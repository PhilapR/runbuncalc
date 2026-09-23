#!/usr/bin/env node
/* eslint-env node, es6 */
'use strict';

/**
 * Heart-Scale dose-response: spend k scales advisor-greedily against a wall,
 * write the dosed document, and let the battery grade each dose at 30 seeds.
 * The 2026-08-29 run (dose1) produced the allocation math:
 *
 *   Wattson: 0/30 at 3 scales, 4/30 at 9, 9/30 at 15, 15/30 at 23 — where
 *   the advisor SATURATES (offers no further row) and exactly matches the
 *   whole-box max-IV ceiling gymcf2 measured. Marginal value ~2.6 win-rate
 *   points per scale on the 9-23 stretch, ~zero below 5.
 *   Roxanne: 0/30 at every dose — scales are the wrong currency for her.
 *
 *   node scripts/scale-dose.js && \
 *     node scripts/scenario-battery.js --manifest=scenarios/dose.json --label=doseN
 */

const fs = require('node:fs');
const manifestStore = require('../lib/manifest');
const run = require('../lib/run.js');

const SITES = [
	['wattson', 'ui-playthrough-out/counterfactual-wattson-baseline.json', 'Leader Wattson'],
	['roxanne', 'ui-playthrough-out/counterfactual-roxanne-baseline.json', 'Leader Roxanne'],
];
const DOSES = [3, 9, 15, 28];
const STATS = {HP: 'hp', Attack: 'atk', Defense: 'def',
	'Sp. Atk': 'spa', 'Sp. Def': 'spd', Speed: 'spe'};

const manifest = [];
for (const site of SITES) {
	const gym = site[0];
	const boss = site[2];
	for (const dose of DOSES) {
		let doc = structuredClone(JSON.parse(fs.readFileSync(site[1], 'utf8')).run);
		doc.bag = Object.assign({}, doc.bag, {'Heart Scale': dose});
		let spent = 0;
		while (spent < dose) {
			let advice;
			try {
				advice = run.adviseUpgrades(doc, boss);
			} catch (error) { break; }
			const row = advice.upgrades.find(entry => entry.kind === 'heartScale');
			if (!row) break;
			const stat = /^(HP|Attack|Defense|Sp\. Atk|Sp\. Def|Speed) IV/.exec(row.detail);
			if (!stat) break;
			try {
				doc = run.apply(doc, {kind: 'heartScale', id: row.id, stat: STATS[stat[1]]});
				spent += 1;
			} catch (error) { break; }
		}
		const out = 'ui-playthrough-out/dose-' + gym + '-' + dose + '.json';
		fs.writeFileSync(out, JSON.stringify({run: doc}, null, '\t'));
		manifest.push({name: boss + ' · ' + spent + ' scales', report: out,
			trainer: boss, seeds: 30});
		console.log(gym, 'dose', dose, '-> spent', spent);
	}
}
manifestStore.writeManifest('scenarios/dose.json', {
	comment: 'Heart Scale dose-response: k advisor-greedy IV purchases against ' +
		'the wall, graded by the battery. Derived docs regenerate from this script.',
	generator: 'scripts/scale-dose.js',
	scenarios: manifest,
});
console.log('manifest written');
