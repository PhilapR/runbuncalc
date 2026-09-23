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

test('an import records WHICH decomp made it, not only where it was', () => {
	// ledger: import-oracle-records-a-path-not-a-revision. `--decomp <path>`
	// names a place; the stamp names the bytes — a git revision when the
	// decomp is a clone, and the sha256 of every input either way.
	const childProcess = require('node:child_process');
	const decomp = fs.mkdtempSync(path.join(os.tmpdir(), 'decomp-rev-'));
	for (const rel of importer.DECOMP_INPUTS) {
		fs.mkdirSync(path.dirname(path.join(decomp, rel)), {recursive: true});
		fs.writeFileSync(path.join(decomp, rel), rel + '\n');
	}
	const tarball = importer.decompSource(decomp);
	assert.equal(tarball.revision, null, 'a directory that is not a checkout has no revision to claim');
	assert.equal(tarball.dirty, null);
	assert.deepEqual(Object.keys(tarball.inputs), importer.DECOMP_INPUTS);
	assert.ok(Object.values(tarball.inputs).every(hash => /^[0-9a-f]{64}$/.test(hash)));

	const git = args => childProcess.execFileSync('git', ['-C', decomp].concat(args), {encoding: 'utf8'});
	git(['init', '-q']);
	git(['add', '.']);
	git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'decomp']);
	const clone = importer.decompSource(decomp);
	assert.equal(clone.revision, git(['rev-parse', 'HEAD']).trim());
	assert.equal(clone.dirty, false);
	assert.deepEqual(clone.inputs, tarball.inputs, 'the same bytes hash the same however they arrived');

	fs.appendFileSync(path.join(decomp, 'species', 'evolution.h'), 'edited\n');
	const edited = importer.decompSource(decomp);
	assert.equal(edited.dirty, true, 'an uncommitted edit is not the revision it sits on');
	assert.notEqual(edited.inputs['species/evolution.h'], clone.inputs['species/evolution.h']);

	const out = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-out-'));
	fs.writeFileSync(path.join(out, 'growth.json'), '{}\n');
	const stamp = importer.stampImport(decomp, out, ['growth.json']);
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, importer.STAMP), 'utf8')), stamp);
	assert.equal(stamp.decomp.revision, clone.revision);
	assert.match(stamp.outputs['growth.json'], /^[0-9a-f]{64}$/);
});

test('the committed oracle data matches the import stamp that made it', t => {
	// Checkable without the decomp: the stamp names each output's bytes. The
	// datasets committed before the stamp existed have none until the next
	// import, and this says so rather than passing quietly.
	const dir = path.join(__dirname, '..', 'profiles', 'run-and-bun', 'oracle');
	const file = path.join(dir, importer.STAMP);
	if (!fs.existsSync(file)) {
		t.skip('no ' + importer.STAMP + ' yet: the four decomp datasets predate the stamp; re-import to record it');
		return;
	}
	const stamp = JSON.parse(fs.readFileSync(file, 'utf8'));
	for (const name of Object.keys(stamp.outputs)) {
		const bytes = require('node:crypto').createHash('sha256')
			.update(fs.readFileSync(path.join(dir, name))).digest('hex');
		assert.equal(bytes, stamp.outputs[name], name + ' is not the bytes the stamped import wrote');
	}
});
