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
		// "New Mauville" is not Mauville: the same qualifiers the builder refuses.
		const place = new RegExp('(?<!\\b(?:New|Old|Near|Outside|Under)\\s)\\b' + item.location.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
		const hit = ledger.entries.find(entry => entry.name === item.name &&
			place.test(entry.location + ' ' + (entry.detail || '')));
		// A null is a withheld date, not a disagreement about the scale. Magnet
		// is not a pair at all: the workbook puts it in New Mauville, where
		// availability read it as Mauville — two places, so nothing to compare.
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
	// New Mauville is not Mauville: dating these four at Mauville offered them
	// 206 orders early. It holds no trainer of its own, so it was withheld —
	// until the builder learned to date a trainer-less place from the map
	// table (2026-09-21), where the R&B tracker's route order puts New
	// Mauville at 623. Later than Mauville, which is the point.
	const items = ledger.entries.filter(entry => /New Mauville/i.test(entry.location));
	// Five since the TM sheet was transcribed.
	assert.equal(items.length, 5, 'the workbook puts five items in New Mauville');
	for (const entry of items) {
		// A named guard outranks the place: TM10 is what Leader Wattson hands
		// over for fixing the generator, so it is dated by the fight, not by
		// New Mauville. Everything the text leaves to the place stays undated.
		if (entry.dating === 'the fight that guards it') {
			assert.ok(entry.opensAt > 0, entry.name + ' is dated by the fight that guards it');
			continue;
		}
		assert.equal(entry.opensAt, 623, entry.name + ' is dated by the map table\'s New Mauville, not by Mauville');
		assert.match(entry.dating, /no trainer stands there: the map table's date for New Mauville/);
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

test('the advisor prices from the same item ledger the run collects from', () => {
	// itemsObtainableBy read 28 curated rows while fieldItems served those
	// plus the dated ledger, so a run collected a Sitrus Berry the advisor
	// could not name: by Norman (order 337) 28 of 32 holdable pickups were
	// invisible to every Give and pickup row.
	const oracle = require('../profiles').getProfile('run-and-bun').oracle;
	const served = new Set(oracle.itemsObtainableBy(337).map(item => item.name));
	for (const name of ['Sitrus Berry', 'Muscle Band', 'Wise Glasses', 'Cheri Berry', 'Chesto Berry']) {
		assert.ok(served.has(name), name + ' is dated before Norman and the advisor can name it');
	}
	const collectable = oracle.fieldItems().filter(item => item.kind !== 'tm' &&
		Number.isInteger(item.opensAt) && item.opensAt <= 337);
	for (const item of collectable) assert.ok(served.has(item.name), item.name + ' is collectable, so priceable');
	assert.equal(served.size, oracle.itemsObtainableBy(337).length, 'one row a name');
	assert.ok(!served.has('Life Orb'), 'and nothing dated after the fight (Life Orb is 683)');
});

test('every TM and tutor is dated from Run & Bun\'s own sources, and the two ledgers\' disagreements are known', () => {
	const builder = require('../scripts/build-item-locations.js');
	const written = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'profiles', 'run-and-bun', 'oracle', 'move-dates.json'), 'utf8'));
	assert.deepEqual(builder.moveDates(), written, 'move-dates.json has drifted from its builder: node scripts/build-item-locations.js');

	const oracle = require('../profiles').getProfile('run-and-bun').oracle;
	const rows = oracle.moveItems();
	// One row waits on the operator: no hack source says where the Fossil Maniac's house is.
	assert.deepEqual(rows.filter(row => row.opensAt === null).map(row => row.move), ['Earth Power']);
	const at = move => rows.find(row => row.move === move).opensAt;
	// The author writes a gate when there is one. Vanilla Emerald put these two
	// wrong: Sludge Bomb behind Norman's badge (342), Route 111's TMs behind
	// Flannery's Go-Goggles (576) — his own Route 111 trainers stand at 190-392.
	assert.equal(at('Sludge Bomb'), 32, 'Dewford Town Hall, no gate written');
	assert.equal(at('Aerial Ace'), 392);
	assert.equal(at('Dual Wingbeat'), 392);
	assert.equal(at('Psychic'), 1131, 'Leaders Tate & Liza: the plural hid it');
	assert.deepEqual(['Avalanche', 'Frost Breath', 'Breaking Swipe', 'Heal Pulse'].map(at), [1183, 1183, 1183, 1183],
		'Shoal Cave is five rooms, and the latest dates them all');
	assert.deepEqual(['Surf', 'Fly', 'Dive'].map(at), [594, 729, 1183], 'the HM story spine');
	// A row the TM ledger dates itself STANDS — transcribed, or corrected from play.
	const own = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'profiles', 'run-and-bun', 'oracle', 'availability.json'), 'utf8')).moveItems;
	for (const row of own.filter(entry => entry.opensAt !== null)) assert.equal(at(row.move), row.opensAt, row.move + ' keeps its own date');

	// Where BOTH date a row they disagree on these, and the builder is not the
	// better of the two on all of them (Defog: "given by Steven at Granite
	// Cave", dated by Steven's Space Center fight). Pinned, so a new one is seen.
	const built = new Map(written.entries.map(entry => [entry.move, entry.opensAt]));
	const differ = own.filter(row => row.opensAt !== null && typeof built.get(row.move) === 'number' && built.get(row.move) !== row.opensAt)
		.map(row => row.move).sort();
	// 31 of them. 25 are the builder running a few orders TIGHTER through its
	// denser anchors (Mt. Pyre 866 v 871), which is the safe direction for the
	// ledger that stands. Two are the builder's own misreads (Defog, above; Icy
	// Wind dated by "sold at Lilycove"). Two are corrections from play. And
	// three are the ones worth an operator's look, because there the ledger
	// that STANDS is the earlier: Feint Attack 14 v 93 (the Floral Shop is in
	// Route 104's north half), Hyper Voice 211 v 287 and Night Shade 211 v 235
	// (both "requires a Bike").
	assert.deepEqual(differ, ['Blizzard', 'Brick Break', 'Curse', 'Dark Pulse', 'Defog', 'Draining Kiss', 'Earthquake', 'Explosion',
		'Fake Tears', 'Feint Attack', 'Fire Blast', 'Fire Punch', 'Hydro Pump', 'Hyper Voice', 'Ice Punch', 'Icy Wind', 'Life Dew',
		'Me First', 'Night Shade', 'Play Rough', 'Poison Jab', 'Rock Blast', 'Shadow Ball', 'Shadow Punch', 'Smart Strike', 'Swagger',
		'Tailwind', 'Thunder', 'Thunder Punch', 'Weather Ball', 'Will-O-Wisp']);
});

test('the author hands out no screen: no TM, HM or tutor teaches Reflect, Light Screen or Aurora Veil', () => {
	// ledger: the-screen-tms-are-not-sourced. The moveItems table has no row for
	// any screen, and that was read as a missing source. It is not: the author's
	// TMHMs and Move Tutors sheet (Item Locations.xlsx, transcribed verbatim in
	// item-workbook.json) numbers TM01-TM50 and HM01-HM08 with no gap, and
	// lists twenty tutors, and none of them is a screen. In Run & Bun a screen
	// comes from a level-up list or not at all.
	//
	// "Or not at all" includes egg moves, and that is checked below, not
	// assumed. Egg moves ARE reachable here: learnsets.json carries the
	// decomp's egg_moves.h, and the nurse remembers one for a Heart Scale
	// (ruling remembering-a-move-costs-a-scale). The hack's own documents say
	// nothing of breeding — Mechanic Changes.txt names the Day Care only for
	// experience past the cap. No egg list holds a screen: the five hits a
	// substring search finds (Gastly, Omanyte, Castform, both Stunfisk) are
	// Reflect Type, which is not Reflect.
	const workbook = require('../profiles/run-and-bun/oracle/item-workbook.json');
	const numbered = prefix => workbook.tms.map(row => row.name.match(new RegExp('^' + prefix + '(\\d\\d) ')))
		.filter(Boolean).map(match => Number(match[1]));
	const tms = numbered('TM');
	const hms = numbered('HM');
	assert.deepEqual(tms, Array.from({length: 50}, (unused, index) => index + 1), 'TM01-TM50, each once, none missing');
	assert.deepEqual(hms, [1, 2, 3, 4, 5, 6, 7, 8], 'HM01-HM08');
	assert.equal(workbook.tms.length, 50 + 8 + 1, 'and the sheet\'s second header row, nothing else');
	assert.equal(workbook.tutors.length, 20);

	const screens = /reflect|light screen|aurora veil/i;
	assert.deepEqual(workbook.tms.concat(workbook.tutors).filter(row => screens.test(JSON.stringify(row))), []);
	const oracle = require('../profiles').getProfile('run-and-bun').oracle;
	assert.deepEqual(oracle.moveItems().filter(row => screens.test(row.move)), [],
		'so the moveItems table has no screen row, and that is the game');

	// Exact names: a pattern would read Reflect Type as Reflect.
	const learnsets = require('../profiles/run-and-bun/oracle/learnsets.json');
	const SCREENS = ['Reflect', 'Light Screen', 'Aurora Veil'];
	const holding = table => Object.keys(table).filter(species =>
		table[species].some(move => SCREENS.includes(Array.isArray(move) ? move[1] : move)));
	assert.deepEqual(holding(learnsets.egg), [], 'no egg list teaches a screen');
	assert.deepEqual(holding(learnsets.teachable), [], 'nor does any teachable list');
	assert.ok(holding(learnsets.levelUp).length > 0, 'the level-up lists are where the screens are');
});

test('a cell that names a shop and a gift is two rows, and the gift is on the road', () => {
	// ledger: evolution-stones-have-prose-where-a-place-should-be. The one
	// non-shop place left on the Evolution Items sheet is inside a shop's
	// cell: "Sold at Mauville City Pokémon Mart. Given 1x from NPC Cutter in
	// Rustboro City." Read whole, it was the shop's alone and the gift was
	// never offered.
	assert.deepEqual(builder.splitSources('Sold at Mauville City Pokémon Mart. Given 1x from NPC Cutter in Rustboro City.'),
		['Sold at Mauville City Pokémon Mart.', 'Given 1x from NPC Cutter in Rustboro City.']);
	assert.deepEqual(builder.splitSources('Granite Cave, ice floor, at the \'L\' shaped rock formation before the stairs (hidden).'),
		['Granite Cave, ice floor, at the \'L\' shaped rock formation before the stairs (hidden).']);

	const moon = ledger.entries.filter(entry => entry.name === 'Moon Stone');
	assert.deepEqual(moon.map(entry => [entry.location, entry.opensAt]), [
		['Given 1x from NPC Cutter in Rustboro City.', 106],
		['Sold at Mauville City Pokémon Mart.', 209],
	]);
	const oracle = require('../profiles').getProfile('run-and-bun').oracle;
	assert.ok(oracle.fieldItems().some(row => row.name === 'Moon Stone' && row.opensAt === 106),
		'the gift is a field item from Rustboro');
	assert.ok(oracle.shopItems().some(row => row.name === 'Moon Stone' && row.opensAt === 209), 'and the mart still sells it');
	// Every evolution row now names one place, or one shop.
	const evolution = ledger.entries.filter(entry => entry.kind === 'evolution');
	assert.equal(evolution.length, 24);
	assert.deepEqual(evolution.filter(entry => entry.opensAt === null), []);
});

test('every item cell that names a second source is split, not only the evolution sheet', () => {
	// review 2026-09-22: the split ran for Evolution Items alone, and the
	// Berries sheet has the same shape — "Berry Trees at Routes 114, 116.
	// Given 10x from an NPC at Route 104." — which dated 93 only because the
	// gift's route opens before the trees'. Read on the builder's output, so
	// a builder that stops splitting fails here before anything is written.
	const built = builder.build();
	const joined = built.entries.filter(entry => entry.kind !== 'tm' &&
		builder.splitSources(entry.location).length > 1);
	assert.deepEqual(joined.map(entry => entry.name + ': ' + entry.location), [],
		'these rows still read two sources as one place');
	const chesto = built.entries.filter(entry => entry.name === 'Chesto Berry');
	assert.deepEqual(chesto.map(entry => [entry.location, entry.detail, entry.opensAt]), [
		['Given 10x from an NPC at Route 104.', null, 93],
		['Berry Trees at Routes 114, 116.', '30 to 90.', 445],
	], 'the gift is its own row, and the trees keep the yield column');
	// And the trees are dated: a list with no "and" is still a list. The
	// first route named dates a tree, as for Oran Berry, so 114 (445).
	assert.equal(chesto[1].dating, 'the first of the places it names');
	// The TMs keep their one row: oracle.tmFor and audit-run key one row a TM
	// and read "Sold at" in it as "re-sold". Split, the Lilycove row (848)
	// would overwrite Seismic Toss's field date of 80.
	const toss = built.entries.filter(entry => entry.name === 'TM16 Seismic Toss');
	assert.deepEqual(toss.map(entry => entry.opensAt), [80]);
	assert.match(toss[0].location, /Sold at Lilycove/);
});

test('the ledger cites the hack\'s official Item Locations workbook', () => {
	// review 2026-09-22: `source` named the engine's copy under
	// engines/rab/backend/DOCS. Its worksheets and shared strings are
	// byte-identical to docs/official's, but data here is cited from the
	// hack's own documents, and the official folder is where they live.
	for (const doc of [builder.build(), ledger]) {
		assert.match(doc.source, /^pokemon-mono docs\/official\/Item Locations\.xlsx\b/);
		assert.doesNotMatch(doc.source, /engines\/rab/);
	}
});
