/* eslint-env node, es6 */
'use strict';

const AttemptStore = require('./src/js/attempt_store');

const SCHEMA_VERSION = '1.0.0';
const TABLE_SCHEMAS = Object.freeze({
	episodes: Object.freeze({
		attempt_id: 'UTF8', profile_id: 'UTF8', model_version: 'UTF8',
		started_at_ms: 'INT64?', ended_at_ms: 'INT64?', outcome: 'UTF8?',
		revision_count: 'UINT32', event_count: 'UINT32', archive_checksum: 'UTF8',
	}),
	events: Object.freeze({
		attempt_id: 'UTF8', revision: 'UINT32', event_id: 'UTF8', source_sequence: 'UINT32?',
		kind: 'UTF8_DICTIONARY', observed_at_ms: 'INT64', source_kind: 'UTF8_DICTIONARY',
		provider_id: 'UTF8_DICTIONARY', confidence: 'FLOAT32', frame: 'UINT64?',
		rom_fingerprint: 'UTF8?', previous_event_hash: 'FIXED_BINARY_32?',
		event_hash: 'FIXED_BINARY_32', previous_state_hash: 'FIXED_BINARY_32?',
		state_hash: 'FIXED_BINARY_32', payload_json: 'UTF8',
	}),
	steps: Object.freeze({
		attempt_id: 'UTF8', revision: 'UINT32', event_id: 'UTF8',
		action_kind: 'UTF8_DICTIONARY', action_json: 'UTF8', caused_by_event_id: 'UTF8?',
		observation_hash: 'FIXED_BINARY_32?', next_observation_hash: 'FIXED_BINARY_32',
		reward: 'FLOAT32?', terminal: 'BOOLEAN', discount: 'FLOAT32',
	}),
	observations: Object.freeze({
		attempt_id: 'UTF8', revision: 'UINT32', event_id: 'UTF8',
		scene_mode: 'UTF8_DICTIONARY?', map_id: 'UTF8?', x: 'INT32?', y: 'INT32?',
		battle_id: 'UTF8?', battle_phase: 'UTF8_DICTIONARY?', battle_turn: 'UINT32?',
		observation_json: 'UTF8',
	}),
});

function timestamp(value) {
	if (!value) return null;
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) throw new Error(`Invalid archive timestamp ${JSON.stringify(value)}.`);
	return parsed;
}

function uint32(value, label) {
	if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
		throw new Error(`${label} must fit UINT32.`);
	}
	return value;
}

function json(value) {
	return JSON.stringify(value === undefined ? null : value);
}

function eventRow(bundle, event) {
	return {
		attempt_id: bundle.attemptId,
		revision: uint32(event.revision, 'event revision'),
		event_id: event.eventId,
		source_sequence: event.sourceSequence === null || event.sourceSequence === undefined ?
			null : uint32(event.sourceSequence, 'source sequence'),
		kind: event.kind,
		observed_at_ms: timestamp(event.observedAt),
		source_kind: event.source.kind,
		provider_id: event.source.providerId,
		confidence: Math.fround(event.source.confidence),
		frame: event.source.frame === undefined ? null : event.source.frame,
		rom_fingerprint: event.source.romFingerprint || null,
		previous_event_hash: event.previousEventHash,
		event_hash: event.eventHash,
		previous_state_hash: event.previousStateHash,
		state_hash: event.stateHash,
		payload_json: json(event.payload),
	};
}

function stepRow(bundle, event, options) {
	const command = event.payload.command;
	const rewardValue = options && typeof options.reward === 'function' ?
		options.reward(event, bundle) : null;
	const ended = options && event.revision === options.terminalRevision;
	return {
		attempt_id: bundle.attemptId,
		revision: uint32(event.revision, 'step revision'),
		event_id: event.eventId,
		action_kind: command.kind || 'unknown',
		action_json: json(command),
		caused_by_event_id: event.payload.causedByEventId || null,
		observation_hash: event.previousStateHash,
		next_observation_hash: event.stateHash,
		reward: rewardValue === null || rewardValue === undefined ? null : Math.fround(rewardValue),
		terminal: ended,
		discount: Math.fround(ended ? 0 : 1),
	};
}

function observationRow(bundle, event) {
	const scene = event.payload.scene || {};
	const battle = event.payload.battle || {};
	return {
		attempt_id: bundle.attemptId,
		revision: uint32(event.revision, 'observation revision'),
		event_id: event.eventId,
		scene_mode: scene.mode || null,
		map_id: scene.map && scene.map.id || null,
		x: scene.position && scene.position.x !== undefined ? scene.position.x : null,
		y: scene.position && scene.position.y !== undefined ? scene.position.y : null,
		battle_id: battle.battleId || null,
		battle_phase: battle.phase || null,
		battle_turn: battle.turn === undefined ? null : uint32(battle.turn, 'battle turn'),
		observation_json: json(event.payload),
	};
}

async function materialize(bundle, options) {
	await AttemptStore.validateBundle(bundle);
	const events = bundle.events.map(event => eventRow(bundle, event));
	const sourceEvents = bundle.events;
	const start = sourceEvents.find(event => event.kind === 'run.started');
	const end = sourceEvents.find(event => event.kind === 'run.ended');
	const commandEvents = sourceEvents.filter(event => event.kind === 'command.applied' &&
		event.payload && event.payload.command);
	const terminalRevision = end && commandEvents.length ?
		commandEvents[commandEvents.length - 1].revision : null;
	const stepOptions = Object.assign({}, options, {terminalRevision});
	const steps = commandEvents.map(event => stepRow(bundle, event, stepOptions));
	const observations = sourceEvents.filter(event => event.kind === 'snapshot.observed')
		.map(event => observationRow(bundle, event));
	return {
		schemaVersion: SCHEMA_VERSION,
		tableSchemas: TABLE_SCHEMAS,
		episodes: [{
			attempt_id: bundle.attemptId,
			profile_id: bundle.head.run.profileId || 'run-and-bun',
			model_version: bundle.modelVersion,
			started_at_ms: start ? timestamp(start.observedAt) : null,
			ended_at_ms: end ? timestamp(end.observedAt) : null,
			outcome: end && end.payload.outcome || null,
			revision_count: uint32(bundle.head.revision, 'head revision'),
			event_count: uint32(bundle.events.length, 'event count'),
			archive_checksum: bundle.checksum,
		}],
		events,
		steps,
		observations,
	};
}

function ndjson(rows) {
	if (!Array.isArray(rows)) throw new Error('NDJSON export requires an array of rows.');
	return rows.map(json).join('\n') + (rows.length ? '\n' : '');
}

module.exports = {SCHEMA_VERSION, TABLE_SCHEMAS, materialize, ndjson};
