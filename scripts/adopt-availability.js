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
const OVERRIDES = {
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

	for (const [mapId, override] of Object.entries(OVERRIDES)) {
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

module.exports = {build, apply, OVERRIDES};
