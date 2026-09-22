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

/** The per-scenario join. Seeds only one arm played are left out, and counted. */
function pair(control, treatment) {
	const out = [];
	for (const c of control.results || []) {
		const t = (treatment.results || []).find(entry => entry.name === c.name);
		if (!t) continue;
		const bySeed = new Map((t.rows || []).map(row => [row.seed, row]));
		const joined = (c.rows || []).filter(row => bySeed.has(row.seed))
			.map(row => ({seed: row.seed, control: row.result, treatment: bySeed.get(row.seed).result}));
		const won = side => joined.filter(row => row[side] === 'win').length;
		out.push({name: c.name, seeds: joined.length, control: won('control'), treatment: won('treatment'),
			gained: joined.filter(row => row.control !== 'win' && row.treatment === 'win').map(row => row.seed),
			lost: joined.filter(row => row.control === 'win' && row.treatment !== 'win').map(row => row.seed),
			unpaired: (c.rows || []).length + (t.rows || []).length - 2 * joined.length});
	}
	return out;
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
	const rows = pair(control, treatment);
	if (process.argv.includes('--json')) {
		console.log(JSON.stringify({engine: gate, rows}, null, '\t'));
		return;
	}
	const tag = gate.warning ? '  [engine unverified]' : '';
	for (const row of rows) {
		console.log(row.name.padEnd(34) + (row.control + '/' + row.seeds).padEnd(7) + '-> ' +
			(row.treatment + '/' + row.seeds).padEnd(7) +
			(row.gained.length ? ' gained ' + row.gained.join(',') : '') +
			(row.lost.length ? ' lost ' + row.lost.join(',') : '') + tag);
	}
}

if (require.main === module) main();

module.exports = {engineGate, pair};
