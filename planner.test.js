/* eslint-env node, es6 */
'use strict';

/**
 * Gate for the fight planner (L5).
 *
 * The planner composes every layer beneath it, so these tests are deliberately
 * about composition rather than about rules. Damage correctness belongs to the
 * calculator's tests, scoring to the AI fixtures, content to the profile
 * conformance gate. What is only checkable here is that the layers still meet:
 * the run map still orders, sets still become a valid BattleState, and the
 * policy still returns something a player could act on.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const planner = require('./planner');

test('the run map loads in authored playthrough order', () => {
	const fights = planner.loadRunMap();
	assert.equal(fights.length, 362, 'expected every battle in the run map');

	for (let i = 1; i < fights.length; i++) {
		assert.ok(
			fights[i].order > fights[i - 1].order,
			`run map is out of order at ${fights[i].trainer} (${fights[i].order} after ${fights[i - 1].order})`
		);
	}

	// The first fight is the run's opening battle. If this moves, either the
	// progression index changed or the opening trainer did.
	assert.equal(fights[0].trainer, 'Youngster Calvin');
	assert.equal(fights[0].order, 0);
});

test('a party is grouped whole, including duplicate species', () => {
	// Fisherman Phil fields three Luvdisc. Grouping on the raw entry key instead
	// of the explicit `trainer` field would split him into three one-Pokemon
	// fights, which is exactly the bug the data shape change fixed.
	const phil = planner.getFight('Fisherman Phil');
	assert.equal(phil.party.length, 3);
	assert.deepEqual(phil.party.map(m => m.species), ['Luvdisc', 'Luvdisc', 'Luvdisc']);
	// Party order follows the progression index, not object key order.
	assert.deepEqual(phil.party.map(m => m.index), [638, 639, 640]);
});

test('listFights carries the coverage caveat', () => {
	// A planner that reports fights without reporting what it is missing invites
	// a caller to treat the run map as a complete trainer census. It is not.
	const listed = planner.listFights();
	assert.equal(listed.fights.length, 362);
	assert.equal(listed.coverage.completeTrainerCensus, false);
	assert.ok(listed.coverage.coversMandatoryProgression);
});

test('upcoming answers "what is next" from a point in the run', () => {
	const calvin = planner.getFight('Youngster Calvin');
	const next = planner.upcoming(calvin.order, 3);
	assert.equal(next.length, 3);
	for (const fight of next) {
		assert.ok(fight.order > calvin.order, 'upcoming must be strictly ahead');
	}
	assert.equal(next[0].trainer, 'Bug Catcher Rick');
});

test('an unknown trainer fails with near-misses rather than a bare miss', () => {
	assert.throws(
		() => planner.getFight('Calvin'),
		/did you mean.*Youngster Calvin/s,
		'a partial name should suggest the real one'
	);
});

test('a fight builds a BattleState the AI package accepts', () => {
	const built = planner.buildFightState({
		trainer: 'Youngster Calvin',
		playerParty: [
			{species: 'Azumarill', setLabel: 'Leader Norman'},
			{species: 'Gyarados', setLabel: 'Rich Boy Dawson'},
		],
	});
	// buildFightState validates internally; assert the shape a caller relies on.
	assert.equal(built.state.generation, 8);
	assert.equal(built.state.sides.ai.party.length, 3);
	assert.equal(built.state.sides.player.party.length, 2);
	assert.equal(built.state.sides.ai.activeIds.length, 1);
	assert.deepEqual(built.state.sides.ai.party.map(p => p.species), ['Poochyena', 'Lillipup', 'Rookidee']);
});

test('planning without a team is refused rather than guessed at', () => {
	assert.throws(
		() => planner.buildFightState({trainer: 'Youngster Calvin', playerParty: []}),
		/playerParty is required/
	);
});

test('predict returns ranked opponent actions with a decision margin', () => {
	const result = planner.predict({
		trainer: 'Youngster Calvin',
		playerParty: [{species: 'Azumarill', setLabel: 'Leader Norman'}],
	});

	assert.equal(result.trainer, 'Youngster Calvin');
	assert.ok(result.actions.length > 1, 'expected several candidate actions');

	// Ranked best-first, so a caller can read the top line and stop.
	for (let i = 1; i < result.actions.length; i++) {
		assert.ok(result.actions[i - 1].score >= result.actions[i].score, 'actions must be ranked');
	}

	// Every action must be readable without knowing the action shape: a move
	// names `moveName`, a switch names `replacementId`, and a caller should not
	// have to care which.
	for (const action of result.actions) {
		assert.ok(action.label && typeof action.label === 'string', 'every action needs a label');
		assert.ok(!/undefined/.test(action.label), `unresolved label: ${action.label}`);
	}

	// The margin is the planning signal, not decoration: it says whether the plan
	// has to survive one opponent action or two.
	assert.equal(typeof result.margin, 'number');
	assert.ok(['decided', 'contested', 'only-option'].includes(result.confidence));
});
