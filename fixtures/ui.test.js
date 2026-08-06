/* eslint-env node, es6 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ai = require('../ai');
const goldenEval = require('./ui/golden_eval');
const replayTrace = require('./ui/replay_trace');
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

test('every UI fixture evaluates, not just validates', () => {
	// Regression: only `sample` was ever evaluated, so `protect` sat in the
	// manifest with a non-dex species ("Aegislash") that validated fine and then
	// threw from inside the calculator on the first evaluate. Score every
	// scenario the batch CLI would (scripts/eval-fixtures.js).
	const manifest = readJson(manifestPath);
	for (const scenario of manifest.scenarios) {
		const state = readJson(path.join(uiDir, scenario.file));
		const options = scenario.defaultOptions || {sideId: 'ai', includeSwitches: false};
		const sideId = options.sideId === 'player' ? 'player' : 'ai';
		let evaluations;
		assert.doesNotThrow(() => {
			evaluations = ai.evaluateActions(state, ai.calculateActionFacts, sideId, {
				includeSwitches: !!options.includeSwitches,
			});
		}, scenario.id + ' must evaluate without throwing');
		assert.ok(
			Array.isArray(evaluations) && evaluations.length >= 1,
			scenario.id + ' should produce at least one scored action'
		);
	}
});

test('every declared golden matches current evaluate-actions', () => {
	// Every scenario declares a golden, so scoring drift shows up as a reviewable
	// diff rather than going unnoticed. Regenerate deliberately:
	//   node scripts/regen-ui-golden.js <fixtureId>
	const manifest = readJson(manifestPath);
	const withGolden = manifest.scenarios.filter(entry => entry.golden);
	assert.equal(
		withGolden.length,
		manifest.scenarios.length,
		'every scenario should declare a golden'
	);
	for (const scenario of withGolden) {
		const state = readJson(path.join(uiDir, scenario.file));
		const options = scenario.defaultOptions || {sideId: 'ai', includeSwitches: false};
		const sideId = options.sideId === 'player' ? 'player' : 'ai';
		const evaluations = ai.evaluateActions(state, ai.calculateActionFacts, sideId, {
			includeSwitches: !!options.includeSwitches,
		});
		const actual = toSnapshot(evaluations, {fixtureId: scenario.id, options: options});
		const expected = readJson(path.join(uiDir, scenario.golden));
		const result = compareSnapshots(expected, actual);
		assert.ok(
			result.ok,
			scenario.id + ': ' + result.summary + '\n' + formatDiffs(result.diffs)
		);
	}
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

test('sample apply-advance replay loads, scrubs, and validates without re-derive', () => {
	const replayPath = path.join(uiDir, 'replays', 'sample.json');
	assert.ok(fs.existsSync(replayPath), 'fixtures/ui/replays/sample.json');
	const raw = readJson(replayPath);
	const replay = replayTrace.validateReplayWithAi(raw, ai);
	assert.equal(replay.kind, 'apply-advance-trace');
	assert.equal(replayTrace.frameCount(replay), replay.steps.length + 1);
	const initial = replayTrace.getFrame(replay, 0);
	assert.equal(initial.state.turn, replay.initialState.turn);
	assert.ok(initial.evaluations.length >= 1, 'sample stores ranked actions on first apply');
	const afterApply = replayTrace.getFrame(replay, 1);
	assert.equal(afterApply.step.type, 'apply');
	assert.ok(afterApply.step.resolution, 'apply step must store resolution');
	assert.equal(afterApply.step.action.moveName, 'Thunderbolt');
	const afterAdvance = replayTrace.getFrame(replay, 2);
	assert.equal(afterAdvance.step.type, 'advance');
	assert.ok(afterAdvance.state.turn > replay.initialState.turn);

	assert.throws(
		() => replayTrace.parseReplay({schemaVersion: 1, kind: 'nope'}),
		/kind must be/
	);
	assert.throws(
		() => replayTrace.parseReplay({
			schemaVersion: 1,
			kind: 'apply-advance-trace',
			initialState: replay.initialState,
			steps: [{type: 'apply', action: {kind: 'move'}, stateAfter: replay.initialState}],
		}),
		/action must be a move or switch|resolution is required/
	);
});

test('replay recorder exports a scrubbable shareable trace', () => {
	const state = readJson(path.join(uiDir, 'sample.json'));
	const recorder = replayTrace.createRecorder(state);
	const action = {
		kind: 'move',
		actorId: 'ai-1',
		moveName: 'Protect',
		targetIds: ['ai-1'],
	};
	const resolution = ai.deriveMoveResolution(state, action, ai.calculateActionFacts, () => 0.99);
	const after = ai.applyAction(state, action, resolution);
	recorder.recordApply({action, resolution, stateAfter: after, evaluations: []});
	const advanced = ai.advanceTurn(after);
	recorder.recordAdvance(advanced);
	const exported = recorder.toReplay({id: 'unit', label: 'unit'});
	const validated = replayTrace.validateReplayWithAi(exported, ai);
	assert.equal(validated.steps.length, 2);
	assert.equal(replayTrace.getFrame(validated, 1).step.action.moveName, 'Protect');
});
