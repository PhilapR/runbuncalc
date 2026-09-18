/* eslint-env node, es6 */
'use strict';

/**
 * Gate for the party ranker (run.rankParties).
 *
 * That it ranks the box the player will field at the cap, not today's; that
 * its enumeration is bounded by the box and not a clock; that the cheap cut
 * keeps the best six; that it plays genuinely different sixes; what its
 * shortlist costs; and that its optional exposure term is the count it says. Split from run.test.js because these five tests carry
 * most of that file's time; the document properties are still there.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const run = require('../lib/run');
const fixtures = require('./helpers/run-fixtures.js');
const owned = fixtures.owned;
const fresh = fixtures.fresh;

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
	// It was then an absolute 3s budget, and that was the same mistake wearing
	// a different number. Measured alone it is 585ms; under the full suite,
	// beside a test that commits ten thousand times, it hit 4829ms and went
	// red on code nothing had touched. A clock cannot be rescued by choosing a
	// kinder threshold — the healthy and loaded ranges overlap, which is the
	// same finding `no-cpu-scaling-gate-for-commit` recorded about this repo.
	//
	// So there is no clock here at all. The claim was always about WORK: the
	// enumeration must not grow with the box. `combinations` is that number,
	// it is exact, and it moves only when behaviour moves. A box of 30 is
	// 593,775 sixes whether the machine is idle or on fire, and the box of 76
	// that opened the finding is 218,618,940 — which the cut refuses rather
	// than enumerates, asserted in its own test above.
	const ranked = run.rankParties(boxOf(30), 'Leader Brawly', {rollouts: 0});
	assert.equal(ranked.combinations, 593775,
		'C(30,6) exhaustively: the enumeration is bounded by the box, not by a clock');
	assert.equal(ranked.shortlist.cutting, false,
		'and a box of 30 is still under the cut threshold, so this is the whole box');
});

test('the exposure term charges each member an enemy one-shots from the slower side, and nothing when off', () => {
	// On a real banked box, not a constructed one: the count is recomputed
	// here from the board's own cells, independently of the ranker's table.
	const fs = require('node:fs');
	const path = require('node:path');
	const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'banked-runs',
		'lead1-A-9.run.json'), 'utf8'));
	// Chelle's Daycare: the held-out fight where play most overruled the
	// ranker (2 -> 17 of 20), and its sixes differ in exposure.
	const trainer = 'Trainer Chelle Daycare';
	// Cut to eight members so all 28 sixes appear in both rankings: on the
	// full box the term reorders the top forty with none left in common.
	const keepIds = new Set(doc.box.filter(member => member.status !== 'dead').slice(0, 8)
		.map(member => member.id));
	doc.box = doc.box.filter(member => keepIds.has(member.id));
	doc.party = doc.party.filter(id => keepIds.has(id));
	const plain = run.rankParties(doc, trainer, {rollouts: 0, top: 40});
	const zero = run.rankParties(doc, trainer, {rollouts: 0, top: 40, exposureWeight: 0});
	assert.deepEqual(zero.parties, plain.parties, 'weight 0 is the ranker as it stood');
	assert.deepEqual(plain.setScore, {exposureWeight: 0});

	const weight = 0.5;
	const priced = run.rankParties(doc, trainer, {rollouts: 0, top: 40, exposureWeight: weight});
	assert.deepEqual(priced.setScore, {exposureWeight: weight});
	const matrix = run.boxMatrix(doc, trainer);
	const exposureOf = id => {
		const m = matrix.box.findIndex(member => member.id === id);
		return matrix.grid.filter(column => column.versus[m].them.guaranteedKO &&
			column.versus[m].speed !== 'faster').length;
	};
	const keyOf = party => party.members.map(member => member.id).sort().join(',');
	const before = new Map(plain.parties.map(party => [keyOf(party), party.score]));
	let compared = 0;
	let charged = 0;
	for (const party of priced.parties) {
		if (!before.has(keyOf(party))) continue;
		const exposure = party.members.reduce((sum, member) => sum + exposureOf(member.id), 0);
		assert.ok(Math.abs(party.score - (before.get(keyOf(party)) - weight * exposure)) < 0.0015,
			keyOf(party) + ': ' + party.score + ' is not ' + before.get(keyOf(party)) + ' - ' + weight + ' x ' + exposure);
		compared++;
		if (exposure) charged++;
	}
	assert.equal(compared, 28, 'every six of eight appears in both rankings: ' + compared);
	assert.ok(charged > 0, 'and some of them carry exposure, or the term is untested');
	assert.notDeepEqual(priced.parties.map(keyOf), plain.parties.map(keyOf), 'the term moves the ranking here');
	assert.throws(() => run.rankParties(doc, trainer, {rollouts: 0, exposureWeight: -1}), /at least 0/);
});
