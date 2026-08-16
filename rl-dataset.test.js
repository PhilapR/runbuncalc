/* eslint-env node, es6 */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Store = require('./src/js/attempt_store');
const dataset = require('./rl-dataset');
const planningRequestFixture = require('./contracts/ecosystem/v1/planning-request.json');
const planningReceiptFixture = require('./contracts/ecosystem/v1/seeded-provider-receipt.json');

const TIME = '2026-08-15T00:00:00.000Z';

function event(kind, payload, source) {
	return {kind, payload, observedAt: TIME,
		source: source || {kind: 'manual', providerId: 'rl-test', confidence: 1}};
}

test('checked archives materialize into primitive episode, event, step and observation rows', async () => {
	const store = Store.createMemoryStore();
	const initial = {attemptId: 'rl-attempt', profileId: 'run-and-bun', value: 0, log: []};
	await store.commit({run: initial, expectedRevision: 0, commandId: 'start',
		event: event('run.started', {run: initial})});
	await store.commit({run: initial, expectedRevision: 1, commandId: 'observation',
		event: event('snapshot.observed', {scene: {mode: 'overworld',
			map: {id: 'rab:route-101'}, position: {x: 8, y: 19}}},
		{kind: 'emulator', providerId: 'mgba-test', confidence: 0.75, frame: 42})});
	const advanced = {attemptId: 'rl-attempt', profileId: 'run-and-bun', value: 1,
		log: [{command: {kind: 'tick'}, summary: 'tick', at: TIME}]};
	await store.commit({run: advanced, expectedRevision: 2, commandId: 'tick',
		event: event('command.applied', {command: {kind: 'tick'}})});
	const planningRequest = JSON.parse(JSON.stringify(planningRequestFixture));
	const planningReceipt = JSON.parse(JSON.stringify(planningReceiptFixture));
	planningRequest.attempt.attemptId = 'rl-attempt';
	planningRequest.attempt.revision = 3;
	planningReceipt.input.attemptId = 'rl-attempt';
	planningReceipt.input.revision = 3;
	await store.recordEvidence({request: planningRequest, receipt: planningReceipt,
		recordedAt: TIME});
	await store.commit({run: advanced, expectedRevision: 3, commandId: 'battle',
		event: event('battle.ended', {kind: 'trainer', trainer: 'Youngster Allen',
			trainerOrder: 1, progressionOrder: 0, seed: 1450, outcome: 'lost', turns: 5,
			leadId: 'owned-treecko-1', participantIds: ['owned-treecko-1'],
			deaths: [{monId: 'owned-treecko-1', species: 'Treecko'}]},
		{kind: 'simulator', providerId: 'runbun-battle-driver', confidence: 1})});
	await store.commit({run: advanced, expectedRevision: 4, commandId: 'end',
		event: event('run.ended', {outcome: 'wipe'})});

	const rows = await dataset.materialize(await store.exportActive(), {
		reward: row => row.payload.command.kind === 'tick' ? -1 : 0,
	});
	assert.equal(rows.schemaVersion, '1.2.0');
	assert.equal(rows.episodes[0].outcome, 'wipe');
	assert.equal(rows.episodes[0].revision_count, 5);
	assert.equal(rows.events.length, 5);
	assert.equal(rows.episodes[0].evidence_count, 1);
	assert.equal(rows.events[1].source_kind, 'emulator');
	assert.equal(rows.events[1].frame, 42);
	assert.deepEqual(rows.steps.map(row => ({action: row.action_kind,
		reward: row.reward, terminal: row.terminal, discount: row.discount})), [
		{action: 'tick', reward: -1, terminal: true, discount: 0},
	]);
	assert.deepEqual(rows.observations[0], {
		attempt_id: 'rl-attempt', revision: 2, event_id: 'rl-attempt:observation',
		scene_mode: 'overworld', map_id: 'rab:route-101', x: 8, y: 19,
		battle_id: null, battle_phase: null, battle_turn: null,
		observation_json: JSON.stringify({scene: {mode: 'overworld',
			map: {id: 'rab:route-101'}, position: {x: 8, y: 19}}}),
	});
	assert.equal(dataset.TABLE_SCHEMAS.events.revision, 'UINT32');
	assert.equal(dataset.TABLE_SCHEMAS.steps.reward, 'FLOAT32?');
	assert.equal(dataset.TABLE_SCHEMAS.planning_receipts.player_team_size, 'UINT8');
	assert.equal(rows.planning_receipts.length, 1);
	assert.deepEqual(rows.planning_receipts[0], {
		attempt_id: 'rl-attempt', evidence_id: planningReceipt.receiptId,
		attempt_revision: 3, state_hash: planningRequest.attempt.stateHash,
		request_id: planningRequest.requestId, trainer_order: 1,
		provider_revision: planningReceipt.producer.revision, seed_count: 1,
		player_team_size: 1, candidates_evaluated: 1, branches_evaluated: 1,
		safe_branches: 0, deaths: 1, losses: 1,
		recommended_lead_id: 'owned-treecko-1', expected_turns: 5,
		result_status: 'complete', safe: false,
		output_hash: planningReceipt.result.outputHash,
		replay_hash: planningReceipt.evidence.replayHash,
		evidence_hash: (await store.listEvidence('rl-attempt'))[0].evidenceHash,
	});
	assert.deepEqual(rows.planning_branches, [{
		attempt_id: 'rl-attempt', evidence_id: planningReceipt.receiptId,
		request_id: planningRequest.requestId, branch_index: 0, seed: 1450,
		victory: false, deaths: 1, turns: 5, total_hp_remaining: 0,
	}]);
	assert.deepEqual(rows.battle_outcomes, [{
		attempt_id: 'rl-attempt', revision: 4, event_id: 'rl-attempt:battle',
		trainer_order: 1, progression_order: 0, trainer: 'Youngster Allen', seed: 1450,
		outcome: 'lost', turns: 5, lead_id: 'owned-treecko-1', participant_count: 1,
		deaths: 1, provider_id: 'runbun-battle-driver',
	}]);
	assert.deepEqual(rows.planning_reviews, [{
		attempt_id: 'rl-attempt', trainer_order: 1, comparison: 'defeat',
		evidence_id: planningReceipt.receiptId, planning_revision: 3,
		battle_revision: 4, battle_event_id: 'rl-attempt:battle', plan_count: 1,
		planned_lead_id: 'owned-treecko-1', sampled_branches: 1,
		sampled_safe_branches: 0, sampled_deaths: 1, actual_outcome: 'loss',
		actual_deaths: 1, actual_turns: 5,
	}]);
	assert.match(dataset.ndjson(rows.steps), /"action_kind":"tick".*\n$/);
});

test('5k-event materialization is deterministic and linear', {timeout: 30000}, async () => {
	const store = Store.createMemoryStore();
	for (let revision = 1; revision <= 5000; revision++) {
		await store.commit({
			run: {attemptId: 'rl-scale', profileId: 'run-and-bun', value: revision},
			expectedRevision: revision - 1, commandId: 'event-' + revision,
			event: event(revision === 1 ? 'run.started' : 'position.changed',
				revision === 1 ? {} : {position: {x: revision, y: 0}}),
		});
	}
	const bundle = await store.exportActive();
	const started = Date.now();
	const first = await dataset.materialize(bundle);
	const second = await dataset.materialize(bundle);
	assert.equal(first.events.length, 5000);
	assert.deepEqual(second, first);
	assert.ok(Date.now() - started < 5000);
	assert.ok(Buffer.byteLength(dataset.ndjson(first.events)) < 10 * 1024 * 1024);
});

test('maximum planning batch materializes into bounded typed evidence rows', {timeout: 30000}, async () => {
	const store = Store.createMemoryStore();
	const initial = {attemptId: 'rl-evidence-scale', profileId: 'run-and-bun', log: []};
	await store.commit({run: initial, expectedRevision: 0, commandId: 'start',
		event: event('run.started', {run: initial})});
	const inputs = Array.from({length: 1024}, (_, index) => {
		const request = JSON.parse(JSON.stringify(planningRequestFixture));
		const receipt = JSON.parse(JSON.stringify(planningReceiptFixture));
		request.requestId = `rl-scale-request-${index}`;
		request.attempt.attemptId = initial.attemptId;
		request.attempt.revision = 1;
		request.task.seeds = [index];
		receipt.receiptId = `rl-scale-receipt-${index}`;
		receipt.requestId = request.requestId;
		receipt.input.attemptId = initial.attemptId;
		receipt.input.revision = 1;
		receipt.input.seeds = [index];
		receipt.result.summary.branchOutcomes[0].seed = index;
		return {request, receipt, recordedAt: TIME};
	});
	const started = Date.now();
	await store.recordEvidenceBatch(inputs);
	const bundle = await store.exportActive();
	const rows = await dataset.materialize(bundle);
	assert.equal(bundle.manifest.eventCount, 1);
	assert.equal(bundle.manifest.evidenceCount, 1024);
	assert.equal(rows.episodes[0].evidence_count, 1024);
	assert.equal(rows.planning_receipts.length, 1024);
	assert.equal(rows.planning_branches.length, 1024);
	assert.equal(rows.planning_receipts[1023].request_id, 'rl-scale-request-1023');
	assert.ok(Date.now() - started < 5000);
	assert.ok(Buffer.byteLength(JSON.stringify(bundle)) < 8 * 1024 * 1024);
});
