/* eslint-env node, es6 */
'use strict';

/**
 * Conformance gate for the oracle layer.
 *
 * These three datasets came out of the author's ROM decomp by a script, which
 * makes them trustworthy in a way hand-transcription never is — and creates a
 * failure mode hand-transcription does not have: a regeneration against a
 * changed upstream, or a broken name mapping, can quietly halve a table and
 * still produce valid JSON.
 *
 * So the assertions here are values, not shapes. "Existence is not correctness"
 * is the rule the species gate learned the hard way; a route with an encounter
 * table is not a route with the RIGHT encounter table.
 *
 * Pinned facts are chosen to be load-bearing rather than arbitrary: the run's
 * first route, a fishing-only species, an evolution the base-stat gate already
 * cares about, and the two move-legality cases that caught real errors in this
 * project's own example team.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const oracle = require('./profiles').getProfile().oracle;

test('the oracle carries the whole decomp, not a truncated read of it', () => {
	const coverage = oracle.coverage();
	assert.equal(coverage.maps, 131, 'wild encounter maps');
	assert.equal(coverage.encounterSlots, 1462, 'distinct encounter slots');
	assert.equal(coverage.evolvingSpecies, 436);
	assert.equal(coverage.levelUpSpecies, 1115);
	assert.equal(coverage.teachableSpecies, 1115);
	assert.equal(coverage.eggSpecies, 370);
});

test('the first route of the run has the roster Run & Bun gives it', () => {
	// Vanilla Emerald's Route 101 is Poochyena, Zigzagoon and Wurmple. If this
	// ever reads like that, the import picked up a stock pokeemerald tree.
	const route = oracle.encountersOn('Route101');
	assert.ok(route, 'Route 101 should resolve by readable name');
	const species = route.mons.map(m => m.species);
	assert.deepEqual(species, [
		'Lillipup', 'Bunnelby', 'Buneary', 'Skitty', 'Zigzagoon-Galar',
		'Poochyena', 'Starly', 'Pidgey', 'Litleo', 'Deerling',
	]);
	for (const mon of route.mons) {
		assert.equal(mon.method, 'walk');
		assert.equal(mon.minLevel, 2);
		assert.equal(mon.maxLevel, 3);
	}
});

test('every encounter table is a probability distribution, straight from the fields declaration', () => {
	// Slot odds come from the decomp's own `encounter_rates`, and this hack
	// re-weights them (its land table runs 20/10/…/1, not vanilla's 20/20/…).
	// Route 101's slot 0 is Lillipup at 20% — pinned so a regeneration that
	// silently falls back to vanilla weights fails a value, not a shape.
	const route = oracle.encountersOn('Route101');
	assert.equal(route.mons.find(m => m.species === 'Lillipup').chance, 20);
	assert.equal(route.mons.find(m => m.species === 'Starly').chance, 5);

	// And every table everywhere sums to ~100 — including the padded ones
	// (Altering Cave declares real species and empty slots; the empties'
	// weight is renormalized away rather than left as missing probability).
	for (const map of oracle.maps()) {
		for (const table of map.tables) {
			const total = table.mons.reduce((sum, mon) => sum + mon.chance, 0);
			assert.ok(Math.abs(total - 100) < 0.5,
				`${map.name} ${table.method} sums to ${total}`);
		}
	}
});

test('a map resolves by constant or by name, and an unknown one is null', () => {
	assert.equal(oracle.getMap('MAP_ROUTE101').map, 'MAP_ROUTE101');
	assert.equal(oracle.getMap('route 101').map, 'MAP_ROUTE101');
	assert.equal(oracle.getMap('Nowhere At All'), null);
	assert.equal(oracle.encountersOn('Nowhere At All'), null);
});

test('encounter method is carried, because how you catch it is half the answer', () => {
	const feebas = oracle.whereToFind('Feebas');
	assert.ok(feebas.length > 0, 'Feebas must be findable');
	for (const spot of feebas) {
		// Water either way — Run & Bun also puts it in the Sootopolis surf table —
		// but never something you walk into.
		assert.ok(spot.method === 'fish' || spot.method === 'surf',
			`Feebas is water-only, got ${spot.method} at ${spot.name}`);
		if (spot.method === 'fish') {
			assert.ok(spot.rod, `a fishing slot must name the rod it needs (${spot.name})`);
		}
	}
	// Run & Bun's wild_encounters.json declares ONE fishing group, `super_rod`,
	// covering all ten slots: there is no old- or good-rod fishing in the hack.
	// Vanilla pokeemerald splits those slots 0-1/2-4/5-9 across three rods, so an
	// Old Rod appearing here means the import went back to assuming vanilla
	// instead of reading the group the hack declares.
	const rods = new Set();
	for (const map of oracle.maps()) {
		for (const table of map.tables) {
			for (const mon of table.mons) if (mon.rod) rods.add(mon.rod);
		}
	}
	assert.deepEqual([...rods], ['Super Rod']);
});

test('evolutions carry their terms, not just their target', () => {
	assert.deepEqual(oracle.evolutionsOf('Marill'),
		[{into: 'Azumarill', method: 'level', level: 18}]);
	// A branching line must keep both branches.
	const wurmple = oracle.evolutionsOf('Wurmple');
	assert.deepEqual(wurmple.map(e => e.into).sort(), ['Cascoon', 'Silcoon']);
	// An item evolution names the item rather than a bare number.
	const eevee = oracle.evolutionsOf('Eevee');
	const jolteon = eevee.find(e => e.into === 'Jolteon');
	assert.equal(jolteon.method, 'item');
	assert.equal(jolteon.item, 'Thunder Stone');
	// A fully evolved species evolves into nothing, and says so as an empty list.
	assert.deepEqual(oracle.evolutionsOf('Azumarill'), []);
});

test('an entry wrapped in #if blocks does not swallow the entry after it', () => {
	// Eevee's decomp entry puts its Gen 4 and Gen 6 branches behind #if guards and
	// closes with a lone `}`, so a parser that looks for a closing `}}` runs past
	// it into Porygon's entry. The two ends of that failure are pinned together:
	// Porygon keeps its own evolution, and Eevee does not borrow it.
	assert.deepEqual(oracle.evolutionsOf('Porygon'),
		[{into: 'Porygon2', method: 'item', item: 'Up-Grade'}]);

	const eevee = oracle.evolutionsOf('Eevee');
	assert.deepEqual(eevee.map(e => e.into), [
		'Jolteon', 'Vaporeon', 'Flareon', 'Espeon', 'Umbreon',
		'Leafeon', 'Leafeon', 'Glaceon', 'Glaceon', 'Sylveon',
	]);
	// Leafeon and Glaceon appear twice on purpose: Run & Bun keeps the vanilla
	// location trigger and adds a stone, and both are real ways to get there.
	assert.deepEqual(eevee.filter(e => e.into === 'Leafeon').map(e => e.method),
		['location', 'item']);
});

test('a form alias does not overwrite the base species it collapses onto', () => {
	// SPECIES_ROCKRUFF_OWN_TEMPO is the Dusk-form Rockruff, mapped onto plain
	// Rockruff, and its row comes LATER in evolution.h than the base species'. If
	// the later row wins, Rockruff's three stones become one level-25 dusk step and
	// two Lycanroc forms become unreachable.
	assert.deepEqual(oracle.evolutionsOf('Rockruff'), [
		{into: 'Lycanroc', method: 'item', item: 'Sun Stone'},
		{into: 'Lycanroc-Midnight', method: 'item', item: 'Moon Stone'},
		{into: 'Lycanroc-Dusk', method: 'item', item: 'Dusk Stone'},
	]);
});

test('SPECIES_AEGISLASH is the shield form, because that is the stat block it carries', () => {
	// base_stats.h gives SPECIES_AEGISLASH 50 Atk / 140 Def / 140 SpD — Aegislash's
	// shield stance. Mapping it to Aegislash-Blade would hand a freshly evolved
	// Doublade the 140-attack blade block and overstate every calculation it feeds.
	assert.deepEqual(oracle.evolutionsOf('Doublade'),
		[{into: 'Aegislash-Shield', method: 'item', item: 'Dusk Stone'}]);
	assert.deepEqual(oracle.lineageOf('Aegislash-Shield'), ['Doublade', 'Honedge']);
});

test('mega evolution is not an evolution a box entry can undergo', () => {
	// Charizard's decomp entry is nothing but two mega branches. Keeping them
	// would let `evolve` permanently turn a Charizard into a Charizard-Mega-X,
	// which is a battle form change, not a growth step.
	assert.deepEqual(oracle.evolutionsOf('Charizard'), []);
	for (const species of ['Venusaur', 'Blastoise', 'Gengar', 'Kyogre', 'Groudon']) {
		for (const step of oracle.evolutionsOf(species)) {
			assert.notEqual(step.method, 'mega', `${species} kept a mega step`);
			assert.notEqual(step.method, 'primal', `${species} kept a primal step`);
		}
	}
});

test('a line is walked backwards to its base form', () => {
	assert.deepEqual(oracle.lineageOf('Azumarill'), ['Marill', 'Azurill']);
	assert.deepEqual(oracle.lineageOf('Breloom'), ['Shroomish']);
	assert.deepEqual(oracle.lineageOf('Azurill'), []);
	assert.equal(oracle.preEvolutionOf('Azumarill'), 'Marill');
	assert.equal(oracle.preEvolutionOf('Azurill'), null);
});

test('move legality inherits down the line, with the reason attached', () => {
	// Bullet Seed is a Shroomish egg move. A Breloom holding it is legal, and the
	// only way to know that is to walk back down the line — this project's own
	// example team was briefly reported illegal for exactly this reason.
	const bulletSeed = oracle.canLearn('Breloom', 'Bullet Seed');
	assert.equal(bulletSeed.legal, true);
	assert.ok(bulletSeed.sources.some(s => /egg \(Shroomish\)/.test(s.source)));

	// A move carried up from a pre-evolution's level-up list.
	const rockSlide = oracle.canLearn('Swampert', 'Rock Slide');
	assert.equal(rockSlide.legal, true);
	assert.ok(rockSlide.sources.some(s => s.source === 'level-up' && s.level === 31));

	// And a real negative. Salamence cannot learn Dragon Dance in Run & Bun by
	// any of the four routes, which is not true of every generation — the point
	// of reading the hack's own tables rather than assuming vanilla.
	assert.deepEqual(oracle.canLearn('Salamence', 'Dragon Dance'),
		{legal: false, sources: []});
});

test('level-up moves keep the level, so "not yet" is distinguishable from "never"', () => {
	const moves = oracle.levelUpMoves('Azumarill');
	assert.ok(moves.length > 5);
	for (const pair of moves) {
		assert.equal(typeof pair[0], 'number');
		assert.equal(typeof pair[1], 'string');
		assert.ok(pair[0] >= 1 && pair[0] <= 100, `implausible level ${pair[0]}`);
	}
	assert.deepEqual(moves[0], [1, 'Tackle']);
});

test('the oracle states what it does not cover', () => {
	assert.equal(oracle.LIMITS.wildEncountersOnly, true);
	assert.equal(oracle.LIMITS.staticAndGiftEncountersAbsent, true);
	// Castform is the Weather Institute gift: a real Pokemon a player owns, in no
	// wild table anywhere. That is the gap `LIMITS` exists to declare, and it is
	// why the run layer must accept a catch with no map behind it.
	assert.deepEqual(oracle.whereToFind('Castform'), []);
	assert.deepEqual(oracle.whereToFind('Eevee'), []);
	// Not a starter, though — assuming so would be reading vanilla into this hack.
	// Run & Bun puts all three Hoenn starters in late-game land tables, which is
	// exactly the sort of thing only the game's own data can tell you.
	assert.ok(oracle.whereToFind('Mudkip').length > 0,
		'Run & Bun does field wild Mudkip; a starter is not automatically unobtainable');
});

test('every encounter species is a species the calculator knows', () => {
	const calc = require('@smogon/calc');
	const gen = calc.Generations.get(8);
	const unknown = new Set();
	for (const map of oracle.maps()) {
		for (const table of map.tables) {
			for (const mon of table.mons) {
				if (!gen.species.get(calc.toID(mon.species))) unknown.add(mon.species);
			}
		}
	}
	// A name the calculator cannot resolve is a name the run layer cannot build a
	// Pokemon from, which would make the encounter unusable rather than merely
	// mislabelled.
	assert.deepEqual([...unknown], []);
});

test('growth rates come from the decomp, and the curves are the Gen 3 functions', () => {
	// The rate assignment is hack data; the curve totals are the standard growth
	// functions those constants have named since Ruby. L100 totals pin both at
	// once — a wrong rate or a wrong formula lands on a different number.
	assert.equal(oracle.growthRateOf('Mudkip'), 'medium-slow');
	assert.equal(oracle.expForLevel('Mudkip', 100), 1059860);
	assert.equal(oracle.growthRateOf('Rayquaza'), 'slow');
	assert.equal(oracle.expForLevel('Rayquaza', 100), 1250000);
	assert.equal(oracle.growthRateOf('Azumarill'), 'fast');
	assert.equal(oracle.expForLevel('Azumarill', 100), 800000);
	assert.equal(oracle.growthRateOf('Zigzagoon-Galar'), 'medium-fast');
	assert.equal(oracle.expForLevel('Zigzagoon-Galar', 100), 1000000);
	// The piecewise pair, at a boundary inside each curve.
	const erratic = Object.keys(JSON.parse(require('node:fs').readFileSync(
		'./profiles/run-and-bun/oracle/growth.json', 'utf8')))
		.find(s => oracle.growthRateOf(s) === 'erratic');
	assert.ok(erratic, 'some species must be on the erratic curve');
	assert.equal(oracle.expForLevel(erratic, 100), 600000);
	const fluctuating = Object.keys(JSON.parse(require('node:fs').readFileSync(
		'./profiles/run-and-bun/oracle/growth.json', 'utf8')))
		.find(s => oracle.growthRateOf(s) === 'fluctuating');
	assert.equal(oracle.expForLevel(fluctuating, 100), 1640000);

	// Level 1 is zero EXP by definition, and levelFromExp inverts expForLevel.
	assert.equal(oracle.expForLevel('Mudkip', 1), 0);
	assert.equal(oracle.levelFromExp('Mudkip', oracle.expForLevel('Mudkip', 36)), 36);
	assert.equal(oracle.levelFromExp('Mudkip', oracle.expForLevel('Mudkip', 36) - 1), 35);
	// Unknown species answer null, never a guess.
	assert.equal(oracle.growthRateOf('MissingNo'), null);
	assert.equal(oracle.expForLevel('MissingNo', 50), null);
	assert.equal(oracle.coverage().growthRatedSpecies, 1016);
});
