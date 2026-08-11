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
 *   - 34 milestones: the spine strip is "where am I" at a glance
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
		try {
			var saved = window.localStorage.getItem(STORAGE_KEY);
			return saved ? JSON.parse(saved) : null;
		} catch (error) {
			return null;
		}
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
	 * accented. 34 ticks is glanceable where 34 names would be a wall; the name
	 * lives in the tooltip and the note line names only the one that matters.
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

	function render() {
		$('#runbun-run-empty').prop('hidden', !!state);
		$('#runbun-run-live').prop('hidden', !state);
		if (!state) return;

		return api('/run/status', {run: state, upcomingCount: 8}).then(function (payload) {
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
		}).catch(function (error) {
			status(error.message, 'error');
		});
	}

	/** Send one command; on success save and redraw, on refusal change nothing. */
	function command(body) {
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

	function bind() {
		$('#runbun-run-new').on('click', function () {
			api('/run/new', {
				name: $('#runbun-run-new-name').val() || 'My run',
				levelCap: $('#runbun-run-new-cap').is(':checked') ? 'next-milestone-ace' : 'none',
				permadeath: $('#runbun-run-new-nuzlocke').is(':checked'),
				// Declaring the rival removes the other two variants of every rival
				// fight from the spine, the road ahead and the caps.
				rival: $('#runbun-run-new-rival').val() || undefined,
				now: new Date().toISOString(),
			}).then(function (payload) {
				state = payload.run;
				persist();
				status('Started ' + state.name + '.', 'ok');
				return render();
			}).catch(function (error) {
				status(error.message, 'error');
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
			api('/run/undo', {run: state}).then(function (payload) {
				state = payload.run;
				persist();
				status('Undone.', 'ok');
				return render();
			}).catch(function (error) {
				status(error.message, 'error');
			});
		});
		$('#runbun-run-export').on('click', function () {
			$('#runbun-run-transfer').val(JSON.stringify(state, null, '\t'));
			status('Exported. Copy this to keep or move the run.', 'ok');
		});
		$('#runbun-run-import').on('click', function () {
			try {
				var incoming = JSON.parse($('#runbun-run-transfer').val());
				if (!incoming || typeof incoming !== 'object' || !incoming.version) {
					throw new Error('that is not a run');
				}
				state = incoming;
				persist();
				status('Imported.', 'ok');
				render();
			} catch (error) {
				status('Could not import: ' + error.message, 'error');
			}
		});
	}

	$(function () {
		if (!$('#runbun-run').length) return;
		bind();
		state = restore();
		loadMaps().then(render).then(function () {
			if (state) status('Loaded ' + state.name + ' from this browser.', 'ok');
		});
	});
})();
