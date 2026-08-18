/* eslint-env node, es6 */
'use strict';

const AttemptStore = require('./src/js/attempt_store');
const RunHistory = require('./src/js/run_history');

const SCHEMA_VERSION = '1.4.0';
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
	attribution_receipts: Object.freeze({
		attempt_id: 'UTF8', evidence_id: 'UTF8', attempt_revision: 'UINT32',
		state_hash: 'FIXED_BINARY_32', request_id: 'UTF8', trainer_order: 'UINT32',
		provider_revision: 'UTF8', planner_revision: 'UTF8', policy: 'UTF8_DICTIONARY',
		seed_count: 'UINT32', baseline_team_size: 'UINT8', intervention_count: 'UINT32',
		seed_pairs_evaluated: 'UINT32', candidate_branches_evaluated: 'UINT32',
		baseline_safe_branches: 'UINT32', baseline_losses: 'UINT32',
		baseline_deaths: 'UINT32', baseline_expected_turns: 'FLOAT32',
		request_hash: 'FIXED_BINARY_32', baseline_team_hash: 'FIXED_BINARY_32',
		output_hash: 'FIXED_BINARY_32', replay_hash: 'FIXED_BINARY_32',
		evidence_hash: 'FIXED_BINARY_32',
	}),
	attribution_tests: Object.freeze({
		attempt_id: 'UTF8', evidence_id: 'UTF8', request_id: 'UTF8',
		intervention_index: 'UINT32', intervention_id: 'UTF8', kind: 'UTF8_DICTIONARY',
		target_id: 'UTF8', replacement_id: 'UTF8?', reference: 'UTF8_DICTIONARY?',
		source_event_id: 'UTF8?', source_event_hash: 'FIXED_BINARY_32?',
		acquired_revision: 'UINT32?', effective_team_hash: 'FIXED_BINARY_32',
		safe_branches: 'UINT32', losses: 'UINT32', deaths: 'UINT32',
		expected_turns: 'FLOAT32', delta_safe_branches: 'INT32', delta_wins: 'INT32',
		delta_deaths: 'INT32', delta_expected_turns: 'FLOAT32',
		delta_total_hp_remaining: 'INT32', changed_outcome_branches: 'UINT32',
		changed_deathless_branches: 'UINT32',
	}),
	attribution_branches: Object.freeze({
		attempt_id: 'UTF8', evidence_id: 'UTF8', request_id: 'UTF8',
		intervention_id: 'UTF8?', branch_index: 'UINT32', seed: 'UINT32',
		victory: 'BOOLEAN', deaths: 'UINT32', turns: 'UINT32', total_hp_remaining: 'INT32',
	}),
	battle_outcomes: Object.freeze({
		attempt_id: 'UTF8', revision: 'UINT32', event_id: 'UTF8',
		trainer_order: 'UINT32', progression_order: 'UINT32?', trainer: 'UTF8',
		seed: 'UINT32', outcome: 'UTF8_DICTIONARY', turns: 'UINT32',
		lead_id: 'UTF8?', participant_count: 'UINT8', deaths: 'UINT8',
		provider_id: 'UTF8',
	}),
	planning_reviews: Object.freeze({
		attempt_id: 'UTF8', trainer_order: 'UINT32', comparison: 'UTF8_DICTIONARY',
		evidence_id: 'UTF8?', planning_revision: 'UINT32?', battle_revision: 'UINT32?',
		battle_event_id: 'UTF8?', plan_count: 'UINT32', planned_lead_id: 'UTF8?',
		sampled_branches: 'UINT32?', sampled_safe_branches: 'UINT32?',
		sampled_deaths: 'UINT32?', actual_outcome: 'UTF8_DICTIONARY?',
		actual_deaths: 'UINT32?', actual_turns: 'UINT32?',
	}),
	battle_contributions: Object.freeze({
		attempt_id: 'UTF8', battle_revision: 'UINT32', battle_event_id: 'UTF8',
		trainer_order: 'UINT32', mon_id: 'UTF8', battle_id: 'UTF8', species: 'UTF8',
		appearances: 'UINT32', switch_ins: 'UINT32', move_attempts: 'UINT32',
		opposing_hp_removed: 'UINT32', kos: 'UINT32',
		complete: 'BOOLEAN',
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

function int32(value, label) {
	if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) {
		throw new Error(`${label} must fit INT32.`);
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

function attributionReceiptRow(bundle, evidence) {
	const request = evidence.request;
	const receipt = evidence.receipt;
	const baseline = receipt.result.baseline;
	return {
		attempt_id: bundle.attemptId,
		evidence_id: evidence.evidenceId,
		attempt_revision: uint32(evidence.attemptRevision, 'attribution attempt revision'),
		state_hash: evidence.stateHash,
		request_id: request.requestId,
		trainer_order: uint32(receipt.input.trainerOrder, 'attribution trainer order'),
		provider_revision: receipt.producer.revision,
		planner_revision: receipt.input.plannerRevision,
		policy: receipt.input.policy,
		seed_count: uint32(receipt.input.seeds.length, 'attribution seed count'),
		baseline_team_size: uint32(request.task.state.baselineTeam.length,
			'attribution baseline team size'),
		intervention_count: uint32(request.task.interventions.length,
			'attribution intervention count'),
		seed_pairs_evaluated: uint32(receipt.result.summary.seedPairsEvaluated,
			'attribution seed pairs'),
		candidate_branches_evaluated: uint32(receipt.result.summary.candidateBranchesEvaluated,
			'attribution candidate branches'),
		baseline_safe_branches: uint32(baseline.safeBranches, 'attribution baseline safe branches'),
		baseline_losses: uint32(baseline.losses, 'attribution baseline losses'),
		baseline_deaths: uint32(baseline.totalDeaths, 'attribution baseline deaths'),
		baseline_expected_turns: Math.fround(baseline.expectedTurns),
		request_hash: receipt.input.requestHash,
		baseline_team_hash: receipt.input.baselineTeamHash,
		output_hash: receipt.result.outputHash,
		replay_hash: receipt.evidence.replayHash,
		evidence_hash: evidence.evidenceHash,
	};
}

function attributionTestRows(bundle, evidence) {
	const byId = Object.fromEntries(evidence.request.task.interventions
		.map(intervention => [intervention.interventionId, intervention]));
	return evidence.receipt.result.interventions.map((result, index) => {
		const intervention = byId[result.interventionId];
		const ownership = intervention.ownership || {};
		return {
			attempt_id: bundle.attemptId,
			evidence_id: evidence.evidenceId,
			request_id: evidence.request.requestId,
			intervention_index: uint32(index, 'attribution intervention index'),
			intervention_id: result.interventionId,
			kind: result.kind,
			target_id: result.targetId,
			replacement_id: intervention.replacement && intervention.replacement.id || null,
			reference: intervention.reference || null,
			source_event_id: ownership.sourceEventId || null,
			source_event_hash: ownership.sourceEventHash || null,
			acquired_revision: ownership.acquiredRevision === undefined ? null :
				uint32(ownership.acquiredRevision, 'attribution acquired revision'),
			effective_team_hash: result.effectiveTeamHash,
			safe_branches: uint32(result.outcome.safeBranches, 'attribution safe branches'),
			losses: uint32(result.outcome.losses, 'attribution losses'),
			deaths: uint32(result.outcome.totalDeaths, 'attribution deaths'),
			expected_turns: Math.fround(result.outcome.expectedTurns),
			delta_safe_branches: int32(result.delta.safeBranches, 'attribution safe branch delta'),
			delta_wins: int32(result.delta.wins, 'attribution win delta'),
			delta_deaths: int32(result.delta.deaths, 'attribution death delta'),
			delta_expected_turns: Math.fround(result.delta.expectedTurns),
			delta_total_hp_remaining: int32(result.delta.totalHPRemaining,
				'attribution remaining HP delta'),
			changed_outcome_branches: uint32(result.delta.changedOutcomeBranches,
				'attribution changed outcome branches'),
			changed_deathless_branches: uint32(result.delta.changedDeathlessBranches,
				'attribution changed deathless branches'),
		};
	});
}

function attributionBranchRows(bundle, evidence) {
	const groups = [{interventionId: null, outcome: evidence.receipt.result.baseline}]
		.concat(evidence.receipt.result.interventions.map(result => ({
			interventionId: result.interventionId, outcome: result.outcome,
		})));
	return groups.flatMap(group => group.outcome.branchOutcomes.map((branch, index) => ({
		attempt_id: bundle.attemptId,
		evidence_id: evidence.evidenceId,
		request_id: evidence.request.requestId,
		intervention_id: group.interventionId,
		branch_index: uint32(index, 'attribution branch index'),
		seed: uint32(branch.seed, 'attribution branch seed'),
		victory: branch.victory,
		deaths: uint32(branch.deaths, 'attribution branch deaths'),
		turns: uint32(branch.turns, 'attribution branch turns'),
		total_hp_remaining: int32(branch.totalHPRemaining, 'attribution branch remaining HP'),
	})));
}

function battleOutcomeRow(bundle, event) {
	const payload = event.payload;
	if (event.kind !== 'battle.ended' || !payload || payload.kind !== 'trainer' ||
		!Number.isInteger(payload.trainerOrder) || typeof payload.trainer !== 'string' ||
		!payload.trainer || !Number.isInteger(payload.seed) ||
		['won', 'lost'].indexOf(payload.outcome) === -1 || !Number.isInteger(payload.turns) ||
		!Array.isArray(payload.participantIds) || payload.participantIds.length > 6 ||
		!Array.isArray(payload.deaths) || payload.deaths.length > 6) return null;
	return {
		attempt_id: bundle.attemptId,
		revision: uint32(event.revision, 'battle revision'),
		event_id: event.eventId,
		trainer_order: uint32(payload.trainerOrder, 'battle trainer order'),
		progression_order: payload.progressionOrder === null ||
			payload.progressionOrder === undefined ? null :
			uint32(payload.progressionOrder, 'battle progression order'),
		trainer: payload.trainer,
		seed: uint32(payload.seed, 'battle seed'),
		outcome: payload.outcome,
		turns: uint32(payload.turns, 'battle turns'),
		lead_id: payload.leadId || null,
		participant_count: uint32((payload.participantIds || []).length,
			'battle participant count'),
		deaths: uint32(payload.deaths.length, 'battle deaths'),
		provider_id: event.source.providerId,
	};
}

function planningReviewRow(bundle, row) {
	return {
		attempt_id: bundle.attemptId,
		trainer_order: uint32(row.trainerOrder, 'review trainer order'),
		comparison: row.comparison,
		evidence_id: row.plan ? row.plan.evidenceId : null,
		planning_revision: row.plan ?
			uint32(row.plan.attemptRevision, 'review planning revision') : null,
		battle_revision: row.actual ?
			uint32(row.actual.revision, 'review battle revision') : null,
		battle_event_id: row.actual ? row.actual.eventId : null,
		plan_count: uint32(row.planCount, 'review plan count'),
		planned_lead_id: row.plan ? row.plan.leadId : null,
		sampled_branches: row.plan ?
			uint32(row.plan.branches, 'review sampled branches') : null,
		sampled_safe_branches: row.plan ?
			uint32(row.plan.safeBranches, 'review safe branches') : null,
		sampled_deaths: row.plan ? uint32(row.plan.deaths, 'review sampled deaths') : null,
		actual_outcome: row.actual ? row.actual.result : null,
		actual_deaths: row.actual ? uint32(row.actual.deaths, 'review actual deaths') : null,
		actual_turns: row.actual ? uint32(row.actual.turns, 'review actual turns') : null,
	};
}

function validBattleContribution(row) {
	const validCounters = row &&
		['appearances', 'switchIns', 'moveAttempts', 'opposingHpRemoved', 'kos']
			.every(field => Number.isInteger(row[field]) && row[field] >= 0 && row[field] <= 0xffffffff);
	return Boolean(validCounters && typeof row.monId === 'string' && row.monId &&
		typeof row.battleId === 'string' && row.battleId && typeof row.species === 'string' &&
		row.species && row.switchIns <= row.appearances &&
		(row.appearances > 0 || row.moveAttempts + row.opposingHpRemoved + row.kos === 0));
}

function battleContributionRows(bundle, event) {
	const payload = event.payload;
	if (event.kind !== 'battle.ended' || !payload || payload.kind !== 'trainer' ||
		!Number.isInteger(payload.trainerOrder) || !Array.isArray(payload.contributions)) return [];
	const valid = payload.contributions.every(validBattleContribution);
	const complete = payload.contributionVersion === 1 && payload.contributionComplete === true && valid;
	return payload.contributions.filter(validBattleContribution)
		.map(row => ({
			attempt_id: bundle.attemptId,
			battle_revision: uint32(event.revision, 'contribution battle revision'),
			battle_event_id: event.eventId,
			trainer_order: uint32(payload.trainerOrder, 'contribution trainer order'),
			mon_id: row.monId,
			battle_id: row.battleId,
			species: row.species,
			appearances: uint32(row.appearances, 'contribution appearances'),
			switch_ins: uint32(row.switchIns, 'contribution switch ins'),
			move_attempts: uint32(row.moveAttempts, 'contribution move attempts'),
			opposing_hp_removed: uint32(row.opposingHpRemoved,
				'contribution opposing HP removed'),
			kos: uint32(row.kos, 'contribution KOs'),
			complete,
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
	const attributionEvidence = evidence.filter(record => record.kind === 'pokemon.rab.attribute');
	const attributionReceipts = attributionEvidence.map(record =>
		attributionReceiptRow(bundle, record));
	const attributionTests = attributionEvidence.flatMap(record =>
		attributionTestRows(bundle, record));
	const attributionBranches = attributionEvidence.flatMap(record =>
		attributionBranchRows(bundle, record));
	const battleOutcomes = bundle.events.map(event => battleOutcomeRow(bundle, event)).filter(Boolean);
	const planningReviews = RunHistory.derivePlanningReview(bundle).rows.map(row =>
		planningReviewRow(bundle, row));
	const battleContributions = bundle.events.flatMap(event =>
		battleContributionRows(bundle, event));
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
		attribution_receipts: attributionReceipts,
		attribution_tests: attributionTests,
		attribution_branches: attributionBranches,
		battle_outcomes: battleOutcomes,
		planning_reviews: planningReviews,
		battle_contributions: battleContributions,
	};
}

function ndjson(rows) {
	if (!Array.isArray(rows)) throw new Error('NDJSON export requires an array of rows.');
	return rows.map(json).join('\n') + (rows.length ? '\n' : '');
}

module.exports = {SCHEMA_VERSION, TABLE_SCHEMAS, materialize, ndjson};
