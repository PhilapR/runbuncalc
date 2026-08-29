/* eslint-env node, es6 */
'use strict';

/**
 * Gate for whether the advisor can see the TM and tutor ledger at all.
 *
 * `moveObtainableAt` decides whether a teachable move is reachable yet, and
 * for a long time it consulted only `hmMoves` — the eight HM story gates. Its
 * docstring said so, and said it plainly: "null covers every TM". That was a
 * true description of the data when it was written. `moveItems` arrived later
 * with 78 rows and 56 dated unlocks, and nothing connected the two, so every
 * TM answered null, `datedTeachRoute` was false for all of them, and the
 * advisor discarded the lot.
 *
 * The visible cost: a party at Leader Brawly, with Icy Wind and Rock Blast
 * both reachable since order 25, was offered Absorb.
 *
 * The second half of the gate is the off-by-one that fix exposed. TM16 Seismic
 * Toss is Brawly's own gym reward and carries HIS order, so a numeric
 * `gate <= order` test made it advice FOR the Brawly fight — a prize you can
 * only hold by having already won without it.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const run = require('../lib/run');
const profile = require('../profiles/run-and-bun');

/** A six-strong party standing immediately before a named fight. */
function standingBefore(trainer) {
	let doc = run.createRun({
		name: 'tm', now: 't0', levelCap: 'next-milestone-ace',
		permadeath: false, onePerRoute: false,
	});
	for (const species of ['Prinplup', 'Staravia', 'Lombre', 'Flaaffy', 'Bayleef', 'Lumineon']) {
		doc = run.apply(doc, {kind: 'catch', species: species, level: 21,
			ivs: {hp: 20, atk: 20, def: 20, spa: 20, spd: 20, spe: 20}});
	}
	doc = run.apply(doc, {kind: 'party', ids: doc.box.map(mon => mon.id)});
	const road = run.upcoming(doc, 4000);
	const fights = Array.isArray(road) ? road : (road.fights || []);
	for (const fight of fights) {
		if (new RegExp(trainer).test(fight.trainer)) break;
		try {
			doc = run.apply(doc, {kind: 'beat', trainer: fight.trainer});
		} catch (error) { /* an optional or variant fight the road skips */ }
	}
	return doc;
}

test('a dated TM reports the order it becomes obtainable, not null', () => {
	const at = move => profile.oracle.moveObtainableAt(move);
	// HMs kept working throughout; they were the only thing that ever did.
	assert.equal(at('Surf'), 594);
	assert.equal(at('Rock Smash'), 142);
	// These are the ones that answered null while sitting dated in the ledger.
	assert.equal(at('Feint Attack'), 14);
	assert.equal(at('Icy Wind'), 25);
	assert.equal(at('Rock Blast'), 25);
	assert.equal(at('Seismic Toss'), 80);
	// A row with a known place and no proven unlock still answers null, which
	// must read as "timing unproven" and never as "available now".
	assert.equal(at('Aerial Ace'), null);
	assert.equal(at('Not A Real Move'), null);
});

test('a ruled move follows its anchor map, and an unruled one still answers null', () => {
	// Two rows a human dated. They arrived as `dating: 'no-datable-place'` —
	// the transcriber knew where the move was and would not say when — and
	// deriving a date from the map table was tried once and reverted, because
	// Aerial Ace names Route 111 and Route 111 has a desert behind the Mach
	// Bike. What separates these from that one is knowledge of the game, so
	// each carries the name of the person who supplied it in
	// `MOVE_DATE_RULINGS`.
	//
	// Asserted against the ANCHOR rather than against a literal, so a ruling
	// says which place dates the move instead of freezing a number that the
	// map table might later move.
	const adopt = require('../scripts/adopt-availability.js');
	const availability = require('../profiles/run-and-bun/oracle/availability.json');
	const at = move => profile.oracle.moveObtainableAt(move);
	const orderOf = name => (availability.entries || [])
		.find(entry => entry.name === name).opensAt;

	const planner = require('../lib/planner');
	const fightOrderOf = name => planner.loadRunMap('run-and-bun')
		.find(fight => fight.trainer === name).order;
	for (const move of Object.keys(adopt.MOVE_DATE_RULINGS)) {
		const ruling = adopt.MOVE_DATE_RULINGS[move];
		// A ruling names a place, a fight, or an order — exactly one of them.
		const forms = [ruling.anchor, ruling.anchorTrainer, ruling.order]
			.filter(value => value !== undefined).length;
		assert.equal(forms, 1,
			`${move} must be ruled from exactly one of: anchor map, anchor trainer, explicit order`);
		const expected = ruling.anchor !== undefined ? orderOf(ruling.anchor) :
			ruling.anchorTrainer !== undefined ? fightOrderOf(ruling.anchorTrainer) :
				ruling.order;
		assert.equal(at(move), expected,
			`${move} is ruled to ${ruling.anchor || ruling.anchorTrainer || ruling.order}, ` +
			'and must report that order');
		assert.match(adopt.MOVE_DATE_RULINGS[move].why, /^Philip, from play:/,
			'a ruling names the person who supplied the game knowledge');
	}
	// The two that were ruled, spelled out, so this test fails if the table is
	// emptied rather than passing vacuously over nothing.
	assert.deepEqual(Object.keys(adopt.MOVE_DATE_RULINGS).sort(),
		['Rock Tomb', 'Smart Strike', 'Swagger']);

	// And the rest of the undated set is untouched: 19 rows still answer null,
	// which is the silence the filter exists to keep.
	const undated = profile.oracle.moveItems()
		.filter(row => typeof row.opensAt !== 'number');
	assert.ok(undated.length > 10,
		'the undated remainder is counted, not quietly emptied');
});

test('the ruling refuses rather than guesses when its anchor moves', () => {
	// The failure this exists for: someone renames or removes a map and the
	// ruling silently stops applying, or upstream starts supplying its own date
	// and the two disagree without anyone noticing. Both throw.
	const adopt = require('../scripts/adopt-availability.js');
	const clone = () => JSON.parse(JSON.stringify(
		require('../profiles/run-and-bun/oracle/availability.json')));

	const noAnchor = clone();
	noAnchor.entries = noAnchor.entries.filter(entry => entry.name !== 'Rusturf Tunnel');
	noAnchor.moveItems.find(row => row.move === 'Rock Tomb').opensAt = null;
	assert.throws(() => adopt.applyMoveDateRulings(noAnchor),
		/the map table does not date/,
		'a ruling whose anchor vanished must refuse, not fall back to a guess');

	const disagrees = clone();
	disagrees.moveItems.find(row => row.move === 'Rock Tomb').opensAt = 999;
	assert.throws(() => adopt.applyMoveDateRulings(disagrees),
		/a transcription and a person disagree/,
		'an upstream date that contradicts the ruling needs a human, not a winner');

	// Idempotent: the committed file is already ruled, so re-applying changes
	// nothing. An adoption that kept rewriting would churn the file forever.
	assert.deepEqual(adopt.applyMoveDateRulings(clone()), [],
		're-applying a ruling already in the file must be a no-op');
});

test('no move yet has two dated routes, so the earliest-wins guard is dormant', () => {
	// moveObtainableAt takes the MINIMUM dated route, because a TM sold in a
	// late department store and also lying on an early route is available from
	// the route. No row in the ledger currently exercises that: every move with
	// a date has exactly one distinct date, so flipping the min to a max
	// changes nothing and a test asserting "the earliest wins" would pass
	// against either. Saying that plainly beats a green assertion that proves
	// nothing — which is what the first version of this test was.
	//
	// What is pinned instead is the assumption. The day a move gains a second
	// dated route, this fails and the min() stops being dormant.
	const dated = {};
	for (const row of profile.oracle.moveItems()) {
		if (typeof row.opensAt !== 'number') continue;
		(dated[row.move] = dated[row.move] || new Set()).add(row.opensAt);
	}
	const multi = Object.keys(dated).filter(move => dated[move].size > 1);
	assert.deepEqual(multi, [],
		'a move now has two dated routes: ' + multi.join(', ') +
		' — the earliest-wins path in moveObtainableAt is live and needs a real test');
});

test('the advisor offers reachable TMs, and not the prize for the fight itself', () => {
	const doc = standingBefore('Leader Brawly');
	const advice = run.adviseUpgrades(doc, 'Leader Brawly');
	const teaches = (advice.upgrades || []).filter(row => row.kind === 'teach');

	assert.ok(advice.considered > 60,
		'the whole ledger should widen the candidate set, not a tenth of it: ' +
		advice.considered);
	assert.ok(teaches.length > 3,
		'teachable moves should reach the shortlist: ' + teaches.length);

	// The off-by-one. Seismic Toss is Brawly's reward at Brawly's own order, so
	// advising it for Brawly is advising a prize won by winning without it.
	assert.ok(!teaches.some(row => /Seismic Toss/.test(row.detail || '')),
		'a fight-reward TM must not be advice for the fight that rewards it');
});

test('and once that fight is beaten, its reward becomes advice', () => {
	// The complement, so the rule reads as timing and not as a blanket ban.
	const doc = standingBefore('Leader Roxanne');
	assert.ok(run.upcoming(doc, 1)[0].order > 77, 'the run is past Brawly');
	assert.equal(profile.oracle.moveObtainableAt('Seismic Toss'), 80);
	const advice = run.adviseUpgrades(doc, 'Leader Roxanne');
	assert.ok(advice.considered > 60, 'candidates: ' + advice.considered);
});

test('a trainer-anchored ruling derives its order from the label and refreshes stale prose', () => {
	// The Route 103 insertion audit's lesson: rulings written against LABELS
	// survived the map change untouched; the one written as a raw order (Smart
	// Strike, 53) had to be hand-shifted, and its prose froze at the old
	// numbers because the idempotence check compared only the number. Smart
	// Strike is now anchored to the trainer its why-prose always described,
	// and a ruled row whose prose has drifted gets it rewritten in place.
	const adopt = require('../scripts/adopt-availability.js');
	const clone = () => JSON.parse(JSON.stringify(
		require('../profiles/run-and-bun/oracle/availability.json')));

	const ruling = adopt.MOVE_DATE_RULINGS['Smart Strike'];
	assert.equal(ruling.anchorTrainer, 'Team Aqua Grunt Museum #1',
		'Smart Strike is anchored to the first fight past Route 110, by label');
	assert.equal(ruling.order, undefined, 'and carries no raw order to rot');

	// The label resolves through the live map, so the committed row agrees.
	const planner = require('../lib/planner');
	const museum = planner.loadRunMap('run-and-bun')
		.find(fight => fight.trainer === 'Team Aqua Grunt Museum #1');
	const row = clone().moveItems.find(entry => entry.move === 'Smart Strike');
	assert.equal(row.opensAt, museum.order);

	// A renamed anchor refuses, the same as a vanished map anchor.
	const renamed = clone();
	renamed.moveItems.find(entry => entry.move === 'Smart Strike').opensAt = null;
	const broken = Object.assign({}, ruling, {anchorTrainer: 'No Such Trainer'});
	const saved = adopt.MOVE_DATE_RULINGS['Smart Strike'];
	adopt.MOVE_DATE_RULINGS['Smart Strike'] = broken;
	try {
		assert.throws(() => adopt.applyMoveDateRulings(renamed),
			/names no fight of the run map/,
			'a rotted trainer label must refuse, not guess');
	} finally {
		adopt.MOVE_DATE_RULINGS['Smart Strike'] = saved;
	}

	// Frozen prose thaws: same order, stale correction text -> rewritten.
	const stale = clone();
	stale.moveItems.find(entry => entry.move === 'Smart Strike').correction = 'old words';
	const out = adopt.applyMoveDateRulings(stale);
	assert.ok(out.some(line => /Smart Strike.*prose/.test(line)),
		'the refresh is reported, not silent');
	assert.equal(stale.moveItems.find(entry => entry.move === 'Smart Strike').correction,
		ruling.why, 'and the row carries the ruling\'s current words');
});
