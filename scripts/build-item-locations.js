#!/usr/bin/env node
/* eslint-env node, es6 */
'use strict';

/**
 * Build the field-item ledger from the engine's own Item Locations workbook.
 *
 * `availability.json` carried 28 items where the workbook carries 235, and
 * three whole categories were absent:
 *
 *     held items and berries   121 upstream,  25 carried,  96 missing
 *     Heart Scales              30 upstream,   0 carried,  all missing
 *     Rare Candies              14 upstream,   0 carried,  all missing
 *     Mega Stones               47 upstream,   0 carried,  all missing
 *
 * The Heart Scales matter beyond their own row. The relearner charges one for
 * an egg move and no shop sells them, so with none in the ledger every egg
 * move in the game is unreachable — 56 of 171 teachable moves across six
 * mid-run species, 32.7% of the movepool. `heartScale` also sets an IV to 31,
 * so that play was unavailable too.
 *
 * TWO ORDER SCALES, AND THIS FILE PUBLISHES THE SECOND ONE. The engine
 * database numbers its own rows 0-434; this repository's `order` counts
 * cumulative enemy Pokemon and runs 0-1620. Leader Brawly is engine row 28 and
 * run-map order 77. `opensAt` is a RUN-MAP order, so every engine number is
 * translated before it is published — see AGENTS.md, "Two order scales".
 *
 * The first version of this builder skipped that step and shipped engine row
 * indexes under a `method` string that claimed run-map order. 160 of its 164
 * dated rows were too early, by 591 on average and 1149 at worst, and no gate
 * caught it: an engine index is a perfectly valid run-map order, just the
 * wrong one. `availability.json` had carried both numbers side by side for
 * every item the whole time — Soft Sand, Route 109, `rabMinOrder 13`,
 * `opensAt 29` — and that contradiction is the cheapest way to see the bug.
 *
 * DATING. An item is only useful to the advisor once it can say WHEN the run
 * can have it, and the workbook gives prose, not orders: "Route 126, guarded
 * by Triathlete Pablo (requires Dive)." Four signals, strongest first.
 *
 *   1. A STATED REQUIREMENT is a hard floor under everything else. It is read
 *      from the words rather than from a `requires` clause, because the
 *      workbook states a dependency both ways — "(requires Waterfall)" and
 *      "Up the Waterfall northwest of the route" gate the same HM. All the
 *      moves named count, not the first: "requires Surf and Waterfall" is
 *      Waterfall's floor, not Surf's. A badge count is a floor of the same
 *      kind, since "requires 3 badges" is the third leader's order.
 *   2. A NAMED TRAINER. "guarded by Triathlete Pablo" is direct evidence: the
 *      item sits behind that fight. Two trainers share a name ten times over,
 *      so the one at the place the prose names wins, and otherwise the later.
 *   3. NAMED PLACES, late-biased across all of them, and expanded through
 *      "Routes 110 and 112".
 *   4. "Unavailable" said outright, which is a fact rather than a gap.
 *
 * WHICH FIGHT DATES A PLACE. The engine splits some places into variants and
 * they are not all the same kind of thing. "Route 104 (South)" and "(North)"
 * are two halves of one route — run-map 11 and 90 — and a bare "Route 104" in
 * the workbook may mean either, so the later one is the only answer that
 * cannot promise something unreachable. "(Optionals)" is not a place at all —
 * it is the engine's bucket for optional fights, which stand where the route
 * already was, so Route 106 opens at its own first fight (22) and not at its
 * optional group (601). Where a route has ONLY an optional group the group is
 * still the best evidence there is, so it is used. A parenthetical naming a
 * building is a different place: "Route 110 (Trick House Door)" is one joke
 * fight behind a door and does not date Route 110.
 *
 * Every number in that paragraph is a RUN-MAP order, and they are exported as
 * `ANCHORS` so the gate asserts the same values this prose quotes. The first
 * draft wrote 7, 30, 11 and 166 — the engine row indexes — and when the scale
 * bug was fixed the `method` string was corrected and this docstring was not.
 * It is the one place a future editor looks for these anchors.
 *
 * A place with no trainer at all is dated `null` and withheld, not guessed —
 * the same treatment the 22 undated TMs get, and for the same reason: a guess
 * is worse than a gap.
 *
 * Every input is pinned: the workbook is transcribed into item-workbook.json,
 * the trainer database comes from the sha-checked vendored runtime, and the
 * scale bridge is trainer-orders.json, which has its own gate.
 * `tests/item_locations.test.js` rebuilds this and fails on drift.
 */

const fs = require('node:fs');
const path = require('node:path');

const runtime = require('@philapr/pokemon-run-runtime');
const planner = require('../lib/planner');

const ROOT = path.join(__dirname, '..');
const ORACLE = path.join(ROOT, 'profiles', 'run-and-bun', 'oracle');
const OUT = path.join(ORACLE, 'item-locations.json');
const WORKBOOK = path.join(ORACLE, 'item-workbook.json');

const PROFILE = 'run-and-bun';

/**
 * The run-map orders the docstring above quotes, so the two drift together.
 * Asserted in tests/item_locations.test.js against the built index.
 */
const ANCHORS = {
	'Route 104 (South)': 11,
	'Route 104 (North)': 90,
	'Route 106': 22,
	'Route 106 (Optionals)': 601,
};

/**
 * Names the workbook spells differently from the item table, corrected on the
 * way OUT so item-workbook.json stays a verbatim transcription.
 *
 * The typo is upstream's: `unzip -p "Item Locations.xlsx" xl/sharedStrings.xml`
 * returns `<t>Cameruptitte</t>`. It is the sole failure of 47 mega stones
 * against the calc item table, and it costs a lookup rather than a date.
 */
const NAME_FIXES = {
	Cameruptitte: 'Cameruptite',
};

/** The engine's own trainer rows, from the vendored runtime rather than a
 * scratch dump, so a rebuild is reproducible. */
function engineTrainers() {
	const resolve = runtime.createRabRunRuntimeProvider({}).options.resolveTrainer;
	const rows = [];
	for (let order = 0; order <= 434; order += 1) {
		let trainer;
		try {
			trainer = resolve(order);
		} catch (error) {
			continue;
		}
		if (!trainer || !trainer.location || typeof trainer.order !== 'number') continue;
		rows.push({name: String(trainer.name || ''), location: String(trainer.location),
			order: trainer.order});
	}
	if (rows.length < 400) throw new Error(`engine trainer table looks wrong: ${rows.length} rows`);
	return rows;
}

/**
 * Engine row index -> run-map order.
 *
 * trainer-orders.json already reconciles the two databases fight by fight, so
 * the bridge is a lookup rather than a heuristic. An engine row with no anchor
 * of its own translates through the first anchor AT OR AFTER it, which is an
 * upper bound: sparsity can only push a date later, and later is the safe side
 * of "can the run reach this yet". Same rule as scripts/import-availability.js.
 */
function scaleBridge() {
	const map = JSON.parse(fs.readFileSync(path.join(ORACLE, 'trainer-orders.json'), 'utf8'));
	const ours = new Map();
	for (const fight of planner.listFights(PROFILE).fights) {
		ours.set(String(fight.trainer).toLowerCase(), fight.order);
	}
	const anchors = [];
	for (const entry of map.entries) {
		const our = ours.get(String(entry.trainer).toLowerCase());
		if (our === undefined) continue;
		anchors.push({engine: entry.order, our: our});
	}
	anchors.sort((a, b) => a.engine - b.engine);
	if (anchors.length < 300) throw new Error(`too few anchors to translate: ${anchors.length}`);
	return engineOrder => {
		for (const anchor of anchors) {
			if (anchor.engine >= engineOrder) return anchor.our;
		}
		return null;
	};
}

/** "Route 119 (West), permanent Rain" -> "Route 119". */
function normalisePlace(value) {
	return String(value || '').split(',')[0].replace(/\s*\(.*\)\s*$/, '').trim().replace(/\.$/, '');
}

/** The trailing parenthetical of a location, or null. */
function qualifierOf(value) {
	const found = /\(([^)]*)\)\s*$/.exec(String(value || '').split(',')[0]);
	return found ? found[1].trim() : null;
}

/**
 * Earliest run-map order at each place, keeping every candidate an ambiguous
 * place has so the caller can bias late.
 *
 * A variant is one of three kinds. A SECTION is part of the place and counts.
 * An OPTIONAL group stands where the place already was, so it counts only when
 * nothing else does. A BUILDING is somewhere else and never counts.
 */
function placeOrders(trainers, toRunMap) {
	const firstAt = new Map();
	for (const trainer of trainers) {
		const at = firstAt.get(trainer.location);
		if (at === undefined || trainer.order < at) firstAt.set(trainer.location, trainer.order);
	}
	const sections = new Map();
	const optionals = new Map();
	for (const entry of firstAt) {
		const qualifier = qualifierOf(entry[0]);
		if (qualifier && /\b(House|Door)\b/i.test(qualifier)) continue;
		const key = normalisePlace(entry[0]);
		const order = toRunMap(entry[1]);
		if (order === null) continue;
		const into = qualifier && /^Optionals$/i.test(qualifier) ? optionals : sections;
		if (!into.has(key)) into.set(key, []);
		into.get(key).push(order);
	}
	for (const entry of optionals) {
		if (!sections.has(entry[0])) sections.set(entry[0], entry[1]);
	}
	return sections;
}

/** Every run-map order a trainer name is used at, with the places, because ten
 * names are used twice and Winstrate Vito stands 1020 orders apart. */
function trainerOrders(trainers, toRunMap) {
	const byName = new Map();
	for (const trainer of trainers) {
		if (!trainer.name) continue;
		const order = toRunMap(trainer.order);
		if (order === null) continue;
		for (const key of nameKeys(trainer.name)) {
			if (!byName.has(key)) byName.set(key, []);
			byName.get(key).push({order: order, place: normalisePlace(trainer.location)});
		}
	}
	return byName;
}

/** The spellings a trainer name can be written as. The workbook and the engine
 * disagree about the space in "CoolTrainer", and the workbook sometimes drops
 * the class: "Steven" for "Pokemon Trainer Steven". */
function nameKeys(name) {
	const full = String(name).toLowerCase().replace(/\bcooltrainer\b/g, 'cool trainer')
		.replace(/\s+/g, ' ').trim();
	const keys = new Set([full, full.replace(/\s/g, '')]);
	const bare = full.replace(
		/^(pokemon trainer|cool trainer|bug catcher|bird keeper|ruin maniac|team aqua grunt|team magma grunt|gym leader|elite four)\s+/, '');
	if (bare.length >= 5) keys.add(bare);
	return keys;
}

/**
 * The eight badges in the order the run earns them, for "requires N badges".
 *
 * Read, not derived. Counting `/^Leader/` fights gives NINE, because Tate and
 * Liza are two Leader-labelled fights at one gym for one badge — so the index
 * slipped from badge 7 on and "8 badges" resolved to 1130 instead of Juan at
 * 1364, 234 orders early. It was latent only because no workbook row names
 * more than three badges.
 *
 * The list cannot be deduplicated by gym either: `planner.listFights` carries
 * no gym field. sources.json has the ladder transcribed from the workbook, and
 * it puts the Mind Badge at Leader Liza, 1130.
 */
function badgeOrders() {
	const sources = JSON.parse(fs.readFileSync(path.join(ORACLE, 'sources.json'), 'utf8'));
	const tiers = (sources.gameCorner || {}).tiers || [];
	const orders = tiers
		.filter(tier => typeof tier.opensAt === 'number')
		.map(tier => tier.opensAt)
		.sort((a, b) => a - b);
	if (orders.length !== 8) {
		throw new Error(`the badge ladder must have 8 rungs, sources.json gives ${orders.length}`);
	}
	return orders;
}

/**
 * Date one prose location, and say which evidence did it.
 *
 * Anything the four signals do not reach stays null and is withheld.
 */
function dateFor(index, prose) {
	const text = String(prose || '');
	if (/^\s*unavailable\b/i.test(text)) return {opensAt: null, dating: 'unavailable in this game'};

	// 1. The floor the prose declares for itself, over whatever a place or a
	// guard says, because a gate is hard rather than an estimate. A place's
	// first trainer can stand there long before the item inside it is
	// reachable: Water Gem is in the Abandoned Ship, whose first fight is 502,
	// behind water that needs Dive at 1178.
	let floor = null;
	let gatedBy = null;
	const raise = (order, reason) => {
		if (order === null || (floor !== null && order <= floor)) return;
		floor = order;
		gatedBy = reason;
	};
	for (const move of Object.keys(index.hmGates)) {
		if (new RegExp('\\b' + move + '\\b', 'i').test(text)) raise(index.hmGates[move], move);
	}
	const badges = /\b(\d+)\s+badges?\b/i.exec(text);
	if (badges) {
		const nth = Number(badges[1]);
		if (nth >= 1 && nth <= index.badges.length) {
			raise(index.badges[nth - 1], nth + ' badges');
		}
	}
	// A place a human has DATED FROM PLAY outranks anything derived from the
	// trainer database, because the two answer different questions. The first
	// trainer standing on a route is not the same as the route being reachable:
	// Route 109's first fight is Tuber Chandler at order 29, and availability
	// .json records "Philip, from play: Route 109 is available post Granite Cave
	// ... the transcribed 29 put it BEFORE Route 107's own trainers, which run
	// to 37". Two rows here were dated 29 against that correction, which is the
	// too-early direction this ledger exists to prevent.
	//
	// Only `corrected` rows are a floor. The other map rows are the SAME
	// derivation this builder does, through a sparser anchor set, so they run
	// slightly late by construction — using those as a floor would push 53 rows
	// past dates that are already exact.
	for (const place of index.corrections) {
		if (new RegExp('\\b' + place.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(text)) {
			raise(place.opensAt, 'a correction from play at ' + place.name);
		}
	}
	const withFloor = answer => {
		if (floor === null || answer.opensAt === null || answer.opensAt >= floor) return answer;
		return {opensAt: floor, dating: 'gated by ' + gatedBy + ', which opens at ' + floor};
	};

	// 3. The places. The prose LEADS with where the item is and mentions any
	// other place afterwards, so the first one named is the one that dates it.
	//
	// Late-bias belongs inside a place, not across places, and conflating the
	// two was the second bug here. "Berry Trees at Routes 102, 104 and 111"
	// means the tree grows on all three, so reaching the first is enough — the
	// latest withheld the game's workhorse berries for most of the run and put
	// Oran Berry at 387 where availability.json had long said 0. A second place
	// is usually a landmark: the Black Belt is ON Route 115, and the Meteor
	// Falls exit is only how the prose points at the corner it sits in.
	//
	// Unless the prose says the item is REACHED through that place, which is a
	// path and therefore a gate. Then it raises the date like an HM does.
	const expanded = text.replace(/\bRoutes\s+([\d,\s]+?)\s+and\s+(\d+)/gi,
		(all, list, last) => list.split(/[,\s]+/).filter(Boolean)
			.concat(last).map(n => 'Route ' + n).join(' '));
	const places = [];
	for (const entry of index.places) {
		const place = entry[0];
		if (place.length < 4) continue;
		const quoted = place.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		// "New Mauville" is not Mauville, and it holds no trainer of its own.
		const pattern = new RegExp('(?<!\\b(?:New|Old|Near|Outside|Under)\\s)\\b' + quoted + '\\b', 'i');
		const at = pattern.exec(expanded);
		if (!at) continue;
		const opensAt = Math.max.apply(null, entry[1]);
		places.push({name: place, opensAt: opensAt, at: at.index});
		if (new RegExp('\\b(?:through|via|from)\\s+(?:the\\s+)?' + quoted + '\\b', 'i').test(expanded)) {
			raise(opensAt, 'the path through ' + place);
		}
	}
	places.sort((a, b) => a.at - b.at);

	// 2. A named guard, which is direct evidence and outranks the place.
	const lower = text.toLowerCase().replace(/\bcooltrainer\b/g, 'cool trainer');
	for (const entry of index.trainers) {
		const name = entry[0];
		if (name.length < 6) continue;
		if (!lower.includes(name)) continue;
		const named = places.map(place => place.name);
		const here = entry[1].filter(stood => named.includes(stood.place));
		const pick = (here.length ? here : entry[1])
			.reduce((best, stood) => (stood.order > best.order ? stood : best));
		return withFloor({opensAt: pick.order, dating: 'the fight that guards it'});
	}

	if (places.length) {
		return withFloor({opensAt: places[0].opensAt,
			dating: places.length > 1 ? 'the first of the places it names' : 'the place it names'});
	}
	// Nothing named the place, but a stated requirement is still a real lower
	// bound and is better evidence than nothing.
	if (floor !== null) return {opensAt: floor, dating: 'only its ' + gatedBy + ' gate is known'};
	return {opensAt: null, dating: 'no trainer or known place in the text'};
}

function build() {
	const workbook = JSON.parse(fs.readFileSync(WORKBOOK, 'utf8'));
	const availability = JSON.parse(fs.readFileSync(path.join(ORACLE, 'availability.json'), 'utf8'));
	const trainers = engineTrainers();
	const toRunMap = scaleBridge();
	const index = {
		places: Array.from(placeOrders(trainers, toRunMap))
			.sort((a, b) => b[0].length - a[0].length),
		trainers: Array.from(trainerOrders(trainers, toRunMap))
			.sort((a, b) => b[0].length - a[0].length),
		hmGates: availability.hmMoves,
		badges: badgeOrders(),
		corrections: (availability.entries || [])
			.filter(entry => entry.provenance === 'corrected' && typeof entry.opensAt === 'number')
			.map(entry => ({
				// "Route109" in the map table, "Route 109" in the workbook prose.
				name: String(entry.name).replace(/([A-Za-z])(\d)/g, '$1 $2').trim(),
				opensAt: entry.opensAt,
			})),
	};

	const entries = [];
	const add = (name, kind, place, detail) => {
		// The detail column often carries the place when the first does not.
		const dated = dateFor(index, place + ' ' + (detail || ''));
		entries.push({
			name: NAME_FIXES[name] || name, kind: kind, location: place,
			detail: detail || null,
			opensAt: dated.opensAt,
			dating: dated.dating,
		});
	};

	for (const row of workbook.heartScales) add('Heart Scale', 'heart-scale', row.place, row.detail);
	for (const row of workbook.rareCandies) add('Rare Candy', 'rare-candy', row.place, row.detail);
	for (const row of workbook.heldItems) add(row.name, 'held', row.place, null);
	for (const row of workbook.berries) add(row.name, 'berry', row.place, row.yield || null);
	for (const row of workbook.evolutionItems) add(row.name, 'evolution', row.place, null);
	for (const row of workbook.megaStones) add(row.name, 'mega-stone', row.place, null);

	entries.sort((a, b) =>
		(a.opensAt === null ? 1 : 0) - (b.opensAt === null ? 1 : 0) ||
		(a.opensAt || 0) - (b.opensAt || 0) ||
		a.name.localeCompare(b.name));

	const dated = entries.filter(entry => entry.opensAt !== null).length;
	return {
		schemaVersion: 'runbun.item.locations/1.1.0',
		source: 'pokemon-mono engines/rab/backend/DOCS/Item Locations.xlsx, via item-workbook.json',
		provenance: 'transcribed + derived',
		method: 'opensAt is a RUN-MAP order (cumulative enemy Pokemon, 0-1620), not an engine ' +
			'row index (0-434). It is the first trainer at the place the prose names, ' +
			'translated through trainer-orders.json. Late-biased: a place the engine splits ' +
			'(Route 104 South and North) takes the LATEST of its sections, because offering ' +
			'an item the run cannot fetch is the failure this ledger prevents. An optional ' +
			'fight group does not date a place that has its own fights, and a building behind ' +
			'a door is not a section of the route outside it. A stated gate — an HM named in ' +
			'the prose, or a badge count — is a floor over all of that. A place with no ' +
			'trainer is null and withheld.',
		counted: entries.length,
		dated: dated,
		undated: entries.length - dated,
		entries: entries,
	};
}

if (require.main === module) {
	const out = build();
	fs.writeFileSync(OUT, JSON.stringify(out, null, '\t') + '\n');
	console.log(`${out.dated} dated of ${out.counted} -> ${path.relative(ROOT, OUT)}`);
}

module.exports = {build: build, ANCHORS: ANCHORS, NAME_FIXES: NAME_FIXES, badgeOrders: badgeOrders,
	normalisePlace: normalisePlace, qualifierOf: qualifierOf,
	dateFor: dateFor, placeOrders: placeOrders, trainerOrders: trainerOrders,
	engineTrainers: engineTrainers, scaleBridge: scaleBridge, OUT: OUT};
