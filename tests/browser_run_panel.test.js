/* eslint-env node, es6 */
'use strict';

/**
 * Browser gate for the My Run panel: routes, catches, the box, and layout.
 *
 * What a player reads and taps between fights — route lists, rolls, items,
 * the box — and whether the panel holds its shape on a phone. One of four
 * shards of what was one file; the save-integrity properties that motivate
 * the whole gate are in browser_run.test.js, and the shared harness is
 * tests/helpers/browser-run.js.
 *
 * Skips rather than fails without Chromium, so the suite still runs headless.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const browserRun = require('./helpers/browser-run.js');

const skip = browserRun.skip;
const harness = browserRun.harness;
const open = browserRun.open;
const openAllSections = browserRun.openAllSections;
const savedRun = browserRun.savedRun;
const selectManualMap = browserRun.selectManualMap;

browserRun.useBrowser();

test('a player starts a run, catches off a real route, and plans the next fight', {skip}, async () => {
	const session = await open();
	const page = session.page;

	await page.fill('#runbun-run-new-name', 'Browser Run');
	await page.check('#runbun-run-new-cap');
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

	// The story spine renders one tick per milestone — 39 now that the Route
	// 103 rival is restored, because the declared rival pruned the other two
	// variants of every rival milestone. The one beaten tick is that rival,
	// cleared above so Calvin is this test's fight.
	assert.equal(await page.$$eval('#runbun-run-spine li', els => els.length), 39);
	assert.equal(await page.$$eval('#runbun-run-spine li.is-beaten', els => els.length), 1);
	assert.match(await page.textContent('#runbun-run-spine-note'), /1 \/ 39 milestones/);

	await page.click('#runbun-run-plan');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-plan-actions .runbun-run-action').length > 1,
		null, {timeout: 15000});
	const verdict = await page.textContent('#runbun-run-plan-verdict');
	// With the Route 103 rival cleared, Calvin is the next battle in the map.
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
	assert.match(await page.textContent('#runbun-run-matrix-note'), /Youngster Calvin \(#2\)/);
	const cells = await page.$$eval('#runbun-run-matrix td', els => els.map(el => el.textContent));
	// Every board cell is a doorway: one click opens this exact pairing in
	// the calculator — our mon with its rolled identity, their mon by set.
	await page.click('#runbun-run-matrix td[data-mon-id]');
	await page.waitForFunction(() => window.location.hash === '#calc');
	assert.match(await page.$eval('.calc-player-column .select2-chosen', el => el.textContent),
		/\(My Run\)$/, 'the pairing must load our run mon on the player side');
	assert.match(await page.$eval('.calc-opponent-column .select2-chosen', el => el.textContent),
		/\(Youngster Calvin\)$/, 'the pairing must load the trainer set opposite');
	await page.evaluate(() => { window.location.hash = '#runbun-run'; });
	assert.ok(cells.length >= 2, 'both directions should render cells');
	assert.ok(cells.every(text => /%|—/.test(text)), 'every cell is a percent or an honest dash');

	// Pin this owned stat to a deterministic non-perfect value before testing the
	// economy. Game-owned Pokemon already have all six IVs; this is an edit, not
	// filling an unknown.
	// The editor toolbench acts on the SELECTED Pokemon; before a selection
	// exists it is a bench of levers wired to nothing, and it hides.
	assert.equal(await page.$eval('#runbun-run-mon-tools', el => el.hidden), true,
		'the details editor must hide until a Pokemon is selected');
	await page.click('.runbun-run-mon[data-id="mon-1"] .runbun-run-mon-select');
	assert.equal(await page.$eval('#runbun-run-mon-tools', el => el.hidden), false,
		'selecting a Pokemon reveals its editor');
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
	// The run -> calculator bridge: one click loads THIS Pokemon's exact
	// rolled identity into the player slot, level projected to the cap, and
	// lands on the calculator tab. The set lives only in the live setdex —
	// never persisted, because the run is the authority.
	await page.click('#runbun-run-open-calc');
	await page.waitForFunction(() => window.location.hash === '#calc');
	assert.equal(await page.$eval('.calc-player-column .select2-chosen', el => el.textContent),
		'Turtwig (My Run)', 'the player slot must hold the run set');
	const bridged = await page.evaluate(() => {
		const saved = JSON.parse(window.localStorage.getItem('runbun.run.v1'));
		const mon = saved.box.find(entry => entry.species === 'Turtwig');
		const p1 = document.querySelector('.calc-player-column');
		return {
			level: p1.querySelector('.level').value,
			nature: p1.querySelector('.nature').value,
			calcIvs: ['hp', 'at', 'df', 'sa', 'sd', 'sp']
				.map(k => p1.querySelector('.' + k + ' .ivs').value).join(','),
			runIvs: [mon.ivs.hp, mon.ivs.atk, mon.ivs.def,
				mon.ivs.spa, mon.ivs.spd, mon.ivs.spe].join(','),
			persisted: window.localStorage.customsets || null,
		};
	});
	assert.equal(bridged.level, '12', 'the bridged level must be projected to the cap');
	assert.equal(bridged.calcIvs, bridged.runIvs,
		'the calculator must carry the run\'s exact rolled IVs');
	assert.equal(bridged.persisted, null,
		'the run set must never leak into persistent custom sets');
	// The calculator's own tab is run-aware: the party rides in as chips, so
	// a player already in the calculator never has to leave it to load their
	// own Pokemon (or hand-enter six IVs the run already knows).
	assert.equal(await page.isVisible('#runbun-calc-party'), true,
		'an active run shows its party in the calculator');
	await page.click('.runbun-calc-party-chip');
	const fromChip = await page.evaluate(() => {
		const p1 = document.querySelector('.calc-player-column');
		const saved = JSON.parse(window.localStorage.getItem('runbun.run.v1'));
		const mon = saved.box.find(entry => entry.id === saved.party[0]);
		return {
			chosen: p1.querySelector('.select2-chosen').textContent,
			calcIvs: ['hp', 'at', 'df', 'sa', 'sd', 'sp']
				.map(k => p1.querySelector('.' + k + ' .ivs').value).join(','),
			runIvs: [mon.ivs.hp, mon.ivs.atk, mon.ivs.def,
				mon.ivs.spa, mon.ivs.spd, mon.ivs.spe].join(','),
		};
	});
	assert.match(fromChip.chosen, /\(My Run\)$/, 'the chip loads the run set');
	assert.equal(fromChip.calcIvs, fromChip.runIvs,
		'a party chip carries the run\'s exact rolled IVs');
	await page.evaluate(() => { window.location.hash = '#runbun-run'; });
	await page.click('#runbun-run-mon-record summary');
	await page.fill('#runbun-run-observed-iv-spe', '5');
	await page.click('#runbun-run-record-details');
	await page.waitForFunction(
		() => /recorded Turtwig/.test(document.querySelector('#runbun-run-status').textContent),
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
		/Youngster Calvin \(#2\) · \d+ available upgrades compared.*TM\/tutor moves skipped/);
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

test('routes, scout and rank render in the panel with the availability data', {skip}, async () => {
	const session = await open();
	const page = session.page;

	await page.fill('#runbun-run-new-name', 'Routes Run');
	await page.check('#runbun-run-new-nuzlocke');
	await page.click('.runbun-run-starter[data-species="Turtwig"]');
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
		/vs Leader Brawly \(#27\) at cap 21/);
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

test('the page fits a phone: every active mode reflows without page overflow', {skip}, async () => {
	// Drive the page at a real phone size and assert the property that matters:
	// the active game and calculator both fit the viewport without turning the
	// page into a clipped desktop canvas.
	const context = await harness.browser.newContext({viewport: {width: 390, height: 844}});
	await context.route(/fonts\.(googleapis|gstatic)\.com/, route => route.abort());
	const page = await context.newPage();
	await page.goto(`${harness.baseUrl}/index.html#runbun-run`, {waitUntil: 'domcontentloaded'});
	await page.waitForSelector('#runbun-run');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-map option').length > 100,
		null, {timeout: 15000});

	// The shell renders one working surface at every viewport. Inactive regions
	// leave layout entirely, so their controls cannot stretch the page.
	assert.equal(await page.isVisible('#calc'), false,
		'the inactive calc region should collapse on a phone');
	await page.click('.runbun-run-starter[data-species="Turtwig"]');
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

test('items are guided onto their routes: listed where they stand, one tap to collect', {skip}, async () => {
	const session = await open();
	const page = session.page;

	await page.click('.runbun-run-starter[data-species="Turtwig"]');
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
	// not collectable: Route 104's Miracle Seed opens at ORDER 14 (11 before
	// the Route 103 rival trio rejoined the map ahead of it).
	await selectManualMap(page, 'Route104');
	await page.waitForFunction(
		() => /Miracle Seed/.test(document.querySelector('#runbun-run-items').textContent),
		null, {timeout: 10000});
	assert.match(await page.textContent('#runbun-run-items'), /opens at #14/);
	assert.equal(await page.$('#runbun-run-items .runbun-run-pickup-take'), null,
		'a gated item must not offer its button');

	// The bag now holds exactly one Potion, and a Potion is not a held item.
	// The picker used to offer it, `give` used to take it, and the refusal
	// arrived two actions later from the calculator — naming a battle slot,
	// not a box entry — with the run unable to plan or fight until somebody
	// worked out who was holding what.
	await page.click('#runbun-run-box .runbun-run-mon .runbun-run-mon-select');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-hold-item option').length > 0,
		null, {timeout: 10000});
	const offered = await page.$$eval('#runbun-run-hold-item option',
		els => els.map(el => el.value).filter(Boolean));
	assert.deepEqual(offered, [],
		'a bag of nothing but Potions offers nothing to hold');
	assert.match(await page.textContent('#runbun-run-hold-item'),
		/Nothing in the bag can be held/,
		'and says which kind of empty it is — not "the bag is empty", which is false');

	// A real held item appears the moment it is in the bag, so the filter is
	// the item's nature and not an empty picker.
	await page.fill('#runbun-run-acquire-item', 'Oran Berry');
	await page.click('#runbun-run-acquire');
	await page.waitForFunction(
		() => Array.from(document.querySelectorAll('#runbun-run-hold-item option'))
			.some(el => el.value === 'Oran Berry'),
		null, {timeout: 10000});
	const withBerry = await page.$$eval('#runbun-run-hold-item option',
		els => els.map(el => el.value).filter(Boolean));
	assert.deepEqual(withBerry, ['Oran Berry'],
		'the berry is offered and the Potion still is not');

	await session.context.close();
});

test('the roll shows the identity it already rolled, before keep or flee', {skip}, async () => {
	// The roll authors an identity — six IVs, a nature, an ability — and hands
	// it straight to the catch command. None of it was on screen, so the one
	// decision a nuzlocke route allows was made blind to the part of it that
	// was already decided. IV total is the number that matters most: a wild
	// roll averages 93 against the flat 186 every trainer is built with.
	const session = await open();
	const page = session.page;
	await page.check('#runbun-run-new-route');
	await page.click('.runbun-run-starter[data-species="Turtwig"]');
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	await openAllSections(page);

	await selectManualMap(page, 'Route101');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-encounters li').length > 5,
		null, {timeout: 10000});
	await page.click('#runbun-run-roll');
	await page.waitForSelector('#runbun-run-roll-result:not([hidden])', {timeout: 10000});
	await page.waitForFunction(
		() => (document.querySelector('#runbun-run-roll-identity') || {}).textContent,
		null, {timeout: 10000});
	const shown = await page.textContent('#runbun-run-roll-identity');

	// It has to be the SAME identity the catch then stores — a quote that
	// drifts from what lands in the box is worse than no quote.
	await page.click('#runbun-run-roll-catch');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-box .runbun-run-mon').length === 2,
		null, {timeout: 10000});
	const caught = (await savedRun(page)).box[1];
	const total = ['hp', 'atk', 'def', 'spa', 'spd', 'spe']
		.reduce((sum, stat) => sum + caught.ivs[stat], 0);
	assert.match(shown, new RegExp('IV ' + total + '/186'),
		'the quoted IV total must be the one the catch stores');
	assert.ok(shown.includes(caught.nature), `nature ${caught.nature} missing from "${shown}"`);
	assert.ok(shown.includes(caught.ability), `ability ${caught.ability} missing from "${shown}"`);

	// A settled roll takes its card away, so the quote cannot outlive the
	// decision it was for.
	assert.equal(await page.isVisible('#runbun-run-roll-result'), false);
	await session.context.close();
});

test('the box says what each Pokemon rolled, against what a trainer gets', {skip}, async () => {
	// Every trainer Pokemon is built with 31s — 186 total. Every wild catch
	// keeps what it rolled: a mean of 93, and a spread across a box from about
	// 56 to 130. So the gap between the best and worst catch you own is about
	// the size of the gap to the opponent, and the only place that showed was
	// the summary screen, one Pokemon at a time, as six separate numbers.
	const session = await open();
	const page = session.page;
	await page.click('.runbun-run-starter[data-species="Piplup"]');
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	await openAllSections(page);

	// A catch with every IV recorded prints its total against 186.
	await selectManualMap(page, 'Route101');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-encounters li').length > 5,
		null, {timeout: 10000});
	await page.click('#runbun-run-roll');
	await page.waitForSelector('#runbun-run-roll-result:not([hidden])', {timeout: 10000});
	await page.click('#runbun-run-roll-catch');
	// Two rows, not one: the reserve list holds the starter as well until a
	// party is committed.
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-box .runbun-run-mon').length === 2,
		null, {timeout: 10000});

	const caught = (await savedRun(page)).box[1];
	const expected = ['hp', 'atk', 'def', 'spa', 'spd', 'spe']
		.reduce((sum, stat) => sum + caught.ivs[stat], 0);
	// Address the CATCH by id: the reserve list also holds the starter, and
	// the first row is not the one whose roll we just read.
	const kit = await page.textContent(
		'#runbun-run-box .runbun-run-mon[data-id="' + caught.id + '"] .runbun-run-mon-kit');
	assert.match(kit, new RegExp('IV ' + expected + '/186'),
		'the reserve row carries the rolled total and what it is measured against');

	// The party strip says it too, because that is where the six are chosen.
	await page.click('#runbun-run-box .runbun-run-mon[data-id="' + caught.id +
		'"] .runbun-run-add');
	assert.match(await page.textContent('#runbun-run-party-strip .runbun-run-party-meta'),
		new RegExp('IV ' + expected + '/186'));

	// A PARTIAL record must not read as a low roll. There is no way to make
	// one through the panel — every catch fetches a rolled identity first —
	// so the case that matters is the one the IV note already names: a legacy
	// or imported save. Import is the honest way to reach it.
	const partialRun = await page.evaluate(expectedTotal => {
		const run = JSON.parse(localStorage.getItem('runbun.run.v1'));
		const mon = run.box[run.box.length - 1];
		delete mon.ivs.spa;
		delete mon.ivs.spd;
		delete mon.ivs.spe;
		// The LOG is what an import replays, so editing only the box is
		// undone the moment the run is adopted — the catch command carries
		// the rolled identity and rebuilds all six.
		for (const entry of run.log) {
			if (entry.command && entry.command.kind === 'catch' && entry.command.ivs) {
				delete entry.command.ivs.spa;
				delete entry.command.ivs.spd;
				delete entry.command.ivs.spe;
			}
		}
		return {json: JSON.stringify(run), id: mon.id, expectedTotal: expectedTotal};
	}, expected);
	// The transfer box lives in a details that openAllSections leaves shut on
	// purpose; every other import test opens it by its summary.
	await page.click('.runbun-run-transfer summary');
	await page.fill('#runbun-run-transfer', partialRun.json);
	await page.click('#runbun-run-import');
	// Wait for the IMPORT, not for the row to mention an IV. The pre-import row
	// already reads "IV 84/186", so a /IV / condition is true before the click
	// is even handled: this waited on a state it was already in, read the old
	// row, and reported the product had summed the missing stats as zero. It
	// had not. The server echoes {hp,atk,def} and paint renders that faithfully.
	//
	// The status line is the one signal that means the adoption finished, and
	// it is independent of the thing being asserted — so a genuine regression
	// still fails on the assertion below rather than passing on a lucky race.
	await page.waitForFunction(
		() => /Imported run\./.test(
			(document.querySelector('#runbun-run-status') || {}).textContent || ''),
		null, {timeout: 10000});
	const partial = await page.textContent(
		'#runbun-run-box .runbun-run-mon[data-id="' + partialRun.id + '"] .runbun-run-mon-kit');
	assert.match(partial, /IV \d+\+ · 3 not recorded/,
		'three unrecorded stats must say so rather than summing as zero');
	assert.doesNotMatch(partial, /\/186/, 'and must not claim a total it cannot know');

	// The median is built from FULLY known rolls only, so a partial record
	// cannot drag it down: the starter is the only complete one left.
	assert.match(await page.textContent('#runbun-run-box-counts'), /IV median \d+\/186/);

	await session.context.close();
});

test('the panel folds: collapsed headers stay live, opening is for acting', {skip}, async () => {
	const session = await open();
	const page = session.page;

	await page.click('.runbun-run-starter[data-species="Turtwig"]');
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
		/#1 Trainer Rival Route 103 Blaziken/);

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

test('nothing in the run panel overflows, clips its own label, or paints as an empty rule', {skip}, async () => {
	// Three layout defects that only a real browser can see, all found by
	// measuring rather than looking.
	//
	// Upstream's base .btn is a FIXED width: 5em. The calculator opts into
	// .btn-wide per button; the run panel's labels are variable-length prose,
	// so "Undo last change" was handed 67px for 114px of text — first wrapping
	// onto two lines, then overflowing 42px past the column once nowrap was
	// added to stop the wrap.
	//
	// And .runbun-run-plan-actions / .runbun-run-advice carry a 1px border, so
	// while empty they painted a 2px-tall bordered box: a stray rule under the
	// party strip that read as a broken divider.
	const opened = await open();
	const page = opened.page;
	await page.click('.runbun-run-starter[data-species="Piplup"]');
	await page.evaluate(() => document.querySelector('#runbun-run-new').click());
	await page.waitForSelector('#runbun-run-undo');
	await openAllSections(page);

	for (const size of [{width: 1280, height: 900}, {width: 375, height: 812}]) {
		await page.setViewportSize(size);
		const report = await page.evaluate(() => {
			const live = document.querySelector('#runbun-run');
			const box = live.getBoundingClientRect();
			const overflowing = [...live.querySelectorAll('*')]
				.filter(el => {
					const r = el.getBoundingClientRect();
					return r.width > 0 && r.right > box.right + 1;
				})
				.map(el => `${el.tagName}.${String(el.className).slice(0, 40)}`);
			// A label is CLIPPED only when the box actually cuts it off: the
			// content is wider AND overflow hides it. On a flex header with
			// overflow:visible, scrollWidth can exceed clientWidth by a pixel
			// or two (a scrollbar narrowing the client box is enough) while
			// nothing is truncated — the first version of this check flagged
			// all seven section headers for exactly that, and they measure
			// delta 0 in a real window. Overflow that is merely visible is
			// caught by the overflowing check above instead.
			const clipped = [...live.querySelectorAll('button')]
				.filter(el => {
					const hides = getComputedStyle(el).overflowX !== 'visible';
					return hides && el.scrollWidth > el.clientWidth + 2;
				})
				.map(el => `${el.textContent.trim().replace(/\s+/g, ' ').slice(0, 32)} ` +
					`(${el.scrollWidth} into ${el.clientWidth})`);
			// An element with no children and no text that still paints a
			// visible horizontal band is a border with nothing to border.
			const phantomRules = [...live.querySelectorAll('*')]
				.filter(el => {
					const r = el.getBoundingClientRect();
					return r.height > 0 && r.height <= 3 && r.width > 40 &&
						!el.children.length && !el.textContent.trim();
				})
				.map(el => String(el.className).slice(0, 40));
			return {
				overflowing, clipped, phantomRules,
				documentOverflow: document.documentElement.scrollWidth -
					document.documentElement.clientWidth,
			};
		});
		const where = `${size.width}x${size.height}`;
		assert.deepEqual(report.overflowing, [],
			`nothing may extend past the run panel at ${where}`);
		assert.deepEqual(report.clipped, [],
			`every button must be wide enough for its own label at ${where}`);
		assert.deepEqual(report.phantomRules, [],
			`an empty container must not paint its border at ${where}`);
		assert.equal(report.documentOverflow, 0,
			`the page must not scroll sideways at ${where}`);
	}
	await opened.context.close();
});

test('the worst-case cell is a control, and pressing it actually answers', {skip}, async () => {
	// Found by playing a run. The readiness strip showed "Worst case: Check
	// matchup" as PLAIN TEXT, beside a button of exactly that name — and that
	// button runs plan(), which answers a different question (how contested
	// the opponent's choice is) and never touches this cell. Only board()
	// computes the worst case, and board() had no control anywhere in the
	// strip. So the instruction named a button that could not satisfy it, and
	// following it did nothing at all.
	const opened = await open();
	const page = opened.page;
	await page.click('.runbun-run-starter[data-species="Piplup"]');
	await page.evaluate(() => document.querySelector('#runbun-run-new').click());
	await page.waitForSelector('#runbun-run-undo');

	// A party is needed before a matchup means anything.
	await page.evaluate(() => {
		const add = [...document.querySelectorAll('button')]
			.find(b => /Add .* to staged party/i.test(b.getAttribute('aria-label') || ''));
		if (add) add.click();
	});
	await page.evaluate(() => {
		const use = [...document.querySelectorAll('button')]
			.find(b => /^Use this party$/i.test(b.textContent.trim()));
		if (use) use.click();
	});
	await page.waitForFunction(
		() => /lead/i.test(document.querySelector('#runbun-run-ready-party').textContent),
		null, {timeout: 15000});

	// Assert on the control only AFTER the strip has re-rendered. Checking it
	// straight after page load proved nothing: index.template.html ships the
	// button in the initial markup, so the assertion passed even with
	// renderWorstCase reverted to writing plain text. The party change forces
	// a real render through the JS path being tested.
	const control = await page.$('#runbun-run-ready-risk-check');
	assert.ok(control,
		'the unanswered worst-case cell must be a button, not prose');
	// Where that button comes from matters. renderWorstCase has exactly one
	// call site — the board render — so its !verdict branch is only a RESTORE
	// path; the control a player actually meets is shipped by
	// index.template.html. Reverting the JS alone therefore changes nothing
	// visible, which is why this asserts the template too.
	const template = fs.readFileSync(
		path.join(__dirname, '..', 'src/index.template.html'), 'utf8');
	assert.match(template,
		/<dd id="runbun-run-ready-risk">\s*<button[^>]*id="runbun-run-ready-risk-check"/,
		'the readiness strip must ship the worst-case control, not a bare label');
	assert.equal(
		await page.$eval('#runbun-run-ready-risk-check', el => el.tagName),
		'BUTTON', 'and a real button, so it is reachable by keyboard');

	// Pressing it must produce an answer, not leave the same instruction.
	await page.click('#runbun-run-ready-risk-check');
	await page.waitForFunction(
		() => !document.querySelector('#runbun-run-ready-risk-check'),
		null, {timeout: 30000});
	const answered = await page.$eval('#runbun-run-ready-risk',
		el => ({text: el.textContent.trim(), risk: el.getAttribute('data-risk')}));
	assert.notEqual(answered.text, 'Check matchup',
		'the cell must stop asking once it has been asked');
	assert.ok(['safe', 'thin', 'lethal'].includes(answered.risk),
		`the cell must carry a verdict, got ${JSON.stringify(answered)}`);

	await opened.context.close();
});

test('a member unstaged from the party returns to the PC list with its add control', {skip}, async () => {
	// Found by playing a run. The PC list was built from the COMMITTED party
	// while the strip draws the STAGED one, so the strip's × took a member
	// off the screen entirely: the strip empty, the list still saying
	// "Every living Pokémon is in the party.", and no control anywhere to
	// bring it back short of committing a party nobody wanted, or reloading.
	const opened = await open();
	const page = opened.page;
	await page.click('.runbun-run-starter[data-species="Piplup"]');
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	await openAllSections(page);

	await page.click('.runbun-run-mon[data-id="mon-1"] .runbun-run-add');
	await page.click('#runbun-run-set-party');
	await page.waitForFunction(
		() => JSON.parse(localStorage.getItem('runbun.run.v1')).party[0] === 'mon-1' &&
			!document.querySelector('#runbun-run-box .runbun-run-mon[data-id="mon-1"]'),
		null, {timeout: 10000});
	assert.match(await page.textContent('#runbun-run-box'), /Every living Pokémon is in the party/);

	// Unstage it. It must land somewhere a player can press.
	await page.click('#runbun-run-party-strip .runbun-run-party-rm[data-id="mon-1"]');
	assert.equal(await page.$$eval('#runbun-run-party-strip .runbun-run-party-slot[data-id]',
		els => els.length), 0, 'the strip dropped it');
	assert.equal(await page.$$eval('#runbun-run-box .runbun-run-mon[data-id="mon-1"] .runbun-run-add',
		els => els.length), 1, 'the unstaged member must be back in the PC list with an add control');
	assert.doesNotMatch(await page.textContent('#runbun-run-box'), /Every living Pokémon is in the party/,
		'the list must not claim the party holds a member the strip just dropped');
	assert.match(await page.textContent('#runbun-run-box-counts'), /^1 reserve/);

	// And the control works: pressing it restages, and the list gives it back.
	await page.click('#runbun-run-box .runbun-run-mon[data-id="mon-1"] .runbun-run-add');
	assert.equal(await page.$$eval('#runbun-run-party-strip .runbun-run-party-slot[data-id="mon-1"]',
		els => els.length), 1);
	assert.equal(await page.$$eval('#runbun-run-box .runbun-run-mon[data-id="mon-1"]',
		els => els.length), 0, 'restaged as committed, it leaves the reserve again');
	assert.equal(await page.isVisible('#runbun-run-set-party'), false,
		'the staged six equals the committed one, so there is nothing to commit');

	await opened.context.close();
});

test('a ranked six is a control: pressing it stages that party, lead first', {skip}, async () => {
	// Found by playing a run. Best parties rendered every six as spans in a
	// bare <ol>: no way to press the winner, and no ids on the row, so the
	// player read species names off it and rebuilt the six by hand, in order.
	const opened = await open();
	const page = opened.page;
	await page.click('.runbun-run-starter[data-species="Turtwig"]');
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	await openAllSections(page);
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

	const six = await page.$eval('#runbun-run-ranking .runbun-run-rank-row .runbun-run-rank-six',
		el => ({tag: el.tagName, ids: el.getAttribute('data-ids'), text: el.textContent,
			label: el.getAttribute('aria-label')}));
	assert.equal(six.tag, 'BUTTON', 'the six must be a real button, reachable by keyboard');
	const ids = six.ids.split(',');
	assert.equal(ids.length, 2, 'the row names both Pokémon in the box');
	assert.match(six.label, /^Stage this party: \w+ \(lead\), \w+$/);

	await page.click('#runbun-run-ranking .runbun-run-rank-row .runbun-run-rank-six');
	assert.deepEqual(
		await page.$$eval('#runbun-run-party-strip .runbun-run-party-slot[data-id]',
			els => els.map(el => el.getAttribute('data-id'))),
		ids, 'the strip must hold exactly the ranked six, lead first');
	// The bracketed species on the row is the one the strip leads with.
	const lead = /\[(\w+)\]/.exec(six.text)[1];
	assert.match(await page.textContent('#runbun-run-party-strip .runbun-run-party-slot[data-id]'),
		new RegExp('Lead.*' + lead));
	assert.match(await page.textContent('#runbun-run-status'), /Use this party/);

	// Staged, not committed: the logged decision is still the player's press.
	assert.deepEqual((await savedRun(page)).party, []);
	await page.click('#runbun-run-set-party');
	await page.waitForFunction(
		expected => JSON.parse(localStorage.getItem('runbun.run.v1')).party.join(',') === expected,
		six.ids, {timeout: 10000});

	await opened.context.close();
});

test('a survival check that fails says so inside its block, not by vanishing', {skip}, async () => {
	// The catch on /run/safety used to set the block hidden — and the block
	// ships hidden, so a refused check looked exactly like one never asked,
	// while the damage list beside it arrived clean. A save /run/advise takes
	// and /run/safety refuses reaches that state with no message at all.
	const opened = await open();
	const page = opened.page;
	await page.route('**/run/safety', route => route.fulfill({
		status: 400, contentType: 'application/json',
		body: JSON.stringify({error: 'unknown routeUnit "zone"'}),
	}));
	await page.click('.runbun-run-starter[data-species="Piplup"]');
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	await openAllSections(page);
	await page.click('.runbun-run-mon[data-id="mon-1"] .runbun-run-add');
	await page.click('#runbun-run-set-party');
	await page.waitForFunction(
		() => JSON.parse(localStorage.getItem('runbun.run.v1')).party[0] === 'mon-1',
		null, {timeout: 10000});

	await page.click('#runbun-run-advise');
	await page.waitForFunction(
		() => document.querySelector('#runbun-run-advice').children.length > 0,
		null, {timeout: 30000});
	await page.waitForFunction(
		() => !document.querySelector('#runbun-run-survival').hidden,
		null, {timeout: 10000}).catch(() => {});
	const block = await page.$eval('#runbun-run-survival', el => ({
		hidden: el.hidden, text: el.textContent,
		risk: (el.querySelector('[data-risk]') || {getAttribute: () => null}).getAttribute('data-risk'),
	}));
	assert.equal(block.hidden, false, 'a refused survival check must stay on screen');
	assert.match(block.text, /survival check could not run/);
	assert.match(block.text, /unknown routeUnit "zone"/, 'the refusal carries its reason');
	assert.equal(block.risk, 'unknown', 'no answer is not a safe answer');

	await opened.context.close();
});

test('the plan verdict gives its margin a unit and a scale', {skip}, async () => {
	// Raised by Philip reading the panel: "what is contested by 0.1 or 4.12?
	// The unit is not clear." The margin is the gap between the enemy AI's
	// best and second-best action on the game's own scoring scale, where a
	// setup move starts at 6 — and nothing on screen said so.
	const opened = await open();
	const page = opened.page;
	// One fight reads one way. Both stances are rendered by their own branch,
	// so the real plan answer is relabelled each way in turn, margin intact.
	let stance = null;
	await page.route('**/run/plan', async route => {
		const response = await route.fetch();
		const plan = await response.json();
		if (stance) plan.confidence = stance;
		await route.fulfill({response, json: plan});
	});
	await page.click('.runbun-run-starter[data-species="Turtwig"]');
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])');
	await page.click('.runbun-run-mon[data-id="mon-1"] .runbun-run-add');
	await page.click('#runbun-run-set-party');
	await page.waitForFunction(
		() => JSON.parse(localStorage.getItem('runbun.run.v1')).party[0] === 'mon-1',
		null, {timeout: 10000});
	const setup = require('../ai/dist/scoring.js').SETUP_BASE_SCORE;
	for (stance of ['decided', 'contested']) {
		await page.evaluate(() => { document.querySelector('#runbun-run-plan-verdict').textContent = ''; });
		await page.click('#runbun-run-plan');
		await page.waitForFunction(
			() => document.querySelector('#runbun-run-plan-verdict').textContent.length > 0,
			null, {timeout: 30000});
		const verdict = await page.textContent('#runbun-run-plan-verdict');
		assert.match(verdict,
			new RegExp('AI move choice ' + stance + ' by [\\d.]+ score points over its next-best ' +
				'\\(a setup move scores ' + setup + '\\)'),
			`a ${stance} margin must carry its unit and the engine's own setup-move anchor: ${verdict}`);
		// The drivers read the number back out; it must still parse as one.
		const margin = new RegExp(stance + ' by ([\\d.]+)').exec(verdict)[1];
		assert.ok(Number.isFinite(Number(margin)), `the margin ${JSON.stringify(margin)} must parse`);
	}

	await opened.context.close();
});
