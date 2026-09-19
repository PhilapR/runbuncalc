#!/usr/bin/env node
/* eslint-env node, es6 */
'use strict';

/**
 * Scenario battery: the playthrough policy, exercised past where runs die.
 *
 * Live runs end at Brawly's door (fight ~25 of 362), so every policy A/B so
 * far has graded the same narrow corridor — and graded it through a browser,
 * at ~25 minutes a batch, with box luck swamping n=8. This runner plays
 * single fights HEADLESSLY: a banked run document (any depth — the archive
 * holds 112 past Brawly, the deepest at order 282), a named trainer ahead of
 * it, N seeds, the real engine, and the real decide() policy reading the
 * same view text the panel renders (lib/battle-view.js is the bridge, with
 * parity gates).
 *
 * What it is NOT: a run. No teaching, no shopping, no healing between
 * fights, no attempt loop — one fight from the document's exact box state,
 * repeated across seeds. A scenario win rate is a statement about the
 * policy in that position, not about a run's chance of getting there.
 *
 *   node scripts/scenario-battery.js --manifest=scenarios/battery.json
 *   node scripts/scenario-battery.js --report=ui-playthrough-out/report-X.json \
 *     --trainer="Leader Wattson" --seeds=20
 *
 * Policy flags (--race-sends=0, --bank-bodies=1, ...) pass straight through:
 * the policy module reads the same argv this script was launched with.
 */

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const driver = require('../lib/battle-driver.js');
const run = require('../lib/run.js');
const viewOf = require('../lib/battle-view.js').viewOf;

function flag(name, fallback) {
	const hit = process.argv.find(arg => arg.startsWith('--' + name + '='));
	return hit ? hit.split('=').slice(1).join('=') : fallback;
}

/**
 * What code produced these numbers. ab.js has recorded this from its first
 * batch; the battery did not, and every batch before 2026-08-29 had its
 * revision reconstructed from file mtimes against the git log — the weak
 * form ingest.py labels "reconstructed". Recording it here is what lets a
 * manifest's `measured` stamp be checked instead of trusted, and `dirty` is
 * the honest asterisk: this repo's habit is to run first and commit after,
 * so the stamp in the manifest names the commit that CARRIES the batch, not
 * this revision.
 */
function provenance() {
	const git = args => {
		try {
			return childProcess.execFileSync('git', args,
				{cwd: path.join(__dirname, '..'), encoding: 'utf8'}).trim();
		} catch (error) {
			return null;
		}
	};
	return {
		revision: git(['rev-parse', 'HEAD']),
		dirty: git(['status', '--porcelain']) !== '',
		date: new Date().toISOString(),
	};
}

function freshMemory() {
	return {switchedFor: new Set(), statusedFoes: new Set(), cleared: 0,
		disarmed: 0, sacked: 0, screens: new Set(), boosts: 0,
		slowed: new Set(), healed: 0, banked: 0,
		stallTried: new Set(), progress: null, endeavored: 0,
		koYielded: new Set()};
}

/**
 * The policy's memory, reduced to numbers a receipt can carry.
 *
 * Sets become their size and the clock is dropped — `progress` counts turns
 * since the last gain, which is a reading, not a tally. `slowed` splits in
 * two because it holds two different treatments keyed into one set: a Speed
 * drop under the foe's name, an attack drop under 'atk:' + the foe's name.
 * Summed together, one could fire on every seed while the other never ran
 * and the total would still look alive — which is the exact reading error
 * this whole function exists to close.
 */
function countersOf(memory) {
	const slowed = Array.from(memory.slowed || []);
	const atk = key => String(key).startsWith('atk:');
	return {
		cleared: memory.cleared || 0,
		disarmed: memory.disarmed || 0,
		sacked: memory.sacked || 0,
		boosts: memory.boosts || 0,
		healed: memory.healed || 0,
		banked: memory.banked || 0,
		endeavored: memory.endeavored || 0,
		screens: (memory.screens || new Set()).size,
		statused: (memory.statusedFoes || new Set()).size,
		switchedFor: (memory.switchedFor || new Set()).size,
		stallTried: (memory.stallTried || new Set()).size,
		koYielded: (memory.koYielded || new Set()).size,
		clockHeld: memory.clockHeld || 0,
		switchRepriced: memory.switchRepriced || 0,
		slowed: slowed.filter(key => !atk(key)).length,
		attackDrops: slowed.filter(atk).length,
	};
}

/**
 * What is left of the trainer's side when the fight ends.
 *
 * A loss row says nothing about how close it was; "their last body at 4%"
 * and "we never scratched the lead" are the same 0/20 in a total. The wall
 * coroner in the audit backlog needs exactly this number to tell a wall from
 * a near miss, and it is two lines to record now rather than a re-run later.
 */
function foeRemainderOf(battle) {
	const state = (battle || {}).state || {};
	const party = ((state.sides || {}).ai || {}).party || [];
	let current = 0;
	let max = 0;
	let alive = 0;
	for (const mon of party) {
		const hp = mon.hp || {};
		current += Math.max(0, hp.current || 0);
		max += hp.max || 0;
		if ((hp.current || 0) > 0) alive += 1;
	}
	return {alive, of: party.length,
		hpPct: max ? Math.round(current / max * 1000) / 10 : null};
}

/**
 * Which policy flags a counter can honestly speak for.
 *
 * Only flags that GATE their rule are here. With `--bank-bodies=0` the
 * counter cannot move; with `--bank-bodies=1` every bank increments it. So a
 * zero across a whole batch means the treatment never ran once, and the
 * tally is not evidence about it — it is the control, relabelled. That is
 * ab.js's refusal ("an own-flag nothing reads is now a refusal") moved one
 * step downstream, to the flag that WAS read and then never reached.
 *
 * The modifier flags are deliberately absent, and their absence is the
 * point. `--speed-control` does not switch the slow rule on, it widens which
 * moves qualify; `--heal-control` swaps the heal rule's guard for
 * healWorthIt. Their counters move whether or not the flag was passed, so a
 * count neither proves the treatment fired nor proves it did not. A gate
 * built on one would pass every time and check nothing, which is the hollow
 * kind this repository has already paid for twice.
 */
const GATED_COUNTERS = {
	'bank-bodies': {counter: 'banked', on: value => value !== '0'},
	'stall-break': {counter: 'stallTried', on: value => value !== '0'},
	'endeavor-line': {counter: 'endeavored', on: value => value !== '0'},
	'attack-drop': {counter: 'attackDrops', on: value => value !== '0'},
	'sac': {counter: 'sacked', on: value => Number(value) > 0},
	'ko-respects-order': {counter: 'koYielded', on: value => value !== '0'},
	'stall-clock': {counter: 'clockHeld', on: value => value === 'net'},
	'repick-party': {counter: 'repicked', on: value => value === '1'},
	'pick-by-play': {counter: 'pickedByPlay', on: value => Number(value) > 1},
	'set-exposure': {counter: 'exposurePriced', on: value => Number(value) > 0},
	'swap-catch': {counter: 'catchSwapped', on: value => value !== ''},
	'swap-teach': {counter: 'swapTaught', on: value => value === '1'},
	'switch-priced': {counter: 'switchRepriced', on: value => value === '1'},
};

/**
 * Gating flags that were passed in their enabling value and never fired.
 *
 * Passed-and-enabling is the whole test. `--stall-break` defaults ON, so a
 * batch run with `--stall-break=0` is SUPPOSED to show a zero and must not
 * be refused for it; only an argument actually present on argv is audited,
 * and only when its value turns the rule on.
 */
function unfiredTreatments(argv, results) {
	const unfired = [];
	for (const name of Object.keys(GATED_COUNTERS)) {
		const rule = GATED_COUNTERS[name];
		const hit = argv.find(arg => arg.startsWith('--' + name + '='));
		if (!hit) continue;
		if (!rule.on(hit.slice(name.length + 3))) continue;
		const total = results.reduce(
			(sum, row) => sum + ((row.counters || {})[rule.counter] || 0), 0);
		if (!total) unfired.push({flag: hit, counter: rule.counter});
	}
	return unfired;
}

/**
 * The fights in a batch where the engine refused a transition.
 *
 * A refusal is not a result: the driver turns it into a lost turn so a live
 * fight survives it, which is exactly how a Burn Up user went unhittable and
 * 113 wins in the adopted baselines were counted as real. A batch with any is
 * still written, as evidence of the defect, but it is not a measurement.
 */
function engineRefusalReport(results) {
	return results.map(row => ({name: row.name,
		seeds: (row.rows || []).filter(entry => entry.engineRefusals > 0).map(entry => entry.seed),
		refusals: (row.rows || []).reduce((sum, entry) => sum + (entry.engineRefusals || 0), 0)}))
		.filter(entry => entry.refusals > 0);
}

/**
 * A receipt that cannot be diagnosed is not written.
 *
 * The totals are a summary OF the rows, so they can be checked against them
 * — and a summary that disagrees with its own rows is fiction, whichever
 * side is wrong. This is the gate the totals alone could never have: before
 * rows existed, a scenario that silently played 19 of its 20 seeds reported
 * a clean `seeds: 20` and no reader could tell.
 */
function requireWholeReceipt(receipt) {
	const faults = [];
	for (const row of receipt.results || []) {
		if (!Array.isArray(row.rows)) {
			faults.push(row.name + ': no per-seed rows at all');
			continue;
		}
		if (row.rows.length !== row.seeds) {
			faults.push(row.name + ': ' + row.rows.length + ' rows for ' +
				row.seeds + ' seeds');
		}
		const tallied = row.wins + row.losses + row.stuck;
		if (tallied !== row.seeds) {
			faults.push(row.name + ': win/loss/stuck sums to ' + tallied +
				', not ' + row.seeds + ' seeds');
		}
		const won = row.rows.filter(entry => entry.result === 'win').length;
		if (won !== row.wins) {
			faults.push(row.name + ': ' + won + ' winning rows but wins=' + row.wins);
		}
		const seen = new Set(row.rows.map(entry => entry.seed));
		if (seen.size !== row.rows.length) {
			faults.push(row.name + ': the rows repeat a seed');
		}
	}
	if (faults.length) {
		throw new Error('REFUSING to write a receipt that cannot be diagnosed:' +
			'\n  ' + faults.join('\n  '));
	}
	return receipt;
}

/**
 * One fight, engine only, decided by the real policy.
 *
 * The guard is generous because a stall is a finding, not a crash: a policy
 * that cannot end a fight reports 'stuck' and the scenario counts it.
 *
 * `tape`, when given, is an array the fight writes itself into, one entry a
 * decision: what stood on both sides, what the threat line said, what the
 * policy chose and why, and what the engine said happened. It is never
 * stored in a receipt — the fight is deterministic per seed, so
 * scripts/battery-tape.js replays any receipt's seed on demand instead.
 */
function playScenario(policy, doc, trainer, seed, tape) {
	const roster = (doc.box || []).map(mon => ({id: mon.id, moves: mon.moves}));
	let reply = driver.start(doc, trainer, seed);
	let battle = reply.battle;
	const memory = freshMemory();
	// Transitions the engine refused: each is a lost turn the driver made up.
	let engineRefusals = 0;
	let guard = 0;
	while (guard++ < 400) {
		if (reply.result) {
			return {result: reply.result, turns: battle.state.turn, engineRefusals,
				deaths: (reply.deaths || []).length,
				// The driver already knows who killed what and with which
				// move, on every death it reports: our `species` fell to the
				// move `by`, used by their `of`. The battery threw all of it
				// away and kept the count.
				killers: (reply.deaths || []).map(death => ({
					species: death.species || null,
					by: death.by || null,
					of: death.of || null,
				})),
				foe: foeRemainderOf(battle),
				counters: countersOf(memory)};
		}
		// start() carries no phase; a forced replacement offers only switches.
		const phase = reply.phase ||
			(reply.actions.some(entry => entry.kind === 'move') ? 'choose' : 'replace');
		const view = viewOf(Object.assign({}, reply, {phase}));
		const choice = policy.decide(view, memory, roster) ||
			{kind: reply.actions[0].kind, pick: reply.actions[0].kind === 'move' ?
				{move: reply.actions[0].move} : {id: reply.actions[0].action.replacementId}};
		const action = choice.kind === 'move' ?
			{kind: 'move', move: choice.pick.move} :
			{kind: 'switch', replacementId: choice.pick.id};
		reply = driver.act(battle, action);
		engineRefusals += (reply.events || []).filter(event => event.engineRefusal).length;
		if (tape) {
			tape.push({turn: battle.state.turn, phase, us: view.us, usHp: view.usHp,
				foe: view.foe, foeHp: view.foeHp, threat: view.threat || '',
				chose: choice.kind === 'move' ? choice.pick.move :
					'switch to ' + (choice.pick.species || choice.pick.label || choice.pick.id),
				why: choice.why || '(fallback: first legal action)',
				events: (reply.events || []).map(event => event.text).filter(Boolean)});
		}
		battle = reply.battle;
	}
	return {result: 'stuck', turns: 400, deaths: null, killers: [], engineRefusals,
		foe: foeRemainderOf(battle), counters: countersOf(memory)};
}

/**
 * A banked document pairs its stored orders with trainers resolved against
 * the CURRENT map; on a stale scale the position silently means a different
 * road. Refuse rather than misread — the 2026-08-28 insertion is why the
 * stamp exists.
 */
function requireScale(doc) {
	const profile = require('../profiles').getProfile(doc.profileId);
	const scale = profile.encounters && profile.encounters.ORDER_SCALE;
	if (!scale) return doc;
	if (doc.orderScale !== scale.id) {
		throw new Error('this document\'s orders are on scale ' +
			(doc.orderScale ? JSON.stringify(doc.orderScale) : '(unstamped)') +
			' but the map is on ' + JSON.stringify(scale.id) +
			' — migrate the document before playing it');
	}
	return doc;
}

/**
 * The run document a scenario plays from.
 *
 * A scenario may name a whole report or a banked run document — the report's
 * `run`, shelved alone in fixtures/banked-runs/ by extract-run-fixture.js.
 * The battery read reports out of gitignored ui-playthrough-out/ until the
 * 2026-09-14 offload emptied it and no scenario could run; the tracked shelf
 * is the same document byte for byte, a fifth of the size, and it survives
 * the next offload. Anything that is neither is refused by name rather than
 * played as an empty box.
 */
function loadDocument(file) {
	const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
	const doc = loaded.run || loaded;
	if (!Array.isArray(doc.box) || !doc.profileId) {
		throw new Error(file + ' is neither a report nor a run document');
	}
	return doc;
}

/**
 * The document a scenario plays, after the pre-fight choice a live run makes.
 *
 * The battery played `doc.party` verbatim: whatever six the banked run last
 * set, against a trainer it may never have been picked for. A live run
 * presses Rank before every fight and fields the top six, lead first — the
 * audit's "re-pick the six", and the one pre-fight decision the battery
 * skipped. `--repick-party=1` makes that choice here, through run.apply, so
 * the run's own party rules refuse an illegal pick. The live driver can
 * then move the lead to the plan's forecast (--lead=forecast); that second
 * step is not reproduced, so this arm measures the ranker's six and the
 * ranker's lead. The flag is read when called, not at load, so the tape
 * tool re-picks under a receipt's own argv.
 */
/**
 * Selection seeds for --pick-by-play: disjoint from every evaluation seed.
 *
 * A six picked by its wins on seeds 1-20 and then graded on seeds 1-20 is
 * graded on the seeds that picked it, and flatters itself. Manifests grade
 * on 1..seeds (at most a few dozen); selection starts far above them.
 */
const SELECTION_SEED_BASE = 100000;

/** The six the ranker's top party names, lead first. */
function sixOf(party) {
	return [party.lead].concat(party.members.map(member => member.id).filter(id => id !== party.lead));
}

/**
 * Choose among the ranker's top K sixes by playing them.
 *
 * The ranker scores a six by an assignment-following playout that is not
 * the policy that fights, and at Roxanne it shows: its pWin tracks wins at
 * r = 0.13, and in br-19 its first six wins 0/30 where its own seventh wins
 * 20/30 (LEADER-KEYS, 2026-09-18). So each candidate plays S selection
 * seeds with the real policy and the most wins goes; a tie keeps the
 * ranker's order. Every candidate's tally is returned for the receipt.
 */
function pickByPlay(policy, doc, trainer, parties, seeds) {
	const tallies = parties.map(party => {
		const candidate = run.apply(doc, {kind: 'party', ids: sixOf(party)});
		let wins = 0;
		for (let offset = 1; offset <= seeds; offset++) {
			if (playScenario(policy, candidate, trainer, SELECTION_SEED_BASE + offset).result === 'win') wins++;
		}
		return wins;
	});
	return {chosen: chooseByTally(tallies), wins: tallies};
}

/** The 1-based rank with the most wins; a tie goes to the ranker's earlier six. */
function chooseByTally(wins) {
	let best = 0;
	for (let index = 1; index < wins.length; index++) if (wins[index] > wins[best]) best = index;
	return best + 1;
}

/**
 * Adopted 2026-09-18 by operator ruling (DECISIONS: the-battery-picks-the-six-by-play):
 * the ranker's first six sixes, six selection seeds each.
 */
const PICK_BY_PLAY = '6';
const PICK_SEEDS = '6';

function explicitPick() {
	const hit = process.argv.find(arg => arg.startsWith('--pick-by-play='));
	return hit ? Number(hit.slice('--pick-by-play='.length)) : 0;
}

/** What the receipt records: no six was picked by play when the banked six plays. */
function effectivePick() {
	return flag('repick-party', '1') === '0' ? '0' : flag('pick-by-play', PICK_BY_PLAY);
}

/**
 * The adopted defaults this batch ran under, as the tape tool must replay
 * them. With the banked six nothing was ranked, so neither the pick nor the
 * set score applied.
 */
function effectiveDefaults() {
	const banked = flag('repick-party', '1') === '0';
	return {'switch-priced': flag('switch-priced', '1'), 'repick-party': flag('repick-party', '1'),
		'pick-by-play': effectivePick(), 'pick-seeds': flag('pick-seeds', PICK_SEEDS),
		'set-exposure': banked ? '0' : flag('set-exposure', String(run.EXPOSURE_WEIGHT))};
}

/**
 * --swap-catch=MAP:Species: the box as if MAP's encounter had been Species.
 *
 * A counterfactual that keeps the one-encounter-per-route rule: the mon
 * this run caught on MAP is replaced, not joined, and keeps its id, level,
 * nature, IVs, item and place in the party; the species takes its first
 * ability and its last four level-up moves at that level, evolved as far as
 * the level takes it (dossier.evolveTo). No TM is taught, so it is a floor.
 * A species MAP's table does not offer is refused, and so is a box with no
 * living catch from MAP. Built to ask whether an early catch plan moves the
 * gym walls (Brawly's named answers are all catchable by Route 104).
 */
function reachableByLevel(species, form, level) {
	const evolutions = require('../profiles/run-and-bun/oracle/evolutions.json');
	if (species === form) return true;
	return (evolutions[species] || []).some(path => path.method === 'level' && path.level <= level &&
		reachableByLevel(path.into, form, level));
}

function swapCatch(doc, spec) {
	const hit = /^(MAP_[A-Z0-9_]+):([^:>]+)(?:>([^:>]+))?$/.exec(spec);
	if (!hit) throw new Error('--swap-catch is MAP_NAME:Species or MAP_NAME:Species>Form, not ' + JSON.stringify(spec));
	const map = hit[1];
	const species = hit[2];
	const form = hit[3] || null;
	const oracle = require('../profiles').getProfile(doc.profileId).oracle;
	const table = oracle.encountersOn(map);
	if (!table || !(table.mons || []).some(entry => entry.species === species)) {
		throw new Error('--swap-catch: ' + map + ' does not offer ' + species);
	}
	const index = doc.box.findIndex(mon => mon.status !== 'dead' && mon.origin && mon.origin.map === map);
	if (index === -1) throw new Error('--swap-catch: this box has no living catch from ' + map);
	const dossier = require('../lib/dossier');
	const calc = require('../calc');
	const old = doc.box[index];
	// A branching line (Tyrogue: Hitmonchan, Hitmonlee or Hitmontop by its
	// stats) has no condition in the evolution data, and evolveTo takes the
	// first path; >Form names the branch, and must be one the level reaches.
	// With no >Form, the encounter's own IVs and nature choose the branch,
	// as they would have in the game.
	const fielded = form === null ?
		dossier.evolveMon({species, ivs: old.ivs, nature: old.nature}, old.level) : form;
	if (form !== null && !reachableByLevel(species, form, old.level)) {
		throw new Error('--swap-catch: ' + species + ' does not become ' + form + ' by level ' + old.level);
	}
	const found = calc.Generations.get(8).species.get(calc.toID(fielded));
	if (!found) throw new Error('--swap-catch: no species data for ' + fielded);
	const next = structuredClone(doc);
	next.box[index] = Object.assign({}, old, {species: fielded, nickname: null,
		ability: Object.values(found.abilities)[0], moves: dossier.lastFourMoves(fielded, old.level),
		origin: Object.assign({}, old.origin, {counterfactual: {caught: species, replaced: old.species}})});
	return {doc: next, swapped: {map, caught: species, fielded, replaced: old.species, id: old.id}};
}

/**
 * --swap-teach=1: the swapped-in catch learns what the upgrade advisor would
 * teach it for this fight, best row first, until no row for it gains a KO or
 * damage. Only the advisor's rows, so only moves dated as obtainable before
 * the fight (or relearned for a Heart Scale the bag holds): at Brawly that is
 * filler for Route 104's answers, because Aerial Ace, Sludge Bomb and Dual
 * Wingbeat are undated (2026-09-18). The advisor reads the party, so the
 * catch stands in it while advising and the party is put back after.
 */
function teachSwapped(doc, trainer, id) {
	const party = doc.party.slice();
	let current = Object.assign({}, doc, {party: [id].concat(party.filter(member => member !== id)).slice(0, 6)});
	const taught = [];
	const refused = new Set();
	for (let round = 0; round < 8; round++) {
		const row = run.adviseUpgrades(current, trainer).upgrades.find(entry => entry.kind === 'teach' &&
			entry.id === id && !refused.has(entry.detail) &&
			(entry.delta.koGained - entry.delta.koConceded > 0 || entry.delta.damage > 0));
		if (!row) break;
		refused.add(row.detail);
		const pair = /^(.+?)(?: over (.+?))?(?: \(|$)/.exec(row.detail);
		try {
			current = run.apply(current, {kind: 'teach', id, move: pair[1].trim(),
				replace: pair[2] ? pair[2].trim() : undefined});
			taught.push(row.detail);
		} catch (error) { /* a refused row stays refused and the loop moves on */ }
	}
	return {doc: Object.assign({}, current, {party}), taught};
}

function prepareDocument(doc, trainer, policy) {
	const swapSpec = flag('swap-catch', '');
	const teach = flag('swap-teach', '0');
	if (teach !== '0' && teach !== '1') throw new Error('--swap-teach must be 0 or 1');
	if (teach === '1' && !swapSpec) throw new Error('--swap-teach teaches the swapped catch; it needs --swap-catch');
	const swap = swapSpec ? swapCatch(doc, swapSpec) : null;
	if (swap && teach === '1') {
		const developed = teachSwapped(swap.doc, trainer, swap.swapped.id);
		swap.doc = developed.doc;
		swap.swapped.taught = developed.taught;
	}
	if (swap) doc = swap.doc;
	const prepared = prepareSix(doc, trainer, policy);
	if (swap) prepared.swapped = swap.swapped;
	return prepared;
}

function prepareSix(doc, trainer, policy) {
	const mode = flag('repick-party', '1');
	if (mode !== '0' && mode !== '1') {
		throw new Error('--repick-party must be 0 or 1, not ' + JSON.stringify(mode));
	}
	const k = Number(flag('pick-by-play', PICK_BY_PLAY));
	const seeds = Number(flag('pick-seeds', PICK_SEEDS));
	if (!Number.isInteger(k) || k < 0 || !Number.isInteger(seeds) || seeds < 1) {
		throw new Error('--pick-by-play must be a whole number of sixes and --pick-seeds at least 1');
	}
	if (mode === '0') {
		// The default picks by play; only an explicit request with the
		// banked six is a contradiction.
		if (explicitPick() > 1) {
			throw new Error('--pick-by-play chooses among re-picked sixes; it needs --repick-party=1');
		}
		return {doc, repick: null};
	}
	// --set-exposure prices a shared weakness in the ranker's set score
	// (rankParties' exposureWeight). The default is the ranker's own, and the
	// weight is always passed, so --set-exposure=0 cannot fall through to it.
	const exposureWeight = Number(flag('set-exposure', String(run.EXPOSURE_WEIGHT)));
	if (!(exposureWeight >= 0)) {
		throw new Error('--set-exposure is a weight at least 0, not ' + JSON.stringify(flag('set-exposure')));
	}
	const ranked = run.rankParties(doc, trainer, {exposureWeight});
	const parties = ranked.parties || [];
	const priced = exposureWeight && ranked.setScore && ranked.setScore.exposureWeight === exposureWeight ?
		{exposureWeight} : {};
	if (!parties.length) return {doc, repick: {changed: false, why: 'the ranker offered no party'}};
	let chosen = parties[0];
	let byPlay = null;
	if (k > 1) {
		if (!policy) throw new Error('--pick-by-play needs the policy that will fight');
		byPlay = Object.assign({k, seeds}, pickByPlay(policy, doc, trainer, parties.slice(0, k), seeds));
		chosen = parties[byPlay.chosen - 1];
	}
	const ids = sixOf(chosen);
	const changed = JSON.stringify(ids) !== JSON.stringify(doc.party);
	return {doc: changed ? run.apply(doc, {kind: 'party', ids}) : doc,
		repick: Object.assign({changed, from: (doc.party || []).slice(), to: ids},
			byPlay ? {byPlay} : {}, priced)};
}

/**
 * The scenarios this process plays: all of them, or shard i of n.
 *
 * One batch of a big manifest ran in one process for as long as its
 * slowest scenario chain; split by index, n processes run it side by side
 * through battery-arms and the receipts are joined when scored.
 */
function shardOf(scenarios, spec) {
	if (!spec) return scenarios;
	const hit = /^(\d+)\/(\d+)$/.exec(spec);
	if (!hit || Number(hit[1]) >= Number(hit[2]) || Number(hit[2]) < 1) {
		throw new Error('--shard is i/n with 0 <= i < n, not ' + JSON.stringify(spec));
	}
	return scenarios.filter((scenario, index) => index % Number(hit[2]) === Number(hit[1]));
}

function runScenario(policy, scenario) {
	const prepared = prepareDocument(requireScale(loadDocument(scenario.report)),
		scenario.trainer, policy);
	const doc = prepared.doc;
	const seeds = scenario.seeds || 20;
	const out = {name: scenario.name, trainer: scenario.trainer,
		report: path.basename(scenario.report), position: doc.position,
		seeds, wins: 0, losses: 0, stuck: 0, deaths: 0, turns: 0,
		counters: {}, rows: []};
	for (let seed = 1; seed <= seeds; seed++) {
		const played = playScenario(policy, doc, scenario.trainer, seed);
		if (played.result === 'win') out.wins += 1;
		else if (played.result === 'stuck') out.stuck += 1;
		else out.losses += 1;
		out.deaths += played.deaths || 0;
		out.turns += played.turns || 0;
		for (const key of Object.keys(played.counters || {})) {
			out.counters[key] = (out.counters[key] || 0) + played.counters[key];
		}
		// The row, not a summary of it. Every question the audit asked of
		// battery3 after the fact — which seeds stalled, what killed us,
		// how close the losses were, whether the flag ever fired — is a
		// filter over this array, and none of them could be asked of a
		// wins/losses pair.
		out.rows.push({seed, result: played.result, turns: played.turns,
			deaths: played.deaths, killers: played.killers || [],
			foe: played.foe || null, counters: played.counters || {},
			engineRefusals: played.engineRefusals || 0});
	}
	// Written only when the arm is on, so a control receipt is byte-identical
	// to one from before the flag existed.
	if (prepared.repick) {
		out.repick = prepared.repick;
		out.counters.repicked = prepared.repick.changed ? 1 : 0;
		if (prepared.repick.byPlay) out.counters.pickedByPlay = prepared.repick.byPlay.chosen > 1 ? 1 : 0;
		// The ranker says it priced the term, so the flag reached it.
		if (prepared.repick.exposureWeight) out.counters.exposurePriced = 1;
	}
	if (prepared.swapped) {
		out.swapped = prepared.swapped;
		out.counters.catchSwapped = 1;
		if (prepared.swapped.taught) out.counters.swapTaught = prepared.swapped.taught.length ? 1 : 0;
	}
	return out;
}

/**
 * Flags on argv that neither this script nor the policy reads.
 *
 * The browser driver has refused these since --legacy-rank was passed to a
 * whole A/B arm without existing; the battery never asked. So a typo'd
 * treatment — `--ko-respect-order=1` — ran the control under the
 * treatment's label, and only the five gating flags had a counter that
 * could notice afterwards. Checked before a single fight, so a refused
 * batch costs nothing and writes no receipt. The policy's flags are all
 * read at load, which is why its answer is complete by the time we ask.
 */
function unreadBy(policy, own) {
	return policy.unreadFlags().filter(name => !own.includes(name));
}

function refuseUnread(policy, own) {
	const unread = unreadBy(policy, own);
	if (!unread.length) return;
	console.error('REFUSING: nothing reads ' + unread.map(name => '--' + name).join(', ') +
		' — a typo here runs the control under the treatment\'s label');
	process.exit(1);
}

const OWN_FLAGS = ['manifest', 'label', 'pp-model', 'report', 'trainer', 'seeds',
	'repick-party', 'pick-by-play', 'pick-seeds', 'set-exposure', 'swap-catch', 'swap-teach', 'shard'];

function main() {
	// Loaded here, not at the top: the policy reads its flags from argv at
	// require time, and the gate loads this module with its own argv.
	const policy = require('./ui-playthrough.js');
	refuseUnread(policy, OWN_FLAGS);
	// A model flag, not a policy flag: it changes what the fight IS. The
	// receipt's argv records it, so an arm that ran fuel-free can never be
	// mistaken for one that ran with real PP.
	driver.setPPModel(flag('pp-model', '0') === '1');
	// The policy reads --switch-priced; the price itself lives in the driver.
	driver.setSwitchPricing(flag('switch-priced', '1') === '1');
	const label = flag('label', 'battery');
	const manifest = flag('manifest', '');
	const scenarios = shardOf(manifest ?
		JSON.parse(fs.readFileSync(manifest, 'utf8')).scenarios :
		[{name: flag('trainer', ''), report: flag('report', ''),
			trainer: flag('trainer', ''), seeds: Number(flag('seeds', '20'))}], flag('shard', ''));
	if (!scenarios.length || !scenarios[0].report) {
		console.error('need --manifest=FILE or --report=FILE --trainer=NAME');
		process.exit(1);
	}
	const results = [];
	for (const scenario of scenarios) {
		const row = runScenario(policy, scenario);
		results.push(row);
		console.log(
			row.name.padEnd(34) +
			('#' + row.position).padEnd(6) +
			(row.wins + '/' + row.seeds).padEnd(7) +
			'deaths/fight=' + (row.deaths / row.seeds).toFixed(2).padEnd(6) +
			'turns/fight=' + (row.turns / row.seeds).toFixed(1) +
			(row.stuck ? '  STUCK=' + row.stuck : ''));
	}
	const receipt = requireWholeReceipt({label, manifest: manifest || null,
		argv: process.argv.slice(2), provenance: provenance(), results,
		// What the batch ran under, whether or not argv said it. Defaults move
		// (both of these flipped on 2026-09-18); a receipt that names only
		// its argv cannot be replayed once they do. battery-tape.js reads this
		// and treats a receipt without it as pre-adoption.
		effective: effectiveDefaults(),
		shard: flag('shard', '') || null});
	const outPath = path.join('ui-playthrough-out', label + '-battery.json');
	fs.writeFileSync(outPath, JSON.stringify(receipt, null, '\t'));
	// The receipt is the same document in a TRACKED home. ui-playthrough-out
	// is gitignored, so the recorded revision above dies with the volume and
	// no gate can read it. A receipt committed with the batch is what lets a
	// manifest's `measured` stamp carry verdict "recorded": the provenance
	// gate checks the receipt's revision is an ancestor of the carrying
	// commit, instead of trusting the stamp's author.
	const receiptPath = path.join('scenarios', 'receipts', label + '.json');
	fs.mkdirSync(path.dirname(receiptPath), {recursive: true});
	fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, '\t') + '\n');
	console.log('\nwrote ' + outPath + ' and ' + receiptPath);
	// Audited AFTER the write, deliberately. The batch has already cost its
	// compute and the rows are worth keeping whatever the verdict says — an
	// inert arm is still a valid control, and the receipt is how anyone
	// later proves that is what it was. What must not happen is the batch
	// reporting success to a script that chains the next arm behind it, so
	// the exit code carries the refusal even though the file landed.
	const refused = engineRefusalReport(results);
	for (const entry of refused) {
		console.error('REFUSING the tally: the engine refused ' + entry.refusals + ' transition(s) in ' +
			entry.name + ' (seeds ' + entry.seeds.join(', ') + ') — those turns were made up, not played');
	}
	if (refused.length) process.exitCode = 1;
	const unfired = unfiredTreatments(process.argv.slice(2), results);
	if (unfired.length) {
		for (const entry of unfired) {
			console.error('REFUSING the tally: ' + entry.flag +
				' was passed and its counter (' + entry.counter +
				') stayed 0 across every seed — this batch is the control,' +
				' whatever the label says');
		}
		process.exitCode = 1;
	}
}

if (require.main === module) main();

module.exports = {playScenario, runScenario, freshMemory, requireScale, loadDocument,
	countersOf, foeRemainderOf, unfiredTreatments, requireWholeReceipt, refuseUnread, unreadBy,
	prepareDocument, engineRefusalReport, shardOf, chooseByTally, effectivePick, effectiveDefaults, swapCatch, SELECTION_SEED_BASE,
	OWN_FLAGS,
	GATED_COUNTERS};
