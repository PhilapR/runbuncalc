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
