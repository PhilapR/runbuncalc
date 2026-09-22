/* eslint-env node, es6 */
'use strict';

/**
 * Import PER-FIGHT FIELD CONDITIONS — the permanent overworld weather and
 * terrain certain fights are always fought under — from the operator's rab
 * trainer database, which annotates them on its location strings:
 *
 *   "Route 119 (West), permanent Rain"
 *   "Route 119 (East), permanent Rain and Electric Terrain"
 *   "Route 111 (Desert), permanent Sandstorm"
 *   "Seafloor Cavern, permanent Aurora Veil"
 *
 * The game's own Mechanic Changes doc names the rule ("Overworld Weather ...
 * summons permanent Rain Dance", "Permanent Aurora Veil set up for the
 * opponent") — rab's annotations say WHICH trainers stand in it. Without
 * this, every fight on those routes is planned in clear skies.
 *
 * An annotation reaches a fight of this run map by one of four named rules,
 * and the output records which rule placed each fight (`derivation`):
 *
 *   exact              the trainer's name, or class + name, is a fight label
 *   duo-prefix         it is the first half of a merged pair battle
 *                      ("Ruin Maniac Bryan" -> "Ruin Maniac Bryan & Celia")
 *   seafloor-location  a Seafloor Cavern annotation covers every fight that
 *                      carries the location in its label (the Aqua crew)
 *   bridge-rival       rab's "Pokemon Trainer May [Boss]" on Route 119 (East)
 *                      is this run map's Bridge triplet, which no variant of
 *                      the name spells; the doc's Thunderstorm rule covers it
 *
 * An annotation no rule places is reported in `unmatched`, never guessed at.
 * "erratic weather" (Route 129) is recorded as a NOTE — it cannot be a
 * static field, and pretending otherwise would be worse than saying so.
 *
 *   RAB_DATA=/path/to/pokemon-mono/engines/rab/backend/src/data \
 *     node scripts/import-fight-fields.js
 *
 * Output: profiles/run-and-bun/oracle/fight-fields.json
 */

const fs = require('fs');
const path = require('path');

const RAB = process.env.RAB_DATA ||
	'/workspace/pokemon-mono/engines/rab/backend/src/data';
const OUT_DIR = path.join(__dirname, '..', 'profiles', 'run-and-bun', 'oracle');

/** rab's location suffix vocabulary, mapped to calc field terms. */
function parseAnnotation(location) {
	const match = /,\s*(.+)$/.exec(location || '');
	if (!match) return null;
	const note = match[1];
	if (note === 'permanent Rain') return {weather: 'Rain'};
	if (note === 'permanent Rain and Electric Terrain') {
		return {weather: 'Rain', terrain: 'Electric'};
	}
	if (note === 'permanent Sandstorm') return {weather: 'Sand'};
	if (note === 'rain') return {weather: 'Rain'};
	// The opponent's side starts with the veil up (Mechanic Changes: "can
	// still be broken or Defogged away") — a side effect, not a field.
	if (note === 'permanent Aurora Veil') return {enemyAuroraVeil: true};
	if (note === 'erratic weather') return {note: 'erratic weather'};
	return {note};
}

function main() {
	const db = JSON.parse(fs.readFileSync(path.join(RAB, 'rab-trainers-database.json'), 'utf8'));
	const list = Array.isArray(db) ? db : db.trainers;
	const planner = require('../lib/planner.js');
	const ours = new Map();
	for (const fight of planner.listFights('run-and-bun').fights) {
		ours.set(fight.trainer.toLowerCase(), fight.trainer);
	}

	const allNames = [...ours.values()];
	// This run map merges rab's pair battles into one fight ("Ruin Maniac
	// Bryan & Celia") and names location crews by their location ("Team Aqua
	// Grunt Seafloor Cavern #3") — so a candidate also matches as the prefix
	// of a duo, and a location-wide annotation covers every fight that
	// carries the location in its name.
	const resolve = candidate => {
		const exact = ours.get(candidate.toLowerCase());
		if (exact) return {rule: 'exact', names: [exact]};
		const duo = allNames.find(name =>
			name.toLowerCase().startsWith(`${candidate.toLowerCase()} &`));
		return duo ? {rule: 'duo-prefix', names: [duo]} : null;
	};
	const place = (trainer, base) => {
		for (const candidate of [trainer.name, `${trainer.className || ''} ${trainer.name}`.trim()]) {
			const hit = resolve(candidate);
			if (hit) return hit;
		}
		if (/^Seafloor Cavern/.test(base)) {
			return {rule: 'seafloor-location', names: allNames.filter(name => /Seafloor ?Cavern/.test(name))};
		}
		// The Route 119 (East) rival is this run map's Bridge triplet — rab
		// names the fight "Pokemon Trainer May [Boss]", which no variant here
		// spells. The doc's own rule covers it: Route 119 is a Thunderstorm
		// route (permanent Rain Dance + Electric Terrain).
		if (base === 'Route 119 (East)' && /^Pokemon Trainer May\b/.test(trainer.name)) {
			return {rule: 'bridge-rival', names: allNames.filter(name => /^Trainer Rival Bridge /.test(name))};
		}
		return null;
	};

	const fields = {};
	const derivation = {};
	const unmatched = [];
	let annotated = 0;
	for (const trainer of list) {
		const field = parseAnnotation(trainer.location);
		if (!field) continue;
		annotated += 1;
		const base = String(trainer.location).split(',')[0].trim();
		const placed = place(trainer, base);
		if (!placed || !placed.names.length) {
			unmatched.push(`${trainer.name} @ ${trainer.location}`);
			continue;
		}
		for (const name of placed.names) {
			fields[name] = field;
			derivation[name] = placed.rule;
		}
	}

	const output = {
		source: 'pokemon-mono engines/rab rab-trainers-database.json location annotations; ' +
			'rule named by docs/official/Mechanic Changes.txt (Overworld Weather)',
		method: 'rab annotations placed on run-map fights by four named rules — exact name, ' +
			'duo prefix, Seafloor Cavern location, Route 119 (East) bridge rival — each ' +
			'fight\'s rule in `derivation`; an annotation no rule places is reported in ' +
			'`unmatched`, never guessed',
		provenance: 'transcribed + derived',
		fields,
		derivation,
		unmatched,
	};
	fs.writeFileSync(path.join(OUT_DIR, 'fight-fields.json'),
		`${JSON.stringify(output, null, 0)}\n`);
	const kinds = {};
	for (const name of Object.keys(fields)) {
		const key = JSON.stringify(fields[name]);
		kinds[key] = (kinds[key] || 0) + 1;
	}
	console.log(`fight-fields.json  ${Object.keys(fields).length} fights matched ` +
		`of ${annotated} annotated (${unmatched.length} unmatched, reported)`);
	for (const key of Object.keys(kinds)) console.log(`  ${kinds[key]} × ${key}`);
}

if (require.main === module) main();
