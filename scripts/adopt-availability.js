/* eslint-env node, es6 */
'use strict';

/**
 * Write the tracker-derived dates into availability.json.
 *
 * A script rather than a hand edit, so the adoption is reproducible and so
 * the reasoning for each entry travels with it. Re-running is safe: adopted
 * entries are replaced wholesale, transcribed ones are left alone unless
 * they appear in OVERRIDES below.
 *
 *   node scripts/adopt-availability.js --check   # what would change
 *   node scripts/adopt-availability.js --write   # change it
 *
 * Every entry this adds carries provenance 'derived' and the basis that
 * placed it, so no reader can mistake it for the transcribed data. The file
 * is a record; a record that hides how it knows something is not one.
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const availabilityPath = path.join(root, 'profiles/run-and-bun/oracle/availability.json');
const estimate = require('./estimate-availability.js');
const profiles = require(path.join(root, 'profiles'));

const maps = profiles.getProfile('run-and-bun').oracle.maps();

/**
 * Corrections to TRANSCRIBED entries. These override data that was already
 * there, so each one needs a reason a human gave, not an inference.
 */
/**
 * Item corrections that must survive a re-import.
 *
 * import-availability.js reads `kind` straight from upstream's `type:` field,
 * so anything corrected in the committed file is restored to the upstream value
 * the next time the importer runs. The map OVERRIDES below exist for the same
 * reason; this is the item-shaped half, which was missing.
 *
 * A correction here has to be checkable rather than asserted, because the whole
 * point is that it outlives the person who made it.
 */
const ITEM_OVERRIDES = {
	'Focus Sash': {
		kind: 'consumable',
		was: 'held',
		why: 'ai/src/move-engine.ts calls consumeItem on the holder the moment a ' +
			'Focus Sash keeps it at 1 HP, so the item is single use. Upstream ' +
			'types it `held`, which prices it as working in every fight. ' +
			'lib/item-facts.js derives the same answer from the engine and ' +
			'tests/item_facts.test.js fails by name if the two disagree.',
	},
};

/**
 * TM and tutor rows a human has ruled datable.
 *
 * These start life as `dating: 'no-datable-place'` — the transcriber knew where
 * the move is and would not say when, and `moveObtainableAt` answers null so
 * the advisor stays silent rather than offering something unreachable. That
 * filter is right and is not what this table relaxes.
 *
 * What it records is a ruling. Deriving these from the map table was tried and
 * REVERTED: Aerial Ace says "Route 111", the map dates Route 111 at 192, and
 * Route 111 has a desert section behind the Mach Bike — so the location string
 * carrying no gating clause is not evidence that none exists.
 * `tests/tm_sourcing.test.js` pins Aerial Ace at null for exactly that reason.
 * The knowledge that separates these rows from that one is knowledge of the
 * game, which is why each entry names the person who supplied it.
 *
 * `anchor` is the map whose transcribed order the row inherits, so a ruling
 * says WHICH PLACE dates the move rather than inventing a number. If upstream
 * ever supplies its own date this throws instead of silently disagreeing.
 */
const MOVE_DATE_RULINGS = {
	'Rock Tomb': {
		anchor: 'Rusturf Tunnel',
		why: 'Philip, from play: fine to date. The NPC is inside Rusturf Tunnel ' +
			'and nothing further gates the gift, so the tunnel\'s own order is ' +
			'the move\'s. 145 already sits above the Rock Smash floor at 139.',
	},
	Swagger: {
		anchor: 'Slateport City',
		why: 'Philip, from play: fine to date. The Grunt is inside Slateport ' +
			'Museum, which is a building in Slateport City rather than a ' +
			'separate area the map table dates on its own.',
	},
};

/**
 * Re-apply the rulings above, and refuse rather than guess.
 *
 * Idempotent: a row already sitting on its ruled order is left alone. A row
 * that upstream has since dated ITSELF, to something else, is a disagreement
 * between a transcription and a person, and this script is not the place to
 * settle it.
 */
function applyMoveDateRulings(availability) {
	const dated = [];
	for (const move of Object.keys(MOVE_DATE_RULINGS)) {
		const ruling = MOVE_DATE_RULINGS[move];
		const row = (availability.moveItems || []).find(entry => entry.move === move);
		if (!row) continue;
		const anchor = (availability.entries || [])
			.find(entry => entry.name === ruling.anchor);
		if (!anchor || typeof anchor.opensAt !== 'number') {
			throw new Error('adopt: ' + move + ' is ruled datable from ' +
				JSON.stringify(ruling.anchor) + ', which the map table does not date — ' +
				'the anchor moved and this needs a human');
		}
		if (row.opensAt === anchor.opensAt) continue;
		if (typeof row.opensAt === 'number') {
			throw new Error('adopt: ' + move + ' is dated ' + row.opensAt +
				' upstream but ruled to follow ' + ruling.anchor + ' at ' + anchor.opensAt +
				' — a transcription and a person disagree, which needs a human');
		}
		row.transcribedOpensAt = row.opensAt === undefined ? null : row.opensAt;
		row.place = ruling.anchor;
		row.opensAt = anchor.opensAt;
		row.dating = 'unlock';
		row.provenance = 'corrected';
		row.correction = ruling.why;
		dated.push(move + ' -> ' + anchor.opensAt + ' (' + ruling.anchor + ')');
	}
	return dated;
}

const OVERRIDES = {
	MAP_ROUTE109: {
		opensAt: 42,
		why: 'Philip, from play: Route 109 is available post Granite Cave — the ' +
			'Route 107/106 land trainers — and Slateport is post Route 109. The ' +
			"transcribed 29 put it BEFORE Route 107's own trainers, which run to " +
			'37, so the tool offered the beach before the stretch that gates it. ' +
			'42 is the first fight past 37. Smallant\'s community encounter ' +
			'template (Run & Bun Encounters Template, sheet order) agrees: ' +
			"Route 104, Dewford, 107, 106, Granite Cave 1F/B1F/B2F, Steven's " +
			'Room, THEN Route 109, then Slateport. Slateport already sits at 48 ' +
			'and needs no move once 109 lands at 42.',
		was: 29,
	},
	MAP_PETALBURG_CITY: {
		opensAt: 11,
		why: 'Philip, from play: Petalburg is not immediately available. From ' +
			'Littleroot you walk Route 101 to Oldale, which has two ways out — ' +
			'Route 103 north and Route 102 west. Petalburg is only reachable ' +
			'through Route 102 and its two or three intro trainers. The tracker ' +
			'agrees independently, ordering Littleroot, 101, Oldale, 103, 102, ' +
			'Petalburg, 104. The transcribed 0 came from a first-trainer anchor ' +
			'that put it level with Route 101.',
		was: 0,
	},
};

function build() {
	const availability = JSON.parse(fs.readFileSync(availabilityPath, 'utf8'));
	const byMap = new Map(availability.entries.map(entry => [entry.map, entry]));
	const added = [];
	const changed = [];

	for (const map of maps) {
		if (byMap.has(map.map)) continue;
		const fromTracker = estimate.predictFromTracker(map.name);
		if (fromTracker === null) continue;
		const opensAt = estimate.snapToFight(fromTracker);
		added.push({
			map: map.map,
			name: map.name,
			opensAt,
			method: 'tracker',
			provenance: 'derived',
			basis: 'position in the R&B tracker, interpolated against dated neighbours',
		});
	}

	for (const mapId of Object.keys(OVERRIDES)) {
		const override = OVERRIDES[mapId];
		const entry = byMap.get(mapId);
		if (!entry || entry.opensAt === override.opensAt) continue;
		changed.push({
			map: mapId,
			name: entry.name,
			from: entry.opensAt,
			to: override.opensAt,
			why: override.why,
		});
	}

	return {availability, added, changed};
}

/**
 * Carry every map correction into the item rows standing on that map.
 *
 * The map table is not the only place a date is written. `items` and
 * `moveItems` keep their own copy, and this script used to rewrite only
 * `entries` — the strings `items` and `moveItems` did not appear in the file.
 * So Route 109 moved to 42 and the Soft Sand on it stayed at 29, which is the
 * row the advisor actually reads (oracle.js:583). Between orders 29 and 41 the
 * pickup sheet offered a route the same file says is shut.
 *
 * This runs over EVERY corrected entry, not only the ones changed on this
 * pass, because the corrections are idempotent: once the map row matches its
 * override the change list is empty, and a fix that only fired on first
 * application would never repair a file that had already drifted.
 *
 * Only rows that are EARLY move. A pickup deeper in a map than its entrance is
 * legitimately later — Pixie Plate is on Route 124 at 1178 against the map's
 * 1067 because it needs Dive — so a later date is left exactly as it is.
 */
function reconcileItems(availability) {
	const moved = [];
	for (const entry of availability.entries || []) {
		if (entry.provenance !== 'corrected' || typeof entry.opensAt !== 'number') continue;
		const place = String(entry.name).replace(/([A-Za-z])(\d)/g, '$1 $2').trim().toLowerCase();
		for (const field of ['items', 'moveItems']) {
			for (const row of availability[field] || []) {
				if (typeof row.opensAt !== 'number' || row.opensAt >= entry.opensAt) continue;
				if (String(row.location || row.place || '').trim().toLowerCase() !== place) continue;
				moved.push(`${field}: ${row.name} ${row.opensAt} -> ${entry.opensAt} (${entry.name})`);
				if (row.transcribedOpensAt === undefined) row.transcribedOpensAt = row.opensAt;
				row.opensAt = entry.opensAt;
				row.provenance = 'corrected';
				row.correction = `follows the ${entry.name} correction: ${entry.correction}`;
			}
		}
	}
	return moved;
}

/**
 * Re-apply the HM floor from each row's own prose.
 *
 * `scripts/import-availability.js` used a single `exec` over an alternation to
 * find the gate, so "requires Surf and Waterfall" matched Surf and stopped.
 * TM15 Body Press shipped at 589 against the Waterfall it names, which does
 * not arrive until 1178 — and its `dating` said "unlock+hm-gate", so the row
 * claimed a gate had been applied.
 *
 * The importer is fixed, but it reads a pokemon-mono checkout that is not
 * present here, so it cannot be re-run to repair the committed file. It does
 * not need to be: the prose and `hmMoves` are both IN the committed file, so
 * the floor is recomputable from the repository alone. Every move the prose
 * names counts, and the latest wins.
 */
function reconcileGates(availability) {
	const gates = availability.hmMoves || {};
	const moved = [];
	for (const field of ['items', 'moveItems']) {
		for (const row of availability[field] || []) {
			if (typeof row.opensAt !== 'number') continue;
			const prose = String(row.location || '');
			let floor = null;
			let named = null;
			for (const move of Object.keys(gates)) {
				if (!new RegExp('\\b' + move + '\\b', 'i').test(prose)) continue;
				if (floor === null || gates[move] > floor) {
					floor = gates[move];
					named = move;
				}
			}
			if (floor === null || row.opensAt >= floor) continue;
			moved.push(`${field}: ${row.name} ${row.opensAt} -> ${floor} (${named})`);
			if (row.transcribedOpensAt === undefined) row.transcribedOpensAt = row.opensAt;
			row.opensAt = floor;
			row.provenance = 'corrected';
			row.correction = `its own prose names ${named}, which opens at ${floor}; ` +
				'the importer matched only the first move in the clause';
		}
	}
	return moved;
}

/**
 * Put the item corrections back after an import has overwritten them.
 *
 * Silent when the value already agrees, so re-running is free. It refuses when
 * upstream carries a value that is neither the correction nor the thing it
 * corrected — that means upstream has changed its mind and a human needs to
 * look, rather than have this table quietly overrule a new answer.
 */
function applyItemOverrides(availability) {
	const corrected = [];
	for (const name of Object.keys(ITEM_OVERRIDES)) {
		const override = ITEM_OVERRIDES[name];
		const row = (availability.items || []).find(item => item.name === name);
		if (!row) continue;
		if (row.kind === override.kind) continue;
		if (row.kind !== override.was) {
			throw new Error('adopt: ' + name + ' is now "' + row.kind + '" upstream, which is ' +
				'neither the correction "' + override.kind + '" nor the "' + override.was +
				'" it corrected — upstream changed its mind and this needs a human');
		}
		row.transcribedKind = row.kind;
		row.kind = override.kind;
		row.provenance = 'derived';
		row.basis = override.why;
		corrected.push(name);
	}
	return corrected;
}

function apply(state) {
	const availability = state.availability;
	for (const entry of state.added) availability.entries.push(entry);
	for (const change of state.changed) {
		const entry = availability.entries.find(row => row.map === change.map);
		entry.transcribedOpensAt = change.from;
		entry.opensAt = change.to;
		entry.provenance = 'corrected';
		entry.correction = change.why;
	}
	applyItemOverrides(availability);
	// Before reconcileGates, so a newly dated row still meets the HM floor its
	// own prose names.
	applyMoveDateRulings(availability);
	reconcileItems(availability);
	reconcileGates(availability);
	availability.entries.sort((a, b) =>
		(a.opensAt ?? 1e9) - (b.opensAt ?? 1e9) || a.map.localeCompare(b.map));
	// The file's own header has to admit it is no longer purely transcribed.
	availability.provenance = 'transcribed + derived';
	availability.provenanceNote = [
		'Entries without a provenance field are the original transcription:',
		'rab minOrder translated through name-matched trainer anchors.',
		'',
		"provenance 'derived' means the entry was placed from the R&B tracker's",
		'route order (profiles/run-and-bun/oracle/tracker-order.json), because no',
		'trainer stands at that location for the original method to anchor to.',
		'',
		"provenance 'corrected' means a transcribed value was wrong and a human",
		'said so. transcribedOpensAt keeps the original visible.',
	];
	return availability;
}

function main() {
	const write = process.argv.includes('--write');
	const state = build();
	console.log(`adds ${state.added.length} derived entries, corrects ${state.changed.length}`);
	console.log('');
	for (const change of state.changed) {
		console.log(`CORRECT ${change.name}: ${change.from} -> ${change.to}`);
	}
	const early = state.added.filter(entry => entry.opensAt <= 50);
	console.log('');
	console.log('newly available in the first 50 orders:');
	for (const entry of early) console.log(`  ${String(entry.opensAt).padStart(4)}  ${entry.name}`);
	if (!write) {
		console.log('');
		console.log('(dry run — pass --write to apply)');
		return;
	}
	fs.writeFileSync(availabilityPath, JSON.stringify(apply(state), null, '\t') + '\n');
	console.log('');
	console.log(`wrote ${path.relative(root, availabilityPath)}`);
}

if (require.main === module) main();

module.exports = {build, apply, reconcileItems, reconcileGates, applyItemOverrides,
	applyMoveDateRulings, OVERRIDES, ITEM_OVERRIDES, MOVE_DATE_RULINGS};
