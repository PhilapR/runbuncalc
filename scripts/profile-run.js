#!/usr/bin/env node
/* eslint-env node, es6 */
'use strict';

/**
 * Where the harness spends its time, repeatably.
 *
 *   node scripts/profile-run.js --budget=30          # a run, by phase and policy
 *   node scripts/profile-run.js --fight="Leader Brawly" --rollouts=2 --cpu
 *
 * A deep run takes hours and a sweep takes a day, so every guess about what
 * to make faster is expensive to test twice. This prints the same table each
 * time, from the same instruments, so two revisions can be compared:
 *
 *   - `phases`: rankParties, adviseUpgrades, unusedRoutes,
 *     preFightOpportunities — the prep a run pays between fights.
 *   - `fights`: grouped by the hand that played them (decide, search-K,
 *     joint-K), with the per-fight cost that decides a run's wall time.
 *   - `--cpu`: a V8 CPU profile of ONE fight, summarised by self time, which
 *     is how the calculator adapter was found to be a third of a searched
 *     fight (2026-09-20).
 *
 * Baselines, this machine, 2026-09-20 (docs/PERFORMANCE.md keeps the table):
 *   a 30-fight run: 425s wall — 74% fights, 15% rankParties, 8% adviseUpgrades
 *   a searched fight (search-8): 77s each; decide(): 0.3s each
 */

const fs = require('node:fs');
const path = require('node:path');

function flag(name, fallback) {
	const hit = process.argv.find(arg => arg.startsWith('--' + name + '='));
	if (hit) return hit.slice(name.length + 3);
	return process.argv.includes('--' + name) ? '1' : fallback;
}

/** Wrap the named exports of a module with a timer, in place. */
function instrument(target, names, into) {
	for (const name of names) {
		const real = target[name];
		if (typeof real !== 'function') continue;
		target[name] = function timed() {
			const started = process.hrtime.bigint();
			try {
				return real.apply(this, arguments);
			} finally {
				const took = Number(process.hrtime.bigint() - started) / 1e6;
				into[name] = into[name] || {calls: 0, ms: 0};
				into[name].calls += 1;
				into[name].ms += took;
			}
		};
	}
}

function profileRun(budget) {
	const battery = require('./scenario-battery.js');
	const headless = require('./headless-run.js');
	const run = require('../lib/run.js');
	const policy = require('./ui-playthrough.js');
	const phases = {};
	const fights = {};
	instrument(run, ['rankParties', 'adviseUpgrades', 'unusedRoutes', 'preFightOpportunities', 'learnable'], phases);
	const played = battery.playScenario;
	let fightMs = 0;
	battery.playScenario = function measured(unusedPolicy, doc, trainer) {
		const started = process.hrtime.bigint();
		const result = played.apply(this, arguments);
		const took = Number(process.hrtime.bigint() - started) / 1e6;
		fightMs += took;
		const hand = (result && result.policy) || 'decide';
		fights[hand] = fights[hand] || {calls: 0, ms: 0};
		fights[hand].calls += 1;
		fights[hand].ms += took;
		return result;
	};
	const started = Date.now();
	const row = headless.playRun(policy, {species: 'Chimchar', rival: 'Blaziken'}, 104770,
		headless.armFlags('--key-catches=1 --key-scales=1 --key-evolve=1'), {keepDoc: true});
	battery.playScenario = played;
	return {wallMs: Date.now() - started, budget, reached: row.fight, attempts: row.fights,
		fightMs, phases, fights};
}

function profileFight(trainer, rollouts, doubles) {
	const battery = require('./scenario-battery.js');
	const driver = require('../lib/battle-driver.js');
	driver.setPPModel(true);
	const doc = battery.loadDocument(path.join(__dirname, '..', 'fixtures', 'banked-runs',
		flag('box', 'brkeys3b-A-7.run.json')));
	const started = Date.now();
	const result = doubles ? driver.playDoubles(doc, trainer, 3, {search: rollouts, joint: true}) :
		driver.playSearch(doc, trainer, 3, {rollouts});
	return {wallMs: Date.now() - started, trainer, rollouts, doubles: !!doubles,
		result: result.result, turns: result.turns};
}

/** The top self-time frames of a .cpuprofile, which is what names a hotspot. */
function summariseProfile(file) {
	const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
	const byId = new Map(profile.nodes.map(node => [node.id, node]));
	const self = new Map();
	for (const id of profile.samples) {
		const node = byId.get(id);
		if (!node) continue;
		const frame = node.callFrame;
		const where = String(frame.url).split('/').slice(-2).join('/') + ':' + frame.lineNumber;
		const key = (frame.functionName || '(anonymous)') + '  ' + where;
		self.set(key, (self.get(key) || 0) + 1);
	}
	const total = profile.samples.length;
	return [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)
		.map(entry => ({frame: entry[0], percent: Math.round(100 * entry[1] / total)}));
}

function table(rows) {
	for (const row of rows) console.log('  ' + row);
}

function main() {
	// --cpu is taken by node itself: run it as
	//   node --cpu-prof --cpu-prof-dir=DIR scripts/profile-run.js --fight=...
	// then summarise the .cpuprofile with summariseProfile(), which is what
	// named the calculator adapter as a third of a searched fight.
	const trainer = flag('fight', '');
	if (trainer) {
		const out = profileFight(trainer, Number(flag('rollouts', '2')), flag('doubles', '') === '1');
		console.log(`${out.doubles ? 'joint' : 'search'}-${out.rollouts} at ${out.trainer}: ` +
			`${(out.wallMs / 1000).toFixed(1)}s, ${out.result} in ${out.turns} turns`);
		if (flag('json', '')) fs.writeFileSync(flag('json', ''), JSON.stringify(out, null, 1) + '\n');
		return;
	}
	const out = profileRun(Number(flag('budget', '30')));
	console.log(`${out.budget}-fight run: ${(out.wallMs / 1000).toFixed(1)}s wall, ` +
		`reached #${out.reached}, ${out.attempts} attempts`);
	console.log('\nfights by hand:');
	table(Object.entries(out.fights).sort((a, b) => b[1].ms - a[1].ms)
		.map(entry => entry[0].padEnd(18) + String(entry[1].calls).padStart(4) + ' fights  ' +
			(entry[1].ms / 1000).toFixed(1).padStart(7) + 's total  ' +
			(entry[1].ms / entry[1].calls / 1000).toFixed(1).padStart(6) + 's each'));
	console.log('\nprep phases (they overlap fights where a fight ranks a six):');
	table(Object.entries(out.phases).sort((a, b) => b[1].ms - a[1].ms)
		.map(entry => entry[0].padEnd(22) + String(entry[1].calls).padStart(6) + ' calls  ' +
			(entry[1].ms / 1000).toFixed(1).padStart(7) + 's  ' +
			String(Math.round(100 * entry[1].ms / out.wallMs)).padStart(3) + '% of wall'));
	console.log('\nfights were ' + Math.round(100 * out.fightMs / out.wallMs) + '% of wall');
	if (flag('json', '')) fs.writeFileSync(flag('json', ''), JSON.stringify(out, null, 1) + '\n');
}

if (require.main === module) main();

module.exports = {profileRun, profileFight, summariseProfile, instrument};
