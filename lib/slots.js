/* eslint-env node, es6 */
'use strict';

/**
 * One machine, one pool of slots: the cap on heavy jobs that holds ACROSS
 * batches.
 *
 * run-batch capped itself at cores - 2 and so did battery-arms, and neither
 * knew of the other or of a script started by hand. On 2026-09-21 six full
 * runs, four measurement shards and two ad-hoc probes shared eleven cores:
 * the load average reached 34, a search fight went from about a minute to
 * 146 s, and a sixteen-fight check took twenty minutes.
 *
 * A slot is a lock FILE, `N.lock`, holding the pid that owns it — no daemon,
 * because a supervisor that must itself be kept alive is one more thing that
 * dies unnoticed (the watch server already has). A lock whose pid is gone is
 * stale and is reaped, so a crashed or killed job never leaks its slot. The
 * directory is outside the repository on purpose: pinned worktrees at other
 * revisions must draw from the same pool.
 *
 *   RUNBUN_SLOTS      how many (default: cores - 2)
 *   RUNBUN_SLOTS_DIR  where (default: ~/.cache/runbuncalc/slots)
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const slotsDir = () => process.env.RUNBUN_SLOTS_DIR || path.join(os.homedir(), '.cache', 'runbuncalc', 'slots');
const capacity = () => Math.max(1, Number(process.env.RUNBUN_SLOTS) || os.cpus().length - 2);

function alive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: it exists and is someone else's. Only ESRCH means gone.
		return error.code === 'EPERM';
	}
}

function readLock(file) {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch (error) {
		return null;
	}
}

/**
 * Remove `file` if its owner is dead. Two reapers must not race — one could
 * unlink the lock the other has just re-taken — so reaping happens under a
 * directory lock (mkdir is atomic), and the owner is read again inside it.
 */
function reap(dir, file) {
	const guard = path.join(dir, 'reap.guard');
	try {
		fs.mkdirSync(guard);
	} catch (error) {
		// Someone else is reaping; or a reaper died mid-way, long ago.
		try {
			if (Date.now() - fs.statSync(guard).mtimeMs > 5000) fs.rmdirSync(guard);
		} catch (inner) { /* gone already */ }
		return false;
	}
	try {
		const held = readLock(file);
		// An unreadable lock is one being written this instant, unless it is old.
		const stale = held ? !alive(held.pid) : Date.now() - fs.statSync(file).mtimeMs > 5000;
		if (stale) fs.unlinkSync(file);
		return stale;
	} catch (error) {
		return false;
	} finally {
		try { fs.rmdirSync(guard); } catch (error) { /* gone already */ }
	}
}

/** Take a free slot now, or return null. `meta.pid` defaults to this process. */
function tryAcquire(meta) {
	const dir = slotsDir();
	fs.mkdirSync(dir, {recursive: true});
	const record = Object.assign({pid: process.pid, label: '', at: Date.now()}, meta);
	for (let slot = 0; slot < capacity(); slot++) {
		const file = path.join(dir, slot + '.lock');
		for (let pass = 0; pass < 2; pass++) {
			try {
				const fd = fs.openSync(file, 'wx');
				fs.writeSync(fd, JSON.stringify(record));
				fs.closeSync(fd);
				let released = false;
				return {slot, file, release() {
					if (released) return;
					released = true;
					const held = readLock(file);
					if (held && held.pid === record.pid) try { fs.unlinkSync(file); } catch (error) { /* reaped */ }
				}};
			} catch (error) {
				if (error.code !== 'EEXIST') throw error;
				const held = readLock(file);
				if (pass === 0 && !(held && alive(held.pid)) && reap(dir, file)) continue;
				break;
			}
		}
	}
	return null;
}

/** Wait for a slot. `onWait` is told once, with who holds the pool, when there is none. */
async function acquire(meta, options) {
	const pollMs = (options && options.pollMs) || 1000;
	let told = false;
	for (;;) {
		const got = tryAcquire(meta);
		if (got) return got;
		if (!told && options && options.onWait) {
			told = true;
			options.onWait(held());
		}
		await new Promise(resolve => setTimeout(resolve, pollMs));
	}
}

/** Every slot and who holds it; a stale holder reads as free. */
function held() {
	const dir = slotsDir();
	const out = [];
	for (let slot = 0; slot < capacity(); slot++) {
		const lock = readLock(path.join(dir, slot + '.lock'));
		out.push(lock && alive(lock.pid) ? Object.assign({slot}, lock) : {slot, pid: null});
	}
	return out;
}

module.exports = {tryAcquire, acquire, held, capacity, slotsDir, alive};
