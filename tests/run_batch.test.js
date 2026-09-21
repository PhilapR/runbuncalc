/* eslint-env node, es6 */
'use strict';

/**
 * A run is launched the same way every time, and lands where it can be found.
 *
 * Every baseline before scripts/run-batch.js came from a throwaway script: one
 * batch failed its provenance audit for running from a tree being edited, one
 * silently played without search, none kept a fight, and the only document at
 * Archie sat in a session scratchpad.
 */

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const batch = require('../scripts/run-batch.js');
const fightLog = require('../lib/fight-log.js');
const runOne = require('../scripts/run-one.js');

test('a batch plans from its arguments, and refuses what it cannot name', () => {
	const todo = batch.plan(['--label=base4', '--seeds=104770, 209499', '--spec=stop-at=343', '--resume-from=/tmp/earlier']);
	assert.deepEqual(todo.seeds, [104770, 209499]);
	assert.ok(todo.out.endsWith(path.join('ui-playthrough-out', 'runs', 'base4')), 'runs land in the repo\'s own output, not a scratchpad');
	assert.equal(todo.resume(209499), path.join('/tmp/earlier', 'run-209499.json'));
	assert.equal(batch.plan(['--label=x', '--seeds=1']).resume(1), '', 'no --resume-from, a fresh run');
	assert.throws(() => batch.plan(['--seeds=1']), /--label=NAME is required/);
	assert.throws(() => batch.plan(['--label=../escape', '--seeds=1']), /--label=NAME is required/);
	assert.throws(() => batch.plan(['--label=x', '--seeds=1,two']), /must be integers/);
});

test('a spec is key=value pairs, because a flag glued inside a value is refused', () => {
	assert.equal(runOne.specOf('boss-retries=40, stop-at=343'), '--boss-retries=40 --stop-at=343');
	assert.equal(runOne.specOf('--budget=2'), '--budget=2', 'dashes are tolerated');
	assert.equal(runOne.specOf(''), '');
});

test('one run writes its record, its fights and its log, and the knobs it was given', () => {
	const out = fs.mkdtempSync(path.join(os.tmpdir(), 'runone-'));
	const saved = path.join(__dirname, '..', 'fixtures', 'banked-runs', 'brbank1-A-1.run.json');
	const done = childProcess.spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'run-one.js'),
		'--seed=7', '--out=' + out, '--resume=' + saved, '--spec=budget=2,retries=1,boss-retries=2,probe=0'],
	{encoding: 'utf8'});
	assert.equal(done.status, 0, done.stderr);
	const row = JSON.parse(fs.readFileSync(path.join(out, 'run-7.json'), 'utf8'));
	assert.equal(row.knobs.budget, 2, 'the spec reached the run');
	assert.equal(row.resumedAt, 76);
	assert.ok(row.doc && row.doc.log.length, 'the document is kept, so the run can be carried on and audited');
	const fights = fightLog.readFightLog(path.join(out, 'run-7.fights.ndjson.gz'));
	assert.deepEqual(fights.map(line => line.n), row.ledger.map(fight => fight.n), 'every boss attempt is in the sidecar');
	assert.ok(row.ledger.every(fight => fight.log === undefined), 'and none of it is inline');
	assert.match(fs.readFileSync(path.join(out, 'run-7.log'), 'utf8'), /DONE position \d+ fights 2/);

	const lines = batch.summarise(out, [7, 8]);
	assert.match(lines[0], /^7: position \d+, 2 fights, \d+ min, stopped: /);
	assert.match(lines[1], /^8: no record/);
});
