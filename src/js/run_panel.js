/* eslint-env browser, jquery, es6 */
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
		plan: ['#runbun-run-plan-verdict', '#runbun-run-plan-actions'],
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
				'advise · rank · board');
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
			setSection($section.attr('data-section'), !$section.hasClass('is-open'));
			persistSections();
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
			// A lost row's kit line is its epitaph — who did it beats where it came
			// from, because the graveyard is read as a story, not an inventory.
			$row.append($('<span class="runbun-run-mon-kit"></span>')
				.text(mon.status === 'dead' && mon.died && mon.died.to ?
					'killed by ' + mon.died.to +
						(mon.died.move ? "'s " + mon.died.move : '') :
					[mon.item, mon.origin && mon.origin.mapName ?
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
			prep.split.boss.replace(/^Leader /, '') + ' split (' + prep.split.index + '/' +
			prep.split.of + ') · ' + prep.fightsAhead + ' fights left, ' +
			prep.filler + ' filler' +
			(prep.cap.cap !== null ? ' · cap ' + prep.cap.cap : ''));
		prep.gauntlet.forEach(function (fight) {
			var $row = $('<li class="runbun-run-split-fight"></li>')
				.toggleClass('is-boss-row', fight.tier === 'boss');
			$row.append($('<span class="runbun-run-up-order"></span>').text('#' + fight.order));
			$row.append($('<span class="runbun-run-up-name"></span>').text(fight.trainer));
			$row.append($('<span class="runbun-run-up-tier"></span>')
				.addClass(fight.tier === 'boss' ? 'is-boss' : 'is-story')
				.text(fight.tier));
			$row.append($('<span class="runbun-run-up-meta"></span>')
				.text(fight.partySize + ' mons' +
					(fight.cap !== undefined ? ' · cap ' + fight.cap : '')));
			$row.append($('<span class="runbun-run-up-actions"></span>')
				.append($('<button type="button" class="runbun-run-up-plan"></button>')
					.attr('data-trainer', fight.trainer).text('Plan'))
				.append($('<button type="button" class="runbun-run-up-board"></button>')
					.attr('data-trainer', fight.trainer).text('Board')));
			$list.append($row);
		});
		// The split's uncollected field pickups: prep is what to grab BEFORE
		// the boss. Each row says where the item waits, and a reachable one
		// carries the button that records the trip — guided, not narrated.
		if (prep.pickups && prep.pickups.length) {
			var $pickups = $('<li class="runbun-run-split-pickups"></li>')
				.append($('<span class="runbun-run-split-pickups-label"></span>')
					.text('Grab before the boss'));
			prep.pickups.forEach(function (item) {
				var $row = $('<span class="runbun-run-pickup"></span>')
					.toggleClass('is-waiting', !item.reachable)
					.append($('<span class="runbun-run-pickup-name"></span>').text(item.name))
					.append($('<span class="runbun-run-pickup-where"></span>')
						.text(item.location + (item.reachable ? '' : ' · from #' + item.opensAt)));
				if (item.reachable) {
					$row.append($('<button type="button" class="runbun-run-pickup-take"></button>')
						.attr('data-item', item.name).text('Picked up'));
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
		$out.text('playing…');
		api('/run/split', {run: state, rollouts: 8}).then(function (prep) {
			var played = prep.adjudication;
			if (!played) {
				$out.text('');
				return;
			}
			$out.text('P(win) ' + Math.round(played.pWin * 100) + '% · ' +
				played.eDeaths.toFixed(1) + ' deaths expected · deathless ' +
				Math.round(played.pDeathless * 100) + '% — floor policy, ' +
				played.rollouts + ' rollouts');
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
				.append($('<button type="button" class="runbun-run-up-board"></button>')
					.attr('data-trainer', fight.trainer).text('Board'))
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
			this.textContent = usedMaps[name] ? name + ' — used' : name;
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
		writeSummary('box', alive + ' alive' + (lost ? ' · ' + lost + ' lost' : '') +
			(bag.length ? ' · bag ' + bag.length : ''));
		writeSummary('split', payload.splitPrep && !payload.splitPrep.split.finished ?
			payload.splitPrep.split.boss.replace(/^Leader /, '') + ' · ' +
				payload.splitPrep.fightsAhead + ' fights' +
				(payload.splitPrep.pickups && payload.splitPrep.pickups.length ?
					' · ' + payload.splitPrep.pickups.length + ' pickups' : '') :
			'finished');
		writeSummary('road', payload.upcoming && payload.upcoming.length ?
			'#' + payload.upcoming[0].order + ' ' + payload.upcoming[0].trainer : 'nothing ahead');
		var selected = $('#runbun-run-selected').val();
		writeSummary('tools', selected || 'select from the box');
		if (!$('#runbun-run-map').val()) writeSummary('catch', 'pick a route');
		refreshStale();
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
		return mutate(function () {
			dismissSnackbar();
			status('Working…', '');
			return api('/run/apply', {run: state, command: body}).then(function (payload) {
				state = payload.run;
				persist();
				status(payload.summary, 'ok');
				return render().then(function () { return true; });
			}).catch(function (error) {
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
			var $method = $('#runbun-run-roll-method').empty();
			var seen = {};
			found.mons.forEach(function (mon) {
				if (seen[mon.method]) return;
				seen[mon.method] = true;
				$method.append($('<option></option>').attr('value', mon.method).text(mon.method));
			});
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
						.attr('data-item', item.name).text('Picked up'));
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
			found.mons.forEach(function (mon) {
				var odds = mon.dupe ? 'dupe' :
					typeof mon.odds === 'number' ? mon.odds + '%' :
						typeof mon.chance === 'number' ? mon.chance + '%' : '';
				$list.append($('<li></li>')
					.toggleClass('is-owned', !!mon.owned)
					.toggleClass('is-dupe', !!mon.dupe)
					.append($('<button type="button" class="runbun-run-encounter"></button>')
						.attr('data-species', mon.species)
						.attr('data-level', mon.minLevel)
						.attr('data-method', mon.method)
						.attr('title', mon.dupe ?
							dupeTitle :
							typeof mon.odds === 'number' && mon.odds !== mon.chance ?
								mon.chance + '% raw, ' + mon.odds + '% once dupes are re-rolled' : null)
						.text((mon.owned ? '✓ ' : '') + mon.species + '  L' + mon.minLevel +
							(mon.maxLevel === mon.minLevel ? '' : '-' + mon.maxLevel) +
							(mon.rod ? '  ' + mon.rod : '') +
							(odds ? '  · ' + odds : ''))));
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
			stamp('plan');
		}).catch(function (error) {
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
		payload.party.forEach(function (mon) { byId[mon.id] = mon; });
		$('#runbun-run-advice-note').text(
			payload.trainer + ' (#' + payload.order + ') · ' +
			payload.considered + ' single changes weighed' +
			(payload.projection.applied && payload.projection.from === 'projected' ?
				' · party at cap ' + payload.projection.cap : ''));
		var $list = $('#runbun-run-advice').empty();
		if (!payload.upgrades.length) {
			$list.append($('<li class="runbun-run-advice-empty"></li>')
				.text('Nothing in the party, the bag or its learnsets moves this board.'));
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
					.text((mon.nickname || mon.species || entry.id) + ' ' + entry.id))
				.append($('<span class="runbun-run-advice-kind"></span>').text(entry.kind))
				.append($('<span class="runbun-run-advice-what"></span>').text(entry.detail))
				.append($('<span class="runbun-run-advice-ko"></span>')
					.toggleClass('is-ko', entry.delta.koGained > entry.delta.koConceded)
					.toggleClass('is-ko-trade', entry.delta.koConceded > 0)
					.text(koParts.length ? koParts.join('/') + ' KO' : ''))
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

	// ------------------------------------------------------------ best sixes

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
			payload.trainer + ' (#' + payload.order + ') · ' +
			payload.combinations + ' sixes from a box of ' + payload.boxSize +
			(payload.projection.applied && payload.projection.from === 'projected' ?
				' · box at cap ' + payload.projection.cap : '') +
			(playedCount ?
				' · top ' + playedCount + ' PLAYED (' + payload.adjudication.rollouts +
					' rollouts each, floor policy — a lower bound, not a promise)' :
				' · [lead] first, score assumes free switches priced by the entry hit'));
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
				$row.append($('<span class="runbun-run-rank-played"></span>')
					.toggleClass('is-win', party.adjudication.pWin >= 0.75)
					.toggleClass('is-loss', party.adjudication.pWin <= 0.25)
					.text('P(win) ' + Math.round(party.adjudication.pWin * 100) + '% · ' +
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
				.append($('<span class="runbun-run-route-name"></span>').text(route.name))
				.append($('<span class="runbun-run-route-best"></span>')
					.text((best || 'everything here is a dupe') + saving)));
		});
		used.forEach(function (route) {
			$list.append($('<li class="runbun-run-route-row is-used"></li>')
				.append($('<span class="runbun-run-route-when"></span>').text('used'))
				.append($('<span class="runbun-run-route-name"></span>').text(route.name))
				.append($('<span class="runbun-run-route-best"></span>')
					.text((route.used.species ?
						'gave ' + route.used.species + ' L' + route.used.level :
						'spent — nothing kept') +
						(route.used.where ? ' (' + route.used.where + ')' : ''))));
		});
	}

	function routesView() {
		status('Reading the routes…', '');
		api('/run/routes', {run: state}).then(function (payload) {
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
			' · ' + payload.routesOpen + ' routes open · party answers ' +
			payload.partyCovers + '/' + payload.enemies +
			(payload.gated ? ' · ' + payload.gated + ' prospects wait on an HM' : ''));
		var $list = $('#runbun-run-scout').empty();
		if (!payload.catches.length) {
			$list.append($('<li class="runbun-run-scout-empty"></li>')
				.text('Nothing catchable moves this board.'));
			return;
		}
		payload.catches.forEach(function (entry) {
			var $row = $('<li class="runbun-run-scout-row"></li>')
				.append($('<span class="runbun-run-scout-species"></span>')
					.text(entry.species + ' L' + entry.level))
				.append($('<span class="runbun-run-scout-where"></span>')
					.text(entry.name + ' · ' + entry.chance + '%' +
						(entry.method === 'walk' ? '' : ' ' + entry.method)))
				.append($('<span class="runbun-run-scout-ko"></span>')
					.toggleClass('is-ko', entry.newAnswers > 0)
					.toggleClass('is-ko-trade', entry.kosConceded > 0)
					.text((entry.newAnswers ? '+' + entry.newAnswers + ' new · ' : '') +
						entry.kos + '/' + payload.enemies + ' KO' +
						(entry.kosConceded ? ' · KOd by ' + entry.kosConceded : '')));
			$list.append($row);
		});
	}

	function scout() {
		status('Grading the open routes against the boss…', '');
		api('/run/scout', {run: state}).then(function (payload) {
			renderScout(payload);
			stamp('routes');
			status('', '');
		}).catch(function (error) {
			status(error.message, 'error');
		});
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
				var colors = heat(side.max);
				var label = side.move ? Math.round(side.max * 100) + '%' : '—';
				var $cell = $('<td></td>')
					.text(label)
					.css({'background-color': colors[0], color: colors[1]})
					.toggleClass('is-ko', side.guaranteedKO)
					.attr('title', (direction === 'us' ? ours : row.enemy.species) + ': ' +
						(side.move ?
							side.move + ' ' + Math.round(side.min * 100) + '-' +
								Math.round(side.max * 100) + '%' +
								(side.guaranteedKO ? ' · guaranteed KO' :
									side.possibleKO ? ' · possible KO' : '') :
							'no damaging move') +
						(cell.speed ? ' · we are ' + cell.speed : ''));
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
			' · dark = harder hit · ring = guaranteed KO · ▲ we are faster');
		$matrix.append(matrixTable(payload, 'us', 'Our best hit — % of their HP'));
		$matrix.append(matrixTable(payload, 'them', "Their best hit back — % of ours"));
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

	/** The last roll, held until Catch or "It got away" writes its truth. */
	var rolled = null;

	function rollEncounter() {
		var map = $('#runbun-run-map').val();
		if (!state || !map) {
			status('Pick a route to roll on first.', 'error');
			return;
		}
		var method = $('#runbun-run-roll-method').val() || undefined;
		api('/run/encounter', {run: state, map: map, method: method}).then(function (payload) {
			rolled = Object.assign({mapName: map}, payload.roll);
			$('#runbun-run-roll-text').text('A wild ' + rolled.species + ' L' + rolled.level +
				' appeared! (' + rolled.method + ' · ' + rolled.chance + '%)');
			$('#runbun-run-roll-result').prop('hidden', false);
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
				map: roll.mapName, method: roll.method} :
			{kind: 'spend', map: roll.mapName, reason: 'it got away'};
		command(body).then(function (accepted) {
			if (!accepted) return;
			rolled = null;
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
		paintBattle({
			phase: record.view.phase,
			viewState: record.view.viewState,
			actions: record.view.actions,
			events: battle.log.map(function (text) {
				return {text: text};
			}),
		});
		status('The fight against ' + battle.bundle.trainer +
			' resumed where it left off.', 'ok');
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
		$('#runbun-run-battle-trainer').text(battle.bundle.trainer);
		$('#runbun-run-battle-turn').text(' · turn ' + viewState.turn);
		$('#runbun-run-battle-foe-name').text(
			viewState.foe.active.species + ' L' + viewState.foe.active.level +
			(viewState.foe.active.status ? ' · ' + viewState.foe.active.status : ''));
		$('#runbun-run-battle-us-name').text(
			viewState.player.active.species + ' L' + viewState.player.active.level +
			(viewState.player.active.status ? ' · ' + viewState.player.active.status : ''));
		hpBar($('#runbun-run-battle-foe-hp'), viewState.foe.active);
		hpBar($('#runbun-run-battle-us-hp'), viewState.player.active);
		$('#runbun-run-battle-foe-bench').empty()
			.append(benchChips(viewState.foe.bench, viewState.foe.active.id));
		$('#runbun-run-battle-us-bench').empty()
			.append(benchChips(viewState.player.bench, viewState.player.active.id));

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
				// The throw wears its odds the way every move wears its damage.
				$moves.append($('<button type="button" class="btn runbun-run-battle-move runbun-run-battle-ball"></button>')
					.append($('<span class="runbun-run-battle-move-name"></span>').text(entry.label))
					.append($('<span class="runbun-run-battle-move-dmg"></span>').text(
						entry.chance + '% catch')));
			} else if (entry.kind === 'move') {
				$moves.append($('<button type="button" class="btn runbun-run-battle-move"></button>')
					.attr('data-move', entry.move)
					.append($('<span class="runbun-run-battle-move-name"></span>').text(entry.move))
					.append($('<span class="runbun-run-battle-move-dmg"></span>').text(
						entry.damage ?
							entry.damage.min + '–' + entry.damage.max + '%' +
								(entry.damage.guaranteedKO ? ' · KO' : '') : '')));
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
			$('#runbun-run-battle-log').empty();
			$('#runbun-run-battle').prop('hidden', false);
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
		}}).then(function (opened) {
			if (opened) $('#runbun-run-roll-result').prop('hidden', true);
		});
	}

	function battleAct(chosen) {
		if (!battle || battleBusy) return;
		battleBusy = true;
		api('/run/battle/act', {battle: battle.bundle, action: chosen}).then(function (reply) {
			battleBusy = false;
			battle.bundle = reply.battle;
			paintBattle(reply);
			if (reply.result) {
				finishBattle(reply);
			} else {
				persistBattle(reply);
			}
		}).catch(function (error) {
			battleBusy = false;
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
		var trainer = battle.bundle.trainer;
		var wild = battle.bundle.wild || null;
		var won = reply.result === 'win';
		var deaths = reply.deaths || [];
		battle = null;
		clearBattleSave();
		var chain = Promise.resolve(true);
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
			// The fight's ending settles the roll: a caught ball is the catch,
			// a killed encounter is the spend — both the ordinary, verified
			// commands the buttons would have written.
			if (reply.result === 'catch') {
				chain = chain.then(function (ok) {
					return ok ? command({kind: 'catch', species: wild.species,
						level: wild.level, map: wild.map, method: wild.method}) : false;
				});
			} else if (won) {
				chain = chain.then(function (ok) {
					return ok ? command({kind: 'spend', map: wild.map,
						reason: 'the encounter fainted'}) : false;
				});
			}
			chain.then(function (ok) {
				if (!ok) return;
				if (reply.result === 'catch' || won) {
					rolled = null;
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
			});
			return;
		}
		if (won) {
			chain = chain.then(function (ok) {
				return ok ? command({kind: 'beat', trainer: trainer}) : false;
			});
		}
		chain.then(function (ok) {
			if (ok) {
				status(won ?
					'Won against ' + trainer + ' — recorded' +
						(deaths.length ? ', with ' + deaths.length + ' lost.' : ', deathless.') :
					'Wiped against ' + trainer + ' — the deaths are recorded; ' +
						'the fight can be retried.', won ? 'ok' : 'error');
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
		// The final save goes to the transfer box BEFORE the browser copy is
		// cleared: the run is over, the record is still the player's.
		$('#runbun-run-transfer').val(JSON.stringify(state, null, '\t'))
			.closest('details').prop('open', true);
		try {
			window.localStorage.removeItem(STORAGE_KEY);
		} catch (error) { /* the state below is cleared regardless */ }
		state = null;
		lastStatus = null;
		stagedParty = [];
		battle = null;
		clearBattleSave();
		rolled = null;
		stamps = {};
		$('#runbun-run-battle').prop('hidden', true);
		$('#runbun-run-roll-result').prop('hidden', true);
		showRun();
		status('Run ended. Its final save is in the transfer box — copy it to keep it.', 'ok');
	}

	function abandonBattle() {
		var wasWild = !!(battle && battle.bundle && battle.bundle.wild);
		battle = null;
		clearBattleSave();
		$('#runbun-run-battle').prop('hidden', true);
		// Fleeing a wild fight settles nothing: the roll card returns so the
		// encounter can still be caught on faith or given up properly.
		if (wasWild && rolled) $('#runbun-run-roll-result').prop('hidden', false);
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
		});

		$('#runbun-run-new').on('click', function () {
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
			mutate(function () {
				return api('/run/new', {
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
					return api('/run/apply', {run: state, command: {
						kind: 'catch',
						species: $starter.attr('data-species'),
						level: 5,
					}}).then(function (gifted) {
						state = gifted.run;
						return ' — ' + $starter.attr('data-species') + ' L5 is in the box.';
					}, function (error) {
						return ' — but the starter was refused: ' + error.message;
					});
				}).then(function (note) {
					corruptSave = null;
					persist();
					status('Started ' + state.name + note,
						note.indexOf('refused') === -1 ? 'ok' : 'error');
					revealSection('catch');
					return render();
				}).catch(function (error) {
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
				// The shiny clause: keepable over the route rule and the dupes
				// clause, and recorded on the mon. One-shot like the epitaph —
				// left checked it would silently exempt the NEXT catch too.
				shiny: $('#runbun-run-catch-shiny').is(':checked') || undefined,
				moves: moves.length ? moves : undefined,
			}).then(function (accepted) {
				if (accepted) $('#runbun-run-catch-shiny').prop('checked', false);
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
		$('#runbun-run-play').on('click', startBattle);
		$('#runbun-run-battle-abandon').on('click', abandonBattle);
		bindHold('#runbun-run-end', 1000, endRun);
		$('#runbun-run-battle-moves').on('click', '.runbun-run-battle-move', function () {
			battleAct($(this).hasClass('runbun-run-battle-ball') ?
				{kind: 'ball'} :
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
			mutate(function () {
				dismissSnackbar();
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

	/**
	 * Two tabs, one run. The save lives in localStorage, so a phone next to the
	 * emulator and a desktop tab are ALREADY the same run — the only missing
	 * piece was hearing about each other's writes. The `storage` event fires in
	 * every OTHER tab when one persists; adopting it here keeps both views on
	 * the run that actually exists, instead of the loser overwriting the
	 * winner's catches with a stale base on its next command.
	 *
	 * Adopted without a server round-trip on purpose: the only writer of this
	 * key is this panel, which persists nothing the server did not accept.
	 * A write mid-flight is NOT adopted — the in-flight reply would clobber it
	 * anyway; the next repaint reconciles through the same event having fired
	 * on the other side.
	 */
	function syncFromOtherTab(event) {
		if (event.key !== STORAGE_KEY || busy) return;
		if (event.newValue === JSON.stringify(state)) return;
		var incoming = null;
		if (event.newValue) {
			try {
				incoming = JSON.parse(event.newValue);
			} catch (error) {
				return; // a corrupt write is the other tab's problem to surface
			}
		}
		state = incoming;
		// A fight here was opened from a run that no longer exists: playing it
		// out would write history onto the wrong document. It folds, unwritten.
		if (battle) {
			battle = null;
			clearBattleSave();
			$('#runbun-run-battle').prop('hidden', true);
		}
		showRun();
		if (!state) return;
		render().then(function () {
			status('Synced — the run moved in another tab.', 'ok');
		});
	}

	$(function () {
		if (!$('#runbun-run').length) return;
		bindDisclosures();
		bind();
		window.addEventListener('storage', syncFromOtherTab);
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
			if (state) {
				status('Loaded ' + state.name + ' from this browser.', 'ok');
				restoreBattle();
			}
		});
	});
})();
