/* eslint-env node, es6 */
'use strict';

/**
 * Play a run through the real UI, the way a player plays it.
 *
 * `tests/browser_run.test.js` proves single properties of the panel with a
 * fight or two. This drives the whole loop instead — level, catch, party,
 * plan, fight, repeat — because the failures that matter most are the ones
 * that only appear on the twentieth fight: a route that never becomes
 * reachable, a moveset that stops growing, an advice line that is confident
 * and wrong. Nothing here asserts. It plays, and it writes down what it saw.
 *
 * The fight policy is deliberately NOT the driver's own opinion. It reads the
 * same two things a player reads off the screen — the damage line under each
 * move and the threat line above them — and does what those say:
 *
 *   1. a move that KOs on any roll is taken, always;
 *   2. otherwise, if the card says we are infatuated or confused, switch —
 *      those are volatiles and the switch reset clears them;
 *   3. otherwise, if this one cannot be finished now and is not already
 *      locked down, spend the turn taking a turn off IT — sleep over
 *      paralysis over confusion, once per opposing Pokemon, never while a
 *      crit would kill us;
 *   4. otherwise, if the threat line says the race is lost, switch (once per
 *      opposing Pokemon, so a losing race cannot become a switch loop);
 *   5. otherwise take the move with the highest floor.
 *
 * Rules 2 and 3 were both missing, and both are about turns rather than
 * damage. Over 66 scripted fights we out-hit the opposition 44.1% to 25.0%
 * per hit and lost anyway, giving up 10.6% of our turns to status against
 * their 2.3%.
 *
 * That makes the run a test of the ADVICE. If following the panel's own
 * displayed reasoning wipes the run, that is a finding about the panel.
 *
 * It plays with everything the rules allow: field items are collected off the
 * routes they stand on, held items are given from the bag, and the party is
 * the one Rank scores highest rather than whatever the box order gave. Items
 * IN a trainer fight are not offered and must not be — `no-items-in-trainer-
 * fights` is the ruling, so moves and switches are the whole action set.
 *
 *   node scripts/ui-playthrough.js
 *   node scripts/ui-playthrough.js --starter=Chimchar --fights=60 --budget=900
 *   node scripts/ui-playthrough.js --party=box     # skip the ranker
 *   node scripts/ui-playthrough.js --headed        # watch it play
 */

const fs = require('node:fs');
const path = require('node:path');

const ai = require('../ai');
const calc = require('../calc');
const startServer = require('../lib/server').startServer;

let chromium = null;
try {
	chromium = require('playwright-core').chromium;
} catch (error) {
	chromium = null;
}

const OUT = path.join(__dirname, '..', 'ui-playthrough-out');
const PARTY_LIMIT = 6;

function flag(name, fallback) {
	const hit = process.argv.find(arg => arg.startsWith('--' + name + '='));
	return hit === undefined ? fallback : hit.slice(name.length + 3);
}

const STARTER = flag('starter', 'Piplup');
const MAX_FIGHTS = Number(flag('fights', 200));
const BUDGET_MS = Number(flag('budget', 1500)) * 1000;
const PLAN_EVERY = Number(flag('plan', 1));
const PARTY_MODE = flag('party', 'rank');
const ADVICE_ROUNDS = Number(flag('advice', 3));
const RULES = flag('rules', 'hardcore');
const CATCH_LIMIT = Number(flag('box', 14));
const TMS = flag('tms', 'advisor');
// How many times to walk back into a fight that beat us. Under `caps` a wipe
// costs nothing and retrying is ordinary play; under `hardcore` a wipe has
// usually already taken the Pokemon that made the attempt worth repeating.
const RETRIES = Number(flag('retries', 3));
const BOSS_RETRIES = Number(flag('boss-retries', 40));
const HEADED = process.argv.includes('--headed');

const started = Date.now();
const journal = [];
const problems = [];
const forecastReported = new Set();
const caughtFrom = new Set();
const taughtAt = new Map();
const adviceReported = new Set();

function note(kind, message, extra) {
	const entry = {at: Math.round((Date.now() - started) / 1000), kind: kind, message: message};
	if (extra) entry.detail = extra;
	journal.push(entry);
	console.log('[' + String(entry.at).padStart(4) + 's] ' + kind + ': ' + message);
}

function problem(where, message, extra) {
	problems.push({where: where, message: message, detail: extra});
	note('PROBLEM', where + ' — ' + message, extra);
}

function outOfTime() {
	return Date.now() - started > BUDGET_MS;
}

// ------------------------------------------------------------------ page reads

function text(page, selector) {
	return page.evaluate(sel => {
		const el = document.querySelector(sel);
		return el ? el.textContent.trim() : '';
	}, selector);
}

function savedRun(page) {
	return page.evaluate(() => {
		const raw = window.localStorage.getItem('runbun.run.v1');
		return raw ? JSON.parse(raw) : null;
	});
}

/** The whole out-of-battle surface in one read, so a decision is made against
 * one consistent frame rather than six racing ones. */
function readRun(page) {
	return page.evaluate(() => {
		const txt = sel => {
			const el = document.querySelector(sel);
			return el ? el.textContent.trim() : '';
		};
		const raw = window.localStorage.getItem('runbun.run.v1');
		const run = raw ? JSON.parse(raw) : null;
		return {
			nextTitle: txt('#runbun-run-next-title'),
			nextDetail: txt('#runbun-run-next-detail'),
			position: txt('#runbun-run-position'),
			cap: txt('#runbun-run-cap'),
			status: txt('#runbun-run-status'),
			playLabel: txt('#runbun-run-play'),
			playDisabled: !!(document.querySelector('#runbun-run-play') || {}).disabled,
			routes: Array.from(document.querySelectorAll(
				'#runbun-run-reachable .runbun-run-route-choice')).map(el => ({
				map: el.getAttribute('data-map'),
				name: (el.querySelector('.runbun-run-route-choice-name') || {}).textContent || '',
				action: (el.querySelector('.runbun-run-route-choice-action') || {}).textContent || '',
			})),
			party: run ? run.party.slice() : [],
			box: run ? run.box.map(mon => ({
				id: mon.id, species: mon.species, level: mon.level,
				status: mon.status, moves: (mon.moves || []).slice(),
				item: mon.item || null,
				// Trainer teams are built with 31s; a wild catch keeps what it
				// rolled, mean 15.5. That gap is worth 3-4 points a stat at
				// L21 — a candidate explanation for why one box beats a wall
				// and the next cannot, so it has to be recorded to be tested.
				ivs: mon.ivs || null,
			})) : [],
			bag: run ? run.bag : {},
		};
	});
}

function readBattle(page) {
	return page.evaluate(() => {
		const q = sel => document.querySelector(sel);
		const txt = sel => (q(sel) ? q(sel).textContent.trim() : '');
		const threat = q('#runbun-run-battle-threat');
		const width = sel => {
			const el = q(sel);
			return el ? Number(String(el.style.width || '').replace('%', '')) : 0;
		};
		return {
			open: !!(q('#runbun-run-battle') && !q('#runbun-run-battle').hidden),
			trainer: txt('#runbun-run-battle-trainer'),
			turn: txt('#runbun-run-battle-turn'),
			prompt: txt('#runbun-run-battle-prompt'),
			threat: threat ? threat.textContent.trim() : '',
			risk: threat ? threat.getAttribute('data-risk') : null,
			us: txt('#runbun-run-battle-us-name'),
			usHp: width('#runbun-run-battle-us-hp'),
			foe: txt('#runbun-run-battle-foe-name'),
			foeHp: width('#runbun-run-battle-foe-hp'),
			result: txt('#runbun-run-battle-result'),
			status: txt('#runbun-run-status'),
			log: Array.from(document.querySelectorAll('#runbun-run-battle-log li'))
				.map(li => li.textContent),
			moves: Array.from(document.querySelectorAll(
				'#runbun-run-battle-moves .runbun-run-battle-move')).map(el => ({
				move: el.getAttribute('data-move'),
				ball: el.getAttribute('data-ball'),
				title: el.getAttribute('title') || '',
				damage: (el.querySelector('.runbun-run-battle-move-dmg') || {}).textContent || '',
				label: (el.querySelector('.runbun-run-battle-move-name') || {}).textContent || '',
			})),
			switches: Array.from(document.querySelectorAll(
				'#runbun-run-battle-switches .runbun-run-battle-switch')).map(el => ({
				id: el.getAttribute('data-replace'),
				label: el.textContent.trim(),
			})),
			// The bench is the only place a Pokemon that never acts can be seen
			// losing HP, so a wipe that nobody clicked for is explainable.
			bench: Array.from(document.querySelectorAll(
				'#runbun-run-battle-us-bench .runbun-run-battle-chip'))
				.map(el => el.textContent.trim()),
		};
	});
}

// ------------------------------------------------------------------ commanding

/**
 * Every panel command posts the whole run and adopts the reply, so a click is
 * finished when the save changed or the status line spoke. Waiting on a fixed
 * timeout instead is how a driver silently skips a refusal.
 */
async function act(page, label, click) {
	const before = await page.evaluate(() => ({
		run: window.localStorage.getItem('runbun.run.v1'),
		status: (document.querySelector('#runbun-run-status') || {}).textContent || '',
	}));
	await click();
	let moved = true;
	try {
		// `command()` writes "Working…" the instant it posts, so a driver that
		// only waits for the status to CHANGE reads the panel mid-flight and
		// then races the reply. The command is finished when that placeholder
		// is gone AND something actually differs.
		await page.waitForFunction(prev => {
			const run = window.localStorage.getItem('runbun.run.v1');
			const status = (document.querySelector('#runbun-run-status') || {}).textContent || '';
			if (/^(Working|Sending out|Saving)/.test(status)) return false;
			return run !== prev.run || status !== prev.status;
		}, before, {timeout: 20000});
	} catch (error) {
		moved = false;
	}
	const after = await page.evaluate(() => ({
		run: window.localStorage.getItem('runbun.run.v1'),
		status: (document.querySelector('#runbun-run-status') || {}).textContent || '',
		error: !!document.querySelector('#runbun-run-status.is-error, #runbun-run-status.error'),
	}));
	// Let the adopted reply finish painting before the next read.
	await page.waitForTimeout(60);
	return {
		label: label,
		changed: after.run !== before.run,
		moved: moved,
		status: after.status.trim(),
	};
}

async function openAllSections(page) {
	await page.$$eval('.rb-disclose .rb-disclose-btn[aria-expanded="false"]',
		els => els.forEach(el => el.click()));
	await page.$$eval('#runbun-run details.runbun-run-manual-map',
		els => els.forEach(el => { el.open = true; }));
}

// ------------------------------------------------------------------ the player

async function takeEncounters(page) {
	const view = await readRun(page);
	// Stop catching once there are enough bodies to choose between. Without
	// the one-per-route rule a route can be rolled again every cycle, and the
	// driver boxed 76 Pokemon by its tenth fight — which is not what a player
	// does, and which melts the ranker: Rank enumerates every C(box, 6), so
	// per-fight wall clock went 36s to 120s over that stretch. Recorded as
	// `rank-enumerates-every-six-with-no-bound`.
	const alive = view.box.filter(mon => mon.status !== 'dead').length;
	if (alive >= CATCH_LIMIT) return [];
	const taken = [];
	// New ground first, and never the same area twice. Without the one-per-
	// route rule an area stays rollable forever, so walking the list in order
	// meant re-rolling Route 101 every cycle: fifteen catches came from the
	// five starting areas, three each, and Route 104, Petalburg Woods and
	// Granite Cave were never touched. A box of Route 101 species is why Rank
	// reported "unanswered: Eelektrik, Sunflora" and was right three times.
	// ONE catch per area, ever, and nothing when no new area is open. Falling
	// back to the already-used list just re-rolled Route 101: fifteen catches
	// came from the five starting areas, three each, while Route 104,
	// Petalburg Woods and Granite Cave went untouched. A box of five Route 101
	// species is why Rank kept reporting "unanswered" and kept being right.
	const fresh = view.routes.filter(route => !caughtFrom.has(route.map));
	if (!fresh.length) return [];
	for (const route of fresh) {
		if (outOfTime()) break;
		const clicked = await page.$('#runbun-run-reachable .runbun-run-route-choice[data-map="' +
			route.map + '"]');
		if (!clicked) continue;
		await clicked.click();
		try {
			await page.waitForFunction(
				() => document.querySelectorAll('#runbun-run-encounters li').length > 0,
				null, {timeout: 10000});
		} catch (error) {
			problem('encounters', 'no encounter table rendered for ' + route.map);
			continue;
		}
		const roll = await act(page, 'roll ' + route.map,
			() => page.click('#runbun-run-roll'));
		const showing = await page.evaluate(() => {
			const el = document.querySelector('#runbun-run-roll-result');
			return !!el && !el.hidden;
		});
		if (!showing) {
			note('route', route.map + ' gave no roll — ' + (roll.status || 'silence'));
			continue;
		}
		const rolled = await text(page, '#runbun-run-roll-text');
		const boxBefore = (await savedRun(page)).box.length;
		const kept = await act(page, 'keep ' + route.map,
			() => page.click('#runbun-run-roll-catch'));
		const boxAfter = (await savedRun(page)).box.length;
		if (boxAfter > boxBefore) {
			caughtFrom.add(route.map);
			taken.push(rolled);
			note('caught', rolled + '  (' + route.map + ')');
		} else {
			caughtFrom.add(route.map);
			await act(page, 'flee ' + route.map, () => page.click('#runbun-run-roll-flee'));
			note('lost', rolled + ' refused — ' + (kept.status || 'no reason given'));
		}
	}
	return taken;
}

/**
 * Every field item standing on a reachable route. One click records the
 * pickup, the list redraws without it, so the loop reads the list again
 * rather than trusting a stale handle — and stops the moment a pass does
 * not shrink it, because a button that will not clear is a bug, not a queue.
 */
async function takeItems(page) {
	for (let pass = 0; pass < 24; pass++) {
		if (outOfTime()) return;
		const items = await page.$$eval('#runbun-run .runbun-run-pickup-take',
			els => els.map(el => el.getAttribute('data-item')));
		if (!items.length) return;
		const button = await page.$('#runbun-run .runbun-run-pickup-take');
		if (!button) return;
		const took = await act(page, 'take ' + items[0], () => button.click());
		if (!took.changed) {
			note('item', items[0] + ' refused — ' + (took.status || 'no reason given'));
			return;
		}
		note('item', 'picked up ' + items[0]);
		const left = await page.$$eval('#runbun-run .runbun-run-pickup-take', els => els.length);
		if (left >= items.length) {
			problem('items', 'taking ' + items[0] + ' did not clear it from the list');
			return;
		}
	}
}

/**
 * A held item is free stats and the run's own opponents all carry one. The
 * bag holds consumables too and `give` is the only authority on what can be
 * held, so a refusal teaches the driver rather than repeating.
 */
const notHoldable = new Set();

async function equipParty(page) {
	const view = await readRun(page);
	const bare = view.box.filter(mon => mon.status !== 'dead' && !mon.item &&
		view.party.indexOf(mon.id) !== -1);
	for (const mon of bare) {
		if (outOfTime()) return;
		if (!await selectMon(page, mon.id)) continue;
		const options = await page.$$eval('#runbun-run-hold-item option',
			els => els.map(el => el.value).filter(Boolean));
		// A type-boost item is worth 1.2x to a Pokemon that has that type of
		// move and nothing at all to one that does not. Handing out the first
		// holdable item in the bag put Soft Sand on a Pidgeotto, Silk Scarf on
		// a Litleo and a Poison Barb on a Lumineon — three dead slots.
		const boosts = {
			'Miracle Seed': 'Grass', 'Silk Scarf': 'Normal', 'Soft Sand': 'Ground',
			'Poison Barb': 'Poison', 'Charcoal': 'Fire', 'Mystic Water': 'Water',
			'Magnet': 'Electric', 'Sharp Beak': 'Flying', 'Twisted Spoon': 'Psychic',
			'Never-Melt Ice': 'Ice', 'Hard Stone': 'Rock', 'Black Belt': 'Fighting',
			'Silver Powder': 'Bug', 'Spell Tag': 'Ghost', 'Black Glasses': 'Dark',
			'Metal Coat': 'Steel', 'Dragon Fang': 'Dragon', 'Pixie Plate': 'Fairy',
		};
		const carries = type => (mon.moves || []).some(name => {
			try {
				const meta = ai.getMoveMetadata(name, 8);
				return meta.category !== 'Status' && meta.type === type;
			} catch (error) {
				return false;
			}
		});
		const usable = options.filter(item => !notHoldable.has(item));
		const wanted = usable.find(item => boosts[item] && carries(boosts[item])) ||
			usable.find(item => !boosts[item]) || usable[0];
		if (!wanted) continue;
		// `give` reads the select, so the choice has to land in the control
		// and not only in this function.
		await page.selectOption('#runbun-run-hold-item', wanted);
		const given = await act(page, 'give ' + wanted, () => page.click('#runbun-run-give'));
		if (!given.changed) {
			notHoldable.add(wanted);
			note('item', wanted + ' cannot be held — ' + (given.status || 'refused'));
			continue;
		}
		note('item', mon.species + ' holds ' + wanted);
	}
}

/**
 * `give` accepts anything in the bag, but the calculator refuses a Potion —
 * and the refusal only arrives when the run tries to plan or fight, at which
 * point nothing works until the item comes off. The message says "fix or take
 * the item", so do exactly that, and never offer that item again.
 * Recorded as `held-item-picker-offers-what-no-pokemon-can-hold`.
 */
async function unbrickHeldItems(page, message) {
	const blame = /(.+?) \(player-\d+\) holds "(.+?)", which is not an item/.exec(message || '');
	if (!blame) return false;
	notHoldable.add(blame[2]);
	const view = await readRun(page);
	const mon = view.box.find(entry => entry.species === blame[1] && entry.item === blame[2]);
	if (!mon || !await selectMon(page, mon.id)) return false;
	const took = await act(page, 'take ' + blame[2], () => page.click('#runbun-run-take'));
	note('item', 'took ' + blame[2] + ' back off ' + blame[1] +
		' — the picker offered an item nothing can hold');
	return took.changed;
}

function capOf(view) {
	const hit = /Level cap (\d+)/.exec(view.cap || '');
	return hit ? Number(hit[1]) : null;
}

/** Levelling teaches: a full moveset stops and asks, so the pending move is
 * taught over the oldest one — which is what a player does with Tackle. */
async function teachPending(page, mon, status) {
	const hit = /so (.+?) must be taught over something/.exec(status);
	if (!hit) return;
	const pending = hit[1].split(', ').filter(Boolean);
	for (const move of pending) {
		if (outOfTime()) return;
		const options = await page.$$eval('#runbun-run-replace option',
			els => els.map(el => el.value).filter(Boolean));
		if (!options.length) return;
		await page.fill('#runbun-run-move', move);
		await page.selectOption('#runbun-run-replace', options[0]);
		const taught = await act(page, 'teach ' + move,
			() => page.click('#runbun-run-teach'));
		if (!taught.changed) {
			note('teach', mon.species + ' could not learn ' + move + ' — ' + taught.status);
			return;
		}
		note('teach', mon.species + ' learned ' + move + ' over ' + options[0]);
	}
}

async function levelAndEvolve(page) {
	const view = await readRun(page);
	const cap = capOf(view);
	if (cap === null) return;
	// The party first, then enough of the reserve to fill a six. Levelling the
	// whole box is what a player does not do, and by the twentieth catch it
	// costs more clicks per fight than the fight does.
	const alive = view.box.filter(mon => mon.status !== 'dead');
	const fighting = alive.filter(mon => view.party.indexOf(mon.id) !== -1)
		.concat(alive.filter(mon => view.party.indexOf(mon.id) === -1))
		.slice(0, PARTY_LIMIT);
	for (const mon of fighting) {
		if (outOfTime()) break;
		if (!await selectMon(page, mon.id)) continue;
		if (mon.level < cap) {
			const grew = await act(page, 'level ' + mon.species,
				() => page.click('#runbun-run-level-cap'));
			if (grew.changed) {
				note('level', mon.species + ' L' + mon.level + ' -> L' + cap);
				await teachPending(page, mon, grew.status);
			} else if (grew.status) {
				note('level', mon.species + ' did not grow — ' + grew.status);
			}
		}
		// Evolve only when the panel's own Evolution fact says it is ready.
		// Pressing it blindly turns every ordinary "not yet" into a 400 and
		// buries the real refusals in noise.
		try {
			await page.waitForFunction(
				() => /Evolution/.test(
					(document.querySelector('#runbun-run-mon-facts') || {}).textContent || ''),
				null, {timeout: 8000});
		} catch (error) {
			continue;
		}
		const ready = await page.evaluate(() => Array.from(
			document.querySelectorAll('#runbun-run-mon-facts .runbun-run-fact'))
			.some(el => /Evolution/.test(el.textContent) && /ready now/.test(el.textContent)));
		if (!ready) continue;
		const evolved = await act(page, 'evolve ' + mon.species,
			() => page.click('#runbun-run-evolve'));
		if (evolved.changed) note('evolve', mon.species + ' — ' + evolved.status);
	}
}

/**
 * Put a Pokemon on the details screen, wherever it currently lives.
 *
 * The PC list holds only the RESERVE — `renderBox` filters out anything in
 * the committed party — so a box-only selector silently does nothing for the
 * six that actually fight, and every command keyed on the selection (level,
 * evolve, give) quietly skips them.
 */
async function selectMon(page, id) {
	const targets = [
		'#runbun-run-party-strip .runbun-run-party-select[data-id="' + id + '"]',
		'#runbun-run-box .runbun-run-mon[data-id="' + id + '"] .runbun-run-mon-select',
	];
	for (const selector of targets) {
		const found = await page.$(selector);
		if (!found) continue;
		await found.click();
		await page.waitForTimeout(40);
		const now = await page.$eval('#runbun-run-selected', el => el.value);
		if (now === id) return true;
	}
	return false;
}

/** One id per SLOT. `[data-id]` also matches the name, up and remove buttons
 * inside each slot, so it reports every party member four times. */
function stagedIds(page) {
	return page.$$eval('#runbun-run-party-strip .runbun-run-party-slot[data-id]',
		els => els.map(el => el.getAttribute('data-id')));
}

/** Stage exactly these ids, in this order — click order is lead order — and
 * commit them as one party command. */
async function stageParty(page, wanted, why) {
	const matches = staged => staged.length === wanted.length &&
		staged.every((id, at) => id === wanted[at]);

	// A member that is un-staged but still in the COMMITTED party is on no
	// list at all — the PC list filters on state.party, the strip renders
	// stagedParty, and nothing shows the difference. So never un-stage someone
	// who is staying: drop only the leavers, commit that, and the newcomers
	// become addable. Recorded as `unstaged-party-member-is-on-no-list`.
	const leaving = (await stagedIds(page)).filter(id => wanted.indexOf(id) === -1);
	for (const id of leaving) {
		const remove = await page.$('#runbun-run-party-strip .runbun-run-party-rm[data-id="' +
			id + '"]');
		if (remove) await remove.click();
		await page.waitForTimeout(30);
	}
	if (leaving.length) await act(page, 'drop', () => page.click('#runbun-run-set-party'));

	for (const id of wanted) {
		if ((await stagedIds(page)).indexOf(id) !== -1) continue;
		const add = await page.$('#runbun-run-box .runbun-run-mon[data-id="' + id +
			'"] .runbun-run-add');
		if (add) await add.click();
		await page.waitForTimeout(30);
	}

	// Order is the lead, and the only control that changes it without
	// un-staging anyone is the strip's up arrow. Selection sort: walk each
	// wanted slot and bubble the right member into it.
	for (let slot = 0; slot < wanted.length; slot++) {
		for (let guard = 0; guard < PARTY_LIMIT; guard++) {
			const staged = await stagedIds(page);
			const at = staged.indexOf(wanted[slot]);
			if (at <= slot) break;
			const up = await page.$('#runbun-run-party-strip .runbun-run-party-up[data-id="' +
				wanted[slot] + '"]');
			if (!up) break;
			await up.click();
			await page.waitForTimeout(30);
		}
	}
	const finalStaged = await stagedIds(page);
	if (!finalStaged.length) {
		problem('party', 'could not stage a party from ' + wanted.length + ' living Pokemon');
		return false;
	}
	const offered = await page.evaluate(() => {
		const el = document.querySelector('.runbun-run-party-commit');
		return !!el && !el.hidden;
	});
	if (!offered) {
		// Nothing to commit is the normal answer when the staged six already
		// IS the party, which is what a stable ranking looks like.
		if (!matches(finalStaged)) {
			problem('party', 'staged ' + finalStaged.length + ' of a wanted ' + wanted.length +
				' but the panel offers no way to commit');
		}
		return matches(finalStaged);
	}
	const set = await act(page, 'set party', () => page.click('#runbun-run-set-party'));
	const landed = (await savedRun(page)).party.length;
	if (landed !== wanted.length) {
		problem('party', 'committed ' + wanted.length + ' but the run kept ' + landed +
			' — ' + set.status);
		return false;
	}
	note('party', (why || 'party') + ' · ' + landed + ' ready — ' +
		(set.status || 'committed'));
	return true;
}

/** The fallback when the ranker is not being used or could not answer: the
 * living box in order, membership only. Order belongs to the plan's
 * recommended lead, so a reorder is not a reason to rebuild. */
async function buildParty(page) {
	const view = await readRun(page);
	const alive = view.box.filter(mon => mon.status !== 'dead');
	// `late` takes the NEWEST catches, not the oldest. Box order is catch
	// order, so the first six are Route 101 fodder while the last six come
	// from whatever area opened most recently — which by Brawly means Granite
	// Cave and Route 116 rather than Zigzagoon. It exists because Rank cannot
	// afford a box big enough to hold both: C(20,6) is 38,760 parties.
	const wanted = (PARTY_MODE === 'late' ? alive.slice(-PARTY_LIMIT) :
		alive.slice(0, PARTY_LIMIT)).map(mon => mon.id);
	const sameSet = wanted.length === view.party.length &&
		wanted.every(id => view.party.indexOf(id) !== -1);
	if (sameSet) return true;
	return stageParty(page, wanted, 'box order');
}

/**
 * Choose the six from the panel's MATCHUP MATRIX rather than from Rank.
 *
 * Rank is the better answer and says so accurately, but it enumerates every
 * C(box, 6) — 38,760 parties at a box of twenty — so a box big enough to hold
 * a real answer is a box Rank cannot afford. The matrix is the same scoring
 * without the enumeration: one row per Pokemon, one column per enemy, our
 * floor roll against their crit. Cost is linear, so the box can be large.
 *
 * The score is the matrix's own two halves, per enemy: what we can rely on
 * doing minus what we must survive. Summed across their party, that is a
 * blunter instrument than Rank's lead marginalisation and it is the one that
 * fits in the time available. Recorded as
 * `rank-enumerates-every-six-with-no-bound`.
 */
async function matrixParty(page) {
	await page.evaluate(() => {
		const el = document.querySelector('#runbun-run-matrix');
		if (el) el.innerHTML = '';
	});
	// The readiness cell's Check-matchup button is REPLACED by the verdict it
	// produces, so it works exactly once and then silently is not there. The
	// upcoming list's per-trainer Matchups control is stable; its first row is
	// the next fight.
	const asked = await page.evaluate(() => {
		const el = document.querySelector('#runbun-run-upcoming .runbun-run-up-board') ||
			document.querySelector('#runbun-run-ready-risk-check');
		if (el) el.click();
		return !!el;
	});
	if (!asked) {
		problem('matrix', 'no control on screen asks for a matchup board');
		return false;
	}
	try {
		await page.waitForFunction(
			() => document.querySelectorAll('#runbun-run-matrix table').length >= 2,
			null, {timeout: 120000});
	} catch (error) {
		problem('matrix', 'the matchup board never rendered — ' +
			(await text(page, '#runbun-run-status')));
		return false;
	}
	const scored = await page.evaluate(() => {
		const tables = Array.from(document.querySelectorAll('#runbun-run-matrix table'));
		if (tables.length < 2) return [];
		const read = table => Array.from(table.querySelectorAll('tbody tr')).map(row => ({
			name: (row.querySelector('th') || {}).textContent || '',
			cells: Array.from(row.querySelectorAll('td')).map(cell => {
				const hit = /(\d+)/.exec(cell.textContent || '');
				return hit ? Number(hit[1]) : 0;
			}),
		}));
		const ours = read(tables[0]);
		const theirs = read(tables[1]);
		return ours.map((row, i) => {
			const against = (theirs[i] || {}).cells || [];
			const deal = row.cells.reduce((a, b) => a + b, 0);
			const take = against.reduce((a, b) => a + b, 0);
			return {name: row.name.trim(), score: deal - take};
		});
	});
	if (scored.length < 2) return false;
	scored.sort((a, b) => b.score - a.score);
	const view = await readRun(page);
	const alive = view.box.filter(mon => mon.status !== 'dead');
	const wanted = [];
	for (const row of scored) {
		if (wanted.length >= PARTY_LIMIT) break;
		// The row header is "<name> L<level>"; match it back to a box entry.
		const label = row.name.replace(/\s+L\d+$/, '').trim();
		const mon = alive.find(entry => (entry.species === label) &&
			wanted.indexOf(entry.id) === -1);
		if (mon) wanted.push(mon.id);
	}
	if (wanted.length < Math.min(PARTY_LIMIT, alive.length)) return false;
	note('matrix', 'best six by matchup: ' +
		scored.slice(0, PARTY_LIMIT).map(row => row.name.replace(/\s+L\d+$/, '') +
			' ' + row.score).join(' · '));
	return stageParty(page, wanted, 'matrix');
}

/**
 * The tool's own answer to "who should fight this": Rank scores every legal
 * six against the next trainer. Following it is the strongest form of
 * following the plan — and it is also the only way to find out whether the
 * ranking is worth anything.
 *
 * The rows carry no ids, only species with the lead in brackets, so the six
 * is matched back to the box by species. The dupes clause keeps that
 * unambiguous; without it the first living match is taken.
 */
async function rankParty(page) {
	const view = await readRun(page);
	if (view.box.filter(mon => mon.status !== 'dead').length < 2) return false;
	await page.evaluate(() => {
		const list = document.querySelector('#runbun-run-ranking');
		if (list) list.innerHTML = '';
	});
	await press(page, '#runbun-run-rank');
	try {
		await page.waitForFunction(
			() => document.querySelectorAll('#runbun-run-ranking li').length > 0,
			null, {timeout: 180000});
	} catch (error) {
		problem('rank', 'the ranker never answered — ' + (await text(page, '#runbun-run-status')));
		return false;
	}
	const top = await page.evaluate(() => {
		const row = document.querySelector('#runbun-run-ranking li');
		return {
			six: (row.querySelector('.runbun-run-rank-six') || {}).textContent || '',
			whole: row.textContent.trim().replace(/\s+/g, ' '),
			note: (document.querySelector('#runbun-run-rank-note') || {}).textContent || '',
		};
	});
	note('rank', top.whole);
	const names = top.six.trim().split(/\s+/).filter(Boolean);
	const lead = names.find(name => name.charAt(0) === '[');
	const ordered = (lead ? [lead].concat(names.filter(name => name !== lead)) : names)
		.map(name => name.replace(/^\[/, '').replace(/\]$/, ''));
	const alive = view.box.filter(mon => mon.status !== 'dead');
	const wanted = [];
	for (const species of ordered) {
		const mon = alive.find(entry => entry.species === species &&
			wanted.indexOf(entry.id) === -1);
		if (mon) wanted.push(mon.id);
	}
	if (wanted.length !== ordered.length) {
		problem('rank', 'the ranked six names ' + ordered.join(', ') +
			' but only ' + wanted.length + ' matched a living box entry');
	}
	if (!wanted.length) return false;
	return stageParty(page, wanted, 'ranked');
}

/**
 * "Best upgrades for the next fight" — the panel prices every teach, give and
 * pickup available right now against the fight ahead and sorts them by what
 * they gain. That includes TM and tutor moves, which levelling never reaches,
 * so a party that only knows its level-up moves is a party playing without
 * half the planning system.
 *
 * The rows are not controls (`rank-answer-is-not-a-control` is the same shape
 * one panel over), so each one is read and carried out by hand. One at a time,
 * re-asking after each: applying an upgrade changes every other row's price.
 */
async function followAdvice(page, rounds) {
	for (let round = 0; round < (rounds || 3); round++) {
		if (outOfTime()) return;
		await page.evaluate(() => {
			const list = document.querySelector('#runbun-run-advice');
			if (list) list.innerHTML = '';
		});
		await press(page, '#runbun-run-advise');
		try {
			await page.waitForFunction(
				() => document.querySelectorAll('#runbun-run-advice li').length > 0,
				null, {timeout: 120000});
		} catch (error) {
			problem('advise', 'the upgrade list never arrived — ' +
				(await text(page, '#runbun-run-status')));
			return;
		}
		// The note carries the size of the search AND what was left out of it:
		// "N available upgrades compared · M TM/tutor moves skipped because
		// their unlock timing is unknown". The second number is the planning
		// system's own measure of how much of itself it cannot use.
		const summary = await text(page, '#runbun-run-advice-note');
		if (round === 0 && summary && !adviceReported.has(summary.replace(/^[^·]+/, ''))) {
			adviceReported.add(summary.replace(/^[^·]+/, ''));
			note('advise', summary);
		}
		const rows = await page.$$eval('#runbun-run-advice .runbun-run-advice-row',
			els => els.map(el => {
				const part = sel => ((el.querySelector(sel) || {}).textContent || '').trim();
				return {
					who: part('.runbun-run-advice-who'),
					kind: part('.runbun-run-advice-kind'),
					what: part('.runbun-run-advice-what'),
					ko: part('.runbun-run-advice-ko'),
					damage: Number(part('.runbun-run-advice-damage')) || 0,
				};
			}));
		const best = rows.find(row => row.damage > 0 && !appliedAdvice.has(row.who + row.what));
		if (!best) return;
		appliedAdvice.add(best.who + best.what);
		if (!await applyUpgrade(page, best)) return;
	}
}

/** Advice already carried out, so a row that reappears priced the same is not
 * attempted a second time in the same fight. */
let appliedAdvice = new Set();

/** Map the advice row's `who` — a mon label — back to something selectable. */
async function idForLabel(page, label) {
	const rows = await page.evaluate(() => {
		const seen = [];
		const push = el => seen.push({
			id: el.getAttribute('data-id'),
			label: el.textContent.replace(/at cap$/, '').trim(),
		});
		document.querySelectorAll('#runbun-run-party-strip .runbun-run-party-select[data-id]')
			.forEach(push);
		document.querySelectorAll('#runbun-run-box .runbun-run-mon-select[data-id]').forEach(push);
		return seen;
	});
	const hit = rows.find(row => row.label === label);
	return hit ? hit.id : null;
}

async function applyUpgrade(page, row) {
	const id = await idForLabel(page, row.who);
	if (!id) {
		problem('advise', 'the upgrade names "' + row.who + '", which is on no list');
		return false;
	}
	if (/Pick up/.test(row.kind)) {
		const item = /^(.+?) \(pickup @ /.exec(row.what);
		if (!item) return false;
		const take = await page.$('#runbun-run .runbun-run-pickup-take[data-item="' +
			item[1] + '"]');
		if (!take) {
			// Expected, and recorded as `pickup-upgrade-does-not-say-when-you-
			// can-take-it`: the advisor plans ahead of the pickup list's
			// progress gate, so an upgrade can name an item the panel will not
			// hand over yet. A note, not a problem — it is the product's
			// documented shape, not a fault in this run.
			note('advise', 'the upgrade names ' + item[1] +
				', which no route offers yet — the advisor is planning ahead of the gate');
			return false;
		}
		const took = await act(page, 'take ' + item[1], () => take.click());
		if (!took.changed) return false;
		note('advise', 'picked up ' + item[1] + ' because the upgrade list priced it at ' +
			row.damage);
		return applyUpgrade(page, {who: row.who, kind: 'Give item',
			what: item[1], damage: row.damage});
	}
	if (!await selectMon(page, id)) return false;
	if (/Give item/.test(row.kind)) {
		const item = (/^(.+?)(?: over .+)?$/.exec(row.what) || [])[1];
		if (!item || notHoldable.has(item)) return false;
		await page.selectOption('#runbun-run-hold-item', item);
		const given = await act(page, 'give ' + item, () => page.click('#runbun-run-give'));
		if (!given.changed) {
			notHoldable.add(item);
			return false;
		}
		note('advise', row.who + ' holds ' + item + '  (' + row.ko + ' ' + row.damage + ')');
		return true;
	}
	if (/Teach move/.test(row.kind)) {
		const parsed = /^(.+?)(?: over (.+?))?(?: \(one Heart Scale\))?$/.exec(row.what);
		if (!parsed) return false;
		await page.fill('#runbun-run-move', parsed[1]);
		await page.selectOption('#runbun-run-replace', parsed[2] || '');
		const taught = await act(page, 'teach ' + parsed[1],
			() => page.click('#runbun-run-teach'));
		if (!taught.changed) {
			note('advise', row.who + ' could not learn ' + parsed[1] + ' — ' + taught.status);
			return false;
		}
		note('advise', row.who + ' learned ' + parsed[1] +
			(parsed[2] ? ' over ' + parsed[2] : '') +
			'  (' + row.ko + ' ' + row.damage + ')');
		return true;
	}
	return false;
}

/** The plan before the fight: what the panel says will happen, recorded now so
 * the fight can be compared against it afterwards. */
async function readPlan(page) {
	// Plan is a READ, not a command: it never touches the save and never
	// writes the status line, so the only honest completion signal is a fresh
	// verdict. Clearing the old one first is what makes "fresh" checkable —
	// otherwise the previous fight's verdict answers for this one.
	await page.evaluate(() => {
		const el = document.querySelector('#runbun-run-plan-verdict');
		if (el) el.textContent = '';
	});
	await press(page, '#runbun-run-plan');
	// A verdict OR a refusal — waiting only for the verdict spends the whole
	// timeout staring at an error the panel already printed.
	try {
		await page.waitForFunction(() => {
			const verdict = (document.querySelector('#runbun-run-plan-verdict') || {}).textContent;
			const status = document.querySelector('#runbun-run-status');
			return !!verdict || (status && status.getAttribute('data-kind') === 'error');
		}, null, {timeout: 120000});
	} catch (error) {
		problem('plan', 'the plan never produced a verdict — ' +
			(await text(page, '#runbun-run-status')));
		return null;
	}
	if (!await text(page, '#runbun-run-plan-verdict')) {
		const refusal = await text(page, '#runbun-run-status');
		if (await unbrickHeldItems(page, refusal)) return readPlan(page);
		problem('plan', 'refused — ' + refusal);
		return null;
	}
	const read = await page.evaluate(() => {
		const txt = sel => {
			const el = document.querySelector(sel);
			return el ? el.textContent.trim() : '';
		};
		return {
			verdict: txt('#runbun-run-plan-verdict'),
			outlook: txt('#runbun-run-plan-outlook-result'),
			evidence: txt('#runbun-run-plan-evidence'),
			provider: typeof window.RunBunPokemonProvider,
			providerRows: document.querySelectorAll(
				'#runbun-run-plan-actions .runbun-run-action.is-provider').length,
			top: txt('#runbun-run-plan-actions .runbun-run-action.is-top'),
			actions: Array.from(document.querySelectorAll('#runbun-run-plan-actions .runbun-run-action'))
				.map(el => el.textContent.trim().replace(/\s+/g, ' ')),
		};
	});
	const lead = /· lead (.+?) ·/.exec(read.top || '');
	read.lead = lead ? lead[1].trim() : null;
	// The fair-dice forecast is the only thing in the plan that speaks about
	// SURVIVING. Without it the verdict is an action-ranking margin, which
	// reads like a judgement on the fight and is not one — so its absence is
	// reported once, loudly, rather than left as a grey row under the list.
	const dead = (read.actions || []).find(row => /seed check unavailable/.test(row));
	if (dead && !forecastReported.has(dead)) {
		forecastReported.add(dead);
		problem('plan', 'no fair-dice forecast for the rest of this run — ' +
			dead.replace(/^—/, '').trim());
	}
	read.forecast = dead ? 'unavailable' : read.lead ? 'live' : 'absent';
	return read;
}

/**
 * The plan names a lead. Sending someone else out is not following it, and
 * lead choice is the one pre-fight decision that changes every turn after.
 */
async function followLead(page, plan) {
	if (!plan || !plan.lead) return;
	const slots = await page.$$eval('#runbun-run-party-strip .runbun-run-party-slot[data-id]',
		els => els.map(el => ({
			id: el.getAttribute('data-id'),
			name: ((el.querySelector('.runbun-run-party-name') || {}).textContent || '').trim(),
		})));
	const at = slots.findIndex(slot => slot.name === plan.lead);
	if (at <= 0) {
		if (at < 0 && slots.length) {
			note('plan', 'the plan leads with ' + plan.lead + ', which is not in the party');
		}
		return;
	}
	for (let step = 0; step < at; step++) {
		const up = await page.$('#runbun-run-party-strip .runbun-run-party-up[data-id="' +
			slots[at].id + '"]');
		if (!up) break;
		await up.click();
		await page.waitForTimeout(40);
	}
	const set = await act(page, 'lead ' + plan.lead,
		() => page.click('#runbun-run-set-party'));
	note('plan', 'leading with ' + plan.lead + ' as planned — ' + set.status);
}

// ------------------------------------------------------------------ the fight

/** The damage line under a move, read the way a player reads it. */
function scoreMove(entry) {
	const damage = entry.damage || '';
	const floor = /(\d+)%\+/.exec(damage);
	const range = /(\d+)–(\d+)%/.exec(entry.title || '');
	return {
		move: entry.move,
		label: entry.label,
		floorKO: /KOs on any roll/.test(damage),
		guaranteedKO: /· KO$/.test(damage),
		min: floor ? Number(floor[1]) : (range ? Number(range[1]) : 0),
		max: range ? Number(range[2]) : (floor ? Number(floor[1]) : 0),
		damaging: !!floor || !!range,
	};
}

/**
 * The best ATTACK on the bar, or null when there is no attack at all.
 *
 * `damaging` is the whole point of the filter. Without it a Pokemon whose
 * moves are all status scored every one of them at zero, picked the first,
 * and pressed it again next turn for the same reason: a L12 Abra used Kinesis
 * seven times running while a Clobbopus ground it to nothing, because Kinesis
 * was, technically, the highest floor available. Null here is the honest
 * answer — nothing on this bar hurts anything — and the caller switches.
 */
function bestMove(view) {
	const scored = view.moves.filter(entry => !entry.ball).map(scoreMove)
		.filter(entry => entry.damaging && entry.max > 0);
	if (!scored.length) return null;
	scored.sort((a, b) =>
		(b.floorKO ? 1 : 0) - (a.floorKO ? 1 : 0) ||
		(b.guaranteedKO ? 1 : 0) - (a.guaranteedKO ? 1 : 0) ||
		b.min - a.min || b.max - a.max);
	return scored[0];
}

/**
 * What a status move DOES, asked of the engine rather than kept as a second
 * copy of the list. The driver pressed damage and nothing else, and 36% of
 * every moveset it carried — 63 of 177 moves across six runs, four of them
 * Sing — was a status move it never touched, while the opposing AI threw
 * Thunder Wave and Attract every turn. That asymmetry, not damage, is what
 * was losing the fights: 8.1% of our turns lost against 0.6% of theirs.
 */
function inflictedStatus(moveName) {
	const id = String(moveName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
	if (ai.STATUS_BY_MOVE[id]) return ai.STATUS_BY_MOVE[id];
	if (ai.PURE_CONFUSION_MOVE_IDS.has(id)) return 'confusion';
	return null;
}

// Sleep costs the most turns, paralysis costs a quarter of them and halves the
// speed, confusion costs a third and self-damages. Poison and burn are chip,
// which is a damage race we are already winning, so they rank below.
const STATUS_WORTH = {slp: 5, par: 4, confusion: 3, frz: 5, tox: 2, psn: 1, brn: 1};

/** The best status move on the bar, or null if none is worth a turn. */
function bestStatusMove(view) {
	const scored = view.moves
		.filter(entry => !entry.ball && !/%/.test(entry.damage || ''))
		.map(entry => ({
			move: entry.move,
			status: inflictedStatus(entry.move),
			accuracy: ai.getMoveMetadata(entry.move, 8).accuracy,
		}))
		.filter(entry => entry.status && STATUS_WORTH[entry.status]);
	if (!scored.length) return null;
	scored.sort((a, b) => STATUS_WORTH[b.status] - STATUS_WORTH[a.status] ||
		(b.accuracy || 100) - (a.accuracy || 100));
	return scored[0];
}

/**
 * Who to send in, not just who has the most health left.
 *
 * The switch buttons carry a species and a percentage, and the threat line
 * above them names the hardest hit coming — "Their hardest hit: Sonic Boom
 * 56%". A player reads both and sends in the thing that resists; the driver
 * was reading only the percentage and sending in the healthiest body, which
 * against a fixed-damage Normal move is exactly the wrong answer. Sonic Boom
 * killed 13 of 46 Pokemon in one batch and a Ghost-type is immune to it.
 *
 * Species typing is the player's own team, shown on the active card and known
 * to anyone who has looked at their party, so reading it here is not the
 * driver seeing more than the screen shows.
 */
function typesOf(species) {
	try {
		const gen = calc.Generations.get(8);
		const found = gen.species.get(calc.toID(species));
		return found && found.types ? found.types.slice() : [];
	} catch (error) {
		return [];
	}
}

/** How hard `moveType` lands on a Pokemon of these types. 0 is immune. */
function multiplierAgainst(moveType, defenderTypes) {
	if (!moveType || !defenderTypes.length) return 1;
	try {
		const chart = calc.Generations.get(8).types.get(calc.toID(moveType));
		if (!chart || !chart.effectiveness) return 1;
		return defenderTypes.reduce((total, type) => {
			const each = chart.effectiveness[type];
			return total * (each === undefined ? 1 : each);
		}, 1);
	} catch (error) {
		return 1;
	}
}

/**
 * Moves that take two turns to land one hit: the chargers, the semi-invulnerable
 * turns, and the ones that spend the turn after. Halved rather than banned,
 * because a big enough number still wins some races.
 */
const TWO_TURN_MOVES = new Set([
	'Solar Beam', 'Solar Blade', 'Sky Attack', 'Razor Wind', 'Skull Bash',
	'Ice Burn', 'Freeze Shock', 'Meteor Beam', 'Electro Shot', 'Geomancy',
	'Bounce', 'Dig', 'Dive', 'Fly', 'Phantom Force', 'Shadow Force',
	'Hyper Beam', 'Giga Impact', 'Blast Burn', 'Hydro Cannon', 'Frenzy Plant',
	'Rock Wrecker', 'Roar of Time', 'Prismatic Laser', 'Eternabeam',
	'Meteor Assault', 'Hyperspace Fury',
]);

/**
 * The types the next fight will field, read off the matchup board.
 *
 * matrixParty renders that board before any teaching happens, and every cell
 * carries the enemy it was priced against, so the roster is already on screen
 * by the time a move has to be chosen.
 *
 * Returns [] when no board is up — with --party=rank or box order there is
 * nothing to read, and the caller falls back to raw power rather than
 * inventing an opponent.
 */
async function upcomingEnemyTypes(page) {
	const names = await page.evaluate(() => Array.from(new Set(
		Array.from(document.querySelectorAll('#runbun-run-matrix td[data-enemy]'))
			.map(cell => cell.getAttribute('data-enemy')))));
	return names.map(typesOf).filter(types => types.length);
}

/** The type of the hardest hit the threat line is warning about. */
function incomingType(view) {
	const named = /Their hardest hit: (.+?) \d/.exec(view.threat || '');
	if (!named) return null;
	try {
		return ai.getMoveMetadata(named[1].trim(), 8).type || null;
	} catch (error) {
		return null;
	}
}

/** Whether a boxed Pokemon owns a move that can damage anything at all. */
function canAttack(roster, id) {
	const mon = (roster || []).find(entry => entry.id === id);
	if (!mon) return true;
	return (mon.moves || []).some(name => {
		try {
			return ai.getMoveMetadata(name, 8).category !== 'Status';
		} catch (error) {
			return true;
		}
	});
}

function healthiestSwitch(view, roster) {
	const incoming = incomingType(view);
	const options = view.switches.map(entry => {
		const hit = /(\d+)%$/.exec(entry.label);
		const species = entry.label.replace(/\s+\d+%$/, '').trim();
		const taking = multiplierAgainst(incoming, typesOf(species));
		return {
			id: entry.id, label: entry.label, species: species,
			hp: hit ? Number(hit[1]) : 0,
			taking: taking,
			// Sending in a Pokemon that cannot damage anything is how Abra
			// arrived in front of a Clobbopus and pressed Kinesis until it
			// died. Its own moves are on its summary screen, so this is not
			// the driver seeing more than the player.
			armed: canAttack(roster, entry.id),
		};
	}).filter(entry => entry.hp > 0);
	if (!options.length) return null;
	// Armed first, then resistance, then health. An immune body at 40% takes
	// the hit a healthy neutral one dies to, and a switch concedes a free turn
	// either way — so what matters is what that free turn buys.
	options.sort((a, b) => (b.armed ? 1 : 0) - (a.armed ? 1 : 0) ||
		a.taking - b.taking || b.hp - a.hp);
	return options[0];
}

function decide(view, memory, roster) {
	if (/Choose the next Pokemon/.test(view.prompt)) {
		const replacement = healthiestSwitch(view, roster);
		return replacement ?
			{kind: 'switch', pick: replacement, why: 'forced replacement'} :
			null;
	}
	const move = bestMove(view);
	if (move && (move.floorKO || move.guaranteedKO)) {
		return {kind: 'move', pick: move, why: 'it KOs'};
	}
	// Cannot end it this turn, and this one is not already locked down: spend
	// the turn taking THEIR turns away instead. Once per opposing Pokemon, so a
	// missed Sing cannot become a Sing loop, and never while a crit would kill
	// us — a turn we might not survive is not a turn to spend on setup.
	// Infatuation and confusion are VOLATILE, and the ordinary switch reset
	// clears them — unlike paralysis, which it does not. So when the card says
	// we are immobilised, the answer is the switch button: a Pokemon that acts
	// half the time is worth less than a fresh body taking one hit. Bounded at
	// two per fight so it cannot become a switch loop, and only into something
	// healthy enough to take the free hit that switching concedes.
	// Budgeted per FIGHT, not per two turns. Lady Cindy fields three Cute
	// Charm users whose movepool is Attract and Thunder Wave, so a bound of
	// two was spent by turn seven and a Paras then stood infatuated for five
	// turns, at 100% HP down to 0, against a Jigglypuff that never dropped
	// below 78%. Six is a party: more switches than bodies is a loop.
	if (/infatuated|confused/.test(view.us) && memory.cleared < 6) {
		const fresh = healthiestSwitch(view, roster);
		if (fresh && fresh.hp >= 50) {
			memory.cleared += 1;
			return {kind: 'switch', pick: fresh, why: 'switching clears it'};
		}
	}
	// Nothing on this bar can hurt it. Standing here pressing a status move
	// is how a L12 Abra spent seven turns on Kinesis and died to a L9
	// Clobbopus. Leave — and leave for something that can fight, which is what
	// `armed` is for. Bounded so a party of pacifists cannot switch forever.
	if (!move && memory.disarmed < 2) {
		const armed = healthiestSwitch(view, roster);
		if (armed && armed.armed) {
			memory.disarmed += 1;
			return {kind: 'switch', pick: armed, why: 'nothing here can damage it'};
		}
	}
	const losingRace = /YOU LOSE THIS RACE|NOTHING HERE DAMAGES IT/.test(view.threat);
	// Status is worth MOST when the race is lost, not least. The old guard
	// refused it whenever a crit would kill us, which against Camper Gavi's
	// five is almost every turn — so the driver traded damage it could not win
	// on and never once put anything to sleep. If we cannot win by attacking,
	// taking their turn away is the only line there is.
	const status = bestStatusMove(view);
	if (status && (view.risk !== 'lethal' || losingRace) &&
		!memory.statusedFoes.has(view.foe)) {
		memory.statusedFoes.add(view.foe);
		return {kind: 'move', pick: {move: status.move},
			why: 'to take a turn off it (' + status.status + ')'};
	}
	const lethal = view.risk === 'lethal';
	if ((losingRace || lethal) && !memory.switchedFor.has(view.foe)) {
		const replacement = healthiestSwitch(view, roster);
		// Only if the body coming in actually RESISTS. A switch concedes a
		// free hit, and against a five-Pokemon team the driver was donating
		// one every time the threat line said the race was lost — switching
		// from a healthy Prinplup into a Bunnelby that died in two turns.
		// Swapping one losing matchup for another is worse than attacking.
		if (replacement && replacement.taking < 1) {
			memory.switchedFor.add(view.foe);
			return {kind: 'switch', pick: replacement,
				why: (losingRace ? 'the race is lost' : 'a crit KOs us') +
					', and this one resists'};
		}
	}
	if (move) return {kind: 'move', pick: move, why: 'highest floor'};
	// Last resort has to be a MOVE, not a switch. Falling through to "switch
	// to whoever is healthiest" with no damaging move anywhere turned Fisherman
	// Darian into 300 turns of switching: nothing could end it, so nothing did.
	// Pressing a status move for the second time is a wasted turn; switching
	// forever is a wasted fight.
	const anything = view.moves.filter(entry => !entry.ball)[0];
	if (anything) {
		return {kind: 'move', pick: {move: anything.move},
			why: 'nothing damages it — pressing something beats switching forever'};
	}
	const replacement = healthiestSwitch(view, roster);
	return replacement ? {kind: 'switch', pick: replacement, why: 'nothing to click'} : null;
}


/**
 * EXPERIMENT, not ordinary play: teach the best move the panel says this
 * Pokemon can learn, on the assumption that the player owns the TM.
 *
 * The run stops at Camper Gavi with a party carrying level-up movesets, and
 * the advisor withholds 82 TM and tutor moves at that exact fight because
 * their unlock timing is unknown — including the ones that answer the two
 * Pokemon Rank names as unanswered. `teach` ACCEPTS those moves; only the
 * advisor withholds them, and correctly, since it cannot say when you get
 * them. So this asks one question and no other: is the TM data gap really
 * the wall, or is something else?
 *
 * It assumes items the run has not recorded, which is exactly the provenance
 * the rest of this driver refuses. That is why it is off by default and named
 * `assume`, and why nothing it produces is a claim about a real run.
 *
 * Everything goes through the panel: `#runbun-run-learnable` fetches what the
 * Pokemon can learn NOW and fills the datalist the player picks from.
 */
async function assumeTms(page, roster) {
	// Read once, not per Pokemon: the board is the same for all six.
	const enemies = await upcomingEnemyTypes(page);
	for (const mon of roster.filter(entry => entry.status !== 'dead').slice(0, PARTY_LIMIT)) {
		if (outOfTime()) return;
		// Only when something changed. Asking for every party member every
		// fight cost 150s a fight and taught nothing new.
		if (taughtAt.get(mon.id) === mon.level) continue;
		taughtAt.set(mon.id, mon.level);
		if (!await selectMon(page, mon.id)) continue;
		// The Learnable button fills a TEXT line, not the datalist — the
		// datalist is refreshed on selection and is cached per Pokemon, so
		// clearing it and pressing the button populated nothing and this
		// taught nothing at all on its first outing.
		await page.evaluate(() => {
			const el = document.querySelector('#runbun-run-learn-now');
			if (el) el.textContent = '';
		});
		await press(page, '#runbun-run-learnable');
		try {
			await page.waitForFunction(
				() => ((document.querySelector('#runbun-run-learn-now') || {}).textContent || '')
					.trim().length > 0,
				null, {timeout: 20000});
		} catch (error) {
			continue;
		}
		const listed = await text(page, '#runbun-run-learn-now');
		if (/^\(nothing\)/.test(listed)) continue;
		// A starred move is an egg move the relearner charges a Heart Scale
		// for; this experiment does not assume the bag, only the TM.
		const offered = listed.split(',').map(entry => entry.trim())
			.filter(entry => entry && entry.indexOf('*') === -1)
			// Raw base power would pick Explosion. The advisor refuses a
			// sacrifice as an upgrade on purpose — "the advisor never teaches
			// suicide" is its own gate — and an experiment that ignores that
			// is measuring a different game.
			.filter(entry => !/^(Explosion|Self-Destruct|Final Gambit|Misty Explosion|Memento|Healing Wish|Lunar Dance)$/.test(entry));
		const bp = name => {
			try {
				const meta = ai.getMoveMetadata(name, 8);
				return meta.category === 'Status' ? 0 : (meta.basePower || 0);
			} catch (error) {
				return 0;
			}
		};
		// Base power is what a move does; effectiveness is what it does to
		// THEM. Ranked on raw power alone this taught Take Down over Wing
		// Attack, and 160 of 171 Brawly plans then opened with Brick Break —
		// a Fighting move into a team that is more than half Fighting. Wing
		// Attack is 60 BP against Take Down's 90 and lands for twice as much
		// on four of his six, so priced against the fight in front of us that
		// ordering flips. STAB is in here for the same reason a 90 BP Ice
		// Beam lost to a 65 BP Bubble Beam on a Water Pokemon.
		const mine = typesOf(mon.species);
		const value = name => {
			const base = bp(name);
			if (!base) return 0;
			let meta;
			try {
				meta = ai.getMoveMetadata(name, 8);
			} catch (error) {
				return base;
			}
			const stab = mine.indexOf(meta.type) === -1 ? 1 : 1.5;
			// A move that spends two turns to hit once is worth half its base
			// power, and the metadata carries no charge or recharge flag to
			// read it off — so the list is spelled out, the same way the
			// sacrifice moves above are. This matters more here than the raw
			// number suggests: these runs lose on turns, not on damage, and
			// the first thing the new ranking did was put Solar Beam on an
			// Exeggcute at 120 base power.
			const turns = TWO_TURN_MOVES.has(name) ? 0.5 : 1;
			if (!enemies.length) return base * stab * turns;
			const lands = enemies.reduce((total, types) =>
				total + multiplierAgainst(meta.type, types), 0) / enemies.length;
			return base * stab * turns * lands;
		};
		const known = (mon.moves || []).slice();
		// Never trade away the party's only lock. This heuristic picks the
		// highest base power and replaces the WEAKEST move, which is always
		// the status one — so it stripped Sing, Stun Spore and Sleep Powder
		// off every Pokemon and handed Brawly a party that could only trade
		// damage with a Lopunny that heals itself with Drain Punch. Taking
		// their turn away is what beat Camper Gavi one fight earlier.
		const locks = known.filter(name => inflictedStatus(name));
		const best = offered.filter(name => known.indexOf(name) === -1)
			.sort((a, b) => value(b) - value(a))[0];
		if (!best || value(best) === 0) continue;
		const droppable = known.filter(name => !inflictedStatus(name) || locks.length > 1);
		if (!droppable.length) continue;
		const weakest = droppable.slice().sort((a, b) => value(a) - value(b))[0];
		if (weakest && value(best) <= value(weakest)) continue;
		await page.fill('#runbun-run-move', best);
		await page.selectOption('#runbun-run-replace', known.length >= 4 ? weakest : '');
		const taught = await act(page, 'assume ' + best, () => page.click('#runbun-run-teach'));
		if (taught.changed) {
			note('tm', mon.species + ' learned ' + best + ' (' + bp(best) + ' BP, ' +
				Math.round(value(best)) + ' against this fight)' +
				(known.length >= 4 ? ' over ' + weakest : ''));
		}
	}
}

/** Press a control without waiting for it to hold still.
 *
 * Playwright's click waits for an element to be "stable", and with a large
 * box the panel re-renders often enough that the analysis buttons never are —
 * a caps run died on `#runbun-run-rank` after eight fights with "element is
 * not stable". These are ordinary jQuery handlers on a fixed id, so
 * dispatching the click is the same event the player produces.
 */
function press(page, selector) {
	return page.evaluate(sel => {
		const el = document.querySelector(sel);
		if (el) el.click();
		return !!el;
	}, selector);
}

/** Press Fight and wait for the battle OR for the panel to say why not. */
async function openFight(page) {
	await press(page, '#runbun-run-play');
	try {
		await page.waitForFunction(() => {
			const panel = document.querySelector('#runbun-run-battle');
			const status = document.querySelector('#runbun-run-status');
			return (panel && !panel.hidden) ||
				(status && status.getAttribute('data-kind') === 'error');
		}, null, {timeout: 30000});
	} catch (error) {
		return false;
	}
	return page.evaluate(() => {
		const panel = document.querySelector('#runbun-run-battle');
		return !!panel && !panel.hidden;
	});
}

async function playFight(page, plan, roster) {
	const memory = {switchedFor: new Set(), statusedFoes: new Set(), cleared: 0, disarmed: 0};
	const turns = [];
	let lastFoe = '';
	for (let turn = 0; turn < 300; turn++) {
		if (outOfTime()) return {turns: turns, outcome: 'out of time'};
		const view = await readBattle(page);
		if (/recorded/.test(view.result)) break;
		if (!view.open) break;
		if (view.foe !== lastFoe) {
			lastFoe = view.foe;
			if (view.threat) note('threat', view.foe + ' — ' + view.threat);
		}
		const choice = decide(view, memory, roster);
		if (!choice) {
			await page.waitForTimeout(200);
			continue;
		}
		const selector = choice.kind === 'move' ?
			'#runbun-run-battle-moves .runbun-run-battle-move[data-move="' +
				choice.pick.move + '"]' :
			'#runbun-run-battle-switches .runbun-run-battle-switch[data-replace="' +
				choice.pick.id + '"]';
		const button = await page.$(selector);
		if (!button) {
			await page.waitForTimeout(200);
			continue;
		}
		turns.push({
			us: view.us, usHp: view.usHp, foe: view.foe, foeHp: view.foeHp,
			bench: view.bench,
			offered: view.switches.map(entry => entry.label),
			did: choice.kind === 'move' ? choice.pick.move : 'switch ' + choice.pick.label,
			why: choice.why, threat: view.threat,
		});
		await button.click();
		try {
			await page.waitForFunction(
				() => !document.querySelector('#runbun-run-battle').hasAttribute('aria-busy'),
				null, {timeout: 30000});
		} catch (error) {
			problem('battle', 'a turn never came back against ' + view.trainer);
			return {turns: turns, outcome: 'stuck'};
		}
	}
	const ended = await readBattle(page);
	const outcome = /Won against/.test(ended.status) ? 'won' :
		/Wiped against/.test(ended.status) ? 'wiped' :
			ended.result || 'unknown';
	note('fight', ended.trainer + ' — ' + outcome + ' in ' + turns.length + ' turns' +
		(plan && plan.verdict ? '  (plan said: ' + plan.verdict + ')' : ''));
	return {turns: turns, outcome: outcome, log: ended.log, status: ended.status};
}

// ------------------------------------------------------------------ the run

async function main() {
	if (!chromium) {
		console.error('playwright-core is not installed');
		process.exit(2);
	}
	fs.mkdirSync(OUT, {recursive: true});
	const server = startServer(0);
	await new Promise(resolve => server.once('listening', resolve));
	const baseUrl = 'http://127.0.0.1:' + server.address().port;
	const browser = await chromium.launch({headless: !HEADED});
	const context = await browser.newContext();
	await context.route(/fonts\.(googleapis|gstatic)\.com/, route => route.abort());
	const page = await context.newPage();

	page.on('pageerror', error => problem('page', String(error)));
	page.on('console', message => {
		if (message.type() !== 'error') return;
		// The browser logs a console error for every non-2xx fetch. The
		// response handler below decides which of those are actually wrong;
		// echoing them here would double-count refusals as defects.
		if (/Failed to load resource/.test(message.text())) return;
		problem('console', message.text());
	});
	page.on('response', response => {
		if (response.status() < 400) return;
		// A refused command is the product working: `/run/apply` answers 400
		// with the reason the game would not allow it, and the panel prints it.
		// Only unexplained failures are problems.
		if (/\/run\/apply$/.test(response.url()) && response.status() === 400) {
			note('refusal', 'the server refused a command');
			return;
		}
		// The deployed-revision probe is a Worker route; the Node dev host has
		// no such endpoint and the page treats a miss as "revision unknown".
		if (/\/__runbun\/meta$/.test(response.url())) return;
		problem('network', response.status() + ' ' + response.url());
	});

	await page.goto(baseUrl + '/index.html#runbun-run', {waitUntil: 'domcontentloaded'});
	await page.waitForSelector('#runbun-run');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-map option').length > 100,
		null, {timeout: 20000});

	// Two rulesets, both the product's own. `hardcore` is the full nuzlocke —
	// caps, permadeath, one encounter per route, dupes by line — and it is the
	// harder test: a run ends when the whole box is dead, and the box cannot
	// refill faster than the walls empty it. `caps` is level caps alone, which
	// the run document supports directly (a faint "changed nothing" without
	// permadeath), and is how far the ADVICE can carry a run when losing a
	// Pokemon is not also losing the run.
	await page.check('#runbun-run-new-cap');
	if (RULES === 'hardcore') {
		await page.check('#runbun-run-new-nuzlocke');
		await page.check('#runbun-run-new-permadeath');
		await page.check('#runbun-run-new-route');
		await page.selectOption('#runbun-run-new-dupes', 'line');
	} else {
		await page.uncheck('#runbun-run-new-nuzlocke');
		await page.uncheck('#runbun-run-new-permadeath');
		await page.uncheck('#runbun-run-new-route');
		await page.uncheck('#runbun-run-new-shiny-clause');
		await page.selectOption('#runbun-run-new-dupes', 'off');
	}
	await page.fill('#runbun-run-new-name', 'UI playthrough');
	await page.click('.runbun-run-starter[data-species="' + STARTER + '"]');
	await page.waitForFunction(() => !document.querySelector('#runbun-run-new').disabled);
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])', {timeout: 20000});
	note('start', RULES + ' · ' + STARTER);

	const fights = [];
	let stalled = 0;
	for (let index = 0; index < MAX_FIGHTS && !outOfTime(); index++) {
		await openAllSections(page);
		const before = await readRun(page);
		if (/run map is complete|run is over/.test(before.nextTitle)) {
			note('end', before.nextTitle + ' — ' + before.nextDetail);
			break;
		}

		await takeEncounters(page);
		await takeItems(page);
		await levelAndEvolve(page);
		// The ranker needs a party to exist before it can score sixes, and its
		// answer replaces whatever box order put there.
		await buildParty(page);
		if (PARTY_MODE === 'rank') await rankParty(page);
		if (PARTY_MODE === 'matrix') await matrixParty(page);
		// Advice is priced against THIS fight and THIS party, so it comes after
		// the six are chosen. It covers giving and picking up as well as
		// teaching; equipParty only fills whatever it left bare.
		appliedAdvice = new Set();
		await followAdvice(page, ADVICE_ROUNDS);
		if (TMS === 'assume') await assumeTms(page, (await readRun(page)).box);
		await equipParty(page);

		const ready = await readRun(page);
		if (ready.playDisabled) {
			problem('run', 'nothing to do: ' + ready.nextTitle + ' / ' + ready.nextDetail);
			break;
		}
		if (!/^Fight /.test(ready.playLabel)) {
			problem('run', 'the panel offers "' + ready.playLabel + '" instead of a fight — ' +
				ready.nextTitle + ' / ' + ready.nextDetail);
			break;
		}

		// The pre-fight plan samples the fight against the pinned provider and
		// costs real seconds, so a long run prices it: every fight by default,
		// every Nth with --plan=N, and always for a milestone.
		const milestone = /Leader|Rival|Elite|Champion|Boss|Admin|Team /i
			.test(ready.nextTitle);
		const plan = (milestone || index % PLAN_EVERY === 0) ? await readPlan(page) : null;
		if (plan) {
			note('plan', plan.verdict + (plan.outlook ? ' · ' + plan.outlook : ''));
			if (plan.top) note('plan', plan.top.replace(/\s+/g, ' '));
			await followLead(page, plan);
		}

		let opened = await openFight(page);
		if (!opened) {
			// The one refusal a player can act on from the message alone.
			const refusal = await text(page, '#runbun-run-status');
			if (await unbrickHeldItems(page, refusal)) opened = await openFight(page);
			if (!opened) {
				problem('run', 'the fight never opened — ' + refusal);
				break;
			}
		}
		const played = await playFight(page, plan, ready.box);
		fights.push({
			trainer: ready.nextTitle.replace(/^Face /, ''),
			plan: plan, outcome: played.outcome, turns: played.turns.length,
			detail: played.turns, log: played.log || [],
		});

		// "Return to run" closes a RECORDED fight, so by design it writes
		// nothing and leaves the status line saying what was already written.
		// Waiting for a change here waits for something that must not happen.
		const back = await page.$('#runbun-run-battle-abandon');
		if (back) {
			await back.click();
			try {
				await page.waitForFunction(
					() => document.querySelector('#runbun-run-battle').hidden,
					null, {timeout: 15000});
			} catch (error) {
				problem('run', 'the finished fight would not close');
				break;
			}
		}

		const after = await readRun(page);
		if (after.position === before.position && played.outcome !== 'won') {
			stalled += 1;
			// Retrying the same six against a wall it cannot answer is not a
			// plan. Under `caps` an area can be rolled again, so forget which
			// areas have been used and go back for more Pokemon — the box is
			// what loses these fights, not the dice. One run beat Brawly and
			// the next could not pass Camper Gavi with the same policy and a
			// different roll.
			if (stalled % 3 === 0 && RULES !== 'hardcore') {
				caughtFrom.clear();
				note('run', 'stuck at ' + before.nextTitle + ' — reopening the routes for more');
			}
			// A boss is worth grinding; an ordinary trainer that has beaten
			// us a dozen times means this box cannot do it, and the budget is
			// better spent on a fresh run than on the same six. Camper Gavi
			// ate seventy attempts in one run and never fell; Brawly fell on
			// the thirteenth in another.
			const boss = /Leader|Elite|Champion|Rival/i.test(before.nextTitle);
			if (stalled >= (boss ? BOSS_RETRIES : RETRIES)) {
				problem('run', stalled + ' attempts with no progress at ' + before.nextTitle);
				break;
			}
		} else {
			stalled = 0;
		}
		if (played.outcome === 'out of time' || played.outcome === 'stuck') break;
	}

	// What the run actually cost in durable state. The browser is the only
	// stateful component — the server keeps nothing — so this is the whole
	// footprint of a playthrough, and it is worth knowing per fight.
	const durable = await page.evaluate(async () => {
		const open = indexedDB.open('runbun-attempts');
		const db = await new Promise((resolve, reject) => {
			open.onsuccess = () => resolve(open.result);
			open.onerror = () => reject(open.error);
		});
		const out = {};
		for (const name of Array.from(db.objectStoreNames)) {
			const rows = await new Promise((resolve, reject) => {
				const request = db.transaction(name, 'readonly').objectStore(name).getAll();
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			out[name] = {rows: rows.length, bytes: JSON.stringify(rows).length};
		}
		out.localStorage = {bytes: (localStorage.getItem('runbun.run.v1') || '').length};
		return out;
	}).catch(() => null);

	const final = await readRun(page);
	await page.screenshot({path: path.join(OUT, 'final.png'), fullPage: true});
	const report = {
		starter: STARTER,
		durable: durable,
		forecast: fights.map(fight => fight.plan && fight.plan.forecast).find(Boolean) || 'none',
		seconds: Math.round((Date.now() - started) / 1000),
		fights: fights.length,
		won: fights.filter(fight => fight.outcome === 'won').length,
		wiped: fights.filter(fight => fight.outcome === 'wiped').length,
		reached: final.nextTitle + ' — ' + final.nextDetail,
		position: final.position,
		box: final.box,
		problems: problems,
		journal: journal,
		detail: fights,
	};
	fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, '\t'));

	console.log('\n=== ' + report.fights + ' fights · ' + report.won + ' won · ' +
		report.wiped + ' wiped · ' + report.seconds + 's');
	console.log('reached: ' + report.reached);
	console.log('problems: ' + problems.length);
	for (const issue of problems.slice(0, 40)) {
		console.log('  - ' + issue.where + ': ' + issue.message);
	}

	await context.close();
	await browser.close();
	await new Promise((resolve, reject) =>
		server.close(error => error ? reject(error) : resolve()));
}

main().catch(error => {
	console.error(error);
	process.exit(1);
});
