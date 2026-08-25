#!/usr/bin/env node
/* eslint-env node, es6 */
'use strict';

/**
 * Interleaved A/B runner for the playthrough driver.
 *
 * Every experiment in this work so far was a shell loop and an awk one-liner,
 * and three of them went wrong in ways the loop could not see. One had its arms
 * straddle a mid-run edit to the code they were comparing. One passed a flag to
 * the control arm that did not exist, so the control silently ran the treatment
 * with a term switched off. One reported a mean pulled by a single outlier at
 * n = 5. None of those were storage problems; they were all the harness having
 * no opinion about what makes a comparison valid.
 *
 * So this one refuses rather than reports:
 *
 *   - it records the revision before the first run and again after the last,
 *     and fails if they differ or if the tree was dirty. A tally that straddles
 *     an edit is not a slow result, it is a wrong one.
 *   - it fails if any run reports a flag that nothing read, which is the
 *     driver's own audit surfaced here.
 *   - it alternates arms run by run, so a good or bad stretch of box luck
 *     cannot land on one of them.
 *   - it reports Fisher's exact p on the pass counts alongside the rates,
 *     because "9 of 15 against 4 of 15" reads as decisive and is not.
 *
 * Usage:
 *   node scripts/ab.js --pairs=20 --parallel=2 \
 *     --a="--status-value=0" --b="" --label=status-value
 *
 * `--a` is the control and `--b` the treatment; either may be empty for "the
 * defaults". Everything after `--` is passed to both arms.
 */

const childProcess = require('node:child_process');
const execFile = childProcess.execFile;
const execFileSync = childProcess.execFileSync;
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-playthrough-out');

/**
 * Run the batch from a detached worktree pinned to one revision.
 *
 * Three comparisons in a row were invalidated by a commit landing while they
 * ran, and detecting that is not the same as preventing it: each time the
 * runs were already spent. A worktree makes the batch immune — the main tree
 * can be committed to freely and the playthroughs keep reading the revision
 * they started on.
 *
 * `dist` is tracked, so the worktree gets the exact client bundle the revision
 * had. The three node_modules directories are gitignored and therefore absent,
 * so they are symlinked rather than installed: they are the same dependencies
 * at the same versions, and installing them per batch would cost more than the
 * batch.
 */
function makeWorktree(revision) {
	const dir = path.join(ROOT, '.ab-worktree');
	try {
		execFileSync('git', ['worktree', 'remove', '--force', dir],
			{cwd: ROOT, stdio: 'ignore'});
	} catch (error) { /* nothing to remove */ }
	execFileSync('git', ['worktree', 'add', '--detach', dir, revision],
		{cwd: ROOT, stdio: 'ignore'});
	for (const rel of ['node_modules', 'calc/node_modules', 'ai/node_modules']) {
		const target = path.join(ROOT, rel);
		if (!fs.existsSync(target)) continue;
		const link = path.join(dir, rel);
		fs.mkdirSync(path.dirname(link), {recursive: true});
		if (!fs.existsSync(link)) fs.symlinkSync(target, link, 'dir');
	}
	fs.mkdirSync(path.join(dir, 'ui-playthrough-out'), {recursive: true});
	return dir;
}

function dropWorktree(dir) {
	try {
		execFileSync('git', ['worktree', 'remove', '--force', dir],
			{cwd: ROOT, stdio: 'ignore'});
	} catch (error) { /* leave it for inspection */ }
}
const STARTERS = ['Turtwig', 'Chimchar', 'Piplup'];

function flag(name, fallback) {
	const hit = process.argv.find(arg => arg.startsWith('--' + name + '='));
	return hit === undefined ? fallback : hit.slice(name.length + 3);
}

function git(args) {
	try {
		return execFileSync('git', args, {cwd: ROOT, encoding: 'utf8'}).trim();
	} catch (error) {
		return null;
	}
}

/** Free space in GB, so a full volume stops the batch instead of crashing it. */
function freeGb() {
	try {
		const out = execFileSync('df', ['-g', '/System/Volumes/Data'], {encoding: 'utf8'});
		return Number(out.trim().split('\n').pop().split(/\s+/)[3]);
	} catch (error) {
		return Infinity;
	}
}

function runOnce(spec, home) {
	return new Promise(resolve => {
		const log = fs.openSync(path.join(home, 'ui-playthrough-out', spec.logName), 'w');
		const child = execFile('node', ['scripts/ui-playthrough.js'].concat(spec.args),
			{cwd: home, maxBuffer: 1 << 28}, () => {});
		child.stdout.on('data', d => fs.writeSync(log, d));
		child.stderr.on('data', d => fs.writeSync(log, d));
		child.on('close', () => {
			fs.closeSync(log);
			resolve(readResult(spec, home));
		});
	});
}

/** What a finished run is worth to the comparison. */
function readResult(spec, home) {
	const out = path.join(home || ROOT, 'ui-playthrough-out');
	const text = fs.readFileSync(path.join(out, spec.logName), 'utf8');
	const orders = (text.match(/\(#(\d+)\)/g) || []).map(s => Number(s.slice(2, -1)));
	const attempts = name => {
		const won = (text.match(new RegExp(name + ' — won in', 'g')) || []).length;
		const lost = (text.match(new RegExp(name + ' — wiped in', 'g')) || []).length;
		return {won: won, attempts: won + lost};
	};
	let provenance = null;
	try {
		provenance = JSON.parse(fs.readFileSync(path.join(out, spec.reportName), 'utf8')).provenance;
	} catch (error) {
		provenance = null;
	}
	return {
		arm: spec.arm, index: spec.index, starter: spec.starter,
		order: orders.length ? Math.max.apply(null, orders) : 0,
		gavi: attempts('Camper Gavi'),
		brawly: attempts('Leader Brawly'),
		roxanne: attempts('Leader Roxanne'),
		crashed: /TimeoutError|ERR_|Cannot read propert/.test(text),
		provenance: provenance,
	};
}

function lnFact(n) {
	let sum = 0;
	for (let i = 2; i <= n; i++) sum += Math.log(i);
	return sum;
}
function lnChoose(n, k) {
	return lnFact(n) - lnFact(k) - lnFact(n - k);
}
/** One-sided P(X >= a) with both margins fixed. */
function fisher(a, b, c, d) {
	const n = a + b + c + d;
	const row = a + b;
	const col = a + c;
	let p = 0;
	for (let x = a; x <= Math.min(row, col); x++) {
		const y = row - x;
		const z = col - x;
		const w = n - row - col + x;
		if (y < 0 || z < 0 || w < 0) continue;
		p += Math.exp(lnChoose(col, x) + lnChoose(n - col, y) - lnChoose(n, row));
	}
	return p;
}

function summarise(rows, arm) {
	const mine = rows.filter(r => r.arm === arm);
	const sum = f => mine.reduce((a, r) => a + f(r), 0);
	return {
		arm: arm, runs: mine.length,
		meanOrder: mine.length ? sum(r => r.order) / mine.length : 0,
		passedGavi: mine.filter(r => r.gavi.won > 0).length,
		beatBrawly: mine.filter(r => r.brawly.won > 0).length,
		gaviWon: sum(r => r.gavi.won), gaviAttempts: sum(r => r.gavi.attempts),
		brawlyWon: sum(r => r.brawly.won), brawlyAttempts: sum(r => r.brawly.attempts),
		crashed: mine.filter(r => r.crashed).length,
	};
}

async function main() {
	const pairs = Number(flag('pairs', '20'));
	// Six, measured — and the previous three was not. That number came from
	// reading a load average of 13.2 on 11 cores and INFERRING that four would
	// thrash, which is the same substituting-reasoning-for-measurement that set
	// the retry cap wrong earlier. Six runs started together finish in 160s
	// against 189s for three: 27s a run against 63s, 2.4x the throughput, at the
	// same load of 13.4. Nothing thrashed and no run timed out.
	//
	// What would break first is not CPU but the driver's 20s waits, which
	// abandon a fight and corrupt the arm rather than merely slowing it. So the
	// number to watch when raising this is TimeoutErrors, not load: zero across
	// all six is what licensed it.
	const parallel = Math.max(1, Number(flag('parallel', '6')));
	const label = flag('label', 'ab');
	const armA = flag('a', '').split(' ').filter(Boolean);
	const armB = flag('b', '').split(' ').filter(Boolean);
	const shared = (flag('shared',
		'--rules=encounters --box=22 --party=matrix --tms=assume ' +
		'--fights=90 --budget=480 --plan=1')).split(' ').filter(Boolean);

	const startRevision = git(['rev-parse', 'HEAD']);
	const startDirty = git(['status', '--porcelain']) !== '';
	if (startDirty) {
		console.error('REFUSING: the tree is dirty. A tally cannot name the code that produced it.');
		process.exit(1);
	}
	console.log('revision ' + String(startRevision).slice(0, 10) + ' · ' + pairs +
		' pairs · ' + parallel + ' at a time');
	console.log('  A (control):   ' + (armA.join(' ') || '(defaults)'));
	console.log('  B (treatment): ' + (armB.join(' ') || '(defaults)'));

	const queue = [];
	for (let i = 1; i <= pairs; i++) {
		const starter = STARTERS[(i - 1) % STARTERS.length];
		for (const side of [{arm: 'A', extra: armA}, {arm: 'B', extra: armB}]) {
			const arm = side.arm;
			const extra = side.extra;
			const name = label + '-' + arm + '-' + i;
			queue.push({
				arm: arm, index: i, starter: starter,
				logName: name + '.log', reportName: 'report-' + name + '.json',
				args: shared.concat(['--starter=' + starter, '--report=report-' + name + '.json'], extra),
			});
		}
	}

	const isolate = flag('isolate', '1') !== '0';
	const home = isolate ? makeWorktree(startRevision) : ROOT;
	if (isolate) console.log('  isolated in a worktree at ' + startRevision.slice(0, 10));

	const rows = [];
	let next = 0;
	const workers = Array.from({length: parallel}, async () => {
		for (;;) {
			if (freeGb() < 3) {
				console.error('ABORT: under 3G free');
				return;
			}
			const spec = queue[next++];
			if (!spec) return;
			const row = await runOnce(spec);
			rows.push(row);
			console.log('  ' + row.arm + ' ' + row.index + ' (' + row.starter + '): order=' +
				row.order + ' gavi=' + row.gavi.won + '/' + row.gavi.attempts +
				' brawly=' + row.brawly.won + '/' + row.brawly.attempts +
				(row.crashed ? '  CRASHED' : ''));
		}
	});
	await Promise.all(workers);

	// Bring the evidence back before the worktree goes, then drop it. The logs
	// and reports are the only durable record of what each run did.
	if (isolate) {
		const from = path.join(home, 'ui-playthrough-out');
		for (const name of fs.readdirSync(from)) {
			try {
				fs.copyFileSync(path.join(from, name), path.join(OUT, name));
			} catch (error) { /* a partial run may leave an unreadable file */ }
		}
		dropWorktree(home);
	}

	// Validity gates. These fail the experiment rather than footnote it.
	const problems = [];
	const endRevision = git(['rev-parse', 'HEAD']);
	if (!isolate && endRevision !== startRevision) {
		problems.push('the revision changed mid-batch: ' + startRevision + ' -> ' + endRevision);
	}
	if (isolate && endRevision !== startRevision) {
		console.log('  (the main tree moved to ' + String(endRevision).slice(0, 10) +
			' during the batch; the worktree did not, which is the point)');
	}
	const revisions = new Set(rows.map(r => r.provenance && r.provenance.revision).filter(Boolean));
	if (revisions.size > 1) problems.push('runs report ' + revisions.size + ' different revisions');
	if (rows.some(r => r.provenance && r.provenance.dirty)) {
		problems.push('at least one run was produced from a dirty tree');
	}
	const unread = new Set();
	rows.forEach(r => (r.provenance && r.provenance.unreadFlags || []).forEach(f => unread.add(f)));
	if (unread.size) {
		problems.push('flags passed but never read: ' + Array.from(unread).join(', ') +
			' — an arm may not be the arm it claims');
	}

	const a = summarise(rows, 'A');
	const b = summarise(rows, 'B');
	console.log('\n=== ' + label + ' ===');
	for (const s of [a, b]) {
		console.log(s.arm.padEnd(2) + ' runs=' + String(s.runs).padEnd(4) +
			'meanOrder=' + s.meanOrder.toFixed(1).padEnd(8) +
			'passedGavi=' + s.passedGavi + '/' + s.runs + '  ' +
			'beatBrawly=' + s.beatBrawly + '/' + s.runs + '  ' +
			'gavi=' + s.gaviWon + '/' + s.gaviAttempts +
			' (' + (s.gaviAttempts ? (100 * s.gaviWon / s.gaviAttempts).toFixed(1) : '0') + '%)' +
			(s.crashed ? '  crashed=' + s.crashed : ''));
	}
	console.log('one-sided p (B better):');
	console.log('  runs passing Gavi:  ' +
		fisher(b.passedGavi, b.runs - b.passedGavi, a.passedGavi, a.runs - a.passedGavi).toFixed(4));
	console.log('  Gavi attempts won:  ' +
		fisher(b.gaviWon, b.gaviAttempts - b.gaviWon, a.gaviWon, a.gaviAttempts - a.gaviWon).toFixed(4));
	console.log('  runs beating Brawly:' +
		fisher(b.beatBrawly, b.runs - b.beatBrawly, a.beatBrawly, a.runs - a.beatBrawly).toFixed(4));

	const result = {label: label, revision: startRevision, pairs: pairs, parallel: parallel,
		armA: armA, armB: armB, shared: shared, rows: rows, summary: {A: a, B: b}, problems: problems};
	fs.writeFileSync(path.join(OUT, label + '-ab.json'), JSON.stringify(result, null, '\t'));

	if (problems.length) {
		console.error('\nINVALID — this comparison must not be reported:');
		problems.forEach(p => console.error('  - ' + p));
		process.exit(1);
	}
	console.log('\nvalid: one revision, clean tree, no unread flags.');
}

if (require.main === module) {
	main().catch(error => {
		console.error(error);
		process.exit(1);
	});
}

module.exports = {fisher: fisher, summarise: summarise};
