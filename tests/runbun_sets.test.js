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

const loadSetdex = require('../lib/setdex-loader').loadSetdex;

const GEN8_SETS = path.join(__dirname, '..', 'src', 'js', 'data', 'sets', 'gen8.js');
const GENERATED_BANNER = 'AUTOMATICALLY GENERATED';

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

test('the run map matches the profile\'s declared encounter invariants', () => {
	const encounters = require('../profiles').getProfile('run-and-bun').encounters;
	const setdex = loadSetdex(GEN8_SETS, 'SETDEX_SS');

	const labels = new Set();
	const trainers = new Set();
	let duplicates = 0;
	for (const species of Object.keys(setdex)) {
		for (const label of Object.keys(setdex[species])) {
			const entry = setdex[species][label];
			labels.add(label);
			trainers.add(entry.trainer || label);
			if (entry.trainer) duplicates++;
		}
	}

	assert.equal(trainers.size, encounters.INVARIANTS.battleCount, 'battle count');
	assert.equal(labels.size, encounters.INVARIANTS.labelCount, 'raw entry key count');
	assert.equal(duplicates, encounters.INVARIANTS.duplicateEntries, 'duplicate-species entries');

	// Battles are not trainers: paired labels name two trainers at once, so the
	// roster is materially larger than the battle count.
	const paired = [...trainers].filter(t => t.includes('&')).length;
	assert.equal(paired, encounters.INVARIANTS.pairedBattles, 'paired (double-battle) labels');
	assert.equal(
		(trainers.size - paired) + paired * 2,
		encounters.INVARIANTS.trainerSlots,
		'trainer slots implied by solo + paired battles'
	);
});

test('the run map declares itself a progression spine, not a full trainer census', () => {
	// The run map covers the mandatory progression — gyms, Elite Four, rivals in
	// all three starter variants, admins and leaders — but roughly 69 optional
	// route trainers (overwhelmingly Swimmers) have no entry at all.
	//
	// This is asserted rather than left implicit because a planner built on this
	// data must not claim to cover every battle a player can pick. If someone
	// imports the missing trainers, this flag is what they have to change, which
	// forces the claim to be revisited deliberately.
	const encounters = require('../profiles').getProfile('run-and-bun').encounters;
	assert.equal(encounters.COVERAGE.completeTrainerCensus, false);
	assert.ok(encounters.COVERAGE.coversMandatoryProgression);

	// The mandatory spine must actually be present. These are the battles a run
	// cannot avoid; losing one is a different failure from missing route filler.
	const setdex = loadSetdex(GEN8_SETS, 'SETDEX_SS');
	const labels = new Set();
	for (const species of Object.keys(setdex)) {
		for (const label of Object.keys(setdex[species])) {
			labels.add(setdex[species][label].trainer || label);
		}
	}
	const spine = ['Elite Four Glacia', 'Elite Four Sidney', 'Elite Four Phoebe', 'Elite Four Drake'];
	const missingSpine = spine.filter(t => !labels.has(t));
	assert.deepEqual(missingSpine, [], `mandatory battles missing: ${missingSpine.join(', ')}`);

	// All three starter variants of each rival battle must survive together —
	// dropping one would silently give a player the wrong opponent for their run.
	const rivals = [...labels].filter(t => /^Trainer Rival /.test(t));
	assert.equal(rivals.length, 12, `expected 12 rival battles (4 locations x 3 starters), found ${rivals.length}`);
	for (const starter of ['Blaziken', 'Sceptile', 'Swampert']) {
		const n = rivals.filter(t => t.endsWith(starter)).length;
		assert.equal(n, 4, `expected 4 rival battles for the ${starter} route, found ${n}`);
	}
});

test('no entry key encodes meaning in whitespace', () => {
	// Duplicate-species entries were once keyed by prefixing the trainer name with
	// spaces. Nothing declared that convention, and `getTrainerOrder` grouped on
	// the raw key, so the Trainer Wheel produced one navigation stop per entry
	// instead of per trainer and "next" re-rendered an identical party. Duplicates
	// now carry an explicit `trainer` field instead.
	const setdex = loadSetdex(GEN8_SETS, 'SETDEX_SS');
	const whitespaceKeyed = [];
	for (const species of Object.keys(setdex)) {
		for (const label of Object.keys(setdex[species])) {
			if (label !== label.trim()) whitespaceKeyed.push(`${species}: ${JSON.stringify(label)}`);
		}
	}
	assert.deepEqual(
		whitespaceKeyed,
		[],
		'entry keys must not depend on leading or trailing whitespace; ' +
		'give the entry an explicit `trainer` field instead:\n  ' + whitespaceKeyed.join('\n  ')
	);
});

test('every duplicate-species entry names a trainer that exists on its own', () => {
	const setdex = loadSetdex(GEN8_SETS, 'SETDEX_SS');
	const labels = new Set();
	const duplicates = [];
	for (const species of Object.keys(setdex)) {
		for (const label of Object.keys(setdex[species])) {
			labels.add(label);
			const entry = setdex[species][label];
			if (entry.trainer) duplicates.push({label, trainer: entry.trainer, copy: entry.copy});
		}
	}
	for (const dup of duplicates) {
		// A duplicate is an extra copy of a species in a party that already exists,
		// so the trainer it points at must be a real entry key somewhere.
		assert.ok(
			labels.has(dup.trainer),
			`${JSON.stringify(dup.label)} names trainer ${JSON.stringify(dup.trainer)}, which is not an entry key`
		);
		assert.ok(
			typeof dup.copy === 'number' && dup.copy >= 2,
			`${JSON.stringify(dup.label)} must carry a copy ordinal of 2 or more, got ${dup.copy}`
		);
	}
});

test('the trainer progression index is a dense, globally unique ordering', () => {
	const setdex = loadSetdex(GEN8_SETS, 'SETDEX_SS');
	const indices = [];
	for (const species of Object.keys(setdex)) {
		for (const label of Object.keys(setdex[species])) {
			const index = setdex[species][label].index;
			if (typeof index === 'number') indices.push(index);
		}
	}

	// `index` is not a per-party slot number. It is a single global sequence
	// encoding authored Run & Bun playthrough order across every trainer, and it
	// is the sole ordering key for Trainer Wheel navigation. It can be
	// reconstructed from no upstream source.
	//
	// The count check above passes for any numeric values, so a renumber, a
	// collapse to a constant, or a shuffle would all slip through it. These
	// assertions pin the shape that makes the ordering meaningful.
	const unique = new Set(indices);
	assert.equal(
		unique.size,
		indices.length,
		`trainer progression indices must be globally unique; ${indices.length - unique.size} duplicates found`
	);

	const min = Math.min.apply(null, indices);
	const max = Math.max.apply(null, indices);
	assert.equal(min, 0, 'the progression ordering should start at 0');

	// Dense: the sequence spans its range with only a couple of gaps. A shuffle
	// keeps density, but a renumber into buckets or a partial rewrite does not.
	// Density is asserted against the DECLARED gaps rather than a tolerance. A
	// percentage threshold hides exactly what a gap means here: the sequence is
	// authored and dense, so a missing index is a lost party member, not slack.
	const encounters = require('../profiles').getProfile('run-and-bun').encounters;
	const present = new Set(indices);
	const gaps = [];
	for (let i = min; i <= max; i++) if (!present.has(i)) gaps.push(i);
	assert.deepEqual(
		gaps,
		encounters.KNOWN_GAPS.indices,
		`progression gaps changed. Declared missing: ${encounters.KNOWN_GAPS.indices.join(', ')} ` +
		`(${encounters.KNOWN_GAPS.trainer} — ${encounters.KNOWN_GAPS.note}). Found: ${gaps.join(', ') || 'none'}. ` +
		'A new gap means a party member was lost; a closed gap means one was restored — update KNOWN_GAPS deliberately.'
	);
});
