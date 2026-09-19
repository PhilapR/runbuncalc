/* eslint-env node, es6 */
'use strict';

/**
 * Gate for headless doubles (driver.playDoubles): 62 fights on the road are
 * double battles, Juan and three of the Elite Four among them, and a run
 * that skips them has not beaten the game.
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const driver = require('../lib/battle-driver.js');
const planner = require('../lib/planner');
const run = require('../lib/run');
const battery = require('../scripts/scenario-battery.js');

const doc = () => battery.loadDocument(path.join(__dirname, '..', 'fixtures', 'banked-runs', 'sv-14.run.json'));
const DOUBLES = ['Pokéfan Isabel & Kaleb', 'Black Belt Rhett & Marcos', 'Twins Amy And Liv'];

test('a double battle is fought two against two, every active acting', () => {
	const box = doc();
	const fight = planner.getFight(DOUBLES[0], box.profileId);
	const state = planner.buildFightState({trainer: fight.trainer, profileId: box.profileId,
		playerParty: run.partySpecs(box, {atOrder: fight.order}), doubles: true}).state;
	assert.equal(state.mode, 'Doubles');
	assert.equal(state.sides.player.activeIds.length, 2);
	assert.equal(state.sides.ai.activeIds.length, 2);
	let actions = 0;
	let turns = 0;
	for (const trainer of DOUBLES) {
		for (let seed = 1; seed <= 3; seed++) {
			const played = driver.playDoubles(box, trainer, seed);
			assert.ok(['win', 'loss'].includes(played.result), trainer + ' #' + seed + ' ended ' + played.result);
			assert.equal(played.engineRefusals, 0, trainer + ' #' + seed + ': ' +
				played.events.filter(event => event.engineRefusal).map(event => event.text).join(' | '));
			actions += played.actions;
			turns += played.turns;
		}
	}
	assert.ok(actions / turns > 3, 'four actives act each turn, less those that fell: ' + (actions / turns).toFixed(2));
});

test('a double is the same fight on the same seed, and a single is refused', () => {
	const box = doc();
	const a = driver.playDoubles(box, DOUBLES[2], 7);
	const b = driver.playDoubles(box, DOUBLES[2], 7);
	assert.deepEqual([a.result, a.turns, a.deaths, a.actions], [b.result, b.turns, b.deaths, b.actions]);
	assert.throws(() => driver.playDoubles(box, 'Leader Wattson', 1), /is a single battle/);
});

test('the battery plays a double through the two-slot loop and says which policy fought', () => {
	const box = doc();
	const played = battery.playScenario(require('../scripts/ui-playthrough.js'), box, DOUBLES[0], 3);
	assert.equal(played.policy, 'engine-ai-doubles');
	assert.deepEqual([played.result, played.turns], (() => {
		const direct = driver.playDoubles(box, DOUBLES[0], 3);
		return [direct.result, direct.turns];
	})());
});

test('the doubles that were refused are played through', () => {
	// Each once produced a refusal: a spread move whose foe fell, a status
	// move whose targets an effect filtered out, a Dancer ally copying a
	// dance, White Herb restoring an ally, and an Encore that landed before
	// the encored Pokemon acted.
	const cases = [
		['sv-14', 'Old Couple John And Jay', 1], ['sv-14', 'Hiker Eric & Autumn', 1],
		['sv-14', 'Young Couple Dez And Luke', 2], ['sv-14', 'Camper Flint & Edwardo', 1],
		['sv-14', 'Lass Andrea & Connie', 2], ['sv-14', 'Twins Miu And Yuki', 1],
		['acc-11', 'Magma Grunt Mt Chimney #2 & Grunt One', 1],
	];
	for (const entry of cases) {
		const box = battery.loadDocument(path.join(__dirname, '..', 'fixtures', 'banked-runs', entry[0] + '.run.json'));
		const played = driver.playDoubles(box, entry[1], entry[2]);
		assert.equal(played.engineRefusals, 0, entry.join(' ') + ': ' + played.events.filter(event => event.engineRefusal)
			.map(event => event.text + ' ' + JSON.stringify(event.action)).join(' | '));
	}
});

test('a move locked out before it acts: Encore substitutes, Taunt makes a status move fail', () => {
	const box = doc();
	const fight = planner.getFight(DOUBLES[0], box.profileId);
	const state = planner.buildFightState({trainer: fight.trainer, profileId: box.profileId,
		playerParty: run.partySpecs(box, {atOrder: fight.order}), doubles: true}).state;
	const actor = state.sides.player.party[0];
	const moves = actor.moves.map(move => move.name);
	const action = {kind: 'move', actorId: actor.id, moveName: moves[0], targetIds: [state.sides.ai.activeIds[0]]};
	const events = [];
	const encored = structuredClone(state);
	encored.sides.player.party[0].volatile = {encore: {moveName: moves[1], turns: 3}};
	assert.equal(driver.lockedOut(encored, action, events).moveName, moves[1], 'the encored move is used instead');
	const disabled = structuredClone(state);
	disabled.sides.player.party[0].volatile = {disable: {moveName: moves[0], turns: 3}};
	assert.equal(driver.lockedOut(disabled, action, events), null, 'a disabled move fails');
	assert.match(events[events.length - 1].text, /can't use/);
	assert.equal(driver.lockedOut(state, action, events), action, 'nothing locked, nothing changed');
});

test('a double is taped action by action, and the optional hands play it through', () => {
	const box = doc();
	const played = driver.playDoubles(box, DOUBLES[2], 2);
	const used = played.events.filter(event => / used /.test(event.text));
	assert.ok(used.length >= played.actions, 'every applied action is on the tape');
	assert.ok(used.every(event => typeof event.turn === 'number'));
	const greedy = driver.playDoubles(box, DOUBLES[2], 2, {ourPolicy: 'greedy'});
	assert.ok(['win', 'loss'].includes(greedy.result));
	const searched = driver.playDoubles(box, DOUBLES[0], 1, {search: 1});
	assert.ok(['win', 'loss'].includes(searched.result));
	assert.equal(searched.engineRefusals, 0);
});
