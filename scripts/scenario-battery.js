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
	let guard = 0;
	while (guard++ < 400) {
		if (reply.result) {
			return {result: reply.result, turns: battle.state.turn,
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
	return {result: 'stuck', turns: 400, deaths: null, killers: [],
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

function runScenario(policy, scenario) {
	const doc = requireScale(loadDocument(scenario.report));
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
			foe: played.foe || null, counters: played.counters || {}});
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

const OWN_FLAGS = ['manifest', 'label', 'pp-model', 'report', 'trainer', 'seeds'];

function main() {
	// Loaded here, not at the top: the policy reads its flags from argv at
	// require time, and the gate loads this module with its own argv.
	const policy = require('./ui-playthrough.js');
	refuseUnread(policy, OWN_FLAGS);
	// A model flag, not a policy flag: it changes what the fight IS. The
	// receipt's argv records it, so an arm that ran fuel-free can never be
	// mistaken for one that ran with real PP.
	driver.setPPModel(flag('pp-model', '0') === '1');
	const label = flag('label', 'battery');
	const manifest = flag('manifest', '');
	const scenarios = manifest ?
		JSON.parse(fs.readFileSync(manifest, 'utf8')).scenarios :
		[{name: flag('trainer', ''), report: flag('report', ''),
			trainer: flag('trainer', ''), seeds: Number(flag('seeds', '20'))}];
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
		argv: process.argv.slice(2), provenance: provenance(), results});
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
	OWN_FLAGS,
	GATED_COUNTERS};
