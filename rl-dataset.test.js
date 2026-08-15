/* eslint-env node, es6 */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Store = require('./src/js/attempt_store');
const dataset = require('./rl-dataset');

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
	await store.commit({run: advanced, expectedRevision: 3, commandId: 'end',
		event: event('run.ended', {outcome: 'wipe'})});

	const rows = await dataset.materialize(await store.exportActive(), {
		reward: row => row.payload.command.kind === 'tick' ? -1 : 0,
	});
	assert.equal(rows.schemaVersion, '1.0.0');
	assert.equal(rows.episodes[0].outcome, 'wipe');
	assert.equal(rows.episodes[0].revision_count, 4);
	assert.equal(rows.events.length, 4);
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
