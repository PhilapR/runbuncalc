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
const estimate = require('../scripts/estimate-availability.js');

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
	// Leader Brawly is engine row 28 and run-map order 80 — lib/run.js says so
	// outright, and AGENTS.md documents the two scales. If this ever returns 28
	// the builder is publishing engine indexes again.
	assert.equal(builder.scaleBridge()(28), 80);
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
	// This asked `trainerIndexOf(doc, opensAt) !== null` and proved nothing.
	// lib/run.js:687 snaps FORWARD to the first fight at or after the value, so
	// the assertion was a bounds check on [0, 1625]: all 366 trainer numbers
	// passed, and so did all 435 engine row indexes — the exact scale this
	// ledger shipped by mistake. Against the buggy ledger at d1a2d52 it stayed
	// green on 164 of 164 dated rows.
	//
	// Membership in the 366 real orders is the question. It catches 103 of
	// those 164 historical rows.
	const orders = new Set(estimate.fightOrders());
	assert.equal(orders.size, 366, 'the run map is 366 fights');
	for (const entry of ledger.entries) {
		if (entry.opensAt === null) continue;
		assert.ok(orders.has(entry.opensAt),
			entry.name + ' is dated ' + entry.opensAt + ', which is not any fight of the run map');
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
	// The whole point. Brawly is order 80, and Route 106 carries a Heart Scale
	// at 22, so a run can relearn an egg move before the first wall it loses to.
	const early = ledger.entries.filter(entry =>
		entry.kind === 'heart-scale' && entry.opensAt !== null && entry.opensAt <= 80);
	assert.ok(early.length > 0,
		'no Heart Scale before Brawly means the egg movepool is still dead for that fight');
});

test('an ambiguous place takes the LATER of its sections, never the earlier', () => {
	// Late-bias, the rule availability.json states as "never early". The engine
	// splits Route 104 into South at run-map 14 and North at 93 while the
	// workbook says only "Route 104"; the item may be in either half, so 93 is
	// the only answer that cannot promise something unreached.
	//
	// This assertion exists because the first version of this gate did not
	// catch the flip: early-bias dated it 14, and every other assertion still
	// passed, because 11 is a real fight order and still before Brawly.
	const scale = ledger.entries.find(entry =>
		entry.kind === 'heart-scale' && entry.location === 'Route 104');
	assert.ok(scale, 'Route 104 carries a Heart Scale in the workbook');
	assert.equal(scale.opensAt, 93,
		'Route 104 splits 14/93 in the trainer database; late-bias must take 93');
});

test('an optional fight group does not date a place that has its own fights', () => {
	// "(Optionals)" is the engine's bucket for optional trainers, not a place.
	// They stand where the route already was, so Route 106 opens at its own
	// first fight, 25, and not at its optional group, 606 — which would have
	// withheld the earliest Heart Scale in the game and put it past Brawly.
	const scale = ledger.entries.find(entry =>
		entry.kind === 'heart-scale' && /^Route 106\b/.test(entry.location));
	assert.ok(scale, 'Route 106 carries a Heart Scale in the workbook');
	assert.equal(scale.opensAt, 25, 'Route 106 opens at 25; its optional group is 606');
});

test('the first place the prose names is the one that dates the item', () => {
	// Late-bias belongs inside a place, not across places. "Berry Trees at
	// Routes 102, 104 and 111" means the tree grows on all three, so reaching
	// the first is enough — taking the latest read 387 for a berry that
	// availability.json had long dated 0, and withheld the workhorse Sitrus
	// Berry until 804 when it grows on Route 110 at 230.
	const oran = ledger.entries.find(entry => entry.name === 'Oran Berry');
	assert.ok(oran, 'the workbook lists an Oran Berry');
	assert.equal(oran.opensAt, 3, 'Oran Berry grows on Route 102, whose first fight is order 3');
	const sitrus = ledger.entries.find(entry => entry.name === 'Sitrus Berry');
	assert.equal(sitrus.opensAt, 235, 'Sitrus Berry grows on Route 110, which is order 235');
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

test('the anchors the builder documents are the anchors it computes', () => {
	// The docstring is where a future editor looks for these numbers, and it is
	// not executable, so it drifts. It carried 7 / 30 / 11 / 166 — the ENGINE
	// row indexes — through the commit that fixed the scale everywhere else,
	// because that fix corrected the `method` string and not the prose above it.
	//
	// Exporting them makes the prose checkable. Any number a builder's comment
	// quotes as an order should be a constant this suite also asserts.
	const toRunMap = builder.scaleBridge();
	const trainers = builder.engineTrainers();
	const engine = new Map();
	for (const trainer of trainers) {
		const at = engine.get(trainer.location);
		if (at === undefined || trainer.order < at) engine.set(trainer.location, trainer.order);
	}
	for (const place of Object.keys(builder.ANCHORS)) {
		assert.ok(engine.has(place), place + ' is not a place the engine names');
		assert.equal(toRunMap(engine.get(place)), builder.ANCHORS[place],
			place + ' does not open when the builder docstring says it does');
	}
	// And the two the ledger actually turns on.
	assert.equal(builder.ANCHORS['Route 104 (North)'], 93);
	assert.equal(builder.ANCHORS['Route 106'], 25);
});

test('the badge ladder has eight rungs and the seventh is Liza, not Tate', () => {
	// It was derived by counting `/^Leader/` fights, which gives NINE: Tate and
	// Liza are two Leader-labelled fights at one gym for one badge. The index
	// slipped from badge 7 on, so "8 badges" resolved to 1130 — Liza — instead
	// of Juan at 1369, 234 orders early. The bound accepted "9 badges" too, a
	// count Hoenn does not have.
	//
	// Latent when found: no workbook row names more than three badges, and
	// badges[2] = 229 was right. Gated because the next workbook might.
	const badges = builder.badgeOrders();
	assert.equal(badges.length, 8, 'Hoenn has eight badges');
	assert.deepEqual(badges, [80, 142, 229, 342, 576, 763, 1135, 1369]);
	// The one the workbook actually uses today.
	assert.equal(badges[2], 229, '"requires 3 badges" is Wattson');
});

test('every mega stone resolves against the calc item table', () => {
	// One of 47 did not: the workbook spells Camerupt's stone `Cameruptitte`.
	// The typo is upstream's — `unzip -p "Item Locations.xlsx"
	// xl/sharedStrings.xml` returns `<t>Cameruptitte</t>` — so it is corrected
	// on the way out and item-workbook.json stays a verbatim transcription.
	//
	// Deliberately NOT extended to evolution items: `Everstone` and `Honey` are
	// spelled correctly and are legitimately absent from the battle-item table.
	const Calc = require('../calc/dist/data/index.js');
	const gen = Calc.Generations.get(8);
	const missing = [];
	for (const entry of ledger.entries) {
		if (entry.kind !== 'mega-stone') continue;
		const key = entry.name.toLowerCase().replace(/[^a-z0-9]/g, '');
		let item = null;
		try {
			item = gen.items.get(key);
		} catch (error) {
			item = null;
		}
		if (!item) missing.push(entry.name);
	}
	assert.deepEqual(missing, [], 'these mega stones cannot be looked up by name');
	assert.equal(builder.NAME_FIXES.Cameruptitte, 'Cameruptite');
});
