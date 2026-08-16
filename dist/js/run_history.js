/* eslint-env browser, node, es6 */
(function (root, factory) {
	'use strict';
	var api = factory(root);
	if (typeof module === 'object' && module.exports) module.exports = api;
	else root.RunBunHistory = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
	'use strict';

	var SCHEMA_VERSION = 2;
	var DB_NAME = 'runbun-history';
	var DB_VERSION = 1;
	var STORE = 'attempts';
	var OUTCOMES = ['wipe', 'completed', 'reset', 'abandoned', 'active'];

	function clone(value) {
		return JSON.parse(JSON.stringify(value));
	}

	function fallbackId(run) {
		var input = [run.profileId, run.createdAt, run.name, run.version].join('|');
		var hash = 2166136261;
		for (var i = 0; i < input.length; i++) {
			hash ^= input.charCodeAt(i);
			hash = Math.imul(hash, 16777619);
		}
		return 'legacy-' + (hash >>> 0).toString(16);
	}

	function attemptId(run) {
		return run && run.attemptId ? String(run.attemptId) : fallbackId(run || {});
	}

	function evidenceReference(bundle, id) {
		if (!bundle) return null;
		if (bundle.format !== 'rabrun.archive' || bundle.attemptId !== id || !bundle.head || !bundle.manifest) {
			throw new Error('The attempt evidence does not match the archived run.');
		}
		return {
			format: bundle.format,
			modelVersion: bundle.modelVersion || null,
			attemptId: bundle.attemptId,
			revision: bundle.head.revision,
			stateHash: bundle.head.stateHash,
			eventHash: bundle.head.lastEventHash || null,
			eventCount: bundle.manifest.eventCount,
			checksum: bundle.checksum,
		};
	}

	function record(run, outcome, endedAt, bundle) {
		if (!run || !Array.isArray(run.box) || !Array.isArray(run.log)) {
			throw new Error('A complete run document is required to archive an attempt.');
		}
		if (OUTCOMES.indexOf(outcome) === -1) {
			throw new Error('Unknown attempt outcome ' + JSON.stringify(outcome) + '.');
		}
		var id = attemptId(run);
		var result = {
			schemaVersion: SCHEMA_VERSION,
			attemptId: id,
			profileId: run.profileId,
			name: run.name,
			startedAt: run.createdAt || null,
			endedAt: outcome === 'active' ? null : endedAt || null,
			outcome: outcome,
			position: run.position,
			run: clone(run),
		};
		var evidence = evidenceReference(bundle, id);
		if (evidence) result.evidence = evidence;
		return result;
	}

	function positionLabel(position) {
		return position < 0 ? 'Before the first fight' : 'Through fight #' + position;
	}

	function outcomeLabel(outcome) {
		return {
			wipe: 'Wiped',
			completed: 'Completed',
			reset: 'Reset',
			abandoned: 'Abandoned',
			active: 'Active',
		}[outcome] || outcome;
	}

	function median(values) {
		if (!values.length) return null;
		var ordered = values.slice().sort(function (a, b) { return a - b; });
		var middle = Math.floor(ordered.length / 2);
		return ordered.length % 2 ? ordered[middle] :
			(ordered[middle - 1] + ordered[middle]) / 2;
	}

	function derive(records, activeRun) {
		var ended = (records || []).filter(function (entry) {
			return entry && (entry.schemaVersion === 1 || entry.schemaVersion === SCHEMA_VERSION) && entry.outcome !== 'active' &&
				entry.run && Array.isArray(entry.run.box);
		});
		var attempts = ended.slice();
		if (activeRun) attempts.push(record(activeRun, 'active', null));
		attempts.sort(function (a, b) {
			return String(b.endedAt || b.startedAt || '').localeCompare(
				String(a.endedAt || a.startedAt || ''));
		});

		var best = attempts.reduce(function (winner, entry) {
			return !winner || entry.position > winner.position ? entry : winner;
		}, null);
		var species = {};
		attempts.forEach(function (entry) {
			var inAttempt = {};
			entry.run.box.forEach(function (mon) {
				var row = species[mon.species] || {
					species: mon.species,
					attempts: 0,
					caught: 0,
					survived: 0,
					lost: 0,
					finalParty: 0,
					bestPosition: -1,
					knownIvs: 0,
				};
				row.caught += 1;
				if (mon.status === 'dead') row.lost += 1;
				else row.survived += 1;
				if ((entry.run.party || []).indexOf(mon.id) !== -1) row.finalParty += 1;
				row.knownIvs += Object.keys(mon.ivs || {}).filter(function (stat) {
					return typeof mon.ivs[stat] === 'number';
				}).length;
				row.bestPosition = Math.max(row.bestPosition, entry.position);
				species[mon.species] = row;
				inAttempt[mon.species] = true;
			});
			Object.keys(inAttempt).forEach(function (name) { species[name].attempts += 1; });
		});

		var speciesRows = Object.keys(species).map(function (name) { return species[name]; });
		speciesRows.sort(function (a, b) {
			return b.attempts - a.attempts || b.bestPosition - a.bestPosition ||
				a.species.localeCompare(b.species);
		});

		return {
			schemaVersion: SCHEMA_VERSION,
			tracked: attempts.length,
			ended: ended.length,
			active: activeRun ? 1 : 0,
			completed: ended.filter(function (entry) { return entry.outcome === 'completed'; }).length,
			wipes: ended.filter(function (entry) { return entry.outcome === 'wipe'; }).length,
			best: best,
			medianPosition: median(ended.map(function (entry) { return entry.position; })),
			attempts: attempts,
			species: speciesRows,
		};
	}

	function planningSummary(record) {
		if (!record || record.kind !== 'pokemon.rab.plan' ||
			!record.request || !record.receipt || !record.receipt.result ||
			!record.receipt.result.summary || !record.request.task ||
			!record.request.task.state || !record.request.task.state.trainer ||
			!Number.isInteger(record.request.task.state.trainer.order)) return null;
		var summary = record.receipt.result.summary;
		if (!Number.isInteger(summary.branchesEvaluated) ||
			!Number.isInteger(summary.safeBranches) || !Number.isInteger(summary.deaths) ||
			!Number.isInteger(summary.losses)) return null;
		var team = Array.isArray(record.request.task.state.playerTeam) ?
			record.request.task.state.playerTeam : [];
		var lead = team.filter(function (mon) {
			return mon && mon.id === summary.recommendedLeadId;
		})[0] || null;
		return {
			evidenceId: record.evidenceId,
			trainerOrder: record.request.task.state.trainer.order,
			attemptRevision: record.attemptRevision,
			recordedAt: record.recordedAt || null,
			branches: summary.branchesEvaluated,
			safeBranches: summary.safeBranches,
			deaths: summary.deaths,
			losses: summary.losses,
			expectedTurns: summary.expectedTurns,
			leadId: summary.recommendedLeadId,
			leadSpecies: lead && lead.species || null,
		};
	}

	function battleCompletion(event) {
		var payload = event && event.kind === 'battle.ended' ? event.payload : null;
		if (!payload || payload.kind !== 'trainer' ||
			!Number.isInteger(payload.trainerOrder) || payload.trainerOrder < 1 ||
			['won', 'lost'].indexOf(payload.outcome) === -1 ||
			!Array.isArray(payload.deaths) || !Number.isInteger(payload.turns)) return null;
		function validContribution(row) {
			var validCounters = row &&
				['entered', 'switchIns', 'actions', 'moveActions', 'damageDealt', 'kos']
					.every(function (field) {
						return Number.isInteger(row[field]) && row[field] >= 0 &&
							row[field] <= 0xffffffff;
					});
			return Boolean(validCounters && typeof row.monId === 'string' && row.monId &&
				typeof row.battleId === 'string' && row.battleId &&
				typeof row.species === 'string' && row.species && row.switchIns <= row.entered &&
				row.moveActions <= row.actions &&
				(row.entered > 0 || row.actions + row.damageDealt + row.kos === 0));
		}
		var rawContributions = Array.isArray(payload.contributions) ? payload.contributions : [];
		var validContributions = rawContributions.every(validContribution);
		var contributions = rawContributions.filter(validContribution)
			.map(function (row) { return clone(row); });
		return {
			eventId: event.eventId,
			revision: event.revision,
			trainerOrder: payload.trainerOrder,
			trainer: payload.trainer || null,
			result: payload.outcome === 'won' ? 'win' : 'loss',
			deaths: payload.deaths.length,
			turns: payload.turns,
			seed: payload.seed,
			leadId: payload.leadId || null,
			participantIds: Array.isArray(payload.participantIds) ? payload.participantIds.slice() : [],
			contributionComplete: payload.contributionVersion === 1 &&
				payload.contributionComplete === true && validContributions,
			contributions: contributions.filter(function (row) {
				return row.entered > 0 || row.actions > 0;
			}),
		};
	}

	function comparison(plan, actual) {
		if (!plan) return 'unplanned';
		if (!actual) return 'unplayed';
		if (actual.result !== 'win') return 'defeat';
		var sampledDeathless = plan.branches > 0 && plan.safeBranches === plan.branches &&
			plan.deaths === 0 && plan.losses === 0;
		if (actual.deaths === 0) return sampledDeathless ? 'held' : 'outperformed';
		return sampledDeathless ? 'underestimated' : 'within-risk';
	}

	/**
	 * Pair immutable planning receipts with explicit battle.ended events.
	 *
	 * A completion consumes only plans recorded since the prior play of that
	 * trainer and chooses the latest one at or before the completed revision.
	 * Plans created after a completion remain unplayed. This is descriptive
	 * evidence: it never manufactures carry, causal value, or policy quality.
	 */
	function derivePlanningReview(inspected) {
		var plans = (inspected && inspected.evidence || []).map(planningSummary)
			.filter(Boolean).sort(function (a, b) {
				return a.attemptRevision - b.attemptRevision ||
					String(a.recordedAt || '').localeCompare(String(b.recordedAt || ''));
			});
		var completions = (inspected && inspected.events || []).map(battleCompletion)
			.filter(Boolean).sort(function (a, b) { return a.revision - b.revision; });
		var orders = {};
		plans.forEach(function (plan) { orders[plan.trainerOrder] = true; });
		completions.forEach(function (actual) { orders[actual.trainerOrder] = true; });
		var rows = [];
		Object.keys(orders).map(Number).sort(function (a, b) { return a - b; })
			.forEach(function (trainerOrder) {
				var trainerPlans = plans.filter(function (plan) {
					return plan.trainerOrder === trainerOrder;
				});
				var trainerPlays = completions.filter(function (actual) {
					return actual.trainerOrder === trainerOrder;
				});
				var priorRevision = -1;
				trainerPlays.forEach(function (actual) {
					var eligible = trainerPlans.filter(function (plan) {
						return plan.attemptRevision > priorRevision &&
							plan.attemptRevision <= actual.revision;
					});
					var plan = eligible.length ? eligible[eligible.length - 1] : null;
					rows.push({
						trainerOrder: trainerOrder,
						trainer: actual.trainer,
						plan: plan,
						planCount: eligible.length,
						actual: actual,
						comparison: comparison(plan, actual),
					});
					priorRevision = actual.revision;
				});
				var remaining = trainerPlans.filter(function (plan) {
					return plan.attemptRevision > priorRevision;
				});
				if (remaining.length) {
					var latest = remaining[remaining.length - 1];
					rows.push({
						trainerOrder: trainerOrder,
						trainer: null,
						plan: latest,
						planCount: remaining.length,
						actual: null,
						comparison: 'unplayed',
					});
				}
			});
		rows.sort(function (a, b) {
			var aRevision = a.actual ? a.actual.revision : a.plan.attemptRevision;
			var bRevision = b.actual ? b.actual.revision : b.plan.attemptRevision;
			return bRevision - aRevision;
		});
		return {
			planned: plans.length,
			played: completions.length,
			matched: rows.filter(function (row) { return row.plan && row.actual; }).length,
			rows: rows,
		};
	}

	function openDb() {
		return new Promise(function (resolve, reject) {
			if (typeof indexedDB === 'undefined') {
				reject(new Error('This browser does not provide IndexedDB.'));
				return;
			}
			var request = indexedDB.open(DB_NAME, DB_VERSION);
			request.onupgradeneeded = function () {
				var db = request.result;
				if (!db.objectStoreNames.contains(STORE)) {
					db.createObjectStore(STORE, {keyPath: 'attemptId'});
				}
			};
			request.onsuccess = function () { resolve(request.result); };
			request.onerror = function () {
				reject(request.error || new Error('Could not open run history.'));
			};
		});
	}

	function transaction(mode, work) {
		return openDb().then(function (db) {
			return new Promise(function (resolve, reject) {
				var tx = db.transaction(STORE, mode);
				var request = work(tx.objectStore(STORE));
				var result;
				request.onsuccess = function () { result = request.result; };
				request.onerror = function () {
					reject(request.error || new Error('Run history operation failed.'));
				};
				tx.oncomplete = function () {
					db.close();
					resolve(result);
				};
				tx.onabort = function () {
					db.close();
					reject(tx.error || new Error('Run history transaction was aborted.'));
				};
			});
		});
	}

	function durableStore() {
		return root && root.RunBunAttemptStore &&
			typeof root.RunBunAttemptStore.getDefault === 'function' ?
			root.RunBunAttemptStore.getDefault() : null;
	}

	function legacyArchive(run, outcome, endedAt) {
		var entry = record(run, outcome, endedAt);
		return transaction('readwrite', function (store) { return store.put(entry); })
			.then(function () { return entry; });
	}

	function legacyList() {
		return transaction('readonly', function (store) { return store.getAll(); })
			.then(function (entries) { return entries || []; });
	}

	/**
	 * New writes use the attempt store so the active head and final archive share
	 * one transaction boundary. The old history database is read-only migration
	 * input: records are copied idempotently and never deleted behind the player.
	 */
	function archive(run, outcome, endedAt, bundle) {
		var store = durableStore();
		if (!store) return legacyArchive(run, outcome, endedAt);
		var supplied = bundle && bundle.format === 'rabrun.archive';
		var portable = supplied ? store.validateBundle(bundle).then(function () { return bundle; }) :
			store.exportAttempt(attemptId(run));
		return portable.then(function (checked) {
			var entry = record(run, outcome, endedAt, checked);
			return store.archive(entry).then(function () { return entry; });
		});
	}

	function evidence(attempt) {
		var store = durableStore();
		return store ? store.inspectAttempt(String(attempt)) : Promise.resolve(null);
	}

	function list() {
		var store = durableStore();
		if (!store) return legacyList();
		return legacyList().catch(function () { return []; }).then(function (entries) {
			return store.importArchives(entries);
		}).then(function () { return store.listArchives(); });
	}

	return {
		SCHEMA_VERSION: SCHEMA_VERSION,
		attemptId: attemptId,
		record: record,
		derive: derive,
		derivePlanningReview: derivePlanningReview,
		positionLabel: positionLabel,
		outcomeLabel: outcomeLabel,
		archive: archive,
		list: list,
		evidence: evidence,
	};
});
