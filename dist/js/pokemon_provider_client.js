/* eslint-env browser, node, es6 */

(function (root, factory) {
	if (typeof module === 'object' && module.exports) module.exports = factory(root);
	else root.RunBunPokemonProviderClient = factory(root);
})(typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : global, function (root) {
	'use strict';

	var IVS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
	var MAX_BROWSER_BATCH_REQUESTS = 8;

	function fail(message) {
		throw new Error('pokemon-mono planner: ' + message);
	}

	function canonical(value) {
		if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
		if (value && typeof value === 'object') {
			return '{' + Object.keys(value).sort().map(function (key) {
				return JSON.stringify(key) + ':' + canonical(value[key]);
			}).join(',') + '}';
		}
		return JSON.stringify(value);
	}

	async function sha256(value) {
		var webCrypto = root.crypto;
		if (!webCrypto || !webCrypto.subtle) fail('Web Crypto is unavailable');
		var bytes = new TextEncoder().encode(value);
		var digest = await webCrypto.subtle.digest('SHA-256', bytes);
		return Array.prototype.map.call(new Uint8Array(digest), function (byte) {
			return byte.toString(16).padStart(2, '0');
		}).join('');
	}

	function deriveSeeds(stateHash, trainerOrder, count) {
		var seeds = [];
		var seen = {};
		for (var index = 0; index < count; index += 1) {
			var offset = index % 8 * 8;
			var chunk = Number.parseInt(stateHash.slice(offset, offset + 8), 16) >>> 0;
			var seed = (chunk + Math.imul(index + 1, 0x9e3779b1) + trainerOrder) >>> 0;
			while (seen[seed]) seed = (seed + 1) >>> 0;
			seen[seed] = true;
			seeds.push(seed);
		}
		return seeds;
	}

	function portableTeam(run) {
		if (!run || !Array.isArray(run.party) || !run.party.length) fail('choose a party first');
		if (!Array.isArray(run.box)) fail('run box is missing');
		return run.party.map(function (id) {
			var mon = run.box.filter(function (entry) { return entry.id === id; })[0];
			if (!mon) fail('party Pokemon ' + id + ' is not in the box');
			if (!mon.ivs || IVS.some(function (stat) { return !Number.isInteger(mon.ivs[stat]); })) {
				fail((mon.nickname || mon.species || id) + ' needs all six IVs recorded');
			}
			if (!Array.isArray(mon.moves) || !mon.moves.length) {
				fail((mon.nickname || mon.species || id) + ' needs at least one move');
			}
			return {
				id: mon.id,
				species: mon.species,
				level: mon.level,
				moves: mon.moves.slice(0, 4),
				nature: mon.nature || undefined,
				ability: mon.ability || undefined,
				item: mon.item || null,
				ivs: IVS.reduce(function (result, stat) {
					result[stat] = mon.ivs[stat];
					return result;
				}, {}),
			};
		});
	}

	async function createRequest(options) {
		if (!options || !options.run) fail('run is required');
		if (!Number.isInteger(options.trainerOrder) || options.trainerOrder < 0) {
			fail('trainerOrder must be a non-negative integer');
		}
		var revision = Number.isInteger(options.revision) && options.revision >= 0 ?
			options.revision : options.run.log && options.run.log.length || 0;
		var stateHash = await sha256(canonical(options.run));
		var seeds = options.seeds || deriveSeeds(stateHash, options.trainerOrder, 8);
		return {
			schemaVersion: 'pokemon.bridge.request/1.0.0',
			requestId: 'run-' + options.run.attemptId + '-r' + revision + '-t' +
				options.trainerOrder + '-' + stateHash.slice(0, 12),
			capability: 'pokemon.rab.plan',
			attempt: {attemptId: options.run.attemptId, revision: revision, stateHash: stateHash},
			profile: {
				id: 'run-and-bun',
				revision: options.profileRevision,
			},
			task: {
				kind: 'plan',
				state: {
					kind: 'run-and-bun.plan-input',
					trainer: {order: options.trainerOrder},
					playerTeam: portableTeam(options.run),
				},
				seeds: seeds,
				constraints: {zeroDeaths: true, wholeBranch: true},
			},
		};
	}

	function resolveRuntime(options) {
		var runtime = options && options.runtime || root.RunBunPokemonProvider;
		if (!runtime || !runtime.provider || typeof runtime.provider.plan !== 'function') {
			fail('embedded provider is not loaded');
		}
		return runtime;
	}

	async function executeRequest(runtime, request) {
		var receipt = await runtime.provider.plan(request);
		if (!receipt || receipt.requestId !== request.requestId ||
			receipt.producer.repository !== 'pokemon-mono' ||
			receipt.producer.revision !== runtime.metadata.engineRevision ||
			!receipt.evidence || receipt.evidence.deterministic !== true ||
			receipt.evidence.unexpectedDivergences.length) {
			fail('provider returned an invalid receipt');
		}
		return {request: request, receipt: receipt, metadata: runtime.metadata};
	}

	async function planRun(options) {
		var runtime = resolveRuntime(options);
		var request = await createRequest(Object.assign({}, options, {
			profileRevision: options.profileRevision || runtime.metadata.engineRevision,
		}));
		return executeRequest(runtime, request);
	}

	/**
	 * Plan a small look-ahead through one already-loaded browser provider.
	 *
	 * This is deliberately bounded to the eight fights the run surface loads.
	 * Fleet-scale batches belong in stochastic-inference-core; the browser only
	 * needs enough work to answer "does this party still look viable ahead?".
	 * Requests execute in stable order so the returned rows map directly back to
	 * the visible road, while the provider module itself stays warm in-process.
	 */
	async function planBatch(options) {
		if (!Array.isArray(options) || !options.length) fail('batch must contain at least one fight');
		if (options.length > MAX_BROWSER_BATCH_REQUESTS) {
			fail('browser batches are capped at ' + MAX_BROWSER_BATCH_REQUESTS + ' fights');
		}
		var runtime = resolveRuntime(options[0]);
		var requests = [];
		var requestIds = {};
		for (var index = 0; index < options.length; index += 1) {
			var item = Object.assign({}, options[index], {runtime: runtime});
			var request = await createRequest(Object.assign({}, item, {
				profileRevision: item.profileRevision || runtime.metadata.engineRevision,
			}));
			if (requestIds[request.requestId]) fail('batch requestId values must be unique');
			requestIds[request.requestId] = true;
			requests.push(request);
		}
		var results = [];
		for (var requestIndex = 0; requestIndex < requests.length; requestIndex += 1) {
			results.push(await executeRequest(runtime, requests[requestIndex]));
		}
		return results;
	}

	return {
		MAX_BROWSER_BATCH_REQUESTS: MAX_BROWSER_BATCH_REQUESTS,
		canonical: canonical,
		deriveSeeds: deriveSeeds,
		createRequest: createRequest,
		planRun: planRun,
		planBatch: planBatch,
	};
});
