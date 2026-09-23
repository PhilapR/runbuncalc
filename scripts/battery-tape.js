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
 *     --scenario="Bug Catcher Jose @37" --seed=4 [--json] [--engine-differs=intended]
 *
 * A name the receipt repeats is named as battery-pair prints it:
 * --scenario="Leader Roxanne · 15 scales [fixtures/banked-runs/x.run.json]".
 *
 * The row check catches code that moved the row. It cannot catch code that
 * moved the fight and landed on the same row, so a receipt stamped with an
 * engine (lib/provenance.js) is replayed only on that engine: a different one
 * is refused, naming the parts that differ, unless --engine-differs=intended
 * says the difference is the point. A receipt from before stamps is replayed
 * with a warning, and the row check is then the only guard.
 */

const fs = require('node:fs');
const path = require('node:path');
const provenance = require('../lib/provenance.js');

/** Defaults as they stood before 2026-09-18, for receipts written then. */
const PRE_ADOPTION = {'switch-priced': '0', 'real-speed': '0', 'repick-party': '0', 'pick-by-play': '0', 'set-exposure': '0', 'loser-work': '0', 'search-keep': '0', 'enemy-switch-scoring': '0'};

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

/**
 * The receipt's engine against this tree's: {same, text, warning}. Throws on a
 * known difference unless it was declared intended.
 */
function engineCheck(receipt, here, intended) {
	const stamped = provenance.stampOf(receipt);
	const compared = provenance.compareStamps(stamped, here);
	if (compared.same === false && !intended) {
		throw new Error('REFUSING: the receipt was played on another engine, so this tape would ' +
			'describe a fight nobody measured.\n  ' + compared.text +
			'\n  pass --engine-differs=intended if the difference is the point');
	}
	const warning = compared.same === null ?
		'WARNING: receipt ' + provenance.UNKNOWN + '; replayed on ' + provenance.describe(here) +
			' — the row check is the only guard' :
		compared.same === false ? 'WARNING (intended): ' + compared.text : null;
	return {same: compared.same, receipt: provenance.describe(stamped), replay: provenance.describe(here),
		differs: compared.differs, warning};
}

/**
 * The receipt's scenario for a name, or for "name [report]" as battery-pair
 * prints a name the receipt repeats. dose2*.json plays "Leader Roxanne · 15
 * scales" from two reports, and taking the first match replayed the wrong one
 * for half the flips. A bare name that repeats is refused, naming the keys
 * that would pick one; a name and report that both repeat is refused outright.
 */
function pickScenario(receipt, key, label) {
	const results = receipt.results || [];
	const where = label || 'the receipt';
	const byName = results.filter(entry => entry.name === key);
	if (byName.length === 1) return byName[0];
	if (byName.length > 1) {
		throw new Error(where + ' has ' + byName.length + ' scenarios named ' + JSON.stringify(key) +
			'; name one with its report: ' + byName.map(entry => JSON.stringify(entry.name + ' [' + entry.report + ']')).join(', '));
	}
	const qualified = /^(.*) \[([^\]]+)\]$/.exec(key);
	const hits = qualified ? results.filter(entry => entry.name === qualified[1] && entry.report === qualified[2]) : [];
	if (hits.length === 1) return hits[0];
	if (hits.length > 1) {
		throw new Error(where + ' has two scenarios named ' + JSON.stringify(qualified[1]) +
			' from one report (' + qualified[2] + '); no key can tell them apart');
	}
	throw new Error(where + ' has no scenario ' + JSON.stringify(key) +
		'; it has: ' + results.map(entry => entry.name).join(', '));
}

function replay(receiptPath, scenarioName, seed, options) {
	const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
	const engine = engineCheck(receipt, provenance.currentStamp(), !!(options && options.engineDiffersIntended));
	if (engine.warning) process.stderr.write(engine.warning + '\n');
	const row = pickScenario(receipt, scenarioName, receiptPath);
	const recorded = (row.rows || []).find(entry => entry.seed === seed);
	if (!recorded) throw new Error(scenarioName + ' has no row for seed ' + seed);
	const scenario = receipt.manifest ?
		JSON.parse(fs.readFileSync(receipt.manifest, 'utf8')).scenarios
			.find(entry => entry.name === row.name && (row.report === undefined || path.basename(entry.report) === row.report)) :
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
	driver.setSearchKeep(argOf(argv, 'search-keep') === '1');
	driver.setSearchHalving(argOf(argv, 'search-halving') === '1');
	driver.setSearchPath(argOf(argv, 'search-path') === '1');
	driver.setSearchLookahead(Number(argOf(argv, 'search-lookahead') || 0));
	driver.setEnemySwitchScoring(argOf(argv, 'enemy-switch-scoring') !== '0');

	// The same pre-fight choice the batch made, under the batch's argv.
	const doc = battery.prepareDocument(
		battery.requireScale(battery.loadDocument(scenario.report, scenario.at)), scenario.trainer, policy).doc;
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
	return {receipt: path.basename(receiptPath), scenario: scenarioName, seed, engine,
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
	const out = replay(receipt, scenario, seed,
		{engineDiffersIntended: ownFlag('engine-differs') === 'intended'});
	if (json) console.log(JSON.stringify(out, null, '\t'));
	else print(out);
}

if (require.main === module) main();

module.exports = {replay, engineCheck, pickScenario};
