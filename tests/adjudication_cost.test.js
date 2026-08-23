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

	// Measured 17,264 Move and 2,450 Pokemon — 19,714 together, from 66,768.
	// Three caches got it there: the immutable dex facts behind
	// `Calc.Move(gen, name).flags?.sound` and `.target`, which were 31,344
	// objects built to read one field each; and unboosted Speed, which was
	// 6,720 Pokemon built to read one number.
	const total = moves + pokemon;
	assert.ok(total < 24000,
		`an adjudication built ${total.toLocaleString()} calculator objects; ` +
		'the budget is 24,000 and the measured cost is 19,714');

	// Each half separately, so a regression in one cannot hide behind headroom
	// in the other.
	assert.ok(moves < 21000,
		`${moves.toLocaleString()} Move objects, against a measured 17,264`);
	assert.ok(pokemon < 4000,
		`${pokemon.toLocaleString()} Pokemon objects, against a measured 2,450`);
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

test('the speed cache rests on what actually moves stats.spe', () => {
	// order.ts caches unboosted Speed, because building a Pokemon to read one
	// number was 6,720 constructions in a twelve-rollout adjudication — a
	// quarter of every calculator object it made. The cache is only safe while
	// the two lists below hold, and they were established by probing the
	// calculator rather than by reading it. If a future calculator lets an
	// item or an ability move base stats, this fails, and the cache has to go
	// before anything else does.
	const gen = Calc.Generations.get(8);
	const EVS = {hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0};
	const base = {level: 50, nature: 'Hardy',
		ivs: {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31}, evs: EVS};
	const spe = extra => new Calc.Pokemon(gen, 'Poochyena',
		Object.assign({}, base, extra)).stats.spe;
	const reference = spe({});

	// In the key, because they move it.
	const keyed = [
		{label: 'level', extra: {level: 51}},
		{label: 'nature', extra: {nature: 'Jolly'}},
		{label: 'ivs.spe', extra: {ivs: Object.assign({}, base.ivs, {spe: 0})}},
		{label: 'evs.spe', extra: {evs: Object.assign({}, EVS, {spe: 252})}},
		{label: 'statOverrides.spe',
			extra: {statOverrides: {hp: 100, atk: 50, def: 50, spa: 50, spd: 50, spe: 999}}},
		{label: 'overrides.baseStats',
			extra: {overrides: {baseStats: {hp: 35, atk: 55, def: 35, spa: 30, spd: 30, spe: 200}}}},
	];
	for (const probe of keyed) {
		assert.notEqual(spe(probe.extra), reference,
			`${probe.label} must move stats.spe — the speed cache keys on it`);
	}

	// NOT in the key, because they do not move it. These are the ones that
	// change mid-battle, which is exactly why a cached base speed can be
	// shared across a fight: order.ts applies each of them by hand afterwards.
	const unkeyed = [
		{label: 'boosts', extra: {boosts: {atk: 0, def: 0, spa: 0, spd: 0, spe: 2}}},
		{label: 'status', extra: {status: 'par'}},
		{label: 'item', extra: {item: 'Choice Scarf'}},
		{label: 'ability', extra: {ability: 'Swift Swim'}},
		{label: 'teraType', extra: {teraType: 'Water'}},
	];
	for (const probe of unkeyed) {
		assert.equal(spe(probe.extra), reference,
			`${probe.label} must NOT move stats.spe — the speed cache omits it ` +
			'from its key, and order.ts applies it by hand to the cached base');
	}

	// The same fact read the other way: because the constructor drops the
	// boosts it is handed, applying the boost multiplier afterwards is not
	// double counting.
	assert.equal(spe({boosts: {atk: 0, def: 0, spa: 0, spd: 0, spe: 6}}), reference);
});
