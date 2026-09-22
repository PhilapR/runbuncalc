/* eslint-env node, es6 */
'use strict';

/**
 * Two silent paths in scripts/import-oracle.js, held on decomp fixtures.
 *
 * The decomp is not on this machine, so these run the importer's own
 * functions on the smallest files that show each defect. The shipped data is
 * held elsewhere: learnsets against the author's document in
 * learnset_doc.test.js.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const importer = require('../scripts/import-oracle.js');

function decompWith(files) {
	const decomp = fs.mkdtempSync(path.join(os.tmpdir(), 'decomp-'));
	fs.mkdirSync(path.join(decomp, 'species'));
	for (const name of Object.keys(files)) {
		fs.writeFileSync(path.join(decomp, 'species', name), files[name]);
	}
	return decomp;
}

test('a branch that collapses onto the same Pokemon is one row, not nine', () => {
	// ledger: nine-identical-milcery-rows. The Alcremie creams collapse to one
	// name on purpose; the branches that pointed at them must collapse too.
	const decomp = decompWith({'evolution.h': [
		'[SPECIES_MILCERY] = {{EVO_LEVEL, 0, SPECIES_ALCREMIE_STRAWBERRY_VANILLA_CREAM},',
		'                     {EVO_LEVEL, 0, SPECIES_ALCREMIE_STRAWBERRY_RUBY_CREAM},',
		'                     {EVO_LEVEL, 0, SPECIES_ALCREMIE_STRAWBERRY_MATCHA_CREAM}},',
		'[SPECIES_TYROGUE] = {{EVO_LEVEL_ATK_LT_DEF, 20, SPECIES_HITMONCHAN},',
		'                     {EVO_LEVEL_ATK_GT_DEF, 20, SPECIES_HITMONLEE}},',
	].join('\n')});
	const problems = [];
	const out = importer.importEvolutions(decomp, problems);
	assert.deepEqual(problems, []);
	assert.deepEqual(out.Milcery, [{into: 'Alcremie', method: 'level', level: 0}]);
	assert.equal(out.Tyrogue.length, 2, 'real branches that differ are all kept');
});

test('a level-up block the pattern cannot read is a problem, not an empty list', () => {
	// ledger: eight-catchable-species-have-no-level-up-movepool. An entry
	// spelled with a space before the paren read as zero moves and was stored
	// as the removed-species signature.
	const decomp = decompWith({
		'level_up_learnsets.h': [
			'static const struct LevelUpMove sBulbasaurLevelUpLearnset[] = {',
			'    LEVEL_UP_MOVE( 1, MOVE_TACKLE),',
			'    LEVEL_UP_END',
			'};',
			'static const struct LevelUpMove sIvysaurLevelUpLearnset[] = {',
			'    LEVEL_UP_MOVE (1, MOVE_TACKLE),',
			'    LEVEL_UP_END',
			'};',
			'static const struct LevelUpMove sCaterpieLevelUpLearnset[] = {',
			'    LEVEL_UP_END',
			'};',
			'',
		].join('\n'),
		'level_up_learnset_pointers.h': [
			'const struct LevelUpMove *const gLevelUpLearnsets[NUM_SPECIES] = {',
			'    [SPECIES_BULBASAUR] = sBulbasaurLevelUpLearnset,',
			'    [SPECIES_IVYSAUR] = sIvysaurLevelUpLearnset,',
			'    [SPECIES_CATERPIE] = sCaterpieLevelUpLearnset,',
			'};',
		].join('\n'),
		'teachable_learnsets.h': '',
		'teachable_learnset_pointers.h': 'const u16 *const gTeachableLearnsets[NUM_SPECIES] = {\n};\n',
		'egg_moves.h': '',
	});
	const problems = [];
	const out = importer.importLearnsets(decomp, problems);
	assert.deepEqual(out.levelUp.Bulbasaur, [[1, 'Tackle']]);
	assert.deepEqual(out.levelUp.Caterpie, [], 'a block that writes no move is an empty list, as the author wrote it');
	assert.equal(out.levelUp.Ivysaur, undefined, 'the unread block is not stored');
	assert.equal(problems.length, 1);
	assert.match(problems[0], /sIvysaurLevelUpLearnset writes 1 LEVEL_UP_MOVE entries and 0 were read/);
});
