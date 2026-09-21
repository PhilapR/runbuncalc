/* eslint-env node, es6 */
'use strict';

/**
 * A run's fights are streamed to a compressed sidecar, an attempt at a time.
 *
 * Inline on the ledger they were ~36 KB an attempt, held in memory for the
 * whole run and written once at the end — so a run that crashed or was killed
 * lost every fight it had played, and those are the runs worth reading.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const fightLog = require('../lib/fight-log.js');
const headless = require('../scripts/headless-run.js');

const scratch = name => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fightlog-')), name);

test('attempts go to disk as they end, and a killed run keeps the ones it finished', () => {
	const file = scratch('run.fights.ndjson.gz');
	const sink = fightLog.openFightLog(file);
	const turn = n => ({turn: n, us: 'Bewear L65', foe: 'Mienshao L65', chose: 'Superpower', events: ['x'.repeat(200)]});
	assert.equal(sink.append({n: 1, trainer: 'Leader Brawly', result: 'loss', log: [turn(1), turn(2)]}), 0);
	assert.deepEqual(fightLog.readFightLog(file).map(row => row.n), [1], 'the first attempt is readable before the second exists');
	assert.equal(sink.append({n: 2, trainer: 'Leader Brawly', result: 'win', log: [turn(1)]}), 1);
	const whole = fs.statSync(file).size;
	assert.deepEqual(fightLog.readFightLog(file).map(row => row.result), ['loss', 'win']);

	// The run is killed while the third attempt is being written.
	sink.append({n: 3, trainer: 'Leader Roxanne', result: 'loss', log: [turn(1), turn(2), turn(3)]});
	fs.truncateSync(file, whole + 20);
	assert.deepEqual(fightLog.readFightLog(file).map(row => row.n), [1, 2],
		'every attempt that finished is still there; only the torn one is lost');
});

test('with a sidecar the ledger keeps a pointer, not the fight', () => {
	const policy = require('../scripts/ui-playthrough.js');
	const saved = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'banked-runs',
		'brbank1-A-1.run.json'), 'utf8'));
	const spec = headless.armFlags('--budget=2 --retries=1 --boss-retries=2 --probe=0');
	const inline = headless.playRun(policy, {species: 'Chimchar', rival: 'Blaziken'}, 7, spec, {resume: saved});
	assert.ok(inline.ledger[0].log.length > 0, 'without a sidecar the fight rides on the row');

	const file = scratch('run.fights.ndjson.gz');
	const streamed = headless.playRun(policy, {species: 'Chimchar', rival: 'Blaziken'}, 7, spec,
		{resume: saved, fightLog: fightLog.openFightLog(file)});
	assert.deepEqual(streamed.ledger.map(row => row.logLine), [0, 1]);
	assert.ok(streamed.ledger.every(row => row.log === undefined && row.six === undefined),
		'the row holds no fight');
	const lines = fightLog.readFightLog(file);
	assert.deepEqual(lines.map(row => [row.n, row.trainer, row.result]),
		streamed.ledger.map(row => [row.n, row.trainer, row.result]), 'and the sidecar names the attempt each line belongs to');
	assert.deepEqual(lines[0].log, inline.ledger[0].log, 'the fight itself is the same fight');
	assert.ok(JSON.stringify(streamed.ledger).length * 5 < JSON.stringify(inline.ledger).length,
		'and the record a run holds in memory is a fraction of the size');
});
