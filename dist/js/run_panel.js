/* eslint-env browser, jquery, es6 */
/**
 * Run panel — a playthrough in the page.
 *
 * The Fight Planner asks a question about one moment. This asks the question a
 * player actually lives with: here is my box, here is where I am, what happens
 * next. It is the same document `play.js` keeps in a file, kept in
 * private browser storage instead.
 *
 * THE SERVER HOLDS NO SAVE FILES. Every call posts the whole run and gets a new
 * one back. That keeps this panel a thin client — it holds no rules, no scores
 * and no legality checks, exactly like `planner_panel.js` — while keeping the
 * run private to the browser it was played in.
 *
 * DESIGNED FOR THE WHOLE GAME, not the first route. The states that matter:
 *
 *   - a box of 60+, several lost: counts, a filter, lost sunk below a divider
 *   - a party whose ORDER is the lead order: built by clicking, shown as six
 *     slots. The old multi-select could not express order at all — jQuery
 *     returns selections in DOM order, so the lead was silently always the
 *     earliest catch
 *   - 362 battles: the road ahead is a list where any fight can be marked
 *     beaten, which moves the run past everything before it — one click per
 *     route, not one per trainer
 *   - 40+ milestones: the spine strip is "where am I" at a glance
 *
 * The one thing this file owns is persistence: read on load, write only what
 * the server accepted, never write a run the server refused. IndexedDB is the
 * durable authority; localStorage is only a compatibility mirror and the
 * browser's cross-tab notification channel.
 */
(function () {
	'use strict';

	var STORAGE_KEY = 'runbun.run.v1';
	var PARTY_LIMIT = 6;

	var state = null;
	var maps = [];
	/** The last /run/status payload, so filtering and staging re-render locally. */
	var lastStatus = null;
	/** Party being assembled, in lead order. Committed only by "Use this party". */
	var stagedParty = [];
	/** True while a run-changing call is in flight. See `mutate`. */
	var busy = false;
	/** Raw text of a save that would not parse, held until the player deals with it. */
	var corruptSave = null;
	// When corruptSave holds a HEALTHY save that was parked (not damaged),
	// this note replaces the "damaged save" load message with the truth.
	var parkedSaveNote = null;
	/** Versioned IndexedDB attempt ledger. Null means compatibility fallback. */
	var attemptStore = window.RunBunAttemptStore ?
		window.RunBunAttemptStore.getDefault() : null;
	/** Optimistic revision of the active IndexedDB head. */
	var currentRevision = null;
	/** Where startup found the active attempt, for an honest load receipt. */
	var restoredFrom = null;
	/** Start is unsafe until durable storage and the authored map are ready. */
	var initialized = false;

	function newAttemptId() {
		if (window.crypto && typeof window.crypto.randomUUID === 'function') {
			return window.crypto.randomUUID();
		}
		return 'attempt-' + Date.now().toString(36) + '-' +
			Math.random().toString(36).slice(2, 10);
	}

	function newCommandId() {
		return 'command-' + newAttemptId();
	}

	function displayText(value) {
		return String(value || '')
			.replace(/([a-z])([A-Z])/g, '$1 $2')
			.replace(/\bRoute\s*(\d+)\b/g, 'Route $1')
			.replace(/\b(B?\d+)f\b/gi, '$1F')
			.replace(/\b(\d+)r\b/gi, 'Room $1')
			.replace(/\bRoom\s*(\d+)\b/gi, 'Room $1')
			.replace(/\bMap\s*(\d+)\b/gi, 'Map $1')
			.replace(/\bSpace center\b/g, 'Space Center');
	}

	/**
	 * A refusal arrives as 'teach: Poochyena cannot learn ...' — the prefix
	 * is the command's name, useful in a log, noise in the game's voice. The
	 * strip is presentation-only: journals and receipts keep the raw text.
	 */
	var COMMAND_PREFIX = new RegExp('^(teach|catch|evolve|levelUp|faint|party|use|' +
		'give|take|heartScale|acquire|release|nickname|beat|skip|battle|plan|' +
		'import|identify|hold|unhold|spend|undo|run|roll): ');
	function speakable(message) {
		var text = String(message || '');
		var stripped = text.replace(COMMAND_PREFIX, '');
		if (stripped !== text && stripped) {
			return stripped.charAt(0).toUpperCase() + stripped.slice(1);
		}
		return text;
	}

	var COUNTERS_KEY = 'runbun.counters.v1';
	function bumpCounter(group, key) {
		try {
			var counters = JSON.parse(window.localStorage.getItem(COUNTERS_KEY)) || {};
			counters[group] = counters[group] || {};
			counters[group][key] = (counters[group][key] || 0) + 1;
			window.localStorage.setItem(COUNTERS_KEY, JSON.stringify(counters));
		} catch (ignore) { /* a lost count is a lost count, never a lost run */ }
	}

	// The engine identity fights are recorded under: the deployed revision
	// when the page can learn it, and the pinned provider always.
	var appRevision = null;
	function learnAppRevision() {
		fetch('/__runbun/meta').then(function (response) {
			return response.ok ? response.json() : null;
		}).then(function (meta) {
			if (meta && meta.revision) appRevision = meta.revision;
		}).catch(function (ignore) { /* dev servers have no meta; null is honest */ });
	}

	function status(message, kind) {
		$('#runbun-run-status').text(displayText(speakable(message)))
			.attr('data-kind', kind || '');
	}

	function refreshStartAvailability() {
		var hasStarter = $('.runbun-run-starter[aria-pressed="true"]').length > 0;
		$('#runbun-run-new').prop('disabled', !initialized || !hasStarter)
			.attr('title', !initialized ? 'Loading the run panel…' :
				!hasStarter ? 'Pick a starter first' : 'Begin the run');
		$('.runbun-run-setup-form').attr('aria-busy', initialized ? 'false' : 'true');
	}

	function api(path, body) {
		return fetch(path, {
			method: 'POST',
			headers: {'content-type': 'application/json'},
			body: JSON.stringify(body || {}),
		}).then(function (response) {
			return response.json().then(function (payload) {
				if (!response.ok) throw new Error(payload && payload.error ? payload.error : 'request failed');
				return payload;
			});
		});
	}

	/**
	 * Persist only what the server accepted. A refused command must leave the
	 * save exactly as it was — the same property `play.js` keeps for its file.
	 */
	function mirror(run) {
		try {
			if (run) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(run));
			else window.localStorage.removeItem(STORAGE_KEY);
		} catch (error) {
			throw new Error('Could not write the compatibility save: ' + error.message);
		}
	}

	function restoreLegacy() {
		var saved;
		try {
			saved = window.localStorage.getItem(STORAGE_KEY);
		} catch (error) {
			status('Could not read this browser\'s storage: ' + error.message, 'error');
			return null;
		}
		if (!saved) return null;
		try {
			return JSON.parse(saved);
		} catch (error) {
			// This string is the player's only copy of the run, so it is kept, not
			// dropped: it goes into the transfer box on load to be repaired by hand,
			// and "Start a run" refuses to write over it until the player decides.
			corruptSave = saved;
			return null;
		}
	}

	/**
	 * Commit an accepted run to the event ledger before exposing its localStorage
	 * mirror. A stale tab therefore fails at the revision boundary instead of
	 * publishing a plausible save that silently drops another tab's command.
	 */
	function persist(kind, payload, commandId) {
		if (!state) return Promise.reject(new Error('There is no active run to save.'));
		if (!attemptStore) {
			mirror(state);
			return Promise.resolve({revision: null, fallback: true});
		}
		return attemptStore.commit({
			run: state,
			expectedRevision: currentRevision === null ? 0 : currentRevision,
			commandId: commandId || newCommandId(),
			event: {
				kind: kind,
				payload: payload || {},
				observedAt: new Date().toISOString(),
				source: {
					kind: kind === 'run.migrated' ? 'migration' :
						(kind === 'run.imported' ? 'import' :
							(kind === 'battle.ended' ? 'simulator' : 'manual')),
					providerId: kind === 'battle.ended' ?
						'runbun-battle-driver' : 'runbun-browser',
					confidence: 1,
				},
			},
		}).then(function (receipt) {
			currentRevision = receipt.revision;
			// The mirror is a convenience copy. Its failure (quota, privacy
			// mode) must never demote a session whose durable commit just
			// SUCCEEDED — that inversion turned a full localStorage into a
			// memory-only run.
			try {
				mirror(state);
			} catch (ignored) {
				status('Saved durably. The compatibility copy could not be ' +
					'written (browser storage is full); the run itself is safe.', 'error');
			}
			return receipt;
		}).catch(function (error) {
			// Neither conflict is evidence that storage died: revision means
			// another tab landed first, idempotency means this commandId was
			// already spent. Both surface; neither demotes durability.
			if (error && (error.code === 'REVISION_CONFLICT' ||
				error.code === 'IDEMPOTENCY_CONFLICT')) throw error;
			// A browser can disable or evict IndexedDB independently of localStorage.
			// Keep the accepted run recoverable, but say that durability degraded.
			attemptStore = null;
			try {
				mirror(state);
			} catch (ignored) { /* memory only now; the status below still renders */ }
			status('Durable storage became unavailable; kept a compatibility copy. ' +
				error.message, 'error');
			return {revision: null, fallback: true};
		});
	}

	function restoreDurable() {
		if (!attemptStore) {
			state = restoreLegacy();
			restoredFrom = state ? 'compatibility storage' : null;
			return Promise.resolve(state);
		}
		return attemptStore.loadActive().then(function (head) {
			if (head) {
				// A degraded prior session appends only to the mirror, so the
				// mirror can be AHEAD of the durable head. The chooser decides;
				// the losing copy is parked, never silently overwritten.
				var choice = window.RunBunAttemptStore.chooseRestoreSource(
					head, restoreLegacy());
				if (choice.source === 'mirror' && choice.parked === 'durable') {
					state = restoreLegacy();
					currentRevision = head.revision;
					restoredFrom = 'compatibility storage (ahead of durable)';
					// Re-anchor NOW, as a lifecycle event: run.replaced
					// snapshots the whole adopted run, so the ledger's
					// materialized-log check keeps holding for every later
					// export. Silently absorbing the mirror into the next
					// ordinary command manufactured archives that failed
					// their own re-import as CORRUPT_LOG.
					var mirrorLog = (state.log || []).length;
					return persist('run.replaced', {
						reason: 'compatibility copy ran ahead of durable storage',
					}, 'replace-' + state.attemptId + '-' + mirrorLog).then(function () {
						status('This browser\'s quick save was ahead of durable ' +
							'storage — re-anchored and continuing.', 'ok');
						return state;
					}).catch(function (ignored) {
						// Degraded again: the mirror keeps the run playable and
						// the next healthy boot retries this same re-anchor.
						status('This browser\'s quick save is ahead of durable storage ' +
							'— continuing from the quick save. The next healthy start ' +
							're-anchors durability.', 'error');
						return state;
					});
				}
				if (choice.parked === 'mirror') {
					// A mirror from a DIFFERENT attempt is someone's run. It
					// goes to the transfer box under the same protection a
					// damaged save gets; Start refuses to write over it.
					corruptSave = window.localStorage.getItem(STORAGE_KEY);
					parkedSaveNote = 'This browser also held a quick save from a ' +
						'different run. Its text is in the transfer box below — ' +
						'copy it if you want to keep it, then clear the box.';
				}
				state = head.run;
				currentRevision = head.revision;
				restoredFrom = 'durable browser storage';
				mirror(state);
				return state;
			}
			var legacy = restoreLegacy();
			if (!legacy) return null;
			if (!legacy.attemptId) legacy.attemptId = newAttemptId();
			// The durable store may already hold this attempt as an ARCHIVED
			// head (an ended run whose mirror clear failed, or an old tab
			// writing late). Migrating it would collide with that head at
			// expectedRevision 0 and previously demoted the whole session to
			// localStorage-only. Ended means ended: park the quick save.
			return attemptStore.inspectAttempt(legacy.attemptId).then(function (known) {
				if (known) {
					corruptSave = window.localStorage.getItem(STORAGE_KEY);
					parkedSaveNote = 'This browser held a quick save of a run ' +
						'that already ended. The ended run is in Run history; ' +
						'the quick save text is in the transfer box below — ' +
						'copy it if you want to keep it, then clear the box ' +
						'to start a new run.';
					return null;
				}
				state = legacy;
				return persist('run.migrated', {run: legacy},
					'migrate-' + legacy.attemptId).then(function () {
					restoredFrom = 'migrated browser storage';
					return state;
				});
			});
		}).catch(function (error) {
			attemptStore = null;
			state = restoreLegacy();
			restoredFrom = state ? 'compatibility storage' : null;
			if (!state && !corruptSave) {
				status('Durable browser storage could not open: ' + error.message, 'error');
			}
			return state;
		});
	}

	function recoverConflict(error) {
		if (!error || error.code !== 'REVISION_CONFLICT' || !attemptStore) {
			return Promise.reject(error);
		}
		return attemptStore.loadActive().then(function (head) {
			if (!head) throw error;
			state = head.run;
			currentRevision = head.revision;
			mirror(state);
			showRun();
			return render().then(function () {
				status('The run moved in another tab. Reloaded the committed version; ' +
					'try that action again.', 'error');
				return false;
			});
		});
	}

	/**
	 * One run-changing call at a time.
	 *
	 * Every mutation posts the run in `state` and adopts the run that comes back,
	 * so two in flight share one base: the second reply overwrites the first, and
	 * a command the player saw acknowledged and persisted vanishes. Refusing the
	 * second click loses nothing — the run it would have been built on does not
	 * exist yet — but it has to SAY so, because a button that silently does
	 * nothing reads as a broken button.
	 */
	function mutate(work) {
		if (busy) {
			status('One change at a time — the last one is still in flight.', 'error');
			// A promise, not undefined: callers chain on the result.
			return Promise.resolve(false);
		}
		busy = true;
		// The guard refuses a second click with a status line; the class lets
		// the CSS say "in flight" without one (progress cursor, dimmed buttons).
		$('#runbun-run-live').addClass('rb-busy').attr('aria-busy', 'true');
		function release() {
			busy = false;
			$('#runbun-run-live').removeClass('rb-busy').removeAttr('aria-busy');
		}
		// Released on both paths: one failure must never wedge the panel shut.
		// The work's resolved value passes through, so `command` can report
		// success to callers with one-shot form fields.
		return work().then(function (value) {
			release();
			return value;
		}, function (error) {
			release();
			status(error.message, 'error');
		});
	}

	/**
	 * Answers on demand go stale the moment the run moves.
	 *
	 * Plan, Advise, Rank, Routes and Board are all computed against the run AS
	 * IT WAS when their button was pressed. Nothing wrong with that — they are
	 * expensive questions, asked when the player wants them — but an advisor
	 * sheet computed three catches ago LOOKS exactly like current advice, and a
	 * player mid-split will act on it. Each block is stamped with the run log's
	 * length when it renders; every repaint compares, and a block the run has
	 * moved past is marked `rb-stale` (dimmed, labelled "refresh" in CSS).
	 * The answer itself is kept — half-stale advice still orients — the mark
	 * only says whose run it belongs to.
	 */
	var STALE_BLOCKS = {
		plan: ['#runbun-run-plan-verdict', '#runbun-run-plan-actions',
			'#runbun-run-plan-evidence', '#runbun-run-plan-outlook'],
		advice: ['.runbun-run-advice-block'],
		rank: ['.runbun-run-rank-block'],
		routes: ['.runbun-run-routes-block'],
		matrix: ['.runbun-run-matrix-block'],
	};
	var stamps = {};

	function logLength() {
		return state && state.log ? state.log.length : 0;
	}

	function stamp(key) {
		stamps[key] = logLength();
		refreshStale();
	}

	function refreshStale() {
		var now = logLength();
		var staleCount = 0;
		var answered = 0;
		Object.keys(STALE_BLOCKS).forEach(function (key) {
			var stale = stamps[key] !== undefined && stamps[key] !== now;
			if (stamps[key] !== undefined && key !== 'plan' && key !== 'routes') {
				answered += 1;
				if (stale) staleCount += 1;
			}
			STALE_BLOCKS[key].forEach(function (selector) {
				$(selector).toggleClass('rb-stale', stale);
			});
		});
		writeSummary('analysis', staleCount ? staleCount + ' answer' +
			(staleCount > 1 ? 's' : '') + ' stale — refresh' :
			answered ? answered + ' standing answer' + (answered > 1 ? 's' : '') :
				'upgrades · parties · matchups');
	}

	// ------------------------------------------------------------- disclosure
	//
	// Ported from ui-lab's disclosure slot, mechanics intact: the region is a
	// grid row animating 0fr -> 1fr (auto height, nothing measured), the
	// header is a real button with aria-expanded, closed content is inert.
	// The POV this panel adds — and feeds back to the lab: the collapsed
	// header carries a LIVE SUMMARY, so collapsed still informs; opening is
	// for acting, not for finding out whether anything is inside.

	var SECTIONS_KEY = 'runbun.panel.sections.v1';

	function setSection(key, open) {
		var $section = $('.rb-disclose[data-section="' + key + '"]');
		$section.toggleClass('is-open', open);
		$section.find('.rb-disclose-btn').attr('aria-expanded', open ? 'true' : 'false');
		var inner = $section.find('.rb-disclose-inner')[0];
		if (inner) {
			if (open) inner.removeAttribute('inert');
			else inner.setAttribute('inert', '');
		}
	}

	function persistSections() {
		var open = {};
		$('.rb-disclose').each(function () {
			open[$(this).attr('data-section')] = $(this).hasClass('is-open');
		});
		try {
			window.localStorage.setItem(SECTIONS_KEY, JSON.stringify(open));
		} catch (error) { /* a panel that cannot remember still folds */ }
	}

	/** Open a section on the player's behalf — an answer they asked for must
	 * never land inside a fold they then have to hunt for. */
	function revealSection(key) {
		if (!$('.rb-disclose[data-section="' + key + '"]').hasClass('is-open')) {
			setSection(key, true);
			persistSections();
		}
	}

	function bindDisclosures() {
		var saved = {};
		try {
			saved = JSON.parse(window.localStorage.getItem(SECTIONS_KEY)) || {};
		} catch (error) { saved = {}; }
		$('.rb-disclose').each(function () {
			var key = $(this).attr('data-section');
			setSection(key, !!saved[key]);
		});
		$('#runbun-run').on('click', '.rb-disclose-btn', function () {
			var $section = $(this).closest('.rb-disclose');
			var key = $section.attr('data-section');
			var opening = !$section.hasClass('is-open');
			setSection(key, opening);
			persistSections();
			// History renders on demand, not at boot; a player opening the
			// section by its own header must get the real ledger, not the
			// boot-time zeros and a stuck 'Loading…' line.
			if (opening && key === 'history') {
				renderHistory().catch(function () { /* renderHistory writes the error state */ });
			}
		});
	}

	function writeSummary(key, text) {
		$('.rb-disclose-summary[data-summary="' + key + '"]').text(text || '');
	}

	function monLabel(mon) {
		return (mon.nickname ? mon.nickname + ' the ' + mon.species : mon.species) + ' L' + mon.level;
	}

	function findBoxed(id) {
		if (!lastStatus) return null;
		return lastStatus.box.filter(function (mon) { return mon.id === id; })[0] || null;
	}

	var IV_LABELS = {hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe'};
	var IV_MAX_TOTAL = 6 * 31;

	/**
	 * A Pokemon's IV total, against the 186 every trainer is built with.
	 *
	 * The per-stat breakdown is on the summary screen, one Pokemon at a time,
	 * which is the wrong shape for the question it answers: which of these is
	 * worth building on. A wild catch rolls a mean of 93 and a spread from
	 * about 56 to 130 across a box, while every trainer Pokemon is a flat 186
	 * — so the gap between the best and worst catch in a box is roughly the
	 * size of the deficit to the opponent, and nothing on screen said so.
	 *
	 * A partial record is NOT summed as if the gaps were zero. An imported
	 * entry with three stats recorded is a different thing from one that
	 * genuinely rolled low, and the two must not print the same.
	 */
	function ivTotal(mon) {
		var known = 0;
		var sum = 0;
		Object.keys(IV_LABELS).forEach(function (stat) {
			if (!mon.ivs || !Object.prototype.hasOwnProperty.call(mon.ivs, stat)) return;
			known += 1;
			sum += Number(mon.ivs[stat]) || 0;
		});
		return {sum: sum, known: known, missing: Object.keys(IV_LABELS).length - known};
	}

	/** The scannable form: "IV 118/186", or what is missing if it cannot say. */
	function ivLabel(mon) {
		var total = ivTotal(mon);
		if (!total.known) return 'IV not recorded';
		if (total.missing) return 'IV ' + total.sum + '+ · ' + total.missing + ' not recorded';
		return 'IV ' + total.sum + '/' + IV_MAX_TOTAL;
	}

	// This panel never rolls an identity. IVs, nature, and ability are
	// authored by the server's die (/run/encounter, /run/identity) and only
	// carried through here into the catch command that makes them replay facts.

	function dexId(value) {
		return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
	}

	/** Species typing is reference data; owned ability/nature/IVs are persisted rolls. */
	function speciesTypes(mon) {
		try {
			var gen = window.calc && window.calc.Generations && window.calc.Generations.get(8);
			var species = gen && gen.species.get(dexId(mon && mon.species));
			return species && species.types ? species.types.slice() : [];
		} catch (error) {
			return [];
		}
	}

	/**
	 * Whether a bag entry is something a Pokemon can actually hold.
	 *
	 * Same table the server checks with `planner.holdableItem`, reached the
	 * same way `speciesTypes` reaches species data — most of a bag is Potions,
	 * Rare Candy and Heart Scales, and offering one here stored a Pokemon the
	 * calculator refuses to build. The server is still the authority and
	 * refuses it by name; this only stops the picker from suggesting a move
	 * that will be refused.
	 *
	 * Unknown on a missing calc means "offer it": a picker that hides the whole
	 * bag because reference data has not loaded is worse than one that offers
	 * an item the server will decline with a reason.
	 */
	function holdableItem(name) {
		try {
			var gen = window.calc && window.calc.Generations && window.calc.Generations.get(8);
			if (!gen || !gen.items) return true;
			return !!gen.items.get(dexId(name));
		} catch (error) {
			return true;
		}
	}

	function appendTypeChips($target, types) {
		$target.empty();
		(types || []).forEach(function (type) {
			$target.append($('<span class="runbun-run-type"></span>')
				.attr('data-type', String(type).toLowerCase())
				.text(type));
		});
		if (!types || !types.length) {
			$target.append($('<span class="runbun-run-type is-unknown"></span>').text('Type unknown'));
		}
	}

	function fact($list, label, value, known) {
		$list.append($('<div class="runbun-run-fact"></div>')
			.append($('<dt></dt>').text(label))
			.append($('<dd></dd>').toggleClass('is-unknown', known === false).text(value)));
	}

	function originLabel(mon) {
		if (!mon.origin || !mon.origin.mapName) return 'Gift / static / trade';
		return (mon.origin.method || 'caught') + ' · ' + displayText(mon.origin.mapName);
	}

	/** The Pokemon-summary screen: facts first, editing secondary. */
	function renderSelectedMon() {
		var id = $('#runbun-run-selected').val();
		var mon = findBoxed(id);
		$('#runbun-run-mon-empty').prop('hidden', !!mon);
		$('#runbun-run-mon-summary, #runbun-run-mon-record, #runbun-run-mon-tools').prop('hidden', !mon);
		if (!mon) return;

		var displayName = mon.nickname || mon.species;
		$('#runbun-run-mon-summary-name').text(displayName + ' · L' + mon.level);
		$('#runbun-run-mon-summary-species').text(
			(mon.nickname ? mon.species + ' · ' : '') + mon.id + (mon.shiny ? ' · Shiny' : ''));
		appendTypeChips($('#runbun-run-mon-summary-types'), speciesTypes(mon));

		var $facts = $('#runbun-run-mon-facts').empty();
		fact($facts, 'Ability', mon.ability || 'Not recorded', !!mon.ability);
		fact($facts, 'Nature', mon.nature || 'Not recorded', !!mon.nature);
		fact($facts, 'Held item', mon.item || 'None', true);
		fact($facts, 'Origin', originLabel(mon), true);
		fact($facts, 'Run state', mon.status === 'dead' ? 'Lost' :
			(state.party.indexOf(mon.id) !== -1 ? 'Party' : 'PC'), true);

		var $moves = $('#runbun-run-mon-summary-moves').empty();
		mon.moves.forEach(function (move) {
			$moves.append($('<span class="runbun-run-move"></span>').text(move));
		});

		// The forget slot is a closed set: this Pokemon's own moves. An empty
		// first choice covers the free-slot teach (fewer than four moves).
		var $replace = $('#runbun-run-replace').empty()
			.append($('<option value=""></option>').text(mon.moves.length < 4 ?
				'Into an empty slot' : 'Choose the move to forget'));
		mon.moves.forEach(function (move) {
			$replace.append($('<option></option>').attr('value', move).text('Forget ' + move));
		});
		refreshTeachableOptions(mon.id);
		refreshEvolutionFact(mon.id);

		var $ivs = $('#runbun-run-mon-summary-ivs').empty();
		var missingIvs = [];
		Object.keys(IV_LABELS).forEach(function (stat) {
			var known = mon.ivs && Object.prototype.hasOwnProperty.call(mon.ivs, stat);
			if (!known) missingIvs.push(IV_LABELS[stat]);
			$ivs.append($('<div class="runbun-run-iv"></div>').toggleClass('is-unknown', !known)
				.append($('<span></span>').text(IV_LABELS[stat]))
				.append($('<strong></strong>').text(known ? mon.ivs[stat] : '—'))
				.append($('<small></small>').text(known ? 'Yours' : 'not recorded')));
			$('#runbun-run-observed-iv-' + stat).val(known ? mon.ivs[stat] : '');
		});
		$('#runbun-run-iv-note').text(missingIvs.length ?
			'Legacy/imported record: add ' + missingIvs.join(', ') +
				' before relying on planning. Trainer teams use 31; wild encounters use their roll.' :
			'Your IVs drive damage, speed, and survival. Trainer teams use 31; wild encounters use their roll.');
		$('#runbun-run-observed-nature').val(mon.nature || '');
		$('#runbun-run-observed-ability').val(mon.ability || '');

		// The bag's HOLDABLE items — the comment said so long before the filter
		// did, and the gap between them was a bricked run: a Pokemon handed a
		// Potion could not be built by the calculator, so the next plan and the
		// next fight both failed until somebody found who was holding it.
		var $hold = $('#runbun-run-hold-item').empty();
		var carried = Object.keys((state && state.bag) || {}).filter(function (item) {
			return (state.bag[item] || 0) > 0;
		}).sort();
		var bagItems = carried.filter(holdableItem);
		if (!bagItems.length) {
			$hold.append($('<option value=""></option>').text(carried.length ?
				'Nothing in the bag can be held' : 'The bag is empty'));
		}
		bagItems.forEach(function (item) {
			$hold.append($('<option></option>').attr('value', item)
				.text(item + ' ×' + state.bag[item]));
		});
		$('#runbun-run-give').prop('disabled', !bagItems.length);
		$('#runbun-run-take').prop('disabled', !mon.item)
			.attr('title', mon.item ? 'Put ' + mon.item + ' back in the bag' :
				(mon.nickname || mon.species) + ' is not holding anything');
	}

	/**
	 * The run -> calculator bridge: load THIS Pokemon, with its exact rolled
	 * identity, into the calculator's player slot. The set rides the live
	 * setdex under one well-known name — never localStorage, because the run
	 * is the authority and a persisted copy would go stale on the next
	 * level-up. Level is projected to the active cap, the same projection
	 * every planning surface uses.
	 */
	var RUN_SET_NAME = 'My Run';
	function openInCalculator(mon, enemySetId) {
		var dex = window.SETDEX_SS;
		if (!dex || !window.jQuery) {
			status('The calculator has not finished loading yet.', 'error');
			return;
		}
		var cap = lastStatus && lastStatus.status && lastStatus.status.levelCap ?
			lastStatus.status.levelCap.cap : null;
		var level = cap === null || cap === undefined ?
			mon.level : Math.max(mon.level, cap);
		var ivs = mon.ivs || {};
		dex[mon.species] = dex[mon.species] || {};
		dex[mon.species][RUN_SET_NAME] = {
			level: level,
			nature: mon.nature || undefined,
			ability: mon.ability || undefined,
			item: mon.item || undefined,
			moves: mon.moves.slice(0, 4),
			// The calculator's legacy stat keys; the run's rolled IVs.
			ivs: {hp: ivs.hp, at: ivs.atk, df: ivs.def,
				sa: ivs.spa, sd: ivs.spd, sp: ivs.spe},
			evs: {},
			isCustomSet: true,
		};
		var setId = mon.species + ' (' + RUN_SET_NAME + ')';
		if (typeof window.topPokemonIcon === 'function') {
			window.topPokemonIcon(setId, $('#p1mon')[0]);
		}
		$('.player').val(setId);
		$('.player').change();
		$('.player .select2-chosen').text(setId);
		var opponentLabel = window.CURRENT_TRAINER || 'the loaded trainer';
		if (enemySetId && dex[enemySetId.split(' (')[0]] &&
			dex[enemySetId.split(' (')[0]][enemySetId.split(' (')[1].slice(0, -1)]) {
			if (typeof window.topPokemonIcon === 'function') {
				window.topPokemonIcon(enemySetId, $('#p2mon')[0]);
			}
			$('.opposing').val(enemySetId);
			$('.opposing').change();
			$('.opposing .select2-chosen').text(enemySetId);
			opponentLabel = enemySetId;
		}
		window.location.hash = '#calc';
		status((mon.nickname || mon.species) + ' L' + level +
			(level !== mon.level ? ' (projected to the cap)' : '') +
			' is in the calculator against ' + opponentLabel + '.', 'ok');
	}

	/**
	 * The calculator's player slot, made run-aware from the calculator's own
	 * tab: the run's living party as one-click chips. Without this the only
	 * path was the details panel's "Check in calculator" button on the Play
	 * tab, so a player already in the calculator had to leave it, find the
	 * mon, and come back — or hand-enter six IVs the run already knows.
	 */
	function renderCalcParty() {
		var $strip = $('#runbun-calc-party');
		if (!$strip.length) return;
		var party = (state && state.party || []).map(findBoxed).filter(Boolean);
		$strip.prop('hidden', !party.length);
		var $list = $('#runbun-calc-party-list').empty();
		party.forEach(function (mon, index) {
			$list.append($('<button type="button" class="btn runbun-calc-party-chip"></button>')
				.attr('title', 'Load ' + (mon.nickname || mon.species) +
					' — its rolled IVs, nature and ability — into the calculator')
				.append($('<span class="runbun-calc-party-slot"></span>').text(index + 1))
				.append($('<span></span>').text((mon.nickname || mon.species) + ' L' + mon.level))
				.on('click', function () { openInCalculator(mon); }));
		});
	}

	// The datalist behind the New move field: everything this Pokemon can
	// legally learn right now, fetched once per selection. Free text still
	// works — the teach command is the validator, this is only the menu.
	var evolutionFor = null;
	function refreshEvolutionFact(id) {
		if (!state || !id || evolutionFor === id) return;
		evolutionFor = id;
		api('/run/evolutions', {run: state, id: id}).then(function (payload) {
			if (evolutionFor !== id) return;
			var rows = payload.evolutions || [];
			var text = !rows.length ? 'Final form' : rows.map(function (row) {
				var how = row.method === 'level' ? 'at L' + row.level :
					row.item ? 'with ' + row.item : row.method;
				return row.into + ' ' + how + (row.ready === true ? ' — ready now' : '');
			}).join(' · ');
			var known = rows.length ? rows.every(function (row) {
				return row.ready !== null || row.method !== 'level';
			}) : true;
			fact($('#runbun-run-mon-facts'), 'Evolution', text, known);
		}).catch(function (ignore) { /* the fact is optional; Evolve validates */ });
	}

	var teachableFor = null;
	function refreshTeachableOptions(id) {
		if (!state || !id || teachableFor === id) return;
		teachableFor = id;
		api('/run/learnable', {run: state, id: id}).then(function (payload) {
			if (teachableFor !== id) return;
			var $options = $('#runbun-run-move-options').empty();
			payload.now.forEach(function (entry) {
				$options.append($('<option></option>').attr('value', entry.move));
			});
		}).catch(function (ignore) { /* the menu is optional; teach validates */ });
	}

	// ------------------------------------------------------------------- spine

	/**
	 * The story spine: one tick per milestone, beaten filled, the next one
	 * accented. Ticks stay glanceable at a count where the same many names would
	 * be a wall; the name lives in the tooltip and the note line names only the
	 * one that matters.
	 */
	function renderSpine(payload) {
		var spine = payload.milestones || [];
		var $spine = $('#runbun-run-spine').empty();
		var next = null;
		spine.forEach(function (milestone) {
			if (!milestone.beaten && !next) next = milestone;
			var isNext = !milestone.beaten && milestone === next;
			$spine.append($('<li></li>')
				.attr('title', '#' + milestone.order + '  ' + displayText(milestone.trainer))
				.attr('aria-label', '#' + milestone.order + ' ' + displayText(milestone.trainer) +
					(milestone.beaten ? ', beaten' : isNext ? ', next milestone' : ', ahead'))
				.attr('aria-current', isNext ? 'step' : null)
				.toggleClass('is-beaten', milestone.beaten)
				.toggleClass('is-boss', milestone.tier === 'boss')
				.toggleClass('is-next', isNext));
		});
		var done = spine.filter(function (m) { return m.beaten; }).length;
		$('#runbun-run-spine-note').text(spine.length ?
			done + ' / ' + spine.length + ' milestones' +
				(next ? ' · next: ' + displayText(next.trainer) +
					' (#' + next.order + ')' : ' — all beaten') :
			'');
	}

	// -------------------------------------------------------------- box + party

	/**
	 * The reserve, at any size: filterable bench first, losses below a divider.
	 * Active party members already live immediately above this section; drawing
	 * them here again buried the actual bench and graveyard under a duplicate six.
	 */
	function renderBox(payload) {
		var filter = String($('#runbun-run-box-filter').val() || '').toLowerCase();
		var cap = payload.status.levelCap && payload.status.levelCap.cap;
		var $box = $('#runbun-run-box').empty();
		var $losses = $('#runbun-run-losses').empty();

		var alive = payload.box.filter(function (mon) { return mon.status !== 'dead'; });
		var lost = payload.box.filter(function (mon) { return mon.status === 'dead'; });
		var party = state.party;
		var reserve = alive.filter(function (mon) { return party.indexOf(mon.id) === -1; });
		// The box's IV picture beside its size. The MEDIAN is the honest
		// summary — a mean moves with one lucky catch — and 186 travels with
		// it so the number carries its own scale instead of needing one.
		var totals = alive.filter(function (mon) { return !ivTotal(mon).missing; })
			.map(function (mon) { return ivTotal(mon).sum; })
			.sort(function (a, b) { return a - b; });
		var median = !totals.length ? null : totals.length % 2 ?
			totals[(totals.length - 1) / 2] :
			Math.round((totals[totals.length / 2 - 1] + totals[totals.length / 2]) / 2);
		$('#runbun-run-box-counts').text(reserve.length + ' reserve' +
			(lost.length ? ' · ' + lost.length + ' lost' : '') +
			(median === null ? '' : ' · IV median ' + median + '/' + IV_MAX_TOTAL));

		function matches(mon) {
			if (!filter) return true;
			return (mon.species + ' ' + (mon.nickname || '')).toLowerCase().indexOf(filter) !== -1;
		}

		function row(mon) {
			var staged = stagedParty.indexOf(mon.id) !== -1;
			var label = monLabel(mon);
			var $row = $('<li class="runbun-run-mon"></li>')
				.attr('data-id', mon.id)
				.toggleClass('is-lost', mon.status === 'dead');
			$row.append($('<span class="runbun-run-mon-slot"></span>')
				.text(mon.status === 'dead' ? '†' : ''));
			var $name = $('<button type="button" class="runbun-run-mon-name runbun-run-mon-select"></button>')
				.attr('data-id', mon.id)
				.attr('aria-label', 'Inspect ' + label)
				.text(label);
			if (cap && mon.level >= cap) {
				$name.append($('<span class="runbun-run-at-cap"></span>').text('at cap'));
			}
			$row.append($name);
			if (mon.status !== 'dead') {
				$row.append($('<button type="button" class="runbun-run-add"></button>')
					.attr('data-id', mon.id)
					.attr('title', staged ? 'Remove ' + label + ' from staged party' :
						'Add ' + label + ' to staged party')
					.attr('aria-label', staged ? 'Remove ' + label + ' from staged party' :
						'Add ' + label + ' to staged party')
					.toggleClass('is-staged', staged)
					.text(staged ? '−' : '+'));
			}
			// A lost row's kit line is its epitaph — who did it beats where it came
			// from, because the graveyard is read as a story, not an inventory.
			var types = speciesTypes(mon);
			$row.append($('<span class="runbun-run-mon-kit"></span>')
				.text(mon.status === 'dead' && mon.died && mon.died.to ?
					'killed by ' + mon.died.to +
						(mon.died.move ? "'s " + mon.died.move : '') :
					[types.length ? types.join('/') : null,
						mon.ability || 'ability not recorded', ivLabel(mon),
						mon.item, mon.origin && mon.origin.mapName ?
							mon.origin.method + ' · ' + displayText(mon.origin.mapName) :
							'gift / static / trade']
						.filter(Boolean).join(' · ')));
			$row.append($('<span class="runbun-run-mon-moves"></span>').text(mon.moves.join(', ')));
			return $row;
		}

		var reserveShown = reserve.filter(matches);
		reserveShown.forEach(function (mon) { $box.append(row(mon)); });
		var lostShown = lost.filter(matches);
		lostShown.forEach(function (mon) { $losses.append(row(mon)); });
		$('#runbun-run-losses-heading, #runbun-run-losses').prop('hidden', !lostShown.length);
		if (!reserveShown.length) {
			$box.append($('<li class="runbun-run-box-empty"></li>').text(filter ?
				'No PC Pokémon matches this filter.' :
				'Every living Pokémon is in the party.'));
		}
	}

	/**
	 * Filled slots, lead first, plus one compact count of the room remaining.
	 * Order is built by adding and adjusted with the up arrows — click order IS
	 * lead order, which is the entire reason this is not a multi-select.
	 */
	function renderPartyStrip() {
		var $strip = $('#runbun-run-party-strip').empty();
		stagedParty.forEach(function (id, i) {
			var mon = findBoxed(id);
			var label = mon ? monLabel(mon) : id;
			var $slot = $('<li class="runbun-run-party-slot"></li>').attr('data-id', id);
			$slot.append($('<span class="runbun-run-party-order"></span>').text(String(i + 1)));
			var $copy = $('<div class="runbun-run-party-copy"></div>');
			$copy.append($('<span class="runbun-run-party-role"></span>').text(i === 0 ? 'Lead' : 'Party'));
			$copy.append($('<button type="button" class="runbun-run-party-name runbun-run-party-select"></button>')
				.attr('data-id', id)
				.attr('aria-label', 'Inspect ' + label)
				.text(label));
			if (mon) {
				var types = speciesTypes(mon);
				$copy.append($('<span class="runbun-run-party-meta"></span>').text(
					(types.length ? types.join('/') + ' · ' : '') +
						(mon.ability || 'ability not recorded') + ' · ' +
						ivLabel(mon) + ' · ' +
						(mon.item || 'No held item') + ' · ' + mon.moves.length +
						(mon.moves.length === 1 ? ' move' : ' moves')));
			}
			$slot.append($copy);
			if (i > 0) {
				$slot.append($('<button type="button" class="runbun-run-party-up"></button>')
					.attr('title', 'Move ' + label + ' toward lead')
					.attr('aria-label', 'Move ' + label + ' toward lead')
					.attr('data-id', id).text('▴'));
			}
			$slot.append($('<button type="button" class="runbun-run-party-rm"></button>')
				.attr('title', 'Remove ' + label + ' from party')
				.attr('aria-label', 'Remove ' + label + ' from party')
				.attr('data-id', id).text('×'));
			$strip.append($slot);
		});
		var open = PARTY_LIMIT - stagedParty.length;
		if (open) {
			$strip.append($('<li class="runbun-run-party-slot is-empty is-summary"></li>')
				.text(open + ' open slot' + (open === 1 ? '' : 's') +
					(stagedParty.length ? '' : ' · choose from the roster')));
		}
		var changed = !state || stagedParty.length !== state.party.length ||
			stagedParty.some(function (id, index) { return state.party[index] !== id; });
		$('.runbun-run-party-commit').prop('hidden', !changed);
	}

	// -------------------------------------------------------------- split sheet

	/**
	 * The split as one sheet: the boss it ends at, the cap on the way, and the
	 * boss-tier gauntlet between here and it — each row plannable and boardable
	 * like the road ahead, because the gauntlet IS the road that matters.
	 */
	function renderSplit(payload) {
		var prep = payload.splitPrep;
		var $summary = $('#runbun-run-split-summary').empty();
		var $list = $('#runbun-run-split-gauntlet').empty();
		// A played floor measures ONE run state: any repaint means the run
		// moved (or might have), so the measurement clears rather than lie.
		$('#runbun-run-split-played').text('');
		$('#runbun-run-split-play').closest('.runbun-run-split-play-row')
			.prop('hidden', !prep || prep.split.finished || !(state && state.party.length));
		if (!prep) return;
		if (prep.split.finished) {
			$summary.text('The run map is finished — no split ahead.');
			return;
		}
		$summary.text(
			'Road to ' + prep.split.boss.replace(/^Leader /, '') + ' · boss ' +
			prep.split.index + '/' + prep.split.of + ' · ' + prep.fightsAhead +
			' fights left · ' + prep.filler + ' standard trainers' +
			(prep.cap.cap !== null ? ' · cap ' + prep.cap.cap : ''));
		prep.gauntlet.forEach(function (fight) {
			var $row = $('<li class="runbun-run-split-fight"></li>')
				.toggleClass('is-boss-row', fight.tier === 'boss');
			// "#77" alone reads as a fight number and is not one: order counts
			// cumulative enemy Pokemon, so Brawly is #77 and the 26th fight.
			// The cell stays short because the column is narrow; the title and
			// the label carry the scale.
			$row.append($('<span class="runbun-run-up-order"></span>')
				.attr('title', 'Run map order ' + fight.order +
					' — counts enemy Pokemon faced, not fights')
				.attr('aria-label', 'order ' + fight.order)
				.text('#' + fight.order));
			$row.append($('<span class="runbun-run-up-name"></span>')
				.text(displayText(fight.trainer)));
			$row.append($('<span class="runbun-run-up-tier"></span>')
				.addClass(fight.tier === 'boss' ? 'is-boss' : 'is-story')
				.text(fight.tier));
			$row.append($('<span class="runbun-run-up-meta"></span>')
				.text(fight.partySize + ' mons' +
					(fight.cap !== undefined ? ' · cap ' + fight.cap : '')));
			$row.append($('<span class="runbun-run-up-actions"></span>')
				.append($('<button type="button" class="runbun-run-up-plan"></button>')
					.attr('data-trainer', fight.trainer).text('Plan fight'))
				.append($('<button type="button" class="runbun-run-up-board"></button>')
					.attr('data-trainer', fight.trainer).text('Matchups')));
			$list.append($row);
		});
		// The split's uncollected field pickups: prep is what to grab BEFORE
		// the boss. Each row says where the item waits, and a reachable one
		// carries the button that records the trip — guided, not narrated.
		if (prep.pickups && prep.pickups.length) {
			var $pickups = $('<li class="runbun-run-split-pickups"></li>')
				.append($('<span class="runbun-run-split-pickups-label"></span>')
					.text('Available before ' + prep.split.boss.replace(/^Leader /, '')));
			prep.pickups.forEach(function (item) {
				var $row = $('<span class="runbun-run-pickup"></span>')
					.toggleClass('is-waiting', !item.reachable)
					.append($('<span class="runbun-run-pickup-name"></span>').text(item.name))
					.append($('<span class="runbun-run-pickup-where"></span>')
						.text(displayText(item.location) +
							(item.reachable ? '' : ' · from #' + item.opensAt)));
				if (item.reachable) {
					$row.append($('<button type="button" class="runbun-run-pickup-take"></button>')
						.attr('data-item', item.name).text('Take ' + item.name));
				}
				$pickups.append($row);
			});
			$list.append($pickups);
		}
	}

	/** Play the split's boss with the current party, on demand — the same
	 * measured floor the ranker plays, pinned to the sheet it answers for. */
	function playBoss() {
		if (!state || !state.party.length) return;
		var $out = $('#runbun-run-split-played');
		$out.text('Testing 8 battles…');
		api('/run/split', {run: state, rollouts: 8}).then(function (prep) {
			var played = prep.adjudication;
			if (!played) {
				$out.text('');
				return;
			}
			$out.text('Win ' + Math.round(played.pWin * 100) + '% · ' +
				played.eDeaths.toFixed(1) + ' deaths expected · deathless ' +
				Math.round(played.pDeathless * 100) + '% · ' + played.rollouts +
				' conservative simulations');
		}).catch(function (error) {
			$out.text('');
			status(error.message, 'error');
		});
	}

	// -------------------------------------------------------------- road ahead

	/**
	 * The fights ahead, each plannable and each markable as beaten. Marking one
	 * moves the run past everything before it — that is `run.js` semantics, and
	 * it is what makes 362 battles navigable: clear a route, mark its last
	 * trainer, and the spine catches up.
	 */
	function renderUpcoming(payload) {
		var $list = $('#runbun-run-upcoming').empty();
		(payload.upcoming || []).forEach(function (fight, index) {
			var $row = $('<li class="runbun-run-up"></li>').toggleClass('is-next', index === 0);
			// "#77" alone reads as a fight number and is not one: order counts
			// cumulative enemy Pokemon, so Brawly is #77 and the 26th fight.
			// The cell stays short because the column is narrow; the title and
			// the label carry the scale.
			$row.append($('<span class="runbun-run-up-order"></span>')
				.attr('title', 'Run map order ' + fight.order +
					' — counts enemy Pokemon faced, not fights')
				.attr('aria-label', 'order ' + fight.order)
				.text('#' + fight.order));
			$row.append($('<span class="runbun-run-up-name"></span>')
				.text(displayText(fight.trainer)));
			if (fight.tier) {
				$row.append($('<span class="runbun-run-up-tier"></span>')
					.addClass(fight.tier === 'boss' ? 'is-boss' : 'is-story')
					.text(fight.tier));
			}
			$row.append($('<span class="runbun-run-up-meta"></span>')
				.text(fight.partySize + ' mons · ace L' + fight.topLevel));
			$row.append($('<span class="runbun-run-up-actions"></span>')
				.append($('<button type="button" class="runbun-run-up-plan"></button>')
					.attr('data-trainer', fight.trainer).text('Plan fight'))
				.append($('<button type="button" class="runbun-run-up-board"></button>')
					.attr('data-trainer', fight.trainer).text('Matchups'))
				.append($('<button type="button" class="runbun-run-up-beat"></button>')
					.attr('data-trainer', fight.trainer).text('Mark beaten')));
			$list.append($row);
		});
		if (!(payload.upcoming || []).length) {
			$list.append($('<li class="runbun-run-up is-done"></li>')
				.text('Nothing ahead — the run map is finished.'));
		}
	}

	/**
	 * The companion's game loop in one card.
	 *
	 * A newly started run already owns a starter, but it lives in the roster
	 * until the player chooses a lead. Presenting an enabled-looking fight CTA
	 * in that state made the first click a refusal and hid the useful action in
	 * a collapsed section. This projection names the actual next decision and
	 * makes the product's out-of-battle shortcuts explicit: party members are
	 * projected to the active cap and trainer battles start from fresh HP.
	 */
	function renderNextStep(payload) {
		var summary = payload.status;
		var next = summary.next;
		var partySize = state.party.length;
		var cap = summary.levelCap && summary.levelCap.cap;
		var alive = payload.box.filter(function (mon) { return mon.status !== 'dead'; });
		var firstAvailable = alive.filter(function (mon) {
			return state.party.indexOf(mon.id) === -1;
		})[0] || alive[0];

		$('#runbun-run-ready-party').text(partySize ?
			partySize + ' / ' + PARTY_LIMIT + ' · lead set' : 'Not set');
		$('#runbun-run-ready-level').text(cap === null || cap === undefined ?
			'Use recorded levels' : 'Projected to L' + cap);
		$('#runbun-run-ready-recovery').text('Fresh at fight start');

		var $play = $('#runbun-run-play');
		var $plan = $('#runbun-run-plan');
		var $value = $('#runbun-run-value');
		var $advise = $('#runbun-run-advise');
		var $rank = $('#runbun-run-rank');
		if (!next) {
			$('#runbun-run-next-title').text('The run map is complete');
			$('#runbun-run-next-detail').text('All required fights cleared');
			$play.text('Run complete').prop('disabled', true)
				.attr('title', 'No required trainer remains');
			$plan.prop('disabled', true).attr('title', 'No required trainer remains');
			$value.prop('disabled', true).attr('title', 'No required trainer remains');
			$advise.prop('disabled', true).attr('title', 'No required trainer remains');
			$rank.prop('disabled', true).attr('title', 'No required trainer remains');
			return;
		}

		// A nuzlocke with nothing left alive is over: offering "choose your
		// party" from an empty box is a dead end, and the player has just
		// watched their last Pokemon fall.
		if (!alive.length) {
			$('#runbun-run-next-title').text('The run is over');
			$('#runbun-run-next-detail').text(
				payload.box.length + ' caught · none left standing · ' +
				displayText(next.trainer) + ' still stands');
			$play.text('End this run').prop('disabled', false)
				.attr('title', 'Nothing is left alive — save this run to history');
			$plan.prop('disabled', true).attr('title', 'Nothing is left alive');
			$value.prop('disabled', true).attr('title', 'Nothing is left alive');
			$advise.prop('disabled', true).attr('title', 'Nothing is left alive');
			$rank.prop('disabled', true).attr('title', 'Nothing is left alive');
			return;
		}

		if (!partySize) {
			$('#runbun-run-next-title').text('Build a party for ' + displayText(next.trainer));
			$('#runbun-run-next-detail').text(
				'0 / ' + PARTY_LIMIT + ' ready' +
				(firstAvailable ? ' · ' + monLabel(firstAvailable) + ' available' : ''));
			$play.text('Choose your party').prop('disabled', false)
				.attr('title', 'Open the roster and choose a lead before fighting');
			$plan.prop('disabled', true).attr('title', 'Choose a party first');
			$value.prop('disabled', true).attr('title', 'Choose a party first');
			$advise.prop('disabled', true).attr('title', 'Choose a party first');
			$rank.prop('disabled', !alive.length).attr('title', alive.length ?
				'Score every legal party against the next fight' :
				'Catch a Pokémon first');
			return;
		}

		$('#runbun-run-next-title').text('Face ' + displayText(next.trainer));
		$('#runbun-run-next-detail').text(
			partySize + ' / ' + PARTY_LIMIT + ' ready · ' +
			(cap === null || cap === undefined ? 'recorded levels' : 'L' + cap) +
			' · fresh');
		$play.text('Fight ' + displayText(next.trainer)).prop('disabled', false)
			.attr('title', 'Play the next trainer fight turn by turn');
		$plan.prop('disabled', false)
			.attr('title', 'Sample the next fight with your current party');
		$value.prop('disabled', false)
			.attr('title', 'Run modeled replacement and IV tests on this roster');
		$advise.prop('disabled', false)
			.attr('title', 'Price candidate builds against the next fight');
		$rank.prop('disabled', !alive.length).attr('title', alive.length ?
			'Score every legal party against the next fight' :
			'Catch a Pokémon first');
	}

	/** A compact, actionable scan of what can still happen before the fight. */
	function renderOpportunities(payload) {
		var opportunity = payload.opportunities;
		var $section = $('#runbun-run-opportunities');
		var $list = $('#runbun-run-opportunity-list').empty();
		if (!opportunity || !opportunity.before) {
			$section.prop('hidden', true);
			return;
		}
		$section.prop('hidden', false);
		$('#runbun-run-opportunities-fight').text(
			opportunity.before.trainer || '#' + opportunity.before.order);

		function preview(values, limit) {
			var shown = values.slice(0, limit);
			return shown.join(' · ') + (values.length > limit ? ' · +' + (values.length - limit) : '');
		}
		function addRow(options) {
			var $row = $('<li class="runbun-run-opportunity"></li>')
				.addClass(options.unknown ? 'is-unknown' : '');
			var $inside = options.kind ?
				$('<button type="button" class="runbun-run-opportunity-action"></button>')
					.attr('data-kind', options.kind)
					.attr('aria-label', options.actionLabel || options.name) :
				$('<div class="runbun-run-opportunity-static"></div>');
			if (options.title) $inside.attr('title', options.title);
			if (options.map) $inside.attr('data-map', options.map);
			$inside.append($('<span class="runbun-run-opportunity-name"></span>').text(options.name));
			if (options.kind) {
				$inside.append($('<span class="runbun-run-opportunity-arrow" aria-hidden="true"></span>')
					.text('→'));
			}
			$inside.append($('<span class="runbun-run-opportunity-detail"></span>')
				.text(options.detail));
			$row.append($inside);
			$list.append($row);
		}

		// Levelling goes FIRST, because it is the only row here that is work you
		// already own rather than something to go and find, and because a plan
		// that reads "at cap" while the box sits at catch levels is the one way
		// this list could mislead. The projection is right; the grind to meet it
		// was simply never named.
		var levels = opportunity.levels || {};
		if (levels.cap) {
			addRow({
				// No kind, so no action button. `kind` drives a reveal-and-scroll
				// and there is no section to send anyone to: the party is already
				// on screen, and a button that does nothing is worse than none.
				kind: null,
				name: levels.levelsNeeded ?
					levels.levelsNeeded + ' level' + (levels.levelsNeeded === 1 ? '' : 's') + ' to the cap' :
					'Party is at the cap',
				detail: levels.levelsNeeded ?
					preview(levels.behind.map(function (row) {
						return displayText(row.nickname || row.species) + ' L' + row.level +
							' \u2192 L' + row.to;
					}), 3) :
					'Every party member is at level ' + levels.cap,
				title: levels.setBy ?
					'Cap ' + levels.cap + ' is set by ' + displayText(levels.setBy.trainer) +
						(levels.setBy.ace ? " (" + displayText(levels.setBy.ace) + ")" : '') :
					undefined,
			});
		}

		// The threshold demand, right under the levelling: when the next fight
		// holds a sash-threshold set, a party with no priority attack is walking
		// into Lilith's Mankey — six slower Pokemon swept from 2% HP because
		// nothing could move first. Informational row, same as levels: there is
		// no section to send anyone to, the teach form is already on screen.
		var prep = opportunity.thresholdPrep || {threats: []};
		if (prep.threats.length) {
			addRow({
				kind: null,
				name: prep.covered ? 'Priority answer ready' : 'No priority answer',
				detail: prep.covered ?
					preview(prep.priorityAnswers.map(function (row) {
						return displayText(row.species) + ' knows ' + row.move;
					}), 2) :
					(prep.teachable.length ?
						'Teach ' + preview(prep.teachable.map(function (row) {
							return row.move + ' to ' + displayText(row.species);
						}), 2) :
						'Nothing in the party can learn one \u2014 bring chip damage or a faster lead'),
				title: prep.threats.map(function (threat) {
					return threat.species + ' holds ' + threat.holds + ' + ' + threat.move;
				}).join('; '),
			});
		}

		var encounters = opportunity.encounters || {count: 0, routes: []};
		addRow({
			kind: encounters.count ? 'encounters' : null,
			name: encounters.count + ' encounter ' + (encounters.count === 1 ? 'area' : 'areas'),
			detail: encounters.count ? preview(encounters.routes.map(function (route) {
				return displayText(route.name);
			}), 3) : 'No open, unspent encounter area',
			actionLabel: 'Review ' + encounters.count + ' available encounter areas',
		});

		var items = opportunity.items || {count: 0, pickups: []};
		addRow({
			kind: items.count ? 'items' : null,
			map: items.count && items.pickups[0].map,
			name: items.count + ' field ' + (items.count === 1 ? 'item' : 'items'),
			detail: items.count ? preview(items.pickups.map(function (item) {
				return item.name + ' · ' + displayText(item.location);
			}), 2) : 'No uncollected field item is reachable',
			actionLabel: 'Review ' + items.count + ' reachable field items',
		});

		var moves = opportunity.moves || {};
		var reachableMoves = moves.reachable || [];
		addRow({
			name: moves.status === 'dated' ?
				moves.count + ' TM' + (moves.count === 1 ? '' : 's') + ' & tutors reachable' :
				'TM & tutors',
			detail: moves.status === 'dated' ?
				(reachableMoves.length ? preview(reachableMoves.map(function (row) {
					return row.move + ' · ' + displayText(row.place || row.location);
				}), 2) : 'None reachable yet' +
					(moves.undated ? ' · ' + moves.undated + ' known places, undated' : '')) :
				moves.status === 'undated' ? 'Move locations are not mapped yet' :
					(moves.note || 'No new move access is recorded'),
			title: moves.note,
			unknown: moves.status === 'undated' || moves.status === 'unknown',
		});
	}

	/** The game-facing route choice: only places the run can reach right now. */
	function renderReachableRoutes(payload) {
		var routes = payload.opportunities && payload.opportunities.encounters ?
			payload.opportunities.encounters.routes || [] : [];
		var $routes = $('#runbun-run-reachable').empty();
		if (!routes.length) {
			$routes.append($('<p class="runbun-run-reachable-empty"></p>')
				.text('No unspent encounter area is available before this fight.'));
			return;
		}
		routes.forEach(function (route) {
			$routes.append($('<button type="button" class="runbun-run-route-choice"></button>')
				.attr('data-map', route.map)
				.attr('aria-pressed', 'false')
				.append($('<span class="runbun-run-route-choice-name"></span>')
					.text(displayText(route.name)))
				.append($('<span class="runbun-run-route-choice-action"></span>')
					.text(route.held ? 'Held route · ready' : 'See encounters')));
		});
		syncRouteSelection();
	}

	/** The card whose table is on screen wears the selected state; every other
	 * card stays a plain offer. One writer, so cards and table cannot disagree. */
	function syncRouteSelection() {
		var map = $('#runbun-run-map').val();
		$('#runbun-run-reachable .runbun-run-route-choice').each(function () {
			var selected = !!map && $(this).attr('data-map') === map;
			$(this).toggleClass('is-selected', selected)
				.attr('aria-pressed', selected ? 'true' : 'false');
		});
	}

	// ------------------------------------------------------------------ render

	/** The start form and the run are never both on screen. */
	function showRun() {
		$('#runbun-run-empty').prop('hidden', !!state);
		$('#runbun-run-live').prop('hidden', !state);
	}

	function renderHistory() {
		var history = window.RunBunHistory;
		var $state = $('#runbun-history-state').text('Loading runs saved in this browser…');
		$('#runbun-history-content').prop('hidden', true);
		if (!history) {
			$state.text('Run history could not load. The active run has not been changed.');
			return Promise.reject(new Error('Run history is unavailable.'));
		}
		function comparisonText(kind) {
			return {
				held: 'The sampled plan held in play.',
				underestimated: 'The played fight was harsher than the sample.',
				outperformed: 'The played fight beat the sampled risk.',
				'within-risk': 'The sampled risk showed up in play.',
				defeat: 'The played fight ended in defeat.',
				unplayed: 'Saved for a fight that has not been played yet.',
				unplanned: 'Played without a saved simulator plan.',
			}[kind] || 'No comparison is available.';
		}
		function renderPlanningReview(entry) {
			var $planningState = $('#runbun-history-planning-state');
			var $planning = $('#runbun-history-planning').empty();
			if (!entry) {
				$planningState.text('Choose a run to review plans, modeled tests, and played fights.');
				return Promise.resolve(null);
			}
			$planningState.text('Loading ' + (entry.name || 'this run') + '…');
			return history.evidence(entry.attemptId).then(function (inspected) {
				if (!inspected) {
					$planningState.text('No checked battle evidence is available for this run.');
					return null;
				}
				var review = history.derivePlanningReview(inspected);
				if (!review.rows.length) {
					$planningState.text('No saved plans, modeled tests, or played fight receipts in this run yet.');
					return review;
				}
				$planningState.text((entry.name || 'This run') + ': ' + review.planned +
					' saved plan' + (review.planned === 1 ? '' : 's') + ' · ' + review.played +
					' played fight' + (review.played === 1 ? '' : 's') + '.');
				review.rows.forEach(function (row) {
					var plan = row.plan;
					var actual = row.actual;
					var trainer = row.trainer || 'Trainer #' + row.trainerOrder;
					var $card = $('<li class="runbun-history-plan"></li>')
						.attr('data-comparison', row.comparison);
					$card.append($('<div class="runbun-history-plan-head"></div>')
						.append($('<strong></strong>').text(displayText(trainer)))
						.append($('<span></span>').text(row.trainer ?
							'Trainer #' + row.trainerOrder : 'Saved plan')));
					$card.append($('<p class="runbun-history-plan-verdict"></p>')
						.text(comparisonText(row.comparison)));
					$card.append($('<p class="runbun-history-plan-fact"></p>').text(plan ?
						'Plan · lead ' + (plan.leadSpecies || plan.leadId || 'not recorded') + ' · ' +
						plan.safeBranches + '/' + plan.branches + ' fair-dice samples clean' +
						(Number.isFinite(plan.expectedTurns) ? ' · ' + plan.expectedTurns +
							' expected turns' : '') + (row.planCount > 1 ?
							' · latest of ' + row.planCount : '') :
						'Plan · none saved before this fight'));
					$card.append($('<p class="runbun-history-plan-fact"></p>').text(actual ?
						'Played · ' + (actual.result === 'win' ? 'won' : 'lost') + ' · ' +
						(actual.deaths ? actual.deaths + ' death' + (actual.deaths === 1 ? '' : 's') :
							'deathless') + ' · ' + actual.turns + ' turns · seed ' + actual.seed :
						'Played · not yet'));
					if (actual && actual.contributions.length) {
						var $contributions = $('<ul class="runbun-history-contributions"></ul>');
						actual.contributions.forEach(function (contribution) {
							var appearances = [];
							if (contribution.appearances > contribution.switchIns) appearances.push('started');
							if (contribution.switchIns) appearances.push(contribution.switchIns +
								' switch-in' + (contribution.switchIns === 1 ? '' : 's'));
							$contributions.append($('<li></li>').text(contribution.species + ' · ' +
								appearances.join(' + ') + ' · ' + contribution.moveAttempts + ' move attempt' +
								(contribution.moveAttempts === 1 ? '' : 's') + ' · ' +
								contribution.opposingHpRemoved + ' opposing HP removed' +
								(contribution.kos ? ' · ' + contribution.kos + ' KO' +
									(contribution.kos === 1 ? '' : 's') : '')));
						});
						$card.append($('<div class="runbun-history-contribution-label"></div>')
							.text(actual.contributionComplete ? 'Actual participation' :
								'Partial participation record'));
						$card.append($contributions);
					}
					if (row.attribution && row.attribution.tests.length) {
						var $modeled = $('<ul class="runbun-history-contributions runbun-history-modeled"></ul>');
						row.attribution.tests.forEach(function (test) {
							$modeled.append($('<li></li>').text(
								attributionTestText(test, row.attribution.seedCount)));
						});
						$card.append($('<div class="runbun-history-contribution-label"></div>')
							.text('Modeled value · fixed-seed tests'));
						$card.append($modeled);
					}
					$planning.append($card);
				});
				return review;
			}).catch(function (error) {
				$planningState.text('Could not read this run\'s battle evidence: ' + error.message);
				return null;
			});
		}
		return history.list().then(function (records) {
			var summary = history.derive(records, state);
			$('#runbun-history-tracked').text(summary.tracked);
			$('#runbun-history-best').text(summary.best ?
				history.positionLabel(summary.best.position) : 'No runs yet');
			$('#runbun-history-median').text(summary.medianPosition === null ?
				'Need 2+ runs' : history.positionLabel(summary.medianPosition));
			$('#runbun-history-completed').text(summary.completed);
			writeSummary('history', summary.ended + ' finished' +
				(summary.active ? ' · 1 active' : ''));

			var $attempts = $('#runbun-history-attempts').empty();
			summary.attempts.forEach(function (entry, index) {
				var $row = $('<li class="runbun-history-attempt"></li>')
					.toggleClass('is-active', entry.outcome === 'active')
					.toggleClass('is-selected', index === 0);
				var $button = $('<button type="button" class="runbun-history-attempt-button"></button>')
					.attr('aria-pressed', index === 0 ? 'true' : 'false');
				$button.append($('<span class="runbun-history-attempt-name"></span>')
					.text(entry.name || 'Untitled run'));
				$button.append($('<span class="runbun-history-attempt-outcome"></span>')
					.text(history.outcomeLabel(entry.outcome)));
				$button.append($('<span class="runbun-history-attempt-position"></span>')
					.text(history.positionLabel(entry.position)));
				$button.on('click', function () {
					$attempts.find('.runbun-history-attempt').removeClass('is-selected')
						.find('.runbun-history-attempt-button').attr('aria-pressed', 'false');
					$row.addClass('is-selected');
					$button.attr('aria-pressed', 'true');
					renderPlanningReview(entry);
				});
				$row.append($button);
				if (attemptStore && entry.attemptId) {
					$row.append($('<button type="button" class="btn runbun-history-attempt-export"></button>')
						.attr('title', 'Put this run\'s checked archive in the transfer box')
						.text('Export')
						.on('click', function () {
							attemptStore.exportAttempt(entry.attemptId).then(function (bundle) {
								if (!bundle) {
									status('No durable archive exists for this run.', 'error');
									return;
								}
								$('#runbun-run-transfer').val(JSON.stringify(bundle))
									.closest('details').prop('open', true);
								status((entry.name || 'The run') + '\'s archive is in the ' +
									'transfer box — copy it somewhere safe.', 'ok');
							}).catch(function (error) {
								status(error.message, 'error');
							});
						}));
				}
				$attempts.append($row);
			});

			var $species = $('#runbun-history-species').empty();
			summary.species.forEach(function (row) {
				var $tr = $('<tr></tr>');
				$tr.append($('<th scope="row"></th>').text(row.species));
				$tr.append($('<td></td>').text(row.attempts));
				$tr.append($('<td></td>').text(row.caught));
				$tr.append($('<td></td>').text(row.survived));
				$tr.append($('<td></td>').text(history.positionLabel(row.bestPosition)));
				$species.append($tr);
			});

			if (!summary.tracked) {
				$state.text('No finished runs saved yet.');
				return summary;
			}
			$state.text(summary.ended ?
				summary.ended + ' finished run' + (summary.ended === 1 ? '' : 's') +
					' saved in this browser.' :
				'The active run joins history when it ends.');
			$('#runbun-history-content').prop('hidden', false);
			return renderPlanningReview(summary.attempts[0]).then(function () { return summary; });
		}).catch(function (error) {
			$state.text('Could not read run history: ' + error.message);
			throw error;
		});
	}

	function openHistory() {
		revealSection('history');
		return renderHistory().then(function () {
			var target = document.querySelector(
				'.rb-disclose[data-section="history"] .rb-disclose-btn');
			if (target) {
				target.scrollIntoView({block: 'start'});
				target.focus();
			}
		});
	}

	/**
	 * Draw one `/run/status` payload. Split out from `render` so an import can
	 * paint the answer it already had to fetch to validate the run, rather than
	 * asking the same question twice.
	 */
	function paint(payload) {
		lastStatus = payload;
		stagedParty = state.party.slice();
		var summary = payload.status;
		$('#runbun-run-name').text(summary.name);
		// The next boss frames the current stretch, so it leads the position line.
		$('#runbun-run-position').text(
			(summary.split && !summary.split.finished ?
				'Road to ' + displayText(summary.split.boss.replace(/^Leader /, '')) + ' · boss ' +
					summary.split.index + '/' + summary.split.of + ' · ' : '') +
			(summary.next ?
				'Next: #' + summary.next.order + ' ' + displayText(summary.next.trainer) :
				'The run map is finished.'));
		$('#runbun-run-cap').text(summary.levelCap.cap === null ?
			'' :
			'Level cap ' + summary.levelCap.cap + ' — ' + displayText(summary.levelCap.trainer) +
				"'s " + summary.levelCap.ace);

		renderSpine(payload);
		renderBox(payload);
		renderPartyStrip();
		renderSelectedMon();
		renderNextStep(payload);
		renderOpportunities(payload);
		renderReachableRoutes(payload);
		renderSplit(payload);
		renderUpcoming(payload);

		// Mark maps whose one encounter is spent, right in the Where dropdown —
		// display only, from the log's own catch entries; the server still owns
		// the rule. The option VALUE stays the bare name the server resolves.
		var usedMaps = {};
		(state.log || []).forEach(function (entry) {
			if (entry.command && entry.command.kind === 'catch' && entry.command.map) {
				usedMaps[entry.command.map] = true;
			}
		});
		$('#runbun-run-map option').each(function () {
			var name = this.value;
			if (!name) return;
			this.textContent = displayText(name) + (usedMaps[name] ? ' — used' : '');
		});

		var bag = Object.keys(summary.bag);
		$('#runbun-run-bag').text(bag.length ?
			bag.map(function (item) { return item + ' x' + summary.bag[item]; }).join(', ') :
			'Bag is empty.');

		// The collapsed headers stay live: each section says what it holds so
		// the player only opens what they need. (`summary` here is the status
		// payload; the header writer is `writeSummary`.)
		var alive = payload.box.filter(function (mon) { return mon.status !== 'dead'; }).length;
		var lost = payload.box.length - alive;
		var reserve = alive - state.party.length;
		writeSummary('box', reserve + ' reserve' + (lost ? ' · ' + lost + ' lost' : '') +
			(bag.length ? ' · bag ' + bag.length : ''));
		writeSummary('split', payload.splitPrep && !payload.splitPrep.split.finished ?
			payload.splitPrep.split.boss.replace(/^Leader /, '') + ' · ' +
				payload.splitPrep.fightsAhead + ' fights' +
				(payload.splitPrep.pickups && payload.splitPrep.pickups.length ?
					' · ' + payload.splitPrep.pickups.length + ' items' : '') :
			'finished');
		writeSummary('road', payload.upcoming && payload.upcoming.length ?
			'#' + payload.upcoming[0].order + ' ' + payload.upcoming[0].trainer : 'nothing ahead');
		var selected = $('#runbun-run-selected').val();
		var selectedMon = selected ? findBoxed(selected) : null;
		writeSummary('tools', selectedMon ? monLabel(selectedMon) : 'select a Pokémon');
		if (!$('#runbun-run-map').val()) writeSummary('catch', 'pick a route');
		refreshStale();
		renderCalcParty();
		return payload;
	}

	function render() {
		showRun();
		if (!state) return;

		return api('/run/status', {run: state, upcomingCount: 8}).then(paint).catch(function (error) {
			status(error.message, 'error');
			// The payload is what feeds staging, so a failed status leaves
			// `stagedParty` describing a run that may no longer exist — undone mons
			// still carrying a "−" and "Use this party" ready to stage their ids. The
			// committed party is the only thing still known to be true.
			stagedParty = state.party.slice();
			if (lastStatus) {
				renderBox(lastStatus);
				renderPartyStrip();
			}
		});
	}

	/**
	 * Send one command; on success save and redraw, on refusal change nothing.
	 * Resolves `true` on success and `false` on refusal, so a caller with
	 * one-shot form fields (the Faint epitaph) knows when they were consumed.
	 */
	// ---------------------------------------------------------- snackbar undo
	//
	// ui-lab's snackbar-undo slot, ported framework-free. One deliberate
	// difference from the lab's optimistic delete: a faint here is ALREADY
	// committed to the document — the bar is a countdown on the easy
	// takeback, not a stay of execution. The undo is only honored while the
	// faint is still the run's last command; any other command landing (or
	// the window draining) dismisses the bar, because /run/undo takes back
	// whatever came last.
	var snackbar = {timer: null, tick: null, stamp: null};

	function dismissSnackbar() {
		if (snackbar.timer) window.clearTimeout(snackbar.timer);
		if (snackbar.tick) window.clearInterval(snackbar.tick);
		snackbar.timer = null;
		snackbar.tick = null;
		snackbar.stamp = null;
		$('#runbun-run-snackbar').prop('hidden', true).removeClass('is-counting');
	}

	function offerUndo(label) {
		dismissSnackbar();
		var windowMs = 6000;
		snackbar.stamp = logLength();
		var $bar = $('#runbun-run-snackbar');
		var $text = $('#runbun-run-snackbar-text');
		var reduced = window.matchMedia &&
			window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		$text.text(label);
		$bar.css('--rb-snackbar-ms', windowMs + 'ms').prop('hidden', false);
		if (reduced) {
			// The kit's reduced-motion contract: no draining ring, a plain
			// seconds countdown carries the same information as text.
			var left = Math.round(windowMs / 1000);
			$text.text(label + ' · ' + left + 's');
			snackbar.tick = window.setInterval(function () {
				left -= 1;
				if (left > 0) $text.text(label + ' · ' + left + 's');
			}, 1000);
		} else {
			// Forced reflow arms the CSS transition from the full ring.
			void $bar[0].offsetWidth;
			$bar.addClass('is-counting');
		}
		snackbar.timer = window.setTimeout(dismissSnackbar, windowMs);
	}

	function command(body) {
		var commandId = newCommandId();
		return mutate(function () {
			dismissSnackbar();
			status('Working…', '');
			var priorBoxIds = {};
			(state && state.box || []).forEach(function (mon) { priorBoxIds[mon.id] = true; });
			return api('/run/apply', {run: state, command: body}).then(function (payload) {
				state = payload.run;
				// Any applied command may change what a Pokemon can learn
				// (teach consumes the slot, level-up opens new rows) and
				// whether it is ready to evolve.
				teachableFor = null;
				evolutionFor = null;
				var eventPayload = {command: body};
				if (body.kind === 'catch') {
					var added = (state.box || []).filter(function (mon) { return !priorBoxIds[mon.id]; });
					if (added.length === 1) eventPayload.result = {pokemonId: added[0].id};
				}
				return persist('command.applied', eventPayload, commandId).then(function () {
					status(payload.summary, 'ok');
					return render().then(function () { return true; });
				});
			}).catch(function (error) {
				if (error && error.code === 'REVISION_CONFLICT') return recoverConflict(error);
				bumpCounter('refusals', body.kind || 'unknown');
				// The refusal message is the feature: it says why this could not have
				// happened in the game, not merely that the form was wrong.
				status(error.message, 'error');
				// A refusal still has to redraw: staging built for the refused command
				// is now describing a run the server never accepted. `render` resyncs
				// it from the authoritative state and leaves this message standing.
				return render().then(function () { return false; });
			});
		});
	}

	function loadMaps() {
		// `.ok` matters as much as the parse. A 500 with an HTML error page
		// parses as a rejection and a 500 with a JSON body does not, so without
		// this the panel would build a route list out of an error payload.
		// api() has checked this since it was written; this call never did.
		return fetch('/run/maps').then(function (response) {
			if (!response.ok) {
				throw new Error('the route list could not be loaded (HTTP ' + response.status + ')');
			}
			return response.json();
		})
			.then(function (payload) {
				maps = payload.maps || [];
				var $select = $('#runbun-run-map').empty();
				$select.append($('<option value=""></option>')
					.text('No route — starter, gift, static, or trade'));
				maps.forEach(function (map) {
					$select.append($('<option></option>').attr('value', map.name)
						.text(displayText(map.name)));
				});
				$('#runbun-run-limits').text(payload.limits ? payload.limits.note : '');
			});
	}

	function showEncounters() {
		var map = $('#runbun-run-map').val();
		var $list = $('#runbun-run-encounters').empty();
		syncRouteSelection();
		if (!state || !map) return Promise.resolve();
		return api('/run/where', {run: state, map: map}).then(function (found) {
			// Under the nuzlocke rules the list is a forecast, not a menu: the
			// route's encounter is random, a used route says so, and a dupe row is
			// dead weight the re-roll skips — its odds go to what's left.
			if (found.used) {
				$list.append($('<li class="runbun-run-route-used"></li>')
					.text(found.used.species ?
						'Route used — its encounter was ' + found.used.species +
							' L' + found.used.level + '.' :
						'Route used — its encounter got away; nothing kept.'));
			}
			// The roll button rolls the methods this map actually has.
			// The method picker offers what this run can actually use. A method
			// still waiting on its HM stays visible (it is the route's future)
			// but is disabled and says why — offering it live sent the player
			// into "surf is not open here", a refusal they could not act on.
			var $method = $('#runbun-run-roll-method').empty();
			var seen = {};
			var openMethods = [];
			found.mons.forEach(function (mon) {
				if (seen[mon.method]) return;
				seen[mon.method] = true;
				var gated = mon.methodGated;
				if (!gated) openMethods.push(mon.method);
				$method.append($('<option></option>')
					.attr('value', mon.method)
					.prop('disabled', !!gated)
					.text(gated ? mon.method + ' — not yet, needs ' + methodNeed(mon.method) : mon.method));
			});
			if (openMethods.length) $method.val(openMethods[0]);
			$('#runbun-run-roll').prop('disabled', !openMethods.length)
				.attr('title', openMethods.length ?
					'Find one random wild Pokémon from this location' :
					'No encounter method here is open yet — the HMs that unlock them are still ahead');
			// The guided half of "what is here": the field items standing on
			// this location. An open, uncollected one carries the button that
			// records the pickup; a collected one stays as the record it is.
			var waiting = (found.items || []).filter(function (item) {
				return !item.collected && item.open;
			}).length;
			writeSummary('catch', found.name +
				(found.used ? ' · used' : '') +
				(waiting ? ' · ' + waiting + ' item' + (waiting > 1 ? 's' : '') + ' here' : ''));
			var $items = $('#runbun-run-items').empty();
			(found.items || []).forEach(function (item) {
				var $row = $('<li class="runbun-run-item"></li>')
					.toggleClass('is-collected', item.collected)
					.toggleClass('is-waiting', !item.collected && !item.open)
					.append($('<span class="runbun-run-item-name"></span>').text(item.name))
					.append($('<span class="runbun-run-item-kind"></span>').text(item.kind));
				if (item.collected) {
					$row.append($('<span class="runbun-run-item-state"></span>').text('✓ collected'));
				} else if (item.open) {
					$row.append($('<button type="button" class="runbun-run-pickup-take"></button>')
						.attr('data-item', item.name).text('Take ' + item.name));
				} else {
					$row.append($('<span class="runbun-run-item-state"></span>')
						.text('opens at #' + item.opensAt));
				}
				$items.append($row);
			});
			// The dupe tooltip names the mode in force — 'species' and 'line'
			// draw the line in different places, which is the toggle's point.
			var dupesMode = lastStatus && lastStatus.status.rules ?
				lastStatus.status.rules.dupes : 'line';
			var dupeTitle = {
				species: 'Already in the box — the same species does not count, re-roll',
				line: 'Same evolution line as a box entry — does not count, re-roll',
				forms: 'Same line as a box entry, or a regional form of it — does not count, re-roll',
			}[dupesMode] || 'A dupe under this run\'s rules — does not count, re-roll';
			// Two lists, not one: what this route can hand over RIGHT NOW,
			// and what it still owes once an HM arrives. Mixing them made
			// gated rows read as claimable and sent players into refusals
			// ("surf is not open here") at the moment they meant to catch.
			function encounterRow(mon) {
				var odds = mon.dupe ? 'dupe' :
					typeof mon.odds === 'number' ? mon.odds + '%' :
						typeof mon.chance === 'number' ? mon.chance + '%' : '';
				var gated = mon.methodGated;
				return $('<li></li>')
					.toggleClass('is-owned', !!mon.owned)
					.toggleClass('is-dupe', !!mon.dupe)
					.toggleClass('is-gated', !!gated)
					.append($('<button type="button" class="runbun-run-encounter"></button>')
						.attr('data-species', mon.species)
						.attr('data-level', mon.minLevel)
						.attr('data-method', mon.method)
						.prop('disabled', !!gated)
						.attr('title', gated ?
							'Needs ' + methodNeed(mon.method) +
								', which arrives at fight number ' + gated +
								' — not claimable yet' :
							mon.dupe ? dupeTitle :
								typeof mon.odds === 'number' && mon.odds !== mon.chance ?
									mon.chance + '% raw, ' + mon.odds + '% once dupes are re-rolled' : null)
						// One SPAN per field, so the CSS grid can put level under
						// level and odds under odds. This was a single flat
						// string — "Surskit  L2-3  Super Rod  · 40%" — and with
						// proportional species names nothing below the first
						// column could ever line up.
						.append($('<span class="runbun-run-encounter-name"></span>')
							.text((mon.owned ? '✓ ' : '') + mon.species))
						.append($('<span class="runbun-run-encounter-level"></span>')
							.text('L' + mon.minLevel +
								(mon.maxLevel === mon.minLevel ? '' : '-' + mon.maxLevel)))
						.append($('<span class="runbun-run-encounter-method"></span>')
							.text(mon.rod || ''))
						.append($('<span class="runbun-run-encounter-odds"></span>')
							.text(odds)));
				// No per-row gate label. The group heading above these rows
				// already reads "4 more once you have Surf", so repeating it
				// on every line was noise — and worse, it widened one column
				// on gated rows only, which pushed the level and odds columns
				// 68px out of line with the claimable rows above them. Every
				// row now has the same four fields, so they all line up. The
				// row's own tooltip still names the requirement exactly.
			}
			var claimable = found.mons.filter(function (mon) { return !mon.methodGated; });
			var waiting = found.mons.filter(function (mon) { return !!mon.methodGated; });
			if (claimable.length) {
				$list.append($('<li class="runbun-run-encounter-group"></li>')
					.text('Catchable now · ' + claimable.length));
				claimable.forEach(function (mon) { $list.append(encounterRow(mon)); });
			} else if (found.mons.length) {
				$list.append($('<li class="runbun-run-encounter-group"></li>')
					.text('Nothing here is catchable yet'));
			}
			if (waiting.length) {
				// Name the requirement, not the order. If the waiting slots all
				// want the same thing, say it; if they differ, stay general
				// rather than picking one and misleading about the others.
				var needs = waiting.map(function (mon) { return methodNeed(mon.method); })
					.filter(function (need, index, all) { return all.indexOf(need) === index; });
				$list.append($('<li class="runbun-run-encounter-group"></li>')
					.text('If you come back · ' + waiting.length + ' more once you have ' +
						(needs.length === 1 ? needs[0] : needs.slice(0, -1).join(', ') +
							' and ' + needs[needs.length - 1])));
				waiting.forEach(function (mon) { $list.append(encounterRow(mon)); });
			}
		}).catch(function (error) {
			status(error.message, 'error');
		});
	}

	// What a gated encounter is ACTUALLY waiting on, in the player's words.
	//
	// This used to print the bare fight order — "· #589" — right beside a
	// species name, where it reads as a National Dex number. #589 is
	// Escavalier. The number was never the useful fact anyway: what the
	// player needs to know is that the slot wants Surf.
	var METHOD_NEEDS = {
		surf: 'Surf',
		'rock-smash': 'Rock Smash',
		fish: 'a Rod',
	};

	function methodNeed(method) {
		return METHOD_NEEDS[method] || method;
	}

	/** "needs Surf", or the raw method when we have no better word for it. */
	function gateLabel(method) {
		return 'needs ' + methodNeed(method);
	}

	function planningFights(trainer, limit) {
		if (!lastStatus) return null;
		var fights = (lastStatus.upcoming || []).slice();
		if (lastStatus.splitPrep && Array.isArray(lastStatus.splitPrep.gauntlet)) {
			fights = fights.concat(lastStatus.splitPrep.gauntlet);
		}
		if (trainer) {
			fights = fights.filter(function (fight) { return fight.trainer === trainer; });
		}
		var seen = {};
		return fights.filter(function (fight) {
			if (!fight || seen[fight.trainer]) return false;
			seen[fight.trainer] = true;
			return true;
		}).slice(0, limit || 1);
	}

	function embeddedForecasts(trainer) {
		var client = window.RunBunPokemonProviderClient;
		var runtime = window.RunBunPokemonProvider;
		var fights = planningFights(trainer, trainer ? 1 : 3);
		if (!client || !runtime || !fights || !fights.length) return Promise.resolve(null);
		// PER FIGHT, not per batch. This map used to throw as a whole, so one
		// label the engine cannot place — and 28 of the run's 362 fights are
		// unplaceable even with the trainer-order map — cost the other two
		// fights their forecast as well.
		//
		// A fight that cannot be resolved keeps its slot and carries its own
		// error, so the array still lines up with `fights` and the panel can
		// say which fight went unanswered rather than answering none of them.
		var options = fights.map(function (fight) {
			try {
				return {
					runtime: runtime,
					run: state,
					// Product progression is filtered. Resolve every visible label
					// through the pinned engine rather than treating a UI index as a
					// canonical trainer database key.
					trainerOrder: runtime.resolveTrainerOrder(fight.trainer),
					revision: currentRevision === null ? logLength() : currentRevision,
				};
			} catch (error) {
				return {error: error};
			}
		});
		var planned = options.filter(function (option) { return !option.error; });
		if (!planned.length) return Promise.resolve({error: options[0].error});
		var planning = typeof client.planBatch === 'function' ?
			client.planBatch(planned) : Promise.all(planned.map(client.planRun));
		return planning.then(function (results) {
			// Put the answers back beside the fights they belong to. The
			// unresolvable ones never went to the engine, so they take their
			// own error rather than somebody else's answer.
			var next = 0;
			return options.map(function (option, index) {
				var result = option.error ? {error: option.error} : results[next++];
				return {fight: fights[index], result: result};
			});
		}).catch(function (error) { return {error: error}; });
	}

	function retainForecastEvidence(forecasts) {
		if (!Array.isArray(forecasts) || !forecasts.length) return Promise.resolve({count: 0});
		if (!attemptStore || typeof attemptStore.recordEvidenceBatch !== 'function') {
			return Promise.resolve({count: 0, unavailable: true});
		}
		var recordedAt = new Date().toISOString();
		// A fight the engine refused has an error in place of a receipt, and
		// there is nothing to retain for it. Filtering here rather than
		// guarding inside the map keeps the count honest: it reports receipts
		// saved, not fights attempted.
		var withReceipts = forecasts.filter(function (forecast) {
			return forecast && forecast.result && forecast.result.receipt;
		});
		if (!withReceipts.length) return Promise.resolve({count: 0});
		return attemptStore.recordEvidenceBatch(withReceipts.map(function (forecast) {
			return {
				request: forecast.result.request,
				receipt: forecast.result.receipt,
				recordedAt: recordedAt,
			};
		})).then(function (records) {
			return {
				count: records.length,
				duplicates: records.filter(function (record) { return record.duplicate; }).length,
			};
		}).catch(function (error) {
			return {count: 0, error: error};
		});
	}

	function renderPlanEvidence(retention) {
		var $evidence = $('#runbun-run-plan-evidence').removeAttr('data-kind');
		if (!retention) {
			$evidence.text('');
			return;
		}
		if (retention.error) {
			$evidence.attr('data-kind', 'error')
				.text('Plan shown · evidence was not saved: ' + retention.error.message);
			return;
		}
		if (retention.unavailable) {
			$evidence.attr('data-kind', 'error')
				.text('Plan shown · durable evidence storage is unavailable.');
			return;
		}
		if (retention.count) {
			$evidence.attr('data-kind', 'saved').text(
				retention.count + ' simulator receipt' + (retention.count === 1 ? '' : 's') +
				' saved with this attempt' +
				(retention.duplicates ? ' · ' + retention.duplicates + ' already present' : '') + '.');
			return;
		}
		$evidence.text('');
	}

	function renderPlanOutlook(forecasts) {
		var $outlook = $('#runbun-run-plan-outlook');
		var $list = $('#runbun-run-plan-outlook-list').empty();
		// Only the fights that came back with a receipt. Since a batch fails per
		// fight rather than as a whole, this list can hold a refusal beside an
		// answer, and a refusal has no summary to read.
		var later = (Array.isArray(forecasts) ? forecasts.slice(1) : []).filter(
			function (forecast) {
				return forecast && forecast.result && forecast.result.receipt;
			});
		$outlook.prop('hidden', !later.length);
		later.forEach(function (forecast) {
			var summary = forecast.result.receipt.result.summary;
			var lead = findBoxed(summary.recommendedLeadId);
			var allSampledSafe = summary.safeBranches === summary.branchesEvaluated;
			$list.append($('<li class="runbun-run-plan-outlook-row"></li>')
				.toggleClass('is-sample-safe', allSampledSafe)
				.toggleClass('is-sample-risk', !allSampledSafe)
				.append($('<span class="runbun-run-plan-outlook-fight"></span>')
					.text(displayText(forecast.fight.trainer)))
				.append($('<span class="runbun-run-plan-outlook-lead"></span>')
					.text('Lead ' + (lead ? monLabel(lead) : summary.recommendedLeadId)))
				.append($('<span class="runbun-run-plan-outlook-result"></span>')
					.text(summary.safeBranches + '/' + summary.branchesEvaluated +
						' samples clean')));
		});
	}

	function signedMetric(value, suffix) {
		if (!Number.isFinite(value)) return 'not reported';
		return (value > 0 ? '+' : '') + value + ' ' + suffix;
	}

	function attributionTestText(test, seedCount) {
		var delta = test.delta || {};
		var name = test.kind === 'replace-party-member' ?
			'Replacement test · ' + test.targetSpecies + ' → ' + test.replacementSpecies :
			'IV reference test · ' + test.targetSpecies + ' → all 15';
		return name + ' · ' + signedMetric(delta.safeBranches, 'deathless branches') +
			' · ' + signedMetric(delta.deaths, 'deaths') + ' · ' +
			signedMetric(delta.totalHPRemaining, 'total HP remaining') +
			' · ' + seedCount + ' paired seeds';
	}

	function renderAttribution(result, saved) {
		var $section = $('#runbun-run-attribution').prop('hidden', false);
		var $state = $('#runbun-run-attribution-state').removeAttr('data-kind');
		var $tests = $('#runbun-run-attribution-tests').empty();
		if (!result) {
			$section.prop('hidden', true);
			return;
		}
		var request = result.request;
		var receipt = result.receipt;
		var byId = {};
		request.task.interventions.forEach(function (test) { byId[test.interventionId] = test; });
		var baseline = {};
		request.task.state.baselineTeam.forEach(function (mon) { baseline[mon.id] = mon; });
		var seedCount = request.task.seeds.length;
		$state.attr('data-kind', saved && saved.error ? 'error' : 'saved').text(
			'Baseline · ' + receipt.result.baseline.safeBranches + '/' + seedCount +
			' paired seeds deathless · ' + receipt.result.interventions.length +
			' independent tests' + (saved && saved.error ?
				' · evidence was not saved: ' + saved.error.message : ' · saved with this attempt'));
		receipt.result.interventions.forEach(function (test) {
			var requested = byId[test.interventionId] || {};
			$tests.append($('<li></li>').text(attributionTestText({
				kind: test.kind,
				targetSpecies: baseline[test.targetId] && baseline[test.targetId].species || test.targetId,
				replacementSpecies: requested.replacement && requested.replacement.species,
				delta: test.delta,
			}, seedCount)));
		});
	}

	function testRosterValue(trainer) {
		var client = window.RunBunPokemonProviderClient;
		var runtime = window.RunBunPokemonProvider;
		var fight = planningFights(trainer, 1)[0];
		if (!client || !runtime || !attemptStore || !fight) {
			status('Roster value needs the embedded simulator and durable attempt history.', 'error');
			return;
		}
		var analysisAttemptId = state.attemptId;
		var analysisRevision = currentRevision;
		var analysisRun = JSON.parse(JSON.stringify(state));
		var $button = $('#runbun-run-value').prop('disabled', true).text('Testing roster…');
		$('#runbun-run-attribution').prop('hidden', false);
		$('#runbun-run-attribution-state').removeAttr('data-kind')
			.text('Running fixed-seed replacement and IV reference tests…');
		$('#runbun-run-attribution')[0].scrollIntoView({block: 'center'});
		$('#runbun-run-attribution-tests').empty();
		attemptStore.inspectAttempt(analysisAttemptId).then(function (inspected) {
			if (!inspected || !inspected.head || inspected.head.revision !== analysisRevision) {
				throw new Error('The durable attempt is not at the run currently on screen.');
			}
			return client.attributeRun({
				runtime: runtime,
				run: analysisRun,
				events: inspected.events,
				trainerOrder: runtime.resolveTrainerOrder(fight.trainer),
				revision: analysisRevision,
			});
		}).then(function (result) {
			return attemptStore.inspectAttempt(analysisAttemptId).then(function (inspected) {
				if (!inspected || !inspected.head || state.attemptId !== analysisAttemptId ||
					currentRevision !== analysisRevision ||
					inspected.head.revision !== analysisRevision ||
					inspected.head.stateHash !== result.request.attempt.stateHash) {
					throw new Error('The run changed while roster value was being modeled. Test it again.');
				}
				return attemptStore.recordEvidence({request: result.request, receipt: result.receipt,
					recordedAt: new Date().toISOString()});
			}).then(function (saved) {
				renderAttribution(result, saved);
				status('Modeled roster value saved for ' + displayText(fight.trainer) + '.', 'ok');
			}, function (error) {
				renderAttribution(result, {error: error});
				status('The model finished, but its evidence was not saved: ' + error.message, 'error');
			});
		}).catch(function (error) {
			$('#runbun-run-attribution-state').attr('data-kind', 'error').text(error.message);
			status(error.message, 'error');
		}).then(function () {
			$button.prop('disabled', false).text('Test roster value');
		});
	}

	function plan(trainer) {
		var body = {run: state};
		if (trainer) body.trainer = trainer;
		return Promise.all([api('/run/plan', body), embeddedForecasts(trainer)]).then(function (answers) {
			return retainForecastEvidence(answers[1]).then(function (retention) {
				return {answers: answers, retention: retention};
			});
		}).then(function (planned) {
			var answers = planned.answers;
			var result = answers[0];
			var forecasts = answers[1];
			var forecast = Array.isArray(forecasts) && forecasts.length ? forecasts[0].result : forecasts;
			// The margin answers "how clear is the move choice", which reads like a
			// judgement on the FIGHT and is not one. Measured across 313 planned
			// fights that now carry a live forecast, the two are uncorrelated:
			// "decided by 5 or more" split six-all on whether anybody died. The
			// survival answer sat two rows below in the PARTIAL PLAN line the
			// whole time, so the verdict now carries it when it exists.
			var survival = '';
			if (forecast && !forecast.error && forecast.receipt) {
				var outcome = forecast.receipt.result;
				var counts = outcome.summary;
				survival = outcome.safe ?
					' · ' + counts.safeBranches + ' of ' + counts.branchesEvaluated +
						' samples clean, none of them lost anyone' :
					' · a sampled branch loses ' + counts.deaths +
						(counts.deaths === 1 ? ' Pokemon' : ' Pokemon');
			}
			// A clean sample against a set the sampler cannot price is not the
			// same claim as a clean sample elsewhere. Lilith's sash Mankey was
			// forecast "worst sampled branch loses 1" fourteen times and swept
			// the party in twelve — so a threshold set is named on the verdict
			// itself, whether or not a forecast arrived, because the threat is
			// true either way.
			var caution = '';
			if (result.thresholdThreats && result.thresholdThreats.length) {
				caution = ' · CAUTION: ' + result.thresholdThreats.map(function (threat) {
					return threat.species + ' holds ' + threat.holds + ' + ' + threat.move;
				}).join(', ') + ' — the samples under-price pinch moves, keep a faster ' +
					'finisher or chip damage in hand';
			}
			$('#runbun-run-plan-verdict').text((
				result.confidence === 'contested' ?
					result.trainer + ' — contested by ' + result.margin + '. Plan for both.' :
					result.confidence === 'only-option' ?
						result.trainer + ' — only one action available.' :
						result.trainer + ' — decided by ' + result.margin + '.'
			) + survival + caution);
			// The button lives at the top of the panel and the answer renders
			// below the fold — bring the verdict to the player, same as
			// advise() and rank() already do.
			$('#runbun-run-plan-verdict')[0].scrollIntoView({block: 'center'});
			var $actions = $('#runbun-run-plan-actions').empty();
			result.actions.slice(0, 6).forEach(function (action, i) {
				$actions.append($('<div class="runbun-run-action"></div>')
					.toggleClass('is-top', i === 0)
					.append($('<span class="runbun-run-action-score"></span>').text(action.score.toFixed(2)))
					.append($('<span class="runbun-run-action-label"></span>').text(action.label)));
			});
			if (forecast && forecast.error) {
				renderPlanOutlook(null);
				// A dead forecast used to be the LAST row of the action list,
				// carrying a class with no styling at all, so it read as one
				// more option that happened to be unavailable. It is not an
				// option. It is the survival answer failing to arrive, and the
				// verdict above it does not answer survival either. So it takes
				// the slot the working forecast takes, at the top, and names the
				// question that went unanswered rather than only the provider
				// that broke.
				$actions.prepend($('<div class="runbun-run-action is-provider is-stale"></div>')
					.append($('<span class="runbun-run-action-score"></span>').text('—'))
					.append($('<span class="runbun-run-action-label"></span>')
						.text('NO SURVIVAL CHECK · nothing here says whether you live through ' +
							'this fight · pokemon-mono seed check unavailable · ' +
							forecast.error.message)));
			} else if (forecast) {
				var summary = forecast.receipt.result.summary;
				var lead = findBoxed(summary.recommendedLeadId);
				// A fair-dice sample is evidence, not a guarantee: 8 clean samples
				// still permit a fight that kills one run in twelve. The wording
				// says what was measured and nothing more.
				var branchLabel = summary.safeBranches + ' of ' + summary.branchesEvaluated +
					' fair-dice samples came back clean';
				var risk = forecast.receipt.result.safe ? 'no deaths observed' :
					'worst sampled branch loses ' + summary.deaths;
				$actions.prepend($('<div class="runbun-run-action is-provider is-top"></div>')
					.append($('<span class="runbun-run-action-score"></span>')
						.text(summary.safeBranches + '/' + summary.branchesEvaluated))
					.append($('<span class="runbun-run-action-label"></span>')
						.text('PARTIAL PLAN · Pokemon Mono · lead ' +
							(lead ? monLabel(lead) : summary.recommendedLeadId) +
							' · ' + branchLabel + ' · ' + risk)));
				renderPlanOutlook(forecasts);
			} else {
				renderPlanOutlook(null);
			}
			renderPlanEvidence(planned.retention);
			stamp('plan');
			// The verdict renders far below the hero commands; an answer the
			// player asked for must arrive on their screen — same treatment
			// Advise gives its shortlist.
			var verdictNode = document.getElementById('runbun-run-plan-verdict');
			if (verdictNode) verdictNode.scrollIntoView({block: 'nearest'});
		}).catch(function (error) {
			renderPlanEvidence(null);
			status(error.message, 'error');
		});
	}

	// --------------------------------------------------------- upgrade advisor

	/**
	 * The shortlist, one row per change.
	 *
	 * Compact on purpose: the player is choosing between ten one-line options,
	 * not reading a report. KO delta leads because it is what decides the
	 * fight; the damage figure is bars of HP summed across the trainer, so it
	 * only breaks ties between changes that flip the same number of cells.
	 */
	function renderAdvice(payload) {
		var byId = {};
		var kindLabels = {
			teach: 'Teach move',
			evolve: 'Evolve',
			pickup: 'Pick up item',
			give: 'Give item',
		};
		payload.party.forEach(function (mon) { byId[mon.id] = mon; });
		$('#runbun-run-advice-note').text(
			displayText(payload.trainer) + ' (#' + payload.order + ') · ' +
			payload.considered + ' available upgrades compared' +
			(payload.projection.applied && payload.projection.from === 'projected' ?
				' · party projected to level cap ' + payload.projection.cap : '') +
			(payload.availability && payload.availability.undatedMovesExcluded ?
				' · ' + payload.availability.undatedMovesExcluded +
					' TM/tutor moves skipped because their unlock timing is unknown' : ''));
		var $list = $('#runbun-run-advice').empty();
		if (!payload.upgrades.length) {
			$list.append($('<li class="runbun-run-advice-empty"></li>')
				.text('No available upgrade improves a matchup in this fight.'));
			return;
		}
		payload.upgrades.forEach(function (entry) {
			var mon = byId[entry.id] || {};
			// Gains and concessions render separately: a net of zero can hide a
			// trade, and a trade must never look like a free win.
			var koParts = [];
			if (entry.delta.koGained > 0) koParts.push('+' + entry.delta.koGained);
			if (entry.delta.koConceded > 0) koParts.push('-' + entry.delta.koConceded);
			$list.append($('<li class="runbun-run-advice-row"></li>')
				.append($('<span class="runbun-run-advice-who"></span>')
					.text(mon.species ? monLabel(mon) : 'Selected Pokémon'))
				.append($('<span class="runbun-run-advice-kind"></span>')
					.text(kindLabels[entry.kind] || displayText(entry.kind)))
				.append($('<span class="runbun-run-advice-what"></span>').text(entry.detail))
				// A one-shot item is a different offer from a permanent one, and the
				// damage column cannot say so: the grid credits a held item in every
				// enemy column, so a berry that fires once is priced as though it
				// fired in all of them. Naming it is what can be told truthfully
				// until the run tracks what was eaten.
				.append($('<span class="runbun-run-advice-once"></span>')
					.attr('title', entry.singleUse ?
						'used up the first time it works, and the score prices it as ' +
						'though it lasted the whole fight' : '')
					.text(entry.singleUse ? 'one-shot' : ''))
				.append($('<span class="runbun-run-advice-ko"></span>')
					.toggleClass('is-ko', entry.delta.koGained > entry.delta.koConceded)
					.toggleClass('is-ko-trade', entry.delta.koConceded > 0)
					// A cure answers a turn, not a health bar, and the KO/damage
					// columns cannot say so — a Cheri Berry reads +0.00 next to
					// every option that adds damage, which is exactly how the
					// only counter to a status lock stayed invisible.
					.text(koParts.length ? koParts.join('/') + ' KO' :
						entry.delta.statusAnswered ?
							'answers ' + entry.delta.statusAnswered : ''))
				.append($('<span class="runbun-run-advice-damage"></span>')
					.attr('title', 'bars of HP, summed across the fight' +
						(entry.delta.koConceded ?
							' · ' + entry.delta.koConceded + ' KO conceded' : ''))
					.text((entry.delta.damage >= 0 ? '+' : '') +
						entry.delta.damage.toFixed(2))));
		});
	}

	function advise(trainer) {
		status('Pricing every change against that fight…', '');
		var body = {run: state};
		if (trainer) body.trainer = trainer;
		// Survival first, damage second: the upgrade list answers "what hits
		// harder", which a party can gain while staying just as dead. This
		// asks the preparation graph the other question — what, if anything,
		// removes a lethal branch, and what it costs.
		api('/run/safety', body).then(renderSurvival).catch(function () {
			$('#runbun-run-survival').prop('hidden', true);
		});
		api('/run/advise', body).then(function (payload) {
			renderAdvice(payload);
			stamp('advice');
			revealSection('analysis');
			$('.runbun-run-advice-block')[0].scrollIntoView({block: 'start'});
			status('', '');
		}).catch(function (error) {
			status(error.message, 'error');
		});
	}

	// ----------------------------------------------------------- party ranking

	/**
	 * The ranker's shortlist. One row per six, the lead bracketed the way the
	 * CLI brackets it, the unanswered enemies named underneath — a six that
	 * leaves something unanswered has to say so on the same row that ranks it.
	 */
	function renderRanking(payload) {
		var playedCount = payload.parties.filter(function (party) {
			return party.adjudication;
		}).length;
		$('#runbun-run-rank-note').text(
			displayText(payload.trainer) + ' (#' + payload.order + ') · ' +
			payload.combinations + ' ' +
				(payload.combinations === 1 ? 'party' : 'parties') +
				// A cut box must say so here. "from 36 Pokémon" after the ranker
				// enumerated a shortlist of eighteen is a claim it did not earn,
				// and the count beside it is exactly what makes it read as one.
				(payload.shortlist && payload.shortlist.cutting ?
					' from ' + payload.shortlist.candidates + ' of ' + payload.boxSize +
						' Pokémon (' + payload.shortlist.cut + ' answered no enemy)' :
					' from ' + payload.boxSize + ' Pokémon') +
			(payload.projection.applied && payload.projection.from === 'projected' ?
				' · projected to level cap ' + payload.projection.cap : '') +
			(playedCount ?
				' · best ' + playedCount + ' tested (' + payload.adjudication.rollouts +
					' conservative simulations each)' :
				' · [lead] first; ranking includes expected switch-in damage'));
		var $list = $('#runbun-run-ranking').empty();
		payload.parties.forEach(function (party) {
			var names = party.members.map(function (member) {
				return member.id === party.lead ? '[' + member.species + ']' : member.species;
			});
			var $row = $('<li class="runbun-run-rank-row"></li>')
				.append($('<span class="runbun-run-rank-score"></span>').text(party.score))
				.append($('<span class="runbun-run-rank-six"></span>').text(names.join(' ')));
			// The played verdict outranks the grid and says so first: what
			// happened in twelve fights beats what the matrix predicted.
			if (party.adjudication) {
				// The number carries its method: 'won 12/12 sims' is a
				// simulation tally, never confusable with the plan's exact
				// seeded branches. A bare 'Win 100%' read as a promise.
				var sims = party.adjudication.rollouts;
				$row.append($('<span class="runbun-run-rank-played"></span>')
					.toggleClass('is-win', party.adjudication.pWin >= 0.75)
					.toggleClass('is-loss', party.adjudication.pWin <= 0.25)
					.text(sims ?
						'won ' + Math.round(party.adjudication.pWin * sims) + '/' + sims +
							' sims · ' + party.adjudication.eDeaths.toFixed(1) + ' deaths avg' :
						'Win ' + Math.round(party.adjudication.pWin * 100) + '% · ' +
							party.adjudication.eDeaths.toFixed(1) + ' deaths'));
			}
			var tags = [];
			if (party.label && party.label !== 'top') tags.push(party.label);
			if (party.leadCollapse) tags.push('lead-sensitive');
			if (tags.length) {
				$row.append($('<span class="runbun-run-rank-tag"></span>').text(tags.join(' · ')));
			}
			if (party.unanswered.length) {
				$row.append($('<span class="runbun-run-rank-unanswered"></span>')
					.text('unanswered: ' + party.unanswered.join(', ')));
			}
			$list.append($row);
		});
	}

	function rank() {
		status('Ranking every six against that fight…', '');
		api('/run/rank', {run: state}).then(function (payload) {
			renderRanking(payload);
			stamp('rank');
			revealSection('analysis');
			$('.runbun-run-rank-block')[0].scrollIntoView({block: 'start'});
			status('', '');
		}).catch(function (error) {
			status(error.message, 'error');
		});
	}

	// ---------------------------------------------------------------- routes

	/**
	 * Every map still holding its encounter, unlock order first. The badge is
	 * the availability import speaking: open now, opens at an order, or
	 * honestly unknown — never unknown dressed up as closed. A * on a prospect
	 * is a method waiting on its HM.
	 */
	function renderRoutes(payload) {
		var unused = payload.routes.filter(function (route) { return !route.used; });
		var used = payload.routes.filter(function (route) { return route.used; });
		var open = unused.filter(function (route) { return route.open; }).length;
		$('#runbun-run-routes-note').text(
			unused.length + ' routes still hold an encounter · ' +
			open + ' open now · ' + used.length + ' spent · * waits on its HM');
		var $list = $('#runbun-run-routes').empty();
		unused.forEach(function (route) {
			var badge = route.held ? (route.held.ready ? 'READY' : 'held') :
				route.open ? 'open' :
					route.opensAt !== undefined ? '#' + route.opensAt : '?';
			var best = route.best.map(function (mon) {
				var where = mon.where ?
					' (' + (mon.where.replace(route.name, '').trim() || mon.where) + ')' : '';
				return mon.species + ' ' + mon.chance + '%' +
					(mon.method === 'walk' ? '' : ' ' + mon.method) +
					(mon.gated !== undefined ? '*' : '') + where;
			}).join(', ');
			var saving = route.held && route.held.for ?
				' — saving for ' + route.held.for + (route.held.ready ? ' (catchable NOW)' : '') : '';
			$list.append($('<li class="runbun-run-route-row"></li>')
				.toggleClass('is-open', !!route.open && !route.held)
				.toggleClass('is-held', !!route.held)
				.append($('<span class="runbun-run-route-when"></span>').text(badge))
				.append($('<span class="runbun-run-route-name"></span>')
					.text(displayText(route.name)))
				.append($('<span class="runbun-run-route-best"></span>')
					.text((best || 'everything here is a dupe') + saving)));
		});
		used.forEach(function (route) {
			$list.append($('<li class="runbun-run-route-row is-used"></li>')
				.append($('<span class="runbun-run-route-when"></span>').text('used'))
				.append($('<span class="runbun-run-route-name"></span>')
					.text(displayText(route.name)))
				.append($('<span class="runbun-run-route-best"></span>')
					.text((route.used.species ?
						'gave ' + route.used.species + ' L' + route.used.level :
						'spent — nothing kept') +
						(route.used.where ? ' (' + route.used.where + ')' : ''))));
		});
	}

	function routesView() {
		status('Reading the routes…', '');
		return api('/run/routes', {run: state}).then(function (payload) {
			renderRoutes(payload);
			stamp('routes');
			status('', '');
		}).catch(function (error) {
			status(error.message, 'error');
		});
	}

	/** The catch advisor: what the open routes could add, on the board. */
	function renderScout(payload) {
		$('#runbun-run-routes-note').text(
			'vs ' + payload.trainer + ' (#' + payload.order + ')' +
			(payload.cap !== null ? ' at cap ' + payload.cap : '') +
			' · ' + payload.routesOpen + ' encounter areas open · your party can KO ' +
			payload.partyCovers + ' of their ' + payload.enemies +
			(payload.gated ? ' · ' + payload.gated + ' prospects wait on an HM' : '') +
			' — each prospect shows how many of their team it could KO');
		var $list = $('#runbun-run-scout').empty();
		if (!payload.catches.length) {
			$list.append($('<li class="runbun-run-scout-empty"></li>')
				.text('No available encounter improves a matchup against this trainer.'));
			return;
		}
		payload.catches.forEach(function (entry) {
			var $row = $('<li class="runbun-run-scout-row"></li>')
				.append($('<span class="runbun-run-scout-species"></span>')
					.text(entry.species + ' L' + entry.level))
				.append($('<span class="runbun-run-scout-where"></span>')
					.text(displayText(entry.name) + ' · ' + entry.chance + '%' +
						(entry.method === 'walk' ? '' : ' ' + entry.method)))
				.append($('<span class="runbun-run-scout-ko"></span>')
					.toggleClass('is-ko', entry.newAnswers > 0)
					.toggleClass('is-ko-trade', entry.kosConceded > 0)
					.attr('title', 'Could KO ' + entry.kos + ' of their ' + payload.enemies +
						(entry.newAnswers ? '; answers ' + entry.newAnswers +
							' your party currently cannot' : '') +
						(entry.kosConceded ? '; ' + entry.kosConceded +
							' of theirs would KO it back' : ''))
					.text((entry.newAnswers ? '+' + entry.newAnswers + ' new · ' : '') +
						'KOs ' + entry.kos + '/' + payload.enemies +
						(entry.kosConceded ? ' · KOd by ' + entry.kosConceded : '')));
			$list.append($row);
		});
	}

	function scout() {
		status('Comparing open encounter areas against the boss…', '');
		api('/run/scout', {run: state}).then(function (payload) {
			renderScout(payload);
			stamp('routes');
			status('', '');
		}).catch(function (error) {
			status(error.message, 'error');
		});
	}

	/**
	 * The run's single worst-case verdict for a fight, from the same cells the
	 * board colours: which of our party a crit can kill, and how many of their
	 * Pokemon can do it. Every surface reads this — the readiness strip, the
	 * plan card, the rank rows — so the app stops speaking four dialects about
	 * the same risk.
	 */
	function worstCaseVerdict(payload) {
		if (!payload || !payload.grid || !payload.box) return null;
		var partyIds = (state && state.party) || [];
		var rows = payload.box.map(function (mon, index) { return {mon: mon, index: index}; })
			.filter(function (entry) { return partyIds.indexOf(entry.mon.id) !== -1; });
		if (!rows.length) return null;
		var lethal = [];
		rows.forEach(function (entry) {
			payload.grid.forEach(function (row) {
				var cell = row.versus[entry.index];
				if (cell && cell.them && cell.them.critKO) {
					lethal.push({
						ours: entry.mon.nickname || entry.mon.species,
						theirs: row.enemy.species,
						move: cell.them.critMove || cell.them.move,
					});
				}
			});
		});
		var leadId = partyIds[0];
		var leadRow = rows.filter(function (entry) { return entry.mon.id === leadId; })[0];
		var leadAtRisk = leadRow ? lethal.some(function (hit) {
			return hit.ours === (leadRow.mon.nickname || leadRow.mon.species);
		}) : false;
		return {
			lethal: lethal,
			leadAtRisk: leadAtRisk,
			exposed: lethal.reduce(function (names, hit) {
				if (names.indexOf(hit.ours) === -1) names.push(hit.ours);
				return names;
			}, []),
		};
	}

	function renderWorstCase(verdict) {
		var $risk = $('#runbun-run-ready-risk');
		if (!verdict) {
			// A real control, not a sentence. This read "Check matchup" as
			// plain text beside a BUTTON of the same name — and that button
			// runs plan(), which answers a different question (how decided the
			// opponent's choice is) and never fills this cell. Only board()
			// computes the worst case, and board() had no control anywhere in
			// this strip, so following the instruction did nothing at all.
			$risk.removeAttr('data-risk').empty().append(
				$('<button type="button" id="runbun-run-ready-risk-check"' +
					' class="runbun-run-risk-check"></button>')
					.text('Check matchup'));
			return;
		}
		// Once there is an answer the cell is prose again, not a control.
		$risk.empty();
		if (!verdict.lethal.length) {
			$risk.attr('data-risk', 'safe').text('No crit kills anyone');
			return;
		}
		var first = verdict.lethal[0];
		$risk.attr('data-risk', verdict.leadAtRisk ? 'lethal' : 'thin')
			.text(first.theirs + '\u2019s ' + first.move + ' crit KOs ' + first.ours +
				(verdict.exposed.length > 1 ?
					' (+' + (verdict.exposed.length - 1) + ' more exposed)' : ''));
	}

	/**
	 * The survival answer, rendered above the damage list: who a crit can
	 * kill, what removes that branch, and — when nothing does — saying so
	 * plainly instead of offering a damage upgrade as if it were a fix.
	 */
	function renderSurvival(answer) {
		var $block = $('#runbun-run-survival').empty();
		if (!answer || !answer.exposed || !answer.exposed.length) {
			$block.prop('hidden', false)
				.append($('<p class="runbun-run-survival-verdict" data-risk="safe"></p>')
					.text('No crit in ' + displayText(answer && answer.trainer || 'this fight') +
						' kills anyone in your party.'));
			return;
		}
		$block.prop('hidden', false);
		$block.append($('<p class="runbun-run-survival-verdict" data-risk="lethal"></p>')
			.text(answer.exposed.map(function (entry) {
				return (entry.species || entry.id) + ' dies to ' +
					entry.killers.map(function (killer) {
						return killer.enemy + '\u2019s ' + killer.move;
					}).slice(0, 2).join(' or ') +
					(entry.killers.length > 2 ? ' (+' + (entry.killers.length - 2) + ')' : '');
			}).join(' · ')));
		// The assignment answer first: when their crit outdamages a whole HP
		// bar, the fix is not a build — it is who you send in.
		if (answer.coverage && answer.coverage.length) {
			$block.append($('<p class="runbun-run-survival-label"></p>')
				.text('Who can face them and live'));
			var $cover = $('<ul class="runbun-run-survival-coverage"></ul>');
			answer.coverage.forEach(function (row) {
				$cover.append($('<li></li>').text(
					row.enemy + ' kills ' + row.kills.join(', ') + ' — ' +
					(row.bestAnswer ?
						'send ' + row.bestAnswer + ' (takes ' + row.bestAnswerCrit +
							'% on a crit)' +
							(row.answers.length > 1 ?
								', or ' + row.answers.slice(1).join(', ') : '') :
						'nobody in this party survives it')));
			});
			$block.append($cover);
		}
		if (answer.steps && answer.steps.length) {
			$block.append($('<p class="runbun-run-survival-label"></p>')
				.text('What removes a lethal branch'));
			var $list = $('<ol class="runbun-run-survival-steps"></ol>');
			answer.steps.slice(0, 4).forEach(function (step) {
				$list.append($('<li></li>').text(
					step.species + ': ' + step.detail +
					(step.path && step.path.length > 1 ?
						' (' + step.path.length + ' steps)' : '') +
					' — removes ' + step.removes + ' lethal ' +
					(step.removes === 1 ? 'matchup' : 'matchups') +
					(step.remaining ? ', ' + step.remaining + ' still lethal' : ', none left') +
					' · costs ' + step.cost));
			});
			$block.append($list);
		} else if (answer.saferLeads && answer.saferLeads.length) {
			$block.append($('<p class="runbun-run-survival-label"></p>')
				.text('Nothing you can build fixes it — but these lead safely'));
			$block.append($('<p class="runbun-run-survival-leads"></p>')
				.text(answer.saferLeads.map(function (lead) {
					return lead.nickname || lead.species;
				}).join(', ')));
		} else {
			$block.append($('<p class="runbun-run-survival-label"></p>')
				.text('Nothing available makes this fight crit-safe'));
			$block.append($('<p class="runbun-run-survival-leads"></p>')
				.text(answer.openRoutes && answer.openRoutes.length ?
					'Unspent encounters that could still change it: ' +
						answer.openRoutes.slice(0, 4).map(displayText).join(', ') :
					'No unspent encounter is open either — this fight is a risk you take or a level you earn.'));
		}
	}

	// ---------------------------------------------------------- matchup board

	/**
	 * Sequential heat ramp for the matchup grids — one hue, light-to-dark, so a
	 * darker cell always means a harder hit. Fill and label ink travel as pairs
	 * (the label flips to white where the fill goes dark), and the hexes hold on
	 * both themes because a filled cell brings its own ground. Speed rides on
	 * glyphs, never on color, so the fill stays honest single-variable.
	 */
	var HEAT = [
		['#cde2fb', '#1a2228'],
		['#9ec5f4', '#1a2228'],
		['#6da7ec', '#1a2228'],
		['#3987e5', '#ffffff'],
		['#256abf', '#ffffff'],
		['#184f95', '#ffffff'],
		['#0d366b', '#ffffff'],
	];
	function heat(fraction) {
		var pct = fraction * 100;
		return HEAT[pct <= 10 ? 0 : pct <= 20 ? 1 : pct <= 35 ? 2 :
			pct <= 50 ? 3 : pct <= 75 ? 4 : pct < 100 ? 5 : 6];
	}
	var SPEED_GLYPH = {faster: '▲', slower: '▼', tie: '＝'};

	/**
	 * One direction of the board as a real table: our box down the side, the
	 * trainer's party across the top. A table because that is what it is — the
	 * headers are the identity channel and a screen reader walks it for free.
	 */
	function matrixTable(payload, direction, caption) {
		var $table = $('<table class="runbun-run-matrix-table"></table>');
		$table.append($('<caption></caption>').text(caption));
		var $head = $('<tr></tr>').append($('<th scope="col"></th>'));
		payload.grid.forEach(function (row) {
			$head.append($('<th scope="col"></th>')
				.text(row.enemy.species + ' L' + row.enemy.level));
		});
		$table.append($('<thead></thead>').append($head));
		var $body = $('<tbody></tbody>');
		payload.box.forEach(function (mon, i) {
			var $row = $('<tr></tr>');
			var ours = mon.nickname || mon.species;
			$row.append($('<th scope="row"></th>')
				.text(ours + ' L' + mon.level)
				.attr('title', mon.level !== mon.from ?
					'projected from L' + mon.from + ' by the cap' : null));
			payload.grid.forEach(function (row) {
				var cell = row.versus[i];
				var side = cell[direction];
				// Worst case, per the run's own planning rule: what WE can rely
				// on is the minimum roll; what THEY can do is a crit. Colouring
				// our side by its maximum was the board's optimism.
				var shown = direction === 'us' ? side.min :
					(side.critMax !== undefined ? side.critMax : side.max);
				var colors = heat(shown);
				var label = side.move ? Math.round(shown * 100) + '%' : '—';
				var $cell = $('<td></td>')
					.text(label)
					.css({'background-color': colors[0], color: colors[1]})
					.toggleClass('is-ko', direction === 'us' ? side.guaranteedKO : !!side.critKO)
					// Every cell is a doorway: this pairing, one click, in the
					// full calculator. Keyboard gets the same door.
					.attr('data-mon-id', mon.id)
					.attr('data-enemy', row.enemy.species)
					.attr('role', 'button')
					.attr('tabindex', '0')
					.attr('title', (direction === 'us' ? ours : row.enemy.species) + ': ' +
						(side.move ?
							side.move + ' ' + Math.round(side.min * 100) + '-' +
								Math.round(side.max * 100) + '%' +
								(side.critMax !== undefined && side.critMax > side.max ?
									' · ' + Math.round(side.critMax * 100) + '% on a crit' +
										(side.critMove && side.critMove !== side.move ?
											' (' + side.critMove + ')' : '') : '') +
								(side.guaranteedKO ? ' · guaranteed KO' :
									side.possibleKO ? ' · possible KO' : '') +
								(direction === 'them' && side.critKO ? ' · a crit KOs us' : '') :
							'no damaging move') +
						(cell.speed ? ' · we are ' + cell.speed : '') +
						' — open this pairing in the calculator');
				if (cell.speed && SPEED_GLYPH[cell.speed]) {
					$cell.append($('<span class="runbun-run-matrix-speed" aria-hidden="true"></span>')
						.text(SPEED_GLYPH[cell.speed]));
				}
				$row.append($cell);
			});
			$body.append($row);
		});
		$table.append($body);
		return $table;
	}

	function renderMatrix(payload) {
		var $matrix = $('#runbun-run-matrix').empty();
		$('#runbun-run-matrix-note').text(
			payload.trainer + ' (#' + payload.order + ')' +
			(payload.projection.applied && payload.projection.from === 'projected' ?
				' · box projected to cap ' + payload.projection.cap +
					' — the levels the free candy gives you there' :
				' · box at current levels') +
			' · dark = harder hit · ring = KO · ▲ we are faster · ' +
			'our numbers are minimum rolls, theirs assume a critical hit');
		$matrix.attr('data-trainer', payload.trainer);
		renderWorstCase(worstCaseVerdict(payload));
		$matrix.append(matrixTable(payload, 'us', 'What we can rely on — floor roll, % of their HP'));
		$matrix.append(matrixTable(payload, 'them', 'What we must survive — their crit, % of ours'));
	}

	function board(trainer) {
		status('Grading the box…', '');
		var body = {run: state};
		if (trainer) body.trainer = trainer;
		api('/run/matrix', body).then(function (payload) {
			renderMatrix(payload);
			stamp('matrix');
			revealSection('analysis');
			$('.runbun-run-matrix-block')[0].scrollIntoView({block: 'start'});
			status('', '');
		}).catch(function (error) {
			status(error.message, 'error');
		});
	}

	// -------------------------------------------------------- the recreation
	//
	// The run played WITHOUT the game running beside it: the dice roll here
	// (off the same tables a reported catch is checked against) and the fights
	// play here, turn by turn, against the same AI policy the planner predicts
	// with. Nothing bypasses the document — a roll becomes an ordinary catch
	// or spend, a fight ends in ordinary faint and beat commands, and every
	// one of them is still verified server-side like a hand-typed one.

	/** The last roll, held until Catch or "It got away" writes its truth —
	 * and PERSISTED like the battle is: a rolled encounter is a die already
	 * cast, so a refresh must neither eat it nor deal a second one. */
	var rolled = null;
	var rolledLog = 0;
	var ROLL_KEY = 'runbun.roll.v1';

	function paintRoll() {
		$('#runbun-run-roll-text').text('A wild ' + rolled.species + ' L' + rolled.level +
			' appeared! (' + rolled.method + ' · ' + rolled.chance + '%)' +
			(rolled.pull ? ' — ' + rolled.pull.ability + ' pulled the ' +
				rolled.pull.type + '-type out of the grass!' : ''));
		// What the die already decided, before the keep-or-flee decision that
		// depends on it. The roll authors an identity — six IVs, a nature and
		// an ability — and hands it straight to the catch command; none of it
		// was on screen. A nuzlocke route gives ONE encounter, and the number
		// that most decides whether this one is worth building on is the IV
		// total: a wild roll averages 93 against the flat 186 every trainer
		// is built with, and the spread across a box is nearly as wide as
		// that deficit. Asking for keep-or-flee while withholding it made the
		// decision blind to the only part of it that is already known.
		$('#runbun-run-roll-identity').text([
			rolled.ivs ? ivLabel({ivs: rolled.ivs}) : null,
			rolled.nature || null,
			rolled.ability || null,
		].filter(Boolean).join(' · '));
		$('#runbun-run-roll-result').prop('hidden', false);
		// The battle/keep/flee decision wants the same numbers the fight's
		// ball buttons will wear — quoted here at full HP, before committing.
		var oddsSpecies = rolled.species;
		$('#runbun-run-roll-odds').text('');
		api('/run/catch-odds', {run: state, species: oddsSpecies}).then(function (payload) {
			if (!rolled || rolled.species !== oddsSpecies) return;
			$('#runbun-run-roll-odds').text('Catch at full HP: ' +
				payload.odds.map(function (entry) {
					return entry.ball + ' ' + entry.chance + '%' +
						(entry.held !== null ? ' ×' + entry.held : '');
				}).join(' · '));
		}).catch(function (ignore) { /* the quote is optional; the fight still shows odds */ });
	}

	function persistRoll() {
		try {
			window.localStorage.setItem(ROLL_KEY, JSON.stringify(
				{logLength: rolledLog, roll: rolled}));
		} catch (error) { /* advice that cannot persist is still advice */ }
	}

	function clearRollSave() {
		rolled = null;
		try {
			window.localStorage.removeItem(ROLL_KEY);
		} catch (error) { /* nothing worth surfacing */ }
	}

	/** A roll dies only when its question got answered: a later catch or
	 * spend on that map settled the route, everything else leaves the die
	 * where it fell. (An undo that removes the settle shortens the log, so
	 * the same check brings the roll back — the die was still cast.) */
	function rollStillPending(record) {
		if (!state || !record || !record.roll) return false;
		return !(state.log || []).slice(record.logLength).some(function (entry) {
			return entry.command && entry.command.map === record.roll.mapName &&
				(entry.command.kind === 'catch' || entry.command.kind === 'spend');
		});
	}

	function restoreRoll() {
		var raw;
		try {
			raw = window.localStorage.getItem(ROLL_KEY);
		} catch (error) {
			return;
		}
		if (!raw) return;
		var record = null;
		try {
			record = JSON.parse(raw);
		} catch (error) { /* an unreadable roll is dropped below */ }
		if (!record || !rollStillPending(record)) {
			clearRollSave();
			return;
		}
		rolled = record.roll;
		rolledLog = record.logLength;
		paintRoll();
	}

	function rollEncounter() {
		var map = $('#runbun-run-map').val();
		if (!state || !map) {
			status('Pick a route to roll on first.', 'error');
			return;
		}
		var method = $('#runbun-run-roll-method').val() || undefined;
		api('/run/encounter', {run: state, map: map, method: method}).then(function (payload) {
			// The server authors the whole rolled identity — IVs, nature,
			// ability. This panel only carries it; it never rolls its own.
			rolled = Object.assign({mapName: map}, payload.roll);
			rolledLog = logLength();
			paintRoll();
			persistRoll();
			status('', '');
		}).catch(function (error) {
			status(error.message, 'error');
		});
	}

	function settleRoll(kept) {
		if (!rolled) return;
		var roll = rolled;
		var body = kept ?
			{kind: 'catch', species: roll.species, level: roll.level,
				map: roll.mapName, method: roll.method, ivs: roll.ivs,
				nature: roll.nature, ability: roll.ability} :
			{kind: 'spend', map: roll.mapName, reason: 'it got away'};
		command(body).then(function (accepted) {
			if (!accepted) return;
			clearRollSave();
			$('#runbun-run-roll-result').prop('hidden', true);
			showEncounters();
		});
	}

	/** The live fight. Nothing is written to the RUN until the fight ends —
	 * but the fight itself survives a refresh: every turn is stamped against
	 * the run state it was opened from and kept in its own storage slot, so
	 * a dropped phone resumes mid-fight, and a run that moved on (another
	 * tab, an import) silently invalidates the stale fight instead. */
	var battle = null;
	var battleBusy = false;
	var BATTLE_KEY = 'runbun.battle.v1';

	/** What the fight was opened FROM: any command moves the log, so a fight
	 * resumes only into the exact document it left. */
	function runStamp() {
		return state ? state.log.length + ':' + state.position : null;
	}

	function persistBattle(reply) {
		battle.view = {
			phase: reply.phase,
			viewState: reply.viewState,
			actions: reply.actions,
		};
		battle.log = (battle.log || []).concat((reply.events || []).map(function (event) {
			return event.text;
		})).slice(-200);
		try {
			window.localStorage.setItem(BATTLE_KEY, JSON.stringify({
				stamp: runStamp(),
				bundle: battle.bundle,
				view: battle.view,
				log: battle.log,
			}));
		} catch (error) { /* a fight that cannot persist is still playable */ }
	}

	function clearBattleSave() {
		try {
			window.localStorage.removeItem(BATTLE_KEY);
		} catch (error) { /* nothing worth surfacing */ }
	}

	/**
	 * A live fight is a mode, not another disclosure in the tracker. While it
	 * owns the screen, out-of-battle editors fold away and keyboard focus moves
	 * to the battle heading. Leaving the fight restores the run desk exactly as
	 * it was; none of those sections are destroyed or re-rendered here.
	 */
	function setBattleMode(active, moveFocus) {
		var $live = $('#runbun-run-live');
		var panel = document.querySelector('#runbun-run-battle');
		$live.toggleClass('is-battle-active', !!active);
		$('#runbun-run').toggleClass('is-battle-active', !!active);
		if (!active || !panel || !moveFocus) return;
		window.requestAnimationFrame(function () {
			panel.scrollIntoView({block: 'start'});
			panel.focus({preventScroll: true});
		});
	}

	function restoreBattle() {
		var raw;
		try {
			raw = window.localStorage.getItem(BATTLE_KEY);
		} catch (error) {
			return;
		}
		if (!raw) return;
		var record = null;
		try {
			record = JSON.parse(raw);
		} catch (error) { /* an unreadable fight is dropped below */ }
		if (!record || !record.view || !record.bundle || record.stamp !== runStamp()) {
			clearBattleSave();
			return;
		}
		battle = {bundle: record.bundle, log: record.log || []};
		$('#runbun-run-battle-log').empty();
		$('#runbun-run-battle').prop('hidden', false);
		setBattleMode(true, true);
		// A resumed wild fight owns its roll again: the card yields exactly
		// as it did when Fight-it opened this battle; abandoning restores it.
		if (record.bundle.wild) $('#runbun-run-roll-result').prop('hidden', true);
		paintBattle({
			phase: record.view.phase,
			viewState: record.view.viewState,
			actions: record.view.actions,
			events: battle.log.map(function (text) {
				return {text: text};
			}),
		});
		status('The fight against ' + displayText(battle.bundle.trainer) +
			' resumed where it left off.', 'ok');
	}

	/**
	 * The conditions a switch would clear, next to the switch buttons.
	 *
	 * `status` was on the card and volatiles were not, so infatuation — which
	 * costs half your turns and IS cleared by switching — showed up only as a
	 * line in the scrolling log, while paralysis, which switching does not
	 * clear, was on the name. Exactly backwards for choosing an action.
	 */
	function conditions(active) {
		var shown = (active && active.volatiles) || [];
		return shown.length ? ' · ' + shown.join(' · ') : '';
	}

	function hpBar($bar, mon) {
		var fraction = mon.hp.max ? Math.max(0, mon.hp.current) / mon.hp.max : 0;
		$bar.css('width', Math.round(fraction * 100) + '%')
			.attr('data-band', fraction <= 0.2 ? 'low' : fraction <= 0.5 ? 'mid' : 'high');
	}

	function benchChips(bench, activeId) {
		return bench.map(function (mon) {
			var fraction = mon.hp.max ? Math.max(0, mon.hp.current) / mon.hp.max : 0;
			return $('<span class="runbun-run-battle-chip"></span>')
				.toggleClass('is-out', mon.hp.current <= 0)
				.toggleClass('is-active', mon.id === activeId)
				.text(mon.species + ' ' + Math.round(fraction * 100) + '%');
		});
	}

	function paintBattle(reply) {
		var viewState = reply.viewState;
		$('#runbun-run-battle-trainer').text(displayText(battle.bundle.trainer));
		$('#runbun-run-battle-turn').text(' · turn ' + viewState.turn);
		$('#runbun-run-battle-foe-name').text(
			viewState.foe.active.species + ' L' + viewState.foe.active.level +
			(viewState.foe.active.status ? ' · ' + viewState.foe.active.status : '') +
			conditions(viewState.foe.active));
		// Fights are played at the level cap the run can legally reach, so a
		// mon that is owned below the cap says so — otherwise the jump from
		// the roster's L5 to a battle L12 reads like a bug, not a rule.
		var ownedLevel = null;
		var activeRow = (battle.bundle.party || []).filter(function (row) {
			return row.battleId === viewState.player.active.id;
		})[0];
		if (activeRow && state && state.box) {
			var ownedMon = state.box.filter(function (mon) {
				return mon.id === activeRow.monId;
			})[0];
			if (ownedMon) ownedLevel = ownedMon.level;
		}
		var atCap = ownedLevel !== null && viewState.player.active.level > ownedLevel;
		$('#runbun-run-battle-us-name').text(
			viewState.player.active.species + ' L' + viewState.player.active.level +
			(atCap ? ' · at cap' : '') +
			(viewState.player.active.status ? ' · ' + viewState.player.active.status : '') +
			conditions(viewState.player.active))
			.attr('title', atCap ?
				'Fights are played at the run’s level cap: owned L' + ownedLevel +
					', capped to L' + viewState.player.active.level + ' for this fight.' :
				null);
		$('#runbun-run-battle-foe-meta').text(
			(viewState.foe.active.types || []).join(' / ') +
			(viewState.foe.active.ability ? ' · ' + viewState.foe.active.ability : '') +
			(viewState.foe.active.item ? ' · ' + viewState.foe.active.item : ''));
		$('#runbun-run-battle-us-meta').text(
			(viewState.player.active.types || []).join(' / ') +
			(viewState.player.active.ability ? ' · ' + viewState.player.active.ability : '') +
			(viewState.player.active.item ? ' · ' + viewState.player.active.item : ''));
		hpBar($('#runbun-run-battle-foe-hp'), viewState.foe.active);
		hpBar($('#runbun-run-battle-us-hp'), viewState.player.active);
		$('#runbun-run-battle-foe-bench').empty()
			.append(benchChips(viewState.foe.bench, viewState.foe.active.id));
		$('#runbun-run-battle-us-bench').empty()
			.append(benchChips(viewState.player.bench, viewState.player.active.id));

		// Their worst case, stated plainly. The fight rolls fair dice; the
		// PLAN behind the next click has to assume the crit lands.
		var threat = reply.threat;
		var $threat = $('#runbun-run-battle-threat');
		if (!threat || !threat.move) {
			$threat.text('').removeAttr('data-risk');
		} else {
			// The RACE first when it is lost, because "survives one crit, not
			// two" is true and reads as a caution. A nuzlocke wiped to a
			// Sonic Boom under exactly that sentence: the real position was
			// two turns to die against eight to kill, and nothing on screen
			// said so.
			var race = threat.race;
			var losing = race && (race.outcome === 'lose' || race.outcome === 'cannot-win');
			$threat.attr('data-risk', losing ? 'lethal' : threat.survivesCrit ?
				(threat.survivesTwoCrits ? 'safe' : 'thin') : 'lethal')
				.text('Their hardest hit: ' + threat.move + ' ' + threat.max + '%' +
					(threat.crit > threat.max ? ' — ' + threat.crit + '% on a crit' : '') +
					' · ' + (!threat.survivesCrit ? 'a crit KOs you' :
					!threat.survivesTwoCrits ? 'survives one crit, not two' :
						'survives a crit') +
					(!race ? '' : race.outcome === 'cannot-win' ?
						' · NOTHING HERE DAMAGES IT — you cannot win this race' :
						' · you need ' + race.turnsToKill + ' turn' +
							(race.turnsToKill === 1 ? '' : 's') + ' to KO, they need ' +
							race.turnsToDie + ' — ' +
							(race.outcome === 'lose' ? 'YOU LOSE THIS RACE' : 'you win it')));
		}

		var $log = $('#runbun-run-battle-log');
		(reply.events || []).forEach(function (event) {
			$log.append($('<li></li>').text(event.text));
		});
		$log.scrollTop($log.prop('scrollHeight'));

		var $moves = $('#runbun-run-battle-moves').empty();
		var $switches = $('#runbun-run-battle-switches').empty();
		$('#runbun-run-battle-prompt').text(
			reply.phase === 'replace' ? 'Choose the next Pokemon.' :
				reply.result ? '' : 'What will ' + viewState.player.active.species + ' do?');
		(reply.actions || []).forEach(function (entry) {
			if (entry.kind === 'ball') {
				// Each throwable ball wears its odds the way every move wears
				// its damage; the counted tiers also say how many are left.
				$moves.append($('<button type="button" class="btn runbun-run-battle-move runbun-run-battle-ball"></button>')
					.attr('data-ball', entry.ball)
					.append($('<span class="runbun-run-battle-move-name"></span>').text(entry.label))
					.append($('<span class="runbun-run-battle-move-dmg"></span>').text(
						entry.chance + '% catch' +
						(entry.left !== undefined ? ' · x' + entry.left : ''))));
			} else if (entry.kind === 'move') {
				$moves.append($('<button type="button" class="btn runbun-run-battle-move"></button>')
					.attr('data-move', entry.move)
					.attr('title', entry.damage ?
						entry.move + ' ' + entry.damage.min + '–' + entry.damage.max + '%' +
							(entry.damage.crit ? ' · ' + entry.damage.crit + '% on a crit' : '') +
							(entry.damage.floorKO ? ' · KOs even on its worst roll' : '') :
						entry.move)
					.append($('<span class="runbun-run-battle-move-name"></span>').text(entry.move))
					.append($('<span class="runbun-run-battle-move-dmg"></span>').text(
						!entry.damage || entry.damage.max === 0 ? '' :
							entry.damage.min + '%+' +
								(entry.damage.floorKO ? ' · KOs on any roll' :
									entry.damage.guaranteedKO ? ' · KO' :
										' up to ' + entry.damage.max + '%'))));
			} else {
				$switches.append($('<button type="button" class="btn runbun-run-battle-switch"></button>')
					.attr('data-replace', entry.action.replacementId)
					.text(entry.species + ' ' +
						Math.round(Math.max(0, entry.hp.current) / entry.hp.max * 100) + '%'));
			}
		});
	}

	function openBattle(path, body) {
		if (battle) {
			status('A fight is already live — finish or abandon it first.', 'error');
			return Promise.resolve(false);
		}
		if (!state) return Promise.resolve(false);
		status('Sending out…', '');
		return api(path, body).then(function (payload) {
			battle = {bundle: payload.battle, log: []};
			bumpCounter('battleStarted', payload.battle.trainer);
			$('#runbun-run-battle').removeAttr('data-result');
			$('#runbun-run-battle-result').text('');
			$('#runbun-run-battle-abandon').text('Leave fight without saving')
				.removeAttr('data-complete').prop('disabled', false);
			$('#runbun-run-battle-log').empty();
			$('#runbun-run-battle').prop('hidden', false);
			setBattleMode(true, true);
			paintBattle(payload);
			persistBattle(payload);
			status('', '');
			return true;
		}).catch(function (error) {
			status(error.message, 'error');
			return false;
		});
	}

	function startBattle() {
		openBattle('/run/battle/start', {run: state});
	}

	/** The rolled encounter, fought instead of clicked: the roll card yields
	 * to the battle, and the fight's ending settles the roll — a caught ball
	 * is the catch, a killed encounter is the spend. */
	function startWildBattle() {
		if (!rolled) return;
		openBattle('/run/battle/wild', {run: state, roll: {
			map: rolled.mapName,
			method: rolled.method,
			species: rolled.species,
			level: rolled.level,
			ivs: rolled.ivs,
			// The roll is the encounter's whole identity: the nature and
			// ability that fight the battle must be the ones the box keeps.
			nature: rolled.nature,
			ability: rolled.ability,
		}}).then(function (opened) {
			if (opened) $('#runbun-run-roll-result').prop('hidden', true);
		});
	}

	function setBattleBusy(active) {
		var $panel = $('#runbun-run-battle');
		$panel.toggleClass('rb-busy', !!active);
		if (active) $panel.attr('aria-busy', 'true');
		else $panel.removeAttr('aria-busy');
		$panel.find('.runbun-run-battle-move, .runbun-run-battle-switch')
			.prop('disabled', !!active);
	}

	function battleAct(chosen) {
		if (!battle || battleBusy) return;
		battleBusy = true;
		setBattleBusy(true);
		$('#runbun-run-battle-result').removeAttr('data-kind').text('');
		// The bundle this turn was sent from: if the fight is abandoned (or a
		// stale one invalidated) while the turn is in flight, the reply
		// belongs to a battle that no longer exists. Dropping it is correct —
		// nothing was written — and it beats the raw TypeError the player saw
		// when the handler dereferenced a cleared battle.
		var actedOn = battle.bundle;
		api('/run/battle/act', {battle: actedOn, action: chosen}).then(function (reply) {
			battleBusy = false;
			setBattleBusy(false);
			if (!battle || battle.bundle !== actedOn) return;
			battle.bundle = reply.battle;
			paintBattle(reply);
			if (reply.result) {
				finishBattle(reply);
			} else {
				persistBattle(reply);
			}
		}).catch(function (error) {
			battleBusy = false;
			setBattleBusy(false);
			if (!battle || battle.bundle !== actedOn) return;
			$('#runbun-run-battle-result').attr('data-kind', 'error')
				.text('That turn did not resolve — ' + error.message + ' Try again.');
			status(error.message, 'error');
		});
	}

	/**
	 * The fight is over; now it becomes run history — through the same
	 * commands a hand-kept run would use, one at a time, stopping at the
	 * first refusal. Deaths first (each with the epitaph the fight already
	 * knows), then the win. A loss records its dead and nothing else: the
	 * trainer still stands on the road ahead.
	 */
	function finishBattle(reply) {
		var completedBundle = battle.bundle;
		var trainer = completedBundle.trainer;
		var wild = completedBundle.wild || null;
		var won = reply.result === 'win';
		var deaths = reply.deaths || [];
		var completionCommandId = newCommandId();
		var canonicalTrainerOrder = null;
		if (!wild && window.RunBunPokemonProvider &&
			typeof window.RunBunPokemonProvider.resolveTrainerOrder === 'function') {
			try {
				canonicalTrainerOrder = window.RunBunPokemonProvider.resolveTrainerOrder(trainer);
			} catch (ignore) {}
		}
		var resultLabel = reply.result === 'win' ? 'Victory' :
			reply.result === 'catch' ? 'Caught' : 'Defeat';
		$('#runbun-run-battle').attr('data-result', reply.result);
		$('#runbun-run-battle-result').text(resultLabel + ' — recording this result…');
		$('#runbun-run-battle-abandon').attr('data-complete', 'true')
			.text('Recording…').prop('disabled', true);
		battle = null;
		clearBattleSave();
		var chain = Promise.resolve(true);
		function recordCompletion(ok) {
			if (!ok) return false;
			return persist('battle.ended', {
				kind: wild ? 'wild' : 'trainer',
				trainer: trainer,
				trainerOrder: canonicalTrainerOrder,
				progressionOrder: Number.isInteger(completedBundle.order) ? completedBundle.order : null,
				seed: completedBundle.seed,
				actions: (completedBundle.tape || []).slice(),
				engine: {
					app: appRevision,
					provider: window.RunBunPokemonProvider &&
						window.RunBunPokemonProvider.metadata &&
						window.RunBunPokemonProvider.metadata.engineRevision || null,
				},
				outcome: won ? 'won' :
					reply.result === 'catch' ? 'caught' : 'lost',
				turns: reply.viewState && Number.isInteger(reply.viewState.turn) ?
					reply.viewState.turn : completedBundle.state.turn,
				leadId: completedBundle.party && completedBundle.party[0] ?
					completedBundle.party[0].monId : null,
				participantIds: (completedBundle.contributions || [])
					.filter(function (row) { return row.appearances > 0; })
					.map(function (row) { return row.monId; }),
				contributionVersion: completedBundle.contributionVersion || null,
				contributionComplete: completedBundle.contributionComplete === true,
				contributions: (completedBundle.contributions || []).map(function (row) {
					return {monId: row.monId, battleId: row.battleId, species: row.species,
						appearances: row.appearances, switchIns: row.switchIns,
						moveAttempts: row.moveAttempts,
						opposingHpRemoved: row.opposingHpRemoved, kos: row.kos};
				}),
				deaths: deaths.map(function (death) {
					return {monId: death.monId, species: death.species,
						by: death.by || null, of: death.of || null};
				}),
			}, completionCommandId).then(function () { return true; });
		}
		deaths.forEach(function (death) {
			if (!death.monId) return;
			chain = chain.then(function (ok) {
				if (!ok) return false;
				// The grass is not a fight on the run map, so a wild death
				// carries its killer as free text instead of a trainer name.
				return command(wild ?
					{kind: 'faint', id: death.monId, move: death.by || undefined,
						of: 'wild ' + wild.species} :
					{kind: 'faint', id: death.monId, to: trainer,
						move: death.by || undefined});
			});
		});
		if (wild) {
			// Thrown tier balls are spent whatever the ending — the bag paid
			// for them the moment they flew. Plain Poke Balls are the free
			// baseline and are not counted.
			Object.keys(wild.thrown || {}).forEach(function (ball) {
				if (ball === 'Poke Ball' || !wild.thrown[ball]) return;
				chain = chain.then(function (ok) {
					return ok ? command({kind: 'use', item: ball,
						count: wild.thrown[ball]}) : false;
				});
			});
			// The fight's ending settles the roll: a caught ball is the catch,
			// a killed encounter is the spend — both the ordinary, verified
			// commands the buttons would have written.
			if (reply.result === 'catch') {
				chain = chain.then(function (ok) {
					return ok ? command({kind: 'catch', species: wild.species,
						level: wild.level, map: wild.map, method: wild.method,
						ivs: wild.ivs, nature: wild.nature,
						ability: wild.ability}) : false;
				});
			} else if (won) {
				chain = chain.then(function (ok) {
					return ok ? command({kind: 'spend', map: wild.map,
						reason: 'the encounter fainted'}) : false;
				});
			}
			chain.then(recordCompletion).then(function (ok) {
				if (!ok) {
					$('#runbun-run-battle-result').text(
						'The fight ended, but the run could not record every result. Review the status below.');
					$('#runbun-run-battle-abandon').text('Return to run').prop('disabled', false);
					return;
				}
				if (reply.result === 'catch' || won) {
					clearRollSave();
					$('#runbun-run-roll-result').prop('hidden', true);
					showEncounters();
				} else if (rolled) {
					// A wipe settles nothing: the encounter is still standing
					// in the grass, and the card comes back to prove it.
					$('#runbun-run-roll-result').prop('hidden', false);
				}
				status(reply.result === 'catch' ?
					'Gotcha! ' + wild.species + ' L' + wild.level + ' joined the box.' :
					won ?
						'The wild ' + wild.species + ' fainted — ' + wild.map +
							' is spent, nothing kept.' :
						'Wiped by the wild ' + wild.species + ' — the deaths are ' +
							'recorded; the encounter still stands.',
				reply.result === 'catch' ? 'ok' : 'error');
				$('#runbun-run-battle-result').text(
					(resultLabel === 'Defeat' ? 'Defeat recorded.' : resultLabel + ' recorded.'));
				$('#runbun-run-battle-abandon').text('Return to run').prop('disabled', false).focus();
			});
			return;
		}
		if (won) {
			chain = chain.then(function (ok) {
				return ok ? command({kind: 'beat', trainer: trainer}) : false;
			});
		}
		chain.then(recordCompletion).then(function (ok) {
			if (ok) {
				status(won ?
					'Won against ' + trainer + ' — recorded' +
						(deaths.length ? ', with ' + deaths.length + ' lost.' : ', deathless.') :
					'Wiped against ' + trainer + ' — the deaths are recorded; ' +
						'the fight can be retried.', won ? 'ok' : 'error');
				$('#runbun-run-battle-result').text(
					(won ? 'Victory recorded.' : 'Defeat recorded.'));
				$('#runbun-run-battle-abandon').text('Return to run').prop('disabled', false).focus();
			} else {
				$('#runbun-run-battle-result').text(
					'The fight ended, but the run could not record every result. Review the status below.');
				$('#runbun-run-battle-abandon').text('Return to run').prop('disabled', false).focus();
			}
		});
	}

	/**
	 * Ending a run is the one action that empties the screen, so it rides the
	 * kit's hold-to-confirm: pointer (or Space/Enter) down starts a linear
	 * fill over holdMs, releasing early springs it back, and the commit fires
	 * only when the fill completes. The final save is written into the
	 * transfer box FIRST — ending a run must never eat the player's only copy.
	 */
	function bindHold(selector, holdMs, onConfirm) {
		var timer = null;
		var $button = $(selector);
		$button.css('--rb-hold-ms', holdMs + 'ms');
		var reduced = window.matchMedia &&
			window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		var wait = reduced ? 200 : holdMs;
		function start(event) {
			if (timer !== null) return;
			if (event.type === 'keydown' &&
				(event.originalEvent && event.originalEvent.repeat)) return;
			$button.addClass('is-holding');
			timer = window.setTimeout(function () {
				timer = null;
				$button.removeClass('is-holding');
				onConfirm();
			}, wait);
		}
		function cancel() {
			if (timer === null) return;
			window.clearTimeout(timer);
			timer = null;
			$button.removeClass('is-holding');
		}
		$button.on('pointerdown', function (event) { event.preventDefault(); start(event); });
		$button.on('pointerup pointerleave pointercancel', cancel);
		$button.on('keydown', function (event) {
			if (event.key === ' ' || event.key === 'Enter') {
				event.preventDefault();
				start(event);
			}
		});
		$button.on('keyup', function (event) {
			if (event.key === ' ' || event.key === 'Enter') cancel();
		});
	}

	function endRun() {
		if (!state) {
			status('There is no run to end.', 'error');
			return;
		}
		var finalRun = state;
		var $outcome = $('#runbun-run-end-outcome');
		var outcome = $outcome.val();
		if (outcome === 'completed' && lastStatus && lastStatus.status.next) {
			$outcome.attr('aria-invalid', 'true').focus();
			status('This run still has required fights ahead and cannot be archived as completed.',
				'error');
			return;
		}
		$outcome.removeAttr('aria-invalid');
		status('Saving this run to history before clearing the active slot…', '');
		mutate(function () {
			var endedAt = new Date().toISOString();
			// The lifecycle event and checked portable copy are materialized before
			// the archive transaction, so history never points at unverifiable evidence.
			var portable = persist('run.ended', {outcome: outcome},
				'end-' + finalRun.attemptId + '-' + Date.now()).then(function () {
				return attemptStore ? attemptStore.exportActive() : finalRun;
			});
			return portable.then(function (archive) {
				$('#runbun-run-transfer').val(JSON.stringify(archive, null, '\t'))
					.closest('details').prop('open', true);
				return window.RunBunHistory.archive(finalRun, outcome, endedAt, archive);
			})
				.then(function () {
					try {
						mirror(null);
					} catch (error) { /* the IndexedDB archive is already durable */ }
					state = null;
					currentRevision = null;
					lastStatus = null;
					stagedParty = [];
					battle = null;
					clearBattleSave();
					clearRollSave();
					stamps = {};
					$('#runbun-run-battle').prop('hidden', true);
					setBattleMode(false, false);
					$('#runbun-run-roll-result').prop('hidden', true);
					showRun();
					revealSection('history');
					return renderHistory().then(function () {
						status('Run saved as ' + window.RunBunHistory.outcomeLabel(outcome) +
							'. A portable copy is ready in Import or export save.', 'ok');
					});
				});
		});
	}

	function abandonBattle() {
		var completed = $('#runbun-run-battle-abandon').attr('data-complete') === 'true';
		var wasWild = !!(battle && battle.bundle && battle.bundle.wild);
		if (!completed && battle && battle.bundle) {
			bumpCounter('battleAbandoned', battle.bundle.trainer);
		}
		battle = null;
		clearBattleSave();
		$('#runbun-run-battle').prop('hidden', true);
		setBattleMode(false, false);
		$('#runbun-run-battle-result').text('');
		$('#runbun-run-battle-abandon').text('Leave fight without saving')
			.removeAttr('data-complete').prop('disabled', false);
		// Fleeing a wild fight settles nothing: the roll card returns so the
		// encounter can still be caught on faith or given up properly.
		if (wasWild && rolled) $('#runbun-run-roll-result').prop('hidden', false);
		if (completed) {
			var next = document.querySelector('#runbun-run-play');
			if (next) next.focus();
			return;
		}
		status('Fight abandoned — nothing was written.', '');
	}

	/**
	 * A save that would not parse is still the player's only copy, and starting a
	 * run persists over it. It blocks only while its raw text is on screen exactly
	 * as it was read: repairing that text, or emptying the box, IS the decision.
	 */
	function damagedSaveUnhandled() {
		return corruptSave !== null && $('#runbun-run-transfer').val() === corruptSave;
	}

	function bind() {
		// The starter buttons are a radio in button's clothing: one pressed at
		// a time, pressing the pressed one clears the choice.
		$('.runbun-run-starter').on('click', function () {
			var was = $(this).attr('aria-pressed') === 'true';
			$('.runbun-run-starter').attr('aria-pressed', 'false');
			$(this).attr('aria-pressed', was ? 'false' : 'true');
			refreshStartAvailability();
		});

		$('#runbun-run-new').on('click', function () {
			if (!initialized) {
				status('Finishing durable storage and game data setup. Start the run when loading completes.',
					'error');
				return;
			}
			if (damagedSaveUnhandled()) {
				status('The damaged save from this browser is in the transfer box below ' +
					'and starting a run would write over it. Repair it and press Import, ' +
					'or clear that box to start fresh.', 'error');
				return;
			}
			var $starter = $('.runbun-run-starter[aria-pressed="true"]');
			// Every run leaves Birch's lab with a starter. A run without one is
			// an import, not a start — the transfer box below handles those.
			if (!$starter.length) {
				status('Pick a starter first — every run leaves the lab with one.', 'error');
				return;
			}
			var startCommandId = newCommandId();
			mutate(function () {
				return api('/run/new', {
					attemptId: newAttemptId(),
					name: $('#runbun-run-new-name').val() || 'My run',
					levelCap: $('#runbun-run-new-cap').is(':checked') ? 'next-milestone-ace' : 'none',
					// Each rule travels as its own toggle; the preset checkbox only
					// drives the controls, so what the form shows is what is sent.
					permadeath: $('#runbun-run-new-permadeath').is(':checked'),
					onePerRoute: $('#runbun-run-new-route').is(':checked'),
					shinyClause: $('#runbun-run-new-shiny-clause').is(':checked'),
					dupesClause: $('#runbun-run-new-dupes').val(),
					// The starter names the rival: they take the one yours beats, so
					// declaring it removes the other two variants of every rival
					// fight from the spine, the road ahead and the caps.
					rival: $starter.length ? $starter.attr('data-rival') : undefined,
					now: new Date().toISOString(),
				}).then(function (payload) {
					state = payload.run;
					// The pick lands in the box before anything renders: the gift is
					// part of starting, not a chore after. No map — a starter is a
					// scripted gift with no wild table, recorded as declared. A
					// refused gift must not unstart the run: the run stands, the
					// refusal is reported, the starter can be caught by hand.
					// The identity comes from the server's die; the catch
					// command below is what makes it a durable, replayable fact.
					return api('/run/identity', {
						species: $starter.attr('data-species'),
					}).then(function (authored) {
						return api('/run/apply', {run: state, command: {
							kind: 'catch',
							species: $starter.attr('data-species'),
							level: 5,
							ivs: authored.identity.ivs,
							nature: authored.identity.nature,
							ability: authored.identity.ability,
						}});
					}).then(function (gifted) {
						state = gifted.run;
						return ' — ' + $starter.attr('data-species') + ' L5 is in the box.';
					}, function (error) {
						return ' — but the starter was refused: ' + error.message;
					});
				}).then(function (note) {
					corruptSave = null;
					return persist('run.started', {run: state}, startCommandId).then(function () {
						status('Started ' + state.name + note,
							note.indexOf('refused') === -1 ? 'ok' : 'error');
						revealSection('box');
						return render();
					});
				}).catch(function (error) {
					if (error && error.code === 'REVISION_CONFLICT') return recoverConflict(error);
					status(error.message, 'error');
				});
			});
		});

		// The preset checkbox is a hand on the four controls, not a fifth rule:
		// it sets the common nuzlocke table, and any control can be adjusted
		// after. Unchecking clears them all.
		$('#runbun-run-new-nuzlocke').on('change', function () {
			var on = this.checked;
			$('#runbun-run-new-permadeath').prop('checked', on);
			$('#runbun-run-new-route').prop('checked', on);
			$('#runbun-run-new-shiny-clause').prop('checked', on);
			$('#runbun-run-new-dupes').val(on ? 'line' : 'off');
		});

		$('#runbun-run-map').on('change', showEncounters);
		// One handler for every "Picked up" button — the items-here list and
		// the split sheet's grab-list both record through the same acquire.
		$('#runbun-run').on('click', '.runbun-run-pickup-take', function () {
			var item = $(this).attr('data-item');
			command({kind: 'acquire', item: item}).then(function (accepted) {
				if (accepted) showEncounters();
			});
		});
		$('#runbun-run-box-filter').on('input', function () {
			if (lastStatus) renderBox(lastStatus);
		});

		// Clicking an encounter fills the catch form rather than catching outright:
		// level and nickname are the player's to set, and a one-click catch would
		// make a misclick a box entry.
		$('#runbun-run-encounters').on('click', '.runbun-run-encounter', function () {
			// Prefilling writes into the scripted-catch form, so the
			// disclosure that hides it must open before the values land.
			$('#runbun-run-manual-add').prop('open', true);
			$('#runbun-run-catch-species').val($(this).attr('data-species'));
			$('#runbun-run-catch-level').val($(this).attr('data-level'));
		});

		$('#runbun-run-catch').on('click', function () {
			// Moves are optional: the engine defaults to what the species knows at
			// this level, and refuses with its teachable list when the game gives it
			// none — Run & Bun strips some level-up learnsets entirely (Skarmory,
			// Wurmple), so this field is the only way to catch those at all.
			var moves = String($('#runbun-run-catch-moves').val() || '')
				.split(',')
				.map(function (move) { return move.trim(); })
				.filter(Boolean);
			// The server's die authors the identity; the catch command makes
			// it a durable, replayable fact. This form never rolls its own.
			api('/run/identity', {species: $('#runbun-run-catch-species').val()})
				.then(function (authored) {
					return command({
						kind: 'catch',
						species: $('#runbun-run-catch-species').val(),
						level: Number($('#runbun-run-catch-level').val()),
						map: $('#runbun-run-map').val() || undefined,
						nickname: $('#runbun-run-catch-name').val() || undefined,
						// The shiny clause: keepable over the route rule and the dupes
						// clause, and recorded on the mon. One-shot like the epitaph —
						// left checked it would silently exempt the NEXT catch too.
						shiny: $('#runbun-run-catch-shiny').is(':checked') || undefined,
						moves: moves.length ? moves : undefined,
						ivs: authored.identity.ivs,
						nature: authored.identity.nature,
						ability: authored.identity.ability,
					});
				}).then(function (accepted) {
					if (accepted) $('#runbun-run-catch-shiny').prop('checked', false);
				}, function (error) {
					status(error.message, 'error');
				});
		});

		// Party assembly: click order is lead order. Staged locally, committed as
		// one `party` command so the log records the decision, not every click.
		$('#runbun-run-box').on('click', '.runbun-run-add', function (event) {
			event.stopPropagation();
			var id = $(this).attr('data-id');
			var at = stagedParty.indexOf(id);
			if (at !== -1) {
				stagedParty.splice(at, 1);
			} else if (stagedParty.length >= PARTY_LIMIT) {
				status('A party holds six. Remove one first.', 'error');
				return;
			} else {
				stagedParty.push(id);
			}
			renderBox(lastStatus);
			renderPartyStrip();
		});
		$('#runbun-run-party-strip').on('click', '.runbun-run-party-rm', function () {
			var id = $(this).attr('data-id');
			stagedParty.splice(stagedParty.indexOf(id), 1);
			renderBox(lastStatus);
			renderPartyStrip();
		});
		$('#runbun-run-party-strip').on('click', '.runbun-run-party-up', function () {
			var id = $(this).attr('data-id');
			var at = stagedParty.indexOf(id);
			if (at > 0) {
				stagedParty.splice(at, 1);
				stagedParty.splice(at - 1, 0, id);
				renderPartyStrip();
			}
		});
		$('#runbun-run-set-party').on('click', function () {
			command({kind: 'party', ids: stagedParty.slice()});
		});

		function selectMon(id, reveal) {
			$('#runbun-run-selected').val(id);
			$('#runbun-run-box .runbun-run-mon, #runbun-run-losses .runbun-run-mon')
				.removeClass('is-selected');
			$('#runbun-run-box .runbun-run-mon[data-id="' + id + '"], ' +
				'#runbun-run-losses .runbun-run-mon[data-id="' + id + '"]').addClass('is-selected');
			var mon = findBoxed(id);
			renderSelectedMon();
			writeSummary('tools', mon ? monLabel(mon) : 'select a Pokémon');
			if (!reveal) return;
			revealSection('tools');
			var selected = document.querySelector('#runbun-run-mon-summary');
			if (selected) {
				selected.scrollIntoView({block: 'center'});
				selected.focus();
			}
		}

		$('#runbun-run').on('click', '.runbun-run-mon-select', function () {
			selectMon($(this).attr('data-id'), true);
		});
		$('#runbun-run-party-strip').on('click', '.runbun-run-party-select', function () {
			selectMon($(this).attr('data-id'), true);
		});

		$('#runbun-run-record-details').on('click', function () {
			var ivs = {};
			var invalid = null;
			Object.keys(IV_LABELS).forEach(function (stat) {
				var $input = $('#runbun-run-observed-iv-' + stat);
				var raw = String($input.val() || '').trim();
				if (!raw) return;
				var value = Number(raw);
				if (!Number.isInteger(value) || value < 0 || value > 31) {
					invalid = invalid || $input[0];
					$input.attr('aria-invalid', 'true');
					return;
				}
				$input.removeAttr('aria-invalid');
				ivs[stat] = value;
			});
			if (invalid) {
				status('Each IV must be a whole number from 0 to 31.', 'error');
				invalid.focus();
				return;
			}
			command({
				kind: 'identify',
				id: $('#runbun-run-selected').val(),
				nature: $('#runbun-run-observed-nature').val() || undefined,
				ability: $('#runbun-run-observed-ability').val() || undefined,
				ivs: Object.keys(ivs).length ? ivs : undefined,
			});
		});

		$('#runbun-run-evolve').on('click', function () {
			command({kind: 'evolve', id: $('#runbun-run-selected').val()});
		});
		$('#runbun-run-level-cap').on('click', function () {
			command({kind: 'levelUp', id: $('#runbun-run-selected').val(), to: 'cap'});
		});
		$('#runbun-run-level').on('click', function () {
			command({kind: 'levelUp', id: $('#runbun-run-selected').val(),
				to: Number($('#runbun-run-level-to').val())});
		});
		$('#runbun-run-teach').on('click', function () {
			command({kind: 'teach', id: $('#runbun-run-selected').val(),
				move: $('#runbun-run-move').val(),
				replace: $('#runbun-run-replace').val() || undefined});
		});
		$('#runbun-run-faint').on('click', function () {
			// The epitaph travels with the loss: who did it (checked against the
			// run map server-side) and with what (free text). Both optional — a
			// loss can be recorded first and mourned later. The fields are
			// ONE-SHOT: cleared the moment a faint consumes them, because stale
			// text silently became the next loss's cause of death — a fabricated
			// entry in the one ledger whose point is the record. A refusal keeps
			// the text so a misspelled trainer can be fixed and resubmitted.
			var id = $('#runbun-run-selected').val();
			command({
				kind: 'faint',
				id: id,
				to: $('#runbun-run-died-to').val() || undefined,
				move: $('#runbun-run-died-move').val() || undefined,
			}).then(function (accepted) {
				if (accepted) {
					$('#runbun-run-died-to').val('');
					$('#runbun-run-died-move').val('');
					// A hand-recorded faint is the misclick-prone one, so it
					// alone gets the takeback window (a battle's deaths are a
					// deliberate multi-command ending — no single undo fits).
					var fallen = null;
					(state && state.box || []).forEach(function (mon) {
						if (mon.id === id) fallen = mon;
					});
					// Permadeath off makes faint a no-op on the mon; a takeback
					// window on nothing would be theater.
					if (fallen && fallen.status === 'dead') {
						offerUndo(fallen.species + ' is gone.');
					}
				}
			});
		});
		$('#runbun-run-acquire').on('click', function () {
			// One-shot like the catch fields: an item name left in the box is one
			// stray click away from a bag that says the run found it twice.
			command({
				kind: 'acquire',
				item: $('#runbun-run-acquire-item').val(),
				count: Number($('#runbun-run-acquire-count').val()) || 1,
			}).then(function (accepted) {
				if (accepted) {
					$('#runbun-run-acquire-item').val('');
					$('#runbun-run-acquire-count').val(1);
				}
			});
		});
		$('#runbun-run-heartscale').on('click', function () {
			// No client-side guard on the bag or the current IV: the server's
			// refusal names which of the two stopped it, and that sentence is
			// more use than a greyed-out button.
			command({kind: 'heartScale', id: $('#runbun-run-selected').val(),
				stat: $('#runbun-run-iv-stat').val()});
		});
		$('#runbun-run-release').on('click', function () {
			command({kind: 'release', id: $('#runbun-run-selected').val()});
		});
		function openMatrixPairing(cell) {
			var mon = findBoxed(cell.attr('data-mon-id'));
			var trainer = cell.closest('#runbun-run-matrix').attr('data-trainer');
			if (!mon || !trainer) return;
			openInCalculator(mon, cell.attr('data-enemy') + ' (' + trainer + ')');
		}
		$('#runbun-run-matrix').on('click', 'td[data-mon-id]', function () {
			openMatrixPairing($(this));
		});
		$('#runbun-run-matrix').on('keydown', 'td[data-mon-id]', function (event) {
			if (event.key !== 'Enter' && event.key !== ' ') return;
			event.preventDefault();
			openMatrixPairing($(this));
		});
		$('#runbun-run-open-calc').on('click', function () {
			var mon = findBoxed($('#runbun-run-selected').val());
			if (!mon) return;
			openInCalculator(mon);
		});
		$('#runbun-run-give').on('click', function () {
			var id = $('#runbun-run-selected').val();
			var item = $('#runbun-run-hold-item').val();
			if (!id || !item) return;
			command({kind: 'give', id: id, item: item});
		});
		$('#runbun-run-take').on('click', function () {
			var id = $('#runbun-run-selected').val();
			if (!id) return;
			command({kind: 'take', id: id});
		});
		$('#runbun-run-learnable').on('click', function () {
			api('/run/learnable', {run: state, id: $('#runbun-run-selected').val()})
				.then(function (payload) {
					// A starred move is an egg move: the relearner charges one
					// Heart Scale for it, and the teach command will too.
					var now = payload.now.map(function (entry) {
						return entry.scale ? entry.move + '*' : entry.move;
					});
					var later = payload.later.map(function (entry) {
						return entry.move + ' @' + entry.level;
					});
					$('#runbun-run-learn').prop('hidden', false);
					$('#runbun-run-learn-now').text(now.join(', ') || '(nothing)');
					$('#runbun-run-learn-later').text(later.join(', ') || '(nothing left)');
				}).catch(function (error) {
					status(error.message, 'error');
				});
		});

		$('#runbun-run-upcoming').on('click', '.runbun-run-up-plan', function () {
			plan($(this).attr('data-trainer'));
		});
		$('#runbun-run-upcoming').on('click', '.runbun-run-up-board', function () {
			board($(this).attr('data-trainer'));
		});
		// The worst-case cell asks for a matchup; pressing it must produce one.
		$(document).on('click', '#runbun-run-ready-risk-check', function () {
			var next = lastStatus && lastStatus.upcoming && lastStatus.upcoming[0];
			board(next ? next.trainer : undefined);
		});
		// The gauntlet rows plan and board like the road ahead. No Beaten button
		// there on purpose: marking a distant boss beaten silently skips every
		// fight before it, which is a road-ahead decision, made in that context.
		$('#runbun-run-split-gauntlet').on('click', '.runbun-run-up-plan', function () {
			plan($(this).attr('data-trainer'));
		});
		$('#runbun-run-split-gauntlet').on('click', '.runbun-run-up-board', function () {
			board($(this).attr('data-trainer'));
		});
		$('#runbun-run-upcoming').on('click', '.runbun-run-up-beat', function () {
			command({kind: 'beat', trainer: $(this).attr('data-trainer')});
		});
		$('#runbun-run-plan').on('click', function () { plan(null); });
		$('#runbun-run-value').on('click', function () { testRosterValue(null); });
		$('#runbun-run-explore').on('click', function () {
			revealSection('catch');
			var target = document.querySelector('#runbun-run-reachable .runbun-run-route-choice') ||
				document.querySelector('#runbun-run-map');
			if (target) {
				target.scrollIntoView({block: 'center'});
				target.focus();
			}
		});
		$('#runbun-run-reachable').on('click', '.runbun-run-route-choice', function () {
			var map = $(this).attr('data-map');
			if (!map || !$('#runbun-run-map option[value="' + map + '"]').length) return;
			$('#runbun-run-map').val(map);
			showEncounters().then(function () {
				var roll = document.querySelector('#runbun-run-roll');
				if (roll) roll.focus();
			});
		});
		$('#runbun-run-review, #runbun-run-empty-review').on('click', function () {
			openHistory().catch(function () { /* renderHistory writes the error state */ });
		});
		$('#runbun-run-opportunity-list').on('click', '.runbun-run-opportunity-action', function () {
			var kind = $(this).attr('data-kind');
			if (kind === 'encounters') {
				revealSection('catch');
				var encounter = document.querySelector(
					'#runbun-run-reachable .runbun-run-route-choice');
				if (encounter) {
					encounter.scrollIntoView({block: 'center'});
					encounter.focus();
				}
				return;
			}
			if (kind === 'items') {
				var map = $(this).attr('data-map');
				if (!map) {
					revealSection('split');
					var split = document.querySelector(
						'.rb-disclose[data-section="split"] .rb-disclose-btn');
					if (split) {
						split.scrollIntoView({block: 'center'});
						split.focus();
					}
					return;
				}
				revealSection('catch');
				if (map && $('#runbun-run-map option[value="' + map + '"]').length) {
					$('#runbun-run-map').val(map);
				}
				showEncounters().then(function () {
					var target = document.querySelector('#runbun-run-map');
					if (target) {
						target.scrollIntoView({block: 'center'});
						target.focus();
					}
				});
			}
		});
		// The recreation: roll the dice, play the fight.
		$('#runbun-run-roll').on('click', rollEncounter);
		$('#runbun-run-roll-fight').on('click', startWildBattle);
		$('#runbun-run-snackbar-undo').on('click', function () {
			// Honored only while the faint is still the last command: /run/undo
			// takes back whatever came last, and that must never silently be
			// something else.
			if (snackbar.stamp === null || snackbar.stamp !== logLength()) {
				dismissSnackbar();
				return;
			}
			$('#runbun-run-undo').trigger('click');
		});
		$('#runbun-run-roll-catch').on('click', function () { settleRoll(true); });
		$('#runbun-run-roll-flee').on('click', function () { settleRoll(false); });
		$('#runbun-run-play').on('click', function () {
			// Nothing alive: the only honest next action is ending the run.
			if (state && lastStatus && !(lastStatus.box || []).some(function (mon) {
				return mon.status !== 'dead';
			})) {
				revealSection('history');
				var transfer = document.querySelector('.runbun-run-transfer');
				if (transfer) {
					transfer.open = true;
					transfer.scrollIntoView({block: 'center'});
				}
				var outcome = document.querySelector('#runbun-run-end-outcome');
				if (outcome) outcome.value = 'wipe';
				status('Every Pokémon is gone. Press and hold End run to save this ' +
					'attempt to your history.', 'error');
				return;
			}
			if (!state || state.party.length) {
				startBattle();
				return;
			}
			revealSection('box');
			var first = document.querySelector(
				'#runbun-run-box .runbun-run-mon:not(.is-lost) .runbun-run-add');
			if (first) {
				first.scrollIntoView({block: 'center'});
				first.focus();
			}
			// The reserve itself flashes so the eye lands on the place to act;
			// the toast only names the one rule the list cannot show (lead
			// first). CSS renders the cue (static under reduced motion), and
			// the timed removal bounds it for both.
			var $reserve = $('#runbun-run-box');
			$reserve.removeClass('rb-attn');
			// Force a reflow so a second click restarts the animation.
			if ($reserve.length) $reserve[0].getBoundingClientRect();
			$reserve.addClass('rb-attn');
			window.setTimeout(function () { $reserve.removeClass('rb-attn'); }, 1800);
			status('Pick your team from the PC reserve — lead first.', '');
		});
		$('#runbun-run-battle-abandon').on('click', abandonBattle);
		bindHold('#runbun-run-end', 1000, endRun);
		$('#runbun-run-battle-moves').on('click', '.runbun-run-battle-move', function () {
			battleAct($(this).hasClass('runbun-run-battle-ball') ?
				{kind: 'ball', ball: $(this).attr('data-ball')} :
				{kind: 'move', move: $(this).attr('data-move')});
		});
		$('#runbun-run-battle-switches').on('click', '.runbun-run-battle-switch', function () {
			battleAct({kind: 'switch', replacementId: $(this).attr('data-replace')});
		});
		// Next fight only, unlike Plan and Board which sit on every row ahead:
		// this call prices hundreds of candidate builds through the policy, and
		// a button on 362 rows would invite it once per row.
		$('#runbun-run-advise').on('click', function () { advise(null); });
		$('#runbun-run-rank').on('click', function () { rank(); });
		$('#runbun-run-split-play').on('click', playBoss);
		$('#runbun-run-routes-btn').on('click', function () { routesView(); });
		$('#runbun-run-scout-btn').on('click', function () { scout(); });

		$('#runbun-run-undo').on('click', function () {
			var undoCommandId = newCommandId();
			mutate(function () {
				dismissSnackbar();
				return api('/run/undo', {run: state}).then(function (payload) {
					state = payload.run;
					return persist('run.replaced', {reason: 'undo', run: state},
						undoCommandId).then(function () {
						// An export made before the undo still contains the undone command.
						// Left sitting in the box it is one Import away from reinstating
						// exactly what the player just took back, so it goes.
						var hadExport = !!$('#runbun-run-transfer').val();
						if (hadExport) $('#runbun-run-transfer').val('');
						status('Undone.' + (hadExport ?
							' Cleared the transfer box — it held the undone command.' : ''), 'ok');
						return render();
					});
				}).catch(function (error) {
					if (error && error.code === 'REVISION_CONFLICT') return recoverConflict(error);
					status(error.message, 'error');
				});
			});
		});
		$('#runbun-run-export').on('click', function () {
			// Reachable with no run, since import has to be: "null" in the box would
			// only be something to paste back later and be refused.
			if (!state) {
				status('There is no run to export yet.', 'error');
				return;
			}
			var exporting = attemptStore ? attemptStore.exportActive() : Promise.resolve(state);
			exporting.then(function (portable) {
				$('#runbun-run-transfer').val(JSON.stringify(portable, null, '\t'));
				status(attemptStore ?
					'Exported a checked attempt archive. Copy it to keep or move the run.' :
					'Exported the compatibility save. Copy it to keep or move the run.', 'ok');
			}).catch(function (error) {
				status('Could not export: ' + error.message, 'error');
			});
		});
		$('#runbun-run-import').on('click', function () {
			var incoming;
			try {
				incoming = JSON.parse($('#runbun-run-transfer').val());
			} catch (error) {
				status('Could not import: ' + error.message, 'error');
				return;
			}
			if (!incoming || typeof incoming !== 'object') {
				status('Could not import: that is not a run', 'error');
				return;
			}
			var isBundle = incoming.format === 'rabrun.archive';
			var importedRun = isBundle ? incoming.run : incoming;
			if (!importedRun || typeof importedRun !== 'object') {
				status('Could not import: that archive has no run', 'error');
				return;
			}
			if (!importedRun.attemptId) {
				importedRun = JSON.parse(JSON.stringify(importedRun));
				importedRun.attemptId = newAttemptId();
			}
			var previousState = state;
			var previousRevision = currentRevision;
			mutate(function () {
				// The server is the only thing that can tell a run from a shape that
				// merely looks like one, so it is asked BEFORE anything is adopted.
				// Checking a field here and persisting on faith wrote junk over a real
				// save permanently — the panel writes only what the server accepted,
				// and an import is no different from a command in that.
				var checked = isBundle && window.RunBunAttemptStore ?
					window.RunBunAttemptStore.validateBundle(incoming) : Promise.resolve(incoming);
				return checked.then(function () {
					return api('/run/status', {run: importedRun, upcomingCount: 8});
				}).then(function (payload) {
					var oldAttemptId = previousState && previousState.attemptId;
					if (isBundle && attemptStore) {
						return attemptStore.importBundle(incoming).then(function (head) {
							state = importedRun;
							corruptSave = null;
							currentRevision = head.revision;
							mirror(state);
							return payload;
						});
					}
					state = importedRun;
					corruptSave = null;
					if (oldAttemptId !== state.attemptId) currentRevision = null;
					return persist('run.imported', {run: state}).then(function () { return payload; });
				}).then(function (payload) {
					showRun();
					paint(payload);
					status(isBundle ? 'Imported checked attempt archive.' : 'Imported run.', 'ok');
				}).catch(function (error) {
					if (error && error.code === 'REVISION_CONFLICT') return recoverConflict(error);
					state = previousState;
					currentRevision = previousRevision;
					// `state` and the save are untouched: the run on screen is still the
					// one that was there before the paste.
					status('Could not import: ' + error.message, 'error');
				});
			});
		});
	}

	/**
	 * Two tabs, one run. IndexedDB owns the revision and localStorage supplies a
	 * cross-tab bell: its `storage` event fires in every OTHER tab after a commit.
	 * The listener reloads the durable head instead of trusting the event body.
	 *
	 * Adopted without a server round-trip on purpose: the durable head contains
	 * only runs the server accepted.
	 * A write mid-flight is NOT adopted — the in-flight reply would clobber it
	 * anyway; the next repaint reconciles through the same event having fired
	 * on the other side.
	 */
	function adoptOtherTab(incoming, revision) {
		if (busy || JSON.stringify(incoming) === JSON.stringify(state)) return;
		state = incoming;
		currentRevision = revision;
		// A fight here was opened from a run that no longer exists: playing it
		// out would write history onto the wrong document. It folds, unwritten.
		if (battle) {
			battle = null;
			clearBattleSave();
			$('#runbun-run-battle').prop('hidden', true);
			setBattleMode(false, false);
		}
		// The pending roll survives the sync unless the other tab answered
		// its question (settled that route); then the card goes with it.
		if (rolled && !rollStillPending({logLength: rolledLog, roll: rolled})) {
			clearRollSave();
			$('#runbun-run-roll-result').prop('hidden', true);
		}
		showRun();
		if (!state) return;
		render().then(function () {
			status('Synced — the run moved in another tab.', 'ok');
		});
	}

	function syncFromOtherTab(event) {
		if (event.key !== STORAGE_KEY || busy) return;
		if (attemptStore) {
			attemptStore.loadActive().then(function (head) {
				adoptOtherTab(head ? head.run : null, head ? head.revision : null);
			}).catch(function () {
				// The localStorage mirror is still a complete accepted run and remains
				// the fallback if IndexedDB becomes unavailable between tab writes.
				attemptStore = null;
				syncFromOtherTab(event);
			});
			return;
		}
		var incoming = null;
		if (event.newValue) {
			try {
				incoming = JSON.parse(event.newValue);
			} catch (error) {
				return; // a corrupt write is the other tab's problem to surface
			}
		}
		adoptOtherTab(incoming, null);
	}

	$(function () {
		if (!$('#runbun-run').length) return;
		bindDisclosures();
		bind();
		window.addEventListener('storage', syncFromOtherTab);
		learnAppRevision();
		if (window.navigator && navigator.storage && navigator.storage.persist) {
			navigator.storage.persist().then(function (granted) {
				window.__runbunStoragePersisted = granted;
			}).catch(function (ignore) { /* denial is legal; eviction risk stands */ });
		}
		// The bag and scripted-catch fields offer the game's own vocabulary:
		// every Gen 8 item and species, one-time menus. Free text still
		// passes through; the commands stay the validators.
		try {
			var gen = window.calc.Generations.get(8);
			var $items = $('#runbun-run-item-options');
			for (var item of gen.items) $items.append($('<option></option>').attr('value', item.name));
			var $species = $('#runbun-run-species-options');
			for (var species of gen.species) $species.append($('<option></option>').attr('value', species.name));
		} catch (ignore) { /* menus are optional; commands validate */ }
		restoreDurable().then(loadMaps).then(render).then(function () {
			initialized = true;
			refreshStartAvailability();
			if (corruptSave) {
				$('#runbun-run-transfer').val(corruptSave)
					.closest('details').prop('open', true);
				status(parkedSaveNote ||
					'The run saved in this browser is damaged and could not be read. ' +
					'Its raw text is in the transfer box below — repair it and press ' +
					'Import to get the run back, or clear the box to start over.', 'error');
				return;
			}
			if (state) {
				status('Loaded ' + state.name + ' from ' + restoredFrom + '.', 'ok');
				// The roll first, then the battle: a live wild fight re-hides
				// the card it owns, and abandoning hands it back.
				restoreRoll();
				restoreBattle();
			}
		}).catch(function (error) {
			// Without this the panel keeps the state it SHIPS in: index.template
			// leaves New Run disabled under "Loading the run panel…" and only
			// this chain enables it, so one ordinary fetch rejection — offline, a
			// reset connection, a tab waking on a dead radio — pinned the whole
			// panel there with no message and no way back short of a reload.
			//
			// Finishing initialisation is the point. A run with no route list is
			// a smaller thing than a dead page: the starter, gift, static and
			// trade paths need no route, and the player can retry by reloading
			// once they know that is what to do.
			initialized = true;
			refreshStartAvailability();
			status('The run panel started without its route list — ' +
				(error && error.message ? error.message : 'the request failed') +
				'. Runs that need a route cannot be started until you reload.', 'error');
		});
	});
})();
