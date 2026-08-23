/* eslint-env node, es6 */
'use strict';

/**
 * Gate for what an adjudication COSTS, counted in work rather than in seconds.
 *
 * Ranking a party plays the fight: four candidate sixes, twelve seeded
 * rollouts each, and that is the flat multi-second cost a player pays every
 * time they press Rank — `tests/run.test.js` pins that it does not scale with
 * the box, but nothing pinned how much work one rollout does.
 *
 * Wall clock is the wrong instrument for that. This repository shares a runner
 * with whatever else is building, and a timing assertion measured machine load
 * at least as often as it measured the product — three separate gates flaked
 * that way in one session. Counting constructed calculator objects is exact,
 * reproducible to the object, and moves only when the engine's behaviour
 * moves.
 *
 * The number is real work: every `Calc.Move` and `Calc.Pokemon` is an object
 * built, deep-copied by the calculator's own `extend`, and thrown away. A
 * profile put ~18% of an adjudication in construction and cloning, and half of
 * every Move built existed to read one immutable field of a dex entry.
 *
 * The budget is a ceiling with headroom, not a target. It should fall when
 * someone removes work; it must not be raised to make a regression pass.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

// Patch BEFORE the engine is loaded, so the counted classes are the ones it
// closes over. node:test gives each file its own process, so this cannot leak
// into another gate.
const calcPath = require.resolve('@smogon/calc',
	{paths: [require('node:path').join(__dirname, '..', 'ai')]});
const Calc = require(calcPath);

let moves = 0;
let pokemon = 0;
class CountedMove extends Calc.Move {
	constructor(...args) {
		super(...args);
		moves += 1;
	}
}
class CountedPokemon extends Calc.Pokemon {
	constructor(...args) {
		super(...args);
		pokemon += 1;
	}
}
Object.defineProperty(Calc, 'Move', {value: CountedMove, writable: true});
Object.defineProperty(Calc, 'Pokemon', {value: CountedPokemon, writable: true});

const run = require('../lib/run');
const driver = require('../lib/battle-driver');

const IVS = {hp: 17, atk: 18, def: 19, spa: 20, spd: 21, spe: 22};

/** A six-strong party at a fixed level, so the count is a property of the
 * engine and not of a roll. */
function party() {
	const catches = [];
	for (let i = 0; i < 6; i++) {
		catches.push({kind: 'catch', species: 'Poochyena', level: 20, ivs: Object.assign({}, IVS)});
	}
	const doc = run.applyAll(run.createRun({
		name: 'cost', now: 't0', levelCap: 'none', permadeath: false, onePerRoute: false,
	}), catches);
	return run.apply(doc, {kind: 'party', ids: doc.box.map(mon => mon.id)});
}

test('a twelve-rollout adjudication stays inside its object budget', () => {
	const doc = party();
	moves = 0;
	pokemon = 0;
	const played = driver.adjudicate(doc, 'Leader Brawly', {rollouts: 12});
	assert.equal(played.rollouts, 12, 'the fixture must actually play twelve');

	// Measured 24,128 Move and 9,168 Pokemon — 33,296 together. It was 66,768
	// before the immutable dex facts behind `Calc.Move(gen, name).flags?.sound`
	// and its two neighbours were cached: 24,480 of those existed to read one
	// boolean, on every damage calculation, for every move the defender owns.
	const total = moves + pokemon;
	assert.ok(total < 40000,
		`an adjudication built ${total.toLocaleString()} calculator objects; ` +
		'the budget is 40,000 and the measured cost is 33,296');

	// And the halving specifically: a regression that reintroduced per-call
	// construction would show up here first, because Moves are what moved.
	assert.ok(moves < 30000,
		`${moves.toLocaleString()} Move objects, against a measured 24,128`);
});

test('the cached dex facts differ by generation, so the key must carry one', () => {
	// A cache keyed on the move name alone would answer with whichever
	// generation ran first — the classic bug a cache introduces, and one a
	// suite of single-generation fixtures never sees. These are the facts
	// being cached, and they genuinely disagree across generations, which is
	// what makes the key load-bearing rather than decorative.
	const gen3 = Calc.Generations.get(3);
	const gen8 = Calc.Generations.get(8);
	assert.equal(new Calc.Move(gen3, 'Bite').category, 'Special',
		'pre-split, Bite is Special because Dark is a special type');
	assert.equal(new Calc.Move(gen8, 'Bite').category, 'Physical',
		'post-split it is Physical — the same move, a different answer');

	// A leak would surface in the engine's own fixtures, which run
	// generations 3, 7, 8 and 9 against each other inside one process.
	const ai = require('../ai');
	assert.equal(ai.getMoveMetadata('Bite', 3).category, 'Special');
	assert.equal(ai.getMoveMetadata('Bite', 8).category, 'Physical');
	assert.equal(ai.getMoveMetadata('Bite', 3).category, 'Special',
		'asking again the other way round must not have been poisoned');
});
