/* eslint-env node, es6 */
'use strict';

/**
 * Guard for the hand-curated Run & Bun trainer set data.
 *
 * `src/js/data/sets/gen8.js` is the most Run & Bun-specific dataset in the
 * product: the actual trainer parties, keyed by trainer name. It is authored,
 * not generated. Every other `sets/gen*.js` file carries an "AUTOMATICALLY
 * GENERATED FROM @smogon/sets" banner and holds Smogon competitive usage sets,
 * which are a different kind of content entirely.
 *
 * The inherited `import/` generator used to write all nine generations into
 * this directory from `@smogon/sets`, so running it would have replaced the
 * trainer parties with Smogon usage sets and quietly destroyed the fork's own
 * data. That generator has been removed. This test is the standing guard: if
 * anything ever regenerates gen 8 from an upstream set source, the banner and
 * the Showdown-usage labels reappear and this fails.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const GEN8_SETS = path.join(__dirname, 'src', 'js', 'data', 'sets', 'gen8.js');
const GENERATED_BANNER = 'AUTOMATICALLY GENERATED';

function loadSetdex(filePath, globalName) {
	const source = fs.readFileSync(filePath, 'utf8');
	// The file is `var SETDEX_XX = {...};` — evaluate it and hand back the object.
	return new Function(`${source}\nreturn ${globalName};`)();
}

test('Run & Bun trainer sets are authored, not generated from an upstream set source', () => {
	const source = fs.readFileSync(GEN8_SETS, 'utf8');
	assert.ok(
		!source.includes(GENERATED_BANNER),
		'src/js/data/sets/gen8.js carries a generated-file banner. The Run & Bun trainer ' +
		'parties are authored data; something has overwritten them from an upstream set source.'
	);
});

test('Run & Bun trainer sets are keyed by trainer, not by Showdown usage tier', () => {
	const setdex = loadSetdex(GEN8_SETS, 'SETDEX_SS');
	const species = Object.keys(setdex);
	assert.ok(species.length > 100, `expected a populated gen 8 setdex, got ${species.length} species`);

	const labels = [];
	for (const name of species) labels.push(...Object.keys(setdex[name]));
	assert.ok(labels.length > 0, 'gen 8 setdex has species but no sets');

	// Smogon usage sets are labelled like "OU Showdown Usage" / "UU Showdown Usage".
	// Run & Bun sets are labelled by trainer, e.g. "Elite Four Glacia".
	const usageLabels = labels.filter(label => /Showdown Usage/i.test(label));
	assert.deepEqual(
		usageLabels.slice(0, 5),
		[],
		`gen 8 sets contain Showdown usage labels (${usageLabels.length} of ${labels.length}); ` +
		'expected Run & Bun trainer names'
	);
});

test('Run & Bun trainer sets carry the party index the Trainer Wheel relies on', () => {
	const setdex = loadSetdex(GEN8_SETS, 'SETDEX_SS');
	let withIndex = 0;
	let total = 0;
	for (const species of Object.keys(setdex)) {
		for (const label of Object.keys(setdex[species])) {
			total++;
			if (typeof setdex[species][label].index === 'number') withIndex++;
		}
	}
	// `index` orders a trainer's party; the Trainer Wheel reads it to build the
	// 2x3 board. Upstream Smogon sets have no such field, so a drop here is the
	// same regression the banner check catches, seen from the data side.
	assert.ok(
		withIndex > total * 0.9,
		`only ${withIndex}/${total} gen 8 sets carry a party index; expected nearly all`
	);
});
