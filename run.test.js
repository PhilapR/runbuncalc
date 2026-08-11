/* eslint-env node, es6 */
'use strict';

/**
 * Gate for the run document.
 *
 * Two properties matter more than any individual command.
 *
 * The first is that `apply` is pure. Undo is implemented by replaying the log
 * without its last entry, which is only correct if applying the same commands to
 * the same start always lands in the same place — no clocks, no randomness, no
 * mutation of the caller's run. A single hidden `Date.now()` would make undo
 * silently wrong rather than obviously broken, so it is asserted directly.
 *
 * The second is that the oracle is actually load-bearing. Every check here has a
 * matching refusal: a species that is not on the route, a level outside the
 * slot, an evolution that has not come due, a move the species cannot hold. A
 * command engine that accepts everything is a data-entry form, and the whole
 * point of importing the decomp was to stop it being one.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const run = require('./run');

/**
 * Real coordinates from the game, used throughout.
 *
 * Marill is fished out of Route 114 with the Super Rod at level 40 — chosen
 * because it exercises method, rod and an exact level range at once, and because
 * getting it wrong (Route 102, Route 117) is what the refusal cases assert.
 */
const MARILL = {kind: 'catch', species: 'Marill', map: 'Route114', level: 40, method: 'fish'};

function fresh(options) {
	return run.createRun(Object.assign({name: 'Gate', now: 't0'}, options));
}

test('a new run is empty, positioned before the first fight, and serializable', () => {
	const state = fresh();
	assert.equal(state.version, run.VERSION);
	assert.equal(state.profileId, 'run-and-bun');
	// -1 rather than 0: the first battle in the map IS index 0, so "nothing beaten
	// yet" needs a value below it.
	assert.equal(state.position, -1);
	assert.deepEqual(state.box, []);
	assert.deepEqual(state.party, []);
	assert.deepEqual(state.bag, {});
	assert.deepEqual(JSON.parse(JSON.stringify(state)), state, 'a run must survive JSON');
});

test('apply does not touch the run it was given', () => {
	const before = fresh();
	const snapshot = JSON.stringify(before);
	const after = run.apply(before, MARILL);
	assert.equal(JSON.stringify(before), snapshot, 'apply mutated its input');
	assert.equal(after.box.length, 1);
	assert.equal(before.box.length, 0);
});

test('apply copies the command, so a caller can never reach back into a run', () => {
	// Handlers park pieces of the command in the document (`catch` stores `ivs`).
	// Handed the raw object, the caller kept a live reference into a run already
	// returned: mutating it edited the run while the log's separate copy did not
	// move, and undo — which replays the log — then rebuilt a different history
	// than the one on screen.
	const command = {kind: 'catch', species: 'Poochyena', map: 'Route101', level: 3,
		ivs: {hp: 31}};
	const state = run.apply(fresh(), command);
	command.ivs.hp = 0;

	assert.deepEqual(state.box[0].ivs, {hp: 31}, 'the run must not follow the caller');
	assert.deepEqual(state.log[0].command.ivs, {hp: 31}, 'the log must agree with the run');
	assert.deepEqual(run.partySpecs(run.apply(state, {kind: 'party', ids: ['mon-1']}))[0].ivs,
		{hp: 31}, 'and the planner must see what the box says');
});

test('the same commands always produce the same run', () => {
	// Determinism is not a nicety here: undo replays the log, so a hidden clock or
	// any other ambient input would make undo quietly wrong.
	const commands = [MARILL, {kind: 'evolve', id: 'mon-1'}, {kind: 'party', ids: ['mon-1']}];
	const first = run.applyAll(fresh(), commands);
	const second = run.applyAll(fresh(), commands);
	assert.deepEqual(first, second);
});

test('a catch is checked against the map it claims to have happened on', () => {
	const state = run.apply(fresh(), MARILL);
	const mon = state.box[0];
	assert.equal(mon.species, 'Marill');
	assert.equal(mon.level, 40);
	assert.equal(mon.origin.map, 'MAP_ROUTE114');
	assert.equal(mon.origin.method, 'fish');
	assert.equal(mon.origin.rod, 'Super Rod');
	// A caught Pokemon arrives knowing things. Making the player type four moves
	// before the entry is usable would turn catching into data entry.
	assert.ok(mon.moves.length > 0, 'a catch should default to its level-up moves');
	assert.ok(mon.moves.length <= 4);
});

test('a catch that could not have happened is refused, with the reason', () => {
	const state = fresh();
	assert.throws(
		() => run.apply(state, {kind: 'catch', species: 'Marill', map: 'Route102', level: 5}),
		/Marill does not appear on Route102; it holds:/
	);
	assert.throws(
		() => run.apply(state, {kind: 'catch', species: 'Marill', map: 'Route114', level: 12}),
		/is level fish 40-40, not 12/
	);
	assert.throws(
		() => run.apply(state, {kind: 'catch', species: 'Marill', map: 'Nowhere', level: 40}),
		/no map named "Nowhere" has a wild encounter table/
	);
	assert.throws(
		() => run.apply(state, {kind: 'catch', species: 'Marill', map: 'Route114'}),
		/level must be an integer/
	);
});

test('a gift or starter is recorded as declared rather than refused', () => {
	// Castform is the Weather Institute gift and appears in no wild table. If a
	// catch needed a map, half a real box could not be recorded at all.
	const state = run.apply(fresh(), {kind: 'catch', species: 'Castform', level: 25});
	assert.equal(state.box[0].origin.method, 'declared');
	assert.equal(state.box[0].origin.map, null);
	assert.match(state.log[0].summary, /declared, no wild table/);
});

test('evolution follows the table, including when it is not due yet', () => {
	let state = run.apply(fresh(), {kind: 'catch', species: 'Marill', map: 'Route114', level: 40});
	state = run.apply(state, {kind: 'evolve', id: 'mon-1'});
	assert.equal(state.box[0].species, 'Azumarill');
	assert.throws(() => run.apply(state, {kind: 'evolve', id: 'mon-1'}),
		/Azumarill does not evolve/);

	// A level evolution that has not come due.
	const early = run.apply(fresh(), {kind: 'catch', species: 'Poochyena', map: 'Route101', level: 3});
	assert.throws(() => run.apply(early, {kind: 'evolve', id: 'mon-1'}),
		/becomes Mightyena at level \d+; it is 3/);

	// A branching line has to be told which branch.
	// Wurmple is another species this hack gives no level-up moves, so the
	// catch names one of its two tutor moves.
	const wurmple = run.apply(fresh(), {kind: 'catch', species: 'Wurmple', level: 10, moves: ['Bug Bite']});
	assert.throws(() => run.apply(wurmple, {kind: 'evolve', id: 'mon-1'}),
		/more than one evolution — pick one of/);
	assert.equal(
		run.apply(wurmple, {kind: 'evolve', id: 'mon-1', into: 'Cascoon'}).box[0].species,
		'Cascoon'
	);
	assert.throws(() => run.apply(wurmple, {kind: 'evolve', id: 'mon-1', into: 'Beautifly'}),
		/does not become Beautifly/);
});

test('a move must be one the species can actually hold', () => {
	let state = run.apply(fresh(), MARILL);
	state = run.apply(state, {kind: 'evolve', id: 'mon-1'});

	assert.throws(() => run.apply(state, {kind: 'teach', id: 'mon-1', move: 'Dragon Dance'}),
		/Azumarill cannot learn Dragon Dance/);

	// Four moves is four moves; a fifth needs one named to replace.
	const full = run.applyAll(state, [
		{kind: 'teach', id: 'mon-1', move: 'Play Rough', replace: state.box[0].moves[0]},
	]);
	assert.ok(full.box[0].moves.includes('Play Rough'));
	assert.equal(full.box[0].moves.length, state.box[0].moves.length);
	assert.throws(() => run.apply(full, {kind: 'teach', id: 'mon-1', move: 'Play Rough'}),
		/already knows Play Rough/);
	assert.throws(
		() => run.apply(full, {kind: 'teach', id: 'mon-1', move: 'Waterfall', replace: 'Fly'}),
		/does not know Fly/
	);
});

test('a level-up move is not available before its level', () => {
	// Caught at 3, so anything the species only learns later must be refused with
	// the level rather than a flat "cannot learn".
	const state = run.apply(fresh(), {kind: 'catch', species: 'Poochyena', map: 'Route101', level: 3});
	const later = run.learnable(state, 'mon-1').later;
	assert.ok(later.length > 0, 'a level 3 Poochyena should have moves still ahead of it');
	assert.throws(() => run.apply(state, {kind: 'teach', id: 'mon-1', move: later[0].move}),
		/learns .* at level \d+; it is 3/);
	// And what it CAN learn now is offered separately, so a UI need not guess.
	const now = run.learnable(state, 'mon-1').now;
	assert.ok(now.length > 0);
	assert.ok(run.apply(state, {kind: 'teach', id: 'mon-1', move: now[0].move}));
});

test('the level cap follows boss tiers, not badges', () => {
	const capped = fresh({levelCap: 'next-milestone-ace'});
	// A fresh run is capped by the FIRST story-boss fight — the Petalburg Woods
	// grunt's Croagunk at 12 — not by Brawly's 21 two story fights later. The
	// whole sequence is read out of the run map, never transcribed.
	const cap = run.levelCap(capped);
	assert.equal(cap.trainer, 'Team Aqua Grunt Petalburg Woods');
	assert.equal(cap.cap, 12);
	assert.equal(cap.ace, 'Croagunk');
	assert.equal(cap.tier, 'story');

	// The cap walks the Brawly split: 12 → 16 → 16 → 21, then the next badge —
	// and past Roxanne it is Chelle's Rhydon at 32, not Wattson's 35, because
	// her Daycare fight (#181) sits between the two badges.
	const walk = [
		['Team Aqua Grunt Petalburg Woods', 16, 'story'],
		['Team Aqua Grunt Museum #1', 16, 'story'],
		['Team Aqua Grunt Museum #2', 21, 'boss'],
		['Leader Brawly', 25, 'boss'],
		['Leader Roxanne', 32, 'story'],
		['Trainer Chelle Daycare', 35, 'boss'],
	];
	let walked = capped;
	for (const step of walk) {
		walked = run.apply(walked, {kind: 'beat', trainer: step[0]});
		const at = run.levelCap(walked);
		assert.equal(at.cap, step[1], `after ${step[0]}`);
		assert.equal(at.tier, step[2], `after ${step[0]}`);
	}

	let state = run.apply(capped, {kind: 'catch', species: 'Poochyena', map: 'Route101', level: 3});
	state = run.apply(state, {kind: 'levelUp', id: 'mon-1', to: cap.cap});
	assert.equal(state.box[0].level, cap.cap);
	assert.throws(() => run.apply(state, {kind: 'levelUp', id: 'mon-1', to: cap.cap + 1}),
		/the cap is 12 \(Team Aqua Grunt Petalburg Woods's Croagunk\)/);

	// On by default: the caps are hardcoded in the game, not a player rule.
	// 'none' is the escape hatch for free editing.
	assert.equal(run.levelCap(fresh()).cap, 12);
	assert.equal(run.levelCap(fresh({levelCap: 'none'})).cap, null);
	const free = run.apply(
		run.apply(fresh({levelCap: 'none'}), {kind: 'catch', species: 'Poochyena', map: 'Route101', level: 3}),
		{kind: 'levelUp', id: 'mon-1', to: 100});
	assert.equal(free.box[0].level, 100);
});

test('to-cap is free, and each level over the cap spends a Rare Candy', () => {
	// The game's economy: an infinite candy reaches the cap, the limited candies
	// found through the run are the only way past it.
	let state = run.apply(fresh(), {kind: 'catch', species: 'Poochyena', map: 'Route101', level: 3});
	state = run.apply(state, {kind: 'levelUp', id: 'mon-1', to: 'cap'});
	assert.equal(state.box[0].level, 12);
	assert.throws(() => run.apply(state, {kind: 'levelUp', id: 'mon-1', to: 14}),
		/each level above it costs a Rare Candy — need 2, the bag has 0/);
	state = run.apply(state, {kind: 'acquire', item: 'Rare Candy', count: 3});
	state = run.apply(state, {kind: 'levelUp', id: 'mon-1', to: 14});
	assert.equal(state.box[0].level, 14);
	assert.deepEqual(state.bag, {'Rare Candy': 1}, 'two candies spent, one left');
	assert.match(state.log[state.log.length - 1].summary, /2 Rare Candy over the cap/);
	// A capless run has no cap to level to.
	assert.throws(
		() => run.apply(run.apply(fresh({levelCap: 'none'}),
			{kind: 'catch', species: 'Poochyena', map: 'Route101', level: 3}),
		{kind: 'levelUp', id: 'mon-1', to: 'cap'}),
		/no cap — give a number/);
});

test('levels do not go down', () => {
	const state = run.apply(fresh(), MARILL);
	assert.throws(() => run.apply(state, {kind: 'levelUp', id: 'mon-1', to: 5}),
		/already level 40; levels do not go down/);
});

test('the bag conserves items across every move', () => {
	let state = run.apply(fresh(), MARILL);
	state = run.apply(state, {kind: 'acquire', item: 'Leftovers', count: 2});
	assert.deepEqual(state.bag, {Leftovers: 2});
	assert.throws(() => run.apply(state, {kind: 'give', id: 'mon-1', item: 'Choice Band'}),
		/the bag has no Choice Band/);

	state = run.apply(state, {kind: 'give', id: 'mon-1', item: 'Leftovers'});
	assert.equal(state.box[0].item, 'Leftovers');
	assert.deepEqual(state.bag, {Leftovers: 1});

	// Swapping must return the old item. A bag that loses an item on every swap
	// is worse than no bag at all.
	state = run.apply(state, {kind: 'acquire', item: 'Sitrus Berry'});
	state = run.apply(state, {kind: 'give', id: 'mon-1', item: 'Sitrus Berry'});
	assert.equal(state.box[0].item, 'Sitrus Berry');
	assert.deepEqual(state.bag, {Leftovers: 2});

	state = run.apply(state, {kind: 'take', id: 'mon-1'});
	assert.equal(state.box[0].item, null);
	assert.deepEqual(state.bag, {Leftovers: 2, 'Sitrus Berry': 1});
	// Releasing a holder returns what it held rather than destroying it.
	const released = run.apply(
		run.apply(state, {kind: 'give', id: 'mon-1', item: 'Leftovers'}),
		{kind: 'release', id: 'mon-1'});
	assert.deepEqual(released.bag, {Leftovers: 2, 'Sitrus Berry': 1});
	assert.deepEqual(released.box, []);
});

test('the party holds six, in order, with no duplicates', () => {
	let state = fresh();
	for (let i = 0; i < 7; i++) {
		state = run.apply(state, {kind: 'catch', species: 'Poochyena', map: 'Route101', level: 3});
	}
	const ids = state.box.map(mon => mon.id);
	assert.throws(() => run.apply(state, {kind: 'party', ids}), /a party holds 6/);
	assert.throws(() => run.apply(state, {kind: 'party', ids: ['mon-1', 'mon-1']}),
		/cannot occupy two slots/);
	assert.throws(() => run.apply(state, {kind: 'party', ids: ['mon-99']}), /no Pokemon with id/);

	const set = run.apply(state, {kind: 'party', ids: ['mon-3', 'mon-1']});
	assert.deepEqual(set.party, ['mon-3', 'mon-1']);
	assert.equal(run.findMon(set, 'mon-3').status, 'party');
	assert.equal(run.findMon(set, 'mon-2').status, 'boxed');
	// Order is the lead order, so it must survive round-tripping to the planner.
	assert.equal(run.partySpecs(set)[0].species, 'Poochyena');
	assert.equal(run.partySpecs(set).length, 2);
});

test('permadeath is a declared rule, not the default', () => {
	let normal = run.apply(fresh(), MARILL);
	normal = run.apply(normal, {kind: 'party', ids: ['mon-1']});
	normal = run.apply(normal, {kind: 'faint', id: 'mon-1'});
	// Fainting is not a state a save file keeps. Treating it as one would make
	// every run look like a nuzlocke.
	assert.equal(run.findMon(normal, 'mon-1').status, 'party');
	assert.deepEqual(normal.party, ['mon-1']);
	assert.match(normal.log[2].summary, /permadeath is off/);

	let hard = run.apply(fresh({permadeath: true}), MARILL);
	hard = run.apply(hard, {kind: 'party', ids: ['mon-1']});
	hard = run.apply(hard, {kind: 'faint', id: 'mon-1'});
	assert.equal(run.findMon(hard, 'mon-1').status, 'dead');
	assert.deepEqual(hard.party, []);
	assert.throws(() => run.apply(hard, {kind: 'party', ids: ['mon-1']}),
		/has fainted for good/);
});

test('audit regressions: routes dedupe, family components, growth via macros, epitaphs write once', () => {
	// The decomp declares Altering Cave nine times under one constant; only the
	// first is reachable by any lookup, so the routes view gets ONE row for it.
	const state = fresh({permadeath: true});
	const routes = run.unusedRoutes(state).routes;
	assert.equal(routes.filter(route => route.map === 'MAP_ALTERING_CAVE').length, 1);
	const ids = routes.map(route => route.map);
	assert.equal(new Set(ids).size, ids.length, 'one row per canonical map');

	// Flabébé is one species again: a single 50% row, and the dupes clause
	// holds against itself.
	const soo = run.encountersOn(state, 'Sootopolis City');
	const flab = soo.mons.filter(mon => /^Flab/.test(mon.species));
	assert.equal(flab.length, 1);
	assert.equal(flab[0].chance, 50);
	const caught = run.apply(state, {kind: 'catch', species: 'Flabebe', map: 'Sootopolis City', level: 20});
	assert.equal(run.encountersOn(caught, 'Sootopolis City')
		.mons.find(mon => mon.species === 'Flabebe').dupe, true);

	// The Alolan Grimer line is ONE family: both halves cannot be kept.
	const grimer = run.apply(fresh({permadeath: true}),
		{kind: 'catch', species: 'Grimer-Alola', map: 'Route117', level: 5, method: 'surf'});
	assert.throws(
		() => run.apply(grimer,
			{kind: 'catch', species: 'Muk-Alola', map: 'Abandoned Ship Rooms B1f', level: 50}),
		/dupe of Grimer-Alola/);

	// Macro-defined growth rates import: Pikachu answers, like everything wild.
	const oracle = require('./profiles').getProfile('run-and-bun').oracle;
	assert.equal(oracle.growthRateOf('Pikachu'), 'medium-fast');
	assert.equal(oracle.expForLevel('Pikachu', 50), 125000);

	// A death is written once: re-fainting is refused, the epitaph survives.
	let lost = run.applyAll(fresh({permadeath: true}), [
		{kind: 'catch', species: 'Lillipup', map: 'Route101', level: 3},
		{kind: 'faint', id: 'mon-1', to: 'Leader Brawly', move: 'Drain Punch'},
	]);
	assert.throws(() => run.apply(lost, {kind: 'faint', id: 'mon-1'}), /already gone/);
	assert.equal(run.findMon(lost, 'mon-1').died.move, 'Drain Punch');
});

test('a loss carries its epitaph, and the trainer named must be real', () => {
	let state = run.applyAll(fresh({permadeath: true}), [
		{kind: 'catch', species: 'Poochyena', map: 'Route101', level: 3},
		{kind: 'party', ids: ['mon-1']},
	]);

	// A named killer must be a fight this run can see, spelled as the map spells it.
	assert.throws(() => run.apply(state, {kind: 'faint', id: 'mon-1', to: 'Brawly'}),
		/no fight named "Brawly"/);

	state = run.apply(state, {kind: 'faint', id: 'mon-1',
		to: 'Leader Brawly', move: 'Drain Punch'});
	const mon = run.findMon(state, 'mon-1');
	assert.equal(mon.status, 'dead');
	assert.equal(mon.died.to, 'Leader Brawly');
	assert.equal(mon.died.move, 'Drain Punch');
	assert.equal(mon.died.order, 77);
	assert.match(state.log[state.log.length - 1].summary, /Leader Brawly's Drain Punch/);

	// The epitaph is optional: a bare faint still records that it happened here.
	let plain = run.applyAll(fresh({permadeath: true}), [
		{kind: 'catch', species: 'Lillipup', map: 'Route101', level: 3},
		{kind: 'faint', id: 'mon-1'},
	]);
	assert.deepEqual(run.findMon(plain, 'mon-1').died, {at: -1});
});

test('the routes view knows what is spent and what is still out there', () => {
	const state = run.apply(fresh({permadeath: true}),
		{kind: 'catch', species: 'Poochyena', map: 'Route101', level: 3});
	const all = run.unusedRoutes(state);
	assert.equal(all.order, 'declaration');

	const spent = all.routes.find(route => route.name === 'Route101');
	assert.deepEqual(spent.used, {species: 'Poochyena', level: 3});
	// Its best rows exclude the dupe line and carry re-roll odds, best first.
	assert.ok(spent.best.every(mon => mon.species !== 'Poochyena'));
	assert.equal(spent.best[0].chance, Math.round(20 / 90 * 1000) / 10);

	const open = all.routes.find(route => route.name === 'Route102');
	assert.equal(open.used, undefined);
	assert.ok(open.best.length === 3 && open.best[0].chance >= open.best[1].chance);

	// Without the ruleset the same view still answers, on raw table chance.
	const plain = run.unusedRoutes(run.apply(fresh(), {kind: 'catch', species: 'Lillipup', map: 'Route101', level: 3}));
	const r101 = plain.routes.find(route => route.name === 'Route101');
	assert.equal(r101.best[0].chance, 20);
});

test('the split sheet is the gauntlet with its caps, and it moves with the run', () => {
	const state = fresh({rival: 'Swampert'});
	const prep = run.splitPrep(state);
	assert.equal(prep.split.boss, 'Leader Brawly');
	assert.equal(prep.split.index, 1);
	// The gauntlet is every remaining boss-tier fight in the split, boss last,
	// each under the cap in force when it is fought — the Museum pair shares 16.
	assert.deepEqual(prep.gauntlet.map(f => [f.trainer, f.tier, f.cap]), [
		['Team Aqua Grunt Petalburg Woods', 'story', 12],
		['Team Aqua Grunt Museum #1', 'story', 16],
		['Team Aqua Grunt Museum #2', 'story', 16],
		['Leader Brawly', 'boss', 21],
	]);
	assert.equal(prep.fightsAhead - prep.filler, prep.gauntlet.length);

	// Beating the boss moves the sheet to the next split, gauntlet rebuilt.
	const onward = run.apply(state, {kind: 'beat', trainer: 'Leader Brawly'});
	const next = run.splitPrep(onward);
	assert.equal(next.split.index, 2);
	assert.notEqual(next.split.boss, 'Leader Brawly');
	assert.ok(next.gauntlet.length >= 1, 'a split ends at its boss, so the gauntlet is never empty');
	assert.equal(next.gauntlet[next.gauntlet.length - 1].trainer, next.split.boss);
});

test('nuzlocke: one random catch per route, and dupes do not count', () => {
	// Without the ruleset, a second catch on the same route stays legal.
	let free = run.apply(fresh(), {kind: 'catch', species: 'Lillipup', map: 'Route101', level: 3});
	free = run.apply(free, {kind: 'catch', species: 'Poochyena', map: 'Route101', level: 3});
	assert.equal(free.box.length, 2);

	// Under it, the route's encounter is spent by the first catch...
	let hard = run.apply(fresh({permadeath: true}),
		{kind: 'catch', species: 'Poochyena', map: 'Route101', level: 3});
	assert.throws(() => run.apply(hard, {kind: 'catch', species: 'Lillipup', map: 'Route101', level: 3}),
		/already used its one Route101 encounter on Poochyena/);

	// ...and losing or releasing the catch does not refund it: the log is the
	// record, not the box.
	const released = run.apply(hard, {kind: 'release', id: 'mon-1'});
	assert.throws(() => run.apply(released, {kind: 'catch', species: 'Lillipup', map: 'Route101', level: 3}),
		/does not refund/);

	// The dupes clause reaches across the evolution line: a caught Buizel makes
	// a Floatzel on a different route a dupe.
	let water = run.apply(fresh({permadeath: true}),
		{kind: 'catch', species: 'Buizel', map: 'Route104', level: 5, method: 'fish'});
	assert.throws(() => run.apply(water, {kind: 'catch', species: 'Floatzel', map: 'Route102', level: 50}),
		/dupe of Buizel/);

	// A gift or static (no map) is not the route's random encounter: exempt.
	const gift = run.apply(hard, {kind: 'catch', species: 'Poochyena', level: 5});
	assert.equal(gift.box.length, 2);
	assert.equal(run.findMon(gift, 'mon-2').origin.method, 'declared');
});

test('nuzlocke: the encounter list is a forecast — odds, dupes, and a used route', () => {
	// Plain run: every row carries its raw table chance and nothing else.
	const plain = run.encountersOn(fresh(), 'Route101');
	const lillipup = plain.mons.find(mon => mon.species === 'Lillipup');
	assert.equal(lillipup.chance, 20);
	assert.equal(lillipup.dupe, undefined);
	assert.equal(plain.used, undefined);

	// Nuzlocke run that owns Poochyena: its row is a dead slot, and the odds of
	// everything else renormalize over the 90% a re-roll can actually keep.
	const state = run.apply(fresh({permadeath: true}),
		{kind: 'catch', species: 'Poochyena', map: 'Route101', level: 3});
	const here = run.encountersOn(state, 'Route101');
	const pooch = here.mons.find(mon => mon.species === 'Poochyena');
	assert.equal(pooch.dupe, true);
	assert.equal(pooch.odds, 0);
	const scout = here.mons.find(mon => mon.species === 'Lillipup');
	assert.equal(scout.dupe, false);
	assert.equal(scout.odds, Math.round(20 / 90 * 1000) / 10);
	// And the route says it has already been used, naming what it gave.
	assert.deepEqual(here.used, {species: 'Poochyena', level: 3});
});

test('beating a fight moves the run forward, and only forward', () => {
	let state = run.apply(fresh(), {kind: 'beat', trainer: 'Youngster Calvin'});
	assert.equal(state.position, 0);
	assert.equal(run.upcoming(state, 1)[0].trainer, 'Bug Catcher Rick');
	state = run.apply(state, {kind: 'beat', trainer: 'Bug Catcher Rick'});
	assert.throws(() => run.apply(state, {kind: 'beat', trainer: 'Youngster Calvin'}),
		/already behind the run/);
	assert.throws(() => run.apply(state, {kind: 'beat', trainer: 'Nobody At All'}),
		/no fight named/);
});

test('undo replays the log without its last entry', () => {
	const commands = [
		MARILL,
		{kind: 'evolve', id: 'mon-1'},
		{kind: 'party', ids: ['mon-1']},
		{kind: 'beat', trainer: 'Youngster Calvin'},
	];
	const full = run.applyAll(fresh(), commands);
	const undone = run.undo(full);
	assert.equal(undone.log.length, 3);
	assert.equal(undone.position, -1, 'the beat should be gone');
	assert.deepEqual(undone.party, ['mon-1'], 'everything before it should remain');
	// Undoing back to the start must give a run equal to a fresh one, otherwise
	// replay is dropping or keeping something it should not.
	let back = full;
	for (let i = 0; i < commands.length; i++) back = run.undo(back);
	assert.deepEqual(back, fresh());
	assert.throws(() => run.undo(back), /nothing to undo/);
});

test('undo rebuilds the exact document, on the path that passes no clock', () => {
	// The shipped browser panel posts no `now`, so `apply` inherits `updatedAt`
	// and logs `at: null`. Undo used to patch `updatedAt` from the last log
	// entry's `at` — null — and undo(apply(r, c)) came back unequal to r on the
	// one path every real user takes. Replaying each entry under its own `at`
	// makes the rebuild exact by construction, so this asserts the whole
	// document at every step rather than the fields anyone thought to name.
	const commands = [
		MARILL,
		{kind: 'evolve', id: 'mon-1'},
		{kind: 'acquire', item: 'Leftovers', count: 2},
		{kind: 'give', id: 'mon-1', item: 'Leftovers'},
		{kind: 'party', ids: ['mon-1']},
		{kind: 'beat', trainer: 'Youngster Calvin'},
	];
	const states = [fresh()];
	for (const command of commands) {
		states.push(run.apply(states[states.length - 1], command));
	}

	let back = states[states.length - 1];
	for (let i = commands.length - 1; i >= 0; i--) {
		back = run.undo(back);
		assert.equal(JSON.stringify(back), JSON.stringify(states[i]),
			`undoing ${commands[i].kind} must reproduce the document before it`);
	}
	// A `now` that IS supplied has to survive the round trip just as exactly.
	const stamped = run.apply(fresh(), MARILL, {now: 't1'});
	assert.equal(run.undo(run.apply(stamped, {kind: 'evolve', id: 'mon-1'}, {now: 't2'}))
		.updatedAt, 't1');
});

test('the run plans the next fight with the party it actually has', () => {
	let state = run.apply(fresh(), MARILL);
	assert.throws(() => run.planNext(state), /the party is empty/);
	state = run.apply(state, {kind: 'evolve', id: 'mon-1'});
	state = run.apply(state, {kind: 'party', ids: ['mon-1']});

	const plan = run.planNext(state);
	assert.equal(plan.trainer, 'Youngster Calvin', 'the run starts before the first fight');
	// The party is the player's own box, never a borrowed trainer build.
	assert.equal(plan.borrowedPlayerBuild, false);
	assert.equal(plan.state.sides.player.party[0].species, 'Azumarill');
	assert.equal(plan.state.sides.player.party[0].level, 40);
	assert.ok(plan.actions.length > 1);
});

test('a look-ahead plan fights with the party the run will legally have', () => {
	// Planning Brawly from the start of the run used to field a level 3 Poochyena
	// against his level 21 party and report every damage roll from it — an answer
	// about a team the player would never stand there with, since the free candy
	// puts the whole box at 21 by the time that fight happens.
	let state = run.apply(fresh(), {kind: 'catch', species: 'Poochyena', map: 'Route101', level: 3});
	state = run.apply(state, {kind: 'party', ids: ['mon-1']});

	const ahead = run.planNext(state, {trainer: 'Leader Brawly'});
	assert.equal(ahead.trainer, 'Leader Brawly');
	assert.equal(ahead.state.sides.player.party[0].level, 21,
		'the projected level has to reach the state the AI is scored against');
	assert.deepEqual(ahead.projection, {applied: true, cap: 21, from: 'projected'});
	// The run itself does not move: planning is a question, not a command.
	assert.equal(state.box[0].level, 3);

	// The fight actually next is projected to ITS cap, which for the first fight
	// in the map is the Petalburg Woods grunt's 12.
	assert.deepEqual(run.planNext(state).projection, {applied: true, cap: 12, from: 'projected'});

	// A party already at or over the cap is planned at exactly the levels the box
	// holds, and says so — hedging about numbers the player can see would be
	// worse than saying nothing.
	let over = run.apply(fresh(), MARILL);
	over = run.apply(over, {kind: 'party', ids: ['mon-1']});
	const current = run.planNext(over, {trainer: 'Leader Brawly'});
	assert.deepEqual(current.projection, {applied: true, cap: 21, from: 'current'});
	assert.equal(current.state.sides.player.party[0].level, 40);

	// A run that declines caps has nothing to project to, and claims nothing.
	const free = run.applyAll(fresh({levelCap: 'none'}), [
		{kind: 'catch', species: 'Poochyena', map: 'Route101', level: 3},
		{kind: 'party', ids: ['mon-1']},
	]);
	const unprojected = run.planNext(free, {trainer: 'Leader Brawly'});
	assert.deepEqual(unprojected.projection, {applied: false, cap: null, from: 'current'});
	assert.equal(unprojected.state.sides.player.party[0].level, 3);
});

test('encounters on a map mark what the run already owns', () => {
	const state = run.apply(fresh(), {kind: 'catch', species: 'Poochyena', map: 'Route101', level: 3});
	const here = run.encountersOn(state, 'Route101');
	assert.ok(here.mons.length > 0);
	assert.equal(here.mons.find(m => m.species === 'Poochyena').owned, true);
	assert.equal(here.mons.find(m => m.species === 'Lillipup').owned, false);
	assert.equal(run.encountersOn(state, 'Nowhere'), null);
});

test('an unknown command names the ones that exist', () => {
	assert.throws(() => run.apply(fresh(), {kind: 'yeet', id: 'mon-1'}),
		/unknown command "yeet"; known: catch, levelUp, evolve/);
	assert.throws(() => run.apply(fresh(), {}), /a command needs a kind/);
	assert.throws(() => run.createRun({levelCap: 'vibes'}), /unknown level cap mode/);
});

test('the summary states where the run has got to', () => {
	let state = run.applyAll(fresh({levelCap: 'next-milestone-ace'}), [
		MARILL,
		{kind: 'evolve', id: 'mon-1'},
		{kind: 'party', ids: ['mon-1']},
		{kind: 'beat', trainer: 'Youngster Calvin'},
		{kind: 'acquire', item: 'Leftovers'},
	]);
	const summary = run.summarize(state);
	assert.equal(summary.position, 0);
	assert.equal(summary.next.trainer, 'Bug Catcher Rick');
	assert.equal(summary.boxed, 1);
	assert.equal(summary.lost, 0);
	assert.equal(summary.party[0].species, 'Azumarill');
	assert.deepEqual(summary.bag, {Leftovers: 1});
	assert.equal(summary.commands, 5);
	// Fight #0 is beaten, so the cap fight is still the first story boss ahead.
	assert.equal(summary.levelCap.trainer, 'Team Aqua Grunt Petalburg Woods');
	assert.equal(summary.split.boss, 'Leader Brawly');
	state = run.apply(state, {kind: 'release', id: 'mon-1'});
	assert.equal(run.summarize(state).boxed, 0);
});

test('the story spine derives beaten from position, not from bookkeeping', () => {
	const state = fresh();
	const spine = run.milestones(state);
	// 44: nine badge battles, eight Elite Four rounds, the Champion, nine rival
	// battles, seven admin battles, five team-leader battles, Wally, Steven, both
	// Chelle fights and Dumbass Soupercell.
	assert.equal(spine.length, 44, 'every milestone fight in the map');
	assert.equal(spine[0].trainer, 'Leader Brawly');
	assert.equal(spine[spine.length - 1].trainer, 'Champion Wallace');
	assert.ok(spine.every(m => !m.beaten), 'a fresh run has beaten nothing');

	// Beating Norman (#337) implies the run is past every earlier milestone —
	// both rounds of rivals included — with no per-trainer bookkeeping.
	const later = run.apply(state, {kind: 'beat', trainer: 'Leader Norman'});
	const after = run.milestones(later);
	assert.equal(after.filter(m => m.beaten).length, 8);
	assert.equal(after.filter(m => m.beaten).pop().trainer, 'Leader Norman');
	assert.equal(after.filter(m => !m.beaten)[0].trainer, 'Magma Admin Tabitha Mt Chimney');
	// Milestones carry their tier so the spine can draw badges taller than
	// story bosses.
	assert.equal(after[0].tier, 'boss');
	assert.equal(after.find(m => m.trainer === 'Magma Admin Tabitha Mt Chimney').tier, 'story');
});

test('the run is narrated in splits, ended by badges', () => {
	const state = fresh();
	const at = run.split(state);
	// 18 split-enders: nine badge battles (Tate and Liza are separate fights),
	// eight Elite Four rounds counting double variants, and the Champion.
	assert.equal(at.of, 18);
	assert.equal(at.index, 1);
	assert.equal(at.boss, 'Leader Brawly');
	assert.equal(at.finished, false);

	// Beating story fights does not advance the split; beating the badge does.
	const grunts = run.apply(state, {kind: 'beat', trainer: 'Team Aqua Grunt Museum #2'});
	assert.equal(run.split(grunts).index, 1);
	const badge = run.apply(grunts, {kind: 'beat', trainer: 'Leader Brawly'});
	assert.equal(run.split(badge).index, 2);
	assert.equal(run.split(badge).boss, 'Leader Roxanne');

	// The tier classifier itself: boss ends splits, story sets caps, filler is null.
	const profile = require('./profiles').getProfile();
	assert.equal(run.fightTier(profile, 'Leader Brawly'), 'boss');
	assert.equal(run.fightTier(profile, 'Elite Four SidneyDouble'), 'boss');
	assert.equal(run.fightTier(profile, 'Champion Wallace'), 'boss');
	assert.equal(run.fightTier(profile, 'Team Aqua Grunt Petalburg Woods'), 'story');
	assert.equal(run.fightTier(profile, 'Team Aqua Grunt Museum #1'), 'story');
	assert.equal(run.fightTier(profile, 'Trainer Rival Cycling Road Swampert'), 'story');
	assert.equal(run.fightTier(profile, 'Aqua Leader Archie Mt Pyre'), 'story');
	// The seven admin battles are the mini-bosses proper — one is keyed with no
	// space before its location and must still classify.
	assert.equal(run.fightTier(profile, 'Magma Admin Tabitha Mt Chimney'), 'story');
	assert.equal(run.fightTier(profile, 'Aqua Admin Shelly Weather Institute'), 'story');
	assert.equal(run.fightTier(profile, 'Aqua Admin ShellySeafloorCavern'), 'story');
	assert.equal(run.fightTier(profile, 'Magma Admin Courtney Space center'), 'story');
	// Chelle carries no team or title prefix but follows the same Name+Location
	// convention, and Soupercell is the one-off L100 Victory Road capstone.
	assert.equal(run.fightTier(profile, 'Trainer Chelle Daycare'), 'story');
	assert.equal(run.fightTier(profile, 'Trainer Chelle Mt Pyre'), 'story');
	assert.equal(run.fightTier(profile, 'Dumbass Soupercell'), 'story');
	// The anchor is exact: a route trainer whose name merely contains "chelle" is
	// still filler.
	assert.equal(run.fightTier(profile, 'Cool Trainer Michelle'), null);
	// Gauntlet grunts are the road TO the boss, not bosses: no tier, no cap.
	assert.equal(run.fightTier(profile, 'Team Aqua Grunt Weather Inst #1'), null);
	assert.equal(run.fightTier(profile, 'Team Magma Grunt Magma Hideout #4teen'), null);
	assert.equal(run.fightTier(profile, 'Team Aqua Grunt Seafloor Cavern #2'), null);
	assert.equal(run.fightTier(profile, 'Youngster Calvin'), null);
	assert.equal(run.fightTier(profile, 'Winstrate Victor'), null);
});

test('a gauntlet is capped by the admin at its end, not grunt by grunt', () => {
	// Beating Flannery puts the Weather Institute ahead: three grunt fights,
	// then Aqua Admin Shelly. The cap must be Shelly's 65 for the whole
	// corridor — the grunts (aces 60-62) set nothing.
	const state = run.apply(fresh({levelCap: 'next-milestone-ace'}),
		{kind: 'beat', trainer: 'Leader Flannery'});
	const cap = run.levelCap(state);
	assert.equal(cap.trainer, 'Aqua Admin Shelly Weather Institute');
	assert.equal(cap.cap, 65);
	assert.equal(cap.tier, 'story');
	// And clearing a grunt does not move the cap.
	const midGauntlet = run.apply(state, {kind: 'beat', trainer: 'Team Aqua Grunt Weather Inst #2'});
	assert.equal(run.levelCap(midGauntlet).trainer, 'Aqua Admin Shelly Weather Institute');
});

test('the cap at a fight is the cap of the stretch that fight belongs to', () => {
	// A cap is a stretch of map, not a point. `levelCap` answers it from where the
	// run stands; `capAt` answers it for a fight the run has not reached, which is
	// the only way a look-ahead plan can be about the party the player will
	// legally have when they get there.
	const state = fresh();

	// A boss's own order is inside its own stretch: Brawly (#77) is fought at 21,
	// not at Roxanne's 25.
	assert.equal(run.capAt(state, 77), 21);
	// The first filler AFTER a cap fight has already moved to the next stretch —
	// #57 is past the Museum grunts (#56), so it is played under Brawly's 21.
	assert.equal(run.capAt(state, 57), 21);
	assert.equal(run.capAt(state, 59), 21, 'route filler mid-stretch, still Brawly');
	// Filler BEFORE a cap fight is still under it: #20 sits between the Petalburg
	// Woods grunt (#19) and the Museum grunts (#53), so 16.
	assert.equal(run.capAt(state, 20), 16);
	assert.equal(run.capAt(state, 53), 16, "the Museum grunt's own order");
	// The start of the run, before any fight, is the first story boss' 12 — the
	// same answer `levelCap` gives a fresh run, from the other direction.
	assert.equal(run.capAt(state, -1), 12);
	assert.equal(run.capAt(state, 0), 12);
	assert.equal(run.capAt(state, 19), 12);
	assert.equal(run.levelCap(state).cap, run.capAt(state, state.position + 1));

	// Nothing boss-tier past the Champion, so nothing sets a cap there.
	assert.equal(run.capAt(state, 1620), 100, 'the Champion caps his own fight');
	assert.equal(run.capAt(state, 1621), null);
	// And a run that declines caps has none anywhere.
	assert.equal(run.capAt(fresh({levelCap: 'none'}), 77), null);

	// The cap of a fight does not move as the run advances — it is a property of
	// the map, not of the position. Beating Brawly does not make him easier.
	const later = run.apply(state, {kind: 'beat', trainer: 'Leader Brawly'});
	assert.equal(run.capAt(later, 77), 21);
});

test('projecting the party to a cap raises levels and never lowers them', () => {
	// The infinite Rare Candy levels the whole box to cap for free, so a mon below
	// a future fight's cap WILL be at it by then. A mon taken OVER the cap with
	// the run's limited candies keeps those levels — nothing takes them back — so
	// the projection is a max, not an assignment.
	let state = run.apply(fresh(), {kind: 'catch', species: 'Poochyena', map: 'Route101', level: 3});
	state = run.apply(state, MARILL);
	state = run.apply(state, {kind: 'party', ids: ['mon-1', 'mon-2']});

	assert.deepEqual(run.partySpecs(state).map(m => m.level), [3, 40],
		'with no order asked about, the specs are the box as it stands');
	assert.deepEqual(run.partySpecs(state, {atOrder: 77}).map(m => m.level), [21, 40],
		'Poochyena rises to Brawly\'s cap; the overlevelled Marill keeps its 40');
	// Only the level moves: a projection is about the cap, not about the box.
	const projected = run.partySpecs(state, {atOrder: 77});
	assert.equal(projected[0].species, 'Poochyena');
	assert.deepEqual(projected[0].moves, run.findMon(state, 'mon-1').moves);
	assert.equal(state.box[0].level, 3, 'projection must not write back to the run');
	// A capless run projects nothing, whatever order it is asked about.
	const free = run.applyAll(fresh({levelCap: 'none'}), [
		{kind: 'catch', species: 'Poochyena', map: 'Route101', level: 3},
		{kind: 'party', ids: ['mon-1']},
	]);
	assert.deepEqual(run.partySpecs(free, {atOrder: 77}).map(m => m.level), [3]);
});

test('a catch can never create a Pokemon with no moves', () => {
	// Run & Bun's own data gives Skarmory an empty level-up learnset —
	// LEVEL_UP_MOVE(1, MOVE_NONE) in the decomp. Without this refusal the box
	// stores a movesless entry and the planner detonates on it later, far from
	// the command that caused it.
	assert.throws(
		() => run.apply(fresh(), {kind: 'catch', species: 'Skarmory', level: 28}),
		/Skarmory at level 28 has no level-up moves in this game — name its moves; it can be taught:/
	);
	const named = run.apply(fresh(),
		{kind: 'catch', species: 'Skarmory', level: 28, moves: ['Body Press', 'Smart Strike']});
	assert.deepEqual(named.box[0].moves, ['Body Press', 'Smart Strike']);
});

test('explicit catch moves are checked, not trusted', () => {
	// Without this, `catch` with a moves list is a bypass around everything
	// `teach` enforces.
	assert.throws(
		() => run.apply(fresh(), {kind: 'catch', species: 'Poochyena', map: 'Route101',
			level: 3, moves: ['Dragon Dance']}),
		/Poochyena cannot know Dragon Dance/
	);
});

test('a catch of more than four moves is refused, not quietly trimmed', () => {
	// The trim ran BEFORE the legality check, so a fifth move — the obvious place
	// to hide one the species cannot hold — was dropped without a word, which is
	// exactly the bypass around `teach` that checking explicit moves exists to
	// close. Four is the game's limit; which four is the player's call.
	assert.throws(
		() => run.apply(fresh(), {kind: 'catch', species: 'Poochyena', map: 'Route101',
			level: 3, moves: ['Tackle', 'Sand Attack', 'Bite', 'Crunch', 'Dragon Dance']}),
		/Poochyena knows four moves, not 5 \(.*Dragon Dance\) — name four/
	);
	// Legal or not, a fifth is still a fifth — the refusal is about the count.
	assert.throws(
		() => run.apply(fresh(), {kind: 'catch', species: 'Poochyena', map: 'Route101',
			level: 3, moves: ['Tackle', 'Sand Attack', 'Bite', 'Crunch', 'Howl']}),
		/knows four moves, not 5/
	);
	// And with the trim gone, every one of the four named is still checked.
	assert.throws(
		() => run.apply(fresh(), {kind: 'catch', species: 'Poochyena', map: 'Route101',
			level: 3, moves: ['Tackle', 'Sand Attack', 'Bite', 'Dragon Dance']}),
		/Poochyena cannot know Dragon Dance/
	);
	const four = run.apply(fresh(), {kind: 'catch', species: 'Poochyena', map: 'Route101',
		level: 3, moves: ['Tackle', 'Sand Attack', 'Bite', 'Crunch']});
	assert.deepEqual(four.box[0].moves, ['Tackle', 'Sand Attack', 'Bite', 'Crunch']);
});

test('a catch that names the wrong method is refused, not silently corrected', () => {
	// Marill comes out of Route 114 on the Super Rod and nowhere else on that map.
	// Picking another slot for a player who claimed `walk` would store 'fish' as
	// though they had said it — an assertion the oracle invented, which is the one
	// thing the origin record exists to rule out.
	assert.throws(
		() => run.apply(fresh(), {kind: 'catch', species: 'Marill', map: 'Route114',
			level: 40, method: 'walk'}),
		/Marill on Route114 at level 40 is not caught by walk; it is caught by: fish/
	);
	// The true claim still passes, and still carries the rod.
	const caught = run.apply(fresh(), MARILL);
	assert.equal(caught.box[0].origin.method, 'fish');
	assert.equal(caught.box[0].origin.rod, 'Super Rod');
	// Claiming nothing is not claiming wrongly: the slot still names the method.
	const unclaimed = run.apply(fresh(),
		{kind: 'catch', species: 'Marill', map: 'Route114', level: 40});
	assert.equal(unclaimed.box[0].origin.method, 'fish');
});

test('a declared rival collapses the variant fights to the ones this run can see', () => {
	// The three variants of each rival location are one story event with
	// identical ace levels; a run faces exactly one, fixed by its starter.
	const declared = fresh({rival: 'Swampert'});
	const spine = run.milestones(declared);
	assert.equal(spine.length, 38, '44 minus the six variants this run never sees');
	assert.deepEqual(
		spine.filter(m => /Rival/.test(m.trainer)).map(m => m.trainer),
		['Trainer Rival Cycling Road Swampert', 'Trainer Rival Bridge Swampert',
			'Trainer Rival Lilycove Swampert']
	);

	// A fight the run can never see cannot be beaten.
	assert.throws(
		() => run.apply(declared, {kind: 'beat', trainer: 'Trainer Rival Cycling Road Sceptile'}),
		/this run faces the Swampert rival; Trainer Rival Cycling Road Sceptile is a fight it can never see/
	);
	assert.ok(run.apply(declared, {kind: 'beat', trainer: 'Trainer Rival Cycling Road Swampert'}));

	// The cap is indifferent to the choice — dekzeh balanced the variants to the
	// same ace — but the fight that sets it is now the right one.
	const afterWattson = run.apply(fresh({rival: 'Blaziken', levelCap: 'next-milestone-ace'}),
		{kind: 'beat', trainer: 'Leader Wattson'});
	const cap = run.levelCap(afterWattson);
	assert.equal(cap.trainer, 'Trainer Rival Cycling Road Blaziken');
	assert.equal(cap.cap, 38);

	// Undeclared stays honest: everything visible, nothing refused.
	assert.equal(run.milestones(fresh()).length, 44);
	assert.ok(run.apply(fresh(), {kind: 'beat', trainer: 'Trainer Rival Cycling Road Sceptile'}));

	// Undo replays with the rule intact.
	const undone = run.undo(run.apply(declared, {kind: 'beat', trainer: 'Leader Brawly'}));
	assert.equal(undone.rules.rival, 'Swampert');

	assert.throws(() => run.createRun({rival: 'Pikachu'}), /unknown rival "Pikachu"/);
});

test('the box matrix compares the WHOLE box, at the cap the fight is fought under', () => {
	// The party is the answer this grid exists to produce, so it cannot also be
	// the input: a box of twenty against a boss of six is the question "which
	// six", and filtering to the party assumes it.
	let state = run.applyAll(fresh(), [
		{kind: 'catch', species: 'Lillipup', map: 'Route101', level: 3},
		{kind: 'catch', species: 'Poochyena', map: 'Route101', level: 3},
		{kind: 'party', ids: ['mon-1']},
	]);

	const matrix = run.boxMatrix(state);
	// With no trainer named it compares the fight actually next, which for a
	// fresh run is the run map's opening battle.
	assert.equal(matrix.trainer, 'Youngster Calvin');
	assert.equal(matrix.order, 0);
	assert.equal(matrix.grid.length, 3);

	// Every alive box entry gets a row, party or not.
	assert.deepEqual(matrix.box.map(entry => entry.id), ['mon-1', 'mon-2']);
	for (const cell of matrix.grid) assert.equal(cell.versus.length, 2);

	// Projection is the reason this lives at L6: a level 3 catch stands in front
	// of that grunt at 12, and a grid built from today's levels grades every row
	// against a box the player will never field.
	assert.deepEqual(matrix.projection, {applied: true, cap: 12, from: 'projected'});
	assert.deepEqual(matrix.grid[0].versus.map(row => row.level), [12, 12]);
	assert.deepEqual(matrix.box.map(entry => [entry.from, entry.level]), [[3, 12], [3, 12]]);
	// Asking a question does not move the run.
	assert.deepEqual(state.box.map(mon => mon.level), [3, 3]);

	// A named trainer projects to ITS cap, not the run's current one.
	const ahead = run.boxMatrix(state, 'Leader Brawly');
	assert.equal(ahead.order, 77);
	assert.deepEqual(ahead.projection, {applied: true, cap: 21, from: 'projected'});
	assert.deepEqual(ahead.grid[0].versus.map(row => row.level), [21, 21]);
	// The same projection `partySpecs` applies, because it IS `partySpecs`.
	assert.deepEqual(ahead.grid[0].versus.map(row => row.level),
		run.partySpecs(run.apply(state, {kind: 'party', ids: ['mon-1', 'mon-2']}),
			{atOrder: 77}).map(spec => spec.level));

	assert.throws(() => run.boxMatrix(state, 'Leader Brawley'), /no fight named/);
});

test('the box matrix leaves out Pokemon that are gone for good', () => {
	// A dead Pokemon under permadeath is not a choice, so a row for it can only
	// mislead — the grid answers "which six" and it is not eligible for any of
	// them.
	// Two routes, because a nuzlocke gets one catch per route.
	let state = run.applyAll(fresh({permadeath: true}), [
		{kind: 'catch', species: 'Lillipup', map: 'Route101', level: 3},
		MARILL,
		{kind: 'faint', id: 'mon-2'},
	]);
	const matrix = run.boxMatrix(state);
	assert.deepEqual(matrix.box.map(entry => entry.id), ['mon-1']);
	for (const cell of matrix.grid) assert.equal(cell.versus.length, 1);

	// Without permadeath a faint is not a loss, so the row stays.
	const survived = run.applyAll(fresh(), [
		{kind: 'catch', species: 'Lillipup', map: 'Route101', level: 3},
		{kind: 'faint', id: 'mon-1'},
	]);
	assert.equal(run.boxMatrix(survived).box.length, 1);

	// An empty box is refused with a reason rather than compared to nothing.
	assert.throws(() => run.boxMatrix(fresh()), /no Pokemon in the box to compare/);
});
