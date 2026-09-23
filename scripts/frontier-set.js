#!/usr/bin/env node
/* eslint-env node, es6 */
'use strict';

/**
 * The frontier set: the fights the full runs actually stall on.
 *
 *   node scripts/frontier-set.js [--min-losses=3] [--seeds=10] [--write]
 *
 * Every other scenario set was picked from archives between 2026-08-28 and
 * 2026-09-18, singles only, and none reaches past Norman. The goal stalls
 * after him — Archie, Shelly, Sidney, Glacia, Wallace, and the doubles — so
 * the fast loop could not measure a change where it counts. This set is
 * picked from the stored full runs by a fixed rule, from counts alone:
 *
 *   a fight a run lost at least --min-losses times, one scenario per
 *   (run, fight), at most --per-trainer runs per trainer (those that lost
 *   it most), played from the document the run fielded: the log up to
 *   that fight's `beat`, the whole log when the run stopped there unbeaten,
 *   or just after the last fight it won before the wall when it skipped it.
 *
 * The losses are a pointer to the position, not a measurement: they were
 * counted on whatever engine that run played, and the set is measured again
 * on today's. A source is used only if its whole log replays byte-identical
 * under today's rules and order scale; one that does not is named and left
 * out. Each source is banked once, gzipped, in fixtures/banked-runs/frontier/
 * (the log is 90% of a document and the set shares sources), and a scenario
 * names its source and the log position `at` it is cut to.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const battery = require('./scenario-battery.js');

const replay = battery.replayTo;

const ROOT = path.resolve(__dirname, '..');
const RUNS = path.join(ROOT, 'ui-playthrough-out', 'runs');
const SHELF = path.join(ROOT, 'fixtures', 'banked-runs', 'frontier');
const MANIFEST = path.join(ROOT, 'scenarios', 'frontier.json');

function flag(name, fallback) {
	const hit = process.argv.find(arg => arg.startsWith('--' + name + '='));
	if (hit) return hit.slice(name.length + 3);
	return process.argv.includes('--' + name) ? '1' : fallback;
}

/** Every stored run with a ledger and a document: [{dir, seed, file, report}]. */
function storedRuns(base) {
	const found = [];
	if (!fs.existsSync(base)) return found;
	for (const dir of fs.readdirSync(base).sort()) {
		const folder = path.join(base, dir);
		if (!fs.statSync(folder).isDirectory()) continue;
		for (const name of fs.readdirSync(folder).filter(file => /^run-\d+\.json$/.test(file)).sort()) {
			let report;
			try {
				report = JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8'));
			} catch (error) {
				continue;
			}
			if (Array.isArray(report.ledger) && report.doc && Array.isArray(report.doc.log)) {
				found.push({dir, seed: name.match(/\d+/)[0], file: path.join(folder, name), report});
			}
		}
	}
	return found;
}

/**
 * The walls of one run: [{trainer, order, losses, won, at}], in ledger order.
 * `at` is the log length before that fight's `beat`. An unbeaten wall that
 * ended the run is cut at the whole log; one the run skipped (--skip-walls)
 * and walked past is cut just after the last fight it won before the first
 * attempt, since the preparation logged after that may be for later fights.
 */
function wallsOf(report, minLosses) {
	const byTrainer = new Map();
	report.ledger.forEach((row, index) => {
		const wall = byTrainer.get(row.trainer) ||
			{trainer: row.trainer, order: row.order, losses: 0, won: false, first: index};
		if (row.result === 'win') wall.won = true;
		else wall.losses += 1;
		byTrainer.set(row.trainer, wall);
	});
	const last = report.ledger.length ? report.ledger[report.ledger.length - 1].trainer : null;
	const log = report.doc.log;
	const beatAt = trainer => log.findIndex(entry => entry.command.kind === 'beat' && entry.command.trainer === trainer);
	const walls = [];
	for (const wall of byTrainer.values()) {
		if (wall.losses < minLosses) continue;
		if (wall.won) {
			wall.at = beatAt(wall.trainer);
		} else if (wall.trainer === last) {
			wall.at = log.length;
		} else {
			const before = report.ledger.slice(0, wall.first).filter(row => row.result === 'win').pop();
			wall.at = before ? beatAt(before.trainer) + 1 : -1;
			wall.skipped = true;
		}
		if (wall.at < 0) continue;
		delete wall.first;
		walls.push(wall);
	}
	return walls;
}

/** At most `cap` runs per trainer, the ones that lost it most; ties by name. */
function capPerTrainer(scenarios, cap) {
	const kept = [];
	const byTrainer = new Map();
	for (const scenario of scenarios) {
		byTrainer.set(scenario.trainer, (byTrainer.get(scenario.trainer) || []).concat([scenario]));
	}
	for (const list of byTrainer.values()) {
		kept.push(...list.sort((a, b) => b.lost - a.lost || (a.name < b.name ? -1 : 1)).slice(0, cap));
	}
	return kept;
}

function build(options) {
	const minLosses = options.minLosses;
	const seeds = options.seeds;
	const scale = require('../profiles').getProfile('run-and-bun').encounters.ORDER_SCALE.id;
	const sources = new Map();
	const refused = [];
	const scenarios = [];
	for (const stored of storedRuns(options.runs || RUNS)) {
		const walls = wallsOf(stored.report, minLosses);
		if (!walls.length) continue;
		const doc = stored.report.doc;
		const label = stored.dir + '/run-' + stored.seed;
		if (doc.orderScale !== scale) {
			refused.push({run: label, why: 'order scale ' + JSON.stringify(doc.orderScale || null) + ', not ' + scale});
			continue;
		}
		let rebuilt;
		try {
			rebuilt = replay(doc, doc.log.length);
		} catch (error) {
			refused.push({run: label, why: 'replay refused: ' + error.message.slice(0, 160)});
			continue;
		}
		if (JSON.stringify(rebuilt) !== JSON.stringify(doc)) {
			refused.push({run: label, why: 'replay differs from the stored document'});
			continue;
		}
		// Identical documents in two folders (a resumed leg) are one source.
		const body = JSON.stringify(doc);
		const hash = crypto.createHash('sha256').update(body).digest('hex');
		if (!sources.has(hash)) {
			sources.set(hash, {file: path.join('fixtures', 'banked-runs', 'frontier', stored.dir + '-' + stored.seed + '.run.json.gz'),
				from: path.relative(ROOT, stored.file), sha256: hash, body, engine: engineOf(stored.report)});
		}
		const source = sources.get(hash);
		for (const wall of walls) {
			const name = wall.trainer + ' @' + wall.order + ' [' + label + ']';
			if (scenarios.some(scenario => scenario.name === name)) continue;
			scenarios.push(Object.assign({name, report: source.file, at: wall.at, trainer: wall.trainer, seeds,
				lost: wall.losses, beaten: wall.won}, wall.skipped ? {skipped: true} : {}));
		}
	}
	const used = new Set();
	const kept = capPerTrainer(scenarios, options.perTrainer);
	for (const scenario of kept) used.add(scenario.report);
	scenarios.length = 0;
	scenarios.push(...kept);
	scenarios.sort((a, b) => fightOrder(a) - fightOrder(b) || (a.name < b.name ? -1 : 1));
	return {scenarios, sources: [...sources.values()].filter(source => used.has(source.file)), refused, minLosses,
		perTrainer: options.perTrainer};
}

function fightOrder(scenario) {
	return Number(scenario.name.match(/ @(\d+) /)[1]);
}

function engineOf(report) {
	const legs = report.legs || [];
	const stamps = [...new Set(legs.map(leg => leg.engine && leg.engine.id).filter(Boolean))];
	return stamps.length ? stamps : null;
}

function write(built) {
	fs.mkdirSync(SHELF, {recursive: true});
	for (const source of built.sources) {
		fs.writeFileSync(path.join(ROOT, source.file), zlib.gzipSync(Buffer.from(source.body), {level: 9, mtime: 0}));
	}
	const manifest = {
		comment: 'The frontier set: the fights the full runs stall on. Built by scripts/frontier-set.js by a fixed ' +
			'rule, from counts alone: a fight a stored run lost at least ' + built.minLosses + ' times, one scenario ' +
			'per (run, fight), at most ' + built.perTrainer + ' runs per trainer (those that lost it most), played from the document the run fielded (the log up to that fight\'s beat, or the ' +
			'whole log when the run stopped there unbeaten, or just after the last fight won before it when the ' +
			'run skipped it). `lost` counts losses on that run\'s own engine and ' +
			'is a pointer, not a measurement. Doubles are included. Sources whose logs do not replay byte-identical ' +
			'under today\'s rules and order scale are left out and named in `refused`.',
		generator: 'scripts/frontier-set.js',
		generatorArgs: ['--min-losses=' + built.minLosses, '--per-trainer=' + built.perTrainer, '--write'],
		sources: built.sources.map(source => ({file: source.file, from: source.from, sha256: source.sha256, engine: source.engine})),
		refused: built.refused,
		scenarios: built.scenarios,
	};
	fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, '\t') + '\n');
}

function main() {
	const built = build({minLosses: Number(flag('min-losses', '3')), seeds: Number(flag('seeds', '10')),
		perTrainer: Number(flag('per-trainer', '3'))});
	for (const scenario of built.scenarios) {
		console.log(String(fightOrder(scenario)).padStart(5) + '  lost ' + String(scenario.lost).padStart(2) +
			(scenario.beaten ? '  ' : scenario.skipped ? ' S' : ' U') + '  ' + scenario.name);
	}
	for (const refusal of built.refused) console.log('refused ' + refusal.run + ': ' + refusal.why);
	console.log(built.scenarios.length + ' scenarios from ' + built.sources.length + ' sources, ' +
		built.refused.length + ' runs refused');
	if (flag('write', '0') === '1') {
		write(built);
		console.log('wrote ' + path.relative(ROOT, MANIFEST) + ' and ' + built.sources.length + ' sources');
	}
}

if (require.main === module) main();

module.exports = {build, wallsOf, capPerTrainer};
