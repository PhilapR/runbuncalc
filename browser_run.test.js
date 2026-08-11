/* eslint-env node, es6 */
'use strict';

/**
 * Browser gate for the My Run panel.
 *
 * `run.test.js` covers the rules and `play.test.js` covers the save file. What
 * is only checkable here is the thing a player actually does: start a run, look
 * at a route, catch something off it, set a party, and plan the next fight —
 * with the whole run living in `localStorage` and the server holding nothing.
 *
 * These properties are specific to this layer and cannot be tested below it:
 *
 *   - a refusal must not corrupt the save. The panel writes only what the
 *     server accepted, so a rejected catch has to leave `localStorage` byte for
 *     byte as it was — and a pasted run is a refusal like any other, which is
 *     why it has to be validated by the server BEFORE it is adopted.
 *   - the run must survive a reload. A playthrough that evaporates on refresh is
 *     not a playthrough, and the legacy Team/Box grid on this same page has had
 *     exactly that bug for its whole life.
 *   - one change at a time. Every call posts the whole run and adopts what comes
 *     back, so two in flight share one base run and the later reply drops the
 *     earlier command without a word.
 *
 * Skips rather than fails without Chromium, so the suite still runs headless.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const startServer = require('./server').startServer;

let chromium = null;
try {
	chromium = require('playwright-core').chromium;
} catch (error) {
	chromium = null;
}

const EXECUTABLE = process.env.PLAYWRIGHT_CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const skip = chromium ? false : 'playwright-core is not installed';

let server;
let browser;
let baseUrl;

test.before(async () => {
	if (skip) return;
	server = startServer(0);
	await new Promise(resolve => server.once('listening', resolve));
	baseUrl = `http://127.0.0.1:${server.address().port}`;
	const fs = require('node:fs');
	const path = require('node:path');
	let executablePath = EXECUTABLE;
	if (!fs.existsSync(executablePath)) {
		const root = '/opt/pw-browsers';
		const dir = fs.existsSync(root) ?
			fs.readdirSync(root).find(name => /^chromium-\d+$/.test(name)) :
			undefined;
		executablePath = dir ? path.join(root, dir, 'chrome-linux', 'chrome') : undefined;
	}
	browser = await chromium.launch({executablePath, args: ['--no-sandbox']});
});

test.after(async () => {
	if (browser) await browser.close();
	if (server) await new Promise((resolve, reject) =>
		server.close(error => error ? reject(error) : resolve()));
});

/** A fresh context each time, so one test's saved run cannot leak into another. */
async function open() {
	const context = await browser.newContext();
	// The Google Fonts stylesheet is render-blocking, and in a proxied sandbox
	// the request can hang for many seconds before failing — stalling every
	// classic script (and DOMContentLoaded) behind it. No test asserts on the
	// font, so fail it instantly. Scoped to the font hosts only, so a genuinely
	// new external dependency still fails loudly instead of being masked.
	await context.route(/fonts\.(googleapis|gstatic)\.com/, route => route.abort());
	const page = await context.newPage();
	const errors = [];
	page.on('pageerror', error => errors.push(String(error)));
	await page.goto(`${baseUrl}/index.html#runbun-run`, {waitUntil: 'domcontentloaded'});
	await page.waitForSelector('#runbun-run');
	// The map list is fetched on load; nothing else works until it lands.
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-map option').length > 100,
		null, {timeout: 15000});
	return {context, page, errors};
}

async function savedRun(page) {
	const raw = await page.evaluate(() => window.localStorage.getItem('runbun.run.v1'));
	return raw ? JSON.parse(raw) : null;
}

test('a player starts a run, catches off a real route, and plans the next fight', {skip}, async () => {
	const session = await open();
	const page = session.page;

	await page.fill('#runbun-run-new-name', 'Browser Run');
	await page.check('#runbun-run-new-cap');
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	// The start form has to actually go away. It was setting `hidden` correctly
	// and staying on screen anyway: a `display: flex` rule in this panel's own CSS
	// outranks the UA stylesheet's `[hidden] {display:none}` on specificity.
	assert.equal(await page.isVisible('#runbun-run-empty'), false,
		'the start form should be gone once a run exists');

	// The cap is computed from the run map, not typed by anyone — and it is the
	// next STORY BOSS's ace, not the next badge's: 12 from the Petalburg Woods
	// grunt's Croagunk, not Brawly's 21 two story fights later.
	const cap = await page.textContent('#runbun-run-cap');
	assert.match(cap, /Level cap 12 — Team Aqua Grunt Petalburg Woods's Croagunk/);
	// And the split leads the position line.
	assert.match(await page.textContent('#runbun-run-position'), /Brawly split \(1\/18\)/);

	// Picking a route lists what actually lives there.
	await page.selectOption('#runbun-run-map', 'Route101');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-encounters li').length > 5,
		null, {timeout: 10000});
	const encounters = await page.$$eval('#runbun-run-encounters .runbun-run-encounter',
		els => els.map(el => el.textContent));
	assert.ok(encounters.some(text => /Lillipup/.test(text)), 'Route 101 should list Lillipup');
	assert.ok(!encounters.some(text => /Ralts/.test(text)), 'Ralts is not on Route 101');

	// Clicking an encounter fills the form rather than catching outright — a
	// misclick should not become a box entry.
	await page.click('#runbun-run-encounters .runbun-run-encounter:has-text("Lillipup")');
	assert.equal(await page.inputValue('#runbun-run-catch-species'), 'Lillipup');
	await page.fill('#runbun-run-catch-name', 'Scout');
	await page.click('#runbun-run-catch');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-box .runbun-run-mon').length === 1,
		null, {timeout: 10000});

	const boxed = await page.textContent('#runbun-run-box .runbun-run-mon-name');
	assert.match(boxed, /Scout the Lillipup L\d+/);
	// Where it came from travels with it, which is what makes the box a record.
	assert.match(await page.textContent('#runbun-run-box .runbun-run-mon-kit'), /walk · Route101/);

	// The party is built by clicking, because click order IS lead order — the
	// multi-select this replaced returned selections in DOM order, so the lead
	// was silently always the earliest catch.
	await page.click('.runbun-run-mon[data-id="mon-1"] .runbun-run-add');
	await page.click('#runbun-run-set-party');
	await page.waitForFunction(
		() => document.querySelector('#runbun-run-box .runbun-run-mon.is-party') !== null,
		null, {timeout: 10000});

	// The split sheet names the boss the run is working toward and its gauntlet.
	assert.match(await page.textContent('#runbun-run-split-summary'), /Brawly split \(1\/18\)/);
	assert.ok(await page.$$eval('#runbun-run-split-gauntlet .runbun-run-split-fight',
		els => els.length) >= 4, 'the gauntlet lists the boss-tier fights');

	// The story spine renders one tick per milestone, none beaten yet.
	assert.equal(await page.$$eval('#runbun-run-spine li', els => els.length), 44);
	assert.equal(await page.$$eval('#runbun-run-spine li.is-beaten', els => els.length), 0);
	assert.match(await page.textContent('#runbun-run-spine-note'), /0 \/ 44 milestones/);

	await page.click('#runbun-run-plan');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-plan-actions .runbun-run-action').length > 1,
		null, {timeout: 15000});
	const verdict = await page.textContent('#runbun-run-plan-verdict');
	// The run starts before the first battle in the map, so this is fight zero.
	assert.match(verdict, /Youngster Calvin/);
	assert.match(verdict, /decided by|contested by|only one action/);

	// The matchup board grades the box against a fight, both directions, in the
	// same page. One box mon against Calvin's party: every enemy is a column in
	// each of the two tables, every cell carries a percent, and the note names
	// the fight so the tables cannot be read against the wrong trainer.
	await page.click('#runbun-run-upcoming .runbun-run-up-board');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-matrix table').length === 2,
		null, {timeout: 15000});
	assert.match(await page.textContent('#runbun-run-matrix-note'), /Youngster Calvin \(#0\)/);
	const cells = await page.$$eval('#runbun-run-matrix td', els => els.map(el => el.textContent));
	assert.ok(cells.length >= 2, 'both directions should render cells');
	assert.ok(cells.every(text => /%|—/.test(text)), 'every cell is a percent or an honest dash');

	// The Heart Scale button is never disabled, so the refusal is what a player
	// with an empty bag reads — and it has to name which of the two reasons
	// stopped it, or a greyed-out button would have said more.
	await page.click('.runbun-run-mon[data-id="mon-1"]');
	await page.selectOption('#runbun-run-iv-stat', 'spe');
	await page.click('#runbun-run-heartscale');
	await page.waitForFunction(
		() => /no shop sells them/.test(document.querySelector('#runbun-run-status').textContent),
		null, {timeout: 10000});

	// With one in the bag it spends, and the box records the IV.
	await page.fill('#runbun-run-acquire-item', 'Heart Scale');
	await page.click('#runbun-run-acquire');
	await page.waitForFunction(
		() => /Heart Scale x1/.test(document.querySelector('#runbun-run-bag').textContent),
		null, {timeout: 10000});
	await page.click('#runbun-run-heartscale');
	await page.waitForFunction(
		() => /Speed IV unrecorded → 31/.test(
			document.querySelector('#runbun-run-status').textContent),
		null, {timeout: 10000});
	assert.equal((await savedRun(page)).box[0].ivs.spe, 31);

	// The advisor: the same board, read as "what do I change about it".
	await page.click('#runbun-run-advise');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-advice .runbun-run-advice-row').length > 0,
		null, {timeout: 30000});
	assert.match(await page.textContent('#runbun-run-advice-note'),
		/Youngster Calvin \(#0\) · \d+ single changes weighed/);
	const rows = await page.$$eval('#runbun-run-advice .runbun-run-advice-row',
		els => els.map(el => el.textContent));
	assert.ok(rows.length <= 10, 'the advisor offers a shortlist, not a catalogue');
	assert.ok(/Scout/.test(rows[0]), 'each row names the Pokemon it would change');
	assert.ok(rows.some(text => /KO/.test(text)), 'a flipped cell is why the list is ordered');

	assert.deepEqual(session.errors, [], `page raised errors: ${session.errors.join('; ')}`);
	await session.context.close();
});

test('a catch that could not have happened is refused and changes nothing', {skip}, async () => {
	const session = await open();
	const page = session.page;

	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	await page.selectOption('#runbun-run-map', 'Route101');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-encounters li').length > 5,
		null, {timeout: 10000});

	const before = JSON.stringify(await savedRun(page));

	await page.fill('#runbun-run-catch-species', 'Ralts');
	await page.fill('#runbun-run-catch-level', '3');
	await page.click('#runbun-run-catch');
	await page.waitForFunction(
		() => /does not appear on/.test(
			document.querySelector('#runbun-run-status').textContent),
		null, {timeout: 10000});

	// The refusal is the feature: it names the route's real roster.
	const message = await page.textContent('#runbun-run-status');
	assert.match(message, /Ralts does not appear on Route101; it holds: Lillipup/);
	assert.equal(await page.getAttribute('#runbun-run-status', 'data-kind'), 'error');
	assert.equal(await page.$$eval('#runbun-run-box .runbun-run-mon', els => els.length), 0);
	// And the save is untouched, not rolled back after the fact.
	assert.equal(JSON.stringify(await savedRun(page)), before, 'a refusal wrote to the save');

	await session.context.close();
});

test('the run survives a reload, because a playthrough that does not is not one', {skip}, async () => {
	const session = await open();
	const page = session.page;

	await page.fill('#runbun-run-new-name', 'Persisted');
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	await page.selectOption('#runbun-run-map', 'Route101');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-encounters li').length > 5,
		null, {timeout: 10000});
	await page.fill('#runbun-run-catch-species', 'Poochyena');
	await page.fill('#runbun-run-catch-level', '3');
	await page.click('#runbun-run-catch');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-box .runbun-run-mon').length === 1,
		null, {timeout: 10000});

	await page.reload({waitUntil: 'domcontentloaded'});
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-box .runbun-run-mon').length === 1,
		null, {timeout: 15000});
	assert.equal(await page.textContent('#runbun-run-name'), 'Persisted');
	assert.match(await page.textContent('#runbun-run-box .runbun-run-mon-name'), /Poochyena/);

	await session.context.close();
});

test('lead order is click order, and marking a fight beaten moves the run', {skip}, async () => {
	const session = await open();
	const page = session.page;

	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	await page.selectOption('#runbun-run-map', 'Route101');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-encounters li').length > 5,
		null, {timeout: 10000});
	for (const species of ['Poochyena', 'Lillipup']) {
		await page.fill('#runbun-run-catch-species', species);
		await page.fill('#runbun-run-catch-level', '3');
		await page.click('#runbun-run-catch');
		await page.waitForFunction(
			expected => document.querySelectorAll('#runbun-run-box .runbun-run-mon').length === expected,
			species === 'Poochyena' ? 1 : 2, {timeout: 10000});
	}

	// mon-2 added FIRST, then mon-1: the committed party must keep that order.
	// This is the exact case the old multi-select could not express.
	await page.click('.runbun-run-mon[data-id="mon-2"] .runbun-run-add');
	await page.click('.runbun-run-mon[data-id="mon-1"] .runbun-run-add');
	await page.click('#runbun-run-set-party');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-box .runbun-run-mon.is-party').length === 2,
		null, {timeout: 10000});
	const saved = await savedRun(page);
	assert.deepEqual(saved.party, ['mon-2', 'mon-1'],
		'lead order must be the order the player added, not catch order');

	// The road ahead: mark the first fight beaten and the run moves past it.
	const firstRow = await page.textContent('#runbun-run-upcoming .runbun-run-up.is-next');
	assert.match(firstRow, /Youngster Calvin/);
	await page.click('#runbun-run-upcoming .runbun-run-up.is-next .runbun-run-up-beat');
	await page.waitForFunction(
		() => /Bug Catcher Rick/.test(
			document.querySelector('#runbun-run-upcoming .runbun-run-up.is-next').textContent),
		null, {timeout: 10000});
	assert.equal((await savedRun(page)).position, 0);

	// The box filter narrows without touching the document.
	await page.fill('#runbun-run-box-filter', 'pooch');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-box .runbun-run-mon').length === 1,
		null, {timeout: 5000});
	assert.match(await page.textContent('#runbun-run-box .runbun-run-mon-name'), /Poochyena/);
	assert.equal((await savedRun(page)).box.length, 2, 'filtering is a view, not a command');

	await session.context.close();
});

test('the rule toggles are individual, and the preset only drives the controls', {skip}, async () => {
	const session = await open();
	const page = session.page;

	// The preset hand sets all four controls...
	await page.check('#runbun-run-new-nuzlocke');
	assert.equal(await page.isChecked('#runbun-run-new-permadeath'), true);
	assert.equal(await page.isChecked('#runbun-run-new-route'), true);
	assert.equal(await page.inputValue('#runbun-run-new-dupes'), 'line');
	// ...and any of them can be adjusted after — the form is what is sent.
	await page.uncheck('#runbun-run-new-route');
	await page.selectOption('#runbun-run-new-dupes', 'species');
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');

	const saved = await savedRun(page);
	assert.equal(saved.rules.permadeath, true);
	assert.equal(saved.rules.onePerRoute, false);
	assert.equal(saved.rules.dupesClause, 'species');
	assert.equal(saved.rules.shinyClause, true);

	assert.deepEqual(session.errors, [], `page raised errors: ${session.errors.join('; ')}`);
	await session.context.close();
});

test('undo rewinds the saved run one command', {skip}, async () => {
	const session = await open();
	const page = session.page;

	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	await page.selectOption('#runbun-run-map', 'Route101');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-encounters li').length > 5,
		null, {timeout: 10000});
	await page.fill('#runbun-run-catch-species', 'Poochyena');
	await page.fill('#runbun-run-catch-level', '3');
	await page.click('#runbun-run-catch');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-box .runbun-run-mon').length === 1,
		null, {timeout: 10000});

	// Export first. That text is the run WITH the catch in it, so leaving it in
	// the box after an undo leaves a silent redo one click away.
	await page.click('.runbun-run-transfer summary');
	await page.click('#runbun-run-export');
	assert.match(await page.inputValue('#runbun-run-transfer'), /Poochyena/);

	await page.click('#runbun-run-undo');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-box .runbun-run-mon').length === 0,
		null, {timeout: 10000});
	const state = await savedRun(page);
	assert.equal(state.box.length, 0);
	assert.equal(state.log.length, 0);
	assert.equal(await page.inputValue('#runbun-run-transfer'), '',
		'the export that still holds the undone catch outlived the undo');

	await session.context.close();
});

test('a pasted run the server cannot read is refused, and the save survives it', {skip}, async () => {
	const session = await open();
	const page = session.page;

	await page.fill('#runbun-run-new-name', 'Keeper');
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	// The first status render is what finishes the save; compare only after it.
	await page.waitForFunction(
		() => /Keeper/.test(document.querySelector('#runbun-run-name').textContent),
		null, {timeout: 15000});
	const before = await page.evaluate(() => window.localStorage.getItem('runbun.run.v1'));

	await page.click('.runbun-run-transfer summary');
	// This clears every check the panel could make on its own — it parses, it is
	// an object, it carries a version — and it is still not a run. Only the
	// server can tell the difference, so only the server gets to decide.
	await page.fill('#runbun-run-transfer', '{"version":1}');
	await page.click('#runbun-run-import');
	await page.waitForFunction(
		() => /^Could not import:/.test(document.querySelector('#runbun-run-status').textContent),
		null, {timeout: 10000});
	assert.equal(await page.getAttribute('#runbun-run-status', 'data-kind'), 'error');

	// Byte for byte. A paste the server refused is a refusal like any other, and
	// this one used to overwrite the save permanently — reload included.
	assert.equal(await page.evaluate(() => window.localStorage.getItem('runbun.run.v1')), before,
		'a refused import wrote to the save');
	assert.equal(await page.textContent('#runbun-run-name'), 'Keeper');
	assert.equal(await page.isVisible('#runbun-run-empty'), false,
		'the refused import should not have taken the run off screen');

	// And the panel is still a panel: the run it holds is the one it always
	// held, and the in-flight guard released when the import failed.
	await page.selectOption('#runbun-run-map', 'Route101');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-encounters li').length > 5,
		null, {timeout: 10000});
	await page.fill('#runbun-run-catch-species', 'Poochyena');
	await page.fill('#runbun-run-catch-level', '3');
	await page.click('#runbun-run-catch');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-box .runbun-run-mon').length === 1,
		null, {timeout: 10000});
	assert.equal((await savedRun(page)).name, 'Keeper');

	assert.deepEqual(session.errors, [], `page raised errors: ${session.errors.join('; ')}`);
	await session.context.close();
});

test('a damaged save is handed back for repair, not quietly replaced', {skip}, async () => {
	const session = await open();
	const page = session.page;

	// A write that was cut off half way — quota, a closed tab. The panel used to
	// swallow the parse error and treat the browser as empty, and the next
	// "Start a run" wrote over the only copy the player had.
	const damaged = '{"version":1,"name":"Half a run","box":[{"id":"mon-1","spec';
	await page.evaluate(raw => window.localStorage.setItem('runbun.run.v1', raw), damaged);
	await page.reload({waitUntil: 'domcontentloaded'});
	await page.waitForFunction(
		() => /damaged/.test(document.querySelector('#runbun-run-status').textContent),
		null, {timeout: 15000});
	assert.equal(await page.getAttribute('#runbun-run-status', 'data-kind'), 'error');
	// Handed back verbatim, in an open box: recovery by hand is the only recovery
	// there is, and it needs the text.
	assert.equal(await page.inputValue('#runbun-run-transfer'), damaged);

	await page.click('#runbun-run-new');
	await page.waitForFunction(
		() => /starting a run would write over it/.test(
			document.querySelector('#runbun-run-status').textContent),
		null, {timeout: 10000});
	assert.equal(await page.evaluate(() => window.localStorage.getItem('runbun.run.v1')), damaged,
		'starting a run wrote over a save the player had not dealt with');

	// Clearing the box IS dealing with it, and then a run starts as usual.
	await page.fill('#runbun-run-transfer', '');
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	await page.waitForFunction(
		() => /"box"/.test(window.localStorage.getItem('runbun.run.v1') || ''),
		null, {timeout: 15000});

	await session.context.close();
});

test('a change asked for while another is in flight is refused, not merged', {skip}, async () => {
	const session = await open();
	const page = session.page;

	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	await page.selectOption('#runbun-run-map', 'Route101');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-encounters li').length > 5,
		null, {timeout: 10000});

	// Held open long enough that a second click lands while the first call is
	// still out. Both would post the same base run, and whichever replied last
	// would be persisted over the other — losing a command the player was told
	// had happened.
	await page.route('**/run/apply', async route => {
		await new Promise(resolve => setTimeout(resolve, 1500));
		await route.continue();
	});

	await page.fill('#runbun-run-catch-species', 'Poochyena');
	await page.fill('#runbun-run-catch-level', '3');
	await page.click('#runbun-run-catch');
	await page.click('#runbun-run-undo');
	// Refused out loud: a button that quietly does nothing reads as broken.
	assert.match(await page.textContent('#runbun-run-status'), /One change at a time/);
	assert.equal(await page.getAttribute('#runbun-run-status', 'data-kind'), 'error');

	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-box .runbun-run-mon').length === 1,
		null, {timeout: 15000});
	const saved = await savedRun(page);
	assert.equal(saved.box.length, 1, 'the catch that was in flight still has to land');
	assert.equal(saved.log.length, 1, 'the refused undo must not have run behind it');

	await session.context.close();
});
