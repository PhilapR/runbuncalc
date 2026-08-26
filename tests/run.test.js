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

const run = require('../lib/run');

/**
 * Real coordinates from the game, used throughout.
 *
 * Marill is fished out of Route 114 with the Super Rod at level 40 — chosen
 * because it exercises method, rod and an exact level range at once, and because
 * getting it wrong (Route 102, Route 117) is what the refusal cases assert.
 */
const MARILL = {kind: 'catch', species: 'Marill', map: 'Route114', level: 40, method: 'fish'};
const TEST_IVS = {hp: 17, atk: 18, def: 19, spa: 20, spd: 21, spe: 22};
const PERFECT_IVS = {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31};

/** Complete owned-Pokemon fixture; supplied stats override the stable test roll. */
function owned(command) {
	return Object.assign({}, command, {
		ivs: Object.assign({}, TEST_IVS, command.ivs || {}),
	});
}

function fresh(options) {
	return run.createRun(Object.assign({name: 'Gate', now: 't0'}, options));
}

test('a new run is empty, positioned before the first fight, and serializable', () => {
	const state = fresh({attemptId: 'attempt-1'});
	assert.equal(state.version, run.VERSION);
	assert.equal(state.profileId, 'run-and-bun');
	assert.equal(state.attemptId, 'attempt-1');
	// -1 rather than 0: the first battle in the map IS index 0, so "nothing beaten
	// yet" needs a value below it.
	assert.equal(state.position, -1);
	assert.deepEqual(state.box, []);
	assert.deepEqual(state.party, []);
	assert.deepEqual(state.bag, {});
	assert.deepEqual(JSON.parse(JSON.stringify(state)), state, 'a run must survive JSON');
});

test('undo preserves the attempt identity used by historical archives', () => {
	const before = fresh({attemptId: 'attempt-undo'});
	const after = run.apply(before, MARILL);
	assert.equal(run.undo(after).attemptId, 'attempt-undo');
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
	const command = owned({kind: 'catch', species: 'Poochyena', map: 'Route101', level: 3,
		ivs: {hp: 31}});
	const recorded = Object.assign({}, TEST_IVS, {hp: 31});
	const state = run.apply(fresh(), command);
	command.ivs.hp = 0;

	assert.deepEqual(state.box[0].ivs, recorded, 'the run must not follow the caller');
	assert.deepEqual(state.log[0].command.ivs, recorded, 'the log must agree with the run');
	assert.deepEqual(run.partySpecs(run.apply(state, {kind: 'party', ids: ['mon-1']}))[0].ivs,
		recorded, 'and the planner must see what the box says');
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

test('observed nature, ability, and partial IVs are replayable run facts', () => {
	const caught = run.apply(fresh(), {
		kind: 'catch', species: 'Poochyena', map: 'Route101', level: 3,
		nature: 'Jolly', ability: 'Run Away', ivs: {atk: 27},
	});
	assert.equal(caught.box[0].nature, 'Jolly');
	assert.equal(caught.box[0].ability, 'Run Away');
	assert.deepEqual(caught.box[0].ivs, {atk: 27});

	const identified = run.apply(caught, {
		kind: 'identify', id: 'mon-1', ability: 'Quick Feet', ivs: {hp: 11, spe: 31},
	});
	assert.equal(identified.box[0].nature, 'Jolly', 'unsupplied facts stay recorded');
	assert.equal(identified.box[0].ability, 'Quick Feet');
	assert.deepEqual(identified.box[0].ivs, {atk: 27, hp: 11, spe: 31});
	assert.match(identified.log.at(-1).summary, /recorded Poochyena.*ability Quick Feet, 2 IVs/);
	assert.deepEqual(run.undo(identified), caught, 'observations must participate in undo and replay');
});

test('invalid observed facts are refused without mutating the run', () => {
	const caught = run.apply(fresh(), MARILL);
	const before = JSON.stringify(caught);
	assert.throws(() => run.apply(caught, {
		kind: 'identify', id: 'mon-1', ivs: {spe: 32},
	}), /Speed IV must be an integer from 0 to 31/);
	assert.throws(() => run.apply(caught, {
		kind: 'identify', id: 'mon-1', nature: 'Very Brave',
	}), /nature must be one of/);
	assert.throws(() => run.apply(caught, {
		kind: 'identify', id: 'mon-1', ivs: {speed: 20},
	}), /IV stat must be one of/);
	assert.equal(JSON.stringify(caught), before);
});

test('player IV rolls cover all six stats and preserve the edge values', () => {
	const values = [0, 1 / 32, 0.25, 0.5, 30 / 32, 31.999 / 32];
	let at = 0;
	assert.deepEqual(run.rollIvs(() => values[at++]), {
		hp: 0, atk: 1, def: 8, spa: 16, spd: 30, spe: 31,
	});
	assert.throws(() => run.rollIvs(() => 1), /IV roll must be in \[0, 1\)/);
});

test('owned-party planning refuses a legacy record with missing player IVs', () => {
	let state = run.apply(fresh(), MARILL);
	state = run.apply(state, {kind: 'party', ids: ['mon-1']});
	assert.throws(() => run.partySpecs(state),
		/missing player IVs: HP, Attack, Defense, Sp\. Atk, Sp\. Def, Speed.*trainer teams use 31.*wild Pokemon use their rolls/);
	state = run.apply(state, {kind: 'identify', id: 'mon-1',
		ivs: {hp: 1, atk: 2, def: 3, spa: 4, spd: 5, spe: 6}});
	assert.deepEqual(run.partySpecs(state)[0].ivs,
		{hp: 1, atk: 2, def: 3, spa: 4, spd: 5, spe: 6});
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

test('the ranker ranks the box the player will field, never the one they hold today', () => {
	// The non-negotiable from the co-design: a ranking at current levels ranks
	// a team that will never exist. Same box, caps on vs off, against Wattson
	// (fought under cap 35): the projections differ AND the ordering differs.
	const catches = [
		{kind: 'catch', species: 'Breloom', level: 24},
		{kind: 'catch', species: 'Kadabra', level: 24},
		{kind: 'catch', species: 'Marshtomp', level: 24},
		{kind: 'catch', species: 'Camerupt', level: 24},
		{kind: 'catch', species: 'Manectric', level: 24},
		{kind: 'catch', species: 'Swellow', level: 24, moves: ['Fly', 'Hurricane']},
		{kind: 'catch', species: 'Pelipper', level: 24, moves: ['Surf', 'Hurricane']},
	];
	const capped = run.rankParties(
		run.applyAll(fresh(), catches.map(owned)), 'Leader Wattson');
	const uncapped = run.rankParties(
		run.applyAll(fresh({levelCap: 'none'}), catches.map(owned)), 'Leader Wattson');
	assert.deepEqual(capped.projection, {applied: true, cap: 35, from: 'projected'});
	assert.deepEqual(uncapped.projection, {applied: false, cap: null, from: 'current'});
	assert.notDeepEqual(
		capped.parties.map(party => party.members.map(member => member.id)),
		uncapped.parties.map(party => party.members.map(member => member.id)),
		'projection must be able to change the ordering, not just the scores');

	// Deterministic: the same question twice is the same answer, byte for byte.
	assert.deepEqual(run.rankParties(run.applyAll(fresh(), catches.map(owned)), 'Leader Wattson'), capped);

	// The shortlist is exhaustive over C(7,6) = 7 sixes, top plus diversity.
	assert.equal(capped.combinations, 7);
	assert.equal(capped.parties[0].label, 'top');
	assert.ok(capped.parties[0].perEnemy.length >= 6, 'the assignment travels with the six');
	assert.ok(capped.caveats.some(text => /assumes you can always switch/.test(text)));
});

test('the ranker finishes a box of 30 in interactive time', () => {
	const catches = [];
	for (let i = 0; i < 30; i++) catches.push(owned(
		{kind: 'catch', species: 'Poochyena', level: 20}));
	const state = run.applyAll(fresh({levelCap: 'none'}), catches);
	const started = process.hrtime.bigint();
	// Measure the exhaustive C(30,6) ranker, not the seeded battle adjudication
	// that follows its shortlist. Rollout timing is covered by the driver gates
	// and is too sensitive to shared-runner load to be part of this 5s budget.
	const ranking = run.rankParties(state, 'Leader Brawly', {rollouts: 0});
	const ms = Number(process.hrtime.bigint() - started) / 1e6;
	assert.equal(ranking.combinations, 593775, 'C(30,6), exhaustively');
	assert.ok(ms < 5000, `ranking took ${ms.toFixed(0)}ms; the budget is 5s`);
});

test('the playbook says how many fights its assignment search played', () => {
	// The assignment search is the most expensive thing this library does —
	// profiled at 81% of a plan-then-rank-then-playbook sequence, because every
	// variant it explores is a PLAYED fight, not a table read. `explored` alone
	// reads as a count of cheap things, so the rollouts behind each one are
	// reported beside it.
	//
	// It is also the accurate half, and the budget was the one knob a caller
	// could not reach: `rollouts` sized the final line while the search stayed
	// pinned at four. Measured over eight real mid-run states, four and twelve
	// chose a different variant in half of them and twelve was never worse.
	let state = fresh({levelCap: 'none'});
	for (const species of ['Poochyena', 'Zigzagoon-Galar', 'Ralts', 'Surskit',
		'Shroomish', 'Makuhita']) {
		state = run.apply(state, owned({kind: 'catch', species, level: 24}));
	}
	state = run.apply(state, {kind: 'party', ids: state.box.map(mon => mon.id)});

	const standard = run.fightPlaybook(state, 'Youngster Calvin');
	assert.equal(standard.variantRollouts, 4,
		'four is what the tool has always paid and must stay the default');
	assert.ok(standard.explored > 0, 'the search must actually run');
	assert.ok(standard.explored <= 16,
		`explored ${standard.explored} variants; the power set is bounded at 2^4`);

	// The knob reaches the search rather than only the final line.
	const careful = run.fightPlaybook(state, 'Youngster Calvin', {variantRollouts: 8});
	assert.equal(careful.variantRollouts, 8);

	// And it can never ask for more per variant than the whole call allows,
	// which would price a search above the line it exists to choose.
	const clamped = run.fightPlaybook(state, 'Youngster Calvin',
		{rollouts: 3, variantRollouts: 12});
	assert.equal(clamped.variantRollouts, 3,
		'variantRollouts is capped by rollouts, not independent of it');

	// A search that did not run reports no per-variant cost, rather than a
	// budget it never spent.
	const off = run.fightPlaybook(state, 'Youngster Calvin', {optimize: false});
	assert.equal(off.explored, 0);
	assert.equal(off.variantRollouts, 0);
});

test('the cheap cut keeps the best six and only runs when the box is expensive', () => {
	// The box that made this necessary was 76 and took 177 SECONDS to enumerate
	// its 218,618,940 sixes. The cut keeps, per enemy column, the members that
	// could actually win it — a six is worth exactly what its column winners are
	// worth — and enumerates only those.
	//
	// What must survive the cut is the BEST SIX'S SCORE. What is allowed to move
	// is which of several equally-scoring sixes is named, because the tiebreak is
	// lexicographic over member index and the pool changed.
	function boxOf(levels, species) {
		let state = fresh({levelCap: 'none'});
		for (const level of levels) {
			for (const name of species) {
				state = run.apply(state, owned({kind: 'catch', species: name, level}));
			}
		}
		return state;
	}
	const species = ['Poochyena', 'Zigzagoon-Galar', 'Ralts', 'Surskit', 'Shroomish',
		'Makuhita', 'Numel', 'Trapinch', 'Aron', 'Electrike', 'Lotad', 'Seedot'];
	// Three levels of twelve species: 36 members, varied enough that the columns
	// disagree about who wins them. C(36,6) is 1,947,792, over the threshold.
	const big = boxOf([22, 30, 38], species);

	// Fights with very different shapes, so this is not one matchup's luck.
	for (const trainer of ['Leader Brawly', 'Leader Wattson', 'Leader Flannery']) {
		const cut = run.rankParties(big, trainer, {rollouts: 0});
		const full = run.rankParties(big, trainer,
			{rollouts: 0, exhaustive: true, maxCombinations: 1e9});
		assert.equal(cut.shortlist.cutting, true, `${trainer}: a box of 36 must cut`);
		assert.equal(full.combinations, 1947792, `${trainer}: C(36,6) exhaustively`);
		assert.ok(cut.combinations < full.combinations / 100,
			`${trainer}: the cut enumerated ${cut.combinations} of ${full.combinations}, ` +
			'which is not a cut worth making');
		assert.equal(cut.parties[0].score, full.parties[0].score,
			`${trainer}: the cut changed the best six's score, which is the one thing ` +
			'it may never do');
		// The cut is reported, never implied.
		assert.equal(cut.shortlist.candidates + cut.shortlist.cut, cut.boxSize);
		assert.equal(cut.shortlist.dropped.length, cut.shortlist.cut);
		assert.equal(full.shortlist.cutting, false);
		assert.equal(full.shortlist.candidates, full.boxSize,
			`${trainer}: exhaustive must enumerate the whole box`);
	}

	// Below the threshold the cut does not run at all, because a cheap box does
	// not need one and loses its diversity rows to it: C(7,6) cut to its column
	// winners is a single six, and "without the star" has nothing to differ with.
	const small = boxOf([24], species.slice(0, 7));
	const smallRank = run.rankParties(small, 'Leader Wattson', {rollouts: 0});
	assert.equal(smallRank.shortlist.cutting, false, 'a box of 7 must not be cut');
	assert.equal(smallRank.combinations, 7, 'C(7,6), whole');
	assert.equal(smallRank.shortlist.cut, 0);

	// And the runaway itself is gone. A box of 76 was the finding's case.
	let wide = fresh({levelCap: 'none'});
	for (let i = 0; i < 76; i++) {
		wide = run.apply(wide, owned({kind: 'catch', species: 'Poochyena', level: 30}));
	}
	const started = process.hrtime.bigint();
	const wideRank = run.rankParties(wide, 'Leader Brawly', {rollouts: 0});
	const ms = Number(process.hrtime.bigint() - started) / 1e6;
	assert.equal(wideRank.boxSize, 76);
	assert.ok(wideRank.combinations < 100000,
		`a box of 76 enumerated ${wideRank.combinations} sixes; the point of the cut ` +
		'is that 218,618,940 never happens again');
	assert.ok(ms < 5000, `a box of 76 took ${ms.toFixed(0)}ms; the budget is 5s`);
});

test('the ranker plays four different sixes, not four spellings of one', () => {
	// scoreSix is the best answer per enemy column, so swapping the member
	// that answers nothing changes no column and no score. The shortlist that
	// came out of it was systematically near-duplicates: measured across
	// twelve fights, the top four always shared five of six members and one
	// identical grid score, every adjudication returned the same pWin and
	// eDeaths, and playing them reordered the top six zero times. Thirty-six
	// of forty-eight rollouts were replaying the same team.
	const catches = [];
	for (const species of ['Poochyena', 'Zigzagoon-Galar', 'Ralts', 'Surskit', 'Shroomish',
		'Makuhita', 'Numel', 'Trapinch', 'Aron', 'Electrike', 'Lotad', 'Seedot']) {
		catches.push(owned({kind: 'catch', species, level: 5}));
	}
	let state = run.applyAll(fresh({levelCap: 'none'}), catches);
	for (const mon of state.box) {
		state = run.apply(state, {kind: 'levelUp', id: mon.id, to: 21});
	}
	const ranked = run.rankParties(state, 'Leader Brawly');
	const played = ranked.parties.filter(party => party.adjudication);
	assert.ok(played.length >= 1, 'something has to be played');

	// Every adjudicated six differs from every other by at least two members.
	// One-member neighbours are what the shortlist is full of, and playing one
	// is playing the other.
	for (let i = 0; i < played.length; i++) {
		for (let j = i + 1; j < played.length; j++) {
			const left = new Set(played[i].members.map(member => member.id));
			const shared = played[j].members.filter(member => left.has(member.id)).length;
			assert.ok(left.size - shared >= 2,
				`adjudicated sixes ${i} and ${j} share ${shared} of ${left.size} members; ` +
				'playing both spends rollouts to ask the same question twice');
		}
	}

	// And the played sixes lead the ranking, whatever grid position they came
	// from — the whole point is that what happened outranks what was predicted.
	for (let i = 0; i < played.length; i++) {
		assert.ok(ranked.parties[i].adjudication,
			'a played six must not sit behind an unplayed one');
	}
});

test('the ranker charges for its shortlist, not for the box', () => {
	// The gate above measures the ENUMERATION with rollouts:0. The number a
	// player feels is the other one: the seeded adjudication of the shortlist,
	// which is a flat cost paid on every press and was gated nowhere.
	// Measured — box 8 5488ms, box 12 5335ms, box 20 5769ms, box 30 6050ms —
	// so it does not scale with the box, and a small box does not buy a fast
	// answer. Pinning it stops that becoming true silently.
	function boxOf(size) {
		const catches = [];
		for (let i = 0; i < size; i++) {
			catches.push(owned({kind: 'catch', species: 'Poochyena', level: 20}));
		}
		return run.applyAll(fresh({levelCap: 'none'}), catches);
	}
	const small = boxOf(8);
	const large = boxOf(20);
	const time = state => {
		const at = process.hrtime.bigint();
		run.rankParties(state, 'Leader Brawly');
		return Number(process.hrtime.bigint() - at) / 1e6;
	};
	const smallMs = time(small);
	const largeMs = time(large);
	// Flat, not proportional: C(20,6) is 1,384 times C(8,6), so anything close
	// to proportional would be minutes. Asserted as ABSOLUTE headroom rather
	// than a multiple — the adjudication floor is seconds, which makes a ratio
	// insensitive enough to pass through a real regression. Measured
	// difference is ~280ms; three seconds is room for a shared runner and
	// still catches a cost that has started tracking the box.
	assert.ok(largeMs - smallMs < 3000,
		`box 20 took ${largeMs.toFixed(0)}ms against box 8's ${smallMs.toFixed(0)}ms, ` +
		`a gap of ${(largeMs - smallMs).toFixed(0)}ms; the shortlist adjudication ` +
		'must not scale with the box');
	// And the enumeration past the gated size is the OTHER cost: still cheap
	// at 30, which is what makes 76 a surprise rather than a warning.
	//
	// This was `bareMs < smallMs` — the box-30 enumeration against a box-8
	// ranking — and it stopped meaning what it says. Memoizing the engine's
	// action facts and effective types, and deferring the crit band, took an
	// adjudication down by about two and a half times, so `smallMs` fell to
	// 562ms while `bareMs` sat at 593ms and the assertion went red. Nothing
	// about the enumeration had changed. The comparison was only ever load
	// bearing while adjudication was seconds and this was milliseconds; with
	// both cheap it compares a thirty-member GRID against a rollout budget,
	// which is two unrelated costs.
	//
	// So it is an absolute budget now, which is what the claim was really
	// about: at 30 this is milliseconds, and the box of 76 that opened the
	// finding was 177 SECONDS. Three seconds is room for a shared runner and
	// still two orders of magnitude below a cost that has started tracking the
	// box.
	const at = process.hrtime.bigint();
	const ranked = run.rankParties(boxOf(30), 'Leader Brawly', {rollouts: 0});
	const bareMs = Number(process.hrtime.bigint() - at) / 1e6;
	assert.equal(ranked.combinations, 593775);
	assert.ok(bareMs < 3000,
		`enumerating C(30,6) took ${bareMs.toFixed(0)}ms; the budget is 3s, and a ` +
		'cost that has started tracking the box blows through it long before 76');
});

test('a named replace is honored below four moves too', () => {
	// Found live: a Skrelp with two moves taught 'Hydro Pump over Water Gun'
	// KEPT Water Gun — the replace was silently dropped because a free slot
	// existed, while the summary implied the swap happened. A named replace
	// means the old move goes, at any move count.
	let state = run.applyAll(fresh(), [
		{kind: 'catch', species: 'Skrelp', map: 'Route103', level: 2, method: 'fish'},
	]);
	assert.ok(state.box[0].moves.includes('Water Gun'));
	state = run.apply(state, {kind: 'teach', id: 'mon-1', move: 'Hydro Pump', replace: 'Water Gun'});
	assert.ok(!state.box[0].moves.includes('Water Gun'), 'the replaced move must be gone');
	assert.ok(state.box[0].moves.includes('Hydro Pump'));
	assert.match(state.log[state.log.length - 1].summary, /forgot Water Gun/);
	// And a replace naming a move it does not know is still refused.
	assert.throws(() => run.apply(state, {kind: 'teach', id: 'mon-1', move: 'Play Rough', replace: 'Tackle'}),
		/does not know Tackle/);
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
	// And what it CAN learn now is offered separately, so a UI need not guess —
	// egg-only entries carry their relearner price as `scale`, so the free
	// teach is the one to exercise here.
	const now = run.learnable(state, 'mon-1').now;
	assert.ok(now.length > 0);
	const free = now.find(entry => !entry.scale);
	assert.ok(free, 'a free teach exists alongside the priced egg moves');
	assert.ok(run.apply(state, {kind: 'teach', id: 'mon-1', move: free.move}));
});

test('the level caps are the game\'s own ladder, all twenty-three rows', () => {
	// Transcribed from docs/official/Mechanic Changes.txt ("Level Cap"): the
	// authored caps, NOT the next boss's ace — derivation was wrong on ten
	// rows (Flannery caps at 57 under an ace of 58; Museum at 17 over an ace
	// of 16; Fallarbor Vito's 48 exists with no badge; and no cap lifts at
	// Chelle's Mt Pyre fight or Maxie's Space Center raid).
	const DOC_LADDER = [
		[19, 12], [56, 17], [77, 21], [139, 25], [181, 32], [224, 35],
		[265, 38], [337, 42], [434, 48], [519, 54], [571, 57], [696, 65],
		[714, 66], [758, 69], [855, 73], [927, 76], [1009, 79], [1056, 81],
		[1130, 85], [1247, 89], [1364, 91], [1454, 95], [1620, 99],
	];
	const state = fresh({permadeath: true, rival: 'Swampert'});
	let previous = -1;
	for (const pair of DOC_LADDER) {
		// Every fight up to and including the row's boss plays under its cap...
		assert.equal(run.capAt(state, pair[0]), pair[1],
			`cap at #${pair[0]} must be ${pair[1]}`);
		assert.equal(run.capAt(state, previous + 1), pair[1],
			`cap at #${previous + 1} (segment start) must be ${pair[1]}`);
		previous = pair[0];
	}
	// ...and the reason line still names a real fight with its real ace.
	const capped = run.levelCap(state);
	assert.equal(capped.cap, 12);
	assert.equal(capped.trainer, 'Team Aqua Grunt Petalburg Woods');
	assert.equal(capped.ace, 'Croagunk');
	// The rival boundary holds for a declared rival: order 253 is the
	// Sceptile variant, invisible to a Swampert run, but the cap segment is
	// the triplet's — 38 through #265, 42 after.
	assert.equal(run.capAt(state, 253), 38);
	assert.equal(run.capAt(state, 266), 42);
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

	// The cap walks the Brawly split: 12 → 17 → 17 → 21, then the next badge —
	// and past Roxanne it is Chelle's 32, not Wattson's 35, because her
	// Daycare fight (#181) sits between the two badges. 17 is the AUTHORED
	// cap (the doc's number); the Museum aces are 16, which is exactly why
	// the ladder is transcribed rather than derived.
	const walk = [
		['Team Aqua Grunt Petalburg Woods', 17, 'story'],
		['Team Aqua Grunt Museum #1', 17, 'story'],
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

	// Most of a bag is not a held item, and `give` used to take any of it. The
	// refusal then arrived from the calculator, one layer down and one action
	// later, naming a battle slot rather than a box entry — so the run could
	// not plan or fight until somebody worked out who was holding what.
	for (const junk of ['Potion', 'Rare Candy', 'Heart Scale', 'Escape Rope']) {
		const stocked = run.apply(state, {kind: 'acquire', item: junk});
		assert.throws(
			() => run.apply(stocked, {kind: 'give', id: 'mon-1', item: junk}),
			new RegExp(junk + ' is not an item a Pokemon can hold'),
			`${junk} must be refused by give, not by the calculator later`);
		// A refusal leaves the bag exactly as it was.
		assert.equal(stocked.bag[junk], 1);
	}
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
		state = run.apply(state, owned(
			{kind: 'catch', species: 'Poochyena', map: 'Route101', level: 3}));
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
	const ids = routes.map(route => route.name);
	assert.equal(new Set(ids).size, ids.length, 'one row per location');

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

	// The regional-form ruling, pinned as convention: separate families where
	// the game keeps them separate (matching the dominant community tracker),
	// merged only where Run & Bun itself connects the lines (plain Grimer
	// evolves into Muk-Alola by Dusk Stone in this hack).
	const oracle2 = require('../profiles').getProfile('run-and-bun').oracle;
	assert.notEqual(oracle2.familyOf('Sandshrew'), oracle2.familyOf('Sandshrew-Alola'));
	assert.notEqual(oracle2.familyOf('Zigzagoon'), oracle2.familyOf('Zigzagoon-Galar'));
	assert.equal(oracle2.familyOf('Grimer'), oracle2.familyOf('Muk-Alola'));
	assert.equal(oracle2.familyOf('Basculin'), oracle2.familyOf('Basculin-Blue-Striped'));

	// Macro-defined growth rates import: Pikachu answers, like everything wild.
	const oracle = require('../profiles').getProfile('run-and-bun').oracle;
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
	assert.equal(all.order, 'opensAt-then-declaration');

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

test('route availability: imported unlock dates order the routes view', () => {
	const oracle = require('../profiles').getProfile('run-and-bun').oracle;

	// The starting routes are dated to the run's first fight.
	assert.equal(oracle.availabilityOf('Route101').opensAt, 0);

	// Petalburg Woods is the import's hardest case: rab's proxy dates it
	// post-Brawly because it labels the in-woods grunt "Route 104 (South)",
	// but this run map NAMES a fight after the woods at #19 — direct evidence
	// that outranks the proxy.
	const woods = oracle.availabilityOf('Petalburg Woods');
	assert.equal(woods.opensAt, 19);
	assert.equal(woods.method, 'our-fight');

	// A multi-floor complex expands to every floor: rab says "Victory Road",
	// all three of our wild tables inherit the date (post-Juan, #1364).
	assert.equal(oracle.availabilityOf('Victory Road B1f').opensAt, 1382);
	assert.equal(oracle.availabilityOf('Victory Road B2f').opensAt, 1382);

	// And the nuzlocke unit folds the floors into one location.
	assert.equal(oracle.areaOf('Victory Road B2f'), 'Victory Road');
	assert.equal(oracle.areaOf('Granite Cave Stevens Room'), 'Granite Cave');
	assert.equal(oracle.areaOf('Underwater Route124'), 'Route124');
	assert.equal(oracle.areaOf('Route101'), 'Route101');

	// A map NOTHING can date answers null — unknown, not closed. Artisan Cave
	// is the honest example: post-game content the R&B tracker never lists,
	// so neither the transcribed anchor nor the derived tracker order reaches
	// it. Altering Cave used to stand here and no longer can — it is dated
	// now, from the tracker.
	assert.equal(oracle.availabilityOf('Artisan Cave 1f'), null);
	assert.equal(oracle.availabilityOf('no such place'), null);
	// And a location the tracker DID place carries its provenance, so nobody
	// mistakes a derived date for the original transcription.
	assert.equal(oracle.availabilityOf('Altering Cave').provenance, 'derived');

	// The routes view: open means the run's NEXT fight is at-or-past the date,
	// so a fresh run sees Route 101 open and the woods still ahead.
	const state = fresh({permadeath: true});
	const routes = run.unusedRoutes(state).routes;
	const r101 = routes.find(route => route.name === 'Route101');
	assert.equal(r101.opensAt, 0);
	assert.equal(r101.open, true);
	const woodsRow = routes.find(route => route.name === 'Petalburg Woods');
	assert.equal(woodsRow.opensAt, 19);
	assert.equal(woodsRow.open, false);
	assert.equal(routes.find(route => route.name === 'Artisan Cave').opensAt, undefined);

	// Beating the run forward opens it: position 19 makes order 19 the last
	// one beaten, so a map dated to #19 is open.
	const advanced = run.apply(state, {kind: 'beat', trainer: 'Team Aqua Grunt Petalburg Woods'});
	assert.equal(run.unusedRoutes(advanced).routes
		.find(route => route.name === 'Petalburg Woods').open, true);

	// Ordering: every dated route precedes every undated one, dates ascending.
	// (Rows are LOCATIONS, so the 83 dated maps fold into fewer dated rows.)
	const dates = routes.filter(route => route.opensAt !== undefined).map(route => route.opensAt);
	assert.ok(dates.length >= 40, `expected the import to date most locations, got ${dates.length}`);
	assert.deepEqual(dates, [...dates].sort((a, b) => a - b));
	const firstUndated = routes.findIndex(route => route.opensAt === undefined);
	assert.ok(routes.slice(firstUndated).every(route => route.opensAt === undefined));
});

test('one encounter per LOCATION: a cave is one route, whatever its floors say', () => {
	// Granite Cave 1F is caught on; every other floor is the same encounter.
	const state = run.apply(fresh({permadeath: true}),
		{kind: 'catch', species: 'Phanpy', map: 'Granite Cave 1f', level: 8});
	assert.throws(
		() => run.apply(state, {kind: 'catch', species: 'Cufant', map: 'Granite Cave B1f', level: 8}),
		/already used its one Granite Cave encounter on Phanpy on Granite Cave 1f/);
	// A different LOCATION is a different encounter, business as usual.
	const two = run.apply(state,
		{kind: 'catch', species: 'Lillipup', map: 'Route101', level: 3});
	assert.equal(two.box.length, 2);

	// The routes view counts locations the same way: one Granite Cave row,
	// spent by that catch, its floors listed and its prospects tagged.
	const routes = run.unusedRoutes(state).routes;
	const cave = routes.filter(route => route.name === 'Granite Cave');
	assert.equal(cave.length, 1);
	assert.equal(cave[0].maps.length, 4);
	assert.equal(cave[0].used.species, 'Phanpy');
	assert.equal(cave[0].used.where, 'Granite Cave 1f');
	assert.ok(routes.every(route => route.name !== 'Granite Cave B1f'));

	// An extra method is not an extra catch: the underwater grass IS the route.
	assert.ok(routes.every(route => route.name !== 'Underwater Route124'));
	const r124 = routes.find(route => route.name === 'Route124');
	assert.equal(r124.maps.length, 2);

	// A save from before the unit existed keeps its per-table rule, because
	// undo replays the log and the log was legal when written.
	const legacy = fresh({permadeath: true});
	delete legacy.rules.routeUnit;
	const first = run.apply(legacy,
		{kind: 'catch', species: 'Phanpy', map: 'Granite Cave 1f', level: 8});
	const second = run.apply(first,
		{kind: 'catch', species: 'Cufant', map: 'Granite Cave B1f', level: 8});
	assert.equal(second.box.length, 2);
	assert.equal(run.encounterRules(second).routeUnit, 'map');

	// A stored unit nobody defined is refused, like every other rule field.
	const tampered = fresh({permadeath: true});
	tampered.rules.routeUnit = 'region';
	assert.throws(() => run.unusedRoutes(tampered), /unknown route unit "region"/);
});

test('the advisor never teaches suicide: self-KO moves price as trades', () => {
	// A lone Seedot vs Calvin: its learnset holds Misty Explosion and
	// Explosion, both guaranteed KOs on paper, both fatal to Seedot. The
	// optimizer used to lead with "Misty Explosion, +3 KO"; the board now
	// refuses to call a sacrifice an answer, so the whole family prices at
	// no gain and drops off the list — and the top teach is a real move.
	let state = run.apply(fresh({permadeath: true}),
		owned({kind: 'catch', species: 'Seedot', map: 'Route103', level: 2}));
	state = run.apply(state, {kind: 'party', ids: ['mon-1']});
	state = run.apply(state, {kind: 'levelUp', id: 'mon-1', to: 'cap'});
	const advice = run.adviseUpgrades(state, 'Youngster Calvin');
	assert.equal(advice.upgrades.length, 0,
		'a bare Seedot has no confirmed, currently obtainable improvement here');
	assert.ok(advice.availability.undatedMovesExcluded > 0,
		'legal but undated TM/tutor ideas are withheld instead of sold as current prep');
	assert.ok(advice.upgrades.every(u => !/Explosion|Self-Destruct|Final Gambit/.test(u.detail)),
		'no self-KO move may be sold as an upgrade');

	// Bullet Seed is Seedot's best answer here — and an EGG move, reachable
	// only through the relearner, which charges one Heart Scale. With an
	// empty bag it may not be offered; with a scale it returns, price named.
	assert.ok(advice.upgrades.every(u => !/Bullet Seed|Take Down/.test(u.detail)),
		'an egg move without a Heart Scale is not a change the player can make');
	const funded = run.apply(state, {kind: 'acquire', item: 'Heart Scale'});
	const paid = run.adviseUpgrades(funded, 'Youngster Calvin');
	assert.equal(paid.upgrades[0].detail, 'Bullet Seed (one Heart Scale)');
	// koGained is 0, not 1. Bullet Seed hits 2-5 times, and 35% of the time it
	// hits twice. A KO that needs three hits is not one the board may promise,
	// so the credit is damage, not a KO. This assertion read 1 while the
	// damage facts were built on the calculator's fixed pin of three hits —
	// it was pricing a KO the game misses better than a third of the time.
	assert.equal(paid.upgrades[0].delta.koGained, 0,
		'a 2-5 hit move never guarantees a KO on its floor of two hits');
	assert.ok(paid.upgrades[0].delta.damage > paid.upgrades[1].delta.damage * 2,
		'it still leads, and by a wide margin — on damage it can actually promise');

	// The teach command charges the same price: refused broke, paid funded,
	// and a move with any free route (Play Rough is also a TM) stays free.
	assert.throws(() => run.apply(state, {kind: 'teach', id: 'mon-1', move: 'Bullet Seed'}),
		/Bullet Seed is an egg move for Seedot — the relearner charges one Heart Scale/);
	const taught = run.apply(funded, {kind: 'teach', id: 'mon-1', move: 'Bullet Seed'});
	assert.ok(taught.log[taught.log.length - 1].summary.includes('for one Heart Scale'));
	assert.equal(taught.bag['Heart Scale'], undefined, 'the scale is spent');
	let pooch = run.apply(fresh({permadeath: true}),
		{kind: 'catch', species: 'Poochyena', map: 'Route101', level: 3});
	pooch = run.apply(pooch, {kind: 'teach', id: 'mon-1', move: 'Play Rough'});
	assert.ok(!pooch.log[pooch.log.length - 1].summary.includes('Heart Scale'));

	// And never an HM the story has not handed over: Lotad's Surf gates at
	// order 589, so an advisor at order 3 may not offer it. TMs carry no dates
	// in the source, so only the HM spine is gated.
	const oracle = require('../profiles').getProfile('run-and-bun').oracle;
	assert.equal(oracle.moveObtainableAt('Surf'), 589);
	assert.equal(oracle.moveObtainableAt('Rock Smash'), 139);
	assert.equal(oracle.moveObtainableAt('Tackle'), null);
	let wet = run.apply(fresh({permadeath: true}),
		owned({kind: 'catch', species: 'Lotad', map: 'Petalburg City', level: 5,
			method: 'fish'}));
	wet = run.apply(wet, {kind: 'party', ids: ['mon-1']});
	wet = run.apply(wet, {kind: 'levelUp', id: 'mon-1', to: 'cap'});
	const early = run.adviseUpgrades(wet, 'Bug Catcher Rick');
	assert.ok(early.upgrades.every(u => !/^Surf\b|\bSurf$/.test(u.detail) &&
		!/Waterfall|\bDive\b|\bFly\b|Strength/.test(u.detail)),
	'no undelivered HM may be offered as a teach');
});

test('a hold saves a location on purpose, and says when the wait pays off', () => {
	// The canonical case from the operator's own practice, in Philip's words:
	// "you could wait and save Littleroot Town for a surfing encounter much
	// later." Littleroot is reachable from the first fight and holds nothing
	// but water — the four starters on surf, a Super Rod table below them —
	// so it is walked past ON PURPOSE, and the tool records the purpose.
	//
	// This stood on Petalburg City until Philip corrected its date: Petalburg
	// is reachable only through Route 102, so it is no longer open at the
	// start and cannot demonstrate a hold there.
	let state = run.apply(fresh({permadeath: true}),
		{kind: 'hold', map: 'Littleroot Town', for: 'Squirtle'});
	assert.match(state.log[state.log.length - 1].summary, /held Littleroot Town for Squirtle/);

	// The routes view names the wait — and it is not ready at position -1.
	const route = run.unusedRoutes(state).routes.find(r => r.name === 'Littleroot Town');
	assert.deepEqual(route.held, {for: 'Squirtle', ready: false});

	// The scout stops nagging about it and says so.
	const scouted = run.adviseCatches(state);
	assert.equal(scouted.held, 1);
	assert.ok(scouted.catches.every(c => c.area !== 'Littleroot Town'));

	// Once the run passes the Surf gate, the hold reads READY.
	const late = JSON.parse(JSON.stringify(state));
	late.position = 600;
	const readyRoute = run.unusedRoutes(late).routes.find(r => r.name === 'Littleroot Town');
	assert.equal(readyRoute.held.ready, true);

	// Waiting for a ghost is refused with the roster; a held location cannot
	// be held twice; an unheld one cannot be released.
	assert.throws(() => run.apply(fresh({permadeath: true}),
		{kind: 'hold', map: 'Route101', for: 'Popplio'}),
	/Popplio does not appear anywhere on Route101/);
	assert.throws(() => run.apply(state, {kind: 'hold', map: 'Littleroot Town'}),
		/already held for Squirtle/);
	assert.throws(() => run.apply(state, {kind: 'unhold', map: 'Route101'}),
		/Route101 is not held/);

	// The hold covers the whole LOCATION under the area rule: holding Granite
	// Cave 1f holds the cave, so the B1f table reports it too.
	const cave = run.apply(fresh({permadeath: true}),
		{kind: 'hold', map: 'Granite Cave 1f', for: 'Amaura'});
	assert.ok(run.unusedRoutes(cave).routes.find(r => r.name === 'Granite Cave').held);

	// A catch that spends the held location resolves the hold, fulfilled or
	// not; a spent location cannot be held after the fact.
	const caught = run.apply(state,
		{kind: 'catch', species: 'Lotad', map: 'Littleroot Town', level: 3, method: 'fish'});
	assert.equal(Object.keys(caught.holds).length, 0, 'the catch resolves the hold');
	assert.throws(() => run.apply(caught, {kind: 'hold', map: 'Littleroot Town'}),
		/already gave its encounter \(Lotad\)/);

	// Release works and undo replays holds faithfully.
	const released = run.apply(state, {kind: 'unhold', map: 'Littleroot Town'});
	assert.equal(Object.keys(released.holds).length, 0);
	const undone = run.undo(released);
	assert.deepEqual(undone.holds, {'Littleroot Town': {for: 'Squirtle'}});
});

test('the advisor recommends field pickups, with where to go get them', () => {
	// A player who never records pickups has an empty bag, and the bag-only
	// advisor priced no items at all. The overworld hands out a Miracle Seed
	// on Route 104 (#11) — a Grass Treecko fighting a fisherman's water mons
	// at #22 should be told to go get it.
	let state = run.apply(fresh({permadeath: true}),
		owned({kind: 'catch', species: 'Treecko', level: 5}));
	state = run.apply(state, {kind: 'party', ids: ['mon-1']});
	state = run.apply(state, {kind: 'levelUp', id: 'mon-1', to: 'cap'});
	const advice = run.adviseUpgrades(state, 'Fisherman Elliot');
	const seed = advice.upgrades.find(u => u.kind === 'pickup' && /Miracle Seed/.test(u.detail));
	assert.ok(seed, 'the Miracle Seed pickup must be offered against water');
	assert.match(seed.detail, /Miracle Seed \(pickup @ Route 104\)/);
	assert.ok(seed.delta.damage > 0);

	// Not before the overworld has handed it out: order 0 predates every
	// type-boost pickup, so none may be offered there.
	const early = run.adviseUpgrades(state, 'Youngster Calvin');
	assert.ok(early.upgrades.every(u => !/Miracle Seed|Silk Scarf|Soft Sand/.test(u.detail)),
		'no pickup that the overworld has not handed out yet');

	// Once the bag records the pickup, the same item is a GIVE, not a trip.
	const bagged = run.apply(state, {kind: 'acquire', item: 'Miracle Seed'});
	const again = run.adviseUpgrades(bagged, 'Fisherman Elliot');
	assert.ok(again.upgrades.some(u => u.kind === 'give' && u.detail === 'Miracle Seed'));
	assert.ok(again.upgrades.every(u => !/pickup @ Route 104/.test(u.detail)));

	// The split sheet lists the same items as prep: names, places, and
	// whether the run can reach them yet.
	const prep = run.splitPrep(state);
	const sheet = prep.pickups.map(p => p.name);
	assert.ok(sheet.includes('Miracle Seed') && sheet.includes('Silk Scarf') &&
		sheet.includes('Soft Sand'), `Brawly-split pickups missing from ${sheet}`);
	const scarf = prep.pickups.find(p => p.name === 'Silk Scarf');
	assert.equal(scarf.location, 'Route 106');
	assert.equal(scarf.reachable, false, 'not reachable at position -1');
	// Collected items drop off the sheet.
	assert.ok(!run.splitPrep(bagged).pickups.some(p => p.name === 'Miracle Seed'));
});

test('the advisor can price a turn, not only a bar of HP', () => {
	// Lady Cindy is three Cute Charm users holding Oran Berries whose movepool
	// is Attract and Thunder Wave. The fight is not a damage race and never
	// was: measured over six scripted playthroughs we out-hit her side 43.8%
	// to 25.2% per hit and KO'd 96 to 46, and lost anyway, because 8.1% of our
	// turns went to status against 0.6% of theirs.
	//
	// The counter is a Cheri Berry, and the upgrade list could not show one.
	// Every candidate was scored through a damage matrix and then dropped
	// unless it gained a KO or added damage, so an item whose whole value is
	// a turn scored 0.00 and was deleted before the player saw it.
	let state = run.apply(fresh({permadeath: true}),
		owned({kind: 'catch', species: 'Lillipup', map: 'Route101', level: 3}));
	state = run.apply(state, {kind: 'party', ids: ['mon-1']});
	state = run.apply(state, {kind: 'levelUp', id: 'mon-1', to: 'cap'});
	const bare = run.adviseUpgrades(state, 'Lady Cindy');
	assert.ok(bare.upgrades.every(u => !/Cheri Berry/.test(u.detail)),
		'nothing to offer while the bag holds no cure');

	const cured = run.apply(state, {kind: 'acquire', item: 'Cheri Berry'});
	const advice = run.adviseUpgrades(cured, 'Lady Cindy');
	const cheri = advice.upgrades.find(u => u.detail === 'Cheri Berry');
	assert.ok(cheri, 'a Cheri Berry must be offered against a team built on Thunder Wave');
	assert.equal(cheri.delta.damage, 0, 'it adds no damage — that is the whole point');
	assert.equal(cheri.delta.koGained, 0);
	assert.equal(cheri.delta.statusAnswered, 2,
		'two of Cindy\'s three carry Thunder Wave, and the count is per Pokemon');

	// The count is what the fight actually threatens, not a property of the
	// item: the same berry against a fight with no paralysis answers nothing,
	// and so is not offered.
	const elsewhere = run.adviseUpgrades(cured, 'Youngster Calvin');
	assert.ok(elsewhere.upgrades.every(u => !/Cheri Berry/.test(u.detail)),
		'a cure for a status this fight cannot inflict is not an upgrade');

	// A cure for the wrong status is not an answer either, even against Cindy.
	const wrong = run.apply(state, {kind: 'acquire', item: 'Rawst Berry'});
	assert.ok(run.adviseUpgrades(wrong, 'Lady Cindy').upgrades
		.every(u => !/Rawst Berry/.test(u.detail)),
	'nothing on this team burns, so a burn cure answers nothing');

	// Lum covers paralysis among everything else, so it answers the same two.
	const lum = run.apply(state, {kind: 'acquire', item: 'Lum Berry'});
	const lumAdvice = run.adviseUpgrades(lum, 'Lady Cindy').upgrades
		.find(u => u.detail === 'Lum Berry');
	assert.ok(lumAdvice && lumAdvice.delta.statusAnswered >= 2);
});

test('the catch advisor scouts only what is really catchable, on the board', () => {
	// A fresh run: four routes open (opensAt 0), no party, next boss Brawly.
	const state = fresh({permadeath: true});
	const out = run.adviseCatches(state);
	assert.equal(out.trainer, 'Leader Brawly');
	assert.equal(out.cap, 21);
	assert.equal(out.partyCovers, 0);
	assert.equal(out.enemies, 6);

	// Petalburg City's surf slots are geography the run can reach but water it
	// cannot ride: Surf gates at #589, so they are counted out, not proposed.
	assert.ok(out.gated >= 1, 'surf prospects before Surf must be gated');
	assert.ok(out.catches.every(c => c.method !== 'surf'));
	// Fishing is open from the start — Run & Bun's one rod is given on Route 103.
	assert.ok(out.catches.some(c => c.method === 'fish'));

	// With no party, every KO is by definition a new answer, and the shortlist
	// is ordered by exactly that.
	assert.ok(out.catches.every(c => c.newAnswers === c.kos));
	const answers = out.catches.map(c => c.newAnswers);
	assert.deepEqual(answers, [...answers].sort((a, b) => b - a));

	// The routes view carries the same gate: an open route lists its surf slot
	// with the order the method starts working, so the forecast never promises
	// surfing before Surf exists.
	//
	// Littleroot Town, not Petalburg City. Petalburg used to sit at order 0
	// and no longer does — Philip's correction, since you reach it only
	// through Route 102 and its intro trainers. Littleroot is the better
	// example anyway: it is open from the first fight and has NOTHING but
	// surf and fish, so the method gate is the entire story there.
	const littleroot = run.unusedRoutes(state).routes.find(route => route.name === 'Littleroot Town');
	assert.ok(littleroot.open, 'the town the run starts in is reachable at once');
	assert.ok(littleroot.best.every(mon => mon.gated || mon.rod),
		'and everything in it waits on Surf or a Rod');
});

test('platform contract: rivals come from the profile, and layers fail by name', () => {
	// The rival list is the profile's; the engine only checks against it.
	assert.throws(() => fresh({rival: 'Meganium'}),
		/unknown rival "Meganium"; the rival is named for their ace: Sceptile, Blaziken, Swampert/);

	// A profile with no encounters layer has views, not errors: every fight
	// view answers empty, so summarize survives a data-only profile.
	assert.equal(run.fightTier({id: 'data-only'}, 'Leader Brawly'), null);

	// An operation that NEEDS a missing layer names it as a contract error,
	// never a TypeError three calls deep.
	const stub = fresh();
	assert.throws(() => {
		const orphan = JSON.parse(JSON.stringify(stub));
		orphan.profileId = 'run-and-bun';
		// Simulate the missing layer through the exported guard directly.
		run.requireLayer({id: 'data-only'}, 'oracle', 'a catch cannot be verified');
	}, /profile 'data-only' declares no oracle layer — a catch cannot be verified/);
});

test('every encounter rule is its own toggle, and old saves keep their bundle', () => {
	// 'species' scope: the exact species is a dupe, its evolution is not.
	const bySpecies = run.apply(fresh({onePerRoute: false, dupesClause: 'species'}),
		{kind: 'catch', species: 'Buizel', map: 'Route104', level: 5, method: 'fish'});
	assert.throws(() => run.apply(bySpecies,
		{kind: 'catch', species: 'Buizel', map: 'Route104', level: 5, method: 'fish'}),
	/dupe of Buizel .*"species"/);
	const evolved = run.apply(bySpecies, {kind: 'catch', species: 'Floatzel', map: 'Route102', level: 50});
	assert.equal(evolved.box.length, 2);

	// 'forms' scope: a regional branch of a caught line is a dupe even though
	// the game never connects the two Geodude lines — under 'line' (the
	// default) the same second catch is legal, which is the toggle's point.
	// Both Geodude lines have EMPTY level-up learnsets in this hack, so the
	// catches name their moves, as the engine requires.
	const geodude = {kind: 'catch', species: 'Geodude', map: 'Magma Hideout 3f 2r', level: 27,
		moves: ['Rock Blast']};
	const alolan = {kind: 'catch', species: 'Geodude-Alola', map: 'Route111', level: 20,
		method: 'rock-smash', moves: ['Rock Blast']};
	const byForms = run.apply(fresh({dupesClause: 'forms', permadeath: true}), geodude);
	assert.throws(() => run.apply(byForms, alolan), /dupe of Geodude/);
	const byLine = run.apply(run.apply(fresh({dupesClause: 'line', permadeath: true}), geodude), alolan);
	assert.equal(byLine.box.length, 2);

	// 'forms' is a strict SUPERSET of 'line': the closure reaches a species
	// whose base form is itself but whose line a regional pre-evolution ties
	// to the base line — Obstagoon through Zigzagoon-Galar's base Zigzagoon.
	// Collapsing each species to its own base form missed this and let the
	// strictest mode accept a catch the default refuses.
	const galar = run.apply(fresh({dupesClause: 'forms', permadeath: true}),
		{kind: 'catch', species: 'Zigzagoon-Galar', map: 'Route101', level: 3});
	assert.throws(() => run.apply(galar,
		{kind: 'catch', species: 'Obstagoon', map: 'Mt Pyre 5f', level: 58}),
	/dupe of Zigzagoon-Galar/);

	// A shiny does not CONSUME the route either: caught first under the shiny
	// clause, the route's real random encounter is still owed.
	const shinyFirst = run.apply(fresh({permadeath: true}),
		{kind: 'catch', species: 'Poochyena', map: 'Route101', level: 3, shiny: true});
	assert.equal(run.encountersOn(shinyFirst, 'Route101').used, undefined);
	const thenReal = run.apply(shinyFirst,
		{kind: 'catch', species: 'Lillipup', map: 'Route101', level: 3});
	assert.equal(thenReal.box.length, 2);
	assert.deepEqual(run.encountersOn(thenReal, 'Route101').used,
		{species: 'Lillipup', level: 3});

	// A stored mode nobody defined is refused when read, not played as 'line'.
	const tampered = fresh({permadeath: true});
	tampered.rules.dupesClause = 'strict';
	assert.throws(() => run.encountersOn(tampered, 'Route101'),
		/unknown dupes clause "strict" stored/);

	// Route rule alone: a dupe is fine, a second catch on the same map is not.
	const routeOnly = run.apply(fresh({onePerRoute: true, dupesClause: 'off'}),
		{kind: 'catch', species: 'Buizel', map: 'Route104', level: 5, method: 'fish'});
	assert.throws(() => run.apply(routeOnly, {kind: 'catch', species: 'Paras', map: 'Route104', level: 5}),
		/already used its one Route104 encounter/);
	const dupeFine = run.apply(routeOnly, {kind: 'catch', species: 'Floatzel', map: 'Route102', level: 50});
	assert.equal(dupeFine.box.length, 2);

	// Shiny clause off: the claim is recorded but exempts nothing.
	const noShiny = run.apply(fresh({permadeath: true, shinyClause: false}),
		{kind: 'catch', species: 'Poochyena', map: 'Route101', level: 3});
	assert.throws(() => run.apply(noShiny,
		{kind: 'catch', species: 'Poochyena', map: 'Route101', level: 2, shiny: true}),
	/already used its one Route101 encounter/);

	// A save from before the toggles existed carries only `permadeath: true`
	// and keeps the whole bundle it was played under.
	const legacy = run.apply(fresh({permadeath: true}),
		{kind: 'catch', species: 'Buizel', map: 'Route104', level: 5, method: 'fish'});
	delete legacy.rules.onePerRoute;
	delete legacy.rules.dupesClause;
	delete legacy.rules.shinyClause;
	delete legacy.rules.routeUnit;
	assert.deepEqual(run.encounterRules(legacy),
		{onePerRoute: true, routeUnit: 'map', dupes: 'line', shiny: true});
	assert.throws(() => run.apply(legacy, {kind: 'catch', species: 'Floatzel', map: 'Route102', level: 50}),
		/dupe of Buizel/);
	// And undo hands back the legacy rules verbatim, not an upgraded shape.
	assert.deepEqual(Object.keys(run.undo(legacy).rules).sort(), Object.keys(legacy.rules).sort());

	// A mode nobody defined is refused at creation, with the list.
	assert.throws(() => fresh({dupesClause: 'strict'}), /unknown dupes clause "strict"/);
});

test('the shiny clause: a natural shiny is keepable over the route rule and the dupes clause', () => {
	let state = run.apply(fresh({permadeath: true}),
		{kind: 'catch', species: 'Poochyena', map: 'Route101', level: 3});

	// Both rules would refuse this catch; the shiny claim exempts it, and the
	// claim is recorded on the mon rather than vanishing into the exemption.
	state = run.apply(state,
		{kind: 'catch', species: 'Poochyena', map: 'Route101', level: 2, shiny: true});
	assert.equal(state.box.length, 2);
	assert.equal(run.findMon(state, 'mon-2').shiny, true);
	assert.equal(run.findMon(state, 'mon-1').shiny, undefined);

	// The exemption is per-claim, not a switch: the next plain catch still
	// answers to both rules.
	assert.throws(() => run.apply(state, {kind: 'catch', species: 'Lillipup', map: 'Route101', level: 3}),
		/already used its one Route101 encounter/);

	// And the round trip holds: a shiny in the log replays byte-identically.
	const replayed = run.undo(run.apply(state, {kind: 'nickname', id: 'mon-2', nickname: 'Star'}));
	assert.deepEqual(replayed, state);
});

test('the split sheet is the gauntlet with its caps, and it moves with the run', () => {
	const state = fresh({rival: 'Swampert'});
	const prep = run.splitPrep(state);
	assert.equal(prep.split.boss, 'Leader Brawly');
	assert.equal(prep.split.index, 1);
	// The gauntlet is every remaining boss-tier fight in the split, boss last,
	// each under the cap in force when it is fought — the Museum pair shares
	// the authored 17.
	assert.deepEqual(prep.gauntlet.map(f => [f.trainer, f.tier, f.cap]), [
		['Team Aqua Grunt Petalburg Woods', 'story', 12],
		['Team Aqua Grunt Museum #1', 'story', 17],
		['Team Aqua Grunt Museum #2', 'story', 17],
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

test('position fast-forwards; a declared skip is the one way back', () => {
	let state = run.apply(fresh(), {kind: 'beat', trainer: 'Youngster Calvin'});
	assert.equal(state.position, 0);
	assert.equal(run.upcoming(state, 1)[0].trainer, 'Bug Catcher Rick');
	// Beating ahead is the fast-forward: the road behind fell on the way,
	// and walking it back is refused — that is how a run is recorded.
	state = run.apply(state, {kind: 'beat', trainer: 'Youngster Allen'});
	assert.throws(() => run.apply(state, {kind: 'beat', trainer: 'Bug Catcher Rick'}),
		/already behind the run/);

	// Most fights are REQUIRED — the road goes through them. Skipping one is
	// a recording error, refused with the profile's own list of exceptions.
	assert.throws(() => run.apply(state, {kind: 'skip', trainer: 'Bug Catcher Rick'}),
		/skip: Bug Catcher Rick is a required fight — the road goes through them\. Only these can be walked past: Camper Gavi, Triathlete Pablo/);
	assert.throws(() => run.apply(state, {kind: 'beat', trainer: 'Nobody At All'}),
		/no fight named/);
});

test('a skipped guard keeps his route closed until he actually falls', () => {
	let state = run.apply(fresh({onePerRoute: true}),
		{kind: 'skip', trainer: 'Camper Gavi', for: 'a box that can afford him'});
	assert.match(state.log[state.log.length - 1].summary,
		/skipping Camper Gavi \(#48\) — waiting for a box that can afford him/);
	// Never twice, and the skipped fight leads the road once passed.
	assert.throws(() => run.apply(state, {kind: 'skip', trainer: 'Camper Gavi'}),
		/already being skipped/);
	state = run.apply(state, {kind: 'beat', trainer: 'Team Aqua Grunt Museum #2'});
	assert.deepEqual(state.skipped, [48]);
	assert.equal(run.upcoming(state, 1)[0].trainer, 'Camper Gavi');
	// Passed, not beaten: the electric grass he guards stays shut.
	assert.throws(() => run.rollEncounter(state, {map: 'Route110'}),
		/Route110 is not reachable yet — Camper Gavi \(#48\) guards it/);
	// While he stands the debt is VISIBLE: mandatory-but-delayed is owed.
	assert.deepEqual(run.summarize(state).owed, [{trainer: 'Camper Gavi', order: 48}]);
	// An OPTIONAL skip is different: never owed, and simply not the road.
	state = run.apply(state, {kind: 'skip', trainer: 'Triathlete Pablo'});
	assert.deepEqual(run.summarize(state).owed, [{trainer: 'Camper Gavi', order: 48}],
		'an optional skip is not a debt');
	assert.ok(!run.upcoming(state, 500).some(fight => fight.trainer === 'Triathlete Pablo'),
		'a skipped optional fight leaves the road entirely');
	// Beat him late and the route opens, position unmoved, the debt settled.
	state = run.apply(state, {kind: 'beat', trainer: 'Camper Gavi'});
	assert.equal(state.position, 56);
	assert.deepEqual(run.summarize(state).owed, []);
	const rolled = run.rollEncounter(state, {map: 'Route110', random: () => 0.01});
	assert.ok(rolled.species, 'the guarded route rolls once the guard falls');
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
	let state = run.apply(fresh(), owned(MARILL));
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
	let state = run.apply(fresh(), owned(
		{kind: 'catch', species: 'Poochyena', map: 'Route101', level: 3}));
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
	let over = run.apply(fresh(), owned(MARILL));
	over = run.apply(over, {kind: 'party', ids: ['mon-1']});
	const current = run.planNext(over, {trainer: 'Leader Brawly'});
	assert.deepEqual(current.projection, {applied: true, cap: 21, from: 'current'});
	assert.equal(current.state.sides.player.party[0].level, 40);

	// A run that declines caps has nothing to project to, and claims nothing.
	const free = run.applyAll(fresh({levelCap: 'none'}), [
		owned({kind: 'catch', species: 'Poochyena', map: 'Route101', level: 3}),
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
		/unknown command "yeet"; known: .*catch.*levelUp.*evolve/);
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
	const profile = require('../profiles').getProfile();
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
	// Woods grunt (#19) and the Museum grunts (#53), so 17.
	assert.equal(run.capAt(state, 20), 17);
	assert.equal(run.capAt(state, 53), 17, "the Museum grunt's own order");
	// The start of the run, before any fight, is the first story boss' 12 — the
	// same answer `levelCap` gives a fresh run, from the other direction.
	assert.equal(run.capAt(state, -1), 12);
	assert.equal(run.capAt(state, 0), 12);
	assert.equal(run.capAt(state, 19), 12);
	assert.equal(run.levelCap(state).cap, run.capAt(state, state.position + 1));

	// Nothing boss-tier past the Champion, so nothing sets a cap there.
	assert.equal(run.capAt(state, 1620), 99, 'the Champion fight plays under the authored 99');
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
	let state = run.apply(fresh(), owned(
		{kind: 'catch', species: 'Poochyena', map: 'Route101', level: 3}));
	state = run.apply(state, owned(MARILL));
	state = run.apply(state, {kind: 'party', ids: ['mon-1', 'mon-2']});

	assert.deepEqual(run.partySpecs(state).map(m => m.level), [3, 40],
		'with no order asked about, the specs are the box as it stands');
	assert.deepEqual(run.partySpecs(state, {atOrder: 77}).map(m => m.level), [21, 40],
		'Poochyena rises to Brawly\'s cap; the overlevelled Marill keeps its 40');
	// The MOVESET rises with the level. This asserted that only the level
	// moved and the moves came through untouched, which is how a Chimchar
	// planned at L12 kept its level-5 moveset and never learned Mach Punch —
	// every matchup computed against a team the player would not field.
	const projected = run.partySpecs(state, {atOrder: 77});
	assert.equal(projected[0].species, 'Poochyena');
	const boxMoves = run.findMon(state, 'mon-1').moves;
	assert.notDeepEqual(projected[0].moves, boxMoves,
		'a Pokemon projected from L3 to L21 has learned things on the way');
	for (const move of boxMoves) {
		assert.ok(projected[0].moves.includes(move),
			`projection adds, never drops: ${move} was known at L3`);
	}
	assert.equal(new Set(projected[0].moves).size, projected[0].moves.length,
		'and never repeats a move — a learnset can list one at two levels');
	assert.ok(projected[0].moves.length <= 4, 'four slots, always');
	assert.equal(state.box[0].level, 3, 'projection must not write back to the run');
	assert.deepEqual(run.findMon(state, 'mon-1').moves, boxMoves,
		'nor write the learned moves back into the box');
	// A capless run projects nothing, whatever order it is asked about.
	const free = run.applyAll(fresh({levelCap: 'none'}), [
		owned({kind: 'catch', species: 'Poochyena', map: 'Route101', level: 3}),
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
		owned({kind: 'catch', species: 'Lillipup', map: 'Route101', level: 3}),
		owned({kind: 'catch', species: 'Poochyena', map: 'Route101', level: 3}),
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
		owned({kind: 'catch', species: 'Lillipup', map: 'Route101', level: 3}),
		owned(MARILL),
		{kind: 'faint', id: 'mon-2'},
	]);
	const matrix = run.boxMatrix(state);
	assert.deepEqual(matrix.box.map(entry => entry.id), ['mon-1']);
	for (const cell of matrix.grid) assert.equal(cell.versus.length, 1);

	// Without permadeath a faint is not a loss, so the row stays.
	const survived = run.applyAll(fresh(), [
		owned({kind: 'catch', species: 'Lillipup', map: 'Route101', level: 3}),
		{kind: 'faint', id: 'mon-1'},
	]);
	assert.equal(run.boxMatrix(survived).box.length, 1);

	// An empty box is refused with a reason rather than compared to nothing.
	assert.throws(() => run.boxMatrix(fresh()), /no Pokemon in the box to compare/);
});

test('a Heart Scale sets one IV to 31, out of a bag that has one', () => {
	// The game's other economy. Rare Candy buys levels over the cap; a Heart
	// Scale buys one perfect stat, from a supply the map hands out and no Mart
	// stocks — so it is spent, not assumed.
	let state = run.apply(fresh(),
		{kind: 'catch', species: 'Poochyena', map: 'Route101', level: 3, ivs: {spe: 5, atk: 31}});
	assert.throws(() => run.apply(state, {kind: 'heartScale', id: 'mon-1', stat: 'spe'}),
		/no shop sells them — need 1, the bag has 0/);

	state = run.apply(state, {kind: 'acquire', item: 'Heart Scale', count: 2});
	// A perfect IV is refused BEFORE the bag is touched, and names the value:
	// spending a scarce item on nothing is the mistake worth refusing.
	assert.throws(() => run.apply(state, {kind: 'heartScale', id: 'mon-1', stat: 'atk'}),
		/already has a 31 Attack IV; a Heart Scale would buy nothing/);
	assert.deepEqual(state.bag, {'Heart Scale': 2}, 'a refusal must not spend');
	// The stat is an `ivs` key, because that is what the box stores and what the
	// calculator reads; a display name is not one.
	assert.throws(() => run.apply(state, {kind: 'heartScale', id: 'mon-1', stat: 'speed'}),
		/stat must be one of hp, atk, def, spa, spd, spe; got "speed"/);

	const spent = run.apply(state, {kind: 'heartScale', id: 'mon-1', stat: 'spe'});
	assert.equal(spent.box[0].ivs.spe, 31);
	assert.deepEqual(spent.bag, {'Heart Scale': 1}, 'one scale spent, one left');
	assert.equal(spent.log[spent.log.length - 1].summary,
		'Poochyena Speed IV 5 → 31 (Heart Scale spent, 1 left)');
	// The last scale leaves the bag rather than sitting there as a zero.
	assert.deepEqual(run.apply(spent, {kind: 'heartScale', id: 'mon-1', stat: 'spa'}).bag, {});

	// An IV the box never recorded already reaches the calculator as 31, so
	// scaling it records a fact rather than buying a stat. Allowed, and said.
	assert.match(run.apply(state, {kind: 'heartScale', id: 'mon-1', stat: 'def'})
		.log.slice(-1)[0].summary, /Defense IV unrecorded → 31/);

	// Undo is the log replayed without its last entry, so a command that spends
	// from the bag has to come back byte-identical or the economy drifts.
	assert.equal(JSON.stringify(run.undo(spent)), JSON.stringify(state));
	assert.deepEqual(JSON.parse(JSON.stringify(spent)), spent, 'a run must survive JSON');
});

test('the advisor prices single changes by what they do to the board', () => {
	const state = run.applyAll(fresh(), [
		owned({kind: 'catch', species: 'Poochyena', map: 'Route101', level: 3,
			ivs: Object.assign({}, PERFECT_IVS, {spe: 5})}),
		{kind: 'party', ids: ['mon-1']},
		{kind: 'acquire', item: 'Heart Scale'},
		{kind: 'acquire', item: 'Rare Candy', count: 3},
		{kind: 'acquire', item: 'Choice Band'},
	]);
	const before = JSON.stringify(state);
	const advice = run.adviseUpgrades(state);
	assert.equal(JSON.stringify(state), before, 'asking a question must not move the run');
	assert.equal(advice.trainer, 'Youngster Calvin');
	assert.equal(advice.order, 0);
	// The board's projection, because it is the board's numbers: a level 3 catch
	// stands in front of that grunt at 12.
	assert.deepEqual(advice.projection, {applied: true, cap: 12, from: 'projected'});
	assert.deepEqual(advice.party, [{id: 'mon-1', species: 'Poochyena', nickname: null,
		level: 12, from: 3}]);

	// The candidate set is every move with a confirmed route NOW, every HOLDABLE bag item,
	// and one scale per recorded sub-31 IV. Rare Candy and the Heart Scale are
	// both in the bag and in neither list: the calculator cannot hold them, so a
	// build made of them is not a build.
	// Derived at the PROJECTED cap, because that is where the advisor draws
	// candidates: the free candy guarantees the levels between — minus any HM
	// the story has not handed over by this fight, which the advisor may not
	// offer (learnable itself stays a capability list).
	const oracle = require('../profiles').getProfile('run-and-bun').oracle;
	// A move the projected Pokemon ALREADY KNOWS is not a candidate. Levelling
	// teaches now, so by the cap Poochyena has picked several of these up on
	// its own, and offering to teach one would be advice to spend a slot on
	// something the cap hands over for free.
	const alreadyKnown = new Set(run.partySpecs(state, {atOrder: 0})[0].moves);
	const teachable = run.learnable(state, 'mon-1', {atLevel: 12}).now
		.filter(entry => {
			if (alreadyKnown.has(entry.move)) return false;
			const gate = oracle.moveObtainableAt(entry.move);
			const level = entry.sources.some(source =>
				source.level !== undefined && source.level <= 12);
			const egg = entry.sources.some(source => /^egg(?:\s|$|\()/.test(source.source));
			const datedTeach = entry.sources.some(source => source.source === 'teachable') &&
				gate !== null && gate <= 0;
			return level || datedTeach || egg;
		}).length;
	// ...plus every holdable field pickup the overworld has handed out by
	// order 0 that the run has not collected (the advisor's fourth kind).
	const pickups = oracle.itemsObtainableBy(0)
		.filter(p => require('../lib/planner').holdableItem(p.name)).length;
	assert.equal(advice.considered, teachable + 1 + 1 + pickups);

	// The deterministic case. This read "Poochyena knows only Tackle", which
	// stopped being true when levelling started teaching: by the cap it has
	// Tackle, Sand Attack, Odor Sleuth and Bite. With a real attacking move
	// already in hand, the Choice Band flips TWO cells where the paid Play
	// Rough flips one, so the ranking changed — and it changed for a reason
	// the old model could not see.
	const top = advice.upgrades[0];
	assert.deepEqual({kind: top.kind, id: top.id, detail: top.detail},
		{kind: 'give', id: 'mon-1', detail: 'Choice Band'});
	assert.equal(top.delta.koGained, 2);
	assert.equal(top.delta.koConceded, 0);
	assert.ok(top.delta.damage > 0, 'a flipped cell also moves the damage');

	// The priced teach is still offered and still names its price — it just
	// is not the best change any more.
	const priced = advice.upgrades.find(upgrade => /^Play Rough/.test(upgrade.detail));
	assert.ok(priced, 'the relearner route is still weighed');
	assert.match(priced.detail, /\(one Heart Scale\)$/, 'and still names what it costs');
	assert.equal(priced.delta.koGained, 1);

	// And the claim is the BOARD's claim, cell for cell — the advisor scores by
	// rebuilding the row through the planner, so an upgrade can never disagree
	// with the grid a player reads next to it.
	const planner = require('../lib/planner');
	const specs = run.partySpecs(state, {atOrder: 0});
	const ko = payload => payload.grid.filter(cell => cell.versus[0].us.guaranteedKO).length;
	assert.equal(ko(planner.matchup({trainer: 'Youngster Calvin', playerParty: specs,
		profileId: state.profileId})), 0);
	assert.equal(ko(planner.matchup({trainer: 'Youngster Calvin', profileId: state.profileId,
		playerParty: [Object.assign({}, specs[0],
			{moves: specs[0].moves.concat(['Play Rough'])})]})), 1);

	// Best first, capped at ten, and nothing in it that changes nothing: a
	// shortlist padded with moves worth zero has told the player nothing.
	assert.ok(advice.upgrades.length <= 10);
	const net = advice.upgrades.map(e => e.delta.koGained - e.delta.koConceded);
	assert.deepEqual(net.slice().sort((a, b) => b - a), net);
	for (const entry of advice.upgrades) {
		assert.ok(net[advice.upgrades.indexOf(entry)] > 0 || entry.delta.damage > 0,
			`${entry.detail} improves nothing and should not be listed`);
	}
	// Deterministic: the same run must produce the same shortlist twice.
	assert.deepEqual(run.adviseUpgrades(state).upgrades, advice.upgrades);
});

test('the advisor draws teach candidates at the projected cap, not today\'s level', () => {
	// A level 3 Poochyena stands in front of the first grunt at 12, and the free
	// candy guarantees the levels between — so Bite (level 10) is a candidate
	// even though the box holds a level 3. Gating on today's level hid every
	// level-up move between here and the cap while scoring the board at the cap.
	const state = run.applyAll(fresh(), [
		owned({kind: 'catch', species: 'Poochyena', map: 'Route101', level: 3}),
		{kind: 'party', ids: ['mon-1']},
	]);
	assert.ok(run.learnable(state, 'mon-1', {atLevel: 12}).now.some(e => e.move === 'Bite'));
	assert.ok(!run.learnable(state, 'mon-1').now.some(e => e.move === 'Bite'),
		'without atLevel the line stays at the box level — other callers keep their meaning');

	// Bite is no longer a TEACH candidate, and that is the point: Poochyena
	// learns it by level 12 on its own, so proposing it would be advice to
	// spend a move slot on something the cap hands over for free. This test
	// asserted the opposite until levelling started teaching.
	const details = run.adviseUpgrades(state).upgrades
		.filter(u => u.kind === 'teach').map(u => u.detail);
	assert.ok(!details.some(d => /^Bite/.test(d)),
		`Bite is learned by L12, so it must not be offered as a teach: ${details.join(', ')}`);
	// The projection genuinely knows it at the cap, which is why it drops out.
	assert.ok(run.partySpecs(state, {atOrder: 0})[0].moves.includes('Bite'),
		'because the projected Poochyena already has Bite');
});

test('the advisor only offers a Heart Scale it can pay for and price', () => {
	const box = owned({kind: 'catch', species: 'Poochyena', map: 'Route101', level: 3,
		ivs: Object.assign({}, PERFECT_IVS, {spe: 5})});
	const oracle = require('../profiles').getProfile('run-and-bun').oracle;
	// Same derivation the advisor uses: the capability list minus HMs the
	// story has not handed over by order 0, minus egg moves when no Heart
	// Scale is in the bag to pay the relearner with.
	// ...and minus anything the projected Pokemon has already LEARNED. Levelling
	// teaches now, so by the cap several of these are in hand and offering to
	// teach one would be advice to pay for something the cap gives free.
	const teachableAt = (state, hasScale) => {
		const known = new Set(run.partySpecs(state, {atOrder: 0})[0].moves);
		return run.learnable(state, 'mon-1', {atLevel: 12}).now
			.filter(entry => {
				if (known.has(entry.move)) return false;
				const gate = oracle.moveObtainableAt(entry.move);
				const level = entry.sources.some(source =>
					source.level !== undefined && source.level <= 12);
				const egg = entry.sources.some(source => /^egg(?:\s|$|\()/.test(source.source));
				const datedTeach = entry.sources.some(source => source.source === 'teachable') &&
					gate !== null && gate <= 0;
				return level || datedTeach || (egg && hasScale);
			}).length;
	};
	const teachable = teachableAt(
		run.applyAll(fresh(), [box, {kind: 'party', ids: ['mon-1']}]), false);
	const pickupsAt0 = oracle.itemsObtainableBy(0)
		.filter(p => require('../lib/planner').holdableItem(p.name)).length;

	// No scale in the bag, no scale candidate: the advisor ranks changes a
	// player can make today, not ones they could make after finding an item.
	assert.equal(run.adviseUpgrades(
		run.applyAll(fresh(), [box, {kind: 'party', ids: ['mon-1']}])).considered,
	teachable + pickupsAt0);

	// A fully perfect roll has no IV candidate. The scale in the bag still
	// unlocks egg-move teaches, and the count grows by exactly those.
	const funded = run.applyAll(fresh(), [
		owned({kind: 'catch', species: 'Poochyena', map: 'Route101', level: 3,
			ivs: PERFECT_IVS}),
		{kind: 'party', ids: ['mon-1']},
		{kind: 'acquire', item: 'Heart Scale'},
	]);
	assert.equal(run.adviseUpgrades(funded).considered, teachableAt(funded, true) + pickupsAt0);
	// (Evolutions are the advisor's fifth kind, but a Poochyena projected to 12
	// is short of Mightyena's 18 — it contributes no candidate here, which is
	// itself the claim: eligibility is judged at the projected cap.)
});

test('the advisor weighs an evolution the run has already earned', () => {
	// A box full of level-16+ Treeckos graded as Treeckos called Brawly
	// unwinnable when Grovyle wins it: the sim that first ran this split wiped
	// 30/30 unevolved and won 26/30 evolved, with no other change. The advisor
	// must surface the free upgrade, judged at the projected cap like teaches.
	const state = run.applyAll(fresh(), [
		owned({kind: 'catch', species: 'Poochyena', map: 'Route101', level: 3}),
		{kind: 'party', ids: ['mon-1']},
	]);
	// Against Brawly the cap is 21 and Mightyena's 18 is inside it.
	const advice = run.adviseUpgrades(state, 'Leader Brawly');
	const evolve = advice.upgrades.find(u => u.kind === 'evolve');
	assert.ok(evolve, 'an earned evolution must be on the shortlist');
	assert.equal(evolve.detail, 'evolve into Mightyena');
	assert.ok(evolve.delta.damage > 0 || evolve.delta.koGained > 0,
		'the evolved row must beat the unevolved one somewhere');
	// Against the first grunt the cap is 12: not earned yet, not offered.
	assert.ok(!run.adviseUpgrades(state).upgrades.some(u => u.kind === 'evolve'),
		'an evolution the cap has not reached is not a change the player can make');
});

test('evolve charges the stone and demands the move, not just the level', () => {
	// The evolution table names three currencies — a level, an item, a known
	// move — and the command must collect all three, or a run document could
	// record a Ludicolo no Water Stone ever paid for. Same contract as the
	// Heart Scale: the resource is charged where it is used, never assumed.
	let state = run.applyAll(fresh(), [
		{kind: 'catch', species: 'Lotad', map: 'Route103', level: 3},
		{kind: 'acquire', item: 'Rare Candy', count: 60},
		{kind: 'levelUp', id: 'mon-1', to: 14},
		{kind: 'evolve', id: 'mon-1'},
	]);
	assert.equal(state.box[0].species, 'Lombre');
	// Lombre -> Ludicolo is a stone evolution; an empty bag refuses it by name.
	assert.throws(() => run.apply(state, {kind: 'evolve', id: 'mon-1'}),
		/Lombre becomes Ludicolo with a Water Stone; there is none in the bag/);
	state = run.applyAll(state, [
		{kind: 'acquire', item: 'Water Stone'},
		{kind: 'evolve', id: 'mon-1'},
	]);
	assert.equal(state.box[0].species, 'Ludicolo');
	assert.ok(!state.bag['Water Stone'], 'the stone is spent, not kept');

	// Yanma -> Yanmega is a move evolution: knowing Ancient Power is the whole
	// requirement, and not knowing it is the whole refusal.
	state = run.apply(state, {kind: 'catch', species: 'Yanma', map: 'Route104', level: 5});
	assert.throws(() => run.apply(state, {kind: 'evolve', id: 'mon-2'}),
		/Yanma becomes Yanmega by levelling up knowing Ancient Power/);
	state = run.applyAll(state, [
		{kind: 'levelUp', id: 'mon-2', to: 33},
		{kind: 'teach', id: 'mon-2', move: 'Ancient Power', replace: 'Tackle'},
		{kind: 'evolve', id: 'mon-2'},
	]);
	assert.equal(state.box[1].species, 'Yanmega');
	// The run replays clean: undo rebuilds Yanma from the log, stone and all.
	assert.equal(run.undo(state).box[1].species, 'Yanma');
	assert.deepEqual(JSON.parse(JSON.stringify(state)), state, 'a run must survive JSON');
});

test('the advisor refuses what it cannot answer, with the reason', () => {
	// The party, not the box: six mons times their learnsets is already hundreds
	// of policy evaluations, and which six is the board's question, not this one.
	assert.throws(() => run.adviseUpgrades(fresh()),
		/the party is empty: add Pokemon to the party/);
	const state = run.applyAll(fresh(), [
		{kind: 'catch', species: 'Poochyena', map: 'Route101', level: 3},
		{kind: 'party', ids: ['mon-1']},
	]);
	assert.throws(() => run.adviseUpgrades(state, 'Leader Brawley'), /no fight named/);
});

test('a spent route is used with nothing kept, and the rule does not refund it', () => {
	// The one that got away is a real nuzlocke event: fled, fainted, out of
	// balls. Before `spend`, the document could only mark that route by
	// recording a catch that never happened.
	const nuz = () => fresh({onePerRoute: true, dupesClause: 'line', shinyClause: true});
	let state = run.applyAll(nuz(), [
		{kind: 'spend', map: 'Route101', reason: 'it fainted to a crit'},
	]);
	assert.match(state.log[0].summary, /Route101 spent — it fainted to a crit; nothing kept/);

	// Spent is spent: the catch is refused with the rule's own words, and the
	// refusal says the encounter got away rather than inventing a species.
	assert.throws(() => run.apply(state, {kind: 'catch', species: 'Poochyena', map: 'Route101', level: 3}),
		/already used its one Route101 encounter with nothing kept/);
	// So is a second spend, and a hold on the corpse of the route.
	assert.throws(() => run.apply(state, {kind: 'spend', map: 'Route101'}),
		/spend: Route101 already gave its encounter \(spent, nothing kept\)/);
	assert.throws(() => run.apply(state, {kind: 'hold', map: 'Route101'}),
		/already gave its encounter \(spent, nothing kept\)/);

	// The views say the same thing without a species to name.
	assert.deepEqual(run.encountersOn(state, 'Route101').used, {species: null, level: null});
	const row = run.unusedRoutes(state).routes.find(route => route.name === 'Route101');
	assert.deepEqual(row.used, {species: null, level: null});

	// Spending a held route resolves the hold, exactly like a catch would.
	state = run.applyAll(nuz(), [
		{kind: 'hold', map: 'Route102', for: 'Ralts'},
		{kind: 'spend', map: 'Route102'},
	]);
	assert.deepEqual(state.holds, {});
	// And the run replays clean.
	assert.equal(JSON.stringify(run.undo(state)),
		JSON.stringify(run.apply(nuz(), {kind: 'hold', map: 'Route102', for: 'Ralts'})));
});

test('the roll draws the route\'s encounter from the same tables a catch is checked against', () => {
	const nuz = () => fresh({onePerRoute: true, dupesClause: 'line', shinyClause: true});
	const state = nuz();
	// Deterministic dice: the first draw picks the species by table weight,
	// the second picks the level inside the slot's range. random() = 0 lands
	// on the first slot at its minimum level — and whatever comes up must be
	// CATCHABLE, which is the whole contract between the die and the rule.
	const roll = run.rollEncounter(state, {map: 'Route101', random: () => 0});
	assert.equal(roll.method, 'walk');
	assert.ok(roll.species && roll.level >= 1);
	const kept = run.apply(state, {kind: 'catch', species: roll.species,
		level: roll.level, map: 'Route101', method: roll.method});
	assert.equal(kept.box[0].species, roll.species);

	// A used route does not roll again — same rule, same wording.
	assert.throws(() => run.rollEncounter(kept, {map: 'Route101', random: () => 0}),
		/roll: Route101 already gave its encounter/);
	// Neither does a method whose HM has not been handed over (rock smash
	// opens at ORDER 139, which is Leader Roxanne and the 45th fight; a
	// fresh run stands at the very start).
	const oracle = require('../profiles').getProfile('run-and-bun').oracle;
	// An unreachable route refuses BEFORE its methods do, naming its guard —
	// so the method probe needs a map whose guard falls before the HM gate.
	const rocky = oracle.maps().find(map => {
		if (!map.tables.some(table => table.method === 'rock-smash') ||
			!map.tables.some(table => table.method === 'walk')) return false;
		const when = oracle.availabilityOf(map.map);
		return when && when.opensAt !== null && when.opensAt > 0 && when.opensAt < 100;
	});
	assert.ok(rocky, 'the game has an early rock-smash map');
	assert.throws(() => run.rollEncounter(state, {map: rocky.name, method: 'rock-smash'}),
		/is not reachable yet — .* guards it/);
	let past = state;
	const guardName = (() => {
		try {
			run.rollEncounter(state, {map: rocky.name, method: 'rock-smash'});
			return null;
		} catch (error) {
			return error.message.match(/— (.*) \(#\d+\) guards it/)[1];
		}
	})();
	past = run.apply(past, {kind: 'beat', trainer: guardName});
	assert.throws(() => run.rollEncounter(past, {map: rocky.name, method: 'rock-smash'}),
		/roll: "rock-smash" is not open/);

	// Under a dupes clause the roll re-rolls dupes by NOT rolling them: catch
	// the whole walk table but one, and every draw lands on the survivor.
	let sweep = nuz();
	const table = run.encountersOn(sweep, 'Route101').mons.filter(mon => mon.method === 'walk');
	assert.notEqual(run.encounterRules(sweep).dupes, 'off');
	for (const mon of table.slice(0, -1)) {
		if (run.encountersOn(sweep, 'Route101').mons.find(row =>
			row.species === mon.species && row.dupe)) continue;
		try {
			sweep = run.apply(sweep, {kind: 'catch', species: mon.species,
				level: mon.minLevel, map: 'Route101', method: 'walk', shiny: true});
		} catch (error) { /* a dupe of an earlier line — already excluded */ }
	}
	for (const draw of [0, 0.5, 0.99]) {
		const forced = run.rollEncounter(sweep, {map: 'Route101', random: () => draw});
		const rolledRow = table.find(mon => mon.species === forced.species);
		assert.ok(!run.encountersOn(sweep, 'Route101').mons.find(row =>
			row.species === forced.species && row.dupe),
		`the die must never land on a dupe; it rolled ${forced.species}`);
		assert.ok(rolledRow, 'the roll stays on the table');
	}
});

test('the field items standing on a location, with the log as the collection record', () => {
	const state = fresh();
	// Route 104 holds the Miracle Seed the moment order 11 is behind you; a
	// fresh run has not reached it, and the ledger says so rather than hiding it.
	const before = run.fieldItems(state, 'Route104');
	const seed = before.find(item => item.name === 'Miracle Seed');
	assert.ok(seed, 'Route 104 holds a Miracle Seed');
	assert.equal(seed.open, false);
	assert.equal(seed.collected, false);
	assert.equal(seed.opensAt, 11);

	// Route 101's Potion opens at the very start — and collecting it is the
	// acquire the bag already records, not a new kind of event.
	const potion = run.fieldItems(state, 'Route101').find(item => item.name === 'Potion');
	assert.ok(potion && potion.open && !potion.collected);
	const bagged = run.apply(state, {kind: 'acquire', item: 'Potion'});
	assert.equal(run.fieldItems(bagged, 'Route101')
		.find(item => item.name === 'Potion').collected, true);

	// Prose locations match identifiers without number bleed: "Route 110"
	// stands only on Route110 — never on Route 119 — and its Poison Barb
	// never leaks onto a neighbouring route's list.
	assert.ok(run.fieldItems(state, 'Route110').some(item => item.name === 'Poison Barb'));
	assert.ok(!run.fieldItems(state, 'Route119').some(item => item.name === 'Poison Barb'));

	// An area-level location reaches every map of the area: Mt. Pyre's item
	// shows up whichever floor is asked about.
	const oracle = require('../profiles').getProfile('run-and-bun').oracle;
	const pyre = oracle.maps().find(map => (oracle.areaOf(map.map) || '') === 'Mt Pyre');
	if (pyre) {
		assert.ok(run.fieldItems(state, pyre.name).length > 0,
			'Mt. Pyre\'s ledger rows should stand on its floors');
	}
});

test('pre-fight opportunities show only reachable, unspent work and honest move timing', () => {
	const state = fresh({permadeath: true});
	const before = run.preFightOpportunities(state);
	assert.deepEqual(before.before, {trainer: 'Youngster Calvin', order: 0});
	assert.equal(before.encounters.mode, 'unspent');
	// Littleroot and Oldale are here and Petalburg is not. Both changes come
	// from Philip's account of the route, corroborated independently by the
	// R&B tracker's own order: you start in Littleroot, walk Route 101 to
	// Oldale, and reach Petalburg only through Route 102. The transcribed
	// data had Petalburg at order 0 because its first-trainer anchor landed
	// level with Route 101, and had the two towns nowhere at all because no
	// trainer stands in either.
	assert.deepEqual(before.encounters.routes.map(route => route.name),
		['Route101', 'Route102', 'Route103', 'Littleroot Town', 'Oldale Town']);
	assert.deepEqual(before.items.pickups.map(item => item.name), ['Potion', 'Oran Berry']);
	assert.deepEqual(before.items.pickups.map(item => item.map), ['Route101', 'Route102']);
	// Move locations are imported now: the projection is run-aware, counts
	// only dated-and-open rows, and names the undated remainder instead of
	// hiding it.
	assert.equal(before.moves.status, 'dated');
	assert.equal(before.moves.count, 0, 'nothing is reachable before the first fight');
	assert.ok(before.moves.undated >= 20);
	assert.match(before.moves.note, /undated/);

	const collected = run.apply(state, {kind: 'acquire', item: 'Potion'});
	assert.deepEqual(run.preFightOpportunities(collected).items.pickups.map(item => item.name),
		['Oran Berry'], 'a pickup already in the log should leave the opportunity scan');

	const spent = run.apply(state,
		{kind: 'catch', species: 'Lillipup', map: 'Route101', level: 3});
	assert.ok(!run.preFightOpportunities(spent).encounters.routes
		.some(route => route.name === 'Route101'),
	'one-per-route runs should not advertise a spent encounter again');
});

test('an egg move is relearner-only: charged a Heart Scale, refused without one', () => {
	// The oracle writes egg sources as 'egg (Treecko)' — base species in the
	// string — and an equality check against 'egg' once taught a gift
	// Treecko Leaf Storm for free. Prefix matching is the regression here.
	let doc = run.createRun({name: 'egg', now: 't0', permadeath: true});
	doc = run.apply(doc, {kind: 'catch', species: 'Treecko', level: 12});
	assert.throws(() => run.apply(doc,
		{kind: 'teach', id: 'mon-1', move: 'Leaf Storm', replace: 'Leer'}),
	/teach: Leaf Storm is an egg move for Treecko — the relearner charges one Heart Scale/);
	doc = run.apply(doc, {kind: 'acquire', item: 'Heart Scale'});
	doc = run.apply(doc, {kind: 'teach', id: 'mon-1', move: 'Leaf Storm', replace: 'Leer'});
	assert.match(doc.log[doc.log.length - 1].summary, /for one Heart Scale/);
	assert.deepEqual(doc.bag, {}, 'the scale is spent');
	// The learnable listing prices it the same way.
	const listed = run.learnable(doc, 'mon-1');
	assert.ok(listed.now.some(entry => !entry.scale),
		'free routes (level-up, TM, tutor) stay unpriced');
});

test('a Static lead pulls the grass: Togedemaru becomes a coin flip, not a 1-in-20', () => {
	// The delay strategy the route guide teaches: HOLD Granite Cave until a
	// Static lead exists, because the pull makes half of all encounters
	// Electric — and Togedemaru is the cave's only Electric slot.
	let doc = run.createRun({name: 'static', now: 't0', permadeath: true});
	doc = run.apply(doc, {kind: 'beat', trainer: 'Lady Cindy'});
	doc = run.apply(doc, {kind: 'catch', species: 'Electrike', map: 'Route110',
		level: 12, ability: 'Static'});
	doc = run.apply(doc, {kind: 'party', ids: ['mon-1']});
	const seq = values => {
		let i = 0;
		return () => values[i++];
	};
	// First draw under one-half: the pull fires and the reply says who did it.
	const pulled = run.rollEncounter(doc, {map: 'GraniteCave1F',
		random: seq([0.1, 0, 0, 0, 0, 0, 0, 0, 0])});
	assert.equal(pulled.species, 'Togedemaru');
	assert.deepEqual(pulled.pull, {ability: 'Static', type: 'Electric'});
	// First draw over one-half: the table rolls exactly as printed.
	const missed = run.rollEncounter(doc, {map: 'GraniteCave1F',
		random: seq([0.9, 0, 0, 0, 0, 0, 0, 0, 0])});
	assert.equal(missed.species, 'Phanpy');
	assert.equal(missed.pull, undefined);
	// No Static lead: no pull draw is consumed at all — the same sequence
	// that pulled above rolls the plain table here.
	let plain = run.createRun({name: 'plain', now: 't0', permadeath: true});
	plain = run.apply(plain, {kind: 'beat', trainer: 'Lady Cindy'});
	plain = run.apply(plain, {kind: 'catch', species: 'Poochyena', map: 'Route101', level: 3});
	plain = run.apply(plain, {kind: 'party', ids: ['mon-1']});
	const unpulled = run.rollEncounter(plain, {map: 'GraniteCave1F',
		random: seq([0.1, 0, 0, 0, 0, 0, 0, 0])});
	assert.equal(unpulled.species, 'Phanpy');
	// An ability the run never declared cannot pull: face value, like all of it.
	let silent = run.createRun({name: 'silent', now: 't0', permadeath: true});
	silent = run.apply(silent, {kind: 'beat', trainer: 'Lady Cindy'});
	silent = run.apply(silent, {kind: 'catch', species: 'Electrike', map: 'Route110', level: 12});
	silent = run.apply(silent, {kind: 'party', ids: ['mon-1']});
	const undeclared = run.rollEncounter(silent, {map: 'GraniteCave1F',
		random: seq([0.1, 0, 0, 0, 0, 0, 0, 0])});
	assert.equal(undeclared.pull, undefined);
});

test('the scout grades the whole open table, not a display shortlist', () => {
	// The routes VIEW shows three rows per route; the scout once graded that
	// display cap — 21 of 131 catchable species — and never offered Gligar,
	// the measured single biggest Brawly lever. The grader now reads every
	// ungated row; the view keeps its summary.
	let doc = run.createRun({name: 'scout', now: 't0', permadeath: true, onePerRoute: true});
	doc = run.apply(doc, owned(
		{kind: 'catch', species: 'Poochyena', map: 'Route101', level: 3}));
	doc = run.apply(doc, {kind: 'party', ids: ['mon-1']});
	// Steven's Room is guarded by Ruin Maniac Georgie (#25): shut at the
	// door, its Gligar is not a catch anyone can make yet.
	const early = run.adviseCatches(doc, 'Leader Brawly');
	assert.ok(!early.catches.some(prospect => prospect.species === 'Gligar'),
		'a guarded room offers nothing');
	doc = run.apply(doc, {kind: 'beat', trainer: 'Battle Girl Jocelyn'});
	const scouted = run.adviseCatches(doc, 'Leader Brawly');
	assert.ok(scouted.catches.some(prospect => prospect.species === 'Gligar'),
		'the open room\'s deep slots are graded');
	assert.ok(scouted.considered > 100,
		`the whole table is considered, got ${scouted.considered}`);
	// The display path is untouched: three rows per route.
	const viewed = run.unusedRoutes(doc).routes.find(route => route.best && route.best.length);
	assert.ok(viewed.best.length <= 3, 'the routes view keeps its shortlist');
});

test('TM and tutor locations are dated late-biased and projected run-aware', () => {
	const oracle = require('../profiles').getProfile('run-and-bun').oracle;
	const rows = oracle.moveItems();
	assert.equal(rows.length, 78, '50 TMs and 28 tutor rows from the Items Locations sheet');
	const dated = rows.filter(row => row.opensAt !== null);
	assert.ok(dated.length >= 56, 'most rows carry an unlock date');
	// A prose HM requirement must gate the pickup: Surf rows can never open
	// before Surf itself does.
	const surfGate = oracle.moveObtainableAt('Surf');
	for (const row of rows) {
		if (/requires Surf/i.test(row.location) && row.opensAt !== null) {
			assert.ok(row.opensAt >= surfGate,
				row.move + ' requires Surf but opens at ' + row.opensAt + ' < ' + surfGate);
		}
	}
	// Undated rows must say so, never masquerade as reachable.
	for (const row of rows) {
		if (row.opensAt === null) assert.equal(row.dating, 'no-datable-place');
	}
	// Run-aware: at the start of a run, nothing is reachable yet and the
	// projection reports the undated remainder honestly.
	const moves = run.preFightOpportunities(fresh({})).moves;
	assert.equal(moves.status, 'dated');
	assert.equal(moves.count, 0, 'no TM or tutor is reachable before the first fight');
	assert.ok(moves.undated >= 20, 'the undated remainder is counted, not hidden');
});

test('evolution readiness reports the ladder and whether the run is there', () => {
	const caught = run.apply(fresh({}), {kind: 'catch', species: 'Treecko', level: 5,
		ivs: {hp: 1, atk: 2, def: 3, spa: 4, spd: 5, spe: 6}, nature: 'Adamant', ability: 'Overgrow'});
	const monId = caught.box[0].id;
	const before = run.evolutionReadiness(caught, monId);
	assert.deepEqual(before.evolutions, [{into: 'Grovyle', method: 'level', level: 16, ready: false}]);
	// Over-cap levels cost Rare Candy, exactly as the game charges them.
	const stocked = run.apply(caught, {kind: 'acquire', item: 'Rare Candy', count: 4});
	const leveled = run.apply(stocked, {kind: 'levelUp', id: monId, to: 16});
	assert.equal(run.evolutionReadiness(leveled, monId).evolutions[0].ready, true,
		'reaching the level flips readiness');
});

test('the safety path refuses an empty party and names who a crit can kill', () => {
	let state = fresh();
	assert.throws(() => run.safetyPath(state, 'Bug Catcher Rick'),
		/party is empty/, 'nothing to make safe without a party');

	state = run.apply(state, owned({kind: 'catch', species: 'Mudkip', level: 5}));
	state = run.apply(state, owned({kind: 'catch', species: 'Poochyena', level: 5}));
	state = run.apply(state, {kind: 'party', ids: state.box.map(mon => mon.id)});
	const answer = run.safetyPath(state, 'Bug Catcher Rick');
	assert.equal(answer.trainer, 'Bug Catcher Rick');
	// Pineco's crit exceeds Poochyena's whole HP bar at this cap; Mudkip's it
	// does not. The exposure list is the fight's honest death list.
	const exposedSpecies = answer.exposed.map(entry => entry.species);
	assert.ok(exposedSpecies.includes('Poochyena'),
		'Poochyena dies to a crit here and must be listed');
	assert.ok(!exposedSpecies.includes('Mudkip'),
		'Mudkip survives every crit in this fight');
	const killer = answer.exposed.find(entry => entry.species === 'Poochyena').killers[0];
	assert.equal(typeof killer.enemy, 'string');
	assert.equal(typeof killer.move, 'string');
});

test('the safety path answers with an assignment when no build fixes a fight', () => {
	let state = fresh();
	state = run.apply(state, owned({kind: 'catch', species: 'Mudkip', level: 5}));
	state = run.apply(state, owned({kind: 'catch', species: 'Poochyena', level: 5}));
	state = run.apply(state, {kind: 'party', ids: state.box.map(mon => mon.id)});
	const answer = run.safetyPath(state, 'Bug Catcher Rick');
	// No teachable move changes what a Pokemon TAKES, so the real answer to a
	// crit that outdamages a whole HP bar is who to send instead.
	assert.ok(answer.coverage.length > 0, 'a lethal fight must name its coverage');
	const row = answer.coverage[0];
	assert.ok(row.kills.length > 0, 'a coverage row exists because someone dies');
	assert.ok(row.answers.length === 0 || typeof row.bestAnswer === 'string');
	if (row.bestAnswer) {
		assert.ok(!row.kills.includes(row.bestAnswer),
			'the answer to an enemy is never someone that enemy kills');
		assert.ok(row.bestAnswerCrit < 100,
			'a safe answer survives the crit it is answering');
	}
	// Every step, if any, must actually reduce lethality and price itself.
	answer.steps.forEach(step => {
		assert.ok(step.removes > 0, 'a step that removes nothing is not a step');
		assert.ok(Array.isArray(step.path) && step.path.length >= 1);
		assert.equal(typeof step.cost, 'string');
	});
});

test('the lethality rule credits an outspeeding floor KO and nothing weaker', () => {
	// Tested directly because a scan of the whole run map found no live
	// pairing that exercises this branch: the condition needs a Pokemon that
	// floor-KOs its opponent AND would die to that opponent's crit. The rule
	// decides every 'exposed' verdict in the app, so it is pinned here rather
	// than left to a fixture that does not reach it.
	const lethalCrit = {critKO: true, critMax: 1.4, move: 'Bite'};
	assert.equal(run.pairingLethal(
		{them: lethalCrit, us: {min: 1.05}, speed: 'faster'}), false,
	'outspeeding with a floor KO means the crit never lands');
	// Priority ignores Speed: a Mach Punch crit swings first however fast we
	// are, so the outspeed credit must not apply to it. Without this the app
	// reports a Pokemon safe against the exact move that kills it.
	assert.equal(run.pairingLethal(
		{them: {critKO: true, critMax: 1.4, move: 'Mach Punch', critPriority: true},
			us: {min: 1.05}, speed: 'faster'}), true,
	'a priority crit cancels the outspeed credit');
	assert.equal(run.pairingLethal(
		{them: lethalCrit, us: {min: 1.05}, speed: 'tie'}), true,
	'a speed tie is not outspeeding');
	assert.equal(run.pairingLethal(
		{them: lethalCrit, us: {min: 1.05}, speed: 'slower'}), true,
	'slower means they swing first');
	assert.equal(run.pairingLethal(
		{them: lethalCrit, us: {min: 0.99}, speed: 'faster'}), true,
	'a 99% floor is not a KO — the roll can leave them alive to crit back');
	assert.equal(run.pairingLethal(
		{them: {critKO: false, critMax: 0.5}, us: {min: 0.1}, speed: 'slower'}), false,
	'a crit that cannot kill is not a lethal pairing');
	assert.equal(run.pairingLethal(null), false, 'a missing pairing is not lethal');
});

test('a clean fight reports no exposure, coverage or steps', () => {
	// A Pokemon that outspeeds and KOs on its WORST roll is never hit, so the
	// crit that would have killed it never happens. This is the model
	// decision that makes teaching a move able to buy survival at all; if it
	// regresses, the safety path silently reports fights as lethal that are
	// not, and every 'nothing fixes this' answer becomes untrustworthy.
	let state = fresh();
	state = run.apply(state, owned({kind: 'catch', species: 'Mudkip', level: 5,
		ivs: PERFECT_IVS}));
	state = run.apply(state, {kind: 'party', ids: state.box.map(mon => mon.id)});
	const capped = run.safetyPath(state, 'Youngster Calvin');
	// Calvin's team cannot crit-kill a capped Mudkip; the fight is clean.
	assert.deepEqual(capped.exposed, [], 'no exposure means no death list');
	assert.deepEqual(capped.coverage, [], 'no exposure means nothing to cover');
	assert.deepEqual(capped.steps, [], 'a safe fight needs no steps');
	assert.ok(Array.isArray(capped.openRoutes), 'unspent routes are always reported');
});

test('an option the bag cannot fund is never offered as a step', () => {
	// Pinned on the selection rule itself, because no live fixture I could
	// build produces an item step at all — and an end-to-end assertion that
	// counts zero claims against a bag passes whether the rule works or not.
	// The rule matters: an earlier version fell back to the unfunded list
	// when nothing affordable helped, which handed one Focus Sash to three
	// Pokemon and called each of them safe.
	const sashStep = {steps: [{kind: 'give', spec: {item: 'Focus Sash'}, detail: 'Focus Sash'}]};
	const teachStep = {steps: [{kind: 'teach', detail: 'Bite over Tackle'}]};
	const twoSashes = {steps: [
		{kind: 'give', spec: {item: 'Focus Sash'}, detail: 'Focus Sash'},
		{kind: 'pickup', spec: {item: 'Focus Sash'}, detail: 'Focus Sash @ Route 121'},
	]};

	const stocked = run.affordableOptions([sashStep, teachStep], {'Focus Sash': 1});
	assert.equal(stocked.length, 2, 'a funded item and a free teach both stand');

	const empty = run.affordableOptions([sashStep], {});
	assert.deepEqual(empty, [],
		'an unfunded option is dropped, never offered as a fallback');

	assert.deepEqual(run.affordableOptions([twoSashes], {'Focus Sash': 1}), [],
		'one Sash cannot fund an option that claims two');

	// The ledger is what makes the SECOND Pokemon see an empty pool.
	const ledger = {'Focus Sash': 1};
	assert.equal(run.affordableOptions([sashStep], ledger).length, 1);
	run.spendFromBag(['Focus Sash'], ledger);
	assert.deepEqual(run.affordableOptions([sashStep], ledger), [],
		'once the first Pokemon claims it, no one else can be told to hold it');
});

test('one bag cannot fund two Pokemon', () => {
	// Tested directly, for the same reason the lethality rule is: the search
	// only reaches this ledger when an ITEM step removes a lethal branch, and
	// no live fixture currently produces one. The rule still decides who gets
	// the run's only Oran Berry, so it is pinned here rather than left to a
	// fixture that never exercises it.
	const bag = {'Oran Berry': 1, Potion: 2};
	assert.equal(run.affordableFromBag(['Oran Berry'], bag), true);
	assert.equal(run.affordableFromBag(['Oran Berry', 'Oran Berry'], bag), false,
		'one berry cannot be claimed twice inside a single option');
	assert.equal(run.affordableFromBag(['Potion', 'Potion'], bag), true,
		'two of a doubled item is affordable');
	assert.equal(run.affordableFromBag(['Potion', 'Potion', 'Potion'], bag), false);
	assert.equal(run.affordableFromBag(['Max Revive'], bag), false,
		'an item the bag does not hold is never affordable');
	assert.equal(run.affordableFromBag([], bag), true, 'a stepless option is free');

	// Spending is what makes the SECOND Pokemon unable to claim the same one.
	const ledger = Object.assign({}, bag);
	run.spendFromBag(['Oran Berry'], ledger);
	assert.equal(ledger['Oran Berry'], 0);
	assert.equal(run.affordableFromBag(['Oran Berry'], ledger), false,
		'once spent, the berry is gone for everyone else');
});

test('a location the data cannot date is reported, never silently dropped', () => {
	// availability.json dates a location by its FIRST TRAINER. Anywhere
	// without one — Oldale Town, the whole Safari Zone, Fiery Path, Sky
	// Pillar, Altering Cave — gets no date at all, and unusedRoutes used to
	// leave `open` unset for those. Every consumer filters on `route.open`,
	// and undefined is falsy, so 18 of 69 locations vanished from every
	// answer at every point in the run. Twelve of them have walk encounters.
	// Oldale Town is one of the first places a run can catch anything and the
	// scout would never once mention it.
	const state = fresh({permadeath: true});
	const routes = run.unusedRoutes(state).routes;

	// Artisan Cave, not Oldale Town. Oldale stood here until the R&B tracker
	// dated it; Artisan Cave is post-game content the tracker never lists, so
	// nothing can reach it and it is the honest remaining example.
	const undatable = routes.find(route => route.name === 'Artisan Cave');
	assert.ok(undatable, 'Artisan Cave is in the wild tables');
	assert.equal(undatable.undated, true, 'and it is reported as undated');
	assert.equal(undatable.opensAt, undefined, 'because nothing dates it');
	// Undated is not open. Claiming it were would send a fresh run to Sky
	// Pillar, which is the same error in the other direction.
	assert.ok(!undatable.open, 'undated is not a licence to call it open');

	const dated = routes.find(route => route.name === 'Route101');
	assert.equal(dated.opensAt, 0, 'a dated route still carries its date');
	assert.equal(dated.open, true, 'and Route 101 is open on turn one');
	assert.equal(dated.undated, undefined, 'a dated route is not flagged undated');

	// The scout counts them out loud. This is the assertion that would have
	// caught the original bug: the answer must account for every location it
	// did not scan, the way it already accounts for held ones.
	const scouted = run.adviseCatches(state, 'Youngster Calvin');
	const undatedRoutes = routes.filter(route => route.undated);
	assert.ok(undatedRoutes.length > 0, 'the fixture must have undated locations');
	assert.equal(scouted.undated.count, undatedRoutes.length,
		'the scout reports exactly the locations it could not date');
	assert.ok(scouted.undated.routes.includes('Artisan Cave'),
		'and names Artisan Cave among them');
	assert.match(scouted.undated.why, /first trainer/,
		'and says why, so the gap reads as missing data rather than as an empty map');

	// The count has to TRACK, not be a constant that happens to match today's
	// data — asserting it against the current 18 passes just as well when the
	// number is hardcoded. Catching on an undated location spends it, so the
	// count must fall and that location must leave the list. This also proves
	// the underlying tables were fine all along: the catch is accepted, the
	// tool simply never offered it.
	const spent = run.apply(state,
		owned({kind: 'catch', species: 'Smeargle', map: 'Artisan Cave 1f', level: 40, moves: ['Flamethrower']}));
	const after = run.adviseCatches(spent, 'Youngster Calvin');
	assert.equal(after.undated.count, scouted.undated.count - 1,
		'spending an undated location drops it from the count');
	assert.ok(!after.undated.routes.includes('Artisan Cave'),
		'and it is no longer named as unscanned');
});

test('a spent route only closes when the run says one encounter per route', () => {
	// Found by playing a run in the browser. The catch advisor filtered on
	// `route.used` unconditionally, so a run WITHOUT the nuzlocke rule lost
	// advice for every route it had already caught on — the route was still
	// perfectly legal to catch from, and the scout simply stopped mentioning
	// it. preFightOpportunities had always asked the question correctly, so
	// the two surfaces disagreed about the same run: 4 against 5.
	const IVS = {hp: 20, atk: 20, def: 20, spa: 20, spd: 20, spe: 20};
	function afterCatchingOnRoute101(onePerRoute) {
		let state = run.apply(fresh({onePerRoute}),
			owned({kind: 'catch', species: 'Mudkip', level: 5, ivs: IVS}));
		state = run.apply(state,
			owned({kind: 'catch', species: 'Lillipup', map: 'Route101', level: 3, ivs: IVS}));
		const advice = run.adviseCatches(state);
		const opportunities = run.preFightOpportunities(state);
		return {
			adviseCount: advice.routesOpen,
			adviseOffersIt: advice.catches.some(entry => entry.area === 'Route101'),
			opportunityCount: opportunities.encounters.count,
			opportunityListsIt: opportunities.encounters.routes
				.some(route => route.name === 'Route101'),
		};
	}

	// Rule OFF: the route is still legal, so both surfaces must still offer it.
	const loose = afterCatchingOnRoute101(false);
	assert.equal(loose.adviseOffersIt, true,
		'without the rule, a route you have caught on is still catchable');
	assert.equal(loose.opportunityListsIt, true, 'and the opportunity list agrees');

	// Rule ON: the route is spent, so neither surface may offer it.
	const nuzlocke = afterCatchingOnRoute101(true);
	assert.equal(nuzlocke.adviseOffersIt, false, 'with the rule, the route is spent');
	assert.equal(nuzlocke.opportunityListsIt, false, 'and the opportunity list agrees');

	// The counts are the same question and must never disagree, either way.
	assert.equal(loose.adviseCount, loose.opportunityCount,
		'the two surfaces must count the same routes with the rule off');
	assert.equal(nuzlocke.adviseCount, nuzlocke.opportunityCount,
		'and with the rule on');
	assert.equal(loose.adviseCount - nuzlocke.adviseCount, 1,
		'and the rule must actually cost exactly the one spent route');
});

test('skipping the enemy half for a teach candidate changes no answer', () => {
	// adviseUpgrades stops recomputing how hard the enemy hits us when the only
	// thing a candidate changes is which moves we know. That is safe because
	// nothing about our Pokemon's defence moved, and because upgradeDelta
	// subtracts that half from itself in any case — but "safe because I
	// reasoned it" is how a wrong optimisation ships, so this compares the
	// whole advise output with the shortcut on and off.
	//
	// It is deliberately NOT taken for a pickup: Eviolite, Focus Sash and the
	// resist berries are all in the dex, and a resist berry answers one type,
	// so a single-cell probe would read "unchanged" against an enemy without
	// that type and be wrong about the next one.
	const planner = require('../lib/planner');
	const real = planner.matchup;
	const IVS = {hp: 20, atk: 18, def: 19, spa: 22, spd: 17, spe: 21};
	const parties = [
		['Prinplup', 'Staravia', 'Lombre', 'Flaaffy', 'Bayleef', 'Lumineon'],
		['Grotle', 'Luxio', 'Gastrodon', 'Beedrill', 'Donphan', 'Ampharos'],
	];
	try {
		for (const species of parties) {
			let doc = run.applyAll(run.createRun({
				name: 'splice', now: 't0', levelCap: 'none',
				permadeath: false, onePerRoute: false,
			}), species.map(name => ({
				kind: 'catch', species: name, level: 24, ivs: Object.assign({}, IVS),
			})));
			doc = run.apply(doc, {kind: 'party', ids: doc.box.map(mon => mon.id)});
			for (const fight of ['Camper Gavi', 'Leader Brawly']) {
				planner.matchup = function (options) {
					const copy = Object.assign({}, options);
					delete copy.skipThem;
					return real.call(this, copy);
				};
				const full = JSON.stringify(run.adviseUpgrades(doc, fight));
				planner.matchup = real;
				const spliced = JSON.stringify(run.adviseUpgrades(doc, fight));
				assert.equal(spliced, full,
					species[0] + ' vs ' + fight + ': the shortcut must not move any number');
			}
		}
	} finally {
		planner.matchup = real;
	}
});

test('a held item can move the enemy half, which is why only teach skips it', () => {
	// The reason adviseUpgrades takes the shortcut for `teach` and not for
	// `pickup`. Without this, someone widens the condition to "anything that is
	// not an evolution", the advise fixtures still pass — their bag happens to
	// hold only Miracle Seed, Silk Scarf, Soft Sand and Poison Barb, which are
	// all offensive — and the shortcut is silently wrong the first time a
	// resist berry or an Eviolite reaches the bag.
	//
	// Aron is Steel/Rock, so Brawly's Fighting hits it for 4x. That matters:
	// a Chople Berry only acts on a move that is already super-effective, so
	// the same probe on a Pokemon that merely takes Fighting neutrally shows
	// no change at all and would "prove" the opposite.
	const planner = require('../lib/planner');
	const aron = {
		species: 'Aron', level: 24,
		moves: ['Headbutt', 'Metal Claw', 'Rock Tomb', 'Harden'],
		ivs: {hp: 20, atk: 18, def: 19, spa: 22, spd: 17, spe: 21},
	};
	const board = item => planner.matchup({
		trainer: 'Leader Brawly',
		playerParty: [item ? Object.assign({}, aron, {item: item}) : aron],
		profileId: 'run-and-bun',
	}).grid.map(cell => cell.versus[0].them.max);

	const bare = board(null);
	const movedBy = item => board(item).filter((max, i) => Math.abs(max - bare[i]) > 1e-9).length;

	assert.ok(movedBy('Chople Berry') > 0,
		'a resist berry changes what the enemy does to us, so a pickup cannot reuse the baseline');
	assert.ok(movedBy('Eviolite') > 0, 'and so does Eviolite');
	assert.equal(movedBy('Silk Scarf'), 0,
		'while a type-boosting item touches only our own damage — which is what makes ' +
		'the wider shortcut look safe on a bag that happens to hold nothing else');
});

test('evolving carries the ability by slot, so it stays legal for the new species', () => {
	// The run kept the ability STRING across evolution, which leaves a Seadra
	// holding Swift Swim — an ability Seadra cannot have. That is not cosmetic:
	// the planning provider validates the ability it is handed against the
	// species, so a stale one throws and the fight loses its survival forecast.
	// 527 of the recorded forecast failures are exactly this, and every one is
	// a pre-evolution's ability sitting on an evolved form.
	//
	// The games carry the SLOT, so slot one becomes slot one.
	//
	// Honest limit: this cannot falsify the slot INDEXING. Every one of the
	// 1,244 species in the fork's calc data has exactly one ability, so slot is
	// always zero and hard-coding zero passes this test. What it does pin is
	// that the ability is remapped at all and lands on something the new
	// species can legally have — which is the failure that was costing runs
	// their forecast.
	const calc = require('../calc');
	const legal = species => {
		const found = calc.Generations.get(8).species.get(calc.toID(species));
		return [...new Set(Object.values(found.abilities || {}).filter(Boolean))];
	};
	const cases = [
		{from: 'Horsea', ability: 'Swift Swim', into: 'Seadra', level: 32},
		{from: 'Fletchling', ability: 'Keen Eye', into: 'Fletchinder', level: 17},
		{from: 'Phanpy', ability: 'Cute Charm', into: 'Donphan', level: 25},
		{from: 'Starly', ability: 'Keen Eye', into: 'Staravia', level: 14},
	];
	for (const step of cases) {
		let doc = run.createRun({
			name: 'evo', now: 't0', levelCap: 'none', permadeath: false, onePerRoute: false,
		});
		doc = run.apply(doc, {
			kind: 'catch', species: step.from, level: step.level, nature: 'Modest',
			ability: step.ability, ivs: {hp: 20, atk: 18, def: 19, spa: 22, spd: 17, spe: 21},
		});
		assert.equal(doc.box[0].ability, step.ability, 'the roll is what it says it is');
		doc = run.apply(doc, {kind: 'evolve', id: doc.box[0].id});
		assert.equal(doc.box[0].species, step.into);
		assert.ok(legal(step.into).includes(doc.box[0].ability),
			step.from + ' -> ' + step.into + ' left ' + doc.box[0].ability +
			', which is not legal for ' + step.into + ' (legal: ' + legal(step.into).join(', ') + ')');
		assert.notEqual(doc.box[0].ability, step.ability,
			'and it is not the pre-evolution ability carried across');
	}
});

test('an unrecorded IV plans as the floor, never as a perfect one', () => {
	// playerStateFromEntry filled missing IVs with 31, and a Pokemon caught
	// without a rolled spread stores ivs {} — so Object.assign({all 31s}, {})
	// planned it flawless. Optimistic is the dangerous direction: at level 30 it
	// overstated Speed by five against an average roll, and five points of Speed
	// flips turn order, which flips a survival verdict.
	const planner = require('../lib/planner');
	// The bridge is the setdex one, and it needs the setdex loaded — which
	// building any fight state does. matchup warms it as a side effect.
	planner.matchup({trainer: 'Leader Brawly', profileId: 'run-and-bun',
		playerParty: [{species: 'Poochyena', level: 5, moves: ['Tackle']}]});
	const bridge = require('../src/js/sets_to_battle_state.js');
	const build = entry => planner.playerStateFromEntry(bridge,
		Object.assign({species: 'Poochyena', level: 30, moves: ['Tackle']}, entry),
		'player-1').state;

	// Assert on the STAT, not the ivs field: the bridge omits IVs from the state
	// when they are its default of 31, so `ivs: undefined` there MEANS perfect
	// and reads like an absence. HP is the consequence and cannot be misread.
	const hp = entry => build(entry).hp.max;

	// OWNED with nothing rolled — ivs is {}, present and empty.
	assert.equal(hp({ivs: {}}), 61,
		'a Pokemon the run owns plans at the floor when nothing was rolled');
	assert.equal(hp({ivs: {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31}}), 70,
		'and at 70 when the spread is actually perfect, which is the number the ' +
		'unrolled case used to borrow');

	// A PROSPECT is a different question. adviseCatches builds {species, level,
	// moves} with no ivs key at all, and "is this worth catching" is asked at its
	// best rather than its worst. Flattening the two broke two existing gates
	// before this split existed.
	assert.equal(hp({}), 70, 'an uncaught prospect is still graded at its best');
});
