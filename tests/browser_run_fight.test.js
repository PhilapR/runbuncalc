/* eslint-env node, es6 */
'use strict';

/**
 * Browser gate for the My Run panel: fights.
 *
 * Lead order, playing a fight to a recorded ending, rolled encounters, reload
 * during a fight, and the faint takeback. One of four shards of what was one
 * file; the save-integrity properties that motivate the whole gate are in
 * browser_run.test.js, and the shared harness is tests/helpers/browser-run.js.
 *
 * Skips rather than fails without Chromium, so the suite still runs headless.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const browserRun = require('./helpers/browser-run.js');

const skip = browserRun.skip;
const open = browserRun.open;
const openAllSections = browserRun.openAllSections;
const savedRun = browserRun.savedRun;
const battleReady = browserRun.battleReady;
const driveVisibleBattleToReceipt = browserRun.driveVisibleBattleToReceipt;
const selectManualMap = browserRun.selectManualMap;

browserRun.useBrowser();

test('a fight survives a reload, and a fight from a moved run does not', {skip}, async () => {
	const session = await open();
	const page = session.page;

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
	// Calvin sits at run-map order 3 now that the Route 103 rival trio
	// stands ahead of him.
	assert.equal((await savedRun(page)).position, 3);

	// The box filter narrows without touching the document.
	await page.fill('#runbun-run-box-filter', 'turt');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-box .runbun-run-mon').length === 1,
		null, {timeout: 5000});
	assert.match(await page.textContent('#runbun-run-box .runbun-run-mon-name'), /Turtwig/);
	assert.equal((await savedRun(page)).box.length, 3, 'filtering is a view, not a command');

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
		assert.ok(saved.position >= 3, 'a won fight must be marked beaten');
	} else {
		assert.match(status, /Wiped against/);
		// The cleared Route 103 rival stands at order 1; a wipe against
		// Calvin must leave the run there, not move it past him.
		assert.equal(saved.position, 1, 'a wipe must not advance the run');
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
	assert.equal(completed.payload.progressionOrder, 3);
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
	await page.click('.runbun-run-starter[data-species="Turtwig"]');
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
		const ball = '.runbun-run-battle-ball:not([disabled])';
		if (await battleReady(page, /Gotcha|spent, nothing kept/, ball) === 'done') break;
		await page.click(ball);
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
	// The receipt speaks the wild vocabulary: the box said Gotcha, so the
	// event must say caught — a catch recorded as 'lost' poisons every
	// downstream reader of wild battle.ended events.
	const completed = await page.evaluate(async () => {
		const store = window.RunBunAttemptStore.getDefault();
		const head = await store.loadActive();
		const inspected = await store.inspectAttempt(head.attemptId);
		return inspected.events.filter(event => event.kind === 'battle.ended').at(-1);
	});
	assert.equal(completed.payload.kind, 'wild');
	assert.equal(completed.payload.outcome, /Gotcha/.test(status) ? 'caught' : 'won',
		'a caught wild is caught, not lost; a killed one is won');
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
	await page.click('.runbun-run-starter[data-species="Turtwig"]');
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
