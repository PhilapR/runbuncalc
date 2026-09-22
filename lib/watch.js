/* eslint-env node, es2017 */
'use strict';

/**
 * A watchable job: anything that plays fights and is not a run.
 *
 * Only runs started through scripts/run-batch.js -> run-one.js were seen:
 * they write a status file and a live tape, take a slot, and read a stop
 * request. A battery, the headless A/B arms and the rab-workspace planning
 * worker (plan by play, turn search) played the same fights on the same
 * code with none of that — invisible to the watch page, deaf to stop, and
 * outside the slot pool that keeps the machine from being oversubscribed
 * (found 2026-09-22).
 *
 *   const watch = require('../lib/watch.js');
 *   const job = watch.openJob({label: 'battery', name: 'heldout2', what: 'battery'});
 *   for (...) {
 *     const fight = job.fight({trainer, attempt, seed});
 *     const played = play(...);
 *     fight.end(played.result);
 *     job.progress({fights: n});
 *     if (job.stopRequested()) break;
 *   }
 *   job.close({state: 'ended'});
 *
 * Files, beside the runs, so every reader already finds them:
 *   <dir>/<label>/<name>.status.json   the same shape run-one writes, plus kind: 'job'
 *   <dir>/<label>/<name>.live.ndjson   the current fight: header and result
 *   <dir>/<label>/<name>.control.json  {"action": "stop"}, from runs.js or the page
 *
 * A job has no checkpoint: `runs.js carry-on` refuses it, and stop means
 * "finish the fight in progress and close". Pause is the process's own
 * SIGSTOP and needs nothing here.
 */

const fs = require('node:fs');
const path = require('node:path');
const slots = require('./slots.js');
const liveTape = require('./fight-log.js').liveTape;

const ROOT = path.join(__dirname, '..');
const DEFAULT_DIR = path.join(ROOT, 'ui-playthrough-out', 'runs');
// A test points jobs at a scratch folder, so it never writes beside real runs.
const runsDir = () => process.env.RUNBUN_RUNS_DIR || DEFAULT_DIR;
const NAME = /^[A-Za-z0-9_.-]+$/;

function writeAtomic(file, text) {
	fs.writeFileSync(file + '.tmp', text);
	fs.renameSync(file + '.tmp', file);
}

/** Block this thread for `ms` (a synchronous caller waiting for a slot). */
function sleepSync(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * A slot for this job, unless the process already holds one: submit.js sets
 * RUNBUN_SLOT_HELD for the command it runs, and a job inside it must not take
 * a second slot for the same work.
 */
function takeSlot(label, options) {
	if (process.env.RUNBUN_SLOT_HELD || options.slot === false) return {slot: null, release() {}};
	// A resident worker answering requests one at a time (rab-workspace's
	// planner) must not block every other request on a full pool: waitMs
	// bounds the wait and throws, which it can report as "busy".
	const deadline = options.waitMs === undefined ? Infinity : Date.now() + options.waitMs;
	for (;;) {
		const got = slots.tryAcquire({label});
		if (got) return got;
		if (Date.now() >= deadline) {
			const error = new Error('watch.openJob: no free slot in ' + options.waitMs + ' ms (' +
				slots.held().filter(row => row.pid).map(row => row.label || row.pid).join(', ') + ')');
			error.code = 'NO_SLOT';
			throw error;
		}
		sleepSync(Math.min(options.pollMs || 1000, Math.max(1, deadline - Date.now())));
	}
}

function openJob(options) {
	const label = options.label;
	const name = options.name;
	if (!NAME.test(label || '') || !NAME.test(name || '')) {
		throw new Error('watch.openJob: label and name are one path segment each ([A-Za-z0-9_.-]), not ' +
			JSON.stringify([label, name]));
	}
	const folder = path.join(options.dir || runsDir(), label);
	fs.mkdirSync(folder, {recursive: true});
	const base = path.join(folder, name);
	const slot = takeSlot(label + '/' + name, options);
	try { fs.unlinkSync(base + '.control.json'); } catch (error) { /* none waiting */ }
	const startedAt = Date.now();
	const now = {state: 'running', fights: 0, attempts: 0, position: null};
	// One leg, stamped with the engine it plays on, in the shape run-one
	// writes: runs.js and the audit read the engine from `legs`.
	const stamp = require('./provenance.js').currentStamp();
	const legs = [{leg: 1, revision: stamp.revision, dirty: stamp.dirty, engine: stamp, spec: options.spec || '',
		startedAt: new Date(startedAt).toISOString()}];
	const status = () => writeAtomic(base + '.status.json', JSON.stringify({
		pid: process.pid, seed: Number(options.seed) || 0, state: now.state, kind: 'job',
		what: options.what || label, position: now.position, fights: now.fights, attempts: now.attempts,
		startedAt, updatedAt: Date.now(), spec: options.spec || '', legs,
		secondsPerFight: now.fights ? Number(((Date.now() - startedAt) / 1000 / now.fights).toFixed(1)) : null,
		rssMb: Math.round(process.memoryUsage().rss / 1048576)}));
	status();
	let closed = false;
	return {
		base,
		slot: slot.slot,
		/** The fight about to be played: its header goes on the live tape, and `end` records the result. */
		fight(header) {
			now.attempts += 1;
			return liveTape(base + '.live.ndjson', Object.assign({n: now.fights + 1, attempt: now.attempts,
				hand: options.what || label}, header));
		},
		progress(update) {
			Object.assign(now, update || {});
			status();
		},
		stopRequested() {
			try {
				const asked = JSON.parse(fs.readFileSync(base + '.control.json', 'utf8'));
				if (asked && asked.action === 'stop') {
					now.state = 'stopping';
					status();
					return true;
				}
			} catch (error) { /* nothing asked */ }
			return false;
		},
		/** Final state: 'ended' (done), 'stopped' (asked to), 'failed' (threw). Releases the slot. */
		close(final) {
			if (closed) return;
			closed = true;
			now.state = (final && final.state) || (now.state === 'stopping' ? 'stopped' : 'ended');
			status();
			try { fs.unlinkSync(base + '.control.json'); } catch (error) { /* none */ }
			slot.release();
		},
	};
}

/** One path segment from free text (a battery label, a shard "0/4", a trainer name). */
function jobName(text) {
	return String(text || 'job').replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'job';
}

module.exports = {openJob, jobName, DEFAULT_DIR};
