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
	// Every fight logged, so the test does not hang on how the fights go: this
	// fixture lost Brawly twice until the TM ledger was dated (2026-09-21), and
	// now beats him first time with the Sludge Bomb it picks up in Dewford.
	const spec = headless.armFlags('--budget=2 --retries=1 --boss-retries=2 --probe=0 --fight-logs=all');
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

test('a fight can be watched as it is played: the tape writes each turn the moment it is decided', () => {
	// The sidecar is for afterwards. Both hands already report a turn by
	// pushing it onto a tape, so the tape is the hook and neither changes.
	const file = scratch('run.live.ndjson');
	const tape = fightLog.liveTape(file, {n: 3, trainer: 'Leader Brawly', attempt: 2, hand: 'search-8'});
	const read = () => fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
	assert.deepEqual(read().map(row => row.kind), ['attempt'], 'the header is there before the first turn');
	tape.push({turn: 1, chose: 'Tailwind'});
	assert.deepEqual(read().map(row => row.kind), ['attempt', 'turn'], 'a turn is on disk before the next is decided');
	tape.push({turn: 2, chose: 'Brave Bird'});
	tape.end('win');
	assert.deepEqual(read().map(row => row.kind), ['attempt', 'turn', 'turn', 'end']);
	assert.equal(tape.length, 2, 'and it is still the array the ledger keeps');

	// The next attempt replaces the file: it never holds more than one fight.
	fightLog.liveTape(file, {n: 4, trainer: 'Leader Brawly', attempt: 3, hand: 'search-8'});
	assert.deepEqual(read().map(row => [row.kind, row.attempt]), [['attempt', 3]]);
});
