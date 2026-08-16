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
