/* eslint-env node, es6 */
'use strict';

const assert = require('node:assert/strict');
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

const pkg = json('package.json');
assert.equal(pkg.scripts.start, 'npm run dev');
assert.equal(pkg.scripts.dev, 'npm run build && node server.js');
assert.equal(pkg.scripts.preview, 'node build view && node server.js');

const source = read('src/index.template.html');
assert.match(source, /\/src\\\/index\\\.template\\\.html\$/,
	'source template must redirect to the materialized product entrypoint');
assert.ok(!fs.existsSync(path.join(root, 'src', 'calc')),
	'src/calc must not be introduced to make the raw template look runnable');

const dist = path.join(root, 'dist');
for (const relative of ['index.html', 'calc/index.js', 'js/runbun_shell.js',
	'js/runtime_contract.js', 'js/attempt_store.js']) {
	assert.ok(fs.existsSync(path.join(dist, relative)), `dist/${relative} is missing; build before preview`);
}
const built = read('dist/index.html');
assert.doesNotMatch(built, /index\.template\.html/);

const manifest = json('contracts/ecosystem/v1/contract.json');
exactKeys(manifest.owners, ['attempt', 'simulation', 'orchestration'], 'contract owners');
assert.deepEqual(manifest.owners, {
	attempt: 'runbuncalc', simulation: 'pokemon-mono', orchestration: 'stochastic-inference-core',
});
assert.equal(manifest.version, '1.0.0');
assert.equal(manifest.transports.archive, 'rabrun.archive@1+model@2.0.0');
assert.ok(manifest.capabilities.includes('pokemon.rab.simulate'));

const request = json('contracts/ecosystem/v1/' + manifest.examples.request);
const receipt = json('contracts/ecosystem/v1/' + manifest.examples.receipt);
assert.equal(request.schemaVersion, manifest.requestSchema);
assert.equal(receipt.schemaVersion, manifest.receiptSchema);
assert.equal(receipt.requestId, request.requestId);
assert.equal(receipt.producer.repository, manifest.owners.simulation);
assert.equal(receipt.input.attemptId, request.attempt.attemptId);
assert.equal(receipt.input.revision, request.attempt.revision);
assert.equal(receipt.input.stateHash, request.attempt.stateHash);
assert.deepEqual(receipt.input.seeds, request.task.seeds);
sha256(request.attempt.stateHash, 'request attempt stateHash');
sha256(receipt.result.outputHash, 'receipt result outputHash');
sha256(receipt.evidence.replayHash, 'receipt evidence replayHash');
assert.equal(receipt.evidence.deterministic, true);
assert.deepEqual(receipt.evidence.unexpectedDivergences, []);

console.log('SDLC gate passed: built entrypoint and ecosystem bridge contract agree.');
