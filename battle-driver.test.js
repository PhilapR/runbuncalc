/* eslint-env node, es6 */
'use strict';

/**
 * The battle driver's gate: the run played turn by turn, without the game.
 *
 * `run.test.js` covers the document and `planner.test.js` the predictions;
 * what only this layer can promise is the LOOP — a player decision in, a
 * resolved turn out, the same fight every time under the same seed, the
 * replacement pause where the game pauses, and epitaphs that survive the
 * stateless round-trips so a loss can be written into the run truthfully.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const run = require('./run');
const driver = require('./battle-driver');

function docWith(party) {
	let doc = run.createRun({name: 'Recreation', now: 't0', permadeath: true});
	doc = run.applyAll(doc, party.map(entry => ({
		kind: 'catch',
		species: entry.species,
		map: entry.map,
		level: entry.level,
	})));
	return run.apply(doc, {kind: 'party',
		ids: party.map((entry, index) => `mon-${index + 1}`)});
}

/** Play a whole fight on one policy: always the first offered action. */
function playOut(doc, seed, trainer) {
	let opened = driver.start(doc, trainer, seed);
	let battle = opened.battle;
	let actions = opened.actions;
	const phases = [];
	let guard = 0;
	while (guard++ < 80) {
		const pick = actions[0];
		assert.ok(pick, 'the driver must always offer a legal action while the fight runs');
		const reply = driver.act(battle, pick.kind === 'move' ?
			{kind: 'move', move: pick.move} :
			{kind: 'switch', replacementId: pick.action.replacementId});
		phases.push(reply.phase);
		battle = reply.battle;
		actions = reply.actions;
		if (reply.result) return {reply, phases, battle};
	}
	assert.fail('the fight must end inside the guard');
	return null;
}

test('a fight opens at the cap, offers priced moves, and the same seed replays the same fight', () => {
	const doc = docWith([
		{species: 'Poochyena', map: 'Route101', level: 3},
		{species: 'Pidgey', map: 'Route102', level: 5},
	]);
	const opened = driver.start(doc, undefined, 42);
	// The next unbeaten fight, unasked: the recreation's "next" is the run's.
	assert.equal(opened.battle.trainer, 'Youngster Calvin');
	// The party enters at the projected cap — the infinite candy IS the XP
	// system, so a level 3 catch fights at what it will be leveled to.
	assert.equal(opened.viewState.player.active.level, 12);
	assert.ok(opened.viewState.player.active.types.length > 0,
		'the battle surface needs the active Pokemon typing');
	assert.equal(typeof opened.viewState.player.active.ability, 'string');
	// Moves come priced: the button can say what the calculator knows.
	const move = opened.actions.find(action => action.kind === 'move');
	assert.ok(move && move.damage && move.damage.max > 0,
		'a damaging move must carry its forecast');
	// The battle id ↔ box id map is what lets a faint in here be written out
	// there. Slot order is party order.
	assert.deepEqual(opened.battle.party.map(row => row.monId), ['mon-1', 'mon-2']);

	const first = playOut(doc, 42);
	const second = playOut(doc, 42);
	assert.equal(first.reply.result, second.reply.result);
	assert.equal(first.battle.step, second.battle.step,
		'the same seed must replay the same fight to the turn');
	// And this seed is a recorded win: a capped Poochyena runs over the
	// route-one birds. If the fixture drifts, the assertion below names it.
	assert.equal(first.reply.result, 'win');
	assert.deepEqual(first.reply.deaths, []);
});

test('move forecasts stay on max HP and a miss says that it missed', () => {
	const doc = docWith([{species: 'Mudkip', map: undefined, level: 5}]);
	const opened = driver.start(doc, 'Youngster Calvin', 0);
	const firstWaterGun = opened.actions.find(action => action.move === 'Water Gun');
	assert.ok(firstWaterGun && firstWaterGun.damage,
		'Water Gun should carry a damage forecast');

	const first = driver.act(opened.battle, {kind: 'move', move: 'Water Gun'});
	const secondWaterGun = first.actions.find(action => action.move === 'Water Gun');
	assert.deepEqual(
		{min: secondWaterGun.damage.min, max: secondWaterGun.damage.max},
		{min: firstWaterGun.damage.min, max: firstWaterGun.damage.max},
		'the forecast is a share of max HP, not a growing share of what remains');
	assert.equal(secondWaterGun.damage.guaranteedKO, true,
		'the separate KO reading should still reflect the HP remaining');

	const second = driver.act(first.battle, {kind: 'move', move: 'Water Gun'});
	assert.ok(second.events.some(event => /Mudkip's Water Gun missed!/.test(event.text)),
		'a failed accuracy roll must not be narrated as an unexplained move use');
});

test('a mid-turn faint pauses for the replacement, and the epitaph survives to the end', () => {
	// One hopeless lead, one bystander: the lead falls, the driver must pause
	// on phase "replace" (never auto-picking the player's next), and when the
	// fight is lost both deaths carry who did it and with what.
	const doc = docWith([
		{species: 'Skitty', map: 'Route101', level: 2},
		{species: 'Starly', map: 'Route102', level: 5},
	]);
	// Two frail mons into Leader Brawly: at cap 21 this is a certain wipe,
	// which is exactly what the test needs — a mid-fight faint and a loss.
	const played = playOut(doc, 7, 'Leader Brawly');
	assert.ok(played.phases.includes('replace'),
		'losing a mon mid-fight must pause for the player to choose the next');
	assert.equal(played.reply.result, 'loss');
	assert.equal(played.reply.deaths.length, 2, 'a wipe reports every death');
	for (const death of played.reply.deaths) {
		assert.ok(death.monId, 'every death maps back to a box id');
		assert.ok(death.by, `${death.species} died to a named move, got ${death.by}`);
		assert.ok(death.of, `${death.species} died to a named killer, got ${death.of}`);
	}
});

test('the driver refuses what the fight cannot do, by name', () => {
	const doc = docWith([{species: 'Poochyena', map: 'Route101', level: 3}]);
	const opened = driver.start(doc, undefined, 1);
	// A move it does not know right now.
	assert.throws(() => driver.act(opened.battle, {kind: 'move', move: 'Earthquake'}),
		/battle: "Earthquake" is not usable right now/);
	// A switch to nobody.
	assert.throws(() => driver.act(opened.battle, {kind: 'switch', replacementId: 'player-9'}),
		/battle: "player-9" is not a legal switch/);
	// No action at all.
	assert.throws(() => driver.act(opened.battle, null), /battle: an action is required/);
	// And an empty party cannot open a fight.
	assert.throws(() => driver.start(run.createRun({name: 'x', now: 't0'})),
		/battle: the party is empty/);
});

test('a finished fight is over: acting on it is refused, not resolved', () => {
	const doc = docWith([
		{species: 'Poochyena', map: 'Route101', level: 3},
		{species: 'Pidgey', map: 'Route102', level: 5},
	]);
	const played = playOut(doc, 42);
	assert.throws(() => driver.act(played.battle, {kind: 'move', move: 'Tackle'}),
		/battle: this fight is over/);
});

test('a wild fight: the ball is priced, the throw is seeded, the ending settles the roll', () => {
	const doc = docWith([{species: 'Starly', map: 'Route102', level: 5}]);
	const rolled = run.rollEncounter(doc, {map: 'Route101', random: () => 0.01});

	const opened = driver.startWild(doc, rolled, 7);
	assert.equal(opened.battle.trainer, `Wild ${rolled.species}`);
	assert.equal(opened.viewState.foe.active.level, rolled.level,
		'the wild mon fights at its rolled level, uncapped');
	const ball = opened.actions.find(action => action.kind === 'ball');
	assert.ok(ball, 'a wild fight offers the ball');
	assert.ok(ball.chance > 0 && ball.chance <= 100, 'the throw wears its odds');

	// Throw until it ends: same seed, same fight, to the shake.
	const playBalls = () => {
		let battle = opened.battle;
		let reply = null;
		for (let guard = 0; guard < 30; guard++) {
			reply = driver.act(battle, {kind: 'ball'});
			battle = reply.battle;
			if (reply.result) return reply;
		}
		return reply;
	};
	const first = playBalls();
	const second = playBalls();
	assert.equal(first.result, second.result);
	assert.equal(first.battle.step, second.battle.step,
		'the same seed shakes the same shakes');
	assert.ok(['catch', 'win', 'loss'].includes(first.result));
	if (first.result === 'catch') {
		assert.match(first.events.map(event => event.text).join(' '), /Gotcha/);
	}
	// A finished wild fight is over even though nobody fainted.
	assert.throws(() => driver.act(first.battle, {kind: 'ball'}),
		/battle: this fight is over/);

	// The ball is the wild fight's action alone, and the roll must be real.
	const trainerFight = driver.start(doc, undefined, 1);
	assert.throws(() => driver.act(trainerFight.battle, {kind: 'ball'}),
		/battle: only a wild encounter takes a ball/);
	assert.throws(() => driver.startWild(doc, {map: 'Route101', species: 'Rayquaza', level: 5}, 1),
		/is not on Route101's table/);

	// The math itself, at the two ends the formula promises: a full-HP catch
	// rate 255 species is a fair throw, and status closes the gap.
	const full = driver.catchMath({hp: {current: 30, max: 30}, status: ''}, 255);
	assert.ok(Math.abs(full.chance - Math.pow(49931 / 65536, 4)) < 1e-9,
		'full HP at rate 255 rolls the book number');
	const asleep = driver.catchMath({hp: {current: 1, max: 30}, status: 'slp'}, 255);
	assert.equal(asleep.chance, 1, 'a sleeping mon at 1 HP is a guaranteed catch');
});

test('ball tiers are bag-backed: better odds, counted throws, refusals when out', () => {
	// Two Great Balls in the bag; the Ultra Ball shelf is empty.
	let doc = docWith([{species: 'Starly', map: 'Route102', level: 5}]);
	doc = run.apply(doc, {kind: 'acquire', item: 'Great Ball', count: 2});
	const rolled = run.rollEncounter(doc, {map: 'Route101', random: () => 0.01});
	const opened = driver.startWild(doc, rolled, 7);

	// Offered: the free Poke Ball plus the two Great Balls, nothing more —
	// and the tier really pays (Emerald's 1.5x on the a-value).
	const balls = opened.actions.filter(action => action.kind === 'ball');
	assert.deepEqual(balls.map(action => action.ball), ['Poke Ball', 'Great Ball']);
	assert.equal(balls[1].left, 2);
	assert.equal(balls[0].left, undefined, 'the free baseline is not counted');
	assert.ok(balls[1].chance > balls[0].chance, 'a Great Ball beats a plain one');

	// Throw both Great Balls (on this seed neither connects); the third is
	// refused with the count, and the button is off the list.
	let battle = opened.battle;
	let reply = null;
	for (let thrown = 0; thrown < 2; thrown++) {
		reply = driver.act(battle, {kind: 'ball', ball: 'Great Ball'});
		battle = reply.battle;
		assert.ok(!reply.result, 'this seed does not connect in two Great throws');
	}
	assert.equal(battle.wild.thrown['Great Ball'], 2, 'the bundle counts the throws');
	assert.ok(!reply.actions.some(action => action.ball === 'Great Ball'),
		'an empty shelf offers no button');
	assert.throws(() => driver.act(battle, {kind: 'ball', ball: 'Great Ball'}),
		/no Great Ball left — this fight has thrown 2 and the bag held 2/);
	assert.throws(() => driver.act(battle, {kind: 'ball', ball: 'Master Ball'}),
		/not a ball this recreation throws/);
	// The free baseline still throws.
	const plain = driver.act(battle, {kind: 'ball'});
	assert.match(plain.events[0].text, /You threw a Poke Ball!/);

	// And the document's half: `use` spends what the fight threw, refusing
	// honestly when the bag cannot cover the claim.
	let settled = run.apply(doc, {kind: 'use', item: 'Great Ball', count: 2});
	assert.equal(settled.bag['Great Ball'], undefined, 'an emptied slot leaves the bag');
	assert.throws(() => run.apply(settled, {kind: 'use', item: 'Great Ball'}),
		/use: need 1 Great Ball, the bag has 0/);
});

test('adjudication reports what happened, deterministically, and calibrates the ranker', () => {
	const doc = docWith([
		{species: 'Poochyena', map: 'Route101', level: 3},
		{species: 'Pidgey', map: 'Route102', level: 5},
	]);
	// Same seeds, same answer: an adjudication is a measurement, not a mood.
	const first = driver.adjudicate(doc, 'Youngster Calvin', {rollouts: 6});
	const second = driver.adjudicate(doc, 'Youngster Calvin', {rollouts: 6});
	assert.deepEqual(first, second);
	assert.equal(first.rollouts, 6);
	assert.ok(first.pWin > 0.5, 'capped mons run over the first Youngster');

	// Two frail mons into Brawly: the floor policy reports the wipe honestly.
	const doomed = docWith([
		{species: 'Skitty', map: 'Route101', level: 2},
		{species: 'Starly', map: 'Route102', level: 5},
	]);
	const wiped = driver.adjudicate(doomed, 'Leader Brawly', {rollouts: 4});
	assert.equal(wiped.pWin, 0);
	assert.equal(wiped.eDeaths, 2);

	// And the ranker carries the measurement: adjudicated parties come back
	// with the played numbers attached and sorted ahead by them.
	const ranked = run.rankParties(doc, 'Youngster Calvin', {rollouts: 4, adjudicate: 2});
	assert.ok(ranked.parties[0].adjudication, 'the top candidates are played');
	assert.equal(ranked.parties[0].adjudication.rollouts, 4);
	assert.match(ranked.adjudication.policy, /lower bound/);
	const played = ranked.parties.filter(party => party.adjudication);
	for (let i = 1; i < played.length; i++) {
		const above = played[i - 1].adjudication;
		const below = played[i].adjudication;
		assert.ok(above.pWin > below.pWin ||
			(above.pWin === below.pWin && above.eDeaths <= below.eDeaths),
		'played results outrank the grid, wins first, then deaths');
	}
	// rollouts: 0 is the off switch — the old grid-only answer, unchanged.
	const gridOnly = run.rankParties(doc, 'Youngster Calvin', {rollouts: 0});
	assert.equal(gridOnly.adjudication, null);
	assert.ok(gridOnly.parties.every(party => !party.adjudication));
});

test('the playbook: same seeds same tape, honest spread, a line that replays the majority', () => {
	const doc = docWith([
		{species: 'Poochyena', map: 'Route101', level: 3},
		{species: 'Pidgey', map: 'Route102', level: 5},
	]);
	const first = driver.playbook(doc, 'Youngster Calvin', {rollouts: 6});
	const second = driver.playbook(doc, 'Youngster Calvin', {rollouts: 6});
	assert.deepEqual(first, second, 'a playbook is a measurement, not a mood');
	assert.equal(first.odds.rollouts, 6);
	assert.equal(first.outcomes.reduce((sum, outcome) => sum + outcome.count, 0), 6,
		'every rollout lands in exactly one outcome bucket');
	assert.ok(first.line, 'the expected line exists');
	assert.ok(first.line.events.length > 2, 'the line narrates the fight');
	assert.match(first.line.events[0], /wants to battle!/);
	// The line replays the MAJORITY result at its most common death count.
	const majority = first.odds.pWin >= 0.5 ? 'win' : 'loss';
	assert.equal(first.line.result, majority);
	// Odds must agree with adjudicate — one tape deck, two readouts.
	const adjudicated = driver.adjudicate(doc, 'Youngster Calvin', {rollouts: 6});
	assert.deepEqual(first.odds, adjudicated);
});
