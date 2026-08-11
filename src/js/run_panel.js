/* eslint-env browser, jquery */
/**
 * Run panel — a playthrough in the page.
 *
 * The Fight Planner asks a question about one moment. This asks the question a
 * player actually lives with: here is my box, here is where I am, what happens
 * next. It is the same document `play.js` keeps in a file, kept in
 * `localStorage` instead.
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
 * the server accepted, never write a run the server refused.
 */
(function () {
	'use strict';

	var STORAGE_KEY = 'runbun.run.v1';
	var PARTY_LIMIT = 6;

	var state = null;
	var maps = [];
	/** The last /run/status payload, so filtering and staging re-render locally. */
	var lastStatus = null;
	/** Party being assembled, in lead order. Committed only by "Set party". */
	var stagedParty = [];
	/** True while a run-changing call is in flight. See `mutate`. */
	var busy = false;
	/** Raw text of a save that would not parse, held until the player deals with it. */
	var corruptSave = null;

	function status(message, kind) {
		$('#runbun-run-status').text(message || '').attr('data-kind', kind || '');
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
	function persist() {
		try {
			window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
		} catch (error) {
			status('Could not save to this browser: ' + error.message, 'error');
		}
	}

	function restore() {
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
			return;
		}
		busy = true;
		function release() { busy = false; }
		// Released on both paths: one failure must never wedge the panel shut.
		return work().then(release, function (error) {
			release();
			status(error.message, 'error');
		});
	}

	function monLabel(mon) {
		return (mon.nickname ? mon.nickname + ' the ' + mon.species : mon.species) + ' L' + mon.level;
	}

	function findBoxed(id) {
		if (!lastStatus) return null;
		return lastStatus.box.filter(function (mon) { return mon.id === id; })[0] || null;
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
			$spine.append($('<li></li>')
				.attr('title', '#' + milestone.order + '  ' + milestone.trainer)
				.toggleClass('is-beaten', milestone.beaten)
				.toggleClass('is-boss', milestone.tier === 'boss')
				.toggleClass('is-next', !milestone.beaten && milestone === next));
		});
		var done = spine.filter(function (m) { return m.beaten; }).length;
		$('#runbun-run-spine-note').text(spine.length ?
			done + ' / ' + spine.length + ' milestones' +
				(next ? ' · next: ' + next.trainer + ' (#' + next.order + ')' : ' — all beaten') :
			'');
	}

	// -------------------------------------------------------------- box + party

	/**
	 * The box, at any size: filterable, party pinned on top in lead order, the
	 * lost below a divider — present but out of the way, because a nuzlocke's
	 * graveyard is part of the record and not part of the working set.
	 */
	function renderBox(payload) {
		var filter = String($('#runbun-run-box-filter').val() || '').toLowerCase();
		var cap = payload.status.levelCap && payload.status.levelCap.cap;
		var $box = $('#runbun-run-box').empty();

		var alive = payload.box.filter(function (mon) { return mon.status !== 'dead'; });
		var lost = payload.box.filter(function (mon) { return mon.status === 'dead'; });
		$('#runbun-run-box-counts').text(alive.length + ' alive' +
			(lost.length ? ' · ' + lost.length + ' lost' : ''));

		var party = state.party;
		var ordered = party
			.map(findBoxed)
			.filter(Boolean)
			.concat(alive.filter(function (mon) { return party.indexOf(mon.id) === -1; }));

		function matches(mon) {
			if (!filter) return true;
			return (mon.species + ' ' + (mon.nickname || '')).toLowerCase().indexOf(filter) !== -1;
		}

		function row(mon) {
			var slot = party.indexOf(mon.id);
			var staged = stagedParty.indexOf(mon.id) !== -1;
			var $row = $('<li class="runbun-run-mon"></li>')
				.attr('data-id', mon.id)
				.toggleClass('is-party', slot !== -1)
				.toggleClass('is-lost', mon.status === 'dead');
			$row.append($('<span class="runbun-run-mon-slot"></span>')
				.text(mon.status === 'dead' ? '†' : slot === -1 ? '' : String(slot + 1)));
			var $name = $('<span class="runbun-run-mon-name"></span>').text(monLabel(mon));
			if (cap && mon.level >= cap) {
				$name.append($('<span class="runbun-run-at-cap"></span>').text('at cap'));
			}
			$row.append($name);
			if (mon.status !== 'dead') {
				$row.append($('<button type="button" class="runbun-run-add"></button>')
					.attr('data-id', mon.id)
					.attr('title', staged ? 'Remove from party' : 'Add to party')
					.toggleClass('is-staged', staged)
					.text(staged ? '−' : '+'));
			}
			$row.append($('<span class="runbun-run-mon-kit"></span>')
				.text([mon.item, mon.origin && mon.origin.mapName ?
					mon.origin.method + ' · ' + mon.origin.mapName : 'declared']
					.filter(Boolean).join(' · ')));
			$row.append($('<span class="runbun-run-mon-moves"></span>').text(mon.moves.join(', ')));
			return $row;
		}

		ordered.filter(matches).forEach(function (mon) { $box.append(row(mon)); });
		var lostShown = lost.filter(matches);
		if (lostShown.length) {
			$box.append($('<li class="runbun-run-box-divider" aria-hidden="true"></li>').text('lost'));
			lostShown.forEach(function (mon) { $box.append(row(mon)); });
		}
	}

	/**
	 * Six slots, lead first. Order is built by the order of adding and adjusted
	 * with the up arrows — click order IS lead order, which is the entire reason
	 * this is not a multi-select.
	 */
	function renderPartyStrip() {
		var $strip = $('#runbun-run-party-strip').empty();
		for (var i = 0; i < PARTY_LIMIT; i++) {
			var id = stagedParty[i];
			if (!id) {
				$strip.append($('<li class="runbun-run-party-slot is-empty"></li>')
					.text(i === 0 ? 'lead — empty' : '—'));
				continue;
			}
			var mon = findBoxed(id);
			var $slot = $('<li class="runbun-run-party-slot"></li>').attr('data-id', id);
			$slot.append($('<span class="runbun-run-party-order"></span>').text(String(i + 1)));
			$slot.append($('<span class="runbun-run-party-name"></span>')
				.text(mon ? monLabel(mon) : id));
			if (i > 0) {
				$slot.append($('<button type="button" class="runbun-run-party-up" title="Move toward lead"></button>')
					.attr('data-id', id).text('▴'));
			}
			$slot.append($('<button type="button" class="runbun-run-party-rm" title="Remove"></button>')
				.attr('data-id', id).text('×'));
			$strip.append($slot);
		}
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
			$row.append($('<span class="runbun-run-up-order"></span>').text('#' + fight.order));
			$row.append($('<span class="runbun-run-up-name"></span>').text(fight.trainer));
			if (fight.tier) {
				$row.append($('<span class="runbun-run-up-tier"></span>')
					.addClass(fight.tier === 'boss' ? 'is-boss' : 'is-story')
					.text(fight.tier));
			}
			$row.append($('<span class="runbun-run-up-meta"></span>')
				.text(fight.partySize + ' mons · to L' + fight.topLevel));
			$row.append($('<span class="runbun-run-up-actions"></span>')
				.append($('<button type="button" class="runbun-run-up-plan"></button>')
					.attr('data-trainer', fight.trainer).text('Plan'))
				.append($('<button type="button" class="runbun-run-up-beat"></button>')
					.attr('data-trainer', fight.trainer).text('Beaten')));
			$list.append($row);
		});
		if (!(payload.upcoming || []).length) {
			$list.append($('<li class="runbun-run-up is-done"></li>')
				.text('Nothing ahead — the run map is finished.'));
		}
	}

	// ------------------------------------------------------------------ render

	/** The start form and the run are never both on screen. */
	function showRun() {
		$('#runbun-run-empty').prop('hidden', !!state);
		$('#runbun-run-live').prop('hidden', !state);
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
		// The split is how a player narrates a run — "the Brawly split" — so it
		// leads the position line rather than trailing it.
		$('#runbun-run-position').text(
			(summary.split && !summary.split.finished ?
				summary.split.boss.replace(/^Leader /, '') + ' split (' +
					summary.split.index + '/' + summary.split.of + ') · ' : '') +
			(summary.next ?
				'Next: #' + summary.next.order + ' ' + summary.next.trainer :
				'The run map is finished.'));
		$('#runbun-run-cap').text(summary.levelCap.cap === null ?
			'' :
			'Level cap ' + summary.levelCap.cap + ' — ' + summary.levelCap.trainer +
				"'s " + summary.levelCap.ace);

		renderSpine(payload);
		renderBox(payload);
		renderPartyStrip();
		renderUpcoming(payload);

		var bag = Object.keys(summary.bag);
		$('#runbun-run-bag').text(bag.length ?
			bag.map(function (item) { return item + ' x' + summary.bag[item]; }).join(', ') :
			'Bag is empty.');
		return payload;
	}

	function render() {
		showRun();
		if (!state) return;

		return api('/run/status', {run: state, upcomingCount: 8}).then(paint).catch(function (error) {
			status(error.message, 'error');
			// The payload is what feeds staging, so a failed status leaves
			// `stagedParty` describing a run that may no longer exist — undone mons
			// still carrying a "−" and "Set party" ready to stage their ids. The
			// committed party is the only thing still known to be true.
			stagedParty = state.party.slice();
			if (lastStatus) {
				renderBox(lastStatus);
				renderPartyStrip();
			}
		});
	}

	/** Send one command; on success save and redraw, on refusal change nothing. */
	function command(body) {
		return mutate(function () {
			status('Working…', '');
			return api('/run/apply', {run: state, command: body}).then(function (payload) {
				state = payload.run;
				persist();
				status(payload.summary, 'ok');
				return render();
			}).catch(function (error) {
				// The refusal message is the feature: it says why this could not have
				// happened in the game, not merely that the form was wrong.
				status(error.message, 'error');
				// A refusal still has to redraw: staging built for the refused command
				// is now describing a run the server never accepted. `render` resyncs
				// it from the authoritative state and leaves this message standing.
				return render();
			});
		});
	}

	function loadMaps() {
		return fetch('/run/maps').then(function (response) { return response.json(); })
			.then(function (payload) {
				maps = payload.maps || [];
				var $select = $('#runbun-run-map').empty();
				$select.append($('<option value=""></option>').text('— nowhere (gift, static, trade) —'));
				maps.forEach(function (map) {
					$select.append($('<option></option>').attr('value', map.name).text(map.name));
				});
				$('#runbun-run-limits').text(payload.limits ? payload.limits.note : '');
			});
	}

	function showEncounters() {
		var map = $('#runbun-run-map').val();
		var $list = $('#runbun-run-encounters').empty();
		if (!state || !map) return;
		api('/run/where', {run: state, map: map}).then(function (found) {
			found.mons.forEach(function (mon) {
				$list.append($('<li></li>')
					.toggleClass('is-owned', !!mon.owned)
					.append($('<button type="button" class="runbun-run-encounter"></button>')
						.attr('data-species', mon.species)
						.attr('data-level', mon.minLevel)
						.attr('data-method', mon.method)
						.text((mon.owned ? '✓ ' : '') + mon.species + '  L' + mon.minLevel +
							(mon.maxLevel === mon.minLevel ? '' : '-' + mon.maxLevel) +
							(mon.rod ? '  ' + mon.rod : ''))));
			});
		}).catch(function (error) {
			status(error.message, 'error');
		});
	}

	function plan(trainer) {
		var body = {run: state};
		if (trainer) body.trainer = trainer;
		api('/run/plan', body).then(function (result) {
			$('#runbun-run-plan-verdict').text(
				result.confidence === 'contested' ?
					result.trainer + ' — contested by ' + result.margin + '. Plan for both.' :
					result.confidence === 'only-option' ?
						result.trainer + ' — only one action available.' :
						result.trainer + ' — decided by ' + result.margin + '.'
			);
			var $actions = $('#runbun-run-plan-actions').empty();
			result.actions.slice(0, 6).forEach(function (action, i) {
				$actions.append($('<div class="runbun-run-action"></div>')
					.toggleClass('is-top', i === 0)
					.append($('<span class="runbun-run-action-score"></span>').text(action.score.toFixed(2)))
					.append($('<span class="runbun-run-action-label"></span>').text(action.label)));
			});
		}).catch(function (error) {
			status(error.message, 'error');
		});
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
		$('#runbun-run-new').on('click', function () {
			if (damagedSaveUnhandled()) {
				status('The damaged save from this browser is in the transfer box below ' +
					'and starting a run would write over it. Repair it and press Import, ' +
					'or clear that box to start fresh.', 'error');
				return;
			}
			mutate(function () {
				return api('/run/new', {
					name: $('#runbun-run-new-name').val() || 'My run',
					levelCap: $('#runbun-run-new-cap').is(':checked') ? 'next-milestone-ace' : 'none',
					permadeath: $('#runbun-run-new-nuzlocke').is(':checked'),
					// Declaring the rival removes the other two variants of every rival
					// fight from the spine, the road ahead and the caps.
					rival: $('#runbun-run-new-rival').val() || undefined,
					now: new Date().toISOString(),
				}).then(function (payload) {
					state = payload.run;
					corruptSave = null;
					persist();
					status('Started ' + state.name + '.', 'ok');
					return render();
				}).catch(function (error) {
					status(error.message, 'error');
				});
			});
		});

		$('#runbun-run-map').on('change', showEncounters);
		$('#runbun-run-box-filter').on('input', function () {
			if (lastStatus) renderBox(lastStatus);
		});

		// Clicking an encounter fills the catch form rather than catching outright:
		// level and nickname are the player's to set, and a one-click catch would
		// make a misclick a box entry.
		$('#runbun-run-encounters').on('click', '.runbun-run-encounter', function () {
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
			command({
				kind: 'catch',
				species: $('#runbun-run-catch-species').val(),
				level: Number($('#runbun-run-catch-level').val()),
				map: $('#runbun-run-map').val() || undefined,
				nickname: $('#runbun-run-catch-name').val() || undefined,
				moves: moves.length ? moves : undefined,
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

		$('#runbun-run-box').on('click', '.runbun-run-mon', function () {
			$('#runbun-run-selected').val($(this).attr('data-id'));
			$('#runbun-run-box .runbun-run-mon').removeClass('is-selected');
			$(this).addClass('is-selected');
		});

		$('#runbun-run-evolve').on('click', function () {
			command({kind: 'evolve', id: $('#runbun-run-selected').val()});
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
		$('#runbun-run-learnable').on('click', function () {
			api('/run/learnable', {run: state, id: $('#runbun-run-selected').val()})
				.then(function (payload) {
					var now = payload.now.map(function (entry) { return entry.move; });
					var later = payload.later.map(function (entry) {
						return entry.move + ' @' + entry.level;
					});
					$('#runbun-run-learn-now').text(now.join(', ') || '(nothing)');
					$('#runbun-run-learn-later').text(later.join(', ') || '(nothing left)');
				}).catch(function (error) {
					status(error.message, 'error');
				});
		});

		$('#runbun-run-upcoming').on('click', '.runbun-run-up-plan', function () {
			plan($(this).attr('data-trainer'));
		});
		$('#runbun-run-upcoming').on('click', '.runbun-run-up-beat', function () {
			command({kind: 'beat', trainer: $(this).attr('data-trainer')});
		});
		$('#runbun-run-plan').on('click', function () { plan(null); });

		$('#runbun-run-undo').on('click', function () {
			mutate(function () {
				return api('/run/undo', {run: state}).then(function (payload) {
					state = payload.run;
					persist();
					// An export made before the undo still contains the undone command.
					// Left sitting in the box it is one Import away from reinstating
					// exactly what the player just took back, so it goes.
					var hadExport = !!$('#runbun-run-transfer').val();
					if (hadExport) $('#runbun-run-transfer').val('');
					status('Undone.' + (hadExport ?
						' Cleared the transfer box — it held the undone command.' : ''), 'ok');
					return render();
				}).catch(function (error) {
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
			$('#runbun-run-transfer').val(JSON.stringify(state, null, '\t'));
			status('Exported. Copy this to keep or move the run.', 'ok');
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
			mutate(function () {
				// The server is the only thing that can tell a run from a shape that
				// merely looks like one, so it is asked BEFORE anything is adopted.
				// Checking a field here and persisting on faith wrote junk over a real
				// save permanently — the panel writes only what the server accepted,
				// and an import is no different from a command in that.
				return api('/run/status', {run: incoming, upcomingCount: 8}).then(function (payload) {
					state = incoming;
					corruptSave = null;
					persist();
					showRun();
					paint(payload);
					status('Imported.', 'ok');
				}).catch(function (error) {
					// `state` and the save are untouched: the run on screen is still the
					// one that was there before the paste.
					status('Could not import: ' + error.message, 'error');
				});
			});
		});
	}

	$(function () {
		if (!$('#runbun-run').length) return;
		bind();
		state = restore();
		loadMaps().then(render).then(function () {
			if (corruptSave) {
				$('#runbun-run-transfer').val(corruptSave)
					.closest('details').prop('open', true);
				status('The run saved in this browser is damaged and could not be read. ' +
					'Its raw text is in the transfer box below — repair it and press ' +
					'Import to get the run back, or clear the box to start over.', 'error');
				return;
			}
			if (state) status('Loaded ' + state.name + ' from this browser.', 'ok');
		});
	});
})();
