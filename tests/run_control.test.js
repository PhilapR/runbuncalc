/* eslint-env node, es6 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const RUN_ONE = path.join(ROOT, 'scripts', 'run-one.js');
const SPEC = 'budget=14,retries=2,boss-retries=2,probe=0,fight-logs=all';

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const line = row => [row.n, row.trainer, row.seed, row.position, row.result, row.turns, row.logLine].join(' ');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('a real run is stopped from outside, carried on, and ends as the uninterrupted run ends', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-'));
	process.env.RUNBUN_RUNS_DIR = dir;
	const runs = require('../scripts/runs.js');
	const start = (out, extra) => childProcess.spawn(process.execPath, [RUN_ONE, '--seed=11', '--out=' + out,
		'--starter=Chimchar', '--rival=Swampert'].concat(extra), {stdio: 'ignore'});
	const ended = child => new Promise(resolve => child.on('exit', resolve));

	// The run nobody touches, and the one that is stopped: side by side.
	const whole = start(path.join(dir, 'whole'), ['--spec=' + SPEC]);
	const cut = start(path.join(dir, 'cut'), ['--spec=' + SPEC]);
	const wholeEnded = ended(whole);
	const cutEnded = ended(cut);
	const base = path.join(dir, 'cut', 'run-11');
	for (let waited = 0; waited < 600; waited++) {
		const status = fs.existsSync(base + '.status.json') ? readJson(base + '.status.json') : null;
		if (status && status.fights >= 4) break;
		await sleep(500);
	}
	const seen = runs.list(dir).find(row => row.run === 'cut/run-11');
	assert.equal(seen.state, 'running');
	assert.equal(seen.pid, cut.pid, 'the status file names the process, so nothing is ever found by pattern');
	assert.match(runs.act(dir, 'stop', 'cut/run-11'), /asked to stop/);
	assert.equal(await cutEnded, 0, 'a stop is a clean exit');

	const stopped = readJson(base + '.json');
	assert.equal(stopped.stopped, 'stopped by request');
	assert.ok(stopped.fights >= 4 && stopped.fights < 14, 'it stopped part-way: ' + stopped.fights);
	assert.equal(runs.list(dir).find(row => row.run === 'cut/run-11').state, 'stopped');
	assert.equal(readJson(base + '.checkpoint.json').state.tally.fights, stopped.fights, 'checkpointed where it stopped');
	assert.throws(() => runs.act(dir, 'stop', 'cut/run-11'), /not running/);

	assert.equal(await ended(start(path.join(dir, 'cut'), ['--carry-on=1'])), 0);
	assert.equal(await wholeEnded, 0);
	const carried = readJson(base + '.json');
	const straight = readJson(path.join(dir, 'whole', 'run-11.json'));
	assert.equal(carried.fights, 14);
	assert.deepEqual(carried.ledger.map(line), straight.ledger.map(line), 'the same run, fight for fight, log line for log line');
	assert.deepEqual(carried.knobs, straight.knobs, 'and it kept its knobs without being told them again');

	// Each leg says which engine played it and which stretch of the road it played.
	const stamp = require('../lib/provenance.js').currentStamp();
	assert.deepEqual(carried.legs.map(leg => [leg.leg, leg.engine.engine, leg.revision, leg.spec]),
		[[1, stamp.engine, stamp.revision, SPEC], [2, stamp.engine, stamp.revision, SPEC]]);
	assert.deepEqual(carried.legs[0].from, {position: 0, fights: 0});
	assert.deepEqual(carried.legs[0].to, {position: stopped.position, fights: stopped.fights}, 'leg 1 ends where the stop left it');
	assert.deepEqual(carried.legs[1].from, carried.legs[0].to, 'leg 2 starts where leg 1 ended');
	assert.deepEqual(carried.legs[1].to, {position: carried.position, fights: carried.fights});
	assert.equal(carried.provenance.engine.engine, stamp.engine, 'the row\'s provenance names the last leg\'s engine');
	assert.deepEqual(straight.legs.map(leg => leg.leg), [1], 'an uninterrupted run is one leg');
	assert.deepEqual(readJson(base + '.status.json').legs, carried.legs, 'the status carries the legs too');
	assert.deepEqual(runs.list(dir).find(row => row.run === 'cut/run-11').engines, [stamp.engine]);
	assert.equal(require('../scripts/audit-run.js').enginesCheck(carried).status, 'PASS');
	const fightLog = require('../lib/fight-log.js');

	// The fight being watched says where on the road it is, as a player counts it.
	const header = JSON.parse(fs.readFileSync(path.join(dir, 'whole', 'run-11.live.ndjson'), 'utf8').split('\n')[0]);
	assert.ok(Number.isInteger(header.road) && header.road > 0 && header.road <= 14, 'the Nth trainer: ' + header.road);
	assert.equal(header.roadOf, 358, 'of the whole road');

	// KILLED, not stopped: the checkpoint is then older than the fight log,
	// which holds attempts the carried-on run is about to play again.
	const shot = start(path.join(dir, 'shot'), ['--spec=' + SPEC]);
	const shotEnded = ended(shot);
	const shotBase = path.join(dir, 'shot', 'run-11');
	for (let waited = 0; waited < 600; waited++) {
		const status = fs.existsSync(shotBase + '.status.json') ? readJson(shotBase + '.status.json') : null;
		if (status && status.fights >= 6) break;
		await sleep(500);
	}
	assert.match(runs.act(dir, 'kill', 'shot/run-11'), /killed/);
	await shotEnded;
	assert.equal(runs.list(dir).find(row => row.run === 'shot/run-11').state, 'dead', 'running over a dead pid reads as dead');
	const before = readJson(shotBase + '.checkpoint.json');
	assert.ok(fightLog.readFightLog(shotBase + '.fights.ndjson.gz').length > before.fightLog.lines,
		'the log ran ahead of the checkpoint: ' + before.fightLog.lines);
	assert.equal(await ended(start(path.join(dir, 'shot'), ['--carry-on=1'])), 0);
	assert.deepEqual(readJson(shotBase + '.json').ledger.map(line), straight.ledger.map(line), 'killed and carried on: the same run again');
	assert.deepEqual(fightLog.readFightLog(shotBase + '.fights.ndjson.gz').map(entry => entry.n),
		straight.ledger.map(row => row.n), 'and its fight log was cut back, not doubled');
	assert.deepEqual(fightLog.readFightLog(base + '.fights.ndjson.gz').map(entry => entry.n),
		fightLog.readFightLog(path.join(dir, 'whole', 'run-11.fights.ndjson.gz')).map(entry => entry.n),
		'the fight log holds each attempt once: nothing doubled, nothing lost');
});
