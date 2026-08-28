#!/usr/bin/env node
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

const fs = require('node:fs');
const path = require('node:path');

const driver = require('../lib/battle-driver.js');
const {viewOf} = require('../lib/battle-view.js');

function flag(name, fallback) {
	const hit = process.argv.find(arg => arg.startsWith('--' + name + '='));
	return hit ? hit.split('=').slice(1).join('=') : fallback;
}

function freshMemory() {
	return {switchedFor: new Set(), statusedFoes: new Set(), cleared: 0,
		disarmed: 0, sacked: 0, screens: new Set(), boosts: 0,
		slowed: new Set(), healed: 0, banked: 0,
		stallTried: new Set(), progress: null};
}

/**
 * One fight, engine only, decided by the real policy.
 *
 * The guard is generous because a stall is a finding, not a crash: a policy
 * that cannot end a fight reports 'stuck' and the scenario counts it.
 */
function playScenario(policy, doc, trainer, seed) {
	const roster = (doc.box || []).map(mon => ({id: mon.id, moves: mon.moves}));
	let reply = driver.start(doc, trainer, seed);
	let battle = reply.battle;
	const memory = freshMemory();
	let guard = 0;
	while (guard++ < 400) {
		if (reply.result) {
			return {result: reply.result, turns: battle.state.turn,
				deaths: (reply.deaths || []).length};
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
		battle = reply.battle;
	}
	return {result: 'stuck', turns: 400, deaths: null};
}

function runScenario(policy, scenario) {
	const report = JSON.parse(fs.readFileSync(scenario.report, 'utf8'));
	const doc = report.run;
	const seeds = scenario.seeds || 20;
	const out = {name: scenario.name, trainer: scenario.trainer,
		report: path.basename(scenario.report), position: doc.position,
		seeds, wins: 0, losses: 0, stuck: 0, deaths: 0, turns: 0};
	for (let seed = 1; seed <= seeds; seed++) {
		const played = playScenario(policy, doc, scenario.trainer, seed);
		if (played.result === 'win') out.wins += 1;
		else if (played.result === 'stuck') out.stuck += 1;
		else out.losses += 1;
		out.deaths += played.deaths || 0;
		out.turns += played.turns || 0;
	}
	return out;
}

function main() {
	// Loaded here, not at the top: the policy reads its flags from argv at
	// require time, and the gate loads this module with its own argv.
	const policy = require('./ui-playthrough.js');
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
	const outPath = path.join('ui-playthrough-out', label + '-battery.json');
	fs.writeFileSync(outPath, JSON.stringify({label, results,
		argv: process.argv.slice(2)}, null, '\t'));
	console.log('\nwrote ' + outPath);
}

if (require.main === module) main();

module.exports = {playScenario, runScenario, freshMemory};
