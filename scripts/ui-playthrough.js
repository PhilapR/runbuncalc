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
 *   2. otherwise, if the threat line says the race is lost, switch (once per
 *      opposing Pokemon, so a losing race cannot become a switch loop);
 *   3. otherwise take the move with the highest floor.
 *
 * That makes the run a test of the ADVICE. If following the panel's own
 * displayed reasoning wipes the run, that is a finding about the panel.
 *
 *   node scripts/ui-playthrough.js
 *   node scripts/ui-playthrough.js --starter=Chimchar --fights=60 --budget=900
 *   node scripts/ui-playthrough.js --headed        # watch it play
 */

const fs = require('node:fs');
const path = require('node:path');

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
const HEADED = process.argv.includes('--headed');

const started = Date.now();
const journal = [];
const problems = [];
const forecastReported = new Set();

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
	const taken = [];
	for (const route of view.routes) {
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
			taken.push(rolled);
			note('caught', rolled + '  (' + route.map + ')');
		} else {
			await act(page, 'flee ' + route.map, () => page.click('#runbun-run-roll-flee'));
			note('lost', rolled + ' refused — ' + (kept.status || 'no reason given'));
		}
	}
	return taken;
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
	// Only the six that will actually fight. Levelling the whole box is what a
	// player does not do, and by the twentieth catch it costs more clicks per
	// fight than the fight does.
	const fighting = view.box.filter(mon => mon.status !== 'dead').slice(0, PARTY_LIMIT);
	for (const mon of fighting) {
		if (outOfTime()) break;
		const row = await page.$('#runbun-run-box .runbun-run-mon[data-id="' + mon.id +
			'"] .runbun-run-mon-select');
		if (!row) continue;
		await row.click();
		await page.waitForTimeout(40);
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

/** One id per SLOT. `[data-id]` also matches the name, up and remove buttons
 * inside each slot, so it reports every party member four times. */
function stagedIds(page) {
	return page.$$eval('#runbun-run-party-strip .runbun-run-party-slot[data-id]',
		els => els.map(el => el.getAttribute('data-id')));
}

async function buildParty(page) {
	const view = await readRun(page);
	const alive = view.box.filter(mon => mon.status !== 'dead');
	const wanted = alive.slice(0, PARTY_LIMIT).map(mon => mon.id);
	// Membership, not order. Order belongs to the plan's recommended lead, and
	// treating a reorder as "wrong" made this rebuild the party after every
	// fight for no reason.
	const sameSet = wanted.length === view.party.length &&
		wanted.every(id => view.party.indexOf(id) !== -1);
	if (sameSet) return;

	// Toggle against the CURRENT staging, re-read each time. `.runbun-run-add`
	// is a toggle and a late render resets the staging to the saved party, so a
	// blind remove-all-then-add-all can end up switching everything back off
	// and committing an empty party.
	for (let attempt = 0; attempt < 3; attempt++) {
		for (const id of await stagedIds(page)) {
			if (wanted.indexOf(id) !== -1) continue;
			const remove = await page.$('#runbun-run-party-strip .runbun-run-party-rm[data-id="' +
				id + '"]');
			if (remove) await remove.click();
		}
		for (const id of wanted) {
			if ((await stagedIds(page)).indexOf(id) !== -1) continue;
			const add = await page.$('#runbun-run-box .runbun-run-mon[data-id="' + id +
				'"] .runbun-run-add');
			if (add) await add.click();
		}
		const now = await stagedIds(page);
		if (now.length === wanted.length && wanted.every(id => now.indexOf(id) !== -1)) break;
	}
	const finalStaged = await stagedIds(page);
	if (!finalStaged.length) {
		problem('party', 'could not stage a party from ' + wanted.length + ' living Pokemon');
		return;
	}
	const offered = await page.evaluate(() => {
		const el = document.querySelector('.runbun-run-party-commit');
		return !!el && !el.hidden;
	});
	if (!offered) {
		problem('party', 'staged ' + wanted.length + ' but the panel offers no way to commit');
		return;
	}
	const set = await act(page, 'set party', () => page.click('#runbun-run-set-party'));
	const landed = (await savedRun(page)).party.length;
	if (landed !== wanted.length) {
		problem('party', 'committed ' + wanted.length + ' but the run kept ' + landed +
			' — ' + set.status);
	}
	note('party', landed + ' ready — ' + (set.status || 'committed'));
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
	await page.click('#runbun-run-plan');
	try {
		await page.waitForFunction(
			() => (document.querySelector('#runbun-run-plan-verdict') || {}).textContent,
			null, {timeout: 120000});
	} catch (error) {
		problem('plan', 'the plan never produced a verdict — ' +
			(await text(page, '#runbun-run-status')));
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

function bestMove(view) {
	const scored = view.moves.filter(entry => !entry.ball).map(scoreMove);
	if (!scored.length) return null;
	scored.sort((a, b) =>
		(b.floorKO ? 1 : 0) - (a.floorKO ? 1 : 0) ||
		(b.guaranteedKO ? 1 : 0) - (a.guaranteedKO ? 1 : 0) ||
		b.min - a.min || b.max - a.max);
	return scored[0];
}

function healthiestSwitch(view) {
	const options = view.switches.map(entry => {
		const hit = /(\d+)%$/.exec(entry.label);
		return {id: entry.id, label: entry.label, hp: hit ? Number(hit[1]) : 0};
	}).filter(entry => entry.hp > 0);
	options.sort((a, b) => b.hp - a.hp);
	return options[0] || null;
}

function decide(view, switchedFor) {
	if (/Choose the next Pokemon/.test(view.prompt)) {
		const replacement = healthiestSwitch(view);
		return replacement ?
			{kind: 'switch', pick: replacement, why: 'forced replacement'} :
			null;
	}
	const move = bestMove(view);
	if (move && (move.floorKO || move.guaranteedKO)) {
		return {kind: 'move', pick: move, why: 'it KOs'};
	}
	const losing = /YOU LOSE THIS RACE|NOTHING HERE DAMAGES IT/.test(view.threat);
	const lethal = view.risk === 'lethal';
	if ((losing || lethal) && !switchedFor.has(view.foe)) {
		const replacement = healthiestSwitch(view);
		if (replacement) {
			switchedFor.add(view.foe);
			return {kind: 'switch', pick: replacement,
				why: losing ? 'the panel says the race is lost' : 'a crit KOs us'};
		}
	}
	if (move) return {kind: 'move', pick: move, why: 'highest floor'};
	const replacement = healthiestSwitch(view);
	return replacement ? {kind: 'switch', pick: replacement, why: 'nothing to click'} : null;
}

async function playFight(page, plan) {
	const switchedFor = new Set();
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
		const choice = decide(view, switchedFor);
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

	// A full nuzlocke: caps, permadeath, one encounter per route, dupes by line.
	await page.check('#runbun-run-new-cap');
	await page.check('#runbun-run-new-nuzlocke');
	await page.check('#runbun-run-new-permadeath');
	await page.check('#runbun-run-new-route');
	await page.selectOption('#runbun-run-new-dupes', 'line');
	await page.fill('#runbun-run-new-name', 'UI playthrough');
	await page.click('.runbun-run-starter[data-species="' + STARTER + '"]');
	await page.waitForFunction(() => !document.querySelector('#runbun-run-new').disabled);
	await page.click('#runbun-run-new');
	await page.waitForSelector('#runbun-run-live:not([hidden])', {timeout: 20000});
	note('start', 'nuzlocke · permadeath · one per route · dupes by line · ' + STARTER);

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
		await levelAndEvolve(page);
		await buildParty(page);

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

		await page.click('#runbun-run-play');
		try {
			await page.waitForSelector('#runbun-run-battle:not([hidden])', {timeout: 30000});
		} catch (error) {
			problem('run', 'the fight never opened — ' + (await text(page, '#runbun-run-status')));
			break;
		}
		const played = await playFight(page, plan);
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
			if (stalled >= 3) {
				problem('run', 'three fights with no progress at ' + before.nextTitle);
				break;
			}
		} else {
			stalled = 0;
		}
		if (played.outcome === 'out of time' || played.outcome === 'stuck') break;
	}

	const final = await readRun(page);
	await page.screenshot({path: path.join(OUT, 'final.png'), fullPage: true});
	const report = {
		starter: STARTER,
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
