#!/usr/bin/env node
/* eslint-env node, es6 */
'use strict';

/**
 * What should this route's one encounter be, for the gym ahead?
 *
 * Measured at Brawly (receipts a6816d5): of the sixteen species Route 104
 * offers, one catch moves the fight — Combee, fielded as Vespiquen, 30 to 75
 * wins of 380 — and the grid scorers that name it first order the rest no
 * better than rho 0.47. So each candidate is PLAYED: swapped into the box
 * (--swap-catch's rules), re-picked the way the battery re-picks, and fought
 * on selection seeds the battery never grades (SELECTION_SEED_BASE up).
 *
 * The encounter is a die, not a choice: the planner prices each method on
 * the route by expected gain — each species' chance within the method times
 * its wins over the box's own catch — and names the best species per method.
 * The dupes clause is ignored here (the box's own lines are not excluded),
 * which is stated rather than silent.
 *
 *   node scripts/catch-planner.js --report=fixtures/banked-runs/br-4.run.json \
 *     --trainer="Leader Brawly" --map=MAP_ROUTE104 [--seeds=6] [--pp-model=1] [--json]
 */

const battery = require('./scenario-battery.js');

function own(name, fallback) {
	const hit = process.argv.find(arg => arg.startsWith('--' + name + '='));
	return hit === undefined ? fallback : hit.slice(name.length + 3);
}

/** Wins on selection seeds for the box as prepared under the battery's rules. */
function selectionWins(policy, doc, trainer, seeds) {
	const prepared = battery.prepareDocument(doc, trainer, policy).doc;
	let wins = 0;
	for (let offset = 1; offset <= seeds; offset++) {
		if (battery.playScenario(policy, prepared, trainer,
			battery.SELECTION_SEED_BASE + offset).result === 'win') wins++;
	}
	return wins;
}

/**
 * Every species the map's open methods offer, played; then each method's
 * expected gain over the box's own catch. `seeds` selection fights each.
 */
function planRoute(policy, doc, trainer, map, seeds) {
	const oracle = require('../profiles').getProfile(doc.profileId).oracle;
	const table = oracle.encountersOn(map);
	if (!table) throw new Error('no encounter table for ' + map);
	const open = method => !oracle.methodOpensAt || (oracle.methodOpensAt(method) || 0) <= (doc.position || 0) + 1;
	const byMethod = {};
	for (const entry of table.mons) {
		if (!open(entry.method)) continue;
		const method = byMethod[entry.method] = byMethod[entry.method] || {};
		method[entry.species] = (method[entry.species] || 0) + entry.chance;
	}
	const baseline = selectionWins(policy, doc, trainer, seeds);
	const played = {};
	for (const method of Object.keys(byMethod)) {
		for (const species of Object.keys(byMethod[method])) {
			if (played[species] !== undefined) continue;
			played[species] = selectionWins(policy,
				battery.swapCatch(doc, map + ':' + species).doc, trainer, seeds);
		}
	}
	const methods = Object.keys(byMethod).map(method => {
		const odds = byMethod[method];
		const total = Object.values(odds).reduce((sum, chance) => sum + chance, 0);
		const species = Object.keys(odds).map(name => ({species: name, chance: odds[name] / total,
			wins: played[name], gain: played[name] - baseline}))
			.sort((a, b) => b.gain - a.gain || a.species.localeCompare(b.species));
		const expected = species.reduce((sum, entry) => sum + entry.chance * entry.gain, 0);
		return {method, expectedGain: Math.round(expected * 100) / 100, best: species[0].species, species};
	}).sort((a, b) => b.expectedGain - a.expectedGain);
	return {map, trainer, seeds, baseline, best: namedCatch(played, baseline), played, methods};
}

/**
 * The catch to name: the most selection wins, alphabetical on a tie, and
 * only when it beats the box's own catch — with no evidence either way the
 * planner keeps what the run caught (null).
 */
function namedCatch(played, baseline) {
	const top = Object.keys(played).sort((a, b) => played[b] - played[a] || a.localeCompare(b))[0];
	return top !== undefined && played[top] > baseline ? top : null;
}

function main() {
	// Candidates are fielded as the ranker's first six: pick-by-play inside
	// the planner would play 36 more fights per candidate. The grade (the
	// battery) still picks by play, so this is an approximation, stated.
	if (!process.argv.some(arg => arg.startsWith('--pick-by-play='))) process.argv.push('--pick-by-play=0');
	require('../lib/battle-driver.js').setPPModel(own('pp-model', '1') === '1');
	const policy = require('./ui-playthrough.js');
	const report = own('report');
	const trainer = own('trainer');
	const map = own('map');
	if (!report || !trainer || !map) throw new Error('--report, --trainer and --map are required');
	const seeds = Number(own('seeds', '6'));
	const doc = battery.requireScale(battery.loadDocument(report));
	const plan = planRoute(policy, doc, trainer, map, seeds);
	if (process.argv.includes('--json')) {
		process.stdout.write(JSON.stringify(plan) + '\n');
		return;
	}
	console.log(`${map} for ${trainer}: the box's own catch wins ${plan.baseline}/${seeds}; best catch ${plan.best || 'none better — keep it'}`);
	for (const method of plan.methods) {
		console.log(`  ${method.method}: expected gain ${method.expectedGain} per ${seeds} — ` +
			method.species.map(entry => `${entry.species} ${Math.round(entry.chance * 100)}% ${entry.gain >= 0 ? '+' : ''}${entry.gain}`).join(', '));
	}
}

if (require.main === module) main();

module.exports = {planRoute, namedCatch};
