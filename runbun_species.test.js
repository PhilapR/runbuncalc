/* eslint-env node, es6 */
'use strict';

/**
 * Profile conformance gate for species and item data.
 *
 * The profile in `profiles/run-and-bun/` is the authority: it declares what
 * Run & Bun's content is. This asserts the calculator's data actually matches
 * that declaration.
 *
 * Two properties, and the difference between them matters. The first is that
 * the data has not been LOST — the earlier version of this file only checked
 * that ported species existed by name. The second is that the data is RIGHT.
 * Zoroark-Hisui shipped with the wrong base stats and passed the existence
 * check for weeks, because existence is not correctness. The profile pins full
 * stat lines so that class of error cannot recur.
 *
 * Profile values were reconciled against `dekzeh/calc`, the hack author's own
 * calculator, which is the source of truth for Run & Bun content.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

// Assert the data tables directly rather than through `Generations.get()`. The
// runtime wrapper renames base stats (`at` -> `atk`) and does not surface
// `nfe`, and it is the tables themselves a bad regeneration would damage.
const SPECIES = require('./calc/dist/data/species.js').SPECIES;
const ITEMS = require('./calc/dist/data/items.js').ITEMS;
const getProfile = require('./profiles').getProfile;

const profile = getProfile('run-and-bun');
const species = SPECIES[profile.baseGeneration];
const items = ITEMS[profile.baseGeneration];

test('the profile is well formed and declares its base generation', () => {
	assert.equal(profile.id, 'run-and-bun');
	assert.equal(profile.baseGeneration, 8);
	assert.ok(profile.data, 'profile declares no data layer');
});

test('Run & Bun base stat changes are present', () => {
	for (const name of Object.keys(profile.data.BASE_STAT_CHANGES)) {
		assert.ok(species[name], `${name} is missing from Gen ${profile.baseGeneration} species data`);
		for (const stat of Object.keys(profile.data.BASE_STAT_CHANGES[name])) {
			assert.equal(
				species[name].bs[stat],
				profile.data.BASE_STAT_CHANGES[name][stat],
				`${name} base ${stat} does not match the Run & Bun profile`
			);
		}
	}
});

test('Run & Bun evolution changes are present', () => {
	for (const name of profile.data.NOT_FULLY_EVOLVED) {
		assert.ok(species[name], `${name} is missing from Gen ${profile.baseGeneration} species data`);
		assert.equal(species[name].nfe, true, `${name} should be not-fully-evolved in Run & Bun`);
	}
});

test('every species the profile ports in is present with the declared stat line', () => {
	const ported = profile.data.PORTED_SPECIES;
	const missing = Object.keys(ported).filter(name => !species[name]);
	assert.deepEqual(
		missing,
		[],
		`Run & Bun species missing from Gen ${profile.baseGeneration} data: ${missing.join(', ')}. ` +
		'These are not upstream content; if they are gone the fork data has been ' +
		'overwritten from an upstream source.'
	);

	// The correctness half. An existence check passes on a wrong stat line.
	const wrong = [];
	for (const name of Object.keys(ported)) {
		const declared = ported[name];
		const actual = species[name];
		if (JSON.stringify(actual.types) !== JSON.stringify(declared.types)) {
			wrong.push(`${name} types: data ${JSON.stringify(actual.types)}, profile ${JSON.stringify(declared.types)}`);
		}
		for (const stat of Object.keys(declared.bs)) {
			if (actual.bs[stat] !== declared.bs[stat]) {
				wrong.push(`${name} base ${stat}: data ${actual.bs[stat]}, profile ${declared.bs[stat]}`);
			}
		}
		if (declared.ability && actual.abilities && actual.abilities[0] !== declared.ability) {
			wrong.push(`${name} ability: data ${actual.abilities[0]}, profile ${declared.ability}`);
		}
	}
	assert.deepEqual(
		wrong,
		[],
		`calculator data contradicts the Run & Bun profile:\n  ${wrong.join('\n  ')}\n` +
		'The profile is the authority. Fix calc/src/data/species.ts, or change the ' +
		'profile deliberately if the game data itself was wrong.'
	);
});

test('Saharascal keeps its Run & Bun original stat line', () => {
	// Called out separately from the loop above because it exists in no official
	// game: it is Run & Bun original content and reconstructible from nothing.
	const declared = profile.data.PORTED_SPECIES['Saharascal'];
	assert.ok(declared, 'the profile no longer declares Saharascal');
	const actual = species['Saharascal'];
	assert.ok(actual, 'Saharascal is missing — this species exists in no official game');
	assert.deepEqual(actual.bs, declared.bs);
	assert.equal(actual.nfe, declared.nfe);
});

test('items the profile removes stay absent', () => {
	const present = profile.data.REMOVED_ITEMS.filter(item => items.includes(item));
	assert.deepEqual(present, [], `items removed by Run & Bun are back: ${present.join(', ')}`);
});

test('the move overlay still matches the size it was verified at', () => {
	// All 166 entries of the Run & Bun move overlay were compared against
	// `dekzeh/runandbundex` — the author's own ROM data dump, which unlike his
	// calculator carries per-move accuracy and PP — and every one agreed.
	//
	// Nothing in the repository can re-run that comparison offline, so the
	// counts are the seal. Adding, removing, or renaming an overlay entry moves
	// a count and fails here, which forces the change to be verified against the
	// ROM data rather than inheriting the confidence of the entries already
	// checked. Re-verify, then update the profile deliberately.
	const fs = require('node:fs');
	const source = fs.readFileSync(require('node:path').join(__dirname, 'ai', 'src', 'move-metadata.ts'), 'utf8');

	function tableSize(name) {
		const match = source.match(new RegExp('const ' + name + '[^{]*\\{([\\s\\S]*?)\\n\\};'));
		assert.ok(match, `${name} not found in ai/src/move-metadata.ts`);
		return Object.keys(Object.fromEntries(
			Array.from(match[1].matchAll(/([a-z0-9]+)\s*:\s*(-?\d+)/g)).map(m => [m[1], m[2]])
		)).length;
	}

	const overlay = profile.data.MOVE_OVERLAY;
	const accuracy = tableSize('CUSTOM_ACCURACY');
	const basePower = tableSize('CUSTOM_BASE_POWER');
	const maxPp = tableSize('CUSTOM_MAX_PP');

	assert.equal(accuracy, overlay.accuracyChanges, 'CUSTOM_ACCURACY entry count');
	assert.equal(basePower, overlay.basePowerChanges, 'CUSTOM_BASE_POWER entry count');
	assert.equal(maxPp, overlay.maxPpChanges, 'CUSTOM_MAX_PP entry count');
	assert.equal(
		accuracy + basePower + maxPp,
		overlay.verifiedEntries,
		`the overlay holds ${accuracy + basePower + maxPp} entries but ${overlay.verifiedEntries} were verified ` +
		`against ${overlay.verifiedAgainst}`
	);
});

test('the Run & Bun ability-slot overlay is intact', () => {
	// Run & Bun changes which ability a species leads with. The calculator uses
	// slot 0 as the default on species selection, so losing this overlay makes it
	// compute with abilities the game does not grant — silently, since nothing
	// about the output looks wrong.
	const fs = require('node:fs');
	const source = fs.readFileSync(
		require('node:path').join(__dirname, 'calc', 'src', 'data', 'species.ts'), 'utf8');
	const match = source.match(/const RUNBUN_ABILITIES[^{]*\{([\s\S]*?)\n\};/);
	assert.ok(match, 'the RUNBUN_ABILITIES overlay is missing from calc/src/data/species.ts');
	const entries = Array.from(match[1].matchAll(/abilities: \{0:/g)).length;
	assert.equal(
		entries,
		profile.data.ABILITY_SLOT_CHANGES.speciesChanged,
		`the ability overlay declares ${profile.data.ABILITY_SLOT_CHANGES.speciesChanged} species ` +
		`but holds ${entries}; re-verify against ${profile.data.ABILITY_SLOT_CHANGES.verifiedAgainst}`
	);

	// Spot-check species whose default ability changes damage or field state.
	assert.equal(species['Tyranitar'].abilities[0], 'Unnerve');
	assert.equal(species['Diglett'].abilities[0], 'Arena Trap');
	assert.equal(species['Buneary'].abilities[0], 'Cute Charm');
});

test('every profile claim carries a provenance tag', () => {
	// Untagged claims default to `inferred`, the weakest tag. This asserts the
	// data layer is actually backed by the source of truth rather than silently
	// falling through to that default.
	for (const key of Object.keys(profile.data)) {
		assert.equal(
			profile.provenanceOf(`data.${key}`),
			'source-of-truth',
			`data.${key} is not tagged source-of-truth; it was reconciled against dekzeh/calc`
		);
	}
});
