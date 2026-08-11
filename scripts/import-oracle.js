/* eslint-env node, es6 */
'use strict';

/**
 * Import the oracle — the hack author's own ROM decomp — into profile data.
 *
 * Everything this project knows about Run & Bun's content ultimately comes from
 * `dekzeh/runandbundex`. Base stats, ability slots and the move overlay were
 * checked against it by hand in earlier passes, which proved the values but left
 * no repeatable path: nothing in the repository could regenerate them, and
 * nothing recorded how a constant in the decomp becomes a name the calculator
 * understands.
 *
 * This script is that path, for the four datasets the project never had:
 *
 *   wild encounters   which species appear where, at what levels, by what method
 *   evolutions        what turns into what, and what it costs
 *   level-up moves    what a species learns, and when
 *   teachable moves   what it can be taught at all
 *
 * Together they are what separates a calculator from a companion. Without them a
 * player's box is whatever they type; with them, catching, evolving and teaching
 * can be checked against the game rather than trusted.
 *
 * Run deliberately, never as part of the build:
 *
 *   node scripts/import-oracle.js --decomp /path/to/runandbundex
 *
 * Output lands in `profiles/run-and-bun/oracle/` as JSON. Generated files are
 * checked in — the decomp is a separate repository that a build must not depend
 * on being present, and a diff on regeneration is exactly the review signal that
 * catches an upstream change.
 *
 * NAME MAPPING is the load-bearing part and the easiest place to lie. The decomp
 * speaks in constants (`SPECIES_ZIGZAGOON_GALARIAN`), the calculator speaks in
 * names (`Zigzagoon-Galar`). Where a mapping cannot be made the import FAILS
 * rather than dropping the row: a silently shorter encounter table looks exactly
 * like a route with fewer Pokemon on it.
 *
 * The one deliberate collapse is cosmetic forms. Vivillon patterns, Florges
 * flower colours, Deerling seasons and Alcremie creams are battle-identical, and
 * the calculator does not model them separately. They map to their base species
 * through an explicit table, so the collapse is a decision on the record rather
 * than a regex that happened to match.
 */

const fs = require('node:fs');
const path = require('node:path');

const calc = require('@smogon/calc');

const GEN = 8;
const gen = calc.Generations.get(GEN);
const OUT_DIR = path.join(__dirname, '..', 'profiles', 'run-and-bun', 'oracle');

/**
 * Form suffixes the decomp spells out and the calculator abbreviates.
 * Applied only after the whole constant fails to resolve on its own.
 */
const FORM_SUFFIXES = {
	MEGA: 'Mega',
	MEGA_X: 'Mega-X',
	MEGA_Y: 'Mega-Y',
	GALARIAN: 'Galar',
	ALOLAN: 'Alola',
	HISUIAN: 'Hisui',
	PALDEAN: 'Paldea',
	THERIAN: 'Therian',
	ORIGIN: 'Origin',
	PRIMAL: 'Primal',
};

/**
 * Constants whose calculator name cannot be derived from the constant.
 *
 * Two kinds, and they are not the same claim:
 *
 *   - real battle forms the calculator names differently
 *     (`SPECIES_AEGISLASH` carries the SHIELD form's stats — 50/140/140 — so it
 *     is `Aegislash-Shield`; `SPECIES_AEGISLASH_BLADE` is the blade form and
 *     resolves on its own, and the calculator has no bare `Aegislash`)
 *   - COSMETIC forms the calculator does not model, collapsed to their base.
 *     This loses nothing in battle: a Sandstorm Vivillon and a Polar Vivillon
 *     have identical stats, types, abilities and movepool.
 */
const SPECIES_ALIASES = {
	SPECIES_AEGISLASH: 'Aegislash-Shield',
	SPECIES_MEOWSTIC_FEMALE: 'Meowstic-F',
	SPECIES_INDEEDEE_FEMALE: 'Indeedee-F',
	SPECIES_URSHIFU_RAPID_STRIKE_STYLE: 'Urshifu-Rapid-Strike',
	SPECIES_ZACIAN_CROWNED_SWORD: 'Zacian-Crowned',
	SPECIES_ZAMAZENTA_CROWNED_SHIELD: 'Zamazenta-Crowned',
	SPECIES_CALYREX_ICE_RIDER: 'Calyrex-Ice',
	SPECIES_CALYREX_SHADOW_RIDER: 'Calyrex-Shadow',
	SPECIES_DARMANITAN_ZEN_MODE: 'Darmanitan-Zen',
	SPECIES_DARMANITAN_ZEN_MODE_GALARIAN: 'Darmanitan-Galar-Zen',
	SPECIES_EISCUE_NOICE_FACE: 'Eiscue-Noice',
	SPECIES_GRENINJA_BATTLE_BOND: 'Greninja-Ash',
	SPECIES_MAGEARNA_ORIGINAL_COLOR: 'Magearna-Original',
	SPECIES_XERNEAS_ACTIVE: 'Xerneas',
	SPECIES_ZYGARDE_10_POWER_CONSTRUCT: 'Zygarde-10%',
	SPECIES_ZYGARDE_50_POWER_CONSTRUCT: 'Zygarde',
	SPECIES_ROCKRUFF_OWN_TEMPO: 'Rockruff',
	SPECIES_WORMADAM_SANDY_CLOAK: 'Wormadam-Sandy',
	SPECIES_WORMADAM_TRASH_CLOAK: 'Wormadam-Trash',
	SPECIES_BURMY_SANDY_CLOAK: 'Burmy',
	SPECIES_BURMY_TRASH_CLOAK: 'Burmy',
	SPECIES_SHELLOS_EAST_SEA: 'Shellos',
	SPECIES_GASTRODON_EAST_SEA: 'Gastrodon',
	SPECIES_FLOETTE_ETERNAL_FLOWER: 'Floette-Eternal',
	SPECIES_PICHU_SPIKY_EARED: 'Pichu',
	SPECIES_MINIOR_METEOR: 'Minior-Meteor',
};

/** Cosmetic form families: `PREFIX_*` collapses to the named base species. */
const COSMETIC_FAMILIES = [
	['SPECIES_UNOWN_', 'Unown'],
	['SPECIES_VIVILLON_', 'Vivillon'],
	['SPECIES_FLABEBE_', 'Flabebe'],
	['SPECIES_FLOETTE_', 'Floette'],
	['SPECIES_FLORGES_', 'Florges'],
	['SPECIES_FURFROU_', 'Furfrou'],
	['SPECIES_ALCREMIE_', 'Alcremie'],
	['SPECIES_DEERLING_', 'Deerling'],
	['SPECIES_SAWSBUCK_', 'Sawsbuck'],
	['SPECIES_PIKACHU_', 'Pikachu'],
	['SPECIES_MINIOR_CORE_', 'Minior'],
	['SPECIES_MINIOR_METEOR_', 'Minior-Meteor'],
	['SPECIES_GENESECT_', 'Genesect'],
];

function titleCase(token) {
	return token.charAt(0) + token.slice(1).toLowerCase();
}

/** `SPECIES_ZIGZAGOON_GALARIAN` → `Zigzagoon-Galar`, or null. */
function resolveSpecies(constant) {
	if (constant === 'SPECIES_NONE' || constant === 'SPECIES_EGG') return null;
	if (SPECIES_ALIASES[constant]) return SPECIES_ALIASES[constant];

	const bare = constant.replace(/^SPECIES_/, '');
	const direct = gen.species.get(calc.toID(bare));
	if (direct) return direct.name;

	const parts = bare.split('_');
	for (let i = parts.length - 1; i > 0; i--) {
		const stem = parts.slice(0, i).join('');
		const rawForm = parts.slice(i).join('_');
		const mapped = FORM_SUFFIXES[rawForm];
		if (mapped) {
			const hit = gen.species.get(calc.toID(stem + mapped));
			if (hit) return hit.name;
		}
		const joined = gen.species.get(calc.toID(stem + rawForm));
		if (joined) return joined.name;
	}

	for (const family of COSMETIC_FAMILIES) {
		if (constant.startsWith(family[0])) return family[1];
	}
	return null;
}

/**
 * Moves the decomp and the calculator spell differently.
 *
 * `Vice Grip` was renamed `Vise Grip` in Gen 8; pokeemerald kept the old
 * spelling. Same move, and a name-mapping table is the honest place to say so.
 */
const MOVE_ALIASES = {
	MOVE_VICE_GRIP: 'Vise Grip',
};

/** `MOVE_DRAGON_DANCE` → `Dragon Dance`, or null for a sentinel. */
function resolveMove(constant) {
	if (constant === 'MOVE_NONE' || constant === 'MOVE_UNAVAILABLE') return null;
	if (MOVE_ALIASES[constant]) return MOVE_ALIASES[constant];
	const bare = constant.replace(/^MOVE_/, '');
	const hit = gen.moves.get(calc.toID(bare));
	if (hit) return hit.name;
	// `MOVE_HIDDEN_POWER_*` and friends spell out a type the calculator folds in.
	const words = bare.split('_').map(titleCase).join(' ');
	const spaced = gen.moves.get(calc.toID(words));
	return spaced ? spaced.name : null;
}

/** `ITEM_THUNDER_STONE` → `Thunder Stone`; unknown items keep a readable name. */
function resolveItem(constant) {
	if (!constant || constant === 'ITEM_NONE') return null;
	const bare = constant.replace(/^ITEM_/, '');
	const hit = gen.items.get(calc.toID(bare));
	if (hit) return hit.name;
	return bare.split('_').map(titleCase).join(' ');
}

// ------------------------------------------------------------------ encounters

/**
 * Which slot table a species sits in. The decomp's key names are the method:
 * a player looking for a Feebas needs to know it is fished, not walked into.
 */
const ENCOUNTER_METHODS = {
	land_mons: 'walk',
	water_mons: 'surf',
	rock_smash_mons: 'rock-smash',
	fishing_mons: 'fish',
};

/**
 * Which rod reaches which fishing slot, read from the encounter group's own
 * `fields` declaration rather than assumed.
 *
 * Vanilla pokeemerald splits the ten fishing slots three ways — 0-1 old, 2-4
 * good, 5-9 super — but that split is a property of the data, not of the format,
 * and a hack is free to declare otherwise. Run & Bun does: it declares a single
 * `super_rod` group covering all ten slots, so there is no old- or good-rod
 * fishing in the game at all. Hardcoding vanilla's boundaries here would invent
 * two rods the hack does not have.
 */
function fishingRods(fields) {
	const declared = (fields || []).find(f => f.type === 'fishing_mons');
	const groups = declared && declared.groups;
	if (!groups) throw new Error('wild_encounters.json: fishing_mons declares no rod groups');
	const byIndex = new Map();
	for (const name of Object.keys(groups)) {
		const rod = name.toUpperCase().split('_').map(titleCase).join(' ');
		for (const index of groups[name]) byIndex.set(index, rod);
	}
	return byIndex;
}

function mapLabel(map) {
	return map.replace(/^MAP_/, '').split('_').map(titleCase).join(' ');
}

function importEncounters(decomp, problems) {
	const raw = JSON.parse(
		fs.readFileSync(path.join(decomp, 'locations', 'wild_encounters.json'), 'utf8'));
	const group = raw.wild_encounter_groups.find(g => g.label === 'gWildMonHeaders');
	if (!group) throw new Error('wild_encounters.json has no gWildMonHeaders group');
	const rodByIndex = fishingRods(group.fields);

	const maps = [];
	for (const entry of group.encounters) {
		const location = {map: entry.map, name: mapLabel(entry.map), tables: []};
		for (const key of Object.keys(ENCOUNTER_METHODS)) {
			const table = entry[key];
			if (!table || !table.mons || !table.mons.length) continue;
			const method = ENCOUNTER_METHODS[key];

			// One slot per distinct (species, level range). The raw table repeats a
			// species once per encounter slot to express its rate; a player choosing
			// what to catch wants the roster, and the slot count is the rate.
			const grouped = new Map();
			table.mons.forEach((mon, index) => {
				// An empty slot is data, not a failure: several tables are padded out
				// to a fixed length with SPECIES_NONE. Treating that as unresolved
				// would drown the real name-mapping errors this check exists to find.
				if (mon.species === 'SPECIES_NONE') return;
				const species = resolveSpecies(mon.species);
				if (!species) {
					problems.push(`${entry.map}/${key}[${index}]: cannot resolve ${mon.species}`);
					return;
				}
				const rod = method === 'fish' ? rodByIndex.get(index) : null;
				if (method === 'fish' && !rod) {
					problems.push(`${entry.map}/${key}[${index}]: no rod group declares slot ${index}`);
					return;
				}
				const key2 = `${species}|${mon.min_level}|${mon.max_level}|${rod || ''}`;
				const found = grouped.get(key2);
				if (found) {
					found.slots += 1;
					return;
				}
				grouped.set(key2, {
					species,
					minLevel: mon.min_level,
					maxLevel: mon.max_level,
					slots: 1,
					...(rod ? {rod} : {}),
				});
			});

			location.tables.push({
				method,
				encounterRate: table.encounter_rate,
				mons: [...grouped.values()],
			});
		}
		if (location.tables.length) maps.push(location);
	}
	return {maps};
}

// ------------------------------------------------------------------ evolutions

/**
 * `EVO_*` methods, named for a player rather than for the ROM.
 *
 * `requirement` says what the number in the second field means, because it is
 * three different things depending on the method — a level, an item, or nothing
 * at all — and a consumer that guesses will guess wrong.
 */
const EVO_METHODS = {
	EVO_LEVEL: 'level',
	EVO_FRIENDSHIP: 'friendship',
	EVO_FRIENDSHIP_DAY: 'friendship-day',
	EVO_FRIENDSHIP_NIGHT: 'friendship-night',
	EVO_ITEM: 'item',
	EVO_TRADE: 'trade',
	EVO_TRADE_ITEM: 'trade-item',
	EVO_LEVEL_ATK_GT_DEF: 'level',
	EVO_LEVEL_ATK_EQ_DEF: 'level',
	EVO_LEVEL_ATK_LT_DEF: 'level',
	EVO_LEVEL_SILCOON: 'level',
	EVO_LEVEL_CASCOON: 'level',
	EVO_LEVEL_NINJASK: 'level',
	EVO_LEVEL_SHEDINJA: 'level',
	EVO_BEAUTY: 'beauty',
	EVO_LEVEL_FEMALE: 'level',
	EVO_LEVEL_MALE: 'level',
	EVO_LEVEL_NIGHT: 'level-night',
	EVO_LEVEL_DAY: 'level-day',
	EVO_LEVEL_DUSK: 'level-dusk',
	EVO_ITEM_HOLD_DAY: 'item-hold-day',
	EVO_ITEM_HOLD_NIGHT: 'item-hold-night',
	EVO_MOVE: 'move',
	EVO_MOVE_TYPE: 'move-type',
	EVO_MAPSEC: 'location',
	EVO_ITEM_MALE: 'item',
	EVO_ITEM_FEMALE: 'item',
	EVO_LEVEL_RAIN: 'level-rain',
	EVO_SPECIFIC_MON_IN_PARTY: 'party-member',
	EVO_LEVEL_DARK_TYPE_MON_IN_PARTY: 'level-dark-in-party',
	EVO_TRADE_SPECIFIC_MON: 'trade-for',
	EVO_SPECIFIC_MAP: 'location',
	EVO_MEGA_EVOLUTION: 'mega',
	EVO_MOVE_MEGA_EVOLUTION: 'mega-move',
	EVO_PRIMAL_REVERSION: 'primal',
	EVO_CRITICAL_HITS: 'critical-hits',
	EVO_SCRIPT_TRIGGER_DMG: 'script',
	EVO_DARK_SCROLL: 'item',
	EVO_WATER_SCROLL: 'item',
	EVO_LEVEL_NATURE_AMPED: 'level-nature-amped',
	EVO_LEVEL_NATURE_LOW_KEY: 'level-nature-low-key',
};

/** Methods whose numeric parameter is a level the player must reach. */
const LEVEL_METHODS = new Set(['level', 'level-night', 'level-day', 'level-dusk', 'level-rain',
	'level-dark-in-party', 'level-nature-amped', 'level-nature-low-key']);

function importEvolutions(decomp, problems) {
	const source = fs.readFileSync(
		path.join(decomp, 'species', 'evolution.h'), 'utf8').replace(/\r/g, '');
	const byFrom = {};
	// An entry runs from its own `[SPECIES_X] =` to the next one's, and is never
	// recognised by how it closes. Its closing shape is not reliable: Eevee's entry
	// wraps branches in `#if P_GEN_*_POKEMON` blocks and ends with a lone `}` on
	// its own line, so a pattern anchored on `}}` runs straight past it and eats
	// the following entry — which is exactly how Porygon lost its evolution and
	// Eevee gained a phantom Porygon2 branch.
	const heads = [...source.matchAll(/\[(SPECIES_[A-Z0-9_]+)\]\s*=/g)];
	for (let i = 0; i < heads.length; i++) {
		const constant = heads[i][1];
		const entry = source.slice(heads[i].index + heads[i][0].length,
			i + 1 < heads.length ? heads[i + 1].index : source.length);
		const from = resolveSpecies(constant);
		if (!from) continue;
		const evos = [];
		for (const evo of entry.matchAll(/\{(EVO_[A-Z0-9_]+),\s*([A-Z0-9_]+),\s*(SPECIES_[A-Z0-9_]+)\}/g)) {
			const method = EVO_METHODS[evo[1]];
			if (!method) {
				problems.push(`evolution.h: unknown method ${evo[1]} on ${constant}`);
				continue;
			}
			const into = resolveSpecies(evo[3]);
			if (!into) {
				problems.push(`evolution.h: cannot resolve ${evo[3]} (from ${constant})`);
				continue;
			}
			const step = {into, method};
			if (LEVEL_METHODS.has(method)) step.level = Number(evo[2]);
			else if (/^ITEM_/.test(evo[2])) step.item = resolveItem(evo[2]);
			else if (/^MOVE_/.test(evo[2])) step.move = resolveMove(evo[2]);
			else if (/^\d+$/.test(evo[2])) step.value = Number(evo[2]);
			else if (evo[2] !== '0') step.condition = evo[2];
			evos.push(step);
		}
		// Mega evolution and primal reversion are in-battle form changes, not
		// something a box entry becomes. Kept out so `evolve` cannot be used to
		// permanently turn a Charizard into a Charizard-Mega-X.
		const permanent = evos.filter(e => e.method !== 'mega' && e.method !== 'mega-move' &&
			e.method !== 'primal');
		// First resolution wins, as in the learnset importer: the base constant's
		// row is the species' own, and every later constant that resolves to the
		// same name is a form collapsed onto it. Letting the last write win would
		// replace Rockruff's three stone branches with SPECIES_ROCKRUFF_OWN_TEMPO's
		// single level-dusk step.
		if (permanent.length && !byFrom[from]) byFrom[from] = permanent;
	}
	return byFrom;
}

// ------------------------------------------------------------------- learnsets

/** `sZigzagoonGalarianLevelUpLearnset` → the moves it lists, in order. */
function parseLearnsetBlocks(source, pattern) {
	const blocks = {};
	for (const match of source.matchAll(pattern)) {
		blocks[match[1]] = match[2];
	}
	return blocks;
}

/** `[SPECIES_X] = sYLearnset,` → which block each species points at. */
function parsePointers(source, arrayName) {
	const start = source.indexOf(arrayName);
	if (start === -1) throw new Error(`${arrayName} not found`);
	const body = source.slice(start);
	const pointers = {};
	for (const match of body.matchAll(/\[(SPECIES_[A-Z0-9_]+)\]\s*=\s*(s[A-Za-z0-9_]+),/g)) {
		pointers[match[1]] = match[2];
	}
	return pointers;
}

function importLearnsets(decomp, problems) {
	const dir = path.join(decomp, 'species');
	const levelSource = fs.readFileSync(path.join(dir, 'level_up_learnsets.h'), 'utf8');
	const levelPointers = parsePointers(
		fs.readFileSync(path.join(dir, 'level_up_learnset_pointers.h'), 'utf8'), 'gLevelUpLearnsets');
	const levelBlocks = parseLearnsetBlocks(levelSource,
		/static const struct LevelUpMove (s[A-Za-z0-9_]+)\[\] = \{([\s\S]*?)\n\};/g);

	const teachSource = fs.readFileSync(path.join(dir, 'teachable_learnsets.h'), 'utf8');
	const teachPointers = parsePointers(
		fs.readFileSync(path.join(dir, 'teachable_learnset_pointers.h'), 'utf8'), 'gTeachableLearnsets');
	const teachBlocks = parseLearnsetBlocks(teachSource,
		/static const u16 (s[A-Za-z0-9_]+)\[\] = \{([\s\S]*?)\n\};/g);

	const levelUp = {};
	const teachable = {};

	for (const constant of Object.keys(levelPointers)) {
		const species = resolveSpecies(constant);
		if (!species) continue;
		const block = levelBlocks[levelPointers[constant]];
		if (block === undefined) {
			problems.push(`level_up_learnsets: no block ${levelPointers[constant]} for ${constant}`);
			continue;
		}
		const moves = [];
		for (const move of block.matchAll(/LEVEL_UP_MOVE\(\s*(\d+),\s*(MOVE_[A-Z0-9_]+)\)/g)) {
			// `MOVE_NONE` terminates the list; it is a sentinel, not a move.
			if (move[2] === 'MOVE_NONE') continue;
			const name = resolveMove(move[2]);
			if (!name) {
				problems.push(`level_up_learnsets: cannot resolve ${move[2]} for ${constant}`);
				continue;
			}
			moves.push([Number(move[1]), name]);
		}
		// A cosmetic form collapses onto its base; keep the first, which is the
		// base species' own list, rather than letting a pattern overwrite it.
		if (!levelUp[species]) levelUp[species] = moves;
	}

	for (const constant of Object.keys(teachPointers)) {
		const species = resolveSpecies(constant);
		if (!species) continue;
		const block = teachBlocks[teachPointers[constant]];
		if (block === undefined) {
			problems.push(`teachable_learnsets: no block ${teachPointers[constant]} for ${constant}`);
			continue;
		}
		const moves = [];
		for (const move of block.matchAll(/\b(MOVE_[A-Z0-9_]+)\b/g)) {
			if (move[1] === 'MOVE_NONE' || move[1] === 'MOVE_UNAVAILABLE') continue;
			const name = resolveMove(move[1]);
			if (!name) {
				problems.push(`teachable_learnsets: cannot resolve ${move[1]} for ${constant}`);
				continue;
			}
			moves.push(name);
		}
		if (!teachable[species]) teachable[species] = moves;
	}

	// Egg moves belong to the BASE species of a line and travel up it: a Breloom
	// can hold Bullet Seed because a Shroomish can hatch with it. Recorded here
	// keyed by the species the decomp names, with the walk up the line left to
	// the consumer, which is the only place the evolution table is also in hand.
	const eggSource = fs.readFileSync(path.join(dir, 'egg_moves.h'), 'utf8');
	const egg = {};
	for (const block of eggSource.matchAll(/egg_moves\(([A-Z0-9_]+),([\s\S]*?)\)\s*,?\s*\n/g)) {
		const species = resolveSpecies(`SPECIES_${block[1]}`);
		if (!species) {
			problems.push(`egg_moves: cannot resolve SPECIES_${block[1]}`);
			continue;
		}
		const moves = [];
		for (const move of block[2].matchAll(/\b(MOVE_[A-Z0-9_]+)\b/g)) {
			if (move[1] === 'MOVE_NONE') continue;
			const name = resolveMove(move[1]);
			if (!name) {
				problems.push(`egg_moves: cannot resolve ${move[1]} for ${species}`);
				continue;
			}
			moves.push(name);
		}
		if (!egg[species]) egg[species] = moves;
	}

	return {levelUp, teachable, egg};
}

// ------------------------------------------------------------------------ main

function write(name, value, summary) {
	fs.mkdirSync(OUT_DIR, {recursive: true});
	const file = path.join(OUT_DIR, name);
	fs.writeFileSync(file, `${JSON.stringify(value, null, 0)}\n`);
	const bytes = fs.statSync(file).size;
	console.log(`${name.padEnd(20)} ${String(bytes).padStart(9)} bytes  ${summary}`);
}

function main(argv) {
	const at = argv.indexOf('--decomp');
	const decomp = at === -1 ? '/workspace/dekzeh/runandbundex' : argv[at + 1];
	if (!fs.existsSync(path.join(decomp, 'species', 'base_stats.h'))) {
		throw new Error(`no decomp at ${decomp}; pass --decomp <path>`);
	}

	const problems = [];
	const encounters = importEncounters(decomp, problems);
	const evolutions = importEvolutions(decomp, problems);
	const learnsets = importLearnsets(decomp, problems);

	// A partial import is worse than none: a short encounter table is
	// indistinguishable from a route with fewer Pokemon on it.
	if (problems.length) {
		console.error(`${problems.length} unresolved references:`);
		for (const problem of problems.slice(0, 40)) console.error(`  ${problem}`);
		if (problems.length > 40) console.error(`  ... and ${problems.length - 40} more`);
		throw new Error('import aborted: every reference must resolve');
	}

	const monCount = encounters.maps
		.reduce((sum, m) => sum + m.tables.reduce((n, t) => n + t.mons.length, 0), 0);
	write('encounters.json', encounters, `${encounters.maps.length} maps, ${monCount} slots`);
	write('evolutions.json', evolutions, `${Object.keys(evolutions).length} species evolve`);
	write('learnsets.json', learnsets,
		`${Object.keys(learnsets.levelUp).length} level-up, ` +
		`${Object.keys(learnsets.teachable).length} teachable, ` +
		`${Object.keys(learnsets.egg).length} egg`);
}

if (require.main === module) {
	try {
		main(process.argv.slice(2));
	} catch (error) {
		console.error(`import-oracle: ${error.message}`);
		process.exitCode = 1;
	}
}

module.exports = {resolveSpecies, resolveMove, resolveItem, importEncounters,
	importEvolutions, importLearnsets};
