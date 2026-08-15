/**
 * Run & Bun product shell (UI-V1 + ACC-01): mode nav, hash routing, context chips.
 * Keep fixture / AI Debug behavior in ai_panel.js — this file owns chrome only.
 */
(function () {
	'use strict';

	var MODES = {
		calc: {
			hash: '#calc',
			label: 'Calc',
			chips: [
				{text: 'Oracle · multi-gen', kind: 'oracle'},
				{text: 'Dense calc', kind: 'muted'}
			],
			note: 'Multi-gen damage oracle with Run & Bun overlays. Gen picker is oracle-only.'
		},
		sets: {
			hash: '#sets-bridge',
			label: 'Sets / Bridge',
			chips: [
				{text: 'Gen 8', kind: 'brand'},
				{text: 'Zero EV', kind: 'warn'}
			],
			note: 'Gen 8 only · EVs forced 0 for AI projections.'
		},
		'ai-debug': {
			hash: '#ai-panel',
			label: 'AI Debug',
			chips: [
				{text: 'Gen 8', kind: 'brand'},
				{text: 'Modeled slice', kind: 'warn'},
				{text: 'Thin client', kind: 'muted'}
			],
			note: 'Modeled slice, not a full sim. Scores and transitions come from the AI HTTP API.'
		},
		battle: {
			hash: '#runbun-battle',
			label: 'Singles Battle',
			chips: [
				{text: 'Gen 8 Singles', kind: 'brand'},
				{text: 'Modeled slice', kind: 'warn'}
			],
			note: 'Practice-vs-policy turn loop over the same HTTP as AI Debug. Doubles field layout follows BattleState.mode (DBL-01).'
		},
		planner: {
			hash: '#runbun-planner',
			label: 'Fight Planner',
			chips: [
				{text: 'Gen 8', kind: 'brand'},
				{text: 'Run map', kind: 'muted'},
				{text: 'Thin client', kind: 'muted'}
			],
			note: 'Pick a fight from the authored run map, bring a team, see the opponent\'s ranked actions and how much rests on a coin flip.'
		},
		run: {
			hash: '#runbun-run',
			label: 'Play',
			chips: [
				{text: 'Run & Bun', kind: 'brand'},
				{text: 'Local save', kind: 'warn'},
				{text: 'ROM-checked', kind: 'muted'}
			],
			note: 'Encounters · roster · fights · history'
		},
		replay: {
			hash: '#runbun-replay',
			label: 'Replay',
			chips: [
				{text: 'Gen 8', kind: 'brand'},
				{text: 'Stored rolls', kind: 'warn'},
				{text: 'Thin client', kind: 'muted'}
			],
			note: 'Scrub recorded apply/advance traces. Resolutions are stored — scrubbing does not re-derive random rolls.'
		}
	};

	var MODE_ORDER = ['calc', 'sets', 'ai-debug', 'battle', 'planner', 'run', 'replay'];
	var NAV_ORDER = ['run', 'calc', 'tools'];
	var NAV_DEFAULT_MODE = {
		run: 'run',
		calc: 'calc',
		tools: 'sets'
	};

	function $(id) {
		return document.getElementById(id);
	}

	function prefersReducedMotion() {
		return !!(window.matchMedia &&
			window.matchMedia('(prefers-reduced-motion: reduce)').matches);
	}

	function modeFromHash(hash) {
		var h = (hash || '').toLowerCase();
		if (h === '#sets-bridge' || h === '#sets') return 'sets';
		if (h === '#ai-panel' || h === '#ai-debug') return 'ai-debug';
		if (h === '#runbun-battle' || h === '#battle') return 'battle';
		if (h === '#runbun-planner' || h === '#planner') return 'planner';
		if (h === '#runbun-run' || h === '#run' || h === '#my-run') return 'run';
		if (h === '#runbun-replay' || h === '#replay') return 'replay';
		if (h === '#calc') return 'calc';
		if (h === '' || h === '#') return 'run';
		return 'run';
	}

	function navForMode(modeId) {
		if (modeId === 'calc') return 'calc';
		if (modeId === 'sets' || modeId === 'ai-debug') return 'tools';
		return 'run';
	}

	function targetIdForMode(modeId) {
		if (modeId === 'sets') return 'sets-bridge';
		if (modeId === 'ai-debug') return 'ai-panel';
		if (modeId === 'battle') return 'runbun-battle';
		if (modeId === 'planner') return 'runbun-planner';
		if (modeId === 'run') return 'runbun-run';
		if (modeId === 'replay') return 'runbun-replay';
		return 'calc';
	}

	function syncThemeAttr() {
		var darkStyles = $('dark-theme-styles');
		var isDark = darkStyles ? !darkStyles.disabled : true;
		document.documentElement.setAttribute('data-rb-theme', isDark ? 'dark' : 'light');
	}

	function renderContext(modeId) {
		var bar = $('rb-context-bar');
		if (!bar) return;
		var mode = MODES[modeId] || MODES.calc;
		bar.innerHTML = '';
		mode.chips.forEach(function (chip) {
			var el = document.createElement('span');
			el.className = 'rb-chip';
			if (chip.kind === 'brand') el.className += ' rb-chip-brand';
			else if (chip.kind === 'oracle') el.className += ' rb-chip-oracle';
			else if (chip.kind === 'warn') el.className += ' rb-chip-warn';
			el.textContent = chip.text;
			bar.appendChild(el);
		});
		var note = document.createElement('span');
		note.className = 'rb-context-note';
		note.textContent = mode.note;
		bar.appendChild(note);
	}

	function setActiveRegion(modeId) {
		MODE_ORDER.forEach(function (id) {
			var region = $(targetIdForMode(id));
			if (!region) return;
			// Only one working surface is present at a time. Related run and tool
			// subviews still share one primary-navigation destination.
			if (id === modeId) region.classList.add('rb-mode-active');
			else region.classList.remove('rb-mode-active');
		});
	}

	function setNavState(modeId) {
		var activeNav = navForMode(modeId);
		NAV_ORDER.forEach(function (id) {
			var link = $('rb-nav-' + id);
			if (!link) return;
			if (id === activeNav) link.setAttribute('aria-current', 'page');
			else link.removeAttribute('aria-current');
		});
	}

	function activateMode(modeId, options) {
		var opts = options || {};
		var mode = MODES[modeId] || MODES.calc;
		document.body.setAttribute('data-rb-mode', navForMode(modeId));
		setNavState(modeId);
		renderContext(modeId);
		setActiveRegion(modeId);
		if (opts.updateHash !== false) {
			var next = mode.hash;
			if (window.location.hash !== next) {
				if (opts.replaceHash) {
					if (window.history && window.history.replaceState) {
						window.history.replaceState(null, '', next);
					} else {
						window.location.hash = next;
					}
				} else if (window.history && window.history.pushState) {
					window.history.pushState(null, '', next);
				} else {
					window.location.hash = next;
				}
			}
		}
		if (opts.scroll !== false) {
			var target = $(targetIdForMode(modeId));
			if (target && typeof target.scrollIntoView === 'function') {
				target.scrollIntoView({
					behavior: prefersReducedMotion() ? 'auto' : 'smooth',
					block: 'start'
				});
			}
		}
		if (opts.focusPanel) {
			var panel = $(targetIdForMode(modeId));
			if (panel && typeof panel.focus === 'function') {
				try {
					panel.focus({preventScroll: true});
				} catch (e) {
					panel.focus();
				}
			}
		}
	}

	function onHashChange() {
		activateMode(modeFromHash(window.location.hash), {
			updateHash: false,
			scroll: true
		});
	}

	function bindPrimaryNav() {
		NAV_ORDER.forEach(function (navId) {
			var link = $('rb-nav-' + navId);
			if (!link) return;
			link.addEventListener('click', function (event) {
				event.preventDefault();
				activateMode(NAV_DEFAULT_MODE[navId], {scroll: true, updateHash: true});
			});
		});
	}

	function bindSkipLink() {
		var skip = document.querySelector('.rb-skip');
		if (!skip) return;
		skip.addEventListener('click', function () {
			var content = $('rb-mode-content');
			var modeId = modeFromHash(window.location.hash);
			var panel = $(targetIdForMode(modeId)) || content;
			window.setTimeout(function () {
				if (panel && typeof panel.focus === 'function') {
					try {
						panel.focus({preventScroll: true});
					} catch (e) {
						panel.focus();
					}
				}
			}, 0);
		});
	}

	function bindThemeSync() {
		syncThemeAttr();
		var toggle = $('dark-theme-toggle');
		if (toggle) {
			toggle.addEventListener('click', function () {
				// dark-theme-toggle.js flips styles synchronously on click;
				// defer one tick so disabled state is settled.
				setTimeout(syncThemeAttr, 0);
			});
		}
		var darkStyles = $('dark-theme-styles');
		if (darkStyles && typeof MutationObserver !== 'undefined') {
			var obs = new MutationObserver(syncThemeAttr);
			obs.observe(darkStyles, {attributes: true, attributeFilter: ['disabled']});
		}
	}

	function init() {
		if (!$('rb-shell')) return;
		bindThemeSync();
		bindPrimaryNav();
		bindSkipLink();
		window.addEventListener('hashchange', onHashChange);
		var initial = modeFromHash(window.location.hash);
		activateMode(initial, {
			scroll: !!window.location.hash && window.location.hash !== '#',
			updateHash: false,
			replaceHash: true
		});
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}
})();
