/* eslint-env browser, jquery */
/**
 * Fight planner panel.
 *
 * The rest of the product answers "given this position, what happens". A player
 * mid-run has a different question: they know which trainer is next and roughly
 * what team they are bringing, and they want to know whether they survive it.
 *
 * This panel is a thin client over `/planner/*`. It holds no rules and no
 * scores: it picks a fight from the run map, sends a team, and renders what the
 * server says the opponent will do. Anything wrong on screen is wrong in a layer
 * below, which is the same contract `planner.js` keeps on the server side.
 */
(function () {
	'use strict';

	var $panel;
	var fights = [];
	var coverage = null;

	function status(message, kind) {
		var $status = $('#runbun-planner-status');
		$status.text(message || '');
		$status.attr('data-kind', kind || '');
	}

	function api(path, options) {
		return fetch(path, options).then(function (response) {
			return response.json().then(function (body) {
				if (!response.ok) {
					throw new Error(body && body.error ? body.error : 'request failed');
				}
				return body;
			});
		});
	}

	/** Team entries are `Species (Set Label)` — the same shape the set dropdowns use. */
	function parseTeam(text) {
		var party = [];
		var lines = String(text || '').split('\n');
		for (var i = 0; i < lines.length; i++) {
			var line = lines[i].trim();
			if (!line) continue;
			var match = line.match(/^(.*?)\s*\((.*)\)\s*$/);
			if (!match) {
				throw new Error('line ' + (i + 1) + ': expected "Species (Set Label)", got "' + line + '"');
			}
			party.push({species: match[1].trim(), setLabel: match[2].trim()});
		}
		if (!party.length) throw new Error('enter at least one Pokémon as "Species (Set Label)"');
		return party;
	}

	function renderFightOptions() {
		var $select = $('#runbun-planner-trainer');
		$select.empty();
		for (var i = 0; i < fights.length; i++) {
			var fight = fights[i];
			$select.append($('<option></option>')
				.attr('value', fight.trainer)
				.text('#' + fight.order + '  ' + fight.trainer + '  (' + fight.partySize + ')'));
		}
	}

	function renderCoverage() {
		if (!coverage) return;
		// The run map is a progression spine, not every battle in the game. Saying
		// so on screen matters more than in a comment: a planner that looks
		// complete invites a player to trust a gap they were never told about.
		if (coverage.completeTrainerCensus) return;
		$('#runbun-planner-coverage').text(
			'Run map covers the mandatory progression — gyms, Elite Four, rivals, admins. ' +
			'Roughly ' + coverage.approximateTrainersAbsent + ' optional route trainers ' +
			'(' + coverage.absentKind + ') are not in this data.'
		);
	}

	function renderParty(fight) {
		var $party = $('#runbun-planner-party').empty();
		for (var i = 0; i < fight.party.length; i++) {
			var mon = fight.party[i];
			var moves = (mon.moves || []).filter(function (move) {
				return move && move !== '(No Move)';
			});
			$party.append($('<li class="runbun-planner-mon"></li>')
				.append($('<span class="runbun-planner-mon-name"></span>').text(mon.species + ' Lv' + mon.level))
				.append($('<span class="runbun-planner-mon-kit"></span>')
					.text([mon.ability, mon.item].filter(Boolean).join(' · ')))
				.append($('<span class="runbun-planner-mon-moves"></span>').text(moves.join(', '))));
		}
	}

	function renderPrediction(result) {
		$('#runbun-planner-verdict')
			.attr('data-confidence', result.confidence)
			.text(
				result.confidence === 'contested' ?
					'Contested — the top two actions are ' + result.margin + ' apart. Plan for both.' :
					result.confidence === 'only-option' ?
						'Only one action available.' :
						'Decided — the top action leads by ' + result.margin + '.'
			);

		var $actions = $('#runbun-planner-actions').empty();
		for (var i = 0; i < result.actions.length; i++) {
			var action = result.actions[i];
			$actions.append($('<div class="runbun-planner-action" role="listitem"></div>')
				.toggleClass('is-top', i === 0)
				.append($('<span class="runbun-planner-action-score"></span>').text(action.score.toFixed(2)))
				.append($('<span class="runbun-planner-action-label"></span>').text(action.label)));
		}
	}

	function loadFights() {
		return api('/planner/fights').then(function (body) {
			fights = body.fights || [];
			coverage = body.coverage;
			renderFightOptions();
			renderCoverage();
			status(fights.length + ' fights loaded from the run map.', 'ok');
		}).catch(function (error) {
			status('Could not load the run map: ' + error.message + '. Is the server running?', 'error');
		});
	}

	function showFight() {
		var trainer = $('#runbun-planner-trainer').val();
		if (!trainer) return;
		api('/planner/fight?trainer=' + encodeURIComponent(trainer)).then(function (body) {
			renderParty(body.fight);
			status('Loaded ' + body.fight.trainer + '.', 'ok');
		}).catch(function (error) {
			status(error.message, 'error');
		});
	}

	function predict() {
		var trainer = $('#runbun-planner-trainer').val();
		var party;
		try {
			party = parseTeam($('#runbun-planner-team').val());
		} catch (error) {
			// A malformed team is the user's typo, not a server round trip.
			status(error.message, 'error');
			return;
		}
		status('Predicting…', '');
		api('/planner/predict', {
			method: 'POST',
			headers: {'content-type': 'application/json'},
			body: JSON.stringify({trainer: trainer, playerParty: party}),
		}).then(function (result) {
			renderPrediction(result);
			status('Predicted ' + result.trainer + '.', 'ok');
		}).catch(function (error) {
			status(error.message, 'error');
		});
	}

	$(function () {
		$panel = $('#runbun-planner');
		if (!$panel.length) return;
		$('#runbun-planner-load').on('click', loadFights);
		$('#runbun-planner-trainer').on('change', showFight);
		$('#runbun-planner-predict').on('click', predict);
		$('#runbun-planner-next').on('click', function () {
			var current = $('#runbun-planner-trainer').get(0);
			if (current && current.selectedIndex < fights.length - 1) {
				current.selectedIndex += 1;
				showFight();
			}
		});
		$('#runbun-planner-prev').on('click', function () {
			var current = $('#runbun-planner-trainer').get(0);
			if (current && current.selectedIndex > 0) {
				current.selectedIndex -= 1;
				showFight();
			}
		});
	});
})();
