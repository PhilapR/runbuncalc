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

	var MODE_ORDER = ['calc', 'sets', 'ai-debug', 'battle', 'replay'];

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
		if (h === '#runbun-replay' || h === '#replay') return 'replay';
		if (h === '#calc' || h === '' || h === '#') return 'calc';
		return 'calc';
	}

	function targetIdForMode(modeId) {
		if (modeId === 'sets') return 'sets-bridge';
		if (modeId === 'ai-debug') return 'ai-panel';
		if (modeId === 'battle') return 'runbun-battle';
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
			// Scroll-based shell keeps every mode visible; do not aria-hide siblings
			// (they remain interactive and must stay in the accessibility tree).
			if (id === modeId) region.classList.add('rb-mode-active');
			else region.classList.remove('rb-mode-active');
		});
	}

	function setTabState(modeId) {
		MODE_ORDER.forEach(function (id) {
			var tab = $('rb-tab-' + id);
			if (!tab) return;
			var selected = id === modeId;
			tab.setAttribute('aria-selected', selected ? 'true' : 'false');
			if (selected) tab.setAttribute('aria-current', 'page');
			else tab.removeAttribute('aria-current');
			tab.tabIndex = selected ? 0 : -1;
		});
	}

	function activateMode(modeId, options) {
		var opts = options || {};
		var mode = MODES[modeId] || MODES.calc;
		setTabState(modeId);
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

	function bindTabs() {
		MODE_ORDER.forEach(function (id) {
			var tab = $('rb-tab-' + id);
			if (!tab) return;
			tab.addEventListener('click', function (event) {
				event.preventDefault();
				activateMode(id, {scroll: true, updateHash: true});
			});
			tab.addEventListener('keydown', function (event) {
				var key = event.key;
				if (key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'Home' &&
					key !== 'End' && key !== 'Enter' && key !== ' ') {
					return;
				}
				event.preventDefault();
				if (key === 'Enter' || key === ' ') {
					activateMode(id, {scroll: true, updateHash: true, focusPanel: true});
					return;
				}
				var idx = MODE_ORDER.indexOf(id);
				var nextIdx = idx;
				if (key === 'ArrowLeft') nextIdx = (idx + MODE_ORDER.length - 1) % MODE_ORDER.length;
				if (key === 'ArrowRight') nextIdx = (idx + 1) % MODE_ORDER.length;
				if (key === 'Home') nextIdx = 0;
				if (key === 'End') nextIdx = MODE_ORDER.length - 1;
				var nextId = MODE_ORDER[nextIdx];
				var nextTab = $('rb-tab-' + nextId);
				if (nextTab) nextTab.focus();
				activateMode(nextId, {scroll: true, updateHash: true});
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
		bindTabs();
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
