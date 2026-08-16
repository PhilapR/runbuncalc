/* eslint-env node, es6 */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const bridge = require('./pokemon-bridge');
const runtime = require('./run');

const HASH = 'a'.repeat(64);
const IVS = {hp: 12, atk: 7, def: 18, spa: 24, spd: 11, spe: 29};

function playableRun() {
	let run = runtime.createRun({attemptId: 'attempt_seed_1450', now: 't0'});
	run = runtime.apply(run, {kind: 'catch', species: 'Treecko', level: 5,
		moves: ['Pound', 'Leer'], nature: 'Hardy', ability: 'Overgrow', ivs: IVS});
	return runtime.apply(run, {kind: 'party', ids: ['mon-1']});
}

function request(run) {
	return bridge.createPlanningRequest({
		run, requestId: 'req_first_fight_seed_1450', revision: 42, stateHash: HASH,
		profileRevision: 'rab-profile-fixture-v1', trainerOrder: 1, seeds: [1450],
	});
}

function receipt() {
	return require('./contracts/ecosystem/v1/planning-receipt.json');
}

test('a run becomes a pinned planning DTO with owned IVs intact', () => {
	const result = request(playableRun());
	assert.equal(result.schemaVersion, bridge.REQUEST_SCHEMA);
	assert.equal(result.capability, 'pokemon.rab.plan');
	assert.equal(result.task.state.trainer.order, 1);
	assert.deepEqual(result.task.state.playerTeam[0], {
		id: 'mon-1', species: 'Treecko', level: 12, nature: 'Hardy', ability: 'Overgrow',
		item: null, moves: ['Pound', 'Leer'], ivs: IVS,
	});
	assert.deepEqual(result.task.seeds, [1450]);
	assert.deepEqual(result.task.constraints, {zeroDeaths: true, wholeBranch: true});
});

test('a legacy owned Pokemon with missing IVs cannot cross the bridge', () => {
	const run = playableRun();
	delete run.box[0].ivs.spe;
	assert.throws(() => request(run), /missing player IVs: Speed/);
});

test('the recorded provider receipt binds to the exact request', () => {
	const source = request(playableRun());
	assert.equal(bridge.validatePlanningReceipt(source, receipt()), receipt());
});

test('tampered or nondeterministic receipts are refused', () => {
	const source = request(playableRun());
	const wrongState = JSON.parse(JSON.stringify(receipt()));
	wrongState.input.stateHash = 'd'.repeat(64);
	assert.throws(() => bridge.validatePlanningReceipt(source, wrongState), /input does not match/);
	const nondeterministic = JSON.parse(JSON.stringify(receipt()));
	nondeterministic.evidence.deterministic = false;
	assert.throws(() => bridge.validatePlanningReceipt(source, nondeterministic), /not deterministic/);
});

test('the preferred path invokes an imported provider in the same process', async () => {
	let observed;
	const provider = {
		plan: async request => {
			observed = request;
			return receipt();
		},
	};
	const result = await bridge.planWithProvider(provider, {
		run: playableRun(), requestId: 'req_first_fight_seed_1450', revision: 42,
		stateHash: HASH, profileRevision: 'rab-profile-fixture-v1', trainerOrder: 1,
		seeds: [1450],
	});
	assert.equal(observed.task.state.playerTeam[0].ivs.spe, 29);
	assert.equal(result.producer.repository, 'pokemon-mono');
});
