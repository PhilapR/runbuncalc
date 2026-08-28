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
const runtime = require('../lib/run.js');
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
	// node_modules is SYMLINKED: 512MB across three directories, identical
	// between the trees, and dependencies do not change inside a batch.
	for (const rel of ['node_modules', 'calc/node_modules', 'ai/node_modules']) {
		const target = path.join(ROOT, rel);
		if (!fs.existsSync(target)) continue;
		const link = path.join(dir, rel);
		fs.mkdirSync(path.dirname(link), {recursive: true});
		if (!fs.existsSync(link)) fs.symlinkSync(target, link, 'dir');
	}
	// The build outputs are COPIED, not linked, and the difference is the whole
	// point of isolating. ai/dist and calc/dist are gitignored, so the worktree
	// has their source and not their build — and a symlink would put the main
	// tree's build back in the path, so a rebuild landing mid-batch would leak
	// straight through. That is the exact failure this exists to prevent: the
	// commit that invalidated the last comparison was a bundle rebuild. 6.8MB
	// between them, 165ms to copy, once per batch.
	for (const rel of ['ai/dist', 'calc/dist']) {
		const from = path.join(ROOT, rel);
		if (!fs.existsSync(from)) continue;
		fs.cpSync(from, path.join(dir, rel), {recursive: true});
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

/**
 * The harness's own argv, held to the discipline it imposes on the driver.
 *
 * The docblock promised "everything after `--` is passed to both arms" and
 * nothing implemented it: a `--pin-box` experiment ran six pinned-box runs
 * with no pin, the treatment was inert, and the batch still printed VALID —
 * the exact class of bug this harness exists to refuse ("the control
 * silently ran the treatment with a term switched off"), committed by the
 * harness itself. So the promise is implemented, and an own-flag nothing
 * reads is now a refusal, because the driver-side unread audit cannot see an
 * argument that was dropped before the driver was spawned.
 */
function parseAbArgv(argv) {
	const dash = argv.indexOf('--');
	return {
		own: dash === -1 ? argv.slice(2) : argv.slice(2, dash),
		passthrough: dash === -1 ? [] : argv.slice(dash + 1),
	};
}
const ARGV = parseAbArgv(process.argv);
const READ_FLAGS = new Set();
function flag(name, fallback) {
	READ_FLAGS.add(name);
	const hit = ARGV.own.find(arg => arg.startsWith('--' + name + '='));
	return hit === undefined ? fallback : hit.slice(name.length + 3);
}
function unreadOwnFlags() {
	return ARGV.own.filter(arg => {
		const hit = /^--([^=]+)=/.exec(arg);
		return !hit || !READ_FLAGS.has(hit[1]);
	});
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
/**
 * Reach as the number a player would say: trainers beaten, not Pokemon.
 *
 * `position` is order-scale (cumulative enemy Pokemon) and stays on the row
 * as the durable machine truth; this converts at the presentation edge, the
 * same as every other surface. The scraped journal numbers already ARE
 * trainer numbers, so the crash fallback passes through unconverted.
 */
function reachOf(run, position, scraped) {
	if (Number.isFinite(position)) {
		if (position <= 0) return 0;
		return runtime.trainerIndexOf(run, position) || 0;
	}
	return scraped.length ? Math.max.apply(null, scraped) : 0;
}

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
	let report = null;
	let forecast = {live: 0, dead: 0, ability: 0, trainer: 0};
	try {
		report = JSON.parse(fs.readFileSync(path.join(out, spec.reportName), 'utf8'));
		provenance = report.provenance;
		// The forecast rate is the product metric this work has been moving —
		// 2.9% of planned fights at the start of the day, 19.8% after three
		// fixes — and it was tracked in commit messages and nowhere a chart
		// could reach. It belongs on the run that produced it.
		for (const fight of report.detail || []) {
			const actions = (fight.plan && fight.plan.actions) || null;
			if (!actions) continue;
			const dead = actions.find(row => /seed check unavailable|NO SURVIVAL CHECK/.test(row));
			if (!dead) {
				forecast.live += 1;
				continue;
			}
			forecast.dead += 1;
			if (/No unique canonical/.test(dead)) forecast.trainer += 1;
			else if (/Ability/.test(dead)) forecast.ability += 1;
		}
	} catch (error) {
		provenance = null;
	}
	// The run DOCUMENT is the reach, not the journal. The old line scraped
	// every (#N) out of the driver's stdout, which was a scraper on a display
	// format: the day the surfaces switched from Pokemon orders to trainer
	// numbers, every batch summary silently changed scale. run.position is
	// the durable order-scale truth in the same report; reachOf converts it
	// to the trainer number every summary now speaks, and the scrape
	// survives only as the fallback for a crashed run that never wrote one.
	const position = report && report.run && Number.isFinite(report.run.position) ?
		report.run.position : null;
	return {
		arm: spec.arm, index: spec.index, starter: spec.starter,
		order: position,
		fight: reachOf(report && report.run, position, orders),
		gavi: attempts('Camper Gavi'),
		brawly: attempts('Leader Brawly'),
		roxanne: attempts('Leader Roxanne'),
		crashed: /TimeoutError|ERR_|Cannot read propert/.test(text),
		forecast: forecast,
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
		meanFight: mine.length ? sum(r => r.fight) / mine.length : 0,
		passedGavi: mine.filter(r => r.gavi.won > 0).length,
		beatBrawly: mine.filter(r => r.brawly.won > 0).length,
		gaviWon: sum(r => r.gavi.won), gaviAttempts: sum(r => r.gavi.attempts),
		brawlyWon: sum(r => r.brawly.won), brawlyAttempts: sum(r => r.brawly.attempts),
		crashed: mine.filter(r => r.crashed).length,
		forecastLive: sum(r => (r.forecast || {}).live || 0),
		forecastDead: sum(r => (r.forecast || {}).dead || 0),
		forecastAbility: sum(r => (r.forecast || {}).ability || 0),
		forecastTrainer: sum(r => (r.forecast || {}).trainer || 0),
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
	// MEASUREMENT mode: one arm, no comparison. The most useful numbers this
	// work produced were not A/Bs — the forecast rate went 2.9% to 19.8% across
	// four fixes, each step a single batch on one revision — and none of them
	// could be tracked, because the only path in took two arms. A measurement
	// reuses everything that makes a comparison trustworthy: the pinned
	// worktree, the provenance checks, the unread-flag audit.
	const measure = Number(flag('measure', '0'));
	const armA = flag('a', '').split(' ').filter(Boolean);
	const armB = flag('b', '').split(' ').filter(Boolean);
	// --tms=advisor, NOT assume. The driver already defaults to advisor and this
	// line overrode it to assume, so every comparison run through this harness
	// taught moves the run could not have sourced yet — and the outputs were
	// then reported as findings about the game.
	//
	// It is not a small effect. Boss rush against Brawly, twelve pairs,
	// isolated: with assume, 11 of 12 runs beat him and 11 of 89 attempts won.
	// With advisor, ZERO of 12 runs and zero of 240 attempts. p = 0.000005. The
	// difference between "Brawly is a coin flip at 6%" and "Brawly was never
	// beaten" was entirely this flag.
	//
	// assume is still reachable by passing --shared explicitly. It answers a
	// different question — what a party COULD do with a full TM shelf — and
	// nothing it produces is a claim about a real run.
	const shared = (flag('shared',
		'--rules=encounters --box=22 --party=matrix --tms=advisor ' +
		'--fights=90 --budget=480 --plan=1')).split(' ').filter(Boolean)
		.concat(ARGV.passthrough);
	const unrecognised = unreadOwnFlags();
	if (unrecognised.length) {
		console.error('ab: unrecognised argument(s) ' + unrecognised.join(' ') +
			' — driver flags go after `--`, e.g. `-- --pin-box=...`');
		process.exit(1);
	}

	const startRevision = git(['rev-parse', 'HEAD']);
	const startDirty = git(['status', '--porcelain']) !== '';
	const isolate = flag('isolate', '1') !== '0';
	// Refusing a dirty tree is right when the batch runs IN that tree, and
	// wrong when it does not. An isolated batch works from a worktree pinned to
	// a committed revision, so uncommitted changes cannot reach it — the
	// comparison can name its code exactly. Refusing anyway cost a valid run:
	// a commit landed between two batches in one script and the second died on
	// a tree that had been dirty for a moment and had nothing to do with it.
	//
	// It still warns, because the uncommitted work is silently NOT under test,
	// and someone who just edited the driver should hear that rather than
	// discover it in the result.
	if (startDirty && !isolate) {
		console.error('REFUSING: the tree is dirty. A tally cannot name the code that produced it.');
		process.exit(1);
	}
	if (startDirty) {
		console.log('  NOTE: the tree is dirty and the worktree is pinned to ' +
			String(startRevision).slice(0, 10) + ' — uncommitted changes are NOT under test');
	}
	console.log('revision ' + String(startRevision).slice(0, 10) + ' · ' +
		(measure ? measure + ' runs (measurement)' : pairs + ' pairs') +
		' · ' + parallel + ' at a time');
	if (measure) {
		console.log('  flags: ' + (armA.join(' ') || '(defaults)'));
	} else {
		console.log('  A (control):   ' + (armA.join(' ') || '(defaults)'));
		console.log('  B (treatment): ' + (armB.join(' ') || '(defaults)'));
	}

	const queue = [];
	const rounds = measure || pairs;
	const sides = measure ? [{arm: 'M', extra: armA}] :
		[{arm: 'A', extra: armA}, {arm: 'B', extra: armB}];
	for (let i = 1; i <= rounds; i++) {
		const starter = STARTERS[(i - 1) % STARTERS.length];
		for (const side of sides) {
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
			const row = await runOnce(spec, home);
			rows.push(row);
			console.log('  ' + row.arm + ' ' + row.index + ' (' + row.starter + '): fight=' +
				row.fight + ' gavi=' + row.gavi.won + '/' + row.gavi.attempts +
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

	if (measure) {
		const m = summarise(rows, 'M');
		const planned = m.forecastLive + m.forecastDead;
		console.log('\n=== ' + label + ' (measurement) ===');
		console.log('runs=' + m.runs + '  meanFight=' + m.meanFight.toFixed(1) +
			'  passedGavi=' + m.passedGavi + '/' + m.runs +
			'  beatBrawly=' + m.beatBrawly + '/' + m.runs +
			(m.crashed ? '  crashed=' + m.crashed : ''));
		if (planned) {
			console.log('forecast: ' + m.forecastLive + '/' + planned + ' planned fights = ' +
				(100 * m.forecastLive / planned).toFixed(1) + '%' +
				'  (dead: ' + m.forecastAbility + ' ability, ' + m.forecastTrainer + ' trainer)');
		}
		const out = {
			label: label, kind: 'measurement', revision: startRevision,
			runs: measure, parallel: parallel, flags: armA, shared: shared,
			rows: rows, summary: m, problems: problems,
		};
		fs.writeFileSync(path.join(OUT, label + '-measure.json'), JSON.stringify(out, null, '\t'));
		if (problems.length) {
			console.error('\nINVALID — this measurement must not be reported:');
			problems.forEach(problem => console.error('  - ' + problem));
			process.exit(1);
		}
		console.log('\nvalid: one revision, no unread flags.');
		return;
	}

	const a = summarise(rows, 'A');
	const b = summarise(rows, 'B');
	console.log('\n=== ' + label + ' ===');
	for (const s of [a, b]) {
		console.log(s.arm.padEnd(2) + ' runs=' + String(s.runs).padEnd(4) +
			'meanFight=' + s.meanFight.toFixed(1).padEnd(8) +
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

module.exports = {fisher: fisher, summarise: summarise, parseAbArgv: parseAbArgv, reachOf: reachOf};
