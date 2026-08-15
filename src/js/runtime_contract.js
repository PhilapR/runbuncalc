/* eslint-env browser, node, es6 */

(function (root, factory) {
	if (typeof module === 'object' && module.exports) module.exports = factory();
	else root.RunBunRuntimeContract = factory();
})(typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : this, function () {
	'use strict';

	var SCHEMA_VERSION = '2.0.0';
	var EVENT_KINDS = Object.freeze([
		'run.started', 'run.ended', 'run.migrated', 'run.imported', 'run.replaced',
		'command.applied', 'snapshot.observed', 'party.changed',
		'box.changed', 'bag.changed', 'map.entered', 'position.changed',
		'encounter.started', 'pokemon.caught', 'pokemon.fainted',
		'battle.started', 'turn.resolved', 'battle.ended', 'flag.changed',
	]);
	var SOURCE_KINDS = Object.freeze([
		'manual', 'emulator', 'simulator', 'rebuilt', 'import', 'migration', 'system',
	]);
	var ATTEMPT_OUTCOMES = Object.freeze(['wipe', 'completed', 'reset', 'abandoned']);
	var EVENT_KIND_SET = new Set(EVENT_KINDS);
	var SOURCE_KIND_SET = new Set(SOURCE_KINDS);
	var LEGACY_KIND_ALIASES = Object.freeze({
		'world.changed': 'snapshot.observed',
		'battle.observed': 'snapshot.observed',
		'party.updated': 'party.changed',
		'resource.updated': 'bag.changed',
	});

	function fail(message) {
		var error = new Error('runtime contract: ' + message);
		error.code = 'InvalidRuntimeContractEvent';
		error.statusCode = 400;
		throw error;
	}

	function isRecord(value) {
		return value && typeof value === 'object' && !Array.isArray(value);
	}

	function requireRecord(value, label) {
		if (!isRecord(value)) fail(label + ' must be an object');
		return value;
	}

	function requireString(value, label) {
		if (typeof value !== 'string' || !value) fail(label + ' is required');
		return value;
	}

	function requireSequence(value, label) {
		if (!Number.isInteger(value) || value < 0) {
			fail(label + ' must be a non-negative integer');
		}
		return value;
	}

	function validateSource(source) {
		requireRecord(source, 'source');
		if (!SOURCE_KIND_SET.has(source.kind)) {
			fail('source.kind must be one of ' + SOURCE_KINDS.join(', '));
		}
		requireString(source.providerId, 'source.providerId');
		if (typeof source.confidence !== 'number' || !Number.isFinite(source.confidence) ||
			source.confidence < 0 || source.confidence > 1) {
			fail('source.confidence must be a number between 0 and 1');
		}
		if (source.frame !== undefined) requireSequence(source.frame, 'source.frame');
		if (source.romFingerprint !== undefined) {
			requireString(source.romFingerprint, 'source.romFingerprint');
		}
		return source;
	}

	function validateSceneState(scene) {
		requireRecord(scene, 'payload.scene');
		requireString(scene.mode, 'payload.scene.mode');
		if (scene.map !== undefined && scene.map !== null) {
			requireRecord(scene.map, 'payload.scene.map');
			if (scene.map.id !== undefined) requireString(scene.map.id, 'payload.scene.map.id');
			['group', 'number', 'layout'].forEach(function (field) {
				if (scene.map[field] !== undefined) requireSequence(scene.map[field], 'payload.scene.map.' + field);
			});
		}
		if (scene.position !== undefined && scene.position !== null) {
			requireRecord(scene.position, 'payload.scene.position');
			if (!Number.isInteger(scene.position.x) || !Number.isInteger(scene.position.y)) {
				fail('payload.scene.position x and y must be integers');
			}
		}
		if (scene.activeObjects !== undefined && !Array.isArray(scene.activeObjects)) {
			fail('payload.scene.activeObjects must be an array');
		}
		return scene;
	}

	function validateBattleObservation(battle) {
		requireRecord(battle, 'payload.battle');
		if (battle.battleId !== undefined) requireString(battle.battleId, 'payload.battle.battleId');
		if (battle.phase !== undefined) requireString(battle.phase, 'payload.battle.phase');
		if (battle.turn !== undefined) requireSequence(battle.turn, 'payload.battle.turn');
		if (battle.participants !== undefined && !Array.isArray(battle.participants)) {
			fail('payload.battle.participants must be an array');
		}
		if (battle.field !== undefined) requireRecord(battle.field, 'payload.battle.field');
		if (battle.pendingInput !== undefined && battle.pendingInput !== null) {
			requireRecord(battle.pendingInput, 'payload.battle.pendingInput');
		}
		return battle;
	}

	function validateEvent(event) {
		requireRecord(event, 'event');
		if (event.schemaVersion !== SCHEMA_VERSION) {
			fail('unsupported schemaVersion ' + JSON.stringify(event.schemaVersion) +
				'; this contract reads ' + SCHEMA_VERSION);
		}
		requireString(event.eventId, 'eventId');
		requireString(event.attemptId, 'attemptId');
		requireString(event.profileId, 'profileId');
		var hasRevision = event.revision !== undefined && event.revision !== null;
		var hasSourceSequence = event.sourceSequence !== undefined && event.sourceSequence !== null;
		if (!hasRevision && !hasSourceSequence) fail('revision or sourceSequence is required');
		if (hasRevision) requireSequence(event.revision, 'revision');
		if (hasSourceSequence) requireSequence(event.sourceSequence, 'sourceSequence');
		requireString(event.kind, 'kind');
		if (!EVENT_KIND_SET.has(event.kind)) fail('unknown kind ' + JSON.stringify(event.kind));
		validateSource(event.source);
		requireRecord(event.payload, 'payload');
		if (event.payload.scene !== undefined && event.payload.scene !== null) validateSceneState(event.payload.scene);
		if (event.payload.battle !== undefined && event.payload.battle !== null) validateBattleObservation(event.payload.battle);
		if (event.kind === 'snapshot.observed' && !event.compatibility &&
			event.payload.scene === undefined && event.payload.battle === undefined) {
			fail('snapshot.observed payload requires scene or battle');
		}
		if (event.kind === 'run.ended' && ATTEMPT_OUTCOMES.indexOf(event.payload.outcome) === -1) {
			fail('run.ended payload.outcome must be one of ' + ATTEMPT_OUTCOMES.join(', '));
		}
		requireString(event.observedAt, 'observedAt');
		if (Number.isNaN(Date.parse(event.observedAt))) fail('observedAt must be an ISO timestamp');
		return event;
	}

	function copy(value) {
		return JSON.parse(JSON.stringify(value));
	}

	function normalizeEncounterEnded(event) {
		var payload = copy(event.payload);
		if (payload.outcome === 'caught') {
			return {kind: 'pokemon.caught', payload: {
				capture: payload.capture,
				...(payload.map ? {map: payload.map} : {}),
			}};
		}
		if (payload.outcome === 'won' || payload.outcome === 'lost') {
			return {kind: 'battle.ended', payload: {
				outcome: payload.outcome,
				...(payload.trainer ? {trainer: payload.trainer} : {}),
			}};
		}
		return {kind: 'encounter.started', payload: payload};
	}

	function normalizeLegacyKind(event) {
		if (event.kind === 'encounter.ended') return normalizeEncounterEnded(event);
		return {kind: LEGACY_KIND_ALIASES[event.kind] || event.kind, payload: copy(event.payload)};
	}

	/**
	 * Convert the v1 fixture/bridge envelope explicitly. The returned event is
	 * v2; the compatibility block keeps the original identity for audit tools.
	 */
	function normalizeEvent(input) {
		var event = requireRecord(input, 'event');
		if (event.schemaVersion === SCHEMA_VERSION) return validateEvent(copy(event));
		if (event.schemaVersion !== '1.0.0') {
			fail('unsupported schemaVersion ' + JSON.stringify(event.schemaVersion) +
			'; this contract reads ' + SCHEMA_VERSION);
		}
		var legacy = normalizeLegacyKind(event);
		var revision = event.revision !== undefined ? event.revision :
			event.sourceSequence !== undefined ? event.sourceSequence : event.sequence;
		var canonical = Object.assign({}, copy(event), {
			schemaVersion: SCHEMA_VERSION,
			attemptId: event.attemptId || event.runId,
			revision: revision,
			kind: legacy.kind,
			payload: legacy.payload,
			compatibility: {
				originalSchemaVersion: event.schemaVersion,
				originalKind: event.kind,
				...(event.runId ? {originalRunId: event.runId} : {}),
				...(event.sequence !== undefined ? {originalSequence: event.sequence} : {}),
			},
		});
		delete canonical.runId;
		delete canonical.sequence;
		delete canonical.sourceSequence;
		return validateEvent(canonical);
	}

	return Object.freeze({
		SCHEMA_VERSION,
		EVENT_KINDS,
		SOURCE_KINDS,
		ATTEMPT_OUTCOMES,
		LEGACY_KIND_ALIASES,
		validateEvent,
		validateSceneState,
		validateBattleObservation,
		normalizeEvent,
	});
});
