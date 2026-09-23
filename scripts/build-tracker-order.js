#!/usr/bin/env node
/* eslint-env node, es6 */
'use strict';

/**
 * Build tracker-order.json: the R&B tracker's location order.
 *
 *   node scripts/build-tracker-order.js                 rebuild from the pinned headers
 *   node scripts/build-tracker-order.js --xlsx PATH     re-read the headers from the workbook
 *
 * The file had readers and no writer, and its method prose said the tracker's
 * headers "survive only in xl/sharedStrings.xml, orphaned from any cell
 * reference". They do not. The Encounter Tables sheet (sheet1.xml) holds them
 * in row 1 — C1, E1, ... GO1, 98 cells, each a shared-string reference — and
 * the order is that row read left to right
 * (ledger: tracker-order-has-no-builder-and-a-false-method).
 *
 * The committed order is NOT row 1 as it stands. Six headers are missing from
 * it and one is added, and none of the three edits was recorded. They are
 * named below, each with what is known about it, and kept exactly as
 * committed: estimate-availability.js dates places from this order, so
 * restoring the six would move shipped dates, and that is a ruling, not a
 * rebuild. Until then the builder reproduces the file and the gate
 * (tests/tracker_order.test.js) holds it to the headers.
 *
 * The headers are pinned verbatim in the output (`headers`), the way
 * item-workbook.json pins its sheet, so the rebuild needs no workbook. The
 * workbook itself is Run & Bun's own: pokemon-mono docs/official/Pokémon
 * Locations.xlsx (1.07 documentation dump).
 */

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '..', 'profiles', 'run-and-bun', 'oracle', 'tracker-order.json');

/** Why each missing header is missing — as far as anything says. */
const UNRECORDED = 'Dropped by the first extraction, which read xl/sharedStrings.xml instead of row 1; ' +
	'no reason was recorded. Kept out so the committed order and the dates derived from it stand ' +
	'until a ruling on restoring it.';
const EXCLUDED = {
	'Mt. Pyre 1F-2F': UNRECORDED,
	'Mt. Pyre 3F-4F': UNRECORDED,
	'Mt. Pyre 5F-6F': UNRECORDED,
	'Mt. Pyre (Exterior)': UNRECORDED,
	'Mt. Pyre (Summit)': UNRECORDED,
	'Aqua Hideout B1F': UNRECORDED,
};

/** Locations the order carries that row 1 does not. */
const APPENDED = {
	Underwater: 'Not a header of the Encounter Tables sheet: the tracker keeps the Route 124 and ' +
		'Route 126 underwater tables on a sheet of their own, "Underwater Encounter Tables". ' +
		'Placed last, where the first extraction put it.',
};

const METHOD_TAIL = [
	'',
	'That order is VALIDATED, not assumed: across the 59 dated locations the',
	'tracker covers, its position rank-correlates with opensAt at 0.82. A wrong',
	'order could not do that.',
	'',
	'0.82 and not the 0.96 an exact-name subset reports. The difference is five',
	'Meteor Falls rooms, placed here right after Route 114 and dated 1526 by',
	'availability.json. That is not a mapping error — it is the two files',
	'answering different questions. The tracker orders by the intended',
	'playthrough; availability.json orders by a location\'s FIRST TRAINER. You',
	'walk past Meteor Falls early; nobody stands there to fight until very late.',
	'Route 115 is the same shape: tracker #16, date-rank #25.',
	'',
	'For deciding what can be CAUGHT, the tracker asks the better question.',
];

const GROUPS = {
	'Shoal Cave (Entrance/Inner)': ['Shoal Cave Low Tide Entrance Room', 'Shoal Cave Low Tide Inner Room'],
	'Shoal Cave (Other Rooms)': ['Shoal Cave Low Tide Stairs Room', 'Shoal Cave Low Tide Lower Room'],
	'Shoal Cave (Ice Room)': ['Shoal Cave Low Tide Ice Room'],
	'Sky Pillar 1F and 3F': ['Sky Pillar 1f', 'Sky Pillar 3f'],
	'Cave of Origin Entrance/1F': ['Cave Of Origin Entrance', 'Cave Of Origin 1f'],
	'New Mauville (Outside)': ['New Mauville Entrance'],
	'New Mauville (Inside)': ['New Mauville Inside'],
	'Safari Zone (South)': ['Safari Zone South'],
	'Safari Zone (Southwest)': ['Safari Zone Southwest'],
	'Safari Zone (Northwest)': ['Safari Zone Northwest'],
	'Safari Zone (North)': ['Safari Zone North'],
	Underwater: ['Underwater Route124', 'Underwater Route126'],
	'Meteor Falls 1F1': ['Meteor Falls 1f 1r'],
	'Meteor Falls 1F2': ['Meteor Falls 1f 2r'],
	'Meteor Falls B1F1': ['Meteor Falls B1f 1r'],
	'Meteor Falls B1F2': ['Meteor Falls B1f 2r'],
	'Steven\'s Room': ['Granite Cave Stevens Room'],
	'Seafloor Cavern Rooms 1-5': ['Seafloor Cavern Room1', 'Seafloor Cavern Room2', 'Seafloor Cavern Room3', 'Seafloor Cavern Room4', 'Seafloor Cavern Room5'],
	'Seafloor Cavern Rooms 6-7': ['Seafloor Cavern Room6', 'Seafloor Cavern Room7'],
	'Seafloor Cavern Room 8': ['Seafloor Cavern Room8'],
};

const ABSENT = {
	comment: 'In the oracle\'s wild tables but nowhere in the tracker. Left undated on purpose.',
	locations: [
		'Artisan Cave 1f',
		'Artisan Cave B1f',
		'Safari Zone Southeast',
		'Safari Zone Northeast',
		'Cave Of Origin Unused Ruby Sapphire Map1',
		'Cave Of Origin Unused Ruby Sapphire Map2',
		'Cave Of Origin Unused Ruby Sapphire Map3',
	],
};

/** `xl/sharedStrings.xml` → its strings in index order, rich-text runs joined. */
function parseSharedStrings(xml) {
	return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(si =>
		[...si[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(t => unescapeXml(t[1])).join(''));
}

function unescapeXml(text) {
	return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
		.replace(/&apos;/g, '\'').replace(/&amp;/g, '&');
}

/** A sheet's row 1, left to right: the text of every non-empty cell. */
function parseRowOne(sheetXml, strings) {
	const row = sheetXml.match(/<row r="1"[^>]*>([\s\S]*?)<\/row>/);
	if (!row) throw new Error('the sheet has no row 1');
	const headers = [];
	for (const cell of row[1].matchAll(/<c r="([A-Z]+)1"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
		const value = (cell[3] || '').match(/<v>([\s\S]*?)<\/v>/);
		if (!value) continue;
		headers.push(/t="s"/.test(cell[2]) ? strings[Number(value[1])] : unescapeXml(value[1]));
	}
	return headers;
}

/** Row 1 of the sheet named "Encounter Tables", found through the workbook's own relationships. */
function readHeaders(xlsx) {
	const part = name => childProcess.execFileSync('unzip', ['-p', xlsx, name], {encoding: 'utf8', maxBuffer: 1 << 26});
	const sheet = part('xl/workbook.xml').match(/<sheet [^>]*name="Encounter Tables"[^>]*r:id="([^"]+)"/);
	if (!sheet) throw new Error('no "Encounter Tables" sheet');
	const target = part('xl/_rels/workbook.xml.rels').match(new RegExp(`Id="${sheet[1]}"[^>]*Target="([^"]+)"`));
	if (!target) throw new Error(`no relationship ${sheet[1]}`);
	return parseRowOne(part(`xl/${target[1]}`), parseSharedStrings(part('xl/sharedStrings.xml')));
}

function build(headers) {
	const unknown = Object.keys(EXCLUDED).filter(name => !headers.includes(name));
	if (unknown.length) throw new Error(`excluded but not a header: ${unknown.join(', ')}`);
	const order = headers.filter(name => !EXCLUDED[name]).concat(Object.keys(APPENDED));
	return {
		source: 'pokemon-mono docs/official/Pokémon Locations.xlsx (the R&B Google-Drive tracker), sheet \'Encounter Tables\'',
		provenance: 'derived',
		method: [
			'The tracker lays each location out as a column pair on the Encounter Tables',
			'sheet, with the location\'s name in row 1 (C1, E1, ... GO1). The order is',
			'that row read left to right, less the headers in `excluded` and plus the',
			'one in `appended`, each with its reason. Built by',
			'scripts/build-tracker-order.js from `headers`, which pins row 1 verbatim.',
			'An earlier version of this text said the headers survive only as orphaned',
			'strings in xl/sharedStrings.xml; they are cell references in row 1.',
		].concat(METHOD_TAIL),
		caveat: 'Order only. The tracker carries no fight orders, so a position must be interpolated ' +
			'against dated neighbours before it means anything.',
		headers,
		excluded: EXCLUDED,
		appended: APPENDED,
		order,
		groups: GROUPS,
		absent: ABSENT,
	};
}

function main(argv) {
	const at = argv.indexOf('--xlsx');
	const headers = at === -1 ? JSON.parse(fs.readFileSync(OUT, 'utf8')).headers : readHeaders(argv[at + 1]);
	if (!Array.isArray(headers) || !headers.length) throw new Error('no headers: pass --xlsx <Pokemon Locations.xlsx>');
	const built = build(headers);
	fs.writeFileSync(OUT, `${JSON.stringify(built, null, '\t')}\n`);
	console.log(`tracker-order.json: ${built.headers.length} headers, ${built.order.length} in order`);
}

if (require.main === module) {
	try {
		main(process.argv.slice(2));
	} catch (error) {
		console.error(`build-tracker-order: ${error.message}`);
		process.exitCode = 1;
	}
}

module.exports = {parseSharedStrings, parseRowOne, readHeaders, build, EXCLUDED, APPENDED};
