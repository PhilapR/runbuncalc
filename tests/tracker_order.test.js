/* eslint-env node, es6 */
'use strict';

/**
 * tracker-order.json has a builder, and is what the builder makes.
 *
 * ledger: tracker-order-has-no-builder-and-a-false-method. The file had
 * readers and no writer; its method said the headers were orphaned strings
 * in sharedStrings.xml, when they are row 1 of the Encounter Tables sheet;
 * and it differed from that row by three unrecorded edits. The builder pins
 * row 1 verbatim in `headers`, names every edit with its reason, and this
 * gate holds the committed order to them.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const builder = require('../scripts/build-tracker-order.js');
const tracker = require('../profiles/run-and-bun/oracle/tracker-order.json');

// Run & Bun's own tracker workbook. Absent off the build machine: the gate
// that reads it then SKIPS and says why.
const XLSX = process.env.TRACKER_XLSX || path.join(os.homedir(), 'Projects', 'pokemon-mono',
	'docs', 'official', 'Pok\u00e9mon Locations.xlsx');

test('the committed tracker order is what its builder makes from the pinned headers', () => {
	assert.deepEqual(builder.build(tracker.headers), tracker,
		'tracker-order.json has drifted from its builder: node scripts/build-tracker-order.js');
});

test('every place the order leaves out or adds is named, with its reason', () => {
	assert.equal(tracker.headers.length, 98, 'row 1 of the Encounter Tables sheet: C1..GO1');
	const kept = tracker.headers.filter(name => !(name in tracker.excluded));
	assert.deepEqual(tracker.order, kept.concat(Object.keys(tracker.appended)));
	assert.deepEqual(Object.keys(tracker.excluded), ['Mt. Pyre 1F-2F', 'Mt. Pyre 3F-4F', 'Mt. Pyre 5F-6F',
		'Mt. Pyre (Exterior)', 'Mt. Pyre (Summit)', 'Aqua Hideout B1F']);
	for (const reason of Object.values(tracker.excluded).concat(Object.values(tracker.appended))) {
		assert.ok(reason.length > 40, 'a reason, not a label');
	}
	assert.doesNotMatch(tracker.method.join(' '), /survive only in/, 'the false account of the headers is gone');
	assert.throws(() => builder.build(['Route 101']), /excluded but not a header/);
});

test('the workbook reader takes row 1 in column order, through the shared strings', () => {
	const strings = builder.parseSharedStrings('<sst><si><t>Route 101</t></si><si><r><t>Steven</t></r>' +
		'<r><t xml:space="preserve">&apos;s Room</t></r></si><si><t>Unused</t></si></sst>');
	assert.deepEqual(strings, ['Route 101', 'Steven\'s Room', 'Unused']);
	const sheet = '<sheetData><row r="1"><c r="A1" s="1"/><c r="C1" s="3" t="s"><v>1</v></c><c r="D1" s="4"/>' +
		'<c r="E1" s="3" t="s"><v>0</v></c></row><row r="2"><c r="C2" t="s"><v>2</v></c></row></sheetData>';
	assert.deepEqual(builder.parseRowOne(sheet, strings), ['Steven\'s Room', 'Route 101']);
});

// review 2026-09-22: the first test builds from the file's own `headers`, so
// a wrong headers block passes it — the file only agrees with itself. This
// one holds `headers` to row 1 of the workbook they claim to pin.
const workbookMissing = fs.existsSync(XLSX) ? false :
	'the tracker workbook is not on this machine (' + XLSX + '); set TRACKER_XLSX to check the pinned headers';

test('the pinned headers are row 1 of the tracker workbook, and the order is built from them', {skip: workbookMissing}, () => {
	const headers = builder.readHeaders(XLSX);
	assert.deepEqual(tracker.headers, headers,
		'tracker-order.json pins headers the workbook does not have: node scripts/build-tracker-order.js --xlsx <workbook>');
	assert.deepEqual(builder.build(headers), tracker, 'and the committed file is what the workbook builds');
});

test('every transcription of the Locations workbook cites it in pokemon-mono, by its real name', () => {
	// data-integrity audit (docs-official-is-cited-as-a-repo-relative-path):
	// three oracle files cited `docs/official/Pokemon Locations.xlsx` as if
	// it were in this repository. It lives in pokemon-mono, and its name
	// carries the accented e (U+00E9). tracker-order.json is built, so its
	// builder carries the string; sources.json and unavailable.json are
	// transcriptions with no builder, so the string is fixed where it is.
	const cite = /^pokemon-mono docs\/official\/Pokémon Locations\.xlsx\b/;
	const oracle = name => require('../profiles/run-and-bun/oracle/' + name);
	const docs = {
		'build-tracker-order.js': builder.build(tracker.headers),
		'tracker-order.json': tracker,
		'sources.json': oracle('sources.json'),
		'unavailable.json': oracle('unavailable.json'),
	};
	for (const name of Object.keys(docs)) assert.match(docs[name].source, cite, name);
});
