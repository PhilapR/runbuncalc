/* eslint-env browser, node, es6 */
/* global globalThis */
(function (root, factory) {
	'use strict';
	var api = factory(root);
	if (typeof module === 'object' && module.exports) module.exports = api;
	else root.RunBunAttemptStore = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
	'use strict';

	var SCHEMA = 'rabrun.archive';
	var VERSION = 1;
	var MODEL_VERSION = '2.0.0';
	var DB_NAME = 'runbun-attempts';
	var DB_VERSION = 3;
	var EVIDENCE_SCHEMA = 'rabrun.evidence/1.0.0';
	var SNAPSHOT_INTERVAL = 50;
	var SNAPSHOT_KINDS = ['run.started', 'run.migrated', 'run.imported', 'run.replaced'];
	var defaultStore = null;

	function clone(value) {
		if (value === undefined) return value;
		return JSON.parse(JSON.stringify(value));
	}

	function runtimeContract() {
		if (root && root.RunBunRuntimeContract) return root.RunBunRuntimeContract;
		if (typeof module !== 'undefined' && module.exports && typeof require === 'function') {
			try { return require('./runtime_contract.js'); } catch (ignore) {}
		}
		return null;
	}

	function now() {
		return new Date().toISOString();
	}

	function isObject(value) {
		return value !== null && typeof value === 'object' && !Array.isArray(value);
	}

	function sorted(value) {
		if (Array.isArray(value)) return value.map(sorted);
		if (!isObject(value)) return value;
		var result = {};
		Object.keys(value).sort().forEach(function (key) { result[key] = sorted(value[key]); });
		return result;
	}

	function canonical(value) {
		return JSON.stringify(sorted(value));
	}

	function stateProjection(run) {
		var result = {};
		Object.keys(run || {}).forEach(function (key) {
			if (key !== 'log') result[key] = clone(run[key]);
		});
		return result;
	}

	function error(message, code, details) {
		var result = new Error(message);
		result.code = code;
		if (details) Object.keys(details).forEach(function (key) { result[key] = details[key]; });
		return result;
	}

	function attemptIdOf(run) {
		var id = run && (run.attemptId || run.id);
		if (!id) throw error('A run.attemptId is required.', 'INVALID_RUN');
		return String(id);
	}

	function isSnapshotKind(kind) {
		return SNAPSHOT_KINDS.indexOf(kind) !== -1;
	}

	function snapshotFromPayload(payload, fallback) {
		if (isObject(payload)) {
			if (payload.run && isObject(payload.run)) return payload.run;
			if (payload.snapshot && isObject(payload.snapshot)) return payload.snapshot;
			if (payload.state && isObject(payload.state)) return payload.state;
		}
		return fallback;
	}

	function sourceInput(input, kind) {
		var source = isObject(input) ? clone(input) : {};
		if (!source.kind) source.kind = kind === 'command.applied' ? 'manual' : 'system';
		if (!source.providerId) source.providerId = source.kind === 'manual' ? 'runbun-browser' : 'attempt-store';
		if (source.confidence === undefined) source.confidence = source.kind === 'manual' ? 1 : 1;
		if (typeof source.kind !== 'string' || !source.kind || typeof source.providerId !== 'string' ||
			!source.providerId || typeof source.confidence !== 'number' || source.confidence < 0 || source.confidence > 1) {
			throw error('event.source is invalid.', 'INVALID_SOURCE');
		}
		var contract = runtimeContract();
		if (contract && contract.SOURCE_KINDS.indexOf(source.kind) === -1) {
			throw error('event.source.kind is unsupported.', 'INVALID_SOURCE');
		}
		return source;
	}

	function eventInput(input, attemptId, profileId, commandId) {
		if (!isObject(input)) throw error('An event is required.', 'INVALID_EVENT');
		if (typeof input.kind !== 'string' || !input.kind) {
			throw error('event.kind is required.', 'INVALID_EVENT');
		}
		return {
			schemaVersion: input.schemaVersion || MODEL_VERSION,
			eventId: input.eventId || attemptId + ':' + commandId,
			kind: input.kind,
			payload: isObject(input.payload) ? clone(input.payload) : {},
			observedAt: input.observedAt || now(),
			source: sourceInput(input.source, input.kind),
			profileId: input.profileId || profileId || 'run-and-bun',
			sourceSequence: Number.isInteger(input.sourceSequence) ? input.sourceSequence :
				(Number.isInteger(input.revision) ? input.revision : null),
			compatibility: isObject(input.compatibility) ? clone(input.compatibility) : null,
		};
	}

	function validateCommit(input) {
		if (!isObject(input) || !isObject(input.run)) throw error('run is required.', 'INVALID_COMMIT');
		var attemptId = attemptIdOf(input.run);
		var expectedRevision = input.expectedRevision;
		if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
			throw error('expectedRevision must be a non-negative integer.', 'INVALID_REVISION');
		}
		if (typeof input.commandId !== 'string' || !input.commandId) {
			throw error('commandId is required.', 'INVALID_COMMAND');
		}
		return {
			attemptId: attemptId,
			run: clone(input.run),
			expectedRevision: expectedRevision,
			commandId: input.commandId,
			event: eventInput(input.event, attemptId, input.run.profileId, input.commandId),
		};
	}

	function resultFor(attemptId, revision, run, event, stateHash, duplicate) {
		return {
			attemptId: attemptId,
			revision: revision,
			run: clone(run),
			event: clone(event),
			stateHash: stateHash,
			duplicate: Boolean(duplicate),
		};
	}

	function shouldSnapshot(kind, revision) {
		return isSnapshotKind(kind) || revision % SNAPSHOT_INTERVAL === 0;
	}

	function fingerprint(input) {
		return canonical({
			attemptId: input.attemptId,
			expectedRevision: input.expectedRevision,
			commandId: input.commandId,
			event: input.event,
			stateHash: input.stateHash,
		});
	}

	function compactEventPayload(kind, payload) {
		var result = isObject(payload) ? clone(payload) : payload;
		if (isSnapshotKind(kind) && isObject(result)) {
			delete result.run;
			delete result.snapshot;
			delete result.state;
		}
		return result;
	}

	function eventHashInput(event) {
		var result = clone(event);
		delete result.id;
		delete result.eventHash;
		return canonical(result);
	}

	function prepareEvent(input, head, revision) {
		var payload = compactEventPayload(input.event.kind, input.event.payload);
		if (input.event.kind === 'command.applied' && isObject(payload) &&
			Array.isArray(input.run.log) && input.run.log.length) {
			payload.logEntry = clone(input.run.log[input.run.log.length - 1]);
		}
		var event = {
			id: input.attemptId + ':' + revision,
			eventId: input.event.eventId,
			schemaVersion: MODEL_VERSION,
			attemptId: input.attemptId,
			profileId: input.event.profileId,
			revision: revision,
			sourceSequence: input.event.sourceSequence,
			commandId: input.commandId,
			kind: input.event.kind,
			payload: payload,
			observedAt: input.event.observedAt,
			source: clone(input.event.source),
			previousStateHash: head ? head.stateHash : null,
			stateHash: input.stateHash,
			previousEventHash: head && head.lastEventHash ? head.lastEventHash : null,
		};
		if (input.event.compatibility) event.compatibility = clone(input.event.compatibility);
		var contract = runtimeContract();
		if (contract) {
			try { contract.validateEvent(event); } catch (contractError) {
				throw error(contractError.message, 'INVALID_EVENT');
			}
		}
		return sha256(eventHashInput(event)).then(function (eventHash) {
			event.eventHash = eventHash;
			return event;
		});
	}

	function commitMemory(state, input) {
		var head = state.heads[input.attemptId];
		var key = input.attemptId + '::' + input.commandId;
		var prior = state.idempotency[key];
		var fp = fingerprint(input);
		if (prior) {
			if (prior.fingerprint !== fp) {
				throw error('commandId was already used with different data.', 'IDEMPOTENCY_CONFLICT', {
					attemptId: input.attemptId, commandId: input.commandId,
				});
			}
			return Promise.resolve(resultFor(input.attemptId, prior.revision,
				head && head.revision === prior.revision ? head.run : null,
				null, prior.stateHash, true));
		}
		var actual = head ? head.revision : 0;
		if (input.expectedRevision !== actual) {
			throw error('Revision conflict.', 'REVISION_CONFLICT', {
				attemptId: input.attemptId, expectedRevision: input.expectedRevision, actualRevision: actual,
			});
		}
		var revision = actual + 1;
		return prepareEvent(input, head, revision).then(function (event) {
			state.events.push(event);
			if (shouldSnapshot(event.kind, revision)) {
				state.snapshots.push({
					id: input.attemptId + ':' + revision,
					attemptId: input.attemptId,
					revision: revision,
					run: clone(input.snapshotRun),
					stateHash: input.snapshotHash,
					logRevision: isSnapshotKind(event.kind) ? revision : 0,
				});
			}
			state.heads[input.attemptId] = {
				attemptId: input.attemptId,
				revision: revision,
				run: clone(input.run),
				stateHash: input.stateHash,
				lastEventHash: event.eventHash,
			};
			state.activeAttemptId = input.attemptId;
			state.idempotency[key] = {
				id: key,
				attemptId: input.attemptId,
				commandId: input.commandId,
				fingerprint: fp,
				revision: revision,
				stateHash: input.stateHash,
				eventId: event.eventId,
				eventHash: event.eventHash,
			};
			return resultFor(input.attemptId, revision, input.run, event, input.stateHash, false);
		});
	}

	function makeMemoryState() {
		return {heads: {}, events: [], snapshots: [], idempotency: {}, evidence: {},
			archives: {}, activeAttemptId: null};
	}

	function serial(initial) {
		var tail = Promise.resolve();
		return function (work) {
			var next = tail.then(work);
			tail = next.catch(function () {});
			return next;
		};
	}

	function archiveId(entry) {
		if (entry.archiveId || entry.id) return String(entry.archiveId || entry.id);
		if (entry.attemptId) return String(entry.attemptId);
		return 'archive-' + Date.now() + '-' + Math.random().toString(16).slice(2);
	}

	function normalizeArchive(entry) {
		if (!isObject(entry)) throw error('An archive entry is required.', 'INVALID_ARCHIVE');
		var result = clone(entry);
		result.archiveId = archiveId(result);
		if (!result.archivedAt) result.archivedAt = result.endedAt || now();
		return result;
	}

	function makeBundle(inspected) {
		if (!inspected || !inspected.head) return null;
		var evidence = clone(inspected.evidence || []);
		return {
			format: SCHEMA,
			schema: SCHEMA,
			version: VERSION,
			schemaVersion: VERSION,
			modelVersion: MODEL_VERSION,
			attemptId: inspected.attemptId,
			exportedAt: now(),
			head: clone(inspected.head),
			run: clone(inspected.head.run),
			events: clone(inspected.events),
			snapshots: clone(inspected.snapshots),
			idempotency: clone(inspected.idempotency),
			evidence: evidence,
			manifest: {
				eventCount: inspected.events.length,
				snapshotCount: inspected.snapshots.length,
				idempotencyCount: inspected.idempotency.length,
				evidenceCount: evidence.length,
				headStateHash: inspected.head.stateHash,
				headEventHash: inspected.head.lastEventHash,
				headLogLength: Array.isArray(inspected.head.run.log) ? inspected.head.run.log.length : null,
			},
			checksumAlgorithm: 'SHA-256',
		};
	}

	function checksumInput(bundle) {
		var copy = clone(bundle);
		delete copy.checksum;
		delete copy.integrity;
		return canonical(copy);
	}

	function nodeSha256(value) {
		if (typeof module !== 'undefined' && module.exports && typeof require === 'function') {
			try {
				return require('crypto').createHash('sha256').update(value, 'utf8').digest('hex');
			} catch (ignore) {}
		}
		return null;
	}

	function sha256(value) {
		var nodeResult = nodeSha256(value);
		if (nodeResult) return Promise.resolve(nodeResult);
		var cryptoObject = root && root.crypto;
		if (!cryptoObject || !cryptoObject.subtle) return Promise.reject(error('SHA-256 is unavailable.', 'NO_SHA256'));
		var encoder = root.TextEncoder ? new root.TextEncoder() : null;
		var bytes = encoder ? encoder.encode(value) : new Uint8Array(unescape(encodeURIComponent(value)).split('').map(function (character) { return character.charCodeAt(0); }));
		return cryptoObject.subtle.digest('SHA-256', bytes).then(function (buffer) {
			return Array.prototype.map.call(new Uint8Array(buffer), function (byte) {
				return ('00' + byte.toString(16)).slice(-2);
			}).join('');
		});
	}

	function evidenceHashInput(record) {
		return canonical({
			schemaVersion: record.schemaVersion,
			evidenceId: record.evidenceId,
			attemptId: record.attemptId,
			attemptRevision: record.attemptRevision,
			stateHash: record.stateHash,
			kind: record.kind,
			request: record.request,
			receipt: record.receipt,
		});
	}

	function validatePlanningEvidence(input) {
		if (!isObject(input)) throw error('Planning evidence is required.', 'INVALID_EVIDENCE');
		var request = input.request;
		var receipt = input.receipt;
		if (!isObject(request) || request.capability !== 'pokemon.rab.plan' ||
			!isObject(request.attempt) || !isObject(request.task) ||
			request.task.kind !== 'plan' || !isObject(request.task.state) ||
			!isObject(request.profile) || typeof request.profile.revision !== 'string' ||
			!request.profile.revision || !Array.isArray(request.task.state.playerTeam) ||
			!request.task.state.playerTeam.length || request.task.state.playerTeam.length > 6 ||
			!isObject(request.task.state.trainer) ||
			!Number.isInteger(request.task.state.trainer.order) ||
			request.task.state.trainer.order < 1 || !Array.isArray(request.task.seeds) ||
			!request.task.seeds.length || request.task.seeds.length > 4096) {
			throw error('Planning evidence request is invalid.', 'INVALID_EVIDENCE');
		}
		var seedSet = {};
		request.task.seeds.forEach(function (seed) {
			if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff || seedSet[seed]) {
				throw error('Planning evidence seeds must be unique UINT32 values.', 'INVALID_EVIDENCE');
			}
			seedSet[seed] = true;
		});
		if (!isObject(receipt) || receipt.requestId !== request.requestId ||
			!isObject(receipt.producer) || receipt.producer.repository !== 'pokemon-mono' ||
			typeof receipt.producer.revision !== 'string' || !receipt.producer.revision ||
			!isObject(receipt.input) || !isObject(receipt.result) ||
			!isObject(receipt.result.summary) || !isObject(receipt.evidence)) {
			throw error('Planning evidence receipt is invalid.', 'INVALID_EVIDENCE');
		}
		var summary = receipt.result.summary;
		if (receipt.input.attemptId !== request.attempt.attemptId ||
			receipt.input.revision !== request.attempt.revision ||
			receipt.input.stateHash !== request.attempt.stateHash ||
			receipt.input.profileRevision !== request.profile.revision ||
			canonical(receipt.input.seeds) !== canonical(request.task.seeds) ||
			summary.trainerOrder !== request.task.state.trainer.order ||
			!Array.isArray(summary.branchOutcomes) ||
			summary.branchOutcomes.length !== request.task.seeds.length ||
			summary.branchesEvaluated !== summary.branchOutcomes.length ||
			!(/^[a-f0-9]{64}$/).test(receipt.result.outputHash || '') ||
			!(/^[a-f0-9]{64}$/).test(receipt.evidence.replayHash || '') ||
			receipt.evidence.deterministic !== true ||
			!Array.isArray(receipt.evidence.unexpectedDivergences) ||
			receipt.evidence.unexpectedDivergences.length) {
			throw error('Planning evidence does not bind to its request.', 'INVALID_EVIDENCE');
		}
		var evidenceId = receipt.receiptId || 'pokemon.rab.plan:' + request.requestId;
		if (typeof evidenceId !== 'string' || !evidenceId ||
			typeof request.attempt.attemptId !== 'string' || !request.attempt.attemptId ||
			!Number.isInteger(request.attempt.revision) || request.attempt.revision < 0 ||
			!(/^[a-f0-9]{64}$/).test(request.attempt.stateHash || '')) {
			throw error('Planning evidence identity is invalid.', 'INVALID_EVIDENCE');
		}
		var recordedAt = input.recordedAt || now();
		if (typeof recordedAt !== 'string' || Number.isNaN(Date.parse(recordedAt))) {
			throw error('Planning evidence recordedAt must be an ISO timestamp.', 'INVALID_EVIDENCE');
		}
		return {
			id: request.attempt.attemptId + '::' + evidenceId,
			schemaVersion: EVIDENCE_SCHEMA,
			evidenceId: evidenceId,
			attemptId: request.attempt.attemptId,
			attemptRevision: request.attempt.revision,
			stateHash: request.attempt.stateHash,
			kind: 'pokemon.rab.plan',
			recordedAt: recordedAt,
			request: clone(request),
			receipt: clone(receipt),
		};
	}

	function validateAttributionEvidence(input) {
		if (!isObject(input)) throw error('Attribution evidence is required.', 'INVALID_EVIDENCE');
		var request = input.request;
		var receipt = input.receipt;
		var task = request && request.task;
		var state = task && task.state;
		var constraints = task && task.constraints;
		if (!isObject(request) ||
			request.schemaVersion !== 'pokemon.bridge.attribution.request/1.0.0' ||
			request.capability !== 'pokemon.rab.attribute' || !isObject(request.attempt) ||
			!isObject(request.profile) || request.profile.id !== 'run-and-bun' ||
			!isObject(task) || task.kind !== 'attribute' || !isObject(state) ||
			state.kind !== 'run-and-bun.attribution-input' ||
			state.startingCondition !== 'full-health-no-status-full-pp' ||
			!isObject(state.trainer) || !Number.isInteger(state.trainer.order) ||
			state.trainer.order < 1 || !Array.isArray(state.baselineTeam) ||
			!state.baselineTeam.length || state.baselineTeam.length > 6 ||
			!Array.isArray(task.interventions) || !task.interventions.length ||
			task.interventions.length > 32 || !Array.isArray(task.seeds) ||
			!task.seeds.length || task.seeds.length > 10000 || !isObject(constraints) ||
			constraints.zeroDeaths !== true || constraints.wholeBranch !== true ||
			constraints.policy !== 'reoptimize-lead-v1' ||
			!Number.isInteger(constraints.maxCandidateBranches) ||
			constraints.maxCandidateBranches < 1 || constraints.maxCandidateBranches > 262144) {
			throw error('Attribution evidence request is invalid.', 'INVALID_EVIDENCE');
		}
		var seeds = {};
		task.seeds.forEach(function (seed) {
			if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff || seeds[seed]) {
				throw error('Attribution seeds must be unique UINT32 values.', 'INVALID_EVIDENCE');
			}
			seeds[seed] = true;
		});
		var interventionIds = {};
		task.interventions.forEach(function (intervention) {
			if (!isObject(intervention) || typeof intervention.interventionId !== 'string' ||
				!intervention.interventionId || interventionIds[intervention.interventionId] ||
				typeof intervention.targetId !== 'string' || !intervention.targetId ||
				['replace-party-member', 'normalize-ivs'].indexOf(intervention.kind) === -1) {
				throw error('Attribution intervention is invalid.', 'INVALID_EVIDENCE');
			}
			interventionIds[intervention.interventionId] = true;
			if (intervention.kind === 'replace-party-member' &&
				(!isObject(intervention.replacement) || !isObject(intervention.ownership) ||
				typeof intervention.ownership.sourceEventId !== 'string' ||
				!(/^[a-f0-9]{64}$/).test(intervention.ownership.sourceEventHash || '') ||
				!Number.isInteger(intervention.ownership.acquiredRevision))) {
				throw error('Replacement attribution lacks acquisition provenance.', 'INVALID_EVIDENCE');
			}
			if (intervention.kind === 'normalize-ivs' &&
				(intervention.reference !== 'all-15-reference' || !isObject(intervention.ivs) ||
				['hp', 'atk', 'def', 'spa', 'spd', 'spe'].some(function (stat) {
					return intervention.ivs[stat] !== 15;
				}))) throw error('IV attribution reference is invalid.', 'INVALID_EVIDENCE');
		});
		var candidateBranches = (task.interventions.length + 1) *
			state.baselineTeam.length * task.seeds.length;
		if (candidateBranches > constraints.maxCandidateBranches) {
			throw error('Attribution branch budget is exceeded.', 'INVALID_EVIDENCE');
		}
		if (!isObject(receipt) ||
			receipt.schemaVersion !== 'pokemon.bridge.attribution.receipt/1.0.0' ||
			receipt.requestId !== request.requestId || !isObject(receipt.producer) ||
			receipt.producer.repository !== 'pokemon-mono' ||
			typeof receipt.producer.revision !== 'string' || !receipt.producer.revision ||
			!isObject(receipt.input) || !isObject(receipt.result) ||
			receipt.result.status !== 'complete' || !isObject(receipt.result.baseline) ||
			!Array.isArray(receipt.result.interventions) ||
			receipt.result.interventions.length !== task.interventions.length ||
			!isObject(receipt.result.summary) || !isObject(receipt.evidence)) {
			throw error('Attribution evidence receipt is invalid.', 'INVALID_EVIDENCE');
		}
		function validOutcome(outcome) {
			return isObject(outcome) && typeof outcome.recommendedLeadId === 'string' &&
				outcome.recommendedLeadId && Number.isInteger(outcome.safeBranches) &&
				outcome.safeBranches >= 0 && outcome.safeBranches <= task.seeds.length &&
				Number.isInteger(outcome.losses) && Number.isInteger(outcome.totalDeaths) &&
				outcome.losses >= 0 && outcome.totalDeaths >= 0 &&
				Number.isFinite(outcome.expectedTurns) && outcome.expectedTurns >= 0 &&
				Number.isInteger(outcome.startingTotalHP) && outcome.startingTotalHP >= 0 &&
				Array.isArray(outcome.branchOutcomes) &&
				outcome.branchOutcomes.length === task.seeds.length &&
				outcome.branchOutcomes.every(function (branch, index) {
					return isObject(branch) && branch.seed === task.seeds[index] &&
						typeof branch.victory === 'boolean' && Number.isInteger(branch.deaths) &&
						branch.deaths >= 0 && Number.isInteger(branch.turns) && branch.turns >= 0 &&
						Number.isInteger(branch.totalHPRemaining) && branch.totalHPRemaining >= 0;
				});
		}
		function validDelta(delta) {
			return isObject(delta) && ['safeBranches', 'wins', 'deaths', 'totalHPRemaining',
				'changedOutcomeBranches', 'changedDeathlessBranches'].every(function (field) {
				return Number.isInteger(delta[field]);
			}) && delta.changedOutcomeBranches >= 0 && delta.changedDeathlessBranches >= 0 &&
				Number.isFinite(delta.expectedTurns);
		}
		if (receipt.input.attemptId !== request.attempt.attemptId ||
			receipt.input.revision !== request.attempt.revision ||
			receipt.input.stateHash !== request.attempt.stateHash ||
			receipt.input.profileRevision !== request.profile.revision ||
			receipt.input.trainerOrder !== state.trainer.order ||
			receipt.input.policy !== constraints.policy ||
			receipt.input.maxCandidateBranches !== constraints.maxCandidateBranches ||
			canonical(receipt.input.seeds) !== canonical(task.seeds) ||
			canonical(receipt.input.interventionIds) !== canonical(task.interventions.map(function (row) {
				return row.interventionId;
			})) || !validOutcome(receipt.result.baseline) ||
			receipt.result.summary.seedPairsEvaluated !== task.seeds.length * task.interventions.length ||
			receipt.result.summary.candidateBranchesEvaluated !== candidateBranches ||
			!(/^[a-f0-9]{64}$/).test(receipt.input.requestHash || '') ||
			!(/^[a-f0-9]{64}$/).test(receipt.input.baselineTeamHash || '') ||
			!(/^[a-f0-9]{64}$/).test(receipt.result.outputHash || '') ||
			!(/^[a-f0-9]{64}$/).test(receipt.evidence.replayHash || '') ||
			receipt.evidence.deterministic !== true ||
			!Array.isArray(receipt.evidence.expectedDivergences) ||
			receipt.evidence.expectedDivergences.length ||
			!Array.isArray(receipt.evidence.unexpectedDivergences) ||
			receipt.evidence.unexpectedDivergences.length) {
			throw error('Attribution evidence does not bind to its request.', 'INVALID_EVIDENCE');
		}
		receipt.result.interventions.forEach(function (result, index) {
			var intervention = task.interventions[index];
			if (!isObject(result) || result.interventionId !== intervention.interventionId ||
				result.kind !== intervention.kind || result.targetId !== intervention.targetId ||
				!(/^[a-f0-9]{64}$/).test(result.effectiveTeamHash || '') ||
				!validOutcome(result.outcome) || !validDelta(result.delta)) {
				throw error('Attribution intervention result is invalid.', 'INVALID_EVIDENCE');
			}
		});
		var evidenceId = receipt.receiptId || 'pokemon.rab.attribute:' + request.requestId;
		if (typeof evidenceId !== 'string' || !evidenceId ||
			typeof request.attempt.attemptId !== 'string' || !request.attempt.attemptId ||
			!Number.isInteger(request.attempt.revision) || request.attempt.revision < 1 ||
			!(/^[a-f0-9]{64}$/).test(request.attempt.stateHash || '')) {
			throw error('Attribution evidence identity is invalid.', 'INVALID_EVIDENCE');
		}
		var recordedAt = input.recordedAt || now();
		if (typeof recordedAt !== 'string' || Number.isNaN(Date.parse(recordedAt))) {
			throw error('Attribution evidence recordedAt must be an ISO timestamp.', 'INVALID_EVIDENCE');
		}
		return {
			id: request.attempt.attemptId + '::' + evidenceId,
			schemaVersion: EVIDENCE_SCHEMA,
			evidenceId: evidenceId,
			attemptId: request.attempt.attemptId,
			attemptRevision: request.attempt.revision,
			stateHash: request.attempt.stateHash,
			kind: 'pokemon.rab.attribute',
			recordedAt: recordedAt,
			request: clone(request),
			receipt: clone(receipt),
		};
	}

	function validateAttributionOwnership(record, events, code) {
		if (!record || record.kind !== 'pokemon.rab.attribute') return;
		var byId = {};
		(events || []).forEach(function (event) { byId[event.eventId] = event; });
		record.request.task.interventions.forEach(function (intervention) {
			if (intervention.kind !== 'replace-party-member') return;
			var ownership = intervention.ownership;
			var source = byId[ownership.sourceEventId];
			var matchesStart = source && source.kind === 'run.started' && source.payload &&
				source.payload.run && Array.isArray(source.payload.run.box) &&
				source.payload.run.box.some(function (mon) {
					return mon && mon.id === intervention.replacement.id &&
						mon.species === intervention.replacement.species;
				});
			var matchesCatch = source && source.kind === 'command.applied' && source.payload &&
				source.payload.command && source.payload.command.kind === 'catch' &&
				source.payload.command.species === intervention.replacement.species &&
				source.payload.result &&
				source.payload.result.pokemonId === intervention.replacement.id;
			if (!source || source.eventHash !== ownership.sourceEventHash ||
				source.revision !== ownership.acquiredRevision ||
				source.revision > record.attemptRevision || (!matchesStart && !matchesCatch)) {
				throw error('Replacement attribution does not match its acquisition event.',
					code || 'INVALID_EVIDENCE');
			}
		});
	}

	function validateEvidenceState(record, events, code) {
		var boundEvent = (events || []).find(function (event) {
			return event.attemptId === record.attemptId && event.revision === record.attemptRevision;
		});
		if (!boundEvent || boundEvent.stateHash !== record.stateHash) {
			throw error('Simulator evidence does not match its bound attempt revision.',
				code || 'INVALID_EVIDENCE');
		}
	}

	function prepareEvidence(input) {
		var capability = input && input.request && input.request.capability;
		var record = capability === 'pokemon.rab.attribute' ?
			validateAttributionEvidence(input) : validatePlanningEvidence(input);
		return sha256(evidenceHashInput(record)).then(function (evidenceHash) {
			record.evidenceHash = evidenceHash;
			return record;
		});
	}

	function prepareEvidenceBatch(inputs) {
		if (!Array.isArray(inputs) || !inputs.length || inputs.length > 1024) {
			return Promise.reject(error('Evidence batch must contain 1 through 1024 records.',
				'INVALID_EVIDENCE'));
		}
		return Promise.all(inputs.map(prepareEvidence)).then(function (records) {
			var attemptId = records[0].attemptId;
			var ids = {};
			records.forEach(function (record) {
				if (record.attemptId !== attemptId) {
					throw error('Evidence batch must belong to one attempt.', 'INVALID_EVIDENCE');
				}
				if (ids[record.id]) throw error('Evidence batch IDs must be unique.', 'INVALID_EVIDENCE');
				ids[record.id] = true;
			});
			return records;
		});
	}

	function validateEvidenceShape(record, attemptId, events) {
		if (!isObject(record) || record.schemaVersion !== EVIDENCE_SCHEMA ||
			['pokemon.rab.plan', 'pokemon.rab.attribute'].indexOf(record.kind) === -1 ||
			record.attemptId !== attemptId ||
			record.id !== record.attemptId + '::' + record.evidenceId ||
			!Number.isInteger(record.attemptRevision) || record.attemptRevision < 0 ||
			!(/^[a-f0-9]{64}$/).test(record.stateHash || '') ||
			!(/^[a-f0-9]{64}$/).test(record.evidenceHash || '') ||
			!isObject(record.request) || !isObject(record.receipt) ||
			record.request.requestId !== record.receipt.requestId) {
			throw error('Archive simulator evidence is invalid.', 'INVALID_BUNDLE');
		}
		if (record.kind === 'pokemon.rab.attribute') {
			validateAttributionEvidence({request: record.request, receipt: record.receipt,
				recordedAt: record.recordedAt});
			validateAttributionOwnership(record, events, 'INVALID_BUNDLE');
		} else {
			validatePlanningEvidence({request: record.request, receipt: record.receipt,
				recordedAt: record.recordedAt});
		}
		validateEvidenceState(record, events, 'INVALID_BUNDLE');
	}

	function addChecksum(bundle) {
		return sha256(checksumInput(bundle)).then(function (value) {
			var result = clone(bundle);
			result.checksum = value;
			return result;
		});
	}

	function prepareIntegrity(prepared) {
		var runValue = canonical(stateProjection(prepared.run));
		var materialized = snapshotFromPayload(prepared.event.payload, prepared.run);
		prepared.snapshotRun = isSnapshotKind(prepared.event.kind) ? clone(materialized) : stateProjection(materialized);
		var snapshotValue = canonical(stateProjection(prepared.snapshotRun));
		return sha256(runValue).then(function (stateHash) {
			prepared.stateHash = stateHash;
			if (snapshotValue === runValue) {
				prepared.snapshotHash = stateHash;
				return prepared;
			}
			return sha256(snapshotValue).then(function (snapshotHash) {
				prepared.snapshotHash = snapshotHash;
				return prepared;
			});
		});
	}

	function compactReceipt(receipt, event) {
		return {
			id: receipt.id || receipt.attemptId + '::' + receipt.commandId,
			attemptId: receipt.attemptId,
			commandId: receipt.commandId,
			fingerprint: receipt.fingerprint,
			revision: receipt.revision,
			stateHash: receipt.stateHash || (event && event.stateHash),
			eventId: receipt.eventId || (event && event.eventId),
			eventHash: receipt.eventHash || (event && event.eventHash),
		};
	}

	function upgradeInspection(inspected) {
		if (!inspected || !inspected.head) return Promise.resolve(inspected);
		var result = clone(inspected);
		result.events.sort(function (a, b) { return a.revision - b.revision; });
		result.snapshots.sort(function (a, b) { return a.revision - b.revision; });
		var stateWork = [sha256(canonical(stateProjection(result.head.run)))].concat(
			result.snapshots.map(function (snapshot) { return sha256(canonical(stateProjection(snapshot.run))); }));
		return Promise.all(stateWork).then(function (hashes) {
			result.head.stateHash = hashes[0];
			result.snapshots.forEach(function (snapshot, index) {
				snapshot.stateHash = hashes[index + 1];
				if (!Number.isInteger(snapshot.logRevision)) snapshot.logRevision = isSnapshotKind(
					(result.events[snapshot.revision - 1] || {}).kind) ? snapshot.revision : 0;
			});
			var previousEventHash = null;
			var commandEntries = Array.isArray(result.head.run.log) ? result.head.run.log : [];
			var commandIndex = 0;
			var snapshotsByRevision = {};
			result.snapshots.forEach(function (snapshot) { snapshotsByRevision[snapshot.revision] = snapshot; });
			return result.events.reduce(function (chain, event, index) {
				return chain.then(function () {
					var previous = index ? result.events[index - 1] : null;
					var contract = runtimeContract();
					if (event.kind === 'runtime.observed' && isObject(event.payload) && isObject(event.payload.event) && contract) {
						var observed = contract.normalizeEvent(event.payload.event);
						event.eventId = observed.eventId;
						event.kind = observed.kind;
						event.payload = observed.payload;
						event.source = observed.source;
						event.sourceSequence = observed.revision !== undefined ? observed.revision : observed.sourceSequence;
						event.observedAt = observed.observedAt;
						event.compatibility = observed.compatibility;
					}
					event.id = result.attemptId + ':' + event.revision;
					event.eventId = event.eventId || event.id;
					event.schemaVersion = MODEL_VERSION;
					event.attemptId = result.attemptId;
					event.profileId = event.profileId || result.head.run.profileId || 'run-and-bun';
					event.sourceSequence = Number.isInteger(event.sourceSequence) ? event.sourceSequence : null;
					event.source = sourceInput(event.source || {kind: 'migration', providerId: 'attempt-store-v2-upcaster', confidence: 1}, event.kind);
					event.payload = compactEventPayload(event.kind, event.payload);
					if (isSnapshotKind(event.kind) && snapshotsByRevision[event.revision]) {
						commandIndex = (snapshotsByRevision[event.revision].run.log || []).length;
					} else if (event.kind === 'command.applied') {
						if (!isObject(event.payload)) event.payload = {};
						if (!event.payload.logEntry && commandEntries[commandIndex]) {
							event.payload.logEntry = clone(commandEntries[commandIndex]);
						}
						commandIndex += 1;
					}
					event.previousStateHash = previous ? previous.stateHash : null;
					if (index === result.events.length - 1) event.stateHash = result.head.stateHash;
					event.previousEventHash = previousEventHash;
					if (contract) contract.validateEvent(event);
					return sha256(eventHashInput(event)).then(function (eventHash) {
						event.eventHash = eventHash;
						previousEventHash = eventHash;
					});
				});
			}, Promise.resolve()).then(function () {
				result.head.lastEventHash = previousEventHash;
				var byRevision = {};
				result.events.forEach(function (event) { byRevision[event.revision] = event; });
				result.idempotency = result.idempotency.map(function (receipt) {
					return compactReceipt(receipt, byRevision[receipt.revision]);
				});
				return result;
			});
		});
	}

	function checksumValue(bundle) {
		if (typeof bundle.checksum === 'string') return bundle.checksum;
		if (isObject(bundle.checksum) && typeof bundle.checksum.value === 'string') return bundle.checksum.value;
		if (isObject(bundle.integrity) && typeof bundle.integrity.value === 'string') return bundle.integrity.value;
		return null;
	}

	function validateShape(bundle) {
		var hashPattern = /^[a-f0-9]{64}$/;
		var evidence = bundle && bundle.evidence === undefined ? [] : bundle && bundle.evidence;
		if (!isObject(bundle) || (bundle.format || bundle.schema) !== SCHEMA ||
			(bundle.version || bundle.schemaVersion) !== VERSION || bundle.modelVersion !== MODEL_VERSION) {
			throw error('Unsupported archive bundle.', 'INVALID_BUNDLE');
		}
		if (typeof bundle.attemptId !== 'string' || !bundle.attemptId || !isObject(bundle.head)) {
			throw error('Archive bundle identity is invalid.', 'INVALID_BUNDLE');
		}
		if (bundle.head.attemptId !== bundle.attemptId || !Number.isInteger(bundle.head.revision) || bundle.head.revision < 0 ||
			!isObject(bundle.head.run) || !hashPattern.test(bundle.head.stateHash || '') ||
			!hashPattern.test(bundle.head.lastEventHash || '')) {
			throw error('Archive bundle head is invalid.', 'INVALID_BUNDLE');
		}
		if (attemptIdOf(bundle.head.run) !== bundle.attemptId || !Array.isArray(bundle.events) ||
			!Array.isArray(bundle.snapshots) || !Array.isArray(bundle.idempotency) ||
			!Array.isArray(evidence) ||
			!isObject(bundle.run) ||
			canonical(bundle.run) !== canonical(bundle.head.run)) {
			throw error('Archive bundle contents are invalid.', 'INVALID_BUNDLE');
		}
		if (!isObject(bundle.manifest) || bundle.manifest.eventCount !== bundle.events.length ||
			bundle.manifest.snapshotCount !== bundle.snapshots.length ||
			bundle.manifest.idempotencyCount !== bundle.idempotency.length ||
			(bundle.evidence === undefined ? bundle.manifest.evidenceCount !== undefined :
				bundle.manifest.evidenceCount !== evidence.length) ||
			bundle.manifest.headStateHash !== bundle.head.stateHash ||
			bundle.manifest.headEventHash !== bundle.head.lastEventHash ||
			bundle.manifest.headLogLength !== (Array.isArray(bundle.head.run.log) ? bundle.head.run.log.length : null)) {
			throw error('Archive bundle manifest does not match its contents.', 'INVALID_BUNDLE');
		}
		var revisions = bundle.events.map(function (event, index) {
			var expectedPrevious = index === 0 ? null : bundle.events[index - 1].stateHash;
			var expectedPreviousEvent = index === 0 ? null : bundle.events[index - 1].eventHash;
			if (!isObject(event) || event.attemptId !== bundle.attemptId || event.revision !== index + 1 ||
				typeof event.kind !== 'string' || !hashPattern.test(event.stateHash || '') ||
				event.previousStateHash !== expectedPrevious || event.schemaVersion !== MODEL_VERSION ||
				!hashPattern.test(event.eventHash || '') || event.previousEventHash !== expectedPreviousEvent ||
				!isObject(event.source) || typeof event.eventId !== 'string' || !event.eventId) {
				throw error('Archive events must be contiguous.', 'INVALID_BUNDLE');
			}
			return event.revision;
		});
		if (revisions.length !== bundle.head.revision) throw error('Archive head revision does not match events.', 'INVALID_BUNDLE');
		if (bundle.events.length && bundle.events[bundle.events.length - 1].stateHash !== bundle.head.stateHash) {
			throw error('Archive head hash does not match its final event.', 'INVALID_BUNDLE');
		}
		if (bundle.events.length && bundle.events[bundle.events.length - 1].eventHash !== bundle.head.lastEventHash) {
			throw error('Archive head event hash does not match its final event.', 'INVALID_BUNDLE');
		}
		if (bundle.events.some(function (event) { return !event.commandId; })) throw error('Archive event commandId is missing.', 'INVALID_BUNDLE');
		if (bundle.snapshots.some(function (snapshot) {
			return !isObject(snapshot) || snapshot.attemptId !== bundle.attemptId ||
				!Number.isInteger(snapshot.revision) || snapshot.revision < 1 || !isObject(snapshot.run) ||
				!hashPattern.test(snapshot.stateHash || '');
		})) throw error('Archive snapshot is invalid.', 'INVALID_BUNDLE');
		if (bundle.idempotency.some(function (receipt) {
			return !isObject(receipt) || receipt.attemptId !== bundle.attemptId ||
				typeof receipt.commandId !== 'string' || !receipt.commandId ||
				!hashPattern.test(receipt.stateHash || '');
		})) throw error('Archive idempotency receipt is invalid.', 'INVALID_BUNDLE');
		evidence.forEach(function (record) {
			validateEvidenceShape(record, bundle.attemptId, bundle.events);
		});
	}

	function validateMaterializedLog(bundle) {
		if (!Array.isArray(bundle.head.run.log)) return;
		var snapshots = {};
		bundle.snapshots.forEach(function (snapshot) { snapshots[snapshot.revision] = snapshot; });
		var log = [];
		bundle.events.forEach(function (event) {
			if (isSnapshotKind(event.kind)) {
				var snapshot = snapshots[event.revision];
				if (!snapshot || !Array.isArray(snapshot.run.log)) {
					throw error('A lifecycle snapshot is missing its command log.', 'INVALID_BUNDLE');
				}
				log = clone(snapshot.run.log);
				return;
			}
			if (event.kind === 'command.applied') {
				if (!isObject(event.payload) || !isObject(event.payload.logEntry)) {
					throw error('A command event is missing its materialized log entry.', 'INVALID_BUNDLE');
				}
				log.push(clone(event.payload.logEntry));
			}
		});
		if (canonical(log) !== canonical(bundle.head.run.log)) {
			throw error('The materialized command log does not match the event ledger.', 'CORRUPT_LOG');
		}
	}

	function validateLegacyShape(bundle) {
		var hashPattern = /^[a-f0-9]{64}$/;
		if (!isObject(bundle) || (bundle.format || bundle.schema) !== SCHEMA ||
			(bundle.version || bundle.schemaVersion) !== VERSION || bundle.modelVersion) {
			throw error('Unsupported legacy archive bundle.', 'UNSUPPORTED_VERSION');
		}
		if (typeof bundle.attemptId !== 'string' || !bundle.attemptId || !isObject(bundle.head) ||
			bundle.head.attemptId !== bundle.attemptId || !Number.isInteger(bundle.head.revision) ||
			!isObject(bundle.head.run) || !hashPattern.test(bundle.head.stateHash || '') ||
			!isObject(bundle.run) || canonical(bundle.run) !== canonical(bundle.head.run) ||
			!Array.isArray(bundle.events) || !Array.isArray(bundle.snapshots) || !Array.isArray(bundle.idempotency)) {
			throw error('Legacy archive bundle is invalid.', 'INVALID_BUNDLE');
		}
		if (!isObject(bundle.manifest) || bundle.manifest.eventCount !== bundle.events.length ||
			bundle.manifest.snapshotCount !== bundle.snapshots.length ||
			bundle.manifest.idempotencyCount !== bundle.idempotency.length ||
			bundle.manifest.headStateHash !== bundle.head.stateHash) {
			throw error('Legacy archive manifest does not match its contents.', 'INVALID_BUNDLE');
		}
		bundle.events.forEach(function (event, index) {
			var previous = index ? bundle.events[index - 1].stateHash : null;
			if (!isObject(event) || event.attemptId !== bundle.attemptId || event.revision !== index + 1 ||
				typeof event.kind !== 'string' || !event.commandId || !hashPattern.test(event.stateHash || '') ||
				event.previousStateHash !== previous) {
				throw error('Legacy archive events are invalid.', 'INVALID_BUNDLE');
			}
		});
		if (bundle.events.length !== bundle.head.revision ||
			(bundle.events.length && bundle.events[bundle.events.length - 1].stateHash !== bundle.head.stateHash)) {
			throw error('Legacy archive head does not match its events.', 'INVALID_BUNDLE');
		}
	}

	function validateLegacyBundle(bundle) {
		validateLegacyShape(bundle);
		var expected = checksumValue(bundle);
		if (!expected) return Promise.reject(error('Archive checksum is missing.', 'INVALID_CHECKSUM'));
		return sha256(checksumInput(bundle)).then(function (actual) {
			if (actual !== expected) throw error('Archive checksum does not match.', 'CORRUPT_BUNDLE');
			var states = [{run: bundle.head.run, stateHash: bundle.head.stateHash}].concat(bundle.snapshots);
			return Promise.all(states.map(function (state) { return sha256(canonical(state.run)); })).then(function (hashes) {
				if (hashes.some(function (hash, index) { return hash !== states[index].stateHash; })) {
					throw error('A legacy archived state does not match its state hash.', 'CORRUPT_STATE');
				}
				return true;
			});
		});
	}

	function upgradeBundle(bundle) {
		if (bundle && bundle.modelVersion === MODEL_VERSION) {
			return validateBundle(bundle).then(function () { return clone(bundle); });
		}
		return validateLegacyBundle(bundle).then(function () {
			return upgradeInspection({
				attemptId: bundle.attemptId,
				head: bundle.head,
				events: bundle.events,
				snapshots: bundle.snapshots,
				idempotency: bundle.idempotency,
			}).then(function (inspected) { return addChecksum(makeBundle(inspected)); });
		});
	}

	function validateBundle(bundle) {
		return Promise.resolve().then(function () {
			if (bundle && !bundle.modelVersion) return validateLegacyBundle(bundle);
			validateShape(bundle);
			validateMaterializedLog(bundle);
			var expected = checksumValue(bundle);
			if (!expected) throw error('Archive checksum is missing.', 'INVALID_CHECKSUM');
			return sha256(checksumInput(bundle)).then(function (actual) {
				if (actual !== expected) throw error('Archive checksum does not match.', 'CORRUPT_BUNDLE');
				var states = [{run: bundle.head.run, stateHash: bundle.head.stateHash}].concat(bundle.snapshots);
				return Promise.all(states.map(function (state) { return sha256(canonical(stateProjection(state.run))); })).then(function (hashes) {
					if (hashes.some(function (hash, index) { return hash !== states[index].stateHash; })) {
						throw error('An archived state does not match its state hash.', 'CORRUPT_STATE');
					}
					return Promise.all(bundle.events.map(function (event) {
						return sha256(eventHashInput(event));
					})).then(function (eventHashes) {
						if (eventHashes.some(function (hash, index) { return hash !== bundle.events[index].eventHash; })) {
							throw error('An archived event does not match its event hash.', 'CORRUPT_EVENT');
						}
						var evidence = bundle.evidence || [];
						return Promise.all(evidence.map(function (record) {
							return sha256(evidenceHashInput(record));
						})).then(function (hashes) {
							if (hashes.some(function (hash, index) {
								return hash !== evidence[index].evidenceHash;
							})) {
								throw error('Archived simulator evidence does not match its hash.',
									'CORRUPT_EVIDENCE');
							}
							return true;
						});
					});
				});
			});
		});
	}

	function replayBundle(bundle, applyCommand) {
		return validateBundle(bundle).then(function () {
			var current = null;
			var snapshots = {};
			(bundle.snapshots || []).forEach(function (snapshot) { snapshots[snapshot.revision] = snapshot.run; });
			var events = bundle.events.slice().sort(function (a, b) { return a.revision - b.revision; });
			return events.reduce(function (chain, event) {
				return chain.then(function () {
					if (isSnapshotKind(event.kind)) {
						current = clone(snapshotFromPayload(event.payload, snapshots[event.revision] || event.snapshot || bundle.head.run));
						return undefined;
					}
					if (event.kind !== 'command.applied') return undefined;
					if (typeof applyCommand !== 'function') throw error('applyCommand is required for command.applied.', 'MISSING_REPLAY_HANDLER');
					var payload = clone(event.payload);
					var command = isObject(payload) && Object.prototype.hasOwnProperty.call(payload, 'command') ? payload.command : payload;
					return Promise.resolve(applyCommand(clone(current), clone(command), clone(event))).then(function (next) {
						if (next && isObject(next) && isObject(next.run)) current = clone(next.run);
						else if (next !== undefined) current = clone(next);
					});
				});
			}, Promise.resolve()).then(function () {
				if (!current) current = clone(bundle.head.run);
				if (canonical(current) !== canonical(bundle.head.run)) {
					throw error('Replayed run does not match the archived head.', 'REPLAY_MISMATCH');
				}
				return {
					attemptId: bundle.attemptId,
					revision: bundle.head.revision,
					run: clone(current),
				};
			});
		});
	}

	function createMemoryStore() {
		var state = makeMemoryState();
		var enqueue = serial();
		function inspectAttempt(attemptId) {
			return enqueue(function () {
				var id = String(attemptId);
				if (!state.heads[id]) return null;
				return {
					attemptId: id,
					head: clone(state.heads[id]),
					events: clone(state.events.filter(function (event) { return event.attemptId === id; })),
					snapshots: clone(state.snapshots.filter(function (snapshot) { return snapshot.attemptId === id; })),
					idempotency: Object.keys(state.idempotency).map(function (key) {
						return state.idempotency[key];
					}).filter(function (receipt) { return receipt.attemptId === id; }).map(clone),
					evidence: Object.keys(state.evidence).map(function (key) {
						return state.evidence[key];
					}).filter(function (record) { return record.attemptId === id; })
						.sort(function (a, b) { return a.recordedAt.localeCompare(b.recordedAt); }).map(clone),
				};
			});
		}
		function exportAttempt(attemptId) {
			return inspectAttempt(attemptId).then(function (inspected) {
				return upgradeInspection(inspected).then(function (upgraded) {
					var bundle = makeBundle(upgraded);
					return bundle ? addChecksum(bundle) : null;
				});
			});
		}
		function recordEvidenceBatch(inputs) {
			return prepareEvidenceBatch(inputs).then(function (prepared) {
				return enqueue(function () {
					var head = state.heads[prepared[0].attemptId];
					if (!head) throw error('Evidence attempt does not exist.', 'MISSING_ATTEMPT');
					var attemptEvents = state.events.filter(function (event) {
						return event.attemptId === prepared[0].attemptId;
					});
					prepared.forEach(function (record) {
						if (record.attemptRevision > head.revision) {
							throw error('Evidence revision is ahead of the attempt.', 'INVALID_EVIDENCE');
						}
						validateEvidenceState(record, attemptEvents, 'INVALID_EVIDENCE');
						validateAttributionOwnership(record, attemptEvents, 'INVALID_EVIDENCE');
						var prior = state.evidence[record.id];
						if (prior && prior.evidenceHash !== record.evidenceHash) {
							throw error('Evidence identity was reused with different content.',
								'EVIDENCE_CONFLICT');
						}
					});
					return prepared.map(function (record) {
						var prior = state.evidence[record.id];
						if (prior) return Object.assign(clone(prior), {duplicate: true});
						state.evidence[record.id] = clone(record);
						return Object.assign(clone(record), {duplicate: false});
					});
				});
			});
		}
		return {
			commit: function (input) {
				var prepared = validateCommit(input);
				return prepareIntegrity(prepared).then(function () {
					return enqueue(function () { return commitMemory(state, prepared); });
				});
			},
			recordEvidence: function (input) {
				return recordEvidenceBatch([input]).then(function (records) { return records[0]; });
			},
			recordEvidenceBatch: recordEvidenceBatch,
			loadActive: function () {
				return enqueue(function () { return state.activeAttemptId && state.heads[state.activeAttemptId] ? clone(state.heads[state.activeAttemptId]) : null; });
			},
			exportActive: function () {
				return this.loadActive().then(function (head) {
					return head ? exportAttempt(head.attemptId) : null;
				});
			},
			exportAttempt: exportAttempt,
			validateBundle: validateBundle,
			importBundle: function (bundle) {
				return upgradeBundle(bundle).then(function (incoming) {
					return enqueue(function () {
						var id = incoming.attemptId;
						var existing = state.heads[id];
						if (existing) {
							if (canonical(existing) !== canonical(incoming.head)) throw error('Attempt already exists with different state.', 'IMPORT_CONFLICT');
							(incoming.evidence || []).forEach(function (record) {
								var prior = state.evidence[record.id];
								if (prior && prior.evidenceHash !== record.evidenceHash) {
									throw error('Imported evidence conflicts with this attempt.', 'EVIDENCE_CONFLICT');
								}
								state.evidence[record.id] = clone(record);
							});
							state.activeAttemptId = id;
							return {attemptId: id, revision: existing.revision, run: clone(existing.run), duplicate: true};
						}
						state.heads[id] = clone(incoming.head);
						incoming.events.forEach(function (event) { state.events.push(clone(event)); });
						incoming.snapshots.forEach(function (snapshot) { state.snapshots.push(clone(snapshot)); });
						incoming.idempotency.forEach(function (receipt) {
							state.idempotency[receipt.id] = clone(receipt);
						});
						(incoming.evidence || []).forEach(function (record) {
							state.evidence[record.id] = clone(record);
						});
						state.activeAttemptId = id;
						return {attemptId: id, revision: incoming.head.revision, run: clone(incoming.head.run), duplicate: false};
					});
				});
			},
			archive: function (entry) {
				var value = normalizeArchive(entry);
				return enqueue(function () {
					state.archives[value.archiveId] = clone(value);
					if (state.activeAttemptId === value.attemptId) state.activeAttemptId = null;
					return clone(value);
				});
			},
			listArchives: function () {
				return enqueue(function () { return Object.keys(state.archives).sort().map(function (key) { return clone(state.archives[key]); }); });
			},
			importArchives: function (records) {
				if (!Array.isArray(records)) return Promise.reject(error('Archive records must be an array.', 'INVALID_ARCHIVE'));
				var values = records.map(normalizeArchive);
				return enqueue(function () {
					values.forEach(function (value) { state.archives[value.archiveId] = clone(value); });
					return values.map(clone);
				});
			},
			inspectAttempt: inspectAttempt,
			listEvents: function (attemptId, options) {
				var id = String(attemptId);
				var opts = options || {};
				var from = Number.isInteger(opts.fromRevision) ? opts.fromRevision : 1;
				var to = Number.isInteger(opts.toRevision) ? opts.toRevision : Number.MAX_SAFE_INTEGER;
				return enqueue(function () {
					return clone(state.events.filter(function (event) {
						return event.attemptId === id && event.revision >= from && event.revision <= to;
					}));
				});
			},
			listEvidence: function (attemptId) {
				var id = String(attemptId);
				return enqueue(function () {
					return Object.keys(state.evidence).map(function (key) { return state.evidence[key]; })
						.filter(function (record) { return record.attemptId === id; })
						.sort(function (a, b) { return a.recordedAt.localeCompare(b.recordedAt); })
						.map(clone);
				});
			},
			replayBundle: replayBundle,
		};
	}

	function getIndexedDB() {
		if (root && root.indexedDB) return root.indexedDB;
		if (typeof indexedDB !== 'undefined') return indexedDB;
		return null;
	}

	function ensureIndex(store, name, keyPath, options) {
		if (!store.indexNames.contains(name)) store.createIndex(name, keyPath, options || {});
	}

	function openDb() {
		return new Promise(function (resolve, reject) {
			var indexed = getIndexedDB();
			if (!indexed) { reject(error('This environment does not provide IndexedDB.', 'NO_INDEXEDDB')); return; }
			var request;
			try { request = indexed.open(DB_NAME, DB_VERSION); } catch (openError) { reject(openError); return; }
			request.onupgradeneeded = function () {
				var db = request.result;
				if (!db.objectStoreNames.contains('heads')) db.createObjectStore('heads', {keyPath: 'attemptId'});
				if (!db.objectStoreNames.contains('events')) db.createObjectStore('events', {keyPath: 'id'});
				if (!db.objectStoreNames.contains('snapshots')) db.createObjectStore('snapshots', {keyPath: 'id'});
				if (!db.objectStoreNames.contains('idempotency')) db.createObjectStore('idempotency', {keyPath: 'id'});
				if (!db.objectStoreNames.contains('evidence')) db.createObjectStore('evidence', {keyPath: 'id'});
				if (!db.objectStoreNames.contains('archives')) db.createObjectStore('archives', {keyPath: 'archiveId'});
				if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', {keyPath: 'key'});
				var upgrade = request.transaction;
				ensureIndex(upgrade.objectStore('events'), 'byAttempt', 'attemptId');
				ensureIndex(upgrade.objectStore('events'), 'byAttemptRevision', ['attemptId', 'revision'], {unique: true});
				ensureIndex(upgrade.objectStore('snapshots'), 'byAttempt', 'attemptId');
				ensureIndex(upgrade.objectStore('snapshots'), 'byAttemptRevision', ['attemptId', 'revision'], {unique: true});
				ensureIndex(upgrade.objectStore('idempotency'), 'byAttempt', 'attemptId');
				ensureIndex(upgrade.objectStore('evidence'), 'byAttempt', 'attemptId');
				ensureIndex(upgrade.objectStore('archives'), 'byAttempt', 'attemptId');
				upgrade.objectStore('meta').put({key: 'schema', schema: SCHEMA, version: VERSION,
					modelVersion: MODEL_VERSION, databaseVersion: DB_VERSION});
			};
			request.onsuccess = function () { resolve(request.result); };
			request.onerror = function () { reject(request.error || error('Could not open attempt store.', 'INDEXEDDB_OPEN')); };
		});
	}

	function requestValue(request) {
		return new Promise(function (resolve, reject) {
			request.onsuccess = function () { resolve(request.result); };
			request.onerror = function () { reject(request.error || error('IndexedDB request failed.', 'INDEXEDDB_REQUEST')); };
		});
	}

	function requestByAttempt(store, attemptId) {
		if (store.indexNames && store.indexNames.contains('byAttempt')) {
			return requestValue(store.index('byAttempt').getAll(attemptId));
		}
		return requestValue(store.getAll()).then(function (records) {
			return records.filter(function (record) { return record.attemptId === attemptId; });
		});
	}

	function rangeForAttempt(attemptId, fromRevision, toRevision) {
		var ranges = root && root.IDBKeyRange ? root.IDBKeyRange :
			(typeof IDBKeyRange !== 'undefined' ? IDBKeyRange : null);
		if (!ranges) return null;
		return ranges.bound([attemptId, fromRevision], [attemptId, toRevision]);
	}

	function transaction(names, mode, work) {
		return openDb().then(function (db) {
			return new Promise(function (resolve, reject) {
				var tx;
				var result;
				try {
					tx = db.transaction(names, mode);
					result = work(tx);
				} catch (transactionError) {
					try { tx.abort(); } catch (ignore) {}
					db.close();
					reject(transactionError);
					return;
				}
				tx.oncomplete = function () { db.close(); resolve(result); };
				tx.onerror = function () { db.close(); reject(tx.error || error('IndexedDB transaction failed.', 'INDEXEDDB_TRANSACTION')); };
				tx.onabort = function () { db.close(); reject(tx.error || error('IndexedDB transaction aborted.', 'INDEXEDDB_TRANSACTION')); };
			});
		});
	}

	function createIndexedStore() {
		var enqueue = serial();
		function inspectAttempt(attemptId) {
			return transaction(['heads', 'events', 'snapshots', 'idempotency', 'evidence'], 'readonly', function (tx) {
				var id = String(attemptId);
				return Promise.all([
					requestValue(tx.objectStore('heads').get(id)),
					requestByAttempt(tx.objectStore('events'), id),
					requestByAttempt(tx.objectStore('snapshots'), id),
					requestByAttempt(tx.objectStore('idempotency'), id),
					requestByAttempt(tx.objectStore('evidence'), id),
				]).then(function (values) {
					if (!values[0]) return null;
					return {
						attemptId: id,
						head: clone(values[0]),
						events: values[1].sort(function (a, b) { return a.revision - b.revision; }),
						snapshots: values[2].sort(function (a, b) { return a.revision - b.revision; }),
						idempotency: values[3],
						evidence: values[4].sort(function (a, b) {
							return a.recordedAt.localeCompare(b.recordedAt);
						}),
					};
				});
			});
		}
		function exportAttempt(attemptId) {
			return inspectAttempt(attemptId).then(function (inspected) {
				return upgradeInspection(inspected).then(function (upgraded) {
					var bundle = makeBundle(upgraded);
					return bundle ? addChecksum(bundle) : null;
				});
			});
		}
		function listEvents(attemptId, options) {
			var id = String(attemptId);
			var opts = options || {};
			var from = Number.isInteger(opts.fromRevision) ? opts.fromRevision : 1;
			var to = Number.isInteger(opts.toRevision) ? opts.toRevision : Number.MAX_SAFE_INTEGER;
			return transaction(['events'], 'readonly', function (tx) {
				var store = tx.objectStore('events');
				var range = rangeForAttempt(id, from, to);
				if (range && store.indexNames.contains('byAttemptRevision')) {
					return requestValue(store.index('byAttemptRevision').getAll(range));
				}
				return requestByAttempt(store, id).then(function (events) {
					return events.filter(function (event) {
						return event.revision >= from && event.revision <= to;
					}).sort(function (a, b) { return a.revision - b.revision; });
				});
			});
		}
		function recordEvidenceBatch(inputs) {
			return prepareEvidenceBatch(inputs).then(function (prepared) {
				return enqueue(function () {
					return transaction(['heads', 'events', 'evidence'], 'readwrite', function (tx) {
						return Promise.all([
							requestValue(tx.objectStore('heads').get(prepared[0].attemptId)),
							requestByAttempt(tx.objectStore('events'), prepared[0].attemptId),
							Promise.all(prepared.map(function (record) {
								return requestValue(tx.objectStore('evidence').get(record.id));
							})),
						]).then(function (values) {
							var head = values[0];
							var attemptEvents = values[1];
							var priorRecords = values[2];
							if (!head) throw error('Evidence attempt does not exist.', 'MISSING_ATTEMPT');
							prepared.forEach(function (record, index) {
								if (record.attemptRevision > head.revision) {
									throw error('Evidence revision is ahead of the attempt.', 'INVALID_EVIDENCE');
								}
								validateEvidenceState(record, attemptEvents, 'INVALID_EVIDENCE');
								validateAttributionOwnership(record, attemptEvents, 'INVALID_EVIDENCE');
								if (priorRecords[index] &&
									priorRecords[index].evidenceHash !== record.evidenceHash) {
									throw error('Evidence identity was reused with different content.',
										'EVIDENCE_CONFLICT');
								}
							});
							return prepared.map(function (record, index) {
								if (priorRecords[index]) {
									return Object.assign(clone(priorRecords[index]), {duplicate: true});
								}
								tx.objectStore('evidence').put(record);
								return Object.assign(clone(record), {duplicate: false});
							});
						});
					});
				});
			});
		}
		return {
			commit: function (input) {
				var prepared = validateCommit(input);
				return prepareIntegrity(prepared).then(function () {
					var fp = fingerprint(prepared);
					return enqueue(function () {
						return transaction(['heads', 'idempotency'], 'readonly', function (readTx) {
							return Promise.all([
								requestValue(readTx.objectStore('heads').get(prepared.attemptId)),
								requestValue(readTx.objectStore('idempotency').get(prepared.attemptId + '::' + prepared.commandId)),
							]);
						}).then(function (initial) {
							var initialHead = initial[0];
							var initialPrior = initial[1];
							if (initialPrior) {
								if (initialPrior.fingerprint !== fp) throw error('commandId was already used with different data.', 'IDEMPOTENCY_CONFLICT');
								return resultFor(prepared.attemptId, initialPrior.revision,
									initialHead && initialHead.revision === initialPrior.revision ? initialHead.run : null,
									null, initialPrior.stateHash, true);
							}
							var actual = initialHead ? initialHead.revision : 0;
							if (prepared.expectedRevision !== actual) throw error('Revision conflict.', 'REVISION_CONFLICT', {expectedRevision: prepared.expectedRevision, actualRevision: actual});
							return prepareEvent(prepared, initialHead, actual + 1).then(function (event) {
								return transaction(['heads', 'events', 'snapshots', 'idempotency', 'meta'], 'readwrite', function (tx) {
									var heads = tx.objectStore('heads');
									var idempotency = tx.objectStore('idempotency');
									return Promise.all([
										requestValue(heads.get(prepared.attemptId)),
										requestValue(idempotency.get(prepared.attemptId + '::' + prepared.commandId)),
									]).then(function (current) {
										var head = current[0];
										var prior = current[1];
										if (prior) {
											if (prior.fingerprint !== fp) throw error('commandId was already used with different data.', 'IDEMPOTENCY_CONFLICT');
											return resultFor(prepared.attemptId, prior.revision,
												head && head.revision === prior.revision ? head.run : null,
												null, prior.stateHash, true);
										}
										var currentRevision = head ? head.revision : 0;
										if (currentRevision !== prepared.expectedRevision) throw error('Revision conflict.', 'REVISION_CONFLICT', {expectedRevision: prepared.expectedRevision, actualRevision: currentRevision});
										tx.objectStore('events').put(event);
										if (shouldSnapshot(event.kind, event.revision)) tx.objectStore('snapshots').put({id: event.id, attemptId: prepared.attemptId, revision: event.revision, run: clone(prepared.snapshotRun), stateHash: prepared.snapshotHash, logRevision: isSnapshotKind(event.kind) ? event.revision : 0});
										heads.put({attemptId: prepared.attemptId, revision: event.revision, run: clone(prepared.run), stateHash: prepared.stateHash, lastEventHash: event.eventHash});
										idempotency.put({id: prepared.attemptId + '::' + prepared.commandId,
											attemptId: prepared.attemptId, commandId: prepared.commandId,
											fingerprint: fp, revision: event.revision, stateHash: prepared.stateHash,
											eventId: event.eventId, eventHash: event.eventHash});
										tx.objectStore('meta').put({key: 'activeAttemptId', value: prepared.attemptId});
										return resultFor(prepared.attemptId, event.revision, prepared.run, event, prepared.stateHash, false);
									});
								});
							});
						});
					});
				});
			},
			recordEvidence: function (input) {
				return recordEvidenceBatch([input]).then(function (records) { return records[0]; });
			},
			recordEvidenceBatch: recordEvidenceBatch,
			loadActive: function () {
				return transaction(['heads', 'meta'], 'readonly', function (tx) {
					return requestValue(tx.objectStore('meta').get('activeAttemptId')).then(function (active) {
						return active && active.value ?
							requestValue(tx.objectStore('heads').get(active.value)) : null;
					}).then(function (head) {
						return head ? clone(head) : null;
					});
				});
			},
			exportActive: function () {
				return this.loadActive().then(function (head) {
					return head ? exportAttempt(head.attemptId) : null;
				});
			},
			exportAttempt: exportAttempt,
			validateBundle: validateBundle,
			importBundle: function (bundle) {
				return upgradeBundle(bundle).then(function (incoming) {
					return enqueue(function () {
						return transaction(['heads', 'events', 'snapshots', 'idempotency', 'evidence', 'meta'], 'readwrite', function (tx) {
							var heads = tx.objectStore('heads');
							return requestValue(heads.get(incoming.attemptId)).then(function (existing) {
								if (existing) {
									if (canonical(existing) !== canonical(incoming.head)) throw error('Attempt already exists with different state.', 'IMPORT_CONFLICT');
									var records = incoming.evidence || [];
									return Promise.all(records.map(function (record) {
										return requestValue(tx.objectStore('evidence').get(record.id));
									})).then(function (priorRecords) {
										records.forEach(function (record, index) {
											if (priorRecords[index] &&
												priorRecords[index].evidenceHash !== record.evidenceHash) {
												throw error('Imported evidence conflicts with this attempt.',
													'EVIDENCE_CONFLICT');
											}
											tx.objectStore('evidence').put(clone(record));
										});
										tx.objectStore('meta').put({key: 'activeAttemptId', value: incoming.attemptId});
										return {attemptId: incoming.attemptId, revision: existing.revision,
											run: clone(existing.run), duplicate: true};
									});
								}
								heads.put(clone(incoming.head));
								incoming.events.forEach(function (event) { tx.objectStore('events').put(clone(event)); });
								incoming.snapshots.forEach(function (snapshot) { tx.objectStore('snapshots').put(clone(snapshot)); });
								incoming.idempotency.forEach(function (receipt) {
									tx.objectStore('idempotency').put(clone(receipt));
								});
								(incoming.evidence || []).forEach(function (record) {
									tx.objectStore('evidence').put(clone(record));
								});
								tx.objectStore('meta').put({key: 'activeAttemptId', value: incoming.attemptId});
								return {attemptId: incoming.attemptId, revision: incoming.head.revision, run: clone(incoming.head.run), duplicate: false};
							});
						});
					});
				});
			},
			archive: function (entry) {
				var value = normalizeArchive(entry);
				return enqueue(function () {
					return transaction(['archives', 'meta'], 'readwrite', function (tx) {
						tx.objectStore('archives').put(value);
						return requestValue(tx.objectStore('meta').get('activeAttemptId')).then(function (active) {
							if (active && active.value === value.attemptId) {
								tx.objectStore('meta').delete('activeAttemptId');
							}
							return value;
						});
					});
				});
			},
			listArchives: function () { return transaction(['archives'], 'readonly', function (tx) { return requestValue(tx.objectStore('archives').getAll()).then(function (records) { return records.sort(function (a, b) { return a.archiveId.localeCompare(b.archiveId); }); }); }); },
			importArchives: function (records) {
				if (!Array.isArray(records)) return Promise.reject(error('Archive records must be an array.', 'INVALID_ARCHIVE'));
				var values = records.map(normalizeArchive);
				return enqueue(function () { return transaction(['archives'], 'readwrite', function (tx) { values.forEach(function (value) { tx.objectStore('archives').put(value); }); return values; }); });
			},
			inspectAttempt: inspectAttempt,
			listEvents: listEvents,
			listEvidence: function (attemptId) {
				return transaction(['evidence'], 'readonly', function (tx) {
					return requestByAttempt(tx.objectStore('evidence'), String(attemptId)).then(function (records) {
						return records.sort(function (a, b) { return a.recordedAt.localeCompare(b.recordedAt); });
					});
				});
			},
			replayBundle: replayBundle,
		};
	}

	function getDefault() {
		if (!defaultStore) defaultStore = createIndexedStore();
		return defaultStore;
	}

	function delegate(name) {
		return function () { return getDefault()[name].apply(getDefault(), arguments); };
	}

	return {
		SCHEMA: SCHEMA,
		VERSION: VERSION,
		DB_NAME: DB_NAME,
		DB_VERSION: DB_VERSION,
		MODEL_VERSION: MODEL_VERSION,
		EVIDENCE_SCHEMA: EVIDENCE_SCHEMA,
		SNAPSHOT_INTERVAL: SNAPSHOT_INTERVAL,
		createMemoryStore: createMemoryStore,
		getDefault: getDefault,
		commit: delegate('commit'),
		recordEvidence: delegate('recordEvidence'),
		recordEvidenceBatch: delegate('recordEvidenceBatch'),
		loadActive: delegate('loadActive'),
		exportActive: delegate('exportActive'),
		exportAttempt: delegate('exportAttempt'),
		validateBundle: validateBundle,
		upgradeBundle: upgradeBundle,
		importBundle: delegate('importBundle'),
		archive: delegate('archive'),
		listArchives: delegate('listArchives'),
		importArchives: delegate('importArchives'),
		inspectAttempt: delegate('inspectAttempt'),
		listEvents: delegate('listEvents'),
		listEvidence: delegate('listEvidence'),
		replayBundle: replayBundle,
	};
});
