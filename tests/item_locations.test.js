/* eslint-env node, es6 */
'use strict';

/**
 * Gate for the field-item ledger.
 *
 * The ledger exists because `availability.json` carried 28 items where the
 * engine's own workbook carries 235, and three whole categories were absent —
 * Heart Scales, Rare Candies and Mega Stones. The Heart Scales were the
 * expensive gap: the relearner charges one for an egg move and no shop sells
 * them, so with none in the ledger every egg move in the game was unreachable,
 * 56 of 171 teachable moves across six mid-run species.
 *
 * What this gate protects is not the count but the DIRECTION of error. A date
 * that is too late costs the player an option. A date that is too EARLY makes
 * the advisor recommend an item the run cannot fetch, which is the failure the
 * whole ledger exists to prevent — so the HM floor below is the assertion that
 * matters most.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const ledger = require('../profiles/run-and-bun/oracle/item-locations.json');
const availability = require('../profiles/run-and-bun/oracle/availability.json');
const run = require('../lib/run');

test('no item is dated before an HM its own prose says it requires', () => {
	// The bug this caught: seventeen of the nineteen entries stating a
	// requirement were dated at the first trainer of their PLACE, ignoring the
	// water between. Pidgeotite on Route 105 read as order 30 when Surf does
	// not arrive until 589; Water Gem read 179 against Dive at 1178.
	const gates = availability.hmMoves;
	const early = [];
	for (const entry of ledger.entries) {
		if (entry.opensAt === null) continue;
		const text = entry.location + ' ' + (entry.detail || '');
		const needed = Object.keys(gates)
			.filter(move => new RegExp('requires?\\s+(the\\s+)?' + move, 'i').test(text));
		if (!needed.length) continue;
		const floor = Math.max.apply(null, needed.map(move => gates[move]));
		if (entry.opensAt < floor) {
			early.push(entry.name + ' at ' + entry.opensAt + ' needs ' +
				needed.join('+') + ' at ' + floor);
		}
	}
	assert.deepEqual(early, [],
		'these would be recommended before the run can reach them');
});

test('every date lands on a real fight of the run map', () => {
	const doc = run.createRun({
		name: 'items', now: 't0', levelCap: 'next-milestone-ace',
		permadeath: false, onePerRoute: false,
	});
	// An order past the end of the road is the signature of a number written in
	// trainer counts rather than run-map order — the same confusion that made
	// "opens at fight #77" wrong elsewhere in this repository.
	for (const entry of ledger.entries) {
		if (entry.opensAt === null) continue;
		assert.ok(run.trainerIndexOf(doc, entry.opensAt) !== null,
			entry.name + ' is dated ' + entry.opensAt + ', which is off the end of the road');
	}
});

test('the categories that were entirely missing are present and dated', () => {
	const kinds = {};
	for (const entry of ledger.entries) {
		kinds[entry.kind] = kinds[entry.kind] || {total: 0, dated: 0};
		kinds[entry.kind].total += 1;
		if (entry.opensAt !== null) kinds[entry.kind].dated += 1;
	}
	for (const kind of ['heart-scale', 'rare-candy', 'mega-stone', 'held', 'berry', 'evolution']) {
		assert.ok(kinds[kind] && kinds[kind].total > 0, kind + ' is missing from the ledger');
	}
	assert.equal(kinds['heart-scale'].total, 30, 'the workbook lists 30 Heart Scales');
	assert.ok(kinds['heart-scale'].dated >= 25,
		'most Heart Scales must be dated or egg moves stay unreachable');
});

test('a Heart Scale is reachable before Brawly, which is what unlocks egg moves', () => {
	// The whole point. Brawly is order 77; a Heart Scale at order 30 means a
	// run can relearn an egg move before the first wall it actually loses to.
	const early = ledger.entries.filter(entry =>
		entry.kind === 'heart-scale' && entry.opensAt !== null && entry.opensAt <= 77);
	assert.ok(early.length > 0,
		'no Heart Scale before Brawly means the egg movepool is still dead for that fight');
});

test('an ambiguous place takes the LATER of its candidates, never the earlier', () => {
	// The rule availability.json states as "late-biased, never early", and the
	// one assertion that catches it being reversed. The trainer database splits
	// Route 104 into South at order 7 and North at 30, while the workbook says
	// only "Route 104"; the item may be in either half, so 30 is the only
	// answer that cannot promise something the run has not reached.
	//
	// This exists because the first version of this gate did NOT catch the flip.
	// Early-bias dates the Route 104 Heart Scale at 7 instead of 30, and every
	// other assertion here still passed: 7 is a real fight order and still
	// before Brawly, so nothing noticed the rule had inverted.
	const scale = ledger.entries.find(entry =>
		entry.kind === 'heart-scale' && entry.location === 'Route 104');
	assert.ok(scale, 'Route 104 carries a Heart Scale in the workbook');
	assert.equal(scale.opensAt, 30,
		'Route 104 splits 7/30 in the trainer database; late-bias must take 30');
});

test('every entry says which evidence dated it, or that nothing did', () => {
	for (const entry of ledger.entries) {
		assert.ok(typeof entry.dating === 'string' && entry.dating.length > 0,
			entry.name + ' carries no account of how it was dated');
		if (entry.opensAt === null) {
			assert.match(entry.dating, /unavailable|no trainer or known place/,
				'an undated entry must say why, not merely be blank');
		}
	}
});
