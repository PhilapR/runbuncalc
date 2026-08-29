#!/usr/bin/env node
/* eslint-env node, es6 */
'use strict';

/**
 * What teams become POSSIBLE if the encounter rule loosens from "roll the
 * die" to "choose from the route's table"?
 *
 * A nuzlocke run owns one catch per route. Under random rolls a box is a
 * sample; under table-choice it is an ASSIGNMENT: each open route
 * contributes any one species its tables carry, subject to the dupes
 * clause. That is a bipartite matching between routes and species, and the
 * dossier machinery already prices every species against a wall — so the
 * best assemblable team per wall is greedy matching over dossier scores,
 * with feasibility (route slots, evolution-line dupes) enforced.
 *
 * Output per wall: the optimal choice-team WITH its route assignment, its
 * score margin over the median random roll, and a counterfactual document
 * the battery can grade (30 seeds) against the rolled baseline.
 *
 *   node scripts/choice-teams.js                # analyze + write docs/manifest
 *   node scripts/scenario-battery.js --manifest=scenarios/choice.json --label=choice1
 */

const fs = require('node:fs');
const planner = require('../lib/planner');
const dossier = require('../lib/dossier');
const availability = require('../profiles/run-and-bun/oracle/availability.json');
const wildTables = require('../profiles/run-and-bun/oracle/encounters.json');
const evolutions = require('../profiles/run-and-bun/oracle/evolutions.json');

const WALLS = [
	{gym: 'brawly', trainer: 'Leader Brawly',
		source: 'ui-playthrough-out/counterfactual-brawly-baseline.json'},
	{gym: 'roxanne', trainer: 'Leader Roxanne',
		source: 'ui-playthrough-out/counterfactual-roxanne-baseline.json'},
	{gym: 'wattson', trainer: 'Leader Wattson',
		source: 'ui-playthrough-out/counterfactual-wattson-baseline.json'},
];

/** route -> Set(species) for every table open at `order`. */
function routeChoices(order) {
	const byMap = new Map((availability.entries || []).map(row => [row.map, row]));
	const methodGate = method => {
		const gate = availability.methods[method];
		return gate === undefined || gate <= 0 || gate <= order;
	};
	const routes = new Map();
	for (const entry of wildTables.maps) {
		const dated = byMap.get(entry.map);
		if (!dated || dated.opensAt === null || dated.opensAt === undefined) continue;
		if (dated.opensAt > 0 && dated.opensAt > order) continue;
		const species = new Set();
		for (const table of entry.tables || []) {
			if (!methodGate(table.method)) continue;
			for (const mon of table.mons || []) species.add(mon.species);
		}
		if (species.size) routes.set(entry.name, species);
	}
	return routes;
}

/** The evolution line's root-ward walk, for the dupes clause. */
function lineOf(species) {
	// Walk down is enough for a clause key: two catches collide when one
	// evolves into the other's line, and evolveTo already canonicalises the
	// caught form upward. Use the evolved form's line root by walking the
	// evolutions table backwards once.
	for (const from of Object.keys(evolutions)) {
		const paths = evolutions[from] || [];
		if (paths.some(p => p.into === species)) return lineOf(from);
	}
	return species;
}

/** Dossier value of every catchable species against one wall. */
function speciesScores(fight, cap, routes) {
	const caught = new Set();
	for (const set of routes.values()) for (const s of set) caught.add(s);
	const sample = [];
	const grown = new Map();
	for (const raw of caught) {
		const species = dossier.evolveTo(raw, cap);
		if (grown.has(species)) continue;
		const moves = dossier.lastFourMoves(species, cap);
		if (!moves.length) continue;
		grown.set(species, raw);
		sample.push({species, level: cap, moves,
			ivs: {hp: 15, atk: 15, def: 15, spa: 15, spd: 15, spe: 15}});
	}
	const grid = dossier.gridAgainst(fight.trainer, sample);
	const scores = new Map();
	for (const block of grid) {
		for (const row of block.versus) {
			if (!row.us || !row.them) continue;
			const answered = row.us.min >= 0.5 && (row.them.critMax || row.them.max) < 0.5;
			const prior = scores.get(row.species) || 0;
			scores.set(row.species, prior + (answered ? 2 : 0) + (row.us.min || 0) / 6);
		}
	}
	return {scores, grown};
}

/** Greedy value-ordered matching: species to a free route that carries it. */
function assemble(scores, grown, routes, cap) {
	const freeRoutes = new Set(routes.keys());
	const usedLines = new Set();
	const team = [];
	const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
	for (const entry of ranked) {
		if (team.length === 6) break;
		const species = entry[0];
		const raw = grown.get(species);
		const line = lineOf(raw);
		if (usedLines.has(line)) continue;
		const route = [...freeRoutes].find(name => routes.get(name).has(raw));
		if (!route) continue;
		freeRoutes.delete(route);
		usedLines.add(line);
		team.push({species, caughtAs: raw, route, score: entry[1], level: cap,
			moves: dossier.lastFourMoves(species, cap)});
	}
	return team;
}

function main() {
	const fights = planner.loadRunMap('run-and-bun');
	const manifest = [];
	for (const wall of WALLS) {
		const fight = fights.find(entry => entry.trainer === wall.trainer);
		const cap = dossier.capOf(fight.order);
		const routes = routeChoices(fight.order);
		const priced = speciesScores(fight, cap, routes);
		const team = assemble(priced.scores, priced.grown, routes, cap);
		console.log('=== ' + wall.trainer + ' (cap ' + cap + ', ' +
			routes.size + ' route slots) ===');
		for (const pick of team) {
			console.log('  ' + pick.species.padEnd(14) +
				' score ' + pick.score.toFixed(2).padStart(6) +
				'  catch ' + pick.caughtAs.padEnd(12) + ' on ' + pick.route);
		}
		const source = JSON.parse(fs.readFileSync(wall.source, 'utf8'));
		const doc = structuredClone(source.run);
		doc.box = team.map((pick, index) => ({
			id: 'choice-' + (index + 1), species: pick.species, nickname: null,
			level: pick.level, nature: 'Bashful',
			ability: null, item: null, moves: pick.moves,
			ivs: {hp: 15, atk: 15, def: 15, spa: 15, spd: 15, spe: 15},
			status: 'party', origin: {kind: 'counterfactual'},
		}));
		// The state builder wants a real ability; borrow the species default.
		const calc = require('../calc');
		for (const mon of doc.box) {
			const found = calc.Generations.get(8).species.get(calc.toID(mon.species));
			mon.ability = found && found.abilities ?
				Object.values(found.abilities)[0] : mon.ability;
		}
		doc.party = doc.box.map(mon => mon.id);
		const out = 'ui-playthrough-out/choice-' + wall.gym + '.json';
		fs.writeFileSync(out, JSON.stringify({run: doc}, null, '\t'));
		manifest.push({name: wall.trainer + ' · choice-team', report: out,
			trainer: wall.trainer, seeds: 30});
		// The invested version, because gymkey1 measured the interaction:
		// names alone moved nothing, names times IVs cracked Brawly.
		const invested = structuredClone(doc);
		for (const mon of invested.box) {
			mon.ivs = {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31};
		}
		const outMax = 'ui-playthrough-out/choice-' + wall.gym + '-max.json';
		fs.writeFileSync(outMax, JSON.stringify({run: invested}, null, '\t'));
		manifest.push({name: wall.trainer + ' · choice-team-max-ivs', report: outMax,
			trainer: wall.trainer, seeds: 30});
	}
	fs.writeFileSync('scenarios/choice.json', JSON.stringify({
		comment: 'Best assemblable teams under table-choice encounters (one catch ' +
			'per route, dupes clause respected), from scripts/choice-teams.js. ' +
			'A win rate here prices the CHOICE rule itself against rolled boxes.',
		scenarios: manifest,
	}, null, '\t') + '\n');
	console.log('\nwrote scenarios/choice.json');
}

main();
