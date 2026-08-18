/* eslint-env node, es6 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const legacyEvents = require('../fixtures/runtime-contract/littleroot-replay.json');
const adapter = require('../game-runtime-adapter');
const contract = require('../src/js/runtime_contract');
const Store = require('../src/js/attempt_store');
const runtime = require('../run');

function event(kind, revision, payload, extra) {
	return Object.assign({
		schemaVersion: '2.0.0',
		eventId: `canonical-${revision}`,
		attemptId: 'canonical-attempt',
		profileId: 'run-and-bun',
		revision,
		kind,
		source: {kind: 'manual', providerId: 'test', confidence: 1},
		observedAt: `2026-08-13T12:00:${String(revision).padStart(2, '0')}Z`,
		payload,
	}, extra);
}

function canonicalFixture() {
	return [
		event('run.started', 0, {name: 'Canonical contract slice', permadeath: true}),
		event('pokemon.caught', 1, {capture: {species: 'Treecko', level: 5, nickname: 'Twig'}}),
		event('party.changed', 2, {partyInstanceIds: ['mon-1']}),
		event('bag.changed', 3, {item: 'Poke Ball', delta: 5}),
		event('snapshot.observed', 4, {scene: {mode: 'overworld',
			map: {id: 'rab:route-101'}, position: {x: 8, y: 19}, activeObjects: []}}, {
			source: {kind: 'emulator', providerId: 'mgba-libretro-rab', confidence: 0.8,
				frame: 1234, romFingerprint: 'sha256:fixture'},
		}),
		event('pokemon.caught', 5, {capture: {species: 'Poochyena', map: 'Route101', level: 3, nickname: 'Scout'}}),
		event('party.changed', 6, {partyInstanceIds: ['mon-1', 'mon-2']}),
		event('bag.changed', 7, {item: 'Poke Ball', delta: -1}),
	];
}

test('canonical v2 replay projects commands and preserves evidence provenance', () => {
	const first = adapter.replay(canonicalFixture());
	const second = adapter.replay(canonicalFixture());

	assert.deepEqual(first, second);
	assert.equal(first.cursor.attemptId, 'canonical-attempt');
	assert.equal(first.cursor.revision, 7);
	assert.equal(first.cursor.schemaVersion, '2.0.0');
	assert.equal(first.run.attemptId, 'canonical-attempt');
	assert.equal(first.run.name, 'Canonical contract slice');
	assert.deepEqual(first.run.party, ['mon-1', 'mon-2']);
	assert.deepEqual(first.run.box.map(mon => [mon.species, mon.nickname]), [
		['Treecko', 'Twig'], ['Poochyena', 'Scout'],
	]);
	assert.equal(first.run.bag['Poke Ball'], 4);
	assert.equal(first.evidence.length, 8);
	assert.equal(first.evidence[4].source.frame, 1234);
	assert.equal(first.evidence[4].source.romFingerprint, 'sha256:fixture');
	assert.equal(first.applied[1].source.providerId, 'test');
	assert.deepEqual(first.observedOnly.map(entry => entry.kind), ['snapshot.observed']);
	assert.equal(Object.hasOwn(first, 'ledger'), false,
		'public replay must not expose the internal persistence ledger');
	assert.equal(adapter.project(canonicalFixture()).ledger.length, 14,
		'internal projection retains source and derived command rows for persistence');
});

test('legacy envelope and event aliases normalize explicitly into canonical v2', () => {
	const result = adapter.replay(legacyEvents);

	assert.equal(result.cursor.attemptId, 'rab-fixture-001');
	assert.equal(result.cursor.revision, 7);
	assert.equal(result.run.attemptId, 'rab-fixture-001');
	assert.deepEqual(result.observedOnly.map(entry => entry.kind), ['snapshot.observed']);
	assert.equal(result.observedOnly[0].compatibility.originalKind, 'world.changed');
	assert.deepEqual(adapter.normalizeEvent(legacyEvents[2]).kind, 'party.changed');
	assert.deepEqual(adapter.normalizeEvent(legacyEvents[3]).kind, 'bag.changed');
	assert.deepEqual(adapter.normalizeEvent(legacyEvents[1]).kind, 'pokemon.caught');
	assert.deepEqual(adapter.normalizeEvent(Object.assign({}, legacyEvents[4], {
		kind: 'battle.observed',
	})).kind, 'snapshot.observed');
});

test('model registry and executable registry are identical', () => {
	const model = JSON.parse(fs.readFileSync(
		path.join(__dirname, '..', 'profiles/run-and-bun/rebuild-model.json'), 'utf8'));
	assert.equal(model.schemaVersion, '2.0.0');
	assert.deepEqual(model.events, adapter.EVENT_KINDS);
	assert.deepEqual(adapter.EVENT_KINDS, contract.EVENT_KINDS);
	assert.deepEqual(adapter.SOURCE_KINDS, [
		'manual', 'emulator', 'simulator', 'rebuilt', 'import', 'migration', 'system',
	]);
});

test('canonical envelope validates source union and sequencing', () => {
	const start = event('run.started', 0, {name: 'Validation'});
	assert.doesNotThrow(() => adapter.validateEvent(start));

	const missingAttempt = Object.assign({}, start, {attemptId: undefined});
	assert.throws(() => adapter.validateEvent(missingAttempt), /attemptId is required/);
	const badSource = Object.assign({}, start, {
		source: {kind: 'unknown', providerId: 'test', confidence: 1},
	});
	assert.throws(() => adapter.validateEvent(badSource), /source\.kind/);
	const badConfidence = Object.assign({}, start, {
		source: {kind: 'manual', providerId: 'test', confidence: 2},
	});
	assert.throws(() => adapter.validateEvent(badConfidence), /confidence/);
	const bothCursors = Object.assign({}, start, {sourceSequence: 42});
	assert.doesNotThrow(() => adapter.validateEvent(bothCursors),
		'persisted evidence keeps its upstream source cursor beside the ledger revision');
	const noCursor = Object.assign({}, start, {revision: undefined});
	assert.throws(() => adapter.validateEvent(noCursor), /revision or sourceSequence/);

	const sourceSequenceEvents = [
		Object.assign({}, start, {revision: undefined, sourceSequence: 10}),
		event('snapshot.observed', 11, {scene: {mode: 'overworld'}}),
	];
	const result = adapter.replay(sourceSequenceEvents);
	assert.equal(result.cursor.revision, 11);
	assert.equal(result.cursor.sequence, 11);
});

test('run.ended returns a lifecycle outcome and closes the replay', () => {
	const result = adapter.replay([
		event('run.started', 0, {name: 'Outcome'}),
		event('run.ended', 1, {outcome: 'wipe', reason: 'team fainted'}, {
			source: {kind: 'system', providerId: 'test-lifecycle', confidence: 1},
		}),
	]);

	assert.deepEqual(result.outcome, {
		status: 'wipe',
		eventId: 'canonical-1',
		attemptId: 'canonical-attempt',
		profileId: 'run-and-bun',
		revision: 1,
		source: {kind: 'system', providerId: 'test-lifecycle', confidence: 1},
		observedAt: '2026-08-13T12:00:01Z',
		payload: {outcome: 'wipe', reason: 'team fainted'},
	});
	assert.throws(() => adapter.replay([
		event('run.started', 0, {name: 'Outcome'}),
		event('run.ended', 1, {outcome: 'wipe'}),
		event('snapshot.observed', 2, {scene: {mode: 'title'}}),
	]), /cannot follow run\.ended/);
});

test('scene and battle observations have explicit serializable boundaries', () => {
	assert.doesNotThrow(() => contract.validateSceneState({
		mode: 'battle', map: {id: 'rab:route-101', group: 0, number: 16},
		position: {x: 8, y: 19}, activeObjects: [],
	}));
	assert.doesNotThrow(() => contract.validateBattleObservation({
		battleId: 'battle-1', phase: 'choice', turn: 3,
		participants: [{instanceId: 'mon-1', hp: 19, status: null}],
		field: {}, pendingInput: {actorId: 'mon-1'},
	}));
	assert.throws(() => adapter.validateEvent(event('snapshot.observed', 1, {
		scene: {mode: 'overworld', position: {x: 1.5, y: 2}},
	})), /position x and y must be integers/);
	assert.throws(() => adapter.validateEvent(event('snapshot.observed', 1, {})),
		/requires scene or battle/);
});

test('canonical evidence persists directly into a replayable attempt ledger', async () => {
	const store = Store.createMemoryStore();
	const persisted = await adapter.persist(store, canonicalFixture());
	assert.equal(persisted.run.attemptId, 'canonical-attempt');
	assert.equal(persisted.receipts.length, 14,
		'eight source events plus six projected commands are preserved');
	const bundle = await store.exportActive();
	assert.equal(await store.validateBundle(bundle), true);
	assert.equal(bundle.events.filter(row => row.kind === 'command.applied').length, 6);
	assert.equal(bundle.events.find(row => row.kind === 'snapshot.observed').source.kind,
		'emulator');
	assert.equal(bundle.events.find(row => row.kind === 'command.applied')
		.payload.causedByEventId, 'canonical-1');
	const replayed = await store.replayBundle(bundle, (runState, command, eventRow) =>
		runtime.apply(runState, command, {now: eventRow.observedAt}));
	assert.deepEqual(replayed.run, persisted.run);
});

test('replay rejects unsupported versions and out-of-order evidence', () => {
	const badVersion = event('run.started', 0, {name: 'Bad'});
	badVersion.schemaVersion = '3.0.0';
	assert.throws(() => adapter.replay([badVersion]), /unsupported schemaVersion/);

	const duplicate = canonicalFixture();
	duplicate[2] = Object.assign({}, duplicate[2], {revision: duplicate[1].revision});
	assert.throws(() => adapter.replay(duplicate), /must be strictly ordered/);
});
