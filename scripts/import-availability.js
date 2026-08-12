/* eslint-env node, es6 */
'use strict';

/**
 * Import route AVAILABILITY — when each wild map becomes reachable — from the
 * operator's own curation in pokemon-mono's rab engine (ENC-02's missing
 * data). Source files:
 *
 *   engines/rab/backend/src/data/progression/locations.ts  LOCATION_UNLOCKS
 *   engines/rab/backend/src/data/rab-trainers-database.json
 *
 * What the source actually says, established by inspection:
 *
 * MINORDER IS A TRAINER. Each location's `minOrder` is the database order of
 * the first trainer rab labels as standing IN that location (Route 113's
 * minOrder 108 is Pokémaniac Wyatt @ Route 113). Since Run & Bun trainers
 * are mandatory, "first fight there" is a faithful — slightly LATE, never
 * early — date for "first time you can walk its grass".
 *
 * THE STAGE HEADERS ARE STALE. The `STAGE N: X Split (order a-b)` comment
 * ranges do not contain their own bosses from stage 6 on (Winona is rab
 * order 222; her stage claims 160-209), and locations are filed under the
 * wrong split wholesale. They are ignored entirely, not cross-checked.
 *
 * UNITS. rab orders count ITS database sequentially; this repo's orders are
 * the authored progression indexes. The bridge is names: rab records that
 * exactly name-match this run map are anchors, and a rab order translates
 * through the first anchor at-or-after it (an upper bound — sparsity only
 * pushes dates later, which for "is this route open yet" is the safe side).
 *
 * OUR OWN FIGHTS OUTRANK THE PROXY. Where this run map names a fight after
 * its location ("Team Aqua Grunt Petalburg Woods", #19), that is direct
 * evidence the map is entered by that order; it overrides a later proxy
 * date (rab labels that same grunt "Route 104 (South)", so its Petalburg
 * Woods proxy lands post-Brawly — a labeling artifact, not game truth).
 *
 * Output: profiles/run-and-bun/oracle/availability.json
 */

const fs = require('fs');
const path = require('path');

const RAB = '/workspace/pokemon-mono/engines/rab/backend/src/data';
const OUT_DIR = path.join(__dirname, '..', 'profiles', 'run-and-bun', 'oracle');

// rab locations that name a multi-floor complex map one wild table per floor
// here, or that use a different name for the same place. Prefixes expand to
// every wild map whose display name starts with the prefix.
const PREFIX = new Map([
	['Mt. Pyre', 'Mt Pyre'],
	['Meteor Falls', 'Meteor Falls'],
	['Seafloor Cavern', 'Seafloor Cavern'],
	['Magma Hideout', 'Magma Hideout'],
	['Abandoned Ship', 'Abandoned Ship'],
	['Victory Road', 'Victory Road'],
]);
const ALIAS = new Map([
	["Steven's Room", 'Granite Cave Stevens Room'],
	['Fallarbor', 'Fallarbor Town'],
	['Lilycove', 'Lilycove City'],
]);

function loadAnchors() {
	const db = JSON.parse(fs.readFileSync(path.join(RAB, 'rab-trainers-database.json'), 'utf8'));
	const list = Array.isArray(db) ? db : db.trainers;
	const planner = require('../planner.js');
	const ours = new Map();
	for (const fight of planner.listFights('run-and-bun').fights) {
		ours.set(fight.trainer.toLowerCase(), fight.order);
	}
	const anchors = [];
	for (const trainer of list) {
		const candidates = [trainer.name,
			`${trainer.className || ''} ${trainer.name}`.trim()];
		for (const name of candidates) {
			const order = ours.get(String(name).toLowerCase());
			if (order !== undefined) {
				anchors.push({rab: trainer.order, our: order});
				break;
			}
		}
	}
	anchors.sort((a, b) => a.rab - b.rab);
	return anchors;
}

/** The first matchable trainer at-or-after a rab order, in our units. */
function translator(anchors) {
	return rabOrder => {
		for (const anchor of anchors) {
			if (anchor.rab >= rabOrder) return anchor.our;
		}
		return null;
	};
}

function parseUnlocks() {
	const source = fs.readFileSync(path.join(RAB, 'progression', 'locations.ts'), 'utf8');
	const entryPattern = /\{ location: "([^"]+)", minOrder: (\d+) \}/;
	const unlocks = [];
	for (const line of source.split('\n')) {
		const entry = entryPattern.exec(line);
		if (entry) unlocks.push({location: entry[1], minOrder: Number(entry[2])});
	}
	return unlocks;
}

/** Every wild map a rab location string names — [] when it names none. */
function resolveMaps(oracle, location) {
	// "Route 119 (West), permanent Rain" → parenthetical sub-area and weather
	// notes name the same wild table as the bare route.
	const base = location.split(',')[0].replace(/\s*\(.*\)$/, '').trim();
	for (const pair of PREFIX) {
		if (base === pair[0]) {
			return oracle.maps().filter(map => map.name.startsWith(pair[1]));
		}
	}
	const alias = ALIAS.get(base);
	const hit = (alias && oracle.getMap(alias)) ||
		oracle.getMap(location) || oracle.getMap(base);
	return hit ? [hit] : [];
}

/** Earliest run-map fight whose trainer NAME carries the map's name. */
function ourFightIndex() {
	const planner = require('../planner.js');
	const fights = planner.listFights('run-and-bun').fights;
	return mapName => {
		let earliest = null;
		for (const fight of fights) {
			if (fight.trainer.includes(mapName) &&
				(earliest === null || fight.order < earliest)) {
				earliest = fight.order;
			}
		}
		return earliest;
	};
}

function main() {
	const oracle = require('../profiles').getProfile('run-and-bun').oracle;
	const translate = translator(loadAnchors());
	const fightAt = ourFightIndex();
	const unlocks = parseUnlocks();

	// Several source rows (Route 104 South/North) target one wild table here;
	// the earliest access wins, because the map is one table for us.
	const byMap = new Map();
	const unresolved = new Set();
	for (const unlock of unlocks) {
		const maps = resolveMaps(oracle, unlock.location);
		if (!maps.length) {
			// Cities and interiors without wild tables are not errors — only a
			// wild map we know that CANNOT be dated would be.
			unresolved.add(unlock.location);
			continue;
		}
		const translated = translate(unlock.minOrder);
		for (const map of maps) {
			const direct = fightAt(map.name);
			const method = direct !== null &&
				(translated === null || direct < translated) ? 'our-fight' : 'anchor';
			const opensAt = method === 'our-fight' ? direct : translated;
			const candidate = {
				map: map.map,
				name: map.name,
				opensAt,
				method,
				rabMinOrder: unlock.minOrder,
				...(opensAt === null ? {flags: ['no-anchor']} : {}),
			};
			const existing = byMap.get(map.map);
			if (!existing ||
				(candidate.opensAt !== null &&
					(existing.opensAt === null || candidate.opensAt < existing.opensAt))) {
				byMap.set(map.map, candidate);
			}
		}
	}

	// Encounter METHOD gates, from the operator's story-gates curation (each
	// carries its evidence there): the Super Rod is the game's only fishing
	// tool and is given on Route 103 at the start; HM03 Surf is earned by
	// clearing the Seashore House (rab #157-159); Rock Smash is Roxanne's
	// reward (rab #46). Walking needs nothing.
	const methods = {
		walk: 0,
		fish: 0,
		surf: translate(159),
		'rock-smash': translate(46),
	};

	// The HM MOVES themselves, dated by the same story-gates curation (rab
	// orders; each entry documents its evidence there). An advisor drawing
	// teach candidates must not offer Surf three fights into the run — HM03
	// is earned at the Seashore House. TMs carry no dates in the source and
	// stay ungated; that limit is documented at the consumer.
	const hmMoves = {
		Flash: translate(10),
		Cut: translate(34),
		'Rock Smash': translate(46),
		Strength: translate(90),
		Surf: translate(159),
		Fly: translate(210),
		Dive: translate(314),
		Waterfall: translate(314),
	};

	const entries = [...byMap.values()].sort((a, b) =>
		(a.opensAt === null ? 1 : 0) - (b.opensAt === null ? 1 : 0) ||
		(a.opensAt || 0) - (b.opensAt || 0) || a.name.localeCompare(b.name));
	const dated = entries.filter(entry => entry.opensAt !== null).length;
	const output = {
		source: 'pokemon-mono engines/rab progression/locations.ts + rab-trainers-database.json',
		method: 'rab minOrder = its first trainer at the location, translated through ' +
			'exactly-name-matched trainer anchors (late-biased, never early); a run-map ' +
			'fight named after the map overrides with direct evidence',
		provenance: 'transcribed',
		methods,
		hmMoves,
		entries,
	};
	fs.writeFileSync(path.join(OUT_DIR, 'availability.json'),
		`${JSON.stringify(output, null, 0)}\n`);
	console.log(`availability.json  ${entries.length} maps dated ` +
		`(${dated} confident, ${entries.length - dated} unanchored), ` +
		`${unresolved.size} non-wild locations skipped`);
}

main();
