#!/usr/bin/env node
/* eslint-env node, es6 */
'use strict';

/**
 * Make a guard fail, in a worktree of its own.
 *
 *   node scripts/falsify.js --file=lib/run.js --test=tests/run.test.js \
 *     --name="the Elite Four is four members" \
 *     --from="return named[2] ? state.doublesSpent : state.singlesSpent;" \
 *     --to="return false;"
 *
 * A gate nobody has watched fail is not a gate. The way to know is to break
 * what it guards and see it go red — which means editing a source file,
 * running the test, and putting the file back byte for byte.
 *
 * Doing that IN THE WORKING TREE is a hazard, and not a theoretical one: the
 * rab-workspace companion loads this repository from the checked-out tree and
 * spawns planner and advice children on demand, so a child spawned inside one
 * of those windows silently plays deliberately broken code — a race that never
 * wins, a plan that never holds — and its receipt names a revision that looks
 * clean, because the mutation is never committed. Twelve such windows were
 * opened in one session before anyone noticed (operator's peer, 2026-09-22).
 *
 * So the mutation happens in a detached worktree at HEAD and the live tree is
 * never touched. The worktree is removed afterwards, whatever the outcome.
 *
 * Exit code 0 means the guard FAILED under the mutation, which is the result
 * you want. Exit 1 means it passed and the gate is hollow.
 */

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const arms = require('./battery-arms.js');

const ROOT = path.join(__dirname, '..');

function own(name, fallback) {
	const hit = process.argv.find(arg => arg.startsWith('--' + name + '='));
	return hit === undefined ? fallback : hit.slice(name.length + 3);
}

function main() {
	const file = own('file', '');
	const test = own('test', '');
	const from = own('from', '');
	const to = own('to', '');
	const name = own('name', '');
	if (!file || !test || !from) {
		process.stderr.write('usage: node scripts/falsify.js --file=SRC --test=TEST --from=TEXT [--to=TEXT] [--name=PATTERN]\n' +
			'  --from is the exact text to replace; --to defaults to removing it.\n');
		process.exit(2);
	}
	const tree = path.join(ROOT, 'ui-playthrough-out', '.worktrees', 'falsify-' + process.pid);
	arms.makeWorktree(tree, 'HEAD');
	try {
		const target = path.join(tree, file);
		const before = fs.readFileSync(target, 'utf8');
		const count = before.split(from).length - 1;
		if (count !== 1) {
			throw new Error(`--from matches ${count} times in ${file}; it must match exactly once`);
		}
		fs.writeFileSync(target, before.replace(from, to));
		const args = ['--test'].concat(name ? ['--test-name-pattern=' + name] : [], [test]);
		const run = childProcess.spawnSync(process.execPath, args, {cwd: tree, encoding: 'utf8'});
		const output = (run.stdout || '') + (run.stderr || '');
		const failed = /^# fail [1-9]/m.test(output) || /^ℹ fail [1-9]/m.test(output);
		const said = (output.match(/AssertionError[^\n]*/) || [''])[0].slice(0, 160);
		// A mutation that BREAKS the file fails every test and proves nothing —
		// the first cut of this tool called `--to=x` a falsification, which is
		// worse than no tool. A falsification is an ASSERTION that failed.
		const broke = /SyntaxError|ReferenceError|Cannot find module|TypeError: [^\n]*is not a function/.test(output);
		if (broke || (failed && !said)) {
			process.stdout.write('BROKEN, not falsified: the mutation stopped ' + file + ' from loading or running, ' +
				'so every test failed and the guard was never asked.\n  ' +
				(output.match(/(SyntaxError|ReferenceError|TypeError|Cannot find module)[^\n]*/) || [''])[0].slice(0, 160) + '\n');
			process.exitCode = 2;
			return;
		}
		process.stdout.write(failed ?
			'FALSIFIED: the guard failed under the mutation, as it must.\n' + (said ? '  ' + said + '\n' : '') :
			'HOLLOW: the guard PASSED with ' + file + ' mutated — it is not testing what you think.\n');
		process.exitCode = failed ? 0 : 1;
	} finally {
		childProcess.spawnSync('git', ['worktree', 'remove', '--force', tree], {cwd: ROOT});
	}
}

if (require.main === module) main();

module.exports = {main};
