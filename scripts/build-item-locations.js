#!/usr/bin/env node
/* eslint-env node, es6 */
'use strict';

/**
 * Build the field-item ledger from the engine's own Item Locations workbook.
 *
 * `availability.json` carried 28 items and 78 TM/tutor rows. The TMs were
 * complete; the items were not, and three whole categories were absent:
 *
 *     held items and berries   121 upstream,  25 carried,  96 missing
 *     Heart Scales              30 upstream,   0 carried,  all missing
 *     Rare Candies              14 upstream,   0 carried,  all missing
 *     Mega Stones               47 upstream,   0 carried,  all missing
 *
 * The Heart Scales matter beyond their own row. The relearner charges one for
 * an egg move and no shop sells them, so with none in the ledger every egg
 * move in the game is unreachable — 56 of 171 teachable moves across six
 * mid-run species, 32.7% of the movepool, gone. `heartScale` also sets an IV
 * to 31, so that play was unavailable too.
 *
 * DATING. An item is only useful to the advisor once it can say WHEN the run
 * can have it, and the workbook gives prose locations with no orders. The
 * existing rule is already written down in availability.json's `method`: the
 * first trainer at that location, late-biased and never early. Both halves
 * matter here.
 *
 *   - `first trainer at the location` is computable: the engine's trainer
 *     database carries a location and an order for all 432 fights across 80
 *     locations, so the earliest order at a place is the earliest a run can
 *     stand there.
 *   - `late-biased, never early` decides the ambiguity. Route 104 exists twice
 *     in that database, South at order 7 and North at 30, and the workbook
 *     says only "Route 104". Taking 7 would let the advisor recommend an item
 *     the run may not be able to reach yet, which is the failure this whole
 *     ledger exists to prevent. So an ambiguous place takes the LATEST of its
 *     candidate firsts.
 *
 * A location with no trainer at all — Petalburg City, Lilycove City, Route 119
 * — is dated `null` and withheld by the advisor, not guessed. That is the same
 * treatment the 22 undated TMs already get, and for the same reason: a guess
 * is worse than a gap.
 *
 * Both sides are pinned, so this is computed once and committed.
 * `tests/item_locations.test.js` rebuilds it and fails on drift.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'profiles', 'run-and-bun', 'oracle', 'item-locations.json');

/** Strip a parenthetical qualifier and trailing punctuation: the workbook
 * writes "Route 104" where the trainer database writes "Route 104 (South)". */
function normalisePlace(value) {
	return String(value || '').replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ')
		.trim().replace(/\.$/, '');
}

/** Earliest run-map order at each place, and every candidate for an ambiguous
 * one. Late-bias needs the whole candidate list, not just the minimum. */
function placeOrders(trainers) {
	const firstAt = new Map();
	for (const trainer of trainers) {
		if (!trainer.location || typeof trainer.order !== 'number') continue;
		const at = firstAt.get(trainer.location);
		if (at === undefined || trainer.order < at) firstAt.set(trainer.location, trainer.order);
	}
	const byPlace = new Map();
	for (const entry of firstAt) {
		const key = normalisePlace(entry[0]);
		if (!byPlace.has(key)) byPlace.set(key, []);
		byPlace.get(key).push(entry[1]);
	}
	return byPlace;
}

/** Order of each named trainer, for a location that names its guard. */
function trainerOrders(trainers) {
	const byName = new Map();
	for (const trainer of trainers) {
		if (!trainer.name || typeof trainer.order !== 'number') continue;
		const key = String(trainer.name).toLowerCase();
		const at = byName.get(key);
		if (at === undefined || trainer.order < at) byName.set(key, trainer.order);
	}
	return byName;
}

/**
 * Date one prose location, and say which evidence did it.
 *
 * The workbook writes sentences, not place names: "Route 126, guarded by
 * Triathlete Pablo (requires Dive)." and "Berry Trees at Routes 110 and 112."
 * A bare string match against the trainer database dates 48 of 235 rows and
 * calls the other 187 unknown, which is not honest — the place is right there
 * in the prose.
 *
 * Three signals, strongest first:
 *
 *   1. A NAMED TRAINER. "guarded by Triathlete Pablo" is direct evidence: the
 *      item sits behind that fight, so its order is the fight's order. The
 *      existing method already allows this — "a run-map fight named after the
 *      map overrides with direct evidence".
 *   2. NAMED PLACES. Every known place mentioned, including "Routes 110 and
 *      112" expanded to both. Late-biased across them, because an item written
 *      against two places may be at either and the later one cannot mislead.
 *   3. "Unavailable" said outright, which is a fact rather than a gap.
 *
 * Anything else stays null and is withheld. A guess is worse than a gap.
 */
function dateFor(index, prose, hmGates) {
	const text = String(prose || '');
	if (/^\s*unavailable\b/i.test(text)) return {opensAt: null, dating: 'unavailable in this game'};

	// The floor the prose declares for itself, applied over whatever the place
	// or the guard says, because an HM is a hard gate rather than an estimate.
	// A place's first trainer can be reachable long before the item inside it:
	// Pidgeotite sits on Route 105, first trainer at order 30, behind water
	// that needs Surf at 589. Seventeen of the nineteen entries stating a
	// requirement were dated too early before this, the worst by 999.
	let floor = null;
	let gatedBy = null;
	for (const move of Object.keys(hmGates || {})) {
		if (new RegExp('requires?\\s+(the\\s+)?' + move, 'i').test(text) &&
			(floor === null || hmGates[move] > floor)) {
			floor = hmGates[move];
			gatedBy = move;
		}
	}
	const withFloor = answer => {
		if (floor === null || answer.opensAt === null || answer.opensAt >= floor) return answer;
		return {opensAt: floor, dating: 'gated by ' + gatedBy + ', which opens at ' + floor};
	};

	for (const entry of index.trainers) {
		const name = entry[0];
		if (name.length < 6) continue;
		if (text.toLowerCase().includes(name)) {
			return withFloor({opensAt: entry[1], dating: 'the fight that guards it'});
		}
	}

	// "Routes 110 and 112" names two places in one phrase.
	const expanded = text.replace(/\bRoutes\s+([\d,\s]+?)\s+and\s+(\d+)/gi,
		(all, list, last) => list.split(/[,\s]+/).filter(Boolean)
			.concat(last).map(n => 'Route ' + n).join(' '));

	const hits = [];
	for (const entry of index.places) {
		const place = entry[0];
		if (place.length < 4) continue;
		if (new RegExp('\\b' + place.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(expanded)) {
			hits.push(Math.max.apply(null, entry[1]));
		}
	}
	if (hits.length) {
		return withFloor({opensAt: Math.max.apply(null, hits),
			dating: hits.length > 1 ? 'latest of the places it names' : 'the place it names'});
	}
	// Nothing named the place, but a stated requirement is still a real lower
	// bound and is better evidence than nothing.
	if (floor !== null) return {opensAt: floor, dating: 'only its ' + gatedBy + ' gate is known'};
	return {opensAt: null, dating: 'no trainer or known place in the text'};
}

function rows(sheet, columns) {
	const out = [];
	for (const row of sheet) {
		const name = row[columns.name];
		const place = row[columns.place];
		if (!name || !place) continue;
		if (String(name).trim() === 'Item') continue;
		out.push({name: String(name).trim(), place: String(place).trim()});
	}
	return out;
}

function build(workbook, trainers) {
	const index = {
		places: Array.from(placeOrders(trainers)).sort((a, b) => b[0].length - a[0].length),
		trainers: Array.from(trainerOrders(trainers)).sort((a, b) => b[0].length - a[0].length),
	};
	const entries = [];
	const add = (name, kind, place, detail) => {
		// The detail column often carries the place when the first does not.
		const dated = dateFor(index, place + ' ' + (detail || ''), workbook.hmGates);
		entries.push({
			name: name, kind: kind, location: place,
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
		schemaVersion: 'runbun.item.locations/1.0.0',
		source: 'pokemon-mono engines/rab/backend/DOCS/Item Locations.xlsx',
		provenance: 'transcribed + derived',
		method: 'opensAt = the first trainer at the location in the engine trainer database, ' +
			'in RUN MAP ORDER (cumulative enemy Pokemon, not fight number). Late-biased: a ' +
			'place the database splits (Route 104 South at 7, North at 30) takes the LATEST ' +
			'of its candidates, because offering an item the run cannot yet fetch is the ' +
			'failure this ledger prevents. A place with no trainer is null and withheld.',
		counted: entries.length,
		dated: dated,
		undated: entries.length - dated,
		entries: entries,
	};
}

module.exports = {build: build, normalisePlace: normalisePlace, dateFor: dateFor,
	placeOrders: placeOrders, trainerOrders: trainerOrders, rows: rows, OUT: OUT};
