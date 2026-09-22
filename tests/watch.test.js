/* eslint-env node, es6 */
'use strict';

/**
 * A job that plays fights and is not a run is watched the way a run is: a
 * status file and a live tape where runs.js and the watch page look, a slot
 * from the pool, a stop that is honoured, and the slot given back.
 */
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function scratch() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-'));
	return {runs: path.join(dir, 'runs'), slots: path.join(dir, 'slots')};
}

function withEnv(env, fn) {
	const before = {};
	for (const key of Object.keys(env)) {
		before[key] = process.env[key];
		if (env[key] === undefined) delete process.env[key];
		else process.env[key] = env[key];
	}
	try {
		return fn();
	} finally {
		for (const key of Object.keys(before)) {
			if (before[key] === undefined) delete process.env[key];
			else process.env[key] = before[key];
		}
	}
}

test('a job is on the watch page, in the pool, stoppable, and gives its slot back', () => {
	const dirs = scratch();
	withEnv({RUNBUN_RUNS_DIR: dirs.runs, RUNBUN_SLOTS_DIR: dirs.slots, RUNBUN_SLOTS: '1', RUNBUN_SLOT_HELD: undefined}, () => {
		const watch = require('../lib/watch.js');
		const slots = require('../lib/slots.js');
		const runs = require('../scripts/runs.js');
		const job = watch.openJob({label: 'battery', name: watch.jobName('heldout 2 · 0/4'), what: 'battery', spec: '--x=1'});
		assert.equal(path.basename(job.base), 'heldout-2-0-4', 'a free-text label becomes one path segment');
		// In the pool: the one slot is this job's, and nobody else gets it.
		assert.equal(job.slot, 0);
		assert.equal(slots.tryAcquire({label: 'someone else'}), null, 'the pool is full while the job runs');
		// The status carries every field the watch page's schema requires, and says it is a job.
		const status = JSON.parse(fs.readFileSync(job.base + '.status.json', 'utf8'));
		for (const key of ['pid', 'seed', 'state', 'position', 'fights', 'startedAt', 'updatedAt', 'secondsPerFight', 'rssMb']) {
			assert.ok(Object.prototype.hasOwnProperty.call(status, key), 'status has ' + key);
		}
		assert.equal(status.kind, 'job');
		assert.equal(status.state, 'running');
		// A fight goes on the live tape: header, then result.
		const fight = job.fight({trainer: 'Leader Norman', seed: 3});
		fight.end('loss');
		job.progress({fights: 1});
		const lines = fs.readFileSync(job.base + '.live.ndjson', 'utf8').trim().split('\n').map(line => JSON.parse(line));
		assert.equal(lines[0].trainer, 'Leader Norman');
		assert.equal(lines[lines.length - 1].result, 'loss');
		// runs.js lists it with the runs, and its stop verb reaches it.
		const row = runs.list(dirs.runs).find(entry => entry.run === 'battery/heldout-2-0-4');
		assert.ok(row, 'runs.js lists the job: ' + JSON.stringify(runs.list(dirs.runs).map(entry => entry.run)));
		assert.equal(row.state, 'running');
		assert.equal(job.stopRequested(), false);
		runs.act(dirs.runs, 'stop', 'battery/heldout-2-0-4');
		assert.equal(job.stopRequested(), true, 'a stop from runs.js is honoured');
		job.close();
		assert.equal(JSON.parse(fs.readFileSync(job.base + '.status.json', 'utf8')).state, 'stopped');
		assert.ok(slots.tryAcquire({label: 'next'}), 'the slot is given back on close');
	});
});

test('a job inside submit.js takes no second slot', () => {
	const dirs = scratch();
	withEnv({RUNBUN_RUNS_DIR: dirs.runs, RUNBUN_SLOTS_DIR: dirs.slots, RUNBUN_SLOTS: '1', RUNBUN_SLOT_HELD: '0'}, () => {
		const watch = require('../lib/watch.js');
		const slots = require('../lib/slots.js');
		const job = watch.openJob({label: 'battery', name: 'inside-submit'});
		assert.equal(job.slot, null);
		const other = slots.tryAcquire({label: 'free'});
		assert.ok(other, 'the pool slot was not taken again');
		other.release();
		job.close();
	});
});

test('a watched battery stops between fights and writes no receipt', () => {
	const battery = require('../scripts/scenario-battery.js');
	const policy = require('../scripts/ui-playthrough.js');
	const tapes = [];
	const job = {
		fight(header) {
			const tape = {header, end(result) { tape.result = result; }};
			tapes.push(tape);
			return tape;
		},
		progress() {},
		stopRequested() { return true; },
	};
	assert.throws(() => battery.runScenario(policy, {name: 'Miguel', trainer: 'Pokéfan Miguel',
		report: 'fixtures/banked-runs/flannery-3.run.json', seeds: 3}, job),
	error => error.name === 'Error' && /stopped by request after 1 fights/.test(error.message));
	assert.equal(tapes.length, 1, 'one fight played, then the stop');
	assert.ok(tapes[0].result, 'and its result is on the tape');
});

test('a job that must not block gives up on a full pool, and says so', () => {
	const dirs = scratch();
	withEnv({RUNBUN_RUNS_DIR: dirs.runs, RUNBUN_SLOTS_DIR: dirs.slots, RUNBUN_SLOTS: '1', RUNBUN_SLOT_HELD: undefined}, () => {
		const watch = require('../lib/watch.js');
		const slots = require('../lib/slots.js');
		const holder = slots.tryAcquire({label: 'a long batch'});
		assert.ok(holder);
		const started = Date.now();
		assert.throws(() => watch.openJob({label: 'rab-workspace', name: 'plan', waitMs: 50, pollMs: 10}),
			error => error.code === 'NO_SLOT' && /a long batch/.test(error.message));
		assert.ok(Date.now() - started < 2000, 'it did not wait for ever');
		holder.release();
	});
});
