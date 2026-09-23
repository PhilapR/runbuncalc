#!/usr/bin/env node
/* eslint-env node, es6 */
'use strict';

/**
 * What each early catch is worth at a gym, from the receipts that measured it.
 *
 * Every committed receipt graded on one manifest is read; a receipt with
 * --swap-catch=MAP:Species[>Form] is that catch's arm, and one without is a
 * control. The controls must play seed for seed alike, or the key is refused:
 * a gain against a control from another engine is a story about the engine.
 * Each catch's value is its wins against the control, seed-paired (gained,
 * lost, exact McNemar p), in wins per seed so a planner can weigh it by odds.
 *
 * `screened` names what the key does NOT measure: species the ranker's
 * set-score screen put at or below zero (gain 0 is then an assumption, and
 * the file says so). The screen kept both Route 104 catches that gain 10+ and
 * missed two that gain 5-6 (Salandit, Scatterbug): its recall, stated.
 *
 *   node scripts/build-catch-values.js --manifest=scenarios/brawly.json \
 *     --out=scenarios/catch-values/leader-brawly.json [--screen=DIR]
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function own(name, fallback) {
	const hit = process.argv.find(arg => arg.startsWith('--' + name + '='));
	return hit === undefined ? fallback : hit.slice(name.length + 3);
}

function lnFactorial(n) {
	let sum = 0;
	for (let i = 2; i <= n; i++) sum += Math.log(i);
	return sum;
}

/** Two-sided exact McNemar p from the discordant counts. */
function mcnemar(gained, lost) {
	const n = gained + lost;
	const k = Math.min(gained, lost);
	let p = 0;
	for (let i = 0; i <= k; i++) {
		p += Math.exp(lnFactorial(n) - lnFactorial(i) - lnFactorial(n - i) - n * Math.log(2));
	}
	return Math.min(1, 2 * p);
}

function argOf(argv, name) {
	const hit = (argv || []).find(arg => arg.startsWith('--' + name + '='));
	return hit === undefined ? null : hit.slice(name.length + 3);
}

/** Every receipt graded on `manifest`, as {label, spec, revision, rows: Map}. */
function receiptsFor(manifest, receiptsDir) {
	const dir = receiptsDir || path.join(ROOT, 'scenarios', 'receipts');
	const found = [];
	for (const file of fs.readdirSync(dir).filter(name => name.endsWith('.json')).sort()) {
		const receipt = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
		if (receipt.manifest !== manifest) continue;
		const rows = new Map();
		for (const scenario of receipt.results) {
			for (const row of scenario.rows) rows.set(scenario.name + '#' + row.seed, row);
		}
		found.push({label: receipt.label, spec: argOf(receipt.argv, 'swap-catch'),
			shard: argOf(receipt.argv, 'shard'), teach: argOf(receipt.argv, 'swap-teach'),
			revision: (receipt.provenance || {}).revision || null, rows});
	}
	return found;
}

/** Shards of one arm joined into one row map; a duplicated row is refused. */
function join(parts) {
	const rows = new Map();
	for (const part of parts) {
		for (const entry of part.rows) {
			if (rows.has(entry[0])) throw new Error('two receipts for ' + entry[0] + ' in one arm');
			rows.set(entry[0], entry[1]);
		}
	}
	return rows;
}

function buildValues(manifest, screened, receiptsDir) {
	const receipts = receiptsFor(manifest, receiptsDir).filter(receipt => receipt.teach === null || receipt.teach === '0');
	// An arm is its spec; a spec measured twice (shards aside) keeps the first.
	const arms = new Map();
	for (const receipt of receipts) {
		const key = receipt.spec || 'control';
		const group = receipt.label.replace(/-s\d+-pp$|-pp$/, '');
		if (!arms.has(key)) arms.set(key, new Map());
		const byGroup = arms.get(key);
		if (!byGroup.has(group)) byGroup.set(group, []);
		byGroup.get(group).push(receipt);
	}
	const controlGroups = [...(arms.get('control') || new Map()).values()].map(join);
	if (!controlGroups.length) throw new Error('no control receipt graded on ' + manifest);
	const control = controlGroups[0];
	const sig = row => row.result + '/' + row.turns + '/' + row.deaths;
	for (const other of controlGroups.slice(1)) {
		for (const entry of control) {
			const twin = other.get(entry[0]);
			if (!twin || sig(twin) !== sig(entry[1])) {
				throw new Error('the controls on ' + manifest + ' disagree at ' + entry[0] +
					': the key would mix engines');
			}
		}
	}
	const controlWins = [...control.values()].filter(row => row.result === 'win').length;
	const values = {};
	for (const entry of arms) {
		if (entry[0] === 'control') continue;
		const rows = join([...entry[1].values()][0]);
		let gained = 0;
		let lost = 0;
		let wins = 0;
		for (const seed of control) {
			const treated = rows.get(seed[0]);
			if (!treated) throw new Error(entry[0] + ' has no row for ' + seed[0]);
			const won = treated.result === 'win';
			const was = seed[1].result === 'win';
			wins += won ? 1 : 0;
			if (won && !was) gained++;
			if (was && !won) lost++;
		}
		const spec = /^(MAP_[A-Z0-9_]+):(.+)$/.exec(entry[0]);
		values[spec[1]] = values[spec[1]] || {};
		values[spec[1]][spec[2]] = {wins, gain: (gained - lost) / control.size, gained, lost,
			p: Number(mcnemar(gained, lost).toPrecision(3))};
	}
	return {manifest, seeds: control.size, control: {wins: controlWins},
		values, screened: screened || {},
		note: 'gain is wins per seed over the control; a catch in `screened` and not in `values` ' +
			'was screened out by the ranker\'s set score and is ASSUMED worth 0'};
}

function main() {
	const manifest = own('manifest');
	const out = own('out');
	if (!manifest || !out) throw new Error('--manifest and --out are required');
	const doc = JSON.parse(fs.readFileSync(path.join(ROOT, manifest), 'utf8'));
	const trainers = [...new Set(doc.scenarios.map(scenario => scenario.trainer))];
	if (trainers.length !== 1) throw new Error(manifest + ' holds ' + trainers.length + ' trainers; a key is for one');
	const screenDir = own('screen', null);
	const screened = {};
	if (screenDir) {
		for (const file of fs.readdirSync(screenDir).filter(name => name.endsWith('.json'))) {
			const screen = JSON.parse(fs.readFileSync(path.join(screenDir, file), 'utf8'));
			screened[screen.map] = {};
			for (const species of Object.keys(screen.out).sort()) {
				if (screen.out[species].gain <= 0) screened[screen.map][species] = screen.out[species].gain;
			}
		}
	}
	const built = Object.assign({trainer: trainers[0]}, buildValues(manifest, screened));
	fs.mkdirSync(path.dirname(path.join(ROOT, out)), {recursive: true});
	fs.writeFileSync(path.join(ROOT, out), JSON.stringify(built, null, '\t') + '\n');
	console.log('wrote ' + out + ': ' + Object.values(built.values)
		.reduce((sum, map) => sum + Object.keys(map).length, 0) + ' measured catches, control ' +
		built.control.wins + '/' + built.seeds);
}

if (require.main === module) main();

module.exports = {buildValues, mcnemar};
