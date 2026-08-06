/* eslint-env node, es6 */
'use strict';

/**
 * Headless batch evaluate over the named UI fixtures (ADP-01).
 *
 * Evaluates every selected scenario through the same `evaluateActions`
 * boundary the AI Debug panel and HTTP adapter use, and compares against a
 * declared golden snapshot where one exists. This is the CLI half of the
 * external-adapter story: an outside caller can score many states without a
 * browser and get a reviewable pass/fail.
 *
 * Snapshots contain ranked action + score + machine facts/reasons only. As
 * everywhere else, nothing here parses `Result.desc()` / `kochance()` strings.
 *
 * Goldens are deliberately NOT written here — regeneration stays a separate,
 * explicit act via `scripts/regen-ui-golden.js <fixtureId>`.
 *
 * Usage:
 *   node scripts/eval-fixtures.js                    all scenarios
 *   node scripts/eval-fixtures.js sample pivot       only these ids
 *   node scripts/eval-fixtures.js --tag doubles      only scenarios with a tag
 *   node scripts/eval-fixtures.js --json             machine-readable report
 *   node scripts/eval-fixtures.js --list             list ids and exit
 *
 * Exit codes:
 *   0  every selected scenario evaluated and every declared golden matched
 *   1  a golden mismatched, or a scenario failed to validate / evaluate
 *   2  usage error (unknown id or tag, unknown flag)
 */

const fs = require('fs');
const path = require('path');
const ai = require('../ai');
const goldenEval = require('../fixtures/ui/golden_eval');

const root = path.resolve(__dirname, '..');
const uiDir = path.join(root, 'fixtures', 'ui');

function readJson(filePath) {
	return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function usage() {
	console.log(
		'Usage: node scripts/eval-fixtures.js [--tag <tag>] [--json] [--quiet] [--list] [fixtureId...]'
	);
}

function parseArgs(argv) {
	const opts = {ids: [], tags: [], json: false, quiet: false, list: false};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--json') opts.json = true;
		else if (arg === '--quiet') opts.quiet = true;
		else if (arg === '--list') opts.list = true;
		else if (arg === '-h' || arg === '--help') opts.help = true;
		else if (arg === '--tag') {
			const value = argv[++i];
			if (!value) {
				console.error('--tag requires a value');
				process.exit(2);
			}
			opts.tags.push(value);
		} else if (arg.startsWith('-')) {
			console.error('Unknown flag:', arg);
			usage();
			process.exit(2);
		} else opts.ids.push(arg);
	}
	return opts;
}

function selectScenarios(scenarios, opts) {
	let selected = scenarios;
	if (opts.ids.length) {
		const known = new Set(scenarios.map(entry => entry.id));
		const missing = opts.ids.filter(id => !known.has(id));
		if (missing.length) {
			console.error('Unknown fixture id(s):', missing.join(', '));
			console.error('Known:', [...known].join(', '));
			process.exit(2);
		}
		selected = selected.filter(entry => opts.ids.includes(entry.id));
	}
	if (opts.tags.length) {
		selected = selected.filter(entry =>
			opts.tags.every(tag => (entry.tags || []).includes(tag))
		);
		if (!selected.length) {
			console.error('No scenario carries tag(s):', opts.tags.join(', '));
			process.exit(2);
		}
	}
	return selected;
}

function describeAction(action) {
	if (!action) return '(none)';
	if (action.kind === 'switch') return 'switch -> ' + action.replacementId;
	const targets = (action.targetIds || []).join(',');
	return action.moveName + (targets ? ' -> ' + targets : '');
}

function evaluateScenario(scenario) {
	const result = {id: scenario.id, label: scenario.label, status: 'ok'};
	const options = scenario.defaultOptions || {sideId: 'ai', includeSwitches: false};
	result.options = options;

	let state;
	try {
		state = readJson(path.join(uiDir, scenario.file));
		ai.validateBattleState(state);
	} catch (error) {
		result.status = 'invalid';
		result.error = error && error.message ? error.message : String(error);
		return result;
	}

	let snapshot;
	try {
		const sideId = options.sideId === 'player' ? 'player' : 'ai';
		const evaluations = ai.evaluateActions(state, ai.calculateActionFacts, sideId, {
			includeSwitches: !!options.includeSwitches,
		});
		snapshot = goldenEval.toSnapshot(evaluations, {fixtureId: scenario.id, options: options});
	} catch (error) {
		result.status = 'error';
		result.error = error && error.message ? error.message : String(error);
		return result;
	}

	result.actionCount = snapshot.evaluations.length;
	const top = snapshot.evaluations[0];
	result.topAction = top ? describeAction(top.action) : '(none)';
	result.topScore = top ? top.score : null;

	if (!scenario.golden) {
		result.golden = 'none';
		return result;
	}

	const goldenPath = path.join(uiDir, scenario.golden);
	if (!fs.existsSync(goldenPath)) {
		result.status = 'error';
		result.golden = 'missing';
		result.error = 'declared golden not found: ' + scenario.golden;
		return result;
	}

	const comparison = goldenEval.compareSnapshots(readJson(goldenPath), snapshot);
	result.golden = comparison.ok ? 'match' : 'mismatch';
	result.goldenSummary = comparison.summary;
	if (!comparison.ok) {
		result.status = 'mismatch';
		result.diffs = comparison.diffs;
	}
	return result;
}

function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (opts.help) {
		usage();
		return 0;
	}

	const manifest = readJson(path.join(uiDir, 'manifest.json'));
	const scenarios = manifest.scenarios || [];

	if (opts.list) {
		for (const scenario of scenarios) {
			console.log(
				scenario.id.padEnd(16),
				(scenario.golden ? '[golden]' : '[      ]'),
				scenario.label
			);
		}
		return 0;
	}

	const selected = selectScenarios(scenarios, opts);
	const results = selected.map(evaluateScenario);
	const failures = results.filter(entry => entry.status !== 'ok');
	const compared = results.filter(entry => entry.golden === 'match' || entry.golden === 'mismatch');

	if (opts.json) {
		console.log(JSON.stringify({
			schemaVersion: 1,
			kind: 'evaluate-fixtures-report',
			total: results.length,
			compared: compared.length,
			failed: failures.length,
			results: results,
		}, null, 2));
		return failures.length ? 1 : 0;
	}

	for (const entry of results) {
		if (opts.quiet && entry.status === 'ok') continue;
		if (entry.status === 'invalid' || entry.status === 'error') {
			console.log('FAIL  ' + entry.id + ' — ' + entry.error);
			continue;
		}
		const goldenNote = entry.golden === 'match' ? 'golden ok'
			: entry.golden === 'mismatch' ? 'GOLDEN MISMATCH'
				: 'no golden';
		console.log(
			(entry.status === 'ok' ? 'ok    ' : 'FAIL  ') + entry.id.padEnd(16) +
			String(entry.actionCount).padStart(3) + ' actions  ' +
			'top: ' + entry.topAction + ' (' + entry.topScore + ')  [' + goldenNote + ']'
		);
		if (entry.status === 'mismatch') {
			console.log(goldenEval.formatDiffs(entry.diffs));
			console.log('  regenerate deliberately: node scripts/regen-ui-golden.js ' + entry.id);
		}
	}

	console.log(
		'\n' + results.length + ' scenario(s), ' + compared.length + ' compared against goldens, ' +
		failures.length + ' failed.'
	);
	return failures.length ? 1 : 0;
}

process.exit(main());
