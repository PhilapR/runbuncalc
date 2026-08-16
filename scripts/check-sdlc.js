/* eslint-env node, es6 */
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const json = relative => JSON.parse(read(relative));

function sha256(value, label) {
	assert.match(value, /^[a-f0-9]{64}$/, `${label} must be a lowercase SHA-256 digest`);
}

function exactKeys(value, expected, label) {
	assert.deepEqual(Object.keys(value).sort(), expected.slice().sort(), `${label} keys drifted`);
}

function canonical(value) {
	if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
	if (value && typeof value === 'object') {
		return '{' + Object.keys(value).sort().map(key =>
			JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
	}
	return JSON.stringify(value);
}

function canonicalHash(value) {
	return crypto.createHash('sha256').update(canonical(value)).digest('hex');
}

const pkg = json('package.json');
assert.equal(pkg.scripts.start, 'npm run dev');
assert.equal(pkg.scripts.dev, 'npm run build && node server.js');
assert.equal(pkg.scripts.preview, 'node build view && node server.js');
assert.equal(pkg.dependencies['@philapr/pokemon-run-runtime'],
	'file:vendor/pokemon-run-runtime');

const providerProvenance = json('vendor/pokemon-run-runtime/PROVENANCE.json');
const providerArtifact = fs.readFileSync(path.join(root, 'vendor', 'pokemon-run-runtime',
	providerProvenance.artifact));
assert.equal(crypto.createHash('sha256').update(providerArtifact).digest('hex'),
	providerProvenance.artifactSha256, 'vendored pokemon-mono artifact hash drifted');
assert.equal(providerProvenance.repository, 'pokemon-mono');
assert.equal(providerProvenance.revision, '58aad68ac7a93980e1d424e768b009ce7cc0ba2f');

const source = read('src/index.template.html');
assert.match(source, /\/src\\\/index\\\.template\\\.html\$/,
	'source template must redirect to the materialized product entrypoint');
assert.ok(!fs.existsSync(path.join(root, 'src', 'calc')),
	'src/calc must not be introduced to make the raw template look runnable');

const dist = path.join(root, 'dist');
for (const relative of ['index.html', 'calc/index.js', 'js/runbun_shell.js',
	'js/runtime_contract.js', 'js/attempt_store.js', 'js/pokemon_provider.js',
	'js/pokemon_provider_client.js']) {
	assert.ok(fs.existsSync(path.join(dist, relative)), `dist/${relative} is missing; build before preview`);
}
const built = read('dist/index.html');
assert.doesNotMatch(built, /index\.template\.html/);
assert.match(built, /js\/pokemon_provider\.js\?[a-f0-9]{8}/);

const manifest = json('contracts/ecosystem/v1/contract.json');
exactKeys(manifest.owners, ['attempt', 'simulation', 'orchestration'], 'contract owners');
assert.deepEqual(manifest.owners, {
	attempt: 'runbuncalc', simulation: 'pokemon-mono', orchestration: 'stochastic-inference-core',
});
assert.equal(manifest.version, '1.0.0');
assert.deepEqual(manifest.authority, {
	status: 'consumer-fixture-cache',
	currentRepository: 'runbuncalc',
	canonicalTargetRepository: 'pokemon-mono',
	canonicalTargetPath: 'contracts/run-runtime/v1',
	canonicalRevision: 'f7933f91b706c969a1dc5430a9484e5fafa4d66c',
	canonicalDigest: '2cd1db3e69c9989b9e766a97e35ebc96a41cef5d756794829c20be2385c88a61',
	promotionRequires: ['canonical-digest', 'provider-conformance', 'consumer-lock'],
});
assert.equal(manifest.transports.archive, 'rabrun.archive@1+model@2.0.0');
assert.deepEqual(manifest.capabilities, ['pokemon.rab.plan']);
assert.deepEqual(manifest.parallelLanes, {
	contract: 'pokemon-mono', engine: 'pokemon-mono', app: 'runbuncalc',
	control: 'stochastic-inference-core', verification: 'cross-repository',
});

const request = json('contracts/ecosystem/v1/' + manifest.examples.request);
const receipt = json('contracts/ecosystem/v1/' + manifest.examples.receipt);
const seededReceipt = json('contracts/ecosystem/v1/seeded-provider-receipt.json');
const matrix = json('contracts/ecosystem/v1/' + manifest.examples.integrationMatrix);
const lock = json('contracts/ecosystem/v1/' + manifest.examples.canonicalLock);
assert.equal(request.schemaVersion, manifest.requestSchema);
assert.equal(receipt.schemaVersion, manifest.receiptSchema);
assert.equal(receipt.requestId, request.requestId);
assert.equal(receipt.producer.repository, manifest.owners.simulation);
assert.equal(receipt.input.attemptId, request.attempt.attemptId);
assert.equal(receipt.input.revision, request.attempt.revision);
assert.equal(receipt.input.stateHash, request.attempt.stateHash);
assert.deepEqual(receipt.input.seeds, request.task.seeds);
assert.equal(request.task.state.kind, 'run-and-bun.plan-input');
assert.ok(Number.isInteger(request.task.state.trainer.order) && request.task.state.trainer.order > 0);
assert.ok(Array.isArray(request.task.state.playerTeam) && request.task.state.playerTeam.length > 0);
assert.deepEqual(Object.keys(request.task.state.playerTeam[0].ivs).sort(),
	['atk', 'def', 'hp', 'spa', 'spd', 'spe']);
assert.equal(receipt.result.summary.trainerOrder, request.task.state.trainer.order);
assert.ok(request.task.state.playerTeam.some(pokemon =>
	pokemon.id === receipt.result.summary.recommendedLeadId));
sha256(request.attempt.stateHash, 'request attempt stateHash');
sha256(receipt.result.outputHash, 'receipt result outputHash');
sha256(receipt.evidence.replayHash, 'receipt evidence replayHash');
assert.equal(receipt.evidence.deterministic, true);
assert.deepEqual(receipt.evidence.unexpectedDivergences, []);
assert.equal(matrix.schemaVersion, 'pokemon.bridge.integration/1.0.0');
assert.equal(matrix.status, 'provider-integrated-local');
assert.equal(matrix.contract.canonicalRepository, manifest.authority.canonicalTargetRepository);
assert.equal(matrix.contract.canonicalPath, manifest.authority.canonicalTargetPath);
assert.equal(matrix.contract.revision, lock.revision);
assert.equal(matrix.contract.digest, lock.digest);
assert.equal(lock.repository, manifest.authority.canonicalTargetRepository);
assert.equal(lock.path, manifest.authority.canonicalTargetPath);
assert.equal(lock.revision, manifest.authority.canonicalRevision);
assert.equal(lock.digest, manifest.authority.canonicalDigest);
sha256(lock.digest, 'canonical contract digest');
assert.deepEqual(matrix.fixtures.unexpectedDivergences, []);
assert.deepEqual(matrix.fixtures.expectedDivergences, []);
assert.equal(matrix.lanes.engine.revision, providerProvenance.revision);
assert.equal(matrix.lanes.app.revision, '814c23e6ebf4d041568d25435f34e499a3b5b191');
assert.equal(seededReceipt.requestId, request.requestId);
assert.equal(seededReceipt.producer.revision, providerProvenance.revision);
assert.equal(seededReceipt.input.stateHash, request.attempt.stateHash);
assert.deepEqual(seededReceipt.input.seeds, request.task.seeds);
assert.deepEqual(seededReceipt.evidence.unexpectedDivergences, []);
const seededBinding = {
	requestId: request.requestId,
	attempt: request.attempt,
	profileRevision: request.profile.revision,
	providerRevision: seededReceipt.producer.revision,
	plannerRevision: 'seeded-monte-carlo-lead-planner-v1',
	seeds: request.task.seeds,
	summary: seededReceipt.result.summary,
};
assert.equal(seededReceipt.result.outputHash, canonicalHash(seededBinding),
	'seeded receipt outputHash does not bind its request and summary');
assert.equal(seededReceipt.evidence.replayHash,
	canonicalHash({binding: seededBinding, outputHash: seededReceipt.result.outputHash}),
	'seeded receipt replayHash does not bind outputHash');
assert.equal(seededReceipt.receiptId, 'receipt_' + canonicalHash({
	schemaVersion: seededReceipt.schemaVersion,
	requestId: seededReceipt.requestId,
	providerRevision: seededReceipt.producer.revision,
	outputHash: seededReceipt.result.outputHash,
	replayHash: seededReceipt.evidence.replayHash,
}).slice(0, 24), 'seeded receiptId does not bind its receipt core');
assert.equal(matrix.promotion.browserProviderParity, true);
assert.equal(matrix.promotion.singleBatchParity, false);
assert.equal(matrix.promotion.providerEnabled, false);
assert.equal(matrix.promotion.privateDeploymentVerified, false);

console.log('SDLC gate passed: built entrypoint and ecosystem bridge contract agree.');
