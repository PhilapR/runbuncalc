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
const runLib = require('../lib/run');

let chromium = null;
try {
	chromium = require('playwright-core').chromium;
} catch (error) {
	chromium = null;
}

const OUT = path.join(__dirname, '..', 'ui-playthrough-out');
const PARTY_LIMIT = 6;

/**
 * Every flag name this run has ASKED for, whether or not it was supplied.
 *
 * A flag the driver never asks for is silently ignored, which is how
 * --legacy-rank came to be passed to an entire A/B arm without existing: the
 * control ran the treatment with one term switched off, and the experiment
 * would have compared a change to a near-copy of itself. Recording what was
 * asked for makes what was passed-but-never-read a detectable error rather
 * than a silent one.
 */
const ASKED = new Set();
/** Flags read with argv.includes rather than through `flag`. */
const BARE = ['legacy-rank', 'headed'];

function flag(name, fallback) {
	ASKED.add(name);
	const hit = process.argv.find(arg => arg.startsWith('--' + name + '='));
	return hit === undefined ? fallback : hit.slice(name.length + 3);
}

/** A git value, or null outside a checkout. Never throws: provenance must
 * not be able to fail a run. */
function gitOutput(args) {
	try {
		return require('node:child_process')
			.execFileSync('git', args, {cwd: __dirname, encoding: 'utf8'}).trim();
	} catch (error) {
		return null;
	}
}

/** Flags supplied on the command line that nothing ever read. Typos, mostly. */
function unreadFlags() {
	const known = new Set([...ASKED, ...BARE]);
	return process.argv.slice(2)
		.filter(arg => arg.startsWith('--'))
		.map(arg => arg.replace(/^--/, '').split('=')[0])
		.filter(name => !known.has(name));
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
/** How far past the strongest foe an uncapped run levels. Ignored when a cap exists. */
const LEVEL_MARGIN = Number(flag('margin', '3'));
// How often to disobey the ranking at a fight, and how deep to look when we
// do. Zero keeps the driver deterministic, which is what every measurement so
// far was taken under.
// Weight damage by the chance of landing it. On by default; --accuracy=0
// restores the damage-only ranking, which is what makes this falsifiable
// and what the A/B behind it was run against.
const USE_ACCURACY = flag('accuracy', '1') !== '0';
// Restores the original ranking — flat KO tiers, then raw damage, no turn
// count and no accuracy — so the change can be measured against what it
// replaced rather than argued about.
const LEGACY_RANK = process.argv.includes('--legacy-rank');
// How many bodies a fight may spend to bring the answer in free. Two is what
// the tactic was tuned to; 0 disables it, which is what makes it testable
// rather than a thing everyone assumes is earning its keep.
// Zero, measured. Fifteen interleaved pairs on one frozen revision: with the
// tactic off, 10 of 15 runs got past Camper Gavi against 4 of 15 with it on,
// and 3 beat Brawly against none. One-sided p = 0.033 on the run-level test —
// one observation per playthrough, no pooled attempts.
//
// The tactic reads as sound and is carefully fenced: it needs a losing race or
// a lethal crit, the replacement must resist, an answer must be waiting, and
// it is capped per fight, each fence added for a failure named in the comments
// below. I read all of that, judged it deliberate, and talked myself out of a
// guard I had already started writing. It was spending 7.8% of every turn
// played to make runs worse.
const SAC_BUDGET = Number(flag('sac', '0'));

/**
 * Which fights to actually PLAY. "bosses" marks every ordinary trainer beaten
 * without fighting it, and plays only leaders, rivals and the admin bosses.
 *
 * The point is practice at the fights worth practising. Most runs die at
 * Camper Gavi on order 48, so the driver rehearses him hundreds of times and
 * meets Brawly rarely, Roxanne barely and Wattson almost never — the fights
 * where the interesting decisions live are the ones it gets least experience
 * of. This inverts that.
 *
 * It marks them BEATEN rather than skipping them, and the difference matters.
 * lib/run.js is explicit that a skipped fight is not a beaten one and that
 * "passing Camper Gavi does not open the route he guards", so a skipping mode
 * would starve the box of the encounters and items those routes carry and
 * make the bosses harder rather than more practised. Marking beaten keeps the
 * whole map open: the same routes, the same levelling, the same shelf.
 *
 * Nothing this mode wins counts. A boss reached without fighting the road to
 * it is a boss met with a box the road would not have produced.
 */
const ONLY = flag('only', '');

/**
 * Re-pick every party member's four moves before EVERY fight, from the full
 * legal movepool, priced against the team actually being faced.
 *
 * assumeTms already reads the whole pool — 33 moves for a Prinplup at L21, not
 * merely what a TM in the bag would allow, because the engine gates teaching
 * on legality rather than inventory. What it does not do is revisit the
 * choice: it skips a Pokemon whose LEVEL has not changed, so a party taught
 * for Camper Gavi's Bibarel walks into Brawly's five Fighting types still
 * holding Gavi's moves.
 *
 * With this on, each moveset is the best the species could hold for the fight
 * in front of it, which takes teaching luck out of the measurement. A boss
 * should be lost to the boss and not to a stale bar. It is not free — the
 * comment on that skip records 150s a fight — so it stays off by default.
 */
const RETEACH = flag('reteach', '');
// Act on the plan's threshold warning: when the NEXT fight holds a sash or
// pinch-berry Reversal/Flail/Endeavor set and the party has no priority
// attack, teach the one preFightOpportunities names before walking in.
// Lilith's sash Mankey swept six slower Pokemon from 2% because nothing
// alive could move first; a priority move ignores the speeds. `0` turns it
// off, which is the control arm of the A/B that prices this.
const THRESHOLD_PREP = flag('threshold-prep', '1') !== '0';
// Speed control as a play policy: damaging drops count as slow moves, and a
// lost race may reach for one even on a lethal turn. Both halves shipped as
// unconditional baseline, so the 42-0 threshold-fight record against the
// prior revision's 18-12 is a cross-revision reading — suggestive, not an
// isolation. `0` restores the old behaviour exactly (pure-status drops only,
// lethal turns refused), which is the control arm of the A/B that isolates
// it.
const SPEED_CONTROL = flag('speed-control', '1') !== '0';
// Screens on lethal turns when the race is lost — the third instance of the
// same over-caution, after status (fixed) and speed drops (fixed, isolated
// at 50-0). Reflect was taught once and pressed never across 118 Brawly
// attempts, because at a wall every turn reads lethal and the screen rule
// refused lethal turns. Brawly's team is almost entirely physical; a screen
// halves all of it for five turns, for the whole side, and survives the
// switches. `0` restores the old refusal, which is the control arm.
const SCREEN_CONTROL = flag('screen-control', '1') !== '0';
// Attack drops as a play policy — the third instance of taught-but-never-
// pressed. Charm was taught 41 times, Baby-Doll Eyes 17, Feather Dance 17
// across 48 runs, and none was pressed once in 801 wall fights, because no
// play rule knew they existed. Charm at -2 roughly halves a physical
// attacker's damage, which DOUBLES their turns-to-KO — it flips the "you
// need 3, they need 2" races the walls are made of, where a Speed drop only
// reorders them. `0` removes the rule entirely, which is the control arm.
const ATTACK_DROP = flag('attack-drop', '1') !== '0';
// Heals judged by what they buy — the fourth instance of the same
// over-caution. Bayleef carried Synthesis into nine Brawly attempts and
// pressed it zero times: against a 47% Mach Punch every HP under the rule's
// 50 ceiling reads lethal, so the old gate's window was the empty interval
// (47, 50]. The gate now asks whether the healed body survives the hit the
// current one dies to. `0` restores the old lethal refusal, the control arm.
const HEAL_CONTROL = flag('heal-control', '1') !== '0';
// No voluntary switch under a killing Pursuit. Twelve of the forty-eight
// deaths in skipwall4 A7's Brawly wipes were Pursuit's, and the engine now
// prices the doubled catch on the threat line — a switch it would kill is a
// donated KO, so the turn stays on damage. `0` removes the guard, which is
// the control arm.
const PURSUIT_GUARD = flag('pursuit-guard', '1') !== '0';
// Bank a body the next hit kills instead of spending it on one more attack.
// The measured death economy at Brawly is 700+ deaths a batch, most of them
// bodies that fought to single-digit HP and died to a finisher tick — while
// the one A7 win came from a 24% Seadra banked early and brought back to
// finish Scraggy. `0` spends the body, which is the control arm.
const BANK_BODIES = flag('bank-bodies', '1') !== '0';
// How a level-up teach chooses its victim. The old rule was options[0] —
// whatever sat first in the replace select — which is how Spheal learned
// Charm over Ice Ball 27 times and the advisor then bought the slot back 27
// times with Brine. `0` restores that, as the control arm.
const SMART_REPLACE = flag('smart-replace', '1') !== '0';
/**
 * A pinned box: exact species at exact levels, caught at run start, and NO
 * route encounters at all. Two jobs. It activates rules that box luck never
 * reaches — the screens A/B measured p=0.05 on an INERT treatment because no
 * rolled box ever carried a screen learner it kept, while a pinned Dottler
 * knows Reflect from level 10. And it removes box luck from wall
 * experiments entirely, which is why every run-level A/B so far has flipped
 * direction: Camper Gavi is decided by which coverage the box rolled, not by
 * the policy under test.
 *
 * Malformed input REFUSES at startup rather than running a 480-second batch
 * on an empty pin — an A/B whose treatment silently failed to apply is how
 * this repository measured box luck at p=0.05 once already.
 */
// Tool moves into FREE slots. Dottler reached L17 pinned with two moves and
// no Reflect, because every teach path had a reason to skip it: teachPending
// fires only on the full-moveset prompt, and the advisor prices teaches by
// damage delta, which a screen does not have. A mon with an empty slot and a
// learnable move the play rules press should hold that move. Free slots
// ONLY — this never replaces, so it cannot fight the advisor's choices.
const FILL_TOOL_SLOTS = flag('fill-tool-slots', '1') !== '0';
// When a fight has eaten the retry budget and the panel offers a skip for
// it — the profile's declared reorderable fights, Camper Gavi first among
// them — take the skip instead of ending the run. The operator's ruling:
// Gavi is MEANT to be passed and taken after the museum grunts, and the
// road now honours that (a skipped fight steps aside going out and stands
// first once the run moves past it). `0` restores give-up-and-break.
const SKIP_WALLS = flag('skip-walls', '1') !== '0';
function isToolTeach(name) {
	return SCREEN_MOVES.has(name) || SLOW_MOVES.has(name) ||
		DAMAGING_SLOW_MOVES.has(name) || ATTACK_DROP_MOVES.has(name) ||
		attackUtility(name);
}
const PIN_BOX = parsePinBox(flag('pin-box', ''));
function parsePinBox(spec) {
	if (!spec) return [];
	return String(spec).split(',').map(entry => {
		const hit = /^\s*([A-Za-z0-9'.:\- ]+?)\s*:\s*(\d+)\s*$/.exec(entry);
		if (!hit) {
			throw new Error('pin-box: cannot read ' + JSON.stringify(entry) +
				' — the shape is Species:level, comma-separated');
		}
		return {species: hit[1], level: Number(hit[2])};
	});
}

/**
 * Whether to reorder the party so the fair-dice forecast's recommended lead
 * goes first, or leave the matrix's own choice alone.
 *
 * This only started doing anything at all when the provider re-pin brought the
 * forecast back: followLead returns immediately without `plan.lead`, and until
 * bf28a069 the forecast was dead for four fights in five, so there was no lead
 * to follow and the matrix's pick stood by default. Every in-fight comparison
 * before that re-pin was therefore run with this lever stuck off, which is
 * worth knowing before reading those results as evidence about lead choice.
 *
 * The two answers disagree by construction. The matrix picks a covering six by
 * greedy set-cover over the board and orders them by who covers what; the
 * forecast picks whoever survived the most sampled branches. Neither is
 * obviously right, so it is a flag and a measurement rather than an opinion.
 */
const LEAD = flag('lead', 'forecast');
const BOSS = /Leader|Elite|Champion|Rival|Maxie|Archie|Magma Leader|Aqua Leader/i;
const NOISE = Number(flag('noise', '0'));
const EXPLORE_WIDTH = Number(flag('explore-width', '3'));
// How many times to walk back into a fight that beat us. Under `caps` a wipe
// costs nothing and retrying is ordinary play; under `hardcore` a wipe has
// usually already taken the Pokemon that made the attempt worth repeating.
// The boss cap is twenty, and the story of how it got there is the reason it
// is not thirteen.
//
// Fourteen boss wins were on record, landing on attempts 1, 4, 5, 6, 8, 12 and
// 13, so thirteen was set as "the observed maximum". An A/B against the old
// setting then won Brawly on attempt FIFTEEN, and that run went on to reach
// order 139. Under a cap of thirteen it dies at Brawly instead.
//
// The mistake was not the arithmetic, it was believing a tail could be read
// off fourteen samples at all — and the failure is self-confirming, because a
// cap censors exactly the evidence that would show it is too low. Three runs
// in the same test stopped on attempt thirteen having never won; whether any
// of them would have won on fourteen is unknowable, because none was allowed
// to try. Setting a limit from the maximum of a small sample and then
// collecting further data under that limit can only ever confirm it.
//
// So the cap is set where the cost is tolerable rather than where the
// evidence runs out: twenty attempts at a boss that never falls cost 95-106s
// of a 314-402s run, and that is worth paying to keep a run that can win on
// fifteen. The old default of 40 doubled the cost again for no win yet seen.
//
// The ordinary cap is NOT the aggregate it looks like. 1,470 ordinary wins
// land on attempt 1 in 96% of cases and 99% by attempt 3, and a cap of three
// read off that number sent six of twelve runs to their death at Camper Gavi,
// against one of nine before it. Three things were wrong with the reading.
// The statistic conditions on having won, which cannot answer what a cap
// costs. Its denominator is 1,416 attempt-1 walkovers that never retry at
// all, so the fights that do retry are invisible in it — and at Camper Gavi
// itself only 16 of 28 wins arrive by attempt 3, with the latest on 11. And
// the logs it was measured from were all produced under --retries=12, so a
// win at attempt 15 could not appear in them: the tail is censored by the
// setting it was being used to justify.
//
// A generous cap is close to free, because it is only ever spent where a run
// is already stuck. It also buys the thing that actually breaks a wall: every
// third stall clears caughtFrom and reopens the routes, so twelve attempts is
// four fresh sets of encounters and three is one. That is why more retries
// beat a wall a better policy could not.
const RETRIES = Number(flag('retries', 12));
const BOSS_RETRIES = Number(flag('boss-retries', 20));
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

/**
 * Catch the pinned box through the panel's own scripted-catch form, so the
 * server's die authors every identity and every engine rule still holds. The
 * map selector is CLEARED for the duration: a mapless catch is the engine's
 * own escape hatch for recording what happened, and a pinned species is not
 * claimed to be on whatever route the selector happened to hold.
 */
const toolFilledAt = new Map();
async function fillToolSlots(page) {
	if (!FILL_TOOL_SLOTS) return;
	const doc = await savedRun(page);
	if (!doc) return;
	for (const id of doc.party || []) {
		if (outOfTime()) return;
		const mon = (doc.box || []).find(entry => entry.id === id);
		if (!mon || (mon.moves || []).length >= 4) continue;
		if (toolFilledAt.get(mon.id) === mon.level) continue;
		toolFilledAt.set(mon.id, mon.level);
		if (!await selectMon(page, mon.id)) continue;
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
		} catch (error) { continue; }
		const listed = await text(page, '#runbun-run-learn-now');
		if (/^\(nothing\)/.test(listed)) continue;
		const tools = listed.split(',').map(entry => entry.replace(/\*/g, '').trim())
			.filter(entry => entry && isToolTeach(entry) &&
				!(mon.moves || []).includes(entry));
		if (!tools.length) continue;
		await page.fill('#runbun-run-move', tools[0]);
		await page.$eval('#runbun-run-replace', el => { el.value = ''; }).catch(() => {});
		const taught = await act(page, 'tool ' + tools[0],
			() => press(page, '#runbun-run-teach'));
		note('tool', taught.changed ?
			mon.species + ' learned ' + tools[0] + ' into a free slot' :
			mon.species + ' could not learn ' + tools[0] + ' — ' + taught.status);
	}
}

let pinnedDone = false;
async function pinBox(page) {
	if (pinnedDone || !PIN_BOX.length) return;
	pinnedDone = true;
	const hadMap = await page.$eval('#runbun-run-map', el => el.value).catch(() => '');
	await page.$eval('#runbun-run-map', el => { el.value = ''; }).catch(() => {});
	for (const pin of PIN_BOX) {
		if (outOfTime()) return;
		await page.fill('#runbun-run-catch-species', pin.species);
		await page.fill('#runbun-run-catch-level', String(pin.level));
		const caught = await act(page, 'pin ' + pin.species,
			() => press(page, '#runbun-run-catch'));
		note('pin', caught.changed ?
			'pinned ' + pin.species + ' L' + pin.level :
			'could not pin ' + pin.species + ' — ' + caught.status);
	}
	if (hadMap) {
		await page.$eval('#runbun-run-map', (el, value) => { el.value = value; }, hadMap)
			.catch(() => {});
	}
}

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
		await tap(clicked);
		try {
			await page.waitForFunction(
				() => document.querySelectorAll('#runbun-run-encounters li').length > 0,
				null, {timeout: 10000});
		} catch (error) {
			problem('encounters', 'no encounter table rendered for ' + route.map);
			continue;
		}
		const roll = await act(page, 'roll ' + route.map,
			() => press(page, '#runbun-run-roll'));
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
			() => press(page, '#runbun-run-roll-catch'));
		const afterBox = (await savedRun(page)).box;
		const boxAfter = afterBox.length;
		if (boxAfter > boxBefore) {
			caughtFrom.add(route.map);
			taken.push(rolled);
			// The IV total belongs in the log line, not only in the report. A
			// trainer's Pokemon is a flat 186 and a wild catch averages 93, so
			// this is the number that says how far below the fight a box starts,
			// and comparing boxes that clear a wall against boxes that never do
			// is the whole question.
			note('caught', rolled + '  (' + route.map + ')' +
					ivNote(afterBox[boxAfter - 1]));
		} else {
			caughtFrom.add(route.map);
			await act(page, 'flee ' + route.map, () => press(page, '#runbun-run-roll-flee'));
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
		const took = await act(page, 'take ' + items[0], () => tap(button));
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
		const given = await act(page, 'give ' + wanted, () => press(page, '#runbun-run-give'));
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
	const took = await act(page, 'take ' + blame[2], () => press(page, '#runbun-run-take'));
	note('item', 'took ' + blame[2] + ' back off ' + blame[1] +
		' — the picker offered an item nothing can hold');
	return took.changed;
}

/**
 * " · IV 104/186" for a Pokemon whose spread is known, and nothing at all for
 * one whose is not.
 *
 * A run records what it was told; an unrecorded IV is not a zero, so a partial
 * spread is reported as a floor over the stats that ARE known rather than
 * summed as though the rest were zeroes. The same rule the panel follows.
 */
function ivNote(mon) {
	const ivs = mon && mon.ivs;
	if (!ivs) return '';
	const known = ['hp', 'atk', 'def', 'spa', 'spd', 'spe']
		.map(stat => ivs[stat]).filter(value => typeof value === 'number');
	if (!known.length) return '';
	const total = known.reduce((sum, value) => sum + value, 0);
	return known.length === 6 ? ' · IV ' + total + '/186' :
		' · IV ' + total + '+ (' + (6 - known.length) + ' not recorded)';
}

function capOf(view) {
	const hit = /Level cap (\d+)/.exec(view.cap || '');
	return hit ? Number(hit[1]) : null;
}

/**
 * The strongest thing we have met, which is the only level signal an uncapped
 * run has.
 *
 * `--rules=encounters` switches the level cap off, and lib/run.js answers a
 * null cap the moment it does — the number the panel shows is the next boss's
 * ace level, and turning the rule off stops it being computed at all. So the
 * target becomes the highest opposing level seen so far plus a margin, which
 * tracks the run's own difficulty curve without needing the rule that was
 * switched off. It only ever goes up, so a weak trainer cannot pull the party
 * back down.
 */
let strongestFoe = 0;

/** Levelling teaches: a full moveset stops and asks, so the pending move is
 * taught over the oldest one — which is what a player does with Tackle. */
/**
 * Which known move a level-up teach should replace.
 *
 * Deterministic and value-ordered, with two guards the plain argmin gets
 * wrong. A STATUS arrival never takes the mon's last attack — that is how a
 * L12 Abra ended up all-status, pressing Kinesis seven turns into a L9
 * Clobbopus — and control moves the play rules can now press (drops, slow
 * moves, screens, heals) are only spent when nothing better is on the bar,
 * per Philip's note that a kept drop can be worth more than a fourth attack.
 */
// Multi-hit moves whose listed base power is per HIT, so a raw comparison
// reads Rock Blast as a 25 and dominated by everything — while its real work
// is 2-5 hits, sash-breaking included. The metadata carries no hits field,
// so the guard is by name and deliberately the common cases only.
const MULTI_HIT_MOVES = new Set([
	'Rock Blast', 'Bullet Seed', 'Icicle Spear', 'Pin Missile', 'Arm Thrust',
	'Fury Swipes', 'Double Slap', 'Bone Rush', 'Tail Slap', 'Water Shuriken',
	'Scale Shot', 'Double Hit', 'Dual Wingbeat', 'Double Kick', 'Fury Attack',
]);

/** BP discounted by accuracy: the consistency half of "consistent and big". */
function expectedPower(name) {
	return basePowerOf(name) * (accuracyOf(name) || 1);
}

/** A damaging move worth keeping beyond its number: priority collects
 * 1-HP survivors, spread hits the field, multi-hit breaks sashes, and a
 * damaging drop is speed control the play rules press. */
function attackUtility(name) {
	if (DAMAGING_SLOW_MOVES.has(name) || MULTI_HIT_MOVES.has(name)) return true;
	try {
		const meta = ai.getMoveMetadata(name, 8);
		return (meta.priority || 0) > 0 ||
			meta.target === 'allAdjacent' || meta.target === 'allAdjacentFoes';
	} catch (error) {
		return false;
	}
}

function pickReplace(options, incoming, species) {
	if (!options || !options.length) return null;
	if (!SMART_REPLACE) return options[0];
	const damaging = name => basePowerOf(name) > 0;
	const attacks = options.filter(damaging);
	if (attacks.length > 1 || (damaging(incoming) && attacks.length === 1)) {
		// DOMINATED first: a weaker attack of the SAME TYPE as a stronger one
		// on the same bar adds nothing — Water Pulse next to Bubble Beam is a
		// worse Water button — so it goes before any coverage move does,
		// whatever their raw numbers say. Utility attacks are never counted
		// dominated; their worth is not their number.
		const typeOf = name => {
			try { return ai.getMoveMetadata(name, 8).type || null; } catch (error) { return null; }
		};
		const dominated = attacks.filter(a => !attackUtility(a) && attacks.some(b =>
			b !== a && typeOf(b) !== null && typeOf(b) === typeOf(a) &&
			expectedPower(b) > expectedPower(a)));
		if (dominated.length) {
			return dominated.sort((a, b) => expectedPower(a) - expectedPower(b))[0];
		}
		// Otherwise the weakest by EXPECTED power — accuracy folded in — and
		// among the plain attacks first: a spread, priority, multi-hit or
		// drop move outlives a plain attack of similar size.
		const plain = attacks.filter(a => !attackUtility(a));
		const pool = plain.length ? plain : attacks;
		return pool.slice().sort((a, b) => expectedPower(a) - expectedPower(b))[0];
	}
	const controls = options.filter(name => !damaging(name));
	if (controls.length) {
		const mine = typesOf(species);
		return controls.slice().sort((a, b) =>
			moveValue(a, mine, []) - moveValue(b, mine, []) ||
			options.indexOf(a) - options.indexOf(b))[0];
	}
	return options[0];
}

async function teachPending(page, mon, status) {
	const hit = /so (.+?) must be taught over something/.exec(status);
	if (!hit) return;
	const pending = hit[1].split(', ').filter(Boolean);
	for (const move of pending) {
		if (outOfTime()) return;
		const options = await page.$$eval('#runbun-run-replace option',
			els => els.map(el => el.value).filter(Boolean));
		if (!options.length) return;
		const replace = pickReplace(options, move, mon.species);
		await page.fill('#runbun-run-move', move);
		await page.selectOption('#runbun-run-replace', replace);
		const taught = await act(page, 'teach ' + move,
			() => press(page, '#runbun-run-teach'));
		if (!taught.changed) {
			note('teach', mon.species + ' could not learn ' + move + ' — ' + taught.status);
			return;
		}
		note('teach', mon.species + ' learned ' + move + ' over ' + replace);
	}
}

/**
 * Mark the next fight beaten from the upcoming list, without playing it.
 *
 * The button is keyed on the trainer name, and the next-fight heading reads
 * "Face Camper Gavi", so the prefix comes off before the lookup.
 */
async function markBeaten(page) {
	// The trainer comes off the upcoming list's own button, not off the
	// next-fight heading. That heading is not always "Face X" — before a party
	// exists it reads "Build a party for Youngster Calvin", so stripping a
	// "Face " prefix produced a selector that matched nothing, and the caller
	// treated the failure as success and marked the same fight twenty-one
	// times without ever moving.
	const next = await page.evaluate(() => {
		const button = document.querySelector('#runbun-run-upcoming .runbun-run-up-beat');
		return button ? button.getAttribute('data-trainer') : null;
	});
	if (!next) return null;
	const clicked = await act(page, 'mark ' + next, () => page.evaluate(name => {
		const button = document.querySelector(
			'#runbun-run-upcoming .runbun-run-up-beat[data-trainer="' +
			name.replace(/"/g, '\\"') + '"]');
		if (!button) return false;
		button.click();
		return true;
	}, next));
	return clicked ? next : null;
}

async function levelAndEvolve(page) {
	const view = await readRun(page);
	const capped = capOf(view);
	// With the rule on, level to the cap the panel states. With it off there
	// is no cap to state, so aim a margin past the strongest thing met so far.
	const cap = capped !== null ? capped :
		(strongestFoe ? strongestFoe + LEVEL_MARGIN : null);
	if (cap === null) return;
	// EVERYONE under the cap, not the first six. Levelling only a six made the
	// box decorative: the matrix chooses from twenty-two, but sixteen of them
	// were four levels down and scored accordingly, so it re-picked the same
	// six every fight and the depth was an illusion. It also left nothing
	// spare to sacrifice, which is the move a Nuzlocke has against a boss it
	// cannot outrace.
	//
	// The click cost the six-cap was avoiding is real — the evolution check
	// below waits on the panel per Pokemon — so this takes everyone who is
	// actually BEHIND the cap, plus the party. Behind-the-cap is the whole box
	// on the fight after the cap moves and nobody on every fight after that;
	// the party is there because evolution shares this loop, and filtering on
	// level alone would stop evolving anything that had already caught up.
	const alive = view.box.filter(mon => mon.status !== 'dead');
	const fighting = alive.filter(mon => view.party.indexOf(mon.id) !== -1)
		.concat(alive.filter(mon => view.party.indexOf(mon.id) === -1))
		.filter(mon => mon.level < cap || view.party.indexOf(mon.id) !== -1);
	for (const mon of fighting) {
		if (outOfTime()) break;
		if (!await selectMon(page, mon.id)) continue;
		if (mon.level < cap) {
			// "Level to cap" needs a cap to exist; without one the same job is
			// done by the exact-level control.
			if (capped === null) await page.fill('#runbun-run-level-to', String(cap));
			const grew = await act(page, 'level ' + mon.species,
				() => press(page, capped === null ? '#runbun-run-level' : '#runbun-run-level-cap'));
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
			() => press(page, '#runbun-run-evolve'));
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
		await tap(found);
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
	// One trip, not one per Pokemon. Staging was 36.7% of a run's wall clock —
	// 87 of 237 seconds across 103 calls — and almost none of it was work: each
	// arrow cost four browser round trips and a fixed 30ms sleep, and the sort
	// alone does up to thirty-six of them. The panel's handlers run
	// synchronously on click, which is the same assumption `press` and `tap`
	// already rest on, so the whole loop can happen inside the page.
	const leaving = await page.evaluate(keep => {
		const slots = Array.from(document.querySelectorAll(
			'#runbun-run-party-strip .runbun-run-party-slot[data-id]'))
			.map(el => el.getAttribute('data-id'));
		const gone = slots.filter(id => keep.indexOf(id) === -1);
		for (const id of gone) {
			const rm = document.querySelector(
				'#runbun-run-party-strip .runbun-run-party-rm[data-id="' + id + '"]');
			if (rm) rm.click();
		}
		return gone;
	}, wanted);
	if (leaving.length) await act(page, 'drop', () => press(page, '#runbun-run-set-party'));

	await page.evaluate(ids => {
		const staged = () => Array.from(document.querySelectorAll(
			'#runbun-run-party-strip .runbun-run-party-slot[data-id]'))
			.map(el => el.getAttribute('data-id'));
		for (const id of ids) {
			if (staged().indexOf(id) !== -1) continue;
			const add = document.querySelector(
				'#runbun-run-box .runbun-run-mon[data-id="' + id + '"] .runbun-run-add');
			if (add) add.click();
		}
	}, wanted);

	// Order is the lead, and the only control that changes it without
	// un-staging anyone is the strip's up arrow. Selection sort: walk each
	// wanted slot and bubble the right member into it.
	await page.evaluate(args => {
		const staged = () => Array.from(document.querySelectorAll(
			'#runbun-run-party-strip .runbun-run-party-slot[data-id]'))
			.map(el => el.getAttribute('data-id'));
		for (let slot = 0; slot < args.wanted.length; slot++) {
			for (let guard = 0; guard < args.limit; guard++) {
				const at = staged().indexOf(args.wanted[slot]);
				if (at <= slot) break;
				const up = document.querySelector(
					'#runbun-run-party-strip .runbun-run-party-up[data-id="' +
					args.wanted[slot] + '"]');
				if (!up) break;
				up.click();
			}
		}
	}, {wanted: wanted, limit: PARTY_LIMIT});
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
	const set = await act(page, 'set party', () => press(page, '#runbun-run-set-party'));
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
		// Per ENEMY, not summed. Who beats whom is the thing a six has to
		// cover, and a total throws that away before anyone can read it.
		return ours.map((row, i) => {
			const against = (theirs[i] || {}).cells || [];
			return {
				name: row.name.trim(),
				margins: row.cells.map((deal, j) => deal - (against[j] || 0)),
			};
		});
	});
	if (scored.length < 2) return false;
	// A gym is fought in sequence: six of ours against seven of theirs, one at
	// a time. Ranking by the SUM of the margins picks six generalists, and
	// against Brawly it picked six that were each negative overall — the board
	// read -21, -62, -213, -218, -267, -327 and the fight was lost before it
	// started. A specialist that beats two of his seven and loses to the rest
	// sums to something awful and is exactly who should be on the team.
	//
	// So: greedily take whoever adds the most on the enemies nobody covers
	// yet. The sum survives as the tie-break, which is what decides the whole
	// order when every margin is negative — the old behaviour, kept for the
	// case where there is genuinely nothing to cover.
	const covered = new Set();
	const picked = [];
	const total = row => row.margins.reduce((a, b) => a + b, 0);
	while (picked.length < PARTY_LIMIT && picked.length < scored.length) {
		let best = null;
		let bestKey = -Infinity;
		for (const row of scored) {
			if (picked.indexOf(row) !== -1) continue;
			let gain = 0;
			row.margins.forEach((margin, j) => {
				if (margin > 0 && !covered.has(j)) gain += margin;
			});
			const key = gain * 1000 + total(row);
			if (key > bestKey) {
				bestKey = key;
				best = row;
			}
		}
		if (!best) break;
		best.margins.forEach((margin, j) => {
			if (margin > 0) covered.add(j);
		});
		picked.push(best);
	}
	// The covering six lead, and everyone else follows in sum order: the
	// matcher below drops a row whose species is already spoken for, so it
	// needs somewhere to fall back to or a box with dupes returns no party.
	const rest = scored.filter(row => picked.indexOf(row) === -1)
		.sort((a, b) => total(b) - total(a));
	scored.length = 0;
	scored.push(...picked, ...rest);
	scored.forEach(row => {
		row.score = total(row);
	});
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
/**
 * The threshold demand, acted on. `thresholdPrep` is computed by the same
 * lib the server runs, against the saved run document — the driver does not
 * parse it back out of the DOM it rendered into. Teaches through the panel's
 * own form so every rule holds: an egg move still costs a Heart Scale, and a
 * refusal is noted rather than fought.
 */
async function prepareForThreshold(page) {
	if (!THRESHOLD_PREP) return;
	const doc = await savedRun(page);
	if (!doc) return;
	let prep;
	try {
		prep = runLib.preFightOpportunities(doc).thresholdPrep;
	} catch (error) {
		return;
	}
	if (!prep || !prep.threats.length) return;
	const threat = prep.threats.map(t => t.species + ' (' + t.holds + ' + ' + t.move + ')').join(', ');
	if (prep.covered) {
		note('threshold', 'priority answer in hand for ' + threat + ': ' +
			prep.priorityAnswers.map(row => row.species + "'s " + row.move).join(', '));
		return;
	}
	if (!prep.teachable.length) {
		note('threshold', 'no priority answer for ' + threat + ' and nothing can learn one');
		return;
	}
	for (const row of prep.teachable) {
		if (outOfTime()) return;
		if (!await selectMon(page, row.id)) continue;
		const options = await page.$$eval('#runbun-run-replace option',
			els => els.map(el => el.value).filter(Boolean));
		// Replace the weakest attack by base power; a mon under four moves
		// teaches into the free slot.
		const weakest = options.slice()
			.sort((a, b) => basePowerOf(a) - basePowerOf(b))[0];
		await page.fill('#runbun-run-move', row.move);
		if (weakest) await page.selectOption('#runbun-run-replace', weakest);
		const taught = await act(page, 'teach ' + row.move,
			() => press(page, '#runbun-run-teach'));
		if (taught.changed) {
			note('threshold', row.species + ' learned ' + row.move + ' against ' + threat +
				(weakest ? ' over ' + weakest : ''));
			return;
		}
		note('threshold', row.species + ' could not learn ' + row.move + ' — ' + taught.status);
	}
}

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
		const took = await act(page, 'take ' + item[1], () => tap(take));
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
		// Same failure as the move select below: an item spent by an earlier
		// row is no longer an option, and selectOption throws rather than
		// declines.
		const stocked = await page.evaluate(name => Array.from(
			document.querySelectorAll('#runbun-run-hold-item option'))
			.some(el => el.value === name), item);
		if (!stocked) {
			note('advise', row.who + ' cannot hold ' + item + ' — not in the bag any more');
			return false;
		}
		await page.selectOption('#runbun-run-hold-item', item);
		const given = await act(page, 'give ' + item, () => press(page, '#runbun-run-give'));
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
		// The advice was priced against the moveset as it was, and applying an
		// earlier row can change it — so the move this row wants to drop is
		// sometimes already gone. selectOption then retries for thirty seconds
		// and THROWS, which killed the whole playthrough from inside
		// followAdvice; k-1, h-2 and h-5 all die exactly here. A row that no
		// longer applies is an ordinary skip, not the end of the run.
		const dropping = parsed[2] || '';
		if (dropping) {
			const offered = await page.evaluate(name => Array.from(
				document.querySelectorAll('#runbun-run-replace option'))
				.some(el => el.value === name), dropping);
			if (!offered) {
				note('advise', row.who + ' no longer knows ' + dropping +
					' — skipping "' + row.what + '"');
				return false;
			}
		}
		await page.selectOption('#runbun-run-replace', dropping);
		const taught = await act(page, 'teach ' + parsed[1],
			() => press(page, '#runbun-run-teach'));
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
	if (LEAD !== 'forecast') return;
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
		await tap(up);
		await page.waitForTimeout(40);
	}
	const set = await act(page, 'lead ' + plan.lead,
		() => press(page, '#runbun-run-set-party'));
	note('plan', 'leading with ' + plan.lead + ' as planned — ' + set.status);
}

// ------------------------------------------------------------------ the fight

/** The damage line under a move, read the way a player reads it. */
/**
 * The race, in turns, as the panel itself counts it.
 *
 * The threat line ends "you need 3 turns to KO, they need 2 — YOU LOSE THIS
 * RACE", and the driver was reading only the verdict at the end of that
 * sentence. The two numbers in front of it are the whole of the panel's
 * reasoning and they say things the boolean cannot: whether the race is lost
 * by one turn or by four, and therefore whether it can be flipped at all.
 *
 * Returns nulls rather than guesses when the sentence is not there, which is
 * the case on a forced switch and on the first turn of some fights.
 */
function raceOf(view) {
	const hit = /you need (\d+) turns? to KO, they need (\d+)/.exec(view.threat || '');
	const lost = /YOU LOSE THIS RACE|NOTHING HERE DAMAGES IT/.test(view.threat || '');
	if (!hit) return {ours: null, theirs: null, lost: lost, margin: null};
	const ours = Number(hit[1]);
	const theirs = Number(hit[2]);
	return {ours: ours, theirs: theirs, lost: lost, margin: theirs - ours};
}

/**
 * How many turns this move needs to KO, on its FLOOR damage.
 *
 * The panel counts a fight in turns and the ranking counted it in percent, so
 * the two disagreed constantly: 34% and 50% are the same move if both need
 * three turns, and a move that turns three turns into two beats any amount of
 * damage that does not. Dividing by accuracy prices a miss as the lost turn it
 * is. The floor rather than the average, because our floor is what a plan may
 * rely on.
 */
function turnsToKO(entry) {
	if (entry.floorKO) return 1 / (entry.acc || 1);
	if (!entry.min || entry.min <= 0) return Infinity;
	return Math.ceil(100 / entry.min) / (entry.acc || 1);
}

/**
 * A move's chance to land, as a fraction. `true` in the dex means it cannot
 * miss, and an unknown move is assumed to hit rather than be penalised for
 * being unrecognised.
 */
function accuracyOf(moveName) {
	try {
		const accuracy = ai.getMoveMetadata(moveName, 8).accuracy;
		if (accuracy === true || accuracy === undefined || accuracy === null) return 1;
		return Number(accuracy) / 100;
	} catch (error) {
		return 1;
	}
}

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
		acc: USE_ACCURACY ? accuracyOf(entry.move) : 1,
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
	rankMoves(scored);
	return explore(scored, 'move');
}

/**
 * Order a scored move list, best first, in place.
 *
 * Turns first, because that is the unit the panel decides fights in and the
 * unit a fight is actually lost in: 34% and 50% are the same move when both
 * need three turns, and a move that turns three turns into two beats any
 * amount of damage that does not. Damage only breaks ties between moves that
 * reach the KO on the same turn, where it decides which survives a bad roll.
 *
 * Accuracy multiplies throughout, because a move that misses deals none. The
 * ranking used damage alone, so Thunder at 110 and 80% beat Spark at 65 and
 * 100% and was pressed every turn. A KO still outranks everything, but a KO
 * that can miss is not the equal of one that cannot, so the KO tiers carry
 * accuracy rather than being a flat yes or no.
 *
 * Measured against the ranking it replaced over thirty interleaved runs:
 * 8.9% of Camper Gavi attempts won against 2.7%. The p = 0.03 first claimed
 * for that pooled attempts across runs, which are not independent — one box
 * wins on attempt one and another loses all twelve. Per run it is p = 0.07:
 * ahead on every metric, not significant at 0.05.
 * `--legacy-rank` restores the old order so that stays reproducible.
 */
/** A move's base power, or 0 for a status move and for anything unrecognised. */
function basePowerOf(name) {
	try {
		const meta = ai.getMoveMetadata(name, 8);
		return meta.category === 'Status' ? 0 : (meta.basePower || 0);
	} catch (error) {
		return 0;
	}
}

/**
 * What a move is worth to the Pokemon that knows it, in base-power units.
 *
 * This decides what gets taught OVER, which decides whether a party still has
 * a line to play by the time it reaches a wall. It priced screens, Speed
 * drops, heals and boosts explicitly and then fell through to base power —
 * which is zero for every sleep, paralysis and confusion move, so those were
 * always the first thing discarded. 344 went that way across these logs,
 * including 34 Sleep Powders, 28 Sings, 26 Thunder Waves and 25 Confuse Rays,
 * and the share of Pokemon carrying any status move fell to 13%. Taking their
 * turn away is what beat Camper Gavi.
 *
 * `mine` are the holder's types, for STAB. `enemies` are the upcoming teams'
 * type lists, for how often the move lands for more than neutral.
 */
function moveValue(name, mine, enemies) {
	// Priced before base power is consulted, because these have none.
	if (SCREEN_MOVES.has(name)) return SCREEN_VALUE;
	if (SLOW_MOVES.has(name)) return SLOW_VALUE;
	if (HEAL_MOVES.has(name)) return HEAL_VALUE;
	if (BOOST_MOVES.has(name)) return BOOST_VALUE;
	// A guaranteed status is worth what it takes away, whether or not the move
	// also does damage. inflictedStatus answers only for moves that ALWAYS
	// inflict — Thunderbolt, Body Slam and Lava Plume all come back null — so
	// taking the larger of the two prices cannot inflate an ordinary attack
	// that happens to have a secondary effect. Nuzzle is why it is needed: a
	// guaranteed paralysis carrying 20 base power, priced at 20 and taught
	// over 41 times.
	const inflicts = inflictedStatus(name);
	const asStatus = inflicts ? (STATUS_WORTH[inflicts] || 0) * STATUS_VALUE_PER_WORTH : 0;
	const base = basePowerOf(name);
	if (!base) return asStatus;
	let meta;
	try {
		meta = ai.getMoveMetadata(name, 8);
	} catch (error) {
		return Math.max(base, asStatus);
	}
	const stab = (mine || []).indexOf(meta.type) === -1 ? 1 : 1.5;
	// A move that spends two turns to hit once is worth half its base power,
	// and the metadata carries no charge flag to read it off, so the list is
	// spelled out. These runs lose on turns, not on damage.
	const turns = TWO_TURN_MOVES.has(name) ? 0.5 : 1;
	const foes = enemies || [];
	if (!foes.length) return Math.max(base * stab * turns, asStatus);
	const lands = foes.reduce((total, types) =>
		total + multiplierAgainst(meta.type, types), 0) / foes.length;
	return Math.max(base * stab * turns * lands, asStatus);
}

function rankMoves(scored) {
	return scored.sort(LEGACY_RANK ? (a, b) =>
		(b.floorKO ? 1 : 0) - (a.floorKO ? 1 : 0) ||
		(b.guaranteedKO ? 1 : 0) - (a.guaranteedKO ? 1 : 0) ||
		b.min - a.min || b.max - a.max :
		(a, b) =>
			(b.floorKO ? b.acc : 0) - (a.floorKO ? a.acc : 0) ||
			(b.guaranteedKO ? b.acc : 0) - (a.guaranteedKO ? a.acc : 0) ||
			turnsToKO(a) - turnsToKO(b) ||
			b.min * b.acc - a.min * a.acc ||
			b.max * b.acc - a.max * a.acc);
}

/**
 * Occasionally take the second or third choice instead of the first.
 *
 * The policy is a function of the state, so twenty retries at a wall re-derive
 * the same line twenty times and only the dice differ — Wattson was lost in
 * 27, 29, 28, 31, 29, 34 and 35 turns, which is one strategy sampled seven
 * times rather than seven strategies. A wall that the top-ranked line cannot
 * pass is exactly where the ranking is worth disobeying, and retrying is free.
 *
 * A KO is never gambled away: the sort puts those first, and if the leader is
 * one it is returned untouched. Everything below the leader is a judgement
 * call the ranking makes on a margin, which is what this samples.
 *
 * Off unless --noise is given, so every earlier measurement still reproduces.
 */
function explore(ranked, what) {
	if (!NOISE || ranked.length < 2) return ranked[0];
	if (ranked[0].floorKO || ranked[0].guaranteedKO) return ranked[0];
	if (Math.random() >= NOISE) return ranked[0];
	const among = Math.min(ranked.length, EXPLORE_WIDTH);
	const pick = 1 + Math.floor(Math.random() * (among - 1));
	note('noise', what + ': took #' + (pick + 1) + ' of ' + among + ' — ' +
		(ranked[pick].move || ranked[pick].species || '?') +
		' over ' + (ranked[0].move || ranked[0].species || '?'));
	return ranked[pick];
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
/**
 * What one point of STATUS_WORTH is worth in base power.
 *
 * Anchored rather than chosen: paralysis is a Speed drop plus a chance to skip
 * the turn outright, so it must price at least as high as SLOW_VALUE. Worth 4
 * at 24 a point lands on 96, just above the Speed drop's 95 — which puts sleep
 * level with a screen at 120 and poison at 24, below every real attack, which
 * is where chip damage belongs.
 */
const STATUS_VALUE_PER_WORTH = Number(flag('status-value', '0'));

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
 * Moves that damage nothing and win fights anyway.
 *
 * The driver had no idea these existed. `bestStatusMove` only recognises a
 * move that INFLICTS a condition, and the teaching score reads base power, so
 * every one of these scored zero and was neither taught nor pressed. That
 * leaves the driver playing one turn at a time with no way to set anything up
 * — which is the whole answer to a boss that outclasses you.
 *
 * A screen is the strongest of them here. Brawly's team is almost entirely
 * physical — Brick Break, Mach Punch, Retaliate, Sucker Punch, Feint Attack —
 * and the threat line keeps saying "you need 2 turns to KO, they need 2".
 * Reflect makes their 2 into 4 for five turns, for the whole side, through
 * switches. It is the only lever that touches the stat gap head on instead of
 * working around it.
 *
 * The numbers are deliberately modest: a screen prices near a good attack so
 * it is taught to a Pokemon that has one to spare, and a boost prices below
 * most attacks so it only lands on somebody with nothing better.
 */
const SCREEN_MOVES = new Set(['Reflect', 'Light Screen', 'Aurora Veil']);
const SCREEN_VALUE = 120;
const BOOST_MOVES = new Set([
	'Swords Dance', 'Nasty Plot', 'Calm Mind', 'Dragon Dance', 'Bulk Up',
	'Iron Defense', 'Agility', 'Shell Smash', 'Quiver Dance', 'Growth',
	'Howl', 'Work Up', 'Hone Claws', 'Coil', 'Curse',
]);
const BOOST_VALUE = 50;

/**
 * The lines that are actually on the shelf.
 *
 * Screens and stat boosts turned out not to be obtainable this early: nine
 * likely party members at L21 were offered none of them, in `now` or in
 * `later`. These are what the same Pokemon ARE offered, and the driver ignored
 * them for the same reason — `inflictedStatus` recognises a CONDITION, so a
 * move that drops their Speed or restores our HP looked like nothing at all.
 *
 * A Speed drop is the direct answer to the sentence the threat line keeps
 * printing: "you need 2 turns to KO, they need 2 — YOU LOSE THIS RACE". That
 * race is lost on order, not on damage, and Cotton Spore takes two stages off
 * it in one turn. Roselia is offered Cotton Spore, Sleep Powder, Stun Spore
 * and Synthesis, and the driver was pressing none of them.
 */
const SLOW_MOVES = new Set([
	'Cotton Spore', 'String Shot', 'Scary Face', 'Sticky Web', 'Tickle',
]);
// The DAMAGING speed drops, kept out of SLOW_MOVES on purpose: that set also
// prices teaching (moveValue returns SLOW_VALUE for its members) and these
// already price correctly as attacks. What they could not do was be PLAYED as
// speed control — the race rule read only the pure-status set, so Icy Wind
// was taught 36 times in one batch and pressed zero times in 118 Brawly
// attempts. Every move here drops Speed on every hit, not as a chance.
const DAMAGING_SLOW_MOVES = new Set([
	'Icy Wind', 'Electroweb', 'Bulldoze', 'Rock Tomb', 'Low Sweep', 'Mud Shot',
	'Glaciate', 'Drum Beating',
]);
function isSlowControl(name) {
	return SLOW_MOVES.has(name) || DAMAGING_SLOW_MOVES.has(name);
}
// Physical-attack drops. Their value condition differs from a Speed drop's:
// a Speed drop can only reorder a race, so it needs the margin close; a -2
// Attack drop halves their damage and so doubles their turn count, which can
// rescue a race lost by more. It only pays into a PHYSICAL threat, which the
// threat line names.
const ATTACK_DROP_MOVES = new Set([
	'Charm', 'Baby-Doll Eyes', 'Feather Dance', 'Growl', 'Tail Whip',
]);
const SLOW_VALUE = 95;
const HEAL_MOVES = new Set([
	'Synthesis', 'Recover', 'Roost', 'Life Dew', 'Moonlight', 'Morning Sun',
	'Slack Off', 'Soft-Boiled', 'Milk Drink', 'Heal Order', 'Shore Up',
]);
const HEAL_VALUE = 85;

/** Anything that plays a line instead of trading damage. */
function isLineMove(name) {
	return !!inflictedStatus(name) || SLOW_MOVES.has(name) || HEAL_MOVES.has(name) ||
		SCREEN_MOVES.has(name) || BOOST_MOVES.has(name);
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

/**
 * Whether a heal changes this fight, judged on the hit the threat line names.
 *
 * Three answers. The plain hit is chip (it does not kill us even now): heal
 * freely — the lethal flag on such a turn is crit fear, the bug this family
 * of fixes keeps removing. The hit kills us now but not after the heal: this
 * is the rescue, the most valuable heal there is, worth it whenever the hit
 * waits for the heal — a priority jab does not, so Mach Punch refuses it.
 * The hit kills the healed body too: the turn is wasted, spend it on damage.
 * No parseable threat falls back to the old gate rather than guessing.
 */
function healWorthIt(view) {
	const named = /Their hardest hit: (.+?) (\d+)%/.exec(view.threat || '');
	if (!named) return view.risk !== 'lethal';
	const pct = Number(named[2]);
	if (pct < view.usHp) return true;
	if (pct >= Math.min(100, view.usHp + 50)) return false;
	let priority = 0;
	try {
		priority = ai.getMoveMetadata(named[1].trim(), 8).priority || 0;
	} catch (error) { priority = 0; }
	return priority <= 0;
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
	// The switch is the same kind of judgement on a margin as the move,
	// and "who do we send in" is often where a lost fight was decided.
	return explore(options, 'switch');
}

/**
 * The body to throw away, which is the opposite question to the one above.
 *
 * A switch concedes a free hit. Sending the healthiest body means the counter
 * eats that hit and arrives damaged, which is backwards: the Nuzlocke answer
 * to a boss you cannot outrace is to spend something you do not need, let it
 * take the hit, and bring the counter in for free on the replacement.
 *
 * This is only affordable because --rules=caps runs with permadeath OFF, so a
 * faint costs the fight and not the Pokemon. It must never run under hardcore,
 * where the same move costs a life.
 *
 * Expendable means: cannot damage anything anyway, then already hurt, then
 * worst matched. Returns null when there is nothing to spare — with three
 * bodies left the sacrifice IS the party.
 */
function sacSwitch(view, roster) {
	if (RULES === 'hardcore') return null;
	const incoming = incomingType(view);
	const options = view.switches.map(entry => {
		const hit = /(\d+)%$/.exec(entry.label);
		const species = entry.label.replace(/\s+\d+%$/, '').trim();
		return {
			id: entry.id, label: entry.label, species: species,
			hp: hit ? Number(hit[1]) : 0,
			taking: multiplierAgainst(incoming, typesOf(species)),
			armed: canAttack(roster, entry.id),
		};
	}).filter(entry => entry.hp > 0);
	// Keep a fighting body and a replacement behind it; below that there is
	// nothing to spend, only the fight itself.
	if (options.length < 3) return null;
	options.sort((a, b) => (a.armed ? 1 : 0) - (b.armed ? 1 : 0) ||
		a.hp - b.hp || b.taking - a.taking);
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
	// The line rather than the turn. A screen halves every hit of its kind for
	// five turns, for the whole side, and it survives the switches that come
	// after — so against a team that wins the race by a single turn it buys
	// more than an attack that does not KO. Once per screen per fight, never
	// on a turn a crit would end, and never instead of a KO.
	// The race is read here as well as below: the lost-race exception needs
	// it, and raceOf is a pure read of the threat line.
	const screenRace = raceOf(view);
	const screen = view.moves.find(entry => !entry.ball && SCREEN_MOVES.has(entry.move));
	if (screen && !memory.screens.has(screen.move) &&
		(view.risk !== 'lethal' || (SCREEN_CONTROL && screenRace.lost))) {
		memory.screens.add(screen.move);
		return {kind: 'move', pick: {move: screen.move},
			why: 'setting ' + screen.move + ' before trading'};
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
	// Every VOLUNTARY switch below is off while a killing Pursuit stands: the
	// engine prices the doubled catch on the threat line, and a switch it
	// kills hands over the exact KO the switch was meant to dodge. The forced
	// replacement above is untouched — a faint is not a switch-out and
	// Pursuit does not punish it.
	const pursuitCaught = PURSUIT_GUARD &&
		/Pursuit KOs anything that switches out/.test(view.threat || '');
	if (/infatuated|confused/.test(view.us) && memory.cleared < 6 && !pursuitCaught) {
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
	if (!move && memory.disarmed < 2 && !pursuitCaught) {
		const armed = healthiestSwitch(view, roster);
		if (armed && armed.armed) {
			memory.disarmed += 1;
			return {kind: 'switch', pick: armed, why: 'nothing here can damage it'};
		}
	}
	const race = raceOf(view);
	const losingRace = race.lost;
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
	// The race is lost on ORDER at least as often as on damage: "you need 2
	// turns to KO, they need 2" is decided by who moves first. Two stages off
	// their Speed turns that sentence around and costs one turn to do. Once
	// per opposing Pokemon, so a missed Cotton Spore cannot become a loop.
	//
	// Which is why it now asks HOW LOST. A Speed drop changes the order, never
	// the turn counts, so it can only win a race that order decides — "you
	// need 2, they need 2". At "you need 6, they need 2" it spends the one
	// turn we had on a move that cannot reach the deficit. The boolean could
	// not tell those apart and spent the turn either way.
	// Both sets: a damaging drop is strictly better in most spots, because the
	// turn is not spent — it chips while it flips the order. There is no
	// lethal-risk clause here any more, and that is the status rule's lesson
	// applied: this rule only ever fires on a LOST race, and a turn we might
	// not survive spent on damage loses exactly as hard as one spent taking
	// the order back. The old clause was why Icy Wind fired zero times in 118
	// Brawly attempts — at a wall, nearly every turn reads lethal.
	const slow = view.moves.find(entry => !entry.ball &&
		(SPEED_CONTROL ? isSlowControl(entry.move) : SLOW_MOVES.has(entry.move)));
	const orderDecides = race.margin === null || race.margin >= -1;
	if (slow && losingRace && orderDecides &&
		(SPEED_CONTROL || view.risk !== 'lethal') && !memory.slowed.has(view.foe)) {
		memory.slowed.add(view.foe);
		return {kind: 'move', pick: {move: slow.move},
			why: 'setting the race straight with ' + slow.move};
	}
	// Their hardest hit is physical and the race is lost: halve it. -2 Attack
	// doubles their turns-to-KO, which rescues deficits a Speed drop cannot
	// reach. Lethal turns allowed for the family reason — on a lost race a
	// turn spent on damage loses exactly as hard. Once per opposing Pokemon.
	if (ATTACK_DROP && losingRace && !memory.slowed.has('atk:' + view.foe)) {
		const drop = view.moves.find(entry => !entry.ball && ATTACK_DROP_MOVES.has(entry.move));
		const named = /Their hardest hit: (.+?) \d/.exec(view.threat || '');
		let physical = false;
		try {
			physical = !!named && ai.getMoveMetadata(named[1].trim(), 8).category === 'Physical';
		} catch (error) { physical = false; }
		if (drop && physical) {
			memory.slowed.add('atk:' + view.foe);
			return {kind: 'move', pick: {move: drop.move},
				why: 'halving ' + (named ? named[1].trim() : 'their hit') + ' with ' + drop.move};
		}
	}
	// Healing is worth a turn when it buys back more than one. Below half, a
	// fifty percent restore puts two more turns between us and the KO the
	// threat line is counting down to. Twice a fight, and never instead of a
	// KO. What it is NOT gated on any more is the crit flag: `lethal` means a
	// CRIT kills, which at a wall is every turn, and that clause is why
	// Synthesis fired zero times in nine Brawly attempts. healWorthIt asks
	// the question the flag cannot — does the healed body survive the hit
	// the current one dies to, and does the hit wait for the heal.
	const heal = view.moves.find(entry => !entry.ball && HEAL_MOVES.has(entry.move));
	if (heal && view.usHp > 0 && view.usHp <= 50 && memory.healed < 2 &&
		(HEAL_CONTROL ? healWorthIt(view) : view.risk !== 'lethal')) {
		memory.healed += 1;
		return {kind: 'move', pick: {move: heal.move},
			why: 'setting the trade back up with ' + heal.move};
	}
	// The hit kills us, THEY ACT FIRST, and a healthy body is waiting: bank
	// the chip, because it dies before its attack either way. brbank1
	// falsified the broad version of this rule — banking every body a hit
	// could kill donated two free hits an attempt, robbed 2.4 attacks, and
	// the chips died on re-entry anyway (foes downed fell 3.60 to 2.79 per
	// attempt, our deaths unchanged). The one case the diagnosis left
	// standing is the body that never gets its attack: staying in loses the
	// body AND the turn, so the free hit the switch concedes costs nothing
	// extra. The engine says who acts first on the threat line; without the
	// sentence the body stays and trades. The Pursuit guard above already
	// closed this door when leaving is the death.
	if (BANK_BODIES && !pursuitCaught && view.usHp > 0 && view.usHp <= 35 &&
		memory.banked < 3 && / they act first/.test(view.threat || '')) {
		const named = /Their hardest hit: (.+?) (\d+)%/.exec(view.threat || '');
		const killed = named && Number(named[2]) >= view.usHp;
		if (killed) {
			const fresh = healthiestSwitch(view, roster);
			if (fresh && fresh.hp >= 50) {
				memory.banked += 1;
				return {kind: 'switch', pick: fresh,
					why: 'banking the body — ' + named[1].trim() +
						' kills it before it acts'};
			}
		}
	}
	// Setting up is the other half of a line, and it comes AFTER taking their
	// turn away: a sleeping opponent is what makes the boost free. Only while
	// we can afford the turn, and twice at most — a third is a Pokemon that
	// buffed itself to death instead of attacking.
	const boost = view.moves.find(entry => !entry.ball && BOOST_MOVES.has(entry.move));
	if (boost && losingRace && view.risk !== 'lethal' && memory.boosts < 2) {
		memory.boosts += 1;
		return {kind: 'move', pick: {move: boost.move},
			why: 'the race is lost straight, so setting up with ' + boost.move};
	}
	const lethal = view.risk === 'lethal';
	if ((losingRace || lethal) && !memory.switchedFor.has(view.foe) && !pursuitCaught) {
		const replacement = healthiestSwitch(view, roster);
		// Only if the body coming in actually RESISTS. A switch concedes a
		// free hit, and against a five-Pokemon team the driver was donating
		// one every time the threat line said the race was lost — switching
		// from a healthy Prinplup into a Bunnelby that died in two turns.
		// Swapping one losing matchup for another is worse than attacking.
		const answer = replacement && replacement.taking < 1 ? replacement : null;
		// The sacrifice exists to bring THE ANSWER in free, so it is only
		// worth paying when there is an answer to bring in. The first version
		// ran it as a fallback after the resist check had already failed —
		// which is precisely when nothing is waiting, so it spent a body to
		// buy nothing and donated a KO. It fired 13 times against Brawly and
		// moved the wipe from turn 20 to turn 25 without ever winning, which
		// is what paying for nothing looks like.
		const fodder = answer && memory.sacked < SAC_BUDGET ?
			sacSwitch(view, roster) : null;
		if (fodder) {
			memory.sacked += 1;
			return {kind: 'switch', pick: fodder,
				why: 'spending ' + fodder.species + ' so ' + answer.species +
					' comes in free'};
		}
		if (answer) {
			memory.switchedFor.add(view.foe);
			return {kind: 'switch', pick: answer,
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
	// ONE line in the party — not none, and not six. Priced honestly against
	// damage a slow is worth 95 and a heal 85, which is the right rank for a
	// fourth moveslot and the wrong rank for a team: real attacks score 150 to
	// 330, so a line never reached the shortlist and was never taught. The
	// fight logs showed it exactly — 41 sacrifices went in without a single
	// Speed drop behind them, because nobody in the party had one to press.
	//
	// So the first line the party can get is bought at any price, and every
	// candidate after that is ranked the ordinary way.
	let partyHasLine = roster.some(mon => (mon.moves || []).some(isLineMove));
	for (const mon of roster.filter(entry => entry.status !== 'dead').slice(0, PARTY_LIMIT)) {
		if (outOfTime()) return;
		// Only when something changed. Asking for every party member every
		// fight cost 150s a fight and taught nothing new.
		if (RETEACH !== 'fight' && taughtAt.get(mon.id) === mon.level) continue;
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
		// A star marks an egg move the relearner charges a Heart Scale for.
		// Skipping them left a Pokemon's best moves on the shelf over a
		// currency this run actually collects and the advisor already knows
		// how to price. The star is stripped and the move is tried; with no
		// Heart Scale the panel refuses, `act` reports no change, and the next
		// candidate down is tried instead.
		const offered = listed.split(',').map(entry => entry.replace(/\*/g, '').trim())
			.filter(entry => entry)
			// Raw base power would pick Explosion. The advisor refuses a
			// sacrifice as an upgrade on purpose — "the advisor never teaches
			// suicide" is its own gate — and an experiment that ignores that
			// is measuring a different game.
			.filter(entry => !/^(Explosion|Self-Destruct|Final Gambit|Misty Explosion|Memento|Healing Wish|Lunar Dance)$/.test(entry));
		const bp = basePowerOf;
		// Base power is what a move does; effectiveness is what it does to
		// THEM. Ranked on raw power alone this taught Take Down over Wing
		// Attack, and 160 of 171 Brawly plans then opened with Brick Break —
		// a Fighting move into a team that is more than half Fighting. Wing
		// Attack is 60 BP against Take Down's 90 and lands for twice as much
		// on four of his six, so priced against the fight in front of us that
		// ordering flips. STAB is in here for the same reason a 90 BP Ice
		// Beam lost to a 65 BP Bubble Beam on a Water Pokemon.
		const mine = typesOf(mon.species);
		const value = name => moveValue(name, mine, enemies);
		const known = (mon.moves || []).slice();
		// Never trade away the party's only lock. This heuristic picks the
		// highest base power and replaces the WEAKEST move, which is always
		// the status one — so it stripped Sing, Stun Spore and Sleep Powder
		// off every Pokemon and handed Brawly a party that could only trade
		// damage with a Lopunny that heals itself with Drain Punch. Taking
		// their turn away is what beat Camper Gavi one fight earlier.
		// A lock is any move that plays a line rather than trading damage: the
		// condition, the Speed drop, the heal, the screen. The rule is the one
		// that was already here — never trade away the LAST one — generalised,
		// because the first run after the lines went in taught a Bayleef Solar
		// Beam over its Synthesis and threw the line away to gain damage.
		const locks = known.filter(isLineMove);
		let ranked = offered.filter(name => known.indexOf(name) === -1)
			.sort((a, b) => value(b) - value(a));
		// The party has no line at all: take the best one on offer here first,
		// ahead of any attack. Only until one lands.
		if (!partyHasLine) {
			const lines = ranked.filter(isLineMove);
			if (lines.length) ranked = lines.concat(ranked.filter(name => !isLineMove(name)));
		}
		const droppable = known.filter(name => !isLineMove(name) || locks.length > 1);
		if (!droppable.length) continue;
		const weakest = droppable.slice().sort((a, b) => value(a) - value(b))[0];
		// Three candidates, not one. An egg move can be refused for want of a
		// Heart Scale, and giving up on the Pokemon at the first refusal would
		// cost it the ordinary TM underneath — which is what it used to get.
		for (const best of ranked.slice(0, 3)) {
			// Buying the party's first line is exempt from the comparison
			// below: a slow at 95 will never beat the attack it is replacing,
			// which is the whole reason none was ever taught.
			const buyingLine = !partyHasLine && isLineMove(best);
			if (value(best) === 0 && !buyingLine) break;
			if (!buyingLine && weakest && value(best) <= value(weakest)) break;
			await page.fill('#runbun-run-move', best);
			await page.selectOption('#runbun-run-replace', known.length >= 4 ? weakest : '');
			const taught = await act(page, 'assume ' + best, () => press(page, '#runbun-run-teach'));
			if (taught.changed) {
				if (isLineMove(best)) partyHasLine = true;
				note('tm', mon.species + ' learned ' + best + ' (' + bp(best) + ' BP, ' +
					Math.round(value(best)) + ' against this fight' +
					(buyingLine ? ', the party had no line' : '') + ')' +
					(known.length >= 4 ? ' over ' + weakest : ''));
				break;
			}
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

/**
 * `press` for an element we already hold a handle to.
 *
 * ElementHandle.click waits for the element to be stable exactly as
 * page.click does, so staging a party out of a twenty-two strong box died on
 * an up-arrow that the re-render never let settle. Dispatching on the handle
 * asks the same question of the same element without the wait.
 */
function tap(handle) {
	return handle ? handle.evaluate(el => {
		el.click();
		return true;
	}) : Promise.resolve(false);
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
	const memory = {switchedFor: new Set(), statusedFoes: new Set(), cleared: 0, disarmed: 0,
		sacked: 0, screens: new Set(), boosts: 0, slowed: new Set(), healed: 0,
		banked: 0};
	const turns = [];
	let lastFoe = '';
	for (let turn = 0; turn < 300; turn++) {
		if (outOfTime()) return {turns: turns, outcome: 'out of time'};
		const view = await readBattle(page);
		if (/recorded/.test(view.result)) break;
		if (!view.open) break;
		if (view.foe !== lastFoe) {
			lastFoe = view.foe;
			// The card reads "Kubfu L20". In an uncapped run this is the only
			// thing that says how far along the difficulty curve we are.
			const met = /\bL(\d+)\b/.exec(view.foe || '');
			if (met) strongestFoe = Math.max(strongestFoe, Number(met[1]));
			if (view.threat) note('threat', view.foe + ' — ' + view.threat);
		}
		const choice = decide(view, memory, roster);
		if (!choice) {
			await page.waitForTimeout(200);
			continue;
		}
		// A sacrifice is rare and load-bearing, so it goes in the log. Every
		// other turn's `why` lives only in `turns`, which is why the first
		// attempt to check whether the sacrifice had ever fired came back zero
		// and proved nothing at all.
		if (/^(spending|setting) /.test(choice.why || '')) {
			note('line', choice.why + ' — against ' + view.foe);
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
		await tap(button);
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
	if (RULES === 'hardcore') {
		await page.check('#runbun-run-new-cap');
		await page.check('#runbun-run-new-nuzlocke');
		await page.check('#runbun-run-new-permadeath');
		await page.check('#runbun-run-new-route');
		await page.selectOption('#runbun-run-new-dupes', 'line');
	} else if (RULES === 'encounters') {
		// A Nuzlocke without the death. Every encounter rule stays on — one
		// catch per route and the dupes clause, so the box is composed exactly
		// the way a real run composes it — and the level caps stay on, so
		// every fight is still fought at the level it is meant to be fought
		// at. Only permadeath comes off.
		//
		// That is the setting that teaches the most per run: the box and the
		// difficulty are honest, so what happens in a fight means what it
		// would mean in a real run, but a loss costs the fight instead of
		// ending the attempt — so one run reaches far more of the map than
		// hardcore ever does. Its wins do not count as a cleared Nuzlocke.
		await page.check('#runbun-run-new-cap');
		await page.check('#runbun-run-new-nuzlocke');
		await page.uncheck('#runbun-run-new-permadeath');
		await page.check('#runbun-run-new-route');
		await page.selectOption('#runbun-run-new-dupes', 'line');
	} else if (RULES === 'uncapped') {
		// The telescope: encounters, no permadeath, and NO LEVEL CAP. Nothing
		// it does resembles a real run — it is for seeing what the capped runs
		// never reach, because everything past order 139 is unobserved and the
		// screens and stat boosts are demonstrably not on the shelf at L21.
		// Levelling falls back to the strongest foe met plus --margin.
		await page.uncheck('#runbun-run-new-cap');
		await page.check('#runbun-run-new-nuzlocke');
		await page.uncheck('#runbun-run-new-permadeath');
		await page.check('#runbun-run-new-route');
		await page.uncheck('#runbun-run-new-shiny-clause');
		await page.selectOption('#runbun-run-new-dupes', 'off');
	} else {
		await page.check('#runbun-run-new-cap');
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

		// Decided here, acted on further down — after the party has been
		// caught, levelled, taught and chosen.
		//
		// The first cut marked the fight here and skipped straight to the next
		// cycle, which skipped every one of those steps. Boxes still reached
		// Brawly correctly capped at L21 and with the same fifteen catches, so
		// it looked right, but they arrived taught 5.6 TMs against 29.5 for a
		// run that fought the road. Rehearsing a boss with a party five times
		// worse equipped than the road would have made it measures the
		// handicap and not the boss.
		const markThisOne = ONLY === 'bosses' && await page.evaluate(() => {
			const button = document.querySelector('#runbun-run-upcoming .runbun-run-up-beat');
			return button ? button.getAttribute('data-trainer') : null;
		}).then(name => !!name && !BOSS.test(name));

		if (PIN_BOX.length) {
			await pinBox(page);
		} else {
			await takeEncounters(page);
		}
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
		// After the priced upgrades, the unpriced demand: a priority answer for
		// a sash-threshold set, which the advisor's damage deltas cannot see —
		// Quick Attack scores nothing against a full-HP grid and everything
		// against a 1-HP survivor.
		await prepareForThreshold(page);
		// And any tool move a FREE slot could hold: the teach paths above all
		// have a reason to skip a zero-damage move on a mon with room.
		await fillToolSlots(page);
		// The SIX WHO FIGHT, not the six caught first. `box` is every catch in
		// catch order and `party` is a separate list of ids, so handing the
		// box straight over taught whoever turned up earliest — fine while the
		// box was still smaller than a party, and wrong from the seventh catch
		// on. By Brawly the box is twenty-two deep and the six are chosen by
		// matchup, so the ones being taught were mostly not the ones fighting.
		if (TMS === 'assume') {
			const view = await readRun(page);
			const byId = new Map(view.box.map(mon => [mon.id, mon]));
			await assumeTms(page, view.party.map(id => byId.get(id)).filter(Boolean));
		}
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

		// The party is now built, taught and equipped for this fight. An
		// ordinary trainer in boss-rush mode is credited here rather than
		// fought — before the plan is read and before the battle opens, since
		// the Mark beaten button belongs to the upcoming list and is gone once
		// a battle is on screen.
		if (markThisOne) {
			const marked = await markBeaten(page);
			if (marked) {
				note('mark', marked + ' — beaten unfought');
				continue;
			}
			// Never loop on a fight that will not mark. One run pressed a
			// non-matching selector twenty-one times and called each press
			// progress; a refusal has to end the run, not repeat.
			problem('only', 'could not mark ' + ready.nextTitle + ' beaten — stopping');
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
			await tap(back);
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
				// Before giving up: if this exact fight is one the profile
				// declares reorderable, the panel renders a Skip button for it,
				// and pressing it is what the game intends — Gavi is meant to
				// be passed and taken after the museum grunts. The button's
				// presence IS the legality check; a required-in-place fight
				// never renders one.
				const trainerName = before.nextTitle.replace(/^Face /, '');
				const skip = SKIP_WALLS ? await page.$(
					'.runbun-run-up-skip[data-trainer="' + trainerName + '"]') : null;
				if (skip) {
					await tap(skip);
					note('skip', 'skipped ' + trainerName + ' after ' + stalled +
						' attempts — owed, taking the road forward first');
					stalled = 0;
					continue;
				}
				problem('run', stalled + ' attempts with no progress at ' + before.nextTitle);
				break;
			}
		} else {
			// The retry caps are set from where wins were observed to land, so
			// a win landing near a cap is the evidence that the observation has
			// moved. Say so, rather than let a later cap silently discard a box
			// that could have cleared the fight.
			const nearBoss = /Leader|Elite|Champion|Rival/i.test(before.nextTitle);
			const limit = nearBoss ? BOSS_RETRIES : RETRIES;
			if (stalled && stalled + 1 >= limit - 1) {
				note('run', 'won at attempt ' + (stalled + 1) + ' of ' + limit +
					' at ' + before.nextTitle + ' — the retry cap is nearly biting');
			}
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
	// The run document itself, so a finished run can be loaded back into the
	// panel and looked at. The report carried the box but never the run, so
	// there was no way to open a playthrough in the app it was driving —
	// paste this into the transfer box and Import.
	const runDoc = await savedRun(page).catch(() => null);
	// Provenance. A report that cannot say which code produced it cannot be
	// compared with another: an A/B whose arms straddled a mid-run edit reads
	// exactly like one that did not, and today one did. A tally holding two
	// revisions is now self-evidently invalid, and `dirty` says the tree had
	// uncommitted changes so the revision alone does not identify the code.
	// Resolved BEFORE the provenance block: the audit below reports flags that
	// nothing asked for, and asking for this one afterwards made it accuse
	// itself. A guard that cries wolf is a guard that gets ignored.
	const reportName = flag('report', 'report-' + STARTER + '-' + started + '.json');
	const provenance = {
		revision: gitOutput(['rev-parse', 'HEAD']),
		dirty: gitOutput(['status', '--porcelain']) !== '',
		argv: process.argv.slice(2),
		unreadFlags: unreadFlags(),
		node: process.version,
		startedAt: new Date(started).toISOString(),
	};
	if (provenance.unreadFlags.length) {
		problem('flags', 'passed but never read: ' +
			provenance.unreadFlags.map(name => '--' + name).join(', '));
	}
	const report = {
		starter: STARTER,
		provenance: provenance,
		run: runDoc,
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
	// One report per run. Every run used to write to the same path, so a
	// nine-run batch overwrote its own results eight times and left only
	// the last — which is why a question about the IV spread of the boxes
	// that cleared a wall could not be answered from a batch that had
	// already measured it. The name carries the starter and the start
	// time, so runs sort and never collide.
	const reportPath = path.join(OUT, reportName);
	fs.writeFileSync(reportPath, JSON.stringify(report, null, '\t'));

	console.log('\n=== ' + report.fights + ' fights · ' + report.won + ' won · ' +
		report.wiped + ' wiped · ' + report.seconds + 's');
	console.log('reached: ' + report.reached);
	console.log('report: ' + reportPath);
	console.log('problems: ' + problems.length);
	for (const issue of problems.slice(0, 40)) {
		console.log('  - ' + issue.where + ': ' + issue.message);
	}

	await context.close();
	await browser.close();
	await new Promise((resolve, reject) =>
		server.close(error => error ? reject(error) : resolve()));
}

/**
 * The decision core, exported so it can be gated.
 *
 * These are the pure parts: they take a view or an entry and return a number
 * or an object, touch no page and no run. The policy they encode was measured
 * — turns-and-accuracy ranking led damage-only on every metric over thirty
 * interleaved runs — and a measured result that nothing pins is a result that
 * regresses quietly. `tests/playthrough_policy.test.js` pins them.
 *
 * Requiring this file must not START a playthrough, so main runs only when
 * this is the program rather than an import.
 */
module.exports = {
	isToolTeach: isToolTeach,
	parsePinBox: parsePinBox,
	pickReplace: pickReplace,
	decide: decide,
	isSlowControl: isSlowControl,
	raceOf: raceOf,
	turnsToKO: turnsToKO,
	accuracyOf: accuracyOf,
	scoreMove: scoreMove,
	capOf: capOf,
	ivNote: ivNote,
	unreadFlags: unreadFlags,
	rankMoves: rankMoves,
	moveValue: moveValue,
	basePowerOf: basePowerOf,
};

if (require.main === module) {
	main().catch(error => {
		console.error(error);
		process.exit(1);
	});
}
