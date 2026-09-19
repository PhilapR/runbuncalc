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
 *   node scripts/catch-planner.js --values=scenarios/catch-values/leader-brawly.json \
 *     --report=fixtures/banked-runs/br-4.run.json [--fresh] [--json]
 */

const battery = require('./scenario-battery.js');
const run = require('../lib/run.js');

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

/**
 * Planner v2: the whole early road priced from a gym's measured catch values
 * (scripts/build-catch-values.js), not replayed per box.
 *
 * Per box, six selection fights at an 8% base rate were mostly zeros, and
 * the per-box planner lost to "always Combee" (69 against 75 of 380). The
 * values pool nineteen boxes and twenty seeds per catch, so each route's
 * methods are priced by expected gain: the chance of each species on the
 * method — renormalised without the run's own lines when the dupes clause
 * is on, as rollEncounter rolls — times its measured gain. A line that
 * branches by its own stats (Tyrogue) is worth its forms' gains weighted by
 * dossier.branchOdds. A species the key never measured is worth 0 and named
 * as such. Routes are priced independently: two catches that answer the same
 * threat are not discounted against each other.
 */
function planFromValues(doc, values, options) {
	const opts = options || {};
	const profile = require('../profiles').getProfile(doc.profileId);
	const oracle = profile.oracle;
	const planner = require('../lib/planner');
	const dossier = require('../lib/dossier');
	const order = planner.getFight(values.trainer, doc.profileId).order;
	const rules = run.encounterRules(doc);
	const lines = new Set(opts.fresh ? [] : doc.box.map(mon => run.dupeKey(rules.dupes, profile, mon.species)));
	const valueOf = species => {
		const measured = values.values;
		const odds = dossier.branchOdds(species, 20);
		const forms = Object.keys(odds);
		if (forms.length > 1) {
			const known = forms.every(form => Object.values(measured).some(map => map[species + '>' + form]));
			if (!known) return {gain: 0, measured: false};
			let gain = 0;
			for (const form of forms) {
				const hit = Object.values(measured).map(map => map[species + '>' + form]).find(Boolean);
				gain += odds[form] * hit.gain;
			}
			return {gain, measured: true, branches: odds};
		}
		return null;
	};
	const routes = [];
	const maps = [...new Set(Object.keys(values.values).concat(Object.keys(values.screened || {})))];
	for (const map of maps) {
		const table = oracle.encountersOn(map);
		const dated = oracle.availabilityOf ? oracle.availabilityOf(map) : null;
		if (!table || (dated && dated.opensAt !== null && dated.opensAt > order)) continue;
		if (!opts.fresh && rules.onePerRoute && doc.box.some(mon => mon.origin && mon.origin.map === map)) continue;
		const methods = {};
		for (const entry of table.mons) {
			const gate = oracle.methodOpensAt ? oracle.methodOpensAt(entry.method) : 0;
			if (gate !== null && gate > order) continue;
			if (lines.has(run.dupeKey(rules.dupes, profile, entry.species))) continue;
			methods[entry.method] = methods[entry.method] || {};
			methods[entry.method][entry.species] = (methods[entry.method][entry.species] || 0) + entry.chance;
		}
		const priced = Object.keys(methods).map(method => {
			const total = Object.values(methods[method]).reduce((sum, chance) => sum + chance, 0);
			const species = Object.keys(methods[method]).map(name => {
				const branched = valueOf(name);
				const measured = (values.values[map] || {})[name];
				const worth = branched || (measured ? {gain: measured.gain, measured: true} : {gain: 0, measured: false});
				return Object.assign({species: name, chance: methods[method][name] / total}, worth);
			}).sort((a, b) => b.gain - a.gain || a.species.localeCompare(b.species));
			const expected = species.reduce((sum, entry) => sum + entry.chance * entry.gain, 0);
			return {method, expectedGain: expected, target: species[0].gain > 0 ? species[0].species : null, species};
		}).sort((a, b) => b.expectedGain - a.expectedGain);
		if (priced.length) routes.push({map, best: priced[0], methods: priced});
	}
	routes.sort((a, b) => b.best.expectedGain - a.best.expectedGain || a.map.localeCompare(b.map));
	return {trainer: values.trainer, order, seeds: values.seeds, routes};
}

function main() {
	if (own('values')) {
		const values = JSON.parse(require('node:fs').readFileSync(own('values'), 'utf8'));
		const doc = battery.loadDocument(own('report'));
		const plan = planFromValues(doc, values, {fresh: process.argv.includes('--fresh')});
		if (process.argv.includes('--json')) {
			process.stdout.write(JSON.stringify(plan) + '\n');
			return;
		}
		console.log(`Early catches for ${plan.trainer}, priced in wins per 100 fights:`);
		for (const route of plan.routes) {
			const best = route.best;
			console.log(`  ${route.map}: ${best.method} (+${(best.expectedGain * 100).toFixed(1)})` +
				(best.target ? ` — hope for ${best.target}` : ' — nothing here moves the fight') + '; ' +
				best.species.filter(entry => entry.gain > 0).map(entry =>
					`${entry.species} ${Math.round(entry.chance * 100)}% +${(entry.gain * 100).toFixed(1)}`).join(', '));
		}
		return;
	}

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

module.exports = {planRoute, namedCatch, planFromValues};
