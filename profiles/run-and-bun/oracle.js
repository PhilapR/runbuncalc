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

/**
 * Every map with a wild encounter table, in decomp order — ONE entry per map
 * constant. The decomp declares Altering Cave nine times under one constant
 * (nine alternate rosters, of which the game activates only the first); every
 * lookup here is by name or constant and can only ever reach the first
 * declaration, so exposing all nine as separate maps made the routes view
 * count one physical room as nine unspent encounters. First declaration wins,
 * matching `getMap`; the alternates stay in the data file, unclaimed rather
 * than misclaimed.
 */
function maps() {
	if (!cache.uniqueMaps) {
		const seen = new Set();
		cache.uniqueMaps = load('encounters').maps.filter(m =>
			seen.has(m.map) ? false : seen.add(m.map));
	}
	return cache.uniqueMaps;
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
const unavailableData = require('./oracle/unavailable.json');
const sourcesData = require('./oracle/sources.json');

/**
 * Every non-wild way to get a Pokemon, flattened to species -> sources.
 *
 * Built once. A Game Corner tier is a RANDOM draw between its options, so
 * each option carries the whole set and the odds rather than pretending the
 * player picks — that is the same shape a wild table already uses.
 */
const NON_WILD = new Map();
function addSource(species, entry) {
	if (!species) return;
	if (!NON_WILD.has(species)) NON_WILD.set(species, []);
	NON_WILD.get(species).push(entry);
}
for (const tier of sourcesData.gameCorner.tiers) {
	for (const species of tier.options) {
		addSource(species, {
			kind: 'game-corner', where: 'Game Corner', opensAt: tier.opensAt,
			gate: tier.badge, after: tier.leader,
			oneOf: tier.options,
			chance: Math.round(100 / tier.options.length),
		});
	}
}
for (const trade of sourcesData.trades) {
	for (const species of trade.gives) {
		addSource(species, {
			kind: 'trade', where: trade.where, opensAt: null,
			costs: trade.wants,
		});
	}
}
for (const gift of sourcesData.gifts) {
	if (gift.species) {
		addSource(gift.species, {kind: 'gift', where: gift.where, opensAt: gift.opensAt,
			note: gift.note});
	}
	for (const species of gift.options || []) {
		addSource(species, {kind: 'gift', where: gift.where, opensAt: gift.opensAt,
			oneOf: gift.options, what: gift.what, note: gift.note});
	}
}
for (const species of sourcesData.roaming.species) {
	addSource(species, {kind: 'roaming', where: null, opensAt: null,
		after: sourcesData.roaming.after});
}

/** Non-wild sources for a species, or an empty list. */
function nonWildSources(species) {
	return (NON_WILD.get(species) || []).slice();
}

/**
 * Every species this hack REMOVED, flattened once.
 *
 * Generation IX is listed as "All of them." rather than enumerated, so it
 * cannot join this set — availabilityOfSpecies reports it by generation
 * instead. Enumerating it here would be inventing a list the source does
 * not give.
 */
/**
 * The removed-species list and the growth table spell some names differently,
 * and the join dropped every one that disagreed.
 *
 * 38 of the 416 enumerated names were not keys of growth.json, so the set never
 * contained them and `where Mewtwo` answered "a gap in the tool, NOT a
 * statement that you cannot get one" about a species the hack removed — which
 * is the exact two-answers-in-one-word failure this dataset exists to end.
 *
 * Three kinds of disagreement, none of them about the game:
 *
 *   - a trailing full stop caught by the transcription ("Mewtwo.", "Ho-Oh.",
 *     "Arceus.", "Marowak-Alolan.", "Braviary-Hisuian.")
 *   - a form suffix the growth table writes shorter (-Alolan against -Alola,
 *     -Galarian against -Galar, -Hisuian against -Hisui) or differently
 *     ("Type-Null" against "Type: Null", -Sandy-Cloak against -Sandy,
 *     -Ice-Rider against -Ice)
 *   - a straight apostrophe where the table uses a curly one (Farfetch'd)
 *
 * A candidate is only accepted when it is the ONE spelling that exists as a
 * growth key, so this cannot invent a species or pick between two. 37 of the 38
 * resolve that way. The one that does not is recorded rather than dropped:
 * "Aegislash" is bare where the table carries Aegislash-Shield and
 * Aegislash-Blade, and deciding whether the source meant both forms is a
 * ruling about the game, not a spelling.
 */
function growthKeyFor(name) {
	const growth = load('growth');
	if (Object.prototype.hasOwnProperty.call(growth, name)) return name;
	const base = name.replace(/\.$/, '');
	const candidates = new Set([
		base,
		base.replace(/-Alolan$/, '-Alola')
			.replace(/-Galarian$/, '-Galar')
			.replace(/-Hisuian$/, '-Hisui'),
		base.replace('Type-Null', 'Type: Null'),
		base.replace(/'/g, '\u2019'),
		base.replace(/-Sandy-Cloak$/, '-Sandy').replace(/-Trash-Cloak$/, '-Trash'),
		base.replace(/-Eternal-Flower$/, '-Eternal'),
		base.replace(/-Ice-Rider$/, '-Ice').replace(/-Shadow-Rider$/, '-Shadow'),
	]);
	const found = [...candidates].filter(candidate =>
		Object.prototype.hasOwnProperty.call(growth, candidate));
	return found.length === 1 ? found[0] : null;
}

const UNAVAILABLE = new Set();
/** Enumerated names that no single growth key answers to. Named, not dropped. */
const UNAVAILABLE_UNJOINED = [];
for (const generation of Object.keys(unavailableData.generations)) {
	for (const name of unavailableData.generations[generation].species) {
		const key = growthKeyFor(name);
		if (key === null) {
			UNAVAILABLE_UNJOINED.push(name);
			UNAVAILABLE.add(name);
			continue;
		}
		UNAVAILABLE.add(key);
		// The written spelling still has to answer, because callers ask with
		// whatever the source gave them.
		if (key !== name) UNAVAILABLE.add(name);
	}
}
const UNAVAILABLE_WHOLE_GENERATIONS = Object.keys(unavailableData.generations)
	.filter(generation => unavailableData.generations[generation].all);
const CONTESTED = new Set(unavailableData.openQuestions.map(row => row.species));

/**
 * WHY a species cannot be found — the distinction the tool did not have.
 *
 * `unavailable` means the hack removed it and no amount of modelling will
 * bring it back. `not-modelled` means it exists and we have not taught the
 * tool that source yet: a gift, a trade, a Game Corner reward. Both used to
 * answer "NOT FINDABLE", which told a nuzlocke player nothing about whether
 * to keep looking.
 *
 * `contested` is the honest third answer for the two species where the
 * author's workbook and the ROM tables disagree and neither has been shown
 * wrong. Claiming either would be inventing certainty.
 */
function availabilityOfSpecies(species) {
	// Not in this hack's species data at all. Generation IX is excluded
	// wholesale — the source says "All of them." rather than naming any — so
	// absence from the dex IS the answer, and enumerating that generation
	// here would be inventing a list the source does not give.
	if (!isKnownSpecies(species)) {
		return {status: 'unavailable', reason: 'not in this hack\'s species data'};
	}
	// Every route in, wild and otherwise. A species can have BOTH: Larvitar
	// is a Heat Badge reward AND stands in the grass, and reporting only the
	// grass would hide a guaranteed one. An earlier version returned on the
	// first wild table it found and lost the other half.
	const other = nonWildSources(species);
	const wild = whereToFind(species);

	if (wild.length) {
		if (CONTESTED.has(species)) {
			const row = unavailableData.openQuestions.find(entry => entry.species === species);
			return {status: 'contested', wild, sources: other,
				question: row.question, wildSource: row.wildSource};
		}
		// A table in unreachable content is not a way to get one. Six species
		// are listed unavailable AND carry wild tables for exactly this
		// reason: the ROM keeps tables for areas the game does not open.
		const reachable = wild.filter(entry => !!availabilityOf(entry.name));
		if (!reachable.length) {
			// ...unless something else hands one over, which changes the answer
			// completely rather than merely adding to it.
			if (other.length) return {status: 'obtainable', wild, sources: other};
			return {
				status: 'unreachable',
				wild,
				reason: 'every wild table for it stands in content nothing can date — ' +
					'the ROM keeps tables for areas the game does not open',
			};
		}
		return {status: 'wild', wild, reachable, ...(other.length ? {sources: other} : {})};
	}
	// A non-wild source is a real way to get one. This is the whole point of
	// Phase 1: eight Game Corner tiers, three trades, the gifts, the fossils
	// and seven roaming legendaries used to answer "not modelled".
	if (other.length) return {status: 'obtainable', sources: other};
	if (UNAVAILABLE.has(species)) {
		return {status: 'unavailable', reason: 'named in the hack\'s Unavailable Pokemon list'};
	}
	// It exists in this hack and has no route we model, so it comes from a
	// source we have not taught the tool. That is a different answer from
	// "you cannot have it".
	return {status: 'not-modelled', notModelled: NON_WILD_SOURCES_NOT_MODELLED};
}

/** Does this hack ship the species at all? */
function isKnownSpecies(species) {
	try {
		return !!growthRateOf(species);
	} catch (error) {
		return false;
	}
}

/** The sources that exist in the game and have no model yet. */
const NON_WILD_SOURCES_NOT_MODELLED = Object.freeze([
	'gift', 'trade', 'fossil', 'game-corner', 'egg', 'static',
]);

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

let familyIndex = null;

/**
 * The evolution FAMILY a species belongs to — the identity the dupes clause
 * compares. Walking pre-evolutions is not enough: the table declares Muk-Alola
 * under both Grimer and Grimer-Alola, and a first-key-wins walk filed the
 * Alolan line under plain Grimer while Grimer-Alola stayed its own family, so
 * a run could legally hold both halves of one line. A family is the connected
 * component of the evolution graph, named by its alphabetically first member —
 * derived from the table, not from which key happened to be read first.
 *
 * On regional forms this lands exactly on the community convention. The
 * dominant tracker (nuzlocke.app) encodes regional lines as separate families
 * — Grimer [88,89] vs Alolan Grimer [-88,-89] — which is what a component walk
 * over VANILLA data produces, since vanilla never connects them. Run & Bun
 * does connect some: plain Grimer evolves into Muk-Alola by Dusk Stone, and
 * both Basculin forms evolve into Basculegion, so those are one family HERE
 * because they are one line in this game. Sandshrew/Sandshrew-Alola,
 * Zigzagoon/Zigzagoon-Galar and every other unconnected pair stay separate.
 * The rule is one sentence: dupes follow the game's own evolution graph.
 */
function familyOf(species) {
	if (!familyIndex) {
		const parent = {};
		const find = name => parent[name] === name ? name : (parent[name] = find(parent[name]));
		const ensure = name => {
			if (!(name in parent)) parent[name] = name;
			return name;
		};
		const table = load('evolutions');
		for (const from of Object.keys(table)) {
			for (const step of table[from]) {
				const rootA = find(ensure(from));
				const rootB = find(ensure(step.into));
				if (rootA !== rootB) parent[rootB] = rootA;
			}
		}
		const canonical = {};
		for (const name of Object.keys(parent)) {
			const root = find(name);
			if (!canonical[root] || name < canonical[root]) canonical[root] = name;
		}
		familyIndex = {};
		for (const name of Object.keys(parent)) familyIndex[name] = canonical[find(name)];
	}
	return familyIndex[species] || species;
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
 * A species' catch rate — the one number the ball math runs on. Mainline dex
 * data (veekun import), not decomp data: the hack does not touch capture
 * rates. Keys are normalized to alphanumerics so naming styles meet.
 */
function catchRateOf(species) {
	const rates = load('catch-rates').rates;
	const key = String(species).toLowerCase().replace(/[^a-z0-9]/g, '');
	if (rates[key]) return rates[key];
	// Regional forms ('Zigzagoon-Galar') are not separate species rows in the
	// dex data; their capture rate is the line's, so the base species answers.
	const base = String(species).split('-')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
	return rates[base] || null;
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
	// Was `true` from the first oracle import and stayed true after the item
	// data landed and falsified it. This block is served to clients on
	// /run/maps, so a stale declaration here tells every consumer the layer
	// cannot answer a question it has been answering for months: `fieldItems()`
	// returns located, dated pickups and `api.where` reports them.
	itemLocationsAbsent: false,
	note: 'Route rolls cover wild encounters. Starters, gifts, static encounters, trades ' +
		'and shop stock are scripted events, so add them without choosing a route. ' +
		'Field items ARE located and dated; an undated one is withheld, not guessed.',
};

/**
 * Multi-map LOCATIONS: one entry per place the game names, covering every
 * wild table inside it. The nuzlocke unit is the location, not the table —
 * Granite Cave's four floors are one encounter, and Route 124's underwater
 * grass is Route 124's dive method, not a second route. Prefixes cover the
 * floor/room naming; the Underwater pair is spelled out because its names
 * run the other way.
 */
const AREA_PREFIXES = [
	'Granite Cave', 'Mt Pyre', 'Seafloor Cavern', 'Magma Hideout',
	'Abandoned Ship', 'Victory Road', 'Meteor Falls', 'Shoal Cave',
	'Cave Of Origin', 'New Mauville', 'Sky Pillar', 'Safari Zone',
	'Artisan Cave', 'Mirage Tower',
];
const AREA_ALIASES = {
	'Underwater Route124': 'Route124',
	'Underwater Route126': 'Route126',
};

/**
 * The location a wild map belongs to, by map constant or readable name.
 * Identity for every map that IS its own location; null for unknown maps.
 */
function areaOf(name) {
	const map = getMap(name);
	if (!map) return null;
	if (AREA_ALIASES[map.name]) return AREA_ALIASES[map.name];
	for (const prefix of AREA_PREFIXES) {
		if (map.name === prefix || map.name.startsWith(`${prefix} `)) return prefix;
	}
	return map.name;
}

/**
 * When a wild map first becomes reachable, as a progression order — imported
 * from the operator's own rab curation (scripts/import-availability.js shows
 * how the date is derived, and why it can only ever be late, never early).
 * Returns `{opensAt, method, rabMinOrder}` or null for a map never dated —
 * absence means "unlock order unknown", not "never opens".
 */
function availabilityOf(name) {
	const map = getMap(name);
	if (!map) return null;
	if (!cache.availabilityIndex) {
		cache.availabilityIndex = new Map(
			load('availability').entries.map(entry => [entry.map, entry]));
	}
	return cache.availabilityIndex.get(map.map) || null;
}

/**
 * The progression order an encounter METHOD starts working, or null for a
 * method never dated. Walking and fishing are free from the start (Run & Bun
 * has one fishing tool, given on Route 103); Surf and Rock Smash wait on
 * their HMs. Reaching a route is not the same as being able to fish its
 * water dry — both gates have to hold before a slot is a real prospect.
 */
function methodOpensAt(method) {
	const gates = load('availability').methods || {};
	return gates[method] !== undefined ? gates[method] : null;
}

/**
 * Field item pickups the overworld hands out, dated like everything else:
 * `[{name, kind, location, opensAt}]`, opensAt in this run map's orders
 * (null = never dated). What lets an advisor recommend an item the bag does
 * not hold yet — with where to go get it.
 */
function itemsObtainableBy(order) {
	const all = load('availability').items || [];
	return all.filter(item => item.opensAt !== null && item.opensAt <= order);
}

/** The whole field-item ledger, location and all — the guided view's source. */
function fieldItems() {
	if (!cache.fieldItems) {
		// The 28 curated availability rows, PLUS the item ledger's dated
		// currencies. Seventeen treatment runs across two instruments spent
		// zero Heart Scales while two sat on the corridor, because this
		// answer never served the ledger — the advisor priced scale
		// purchases a bag could not fund. Only dated rows: an undated place
		// cannot say when its item is reachable, and the collect surface
		// must never offer what the road cannot.
		const ledger = load('item-locations').entries || [];
		// Currencies, held items and berries — everything a route hands over.
		// Sold-at rows are the SHOP's, not the road's, and 44 dated held rows
		// sat here unserved, starving every Give-item advice row. Dedup
		// against the curated availability rows by name+location prefix so
		// one physical item never renders twice.
		const curated = load('availability').items || [];
		const taken = new Set(curated.map(row =>
			row.name + '|' + String(row.location || '').slice(0, 12)));
		const fromLedger = ledger
			.filter(row => ['heart-scale', 'rare-candy', 'held', 'berry', 'evolution', 'mega-stone'].includes(row.kind) &&
				row.opensAt !== null && row.opensAt !== undefined &&
				!/^Sold at /.test(row.location || '') &&
				!taken.has(row.name + '|' + String(row.location || '').slice(0, 12)))
			.map(row => ({name: row.name, kind: row.kind,
				location: row.location, opensAt: row.opensAt}));
		cache.fieldItems = curated.concat(fromLedger);
	}
	return cache.fieldItems;
}

/**
 * The permanent field a fight is always fought under — Route 119's rain,
 * the Thunderstorm stretch's Electric Terrain, the desert's sandstorm, the
 * Seafloor Cavern's opponent-side Aurora Veil — or null for a fight in
 * clear skies. Imported from the operator's rab location annotations (see
 * scripts/import-fight-fields.js); a `note`-only entry (Route 129's erratic
 * weather) declares a condition that CANNOT be a static field.
 */
/** Dated sold-at ledger rows: the marts the road has reached sell these. */
function shopItems() {
	if (!cache.shopItems) {
		cache.shopItems = (load('item-locations').entries || [])
			.filter(row => /^Sold at /.test(row.location || '') &&
				row.opensAt !== null && row.opensAt !== undefined)
			.map(row => ({name: row.name, kind: row.kind,
				location: row.location, opensAt: row.opensAt}));
	}
	return cache.shopItems;
}

function fightFieldOf(trainer) {
	if (!cache.fightFields) {
		cache.fightFields = load('fight-fields').fields;
	}
	return cache.fightFields[trainer] || null;
}

/**
 * The progression order an HM MOVE becomes teachable, or null for a move
 * with no known gate. Null means "not dated" — 22 of the 78 TM and tutor rows
 * have a known place and no proven unlock — so a null must be read as "timing
 * unproven", never as "never obtainable" and never as "available now".
 */
function moveObtainableAt(move) {
	const data = load('availability');
	const gates = data.hmMoves || {};
	if (gates[move] !== undefined) return gates[move];
	// The TM and tutor ledger, which this used to ignore. When it was written
	// the source dated only the HM story spine, so "null covers every TM" was a
	// true description; moveItems has since arrived with 56 dated rows and the
	// function kept answering null for all of them. The advisor reads this to
	// decide whether a teachable move is reachable yet, so every TM failed that
	// test and was dropped — a party stood in front of Leader Brawly with Icy
	// Wind, Rock Blast and Feint Attack all reachable and was offered Absorb.
	//
	// The EARLIEST dated row wins: a move sold in a late department store and
	// also lying on an early route is available from the route.
	let soonest = null;
	for (const row of data.moveItems || []) {
		if (row.move !== move || typeof row.opensAt !== 'number') continue;
		if (soonest === null || row.opensAt < soonest) soonest = row.opensAt;
	}
	return soonest;
}

/** The TM and tutor location ledger — rows with a prose location, and an
 * `opensAt` in RUN MAP ORDER where the place could be dated (null = the place
 * is known but its unlock is not; read as "location known, timing unproven").
 *
 * Run map order counts cumulative enemy POKEMON, not trainers. This comment
 * said "trainer order" and that is a different number entirely: Leader Brawly
 * is trainer 26 of 362 and order 77. TM16 settles which one the data uses —
 * it is Brawly's own gym reward and carries opensAt 77, his order, not 26. The
 * mislabel is the same one `lib/play.js` printed to players as "opens at fight
 * #77" for a TM obtainable 51 trainers earlier than that reads. */
/**
 * Where a spent currency actually comes from.
 *
 * The run CHARGES a Rare Candy per level over the cap and a Heart Scale per
 * relearned move, and for a long time it could not say where either is found:
 * `fieldItems` models 28 items and neither currency, nor any evolution stone,
 * is among them. The workbook has held the answer the whole time — 30 Heart
 * Scale locations and 14 Rare Candy — and nothing read it.
 *
 * Places only, deliberately. Dating them would mean inferring an unlock from a
 * place name, which is the inference `moveObtainableAt` refuses for TMs and
 * which produced this repository's worst data bug. Telling a player WHERE is
 * the whole of what the refusal was missing; WHEN is a separate question with
 * a separate standard of proof.
 */
function currencySources(name) {
	const sheet = name === 'Heart Scale' ? 'heartScales' :
		name === 'Rare Candy' ? 'rareCandies' : null;
	if (!sheet) return [];
	const workbook = load('item-workbook');
	return (workbook[sheet] || []).map(row => ({
		place: row.place || null,
		detail: row.detail || null,
	}));
}

function moveItems() {
	return load('availability').moveItems || [];
}

/**
 * Coverage statement for move unlocks shown in progression UI.
 *
 * TM and tutor locations are imported from the operator's Items Locations
 * sheet (via pokemon-mono rab-tms-tutors); most rows carry a late-biased
 * unlock date through LOCATION_UNLOCKS. Rows without a datable place keep
 * opensAt null — consumers must present those as "location known, timing
 * unproven", never as available-now.
 */
function moveAvailability() {
	const rows = moveItems();
	if (!rows.length) {
		return {
			status: 'undated',
			available: [],
			note: 'TM and tutor moves are known, but their locations and unlock timing are not dated yet.',
		};
	}
	const undated = rows.filter(row => row.opensAt === null).length;
	return {
		status: 'dated',
		available: rows,
		note: rows.length + ' TM and tutor locations on file' +
			(undated ? ', ' + undated + ' without a dated unlock' : ''),
	};
}

/**
 * Enumerated removed-species names that no single growth key answers to.
 *
 * Exported so the gap is checkable rather than folklore. One name is on it:
 * "Aegislash", where the growth table carries Aegislash-Shield and
 * Aegislash-Blade and choosing between them — or claiming both — is a ruling
 * about what the source meant.
 */
function unavailableNamesWithoutGrowthKey() {
	return UNAVAILABLE_UNJOINED.slice();
}

/**
 * The precomputed fight dossier: threat metrics, tech flags and named
 * answers, built offline by scripts/build-fight-dossiers.js so a runtime
 * consumer pays a dictionary lookup. Null for a trainer the map does not
 * know — a consumer treats that as "no dossier", never as an error.
 */
let DOSSIER_INDEX = null;
function fightDossierOf(trainer) {
	if (!DOSSIER_INDEX) {
		const doc = require('./oracle/fight-dossiers.json');
		DOSSIER_INDEX = new Map(doc.fights.map(row => [row.trainer, row]));
	}
	return DOSSIER_INDEX.get(trainer) || null;
}

module.exports = {
	fightDossierOf,
	maps, getMap, encountersOn, whereToFind, availabilityOfSpecies, nonWildSources, areaOf, availabilityOf, methodOpensAt, moveObtainableAt,
	unavailableNamesWithoutGrowthKey,
	moveAvailability, moveItems,
	currencySources,
	fightFieldOf, itemsObtainableBy, fieldItems, shopItems,
	evolutionsOf, preEvolutionOf, lineageOf, familyOf,
	levelUpMoves, teachableMoves, ownEggMoves, legalMoves, canLearn,
	growthRateOf, expForLevel, levelFromExp, catchRateOf,
	coverage, LIMITS,
};
