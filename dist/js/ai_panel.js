/* eslint-env browser, jquery, es6 */
(function () {
	'use strict';

	/** Parent-workspace AI policy doc; cite by section + line for Explain UX. */
	var AI_DOC = {
		path: '../run_and_bun_ai.MD',
		label: 'run_and_bun_ai.MD',
	};

	/**
	 * Map score reason / fact keywords → policy-doc sections.
	 * Order: most-specific phrases first. Line numbers track the parent doc;
	 * citations are keyword/fact-driven — never parsed from calc kochance strings.
	 */
	var DOC_CITATIONS = [
		{pattern: /priority survival/i, section: 'Damaging priority moves', line: 82},
		{pattern: /trapping move/i, section: 'Damaging Trapping moves', line: 86},
		{pattern: /speed-drop move/i, section: 'Damaging speed reduction moves', line: 89},
		{pattern: /guaranteed stat-drop/i, section: 'Damaging Atk/SpAtk reduction (guaranteed)', line: 101},
		{pattern: /Acid Spray/i, section: 'Damaging -2 SpDef reduction (Acid Spray)', line: 114},
		{pattern: /repeat Sucker Punch|Sucker Punch/i, section: 'Sucker Punch', line: 132},
		{pattern: /Pursuit/i, section: 'Pursuit', line: 137},
		{pattern: /Contrary setup/i, section: 'Contrary setup (Overheat / Leaf Storm / Superpower)', line: 559},
		{pattern: /high-crit super-effective/i, section: 'All damaging moves (high crit SE)', line: 68},
		{pattern: /partner Weakness Policy/i, section: 'Fling / partner priority specials', line: 208},
		{pattern: /special damaging-move/i, section: 'Special damaging-move rules (Fling / Fake Out / …)', line: 118},
		{pattern: /ally Ground-move/i, section: 'Magnitude, Earthquake', line: 229},
		{pattern: /Protect scoring|Protect context|repeat-Protect/i, section: 'Protect, King\'s Shield', line: 186},
		{pattern: /field-speed setup|Tailwind/i, section: 'Tailwind', line: 261},
		{pattern: /Trick Room/i, section: 'Trick Room', line: 267},
		{pattern: /default non-damaging move score/i, section: 'Default non-attacking move score (+6)', line: 14},
		{pattern: /recovery is discouraged|recovery/i, section: 'Recovery moves', line: 586},
		{pattern: /eligible hard switch|switch conditions|forced replacement|replacement score|hard switch/i, section: 'Switch AI', line: 29},
		{pattern: /Stealth Rock/i, section: 'Stealth Rock', line: 165},
		{pattern: /Sticky Web/i, section: 'Sticky Web', line: 180},
		{pattern: /Toxic Spikes|Spikes|hazard/i, section: 'Spikes / Toxic Spikes', line: 171},
		{pattern: /KO ability bonus/i, section: 'All damaging moves (KO ability bonus)', line: 64},
		{pattern: /can KO the target/i, section: 'All damaging moves (kill bonuses)', line: 58},
		{pattern: /highest damaging move or a move that can KO/i, section: 'All damaging moves', line: 50},
		{pattern: /not the highest damaging|target is immune/i, section: 'All damaging moves', line: 50},
		{pattern: /Dragon Dance|Calm Mind|setup stats|opponent can KO before setup/i, section: 'General setup', line: 416},
		{pattern: /immune to this status|already has a major status|sleep|Yawn|Toxic|Will-O-Wisp|Thunder Wave/i, section: 'Status moves (general notes)', line: 14},
	];

	/** Bucket labels for structured Explain (display only; no new scoring). */
	var EXPLAIN_BUCKETS = [
		{
			id: 'damage',
			label: 'Damage / KO',
			reasonPatterns: [
				/highest damaging|can KO|not the highest|target is immune|KO ability|high-crit|trapping move|special damaging|guaranteed stat-drop|speed-drop|Pursuit|Sucker Punch|Contrary setup|ally Ground|partner Weakness/i,
			],
		},
		{
			id: 'speed',
			label: 'Speed / Priority',
			reasonPatterns: [/priority survival|field-speed setup|Tailwind|Trick Room/i],
		},
		{
			id: 'status',
			label: 'Status / Setup / Protect',
			reasonPatterns: [
				/Protect|default non-damaging|recovery|setup|status|immune to this|already has|Yawn|hazard|Stealth Rock|Sticky Web|Spikes/i,
			],
		},
		{
			id: 'switch',
			label: 'Switch',
			reasonPatterns: [/switch|forced replacement|replacement score/i],
		},
	];

	var FIXTURE_BASE = '/fixtures/ui';

	var DEFAULT_STATE = {
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
					moves: [{name: 'Thunderbolt'}, {name: 'Thunder Wave'}, {name: 'Protect'}, {name: 'Volt Switch'}],
				}],
			},
			player: {
				activeIds: ['player-1'],
				party: [{
					id: 'player-1',
					species: 'Gyarados',
					level: 100,
					hp: {current: 200, max: 200},
					moves: [{name: 'Waterfall'}, {name: 'Earthquake'}, {name: 'Dragon Dance'}, {name: 'Ice Fang'}],
				}],
			},
		},
		firstTurnOutIds: ['ai-1', 'player-1'],
	};

	/** Inline fallback if /fixtures/ui/manifest.json is unreachable. */
	var FALLBACK_SCENARIOS = [
		{id: 'sample', label: 'Sample Singles (Pikachu vs Gyarados)', state: DEFAULT_STATE},
	];

	var fixtureManifest = null;
	var currentFixtureId = 'sample';
	var lastEvaluations = null;
	var syncingFields = false;

	function $(id) {
		return document.getElementById(id);
	}

	function setBusy(busy) {
		var root = $('ai-panel');
		if (!root) return;
		if (busy) root.setAttribute('aria-busy', 'true');
		else root.removeAttribute('aria-busy');
		[
			'ai-panel-evaluate',
			'ai-panel-choose',
			'ai-panel-compare-golden',
			'ai-panel-debug-loop',
			'ai-panel-validate',
			'ai-panel-load-scenario',
			'ai-panel-load-calc',
		].forEach(function (id) {
			var btn = $(id);
			if (btn) btn.disabled = !!busy;
		});
	}

	function setStatus(message, isError) {
		var el = $('ai-panel-status');
		if (!el) return;
		el.textContent = message || '';
		el.className = isError ? 'ai-panel-status ai-panel-error' : 'ai-panel-status';
		el.setAttribute('aria-live', isError ? 'assertive' : 'polite');
	}

	function setGoldenStatus(message, tone) {
		var el = $('ai-panel-golden-status');
		if (!el) return;
		el.textContent = message || '';
		var cls = 'ai-panel-golden-status';
		if (tone === 'ok') cls += ' ai-panel-golden-ok';
		else if (tone === 'fail') cls += ' ai-panel-golden-fail';
		else if (tone === 'muted') cls += ' ai-panel-golden-muted';
		el.className = cls;
	}

	function scenarioList() {
		if (fixtureManifest && Array.isArray(fixtureManifest.scenarios)) {
			return fixtureManifest.scenarios;
		}
		return FALLBACK_SCENARIOS;
	}

	function findScenario(id) {
		var list = scenarioList();
		for (var i = 0; i < list.length; i++) {
			if (list[i].id === id) return list[i];
		}
		return list[0] || null;
	}

	function applyScenarioOptions(scenario) {
		var options = (scenario && scenario.defaultOptions) || {};
		var side = $('ai-panel-side');
		if (side && (options.sideId === 'ai' || options.sideId === 'player')) {
			side.value = options.sideId;
		}
		var switches = $('ai-panel-include-switches');
		if (switches && typeof options.includeSwitches === 'boolean') {
			switches.checked = options.includeSwitches;
		}
	}

	function fetchJson(url) {
		return fetch(url, {headers: {accept: 'application/json'}}).then(function (response) {
			if (!response.ok) {
				throw new Error('HTTP ' + response.status + ' for ' + url);
			}
			return response.json();
		});
	}

	function parseState() {
		var raw = $('ai-panel-state').value;
		try {
			return JSON.parse(raw);
		} catch (error) {
			throw new Error('Battle state JSON is invalid: ' + (error && error.message ? error.message : error));
		}
	}

	function cloneState(state) {
		return JSON.parse(JSON.stringify(state));
	}

	function activePokemon(state, sideId) {
		var side = state && state.sides && state.sides[sideId];
		if (!side || !Array.isArray(side.party) || !side.party.length) return null;
		var activeId = side.activeIds && side.activeIds[0];
		if (activeId) {
			for (var i = 0; i < side.party.length; i++) {
				if (side.party[i] && side.party[i].id === activeId) return side.party[i];
			}
		}
		return side.party[0] || null;
	}

	function setInputValue(id, value) {
		var el = $(id);
		if (!el) return;
		el.value = value === undefined || value === null ? '' : String(value);
	}

	function readNumber(id, fallback) {
		var el = $(id);
		if (!el || el.value === '') return fallback;
		var value = Number(el.value);
		return Number.isFinite(value) ? value : fallback;
	}

	function syncFieldsFromState(state) {
		if (!state) return;
		syncingFields = true;
		try {
			setInputValue('ai-panel-field-generation', state.generation != null ? state.generation : 8);
			var mode = state.mode === 'Doubles' ? 'Doubles' : 'Singles';
			setInputValue('ai-panel-field-mode', mode);
			setInputValue('ai-panel-field-turn', state.turn != null ? state.turn : 1);

			['ai', 'player'].forEach(function (sideId) {
				var mon = activePokemon(state, sideId);
				var speciesEl = $(sideId === 'ai' ? 'ai-panel-ai-species' : 'ai-panel-player-species');
				if (speciesEl) {
					speciesEl.textContent = mon && mon.species ?
						mon.species + (mon.id ? ' (' + mon.id + ')' : '') :
						'(none)';
				}
				var prefix = sideId === 'ai' ? 'ai-panel-ai-hp' : 'ai-panel-player-hp';
				setInputValue(prefix + '-current', mon && mon.hp ? mon.hp.current : '');
				setInputValue(prefix + '-max', mon && mon.hp ? mon.hp.max : '');
			});
		} finally {
			syncingFields = false;
		}
	}

	function applyFieldsToState(state) {
		var next = cloneState(state);
		var generation = readNumber('ai-panel-field-generation', next.generation || 8);
		next.generation = Math.max(1, Math.floor(generation));
		var modeEl = $('ai-panel-field-mode');
		next.mode = modeEl && modeEl.value === 'Doubles' ? 'Doubles' : 'Singles';
		var turn = readNumber('ai-panel-field-turn', next.turn || 1);
		next.turn = Math.max(1, Math.floor(turn));

		['ai', 'player'].forEach(function (sideId) {
			var mon = activePokemon(next, sideId);
			if (!mon) return;
			if (!mon.hp) mon.hp = {current: 0, max: 1};
			var prefix = sideId === 'ai' ? 'ai-panel-ai-hp' : 'ai-panel-player-hp';
			var maxHp = Math.max(1, Math.floor(readNumber(prefix + '-max', mon.hp.max || 1)));
			var current = Math.floor(readNumber(prefix + '-current', mon.hp.current || 0));
			mon.hp.max = maxHp;
			mon.hp.current = Math.max(0, Math.min(maxHp, current));
		});
		return next;
	}

	function writeState(state) {
		$('ai-panel-state').value = JSON.stringify(state, null, 2);
		syncFieldsFromState(state);
	}

	function applyStructuredFields() {
		var state;
		try {
			state = parseState();
		} catch (error) {
			setStatus(error.message, true);
			return;
		}
		writeState(applyFieldsToState(state));
		setStatus('Applied structured fields into BattleState JSON.');
	}

	function syncStructuredFromJson() {
		var state;
		try {
			state = parseState();
		} catch (error) {
			setStatus(error.message, true);
			return;
		}
		syncFieldsFromState(state);
		setStatus('Synced structured fields from JSON.');
	}

	function formatAction(action) {
		if (!action) return '(none)';
		if (action.kind === 'switch') {
			return 'switch → ' + action.replacementId + (action.forced ? ' (forced)' : '');
		}
		if (action.kind === 'move') {
			var targets = (action.targetIds || []).join(', ');
			return action.moveName + (targets ? ' → ' + targets : '');
		}
		return JSON.stringify(action);
	}

	function outcomeScores(evaluation) {
		if (!evaluation || !Array.isArray(evaluation.outcomes)) return [];
		return evaluation.outcomes
			.map(function (outcome) { return outcome && typeof outcome.score === 'number' ? outcome.score : null; })
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

	function formatDamage(facts) {
		if (!facts || !facts.damage) return null;
		var d = facts.damage;
		var text = d.min + '–' + d.max + ' / ' + d.targetHp + ' HP';
		if (d.guaranteedKO) text += ' (guaranteed KO)';
		else if (d.possibleKO) text += ' (possible KO)';
		return text;
	}

	function hasOwn(obj, key) {
		return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
	}

	function factsPresent(facts) {
		if (!facts || typeof facts !== 'object') return false;
		return Object.keys(facts).length > 0;
	}

	function citeForText(text) {
		if (!text) return null;
		for (var i = 0; i < DOC_CITATIONS.length; i++) {
			if (DOC_CITATIONS[i].pattern.test(text)) {
				return {
					section: DOC_CITATIONS[i].section,
					line: DOC_CITATIONS[i].line,
					href: AI_DOC.path + '#L' + DOC_CITATIONS[i].line,
					matched: text,
				};
			}
		}
		return null;
	}

	function collectCitations(evaluation) {
		var seen = {};
		var cites = [];
		function addFrom(text, source) {
			var cite = citeForText(text);
			if (!cite) return;
			var key = cite.section + ':' + cite.line;
			if (seen[key]) return;
			seen[key] = true;
			cites.push({
				section: cite.section,
				line: cite.line,
				href: cite.href,
				source: source || 'reason',
				matched: cite.matched,
			});
		}
		if (Array.isArray(evaluation.reasons)) {
			evaluation.reasons.forEach(function (reason) {
				addFrom(reason, 'reason');
			});
		}
		var facts = evaluation.facts || {};
		if (facts.damage && (facts.damage.possibleKO || facts.damage.guaranteedKO)) {
			addFrom('can KO the target', 'fact');
		}
		if (facts.damage && facts.damage.max === 0) {
			addFrom('target is immune', 'fact');
		}
		if (facts.isHighCrit && facts.isSuperEffective) {
			addFrom('high-crit super-effective chance', 'fact');
		}
		if (facts.moveCategory === 'Status') {
			addFrom('default non-damaging move score', 'fact');
		}
		if (evaluation.action && evaluation.action.kind === 'switch') {
			addFrom('hard switch', 'action');
		}
		if (typeof facts.priority === 'number' && facts.priority > 0 && facts.opponentCanKO) {
			addFrom('priority survival', 'fact');
		}
		return cites;
	}

	function bucketForReason(reason) {
		if (!reason) return 'other';
		for (var i = 0; i < EXPLAIN_BUCKETS.length; i++) {
			var patterns = EXPLAIN_BUCKETS[i].reasonPatterns;
			for (var j = 0; j < patterns.length; j++) {
				if (patterns[j].test(reason)) return EXPLAIN_BUCKETS[i].id;
			}
		}
		return 'other';
	}

	function formatOutcomes(evaluation) {
		if (!evaluation || !Array.isArray(evaluation.outcomes) || !evaluation.outcomes.length) {
			return [];
		}
		return evaluation.outcomes.map(function (outcome) {
			if (!outcome || typeof outcome.score !== 'number') return null;
			var pct = typeof outcome.probability === 'number' ?
				Math.round(outcome.probability * 1000) / 10 + '%' : '?';
			return 'score ' + outcome.score + ' @ ' + pct;
		}).filter(Boolean);
	}

	function damageFactItems(facts) {
		var items = [];
		var damage = formatDamage(facts);
		if (damage) {
			items.push({
				text: 'damage rolls: ' + damage,
				cite: citeForText(facts.damage && facts.damage.possibleKO ?
					'can KO the target' : 'highest damaging move or a move that can KO'),
			});
		} else if (facts && (facts.moveCategory === 'Physical' || facts.moveCategory === 'Special')) {
			items.push({
				text: 'damage facts missing (evaluate response had no damage block)',
				cite: null,
				missing: true,
			});
		}
		if (facts && facts.isImmune) {
			items.push({text: 'type / immunity: immune', cite: citeForText('target is immune')});
		}
		if (facts && facts.isSuperEffective) {
			items.push({text: 'matchup: super effective', cite: null});
		}
		if (facts && facts.isHighCrit) {
			items.push({
				text: 'high critical-hit stage on this move',
				cite: citeForText('high-crit super-effective chance'),
			});
		}
		if (facts && facts.isMultiHit) {
			items.push({text: 'multi-hit move (calculator fact)', cite: null});
		}
		if (facts && facts.criticalHitGuaranteed) {
			items.push({text: 'critical hit guaranteed this turn', cite: null});
		}
		return items;
	}

	function speedFactItems(facts) {
		var items = [];
		if (!facts) return items;
		if (typeof facts.priority === 'number') {
			items.push({
				text: 'priority: ' + facts.priority,
				cite: facts.priority > 0 && facts.opponentCanKO ?
					citeForText('priority survival') : null,
			});
		}
		if (typeof facts.attackerSpeed === 'number' && typeof facts.defenderSpeed === 'number') {
			var cmp = facts.attackerSpeed > facts.defenderSpeed ? 'faster' :
				facts.attackerSpeed < facts.defenderSpeed ? 'slower' : 'speed tie (AI treats as faster)';
			items.push({
				text: 'speed: ' + facts.attackerSpeed + ' vs ' + facts.defenderSpeed + ' (' + cmp + ')',
				cite: null,
			});
		} else if (typeof facts.attackerSpeed === 'number' || typeof facts.defenderSpeed === 'number') {
			items.push({
				text: 'speed facts incomplete (attacker=' +
					(typeof facts.attackerSpeed === 'number' ? facts.attackerSpeed : '—') +
					', defender=' +
					(typeof facts.defenderSpeed === 'number' ? facts.defenderSpeed : '—') + ')',
				cite: null,
				missing: true,
			});
		}
		return items;
	}

	function threatFactItems(facts) {
		var items = [];
		if (!facts) return items;
		if (hasOwn(facts, 'opponentCanKO')) {
			items.push({
				text: facts.opponentCanKO ? 'opponent can KO this turn' : 'opponent cannot KO this turn',
				cite: facts.opponentCanKO ? citeForText('Protect scoring rule') : null,
			});
		}
		if (hasOwn(facts, 'opponentCan2HKO')) {
			items.push({
				text: facts.opponentCan2HKO ? 'opponent can 2HKO' : 'opponent cannot 2HKO',
				cite: facts.opponentCan2HKO ? citeForText('setup stats') : null,
			});
		}
		if (typeof facts.opponentMaxDamage === 'number') {
			items.push({text: 'incoming max damage: ' + facts.opponentMaxDamage, cite: null});
		}
		return items;
	}

	function contextFactItems(evaluation) {
		var facts = evaluation && evaluation.facts ? evaluation.facts : {};
		var items = [];
		if (facts.moveCategory) items.push({text: 'category: ' + facts.moveCategory, cite: null});
		if (facts.moveType) items.push({text: 'type: ' + facts.moveType, cite: null});
		if (facts.attackerSpecies || facts.defenderSpecies) {
			items.push({
				text: 'species: ' + (facts.attackerSpecies || '?') + ' → ' + (facts.defenderSpecies || '?'),
				cite: null,
			});
		}
		if (facts.attackerAbility) items.push({text: 'attacker ability: ' + facts.attackerAbility, cite: null});
		if (facts.defenderAbility) items.push({text: 'defender ability: ' + facts.defenderAbility, cite: null});
		if (facts.attackerItem) items.push({text: 'attacker item: ' + facts.attackerItem, cite: null});
		if (facts.defenderStatus) items.push({text: 'defender status: ' + facts.defenderStatus, cite: null});
		if (hasOwn(facts, 'isFirstTurnOut')) {
			items.push({text: 'first turn out: ' + (facts.isFirstTurnOut ? 'yes' : 'no'), cite: null});
		}
		if (evaluation && evaluation.action && evaluation.action.kind === 'switch' && !factsPresent(facts)) {
			items.push({
				text: 'no ActionFacts on this switch — score uses eligibility / replacement scores only',
				cite: citeForText('hard switch'),
				missing: true,
			});
		}
		return items;
	}

	function honestyNotes(evaluation) {
		var notes = [];
		var facts = evaluation && evaluation.facts ? evaluation.facts : {};
		var reasons = evaluation && Array.isArray(evaluation.reasons) ? evaluation.reasons : [];
		if (!reasons.length) {
			notes.push('Engine returned no score reasons for this action.');
		}
		if (evaluation && evaluation.action && evaluation.action.kind === 'move' && !factsPresent(facts)) {
			notes.push('ActionFacts missing from evaluate-actions response.');
		}
		if (factsPresent(facts) && !hasOwn(facts, 'damage') &&
			(facts.moveCategory === 'Physical' || facts.moveCategory === 'Special')) {
			notes.push('Damaging category without a damage block — KO/range contribution unknown.');
		}
		notes.push('Explain mirrors evaluate-actions reasons/facts only; it does not rescore or parse calc kochance strings.');
		return notes;
	}

	function appendCite(parent, cite, options) {
		if (!cite) return;
		var opts = options || {};
		var span = document.createElement('span');
		span.className = opts.block ? 'ai-panel-cite ai-panel-cite-block' : 'ai-panel-cite';
		span.appendChild(document.createTextNode(opts.prefix || 'doc: '));
		var link = document.createElement('a');
		link.href = cite.href;
		link.target = '_blank';
		link.rel = 'noopener noreferrer';
		link.textContent = AI_DOC.label + ' — ' + cite.section + ' (≈L' + cite.line + ')';
		link.title = 'Policy citation (machine facts / reasons; not calc kochance strings)';
		span.appendChild(link);
		if (cite.source) {
			var src = document.createElement('span');
			src.className = 'ai-panel-cite-source';
			src.textContent = ' · via ' + cite.source;
			span.appendChild(src);
		}
		parent.appendChild(span);
	}

	function appendFactList(parent, title, items) {
		if (!items || !items.length) return;
		var section = document.createElement('div');
		section.className = 'ai-panel-explain-section';
		var heading = document.createElement('div');
		heading.className = 'ai-panel-explain-section-title';
		heading.textContent = title;
		section.appendChild(heading);
		var ul = document.createElement('ul');
		ul.className = 'ai-panel-explain-list';
		items.forEach(function (item) {
			var li = document.createElement('li');
			if (item.missing) li.className = 'ai-panel-explain-missing';
			li.appendChild(document.createTextNode(item.text));
			appendCite(li, item.cite);
			ul.appendChild(li);
		});
		section.appendChild(ul);
		parent.appendChild(section);
	}

	function renderExplainDetail(evaluation, detail) {
		detail.innerHTML = '';
		if (detail.className.indexOf('ai-panel-explain') === -1) {
			detail.className = (detail.className ? detail.className + ' ' : '') + 'ai-panel-explain';
		}

		var engine = document.createElement('div');
		engine.className = 'ai-panel-explain-engine';
		var engineTitle = document.createElement('div');
		engineTitle.className = 'ai-panel-explain-col-title';
		engineTitle.textContent = 'Engine scored';
		engine.appendChild(engineTitle);

		var outcomes = formatOutcomes(evaluation);
		if (outcomes.length) {
			var scoreBox = document.createElement('div');
			scoreBox.className = 'ai-panel-explain-score';
			scoreBox.textContent = outcomes.join(' · ');
			engine.appendChild(scoreBox);
		} else {
			var noScore = document.createElement('div');
			noScore.className = 'ai-panel-explain-empty';
			noScore.textContent = 'No score outcomes on this evaluation.';
			engine.appendChild(noScore);
		}

		var reasons = evaluation && Array.isArray(evaluation.reasons) ? evaluation.reasons.filter(Boolean) : [];
		var byBucket = {};
		EXPLAIN_BUCKETS.forEach(function (bucket) { byBucket[bucket.id] = []; });
		byBucket.other = [];
		reasons.forEach(function (reason) {
			byBucket[bucketForReason(reason)].push({
				text: reason,
				cite: citeForText(reason),
			});
		});
		EXPLAIN_BUCKETS.forEach(function (bucket) {
			appendFactList(engine, 'Reasons · ' + bucket.label, byBucket[bucket.id]);
		});
		appendFactList(engine, 'Reasons · Other', byBucket.other);

		var facts = evaluation && evaluation.facts ? evaluation.facts : {};
		appendFactList(engine, 'Facts · Damage / KO', damageFactItems(facts));
		appendFactList(engine, 'Facts · Speed / Priority', speedFactItems(facts));
		appendFactList(engine, 'Facts · Incoming threat', threatFactItems(facts));
		appendFactList(engine, 'Facts · Context', contextFactItems(evaluation));

		var notes = honestyNotes(evaluation);
		if (notes.length) {
			var noteBox = document.createElement('div');
			noteBox.className = 'ai-panel-explain-honesty';
			notes.forEach(function (note) {
				var p = document.createElement('div');
				p.textContent = note;
				noteBox.appendChild(p);
			});
			engine.appendChild(noteBox);
		}

		var doc = document.createElement('div');
		doc.className = 'ai-panel-explain-doc';
		var docTitle = document.createElement('div');
		docTitle.className = 'ai-panel-explain-col-title';
		docTitle.textContent = 'Policy doc says';
		doc.appendChild(docTitle);
		var cites = collectCitations(evaluation || {});
		if (!cites.length) {
			var empty = document.createElement('div');
			empty.className = 'ai-panel-explain-empty';
			empty.textContent = reasons.length ?
				'No citation map match for these reason phrases yet (EXP-02 gaps).' :
				'No reasons/facts available to cite against ' + AI_DOC.label + '.';
			doc.appendChild(empty);
		} else {
			var citeBox = document.createElement('div');
			citeBox.className = 'ai-panel-cites';
			cites.forEach(function (cite) {
				var row = document.createElement('div');
				row.className = 'ai-panel-cite-row';
				appendCite(row, cite, {block: true, prefix: ''});
				if (cite.matched) {
					var matched = document.createElement('div');
					matched.className = 'ai-panel-cite-matched';
					matched.textContent = 'matched: “' + cite.matched + '”';
					row.appendChild(matched);
				}
				citeBox.appendChild(row);
			});
			doc.appendChild(citeBox);
		}

		if (!reasons.length && !factsPresent(facts) && !outcomes.length) {
			var blank = document.createElement('div');
			blank.className = 'ai-panel-explain-empty';
			blank.textContent = 'No score reasons or ActionFacts for this action.';
			engine.appendChild(blank);
		}

		detail.appendChild(engine);
		detail.appendChild(doc);
	}

	function bindResultsKeyboard(list) {
		if (!list || list.dataset.rbA11yBound === '1') return;
		list.dataset.rbA11yBound = '1';
		list.addEventListener('keydown', function (event) {
			if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' &&
				event.key !== 'Home' && event.key !== 'End') {
				return;
			}
			var rows = Array.prototype.slice.call(list.querySelectorAll('.ai-panel-result-row'));
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

	function renderEvaluations(evaluations, selectedAction) {
		var list = $('ai-panel-results');
		if (!list) return;
		list.innerHTML = '';
		bindResultsKeyboard(list);
		if (!Array.isArray(evaluations) || !evaluations.length) {
			list.textContent = 'No legal actions returned.';
			return;
		}
		var ranked = evaluations.slice().sort(function (left, right) {
			return bestScore(right) - bestScore(left);
		});
		var selectedKey = selectedAction ? JSON.stringify(selectedAction) : '';
		ranked.forEach(function (evaluation, index) {
			var block = document.createElement('div');
			block.className = 'ai-panel-result-block';
			block.setAttribute('role', 'listitem');
			var row = document.createElement('button');
			row.type = 'button';
			row.className = 'ai-panel-result-row';
			row.setAttribute('aria-expanded', 'false');
			var actionLabel = formatAction(evaluation.action);
			var scoreText = formatScore(evaluation);
			row.setAttribute('aria-label',
				'Rank ' + (index + 1) + ', ' + actionLabel + ', score ' + scoreText +
				'. Activate to toggle Explain.');
			if (selectedKey && JSON.stringify(evaluation.action) === selectedKey) {
				row.className += ' ai-panel-selected';
			}
			var rank = document.createElement('span');
			rank.className = 'ai-panel-rank';
			rank.textContent = String(index + 1);
			rank.setAttribute('aria-hidden', 'true');
			var action = document.createElement('span');
			action.className = 'ai-panel-action';
			action.textContent = actionLabel;
			var score = document.createElement('span');
			score.className = 'ai-panel-score';
			score.textContent = scoreText;
			row.appendChild(rank);
			row.appendChild(action);
			row.appendChild(score);

			var detail = document.createElement('div');
			detail.className = 'ai-panel-result-detail ai-panel-explain';
			detail.hidden = true;
			detail.id = 'ai-panel-explain-' + index;
			row.setAttribute('aria-controls', detail.id);
			renderExplainDetail(evaluation, detail);
			row.addEventListener('click', function () {
				detail.hidden = !detail.hidden;
				row.classList.toggle('ai-panel-expanded', !detail.hidden);
				row.setAttribute('aria-expanded', detail.hidden ? 'false' : 'true');
			});
			block.appendChild(row);
			block.appendChild(detail);
			list.appendChild(block);
		});
	}

	/** Shared Explain renderer for Battle (and other thin clients). */
	window.RunBunExplain = {
		renderDetail: renderExplainDetail,
		citeForText: citeForText,
		collectCitations: collectCitations,
	};

	function postAi(path, body) {
		return fetch(path, {
			method: 'POST',
			headers: {'content-type': 'application/json'},
			body: JSON.stringify(body),
		}).then(function (response) {
			return response.json().then(function (payload) {
				return {status: response.status, body: payload};
			});
		});
	}

	function requestOptions() {
		return {
			sideId: ($('ai-panel-side') && $('ai-panel-side').value) || 'ai',
			includeSwitches: !!($('ai-panel-include-switches') && $('ai-panel-include-switches').checked),
		};
	}

	function formatHttpError(result) {
		var body = result.body || {};
		var message = body.error || JSON.stringify(body);
		return 'HTTP ' + result.status + ': ' + message;
	}

	function flashBridgeCallouts() {
		var root = $('ai-panel-bridge-callouts');
		if (!root) return;
		var reduceMotion = !!(window.matchMedia &&
			window.matchMedia('(prefers-reduced-motion: reduce)').matches);
		Array.prototype.forEach.call(root.querySelectorAll('.ai-panel-callout'), function (node) {
			node.classList.remove('ai-panel-callout-flash');
			if (reduceMotion) {
				node.classList.add('ai-panel-callout-flash');
				return;
			}
			// Force reflow so the flash class can re-trigger.
			void node.offsetWidth;
			node.classList.add('ai-panel-callout-flash');
		});
		if (reduceMotion) return;
		window.setTimeout(function () {
			Array.prototype.forEach.call(root.querySelectorAll('.ai-panel-callout'), function (node) {
				node.classList.remove('ai-panel-callout-flash');
			});
		}, 1600);
	}

	function bridgeCalloutSummary() {
		if (window.RunBunSetsBridge && typeof window.RunBunSetsBridge.projectionCallouts === 'function') {
			return window.RunBunSetsBridge.projectionCallouts().map(function (item) {
				return item.summary || item.text;
			}).join(' ');
		}
		return 'Gen 8 BattleState; EVs forced to 0 for AI projections.';
	}

	function runEvaluate(options) {
		var opts = options || {};
		setStatus('Evaluating…');
		if (!opts.keepGolden) setGoldenStatus('', 'muted');
		var state;
		try {
			state = parseState();
		} catch (error) {
			setStatus(error.message, true);
			return Promise.resolve(null);
		}
		setBusy(true);
		return postAi('/ai/evaluate-actions', {state: state, options: requestOptions()}).then(function (result) {
			if (result.status >= 400) {
				setStatus(formatHttpError(result), true);
				renderEvaluations([]);
				lastEvaluations = null;
				return null;
			}
			lastEvaluations = result.body.evaluations || [];
			renderEvaluations(lastEvaluations);
			setStatus('Evaluated ' + lastEvaluations.length +
				' legal action(s). Click a row for Explain (reasons · facts · policy doc).');
			return lastEvaluations;
		}).catch(function (error) {
			setStatus('Request failed. Is node server.js running? ' + (error && error.message ? error.message : error), true);
			lastEvaluations = null;
			return null;
		}).then(function (value) {
			setBusy(false);
			return value;
		});
	}

	function compareCurrentGolden() {
		var goldenApi = window.RunBunGoldenEval;
		if (!goldenApi || typeof goldenApi.toSnapshot !== 'function') {
			setGoldenStatus('Golden helper not loaded (golden_eval.js).', 'fail');
			return;
		}
		var scenario = findScenario(currentFixtureId);
		if (!scenario || !scenario.golden) {
			setGoldenStatus('No golden registered for fixture "' + currentFixtureId + '".', 'muted');
			return;
		}
		setGoldenStatus('Comparing golden…', 'muted');
		var evaluatePromise = lastEvaluations ?
			Promise.resolve(lastEvaluations) :
			runEvaluate({keepGolden: true});
		evaluatePromise.then(function (evaluations) {
			if (!evaluations) return null;
			return fetchJson(FIXTURE_BASE + '/' + scenario.golden).then(function (expected) {
				var options = requestOptions();
				var actual = goldenApi.toSnapshot(evaluations, {
					fixtureId: currentFixtureId,
					options: {
						sideId: options.sideId,
						includeSwitches: options.includeSwitches,
					},
				});
				var result = goldenApi.compareSnapshots(expected, actual);
				if (result.ok) {
					setGoldenStatus(result.summary, 'ok');
					setStatus('Evaluate OK; ' + result.summary);
				} else {
					var detail = typeof goldenApi.formatDiffs === 'function' ?
						goldenApi.formatDiffs(result.diffs, 4) :
						'';
					setGoldenStatus(result.summary + (detail ? '\n' + detail : ''), 'fail');
					setStatus('Evaluate returned actions; golden compare failed (facts/reasons only).', true);
				}
				return result;
			});
		}).catch(function (error) {
			setGoldenStatus('Golden compare failed: ' + (error && error.message ? error.message : error), 'fail');
		});
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
		setBusy(true);
		postAi('/ai/choose-action', {state: state, options: requestOptions()}).then(function (result) {
			if (result.status >= 400) {
				setStatus(formatHttpError(result), true);
				renderEvaluations([]);
				return;
			}
			renderEvaluations(result.body.evaluations || [], result.body.action);
			var chosen = formatAction(result.body.action);
			var selected = typeof result.body.selectedScore === 'number' ?
				' (score ' + result.body.selectedScore + ')' :
				'';
			setStatus('Chose ' + chosen + selected + '. Click a row for Explain (reasons · facts · policy doc).');
		}).catch(function (error) {
			setStatus('Request failed. Is node server.js running? ' + (error && error.message ? error.message : error), true);
		}).then(function () { setBusy(false); });
	}

	function runDebugStep(step) {
		setStatus(step + '…');
		var state;
		try {
			state = parseState();
		} catch (error) {
			setStatus(error.message, true);
			return;
		}
		var options = requestOptions();
		setBusy(true);
		postAi('/ai/choose-action', {state: state, options: options}).then(function (choice) {
			if (choice.status >= 400) {
				setStatus(formatHttpError(choice), true);
				return;
			}
			var action = choice.body.action;
			renderEvaluations(choice.body.evaluations || [], action);
			if (!action || action.kind !== 'move') {
				setStatus('Chose non-move action ' + formatAction(action) + '; debug loop stops after choose.');
				return;
			}
			return postAi('/ai/derive-resolution', {state: state, action: action}).then(function (derived) {
				if (derived.status >= 400) {
					setStatus(formatHttpError(derived) + ' (derive-resolution)', true);
					return;
				}
				return postAi('/ai/apply-action', {
					state: state,
					action: action,
					resolution: derived.body,
				}).then(function (applied) {
					if (applied.status >= 400) {
						setStatus(formatHttpError(applied) + ' (apply-action)', true);
						return;
					}
					return postAi('/ai/advance-turn', {state: applied.body}).then(function (advanced) {
						if (advanced.status >= 400) {
							setStatus(formatHttpError(advanced) + ' (advance-turn)', true);
							return;
						}
						writeState(advanced.body);
						setStatus('Debug loop: chose ' + formatAction(action) +
							', applied modeled resolution, advanced turn residuals. ' +
							'Unmodeled accuracy / external events remain caller-owned.');
					});
				});
			});
		}).catch(function (error) {
			setStatus('Debug loop failed. Is node server.js running? ' + (error && error.message ? error.message : error), true);
		}).then(function () { setBusy(false); });
	}

	function runValidate() {
		setStatus('Validating BattleState…');
		var state;
		try {
			state = parseState();
		} catch (error) {
			setStatus(error.message, true);
			return;
		}
		setBusy(true);
		postAi('/ai/validate-battle-state', {state: state}).then(function (result) {
			if (result.status >= 400) {
				setStatus(formatHttpError(result), true);
				return;
			}
			setStatus('BattleState is valid (Gen ' + (state.generation || '?') + ', ' + (state.mode || '?') + ').');
		}).catch(function (error) {
			setStatus('Validate failed. Is node server.js running? ' + (error && error.message ? error.message : error), true);
		}).then(function () { setBusy(false); });
	}

	function loadScenario(key) {
		var scenario = findScenario(key) || findScenario('sample');
		if (!scenario) {
			setStatus('No fixtures available.', true);
			return;
		}
		currentFixtureId = scenario.id;
		var select = $('ai-panel-scenario');
		if (select) select.value = scenario.id;
		applyScenarioOptions(scenario);
		lastEvaluations = null;
		setGoldenStatus(scenario.golden ? 'Golden available — Evaluate or Compare golden.' : 'No golden for this fixture.', 'muted');
		renderEvaluations([]);

		if (scenario.state) {
			writeState(cloneState(scenario.state));
			setStatus('Loaded fallback scenario: ' + scenario.label + '. Validating…');
			postAi('/ai/validate-battle-state', {state: scenario.state}).then(function (result) {
				if (result.status >= 400) {
					setStatus(formatHttpError(result) + ' — fixture is in the editor for fixes.', true);
					return;
				}
				setStatus('Loaded fixture: ' + scenario.label + ' (valid).');
			}).catch(function (error) {
				setStatus('Fixture written, but validate request failed: ' +
					(error && error.message ? error.message : error), true);
			});
			return;
		}

		setStatus('Loading fixture: ' + scenario.label + '…');
		fetchJson(FIXTURE_BASE + '/' + scenario.file).then(function (state) {
			if (!state || typeof state !== 'object' || !state.sides) {
				throw new Error('Fixture must be a BattleState object with sides.');
			}
			writeState(state);
			setStatus('Loaded fixture: ' + scenario.label + '. Validating…');
			return postAi('/ai/validate-battle-state', {state: state}).then(function (result) {
				if (result.status >= 400) {
					setStatus(formatHttpError(result) + ' — fixture is in the editor for fixes.', true);
					return;
				}
				setStatus('Loaded fixture: ' + scenario.label +
					' (Gen ' + (state.generation || '?') + ', ' + (state.mode || '?') + '). Valid.');
			});
		}).catch(function (error) {
			setStatus('Could not load fixture "' + scenario.id + '": ' +
				(error && error.message ? error.message : error) +
				'. Is node server.js serving /fixtures?', true);
		});
	}

	function resetState() {
		loadScenario((fixtureManifest && fixtureManifest.defaultId) || 'sample');
	}

	function exportState() {
		var state;
		try {
			state = parseState();
		} catch (error) {
			setStatus(error.message, true);
			return;
		}
		var blob = new Blob([JSON.stringify(state, null, 2) + '\n'], {type: 'application/json'});
		var url = URL.createObjectURL(blob);
		var anchor = document.createElement('a');
		var gen = state.generation != null ? state.generation : 'x';
		var turn = state.turn != null ? state.turn : 1;
		anchor.href = url;
		anchor.download = 'battle-state-gen' + gen + '-t' + turn + '.json';
		document.body.appendChild(anchor);
		anchor.click();
		document.body.removeChild(anchor);
		URL.revokeObjectURL(url);
		setStatus('Exported current BattleState JSON.');
	}

	function loadFixtureFile(file) {
		if (!file) return;
		var reader = new FileReader();
		reader.onload = function () {
			var text = String(reader.result || '');
			var state;
			try {
				state = JSON.parse(text);
			} catch (error) {
				setStatus('Fixture JSON is invalid: ' + (error && error.message ? error.message : error), true);
				return;
			}
			if (!state || typeof state !== 'object' || !state.sides) {
				setStatus('Fixture must be a BattleState object with sides.', true);
				return;
			}
			writeState(state);
			renderEvaluations([]);
			setStatus('Loaded fixture "' + file.name + '". Validating…');
			postAi('/ai/validate-battle-state', {state: state}).then(function (result) {
				if (result.status >= 400) {
					setStatus(formatHttpError(result) + ' — fixture is in the editor for fixes.', true);
					return;
				}
				setStatus('Loaded fixture "' + file.name + '" (Gen ' +
					(state.generation || '?') + ', ' + (state.mode || '?') + '). Valid.');
			}).catch(function (error) {
				setStatus('Fixture written, but validate request failed: ' +
					(error && error.message ? error.message : error), true);
			});
		};
		reader.onerror = function () {
			setStatus('Could not read fixture file.', true);
		};
		reader.readAsText(file);
	}

	function renderBridgePreview(state) {
		var root = $('sets-bridge-preview');
		if (!root) return;
		root.innerHTML = '';
		if (!state || !state.sides) {
			var empty = document.createElement('p');
			empty.className = 'sets-bridge-preview-empty';
			empty.textContent = 'Load a calculator matchup to inspect its battle state.';
			root.appendChild(empty);
			return;
		}
		['player', 'ai'].forEach(function (sideId) {
			var side = state.sides[sideId];
			if (!side) return;
			var col = document.createElement('div');
			col.className = 'sets-bridge-preview-side';
			var heading = document.createElement('div');
			heading.className = 'sets-bridge-preview-side-label';
			heading.textContent = sideId;
			col.appendChild(heading);
			var active = {};
			(side.activeIds || []).forEach(function (id) { active[id] = true; });
			(side.party || []).forEach(function (mon) {
				var row = document.createElement('div');
				row.className = 'sets-bridge-preview-row' + (active[mon.id] ? ' is-active' : '');
				var hp = mon.hp || {};
				row.textContent = (mon.id || '?') + ' · ' + (mon.species || '?') +
					' · HP ' + (hp.current != null ? hp.current : '?') +
					'/' + (hp.max != null ? hp.max : '?') +
					(active[mon.id] ? ' · active' : '');
				col.appendChild(row);
			});
			if (!(side.party || []).length) {
				var none = document.createElement('div');
				none.className = 'sets-bridge-preview-row is-empty';
				none.textContent = '(empty party)';
				col.appendChild(none);
			}
			root.appendChild(col);
		});
	}

	function loadFromCalcPanels() {
		if (!window.RunBunSetsBridge || typeof window.RunBunSetsBridge.battleStateFromCalcPanels !== 'function') {
			setStatus('Sets bridge is not loaded (sets_to_battle_state.js).', true);
			return;
		}
		setStatus('Building BattleState from calc panels…');
		flashBridgeCallouts();
		var state;
		try {
			state = window.RunBunSetsBridge.battleStateFromCalcPanels({
				includePlayerTeam: !!($('ai-panel-include-player-team') && $('ai-panel-include-player-team').checked),
				includeTrainerParty: !!($('ai-panel-include-trainer-party') && $('ai-panel-include-trainer-party').checked),
			});
		} catch (error) {
			setStatus('Bridge failed: ' + (error && error.message ? error.message : error), true);
			renderBridgePreview(null);
			return;
		}
		writeState(state);
		renderBridgePreview(state);
		var aiCount = state.sides.ai.party.length;
		var playerCount = state.sides.player.party.length;
		setStatus('Built from panels (player ' + playerCount + ' / ai ' + aiCount + '). ' +
			bridgeCalloutSummary() + ' Validating…');
		postAi('/ai/validate-battle-state', {state: state}).then(function (result) {
			if (result.status >= 400) {
				setStatus(formatHttpError(result) + ' — state is in the editor for fixes.', true);
				return;
			}
			setStatus('Loaded from calc panels (player ' + playerCount + ', ai ' + aiCount + '). ' +
				bridgeCalloutSummary() + ' Valid. State is in AI Debug.');
			renderEvaluations([]);
		}).catch(function (error) {
			setStatus('State written, but validate request failed: ' +
				(error && error.message ? error.message : error), true);
		});
	}

	function fillScenarioSelect() {
		var select = $('ai-panel-scenario');
		if (!select) return;
		select.innerHTML = '';
		scenarioList().forEach(function (scenario) {
			var option = document.createElement('option');
			option.value = scenario.id;
			option.textContent = scenario.label + (scenario.golden ? ' ★' : '');
			select.appendChild(option);
		});
		if (currentFixtureId) select.value = currentFixtureId;
	}

	function loadFixtureManifest() {
		return fetchJson(FIXTURE_BASE + '/manifest.json').then(function (manifest) {
			if (!manifest || !Array.isArray(manifest.scenarios) || !manifest.scenarios.length) {
				throw new Error('manifest.scenarios missing');
			}
			fixtureManifest = manifest;
			currentFixtureId = manifest.defaultId || manifest.scenarios[0].id;
			fillScenarioSelect();
			return manifest;
		}).catch(function (error) {
			fixtureManifest = null;
			fillScenarioSelect();
			setStatus('Fixture manifest unavailable (' +
				(error && error.message ? error.message : error) +
				'); using inline sample fallback.', true);
			return null;
		});
	}

	function bindStructuredFieldListeners() {
		['ai-panel-field-generation', 'ai-panel-field-mode', 'ai-panel-field-turn',
			'ai-panel-ai-hp-current', 'ai-panel-ai-hp-max',
			'ai-panel-player-hp-current', 'ai-panel-player-hp-max'].forEach(function (id) {
			var el = $(id);
			if (!el) return;
			el.addEventListener('change', function () {
				if (syncingFields) return;
				applyStructuredFields();
			});
		});
		var textarea = $('ai-panel-state');
		if (textarea) {
			textarea.addEventListener('blur', function () {
				try {
					syncFieldsFromState(parseState());
				} catch (error) {
					// Leave fields alone until JSON is valid again.
				}
			});
		}
	}

	function init() {
		if (!$('ai-panel')) return;
		fillScenarioSelect();
		bindStructuredFieldListeners();
		$('ai-panel-evaluate').addEventListener('click', function () {
			runEvaluate().then(function (evaluations) {
				if (!evaluations) return;
				var scenario = findScenario(currentFixtureId);
				if (scenario && scenario.golden) {
					compareCurrentGolden();
				}
			});
		});
		var compareBtn = $('ai-panel-compare-golden');
		if (compareBtn) compareBtn.addEventListener('click', compareCurrentGolden);
		$('ai-panel-choose').addEventListener('click', runChoose);
		$('ai-panel-reset').addEventListener('click', resetState);
		var debug = $('ai-panel-debug-loop');
		if (debug) debug.addEventListener('click', function () { runDebugStep('Debug loop'); });
		var validate = $('ai-panel-validate');
		if (validate) validate.addEventListener('click', runValidate);
		var bridge = $('ai-panel-load-calc');
		if (bridge) bridge.addEventListener('click', loadFromCalcPanels);
		var scenario = $('ai-panel-scenario');
		var loadScenarioBtn = $('ai-panel-load-scenario');
		if (loadScenarioBtn && scenario) {
			loadScenarioBtn.addEventListener('click', function () {
				loadScenario(scenario.value);
			});
		}
		var exportBtn = $('ai-panel-export-state');
		if (exportBtn) exportBtn.addEventListener('click', exportState);
		var fixture = $('ai-panel-fixture-file');
		if (fixture) {
			fixture.addEventListener('change', function () {
				var file = fixture.files && fixture.files[0];
				currentFixtureId = 'local';
				lastEvaluations = null;
				setGoldenStatus('Local file — no golden compare.', 'muted');
				loadFixtureFile(file);
				fixture.value = '';
			});
		}
		var applyFields = $('ai-panel-apply-fields');
		if (applyFields) applyFields.addEventListener('click', applyStructuredFields);
		var syncFields = $('ai-panel-sync-fields');
		if (syncFields) syncFields.addEventListener('click', syncStructuredFromJson);

		loadFixtureManifest().then(function () {
			resetState();
		});
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}
})();
