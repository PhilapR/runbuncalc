/* eslint-env browser, node, es6 */

(function (root, factory) {
	if (typeof module === 'object' && module.exports) module.exports = factory(root);
	else root.RunBunPokemonProviderClient = factory(root);
})(typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : global, function (root) {
	'use strict';

	var IVS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
	var MAX_BROWSER_BATCH_REQUESTS = 8;
	var ATTRIBUTION_SEED_COUNT = 4;
	var MAX_ATTRIBUTION_INTERVENTIONS = 15;
	var MAX_ATTRIBUTION_CANDIDATE_BRANCHES = 384;

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

	function stateProjection(run) {
		var projected = {};
		Object.keys(run || {}).forEach(function (key) {
			if (key !== 'log') projected[key] = run[key];
		});
		return projected;
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

	function portablePokemon(mon, strict) {
		var label = mon && (mon.nickname || mon.species || mon.id) || 'Pokemon';
		if (!mon || typeof mon.id !== 'string' || !mon.id ||
			typeof mon.species !== 'string' || !mon.species ||
			!Number.isInteger(mon.level) || mon.level < 1 || mon.level > 100) {
			fail(label + ' needs an id, species, and level');
		}
		if (!mon.ivs || IVS.some(function (stat) {
			return !Number.isInteger(mon.ivs[stat]) || mon.ivs[stat] < 0 || mon.ivs[stat] > 31;
		})) fail(label + ' needs all six IVs recorded');
		if (!Array.isArray(mon.moves) || !mon.moves.length || mon.moves.length > 4) {
			fail(label + ' needs one through four moves');
		}
		if (strict && (typeof mon.nature !== 'string' || !mon.nature ||
			typeof mon.ability !== 'string' || !mon.ability)) {
			fail(label + ' needs its nature and ability recorded');
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
	}

	function portableTeam(run, strict) {
		if (!run || !Array.isArray(run.party) || !run.party.length) fail('choose a party first');
		if (!Array.isArray(run.box)) fail('run box is missing');
		return run.party.map(function (id) {
			var mon = run.box.filter(function (entry) { return entry.id === id; })[0];
			if (!mon) fail('party Pokemon ' + id + ' is not in the box');
			return portablePokemon(mon, strict);
		});
	}

	function acquisitionEvent(mon, events, revision) {
		var candidates = (events || []).filter(function (event) {
			if (!event || !Number.isInteger(event.revision) || event.revision < 1 ||
				event.revision > revision || typeof event.eventId !== 'string' || !event.eventId ||
				!(/^[a-f0-9]{64}$/).test(event.eventHash || '')) return false;
			if (event.kind === 'run.started') {
				var startedBox = event.payload && event.payload.run && event.payload.run.box;
				return Array.isArray(startedBox) && startedBox.some(function (entry) {
					return entry && entry.id === mon.id && entry.species === mon.species;
				});
			}
			return event.kind === 'command.applied' && event.payload && event.payload.command &&
				event.payload.command.kind === 'catch' && event.payload.result &&
				event.payload.result.pokemonId === mon.id &&
				event.payload.command.species === mon.species;
		}).sort(function (a, b) { return a.revision - b.revision; });
		if (!candidates.length) return null;
		var source = candidates[0];
		return {sourceEventId: source.eventId, sourceEventHash: source.eventHash,
			acquiredRevision: source.revision};
	}

	function attributionInterventions(run, baseline, events, revision) {
		var interventions = baseline.map(function (mon) {
			return {
				interventionId: mon.id + '-all-15-reference',
				kind: 'normalize-ivs',
				targetId: mon.id,
				reference: 'all-15-reference',
				ivs: {hp: 15, atk: 15, def: 15, spa: 15, spd: 15, spe: 15},
			};
		});
		var partyIds = {};
		baseline.forEach(function (mon) { partyIds[mon.id] = true; });
		var reserves = run.box.filter(function (mon) {
			return mon && !partyIds[mon.id] && mon.status !== 'dead';
		}).slice().sort(function (a, b) { return String(a.id).localeCompare(String(b.id)); });
		for (var reserveIndex = 0; reserveIndex < reserves.length &&
			interventions.length < MAX_ATTRIBUTION_INTERVENTIONS; reserveIndex += 1) {
			var replacement;
			try { replacement = portablePokemon(reserves[reserveIndex], true); } catch (ignore) { continue; }
			var ownership = acquisitionEvent(replacement, events, revision);
			if (!ownership) continue;
			for (var targetIndex = 0; targetIndex < baseline.length &&
				interventions.length < MAX_ATTRIBUTION_INTERVENTIONS; targetIndex += 1) {
				interventions.push({
					interventionId: 'replace-' + baseline[targetIndex].id + '-with-' + replacement.id,
					kind: 'replace-party-member',
					targetId: baseline[targetIndex].id,
					replacement: replacement,
					ownership: ownership,
				});
			}
		}
		return interventions;
	}

	async function createRequest(options) {
		if (!options || !options.run) fail('run is required');
		if (!Number.isInteger(options.trainerOrder) || options.trainerOrder < 0) {
			fail('trainerOrder must be a non-negative integer');
		}
		var revision = Number.isInteger(options.revision) && options.revision >= 0 ?
			options.revision : options.run.log && options.run.log.length || 0;
		var stateHash = await sha256(canonical(stateProjection(options.run)));
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

	async function createAttributionRequest(options) {
		if (!options || !options.run) fail('run is required');
		if (!Number.isInteger(options.trainerOrder) || options.trainerOrder < 1) {
			fail('trainerOrder must be a positive integer');
		}
		var revision = Number.isInteger(options.revision) && options.revision >= 1 ?
			options.revision : options.run.log && options.run.log.length || 0;
		if (revision < 1) fail('a durable attempt revision is required');
		var stateHash = await sha256(canonical(stateProjection(options.run)));
		var seeds = options.seeds || deriveSeeds(stateHash, options.trainerOrder,
			ATTRIBUTION_SEED_COUNT);
		var baseline = portableTeam(options.run, true);
		var interventions = options.interventions || attributionInterventions(
			options.run, baseline, options.events, revision);
		if (!interventions.length) fail('no bounded attribution tests are available');
		var candidateBranches = (interventions.length + 1) * baseline.length * seeds.length;
		if (candidateBranches > MAX_ATTRIBUTION_CANDIDATE_BRANCHES) {
			fail('attribution candidate branch budget exceeded');
		}
		return {
			schemaVersion: 'pokemon.bridge.attribution.request/1.0.0',
			requestId: 'attribute-' + options.run.attemptId + '-r' + revision + '-t' +
				options.trainerOrder + '-' + stateHash.slice(0, 12),
			capability: 'pokemon.rab.attribute',
			attempt: {attemptId: options.run.attemptId, revision: revision, stateHash: stateHash},
			profile: {id: 'run-and-bun', revision: options.profileRevision},
			task: {
				kind: 'attribute',
				state: {kind: 'run-and-bun.attribution-input',
					trainer: {order: options.trainerOrder},
					startingCondition: 'full-health-no-status-full-pp',
					baselineTeam: baseline},
				interventions: interventions,
				seeds: seeds,
				constraints: {zeroDeaths: true, wholeBranch: true,
					policy: 'reoptimize-lead-v1',
					maxCandidateBranches: MAX_ATTRIBUTION_CANDIDATE_BRANCHES},
			},
		};
	}

	function resolveRuntime(options, method) {
		var runtime = options && options.runtime || root.RunBunPokemonProvider;
		if (!runtime || !runtime.provider || typeof runtime.provider[method] !== 'function') {
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
		var runtime = resolveRuntime(options, 'plan');
		var request = await createRequest(Object.assign({}, options, {
			profileRevision: options.profileRevision || runtime.metadata.engineRevision,
		}));
		return executeRequest(runtime, request);
	}

	async function attributeRun(options) {
		var runtime = resolveRuntime(options, 'attribute');
		var request = await createAttributionRequest(Object.assign({}, options, {
			profileRevision: options.profileRevision || runtime.metadata.engineRevision,
		}));
		var receipt = await runtime.provider.attribute(request);
		if (!receipt || receipt.requestId !== request.requestId ||
			receipt.schemaVersion !== 'pokemon.bridge.attribution.receipt/1.0.0' ||
			!receipt.producer || receipt.producer.repository !== 'pokemon-mono' ||
			receipt.producer.revision !== runtime.metadata.engineRevision ||
			!receipt.result || receipt.result.status !== 'complete' ||
			!Array.isArray(receipt.result.interventions) ||
			receipt.result.interventions.length !== request.task.interventions.length ||
			!receipt.evidence || receipt.evidence.deterministic !== true ||
			!Array.isArray(receipt.evidence.unexpectedDivergences) ||
			receipt.evidence.unexpectedDivergences.length) {
			fail('provider returned an invalid attribution receipt');
		}
		return {request: request, receipt: receipt, metadata: runtime.metadata};
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
		var runtime = resolveRuntime(options[0], 'plan');
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
		ATTRIBUTION_SEED_COUNT: ATTRIBUTION_SEED_COUNT,
		MAX_ATTRIBUTION_INTERVENTIONS: MAX_ATTRIBUTION_INTERVENTIONS,
		MAX_ATTRIBUTION_CANDIDATE_BRANCHES: MAX_ATTRIBUTION_CANDIDATE_BRANCHES,
		canonical: canonical,
		deriveSeeds: deriveSeeds,
		createRequest: createRequest,
		createAttributionRequest: createAttributionRequest,
		planRun: planRun,
		planBatch: planBatch,
		attributeRun: attributeRun,
	};
});
