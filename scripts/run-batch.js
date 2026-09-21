#!/usr/bin/env node
/* eslint-env node, es6 */
'use strict';

/**
 * Several headless runs at once, from one pinned clean worktree.
 *
 *   node scripts/run-batch.js --label=base4 --seeds=104770,209499,314228 \
 *     --spec=boss-retries=40,retries=24,double-retries=40,scale-ivs=1,search-after=2,search-rollouts=8,repick-after=3,stop-at=343
 *   node scripts/run-batch.js --label=carry --seeds=104770 --resume-from=ui-playthrough-out/runs/base4
 *
 * Runs land in ui-playthrough-out/runs/LABEL/ (gitignored, and NOT the
 * session scratchpad, which is where the only document at Archie nearly went
 * missing). Each is played by scripts/run-one.js from a detached worktree at
 * --rev, so its provenance names a clean revision whatever is being edited in
 * the checkout meanwhile. The worktree is removed afterwards — one per sweep,
 * never cleaned, is how the disk filled and Playwright failed with ENOSPC.
 *
 * It prints each run's reach, its audit verdict, and the attempts each boss
 * took. It judges nothing: a batch is a reading, and the bar it is read
 * against is declared before it is launched, not here.
 */

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const arms = require('./battery-arms.js');

const ROOT = path.join(__dirname, '..');

function own(name, fallback, argv) {
	const hit = (argv || process.argv).find(arg => arg.startsWith('--' + name + '='));
	return hit === undefined ? fallback : hit.slice(name.length + 3);
}

/** What a batch will do, from its arguments — separate so it can be gated without playing. */
function plan(argv) {
	const label = own('label', '', argv);
	const seeds = own('seeds', '', argv).split(',').map(value => value.trim()).filter(Boolean).map(Number);
	if (!/^[A-Za-z0-9_.-]+$/.test(label)) throw new Error('--label=NAME is required (letters, digits, . _ -)');
	if (!seeds.length || seeds.some(seed => !Number.isInteger(seed))) throw new Error('--seeds=a,b,c must be integers');
	const resumeFrom = own('resume-from', '', argv);
	return {label, seeds, rev: own('rev', 'HEAD', argv), spec: own('spec', '', argv),
		starter: own('starter', 'Chimchar', argv), rival: own('rival', 'Blaziken', argv),
		parallel: Math.max(1, Number(own('parallel', String(Math.max(1, os.cpus().length - 2)), argv))),
		keep: own('keep-worktree', '0', argv) === '1',
		out: path.join(ROOT, 'ui-playthrough-out', 'runs', label),
		resume: seed => resumeFrom ? path.join(path.resolve(resumeFrom), 'run-' + seed + '.json') : ''};
}

function summarise(out, seeds) {
	const auditRun = require('./audit-run.js').auditRun;
	const lines = [];
	for (const seed of seeds) {
		const file = path.join(out, 'run-' + seed + '.json');
		if (!fs.existsSync(file)) { lines.push(seed + ': no record (see run-' + seed + '.log)'); continue; }
		const row = JSON.parse(fs.readFileSync(file, 'utf8'));
		let verdict;
		try {
			const failed = auditRun(row).checks.filter(check => check.status === 'FAIL').map(check => check.name);
			verdict = failed.length ? 'AUDIT FAILS: ' + failed.join(', ') : 'audit valid';
		} catch (error) { verdict = 'audit error: ' + String(error.message).slice(0, 60); }
		const walls = {};
		for (const fight of row.ledger) {
			if (!/Leader|Elite|Champion|Admin|Maxie|Archie|Rival/.test(fight.trainer)) continue;
			walls[fight.trainer] = walls[fight.trainer] || {tries: 0, won: false};
			walls[fight.trainer].tries += 1;
			if (fight.result === 'win') walls[fight.trainer].won = true;
		}
		const hard = Object.entries(walls).filter(entry => entry[1].tries >= 5)
			.map(entry => entry[0].replace(/^(Leader|Trainer) /, '') + ' ' + (entry[1].won ? '1/' : '0/') + entry[1].tries);
		lines.push(`${seed}: position ${row.position}, ${row.fights} fights, ${Math.round(row.seconds / 60)} min, ` +
			`${row.finished ? 'FINISHED' : 'stopped: ' + (String(row.stopped || '').split(':')[0] || 'budget spent')} — ${verdict}` +
			(hard.length ? '\n    ' + hard.join(', ') : ''));
	}
	return lines;
}

function main() {
	const todo = plan(process.argv);
	fs.mkdirSync(todo.out, {recursive: true});
	const short = childProcess.spawnSync('git', ['rev-parse', '--short', todo.rev], {cwd: ROOT, encoding: 'utf8'}).stdout.trim();
	const tree = path.join(ROOT, 'ui-playthrough-out', '.worktrees', 'run-' + short + '-' + todo.label);
	arms.makeWorktree(tree, todo.rev);
	process.stdout.write(`${todo.seeds.length} run(s) at ${short}, ${todo.parallel} at a time, into ${path.relative(ROOT, todo.out)}\n`);
	const queue = todo.seeds.slice();
	let live = 0;
	const next = () => {
		while (live < todo.parallel && queue.length) {
			const seed = queue.shift();
			const args = [path.join(tree, 'scripts', 'run-one.js'), '--seed=' + seed, '--out=' + todo.out,
				'--starter=' + todo.starter, '--rival=' + todo.rival, '--spec=' + todo.spec]
				.concat(todo.resume(seed) ? ['--resume=' + todo.resume(seed)] : []);
			live += 1;
			const child = childProcess.spawn('nice', ['-n', '10', process.execPath].concat(args), {cwd: tree, stdio: 'ignore'});
			child.on('exit', code => {
				live -= 1;
				process.stdout.write(`seed ${seed} exited ${code}\n`);
				if (queue.length) next();
				else if (live === 0) finish();
			});
		}
	};
	const finish = () => {
		if (!todo.keep) childProcess.spawnSync('git', ['worktree', 'remove', '--force', tree], {cwd: ROOT});
		for (const line of summarise(todo.out, todo.seeds)) process.stdout.write(line + '\n');
	};
	next();
}

if (require.main === module) main();

module.exports = {plan, summarise};
