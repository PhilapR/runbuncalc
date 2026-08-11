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
 * run private to the browser it was played in. There are no accounts here, and a
 * server that stored playthroughs would need them.
 *
 * The one thing this file DOES own is persistence, because that is a browser
 * concern and nothing below it can do it: read on load, write after every
 * accepted command, and never write a run the server refused.
 */
(function () {
	'use strict';

	var STORAGE_KEY = 'runbun.run.v1';

	var state = null;
	var maps = [];

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
	 * Persist only what the server accepted.
	 *
	 * A refused command must leave the save exactly as it was — the same property
	 * `play.js` keeps for its file. Writing optimistically and rolling back on
	 * error would leave a corrupt run behind if the page closed in between.
	 */
	function persist() {
		try {
			window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
		} catch (error) {
			// A full or disabled localStorage must not take the panel down with it;
			// the run still works for this session.
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

	function render() {
		// `hidden` as an attribute, not jQuery's `toggle`. `toggle` clears the
		// inline display, which leaves the UA stylesheet's `[hidden] {display:none}`
		// still in force — the panel stays invisible and nothing says why.
		$('#runbun-run-empty').prop('hidden', !!state);
		$('#runbun-run-live').prop('hidden', !state);
		if (!state) return;

		return api('/run/status', {run: state}).then(function (payload) {
			var summary = payload.status;
			$('#runbun-run-name').text(summary.name);
			$('#runbun-run-position').text(summary.next ?
				'Next: #' + summary.next.order + ' ' + summary.next.trainer :
				'The run map is finished.');
			$('#runbun-run-cap').text(summary.levelCap.cap === null ?
				'No level cap.' :
				'Level cap ' + summary.levelCap.cap + ' — ' + summary.levelCap.trainer +
					"'s " + summary.levelCap.ace);

			var $box = $('#runbun-run-box').empty();
			var party = summary.party.map(function (mon) { return mon.id; });
			// Party first and in order: it is what the player is looking at, and the
			// order is the lead order the planner will use.
			var ordered = party.map(function (id) {
				return payload.box.filter(function (mon) { return mon.id === id; })[0];
			}).concat(payload.box.filter(function (mon) { return party.indexOf(mon.id) === -1; }));

			ordered.forEach(function (mon) {
				var slot = party.indexOf(mon.id);
				var $row = $('<li class="runbun-run-mon"></li>')
					.attr('data-id', mon.id)
					.toggleClass('is-party', slot !== -1)
					.toggleClass('is-lost', mon.status === 'dead');
				$row.append($('<span class="runbun-run-mon-slot"></span>')
					.text(mon.status === 'dead' ? 'lost' : slot === -1 ? 'box' : String(slot + 1)));
				$row.append($('<span class="runbun-run-mon-name"></span>').text(monLabel(mon)));
				$row.append($('<span class="runbun-run-mon-kit"></span>')
					.text([mon.item, mon.origin && mon.origin.mapName ?
						mon.origin.method + ' · ' + mon.origin.mapName : 'declared']
						.filter(Boolean).join(' · ')));
				$row.append($('<span class="runbun-run-mon-moves"></span>').text(mon.moves.join(', ')));
				$box.append($row);
			});

			var bag = Object.keys(summary.bag);
			$('#runbun-run-bag').text(bag.length ?
				bag.map(function (item) { return item + ' x' + summary.bag[item]; }).join(', ') :
				'Bag is empty.');

			var $party = $('#runbun-run-party-picker').empty();
			payload.box.filter(function (mon) { return mon.status !== 'dead'; }).forEach(function (mon) {
				$party.append($('<option></option>').attr('value', mon.id)
					.prop('selected', party.indexOf(mon.id) !== -1)
					.text(mon.id + '  ' + monLabel(mon)));
			});
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

	function plan() {
		api('/run/plan', {run: state}).then(function (result) {
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

		// Clicking an encounter fills the catch form rather than catching outright:
		// level, nickname and the rest are the player's to set, and a one-click
		// catch would make a misclick a box entry.
		$('#runbun-run-encounters').on('click', '.runbun-run-encounter', function () {
			$('#runbun-run-catch-species').val($(this).attr('data-species'));
			$('#runbun-run-catch-level').val($(this).attr('data-level'));
		});

		$('#runbun-run-catch').on('click', function () {
			command({
				kind: 'catch',
				species: $('#runbun-run-catch-species').val(),
				level: Number($('#runbun-run-catch-level').val()),
				map: $('#runbun-run-map').val() || undefined,
				nickname: $('#runbun-run-catch-name').val() || undefined,
			});
		});

		$('#runbun-run-set-party').on('click', function () {
			var ids = $('#runbun-run-party-picker').val() || [];
			command({kind: 'party', ids: ids});
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
		$('#runbun-run-beat').on('click', function () {
			api('/run/status', {run: state}).then(function (payload) {
				if (!payload.upcoming.length) throw new Error('the run map is finished');
				return command({kind: 'beat', trainer: payload.upcoming[0].trainer});
			}).catch(function (error) {
				status(error.message, 'error');
			});
		});
		$('#runbun-run-plan').on('click', plan);
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
