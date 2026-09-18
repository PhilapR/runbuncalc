/* eslint-env node, es6 */
'use strict';

/**
 * Browser gate for the My Run panel: starting a run and planning from it.
 *
 * The setup screen, the starter and rival, the rule toggles, the planning
 * provider, and the verdicts it paints. One of four shards of what was one
 * file; the save-integrity properties that motivate the whole gate are in
 * browser_run.test.js, and the shared harness is tests/helpers/browser-run.js.
 *
 * Skips rather than fails without Chromium, so the suite still runs headless.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const planningRequest = require('../contracts/ecosystem/v1/planning-request.json');
const seededProviderReceipt = require('../contracts/ecosystem/v1/seeded-provider-receipt.json');
const dataset = require('../lib/rl-dataset');

const browserRun = require('./helpers/browser-run.js');

const skip = browserRun.skip;
const harness = browserRun.harness;
const open = browserRun.open;
const openAllSections = browserRun.openAllSections;
const savedRun = browserRun.savedRun;
const durableHead = browserRun.durableHead;
const driveVisibleBattleToReceipt = browserRun.driveVisibleBattleToReceipt;
const selectManualMap = browserRun.selectManualMap;

browserRun.useBrowser();

test('a failed route list does not wedge the panel in its shipping state',
	{skip}, async () => {
	// index.template ships New Run disabled under "Loading the run panel…" and
	// only the bootstrap chain enables it. loadMaps was the one link that could
	// reject and the only one nobody caught, so an ordinary fetch failure —
	// offline, a reset connection, a tab waking on a dead radio — left the page
	// exactly as it shipped, with no message and no way back but a reload.
		const context = await harness.browser.newContext();
		await context.route(/fonts\.(googleapis|gstatic)\.com/, route => route.abort());
		await context.route('**/run/maps', route => route.abort('failed'));
		const page = await context.newPage();
		await page.goto(`${harness.baseUrl}/index.html#runbun-run`, {waitUntil: 'domcontentloaded'});

		// Bootstrap must FINISH. A run with no route list is a smaller thing than a
		// dead page: starter, gift, static and trade need no route.
		await page.waitForFunction(
			() => !document.querySelector('#runbun-run-new').disabled ||
			document.querySelector('.runbun-run-setup-form').getAttribute('aria-busy') === 'false',
			null, {timeout: 15000});
		assert.equal(await page.getAttribute('.runbun-run-setup-form', 'aria-busy'), 'false',
			'the form must stop claiming it is loading');

		// And it must say what happened, rather than looking merely empty.
		assert.match(await page.textContent('#runbun-run-status'),
			/started without its route list/,
			'a panel that lost its routes has to say so');
		await context.close();
	});

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
		revision: 'bf28a069148903cc02315cc434f91e24816045e2',
		plan: 'function',
		attribute: 'function',
	});
	assert.equal(await page.evaluate(() =>
		window.RunBunPokemonProvider.resolveTrainerOrder('Youngster Calvin')), 3);
	assert.deepEqual(await page.evaluate(request =>
		window.RunBunPokemonProvider.provider.plan(request), planningRequest),
	seededProviderReceipt, 'browser provider must reproduce pokemon-mono canonical receipt exactly');

	await page.check('#runbun-run-new-route');
	await page.click('.runbun-run-starter[data-species="Turtwig"]');
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	await openAllSections(page);
	// The restored Route 103 rival stands first; this test's subject is
	// Calvin, so clear the rival the way a player would.
	await page.click('#runbun-run-upcoming .runbun-run-up.is-next .runbun-run-up-beat');
	await page.waitForFunction(() => /Youngster Calvin/.test(
		document.querySelector('#runbun-run-upcoming .runbun-run-up.is-next').textContent),
	null, {timeout: 10000});

	// One real route roll supplies the reserve used by the replacement test.
	// Its owned IVs are facts from the roll, and must survive reconstruction.
	await selectManualMap(page, 'Route101');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-encounters li').length > 5,
		null, {timeout: 10000});
	await page.click('#runbun-run-roll');
	await page.waitForSelector('#runbun-run-roll-result:not([hidden])', {timeout: 10000});
	// The battle/keep/flee decision reads its odds before committing —
	// quoted at full HP by the same formula the fight's ball buttons use.
	await page.waitForFunction(
		() => /Catch at full HP: Poke Ball \d+%/.test(
			document.querySelector('#runbun-run-roll-odds').textContent),
		null, {timeout: 10000});
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
		/PARTIAL PLAN · Pokemon Mono · lead Turtwig L5 · \d+ of 8 fair-dice samples came back clean/);

	// The verdict carries the survival answer, not only the action margin. The
	// margin says how clear the MOVE choice is and reads like a judgement on
	// the fight: across 313 planned fights with a live forecast, "decided by 5
	// or more" split six-all on whether anybody died. The worst real example is
	// "Team Aqua Grunt Petalburg Woods — decided by 12.4 · a sampled branch
	// loses 4 Pokemon", which without this clause reads as a safe fight.
	assert.match(await page.textContent('#runbun-run-plan-verdict'),
		/(samples clean, none of them lost anyone|a sampled branch loses \d+ Pokemon)/,
		'a live forecast must reach the verdict, not just the row below it');
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
		/Modeled roster value.*Baseline · \d+\/4 paired seeds deathless.*IV reference test · Turtwig → all 15/s);
	assert.match(await page.textContent('#runbun-run-attribution'),
		/Replacement test · Turtwig → .+ · .*4 paired seeds/s,
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
		/Modeled value · fixed-seed tests.*IV reference test · Turtwig → all 15/s);
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

	await page.click('.runbun-run-starter[data-species="Turtwig"]');
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');

	// The restored Route 103 rival stands first; this test's subject is
	// Calvin, so clear the rival the way a player would. Only the road
	// section opens for it — the box must still open by itself below.
	await page.click('.rb-disclose[data-section="road"] .rb-disclose-btn');
	await page.click('#runbun-run-upcoming .runbun-run-up.is-next .runbun-run-up-beat');
	await page.waitForFunction(() => /Youngster Calvin/.test(
		document.querySelector('#runbun-run-upcoming .runbun-run-up.is-next').textContent),
	null, {timeout: 10000});

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
	assert.match(await page.textContent('#runbun-run-mon-summary-name'), /Turtwig · L5/);
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
	// Five, not four. Littleroot Town and Oldale Town joined the openers when
	// the R&B tracker dated them, and Petalburg City left — it is reachable
	// only through Route 102. Both changes are Philip's, from play.
	assert.match(await page.textContent('#runbun-run-opportunity-list'),
		/5 encounter areas/);
	assert.match(await page.textContent('#runbun-run-opportunity-list'),
		/2 field items/);
	assert.match(await page.textContent('#runbun-run-opportunity-list'),
		/0 TMs & tutors reachableNone reachable yet · \d+ known places, undated/);
	assert.equal(await page.$$eval('#runbun-run-reachable .runbun-run-route-choice',
		buttons => buttons.length), 5,
	'Explore should begin with the five reachable choices, not the complete ROM catalog');

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
	await page.click('.runbun-run-starter[data-species="Turtwig"]');
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

test('the verdict warns about a sash-threshold set the samples cannot price', {skip}, async () => {
	// Fisherman Darian's Magikarp holds Focus Sash + Flail — the earliest of 41
	// fights whose danger scales with the enemy's own missing health, a scaling
	// the fair-dice sampler is known blind to. Battle Girl Lilith's version of
	// this set was forecast "worst sampled branch loses 1" fourteen times and
	// swept six Pokemon in twelve. The warning must reach the DOM the player
	// reads, not only the plan object.
	const session = await open();
	const page = session.page;

	await page.click('.runbun-run-starter[data-species="Turtwig"]');
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

	// Plan Darian from the road-ahead list — the panel shows eight upcoming
	// fights and he is the sixth.
	await page.click('.runbun-run-up-plan[data-trainer="Fisherman Darian"]');
	await page.waitForFunction(
		() => /CAUTION/.test(document.querySelector('#runbun-run-plan-verdict').textContent),
		null, {timeout: 20000});
	const warned = await page.textContent('#runbun-run-plan-verdict');
	assert.match(warned, /Magikarp holds Focus Sash \+ Flail/,
		'the set is named, not gestured at');
	assert.match(warned, /under-price pinch moves/,
		'and the reason is stated: the samples cannot price this');

	// A fight with no such set must NOT carry the warning — a caution on every
	// verdict is a caution on none.
	await page.click('#runbun-run-plan');
	await page.waitForFunction(
		() => /decided|contested|only one/.test(
			document.querySelector('#runbun-run-plan-verdict').textContent) &&
			!/CAUTION/.test(document.querySelector('#runbun-run-plan-verdict').textContent),
		null, {timeout: 20000});

	await session.context.close();
});

test('an answer the run has moved past is marked stale', {skip}, async () => {
	// Plan, Advise, Rank, Routes and Board are computed against the run AS IT
	// WAS. That is fine — they are on-demand questions — but an advisor sheet
	// computed three catches ago must not LOOK like current advice.
	const session = await open();
	const page = session.page;

	await page.click('.runbun-run-starter[data-species="Turtwig"]');
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

test('the starter is picked on the setup screen, and the rival follows from it', {skip}, async () => {
	const session = await open();
	const page = session.page;

	// Three buttons, one pressed at a time; pressing the pressed one clears.
	await page.click('.runbun-run-starter[data-species="Turtwig"]');
	assert.equal(await page.getAttribute('.runbun-run-starter[data-species="Turtwig"]', 'aria-pressed'), 'true');
	await page.click('.runbun-run-starter[data-species="Piplup"]');
	assert.equal(await page.getAttribute('.runbun-run-starter[data-species="Turtwig"]', 'aria-pressed'), 'false');
	assert.equal(await page.getAttribute('.runbun-run-starter[data-species="Piplup"]', 'aria-pressed'), 'true');
	await page.click('.runbun-run-starter[data-species="Piplup"]');
	assert.equal(await page.getAttribute('.runbun-run-starter[data-species="Piplup"]', 'aria-pressed'), 'false');

	// Start with Turtwig: the gift is in the box before anything else happens,
	// and the rival is fixed to the line that answers it — the one Turtwig
	// beats, whose ace is Swampert.
	await page.click('.runbun-run-starter[data-species="Turtwig"]');
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	await openAllSections(page);
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-box .runbun-run-mon').length === 1,
		null, {timeout: 10000});
	const saved = await savedRun(page);
	assert.equal(saved.box[0].species, 'Turtwig');
	assert.equal(saved.box[0].level, 5);
	// The rival counters the pick: Turtwig fixes them to Blaziken (operator
	// ruling, 2026-08-28 — the first model had vanilla Emerald's friendly
	// direction and gave every run the wrong three spine variants).
	assert.equal(saved.rules.rival, 'Blaziken');
	assert.match(await page.textContent('#runbun-run-status'), /Turtwig L5 is in the box/);

	await session.context.close();
});

test('no starter, no run — and ending one is a held, deliberate act', {skip}, async () => {
	const session = await open();
	const page = session.page;

	// The screen teaches the required first choice by withholding the action.
	assert.equal(await page.isDisabled('#runbun-run-new'), true);
	assert.equal(await page.evaluate(() => window.localStorage.getItem('runbun.run.v1')), null);

	await page.click('.runbun-run-starter[data-species="Piplup"]');
	assert.equal(await page.isDisabled('#runbun-run-new'), false);
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	await page.waitForFunction(
		() => /Piplup L5/.test(document.querySelector('#runbun-run-status').textContent),
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
	assert.match(await page.inputValue('#runbun-run-transfer'), /"Piplup"/,
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
	// Opening the history section by its own header must render the real
	// ledger too — not only the Run history button. Close, reopen, re-render.
	const historyHeader = '.rb-disclose[data-section="history"] .rb-disclose-btn';
	await page.click(historyHeader);
	await page.click(historyHeader);
	await page.waitForFunction(() =>
		document.querySelector('#runbun-history-tracked').textContent === '1',
	null, {timeout: 10000});
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
	assert.match(await page.inputValue('#runbun-run-transfer'), /"Piplup"/,
		'the parked quick save stays in the player\'s hands');
	assert.equal(await page.evaluate(() =>
		window.RunBunAttemptStore.getDefault().loadActive()), null,
	'the archived attempt must not become active again');

	await session.context.close();
});
