/* eslint-env node */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Store = require('./src/js/attempt_store.js');
const runtime = require('./run');
const adapter = require('./game-runtime-adapter');
const littleroot = require('./fixtures/runtime-contract/littleroot-replay.json');
const legacyArchive = require('./fixtures/runtime-contract/rabrun-archive-v1.json');
const planningRequest = require('./contracts/ecosystem/v1/planning-request.json');
const planningReceipt = require('./contracts/ecosystem/v1/seeded-provider-receipt.json');
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
	for (let revision = 1; revision <= 10000; revision++) {
		await store.commit({
			run: {attemptId: 'scale-10k', profileId: 'run-and-bun', value: revision},
			expectedRevision: revision - 1,
			commandId: 'scale-' + revision,
			event: event(revision === 1 ? 'run.started' : 'command.applied',
				revision === 1 ? {} : {command: {value: revision}}),
		});
		if (revision === 5000) {
			halfwayBytes = Buffer.byteLength(JSON.stringify(await store.exportActive()));
		}
	}
	const bundle = await store.exportActive();
	const finalBytes = Buffer.byteLength(JSON.stringify(bundle));
	assert.equal(bundle.events.length, 10000);
	assert.equal(bundle.head.revision, 10000);
	assert.equal(bundle.snapshots.length, 201);
	assert.ok(Date.now() - startedAt < 10000, '10k compact commits and exports stay interactive');
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
