/* eslint-env node, es6 */
'use strict';

/**
 * Player teams.
 *
 * The planner takes a `playerParty`, and until now the only way to supply one
 * was `{species, setLabel}` — a lookup into the trainer table. That reads as a
 * convenience and is actually a correctness hole: it puts a TRAINER'S build on
 * the player's side. "Metagross (Trainer Steven Space Center)" is Steven's
 * level 89 Metagross, with his Life Orb, his Brave nature and his 0 Speed IV
 * for Trick Room. No player can have that Pokemon, at that level, at that point
 * in the run.
 *
 * That matters beyond tidiness. The AI scores its actions against whatever is
 * across from it — types, stats, ability, item all feed the damage projection
 * that produces the score, and therefore the ranking. Plan against a build the
 * player cannot field and the ranking is an answer to a question nobody asked.
 *
 * So a player team is DECLARED, not borrowed. The format is a Showdown paste,
 * because that is what a player already has and already knows how to write:
 *
 *   Swampert @ Leftovers
 *   Ability: Torrent
 *   Level: 45
 *   Adamant Nature
 *   - Earthquake
 *   - Waterfall
 *   - Ice Punch
 *   - Rock Slide
 *
 * Run & Bun removes EVs (`docs/AI_DATA_MODEL.md`), so an `EVs:` line is accepted and
 * reported back as ignored rather than silently dropped — a player pasting a
 * competitive export should be told their spread does nothing here, not left to
 * assume it applied.
 *
 * What this module does NOT do is legality. Whether a species is obtainable
 * before a given badge needs an availability table this project does not have,
 * and inventing one would be exactly the kind of unsourced claim the profile
 * layer exists to prevent. Level, by contrast, is checkable and is checked: the
 * caller gets the delta against the fight.
 */

const calc = require('@smogon/calc');

const GEN = 8;

const STAT_KEYS = {
	hp: 'hp',
	atk: 'atk',
	def: 'def',
	spa: 'spa',
	spd: 'spd',
	spe: 'spe',
};

const NATURES = new Set([
	'Adamant', 'Bashful', 'Bold', 'Brave', 'Calm', 'Careful', 'Docile', 'Gentle',
	'Hardy', 'Hasty', 'Impish', 'Jolly', 'Lax', 'Lonely', 'Mild', 'Modest',
	'Naive', 'Naughty', 'Quiet', 'Quirky', 'Rash', 'Relaxed', 'Sassy', 'Serious',
	'Timid',
]);

function gen() {
	return calc.Generations.get(GEN);
}

/** `31 HP / 0 Atk / 31 Spe` → a partial stat map. Throws on an unknown stat. */
function parseStatLine(line, label) {
	const out = {};
	for (const chunk of line.split('/')) {
		const part = chunk.trim();
		if (!part) continue;
		const match = part.match(/^(\d+)\s+([A-Za-z]+)$/);
		if (!match) {
			throw new Error(`${label}: expected "31 Atk / 0 Spe", got ${JSON.stringify(part)}`);
		}
		const key = STAT_KEYS[match[2].toLowerCase()];
		if (!key) throw new Error(`${label}: unknown stat ${JSON.stringify(match[2])}`);
		out[key] = Number(match[1]);
	}
	return out;
}

/**
 * One Pokemon's block of a Showdown paste.
 *
 * The header line is the awkward part: `Nickname (Species) (F) @ Item` is legal
 * and so is a bare `Species`. Parsed outside-in — item, then gender, then a
 * parenthesised species — so a nickname containing a space or an item
 * containing a hyphen cannot be mistaken for one of the other fields.
 */
function parseBlock(lines, blockNumber) {
	const where = `Pokemon ${blockNumber}`;
	const mon = {moves: [], ivs: {}};
	let header = lines[0].trim();

	const at = header.lastIndexOf(' @ ');
	if (at !== -1) {
		mon.item = header.slice(at + 3).trim();
		header = header.slice(0, at).trim();
	}

	const gender = header.match(/\s\((M|F)\)$/);
	if (gender) {
		mon.gender = gender[1];
		header = header.slice(0, gender.index).trim();
	}

	const named = header.match(/^(.*?)\s*\((.+)\)$/);
	// `Swampert (M)` already lost its gender above, so a surviving parenthesis is
	// a nickname wrapper: the species is what is inside it.
	mon.species = named ? named[2].trim() : header.trim();
	if (named) mon.nickname = named[1].trim();
	if (!mon.species) throw new Error(`${where}: no species on the first line`);

	for (const raw of lines.slice(1)) {
		const line = raw.trim();
		if (!line) continue;
		if (line.startsWith('-')) {
			const move = line.slice(1).trim();
			if (move) mon.moves.push(move);
			continue;
		}
		const colon = line.indexOf(':');
		const key = colon === -1 ? '' : line.slice(0, colon).trim().toLowerCase();
		const value = colon === -1 ? '' : line.slice(colon + 1).trim();
		if (key === 'ability') mon.ability = value;
		else if (key === 'level') mon.level = Number(value);
		else if (key === 'ivs') Object.assign(mon.ivs, parseStatLine(value, `${where} IVs`));
		else if (key === 'evs') mon.declaredEvs = parseStatLine(value, `${where} EVs`);
		else if (key === 'tera type') mon.teraType = value;
		else if (key === 'shiny' || key === 'happiness' || key === 'gigantamax') continue;
		else if (/\bNature$/i.test(line)) mon.nature = line.replace(/\s*Nature$/i, '').trim();
		else throw new Error(`${where}: could not read ${JSON.stringify(line)}`);
	}

	if (!mon.moves.length) throw new Error(`${where} (${mon.species}): needs at least one move`);
	return mon;
}

/**
 * Validate against the game's own data.
 *
 * A misspelled species or move is the single most likely mistake in a hand-typed
 * paste, and the failure mode without this check is silent: the calculator
 * builds a Pokemon with no stats, the AI scores against it, and a plausible
 * ranking comes back for a Pokemon that does not exist.
 */
function validate(mon, blockNumber) {
	const where = `Pokemon ${blockNumber} (${mon.species})`;
	const data = gen();

	if (!data.species.get(calc.toID(mon.species))) {
		throw new Error(`${where}: unknown species`);
	}
	if (mon.level !== undefined) {
		if (!Number.isInteger(mon.level) || mon.level < 1 || mon.level > 100) {
			throw new Error(`${where}: level must be an integer from 1 to 100`);
		}
	}
	if (mon.nature && !NATURES.has(mon.nature)) {
		throw new Error(`${where}: unknown nature ${JSON.stringify(mon.nature)}`);
	}
	if (mon.ability && !data.abilities.get(calc.toID(mon.ability))) {
		throw new Error(`${where}: unknown ability ${JSON.stringify(mon.ability)}`);
	}
	if (mon.item && !data.items.get(calc.toID(mon.item))) {
		throw new Error(`${where}: unknown item ${JSON.stringify(mon.item)}`);
	}
	for (const move of mon.moves) {
		if (!data.moves.get(calc.toID(move))) {
			throw new Error(`${where}: unknown move ${JSON.stringify(move)}`);
		}
	}
	for (const stat of Object.keys(mon.ivs)) {
		const value = mon.ivs[stat];
		if (!Number.isInteger(value) || value < 0 || value > 31) {
			throw new Error(`${where}: IV ${stat} must be an integer from 0 to 31`);
		}
	}
	if (mon.moves.length > 4) throw new Error(`${where}: more than four moves`);
}

/**
 * Parse a Showdown paste into player specs.
 *
 * Returns `{party, notes}`. Notes carry what was accepted-but-ignored, so a
 * caller can surface it; nothing is dropped quietly.
 */
function parseTeam(text) {
	const source = String(text || '')
		.replace(/\r\n?/g, '\n')
		// Not part of the Showdown format, but a team lives in a file here and a
		// file wants a header explaining what it is. No species or move begins
		// with `#`, so the extension cannot collide with real content.
		.replace(/^[ \t]*#.*$/gm, '');
	const blocks = source.split(/\n\s*\n/)
		.map(block => block.split('\n').filter(line => line.trim()))
		.filter(lines => lines.length);

	if (!blocks.length) throw new Error('empty team: nothing to plan with');
	if (blocks.length > 6) throw new Error(`a party holds six, this paste has ${blocks.length}`);

	const party = [];
	const notes = [];
	blocks.forEach((lines, i) => {
		const mon = parseBlock(lines, i + 1);
		validate(mon, i + 1);
		if (mon.declaredEvs) {
			// Reported rather than dropped: a competitive export carries a spread,
			// and a player who pastes one deserves to know it did nothing.
			notes.push(`${mon.species}: EVs ignored — Run & Bun removes EVs.`);
			delete mon.declaredEvs;
		}
		if (mon.level === undefined) {
			notes.push(`${mon.species}: no level given, assuming 100.`);
			mon.level = 100;
		}
		party.push(mon);
	});

	return {party, notes};
}

/** Render a spec back to a paste. Round-tripping is how a caller edits a team. */
function formatMon(mon) {
	const lines = [];
	lines.push((mon.nickname ? `${mon.nickname} (${mon.species})` : mon.species) +
		(mon.gender ? ` (${mon.gender})` : '') +
		(mon.item ? ` @ ${mon.item}` : ''));
	if (mon.ability) lines.push(`Ability: ${mon.ability}`);
	if (mon.level !== undefined) lines.push(`Level: ${mon.level}`);
	if (mon.nature) lines.push(`${mon.nature} Nature`);
	const declared = mon.ivs || {};
	const ivs = Object.keys(declared)
		.filter(stat => declared[stat] !== 31)
		.map(stat => `${declared[stat]} ${stat[0].toUpperCase()}${stat.slice(1)}`);
	if (ivs.length) lines.push(`IVs: ${ivs.join(' / ')}`);
	for (const move of mon.moves) lines.push(`- ${move}`);
	return lines.join('\n');
}

function formatTeam(party) {
	return party.map(formatMon).join('\n\n');
}

module.exports = {parseTeam, formatTeam, formatMon, NATURES};
