/* eslint-env browser, node, es6 */
/* global window */
/**
 * Shareable apply/advance replay traces (RPL-01).
 * Scrubbing uses recorded stateAfter + optional stored resolution — no re-derive.
 * Dual load: browser global `RunBunReplayTrace` and CommonJS `module.exports`.
 */
(function (root, factory) {
	var api = factory();
	if (typeof module === 'object' && module.exports) {
		module.exports = api;
	}
	if (root) {
		root.RunBunReplayTrace = api;
	}
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this), function () {
	'use strict';

	var SCHEMA_VERSION = 1;
	var KIND = 'apply-advance-trace';

	function ReplayClientError(message) {
		var err = new Error(message);
		err.name = 'ReplayClientError';
		err.status = 400;
		return err;
	}

	function isPlainObject(value) {
		return !!value && typeof value === 'object' && !Array.isArray(value);
	}

	function assert(condition, message) {
		if (!condition) throw ReplayClientError(message);
	}

	function cloneJson(value) {
		return JSON.parse(JSON.stringify(value));
	}

	function looksLikeBattleState(state) {
		return isPlainObject(state) &&
			isPlainObject(state.sides) &&
			isPlainObject(state.sides.ai) &&
			isPlainObject(state.sides.player) &&
			Array.isArray(state.sides.ai.party) &&
			Array.isArray(state.sides.player.party);
	}

	function looksLikeAction(action) {
		if (!isPlainObject(action) || typeof action.kind !== 'string') return false;
		if (action.kind === 'move') {
			return typeof action.actorId === 'string' &&
				typeof action.moveName === 'string' &&
				Array.isArray(action.targetIds);
		}
		if (action.kind === 'switch') {
			return typeof action.actorId === 'string' &&
				typeof action.replacementId === 'string';
		}
		return false;
	}

	function validateStep(step, index) {
		assert(isPlainObject(step), 'steps[' + index + '] must be an object');
		assert(step.type === 'apply' || step.type === 'advance',
			'steps[' + index + '].type must be "apply" or "advance"');
		assert(looksLikeBattleState(step.stateAfter),
			'steps[' + index + '].stateAfter must be a BattleState-shaped object');
		if (step.type === 'apply') {
			assert(looksLikeAction(step.action),
				'steps[' + index + '].action must be a move or switch action');
			if (step.action.kind === 'move') {
				assert(isPlainObject(step.resolution),
					'steps[' + index + '].resolution is required for move apply steps ' +
					'(store derive-resolution output so scrubbing does not re-roll)');
			}
			if (step.evaluations !== undefined) {
				assert(Array.isArray(step.evaluations),
					'steps[' + index + '].evaluations must be an array when present');
			}
			if (step.sideId !== undefined) {
				assert(step.sideId === 'ai' || step.sideId === 'player',
					'steps[' + index + '].sideId must be "ai" or "player"');
			}
		} else if (step.action !== undefined || step.resolution !== undefined) {
			throw ReplayClientError(
				'steps[' + index + '] advance steps must not carry action/resolution');
		}
	}

	/**
	 * Parse and structurally validate a shareable replay JSON value.
	 * Does not call the AI package; use validateReplayWithAi for that.
	 */
	function parseReplay(raw) {
		var value = raw;
		if (typeof raw === 'string') {
			try {
				value = JSON.parse(raw);
			} catch (error) {
				throw ReplayClientError('replay must contain valid JSON');
			}
		}
		assert(isPlainObject(value), 'replay must be a JSON object');
		assert(value.schemaVersion === SCHEMA_VERSION,
			'replay.schemaVersion must be ' + SCHEMA_VERSION);
		assert(value.kind === KIND,
			'replay.kind must be "' + KIND + '"');
		assert(looksLikeBattleState(value.initialState),
			'replay.initialState must be a BattleState-shaped object');
		assert(Array.isArray(value.steps), 'replay.steps must be an array');
		assert(value.steps.length >= 1, 'replay.steps must include at least one step');
		value.steps.forEach(validateStep);
		if (value.generation !== undefined) {
			assert(typeof value.generation === 'number' &&
				value.generation >= 1 && value.generation <= 9,
			'replay.generation must be an integer 1–9 when present');
		}
		if (value.mode !== undefined) {
			assert(value.mode === 'Singles' || value.mode === 'Doubles',
				'replay.mode must be Singles or Doubles when present');
		}
		return value;
	}

	/**
	 * Validate recorded states/actions against the AI package validators.
	 * `ai` must expose validateBattleState, validateAction, validateMoveResolution.
	 */
	function validateReplayWithAi(replay, ai) {
		var parsed = parseReplay(replay);
		assert(ai && typeof ai.validateBattleState === 'function',
			'validateReplayWithAi requires an ai package');
		try {
			ai.validateBattleState(parsed.initialState);
		} catch (error) {
			throw ReplayClientError('initialState: ' +
				(error && error.message ? error.message : error));
		}
		var before = parsed.initialState;
		parsed.steps.forEach(function (step, index) {
			try {
				if (step.type === 'apply') {
					ai.validateAction(before, step.action);
					if (step.action.kind === 'move' && step.resolution) {
						ai.validateMoveResolution(before, step.action, step.resolution);
					}
				}
				ai.validateBattleState(step.stateAfter);
			} catch (error) {
				throw ReplayClientError('steps[' + index + ']: ' +
					(error && error.message ? error.message : error));
			}
			before = step.stateAfter;
		});
		return parsed;
	}

	function frameCount(replay) {
		var parsed = parseReplay(replay);
		return parsed.steps.length + 1;
	}

	/**
	 * Frame 0 = initialState; frame k>0 = after steps[k-1].
	 */
	function getFrame(replay, index) {
		var parsed = parseReplay(replay);
		var max = parsed.steps.length;
		assert(typeof index === 'number' && index >= 0 && index <= max &&
			Math.floor(index) === index,
		'replay frame index must be an integer 0..' + max);
		if (index === 0) {
			return {
				index: 0,
				label: 'Initial',
				state: parsed.initialState,
				step: null,
				evaluations: (parsed.steps[0] && parsed.steps[0].evaluations) || [],
			};
		}
		var step = parsed.steps[index - 1];
		var label = step.type === 'advance' ?
			'After advance #' + index :
			'After apply #' + index;
		return {
			index: index,
			label: label,
			state: step.stateAfter,
			step: step,
			evaluations: step.evaluations || [],
		};
	}

	function formatAction(action) {
		if (!action) return '(none)';
		if (action.kind === 'switch') {
			return 'switch ' + action.actorId + ' → ' + action.replacementId;
		}
		if (action.kind === 'move') {
			var targets = Array.isArray(action.targetIds) ?
				action.targetIds.join(', ') : '?';
			return action.moveName + ' (' + action.actorId + ' → ' + targets + ')';
		}
		return String(action.kind || '?');
	}

	function createRecorder(initialState) {
		assert(looksLikeBattleState(initialState),
			'recorder initialState must be a BattleState-shaped object');
		var state0 = cloneJson(initialState);
		var steps = [];
		return {
			reset: function (nextInitial) {
				assert(looksLikeBattleState(nextInitial),
					'recorder reset requires a BattleState-shaped object');
				state0 = cloneJson(nextInitial);
				steps = [];
			},
			recordApply: function (opts) {
				var options = opts || {};
				assert(looksLikeAction(options.action),
					'recordApply requires a move or switch action');
				assert(looksLikeBattleState(options.stateAfter),
					'recordApply requires stateAfter');
				if (options.action.kind === 'move') {
					assert(isPlainObject(options.resolution),
						'recordApply requires resolution for move actions');
				}
				var step = {
					type: 'apply',
					action: cloneJson(options.action),
					stateAfter: cloneJson(options.stateAfter),
				};
				if (options.resolution) step.resolution = cloneJson(options.resolution);
				if (options.sideId) step.sideId = options.sideId;
				if (Array.isArray(options.evaluations)) {
					step.evaluations = cloneJson(options.evaluations);
				}
				steps.push(step);
			},
			recordAdvance: function (stateAfter) {
				assert(looksLikeBattleState(stateAfter),
					'recordAdvance requires stateAfter');
				steps.push({
					type: 'advance',
					stateAfter: cloneJson(stateAfter),
				});
			},
			stepCount: function () { return steps.length; },
			toReplay: function (meta) {
				assert(steps.length >= 1,
					'export requires at least one recorded apply/advance step');
				var info = meta || {};
				var generation = typeof info.generation === 'number' ?
					info.generation : state0.generation;
				var mode = info.mode || state0.mode;
				return {
					schemaVersion: SCHEMA_VERSION,
					kind: KIND,
					id: info.id || 'session',
					label: info.label || 'Battle session replay',
					generation: generation,
					mode: mode,
					initialState: cloneJson(state0),
					steps: cloneJson(steps),
				};
			},
		};
	}

	return {
		SCHEMA_VERSION: SCHEMA_VERSION,
		KIND: KIND,
		ReplayClientError: ReplayClientError,
		parseReplay: parseReplay,
		validateReplayWithAi: validateReplayWithAi,
		frameCount: frameCount,
		getFrame: getFrame,
		formatAction: formatAction,
		createRecorder: createRecorder,
	};
});
