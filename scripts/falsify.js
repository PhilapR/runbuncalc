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
 * Five outcomes, five exit codes, because a script that cannot tell them apart
 * will read the wrong one as success:
 *
 *   0  FALSIFIED  an assertion failed inside a named test. The guard tests
 *                 what you think.
 *   1  HOLLOW     a named test ran and passed with the source mutated. The
 *                 guard does not.
 *   2  BROKEN     the guard was never asked: the mutation stopped the test
 *                 file (or a module it needs) loading; or --name matched no
 *                 test, so nothing ran; or the file is not at HEAD; or the
 *                 mutation is in ai/src or calc/src, which do not play until
 *                 they are built (mutate ai/dist or calc/dist instead).
 *   3  DRIFTED    --from no longer matches, so nothing was mutated at all.
 *   4  FALSIFIED-BY-ERROR  a named test failed, but by an error raised inside
 *                 it (a TypeError, not an assertion). The guard did go red
 *                 under the mutation, so it is a falsification; it says so
 *                 separately because the red came from a crash, not from the
 *                 check the guard makes.
 *
 * BROKEN and DRIFTED are the ones that flatter you: both look like a result
 * and neither is one. pokemon-mono's `just falsify` made the same split.
 *
 * "--name matched no test" is its own trap: Node's runner prints "tests 1,
 * pass 1" when a pattern matches nothing (the file itself counts as the one
 * test), which read as HOLLOW. So the run is read as TAP, and a test whose
 * name matches the pattern must appear in it.
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
	// ai/src and calc/src are TypeScript that plays only once built into dist.
	// The worktree copies the main checkout's dist, so a mutated .ts never
	// runs and every guard reads HOLLOW.
	if (/^(ai|calc)\/src\/.*\.ts$/.test(file.replace(/^\.\//, ''))) {
		process.stdout.write('BROKEN, not falsified: ' + file + ' is TypeScript source, which does not play until it ' +
			'is built. Mutate the built file under ' + file.split('/')[0] + '/dist instead; the guard was never asked.\n');
		process.exitCode = 2;
		return;
	}
	const tree = path.join(ROOT, 'ui-playthrough-out', '.worktrees', 'falsify-' + process.pid);
	arms.makeWorktree(tree, 'HEAD');
	try {
		// A test that is not in the tree at HEAD — written, not yet committed —
		// runs nothing, passes, and read as HOLLOW (2026-09-22: a lint failure
		// stopped the commit and two guards were called hollow). It is BROKEN:
		// the guard was never asked.
		if (!fs.existsSync(path.join(tree, test))) {
			process.stdout.write('BROKEN, not falsified: ' + test + ' is not in the tree at HEAD — commit it first; ' +
				'the guard was never asked.\n');
			process.exitCode = 2;
			return;
		}
		const target = path.join(tree, file);
		const before = fs.readFileSync(target, 'utf8');
		const count = before.split(from).length - 1;
		if (count !== 1) {
			// DRIFTED: the text moved or was rewritten, so the mutation never
			// applied. It threw before, which exits 1 — the same code as HOLLOW,
			// so a script could not tell "your guard is hollow" from "your
			// pattern is stale" (pokemon-mono split the same three cases in
			// fb5ab8d and needed this fourth one; raised by that session).
			process.stdout.write('DRIFTED: --from matches ' + count + ' times in ' + file +
				', so nothing was mutated and the guard was never asked. It must match exactly once.\n');
			process.exitCode = 3;
			return;
		}
		fs.writeFileSync(target, before.replace(from, to));
		const args = ['--test', '--test-reporter=tap'].concat(name ? ['--test-name-pattern=' + name] : [], [test]);
		// Without the runner's marker: inside a test, a nested `node --test` skips its files.
		const env = Object.assign({}, process.env);
		delete env.NODE_TEST_CONTEXT;
		const run = childProcess.spawnSync(process.execPath, args, {cwd: tree, encoding: 'utf8', env});
		const verdict = classify((run.stdout || '') + (run.stderr || ''), test, name);
		process.stdout.write(verdict.text + '\n');
		process.exitCode = verdict.code;
	} finally {
		childProcess.spawnSync('git', ['worktree', 'remove', '--force', tree], {cwd: ROOT});
	}
}

/**
 * The results of a TAP run: [{name, ok, error, code, failureType, depth}].
 * An error's name, code and failure type come from the YAML block after its
 * `not ok` line.
 */
function tapResults(output) {
	const results = [];
	let open = null;
	for (const line of output.split('\n')) {
		const hit = line.match(/^(\s*)(not ok|ok) \d+ - (.*?)(?: # (?:SKIP|TODO).*)?$/);
		if (hit) {
			open = {name: hit[3], ok: hit[2] === 'ok', error: null, code: null, failureType: null,
				depth: hit[1].length, skipped: / # SKIP/.test(line)};
			results.push(open);
			continue;
		}
		if (!open || open.ok) continue;
		const field = line.match(/^\s*(name|code|failureType): '?([^']*)'?\s*$/);
		if (field && open[field[1] === 'name' ? 'error' : field[1]] === null) {
			open[field[1] === 'name' ? 'error' : field[1]] = field[2];
		}
		if (/^\s*\.\.\.\s*$/.test(line)) open = null;
	}
	return results;
}

/**
 * The verdict of one mutated run: {code, text}. `output` is the TAP of
 * `node --test --test-reporter=tap [--test-name-pattern=name] test`.
 */
function classify(output, test, name) {
	const results = tapResults(output);
	const files = new Set([test, path.basename(test), test.replace(/^\.\//, '')]);
	const fileLevel = results.filter(result => files.has(result.name));
	const tests = results.filter(result => !files.has(result.name) && !result.skipped);
	let pattern = null;
	if (name) {
		try {
			pattern = new RegExp(name);
		} catch (error) {
			pattern = {test: text => text.includes(name)};
		}
	}
	const named = pattern ? tests.filter(result => pattern.test(result.name)) : tests;
	const loadError = (output.match(/(SyntaxError|ReferenceError|TypeError|Error: Cannot find module)[^\n]*/) || [''])[0]
		.slice(0, 160);
	if (!named.length) {
		if (fileLevel.some(result => !result.ok)) {
			return {code: 2, text: 'BROKEN, not falsified: ' + test + ' did not load under the mutation, so no ' +
				'test ran and the guard was never asked.\n  ' + loadError};
		}
		return {code: 2, text: 'BROKEN, not falsified: the pattern ' + JSON.stringify(name) + ' matched no test in ' +
			test + ', so nothing ran and the guard was never asked (' + tests.length + ' test(s) ran).'};
	}
	// A parent fails when a child does; the child's error is the one that says why.
	const failed = tests.filter(result => !result.ok && result.failureType !== 'subtestsFailed');
	if (!failed.length) {
		return {code: 1, text: 'HOLLOW: the guard PASSED with the source mutated — it is not testing what you think.\n' +
			'  ran: ' + named.map(result => result.name).join('; ').slice(0, 200)};
	}
	const asserted = failed.filter(result => result.error === 'AssertionError' || result.code === 'ERR_ASSERTION');
	if (asserted.length) {
		return {code: 0, text: 'FALSIFIED: the guard failed under the mutation, as it must.\n  ' +
			asserted.map(result => result.name).join('; ').slice(0, 200)};
	}
	// A module that stops loading inside a test (a lazy require) is a load error, not a falsification.
	const loading = failed.filter(result => result.error === 'SyntaxError' || result.code === 'MODULE_NOT_FOUND');
	if (loading.length === failed.length) {
		return {code: 2, text: 'BROKEN, not falsified: the mutation stopped a module loading inside the test, so ' +
			'the guard was never asked.\n  ' + loadError};
	}
	return {code: 4, text: 'FALSIFIED-BY-ERROR: the guard went red under the mutation, but by an error raised ' +
		'inside the test, not an assertion.\n  ' + failed.map(result => result.name + ' (' + (result.error || result.code) +
		')').join('; ').slice(0, 200)};
}

if (require.main === module) main();

module.exports = {main, classify, tapResults};
