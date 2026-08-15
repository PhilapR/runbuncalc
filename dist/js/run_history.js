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
		positionLabel: positionLabel,
		outcomeLabel: outcomeLabel,
		archive: archive,
		list: list,
		evidence: evidence,
	};
});
