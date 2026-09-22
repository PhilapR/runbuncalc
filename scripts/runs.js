#!/usr/bin/env node
/* eslint-env node, es6 */
'use strict';

/**
 * The runs on this machine, and a hand on each of them.
 *
 *   node scripts/runs.js list
 *   node scripts/runs.js stop     clear1/run-731001    ask it to stop; it checkpoints and exits between fights
 *   node scripts/runs.js pause    clear1/run-731001    SIGSTOP, at once; it keeps its slot and its memory
 *   node scripts/runs.js cont     clear1/run-731001    SIGCONT
 *   node scripts/runs.js kill     clear1/run-731001    SIGTERM; at most CHECKPOINT_MS of play is lost
 *   node scripts/runs.js carry-on clear1/run-731001 [--spec=hand-by-probe=1] [--rev=HEAD]
 *
 * Everything here goes by the pid in the run's OWN status file
 * (scripts/run-one.js writes it), never by a name pattern: `pkill -f` once
 * took the watch server down with the run it was aimed at, and three
 * `pgrep -f` waiters matched their own command lines and waited for ever.
 *
 * carry-on goes through scripts/run-batch.js, so the run is taken up from a
 * pinned clean worktree and inside the machine's slot pool like any other.
 */

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const provenance = require('../lib/provenance.js');
const slots = require('../lib/slots.js');

const ROOT = path.join(__dirname, '..');
const RUNS = () => process.env.RUNBUN_RUNS_DIR || path.join(ROOT, 'ui-playthrough-out', 'runs');

function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch (error) {
		return null;
	}
}

/** Every run that has a status file, with what its process is doing NOW. */
function list(dir) {
	const out = [];
	const walk = (folder, depth) => {
		let names = [];
		try { names = fs.readdirSync(folder, {withFileTypes: true}); } catch (error) { return; }
		for (const entry of names) {
			// A dot-directory is put away (runs/.archive, .worktrees): the watch page skips them too.
			if (entry.name.startsWith('.')) continue;
			if (entry.isDirectory() && depth < 3) walk(path.join(folder, entry.name), depth + 1);
			else if (entry.name.endsWith('.status.json')) {
				const status = readJson(path.join(folder, entry.name));
				if (!status) continue;
				const base = path.join(folder, entry.name.slice(0, -'.status.json'.length));
				const live = slots.alive(status.pid);
				// A status that says running over a dead pid is a run that was killed.
				const state = /^(running|stopping|paused)$/.test(status.state) && !live ? 'dead' : status.state;
				out.push(Object.assign({}, status, {run: path.relative(dir, base), base, state,
					checkpoint: fs.existsSync(base + '.checkpoint.json'), engines: enginesOf(status)}));
			}
		}
	};
	walk(dir, 0);
	return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * The engines a run's legs were played on (scripts/run-one.js records them):
 * their keys, first met first. A status from before legs reads as one unknown.
 */
function enginesOf(status) {
	if (!Array.isArray(status.legs) || !status.legs.length) return [provenance.UNKNOWN];
	return provenance.enginesOfLegs(status.legs).map(entry => entry.key);
}

/** What the list says about engines: nothing for one known, a flag for a span. */
function engineNote(row) {
	const engines = row.engines || [];
	if (engines.length > 1) return ' SPANS ' + engines.length + ' ENGINES (' + engines.join(', ') + ')';
	if (engines[0] === provenance.UNKNOWN) return ' (' + provenance.UNKNOWN + ')';
	return engines.length ? ' ' + engines[0] : '';
}

function find(dir, name) {
	const hit = list(dir).filter(row => row.run === name || row.run.endsWith('/' + name) || String(row.seed) === name);
	if (hit.length !== 1) throw new Error(hit.length ? name + ' names ' + hit.length + ' runs: ' + hit.map(row => row.run).join(', ') : 'no run called ' + name);
	return hit[0];
}

function setState(row, state) {
	const status = readJson(row.base + '.status.json') || {};
	fs.writeFileSync(row.base + '.status.json.tmp', JSON.stringify(Object.assign(status, {state, updatedAt: Date.now()})));
	fs.renameSync(row.base + '.status.json.tmp', row.base + '.status.json');
}

function act(dir, verb, name, argv) {
	const row = find(dir, name);
	const needsLive = () => { if (!slots.alive(row.pid)) throw new Error(row.run + ' is not running (' + row.state + ')'); };
	if (verb === 'stop') {
		needsLive();
		fs.writeFileSync(row.base + '.control.json', JSON.stringify({action: 'stop', at: Date.now()}));
		return row.run + ': asked to stop; it will checkpoint and exit after the fight it is in';
	}
	if (verb === 'pause' || verb === 'cont' || verb === 'kill') {
		needsLive();
		process.kill(row.pid, {pause: 'SIGSTOP', cont: 'SIGCONT', kill: 'SIGTERM'}[verb]);
		if (verb !== 'kill') setState(row, verb === 'pause' ? 'paused' : 'running');
		return row.run + ': ' + {pause: 'paused', cont: 'continued', kill: 'killed'}[verb] + ' (pid ' + row.pid + ')';
	}
	if (verb === 'carry-on') {
		if (slots.alive(row.pid) && row.state !== 'dead') throw new Error(row.run + ' is still running (pid ' + row.pid + ')');
		if (!row.checkpoint) throw new Error(row.run + ' has no checkpoint to carry on from');
		const label = path.dirname(row.run);
		const pass = (argv || []).filter(arg => /^--(spec|rev)=/.test(arg));
		const out = fs.openSync(path.join(path.dirname(row.base), 'carry-on-' + row.seed + '.out'), 'a');
		const child = childProcess.spawn(process.execPath, [path.join(__dirname, 'run-batch.js'), '--label=' + label,
			'--seeds=' + row.seed, '--carry-on=1'].concat(pass), {cwd: ROOT, detached: true, stdio: ['ignore', out, out]});
		child.unref();
		return row.run + ': carried on from position ' + row.position + (pass.length ? ' with ' + pass.join(' ') : '');
	}
	throw new Error('unknown verb ' + verb);
}

function table(rows) {
	const held = slots.held();
	const lines = [held.filter(row => row.pid).length + ' of ' + held.length + ' slots held'];
	for (const row of rows) {
		lines.push([row.run.padEnd(28), String(row.state).padEnd(9), ('pos ' + row.position).padEnd(9),
			(row.fights + ' fights').padEnd(12), (row.secondsPerFight === null ? '' : row.secondsPerFight + ' s/fight').padEnd(14),
			(row.rssMb + ' MB').padEnd(8), Math.round((Date.now() - row.updatedAt) / 1000) + ' s ago',
			row.spec ? ' [' + (row.spec.length > 48 ? row.spec.slice(0, 45) + '...' : row.spec) + ']' : ''].join(' ') +
			engineNote(row));
	}
	return lines;
}

function main() {
	const words = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
	const verb = words[0];
	const name = words[1];
	try {
		if (!verb || verb === 'list') process.stdout.write(table(list(RUNS())).join('\n') + '\n');
		else process.stdout.write(act(RUNS(), verb, name || '', process.argv.slice(2)) + '\n');
	} catch (error) {
		process.stderr.write(error.message + '\n');
		process.exit(1);
	}
}

if (require.main === module) main();

module.exports = {list, find, act, table, enginesOf};
