/* eslint-env node, es6 */
'use strict';

/**
 * Run & Bun — oracle layer (L0, materialised).
 *
 * The four datasets imported straight out of the hack author's ROM decomp by
 * `scripts/import-oracle.js`, plus the small amount of reasoning that turns them
 * into answers rather than tables.
 *
 * Why these four and not others: they are what a companion needs and a
 * calculator does not. A calculator asks "how hard does this hit". A player
 * mid-run asks "what can I catch here", "what does this become", "can it learn
 * that". Those are the questions the run layer is built on, and none of them can
 * be answered from stats alone.
 *
 * Provenance is `source-of-truth` for every value here: they are the decomp's
 * own tables, transformed only by name mapping, and the import fails rather than
 * dropping a row it cannot map.
 *
 * The one piece of reasoning this module adds is move legality, because it is
 * the only question whose answer is not a table lookup. Egg moves are recorded
 * against the base species of a line, so a Breloom's claim to Bullet Seed lives
 * under Shroomish; answering "can this Breloom hold Bullet Seed" means walking
 * back down the evolution line, which needs the evolution table and the learnset
 * tables at once. That is why it lives here rather than in either file.
 */

const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, 'oracle');

/**
 * Loaded on demand and cached.
 *
 * Around 600KB across the three files, which is cheap once and wasteful on every
 * `require` of the profile — the calculator, the AI and the planner all pull the
 * profile in and none of them need a learnset.
 */
const cache = {};

function load(name) {
	if (!cache[name]) {
		cache[name] = JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), 'utf8'));
	}
	return cache[name];
}

/** Every map with a wild encounter table, in decomp order. */
function maps() {
	return load('encounters').maps;
}

/** One map by its `MAP_*` constant or by its readable name, case-insensitively. */
function getMap(name) {
	const needle = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
	return maps().find(m =>
		m.map.toLowerCase().replace(/[^a-z0-9]/g, '') === needle ||
		m.name.toLowerCase().replace(/[^a-z0-9]/g, '') === needle) || null;
}

/**
 * What can be caught on a map, flattened across methods.
 *
 * Flattened because a player asking "what's here" wants one list, and the method
 * is a property of the slot rather than a separate question. `slots` is the
 * encounter weight the decomp expresses by repeating a species — kept so a
 * consumer can show that a route is mostly Zigzagoon rather than presenting ten
 * species as equally likely.
 */
function encountersOn(name) {
	const map = getMap(name);
	if (!map) return null;
	const out = [];
	for (const table of map.tables) {
		for (const mon of table.mons) {
			out.push(Object.assign({method: table.method, encounterRate: table.encounterRate}, mon));
		}
	}
	return {map: map.map, name: map.name, mons: out};
}

/** Every map a species can be caught on, with how. */
function whereToFind(species) {
	const found = [];
	for (const map of maps()) {
		for (const table of map.tables) {
			for (const mon of table.mons) {
				if (mon.species !== species) continue;
				found.push({
					map: map.map,
					name: map.name,
					method: table.method,
					minLevel: mon.minLevel,
					maxLevel: mon.maxLevel,
					...(mon.rod ? {rod: mon.rod} : {}),
				});
			}
		}
	}
	return found;
}

/** What a species evolves into, and on what terms. Empty array if it does not. */
function evolutionsOf(species) {
	return load('evolutions')[species] || [];
}

let preEvolutionIndex = null;

/** What a species evolved FROM. Built by inverting the evolution table once. */
function preEvolutionOf(species) {
	if (!preEvolutionIndex) {
		preEvolutionIndex = {};
		const table = load('evolutions');
		for (const from of Object.keys(table)) {
			for (const step of table[from]) {
				// A species can have more than one pre-evolution across forms; the first
				// is the one the line is named for, and that is the one egg moves sit
				// under. Later ones are alternate-form paths.
				if (!preEvolutionIndex[step.into]) preEvolutionIndex[step.into] = from;
			}
		}
	}
	return preEvolutionIndex[species] || null;
}

/** The whole line below a species, nearest first, ending at the base form. */
function lineageOf(species) {
	const line = [];
	let current = preEvolutionOf(species);
	// Guarded rather than trusted: an evolution table with a cycle would hang
	// here, and a cycle is exactly the sort of thing a bad import produces.
	while (current && line.length < 6 && !line.includes(current)) {
		line.push(current);
		current = preEvolutionOf(current);
	}
	return line;
}

/** Level-up moves as `[level, move]` pairs, in the order the game lists them. */
function levelUpMoves(species) {
	return load('learnsets').levelUp[species] || [];
}

/** Moves a species can be taught by TM or tutor. */
function teachableMoves(species) {
	return load('learnsets').teachable[species] || [];
}

/** Egg moves recorded directly against a species, without walking the line. */
function ownEggMoves(species) {
	return load('learnsets').egg[species] || [];
}

/**
 * Every move a species can legally hold, with where the claim comes from.
 *
 * Four sources, and they are not interchangeable — a consumer showing "what can
 * I teach this right now" wants `teachable`, while one checking a pasted team
 * wants all four. Egg moves are inherited down the line, which is the reason
 * this function exists at all.
 *
 * `level` is the level a level-up move becomes available. It is reported rather
 * than enforced: a Pokemon that already knows a move keeps it after evolving,
 * and reconstructing that history from a box entry is not possible.
 */
function legalMoves(species) {
	const sources = {};
	const add = (move, source, level) => {
		if (!sources[move]) sources[move] = {move, sources: []};
		const entry = {source};
		if (level !== undefined) entry.level = level;
		sources[move].sources.push(entry);
	};

	for (const pair of levelUpMoves(species)) add(pair[1], 'level-up', pair[0]);
	for (const move of teachableMoves(species)) add(move, 'teachable');
	for (const move of ownEggMoves(species)) add(move, 'egg');
	for (const ancestor of lineageOf(species)) {
		for (const move of ownEggMoves(ancestor)) add(move, `egg (${ancestor})`);
		// A pre-evolution's level-up moves come along when it evolves, so a
		// Breloom may hold a move only Shroomish ever learns by level.
		for (const pair of levelUpMoves(ancestor)) add(pair[1], `level-up (${ancestor})`, pair[0]);
	}
	return sources;
}

/**
 * Can this species hold this move at all?
 *
 * Returns `{legal, sources}` rather than a bare boolean, because "no" is only
 * useful with the reason attached, and "yes, but only from an egg" is a
 * different fact from "yes, it is a TM".
 */
function canLearn(species, move) {
	const all = legalMoves(species);
	const entry = all[move];
	return entry ?
		{legal: true, sources: entry.sources} :
		{legal: false, sources: []};
}

/** Which EXP curve a species grows on, from the decomp's base_stats.h. */
function growthRateOf(species) {
	return load('growth')[species] || null;
}

/**
 * Total EXP at a level, per curve.
 *
 * The curve assignment is hack data; these formulas are the standard Gen 3
 * growth functions the GROWTH_* constants have named since Ruby — mechanics,
 * not per-game values, which is why they live here as code rather than in the
 * generated JSON.
 */
const GROWTH_FORMULAS = {
	'medium-fast': n => n * n * n,
	fast: n => Math.floor(4 * n * n * n / 5),
	slow: n => Math.floor(5 * n * n * n / 4),
	'medium-slow': n => Math.floor(6 * n * n * n / 5) - 15 * n * n + 100 * n - 140,
	erratic: n =>
		n < 50 ? Math.floor(n * n * n * (100 - n) / 50) :
			n < 68 ? Math.floor(n * n * n * (150 - n) / 100) :
				n < 98 ? Math.floor(n * n * n * Math.floor((1911 - 10 * n) / 3) / 500) :
					Math.floor(n * n * n * (160 - n) / 100),
	fluctuating: n =>
		n < 15 ? Math.floor(n * n * n * (Math.floor((n + 1) / 3) + 24) / 50) :
			n < 36 ? Math.floor(n * n * n * (n + 14) / 50) :
				Math.floor(n * n * n * (Math.floor(n / 2) + 32) / 50),
};

/** Total EXP a species has at a level. Null when the species has no rate. */
function expForLevel(species, level) {
	const rate = growthRateOf(species);
	if (!rate || level < 1) return null;
	if (level === 1) return 0;
	return GROWTH_FORMULAS[rate](level);
}

/** The level a species sits at with a given EXP total. */
function levelFromExp(species, exp) {
	const rate = growthRateOf(species);
	if (!rate || exp < 0) return null;
	let level = 1;
	while (level < 100 && GROWTH_FORMULAS[rate](level + 1) <= exp) level++;
	return level;
}

/** Counts, for gates and for a consumer wanting to state coverage. */
function coverage() {
	const encounters = load('encounters');
	const learnsets = load('learnsets');
	return {
		maps: encounters.maps.length,
		encounterSlots: encounters.maps
			.reduce((sum, m) => sum + m.tables.reduce((n, t) => n + t.mons.length, 0), 0),
		evolvingSpecies: Object.keys(load('evolutions')).length,
		levelUpSpecies: Object.keys(learnsets.levelUp).length,
		teachableSpecies: Object.keys(learnsets.teachable).length,
		eggSpecies: Object.keys(learnsets.egg).length,
		growthRatedSpecies: Object.keys(load('growth')).length,
	};
}

/**
 * What this layer does NOT know, stated so a consumer cannot imply otherwise.
 *
 * Story gifts, static encounters and trades are scripted events, not entries in
 * a wild encounter table, so they are absent here — a starter, the Castform from
 * the Weather Institute and the Beldum in Steven's house are all real Pokemon a
 * player owns and none of them appear in `encounters.json`. That is why the run
 * layer accepts a declared catch with no map: the alternative is refusing to
 * record half the box.
 */
const LIMITS = {
	wildEncountersOnly: true,
	staticAndGiftEncountersAbsent: true,
	itemLocationsAbsent: true,
	note: 'Wild encounter tables only. Starters, gifts, statics, trades and Poke Mart ' +
		'stock are scripted events with no table in the decomp, so a catch or an item ' +
		'may legitimately have no map behind it.',
};

module.exports = {
	maps, getMap, encountersOn, whereToFind,
	evolutionsOf, preEvolutionOf, lineageOf,
	levelUpMoves, teachableMoves, ownEggMoves, legalMoves, canLearn,
	growthRateOf, expForLevel, levelFromExp,
	coverage, LIMITS,
};
