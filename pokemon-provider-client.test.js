/* eslint-env node, es6 */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const client = require('./src/js/pokemon_provider_client');

function run() {
	return {
		version: 1,
		profileId: 'run-and-bun',
		attemptId: 'attempt-client-test',
		position: -1,
		party: ['owned-treecko'],
		box: [{
			id: 'owned-treecko', species: 'Treecko', level: 5,
			moves: ['Pound', 'Leer'], nature: 'Jolly', ability: 'Overgrow', item: null,
			ivs: {hp: 12, atk: 7, def: 18, spa: 24, spd: 11, spe: 29},
		}],
		bag: {}, log: [],
	};
}

function receiptFor(request) {
	return {
		schemaVersion: 'pokemon.bridge.receipt/1.0.0',
		requestId: request.requestId,
		producer: {repository: 'pokemon-mono', revision: 'engine-revision'},
		result: {safe: true, summary: {trainerOrder: request.task.state.trainer.order}},
		evidence: {deterministic: true, unexpectedDivergences: []},
	};
}

function runtime(observed) {
	return {
		metadata: {engineRevision: 'engine-revision'},
		provider: {plan: async request => {
			observed.push(request);
			return receiptFor(request);
		}},
	};
}

test('browser request preserves owned IVs and derives stable explicit seeds', async () => {
	const first = await client.createRequest({
		run: run(), trainerOrder: 1, revision: 4, profileRevision: 'engine-revision',
	});
	const second = await client.createRequest({
		run: run(), trainerOrder: 1, revision: 4, profileRevision: 'engine-revision',
	});
	assert.deepEqual(second, first);
	assert.deepEqual(first.task.state.playerTeam[0].ivs,
		{hp: 12, atk: 7, def: 18, spa: 24, spd: 11, spe: 29});
	assert.equal(first.task.seeds.length, 8);
	assert.equal(new Set(first.task.seeds).size, 8);
});

test('browser request refuses legacy Pokemon with unknown IVs', async () => {
	const legacy = run();
	delete legacy.box[0].ivs.spe;
	await assert.rejects(client.createRequest({
		run: legacy, trainerOrder: 1, revision: 4, profileRevision: 'engine-revision',
	}), /needs all six IVs recorded/);
});

test('warm browser batch preserves road order and exact single receipt semantics', async () => {
	const singleCalls = [];
	const batchCalls = [];
	const options = [1, 3, 7].map(trainerOrder => ({
		run: run(), trainerOrder, revision: 4, profileRevision: 'engine-revision',
	}));
	const singles = [];
	for (const option of options) {
		singles.push(await client.planRun(Object.assign({}, option, {runtime: runtime(singleCalls)})));
	}
	const sharedRuntime = runtime(batchCalls);
	const batch = await client.planBatch(options.map(option =>
		Object.assign({}, option, {runtime: sharedRuntime})));

	assert.deepEqual(batch.map(result => result.receipt), singles.map(result => result.receipt));
	assert.deepEqual(batch.map(result => result.request.task.state.trainer.order), [1, 3, 7]);
	assert.deepEqual(batchCalls.map(request => request.requestId),
		batch.map(result => result.request.requestId));
});

test('browser batch is bounded and rejects duplicate requests before provider work', async () => {
	const observed = [];
	const provider = runtime(observed);
	const duplicate = {
		runtime: provider, run: run(), trainerOrder: 1, revision: 4,
		profileRevision: 'engine-revision',
	};
	await assert.rejects(client.planBatch([duplicate, duplicate]), /requestId values must be unique/);
	assert.equal(observed.length, 0);

	const tooMany = Array.from({length: client.MAX_BROWSER_BATCH_REQUESTS + 1}, (_, index) => ({
		runtime: provider, run: run(), trainerOrder: index, revision: 4,
		profileRevision: 'engine-revision',
	}));
	await assert.rejects(client.planBatch(tooMany), /browser batches are capped at 8 fights/);
	assert.equal(observed.length, 0);
});
