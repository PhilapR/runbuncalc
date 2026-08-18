/* eslint-env node, es6 */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const history = require('../src/js/run_history');
const Store = require('../src/js/attempt_store');

function attempt(id, position, species) {
	return {
		version: 1,
		profileId: 'run-and-bun',
		attemptId: id,
		name: id,
		createdAt: id + '-start',
		position,
		party: species.length ? ['mon-1'] : [],
		box: species.map((name, index) => ({
			id: 'mon-' + (index + 1),
			species: name,
			status: index === 1 ? 'dead' : 'party',
			ivs: index ? {} : {spe: 31},
		})),
		log: [],
	};
}

test('history records preserve the final run and explicit outcome', () => {
	const run = attempt('attempt-1', 77, ['Treecko']);
	const entry = history.record(run, 'wipe', 't1');
	assert.equal(entry.attemptId, 'attempt-1');
	assert.equal(entry.outcome, 'wipe');
	assert.equal(entry.position, 77);
	run.position = 99;
	assert.equal(entry.run.position, 77, 'the archive owns an immutable copy');
});

test('history derives progression and species evidence without claiming carry', () => {
	const first = history.record(attempt('attempt-1', 77, ['Treecko', 'Poochyena']),
		'wipe', 't1');
	const second = history.record(attempt('attempt-2', 139, ['Treecko', 'Croagunk']),
		'reset', 't2');
	const active = attempt('attempt-3', 42, ['Mudkip']);
	const result = history.derive([first, second], active);

	assert.equal(result.tracked, 3);
	assert.equal(result.ended, 2);
	assert.equal(result.active, 1);
	assert.equal(result.wipes, 1);
	assert.equal(result.best.attemptId, 'attempt-2');
	assert.equal(result.medianPosition, 108);
	assert.deepEqual(result.species.find(row => row.species === 'Treecko'), {
		species: 'Treecko', attempts: 2, caught: 2, survived: 2, lost: 0,
		finalParty: 2, bestPosition: 139, knownIvs: 2,
	});
	assert.equal(result.species.find(row => row.species === 'Poochyena').lost, 1);
	assert.equal(Object.hasOwn(result.species[0], 'carry'), false,
		'presence-only history must not manufacture a carry score');
});

test('legacy runs receive a deterministic archive identity', () => {
	const run = attempt(undefined, -1, []);
	delete run.attemptId;
	assert.match(history.attemptId(run), /^legacy-/);
	assert.equal(history.attemptId(run), history.attemptId(run));
});

test('history records point to checked replay evidence instead of copying it again', async () => {
	const run = attempt('evidenced-attempt', 42, ['Treecko']);
	const store = Store.createMemoryStore();
	await store.commit({
		run, expectedRevision: 0, commandId: 'start',
		event: {kind: 'run.started', payload: {run}, observedAt: '2026-08-15T00:00:00.000Z'},
	});
	await store.commit({
		run, expectedRevision: 1, commandId: 'end',
		event: {kind: 'run.ended', payload: {outcome: 'wipe'},
			observedAt: '2026-08-15T00:01:00.000Z'},
	});
	const bundle = await store.exportActive();
	const entry = history.record(run, 'wipe', '2026-08-15T00:01:00.000Z', bundle);
	assert.deepEqual(entry.evidence, {
		format: 'rabrun.archive', modelVersion: '2.0.0', attemptId: 'evidenced-attempt',
		revision: 2, stateHash: bundle.head.stateHash, eventHash: bundle.head.lastEventHash,
		eventCount: 2, checksum: bundle.checksum,
	});
	assert.equal(Object.hasOwn(entry.evidence, 'events'), false,
		'history references the ledger rather than duplicating the event corpus');
});
