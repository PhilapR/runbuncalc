/* eslint-env node, es6 */
'use strict';

const AttemptStore = require('./src/js/attempt_store');

const SCHEMA_VERSION = '1.1.0';
const TABLE_SCHEMAS = Object.freeze({
	episodes: Object.freeze({
		attempt_id: 'UTF8', profile_id: 'UTF8', model_version: 'UTF8',
		started_at_ms: 'INT64?', ended_at_ms: 'INT64?', outcome: 'UTF8?',
		revision_count: 'UINT32', event_count: 'UINT32', evidence_count: 'UINT32',
		archive_checksum: 'UTF8',
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
	planning_receipts: Object.freeze({
		attempt_id: 'UTF8', evidence_id: 'UTF8', attempt_revision: 'UINT32',
		state_hash: 'FIXED_BINARY_32', request_id: 'UTF8', trainer_order: 'UINT32',
		provider_revision: 'UTF8', seed_count: 'UINT32', player_team_size: 'UINT8',
		candidates_evaluated: 'UINT32', branches_evaluated: 'UINT32',
		safe_branches: 'UINT32', deaths: 'UINT32', losses: 'UINT32',
		recommended_lead_id: 'UTF8', expected_turns: 'FLOAT32',
		result_status: 'UTF8_DICTIONARY', safe: 'BOOLEAN',
		output_hash: 'FIXED_BINARY_32', replay_hash: 'FIXED_BINARY_32',
		evidence_hash: 'FIXED_BINARY_32',
	}),
	planning_branches: Object.freeze({
		attempt_id: 'UTF8', evidence_id: 'UTF8', request_id: 'UTF8',
		branch_index: 'UINT32', seed: 'UINT32', victory: 'BOOLEAN', deaths: 'UINT32',
		turns: 'UINT32', total_hp_remaining: 'INT32',
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

function planningReceiptRow(bundle, evidence) {
	const request = evidence.request;
	const receipt = evidence.receipt;
	const summary = receipt.result.summary;
	return {
		attempt_id: bundle.attemptId,
		evidence_id: evidence.evidenceId,
		attempt_revision: uint32(evidence.attemptRevision, 'planning attempt revision'),
		state_hash: evidence.stateHash,
		request_id: request.requestId,
		trainer_order: uint32(request.task.state.trainer.order, 'planning trainer order'),
		provider_revision: receipt.producer.revision,
		seed_count: uint32(request.task.seeds.length, 'planning seed count'),
		player_team_size: uint32(request.task.state.playerTeam.length, 'planning team size'),
		candidates_evaluated: uint32(summary.candidatesEvaluated, 'planning candidate count'),
		branches_evaluated: uint32(summary.branchesEvaluated, 'planning branch count'),
		safe_branches: uint32(summary.safeBranches, 'planning safe branch count'),
		deaths: uint32(summary.deaths, 'planning deaths'),
		losses: uint32(summary.losses, 'planning losses'),
		recommended_lead_id: summary.recommendedLeadId,
		expected_turns: Math.fround(summary.expectedTurns),
		result_status: receipt.result.status,
		safe: receipt.result.safe,
		output_hash: receipt.result.outputHash,
		replay_hash: receipt.evidence.replayHash,
		evidence_hash: evidence.evidenceHash,
	};
}

function planningBranchRows(bundle, evidence) {
	return evidence.receipt.result.summary.branchOutcomes.map((branch, index) => ({
		attempt_id: bundle.attemptId,
		evidence_id: evidence.evidenceId,
		request_id: evidence.request.requestId,
		branch_index: uint32(index, 'planning branch index'),
		seed: uint32(branch.seed, 'planning branch seed'),
		victory: branch.victory,
		deaths: uint32(branch.deaths, 'planning branch deaths'),
		turns: uint32(branch.turns, 'planning branch turns'),
		total_hp_remaining: branch.totalHPRemaining,
	}));
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
	const evidence = bundle.evidence || [];
	const planningEvidence = evidence.filter(record => record.kind === 'pokemon.rab.plan');
	const planningReceipts = planningEvidence.map(record => planningReceiptRow(bundle, record));
	const planningBranches = planningEvidence.flatMap(record => planningBranchRows(bundle, record));
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
			evidence_count: uint32(evidence.length, 'evidence count'),
			archive_checksum: bundle.checksum,
		}],
		events,
		steps,
		observations,
		planning_receipts: planningReceipts,
		planning_branches: planningBranches,
	};
}

function ndjson(rows) {
	if (!Array.isArray(rows)) throw new Error('NDJSON export requires an array of rows.');
	return rows.map(json).join('\n') + (rows.length ? '\n' : '');
}

module.exports = {SCHEMA_VERSION, TABLE_SCHEMAS, materialize, ndjson};
