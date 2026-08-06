/* eslint-env node, es6 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ai = require('../ai');
const goldenEval = require('./ui/golden_eval');
const toSnapshot = goldenEval.toSnapshot;
const compareSnapshots = goldenEval.compareSnapshots;
const formatDiffs = goldenEval.formatDiffs;

const uiDir = path.join(__dirname, 'ui');
const manifestPath = path.join(uiDir, 'manifest.json');

function readJson(filePath) {
	return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('UI fixture manifest lists 8–12 Gen 8 Singles/Doubles scenarios', () => {
	const manifest = readJson(manifestPath);
	assert.equal(manifest.schemaVersion, 1);
	assert.ok(Array.isArray(manifest.scenarios));
	assert.ok(manifest.scenarios.length >= 8 && manifest.scenarios.length <= 12);
	const ids = new Set();
	let singles = 0;
	for (const scenario of manifest.scenarios) {
		assert.ok(scenario.id && typeof scenario.id === 'string');
		assert.ok(!ids.has(scenario.id), 'duplicate scenario id: ' + scenario.id);
		ids.add(scenario.id);
		assert.ok(scenario.label);
		assert.ok(scenario.file);
		assert.ok(fs.existsSync(path.join(uiDir, scenario.file)), scenario.file);
		const state = readJson(path.join(uiDir, scenario.file));
		assert.equal(state.generation, 8, scenario.id + ' should be Gen 8');
		assert.ok(
			state.mode === 'Singles' || state.mode === 'Doubles',
			scenario.id + ' mode must be Singles or Doubles'
		);
		if (state.mode === 'Singles') {
			singles += 1;
			assert.ok(
				(scenario.tags || []).includes('singles'),
				scenario.id + ' Singles fixture should tag singles'
			);
		} else {
			assert.ok(
				(scenario.tags || []).includes('doubles'),
				scenario.id + ' Doubles fixture should tag doubles'
			);
			assert.ok(
				state.sides.ai.activeIds.length === 2 &&
					state.sides.player.activeIds.length === 2,
				scenario.id + ' Doubles sample should expose two actives per side'
			);
		}
	}
	assert.ok(singles >= 8, 'keep at least 8 Singles scenarios');
});

test('every UI fixture validates via validateBattleState', () => {
	const manifest = readJson(manifestPath);
	for (const scenario of manifest.scenarios) {
		const state = readJson(path.join(uiDir, scenario.file));
		assert.doesNotThrow(() => ai.validateBattleState(state), scenario.id);
	}
});

test('sample golden evaluate snapshot matches current evaluate-actions', () => {
	const manifest = readJson(manifestPath);
	const scenario = manifest.scenarios.find(entry => entry.id === 'sample');
	assert.ok(scenario && scenario.golden, 'sample must declare a golden');
	const state = readJson(path.join(uiDir, scenario.file));
	const options = scenario.defaultOptions || {sideId: 'ai', includeSwitches: false};
	const sideId = options.sideId === 'player' ? 'player' : 'ai';
	const evaluations = ai.evaluateActions(state, ai.calculateActionFacts, sideId, {
		includeSwitches: !!options.includeSwitches,
	});
	const actual = toSnapshot(evaluations, {fixtureId: 'sample', options: options});
	const expected = readJson(path.join(uiDir, scenario.golden));
	const result = compareSnapshots(expected, actual);
	assert.ok(result.ok, result.summary + '\n' + formatDiffs(result.diffs));
});

test('zero-EV overlays are present on UI fixtures that declare natures', () => {
	const manifest = readJson(manifestPath);
	const zero = {hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0};
	for (const scenario of manifest.scenarios) {
		const state = readJson(path.join(uiDir, scenario.file));
		for (const sideId of ['ai', 'player']) {
			for (const mon of state.sides[sideId].party) {
				if (!mon.nature && !mon.evs) continue;
				assert.deepEqual(mon.evs, zero, scenario.id + ' / ' + mon.id + ' must use zero EVs');
			}
		}
	}
});
