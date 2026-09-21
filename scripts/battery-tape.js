#!/usr/bin/env node
/* eslint-env node, es6 */
'use strict';

/**
 * Replay one seed of one battery receipt, turn by turn.
 *
 * A receipt says which seeds a treatment flipped; it cannot say why. The
 * fight is deterministic per seed, and the receipt records the argv it ran
 * under, so the tape is not stored — it is regenerated here, under that same
 * argv, and checked against the receipt's own row before it is believed. A
 * replay that disagrees with its row means the code moved since the batch,
 * and a tape of different code is a story about a fight nobody measured, so
 * it is refused rather than printed.
 *
 *   node scripts/battery-tape.js --receipt=scenarios/receipts/koorder1-pp.json \
 *     --scenario="Bug Catcher Jose @37" --seed=4 [--json]
 */

const fs = require('node:fs');
const path = require('node:path');

/** Defaults as they stood before 2026-09-18, for receipts written then. */
const PRE_ADOPTION = {'switch-priced': '0', 'real-speed': '0', 'repick-party': '0', 'pick-by-play': '0', 'set-exposure': '0'};

function ownFlag(name) {
	const hit = process.argv.find(arg => arg.startsWith('--' + name + '='));
	return hit === undefined ? null : hit.slice(name.length + 3);
}

/** The fields a row and a replay must agree on before the tape is trusted. */
function rowOf(played, seed) {
	// The PLAY fields of a death, and only those. A row's record has grown
	// since the old receipts were written (a death now carries the box id of
	// the body that fell, for the chronicle); the fight it describes has not.
	// Comparing the whole object refused every committed receipt over a key
	// that says who, not what happened.
	return {seed, result: played.result, turns: played.turns, deaths: played.deaths,
		killers: (played.killers || []).map(death => ({
			species: death.species, by: death.by, of: death.of})),
		foe: played.foe || null};
}

function replay(receiptPath, scenarioName, seed) {
	const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
	const row = receipt.results.find(entry => entry.name === scenarioName);
	if (!row) {
		throw new Error(receiptPath + ' has no scenario ' + JSON.stringify(scenarioName) +
			'; it has: ' + receipt.results.map(entry => entry.name).join(', '));
	}
	const recorded = (row.rows || []).find(entry => entry.seed === seed);
	if (!recorded) throw new Error(scenarioName + ' has no row for seed ' + seed);
	const scenario = receipt.manifest ?
		JSON.parse(fs.readFileSync(receipt.manifest, 'utf8')).scenarios
			.find(entry => entry.name === scenarioName) :
		{report: argOf(receipt.argv, 'report'), trainer: argOf(receipt.argv, 'trainer')};
	if (!scenario) throw new Error(receipt.manifest + ' no longer names ' + scenarioName);

	// The policy reads its flags from argv when it loads, so the receipt's
	// argv has to be in place first — this process's own flags are not the
	// batch's. The PP model is the battery's switch, not the policy's.
	// Flags whose defaults changed after receipts were written. A receipt
	// records what it ran under in `effective`; one without that record
	// predates the change and ran with the old default, so that value is
	// passed explicitly — the current default would replay a different fight.
	const argv = receipt.argv.slice();
	for (const name of Object.keys(PRE_ADOPTION)) {
		if (argOf(argv, name) !== null) continue;
		const effective = (receipt.effective || {})[name];
		argv.push('--' + name + '=' + (effective !== undefined ? effective : PRE_ADOPTION[name]));
	}
	process.argv = [process.argv[0], 'scenario-battery.js'].concat(argv);
	const battery = require('./scenario-battery.js');
	const driver = require('../lib/battle-driver.js');
	const policy = require('./ui-playthrough.js');
	driver.setPPModel(argOf(argv, 'pp-model') === '1');
	driver.setSwitchPricing(argOf(argv, 'switch-priced') === '1');
	driver.setHidingForecast(argOf(argv, 'hiding-forecast') === '1');
	driver.setRealSpeed(argOf(argv, 'real-speed') === '1');
	driver.setChargeThreat(argOf(argv, 'charge-threat') === '1');
	driver.setDoublesJoint(argOf(argv, 'doubles-joint') === '1');
	driver.setSearchWiden(Number(argOf(argv, 'search-widen') || 0));

	// The same pre-fight choice the batch made, under the batch's argv.
	const doc = battery.prepareDocument(
		battery.requireScale(battery.loadDocument(scenario.report)), scenario.trainer, policy).doc;
	const tape = [];
	const played = battery.playScenario(policy, doc, scenario.trainer, seed, tape);
	const want = rowOf(recorded, seed);
	const got = rowOf(played, seed);
	if (JSON.stringify(want) !== JSON.stringify(got)) {
		throw new Error('REFUSING: the replay does not reproduce the receipt\'s row, so the ' +
			'code has moved since ' + String((receipt.provenance || {}).revision).slice(0, 10) +
			' and this tape would describe a fight nobody measured.\n  receipt: ' +
			JSON.stringify(want) + '\n  replay:  ' + JSON.stringify(got));
	}
	return {receipt: path.basename(receiptPath), scenario: scenarioName, seed,
		row: got, counters: played.counters, tape};
}

function argOf(argv, name) {
	const hit = (argv || []).find(arg => arg.startsWith('--' + name + '='));
	return hit === undefined ? null : hit.slice(name.length + 3);
}

function print(out) {
	console.log(out.receipt + ' · ' + out.scenario + ' · seed ' + out.seed + ' · ' +
		out.row.result + ' in ' + out.row.turns + ' turns, ' + out.row.deaths + ' dead' +
		(out.row.foe ? ', foe left ' + out.row.foe.alive + '/' + out.row.foe.of +
			' at ' + out.row.foe.hpPct + '%' : ''));
	for (const step of out.tape) {
		console.log('\nT' + step.turn + (step.phase === 'replace' ? ' (replace)' : '') + '  ' +
			step.us + ' ' + step.usHp + '%  vs  ' + step.foe + ' ' + step.foeHp + '%');
		if (step.threat) console.log('   threat: ' + step.threat);
		console.log('   chose:  ' + step.chose + '  — ' + step.why);
		for (const text of step.events) console.log('     ' + text);
	}
}

function main() {
	const receipt = ownFlag('receipt');
	const scenario = ownFlag('scenario');
	const seed = Number(ownFlag('seed'));
	if (!receipt || !scenario || !seed) {
		console.error('need --receipt=FILE --scenario=NAME --seed=N [--json]');
		process.exit(1);
	}
	const json = process.argv.includes('--json');
	const out = replay(receipt, scenario, seed);
	if (json) console.log(JSON.stringify(out, null, '\t'));
	else print(out);
}

if (require.main === module) main();

module.exports = {replay};
