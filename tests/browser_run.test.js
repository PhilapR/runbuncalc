/* eslint-env node, es6 */
'use strict';

/**
 * Browser gate for the My Run panel.
 *
 * `run.test.js` covers the rules and `play.test.js` covers the save file. What
 * is only checkable here is the thing a player actually does: start a run, look
 * at a route, catch something off it, set a party, and plan the next fight —
 * with the whole run living in private browser storage and the server holding
 * nothing. IndexedDB owns the durable revision; localStorage is a compatibility
 * mirror and cross-tab signal.
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

const planningRequest = require('../contracts/ecosystem/v1/planning-request.json');
const seededProviderReceipt = require('../contracts/ecosystem/v1/seeded-provider-receipt.json');
const dataset = require('../lib/rl-dataset');

const startServer = require('../lib/server').startServer;

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


/** Sections fold by default (the drill-down grammar); a test that reaches
 * inside them opens everything once, like a player who wants the full desk. */
async function openAllSections(page) {
	await page.$$eval('.rb-disclose .rb-disclose-btn[aria-expanded="false"]',
		els => els.forEach(el => el.click()));
	// The manual disclosures (location chooser, scripted-catch form) fold by
	// design; tests that drive the whole panel open them the same way. The
	// transfer details is deliberately excluded — tests toggle it by summary.
	await page.$$eval('#runbun-run details.runbun-run-manual-map',
		els => els.forEach(el => { el.open = true; }));
}

async function savedRun(page) {
	const raw = await page.evaluate(() => window.localStorage.getItem('runbun.run.v1'));
	return raw ? JSON.parse(raw) : null;
}

async function durableHead(page) {
	return page.evaluate(() => window.RunBunAttemptStore.getDefault().loadActive());
}

async function driveVisibleBattleToReceipt(page, maxTurns) {
	for (let turn = 0; turn < (maxTurns || 40); turn++) {
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
	return page.evaluate(async () => {
		const store = window.RunBunAttemptStore.getDefault();
		const head = await store.loadActive();
		const inspected = await store.inspectAttempt(head.attemptId);
		return inspected.events.filter(event => event.kind === 'battle.ended').at(-1);
	});
}

test('a new run cannot outrun durable bootstrap', {skip}, async () => {
	const context = await browser.newContext();
	await context.route(/fonts\.(googleapis|gstatic)\.com/, route => route.abort());
	let releaseMaps;
	const mapsReleased = new Promise(resolve => { releaseMaps = resolve; });
	await context.route('**/run/maps', async route => {
		await mapsReleased;
		await route.continue();
	});
	const page = await context.newPage();
	await page.goto(`${baseUrl}/index.html#runbun-run`, {waitUntil: 'domcontentloaded'});
	await page.waitForFunction(() => {
		const button = document.querySelector('#runbun-run-new');
		const events = button && window.jQuery && window.jQuery._data(button, 'events');
		return events && events.click;
	});

	await page.click('.runbun-run-starter[data-species="Mudkip"]');
	assert.equal(await page.isDisabled('#runbun-run-new'), true,
		'the selected starter must not bypass unfinished durable bootstrap');
	assert.equal(await page.getAttribute('#runbun-run-new', 'title'),
		'Loading the run panel…', 'a disabled start button must say why');
	assert.equal(await page.getAttribute('.runbun-run-setup-form', 'aria-busy'), 'true');
	await page.evaluate(() => document.querySelector('#runbun-run-new').click());
	assert.equal(await savedRun(page), null, 'a programmatic early click must not create a fallback save');

	releaseMaps();
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-map option').length > 100,
		null, {timeout: 15000});
	await page.waitForFunction(() => !document.querySelector('#runbun-run-new').disabled);
	assert.equal(await page.getAttribute('.runbun-run-setup-form', 'aria-busy'), 'false');
	await page.click('#runbun-run-new');
	await page.waitForFunction(() => /Started My run/.test(
		document.querySelector('#runbun-run-status').textContent), null, {timeout: 15000});
	const head = await durableHead(page);
	assert.equal(head.revision, 1);
	assert.equal(head.run.name, 'My run');
	await context.close();
});

async function selectManualMap(page, map) {
	// Both manual disclosures share the class: the location chooser this
	// helper selects in, and the scripted-catch form the same flows fill next.
	await page.$$eval('.runbun-run-manual-map',
		els => els.forEach(el => { el.open = true; }));
	await page.selectOption('#runbun-run-map', map);
}

test('the page plans through the pinned pokemon-mono browser provider', {skip, timeout: 120000}, async () => {
	const session = await open();
	const page = session.page;
	// The server authors the entire rolled identity, so the deterministic
	// seam is the server's answer itself — the page only carries it.
	await session.context.route('**/run/encounter', async route => {
		const response = await route.fetch();
		const payload = await response.json();
		payload.roll.species = 'Zigzagoon-Galar';
		payload.roll.ability = 'Gluttony';
		payload.roll.nature = 'Adamant';
		payload.roll.ivs = {hp: 0, atk: 5, def: 9, spa: 13, spd: 20, spe: 28};
		await route.fulfill({response, json: payload});
	});
	assert.deepEqual(await page.evaluate(() => ({
		repository: window.RunBunPokemonProvider.metadata.repository,
		revision: window.RunBunPokemonProvider.metadata.engineRevision,
		plan: typeof window.RunBunPokemonProvider.provider.plan,
		attribute: typeof window.RunBunPokemonProvider.provider.attribute,
	})), {
		repository: 'pokemon-mono',
		revision: '2ae1b7e5721a2d2ff3b9692df75f65329c891650',
		plan: 'function',
		attribute: 'function',
	});
	assert.equal(await page.evaluate(() =>
		window.RunBunPokemonProvider.resolveTrainerOrder('Youngster Calvin')), 3);
	assert.deepEqual(await page.evaluate(request =>
		window.RunBunPokemonProvider.provider.plan(request), planningRequest),
	seededProviderReceipt, 'browser provider must reproduce pokemon-mono canonical receipt exactly');

	await page.check('#runbun-run-new-route');
	await page.click('.runbun-run-starter[data-species="Treecko"]');
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	await openAllSections(page);

	// One real route roll supplies the reserve used by the replacement test.
	// Its owned IVs are facts from the roll, and must survive reconstruction.
	await selectManualMap(page, 'Route101');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-encounters li').length > 5,
		null, {timeout: 10000});
	await page.click('#runbun-run-roll');
	await page.waitForSelector('#runbun-run-roll-result:not([hidden])', {timeout: 10000});
	await page.click('#runbun-run-roll-catch');
	await page.waitForFunction(
		() => JSON.parse(localStorage.getItem('runbun.run.v1')).box.length === 2,
		null, {timeout: 10000});
	const wild = (await savedRun(page)).box[1];
	assert.equal(wild.species, 'Zigzagoon-Galar');
	assert.equal(wild.ability, 'Gluttony',
		'the acquisition must use the same ROM-backed ability as the pinned runtime');
	assert.deepEqual(Object.keys(wild.ivs).sort(), ['atk', 'def', 'hp', 'spa', 'spd', 'spe']);
	assert.equal(Object.values(wild.ivs).every(iv =>
		Number.isInteger(iv) && iv >= 0 && iv <= 31), true);
	assert.deepEqual(wild.ivs, {hp: 0, atk: 5, def: 9, spa: 13, spd: 20, spe: 28},
		'the wild roll must preserve its six generated values, not a trainer default');
	await page.reload({waitUntil: 'domcontentloaded'});
	await page.waitForSelector('#runbun-run-live:not([hidden])', {timeout: 15000});
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-map option').length > 100,
		null, {timeout: 15000});
	await openAllSections(page);
	const reconstructedWild = (await savedRun(page)).box.find(mon => mon.id === wild.id);
	assert.deepEqual(reconstructedWild.ivs, wild.ivs,
		'reload must reconstruct the one owned IV roll instead of rerolling it');

	await page.click('.runbun-run-mon[data-id="mon-1"] .runbun-run-add');
	await page.click('#runbun-run-set-party');
	await page.waitForFunction(() => !document.querySelector('#runbun-run-plan').disabled,
		null, {timeout: 10000});
	await page.evaluate(() => {
		const provider = window.RunBunPokemonProvider.provider;
		const plan = provider.plan.bind(provider);
		window.__pokemonMonoTrainerOrders = [];
		provider.plan = request => {
			window.__pokemonMonoTrainerOrders.push(request.task.state.trainer.order);
			return plan(request);
		};
	});
	const revisionBeforePlan = (await durableHead(page)).revision;
	// A real mid-run screen is taller than the window and the player sits up
	// at the hero commands; the verdict renders far below them. A short
	// viewport makes that geometry decisive rather than coincidental.
	await openAllSections(page);
	await page.setViewportSize({width: 1280, height: 360});
	await page.$eval('#runbun-run-plan', el => {
		el.scrollIntoView({block: 'center'});
	});
	await page.click('#runbun-run-plan');
	await page.waitForSelector('#runbun-run-plan-actions .is-provider', {timeout: 30000});
	// An answer the player asks for must arrive on their screen: Check
	// matchup scrolls its own verdict into the viewport. The page scrolls
	// smoothly, so the settled position is what counts.
	await page.waitForFunction(() => {
		const box = document.getElementById('runbun-run-plan-verdict').getBoundingClientRect();
		return box.bottom > 0 && box.top < window.innerHeight;
	}, null, {timeout: 5000}).catch(() => {
		throw new Error('the plan verdict must be scrolled into the viewport');
	});
	await page.setViewportSize({width: 1280, height: 720});
	assert.equal(await page.evaluate(() => window.__pokemonMonoTrainerOrders[0]), 3,
		'Calvin must resolve to the canonical raw trainer order, not the filtered UI index');
	assert.equal(await page.evaluate(() => window.__pokemonMonoTrainerOrders.length), 3,
		'the warm browser batch should check the current and next two fights');
	assert.equal(await page.$$eval('#runbun-run-plan-outlook-list li', rows => rows.length), 2,
		'the current forecast belongs in the plan; the next two belong in the outlook');
	assert.match(await page.textContent('#runbun-run-plan-actions'),
		/PARTIAL PLAN · Pokemon Mono · lead Treecko L5 · \d+\/8 sampled branches deathless/);
	assert.match(await page.textContent('#runbun-run-plan-outlook'),
		/bounded eight-seed checks, not certified safe routes/);
	assert.equal(await page.textContent('#runbun-run-plan-evidence'),
		'3 simulator receipts saved with this attempt.');
	const retained = await page.evaluate(async attemptId => {
		const store = window.RunBunAttemptStore.getDefault();
		return {
			head: await store.loadActive(),
			evidence: await store.listEvidence(attemptId),
		};
	}, (await durableHead(page)).attemptId);
	assert.equal(retained.head.revision, revisionBeforePlan,
		'read-only planning must not advance the game-state revision');
	assert.equal(retained.evidence.length, 3);
	assert.deepEqual(retained.evidence.map(record => record.receipt.input.revision),
		[revisionBeforePlan, revisionBeforePlan, revisionBeforePlan]);
	assert.equal(retained.evidence.every(record =>
		record.schemaVersion === 'rabrun.evidence/1.0.0' &&
		/^[a-f0-9]{64}$/.test(record.evidenceHash)), true);
	await page.click('#runbun-run-value');
	await page.waitForFunction(() => !document.querySelector('#runbun-run-value').disabled,
		null, {timeout: 60000});
	assert.match(await page.textContent('#runbun-run-attribution-state'),
		/saved with this attempt/);
	assert.match(await page.textContent('#runbun-run-attribution'),
		/Modeled roster value.*Baseline · \d+\/4 paired seeds deathless.*IV reference test · Treecko → all 15/s);
	assert.match(await page.textContent('#runbun-run-attribution'),
		/Replacement test · Treecko → .+ · .*4 paired seeds/s,
		'the caught reserve must be compared on the same fixed seeds');
	assert.match(await page.textContent('#runbun-run-attribution'),
		/Model only · same paired seeds · lead reoptimized/);
	const attributionEvidence = await page.evaluate(async attemptId =>
		window.RunBunAttemptStore.getDefault().listEvidence(attemptId),
	(await durableHead(page)).attemptId);
	assert.equal(attributionEvidence.length, 4);
	assert.equal(attributionEvidence[3].kind, 'pokemon.rab.attribute');
	assert.equal(Object.hasOwn(attributionEvidence[3], 'carry'), false);

	// Play the exact fight the plan described. This must create the battle
	// event through ordinary UI commands, including contribution telemetry.
	await page.click('#runbun-run-play');
	await page.waitForSelector('#runbun-run-battle:not([hidden])', {timeout: 15000});
	assert.match(await page.textContent('#runbun-run-battle-trainer'), /Youngster Calvin/);
	const completed = await driveVisibleBattleToReceipt(page);
	assert.equal(completed.payload.trainer, 'Youngster Calvin');
	assert.equal(completed.payload.trainerOrder, 3);
	assert.equal(completed.payload.contributionVersion, 1);
	assert.equal(completed.payload.contributionComplete, true);
	assert.ok(completed.payload.contributions.some(row =>
		row.appearances > 0 && row.moveAttempts > 0));
	assert.equal(Object.hasOwn(completed.payload, 'carry'), false);
	assert.equal(completed.source.kind, 'simulator');
	assert.equal(completed.source.providerId, 'runbun-battle-driver');
	await page.click('#runbun-run-battle-abandon');
	await page.waitForFunction(() => document.querySelector('#runbun-run-battle').hidden,
		null, {timeout: 10000});

	await page.click('#runbun-run-review');
	await page.waitForSelector('#runbun-history-planning .runbun-history-plan', {timeout: 10000});
	assert.equal(await page.$$eval('#runbun-history-planning .runbun-history-plan',
		rows => rows.length), 3, 'the current plan and two-fight outlook become review rows');
	assert.match(await page.textContent('#runbun-history-planning'),
		/Youngster Calvin.*(sampled plan held in play|played fight was harsher than the sample|played fight beat the sampled risk|sampled risk showed up in play|played fight ended in defeat).*Played · (won|lost)/s);
	assert.match(await page.textContent('#runbun-history-planning'),
		/Actual participation/s);
	assert.match(await page.textContent('#runbun-history-planning'),
		/Modeled value · fixed-seed tests.*IV reference test · Treecko → all 15/s);
	assert.doesNotMatch(await page.textContent('#runbun-history-planning'), /\bcarry\b/i);

	const bundle = await page.evaluate(() =>
		window.RunBunAttemptStore.getDefault().exportActive());
	const rows = await dataset.materialize(bundle);
	assert.equal(rows.planning_receipts.length, 3);
	assert.equal(rows.attribution_receipts.length, 1);
	assert.deepEqual(rows.attribution_tests.map(row => row.kind).sort(),
		['normalize-ivs', 'replace-party-member']);
	const replacement = rows.attribution_tests.find(row => row.kind === 'replace-party-member');
	assert.ok(replacement.source_event_id && replacement.source_event_hash,
		'the species counterfactual must bind to the reserve acquisition event');
	assert.equal(rows.battle_outcomes.length, 1);
	assert.equal(rows.battle_outcomes[0].trainer_order, 3);
	assert.equal(rows.battle_outcomes[0].outcome, completed.payload.outcome);
	assert.ok(rows.battle_contributions.some(row =>
		row.mon_id === 'mon-1' && row.complete && row.move_attempts > 0));
	const review = rows.planning_reviews.find(row => row.trainer_order === 3);
	assert.ok(review && review.battle_event_id,
		'the materialized plan review must join the actual fight to its fixed-seed plan');
	assert.equal(review.actual_outcome, completed.payload.outcome === 'won' ? 'win' : 'loss');
	assert.equal(Object.hasOwn(rows.attribution_tests[0], 'carry'), false);
	assert.deepEqual(session.errors, []);
	await session.context.close();
});

test('a new run presents the next valid decision before the fight', {skip}, async () => {
	const session = await open();
	const page = session.page;

	await page.click('.runbun-run-starter[data-species="Treecko"]');
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');

	assert.match(await page.textContent('#runbun-run-next-title'),
		/Build a party for Youngster Calvin/);
	assert.equal(await page.textContent('#runbun-run-play'), 'Choose your party');
	assert.equal(await page.isDisabled('#runbun-run-plan'), true,
		'a matchup preview without a party is not a valid next action');
	assert.equal(await page.getAttribute(
		'.rb-disclose[data-section="box"] .rb-disclose-btn', 'aria-expanded'), 'true',
	'the roster should be open when the starter is the next useful object');
	assert.equal(await page.textContent('#runbun-run-party-strip .is-summary'),
		'6 open slots · choose from the roster');
	assert.equal(await page.$$eval('#runbun-run-party-strip > li', rows => rows.length), 1,
		'empty capacity should be summarized instead of drawing six empty cards');
	assert.equal(await page.isHidden('.runbun-run-party-commit'), true,
		'the commit action should stay out of the layout until party order changes');

	await page.click('#runbun-run-play');
	assert.equal(await page.evaluate(() =>
		document.activeElement.classList.contains('runbun-run-add')), true,
	'Choose your party should focus the first usable roster control');
	await page.click('.runbun-run-mon[data-id="mon-1"] .runbun-run-add');
	assert.equal(await page.isVisible('.runbun-run-party-commit'), true);
	await page.click('#runbun-run-set-party');
	await page.waitForFunction(
		() => /Face Youngster Calvin/.test(
			document.querySelector('#runbun-run-next-title').textContent),
		null, {timeout: 10000});

	assert.match(await page.textContent('#runbun-run-play'), /Fight Youngster Calvin/);
	assert.equal(await page.isDisabled('#runbun-run-plan'), false);
	assert.equal(await page.textContent('#runbun-run-ready-party'), '1 / 6 · lead set');
	assert.equal(await page.textContent('#runbun-run-ready-level'), 'Projected to L12');
	assert.equal(await page.textContent('#runbun-run-ready-recovery'), 'Fresh at fight start');
	assert.equal(await page.textContent('#runbun-run-party-strip .is-summary'), '5 open slots');
	assert.equal(await page.$$eval('.runbun-run-next-actions > button', buttons => buttons.length), 7,
		'the active loop should keep roster value inside one compact command deck');
	assert.match(await page.textContent('#runbun-run-party-strip .runbun-run-party-meta'),
		/No held item · 3 moves/);
	await page.click('#runbun-run-party-strip .runbun-run-party-select[data-id="mon-1"]');
	assert.equal(await page.inputValue('#runbun-run-selected'), 'mon-1');
	assert.equal(await page.getAttribute(
		'.rb-disclose[data-section="tools"] .rb-disclose-btn', 'aria-expanded'), 'true',
	'party members should be inspectable without duplicating them in the reserve');
	assert.match(await page.textContent('#runbun-run-mon-summary-name'), /Treecko · L5/);
	assert.equal(await page.textContent('#runbun-run-mon-summary-types'), 'Grass');
	const ownedFacts = await page.textContent('#runbun-run-mon-facts');
	assert.match(ownedFacts, /AbilityOvergrowNature[A-Z][a-z]+/,
		'a game-owned starter must expose its rolled ability and nature');
	assert.doesNotMatch(ownedFacts, /Not recorded/,
		'game-owned facts must not fall back to imported-data uncertainty');
	assert.equal(await page.$$eval('#runbun-run-mon-summary-ivs .runbun-run-iv.is-unknown',
		rows => rows.length), 0, 'a game-owned starter has all six player IVs');
	assert.deepEqual(await page.$$eval('#runbun-run-mon-summary-ivs .runbun-run-iv strong',
		rows => rows.map(row => Number(row.textContent)).map(value =>
			Number.isInteger(value) && value >= 0 && value <= 31)),
	[true, true, true, true, true, true]);
	assert.match(await page.textContent('#runbun-run-iv-note'),
		/Your IVs drive damage, speed, and survival\. Trainer teams use 31; wild encounters use their roll/);

	await page.click('#runbun-run-mon-record summary');
	await page.selectOption('#runbun-run-observed-nature', 'Jolly');
	await page.fill('#runbun-run-observed-ability', 'Overgrow');
	await page.fill('#runbun-run-observed-iv-atk', '27');
	await page.fill('#runbun-run-observed-iv-spe', '31');
	await page.click('#runbun-run-record-details');
	await page.waitForFunction(() => {
		const facts = document.querySelector('#runbun-run-mon-facts').textContent;
		const ivs = Array.from(document.querySelectorAll(
			'#runbun-run-mon-summary-ivs .runbun-run-iv strong'), row => row.textContent);
		return /AbilityOvergrowNatureJolly/.test(facts) &&
			ivs[1] === '27' && ivs[5] === '31';
	}, null, {timeout: 10000});
	assert.match(await page.textContent('#runbun-run-mon-facts'), /AbilityOvergrowNatureJolly/);
	assert.equal(await page.textContent('#runbun-run-mon-summary-ivs .runbun-run-iv:nth-child(2) strong'), '27');
	assert.equal(await page.textContent('#runbun-run-mon-summary-ivs .runbun-run-iv:nth-child(6) strong'), '31');
	const identifiedStarter = (await savedRun(page)).box[0];
	assert.equal(identifiedStarter.nature, 'Jolly', 'the visible identification must reach the durable run');
	assert.equal(identifiedStarter.ability, 'Overgrow');
	assert.equal(identifiedStarter.ivs.atk, 27);
	assert.equal(identifiedStarter.ivs.spe, 31);
	assert.match(await page.textContent('#runbun-run-opportunity-list'),
		/4 encounter areas/);
	assert.match(await page.textContent('#runbun-run-opportunity-list'),
		/2 field items/);
	assert.match(await page.textContent('#runbun-run-opportunity-list'),
		/TM & tutorsMove locations are not mapped yet/);
	assert.equal(await page.$$eval('#runbun-run-reachable .runbun-run-route-choice',
		buttons => buttons.length), 4,
	'Explore should begin with the four reachable choices, not the complete ROM catalog');

	await page.click('.runbun-run-opportunity-action[data-kind="items"]');
	assert.equal(await page.getAttribute(
		'.rb-disclose[data-section="catch"] .rb-disclose-btn', 'aria-expanded'), 'true');
	assert.equal(await page.inputValue('#runbun-run-map'), 'Route101');
	await page.waitForFunction(() => /Potion/.test(
		document.querySelector('#runbun-run-items').textContent), null, {timeout: 10000});

	await page.click('.runbun-run-opportunity-action[data-kind="encounters"]');
	assert.equal(await page.getAttribute(
		'.rb-disclose[data-section="catch"] .rb-disclose-btn', 'aria-expanded'), 'true');
	assert.equal(await page.evaluate(() =>
		document.activeElement.classList.contains('runbun-run-route-choice')), true);

	await page.click('#runbun-run-review');
	assert.equal(await page.getAttribute(
		'.rb-disclose[data-section="history"] .rb-disclose-btn', 'aria-expanded'), 'true');
	await page.waitForFunction(() => /active run joins history/i.test(
		document.querySelector('#runbun-history-state').textContent), null, {timeout: 5000});
	await page.click('#runbun-run-explore');
	assert.equal(await page.getAttribute(
		'.rb-disclose[data-section="catch"] .rb-disclose-btn', 'aria-expanded'), 'true');
	assert.equal(await page.evaluate(() =>
		document.activeElement.classList.contains('runbun-run-route-choice')), true);
	assert.deepEqual(session.errors, []);

	await session.context.close();
});

test('IndexedDB is authoritative and exports a checked replay archive', {skip}, async () => {
	const session = await open();
	const page = session.page;

	await page.fill('#runbun-run-new-name', 'Durable run');
	await page.click('.runbun-run-starter[data-species="Treecko"]');
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	await page.waitForFunction(async () => {
		const head = await window.RunBunAttemptStore.getDefault().loadActive();
		return head && head.revision === 1 && head.run.name === 'Durable run';
	}, null, {timeout: 15000});

	const before = await durableHead(page);
	assert.equal(before.revision, 1);
	const inspected = await page.evaluate(id =>
		window.RunBunAttemptStore.getDefault().inspectAttempt(id), before.attemptId);
	assert.equal(inspected.events.length, 1);
	assert.equal(inspected.events[0].kind, 'run.started');
	assert.equal(inspected.events[0].schemaVersion, '2.0.0');
	assert.equal(inspected.events[0].source.providerId, 'runbun-browser');
	assert.equal(inspected.events[0].source.kind, 'manual');
	assert.match(inspected.events[0].eventHash, /^[a-f0-9]{64}$/);
	assert.deepEqual(await page.evaluate(async () => {
		const request = indexedDB.open(window.RunBunAttemptStore.DB_NAME);
		const db = await new Promise((resolve, reject) => {
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		const tx = db.transaction(['events', 'snapshots', 'idempotency', 'evidence'], 'readonly');
		const result = {
			databaseVersion: db.version,
			events: Array.from(tx.objectStore('events').indexNames),
			snapshots: Array.from(tx.objectStore('snapshots').indexNames),
			idempotency: Array.from(tx.objectStore('idempotency').indexNames),
			evidence: Array.from(tx.objectStore('evidence').indexNames),
		};
		db.close();
		return result;
	}), {
		databaseVersion: 3,
		events: ['byAttempt', 'byAttemptRevision'],
		snapshots: ['byAttempt', 'byAttemptRevision'],
		idempotency: ['byAttempt'],
		evidence: ['byAttempt'],
	});

	// Delete only the compatibility mirror. Reload must recover the IndexedDB
	// head and repopulate that mirror, proving localStorage is not authoritative.
	await page.evaluate(() => window.localStorage.removeItem('runbun.run.v1'));
	await page.reload({waitUntil: 'domcontentloaded'});
	await page.waitForSelector('#runbun-run-live:not([hidden])', {timeout: 15000});
	assert.equal(await page.textContent('#runbun-run-name'), 'Durable run');
	assert.equal((await savedRun(page)).name, 'Durable run');
	assert.match(await page.textContent('#runbun-run-status'), /durable browser storage/);

	await page.click('.runbun-run-transfer summary');
	await page.click('#runbun-run-export');
	await page.waitForFunction(
		() => /"format": "rabrun\.archive"/.test(
			document.querySelector('#runbun-run-transfer').value),
		null, {timeout: 10000});
	assert.equal(await page.evaluate(async () => {
		const bundle = JSON.parse(document.querySelector('#runbun-run-transfer').value);
		return window.RunBunAttemptStore.validateBundle(bundle);
	}), true);
	await page.click('#runbun-run-import');
	await page.waitForFunction(() => /Imported checked attempt archive/.test(
		document.querySelector('#runbun-run-status').textContent), null, {timeout: 10000});
	assert.equal((await durableHead(page)).revision, 1, 'duplicate import preserves the durable head');

	assert.deepEqual(session.errors, [], `page raised errors: ${session.errors.join('; ')}`);
	await session.context.close();
});

test('a v1 browser database upgrades in place before the next command', {skip}, async () => {
	const session = await open();
	const page = session.page;
	await page.click('.runbun-run-starter[data-species="Treecko"]');
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	const head = await durableHead(page);

	await page.evaluate(async oldHead => {
		const name = window.RunBunAttemptStore.DB_NAME;
		await new Promise((resolve, reject) => {
			const request = indexedDB.deleteDatabase(name);
			request.onsuccess = resolve;
			request.onerror = () => reject(request.error);
			request.onblocked = () => reject(new Error('legacy database deletion was blocked'));
		});
		const db = await new Promise((resolve, reject) => {
			const request = indexedDB.open(name, 1);
			request.onupgradeneeded = () => {
				const created = request.result;
				created.createObjectStore('heads', {keyPath: 'attemptId'});
				created.createObjectStore('events', {keyPath: 'id'});
				created.createObjectStore('snapshots', {keyPath: 'id'});
				created.createObjectStore('idempotency', {keyPath: 'id'});
				created.createObjectStore('archives', {keyPath: 'archiveId'});
				created.createObjectStore('meta', {keyPath: 'key'});
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		await new Promise((resolve, reject) => {
			const tx = db.transaction(['heads', 'events', 'snapshots', 'idempotency', 'meta'], 'readwrite');
			const id = oldHead.attemptId;
			const legacyEvent = {id: id + ':1', attemptId: id, revision: 1,
				commandId: 'legacy-start', kind: 'run.started', payload: {run: oldHead.run},
				observedAt: oldHead.run.createdAt, previousStateHash: null,
				stateHash: oldHead.stateHash};
			tx.objectStore('heads').put({attemptId: id, revision: 1,
				run: oldHead.run, stateHash: oldHead.stateHash});
			tx.objectStore('events').put(legacyEvent);
			tx.objectStore('snapshots').put({id: id + ':1', attemptId: id,
				revision: 1, run: oldHead.run, stateHash: oldHead.stateHash});
			tx.objectStore('idempotency').put({id: id + '::legacy-start', attemptId: id,
				commandId: 'legacy-start', fingerprint: 'legacy', revision: 1,
				run: oldHead.run, event: legacyEvent, stateHash: oldHead.stateHash});
			tx.objectStore('meta').put({key: 'activeAttemptId', value: id});
			tx.oncomplete = resolve;
			tx.onerror = () => reject(tx.error);
		});
		db.close();
	}, head);

	await page.reload({waitUntil: 'domcontentloaded'});
	await page.waitForSelector('#runbun-run-live:not([hidden])', {timeout: 15000});
	await openAllSections(page);
	await page.fill('#runbun-run-acquire-item', 'Potion');
	await page.click('#runbun-run-acquire');
	await page.waitForFunction(async () => {
		const active = await window.RunBunAttemptStore.getDefault().loadActive();
		return active && active.revision === 2;
	}, null, {timeout: 15000});
	const upgraded = await page.evaluate(async () => {
		const store = window.RunBunAttemptStore.getDefault();
		const bundle = await store.exportActive();
		return {bundle, valid: await store.validateBundle(bundle)};
	});
	assert.equal(upgraded.valid, true);
	assert.equal(upgraded.bundle.modelVersion, '2.0.0');
	assert.equal(upgraded.bundle.events[0].source.kind, 'migration');
	assert.equal(upgraded.bundle.events[1].source.kind, 'manual');
	assert.equal(upgraded.bundle.events[1].previousEventHash,
		upgraded.bundle.events[0].eventHash);
	assert.deepEqual(session.errors, []);
	await session.context.close();
});

test('a player starts a run, catches off a real route, and plans the next fight', {skip}, async () => {
	const session = await open();
	const page = session.page;

	await page.fill('#runbun-run-new-name', 'Browser Run');
	await page.check('#runbun-run-new-cap');
	await page.click('.runbun-run-starter[data-species="Treecko"]');
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	await openAllSections(page);
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
	assert.match(await page.textContent('#runbun-run-position'), /Road to Brawly · boss 1\/18/);

	// Picking a route lists what actually lives there.
	await selectManualMap(page, 'Route101');
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
	// Two in the box: the starter came free with the run.
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-box .runbun-run-mon').length === 2,
		null, {timeout: 10000});

	const boxed = await page.textContent('.runbun-run-mon[data-id="mon-2"] .runbun-run-mon-name');
	assert.match(boxed, /Scout the Lillipup L\d+/);
	// Where it came from travels with it, which is what makes the box a record.
	assert.match(await page.textContent('.runbun-run-mon[data-id="mon-2"] .runbun-run-mon-kit'), /walk · Route 101/);

	// The party is built by clicking, because click order IS lead order — the
	// multi-select this replaced returned selections in DOM order, so the lead
	// was silently always the earliest catch. Scout (mon-2) gets the slot; the
	// starter stays boxed on purpose.
	await page.click('.runbun-run-mon[data-id="mon-2"] .runbun-run-add');
	await page.click('#runbun-run-set-party');
	await page.waitForFunction(
		() => JSON.parse(localStorage.getItem('runbun.run.v1')).party[0] === 'mon-2' &&
			document.querySelectorAll('#runbun-run-box .runbun-run-mon[data-id="mon-2"]').length === 0,
		null, {timeout: 10000});
	assert.equal(await page.$$eval('#runbun-run-box .runbun-run-mon[data-id="mon-2"]',
		rows => rows.length), 0,
	'the persistent party should not be drawn again in the reserve');

	// The split sheet names the boss the run is working toward and its gauntlet.
	assert.match(await page.textContent('#runbun-run-split-summary'),
		/Road to Brawly · boss 1\/18/);
	assert.ok(await page.$$eval('#runbun-run-split-gauntlet .runbun-run-split-fight',
		els => els.length) >= 4, 'the gauntlet lists the boss-tier fights');

	// The story spine renders one tick per milestone, none beaten yet — 38,
	// because the declared rival pruned the other two variants of every
	// rival milestone.
	assert.equal(await page.$$eval('#runbun-run-spine li', els => els.length), 38);
	assert.equal(await page.$$eval('#runbun-run-spine li.is-beaten', els => els.length), 0);
	assert.match(await page.textContent('#runbun-run-spine-note'), /0 \/ 38 milestones/);

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

	// Pin this owned stat to a deterministic non-perfect value before testing the
	// economy. Game-owned Pokemon already have all six IVs; this is an edit, not
	// filling an unknown.
	await page.click('.runbun-run-mon[data-id="mon-1"] .runbun-run-mon-select');
	// Constrained inputs offer the game's own vocabulary: the forget slot is
	// a select of THIS Pokemon's moves, the new-move field carries a menu of
	// what it can legally learn, and the bag/species fields carry the full
	// Gen 8 item and species lists. Free text still passes through — the
	// commands stay the validators.
	assert.deepEqual(
		await page.$$eval('#runbun-run-replace option', opts => opts.map(o => o.value).filter(Boolean)),
		await page.$$eval('#runbun-run-mon-summary-moves .runbun-run-move', els => els.map(el => el.textContent)),
		'the forget select must list exactly the selected Pokemon\'s moves');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-move-options option').length > 3,
		null, {timeout: 10000});
	assert.ok(await page.$eval('#runbun-run-item-options', el => el.children.length > 100),
		'the bag item field must offer the item vocabulary');
	assert.ok(await page.$eval('#runbun-run-species-options', el => el.children.length > 500),
		'the scripted-catch species field must offer the species vocabulary');
	await page.click('#runbun-run-mon-record summary');
	await page.fill('#runbun-run-observed-iv-spe', '5');
	await page.click('#runbun-run-record-details');
	await page.waitForFunction(
		() => /recorded Treecko/.test(document.querySelector('#runbun-run-status').textContent),
		null, {timeout: 10000});

	// The Heart Scale button is never disabled, so the refusal is what a player
	// with an empty bag reads — and it has to name the inventory reason.
	await page.selectOption('#runbun-run-iv-stat', 'spe');
	await page.click('#runbun-run-heartscale');
	await page.waitForFunction(
		() => /no shop sells them/.test(document.querySelector('#runbun-run-status').textContent),
		null, {timeout: 10000});

	// With one in the bag it spends, and the box records the upgrade.
	await page.fill('#runbun-run-acquire-item', 'Heart Scale');
	await page.click('#runbun-run-acquire');
	await page.waitForFunction(
		() => /Heart Scale x1/.test(document.querySelector('#runbun-run-bag').textContent),
		null, {timeout: 10000});
	await page.click('#runbun-run-heartscale');
	await page.waitForFunction(
		() => /Speed IV 5 → 31/.test(
			document.querySelector('#runbun-run-status').textContent),
		null, {timeout: 10000});
	assert.equal((await savedRun(page)).box[0].ivs.spe, 31);

	// The advisor: the same board, read as "what do I change about it".
	await page.click('#runbun-run-advise');
	await page.waitForFunction(
		() => document.querySelector('#runbun-run-advice .runbun-run-advice-row, ' +
			'#runbun-run-advice .runbun-run-advice-empty') !== null,
		null, {timeout: 30000});
	assert.match(await page.textContent('#runbun-run-advice-note'),
		/Youngster Calvin \(#0\) · \d+ available upgrades compared.*TM\/tutor moves skipped/);
	const rows = await page.$$eval('#runbun-run-advice .runbun-run-advice-row',
		els => els.map(el => el.textContent));
	assert.ok(rows.length <= 10, 'the advisor offers a shortlist, not a catalogue');
	if (rows.length) {
		assert.ok(/Scout/.test(rows[0]), 'each row names the Pokemon it would change');
		assert.doesNotMatch(rows[0], /mon-\d+/, 'player-facing upgrades must not expose storage ids');
		assert.ok(rows.some(text => /KO/.test(text)), 'a flipped cell is why the list is ordered');
	} else {
		assert.match(await page.textContent('#runbun-run-advice .runbun-run-advice-empty'),
			/No available upgrade improves a matchup in this fight/);
	}

	assert.deepEqual(session.errors, [], `page raised errors: ${session.errors.join('; ')}`);
	await session.context.close();
});

test('a catch that could not have happened is refused and changes nothing', {skip}, async () => {
	const session = await open();
	const page = session.page;

	await page.click('.runbun-run-starter[data-species="Treecko"]');
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	await openAllSections(page);
	await selectManualMap(page, 'Route101');
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
	assert.match(message, /Ralts does not appear on Route 101; it holds: Lillipup/);
	assert.equal(await page.getAttribute('#runbun-run-status', 'data-kind'), 'error');
	assert.equal(await page.$$eval('#runbun-run-box .runbun-run-mon', els => els.length), 1,
		'only the starter stands');
	// And the save is untouched, not rolled back after the fact.
	assert.equal(JSON.stringify(await savedRun(page)), before, 'a refusal wrote to the save');

	await session.context.close();
});

test('the run survives a reload, because a playthrough that does not is not one', {skip}, async () => {
	const session = await open();
	const page = session.page;

	await page.fill('#runbun-run-new-name', 'Persisted');
	await page.click('.runbun-run-starter[data-species="Treecko"]');
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	await openAllSections(page);
	await selectManualMap(page, 'Route101');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-encounters li').length > 5,
		null, {timeout: 10000});
	await page.fill('#runbun-run-catch-species', 'Poochyena');
	await page.fill('#runbun-run-catch-level', '3');
	await page.click('#runbun-run-catch');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-box .runbun-run-mon').length === 2,
		null, {timeout: 10000});

	await page.reload({waitUntil: 'domcontentloaded'});
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	await openAllSections(page);
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-box .runbun-run-mon').length === 2,
		null, {timeout: 15000});
	assert.equal(await page.textContent('#runbun-run-name'), 'Persisted');
	assert.match(await page.textContent('.runbun-run-mon[data-id="mon-2"] .runbun-run-mon-name'), /Poochyena/);

	await session.context.close();
});

test('a fight survives a reload, and a fight from a moved run does not', {skip}, async () => {
	const session = await open();
	const page = session.page;

	await page.click('.runbun-run-starter[data-species="Treecko"]');
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	await openAllSections(page);
	await page.click('#runbun-run-box .runbun-run-mon .runbun-run-add');
	await page.click('#runbun-run-set-party');
	await page.waitForFunction(
		() => JSON.parse(localStorage.getItem('runbun.run.v1')).party.length === 1,
		null, {timeout: 10000});

	// Open the fight and play one turn, so there is a log worth keeping.
	await page.click('#runbun-run-play');
	await page.waitForSelector('#runbun-run-battle:not([hidden])', {timeout: 15000});
	await page.waitForSelector('#runbun-run-battle-moves .runbun-run-battle-move',
		{timeout: 10000});
	await page.waitForFunction(() => document.activeElement.id === 'runbun-run-battle');
	assert.equal(await page.$eval('#runbun-run-live', element =>
		element.classList.contains('is-battle-active')), true,
	'a live fight takes over the run surface');
	assert.equal(await page.isVisible('.runbun-run-hero-party'), false,
		'out-of-battle party editing folds while a fight is live');
	assert.equal(await page.isVisible('.runbun-run-history-disclose'), false,
		'run history stays out of the live battle surface');
	assert.equal(await page.isVisible('.runbun-run-transfer'), false,
		'save management stays out of the live battle surface');
	const moveWidths = await page.$$eval('#runbun-run-battle-moves .runbun-run-battle-move',
		buttons => buttons.map(button => button.getBoundingClientRect().width));
	assert.ok(moveWidths.every(width => width >= 180),
		'battle moves fill their two-column decision grid');
	await page.click('#runbun-run-battle-moves .runbun-run-battle-move');
	await page.waitForFunction(
		() => /turn 2/.test(document.querySelector('#runbun-run-battle-turn').textContent),
		null, {timeout: 10000});
	const logBefore = await page.textContent('#runbun-run-battle-log');
	assert.ok(logBefore.length > 0, 'a played turn narrates itself');

	// The refresh: the fight is still on screen, mid-fight, log and all.
	await page.reload({waitUntil: 'domcontentloaded'});
	await page.waitForSelector('#runbun-run-battle:not([hidden])', {timeout: 15000});
	await page.waitForFunction(() => document.activeElement.id === 'runbun-run-battle');
	assert.equal(await page.$eval('#runbun-run-live', element =>
		element.classList.contains('is-battle-active')), true,
	'a resumed fight restores battle mode');
	assert.match(await page.textContent('#runbun-run-battle-trainer'), /Youngster Calvin/);
	assert.match(await page.textContent('#runbun-run-battle-turn'), /turn 2/);
	assert.equal(await page.textContent('#runbun-run-battle-log'), logBefore,
		'the narration survives the refresh');
	// And it is still playable: the buttons act, not just paint.
	await page.click('#runbun-run-battle-moves .runbun-run-battle-move');
	await page.waitForFunction(
		() => !/turn 2/.test(document.querySelector('#runbun-run-battle-turn').textContent),
		null, {timeout: 10000});

	// A fight stamped against a run that has since moved is a stale fork:
	// it is dropped on load, never resumed into the wrong document.
	await page.evaluate(() => {
		const record = JSON.parse(window.localStorage.getItem('runbun.battle.v1'));
		record.stamp = 'somewhere else entirely';
		window.localStorage.setItem('runbun.battle.v1', JSON.stringify(record));
	});
	await page.reload({waitUntil: 'domcontentloaded'});
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	assert.equal(await page.isVisible('#runbun-run-battle'), false,
		'a stale fight must not resume');
	assert.equal(await page.$eval('#runbun-run-live', element =>
		element.classList.contains('is-battle-active')), false,
	'a stale fight cannot leave the run surface locked in battle mode');
	assert.equal(await page.evaluate(
		() => window.localStorage.getItem('runbun.battle.v1')), null,
	'a stale fight is cleaned out of storage');

	await session.context.close();
});

test('lead order is click order, and marking a fight beaten moves the run', {skip}, async () => {
	const session = await open();
	const page = session.page;

	await page.click('.runbun-run-starter[data-species="Treecko"]');
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	await openAllSections(page);
	await selectManualMap(page, 'Route101');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-encounters li').length > 5,
		null, {timeout: 10000});
	for (const species of ['Poochyena', 'Lillipup']) {
		await page.fill('#runbun-run-catch-species', species);
		await page.fill('#runbun-run-catch-level', '3');
		await page.click('#runbun-run-catch');
		await page.waitForFunction(
			expected => document.querySelectorAll('#runbun-run-box .runbun-run-mon').length === expected,
			species === 'Poochyena' ? 2 : 3, {timeout: 10000});
	}

	// mon-3 added FIRST, then mon-2: the committed party must keep that order.
	// This is the exact case the old multi-select could not express. (mon-1,
	// the starter, deliberately stays boxed — party is a choice, not a default.)
	await page.click('.runbun-run-mon[data-id="mon-3"] .runbun-run-add');
	await page.click('.runbun-run-mon[data-id="mon-2"] .runbun-run-add');
	await page.click('#runbun-run-set-party');
	await page.waitForFunction(
		() => JSON.parse(localStorage.getItem('runbun.run.v1')).party.length === 2,
		null, {timeout: 10000});
	const saved = await savedRun(page);
	assert.deepEqual(saved.party, ['mon-3', 'mon-2'],
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
	await page.fill('#runbun-run-box-filter', 'tree');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-box .runbun-run-mon').length === 1,
		null, {timeout: 5000});
	assert.match(await page.textContent('#runbun-run-box .runbun-run-mon-name'), /Treecko/);
	assert.equal((await savedRun(page)).box.length, 3, 'filtering is a view, not a command');

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
	await page.click('.runbun-run-starter[data-species="Treecko"]');
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	await openAllSections(page);

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
	await page.click('.runbun-run-starter[data-species="Treecko"]');
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	await openAllSections(page);

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
	await selectManualMap(page, 'Route101');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-encounters li').length > 5,
		null, {timeout: 10000});
	await page.click('#runbun-run-encounters .runbun-run-encounter:has-text("Lillipup")');
	await page.click('#runbun-run-catch');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-box .runbun-run-mon').length === 2,
		null, {timeout: 10000});
	await page.click('#runbun-run-rank');
	await page.waitForSelector('#runbun-run-ranking .runbun-run-rank-row');
	assert.match(await page.textContent('#runbun-run-rank-note'), /1 party from 2 Pokémon/);
	assert.match(await page.textContent('#runbun-run-ranking .runbun-run-rank-row'),
		/Lillipup/);
});

test('undo rewinds the saved run one command', {skip}, async () => {
	const session = await open();
	const page = session.page;

	await page.click('.runbun-run-starter[data-species="Treecko"]');
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	await openAllSections(page);
	await selectManualMap(page, 'Route101');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-encounters li').length > 5,
		null, {timeout: 10000});
	await page.fill('#runbun-run-catch-species', 'Poochyena');
	await page.fill('#runbun-run-catch-level', '3');
	await page.click('#runbun-run-catch');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-box .runbun-run-mon').length === 2,
		null, {timeout: 10000});

	// Export first. That text is the run WITH the catch in it, so leaving it in
	// the box after an undo leaves a silent redo one click away.
	await page.click('.runbun-run-transfer summary');
	await page.click('#runbun-run-export');
	await page.waitForFunction(
		() => /Poochyena/.test(document.querySelector('#runbun-run-transfer').value),
		null, {timeout: 10000});
	assert.match(await page.inputValue('#runbun-run-transfer'), /Poochyena/);

	await page.click('#runbun-run-undo');
	// The undo pops the catch; the starter (the run's first command) stands.
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-box .runbun-run-mon').length === 1,
		null, {timeout: 10000});
	const state = await savedRun(page);
	assert.equal(state.box.length, 1);
	assert.equal(state.log.length, 1);
	assert.equal(await page.inputValue('#runbun-run-transfer'), '',
		'the export that still holds the undone catch outlived the undo');

	await session.context.close();
});

test('a pasted run the server cannot read is refused, and the save survives it', {skip}, async () => {
	const session = await open();
	const page = session.page;

	await page.fill('#runbun-run-new-name', 'Keeper');
	await page.click('.runbun-run-starter[data-species="Treecko"]');
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	await openAllSections(page);
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
	await selectManualMap(page, 'Route101');
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

	await page.click('.runbun-run-starter[data-species="Treecko"]');
	await page.click('#runbun-run-new');
	await page.waitForFunction(
		() => /starting a run would write over it/.test(
			document.querySelector('#runbun-run-status').textContent),
		null, {timeout: 10000});
	assert.equal(await page.evaluate(() => window.localStorage.getItem('runbun.run.v1')), damaged,
		'starting a run wrote over a save the player had not dealt with');

	// Clearing the box IS dealing with it, and then a run starts as usual.
	// (The starter is still pressed from the blocked attempt — pressing it
	// again would clear the pick.)
	await page.fill('#runbun-run-transfer', '');
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	await openAllSections(page);
	await page.waitForFunction(
		() => /"box"/.test(window.localStorage.getItem('runbun.run.v1') || ''),
		null, {timeout: 15000});

	await session.context.close();
});

test('a change asked for while another is in flight is refused, not merged', {skip}, async () => {
	const session = await open();
	const page = session.page;

	await page.click('.runbun-run-starter[data-species="Treecko"]');
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	await openAllSections(page);
	await selectManualMap(page, 'Route101');
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
	// Deterministic mid-flight click, immune to machine speed on both
	// sides: wait for the synchronous 'Working…' marker so the flight has
	// begun, then click programmatically — page.click's actionability wait
	// would idle on the busy-disabled button until the flight ends.
	await page.waitForFunction(
		() => /Working/.test(document.querySelector('#runbun-run-status').textContent));
	await page.evaluate(() => document.querySelector('#runbun-run-undo').click());
	// Refused out loud: a button that quietly does nothing reads as broken.
	assert.match(await page.textContent('#runbun-run-status'), /One change at a time/);
	assert.equal(await page.getAttribute('#runbun-run-status', 'data-kind'), 'error');

	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-box .runbun-run-mon').length === 2,
		null, {timeout: 15000});
	const saved = await savedRun(page);
	assert.equal(saved.box.length, 2, 'the catch that was in flight still has to land');
	assert.equal(saved.log.length, 2, 'the refused undo must not have run behind it');

	await session.context.close();
});

test('the page fits a phone: every active mode reflows without page overflow', {skip}, async () => {
	// Drive the page at a real phone size and assert the property that matters:
	// the active game and calculator both fit the viewport without turning the
	// page into a clipped desktop canvas.
	const context = await browser.newContext({viewport: {width: 390, height: 844}});
	await context.route(/fonts\.(googleapis|gstatic)\.com/, route => route.abort());
	const page = await context.newPage();
	await page.goto(`${baseUrl}/index.html#runbun-run`, {waitUntil: 'domcontentloaded'});
	await page.waitForSelector('#runbun-run');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-map option').length > 100,
		null, {timeout: 15000});

	// The shell renders one working surface at every viewport. Inactive regions
	// leave layout entirely, so their controls cannot stretch the page.
	assert.equal(await page.isVisible('#calc'), false,
		'the inactive calc region should collapse on a phone');
	await page.click('.runbun-run-starter[data-species="Treecko"]');
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	await openAllSections(page);
	await page.click('#runbun-run-review');
	await page.waitForSelector('#runbun-history-content:not([hidden])', {timeout: 5000});
	const overflow = await page.evaluate(() =>
		document.documentElement.scrollWidth - document.documentElement.clientWidth);
	assert.ok(overflow <= 0, `the run panel forced the page ${overflow}px wider than the phone`);
	// Exactly one region on the page: a mode with its own id-level display rule
	// (the planner's grid) used to ghost through the collapse and float above
	// whichever mode was actually selected.
	const visibleRegions = await page.$$eval('.rb-mode-region',
		els => els.filter(el => el.offsetParent !== null).map(el => el.id));
	assert.deepEqual(visibleRegions, ['runbun-run'],
		'only the active surface should render on a phone');

	// The calc is still reachable. Its combatants stack as one comparison flow,
	// followed by the field controls, with exactly one live result group.
	await page.click('#rb-nav-calc');
	await page.waitForSelector('#calc.rb-mode-active');
	assert.equal(await page.isVisible('#runbun-run'), false,
		'switching modes should swap regions, not stack them');
	const calcLayout = await page.evaluate(() => {
		const calc = document.getElementById('calc');
		return {
			pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
			calcOverflow: calc.scrollWidth - calc.clientWidth,
			playerTop: document.getElementById('p1').getBoundingClientRect().top,
			opponentTop: document.getElementById('p2').getBoundingClientRect().top,
			fieldTop: document.querySelector('#calc .field-info').getBoundingClientRect().top,
			visibleResults: Array.from(document.querySelectorAll('#calc .move-result-group'))
				.filter(el => getComputedStyle(el).display !== 'none').length,
		};
	});
	assert.ok(calcLayout.pageOverflow <= 0,
		`the calculator forced the page ${calcLayout.pageOverflow}px wider than the phone`);
	assert.ok(calcLayout.calcOverflow <= 0,
		`the calculator kept ${calcLayout.calcOverflow}px of hidden desktop overflow`);
	assert.ok(calcLayout.playerTop < calcLayout.opponentTop &&
		calcLayout.opponentTop < calcLayout.fieldTop,
	'the phone flow should show player, opponent, then field');
	assert.equal(calcLayout.visibleResults, 1,
		'the dormant doubles result group must remain hidden');

	await context.close();
});

test('an answer the run has moved past is marked stale', {skip}, async () => {
	// Plan, Advise, Rank, Routes and Board are computed against the run AS IT
	// WAS. That is fine — they are on-demand questions — but an advisor sheet
	// computed three catches ago must not LOOK like current advice.
	const session = await open();
	const page = session.page;

	await page.click('.runbun-run-starter[data-species="Treecko"]');
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	await openAllSections(page);
	await selectManualMap(page, 'Route101');
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
		() => JSON.parse(localStorage.getItem('runbun.run.v1')).party.length === 1,
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

	await first.click('.runbun-run-starter[data-species="Treecko"]');
	await first.click('#runbun-run-new');
	await first.waitForSelector('#runbun-run-live:not([hidden])');
	// The other tab hears the write and shows the run without a reload.
	await second.waitForSelector('#runbun-run-live:not([hidden])', {timeout: 10000});

	await first.click('.rb-disclose[data-section="catch"] .rb-disclose-btn');
	await first.waitForSelector('#runbun-run-roll', {state: 'visible', timeout: 5000});
	await selectManualMap(first, 'Route101');
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
	// Permadeath ON too, so whichever way the fight ends, the document must
	// carry it: a beat, or a burial.
	await page.check('#runbun-run-new-route');
	await page.check('#runbun-run-new-permadeath');
	await page.click('.runbun-run-starter[data-species="Treecko"]');
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	await openAllSections(page);

	// Roll Route 101's one encounter off its real table. What comes up is
	// advice until a button writes it — so the box must still be empty here.
	await selectManualMap(page, 'Route101');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-encounters li').length > 5,
		null, {timeout: 10000});
	await page.click('#runbun-run-roll');
	await page.waitForSelector('#runbun-run-roll-result:not([hidden])', {timeout: 10000});
	const rolled = await page.textContent('#runbun-run-roll-text');
	assert.match(rolled, /A wild .+ L\d+ appeared!/);
	assert.equal((await savedRun(page)).box.length, 1, 'a roll is not a catch — only the starter stands');

	// Catch it: the roll becomes an ordinary, fully verified catch command.
	await page.click('#runbun-run-roll-catch');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-box .runbun-run-mon').length === 2,
		null, {timeout: 10000});
	assert.equal(await page.isVisible('#runbun-run-roll-result'), false,
		'a settled roll leaves the screen');
	const caughtIvs = (await savedRun(page)).box[1].ivs;
	assert.deepEqual(Object.keys(caughtIvs).sort(), ['atk', 'def', 'hp', 'spa', 'spd', 'spe'],
		'the encounter IV roll becomes owned player state when caught');

	// Roll the next route and lose it: the route is spent with nothing kept,
	// and rolling it again is refused with the rule's own words.
	await selectManualMap(page, 'Route102');
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
	assert.equal((await savedRun(page)).box.length, 2, 'losing the roll keeps nothing');

	// Party up and play the fight — turn by turn against the real AI, always
	// pressing the first move, replacements included. A capped catch runs
	// over the first Youngster whatever the seed rolled.
	await page.click('#runbun-run-box .runbun-run-mon .runbun-run-add');
	await page.click('#runbun-run-set-party');
	await page.waitForFunction(
		() => JSON.parse(localStorage.getItem('runbun.run.v1')).party.length === 1,
		null, {timeout: 10000});
	await page.click('#runbun-run-play');
	await page.waitForSelector('#runbun-run-battle:not([hidden])', {timeout: 15000});
	assert.match(await page.textContent('#runbun-run-battle-trainer'), /Youngster Calvin/);

	const completed = await driveVisibleBattleToReceipt(page);

	// The fight became run history through ordinary commands: win or wipe,
	// the document moved — a win moves the position past Calvin, a wipe
	// buries the fighter. The seed is the die's to roll (a solo starter loses
	// this fight a third of the time — that IS Run & Bun), so the test holds
	// the contract, not the outcome.
	const saved = await savedRun(page);
	const status = await page.textContent('#runbun-run-status');
	if (/Won against/.test(status)) {
		assert.ok(saved.position >= 0, 'a won fight must be marked beaten');
	} else {
		assert.match(status, /Wiped against/);
		assert.equal(saved.position, -1, 'a wipe must not advance the run');
		const fallen = saved.box.find(mon => mon.status === 'dead');
		assert.ok(fallen, 'a wipe buries the fighter');
		assert.equal(fallen.died.to, 'Youngster Calvin',
			'the epitaph names who did it');
		assert.ok(fallen.died.move, 'the epitaph names the move');
	}
	assert.ok((await page.textContent('#runbun-run-battle-log')).length > 0,
		'the fight left a narration');
	assert.match(await page.textContent('#runbun-run-battle-result'), /recorded/,
		'the finished battle says its result is in the run');
	assert.equal(completed.payload.kind, 'trainer');
	assert.equal(completed.payload.trainer, 'Youngster Calvin');
	assert.equal(completed.payload.trainerOrder, 3);
	assert.equal(completed.payload.progressionOrder, 0);
	assert.equal(completed.payload.outcome, /Won against/.test(status) ? 'won' : 'lost');
	assert.equal(completed.payload.contributionVersion, 1);
	assert.equal(completed.payload.contributionComplete, true);
	assert.ok(completed.payload.contributions.some(row =>
		row.appearances > 0 && row.moveAttempts > 0),
	'the battle receipt records the Pokemon that actually acted');
	assert.equal(completed.payload.deaths.length,
		saved.box.filter(mon => mon.status === 'dead').length);
	assert.equal(completed.source.kind, 'simulator');
	assert.equal(completed.source.providerId, 'runbun-battle-driver');
	assert.equal(await page.textContent('#runbun-run-battle-abandon'), 'Return to run',
		'a completed fight must never leave an Abandon action behind');
	const recordedStatus = await page.textContent('#runbun-run-status');
	await page.click('#runbun-run-battle-abandon');
	assert.equal(await page.isVisible('#runbun-run-battle'), false,
		'Return to run opens the next run decision');
	assert.equal(await page.$eval('#runbun-run-live', element =>
		element.classList.contains('is-battle-active')), false,
	'Return to run restores the out-of-battle run surface');
	assert.equal(await page.textContent('#runbun-run-status'), recordedStatus,
		'closing a completed fight must not claim that nothing was written');

	await session.context.close();
});

test('a rolled encounter can be fought: the ball is on the buttons, the ending settles the roll', {skip}, async () => {
	const session = await open();
	const page = session.page;

	// The route rule ON, so the settled roll's "one per route" refusal at the
	// end is the rule speaking — without it a used route re-rolls legally.
	await page.check('#runbun-run-new-route');
	await page.click('.runbun-run-starter[data-species="Treecko"]');
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	await openAllSections(page);
	await page.click('#runbun-run-box .runbun-run-mon .runbun-run-add');
	await page.click('#runbun-run-set-party');
	await page.waitForFunction(
		() => JSON.parse(localStorage.getItem('runbun.run.v1')).party.length === 1,
		null, {timeout: 10000});

	// Roll, then fight the roll instead of clicking it into the box.
	await selectManualMap(page, 'Route101');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-encounters li').length > 5,
		null, {timeout: 10000});
	await page.click('#runbun-run-roll');
	await page.waitForSelector('#runbun-run-roll-result:not([hidden])', {timeout: 10000});
	await page.click('#runbun-run-roll-fight');
	await page.waitForSelector('#runbun-run-battle:not([hidden])', {timeout: 15000});
	assert.match(await page.textContent('#runbun-run-battle-trainer'), /^Wild /);
	assert.equal(await page.isVisible('#runbun-run-roll-result'), false,
		'the roll card yields to the fight');
	const $ball = await page.waitForSelector('.runbun-run-battle-ball', {timeout: 10000});
	assert.match(await $ball.textContent(), /% catch/, 'the throw wears its odds');

	// Throw balls until the fight settles — a capped starter shrugs off a
	// route-one wild, so this ends in a catch or (rarely) a kill, never a loss.
	for (let turn = 0; turn < 30; turn++) {
		const done = await page.evaluate(() =>
			/Gotcha|spent, nothing kept/.test(
				document.querySelector('#runbun-run-status').textContent));
		if (done) break;
		const ball = await page.$('.runbun-run-battle-ball');
		if (!ball) {
			await page.waitForTimeout(250);
			continue;
		}
		await ball.click();
		await page.waitForTimeout(150);
	}
	try {
		await page.waitForFunction(
			() => /Gotcha|spent, nothing kept/.test(
				document.querySelector('#runbun-run-status').textContent),
			null, {timeout: 15000});
	} catch (error) {
		console.log('DEBUG status:', await page.textContent('#runbun-run-status'));
		console.log('DEBUG battle visible:', await page.isVisible('#runbun-run-battle'));
		console.log('DEBUG moves:', await page.evaluate(() =>
			[...document.querySelectorAll('#runbun-run-battle-moves button')].map(b => b.textContent)));
		throw error;
	}

	// Either ending went through the document: a catch is in the box, a kill
	// spent the route — and in both worlds the route refuses a second roll.
	const saved = await savedRun(page);
	const status = await page.textContent('#runbun-run-status');
	if (/Gotcha/.test(status)) {
		assert.equal(saved.box.length, 2, 'the caught wild is a real box entry');
		assert.equal(saved.box[1].origin.mapName, 'Route101');
	} else {
		assert.equal(saved.box.length, 1, 'a killed encounter keeps nothing');
	}
	assert.equal(await page.textContent('#runbun-run-battle-abandon'), 'Return to run',
		'a settled wild fight keeps its result visible until the player continues');
	await page.click('#runbun-run-battle-abandon');
	await page.click('#runbun-run-roll');
	await page.waitForFunction(
		() => /already gave its encounter/.test(
			document.querySelector('#runbun-run-status').textContent),
		null, {timeout: 10000});

	await session.context.close();
});

test('a rolled encounter survives a reload: the die was cast, not the page', {skip}, async () => {
	const session = await open();
	const page = session.page;

	await page.click('.runbun-run-starter[data-species="Treecko"]');
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	await openAllSections(page);
	await selectManualMap(page, 'Route101');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-encounters li').length > 5,
		null, {timeout: 10000});
	await page.click('#runbun-run-roll');
	await page.waitForSelector('#runbun-run-roll-result:not([hidden])', {timeout: 10000});
	const cast = await page.textContent('#runbun-run-roll-text');

	// Refresh: the same roll is still on the table — no card lost, no
	// second die dealt.
	await page.reload({waitUntil: 'domcontentloaded'});
	await page.waitForSelector('#runbun-run-roll-result:not([hidden])', {timeout: 15000});
	assert.equal(await page.textContent('#runbun-run-roll-text'), cast,
		'the same roll returns, verbatim');

	// Settle it, reload again: the answered question stays answered.
	await openAllSections(page);
	await page.click('#runbun-run-roll-flee');
	await page.waitForFunction(
		() => /spent — it got away/.test(
			document.querySelector('#runbun-run-status').textContent),
		null, {timeout: 10000});
	await page.reload({waitUntil: 'domcontentloaded'});
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	assert.equal(await page.isVisible('#runbun-run-roll-result'), false,
		'a settled roll must not resurrect');
	assert.equal(await page.evaluate(
		() => window.localStorage.getItem('runbun.roll.v1')), null,
	'the settled roll is cleaned out of storage');

	await session.context.close();
});

test('a hand-recorded faint offers its takeback, and the window is honest', {skip}, async () => {
	const session = await open();
	const page = session.page;

	await page.check('#runbun-run-new-permadeath');
	await page.click('.runbun-run-starter[data-species="Treecko"]');
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	await openAllSections(page);
	await selectManualMap(page, 'Route101');
	await page.fill('#runbun-run-catch-species', 'Poochyena');
	await page.fill('#runbun-run-catch-level', '3');
	await page.click('#runbun-run-catch');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-box .runbun-run-mon').length === 2,
		null, {timeout: 10000});

	// The faint lands, and the takeback bar rises with it.
	await page.click('.runbun-run-mon[data-id="mon-2"] .runbun-run-mon-name');
	await page.waitForFunction(
		() => document.querySelector('#runbun-run-selected').value === 'mon-2',
		null, {timeout: 10000});
	await page.click('#runbun-run-faint');
	await page.waitForSelector('#runbun-run-snackbar:not([hidden])', {timeout: 10000});
	assert.match(await page.textContent('#runbun-run-snackbar-text'), /Poochyena is gone/);
	assert.ok((await savedRun(page)).box[1].status === 'dead', 'the faint really committed');
	await page.waitForSelector('#runbun-run-losses .runbun-run-mon[data-id="mon-2"].is-lost',
		{state: 'visible', timeout: 10000});

	// Undo inside the window: the death is taken back through /run/undo.
	await page.click('#runbun-run-snackbar-undo');
	await page.waitForFunction(
		() => /Undone/.test(document.querySelector('#runbun-run-status').textContent),
		null, {timeout: 10000});
	assert.equal((await savedRun(page)).box[1].status, 'boxed', 'the mon stands again');
	assert.equal(await page.isVisible('#runbun-run-snackbar'), false,
		'the bar leaves with the undo');

	// A later command closes the window: the bar must never undo the wrong thing.
	await page.click('#runbun-run-faint');
	await page.waitForSelector('#runbun-run-snackbar:not([hidden])', {timeout: 10000});
	await page.fill('#runbun-run-acquire-item', 'Potion');
	await page.click('#runbun-run-acquire');
	await page.waitForFunction(
		() => /Potion/.test(document.querySelector('#runbun-run-status').textContent),
		null, {timeout: 10000});
	assert.equal(await page.isVisible('#runbun-run-snackbar'), false,
		'another command dismisses the takeback');
	assert.equal((await savedRun(page)).box[1].status, 'dead',
		'the faint stays recorded once the window closes');

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
	await openAllSections(page);
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

	await page.click('.runbun-run-starter[data-species="Treecko"]');
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	await openAllSections(page);

	// Route 101 holds a Potion, open from the start: the Where view says so
	// and carries the button that records the trip.
	await selectManualMap(page, 'Route101');
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
	await selectManualMap(page, 'Route104');
	await page.waitForFunction(
		() => /Miracle Seed/.test(document.querySelector('#runbun-run-items').textContent),
		null, {timeout: 10000});
	assert.match(await page.textContent('#runbun-run-items'), /opens at #11/);
	assert.equal(await page.$('#runbun-run-items .runbun-run-pickup-take'), null,
		'a gated item must not offer its button');

	await session.context.close();
});

test('the panel folds: collapsed headers stay live, opening is for acting', {skip}, async () => {
	const session = await open();
	const page = session.page;

	await page.click('.runbun-run-starter[data-species="Treecko"]');
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	// Everything folds by default except what starting a run opens for you:
	// the starter is in the roster and a party is required before the fight.
	const expanded = await page.$$eval('.rb-disclose-btn[aria-expanded="true"]',
		els => els.map(el => el.closest('.rb-disclose').getAttribute('data-section')));
	assert.deepEqual(expanded, ['box'], 'a fresh run opens exactly the roster section');
	// Collapsed content is not on the player's screen or in their tab order:
	// the region clips to zero height and the content is inert.
	const folded = await page.$eval('.rb-disclose[data-section="catch"] .rb-disclose-inner',
		el => el.getBoundingClientRect().height === 0 && el.hasAttribute('inert'));
	assert.ok(folded, 'a folded section keeps its ledger off the table');

	// The collapsed headers carry the live summary — informed without opening.
	assert.match(await page.textContent('.rb-disclose-summary[data-summary="box"]'),
		/1 reserve/);
	assert.match(await page.textContent('.rb-disclose-summary[data-summary="split"]'),
		/Brawly · \d+ fights/);
	assert.match(await page.textContent('.rb-disclose-summary[data-summary="road"]'),
		/#0 Youngster Calvin/);

	// The roster opened with the run, and the ledger is there to act on.
	await page.waitForSelector('#runbun-run-box', {state: 'visible', timeout: 5000});

	// An answer the player asks for must never land inside a fold: Advise
	// (in the always-visible hero) opens the Analysis section itself.
	await page.click('.rb-disclose[data-section="catch"] .rb-disclose-btn');
	await page.waitForSelector('#runbun-run-roll', {state: 'visible', timeout: 5000});
	await selectManualMap(page, 'Route101');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-encounters li').length > 5,
		null, {timeout: 10000});
	await page.fill('#runbun-run-catch-species', 'Poochyena');
	await page.fill('#runbun-run-catch-level', '3');
	await page.click('#runbun-run-catch');
	await page.waitForFunction(
		() => /caught/.test(document.querySelector('#runbun-run-status').textContent),
		null, {timeout: 10000});
	await page.click('.rb-disclose[data-section="box"] .rb-disclose-btn'); // fold it back
	await page.click('.rb-disclose[data-section="box"] .rb-disclose-btn');
	await page.waitForSelector('#runbun-run-box', {state: 'visible', timeout: 5000});
	await page.click('.runbun-run-mon[data-id="mon-1"] .runbun-run-add');
	await page.click('#runbun-run-set-party');
	await page.waitForFunction(
		() => JSON.parse(localStorage.getItem('runbun.run.v1')).party.length === 1,
		null, {timeout: 10000});
	assert.equal(await page.$eval('.rb-disclose[data-section="analysis"] .rb-disclose-inner',
		el => el.getBoundingClientRect().height), 0, 'analysis starts folded');
	await page.click('#runbun-run-advise');
	await page.waitForSelector('.runbun-run-advice-block', {state: 'visible', timeout: 30000});
	assert.equal(await page.getAttribute(
		'.rb-disclose[data-section="analysis"] .rb-disclose-btn', 'aria-expanded'), 'true');

	// The fold state is the player's: it survives a reload.
	await page.reload({waitUntil: 'domcontentloaded'});
	await page.waitForSelector('#runbun-run-live:not([hidden])', {timeout: 15000});
	assert.equal(await page.getAttribute(
		'.rb-disclose[data-section="analysis"] .rb-disclose-btn', 'aria-expanded'), 'true');
	assert.equal(await page.getAttribute(
		'.rb-disclose[data-section="road"] .rb-disclose-btn', 'aria-expanded'), 'false');

	await session.context.close();
});

test('no starter, no run — and ending one is a held, deliberate act', {skip}, async () => {
	const session = await open();
	const page = session.page;

	// The screen teaches the required first choice by withholding the action.
	assert.equal(await page.isDisabled('#runbun-run-new'), true);
	assert.equal(await page.evaluate(() => window.localStorage.getItem('runbun.run.v1')), null);

	await page.click('.runbun-run-starter[data-species="Mudkip"]');
	assert.equal(await page.isDisabled('#runbun-run-new'), false);
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	await page.waitForFunction(
		() => /Mudkip L5/.test(document.querySelector('#runbun-run-status').textContent),
		null, {timeout: 10000});
	assert.match((await savedRun(page)).attemptId, /^[0-9a-f-]{20,}$|^attempt-/,
		'a browser attempt should have a stable archive identity');
	// A fresh run has no party yet: every disabled planning tool names the
	// unlock instead of sitting mute.
	assert.equal(await page.getAttribute('#runbun-run-plan', 'title'),
		'Choose a party first', 'disabled Check matchup must say why');
	assert.equal(await page.getAttribute('#runbun-run-value', 'title'),
		'Choose a party first', 'disabled Test roster value must say why');

	// Ending a run rides the kit's hold-to-confirm: a short press releases
	// early and nothing happens — the fill sprang back, the run stands.
	await page.click('.runbun-run-transfer summary');
	const button = await page.$('#runbun-run-end');
	let box = await button.boundingBox();
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.down();
	await page.waitForTimeout(300);
	await page.mouse.up();
	await page.waitForTimeout(300);
	assert.ok(await page.evaluate(() => window.localStorage.getItem('runbun.run.v1')),
		'a released hold must not end the run');

	// Completion is evidence, not a free-form label: a run with required fights
	// ahead remains active and the result control receives the correction.
	await page.selectOption('#runbun-run-end-outcome', 'completed');
	await button.focus();
	await page.keyboard.down('Space');
	await page.waitForTimeout(1400);
	await page.keyboard.up('Space');
	assert.ok(await page.evaluate(() => window.localStorage.getItem('runbun.run.v1')),
		'an early run must not be archived as completed');
	assert.equal(await page.getAttribute('#runbun-run-end-outcome', 'aria-invalid'), 'true');
	assert.match(await page.textContent('#runbun-run-status'), /required fights ahead/);
	await page.selectOption('#runbun-run-end-outcome', 'wipe');

	// Held to the end with the keyboard, it commits: the setup screen returns,
	// the browser copy is cleared, and the final save is left in the transfer
	// box to copy. The short path above covers pointer cancellation; this path
	// also proves the destructive hold is not pointer-only.
	await button.focus();
	await page.keyboard.down('Space');
	await page.waitForTimeout(1400);
	await page.keyboard.up('Space');
	await page.waitForSelector('#runbun-run-empty:not([hidden])', {timeout: 15000});
	assert.equal(await page.evaluate(() => window.localStorage.getItem('runbun.run.v1')), null);
	assert.match(await page.inputValue('#runbun-run-transfer'), /"Mudkip"/,
		'the final save stays in the player\'s hands');
	const archivedBundle = JSON.parse(await page.inputValue('#runbun-run-transfer'));
	assert.equal(archivedBundle.modelVersion, '2.0.0');
	assert.equal(archivedBundle.events.at(-1).kind, 'run.ended');
	assert.equal(archivedBundle.events.at(-1).payload.outcome, 'wipe');
	assert.deepEqual(await page.evaluate(async () => {
		const entries = await window.RunBunAttemptStore.getDefault().listArchives();
		return entries.map(entry => entry.evidence && {
			revision: entry.evidence.revision,
			eventHash: entry.evidence.eventHash,
			checksum: entry.evidence.checksum,
		});
	}), [{
		revision: archivedBundle.head.revision,
		eventHash: archivedBundle.head.lastEventHash,
		checksum: archivedBundle.checksum,
	}]);
	await page.waitForSelector('#runbun-history-attempts .runbun-history-attempt',
		{state: 'visible', timeout: 10000});
	assert.match(await page.textContent('#runbun-history-attempts'), /Wiped/);
	assert.equal(await page.textContent('#runbun-history-tracked'), '1');
	assert.match(await page.textContent('#runbun-run-status'), /Run saved as Wiped/);

	// A quick save of the ended run resurfacing (a failed mirror clear, an
	// old tab writing late) must not resurrect the run, collide with its
	// archived head, or kill durable storage. It parks in the transfer box;
	// the panel stays on the start screen with durability intact.
	await page.evaluate(savedRunDoc => {
		window.localStorage.setItem('runbun.run.v1', JSON.stringify(savedRunDoc));
	}, archivedBundle.head.run);
	await page.reload({waitUntil: 'domcontentloaded'});
	await page.waitForSelector('#runbun-run-empty:not([hidden])', {timeout: 15000});
	assert.match(await page.textContent('#runbun-run-status'), /already ended/);
	assert.doesNotMatch(await page.textContent('#runbun-run-status'),
		/Durable storage became unavailable|could not open/);
	assert.match(await page.inputValue('#runbun-run-transfer'), /"Mudkip"/,
		'the parked quick save stays in the player\'s hands');
	assert.equal(await page.evaluate(() =>
		window.RunBunAttemptStore.getDefault().loadActive()), null,
	'the archived attempt must not become active again');

	await session.context.close();
});
