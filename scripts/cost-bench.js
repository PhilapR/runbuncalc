#!/usr/bin/env node
/* eslint-env node, es6 */
'use strict';

/**
 * What a fight COSTS, measured in work rather than in seconds.
 *
 * `scripts/ab.js` answers "is this policy better than that one" and
 * `--measure` answers "how good is the product today". Neither answers the
 * question that opened this file: where does the time go, and did an
 * optimisation move it. Three optimisations in one day were argued from a
 * profile nobody had run, and one of them turned out to be free work on a free
 * stage.
 *
 * Counted in CONSTRUCTED CALCULATOR OBJECTS first and wall clock second, for
 * the reason `tests/adjudication_cost.test.js` gives: this repository shares a
 * runner, three timing gates flaked on machine load in one session, and an
 * object is exact and reproducible. Seconds are recorded beside it because a
 * player feels seconds, but the object count is the number that means
 * something a week later.
 *
 * The workload is a REAL run document out of `ui-playthrough-out/`, not a
 * constructed box. A box of identical early-route Pokemon answers a different
 * question than a mid-run party does — it collapses the ranker's shortlist to
 * one six and wipes to every trainer, and two proposals died on that
 * difference. Positions are sampled across the run rather than taken from
 * whichever file sorted first.
 *
 * Usage:
 *   node scripts/cost-bench.js --label=cost-today
 *   node scripts/cost-bench.js --label=x --positions=73,206 --arms=baseline,facts-cache
 *
 * Writes `ui-playthrough-out/<label>-cost.json`, which
 * `experiments/ingest.py` loads. Nothing is recomputed at ingest: what this
 * records is what MLflow shows.
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

// The calculator classes are counted by subclassing them BEFORE the engine is
// required, so the classes the engine closes over are the counted ones. Any
// require of `lib/run` above this line silently measures nothing.
const calcPath = require.resolve('@smogon/calc', {paths: [path.join(ROOT, 'ai')]});
const Calc = require(calcPath);
let moves = 0;
let pokemon = 0;
class CountedMove extends Calc.Move {
	constructor(...args) { super(...args); moves += 1; }
}
class CountedPokemon extends Calc.Pokemon {
	constructor(...args) { super(...args); pokemon += 1; }
}
Object.defineProperty(Calc, 'Move', {value: CountedMove, writable: true});
Object.defineProperty(Calc, 'Pokemon', {value: CountedPokemon, writable: true});

const run = require(path.join(ROOT, 'lib/run'));
const adapter = require(path.join(ROOT, 'ai/dist/calc-adapter.js'));
const driver = require(path.join(ROOT, 'lib/battle-driver'));

/**
 * The facts-level memo, as an ARM rather than as a change to the engine.
 *
 * Measured 3.04x fewer objects and 2.59x less wall clock over six real states,
 * with byte-identical playbooks. It is not shipped, and benchmarking it here
 * is how it earns the right to be: a lever nobody can price is a lever nobody
 * should pull. The key is the whole serialized input, which is sound by
 * construction and deliberately naive — the point of the measurement is that
 * the placement pays even when the key does not.
 */
const realFacts = adapter.calculateActionFacts;
let factsCache = null;
Object.defineProperty(adapter, 'calculateActionFacts', {
	value: function (state, action) {
		if (!factsCache) return realFacts.apply(this, arguments);
		let key;
		try {
			key = JSON.stringify(state) + '|' + JSON.stringify(action) +
				'|' + JSON.stringify(arguments[2] || null);
		} catch (error) {
			return realFacts.apply(this, arguments);
		}
		if (factsCache.has(key)) return factsCache.get(key);
		const facts = realFacts.apply(this, arguments);
		factsCache.set(key, facts);
		return facts;
	},
	writable: true, configurable: true,
});

/** Real run documents, newest position last, one per band across the run. */
function realStates(wanted) {
	if (!fs.existsSync(OUT)) return [];
	const docs = [];
	for (const file of fs.readdirSync(OUT)) {
		if (!file.endsWith('.json')) continue;
		let parsed;
		try {
			parsed = JSON.parse(fs.readFileSync(path.join(OUT, file), 'utf8'));
		} catch (error) { continue; }
		const doc = parsed && parsed.run;
		if (!doc || !Array.isArray(doc.box) || !Array.isArray(doc.party)) continue;
		if (!doc.party.length || typeof doc.position !== 'number') continue;
		docs.push({file, doc});
	}
	docs.sort((a, b) => a.doc.position - b.doc.position);
	if (wanted.length) {
		return wanted.map(position => docs.find(entry => entry.doc.position === position))
			.filter(Boolean);
	}
	const seen = new Set();
	const spread = [];
	for (const entry of docs) {
		const band = Math.floor(entry.doc.position / 40);
		if (seen.has(band)) continue;
		seen.add(band);
		spread.push(entry);
	}
	return spread;
}

/**
 * Peak resident memory while some work runs.
 *
 * A cache is a memory-for-compute trade and this benchmark spent its first
 * version measuring only one side of it. `process.memoryUsage()` is a point
 * reading, so the peak needs sampling: 25ms is fine against stages that take
 * hundreds of milliseconds, and it costs a syscall.
 */
function samplePeakRss() {
	let peak = process.memoryUsage().rss;
	const timer = setInterval(() => {
		const now = process.memoryUsage().rss;
		if (now > peak) peak = now;
	}, 25);
	timer.unref();
	return function stop() {
		clearInterval(timer);
		const now = process.memoryUsage().rss;
		return Math.max(peak, now);
	};
}

// One origin for the whole process, so every stage can say WHEN it ran and
// not merely how long it took. That turns a list of durations into a span
// tree MLflow can render as a trace.
const ORIGIN = process.hrtime.bigint();

/**
 * The span recorder, and why it goes deeper than the three stages.
 *
 * The first version recorded boxMatrix, rank and playbook and stopped. That
 * trace was a redrawing of three numbers the metrics already carried, and it
 * hid the only thing a hierarchy is good for: `playbook` is not one unit of
 * work, it is a power set of assignment variants, each of which PLAYS the
 * fight, plus a final line that plays it twelve more times. Roughly fifty
 * playthroughs behind one bar.
 *
 * So `adjudicate` and `playbook` are wrapped at the driver, and every call
 * becomes a span under whichever stage was running. Sixteen sibling variant
 * spans is the shape of the cost, and it is visible rather than asserted.
 */
let spans = [];
let spanStack = [];
let spanSeq = 0;

function withSpan(name, attributes, work) {
	const id = `s${spanSeq++}`;
	const parent = spanStack.length ? spanStack[spanStack.length - 1] : null;
	const objectsBefore = moves + pokemon;
	const started = process.hrtime.bigint();
	const record = {
		id, parentId: parent, name,
		startOffsetMs: Number(started - ORIGIN) / 1e6,
		attributes: attributes || {},
	};
	spans.push(record);
	spanStack.push(id);
	try {
		return work();
	} finally {
		spanStack.pop();
		const ended = process.hrtime.bigint();
		record.endOffsetMs = Number(ended - ORIGIN) / 1e6;
		record.ms = Number(ended - started) / 1e6;
		// Objects built anywhere inside this span, children included. A parent
		// therefore reads as the total it is responsible for, which is the
		// question "where did the work go" rather than "who allocated it".
		record.objects = (moves + pokemon) - objectsBefore;
	}
}

// `lib/run.js` requires the driver lazily inside its functions, and the module
// cache means these wrappers are the ones it reaches.
const realAdjudicate = driver.adjudicate;
const realPlaybook = driver.playbook;
driver.adjudicate = function (doc, trainerName, options) {
	const rollouts = (options && options.rollouts) !== undefined ? options.rollouts : 12;
	return withSpan('adjudicate', {rollouts, trainer: trainerName},
		() => realAdjudicate.apply(this, arguments));
};
driver.playbook = function (doc, trainerName, options) {
	const rollouts = (options && options.rollouts) !== undefined ? options.rollouts : 12;
	return withSpan('playbook-line', {rollouts, trainer: trainerName},
		() => realPlaybook.apply(this, arguments));
};

function measure(label, work) {
	moves = 0;
	pokemon = 0;
	const stopRss = samplePeakRss();
	const heapBefore = process.memoryUsage().heapUsed;
	const started = process.hrtime.bigint();
	// A stage is a span too, so the adjudications the driver runs inside it
	// land as its children rather than as orphans at the root.
	const value = withSpan(label, {stage: label}, work);
	const ended = process.hrtime.bigint();
	return {
		stage: label,
		objects: moves + pokemon,
		ms: Number(ended - started) / 1e6,
		startOffsetMs: Number(started - ORIGIN) / 1e6,
		endOffsetMs: Number(ended - ORIGIN) / 1e6,
		peakRss: stopRss(),
		heapGrowth: process.memoryUsage().heapUsed - heapBefore,
		value,
	};
}

/** One state, one arm: the stages a player actually waits for. */
function stagesFor(doc, trainer, arm) {
	factsCache = arm === 'facts-cache' ? new Map() : null;
	spans = [];
	spanStack = [];
	spanSeq = 0;
	const grid = measure('boxMatrix', () => run.boxMatrix(doc, trainer));
	const ranked = measure('rank', () => run.rankParties(doc, trainer));
	const book = measure('playbook', () => run.fightPlaybook(doc, trainer));
	// Read the cache BEFORE dropping it: its size is the price of the speedup,
	// and the first version of this benchmark never charged for it.
	const cacheEntries = factsCache ? factsCache.size : 0;
	let cacheBytes = 0;
	if (factsCache) {
		// The keys are the serialized inputs, which dominate; two bytes a
		// character is the V8 string cost, and the values are shared references
		// to objects the run built anyway.
		for (const key of factsCache.keys()) cacheBytes += key.length * 2;
	}
	factsCache = null;
	return {
		stages: [grid, ranked, book].map(entry => ({
			stage: entry.stage, objects: entry.objects, ms: entry.ms,
			startOffsetMs: entry.startOffsetMs, endOffsetMs: entry.endOffsetMs,
			peakRss: entry.peakRss, heapGrowth: entry.heapGrowth,
		})),
		// The nested truth behind those three bars: every adjudication the
		// driver ran, under the stage that ran it.
		spans: spans.slice(),
		objects: grid.objects + ranked.objects + book.objects,
		ms: grid.ms + ranked.ms + book.ms,
		peakRss: Math.max(grid.peakRss, ranked.peakRss, book.peakRss),
		cacheEntries,
		cacheBytes,
		// The answer itself, so an arm that got cheap by getting wrong is
		// visible rather than merely fast.
		fingerprint: JSON.stringify({
			assignments: book.value.assignments.map(a => a.answeredBy),
			pWin: book.value.odds ? book.value.odds.pWin : null,
			eDeaths: book.value.odds ? book.value.odds.eDeaths : null,
			top: ranked.value.parties[0].members.map(m => m.id).sort(),
			score: ranked.value.parties[0].score,
		}),
		explored: book.value.explored,
		variantRollouts: book.value.variantRollouts,
		shortlist: ranked.value.shortlist,
		boxSize: ranked.value.boxSize,
		combinations: ranked.value.combinations,
	};
}

/**
 * The ranker's cut, priced where it actually bites.
 *
 * On a normal box the enumeration is free — it reads cached grid cells, and
 * 78x the combinations built FEWER objects. The cut exists for the tail, so
 * the tail is what this measures: a box no nuzlocke reaches and a level-caps
 * run that rerolls areas does.
 */
function tailArm(size, trainer) {
	const IVS = {hp: 20, atk: 18, def: 19, spa: 22, spd: 17, spe: 21};
	let doc = run.createRun({name: 'tail', now: 't0', levelCap: 'none'});
	for (let i = 0; i < size; i++) {
		doc = run.apply(doc, {kind: 'catch', species: 'Poochyena', level: 30, ivs: IVS});
	}
	const cut = measure('rank-cut', () => run.rankParties(doc, trainer, {rollouts: 0}));
	let whole = null;
	try {
		whole = measure('rank-whole-box',
			() => run.rankParties(doc, trainer, {rollouts: 0, exhaustive: true}));
	} catch (error) {
		// The ceiling refusing is the result, not a failure: it is what stops
		// a box of this size from disappearing for three minutes.
		whole = {stage: 'rank-whole-box', objects: 0, ms: 0, refused: error.message};
	}
	return {
		boxSize: size,
		cut: {objects: cut.objects, ms: cut.ms, combinations: cut.value.combinations,
			candidates: cut.value.shortlist.candidates},
		wholeBox: {objects: whole.objects, ms: whole.ms,
			...(whole.refused ? {refused: whole.refused} : {})},
	};
}

function main() {
	const label = flag('label', 'cost');
	// `''.split(',')` is `['']` and `Number('')` is 0, so an unset flag asked
	// for position zero and matched nothing. Drop the empty pieces first.
	const positions = flag('positions', '').split(',')
		.map(value => value.trim()).filter(Boolean)
		.map(Number).filter(value => Number.isFinite(value));
	const arms = flag('arms', 'baseline,facts-cache').split(',').map(a => a.trim());
	const tailSize = Number(flag('tail-box', 76));

	const states = realStates(positions);
	if (!states.length) {
		console.error('cost-bench: no real run documents in ui-playthrough-out/. ' +
			'This benchmark refuses to price a constructed box, because two ' +
			'proposals already died on the difference.');
		process.exit(1);
	}

	const revision = git(['rev-parse', 'HEAD']);
	const dirty = !!git(['status', '--porcelain']);
	const results = [];
	for (const entry of states) {
		const doc = entry.doc;
		let ahead;
		try { ahead = run.upcoming(doc, 1); } catch (error) { continue; }
		if (!ahead.length) continue;
		const trainer = ahead[0].trainer;
		const perArm = {};
		for (const arm of arms) {
			try {
				perArm[arm] = stagesFor(doc, trainer, arm);
			} catch (error) {
				perArm[arm] = {error: error.message};
			}
		}
		const fingerprints = Object.values(perArm)
			.map(entry => entry.fingerprint).filter(Boolean);
		results.push({
			source: entry.file, position: doc.position, trainer,
			arms: perArm,
			// Every arm must answer the same question the same way. An arm that
			// disagrees is not an optimisation, whatever it did to the clock.
			agree: fingerprints.length > 1 ?
				fingerprints.every(value => value === fingerprints[0]) : null,
		});
		const base = perArm[arms[0]];
		if (base && base.objects) {
			console.log(`  #${String(doc.position).padStart(3)} ${trainer.slice(0, 24).padEnd(26)}` +
				arms.map(arm => `${arm} ${(perArm[arm].objects / 1000).toFixed(0)}k`).join('  ') +
				(results[results.length - 1].agree === false ? '   DISAGREE' : ''));
		}
	}

	const tailTrainer = 'Leader Brawly';
	const tail = tailArm(tailSize, tailTrainer);
	console.log(`  tail: box ${tail.boxSize} cut to ${tail.cut.candidates} candidates, ` +
		`${tail.cut.combinations.toLocaleString('en-US')} combinations, ${tail.cut.ms.toFixed(0)}ms` +
		(tail.wholeBox.refused ? '  (whole box refused, which is the point)' : ''));

	const payload = {
		label, kind: 'cost',
		recordedAt: new Date().toISOString(),
		revision, dirty,
		node: process.version,
		arms, results, tail: {trainer: tailTrainer, ...tail},
	};
	fs.mkdirSync(OUT, {recursive: true});
	const file = path.join(OUT, `${label}-cost.json`);
	fs.writeFileSync(file, JSON.stringify(payload, null, '\t') + '\n');
	console.log(`\nwrote ${path.relative(ROOT, file)}`);
	if (dirty) {
		console.log('NOTE: the tree was dirty, so this run cannot name the code it ran.');
	}
}

if (require.main === module) main();

module.exports = {realStates, stagesFor, tailArm};
