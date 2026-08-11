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

test('the caches are keyed by profile: a warm cache never answers for a stranger', () => {
	// The failure this pins was silent: an unkeyed module-level cache, once
	// warmed by run-and-bun, served its 362 fights to ANY profile id — so an
	// unknown game got a confident wrong answer instead of a refusal.
	planner.loadRunMap('run-and-bun');
	assert.throws(() => planner.loadRunMap('bogus-game'), /unknown profile/i);
});

test('a double battle is planned as Singles, and says so instead of hiding it', () => {
	// 46 fights in the map are doubles. Until Doubles planning lands measured,
	// the simplification travels WITH the prediction rather than inside it.
	const double = planner.listFights('run-and-bun').fights.find(f => f.isDouble);
	assert.ok(double, 'the run map has double battles');
	const prediction = planner.predict({
		trainer: double.trainer,
		playerParty: [{species: 'Marill', level: 40, moves: ['Aqua Tail']}],
	});
	assert.equal(prediction.plannedAsSingles, true);
	const single = planner.predict({
		trainer: 'Youngster Calvin',
		playerParty: [{species: 'Marill', level: 40, moves: ['Aqua Tail']}],
	});
	assert.equal(single.plannedAsSingles, false);
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

/** A team with a spread of levels, so the grid has something to distinguish. */
const MATRIX_PARTY = [
	{species: 'Mudkip', level: 12, moves: ['Water Gun', 'Tackle', 'Growl']},
	{species: 'Mudkip', level: 5, moves: ['Water Gun', 'Tackle', 'Growl']},
];

test('the matchup matrix covers every pair in both directions', () => {
	const matrix = planner.matchup({trainer: 'Youngster Calvin', playerParty: MATRIX_PARTY});
	assert.equal(matrix.trainer, 'Youngster Calvin');
	assert.equal(matrix.order, 0);
	assert.equal(matrix.borrowedPlayerBuild, false);

	// A grid is only a grid if it is complete: one block per opposing Pokemon,
	// one row per Pokemon offered, and no cell missing a direction. A partial
	// grid would be read as "these matchups do not exist" rather than "these
	// were not computed".
	assert.equal(matrix.grid.length, 3);
	assert.deepEqual(matrix.grid.map(cell => cell.enemy.species),
		['Poochyena', 'Lillipup', 'Rookidee']);
	for (const cell of matrix.grid) {
		assert.equal(cell.versus.length, MATRIX_PARTY.length);
		assert.deepEqual(cell.versus.map(row => row.level), [12, 5],
			'a row must report the level it was actually built at');
		for (const row of cell.versus) {
			for (const direction of [row.us, row.them]) {
				// Both directions or neither: "we OHKO it" and "it OHKOs us first"
				// are the same cell, and half a matchup is not one.
				assert.ok(direction.move, 'every direction needs a move it leads with');
				assert.equal(typeof direction.guaranteedKO, 'boolean');
				assert.equal(typeof direction.possibleKO, 'boolean');
				// A guaranteed KO is also a possible one; the reverse is the
				// difference between a plan and a gamble.
				if (direction.guaranteedKO) assert.ok(direction.possibleKO);
			}
		}
	}
});

test('matrix damage is a fraction of the defender, not raw HP', () => {
	// Raw damage compares nothing across a grid — 20 off a Poochyena and 20 off a
	// Metagross are not the same cell. Fractions are the only number that means
	// the same thing in every row, and they are unbounded above: a move can hit
	// for three times a bar.
	const matrix = planner.matchup({trainer: 'Youngster Calvin', playerParty: MATRIX_PARTY});
	for (const cell of matrix.grid) {
		for (const row of cell.versus) {
			for (const direction of [row.us, row.them]) {
				assert.equal(typeof direction.max, 'number');
				assert.equal(typeof direction.min, 'number');
				assert.ok(direction.min >= 0, `negative floor: ${direction.min}`);
				assert.ok(direction.max >= direction.min, 'the top roll cannot be below the floor');
				// The KO booleans come from the policy's own facts, so they must
				// agree with the fractions those same facts produced.
				assert.equal(direction.possibleKO, direction.max >= 1);
				assert.equal(direction.guaranteedKO, direction.min >= 1);
			}
		}
	}

	// Something in this fight must actually threaten, or the assertions above
	// are passing on a grid of zeroes.
	const hits = matrix.grid.some(cell => cell.versus.some(row => row.us.max > 0.5));
	assert.ok(hits, 'a level 12 Mudkip should be taking half a bar off something');
});

test('the speed relation follows the levels the rows were built at', () => {
	const matrix = planner.matchup({trainer: 'Youngster Calvin', playerParty: MATRIX_PARTY});
	const ORDER = {slower: 0, tie: 1, faster: 2};
	for (const cell of matrix.grid) {
		const high = cell.versus[0];
		const low = cell.versus[1];
		// Both rows are the same Pokemon, so nothing but the level separates
		// them: the level 12 one can never be the slower of the two. This is what
		// catches a relation read off the wrong side's facts, which a single-row
		// grid would show as a plausible arrow pointing the wrong way.
		assert.ok(ORDER[high.speed] >= ORDER[low.speed],
			`L12 Mudkip reads ${high.speed} where L5 reads ${low.speed} vs ${cell.enemy.species}`);
		// And the relation is the speeds each side's own facts reported, not a
		// second opinion about them.
		for (const row of cell.versus) {
			assert.equal(row.speed,
				row.us.speed > row.them.speed ? 'faster' :
					row.us.speed < row.them.speed ? 'slower' : 'tie');
		}
	}
});

test('a matrix without a team is refused rather than guessed at', () => {
	assert.throws(
		() => planner.matchup({trainer: 'Youngster Calvin', playerParty: []}),
		/playerParty is required/
	);
});
