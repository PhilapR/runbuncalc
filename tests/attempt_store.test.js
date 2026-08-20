/* eslint-env node */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Store = require('../src/js/attempt_store.js');
const runtime = require('../lib/run');
const adapter = require('../lib/game-runtime-adapter');
const littleroot = require('../fixtures/runtime-contract/littleroot-replay.json');
const legacyArchive = require('../fixtures/runtime-contract/rabrun-archive-v1.json');
const planningRequest = require('../contracts/ecosystem/v1/planning-request.json');
const planningReceipt = require('../contracts/ecosystem/v1/seeded-provider-receipt.json');
const attributionRequest = require('../contracts/ecosystem/v1/attribution-request.json');
const attributionReceipt = require('../contracts/ecosystem/v1/attribution-receipt.json');
const TIME = '2026-08-15T00:00:00.000Z';

function sortValue(value) {
	if (Array.isArray(value)) return value.map(sortValue);
	if (!value || typeof value !== 'object') return value;
	const sorted = {};
	Object.keys(value).sort().forEach(key => { sorted[key] = sortValue(value[key]); });
	return sorted;
}

function canonical(value) {
	return JSON.stringify(sortValue(value));
}

function rechecksum(bundle) {
	const result = JSON.parse(JSON.stringify(bundle));
	delete result.checksum;
	delete result.integrity;
	result.checksum = crypto.createHash('sha256').update(canonical(result), 'utf8').digest('hex');
	return result;
}

function run(id, value) {
	return {attemptId: id, value, updatedAt: '2026-08-15T00:00:00.000Z'};
}

function event(kind, payload) {
	return {kind, payload, observedAt: '2026-08-15T00:00:00.000Z'};
}

async function started(store, id = 'attempt-1') {
	return store.commit({
		run: run(id, 0), expectedRevision: 0, commandId: 'start-1',
		event: event('run.started', {snapshot: run(id, 0)}),
	});
}

test('revision, duplicate command, and optimistic conflict are atomic', async () => {
	const store = Store.createMemoryStore();
	const first = await started(store);
	assert.equal(first.revision, 1);
	assert.match(first.stateHash, /^[a-f0-9]{64}$/);
	const duplicate = await store.commit({
		run: run('attempt-1', 0), expectedRevision: 0, commandId: 'start-1',
		event: event('run.started', {snapshot: run('attempt-1', 0)}),
	});
	assert.equal(duplicate.duplicate, true);
	assert.equal(duplicate.revision, 1);
	await assert.rejects(() => store.commit({
		run: run('attempt-1', 2), expectedRevision: 0, commandId: 'change-1',
		event: event('command.applied', {command: {value: 2}}),
	}), error => error.code === 'REVISION_CONFLICT');
	const second = await store.commit({
		run: run('attempt-1', 1), expectedRevision: 1, commandId: 'change-1',
		event: event('command.applied', {command: {value: 1}}),
	});
	assert.equal(second.revision, 2);
	const oldRetry = await store.commit({
		run: run('attempt-1', 0), expectedRevision: 0, commandId: 'start-1',
		event: event('run.started', {snapshot: run('attempt-1', 0)}),
	});
	assert.equal(oldRetry.duplicate, true);
	assert.equal(oldRetry.run, null,
		'an old idempotency receipt must not pair its revision with a newer run head');
});

test('a retried command with a fresh observedAt is the same command', async () => {
	// The panel stamps observedAt at send time, so an honest retry of the
	// same commandId never carries the same wall clock. The idempotency
	// record exists exactly for that retry; it must answer with the stored
	// receipt, not a conflict.
	const store = Store.createMemoryStore();
	await started(store);
	const retried = await store.commit({
		run: run('attempt-1', 0), expectedRevision: 0, commandId: 'start-1',
		event: {kind: 'run.started', payload: {snapshot: run('attempt-1', 0)},
			observedAt: '2026-08-15T09:59:59.000Z'},
	});
	assert.equal(retried.duplicate, true,
		'a retry that differs only in observedAt must return the stored receipt');
	assert.equal(retried.revision, 1);
	// A genuinely different command under a reused id is still a conflict.
	await assert.rejects(() => store.commit({
		run: run('attempt-1', 1), expectedRevision: 0, commandId: 'start-1',
		event: event('run.started', {snapshot: run('attempt-1', 1)}),
	}), error => error.code === 'IDEMPOTENCY_CONFLICT');
});

test('a rejected import leaves the target attempt untouched', async () => {
	const target = Store.createMemoryStore();
	const request = JSON.parse(JSON.stringify(planningRequest));
	const receipt = JSON.parse(JSON.stringify(planningReceipt));
	request.attempt.revision = 1;
	receipt.input.revision = 1;
	await started(target, request.attempt.attemptId);
	const head = await target.loadActive();
	request.attempt.stateHash = head.stateHash;
	receipt.input.stateHash = head.stateHash;
	await target.recordEvidence({request, receipt, recordedAt: TIME});
	const before = await target.listEvidence(request.attempt.attemptId);

	// A second store with the same attempt records a CONFLICTING copy of the
	// same receipt id plus one genuinely new receipt — a bundle whose import
	// must be refused as a whole.
	const other = Store.createMemoryStore();
	await started(other, request.attempt.attemptId);
	const conflicting = JSON.parse(JSON.stringify(receipt));
	conflicting.result.safe = !conflicting.result.safe;
	await other.recordEvidence({request, receipt: conflicting, recordedAt: TIME});
	const fresh = JSON.parse(JSON.stringify(receipt));
	fresh.receiptId = receipt.receiptId + '-second';
	await other.recordEvidence({request, receipt: fresh, recordedAt: TIME});
	const bundle = await other.exportActive();
	// The new record first, the conflicting one last: a one-pass importer
	// writes the prefix before it notices the conflict.
	bundle.evidence.sort((a, b) =>
		(a.evidenceId.endsWith('-second') ? 0 : 1) - (b.evidenceId.endsWith('-second') ? 0 : 1));
	const reordered = rechecksum(bundle);

	await assert.rejects(() => target.importBundle(reordered),
		error => error.code === 'EVIDENCE_CONFLICT');
	assert.deepEqual(await target.listEvidence(request.attempt.attemptId), before,
		'a refused import must not keep any prefix of its evidence');
});

test('the restore chooser never lets a stale durable head eat a newer mirror', () => {
	const head = {attemptId: 'a1', revision: 3,
		run: {attemptId: 'a1', log: [1, 2, 3], updatedAt: TIME}};
	const aheadMirror = {attemptId: 'a1', log: [1, 2, 3, 4], updatedAt: TIME};
	const behindMirror = {attemptId: 'a1', log: [1, 2], updatedAt: TIME};
	assert.deepEqual(Store.chooseRestoreSource(null, aheadMirror),
		{source: 'mirror', parked: null});
	assert.deepEqual(Store.chooseRestoreSource(head, null),
		{source: 'durable', parked: null});
	assert.deepEqual(Store.chooseRestoreSource(head, behindMirror),
		{source: 'durable', parked: null});
	assert.deepEqual(Store.chooseRestoreSource(head, aheadMirror),
		{source: 'mirror', parked: 'durable'},
		'a mirror with commands the durable store never saw must win and park the head');
	const otherAttempt = {attemptId: 'a2', log: [1, 2, 3, 4, 5], updatedAt: TIME};
	assert.deepEqual(Store.chooseRestoreSource(head, otherAttempt),
		{source: 'durable', parked: 'mirror'},
		'a mirror from a different attempt is parked, not silently destroyed');
});

test('export includes a portable checksum and rejects corruption', async () => {
	const store = Store.createMemoryStore();
	await started(store);
	const bundle = await store.exportActive();
	assert.equal(bundle.format, 'rabrun.archive');
	assert.equal(bundle.schema, 'rabrun.archive');
	assert.equal(bundle.version, 1);
	assert.match(bundle.checksum, /^[a-f0-9]{64}$/);
	assert.equal(bundle.manifest.headStateHash, bundle.head.stateHash);
	assert.match(bundle.head.stateHash, /^[a-f0-9]{64}$/);
	assert.equal(await store.validateBundle(bundle), true);
	const corrupted = JSON.parse(JSON.stringify(bundle));
	corrupted.head.run.value = 99;
	corrupted.run.value = 99;
	await assert.rejects(() => store.validateBundle(corrupted), error => error.code === 'CORRUPT_BUNDLE');
	await assert.rejects(() => store.validateBundle(rechecksum(corrupted)),
		error => error.code === 'CORRUPT_STATE');
	const nested = Store.createMemoryStore();
	await nested.commit({
		run: run('nested', 0), expectedRevision: 0, commandId: 'start-nested',
		event: event('run.started', {run: run('nested', 0), checksum: 'source-evidence'}),
	});
	const nestedBundle = await nested.exportActive();
	nestedBundle.events[0].payload.checksum = 'tampered';
	await assert.rejects(() => nested.validateBundle(nestedBundle),
		error => error.code === 'CORRUPT_BUNDLE');
});

test('planning receipts are content-addressed evidence, not run revisions', async () => {
	const store = Store.createMemoryStore();
	const request = JSON.parse(JSON.stringify(planningRequest));
	const receipt = JSON.parse(JSON.stringify(planningReceipt));
	request.attempt.revision = 1;
	receipt.input.revision = 1;
	await started(store, request.attempt.attemptId);
	const before = await store.loadActive();
	request.attempt.stateHash = before.stateHash;
	receipt.input.stateHash = before.stateHash;
	const first = await store.recordEvidence({
		request, receipt, recordedAt: TIME,
	});
	assert.equal(first.duplicate, false);
	assert.equal(first.schemaVersion, Store.EVIDENCE_SCHEMA);
	assert.match(first.evidenceHash, /^[a-f0-9]{64}$/);
	assert.equal((await store.loadActive()).revision, before.revision,
		'read-only planning evidence must not advance game state');

	const duplicate = await store.recordEvidence({
		request, receipt, recordedAt: '2026-08-16T01:00:00.000Z',
	});
	assert.equal(duplicate.duplicate, true);
	assert.equal((await store.listEvidence(request.attempt.attemptId)).length, 1);

	const bundle = await store.exportActive();
	assert.equal(bundle.manifest.evidenceCount, 1);
	assert.equal(bundle.evidence[0].receipt.receiptId, receipt.receiptId);
	assert.equal(await store.validateBundle(bundle), true);
	const restarted = Store.createMemoryStore();
	await restarted.importBundle(bundle);
	assert.deepEqual(await restarted.listEvidence(request.attempt.attemptId),
		bundle.evidence);

	const corrupted = JSON.parse(JSON.stringify(bundle));
	corrupted.evidence[0].receipt.result.safe = !corrupted.evidence[0].receipt.result.safe;
	await assert.rejects(() => store.validateBundle(rechecksum(corrupted)),
		error => error.code === 'CORRUPT_EVIDENCE');

	const conflictingReceipt = JSON.parse(JSON.stringify(receipt));
	conflictingReceipt.result.safe = !conflictingReceipt.result.safe;
	await assert.rejects(() => store.recordEvidence({
		request, receipt: conflictingReceipt, recordedAt: TIME,
	}), error => error.code === 'EVIDENCE_CONFLICT');
});

test('planning evidence batches are atomic and preserve caller order', async () => {
	const store = Store.createMemoryStore();
	const request = JSON.parse(JSON.stringify(planningRequest));
	const receipt = JSON.parse(JSON.stringify(planningReceipt));
	request.attempt.revision = 1;
	receipt.input.revision = 1;
	await started(store, request.attempt.attemptId);
	const head = await store.loadActive();
	request.attempt.stateHash = head.stateHash;
	receipt.input.stateHash = head.stateHash;
	const secondRequest = JSON.parse(JSON.stringify(request));
	const secondReceipt = JSON.parse(JSON.stringify(receipt));
	secondRequest.requestId += '-second';
	secondReceipt.requestId = secondRequest.requestId;
	secondReceipt.receiptId += '-second';
	const records = await store.recordEvidenceBatch([
		{request, receipt, recordedAt: TIME},
		{request: secondRequest, receipt: secondReceipt, recordedAt: TIME},
	]);
	assert.deepEqual(records.map(record => record.receipt.requestId),
		[request.requestId, secondRequest.requestId]);
	assert.deepEqual(records.map(record => record.duplicate), [false, false]);

	const thirdRequest = JSON.parse(JSON.stringify(request));
	const thirdReceipt = JSON.parse(JSON.stringify(receipt));
	thirdRequest.requestId += '-third';
	thirdReceipt.requestId = thirdRequest.requestId;
	thirdReceipt.receiptId += '-third';
	const conflict = JSON.parse(JSON.stringify(receipt));
	conflict.result.safe = !conflict.result.safe;
	await assert.rejects(() => store.recordEvidenceBatch([
		{request: thirdRequest, receipt: thirdReceipt, recordedAt: TIME},
		{request, receipt: conflict, recordedAt: TIME},
	]), error => error.code === 'EVIDENCE_CONFLICT');
	assert.equal((await store.listEvidence(request.attempt.attemptId)).length, 2,
		'a rejected batch must not retain its non-conflicting prefix');
});

test('attribution evidence is immutable and replacement tests require the exact catch event', async () => {
	const store = Store.createMemoryStore();
	const request = JSON.parse(JSON.stringify(attributionRequest));
	const receipt = JSON.parse(JSON.stringify(attributionReceipt));
	await started(store, request.attempt.attemptId);
	const caught = await store.commit({
		run: run(request.attempt.attemptId, 1), expectedRevision: 1,
		commandId: 'catch-route-101',
		event: event('command.applied', {command: {kind: 'catch', species: 'Poochyena', level: 5},
			result: {pokemonId: 'owned-poochyena-1'}}),
	});
	request.attempt.revision = caught.revision;
	request.attempt.stateHash = caught.stateHash;
	receipt.input.revision = caught.revision;
	receipt.input.stateHash = caught.stateHash;
	request.task.interventions[0].ownership = {
		sourceEventId: caught.event.eventId, sourceEventHash: caught.event.eventHash,
		acquiredRevision: caught.revision,
	};

	const saved = await store.recordEvidence({request, receipt, recordedAt: TIME});
	assert.equal(saved.kind, 'pokemon.rab.attribute');
	assert.equal(saved.duplicate, false);
	assert.match(saved.evidenceHash, /^[a-f0-9]{64}$/);
	assert.equal((await store.loadActive()).revision, 2,
		'attribution evidence must not advance game state');
	assert.equal(await store.validateBundle(await store.exportActive()), true);

	const forgedRequest = JSON.parse(JSON.stringify(request));
	const forgedReceipt = JSON.parse(JSON.stringify(receipt));
	forgedRequest.requestId += '-forged';
	forgedReceipt.requestId = forgedRequest.requestId;
	forgedReceipt.receiptId += '-forged';
	forgedRequest.task.interventions[0].ownership.sourceEventHash = 'f'.repeat(64);
	await assert.rejects(store.recordEvidence({request: forgedRequest,
		receipt: forgedReceipt, recordedAt: TIME}),
	error => error.code === 'INVALID_EVIDENCE' && /acquisition event/.test(error.message));

	const wrongBranchRequest = JSON.parse(JSON.stringify(request));
	const wrongBranchReceipt = JSON.parse(JSON.stringify(receipt));
	wrongBranchRequest.requestId += '-wrong-branch';
	wrongBranchReceipt.requestId = wrongBranchRequest.requestId;
	wrongBranchReceipt.receiptId += '-wrong-branch';
	wrongBranchReceipt.result.interventions[0].outcome.branchOutcomes[0].seed += 1;
	await assert.rejects(() => store.recordEvidence({request: wrongBranchRequest,
		receipt: wrongBranchReceipt, recordedAt: TIME}),
	error => error.code === 'INVALID_EVIDENCE' && /intervention result/.test(error.message));

	const wrongDeltaRequest = JSON.parse(JSON.stringify(request));
	const wrongDeltaReceipt = JSON.parse(JSON.stringify(receipt));
	wrongDeltaRequest.requestId += '-wrong-delta';
	wrongDeltaReceipt.requestId = wrongDeltaRequest.requestId;
	wrongDeltaReceipt.receiptId += '-wrong-delta';
	wrongDeltaReceipt.result.interventions[0].delta.deaths = '1';
	await assert.rejects(() => store.recordEvidence({request: wrongDeltaRequest,
		receipt: wrongDeltaReceipt, recordedAt: TIME}),
	error => error.code === 'INVALID_EVIDENCE' && /intervention result/.test(error.message));
	assert.equal((await store.listEvidence(request.attempt.attemptId)).length, 1);
});

test('long attempts checkpoint every 50 revisions with content-addressed states', async () => {
	const store = Store.createMemoryStore();
	await started(store, 'long-run');
	for (let revision = 2; revision <= Store.SNAPSHOT_INTERVAL; revision++) {
		await store.commit({
			run: run('long-run', revision - 1),
			expectedRevision: revision - 1,
			commandId: 'command-' + revision,
			event: event('command.applied', {command: {value: revision - 1}}),
		});
	}
	const inspected = await store.inspectAttempt('long-run');
	assert.deepEqual(inspected.snapshots.map(snapshot => snapshot.revision), [1, 50]);
	assert.equal(inspected.snapshots[1].stateHash, inspected.head.stateHash);
	assert.equal(inspected.events[49].previousStateHash, inspected.events[48].stateHash);
	assert.equal(inspected.events[49].stateHash, inspected.head.stateHash);
	assert.equal(await store.validateBundle(await store.exportActive()), true);
});

test('an interval checkpoint records the accepted run, not whatever the payload carries', async () => {
	const store = Store.createMemoryStore();
	await started(store, 'long-run');
	for (let revision = 2; revision < Store.SNAPSHOT_INTERVAL; revision++) {
		await store.commit({
			run: run('long-run', revision - 1),
			expectedRevision: revision - 1,
			commandId: 'command-' + revision,
			event: event('command.applied', {command: {value: revision - 1}}),
		});
	}
	// The 50th commit is an ordinary command whose payload happens to carry
	// a `state` key. Only lifecycle kinds may source a snapshot from their
	// payload; an interval checkpoint must record the accepted run.
	await store.commit({
		run: run('long-run', 49), expectedRevision: 49, commandId: 'command-50',
		event: event('command.applied',
			{command: {value: 49}, state: {attemptId: 'long-run', value: -777}}),
	});
	const inspected = await store.inspectAttempt('long-run');
	const checkpoint = inspected.snapshots.find(snapshot => snapshot.revision === 50);
	assert.deepEqual(checkpoint.run, run('long-run', 49),
		'the interval checkpoint must be the accepted run state');
	assert.equal(checkpoint.stateHash, inspected.head.stateHash);
});

test('verifyInspection proves the stored chain instead of rewriting it', async () => {
	const store = Store.createMemoryStore();
	await started(store);
	await store.commit({
		run: run('attempt-1', 1), expectedRevision: 1, commandId: 'change-1',
		event: event('command.applied', {command: {value: 1}}),
	});
	const healthy = await store.inspectAttempt('attempt-1');
	await Store.verifyInspection(healthy);

	const tamperedEvent = JSON.parse(JSON.stringify(healthy));
	tamperedEvent.events[1].payload.command.value = 999;
	await assert.rejects(() => Store.verifyInspection(tamperedEvent),
		error => error.code === 'CORRUPT_EVENT');

	const tamperedState = JSON.parse(JSON.stringify(healthy));
	tamperedState.head.run.value = 999;
	await assert.rejects(() => Store.verifyInspection(tamperedState),
		error => error.code === 'CORRUPT_STATE');

	const brokenLink = JSON.parse(JSON.stringify(healthy));
	brokenLink.events[1].previousEventHash = brokenLink.events[1].eventHash;
	await assert.rejects(() => Store.verifyInspection(brokenLink),
		error => error.code === 'CORRUPT_EVENT');
});

test('planning evidence must bind to a real revision, and says so', async () => {
	const store = Store.createMemoryStore();
	const request = JSON.parse(JSON.stringify(planningRequest));
	const receipt = JSON.parse(JSON.stringify(planningReceipt));
	await started(store, request.attempt.attemptId);
	const head = await store.loadActive();
	request.attempt.revision = 0;
	receipt.input.revision = 0;
	request.attempt.stateHash = head.stateHash;
	receipt.input.stateHash = head.stateHash;
	// Revisions start at 1, so evidence bound to revision 0 can never match
	// an event. The schema check must refuse it up front rather than letting
	// the state check blame the receipt for a mismatch it was told was legal.
	await assert.rejects(() => store.recordEvidence({request, receipt, recordedAt: TIME}),
		error => error.code === 'INVALID_EVIDENCE' && /revision/.test(error.message) &&
			!/does not match its bound/.test(error.message));
});

test('replay applies snapshots and command.applied events', async () => {
	const store = Store.createMemoryStore();
	await started(store);
	await store.commit({
		run: run('attempt-1', 3), expectedRevision: 1, commandId: 'change-1',
		event: event('command.applied', {command: {delta: 3}}),
	});
	const bundle = await store.exportAttempt('attempt-1');
	const replayed = await store.replayBundle(bundle, (current, command) => run(current.attemptId, current.value + command.delta));
	assert.deepEqual(replayed.run, run('attempt-1', 3));
	await assert.rejects(
		() => store.replayBundle(bundle,
			(current, command) => run(current.attemptId, current.value + command.delta + 1)),
		error => error.code === 'REPLAY_MISMATCH');
});

test('export/import survives a fresh store and is idempotent', async () => {
	const original = Store.createMemoryStore();
	await started(original, 'restartable');
	const bundle = await original.exportAttempt('restartable');
	const restarted = Store.createMemoryStore();
	const imported = await restarted.importBundle(bundle);
	assert.equal(imported.revision, 1);
	assert.deepEqual((await restarted.loadActive()).run, run('restartable', 0));
	const retriedCommand = await restarted.commit({
		run: run('restartable', 0), expectedRevision: 0, commandId: 'start-1',
		event: event('run.started', {snapshot: run('restartable', 0)}),
	});
	assert.equal(retriedCommand.duplicate, true, 'restart imports idempotency receipts');
	const again = await restarted.importBundle(bundle);
	assert.equal(again.duplicate, true);
});

test('legacy archives upcast losslessly and idempotently into Model v2', async () => {
	const store = Store.createMemoryStore();
	assert.equal(await store.validateBundle(legacyArchive), true);
	const first = await store.importBundle(legacyArchive);
	assert.equal(first.duplicate, false);
	const upgraded = await store.exportAttempt('legacy-attempt');
	assert.equal(upgraded.modelVersion, '2.0.0');
	assert.equal(upgraded.head.run.value, legacyArchive.head.run.value);
	assert.equal(upgraded.events[0].source.kind, 'migration');
	assert.match(upgraded.events[1].eventHash, /^[a-f0-9]{64}$/);
	assert.equal(Object.hasOwn(upgraded.idempotency[1], 'run'), false);
	assert.equal(await store.validateBundle(upgraded), true);
	const second = await store.importBundle(legacyArchive);
	assert.equal(second.duplicate, true);
	assert.deepEqual((await store.loadActive()).run, legacyArchive.head.run);
});

test('a legacy archive that cannot upcast validly is refused before anything is written', async () => {
	// (a) No snapshots: the upcast strips the lifecycle payload but has no
	// snapshot to carry the command log, so its own validator can never
	// accept the result — importing it would create an attempt that can
	// never export again.
	const noSnapshots = JSON.parse(JSON.stringify(legacyArchive));
	noSnapshots.snapshots = [];
	noSnapshots.manifest.snapshotCount = 0;
	const storeA = Store.createMemoryStore();
	await assert.rejects(() => storeA.importBundle(rechecksum(noSnapshots)),
		error => error.code === 'UNSUPPORTED_VERSION');
	assert.equal(await storeA.loadActive(), null, 'a refused upcast must write nothing');

	// (b) An idempotency receipt bound to a revision with no event resolves
	// to an undefined stateHash in the upcast.
	const orphan = JSON.parse(JSON.stringify(legacyArchive));
	orphan.idempotency.push({id: 'legacy-attempt::orphan', attemptId: 'legacy-attempt',
		commandId: 'orphan', fingerprint: 'legacy-orphan', revision: 99});
	orphan.manifest.idempotencyCount = orphan.idempotency.length;
	const storeB = Store.createMemoryStore();
	await assert.rejects(() => storeB.importBundle(rechecksum(orphan)),
		error => error.code === 'UNSUPPORTED_VERSION');
	assert.equal(await storeB.loadActive(), null, 'a refused upcast must write nothing');
});

test('event tampering is rejected even after the outer checksum is recomputed', async () => {
	const store = Store.createMemoryStore();
	await started(store);
	await store.commit({
		run: run('attempt-1', 1), expectedRevision: 1, commandId: 'change-1',
		event: event('command.applied', {command: {value: 1}}),
	});
	const corrupted = await store.exportActive();
	corrupted.events[1].payload.command.value = 999;
	await assert.rejects(() => store.validateBundle(rechecksum(corrupted)),
		error => error.code === 'CORRUPT_EVENT');
});

test('the compatibility run log cannot drift from its authoritative events', async () => {
	const store = Store.createMemoryStore();
	const initial = {attemptId: 'log-integrity', profileId: 'run-and-bun', value: 0, log: []};
	await store.commit({run: initial, expectedRevision: 0, commandId: 'start-log',
		event: event('run.started', {run: initial})});
	const next = {attemptId: 'log-integrity', profileId: 'run-and-bun', value: 1,
		log: [{command: {kind: 'tick', value: 1}, summary: 'tick', at: null}]};
	await store.commit({run: next, expectedRevision: 1, commandId: 'tick-log',
		event: event('command.applied', {command: {kind: 'tick', value: 1}})});
	const corrupted = await store.exportActive();
	corrupted.head.run.log[0].summary = 'fabricated';
	corrupted.run.log[0].summary = 'fabricated';
	await assert.rejects(() => store.validateBundle(rechecksum(corrupted)),
		error => error.code === 'CORRUPT_LOG');
});

test('event ranges return only the requested attempt revisions', async () => {
	const store = Store.createMemoryStore();
	await started(store, 'ranged');
	for (let revision = 2; revision <= 8; revision++) {
		await store.commit({
			run: run('ranged', revision), expectedRevision: revision - 1,
			commandId: 'ranged-' + revision,
			event: event('command.applied', {command: {value: revision}}),
		});
	}
	await started(store, 'noise');
	const selected = await store.listEvents('ranged', {fromRevision: 3, toRevision: 6});
	assert.deepEqual(selected.map(row => row.revision), [3, 4, 5, 6]);
	assert.equal(selected.every(row => row.attemptId === 'ranged'), true);
});

test('10k compact revisions stay bounded and archives grow linearly', {timeout: 30000}, async () => {
	const store = Store.createMemoryStore();
	const startedAt = Date.now();
	let halfwayBytes = 0;
	let halfwayAt = 0;
	let firstHalfMs = 0;
	for (let revision = 1; revision <= 10000; revision++) {
		await store.commit({
			run: {attemptId: 'scale-10k', profileId: 'run-and-bun', value: revision},
			expectedRevision: revision - 1,
			commandId: 'scale-' + revision,
			event: event(revision === 1 ? 'run.started' : 'command.applied',
				revision === 1 ? {} : {command: {value: revision}}),
		});
		if (revision === 5000) {
			// The halfway export is measured OUT of both halves. It serializes
			// 5000 events, so leaving it in makes the second half look 3.5x the
			// first and the scaling gate below fires on the measurement rather
			// than on the code.
			firstHalfMs = Date.now() - startedAt;
			halfwayBytes = Buffer.byteLength(JSON.stringify(await store.exportActive()));
			halfwayAt = Date.now();
		}
	}
	// Both halves must measure COMMITS only. The halfway export is excluded
	// above; this stops the final full export — which serializes all 10000
	// events — from being charged to the second half.
	const loopEndedAt = Date.now();
	const bundle = await store.exportActive();
	const finalBytes = Buffer.byteLength(JSON.stringify(bundle));
	assert.equal(bundle.events.length, 10000);
	assert.equal(bundle.head.revision, 10000);
	assert.equal(bundle.snapshots.length, 201);
	// There is deliberately NO wall-clock assertion here, and that is a
	// deliberate retreat rather than an oversight.
	//
	// This line used to read `Date.now() - startedAt < 10000`. It went red
	// under the full suite at 11.5s and green alone at 2.5s, with no code
	// change between them — it was measuring machine load. Replacing it with
	// a scaling ratio (second 5000 commits over the first) looked right and
	// is not: the halves run minutes apart, so a suite that is busier later
	// skews them. Measured 0.83-0.94 alone, 2.43 under the full suite, on
	// identical code. A gate that fires on load teaches you to ignore it,
	// which is worse than not having one.
	//
	// What survives is deterministic. The commit loop IS bounded — measured
	// per-1000-commit blocks alone: 88, 94, 67, 57, 49, 54, 65, 55, 61 ms,
	// flat — but nothing in a parallel suite can assert that honestly. The
	// byte-growth assertion below is the linear-growth gate this test is
	// named for, and it does not care how loaded the box is.
	//
	// Tracked as `no-cpu-scaling-gate-for-commit` in the ledger so the gap
	// is recorded rather than quietly dropped.
	assert.ok(loopEndedAt >= halfwayAt, 'the commit loop ran to completion');
	assert.ok(finalBytes / halfwayBytes < 2.15,
		'serialized archive growth remains approximately linear');
	assert.equal(await store.validateBundle(bundle), true);
});

test('growing run logs are stored once, not copied into every receipt', {timeout: 30000}, async () => {
	const store = Store.createMemoryStore();
	let current = {attemptId: 'growing-log', profileId: 'run-and-bun', value: 0, log: []};
	for (let revision = 1; revision <= 2000; revision++) {
		current = Object.assign({}, current, {value: revision,
			log: current.log.concat([{command: {kind: 'tick', value: revision}}])});
		await store.commit({
			run: current, expectedRevision: revision - 1, commandId: 'grow-' + revision,
			event: event(revision === 1 ? 'run.started' : 'command.applied',
				revision === 1 ? {} : {command: {kind: 'tick', value: revision}}),
		});
	}
	const bundle = await store.exportActive();
	assert.ok(Buffer.byteLength(JSON.stringify(bundle)) < 10 * 1024 * 1024);
	assert.equal(bundle.idempotency.every(receipt =>
		!Object.hasOwn(receipt, 'run') && !Object.hasOwn(receipt, 'event')), true);
	assert.equal(bundle.snapshots.filter(snapshot => snapshot.logRevision === 0)
		.every(snapshot => !snapshot.run.log), true);
});

test('archive and archive import/list preserve portable records', async () => {
	const store = Store.createMemoryStore();
	await started(store, 'archived');
	const entry = await store.archive({attemptId: 'archived', outcome: 'wipe', position: 4});
	assert.equal(entry.archiveId, 'archived');
	assert.equal((await store.listArchives()).length, 1);
	assert.equal(await store.loadActive(), null, 'archiving clears the active pointer');
	const other = Store.createMemoryStore();
	await other.importArchives(await store.listArchives());
	assert.deepEqual((await other.listArchives())[0], entry);
});

test('a Littleroot runtime fixture rebuilds through the real run reducer', async () => {
	const store = Store.createMemoryStore();
	const first = littleroot[0];
	let current = adapter.replay([first]).run;
	let revision = 0;
	await store.commit({
		run: current, expectedRevision: revision++, commandId: first.eventId,
		event: adapter.normalizeEvent(first),
	});

	for (const observed of littleroot.slice(1)) {
		const canonical = adapter.normalizeEvent(observed);
		const commands = adapter.eventCommands(canonical);
		if (!commands.length) {
			await store.commit({
				run: current, expectedRevision: revision++, commandId: observed.eventId,
				event: canonical,
			});
			continue;
		}
		for (let index = 0; index < commands.length; index++) {
			const command = commands[index];
			current = runtime.apply(current, command, {now: observed.observedAt});
			await store.commit({
				run: current,
				expectedRevision: revision++,
				commandId: observed.eventId + ':' + index,
				event: {
					schemaVersion: adapter.SCHEMA_VERSION,
					eventId: canonical.eventId + ':projection:' + index,
					profileId: canonical.profileId,
					sourceSequence: canonical.revision,
					kind: 'command.applied', payload: {command},
					source: canonical.source, observedAt: canonical.observedAt,
				},
			});
		}
	}

	const bundle = await store.exportActive();
	const rebuilt = await store.replayBundle(bundle, (runState, command, eventRow) =>
		runtime.apply(runState, command, {now: eventRow.observedAt}));
	assert.deepEqual(rebuilt.run, current);
	const expected = adapter.replay(littleroot).run;
	assert.deepEqual(rebuilt.run, expected);
});

test('the archive shelf refuses silent replacement of a saved run', async () => {
	const store = Store.createMemoryStore();
	await started(store);
	const first = await store.archive({attemptId: 'attempt-1', name: 'First run',
		outcome: 'wipe', position: 3, run: run('attempt-1', 3),
		evidence: {revision: 3, checksum: 'aaaa'}});
	// Same shelf slot, different content, no supersede: refused loudly.
	await assert.rejects(() => store.archive({attemptId: 'attempt-1', name: 'Rewritten',
		outcome: 'completed', position: 9, run: run('attempt-1', 9),
		evidence: {revision: 9, checksum: 'bbbb'}}),
	error => error.code === 'ARCHIVE_CONFLICT');
	await assert.rejects(() => store.importArchives([{attemptId: 'attempt-1',
		name: 'Legacy shadow', outcome: 'reset', position: 1, run: run('attempt-1', 1),
		evidence: {revision: 1, checksum: 'cccc'}}]),
	error => error.code === 'ARCHIVE_CONFLICT');
	// The shelf still holds the original.
	const kept = (await store.listArchives())[0];
	assert.equal(kept.outcome, 'wipe', 'the first archive survives every collision');
	// A deliberate re-archive names what it replaces — that is the valve.
	const superseded = await store.archive({attemptId: 'attempt-1', name: 'Continued run',
		outcome: 'completed', position: 12, run: run('attempt-1', 12),
		evidence: {revision: 12, checksum: 'dddd'}, supersedes: first.evidence.checksum});
	assert.equal(superseded.outcome, 'completed');
	// Idempotent same-content puts stay legal (the legacy DB re-import path).
	await store.importArchives([JSON.parse(JSON.stringify(superseded))]);
	assert.equal((await store.listArchives()).length, 1);
});

test('a backwards wall clock is flagged at commit, never rewritten', async () => {
	const store = Store.createMemoryStore();
	await store.commit({
		run: run('attempt-1', 0), expectedRevision: 0, commandId: 'start-1',
		event: {kind: 'run.started', payload: {snapshot: run('attempt-1', 0)},
			observedAt: '2026-08-15T10:00:00.000Z'},
	});
	await store.commit({
		run: run('attempt-1', 1), expectedRevision: 1, commandId: 'change-1',
		event: {kind: 'command.applied', payload: {command: {value: 1}},
			observedAt: '2026-08-15T09:00:00.000Z'},
	});
	const events = await store.listEvents('attempt-1');
	assert.equal(events[0].observedAtSuspect, undefined,
		'a forward clock carries no flag');
	assert.equal(events[1].observedAtSuspect, true,
		'the backwards timestamp is marked suspect');
	assert.equal(events[1].observedAt, '2026-08-15T09:00:00.000Z',
		'the raw value is kept — flagged, never rewritten');
	// The flag is part of the hash chain from birth: the export round-trips.
	const bundle = await store.exportActive();
	assert.equal(await store.validateBundle(bundle), true);
});

test('a re-anchored mirror commits as run.replaced so its exports stay importable', async () => {
	function runLog(id, value, log) {
		return {attemptId: id, value: value, log: log, updatedAt: TIME};
	}
	// The failure being healed: a degraded session appends to the mirror
	// only; on recovery the next command absorbs the mirror-grown log into
	// ONE command.applied, whose single logEntry cannot re-materialize the
	// whole log — the attempt's own export then fails import as CORRUPT_LOG.
	const broken = Store.createMemoryStore();
	await broken.commit({run: runLog('attempt-1', 0, []), expectedRevision: 0,
		commandId: 'start', event: event('run.started', {})});
	await broken.commit({run: runLog('attempt-1', 3, [{kind: 'a'}, {kind: 'b'}, {kind: 'c'}]), expectedRevision: 1,
		commandId: 'absorb', event: event('command.applied', {command: {kind: 'c'}})});
	const brokenBundle = await broken.exportActive();
	await assert.rejects(() => broken.validateBundle(brokenBundle),
		error => error.code === 'CORRUPT_LOG',
		'the absorbed log must fail its own export — this is the defect being healed');

	// The cure: adopting the ahead mirror is a lifecycle event. run.replaced
	// snapshots the full adopted run, so materialization restarts from it.
	const healed = Store.createMemoryStore();
	await healed.commit({run: runLog('attempt-1', 0, []), expectedRevision: 0,
		commandId: 'start', event: event('run.started', {})});
	await healed.commit({run: runLog('attempt-1', 2, [{kind: 'a'}, {kind: 'b'}]), expectedRevision: 1,
		commandId: 'replace-2', event: event('run.replaced',
			{reason: 'compatibility copy ran ahead of durable storage'})});
	await healed.commit({run: runLog('attempt-1', 3, [{kind: 'a'}, {kind: 'b'}, {kind: 'c'}]), expectedRevision: 2,
		commandId: 'next', event: event('command.applied', {command: {kind: 'c'}})});
	const bundle = await healed.exportActive();
	assert.equal(await healed.validateBundle(bundle), true,
		'a re-anchored attempt must export archives that import cleanly');
	const fresh = Store.createMemoryStore();
	const imported = await fresh.importBundle(bundle);
	assert.equal(imported.duplicate, false, 'the healed archive round-trips');
});
