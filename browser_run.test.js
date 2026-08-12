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

test('routes, scout and rank render in the panel with the availability data', {skip}, async () => {
	const session = await open();
	const page = session.page;

	await page.fill('#runbun-run-new-name', 'Routes Run');
	await page.check('#runbun-run-new-nuzlocke');
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');

	// Routes: unlock order first, the open ones badged as open, a surf slot
	// starred because the method waits on its HM.
	await page.click('#runbun-run-routes-btn');
	await page.waitForSelector('#runbun-run-routes .runbun-run-route-row');
	assert.match(await page.textContent('#runbun-run-routes-note'), /open now/);
	const firstRoute = await page.textContent('#runbun-run-routes .runbun-run-route-row');
	assert.match(firstRoute, /open/);
	const routeRows = await page.$$eval('#runbun-run-routes .runbun-run-route-row',
		els => els.map(el => el.textContent));
	assert.ok(routeRows.some(text => /surf\*/.test(text)),
		'a pre-Surf water slot should carry the HM star');

	// Scout: hypothetical catches graded against the boss, no surf prospects.
	await page.click('#runbun-run-scout-btn');
	await page.waitForSelector('#runbun-run-scout .runbun-run-scout-row');
	assert.match(await page.textContent('#runbun-run-routes-note'),
		/vs Leader Brawly \(#77\) at cap 21/);
	const scouted = await page.$$eval('#runbun-run-scout .runbun-run-scout-row',
		els => els.map(el => el.textContent));
	assert.ok(scouted.length >= 1);
	assert.ok(!scouted.some(text => / surf/.test(text)), 'no surfing before Surf');

	// Rank needs a box; catch one and rank against the first fight.
	await page.selectOption('#runbun-run-map', 'Route101');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-encounters li').length > 5,
		null, {timeout: 10000});
	await page.click('#runbun-run-encounters .runbun-run-encounter:has-text("Lillipup")');
	await page.click('#runbun-run-catch');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-box .runbun-run-mon').length === 1,
		null, {timeout: 10000});
	await page.click('#runbun-run-rank');
	await page.waitForSelector('#runbun-run-ranking .runbun-run-rank-row');
	assert.match(await page.textContent('#runbun-run-rank-note'), /1 sixes from a box of 1/);
	assert.match(await page.textContent('#runbun-run-ranking .runbun-run-rank-row'),
		/\[Lillipup\]/);
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

test('the page fits a phone: the active mode reflows, the calc scrolls in place', {skip}, async () => {
	// The viewport meta plus the scoped width floor is the whole responsive
	// setup: without them every rule below 980px is dead code on the devices it
	// exists for. This drives the page at a real phone size and asserts the
	// property that matters — nothing forces the PAGE wider than the screen.
	const context = await browser.newContext({viewport: {width: 390, height: 844}});
	await context.route(/fonts\.(googleapis|gstatic)\.com/, route => route.abort());
	const page = await context.newPage();
	await page.goto(`${baseUrl}/index.html#runbun-run`, {waitUntil: 'domcontentloaded'});
	await page.waitForSelector('#runbun-run');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-map option').length > 100,
		null, {timeout: 15000});

	// Below the breakpoint the shell is a true tab UI: the classic calc (whose
	// desktop float layout is authored at 100em) leaves the layout entirely
	// while another mode is active, so its floor cannot stretch the page.
	assert.equal(await page.isVisible('#calc'), false,
		'the inactive calc region should collapse on a phone');
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	const overflow = await page.evaluate(() =>
		document.documentElement.scrollWidth - document.documentElement.clientWidth);
	assert.ok(overflow <= 0, `the run panel forced the page ${overflow}px wider than the phone`);
	// Exactly one region on the page: a mode with its own id-level display rule
	// (the planner's grid) used to ghost through the collapse and float above
	// whichever mode was actually selected.
	const visibleRegions = await page.$$eval('.rb-mode-region',
		els => els.filter(el => el.offsetParent !== null).map(el => el.id));
	assert.deepEqual(visibleRegions, ['runbun-run'],
		'only the active mode should render on a phone');

	// The calc is still reachable — it scrolls INSIDE its own region rather
	// than widening the page for every other mode.
	await page.click('#rb-tab-calc');
	await page.waitForSelector('#calc.rb-mode-active');
	assert.equal(await page.isVisible('#runbun-run'), false,
		'switching modes should swap regions, not stack them');
	const calcScrolls = await page.evaluate(() => {
		const calc = document.getElementById('calc');
		return calc.scrollWidth > calc.clientWidth;
	});
	assert.ok(calcScrolls, 'the calc should keep its desktop geometry, scrollable in place');

	await context.close();
});

test('an answer the run has moved past is marked stale', {skip}, async () => {
	// Plan, Advise, Rank, Routes and Board are computed against the run AS IT
	// WAS. That is fine — they are on-demand questions — but an advisor sheet
	// computed three catches ago must not LOOK like current advice.
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
	await page.click('.runbun-run-mon[data-id="mon-1"] .runbun-run-add');
	await page.click('#runbun-run-set-party');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-box .runbun-run-mon.is-party').length === 1,
		null, {timeout: 10000});

	await page.click('#runbun-run-plan');
	await page.waitForFunction(
		() => /decided|contested|only one/.test(
			document.querySelector('#runbun-run-plan-verdict').textContent),
		null, {timeout: 20000});
	// Fresh answer, fresh mark: computed for THIS run, nothing stale about it.
	assert.equal(await page.$eval('#runbun-run-plan-verdict',
		el => el.classList.contains('rb-stale')), false);

	// Any command moves the run; the standing answer must say so on its face.
	await page.fill('#runbun-run-acquire-item', 'Oran Berry');
	await page.click('#runbun-run-acquire');
	await page.waitForFunction(
		() => document.querySelector('#runbun-run-plan-verdict').classList.contains('rb-stale'),
		null, {timeout: 10000});

	// Re-asking clears the mark: the answer belongs to the current run again.
	await page.click('#runbun-run-plan');
	await page.waitForFunction(
		() => !document.querySelector('#runbun-run-plan-verdict').classList.contains('rb-stale'),
		null, {timeout: 20000});

	await session.context.close();
});

test('two tabs are one run: a catch in one appears in the other', {skip}, async () => {
	// The save lives in localStorage, so a phone next to the emulator and a
	// desktop tab were ALWAYS the same run — but each tab only read it at load,
	// and the staler one would overwrite the other's catches on its next
	// command. The storage event is the missing half.
	const session = await open();
	const first = session.page;
	const second = await session.context.newPage();
	await second.goto(`${baseUrl}/index.html#runbun-run`, {waitUntil: 'domcontentloaded'});
	await second.waitForSelector('#runbun-run');

	await first.click('#runbun-run-new');
	await first.waitForSelector('#runbun-run-live:not([hidden])');
	// The other tab hears the write and shows the run without a reload.
	await second.waitForSelector('#runbun-run-live:not([hidden])', {timeout: 10000});

	await first.selectOption('#runbun-run-map', 'Route101');
	await first.waitForFunction(
		() => document.querySelectorAll('#runbun-run-encounters li').length > 5,
		null, {timeout: 10000});
	await first.fill('#runbun-run-catch-species', 'Poochyena');
	await first.fill('#runbun-run-catch-level', '3');
	await first.click('#runbun-run-catch');

	await second.waitForFunction(
		() => document.querySelectorAll('#runbun-run-box .runbun-run-mon').length === 1,
		null, {timeout: 10000});
	assert.match(await second.textContent('#runbun-run-status'), /Synced/,
		'the second tab should say where the change came from');

	await session.context.close();
});

test('the recreation: roll the route, catch or lose it, and play the fight to a recorded win', {skip}, async () => {
	const session = await open();
	const page = session.page;

	// The route rule ON: "one roll per route" is only a rule when the run
	// declares it — the refusal below is the rule speaking, not the die.
	await page.check('#runbun-run-new-route');
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');

	// Roll Route 101's one encounter off its real table. What comes up is
	// advice until a button writes it — so the box must still be empty here.
	await page.selectOption('#runbun-run-map', 'Route101');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-encounters li').length > 5,
		null, {timeout: 10000});
	await page.click('#runbun-run-roll');
	await page.waitForSelector('#runbun-run-roll-result:not([hidden])', {timeout: 10000});
	const rolled = await page.textContent('#runbun-run-roll-text');
	assert.match(rolled, /A wild .+ L\d+ appeared!/);
	assert.equal((await savedRun(page)).box.length, 0, 'a roll is not a catch');

	// Catch it: the roll becomes an ordinary, fully verified catch command.
	await page.click('#runbun-run-roll-catch');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-box .runbun-run-mon').length === 1,
		null, {timeout: 10000});
	assert.equal(await page.isVisible('#runbun-run-roll-result'), false,
		'a settled roll leaves the screen');

	// Roll the next route and lose it: the route is spent with nothing kept,
	// and rolling it again is refused with the rule's own words.
	await page.selectOption('#runbun-run-map', 'Route102');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-encounters li').length > 5,
		null, {timeout: 10000});
	await page.click('#runbun-run-roll');
	await page.waitForSelector('#runbun-run-roll-result:not([hidden])', {timeout: 10000});
	await page.click('#runbun-run-roll-flee');
	await page.waitForFunction(
		() => /spent — it got away/.test(
			document.querySelector('#runbun-run-status').textContent),
		null, {timeout: 10000});
	await page.click('#runbun-run-roll');
	await page.waitForFunction(
		() => /already gave its encounter/.test(
			document.querySelector('#runbun-run-status').textContent),
		null, {timeout: 10000});
	assert.equal((await savedRun(page)).box.length, 1, 'losing the roll keeps nothing');

	// Party up and play the fight — turn by turn against the real AI, always
	// pressing the first move, replacements included. A capped catch runs
	// over the first Youngster whatever the seed rolled.
	await page.click('#runbun-run-box .runbun-run-mon .runbun-run-add');
	await page.click('#runbun-run-set-party');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-box .runbun-run-mon.is-party').length === 1,
		null, {timeout: 10000});
	await page.click('#runbun-run-play');
	await page.waitForSelector('#runbun-run-battle:not([hidden])', {timeout: 15000});
	assert.match(await page.textContent('#runbun-run-battle-trainer'), /Youngster Calvin/);

	for (let turn = 0; turn < 40; turn++) {
		const done = await page.evaluate(() =>
			/recorded|Wiped/.test(document.querySelector('#runbun-run-status').textContent));
		if (done) break;
		const button = await page.$('#runbun-run-battle-moves .runbun-run-battle-move') ||
			await page.$('#runbun-run-battle-switches .runbun-run-battle-switch');
		if (!button) {
			await page.waitForTimeout(250);
			continue;
		}
		await button.click();
		await page.waitForTimeout(150);
	}
	await page.waitForFunction(
		() => /recorded/.test(document.querySelector('#runbun-run-status').textContent),
		null, {timeout: 15000});

	// The fight became run history through ordinary commands: win or wipe,
	// the document moved — a win moves the position past Calvin, a wipe
	// buries the party. This seed's capped catch wins.
	const saved = await savedRun(page);
	assert.ok(saved.position >= 0, 'the won fight must be marked beaten');
	assert.ok((await page.textContent('#runbun-run-battle-log')).length > 0,
		'the fight left a narration');

	await session.context.close();
});

test('the starter is picked on the setup screen, and the rival follows from it', {skip}, async () => {
	const session = await open();
	const page = session.page;

	// Three buttons, one pressed at a time; pressing the pressed one clears.
	await page.click('.runbun-run-starter[data-species="Treecko"]');
	assert.equal(await page.getAttribute('.runbun-run-starter[data-species="Treecko"]', 'aria-pressed'), 'true');
	await page.click('.runbun-run-starter[data-species="Mudkip"]');
	assert.equal(await page.getAttribute('.runbun-run-starter[data-species="Treecko"]', 'aria-pressed'), 'false');
	assert.equal(await page.getAttribute('.runbun-run-starter[data-species="Mudkip"]', 'aria-pressed'), 'true');
	await page.click('.runbun-run-starter[data-species="Mudkip"]');
	assert.equal(await page.getAttribute('.runbun-run-starter[data-species="Mudkip"]', 'aria-pressed'), 'false');

	// Start with Treecko: the gift is in the box before anything else happens,
	// and the rival is fixed to the line that answers it — the one Treecko
	// beats, whose ace is Swampert.
	await page.click('.runbun-run-starter[data-species="Treecko"]');
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-box .runbun-run-mon').length === 1,
		null, {timeout: 10000});
	const saved = await savedRun(page);
	assert.equal(saved.box[0].species, 'Treecko');
	assert.equal(saved.box[0].level, 5);
	assert.equal(saved.rules.rival, 'Swampert');
	assert.match(await page.textContent('#runbun-run-status'), /Treecko L5 is in the box/);

	await session.context.close();
});

test('items are guided onto their routes: listed where they stand, one tap to collect', {skip}, async () => {
	const session = await open();
	const page = session.page;

	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');

	// Route 101 holds a Potion, open from the start: the Where view says so
	// and carries the button that records the trip.
	await page.selectOption('#runbun-run-map', 'Route101');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-items .runbun-run-item').length > 0,
		null, {timeout: 10000});
	const row = await page.textContent('#runbun-run-items .runbun-run-item');
	assert.match(row, /Potion/);
	await page.click('#runbun-run-items .runbun-run-pickup-take');
	await page.waitForFunction(
		() => /✓ collected/.test(document.querySelector('#runbun-run-items').textContent),
		null, {timeout: 10000});
	// The collection IS the bag's ordinary acquire — one record, two views.
	assert.match(await page.textContent('#runbun-run-bag'), /Potion x1/);
	assert.equal((await savedRun(page)).bag.Potion, 1);

	// An item the story has not opened yet is shown waiting, not hidden and
	// not collectable: Route 104's Miracle Seed opens at fight #11.
	await page.selectOption('#runbun-run-map', 'Route104');
	await page.waitForFunction(
		() => /Miracle Seed/.test(document.querySelector('#runbun-run-items').textContent),
		null, {timeout: 10000});
	assert.match(await page.textContent('#runbun-run-items'), /opens at #11/);
	assert.equal(await page.$('#runbun-run-items .runbun-run-pickup-take'), null,
		'a gated item must not offer its button');

	await session.context.close();
});
