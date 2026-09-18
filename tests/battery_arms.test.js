/* eslint-env node, es6 */
'use strict';

/**
 * Gates for scripts/battery-arms.js, the parallel arm runner.
 *
 * Its whole value is that a receipt it produces is exactly the receipt a
 * lone battery run in a clean tree would have written: the right revision,
 * dirty false, the arm's own flags and nothing else, and no worktree left
 * behind. The parser has to refuse, before any worktree is built, every arm
 * spec that would run something other than what it names.
 */

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const arms = require('../scripts/battery-arms.js');

const ONE_FIGHT = '--report=fixtures/banked-runs/flannery-3.run.json,--trainer=Pokéfan Miguel,--seeds=1';

test('an arm spec names a label, a manifest and flags, each flag its own argument', () => {
	const parsed = arms.parseArms(['--arm=b9:battery:', '--arm=b9-pp:battery:--pp-model=1',
		'--arm=one::' + ONE_FIGHT]);
	assert.deepEqual(parsed[0], {label: 'b9', manifest: 'battery', flags: []});
	assert.deepEqual(parsed[1].flags, ['--pp-model=1']);
	assert.equal(parsed[2].manifest, '', 'empty manifest is single-scenario mode');
	assert.deepEqual(parsed[2].flags, ['--report=fixtures/banked-runs/flannery-3.run.json',
		'--trainer=Pokéfan Miguel', '--seeds=1'], 'a value may hold a space');

	const refuse = (argv, pattern) => assert.throws(() => arms.parseArms(argv), pattern);
	refuse([], /no arms/);
	refuse(['--arm=only-a-label'], /LABEL:MANIFEST:FLAGS/);
	refuse(['--arm=x:battery:', '--arm=x:heldout:'], /share the label x/);
	refuse(['--arm=a b:battery:'], /not a receipt name/);
	refuse(['--arm=g:heldout2:--ko-respects-order=1 --pp-model=1'], /glued/);
	refuse(['--arm=h:battery:pp-model=1'], /one --name=value/);
	refuse(['--arm=l:battery:--label=other'], /set by the runner/);
});

test('each arm runs from its own clean worktree and leaves only its receipt', async () => {
	const out = fs.mkdtempSync(path.join(os.tmpdir(), 'arms-out-'));
	const worktrees = fs.mkdtempSync(path.join(os.tmpdir(), 'arms-wt-'));
	const head = childProcess.execFileSync('git', ['rev-parse', 'HEAD'],
		{cwd: path.join(__dirname, '..'), encoding: 'utf8'}).trim();
	const outcome = await arms.runArms({
		arms: arms.parseArms(['--arm=gate-a::' + ONE_FIGHT, '--arm=gate-b::' + ONE_FIGHT + ',--pp-model=1']),
		rev: 'HEAD', concurrency: 2, out, worktrees,
	});
	assert.equal(outcome.sha, head);
	assert.deepEqual(outcome.results.map(result => [result.label, result.status, result.receipt]).sort(),
		[['gate-a', 0, true], ['gate-b', 0, true]]);
	for (const label of ['gate-a', 'gate-b']) {
		const receipt = JSON.parse(fs.readFileSync(path.join(out, label + '.json'), 'utf8'));
		assert.equal(receipt.provenance.revision, head, label + ' ran at the named revision');
		assert.equal(receipt.provenance.dirty, false, label + ' ran from a clean tree');
		assert.equal(receipt.label, label);
	}
	const b = JSON.parse(fs.readFileSync(path.join(out, 'gate-b.json'), 'utf8'));
	assert.ok(b.argv.includes('--pp-model=1'), 'the arm\'s own flags, one argument each');
	const listed = childProcess.execFileSync('git', ['worktree', 'list'],
		{cwd: path.join(__dirname, '..'), encoding: 'utf8'});
	assert.ok(!listed.includes(worktrees), 'no worktree is left behind');

	await assert.rejects(arms.runArms({arms: arms.parseArms(['--arm=x:battery:']),
		rev: 'no-such-revision-anywhere', concurrency: 1, out, worktrees}), /no commit named/);
});
