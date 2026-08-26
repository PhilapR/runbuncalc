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
 * whole ledger exists to prevent.
 *
 * THE FIRST VERSION OF THIS FILE DID NOT PROTECT THAT. It asserted the HM
 * floor, the category counts, and that every date was a real fight order — and
 * every one of those passed while 160 of 164 dates were too early, because the
 * builder published engine row indexes (0-434) into a field that means run-map
 * order (0-1620). An engine index IS a real run-map order. It is just a
 * different fight.
 *
 * The assertion that catches it is the one that was missing: this ledger and
 * availability.json are INDEPENDENT imports of overlapping items, so where
 * they both name an item at a place they must land in the same scale. Under
 * the bug Soft Sand read 185 here and 29 there. That test is first below.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const builder = require('../scripts/build-item-locations.js');
const ledger = require('../profiles/run-and-bun/oracle/item-locations.json');
const availability = require('../profiles/run-and-bun/oracle/availability.json');
const run = require('../lib/run');

/** Items availability.json and the ledger both carry, matched on the name and
 * on availability's place appearing in the ledger's prose. */
function overlap() {
	const pairs = [];
	for (const item of availability.items) {
		const place = new RegExp('\\b' + item.location.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
		const hit = ledger.entries.find(entry => entry.name === item.name &&
			place.test(entry.location + ' ' + (entry.detail || '')));
		// A null is a withheld date, not a disagreement about the scale. The one
		// that occurs is Magnet: the workbook puts it in New Mauville, which
		// holds no trainer, where availability read it as Mauville.
		if (hit && hit.opensAt !== null) pairs.push({item: item, entry: hit});
	}
	return pairs;
}

test('the ledger and availability.json agree about which order scale this is', () => {
	// Two independent imports of the same game. They need not agree to the
	// fight — each dates a place by the first anchor at or after it, and this
	// ledger has the denser anchor set, so it is allowed to be slightly tighter.
	// They must agree about the SCALE, and a wrong scale is not a near miss:
	// under the bug these pairs were out by 538%, 71% and 72%.
	const pairs = overlap();
	assert.ok(pairs.length >= 4, 'nothing overlaps, so this gate is not checking anything');
	const wrong = [];
	for (const pair of pairs) {
		const drift = Math.abs(pair.entry.opensAt - pair.item.opensAt) /
			Math.max(1, pair.item.opensAt);
		if (drift > 0.05) {
			wrong.push(pair.item.name + ' at ' + pair.item.location + ': ledger ' +
				pair.entry.opensAt + ', availability ' + pair.item.opensAt);
		}
	}
	assert.deepEqual(wrong, [], 'these two files are not counting the same thing');
});

test('the scale bridge anchors on a fight both databases name', () => {
	// Leader Brawly is engine row 28 and run-map order 77 — lib/run.js says so
	// outright, and AGENTS.md documents the two scales. If this ever returns 28
	// the builder is publishing engine indexes again.
	assert.equal(builder.scaleBridge()(28), 77);
});

test('the committed ledger is what the builder produces', () => {
	// Every input is pinned — the workbook is transcribed into the repository,
	// the trainer database comes from the sha-checked vendored runtime, and the
	// scale bridge is trainer-orders.json, which has its own gate. So this must
	// regenerate exactly or something underneath it moved.
	const built = builder.build();
	assert.equal(built.counted, ledger.counted);
	assert.equal(built.dated, ledger.dated);
	assert.deepEqual(built.entries, ledger.entries, 'the ledger has drifted from its source');
});

test('no item is dated before a gate its own prose names', () => {
	// The workbook states a dependency two ways — "(requires Waterfall)" and
	// "Up the Waterfall northwest of the route" gate the same HM — so this
	// reads the move name anywhere in the text, and takes ALL the moves named:
	// "requires Surf and Waterfall" is Waterfall's floor, not Surf's.
	const gates = availability.hmMoves;
	const early = [];
	for (const entry of ledger.entries) {
		if (entry.opensAt === null) continue;
		const text = entry.location + ' ' + (entry.detail || '');
		const needed = Object.keys(gates)
			.filter(move => new RegExp('\\b' + move + '\\b', 'i').test(text));
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
	// The whole point. Brawly is order 77, and Route 106 carries a Heart Scale
	// at 22, so a run can relearn an egg move before the first wall it loses to.
	const early = ledger.entries.filter(entry =>
		entry.kind === 'heart-scale' && entry.opensAt !== null && entry.opensAt <= 77);
	assert.ok(early.length > 0,
		'no Heart Scale before Brawly means the egg movepool is still dead for that fight');
});

test('an ambiguous place takes the LATER of its sections, never the earlier', () => {
	// Late-bias, the rule availability.json states as "never early". The engine
	// splits Route 104 into South at run-map 11 and North at 90 while the
	// workbook says only "Route 104"; the item may be in either half, so 90 is
	// the only answer that cannot promise something unreached.
	//
	// This assertion exists because the first version of this gate did not
	// catch the flip: early-bias dated it 11, and every other assertion still
	// passed, because 11 is a real fight order and still before Brawly.
	const scale = ledger.entries.find(entry =>
		entry.kind === 'heart-scale' && entry.location === 'Route 104');
	assert.ok(scale, 'Route 104 carries a Heart Scale in the workbook');
	assert.equal(scale.opensAt, 90,
		'Route 104 splits 11/90 in the trainer database; late-bias must take 90');
});

test('an optional fight group does not date a place that has its own fights', () => {
	// "(Optionals)" is the engine's bucket for optional trainers, not a place.
	// They stand where the route already was, so Route 106 opens at its own
	// first fight, 22, and not at its optional group, 601 — which would have
	// withheld the earliest Heart Scale in the game and put it past Brawly.
	const scale = ledger.entries.find(entry =>
		entry.kind === 'heart-scale' && /^Route 106\b/.test(entry.location));
	assert.ok(scale, 'Route 106 carries a Heart Scale in the workbook');
	assert.equal(scale.opensAt, 22, 'Route 106 opens at 22; its optional group is 601');
});

test('the first place the prose names is the one that dates the item', () => {
	// Late-bias belongs inside a place, not across places. "Berry Trees at
	// Routes 102, 104 and 111" means the tree grows on all three, so reaching
	// the first is enough — taking the latest read 387 for a berry that
	// availability.json had long dated 0, and withheld the workhorse Sitrus
	// Berry until 804 when it grows on Route 110 at 230.
	const oran = ledger.entries.find(entry => entry.name === 'Oran Berry');
	assert.ok(oran, 'the workbook lists an Oran Berry');
	assert.equal(oran.opensAt, 0, 'Oran Berry grows on Route 102, which is order 0');
	const sitrus = ledger.entries.find(entry => entry.name === 'Sitrus Berry');
	assert.equal(sitrus.opensAt, 230, 'Sitrus Berry grows on Route 110, which is order 230');
});

test('a qualified place is not the place it is named after', () => {
	// New Mauville is not Mauville. It holds no trainer of its own, so the
	// ledger's own rule — a place with no trainer is withheld — applies, and
	// dating these four at Mauville offered them 206 orders early.
	const items = ledger.entries.filter(entry => /New Mauville/i.test(entry.location));
	assert.equal(items.length, 4, 'the workbook puts four items in New Mauville');
	for (const entry of items) {
		assert.equal(entry.opensAt, null,
			entry.name + ' is in New Mauville, which has no fight to date it');
	}
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
