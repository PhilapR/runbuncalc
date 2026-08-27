#!/usr/bin/env node
/* eslint-env node, es6 */
'use strict';

/**
 * Does the plan predict the fight?
 *
 * `scripts/ab.js --measure` answers how FAR a run gets and `scripts/cost-bench.js`
 * answers what a fight costs. Neither asks the question the planning surface
 * exists to answer: when Run & Bun says a fight is clean, is it, and when it says
 * someone dies, does someone die.
 *
 * That is a calibration question, and calibration is the one property a forecast
 * cannot be talked into. A verdict that is right 100% of the time on 13% of
 * fights and a coin flip on the rest is a different product from one that is
 * right 80% of the time on everything, and the reach number cannot tell them
 * apart.
 *
 * Reads what the runs already recorded — every report carries `detail[]` with a
 * `plan.verdict` and an `outcome` per fight — and recomputes nothing about the
 * game. The verdict strings are parsed rather than re-derived, because the
 * string is what a player actually read.
 *
 * Usage:
 *   node scripts/plan-calibration.js --label=post-perf
 *   node scripts/plan-calibration.js --label=post-perf --match=post-perf
 *
 * Writes `ui-playthrough-out/<label>-calibration.json` for `experiments/ingest.py`.
 */

const fs = require('node:fs');
const path = require('node:path');
const execFileSync = require('node:child_process').execFileSync;

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'ui-playthrough-out');

function flag(name, fallback) {
	const hit = process.argv.slice(2).find(arg => arg.startsWith(`--${name}=`));
	return hit === undefined ? fallback : hit.slice(name.length + 3);
}

function git(args) {
	try {
		return execFileSync('git', args, {cwd: ROOT, encoding: 'utf8'}).trim();
	} catch (error) {
		return null;
	}
}

/**
 * What the verdict CLAIMED, read off the sentence a player was shown.
 *
 * Parsed, not recomputed. If the panel and this disagree the panel is right by
 * definition — it is the artifact the claim was made in — so this reads the
 * string rather than going back to the receipt behind it.
 */
function readVerdict(verdict) {
	const text = String(verdict || '');
	if (!text) return null;
	const clean = /samples clean, none of them lost anyone/.test(text);
	const loses = text.match(/loses (\d+) Pokemon/);
	const decided = text.match(/decided by ([\d.]+)/);
	const contested = text.match(/contested by ([\d.]+)/);
	return {
		clean,
		predictedLosses: loses ? Number(loses[1]) : (clean ? 0 : null),
		margin: decided ? Number(decided[1]) : contested ? Number(contested[1]) : null,
		stance: decided ? 'decided' : contested ? 'contested' : 'unstated',
	};
}

function main() {
	const label = flag('label', 'calibration');
	const match = flag('match', label);
	if (!fs.existsSync(OUT)) {
		console.error('plan-calibration: no ui-playthrough-out/ to read');
		process.exit(1);
	}

	const files = fs.readdirSync(OUT)
		.filter(name => name.startsWith('report-') && name.endsWith('.json'))
		.filter(name => name.includes(match));
	if (!files.length) {
		console.error(`plan-calibration: no reports matching ${JSON.stringify(match)}`);
		process.exit(1);
	}

	let fights = 0;
	let planned = 0;
	const byLosses = new Map();
	const byLossesSafe = new Map();
	const byStance = new Map();
	const revisions = new Set();
	const perFight = [];
	const bump = (map, key, won) => {
		const cell = map.get(key) || {won: 0, lost: 0};
		if (won) cell.won += 1; else cell.lost += 1;
		map.set(key, cell);
	};

	// A trainer whose set the fair-dice sampler is KNOWN blind to. The vendor
	// provider's bundle carries no HP-threshold power scaling — "Reversal"
	// appears once, as a move-table name — while the engine that plays the
	// fight implements it (calc gen789 case 'Reversal'). So a sash or pinch
	// berry plus Reversal/Flail/Endeavor is a threat the samples under-price
	// structurally: Battle Girl Lilith's sash Mankey was forecast "worst
	// sampled branch loses 1" fourteen times and swept the party in twelve.
	// Computed from the authored run map, once per trainer.
	const planner = require(path.join(ROOT, 'lib', 'planner'));
	const THRESHOLD_MOVES = ['Reversal', 'Flail', 'Endeavor'];
	const ENDURING = ['Focus Sash', 'Custap Berry', 'Salac Berry'];
	const thresholdCache = new Map();
	function thresholdThreatsOf(trainer) {
		if (thresholdCache.has(trainer)) return thresholdCache.get(trainer);
		let threats = [];
		try {
			for (const mon of planner.getFight(trainer, 'run-and-bun').party || []) {
				const held = THRESHOLD_MOVES.filter(move => (mon.moves || []).includes(move));
				if (!held.length) continue;
				const endures = ENDURING.includes(mon.item) || mon.ability === 'Sturdy' ||
					(mon.moves || []).includes('Endure');
				if (endures) threats.push({species: mon.species, move: held.join('/'), holds: mon.item || mon.ability});
			}
		} catch (error) { threats = []; }
		thresholdCache.set(trainer, threats);
		return threats;
	}

	for (const name of files) {
		let report;
		try {
			report = JSON.parse(fs.readFileSync(path.join(OUT, name), 'utf8'));
		} catch (error) { continue; }
		if (report.provenance && report.provenance.revision) {
			revisions.add(String(report.provenance.revision).slice(0, 10));
		}
		(report.detail || []).forEach((fight, index) => {
			fights += 1;
			const claim = readVerdict(fight.plan && fight.plan.verdict);
			if (!claim) return;
			planned += 1;
			const won = fight.outcome === 'won';
			const threats = thresholdThreatsOf(fight.trainer);
			bump(byStance, claim.stance, won);
			if (claim.predictedLosses !== null) {
				bump(byLosses, claim.predictedLosses, won);
				// The curve the samples can honestly claim: fights with no
				// enemy set the sampler is known blind to.
				if (!threats.length) bump(byLossesSafe, claim.predictedLosses, won);
			}
			// What actually happened, counted off the transcript rather than
			// inferred from the outcome: our faints are the lines that do not
			// start with "Foe".
			const actualLosses = (fight.log || []).filter(line =>
				/fainted!$/.test(line) && !/^Foe /.test(line)).length;
			perFight.push({
				report: name, index,
				trainer: fight.trainer,
				outcome: fight.outcome,
				turns: fight.turns,
				predictedLosses: claim.predictedLosses,
				actualLosses,
				stance: claim.stance,
				margin: claim.margin,
				thresholdThreats: threats,
				verdict: String((fight.plan && fight.plan.verdict) || ''),
				timeline: fight.detail || [],
				log: fight.log || [],
			});
		});
	}

	const rate = cell => (cell.won + cell.lost ? cell.won / (cell.won + cell.lost) : null);
	const cleanCell = byLosses.get(0) || {won: 0, lost: 0};
	const toCurve = map => [...map.entries()].sort((a, b) => a[0] - b[0]).map(entry => ({
		predictedLosses: entry[0],
		won: entry[1].won,
		lost: entry[1].lost,
		n: entry[1].won + entry[1].lost,
		winRate: rate(entry[1]),
	}));
	const curve = toCurve(byLosses);
	const curveSafe = toCurve(byLossesSafe);

	const payload = {
		label, kind: 'calibration',
		recordedAt: new Date().toISOString(),
		// A calibration pooled across revisions is two products' forecasts in one
		// chart, so the set is recorded rather than assumed to be one.
		revisions: [...revisions],
		revision: revisions.size === 1 ? [...revisions][0] : null,
		reports: files.length,
		fights,
		planned,
		plannedRate: fights ? planned / fights : null,
		clean: {won: cleanCell.won, lost: cleanCell.lost,
			n: cleanCell.won + cleanCell.lost, winRate: rate(cleanCell)},
		curve,
		// The same curve restricted to fights with no threshold set on the
		// other side — the claim the sampler can honestly make. The gap
		// between the two curves is the price of the blindness, not noise.
		curveExcludingThresholdThreats: curveSafe,
		byStance: [...byStance.entries()].map(entry => ({
			stance: entry[0], won: entry[1].won, lost: entry[1].lost,
			n: entry[1].won + entry[1].lost, winRate: rate(entry[1]),
		})),
		// One record per fight: the claim, the outcome, the transcript. This
		// is what lets MLflow carry a trace and an artifact per evaluation
		// instead of a batch mean per batch. (`fights` above is the count.)
		evaluations: perFight,
	};

	fs.writeFileSync(path.join(OUT, `${label}-calibration.json`),
		JSON.stringify(payload, null, '\t') + '\n');

	console.log(`${files.length} reports · ${fights} fights · ${planned} planned ` +
		`(${(100 * payload.plannedRate).toFixed(1)}%)`);
	console.log(`  called CLEAN: ${payload.clean.n} fights, ` +
		`${payload.clean.winRate === null ? 'n/a' : (100 * payload.clean.winRate).toFixed(1) + '% won'}`);
	console.log('  predicted losses    won   lost   win rate      n   (excl. threshold sets)');
	for (const row of curve) {
		const safe = curveSafe.find(entry => entry.predictedLosses === row.predictedLosses);
		console.log('  ' + String(row.predictedLosses).padStart(14) +
			String(row.won).padStart(7) + String(row.lost).padStart(7) +
			'   ' + (100 * row.winRate).toFixed(1).padStart(5) + '%' + String(row.n).padStart(7) +
			(safe ? '   ' + (100 * safe.winRate).toFixed(1).padStart(5) + '% n=' + safe.n : '   (all threshold)'));
	}
	const mispriced = perFight.filter(fight => fight.thresholdThreats.length &&
		fight.actualLosses > (fight.predictedLosses === null ? 0 : fight.predictedLosses) + 1);
	if (mispriced.length) {
		console.log('  threshold fights where reality beat the claim by 2+: ' + mispriced.length +
			' (e.g. ' + mispriced[0].trainer + ' predicted ' + mispriced[0].predictedLosses +
			', lost ' + mispriced[0].actualLosses + ')');
	}
	if (revisions.size > 1) {
		console.log(`NOTE: ${revisions.size} revisions pooled — this is not one product's forecast.`);
	}
	console.log(`\nwrote ui-playthrough-out/${label}-calibration.json`);
	if (git(['status', '--porcelain'])) {
		console.log('NOTE: the tree is dirty, so this cannot name the code it measured.');
	}
}

if (require.main === module) main();

module.exports = {readVerdict};
