/* eslint-env browser, node, es6 */
/* global window */
/**
 * Golden evaluate-actions snapshot helpers (FIX-03 / FIX-04).
 * Snapshots ranked action + score + machine facts/reasons only — never calc desc / kochance.
 * Dual load: browser global `RunBunGoldenEval` and CommonJS `module.exports`.
 */
(function (root, factory) {
	var api = factory();
	if (typeof module === 'object' && module.exports) {
		module.exports = api;
	}
	if (root) {
		root.RunBunGoldenEval = api;
	}
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this), function () {
	'use strict';

	var SCHEMA_VERSION = 1;
	var KIND = 'evaluate-actions';

	var FACT_KEYS = [
		'moveCategory',
		'moveType',
		'priority',
		'attackerSpeed',
		'defenderSpeed',
		'attackerSpecies',
		'defenderSpecies',
		'attackerStatus',
		'defenderStatus',
		'isImmune',
		'isSuperEffective',
		'isHighCrit',
		'isMultiHit',
		'opponentCanKO',
		'opponentCan2HKO',
		'opponentMaxDamage',
		'defenderIncapacitated',
		'isFirstTurnOut',
	];

	function actionKey(action) {
		if (!action) return '';
		if (action.kind === 'switch') {
			return ['switch', action.actorId, action.replacementId, action.forced ? 'forced' : '',
				action.batonPass ? 'baton' : '', action.preserveSubstitute ? 'sub' : ''].join('|');
		}
		if (action.kind === 'move') {
			var targets = Array.isArray(action.targetIds) ? action.targetIds.slice().sort().join(',') : '';
			return ['move', action.actorId, action.moveName, targets].join('|');
		}
		return JSON.stringify(action);
	}

	function bestScore(evaluation) {
		var outcomes = evaluation && Array.isArray(evaluation.outcomes) ? evaluation.outcomes : [];
		var best = -Infinity;
		for (var i = 0; i < outcomes.length; i++) {
			var score = outcomes[i] && typeof outcomes[i].score === 'number' ? outcomes[i].score : null;
			if (score !== null && score > best) best = score;
		}
		return best;
	}

	function slimDamage(damage) {
		if (!damage || typeof damage !== 'object') return undefined;
		var out = {
			min: damage.min,
			max: damage.max,
			targetHp: damage.targetHp,
			possibleKO: !!damage.possibleKO,
			guaranteedKO: !!damage.guaranteedKO,
		};
		if (damage.hits !== undefined) out.hits = damage.hits;
		return out;
	}

	function slimFacts(facts) {
		var out = {};
		var source = facts || {};
		for (var i = 0; i < FACT_KEYS.length; i++) {
			var key = FACT_KEYS[i];
			if (source[key] !== undefined) out[key] = source[key];
		}
		if (source.damage) out.damage = slimDamage(source.damage);
		return out;
	}

	function slimOutcomes(outcomes) {
		if (!Array.isArray(outcomes)) return [];
		return outcomes.map(function (outcome) {
			return {
				score: outcome.score,
				probability: outcome.probability,
			};
		});
	}

	function slimAction(action) {
		if (!action) return action;
		if (action.kind === 'switch') {
			var next = {
				kind: 'switch',
				actorId: action.actorId,
				replacementId: action.replacementId,
			};
			if (action.forced) next.forced = true;
			if (action.batonPass) next.batonPass = true;
			if (action.preserveSubstitute) next.preserveSubstitute = true;
			return next;
		}
		return {
			kind: 'move',
			actorId: action.actorId,
			moveName: action.moveName,
			targetIds: Array.isArray(action.targetIds) ? action.targetIds.slice() : [],
		};
	}

	function toSnapshot(evaluations, meta) {
		var ranked = (Array.isArray(evaluations) ? evaluations : []).slice().sort(function (left, right) {
			var scoreDiff = bestScore(right) - bestScore(left);
			if (scoreDiff !== 0) return scoreDiff;
			return actionKey(left.action).localeCompare(actionKey(right.action));
		});
		return {
			schemaVersion: SCHEMA_VERSION,
			kind: KIND,
			fixtureId: meta && meta.fixtureId ? meta.fixtureId : undefined,
			options: meta && meta.options ? meta.options : {sideId: 'ai', includeSwitches: false},
			evaluations: ranked.map(function (evaluation) {
				return {
					action: slimAction(evaluation.action),
					score: bestScore(evaluation),
					outcomes: slimOutcomes(evaluation.outcomes),
					reasons: Array.isArray(evaluation.reasons) ? evaluation.reasons.slice() : [],
					facts: slimFacts(evaluation.facts),
				};
			}),
		};
	}

	function deepDiff(expected, actual, prefix, diffs) {
		if (expected === actual) return;
		var expType = expected === null ? 'null' : typeof expected;
		var actType = actual === null ? 'null' : typeof actual;
		if (expType !== actType || Array.isArray(expected) !== Array.isArray(actual)) {
			diffs.push({
				path: prefix || '(root)',
				expected: expected,
				actual: actual,
				message: 'type/value mismatch',
			});
			return;
		}
		if (typeof expected !== 'object' || expected === null) {
			diffs.push({
				path: prefix || '(root)',
				expected: expected,
				actual: actual,
				message: 'value mismatch',
			});
			return;
		}
		if (Array.isArray(expected)) {
			if (expected.length !== actual.length) {
				diffs.push({
					path: prefix,
					expected: expected.length,
					actual: actual.length,
					message: 'array length mismatch',
				});
			}
			var len = Math.max(expected.length, actual.length);
			for (var i = 0; i < len; i++) {
				deepDiff(expected[i], actual[i], prefix + '[' + i + ']', diffs);
			}
			return;
		}
		var keys = {};
		Object.keys(expected).forEach(function (key) { keys[key] = true; });
		Object.keys(actual).forEach(function (key) { keys[key] = true; });
		Object.keys(keys).sort().forEach(function (key) {
			var child = prefix ? prefix + '.' + key : key;
			if (!(key in expected)) {
				diffs.push({
					path: child,
					expected: undefined,
					actual: actual[key],
					message: 'unexpected key',
				});
				return;
			}
			if (!(key in actual)) {
				diffs.push({
					path: child,
					expected: expected[key],
					actual: undefined,
					message: 'missing key',
				});
				return;
			}
			deepDiff(expected[key], actual[key], child, diffs);
		});
	}

	function compareSnapshots(expected, actual) {
		var diffs = [];
		if (!expected || !actual) {
			return {
				ok: false,
				diffs: [{path: '(root)', expected: expected, actual: actual, message: 'missing snapshot'}],
				summary: 'Missing expected or actual golden snapshot.',
			};
		}
		if (expected.schemaVersion !== actual.schemaVersion) {
			diffs.push({
				path: 'schemaVersion',
				expected: expected.schemaVersion,
				actual: actual.schemaVersion,
				message: 'schema version mismatch',
			});
		}
		if (expected.kind !== actual.kind) {
			diffs.push({
				path: 'kind',
				expected: expected.kind,
				actual: actual.kind,
				message: 'kind mismatch',
			});
		}
		deepDiff(expected.evaluations || [], actual.evaluations || [], 'evaluations', diffs);
		var ok = diffs.length === 0;
		var summary;
		if (ok) {
			summary = 'Golden match (' + ((expected.evaluations || []).length) + ' action(s)).';
		} else {
			var first = diffs[0];
			summary = 'Golden mismatch (' + diffs.length + '): ' + first.path + ' — ' + first.message +
				' (expected ' + JSON.stringify(first.expected) + ', actual ' + JSON.stringify(first.actual) + ')';
		}
		return {ok: ok, diffs: diffs, summary: summary};
	}

	function formatDiffs(diffs, limit) {
		var max = typeof limit === 'number' ? limit : 8;
		return (diffs || []).slice(0, max).map(function (diff) {
			return diff.path + ': ' + diff.message +
				'\n  expected: ' + JSON.stringify(diff.expected) +
				'\n  actual:   ' + JSON.stringify(diff.actual);
		}).join('\n');
	}

	return {
		SCHEMA_VERSION: SCHEMA_VERSION,
		KIND: KIND,
		FACT_KEYS: FACT_KEYS,
		actionKey: actionKey,
		bestScore: bestScore,
		toSnapshot: toSnapshot,
		compareSnapshots: compareSnapshots,
		formatDiffs: formatDiffs,
		slimFacts: slimFacts,
		slimAction: slimAction,
	};
});
