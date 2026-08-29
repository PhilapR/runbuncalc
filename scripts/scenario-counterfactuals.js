#!/usr/bin/env node
/* eslint-env node, es6 */
'use strict';

/**
 * Counterfactual gym scenarios: what would close the wall?
 *
 * battery1 measured all three early gyms at ~0/30 for period boxes, and the
 * standing theory says stats (trainers carry a flat 186 IV total against a
 * wild catch's mean 93) while the standing hope says lines (screens, Speed
 * control — the tools no rolled box carries). The browser loop could never
 * separate the two: a box with screens arrives once in dozens of runs, and
 * an IV counterfactual never arrives at all.
 *
 * This generator makes the variants by hand — the operator's "hard-coded
 * box" idea, generalized. Same document, same fight, one mutation each:
 *
 *   baseline   the banked box, untouched
 *   max-ivs    every box IV raised to 31 — the stat hypothesis, isolated
 *   screens    Reflect and Light Screen over two last moves — the line
 *              hypothesis, isolated (the driver's screen rule is on)
 *   slow       Icy Wind over one last move — the Speed-control line
 *   the-lot    all three at once — the ceiling
 *
 * Derived documents land in ui-playthrough-out/ (gitignored, regenerate at
 * will); the manifest lands in scenarios/counterfactuals.json. These are
 * COUNTERFACTUALS: no run reached these boxes, and a win rate here is a
 * statement about what would help, not about what a run owns.
 */

const fs = require('node:fs');
const path = require('node:path');

const GYMS = [
	{gym: 'brawly', report: 'ui-playthrough-out/report-brbank1-A-1.json', trainer: 'Leader Brawly'},
	{gym: 'roxanne', report: 'ui-playthrough-out/report-br-1.json', trainer: 'Leader Roxanne'},
	{gym: 'wattson', report: 'ui-playthrough-out/report-sac-A-11.json', trainer: 'Leader Wattson'},
];

function maxIvs(doc) {
	for (const mon of doc.box) {
		mon.ivs = {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31};
	}
}

/** In PARTY order, not box order: the first cut of this walked the box and
 * taught the screens to the last two bodies sent in, so every screen arrived
 * after four deaths and measured exactly zero. The lead and the second slot
 * are the ones whose turns exist while the fight is still winnable. */
function partyOf(doc) {
	return doc.party.map(id => doc.box.find(mon => mon.id === id));
}

function teachScreens(doc) {
	const screens = ['Reflect', 'Light Screen'];
	for (const mon of partyOf(doc).slice(0, 2)) {
		mon.moves = mon.moves.slice(0, 3).concat(screens.shift());
	}
}

function teachSlow(doc) {
	const party = partyOf(doc);
	const mon = party[2] || party[0];
	mon.moves = mon.moves.slice(0, 3).concat('Icy Wind');
}

/**
 * The correction, not the ceiling: only the starter line gets its three
 * guaranteed perfect IVs (the gift rule the model missed until 2026-08-28),
 * picked by a seeded die so the variant is reproducible. Every banked box
 * under-rolled exactly this body, so this variant measures what the bug
 * cost at each wall.
 */
const STARTER_LINES = [
	['Turtwig', 'Grotle', 'Torterra'], ['Chimchar', 'Monferno', 'Infernape'],
	['Piplup', 'Prinplup', 'Empoleon'],
];
function fixStarterIvs(doc) {
	const line = STARTER_LINES.flat();
	const starter = doc.box.find(mon => line.includes(mon.species));
	if (!starter) return;
	let seed = 7;
	const draw = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
	const stats = Object.keys(starter.ivs);
	for (let i = 0; i < 3; i++) {
		const pick = Math.floor(draw() * stats.length);
		starter.ivs[stats.splice(pick, 1)[0]] = 31;
	}
}

/**
 * The dossier's measured pick: the six period-catchable species that best
 * answer this leader's whole team (scripts/leader-dossier.js names them from
 * the engine's own matchup grid). Neutral nature, species-default ability,
 * period IVs, last-four level-up moves — a box a player could actually go
 * catch. This is the composition hypothesis with names on it.
 */
function keyBox(doc, trainer) {
	const dossiers = JSON.parse(fs.readFileSync('ui-playthrough-out/leader-dossiers.json', 'utf8'));
	const entry = dossiers.find(d => d.trainer === trainer);
	if (!entry || !entry.keyBox) throw new Error('no dossier key box for ' + trainer);
	const learnsets = require('../profiles/run-and-bun/oracle/learnsets.json');
	const calc = require('../calc');
	const box = entry.keyBox.map((species, index) => {
		const rows = (learnsets.levelUp && learnsets.levelUp[species]) || [];
		const moves = [...new Set(rows.filter(r => r[0] <= entry.cap).map(r => r[1]))].slice(-4);
		const found = calc.Generations.get(8).species.get(calc.toID(species));
		const ability = found && found.abilities ? Object.values(found.abilities)[0] : null;
		return {id: 'key-' + (index + 1), species, nickname: null, level: entry.cap,
			nature: 'Bashful', ability, item: null, moves,
			ivs: {hp: 15, atk: 15, def: 15, spa: 15, spd: 15, spe: 15},
			status: 'party', origin: {kind: 'counterfactual'}};
	});
	doc.box = box;
	doc.party = box.map(mon => mon.id);
}

const VARIANTS = [
	{name: 'baseline', mutate: () => {}},
	{name: 'starter-3iv', mutate: fixStarterIvs},
	{name: 'max-ivs', mutate: maxIvs},
	{name: 'screens', mutate: teachScreens},
	{name: 'slow', mutate: teachSlow},
	{name: 'the-lot', mutate: doc => { maxIvs(doc); teachScreens(doc); teachSlow(doc); }},
	{name: 'key-box', mutate: (doc, trainer) => keyBox(doc, trainer)},
	{name: 'key-box-max-ivs', mutate: (doc, trainer) => { keyBox(doc, trainer); maxIvs(doc); }},
];

function main() {
	const scenarios = [];
	for (const site of GYMS) {
		const source = JSON.parse(fs.readFileSync(site.report, 'utf8'));
		for (const variant of VARIANTS) {
			const doc = structuredClone(source.run);
			variant.mutate(doc, site.trainer);
			const file = path.join('ui-playthrough-out',
				'counterfactual-' + site.gym + '-' + variant.name + '.json');
			fs.writeFileSync(file, JSON.stringify({run: doc}, null, '\t'));
			scenarios.push({
				name: site.trainer + ' · ' + variant.name,
				report: file, trainer: site.trainer, seeds: 30,
			});
		}
	}
	fs.writeFileSync('scenarios/counterfactuals.json', JSON.stringify({
		comment: 'Gym-wall decomposition: banked boxes with one mutation each. ' +
			'Derived documents are regenerated by scripts/scenario-counterfactuals.js; ' +
			'a win rate here says what WOULD help, not what a run owns.',
		scenarios,
	}, null, '\t') + '\n');
	console.log(scenarios.length + ' scenarios written to scenarios/counterfactuals.json');
}

if (require.main === module) main();

module.exports = {VARIANTS, maxIvs, teachScreens, teachSlow};
