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
assert.equal(providerProvenance.revision, '5648e07f8c48f8ce20e091dbf367dab213350686');

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
assert.equal(manifest.version, '1.1.0');
assert.deepEqual(manifest.authority, {
	status: 'consumer-fixture-cache',
	currentRepository: 'runbuncalc',
	canonicalTargetRepository: 'pokemon-mono',
	canonicalTargetPath: 'contracts/run-runtime/v1',
	canonicalRevision: '8e2c3c8f021094814b1b44844c7de4992095d274',
	canonicalDigest: '402809acb338a7fc274e72ae9bcc6efbe4956f8a980a951e05b665ee52f0ba75',
	promotionRequires: ['canonical-digest', 'provider-conformance', 'consumer-lock'],
});
assert.equal(manifest.transports.archive, 'rabrun.archive@1+model@2.0.0');
assert.equal(manifest.attributionRequestSchema, 'pokemon.bridge.attribution.request/1.0.0');
assert.equal(manifest.attributionReceiptSchema, 'pokemon.bridge.attribution.receipt/1.0.0');
assert.deepEqual(manifest.capabilities, ['pokemon.rab.plan', 'pokemon.rab.attribute']);
assert.deepEqual(manifest.parallelLanes, {
	contract: 'pokemon-mono', engine: 'pokemon-mono', app: 'runbuncalc',
	control: 'stochastic-inference-core', verification: 'cross-repository',
});

const request = json('contracts/ecosystem/v1/' + manifest.examples.request);
const receipt = json('contracts/ecosystem/v1/' + manifest.examples.receipt);
const seededReceipt = json('contracts/ecosystem/v1/seeded-provider-receipt.json');
const attributionRequest = json('contracts/ecosystem/v1/' + manifest.examples.attributionRequest);
const attributionReceipt = json('contracts/ecosystem/v1/' + manifest.examples.attributionReceipt);
const seededAttributionReceipt = json('contracts/ecosystem/v1/' +
	manifest.examples.seededAttributionReceipt);
const localAttribution = json('contracts/ecosystem/v1/' +
	manifest.examples.localAttributionEvidence);
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
assert.equal(attributionRequest.schemaVersion, manifest.attributionRequestSchema);
assert.equal(attributionReceipt.schemaVersion, manifest.attributionReceiptSchema);
assert.equal(attributionReceipt.requestId, attributionRequest.requestId);
assert.equal(attributionReceipt.input.attemptId, attributionRequest.attempt.attemptId);
assert.equal(attributionReceipt.input.revision, attributionRequest.attempt.revision);
assert.equal(attributionReceipt.input.stateHash, attributionRequest.attempt.stateHash);
assert.deepEqual(attributionReceipt.input.seeds, attributionRequest.task.seeds);
assert.deepEqual(attributionReceipt.input.interventionIds,
	attributionRequest.task.interventions.map(row => row.interventionId));
assert.equal(attributionReceipt.result.interventions.length,
	attributionRequest.task.interventions.length);
assert.equal(attributionReceipt.result.summary.seedPairsEvaluated,
	attributionRequest.task.seeds.length * attributionRequest.task.interventions.length);
assert.deepEqual(attributionReceipt.evidence.unexpectedDivergences, []);
assert.equal(matrix.schemaVersion, 'pokemon.bridge.integration/1.0.0');
assert.equal(matrix.status, 'participation-ready-local');
assert.equal(matrix.contract.version, '1.0.0',
	'integration matrix remains the last promoted planning baseline');
assert.equal(matrix.contract.revision, 'f7933f91b706c969a1dc5430a9484e5fafa4d66c');
assert.equal(matrix.contract.digest,
	'2cd1db3e69c9989b9e766a97e35ebc96a41cef5d756794829c20be2385c88a61');
assert.equal(lock.repository, manifest.authority.canonicalTargetRepository);
assert.equal(lock.path, manifest.authority.canonicalTargetPath);
assert.equal(lock.revision, manifest.authority.canonicalRevision);
assert.equal(lock.digest, manifest.authority.canonicalDigest);
sha256(lock.digest, 'canonical contract digest');
assert.deepEqual(matrix.fixtures.unexpectedDivergences, []);
assert.deepEqual(matrix.fixtures.expectedDivergences, []);
assert.equal(matrix.lanes.engine.revision, '58aad68ac7a93980e1d424e768b009ce7cc0ba2f');
assert.equal(matrix.lanes.app.revision, '27cb8e5e03f90e7931d359f7d23768914c50dd34');
assert.equal(matrix.lanes.control.revision, '84e7e9eb5d829d10e5f1f4b753976e6abb6d3d1a');
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
assert.equal(seededAttributionReceipt.requestId, attributionRequest.requestId);
assert.equal(seededAttributionReceipt.producer.revision, providerProvenance.revision);
assert.equal(seededAttributionReceipt.input.requestHash, canonicalHash(attributionRequest));
assert.equal(seededAttributionReceipt.input.baselineTeamHash,
	canonicalHash(attributionRequest.task.state.baselineTeam));
assert.deepEqual(seededAttributionReceipt.input.seeds, attributionRequest.task.seeds);
assert.deepEqual(seededAttributionReceipt.input.interventionIds,
	attributionRequest.task.interventions.map(row => row.interventionId));
assert.equal(seededAttributionReceipt.result.interventions.length,
	attributionRequest.task.interventions.length);
assert.deepEqual(seededAttributionReceipt.evidence.expectedDivergences, []);
assert.deepEqual(seededAttributionReceipt.evidence.unexpectedDivergences, []);
sha256(seededAttributionReceipt.result.outputHash, 'seeded attribution outputHash');
sha256(seededAttributionReceipt.evidence.replayHash, 'seeded attribution replayHash');
assert.equal(localAttribution.schemaVersion, 'pokemon.bridge.local-evidence/1.0.0');
assert.equal(localAttribution.status, 'implementation-tested-browser-pending');
assert.equal(localAttribution.contract.revision, lock.revision);
assert.equal(localAttribution.contract.digest, lock.digest);
assert.equal(localAttribution.lanes.app.revision,
	'87ca609a5c5cf7dcc70eed70c8b7c0a2b7ed1d8a');
assert.equal(localAttribution.lanes.engine.revision, providerProvenance.revision);
assert.equal(localAttribution.lanes.control.attributionCapabilityRegistered, false);
assert.equal(localAttribution.gates.providerDeterministicRepeat, true);
assert.equal(localAttribution.gates.providerReceiptLocked, true);
assert.equal(localAttribution.gates.evidencePersisted, true);
assert.equal(localAttribution.gates.evidenceMaterialized, true);
assert.equal(localAttribution.gates.reviewDerived, true);
assert.equal(localAttribution.gates.rendered, false);
assert.equal(localAttribution.gates.privateDeploymentVerified, false);
assert.equal(matrix.promotion.browserProviderParity, true);
assert.equal(matrix.promotion.singleBatchParity, true);
assert.equal(matrix.promotion.sixPokemonBenchmark, true);
assert.equal(matrix.promotion.planningEvidencePersisted, true);
assert.equal(matrix.promotion.planningEvidenceMaterialized, true);
assert.equal(matrix.promotion.battleOutcomeRecorded, true);
assert.equal(matrix.promotion.planningReviewRendered, true);
assert.equal(matrix.promotion.planningReviewMaterialized, true);
assert.equal(matrix.promotion.battleContributionRecorded, true);
assert.equal(matrix.promotion.battleContributionRendered, true);
assert.equal(matrix.promotion.battleContributionMaterialized, true);
assert.equal(matrix.promotion.providerEnabled, false);
assert.equal(matrix.promotion.privateDeploymentVerified, false);

console.log('SDLC gate passed: built entrypoint and ecosystem bridge contract agree.');
