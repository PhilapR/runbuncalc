#!/usr/bin/env node
/* eslint-env node, es6 */
'use strict';

/**
 * Two permadeath batches, paired by seed: the one scoring rule for every
 * nuzlocke bar (scenarios/measurements/nuz-*-bar.md).
 *
 *   node scripts/nuz-compare.js CONTROL[,CONTROL...] TREATMENT[,TREATMENT...]
 *
 * Each name is a folder under ui-playthrough-out/runs (a run-batch label); a
 * comma joins the halves of a batch run in two (nuzd0923,nuzd0923b). The
 * measure is fights won before the wipe. The rule: over the seeds where the
 * arms differ, the treatment must be better on more of them than worse, by a
 * one-sided sign test at p < 0.05; ties are left out, not counted against.
 * The first two bars counted ties against the treatment; from 2026-09-23
 * every bar uses this rule, so it lives here and not in a scratchpad.
 * Also printed, for the bars that require it: bodies lost per fight won, and
 * any run whose audit failed (an audit failure voids its seed).
 */
const fs = require('node:fs');
const path = require('node:path');

const RUNS = path.join(__dirname, '..', 'ui-playthrough-out', 'runs');

/** seed -> {won, lost, audit} for every run in the named batches. */
function batch(names) {
	const out = {};
	for (const name of names.split(',')) {
		const dir = path.join(RUNS, name);
		for (const file of fs.readdirSync(dir).filter(entry => /^run-\d+\.json$/.test(entry))) {
			const row = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
			out[file.match(/\d+/)[0]] = {won: row.ledger.filter(entry => entry.result === 'win').length,
				lost: row.bodiesLost || 0, audit: row.audit ? row.audit.ok : null, stopped: row.stopped || null};
		}
	}
	return out;
}

/** One-sided sign test: P(at least `better` of `n` fair coin flips). */
function signTest(better, n) {
	let p = 0;
	const choose = (total, k) => {
		let value = 1;
		for (let i = 1; i <= k; i++) value = value * (total - k + i) / i;
		return value;
	};
	for (let k = better; k <= n; k++) p += choose(n, k) / 2 ** n;
	return p;
}

function compare(control, treatment) {
	const seeds = Object.keys(control).filter(seed => treatment[seed]).sort();
	const rows = seeds.map(seed => ({seed, control: control[seed], treatment: treatment[seed],
		delta: treatment[seed].won - control[seed].won}));
	const valid = rows.filter(row => row.control.audit !== false && row.treatment.audit !== false);
	const better = valid.filter(row => row.delta > 0).length;
	const worse = valid.filter(row => row.delta < 0).length;
	const median = values => {
		const sorted = values.slice().sort((a, b) => a - b);
		return sorted.length ? (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2 : null;
	};
	const perWin = side => {
		const won = valid.reduce((sum, row) => sum + row[side].won, 0);
		return won ? valid.reduce((sum, row) => sum + row[side].lost, 0) / won : null;
	};
	return {rows, paired: valid.length, voided: rows.length - valid.length, better, worse, tied: valid.length - better - worse,
		p: signTest(better, better + worse), medianControl: median(valid.map(row => row.control.won)),
		medianTreatment: median(valid.map(row => row.treatment.won)), lostPerWinControl: perWin('control'),
		lostPerWinTreatment: perWin('treatment')};
}

function main() {
	const args = process.argv.slice(2);
	if (args.length !== 2) {
		console.error('usage: node scripts/nuz-compare.js CONTROL[,CONTROL] TREATMENT[,TREATMENT]');
		process.exit(2);
	}
	const result = compare(batch(args[0]), batch(args[1]));
	for (const row of result.rows) {
		console.log(row.seed + '  ' + row.control.won + ' -> ' + row.treatment.won + '  ' +
			(row.delta > 0 ? '+' + row.delta : String(row.delta)) +
			(row.control.audit === false || row.treatment.audit === false ? '  AUDIT FAILED: voided' : ''));
	}
	console.log('paired ' + result.paired + (result.voided ? ' (' + result.voided + ' voided)' : '') + ': better ' + result.better +
		', worse ' + result.worse + ', tied ' + result.tied + ' | one-sided sign test over the non-tied p = ' + result.p.toFixed(4) +
		(result.better > result.worse && result.p < 0.05 ? '  PASSES the primary' : '  does not pass the primary'));
	console.log('median fights won ' + result.medianControl + ' -> ' + result.medianTreatment + ' | bodies lost per fight won ' +
		(result.lostPerWinControl === null ? '-' : result.lostPerWinControl.toFixed(2)) + ' -> ' +
		(result.lostPerWinTreatment === null ? '-' : result.lostPerWinTreatment.toFixed(2)));
}

if (require.main === module) main();

module.exports = {compare, signTest, batch};
