/* eslint-env node, es6 */
'use strict';

const runtime = require('./run');

const REQUEST_SCHEMA = 'pokemon.bridge.request/1.0.0';
const RECEIPT_SCHEMA = 'pokemon.bridge.receipt/1.0.0';
const CONTRACT_VERSION = '1.0.0';
const CAPABILITY = 'pokemon.rab.plan';

function fail(message) {
	const error = new Error('pokemon bridge: ' + message);
	error.code = 'InvalidPokemonBridge';
	throw error;
}

function record(value, label) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) fail(label + ' must be an object');
	return value;
}

function string(value, label) {
	if (typeof value !== 'string' || !value) fail(label + ' is required');
	return value;
}

function sha256(value, label) {
	string(value, label);
	if (!/^[a-f0-9]{64}$/.test(value)) fail(label + ' must be a lowercase SHA-256 digest');
	return value;
}

function revision(value, label) {
	if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) fail(label + ' must fit UINT32');
	return value;
}

function seeds(value) {
	if (!Array.isArray(value) || value.length < 1 || value.length > 10000) {
		fail('seeds must contain 1 through 10000 values');
	}
	if (new Set(value).size !== value.length) fail('seeds must be unique');
	value.forEach((seed, index) => revision(seed, 'seeds[' + index + ']'));
	return value.slice();
}

function createPlanningRequest(input) {
	const options = record(input, 'input');
	const run = record(options.run, 'run');
	if (run.version !== runtime.VERSION) fail('run version is unsupported');
	if (!Array.isArray(run.party) || !run.party.length) fail('run party is empty');
	const order = options.trainerOrder;
	if (!Number.isInteger(order) || order < 0) fail('trainerOrder must be a non-negative integer');
	const specs = runtime.partySpecs(run, {atOrder: order});
	const team = run.party.map((id, index) => Object.assign({id}, specs[index]));
	return {
		schemaVersion: REQUEST_SCHEMA,
		requestId: string(options.requestId, 'requestId'),
		capability: CAPABILITY,
		attempt: {
			attemptId: string(options.attemptId || run.attemptId, 'attemptId'),
			revision: revision(options.revision, 'revision'),
			stateHash: sha256(options.stateHash, 'stateHash'),
		},
		profile: {
			id: run.profileId,
			revision: string(options.profileRevision, 'profileRevision'),
		},
		task: {
			kind: 'plan',
			state: {kind: 'run-and-bun.plan-input', trainer: {order}, playerTeam: team},
			seeds: seeds(options.seeds),
			constraints: {
				zeroDeaths: options.zeroDeaths !== false,
				wholeBranch: options.wholeBranch !== false,
			},
		},
	};
}

function validatePlanningReceipt(requestInput, receiptInput) {
	const request = record(requestInput, 'request');
	const receipt = record(receiptInput, 'receipt');
	if (request.schemaVersion !== REQUEST_SCHEMA) fail('request schema is unsupported');
	if (request.capability !== CAPABILITY) fail('request capability is unsupported');
	if (receipt.schemaVersion !== RECEIPT_SCHEMA) fail('receipt schema is unsupported');
	if (receipt.requestId !== request.requestId) fail('receipt requestId does not match');
	const producer = record(receipt.producer, 'receipt.producer');
	if (producer.repository !== 'pokemon-mono') fail('receipt producer is not pokemon-mono');
	string(producer.revision, 'receipt.producer.revision');
	const input = record(receipt.input, 'receipt.input');
	if (input.attemptId !== request.attempt.attemptId ||
		input.revision !== request.attempt.revision ||
		input.stateHash !== request.attempt.stateHash ||
		input.profileRevision !== request.profile.revision) {
		fail('receipt input does not match the request');
	}
	if (JSON.stringify(input.seeds) !== JSON.stringify(request.task.seeds)) {
		fail('receipt seeds do not match the request');
	}
	const result = record(receipt.result, 'receipt.result');
	sha256(result.outputHash, 'receipt.result.outputHash');
	const evidence = record(receipt.evidence, 'receipt.evidence');
	if (evidence.contractVersion !== CONTRACT_VERSION) fail('receipt contract version is unsupported');
	if (evidence.deterministic !== true) fail('receipt is not deterministic');
	sha256(evidence.replayHash, 'receipt.evidence.replayHash');
	if (!Array.isArray(evidence.unexpectedDivergences) || evidence.unexpectedDivergences.length) {
		fail('receipt has unexpected divergences');
	}
	return receipt;
}

async function planWithProvider(providerInput, input) {
	const provider = record(providerInput, 'provider');
	if (typeof provider.plan !== 'function') fail('provider.plan must be a function');
	const request = createPlanningRequest(input);
	const receipt = await provider.plan(request);
	return validatePlanningReceipt(request, receipt);
}

module.exports = {
	REQUEST_SCHEMA, RECEIPT_SCHEMA, CONTRACT_VERSION, CAPABILITY,
	createPlanningRequest, validatePlanningReceipt, planWithProvider,
};
