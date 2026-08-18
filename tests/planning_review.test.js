/* eslint-env node, es6 */
/* eslint-disable no-restricted-syntax */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {derivePlanningReview} = require('../src/js/run_history');
const attributionRequestFixture = require('../contracts/ecosystem/v1/attribution-request.json');
const attributionReceiptFixture = require('../contracts/ecosystem/v1/attribution-receipt.json');

const ATTEMPT_ID = 'attempt-planning-review';

function planEvidence({trainerOrder = 7, attemptRevision = 10, recordedAt = '2026-08-16T10:00:00.000Z',
	branchesEvaluated = 4, safeBranches = 4, recommendedLeadId = 'mon-treecko',
	deaths = 0, expectedTurns = 6, evidenceId = 'receipt-1'} = {}) {
	const seeds = Array.from({length: branchesEvaluated}, (_, index) => 1450 + index);
	return {
		id: ATTEMPT_ID + '::' + evidenceId,
		schemaVersion: 'rabrun.evidence/1.0.0',
		evidenceId,
		attemptId: ATTEMPT_ID,
		attemptRevision,
		stateHash: 'not-hash-validated-in-this-fixture',
		kind: 'pokemon.rab.plan',
		recordedAt,
		request: {
			schemaVersion: 'pokemon.bridge.request/1.0.0',
			requestId: 'request-' + evidenceId,
			capability: 'pokemon.rab.plan',
			attempt: {attemptId: ATTEMPT_ID, revision: attemptRevision,
				stateHash: 'not-hash-validated-in-this-fixture'},
			profile: {id: 'run-and-bun', revision: 'rab-profile-fixture-v1'},
			task: {
				kind: 'plan',
				state: {kind: 'run-and-bun.plan-input', trainer: {order: trainerOrder},
					playerTeam: [{id: 'mon-treecko', species: 'Treecko', level: 12,
						moves: ['Pound', 'Leer'], nature: 'Hardy', ability: 'Overgrow',
						item: null, ivs: {hp: 12, atk: 7, def: 18, spa: 24, spd: 11, spe: 29}},
					{id: 'mon-mudkip', species: 'Mudkip', level: 12, moves: ['Water Gun'],
						nature: 'Hardy', ability: 'Torrent', item: null, ivs: {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31}}]},
				seeds,
				constraints: {zeroDeaths: true, wholeBranch: true},
			},
		},
		receipt: {
			schemaVersion: 'pokemon.bridge.receipt/1.0.0',
			receiptId: evidenceId,
			requestId: 'request-' + evidenceId,
			producer: {repository: 'pokemon-mono', revision: 'fixture-revision',
				engine: 'run-and-bun', engineVersion: '0.1.0'},
			input: {attemptId: ATTEMPT_ID, revision: attemptRevision,
				stateHash: 'not-hash-validated-in-this-fixture', profileRevision: 'rab-profile-fixture-v1', seeds},
			result: {
				status: 'complete', safe: safeBranches === branchesEvaluated,
				summary: {branchesEvaluated, candidatesEvaluated: 1, deaths, losses: deaths,
					safeBranches, trainerOrder, recommendedLeadId, expectedTurns,
					branchOutcomes: seeds.map(seed => ({seed, victory: deaths === 0, deaths, turns: expectedTurns}))},
			},
			evidence: {contractVersion: '1.0.0', deterministic: true,
				replayHash: 'fixture-replay', expectedDivergences: [], unexpectedDivergences: []},
		},
	};
}

function battleCompleted({trainerOrder = 7, revision = 20, victory = true, deaths = 0, turns = 6,
	wild = false, kind = 'battle.ended', contributions} = {}) {
	return {
		attemptId: ATTEMPT_ID,
		revision,
		kind,
		payload: {kind: wild ? 'wild' : 'trainer', trainerOrder,
			outcome: victory ? 'won' : 'lost', deaths: Array.from({length: deaths}, (_, index) => 'mon-' + index),
			turns, leadId: 'mon-treecko', participantIds: ['mon-treecko'],
			contributionVersion: contributions ? 1 : null,
			contributionComplete: Boolean(contributions), contributions: contributions || []},
	};
}

function attributionEvidence({trainerOrder = 7, attemptRevision = 12,
	recordedAt = '2026-08-16T09:40:00.000Z'} = {}) {
	const request = JSON.parse(JSON.stringify(attributionRequestFixture));
	const receipt = JSON.parse(JSON.stringify(attributionReceiptFixture));
	request.task.state.trainer.order = trainerOrder;
	receipt.input.trainerOrder = trainerOrder;
	return {
		id: ATTEMPT_ID + '::' + receipt.receiptId,
		schemaVersion: 'rabrun.evidence/1.0.0', evidenceId: receipt.receiptId,
		attemptId: ATTEMPT_ID, attemptRevision, stateHash: request.attempt.stateHash,
		kind: 'pokemon.rab.attribute', recordedAt, request, receipt,
	};
}

function inspected(evidence, events) {
	return {attemptId: ATTEMPT_ID, evidence, events};
}

function onlyReview(result) {
	assert.equal(result.rows.length, 1);
	return result.rows[0];
}

test('matches the latest pre-battle plan by trainer order and reports actual outcome', () => {
	const review = onlyReview(derivePlanningReview(inspected([
		planEvidence({evidenceId: 'older', recordedAt: '2026-08-16T09:00:00.000Z', safeBranches: 2}),
		planEvidence({evidenceId: 'latest', recordedAt: '2026-08-16T09:30:00.000Z', safeBranches: 4,
			recommendedLeadId: 'mon-mudkip', expectedTurns: 5}),
	], [battleCompleted({revision: 20, victory: true, deaths: 0, turns: 5})])));

	assert.deepEqual(review.plan, {evidenceId: 'latest', trainerOrder: 7, attemptRevision: 10,
		recordedAt: '2026-08-16T09:30:00.000Z', branches: 4, safeBranches: 4,
		deaths: 0, losses: 0, expectedTurns: 5, leadId: 'mon-mudkip', leadSpecies: 'Mudkip'});
	assert.deepEqual(review.actual, {eventId: undefined, revision: 20, trainerOrder: 7,
		trainer: null, result: 'win', deaths: 0, turns: 5, seed: undefined,
		leadId: 'mon-treecko', participantIds: ['mon-treecko'],
		contributionComplete: false, contributions: []});
	assert.equal(review.comparison, 'held');
});

test('uses a later pre-completion re-plan, never a plan recorded after completion', () => {
	const result = derivePlanningReview(inspected([
		planEvidence({evidenceId: 'early', attemptRevision: 10, recordedAt: '2026-08-16T09:00:00.000Z', safeBranches: 1}),
		planEvidence({evidenceId: 'replan', attemptRevision: 15, recordedAt: '2026-08-16T09:30:00.000Z', safeBranches: 4,
			recommendedLeadId: 'mon-mudkip'}),
		planEvidence({evidenceId: 'after', attemptRevision: 21, recordedAt: '2026-08-16T11:00:00.000Z', safeBranches: 0,
			recommendedLeadId: 'mon-poochyena'}),
	], [battleCompleted({revision: 20, victory: true, deaths: 0, turns: 6})]));
	const review = result.rows.find(row => row.actual);

	assert.equal(review.plan.safeBranches, 4);
	assert.equal(review.plan.leadId, 'mon-mudkip');
});

test('calls a safe sampled plan followed by a win with deaths underestimated', () => {
	const review = onlyReview(derivePlanningReview(inspected([
		planEvidence({safeBranches: 4, deaths: 0}),
	], [battleCompleted({victory: true, deaths: 2})])));
	assert.equal(review.comparison, 'underestimated');
});

test('calls a risky sampled plan followed by a deathless win outperformed', () => {
	const review = onlyReview(derivePlanningReview(inspected([
		planEvidence({safeBranches: 2, deaths: 1}),
	], [battleCompleted({victory: true, deaths: 0})])));
	assert.equal(review.comparison, 'outperformed');
});

test('leaves evidence with no matching completion unplayed', () => {
	const review = onlyReview(derivePlanningReview(inspected([
		planEvidence({safeBranches: 4}),
	], [])));
	assert.equal(review.comparison, 'unplayed');
	assert.equal(review.actual, null);
});

test('retains complete realized participation without inferring carry', () => {
	const contributions = [{monId: 'mon-treecko', battleId: 'player-1', species: 'Treecko',
		appearances: 1, switchIns: 0, moveAttempts: 3, opposingHpRemoved: 41, kos: 1},
	{monId: 'mon-mudkip', battleId: 'player-2', species: 'Mudkip',
		appearances: 0, switchIns: 0, moveAttempts: 0, opposingHpRemoved: 0, kos: 0}];
	const review = onlyReview(derivePlanningReview(inspected([], [battleCompleted({contributions})])));

	assert.equal(review.actual.contributionComplete, true);
	assert.deepEqual(review.actual.contributions, [contributions[0]]);
	assert.equal(Object.hasOwn(review.actual.contributions[0], 'carry'), false);
});

test('a malformed contribution row makes the receipt partial', () => {
	const contributions = [{monId: 'mon-treecko', battleId: 'player-1', species: 'Treecko',
		appearances: 1, switchIns: 0, moveAttempts: 3, opposingHpRemoved: -1, kos: 1}];
	const review = onlyReview(derivePlanningReview(inspected([], [battleCompleted({contributions})])));

	assert.equal(review.actual.contributionComplete, false);
	assert.deepEqual(review.actual.contributions, []);
});

test('ignores unrelated, wild, and malformed records without inventing carry', () => {
	const result = derivePlanningReview(inspected([
		planEvidence({safeBranches: 4}),
		{kind: 'pokemon.rab.plan', recordedAt: 'not-a-date', request: {}, receipt: {}},
		{kind: 'pokemon.rab.plan', attemptId: 'other-attempt'},
	], [
		battleCompleted({wild: true}),
		{kind: 'battle.started', payload: {kind: 'trainer', trainerOrder: 99}},
		{kind: 'battle.ended', payload: null},
		{kind: 'battle.ended', payload: {kind: 'trainer', trainerOrder: 7, outcome: 'yes', deaths: [], turns: 6}},
	]));

	assert.equal(result.rows.length, 1);
	assert.equal(result.rows[0].comparison, 'unplayed');
	assert.equal(Object.hasOwn(result.rows[0], 'carry'), false);
});

test('joins fixed-seed modeled value separately from realized participation', () => {
	const review = onlyReview(derivePlanningReview(inspected([
		planEvidence({attemptRevision: 10}), attributionEvidence({attemptRevision: 12}),
	], [battleCompleted({revision: 20, contributions: [{monId: 'owned-treecko-1',
		battleId: 'player-1', species: 'Treecko', appearances: 1, switchIns: 0,
		moveAttempts: 3, opposingHpRemoved: 41, kos: 1}]})])));

	assert.equal(review.attribution.seedCount, 2);
	assert.equal(review.attribution.policy, 'reoptimize-lead-v1');
	assert.equal(review.attribution.tests.length, 2);
	assert.deepEqual(review.attribution.tests.map(row => row.kind),
		['replace-party-member', 'normalize-ivs']);
	assert.equal(review.attribution.tests[0].targetSpecies, 'Mudkip');
	assert.equal(review.attribution.tests[0].replacementSpecies, 'Poochyena');
	assert.equal(review.attribution.tests[0].delta.safeBranches, -1);
	assert.equal(review.actual.contributions.length, 1);
	assert.equal(Object.hasOwn(review, 'carry'), false);
	assert.equal(Object.hasOwn(review.attribution, 'carry'), false);
});

test('retains an attribution-only pre-fight row without calling it historical truth', () => {
	const result = derivePlanningReview(inspected([attributionEvidence()], []));
	const review = onlyReview(result);
	assert.equal(review.plan, null);
	assert.equal(review.actual, null);
	assert.equal(review.attributionCount, 1);
	assert.equal(result.modeled, 1);
	assert.equal(Object.hasOwn(review.attribution.tests[0], 'carry'), false);
});
