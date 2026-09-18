#!/usr/bin/env node
/* eslint-env node, es6 */
'use strict';

/**
 * Does a Speed IV the advisor cannot see win fights at Wattson?
 *
 * adviseUpgrades scores an upgrade by KOs gained, KOs conceded and max
 * damage (upgradeDelta, lib/run.js). A Speed IV moves none of them, so the
 * filter drops it and the advisor never buys one — while the board it reads
 * already records who moves first. In the saturated Wattson dose (23 scales,
 * 5 left in the bag), Speed 31 changes the order in four cells: Ampharos
 * over Magnezone, Eelektross and Mega Ampharos, Manectric over Rotom-Fan.
 * Nobody measured whether those flips win anything; this builds the
 * documents that ask.
 *
 *   control23  the advisor's 23 purchases (dose-wattson-28, as banked)
 *   plus23     those, plus the two Speed IVs from the 5 scales left over
 *   swap23     the first 21 purchases, then the two Speed IVs: same budget
 *   control15  the advisor's 15 (dose-wattson-15, as banked)
 *   swap15     the first 13, then the two Speed IVs: same budget
 *
 * The advisor's purchases are read back from the banked dose-wattson-28 log
 * (dose 15 is its first 15, the greedy prefix) and replayed through
 * run.apply on the banked baseline, so every document is one the run's own
 * rules accept.
 *
 *   node scripts/speed-probe.js && \
 *     node scripts/scenario-battery.js --manifest=scenarios/speed.json --repick-party=0
 */

const fs = require('node:fs');
const path = require('node:path');

const manifestStore = require('../lib/manifest');
const run = require('../lib/run.js');

const SHELF = path.join(__dirname, '..', 'fixtures', 'banked-runs');
const SPEED = [{id: 'mon-15', why: 'Ampharos'}, {id: 'mon-20', why: 'Manectric'}];
const SEEDS = 60;

function banked(name) {
	return JSON.parse(fs.readFileSync(path.join(SHELF, name + '.run.json'), 'utf8'));
}

/** The baseline with `commands` applied and the bag the dose generator set. */
function dosed(baseline, commands, bag) {
	let doc = structuredClone(baseline);
	doc.bag = Object.assign({}, doc.bag, {'Heart Scale': bag});
	for (const command of commands) doc = run.apply(doc, command);
	return doc;
}

function main() {
	const baseline = banked('counterfactual-wattson-baseline');
	const advisor = banked('dose-wattson-28').log.slice(baseline.log.length)
		.map(entry => entry.command).filter(command => command.kind === 'heartScale');
	if (advisor.length !== 23) throw new Error('expected 23 advisor purchases, read ' + advisor.length);
	const speed = SPEED.map(mon => ({kind: 'heartScale', id: mon.id, stat: 'spe'}));
	const built = {
		plus23: dosed(baseline, advisor.concat(speed), 28),
		swap23: dosed(baseline, advisor.slice(0, 21).concat(speed), 28),
		swap15: dosed(baseline, advisor.slice(0, 13).concat(speed), 15),
	};
	for (const name of Object.keys(built)) {
		fs.writeFileSync(path.join('ui-playthrough-out', 'speed-' + name + '.json'),
			JSON.stringify({run: built[name]}, null, '\t'));
		console.log('wrote speed-' + name);
	}
	const scenario = (name, report) => ({name: 'Leader Wattson · ' + name, report,
		trainer: 'Leader Wattson', seeds: SEEDS});
	manifestStore.writeManifest('scenarios/speed.json', {
		comment: 'Speed probe at Wattson: do Speed IVs the advisor cannot price win fights? ' +
			'The advisor scores KOs and max damage only, so it never buys Speed; Speed 31 flips turn ' +
			'order for Ampharos (Magnezone, Eelektross, Mega Ampharos) and Manectric (Rotom-Fan). ' +
			'Pairs: control23/plus23 (the 5 unspent scales), control23/swap23 and control15/swap15 ' +
			'(same budget, Speed replacing the advisor\'s last two buys). ' +
			'Run with --repick-party=0: the party is part of the treatment here, and since 2026-09-18 ' +
			'the battery re-picks the six by default, which would replace it.',
		generator: 'scripts/speed-probe.js',
		scenarios: [
			scenario('control23', 'fixtures/banked-runs/dose-wattson-28.run.json'),
			scenario('plus23', 'fixtures/banked-runs/speed-plus23.run.json'),
			scenario('swap23', 'fixtures/banked-runs/speed-swap23.run.json'),
			scenario('control15', 'fixtures/banked-runs/dose-wattson-15.run.json'),
			scenario('swap15', 'fixtures/banked-runs/speed-swap15.run.json'),
		],
	});
	console.log('manifest written');
}

if (require.main === module) main();
