#!/usr/bin/env node
/* eslint-env node, es6 */
'use strict';

/**
 * Join a control receipt and a treatment receipt, seed by seed.
 *
 *   node scripts/battery-pair.js --control=scenarios/receipts/battery9-pp.json \
 *     --treatment=scenarios/receipts/ko1-pp.json [--json] [--engine-differs=intended]
 *
 * For each scenario both receipts played: the wins of each arm on the seeds
 * both played, and the seeds that flipped (lost to won, won to lost). The
 * flips are what scripts/battery-tape.js replays to read why.
 *
 * Each scenario, and the total, carries an exact McNemar test: a two-sided
 * binomial test of the gained flips against all flips (gained + lost) at
 * one half. It reads only the discordant seeds, which is what a paired
 * design measures. A scenario only one receipt played is listed, not dropped.
 * Two scenarios of one name in a receipt (dose2*.json plays "Leader Roxanne ·
 * 15 scales" from two reports) are told apart by their report; two of one
 * name and one report are refused, since no join could say which is which.
 *
 * It refuses to join receipts played on different engines (lib/provenance.js).
 * A treatment measured against a control from before an engine fix measures
 * the fix as well as the treatment, and nothing in the numbers says so: the
 * lead-entry and Download fixes of 2026-09-22 made every earlier receipt an
 * easier game. --engine-differs=intended joins them anyway, and says so on
 * every line of output. Receipts from before stamps are joined only when
 * both name the same revision; the join then carries a warning.
 */

const fs = require('node:fs');
const provenance = require('../lib/provenance.js');

function ownFlag(name, argv) {
	const hit = (argv || process.argv).find(arg => arg.startsWith('--' + name + '='));
	return hit === undefined ? null : hit.slice(name.length + 3);
}

/**
 * Whether two receipts may be joined: {ok, warning, text}. A known difference,
 * or one stamped against one unstamped, is not ok unless intended.
 */
function engineGate(control, treatment, intended) {
	const a = provenance.stampOf(control);
	const b = provenance.stampOf(treatment);
	const compared = provenance.compareStamps(a, b);
	if (compared.same === true) return {ok: true, warning: null, text: compared.text};
	let text;
	if (compared.same === false) text = compared.text;
	else if (!a && !b) {
		const ra = (control.provenance || {}).revision || null;
		const rb = (treatment.provenance || {}).revision || null;
		if (ra && ra === rb) {
			return {ok: true, warning: 'WARNING: both receipts are ' + provenance.UNKNOWN +
				'; joined because both name revision ' + ra.slice(0, 10), text: 'same revision, no stamps'};
		}
		text = 'both receipts are ' + provenance.UNKNOWN + ' and name different revisions (' +
			String(ra).slice(0, 10) + ', ' + String(rb).slice(0, 10) + ')';
	} else {
		text = 'control is ' + provenance.describe(a) + ', treatment is ' + provenance.describe(b);
	}
	if (intended) return {ok: true, warning: 'WARNING (intended): ' + text, text};
	return {ok: false, warning: null, text};
}

/**
 * Exact two-sided McNemar p: the chance, under no effect, of a split of the
 * discordant pairs at least as uneven as gained against lost.
 */
function mcnemar(gained, lost) {
	const n = gained + lost;
	if (!n) return 1;
	const k = Math.min(gained, lost);
	// Summed in log space: 2^-n underflows for n past about a thousand.
	let logChoose = 0;
	let tail = 0;
	for (let i = 0; i <= k; i++) {
		if (i > 0) logChoose += Math.log(n - i + 1) - Math.log(i);
		tail += Math.exp(logChoose - n * Math.LN2);
	}
	return Math.min(1, 2 * tail);
}

/**
 * A receipt's scenarios by join key: the name, or "name [report]" when the
 * name is not unique in the receipt. Throws when name and report both repeat.
 */
function keyed(receipt, label) {
	const results = receipt.results || [];
	const count = new Map();
	for (const entry of results) count.set(entry.name, (count.get(entry.name) || 0) + 1);
	const out = new Map();
	for (const entry of results) {
		const key = count.get(entry.name) > 1 ? entry.name + ' [' + entry.report + ']' : entry.name;
		if (out.has(key)) {
			throw new Error('REFUSING to join: the ' + label + ' receipt has two scenarios named ' +
				JSON.stringify(entry.name) + ' from one report (' + entry.report + '); no join can tell them apart');
		}
		out.set(key, entry);
	}
	return out;
}

/** The scenarios only one receipt played: {control: [key], treatment: [key]}. */
function unmatched(control, treatment) {
	const c = keyed(control, 'control');
	const t = keyed(treatment, 'treatment');
	return {control: [...c.keys()].filter(key => !t.has(key)), treatment: [...t.keys()].filter(key => !c.has(key))};
}

/** The per-scenario join. Seeds only one arm played are left out, and counted. */
function pair(control, treatment) {
	const out = [];
	const byKey = keyed(treatment, 'treatment');
	const byControl = keyed(control, 'control');
	for (const key of byControl.keys()) {
		const c = byControl.get(key);
		const t = byKey.get(key);
		if (!t) continue;
		const bySeed = new Map((t.rows || []).map(row => [row.seed, row]));
		const joined = (c.rows || []).filter(row => bySeed.has(row.seed))
			.map(row => ({seed: row.seed, control: row.result, treatment: bySeed.get(row.seed).result}));
		const won = side => joined.filter(row => row[side] === 'win').length;
		const gained = joined.filter(row => row.control !== 'win' && row.treatment === 'win').map(row => row.seed);
		const lost = joined.filter(row => row.control === 'win' && row.treatment !== 'win').map(row => row.seed);
		out.push({name: key, seeds: joined.length, control: won('control'), treatment: won('treatment'), gained, lost,
			p: mcnemar(gained.length, lost.length),
			unpaired: (c.rows || []).length + (t.rows || []).length - 2 * joined.length});
	}
	return out;
}

/** Every scenario's seeds pooled: the flips summed, and one McNemar p over them. */
function total(rows) {
	const sum = field => rows.reduce((acc, row) => acc + (Array.isArray(row[field]) ? row[field].length : row[field]), 0);
	const gained = sum('gained');
	const lost = sum('lost');
	return {seeds: sum('seeds'), control: sum('control'), treatment: sum('treatment'), gained, lost,
		p: mcnemar(gained, lost)};
}

function main() {
	const controlPath = ownFlag('control');
	const treatmentPath = ownFlag('treatment');
	if (!controlPath || !treatmentPath) {
		console.error('need --control=RECEIPT --treatment=RECEIPT [--json] [--engine-differs=intended]');
		process.exit(2);
	}
	const control = JSON.parse(fs.readFileSync(controlPath, 'utf8'));
	const treatment = JSON.parse(fs.readFileSync(treatmentPath, 'utf8'));
	const gate = engineGate(control, treatment, ownFlag('engine-differs') === 'intended');
	if (!gate.ok) {
		console.error('REFUSING to join: ' + gate.text +
			'\n  a treatment against a control on another engine measures the engine change too.' +
			'\n  pass --engine-differs=intended if that is the point');
		process.exit(1);
	}
	if (gate.warning) console.error(gate.warning);
	let rows;
	let alone;
	try {
		rows = pair(control, treatment);
		alone = unmatched(control, treatment);
	} catch (error) {
		console.error(error.message);
		process.exit(1);
	}
	const all = total(rows);
	if (process.argv.includes('--json')) {
		console.log(JSON.stringify({engine: gate, rows, total: all, onlyControl: alone.control,
			onlyTreatment: alone.treatment}, null, '\t'));
		return;
	}
	const tag = gate.warning ? '  [engine unverified]' : '';
	const p = value => ' p=' + (value < 0.001 ? value.toExponential(1) : value.toFixed(3));
	for (const row of rows) {
		console.log((row.name + ' ').padEnd(35) + (row.control + '/' + row.seeds).padEnd(7) + '-> ' +
			(row.treatment + '/' + row.seeds).padEnd(7) +
			(row.gained.length ? ' gained ' + row.gained.join(',') : '') +
			(row.lost.length ? ' lost ' + row.lost.join(',') : '') + p(row.p) + tag);
	}
	console.log('TOTAL'.padEnd(35) + (all.control + '/' + all.seeds).padEnd(7) + '-> ' +
		(all.treatment + '/' + all.seeds).padEnd(7) + ' gained ' + all.gained + ' lost ' + all.lost +
		' (exact McNemar)' + p(all.p) + tag);
	if (alone.control.length) console.log('only in control, not joined: ' + alone.control.join('; '));
	if (alone.treatment.length) console.log('only in treatment, not joined: ' + alone.treatment.join('; '));
}

if (require.main === module) main();

module.exports = {engineGate, pair, mcnemar, total, unmatched};
