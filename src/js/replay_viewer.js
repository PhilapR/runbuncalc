/* eslint-env browser, es6 */
/**
 * Replay scrubber (RPL-01) — thin client over recorded apply/advance traces.
 * Steps use stored stateAfter + resolution; does not re-derive random rolls.
 */
(function () {
	'use strict';

	var SAMPLE_URL = '/fixtures/ui/replays/sample.json';
	var loadedReplay = null;
	var frameIndex = 0;
	var busy = false;

	function $(id) {
		return document.getElementById(id);
	}

	function api() {
		return window.RunBunReplayTrace;
	}

	function setBusy(isBusy) {
		busy = !!isBusy;
		[
			'runbun-replay-load-sample',
			'runbun-replay-validate',
			'runbun-replay-export',
			'runbun-replay-prev',
			'runbun-replay-next',
			'runbun-replay-import-battle',
		].forEach(function (id) {
			var el = $(id);
			if (el) el.disabled = busy;
		});
	}

	function setStatus(message, isError) {
		var el = $('runbun-replay-status');
		if (!el) return;
		el.textContent = message || '';
		el.className = isError ?
			'runbun-replay-status runbun-replay-error' :
			'runbun-replay-status';
	}

	function formatHttpError(result) {
		var body = result && result.body;
		var msg = body && body.error ? body.error : 'HTTP ' + (result && result.status);
		return 'Invalid Action: ' + msg;
	}

	function postAi(path, payload) {
		return fetch(path, {
			method: 'POST',
			headers: {'content-type': 'application/json'},
			body: JSON.stringify(payload),
		}).then(function (response) {
			return response.json().then(function (body) {
				return {status: response.status, body: body};
			});
		});
	}

	function readEditorText() {
		var el = $('runbun-replay-json');
		return el ? el.value : '';
	}

	function writeEditor(replay) {
		var el = $('runbun-replay-json');
		if (el) el.value = JSON.stringify(replay, null, 2);
	}

	function parseEditorReplay() {
		var Trace = api();
		if (!Trace) throw new Error('RunBunReplayTrace is not loaded.');
		return Trace.parseReplay(readEditorText());
	}

	function speciesLine(state, sideId) {
		var side = state && state.sides && state.sides[sideId];
		if (!side || !Array.isArray(side.activeIds)) return sideId + ': —';
		var party = side.party || [];
		var names = side.activeIds.map(function (id) {
			var mon = party.find(function (entry) { return entry.id === id; });
			if (!mon) return id;
			var hp = mon.hp ?
				mon.hp.current + '/' + mon.hp.max :
				'?';
			return (mon.species || id) + ' (' + hp + ')';
		});
		return sideId + ': ' + names.join(' · ');
	}

	function renderEvaluations(evaluations) {
		var list = $('runbun-replay-actions');
		if (!list) return;
		list.innerHTML = '';
		if (!evaluations || !evaluations.length) {
			var empty = document.createElement('p');
			empty.className = 'runbun-replay-empty';
			empty.textContent = 'No ranked evaluations stored at this frame.';
			list.appendChild(empty);
			return;
		}
		evaluations.forEach(function (evaluation, index) {
			var row = document.createElement('div');
			row.className = 'runbun-replay-action-row';
			row.setAttribute('role', 'listitem');
			var rank = document.createElement('span');
			rank.className = 'runbun-replay-rank';
			rank.textContent = String(index + 1);
			var label = document.createElement('span');
			label.className = 'runbun-replay-action-label';
			label.textContent = api().formatAction(evaluation.action);
			var score = document.createElement('span');
			score.className = 'runbun-replay-score';
			score.textContent = typeof evaluation.score === 'number' ?
				String(evaluation.score) : '—';
			row.appendChild(rank);
			row.appendChild(label);
			row.appendChild(score);
			list.appendChild(row);
		});
	}

	function renderFrame() {
		var Trace = api();
		if (!loadedReplay || !Trace) return;
		var max = Trace.frameCount(loadedReplay) - 1;
		if (frameIndex < 0) frameIndex = 0;
		if (frameIndex > max) frameIndex = max;
		var frame = Trace.getFrame(loadedReplay, frameIndex);
		var slider = $('runbun-replay-scrubber');
		if (slider) {
			slider.min = '0';
			slider.max = String(max);
			slider.value = String(frameIndex);
		}
		var pos = $('runbun-replay-position');
		if (pos) {
			pos.textContent = 'Frame ' + frameIndex + ' / ' + max + ' — ' + frame.label;
		}
		var summary = $('runbun-replay-summary');
		if (summary) {
			var state = frame.state;
			var chips = [
				'Gen ' + (state.generation || loadedReplay.generation || '?'),
				state.mode || loadedReplay.mode || '?',
				'Turn ' + (state.turn != null ? state.turn : '?'),
			];
			summary.innerHTML = '';
			chips.forEach(function (text) {
				var el = document.createElement('span');
				el.className = 'runbun-replay-chip';
				el.textContent = text;
				summary.appendChild(el);
			});
			var field = document.createElement('div');
			field.className = 'runbun-replay-field-lines';
			field.textContent = speciesLine(state, 'ai') + '\n' + speciesLine(state, 'player');
			summary.appendChild(field);
		}
		var stepEl = $('runbun-replay-step');
		if (stepEl) {
			if (!frame.step) {
				stepEl.textContent = 'Initial state (no step yet). Stored evaluations below are from the first apply when present.';
			} else if (frame.step.type === 'advance') {
				stepEl.textContent = 'Step: advance-turn (modeled residual / timer slice).';
			} else {
				var resNote = frame.step.resolution ?
					' Resolution stored — scrubbing does not re-derive rolls.' :
					'';
				stepEl.textContent = 'Step: apply ' + Trace.formatAction(frame.step.action) +
					'.' + resNote;
			}
		}
		var stateView = $('runbun-replay-state');
		if (stateView) {
			stateView.value = JSON.stringify(frame.state, null, 2);
		}
		renderEvaluations(frame.evaluations);
		var prev = $('runbun-replay-prev');
		var next = $('runbun-replay-next');
		if (prev) prev.disabled = busy || frameIndex <= 0;
		if (next) next.disabled = busy || frameIndex >= max;
	}

	function loadReplayObject(replay, note) {
		var Trace = api();
		loadedReplay = Trace.parseReplay(replay);
		frameIndex = 0;
		writeEditor(loadedReplay);
		renderFrame();
		setStatus(note || ('Loaded replay "' + (loadedReplay.label || loadedReplay.id || 'trace') +
			'" with ' + loadedReplay.steps.length + ' step(s).'));
	}

	function loadSample() {
		setStatus('Loading sample replay…');
		setBusy(true);
		fetch(SAMPLE_URL).then(function (response) {
			if (!response.ok) {
				throw new Error('HTTP ' + response.status + ' for ' + SAMPLE_URL);
			}
			return response.json();
		}).then(function (json) {
			loadReplayObject(json, 'Loaded sample apply→advance replay. Scrub frames without re-rolling.');
		}).catch(function (error) {
			setStatus('Could not load sample replay: ' +
				(error && error.message ? error.message : error) +
				'. Is node server.js serving /fixtures?', true);
		}).then(function () { setBusy(false); });
	}

	function loadFromEditor() {
		try {
			loadReplayObject(parseEditorReplay(), 'Parsed replay from editor.');
		} catch (error) {
			setStatus(error && error.message ? error.message : String(error), true);
		}
	}

	function loadLocalFile(file) {
		if (!file) return;
		var reader = new FileReader();
		reader.onload = function () {
			try {
				loadReplayObject(String(reader.result),
					'Loaded replay file "' + file.name + '".');
			} catch (error) {
				setStatus(error && error.message ? error.message : String(error), true);
			}
		};
		reader.onerror = function () {
			setStatus('Could not read replay file.', true);
		};
		reader.readAsText(file);
	}

	function importFromBattle() {
		if (!window.RunBunBattleReplay ||
			typeof window.RunBunBattleReplay.exportSession !== 'function') {
			setStatus('Battle recorder is not available.', true);
			return;
		}
		try {
			var replay = window.RunBunBattleReplay.exportSession({
				id: 'battle-session',
				label: 'Exported from Battle Turn Viewer',
			});
			loadReplayObject(replay, 'Imported recorded Battle session (' +
				replay.steps.length + ' step(s)).');
		} catch (error) {
			setStatus(error && error.message ? error.message : String(error), true);
		}
	}

	function exportReplay() {
		try {
			var replay = loadedReplay || parseEditorReplay();
			var blob = new Blob([JSON.stringify(replay, null, 2)], {type: 'application/json'});
			var url = URL.createObjectURL(blob);
			var anchor = document.createElement('a');
			anchor.href = url;
			anchor.download = (replay.id || 'replay') + '.json';
			document.body.appendChild(anchor);
			anchor.click();
			document.body.removeChild(anchor);
			URL.revokeObjectURL(url);
			setStatus('Exported replay JSON.');
		} catch (error) {
			setStatus(error && error.message ? error.message : String(error), true);
		}
	}

	function validateReplay() {
		setStatus('Validating replay states over HTTP…');
		var replay;
		try {
			replay = loadedReplay || parseEditorReplay();
			loadedReplay = replay;
			writeEditor(replay);
		} catch (error) {
			setStatus(error && error.message ? error.message : String(error), true);
			return;
		}
		var states = [replay.initialState].concat(replay.steps.map(function (step) {
			return step.stateAfter;
		}));
		setBusy(true);
		var chain = Promise.resolve();
		var index = 0;
		states.forEach(function (state, i) {
			chain = chain.then(function () {
				return postAi('/ai/validate-battle-state', {state: state}).then(function (result) {
					if (result.status >= 400) {
						var label = i === 0 ? 'initialState' : 'steps[' + (i - 1) + '].stateAfter';
						throw Object.assign(
							new Error(formatHttpError(result) + ' (' + label + ')'),
							{http: true}
						);
					}
					index = i;
				});
			});
		});
		chain.then(function () {
			renderFrame();
			setStatus('Replay valid: ' + (index + 1) + ' BattleState frame(s) accepted by ' +
				'/ai/validate-battle-state. Scrubbing uses stored resolutions.');
		}).catch(function (error) {
			setStatus(error && error.message ? error.message :
				'Validate failed. Is node server.js running?', true);
		}).then(function () { setBusy(false); });
	}

	function stepBy(delta) {
		if (!loadedReplay) {
			try {
				loadedReplay = parseEditorReplay();
			} catch (error) {
				setStatus(error && error.message ? error.message : String(error), true);
				return;
			}
		}
		frameIndex += delta;
		renderFrame();
		setStatus('Scrubbed to frame ' + frameIndex + '.');
	}

	function onScrubberInput() {
		var slider = $('runbun-replay-scrubber');
		if (!slider || !loadedReplay) return;
		frameIndex = parseInt(slider.value) || 0;
		renderFrame();
	}

	function bind(id, handler) {
		var el = $(id);
		if (el) el.addEventListener('click', handler);
	}

	function init() {
		if (!$('runbun-replay')) return;
		if (!api()) {
			setStatus('RunBunReplayTrace failed to load.', true);
			return;
		}
		bind('runbun-replay-load-sample', loadSample);
		bind('runbun-replay-parse', loadFromEditor);
		bind('runbun-replay-validate', validateReplay);
		bind('runbun-replay-export', exportReplay);
		bind('runbun-replay-import-battle', importFromBattle);
		bind('runbun-replay-prev', function () { stepBy(-1); });
		bind('runbun-replay-next', function () { stepBy(1); });
		var slider = $('runbun-replay-scrubber');
		if (slider) {
			slider.addEventListener('input', onScrubberInput);
			slider.addEventListener('change', onScrubberInput);
		}
		var file = $('runbun-replay-file');
		if (file) {
			file.addEventListener('change', function () {
				var picked = file.files && file.files[0];
				if (picked) loadLocalFile(picked);
				file.value = '';
			});
		}
		loadSample();
	}

	window.RunBunReplayViewer = {
		loadReplay: loadReplayObject,
		getReplay: function () { return loadedReplay; },
	};

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}
})();
