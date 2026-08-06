/* eslint-env browser, es6 */
/**
 * Battle turn viewer — thin HTTP client over Run & Bun AI endpoints.
 * Display state → evaluate/choose → apply (derive→apply) → advance.
 * Singles and Doubles field layouts follow BattleState.mode (DBL-01 display only).
 * Does not reimplement scoring or battle transitions in the browser.
 */
(function () {
	'use strict';

	var SAMPLE_STATE = {
		generation: 8,
		mode: 'Singles',
		turn: 1,
		field: {},
		sides: {
			ai: {
				activeIds: ['ai-1'],
				party: [{
					id: 'ai-1',
					species: 'Pikachu',
					level: 100,
					hp: {current: 100, max: 100},
					ability: 'Static',
					item: 'Light Ball',
					moves: [
						{name: 'Thunderbolt'},
						{name: 'Thunder Wave'},
						{name: 'Protect'},
						{name: 'Volt Switch'},
					],
				}, {
					id: 'ai-2',
					species: 'Raichu',
					level: 100,
					hp: {current: 150, max: 150},
					ability: 'Lightning Rod',
					moves: [
						{name: 'Thunderbolt'},
						{name: 'Focus Blast'},
						{name: 'Nasty Plot'},
						{name: 'Grass Knot'},
					],
				}],
			},
			player: {
				activeIds: ['player-1'],
				party: [{
					id: 'player-1',
					species: 'Gyarados',
					level: 100,
					hp: {current: 200, max: 200},
					ability: 'Intimidate',
					item: 'Leftovers',
					moves: [
						{name: 'Waterfall'},
						{name: 'Earthquake'},
						{name: 'Dragon Dance'},
						{name: 'Ice Fang'},
					],
				}],
			},
		},
		firstTurnOutIds: ['ai-1', 'player-1'],
	};

	var DOUBLES_SAMPLE_STATE = {
		generation: 8,
		mode: 'Doubles',
		turn: 1,
		field: {},
		sides: {
			ai: {
				activeIds: ['ai-1', 'ai-2'],
				party: [{
					id: 'ai-1',
					species: 'Pikachu',
					level: 100,
					hp: {current: 100, max: 100},
					ability: 'Static',
					item: 'Light Ball',
					moves: [
						{name: 'Thunderbolt'},
						{name: 'Fake Out'},
						{name: 'Protect'},
						{name: 'Helping Hand'},
					],
				}, {
					id: 'ai-2',
					species: 'Togekiss',
					level: 100,
					hp: {current: 180, max: 180},
					ability: 'Serene Grace',
					item: 'Leftovers',
					moves: [
						{name: 'Air Slash'},
						{name: 'Dazzling Gleam'},
						{name: 'Follow Me'},
						{name: 'Protect'},
					],
				}],
			},
			player: {
				activeIds: ['player-1', 'player-2'],
				party: [{
					id: 'player-1',
					species: 'Gyarados',
					level: 100,
					hp: {current: 200, max: 200},
					ability: 'Intimidate',
					item: 'Life Orb',
					moves: [
						{name: 'Waterfall'},
						{name: 'Earthquake'},
						{name: 'Dragon Dance'},
						{name: 'Protect'},
					],
				}, {
					id: 'player-2',
					species: 'Rillaboom',
					level: 100,
					hp: {current: 190, max: 190},
					ability: 'Grassy Surge',
					item: 'Assault Vest',
					moves: [
						{name: 'Grassy Glide'},
						{name: 'Wood Hammer'},
						{name: 'U-turn'},
						{name: 'Fake Out'},
					],
				}],
			},
		},
		firstTurnOutIds: ['ai-1', 'ai-2', 'player-1', 'player-2'],
	};

	var FORCED_SWITCH_SAMPLE = {
		generation: 8,
		mode: 'Singles',
		turn: 3,
		field: {},
		pendingForcedSwitchIds: ['ai-1'],
		sides: {
			ai: {
				activeIds: ['ai-1'],
				party: [{
					id: 'ai-1',
					species: 'Pikachu',
					level: 100,
					hp: {current: 42, max: 100},
					ability: 'Static',
					moves: [
						{name: 'Thunderbolt'},
						{name: 'Volt Switch'},
						{name: 'Protect'},
						{name: 'Thunder Wave'},
					],
				}, {
					id: 'ai-2',
					species: 'Raichu',
					level: 100,
					hp: {current: 150, max: 150},
					ability: 'Lightning Rod',
					moves: [
						{name: 'Thunderbolt'},
						{name: 'Focus Blast'},
						{name: 'Nasty Plot'},
						{name: 'Grass Knot'},
					],
				}],
			},
			player: {
				activeIds: ['player-1'],
				party: [{
					id: 'player-1',
					species: 'Gyarados',
					level: 100,
					hp: {current: 160, max: 200},
					ability: 'Intimidate',
					moves: [
						{name: 'Waterfall'},
						{name: 'Earthquake'},
						{name: 'Dragon Dance'},
						{name: 'Ice Fang'},
					],
				}],
			},
		},
	};

	var selectedAction = null;
	var lastEvaluations = [];

	function $(id) {
		return document.getElementById(id);
	}

	function setBusy(busy) {
		var root = $('runbun-battle');
		if (!root) return;
		if (busy) root.setAttribute('aria-busy', 'true');
		else root.removeAttribute('aria-busy');
		[
			'runbun-battle-evaluate',
			'runbun-battle-choose',
			'runbun-battle-apply',
			'runbun-battle-advance',
			'runbun-battle-loop',
			'runbun-battle-validate',
			'runbun-battle-load-sample',
			'runbun-battle-load-doubles',
			'runbun-battle-load-forced',
			'runbun-battle-load-ai-panel',
			'runbun-battle-load-bridge',
		].forEach(function (id) {
			var btn = $(id);
			if (btn) btn.disabled = !!busy;
		});
	}

	function setStatus(message, isError) {
		var el = $('runbun-battle-status');
		if (!el) return;
		el.textContent = message || '';
		el.className = isError ?
			'runbun-battle-status runbun-battle-error' :
			'runbun-battle-status';
		el.setAttribute('aria-live', isError ? 'assertive' : 'polite');
	}

	function parseState() {
		var raw = $('runbun-battle-state').value;
		try {
			return JSON.parse(raw);
		} catch (error) {
			throw new Error('Battle state JSON is invalid: ' +
				(error && error.message ? error.message : error));
		}
	}

	function writeState(state) {
		$('runbun-battle-state').value = JSON.stringify(state, null, 2);
		renderField(state);
	}

	function postAi(path, body) {
		return fetch(path, {
			method: 'POST',
			headers: {'content-type': 'application/json'},
			body: JSON.stringify(body),
		}).then(function (response) {
			return response.json().then(function (payload) {
				return {status: response.status, body: payload};
			}, function () {
				return {status: response.status, body: {error: 'Non-JSON response'}};
			});
		});
	}

	function formatHttpError(result) {
		var body = result.body || {};
		var message = body.error || JSON.stringify(body);
		return 'HTTP ' + result.status + ': ' + message;
	}

	function requestOptions() {
		return {
			sideId: ($('runbun-battle-side') && $('runbun-battle-side').value) || 'ai',
			includeSwitches: !!(
				$('runbun-battle-include-switches') &&
				$('runbun-battle-include-switches').checked
			),
		};
	}

	function findPokemon(state, id) {
		if (!state || !state.sides || !id) return null;
		var sides = [state.sides.ai, state.sides.player];
		for (var i = 0; i < sides.length; i++) {
			var side = sides[i];
			if (!side || !Array.isArray(side.party)) continue;
			for (var j = 0; j < side.party.length; j++) {
				if (side.party[j] && side.party[j].id === id) return side.party[j];
			}
		}
		return null;
	}

	function isDoublesState(state) {
		if (!state) return false;
		if (state.mode === 'Doubles') return true;
		if (state.format === 'Doubles') return true;
		return false;
	}

	function activeSlotIds(state, sideId) {
		var side = state && state.sides && state.sides[sideId];
		var ids = side && Array.isArray(side.activeIds) ? side.activeIds.filter(Boolean) : [];
		var slots = isDoublesState(state) ? 2 : 1;
		var out = [];
		var i;
		for (i = 0; i < slots; i++) {
			out.push(ids[i] || null);
		}
		return out;
	}

	function hpText(pokemon) {
		if (!pokemon || !pokemon.hp) return '—';
		return pokemon.hp.current + ' / ' + pokemon.hp.max;
	}

	function hpPercent(pokemon) {
		if (!pokemon || !pokemon.hp || !pokemon.hp.max) return 0;
		var pct = (100 * pokemon.hp.current) / pokemon.hp.max;
		if (pct < 0) return 0;
		if (pct > 100) return 100;
		return pct;
	}

	function fillActiveCard(el, label, pokemon, options) {
		var opts = options || {};
		el.innerHTML = '';
		el.className = 'runbun-battle-active' +
			(opts.sideClass ? ' ' + opts.sideClass : '') +
			(pokemon ? '' : ' runbun-battle-active-empty');
		var title = document.createElement('div');
		title.className = 'runbun-battle-side-label';
		title.textContent = label;
		el.appendChild(title);
		if (!pokemon) {
			var empty = document.createElement('div');
			empty.className = 'runbun-battle-species';
			empty.textContent = opts.emptyText || '(empty slot)';
			el.appendChild(empty);
			return;
		}
		var species = document.createElement('div');
		species.className = 'runbun-battle-species';
		species.textContent = pokemon.species +
			(pokemon.level ? ' Lv' + pokemon.level : '') +
			(pokemon.status ? ' [' + pokemon.status + ']' : '');
		el.appendChild(species);
		var bar = document.createElement('div');
		bar.className = 'runbun-battle-hp-bar';
		bar.setAttribute('role', 'meter');
		bar.setAttribute('aria-label', (pokemon.species || 'Pokémon') + ' HP');
		bar.setAttribute('aria-valuemin', '0');
		bar.setAttribute('aria-valuemax', String(pokemon.hp.max));
		bar.setAttribute('aria-valuenow', String(pokemon.hp.current));
		bar.setAttribute('aria-valuetext', hpText(pokemon));
		var fill = document.createElement('div');
		var pct = hpPercent(pokemon);
		fill.className = 'runbun-battle-hp-fill';
		if (pct < 20) fill.className += ' runbun-battle-hp-low';
		else if (pct < 50) fill.className += ' runbun-battle-hp-mid';
		else fill.className += ' runbun-battle-hp-high';
		fill.style.width = pct + '%';
		fill.setAttribute('aria-hidden', 'true');
		bar.appendChild(fill);
		el.appendChild(bar);
		var hp = document.createElement('div');
		hp.className = 'runbun-battle-hp-text';
		hp.textContent = 'HP ' + hpText(pokemon);
		el.appendChild(hp);
		if (pokemon.id || pokemon.ability || pokemon.item) {
			var meta = document.createElement('div');
			meta.className = 'runbun-battle-meta';
			var bits = [];
			if (pokemon.id) bits.push(pokemon.id);
			if (pokemon.ability) bits.push(pokemon.ability);
			if (pokemon.item) bits.push(pokemon.item);
			meta.textContent = bits.join(' · ');
			el.appendChild(meta);
		}
	}

	function renderSideRow(field, state, sideId, rowLabel, sideClass) {
		var row = document.createElement('div');
		row.className = 'runbun-battle-side-row runbun-battle-side-' + sideId;
		row.setAttribute('role', 'group');
		row.setAttribute('aria-label', rowLabel);
		var heading = document.createElement('div');
		heading.className = 'runbun-battle-row-label';
		heading.textContent = rowLabel;
		row.appendChild(heading);
		var slots = document.createElement('div');
		slots.className = 'runbun-battle-slots';
		var doubles = isDoublesState(state);
		var ids = activeSlotIds(state, sideId);
		ids.forEach(function (id, index) {
			var card = document.createElement('div');
			var slotLabel = doubles ?
				(sideId === 'ai' ? 'Foe' : 'Ally') + ' slot ' + (index + 1) :
				(sideId === 'ai' ? 'AI active' : 'Player active');
			var pokemon = id ? findPokemon(state, id) : null;
			fillActiveCard(card, slotLabel, pokemon, {
				sideClass: sideClass,
				emptyText: doubles ? '(empty Doubles slot)' : '(no active)',
			});
			slots.appendChild(card);
		});
		row.appendChild(slots);
		field.appendChild(row);
	}

	function renderForced(state) {
		var el = $('runbun-battle-forced');
		if (!el) return;
		var ids = state && Array.isArray(state.pendingForcedSwitchIds) ?
			state.pendingForcedSwitchIds.filter(Boolean) : [];
		var baton = state && Array.isArray(state.pendingBatonPassIds) ?
			state.pendingBatonPassIds.filter(Boolean) : [];
		var shed = state && Array.isArray(state.pendingSubstitutePassIds) ?
			state.pendingSubstitutePassIds.filter(Boolean) : [];
		if (!ids.length && !baton.length && !shed.length) {
			el.hidden = true;
			el.textContent = '';
			el.removeAttribute('role');
			return;
		}
		el.hidden = false;
		el.setAttribute('role', 'alert');
		var parts = [];
		if (ids.length) parts.push('pendingForcedSwitchIds: ' + ids.join(', '));
		if (baton.length) parts.push('pendingBatonPassIds: ' + baton.join(', '));
		if (shed.length) parts.push('pendingSubstitutePassIds: ' + shed.join(', '));
		el.textContent = 'Forced replacement required — ' + parts.join(' · ');
	}

	function renderSummaryChips(state) {
		var summary = $('runbun-battle-summary');
		if (!summary) return;
		summary.innerHTML = '';
		summary.className = 'runbun-battle-summary';
		var chips = [
			{text: 'Gen ' + (state.generation || '?'), kind: 'brand'},
			{text: state.mode || '?', kind: 'muted'},
			{text: 'Turn ' + (state.turn != null ? state.turn : '?'), kind: 'muted'},
		];
		var weather = state.field && state.field.weather;
		if (weather) chips.push({text: weather, kind: 'oracle'});
		var terrain = state.field && state.field.terrain;
		if (terrain) chips.push({text: terrain + ' Terrain', kind: 'oracle'});
		if (state.field && state.field.trickRoom) chips.push({text: 'Trick Room', kind: 'warn'});
		chips.forEach(function (chip) {
			var el = document.createElement('span');
			el.className = 'runbun-battle-chip';
			if (chip.kind === 'brand') el.className += ' runbun-battle-chip-brand';
			else if (chip.kind === 'oracle') el.className += ' runbun-battle-chip-oracle';
			else if (chip.kind === 'warn') el.className += ' runbun-battle-chip-warn';
			el.textContent = chip.text;
			summary.appendChild(el);
		});
	}

	function syncShellModeChip(state) {
		var bar = $('rb-context-bar');
		if (!bar) return;
		var brand = bar.querySelector('.rb-chip-brand');
		if (!brand) return;
		var gen = state && state.generation != null ? state.generation : 8;
		var mode = isDoublesState(state) ? 'Doubles' : 'Singles';
		brand.textContent = 'Gen ' + gen + ' ' + mode;
	}

	function renderField(state) {
		renderSummaryChips(state);
		syncShellModeChip(state);
		var field = $('runbun-battle-field');
		if (!field) {
			renderForced(state);
			return;
		}
		var doubles = isDoublesState(state);
		field.innerHTML = '';
		field.setAttribute('data-mode', doubles ? 'doubles' : 'singles');
		field.className = 'runbun-battle-field' +
			(doubles ? ' runbun-battle-field-doubles' : ' runbun-battle-field-singles');
		// Doubles sketch: foes (AI) on top, allies (Player) below — no slot adjacency invented.
		renderSideRow(field, state, 'ai', doubles ? 'Opposing (AI)' : 'AI', 'runbun-battle-active-ai');
		renderSideRow(field, state, 'player', doubles ? 'Allies (Player)' : 'Player', 'runbun-battle-active-player');
		renderForced(state);
	}

	function formatAction(action) {
		if (!action) return '(none)';
		var actor = action.actorId ? action.actorId + ': ' : '';
		if (action.kind === 'switch') {
			var flags = [];
			if (action.forced) flags.push('forced');
			if (action.batonPass) flags.push('baton pass');
			if (action.preserveSubstitute) flags.push('shed tail');
			return actor + 'switch → ' + action.replacementId +
				(flags.length ? ' (' + flags.join(', ') + ')' : '');
		}
		if (action.kind === 'move') {
			var targets = (action.targetIds || []).join(', ');
			return actor + action.moveName + (targets ? ' → ' + targets : '');
		}
		return JSON.stringify(action);
	}

	function outcomeScores(evaluation) {
		if (!evaluation || !Array.isArray(evaluation.outcomes)) return [];
		return evaluation.outcomes
			.map(function (outcome) {
				return outcome && typeof outcome.score === 'number' ? outcome.score : null;
			})
			.filter(function (score) { return score !== null; });
	}

	function bestScore(evaluation) {
		var scores = outcomeScores(evaluation);
		if (!scores.length) return -Infinity;
		return Math.max.apply(null, scores);
	}

	function formatScore(evaluation) {
		var scores = outcomeScores(evaluation);
		if (!scores.length) return '—';
		if (scores.length === 1) return String(scores[0]);
		return scores.map(String).join(' / ');
	}

	function actionsEqual(a, b) {
		if (!a || !b) return false;
		return JSON.stringify(a) === JSON.stringify(b);
	}

	function bindActionListKeyboard(list) {
		if (!list || list.dataset.rbA11yBound === '1') return;
		list.dataset.rbA11yBound = '1';
		list.addEventListener('keydown', function (event) {
			if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' &&
				event.key !== 'Home' && event.key !== 'End') {
				return;
			}
			var rows = Array.prototype.slice.call(
				list.querySelectorAll('.runbun-battle-action-row')
			);
			if (!rows.length) return;
			var idx = rows.indexOf(document.activeElement);
			if (idx < 0) idx = 0;
			event.preventDefault();
			var next = idx;
			if (event.key === 'ArrowDown') next = Math.min(rows.length - 1, idx + 1);
			if (event.key === 'ArrowUp') next = Math.max(0, idx - 1);
			if (event.key === 'Home') next = 0;
			if (event.key === 'End') next = rows.length - 1;
			rows[next].focus();
		});
	}

	function renderActions(evaluations, highlight) {
		var list = $('runbun-battle-actions');
		if (!list) return;
		list.innerHTML = '';
		bindActionListKeyboard(list);
		lastEvaluations = Array.isArray(evaluations) ? evaluations : [];
		if (!lastEvaluations.length) {
			list.textContent = 'No legal actions yet. Load state, then Evaluate or Choose.';
			return;
		}
		var ranked = lastEvaluations.slice().sort(function (left, right) {
			return bestScore(right) - bestScore(left);
		});
		ranked.forEach(function (evaluation, index) {
			var block = document.createElement('div');
			block.className = 'runbun-battle-action-block';
			block.setAttribute('role', 'listitem');
			var row = document.createElement('button');
			row.type = 'button';
			row.className = 'runbun-battle-action-row';
			var actionLabel = formatAction(evaluation.action);
			var scoreText = formatScore(evaluation);
			row.setAttribute('aria-label',
				'Rank ' + (index + 1) + ', ' + actionLabel + ', score ' + scoreText);
			var isActive = (highlight && actionsEqual(evaluation.action, highlight)) ||
				(selectedAction && actionsEqual(evaluation.action, selectedAction));
			if (highlight && actionsEqual(evaluation.action, highlight)) {
				row.className += ' runbun-battle-action-selected';
				row.setAttribute('aria-pressed', 'true');
			} else if (selectedAction && actionsEqual(evaluation.action, selectedAction)) {
				row.className += ' runbun-battle-action-picked';
				row.setAttribute('aria-pressed', 'true');
			} else {
				row.setAttribute('aria-pressed', 'false');
			}
			var rank = document.createElement('span');
			rank.className = 'runbun-battle-rank';
			rank.textContent = String(index + 1);
			rank.setAttribute('aria-hidden', 'true');
			var label = document.createElement('span');
			label.className = 'runbun-battle-action-label';
			label.textContent = actionLabel;
			var score = document.createElement('span');
			score.className = 'runbun-battle-score';
			score.textContent = scoreText;
			row.appendChild(rank);
			row.appendChild(label);
			row.appendChild(score);
			row.addEventListener('click', function () {
				selectedAction = evaluation.action;
				renderActions(lastEvaluations, null);
				setStatus('Picked ' + formatAction(selectedAction) +
					'. Explain below uses evaluate-actions facts/reasons. Apply or Advance next.');
			});
			block.appendChild(row);
			if (isActive && window.RunBunExplain &&
				typeof window.RunBunExplain.renderDetail === 'function') {
				var detail = document.createElement('div');
				detail.className = 'runbun-battle-explain ai-panel-explain';
				detail.setAttribute('aria-label', 'Explain for ' + actionLabel);
				window.RunBunExplain.renderDetail(evaluation, detail);
				block.appendChild(detail);
			}
			list.appendChild(block);
		});
	}

	function loadSample() {
		selectedAction = null;
		writeState(SAMPLE_STATE);
		renderActions([]);
		setStatus('Loaded sample Singles state (Gen 8). Modeled slice only — ' +
			'external residuals / unmodeled events stay caller-owned.');
	}

	function loadDoublesSample() {
		selectedAction = null;
		writeState(DOUBLES_SAMPLE_STATE);
		renderActions([]);
		setStatus('Loaded sample Doubles state (Gen 8, 2v2 slots). Display layout only — ' +
			'targeting UX is DBL-02; same HTTP loop as Singles.');
	}

	function loadForcedSample() {
		selectedAction = null;
		writeState(FORCED_SWITCH_SAMPLE);
		renderActions([]);
		setStatus('Loaded forced-switch sample. pendingForcedSwitchIds is shown above; ' +
			'Evaluate returns only legal replacements for that side.');
	}

	function loadFromAiPanel() {
		var source = $('ai-panel-state');
		if (!source || !source.value.trim()) {
			setStatus('AI Debug textarea (#ai-panel-state) is empty.', true);
			return;
		}
		try {
			var state = JSON.parse(source.value);
			selectedAction = null;
			writeState(state);
			renderActions([]);
			setStatus('Imported BattleState from AI Debug panel.');
		} catch (error) {
			setStatus('AI Debug JSON is invalid: ' +
				(error && error.message ? error.message : error), true);
		}
	}

	function loadFromBridge() {
		if (!window.RunBunSetsBridge ||
			typeof window.RunBunSetsBridge.battleStateFromCalcPanels !== 'function') {
			setStatus('Sets bridge is not loaded (sets_to_battle_state.js).', true);
			return;
		}
		setStatus('Building BattleState from calc panels…');
		var state;
		try {
			state = window.RunBunSetsBridge.battleStateFromCalcPanels({
				includePlayerTeam: true,
				includeTrainerParty: true,
			});
		} catch (error) {
			setStatus('Bridge failed: ' +
				(error && error.message ? error.message : error), true);
			return;
		}
		selectedAction = null;
		writeState(state);
		renderActions([]);
		postAi('/ai/validate-battle-state', {state: state}).then(function (result) {
			if (result.status >= 400) {
				setStatus(formatHttpError(result) + ' — state is in the editor for fixes.', true);
				return;
			}
			setStatus('Loaded Gen 8 BattleState from calc panels (validated). Zero EVs applied.');
		}).catch(function (error) {
			setStatus('State written, but validate failed: ' +
				(error && error.message ? error.message : error), true);
		});
	}

	function refreshFromEditor() {
		var state;
		try {
			state = parseState();
		} catch (error) {
			setStatus(error.message, true);
			return;
		}
		renderField(state);
		setStatus('Field refreshed from editor JSON.');
	}

	function runValidate() {
		setStatus('Validating…');
		var state;
		try {
			state = parseState();
		} catch (error) {
			setStatus(error.message, true);
			return;
		}
		renderField(state);
		setBusy(true);
		postAi('/ai/validate-battle-state', {state: state}).then(function (result) {
			if (result.status >= 400) {
				setStatus(formatHttpError(result), true);
				return;
			}
			setStatus('BattleState is valid (Gen ' + (state.generation || '?') +
				', ' + (state.mode || '?') + ').');
		}).catch(function (error) {
			setStatus('Validate failed. Is node server.js running? ' +
				(error && error.message ? error.message : error), true);
		}).then(function () { setBusy(false); });
	}

	function runEvaluate() {
		setStatus('Evaluating…');
		var state;
		try {
			state = parseState();
		} catch (error) {
			setStatus(error.message, true);
			return;
		}
		renderField(state);
		setBusy(true);
		postAi('/ai/evaluate-actions', {state: state, options: requestOptions()}).then(function (result) {
			if (result.status >= 400) {
				setStatus(formatHttpError(result), true);
				renderActions([]);
				return;
			}
			selectedAction = null;
			renderActions(result.body.evaluations || []);
			setStatus('Evaluated ' + ((result.body.evaluations || []).length) +
				' legal action(s). Click a row to pick, or Choose for policy sample.');
		}).catch(function (error) {
			setStatus('Request failed. Is node server.js running? ' +
				(error && error.message ? error.message : error), true);
		}).then(function () { setBusy(false); });
	}

	function runChoose() {
		setStatus('Choosing…');
		var state;
		try {
			state = parseState();
		} catch (error) {
			setStatus(error.message, true);
			return;
		}
		renderField(state);
		setBusy(true);
		postAi('/ai/choose-action', {state: state, options: requestOptions()}).then(function (result) {
			if (result.status >= 400) {
				setStatus(formatHttpError(result), true);
				renderActions([]);
				return;
			}
			selectedAction = result.body.action || null;
			renderActions(result.body.evaluations || [], selectedAction);
			var score = typeof result.body.selectedScore === 'number' ?
				' (score ' + result.body.selectedScore + ')' : '';
			setStatus('Chose ' + formatAction(selectedAction) + score +
				'. Apply selected to derive→apply that action.');
		}).catch(function (error) {
			setStatus('Request failed. Is node server.js running? ' +
				(error && error.message ? error.message : error), true);
		}).then(function () { setBusy(false); });
	}

	function applyActionPath(action, state) {
		if (!action) {
			return Promise.reject(new Error('No action selected. Evaluate/Choose or click a row first.'));
		}
		if (action.kind === 'switch') {
			return postAi('/ai/apply-action', {state: state, action: action}).then(function (applied) {
				if (applied.status >= 400) {
					throw Object.assign(new Error(formatHttpError(applied) + ' (apply-action)'), {http: true});
				}
				return {state: applied.body, note: 'Applied switch ' + formatAction(action) + '.'};
			});
		}
		if (action.kind !== 'move') {
			return Promise.reject(new Error('Unsupported action kind: ' + (action.kind || '?')));
		}
		return postAi('/ai/derive-resolution', {state: state, action: action}).then(function (derived) {
			if (derived.status >= 400) {
				throw Object.assign(new Error(formatHttpError(derived) + ' (derive-resolution)'), {http: true});
			}
			return postAi('/ai/apply-action', {
				state: state,
				action: action,
				resolution: derived.body,
			}).then(function (applied) {
				if (applied.status >= 400) {
					throw Object.assign(new Error(formatHttpError(applied) + ' (apply-action)'), {http: true});
				}
				return {
					state: applied.body,
					note: 'Derived + applied ' + formatAction(action) +
						' (modeled resolution slice).',
				};
			});
		});
	}

	function runApplySelected() {
		setStatus('Applying selected…');
		var state;
		try {
			state = parseState();
		} catch (error) {
			setStatus(error.message, true);
			return;
		}
		setBusy(true);
		applyActionPath(selectedAction, state).then(function (result) {
			selectedAction = null;
			writeState(result.state);
			renderActions([]);
			setStatus(result.note +
				' State updated. Advance turn for the modeled end-turn residual slice.');
		}).catch(function (error) {
			setStatus(error && error.message ? error.message :
				'Apply failed. Is node server.js running?', true);
		}).then(function () { setBusy(false); });
	}

	function runAdvanceTurn() {
		setStatus('Advancing turn…');
		var state;
		try {
			state = parseState();
		} catch (error) {
			setStatus(error.message, true);
			return;
		}
		setBusy(true);
		postAi('/ai/advance-turn', {state: state}).then(function (result) {
			if (result.status >= 400) {
				setStatus(formatHttpError(result), true);
				return;
			}
			selectedAction = null;
			writeState(result.body);
			renderActions([]);
			setStatus('Advanced turn (modeled residual / timer slice). ' +
				'Unmodeled external events are not invented here.');
		}).catch(function (error) {
			setStatus('Advance failed. Is node server.js running? ' +
				(error && error.message ? error.message : error), true);
		}).then(function () { setBusy(false); });
	}

	function runChooseApplyAdvance() {
		setStatus('Choose → apply → advance…');
		var state;
		try {
			state = parseState();
		} catch (error) {
			setStatus(error.message, true);
			return;
		}
		setBusy(true);
		postAi('/ai/choose-action', {state: state, options: requestOptions()}).then(function (choice) {
			if (choice.status >= 400) {
				setStatus(formatHttpError(choice), true);
				return;
			}
			var action = choice.body.action;
			selectedAction = action;
			renderActions(choice.body.evaluations || [], action);
			return applyActionPath(action, state).then(function (applied) {
				return postAi('/ai/advance-turn', {state: applied.state}).then(function (advanced) {
					if (advanced.status >= 400) {
						writeState(applied.state);
						setStatus(formatHttpError(advanced) + ' (advance-turn). Applied state kept.', true);
						return;
					}
					selectedAction = null;
					writeState(advanced.body);
					renderActions([]);
					setStatus('Full step: chose ' + formatAction(action) +
						', applied modeled resolution, advanced turn.');
				});
			});
		}).catch(function (error) {
			setStatus(error && error.message ? error.message :
				'Loop failed. Is node server.js running?', true);
		}).then(function () { setBusy(false); });
	}

	function bind(id, handler) {
		var el = $(id);
		if (el) el.addEventListener('click', handler);
	}

	function init() {
		if (!$('runbun-battle')) return;
		var jsonDetails = document.querySelector('#runbun-battle .runbun-battle-json-details');
		if (jsonDetails && window.matchMedia && window.matchMedia('(min-width: 701px)').matches) {
			jsonDetails.open = true;
		}
		loadSample();
		bind('runbun-battle-load-sample', loadSample);
		bind('runbun-battle-load-doubles', loadDoublesSample);
		bind('runbun-battle-load-forced', loadForcedSample);
		bind('runbun-battle-load-ai-panel', loadFromAiPanel);
		bind('runbun-battle-load-bridge', loadFromBridge);
		bind('runbun-battle-refresh', refreshFromEditor);
		bind('runbun-battle-validate', runValidate);
		bind('runbun-battle-evaluate', runEvaluate);
		bind('runbun-battle-choose', runChoose);
		bind('runbun-battle-apply', runApplySelected);
		bind('runbun-battle-advance', runAdvanceTurn);
		bind('runbun-battle-loop', runChooseApplyAdvance);
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}
})();
