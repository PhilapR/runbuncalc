#!/usr/bin/env node
/* eslint-env node, es6 */
'use strict';

/**
 * The test files a working loop can afford to run on every change.
 *
 * `npm test` is about six minutes, and almost all of it is a handful of files
 * that play whole RUNS or drive a browser. Those gates earn their cost — each
 * catches a defect that only appears in a run, and a fixture-level version of
 * several passed with the fix removed — but paying it per commit is what made
 * the loop unusable (operator, 2026-09-20).
 *
 * So: `npm run test:fast` while iterating, `npm test` once per batch and
 * before reporting. This file is the only place the split is written down;
 * the costs come from the suite's own durations (docs/PERFORMANCE.md).
 */

const fs = require('node:fs');
const path = require('node:path');

/** Files whose slowest test is measured in minutes, with that cost. */
const SLOW = {
	'browser_run.test.js': 'Playwright, ~109s',
	'browser_run_fight.test.js': 'Playwright',
	'browser_run_panel.test.js': 'Playwright',
	'browser_run_setup.test.js': 'Playwright',
	'browser_entrypoint.test.js': 'Playwright',
	'browser_planner.test.js': 'Playwright',
	'browser_calc_load.test.js': 'Playwright',
	'audit_run.test.js': 'plays runs: ledger 179s, crash 117s',
	'headless_run.test.js': 'plays a 40-fight run: 176s',
	'doubles.test.js': 'battery doubles: 103s',
	'battery_receipts.test.js': 'repick 97s, arms 88s',
	'search_policy.test.js': 'playbook rollouts: 87s',
	'pivot_turn.test.js': 'full runs: 86s',
	'run_control.test.js': 'plays real runs in child processes',
	'item_planning.test.js': 'plays the planner at Champion Wallace: ~150s',
};

function fastFiles(root) {
	const dir = path.join(root || path.join(__dirname, '..'), 'tests');
	return fs.readdirSync(dir)
		.filter(name => name.endsWith('.test.js'))
		.filter(name => !SLOW[name])
		.map(name => path.join('tests', name))
		.sort();
}

if (require.main === module) process.stdout.write(fastFiles().join(' ') + '\n');

module.exports = {fastFiles, SLOW};
