#!/usr/bin/env node
/* eslint-env node, es6 */
'use strict';

/**
 * Archive sweep: which banked fights can a policy change actually move?
 *
 * A scenario the policy always wins, or always loses to, spends every seed
 * confirming what the last batch already said. battery3 spent 130 seeds a
 * batch that way. The information in a fight is in its variance — p(1-p) is
 * zero at 0/20 and 20/20 and largest at 10/20 — so this plays every banked
 * report against the next few trainers on its own road, a handful of seeds
 * each, and ranks the fights by it.
 *
 * It is ADVISORY. battery.json stays hand-curated: a fight at the floor can
 * still be the one a treatment targets (the leaders are), and a fight at the
 * ceiling is still a regression canary. This only says where the variance
 * is; the operator decides what the battery is for.
 *
 *   node scripts/battery-sweep.js --ahead=3 --seeds=5 --label=sweep1
 *
 * Doubles are skipped (operator ruling 2026-08-28), and a report whose orders
 * sit on a stale scale is skipped by requireScale's refusal, with the reason.
 */

const fs = require('node:fs');
const path = require('node:path');

const run = require('../lib/run.js');
const battery = require('./scenario-battery.js');

function flag(name, fallback) {
	const hit = process.argv.find(arg => arg.startsWith('--' + name + '='));
	return hit ? hit.split('=').slice(1).join('=') : fallback;
}

function main() {
	const policy = require('./ui-playthrough.js');
	battery.refuseUnread(policy, ['dir', 'ahead', 'seeds', 'label']);
	const dir = flag('dir', 'ui-playthrough-out');
	const ahead = Number(flag('ahead', '3'));
	const seeds = Number(flag('seeds', '5'));
	const label = flag('label', 'sweep');
	const reports = fs.readdirSync(dir)
		.filter(name => /^report-.*\.json$/.test(name)).sort();
	const rows = [];
	const skipped = [];
	for (const name of reports) {
		const file = path.join(dir, name);
		let doc;
		try {
			doc = battery.requireScale(JSON.parse(fs.readFileSync(file, 'utf8')).run);
		} catch (error) {
			skipped.push({report: name, why: error.message});
			continue;
		}
		const road = run.upcoming(doc, ahead);
		const fights = (Array.isArray(road) ? road : road.fights) || [];
		for (const fight of fights) {
			if (fight.isDouble) continue;
			const row = {report: file, trainer: fight.trainer, position: doc.position,
				order: fight.order, seeds, wins: 0, stuck: 0, turns: 0};
			try {
				for (let seed = 1; seed <= seeds; seed++) {
					const played = battery.playScenario(policy, doc, fight.trainer, seed);
					if (played.result === 'win') row.wins += 1;
					if (played.result === 'stuck') row.stuck += 1;
					row.turns += played.turns || 0;
				}
			} catch (error) {
				skipped.push({report: name, trainer: fight.trainer, why: error.message});
				continue;
			}
			const p = row.wins / seeds;
			row.variance = Math.round(p * (1 - p) * 1000) / 1000;
			rows.push(row);
		}
		process.stderr.write('.');
	}
	rows.sort((a, b) => b.variance - a.variance || a.order - b.order);
	const out = path.join(dir, label + '-sweep.json');
	fs.writeFileSync(out, JSON.stringify({label, argv: process.argv.slice(2),
		reports: reports.length, rows, skipped}, null, '\t'));
	console.log('\n' + rows.length + ' fights from ' + reports.length + ' reports, ' +
		skipped.length + ' skipped; wrote ' + out);
}

if (require.main === module) main();
