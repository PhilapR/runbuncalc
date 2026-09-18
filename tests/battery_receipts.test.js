/* eslint-env node, es6 */
'use strict';

/**
 * Gates for what a battery receipt has to say about itself.
 *
 * The audit over battery3 could not answer its own questions from the
 * receipts: which seeds stalled, what killed us, how close the losses were,
 * whether a flag that was passed ever fired. Every one of those is a
 * property of a seed, and the receipt recorded only the sum over seeds — so
 * the diagnoses in docs/IMPROVEMENT-AUDIT.md had to be re-derived by
 * instrumented probes, one lens at a time, from batches that had already
 * been run and thrown away.
 *
 * Three gates hold the repair: per-seed rows exist and agree with the
 * totals; the receipt refuses to be written when they disagree; and a
 * treatment flag that was passed and never fired refuses the tally rather
 * than reporting it as a null result.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const battery = require('../scripts/scenario-battery.js');
const policy = require('../scripts/ui-playthrough.js');
const run = require('../lib/run.js');

// The tracked banked run, as tests/battle_view.test.js reads it.
const bankedRun = () => JSON.parse(fs.readFileSync(path.join(
	__dirname, '..', 'fixtures', 'banked-runs', 'flannery-3.run.json'), 'utf8'));

/** A scenario needs a report wrapper; the fixture is the document inside one. */
function scenarioFor(seeds) {
	const doc = bankedRun();
	const ahead = run.upcoming(doc, 2);
	const fight = (Array.isArray(ahead) ? ahead : ahead.fights)[0];
	assert.ok(fight, 'the archive run must still have a road');
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'battery-')),
		'report.json');
	fs.writeFileSync(file, JSON.stringify({run: doc}));
	return {name: 'fixture', trainer: fight.trainer, report: file, seeds};
}

/** A receipt shaped like a real one, so the gate is tested on the real shape. */
function receiptOf(rows) {
	return {label: 'test', results: [{
		name: 'fixture', seeds: rows.length,
		wins: rows.filter(row => row.result === 'win').length,
		losses: rows.filter(row => row.result === 'loss').length,
		stuck: rows.filter(row => row.result === 'stuck').length,
		rows,
	}]};
}

const winRow = seed => ({seed, result: 'win', turns: 4, deaths: 0,
	killers: [], foe: {alive: 0, of: 1, hpPct: 0}, counters: {banked: 0}});

test('a played fight reports the seed, not just the tally', () => {
	const doc = bankedRun();
	const ahead = run.upcoming(doc, 2);
	const fight = (Array.isArray(ahead) ? ahead : ahead.fights)[0];
	const played = battery.playScenario(policy, doc, fight.trainer, 7);

	assert.ok(['win', 'loss'].includes(played.result));
	assert.ok(Array.isArray(played.killers), 'every death names its killer');
	// deaths is the count and killers is the list; they cannot disagree.
	assert.equal(played.killers.length, played.deaths);
	assert.ok(played.foe, 'the trainer\'s remainder decides wall from near miss');
	assert.equal(typeof played.foe.alive, 'number');
	assert.ok(played.foe.of > 0);
	assert.ok(played.counters, 'the policy memory comes back as numbers');
	assert.equal(typeof played.counters.banked, 'number');
	assert.equal(typeof played.counters.attackDrops, 'number');
});

test('every seed gets a row, and the rows carry the totals', () => {
	const scenario = scenarioFor(2);
	const out = battery.runScenario(policy, scenario);

	assert.equal(out.rows.length, 2, 'one row per seed');
	assert.deepEqual(out.rows.map(row => row.seed), [1, 2]);
	assert.equal(out.wins + out.losses + out.stuck, out.seeds);
	assert.equal(out.rows.filter(row => row.result === 'win').length, out.wins);
	// The scenario counters are the seeds' counters, summed.
	assert.equal(out.counters.banked,
		out.rows.reduce((sum, row) => sum + row.counters.banked, 0));
});

test('the receipt refuses to be written when it disagrees with its rows', () => {
	assert.ok(battery.requireWholeReceipt(receiptOf([winRow(1), winRow(2)])),
		'an honest receipt passes');

	const short = receiptOf([winRow(1), winRow(2)]);
	short.results[0].seeds = 3;
	assert.throws(() => battery.requireWholeReceipt(short), /2 rows for 3 seeds/,
		'a scenario that played fewer seeds than it claims is refused');

	const miscounted = receiptOf([winRow(1), winRow(2)]);
	miscounted.results[0].wins = 1;
	assert.throws(() => battery.requireWholeReceipt(miscounted),
		/2 winning rows but wins=1/,
		'a total that disagrees with its own rows is fiction either way');

	const repeated = receiptOf([winRow(1), winRow(1)]);
	assert.throws(() => battery.requireWholeReceipt(repeated), /repeat a seed/,
		'two rows for one seed is one seed played twice');

	const rowless = receiptOf([winRow(1)]);
	delete rowless.results[0].rows;
	assert.throws(() => battery.requireWholeReceipt(rowless), /no per-seed rows/,
		'the old receipt shape is exactly what this gate exists to stop');
});

test('a treatment flag that never fired refuses the tally', () => {
	const inert = [{counters: {banked: 0, stallTried: 0, sacked: 0}}];
	const fired = [{counters: {banked: 3, stallTried: 0, sacked: 0}}];

	assert.deepEqual(
		battery.unfiredTreatments(['--bank-bodies=1'], inert)
			.map(entry => entry.flag),
		['--bank-bodies=1'],
		'passed, enabling, and the counter never moved');
	assert.deepEqual(battery.unfiredTreatments(['--bank-bodies=1'], fired), [],
		'a counter that moved is the treatment running');

	// Passed in its DISABLING value: a zero is the expected reading, not a
	// fault. --stall-break defaults on, so this is the arm that turns it off.
	assert.deepEqual(battery.unfiredTreatments(['--stall-break=0'], inert), [],
		'switching a rule off must not be refused for staying off');
	assert.deepEqual(battery.unfiredTreatments([], inert), [],
		'a flag nobody passed is not a claim about anything');

	// --sac is numeric: the budget is what enables it.
	assert.deepEqual(
		battery.unfiredTreatments(['--sac=2'], inert).map(entry => entry.counter),
		['sacked']);
	assert.deepEqual(battery.unfiredTreatments(['--sac=0'], inert), []);

	// The modifier flags are not auditable this way and must not pretend to
	// be: their counters move with the flag absent, so a gate on one would
	// pass every time and check nothing.
	for (const modifier of ['speed-control', 'heal-control', 'screen-control',
		'pursuit-guard', 'race-sends']) {
		assert.ok(!Object.keys(battery.GATED_COUNTERS).includes(modifier),
			modifier + ' modifies a rule, it does not gate one');
	}
});

test('the two treatments keyed into one set are counted apart', () => {
	const memory = battery.freshMemory();
	memory.slowed.add('Pinsir L37');
	memory.slowed.add('atk:Pinsir L37');
	memory.slowed.add('atk:Hariyama L40');

	const counters = battery.countersOf(memory);
	assert.equal(counters.slowed, 1, 'one Speed drop');
	assert.equal(counters.attackDrops, 2, 'two attack drops');
	assert.equal(counters.progress, undefined, 'the stall clock is not a tally');
});

test('every battery scenario reads a document the repository tracks', () => {
	// The battery read its reports out of gitignored ui-playthrough-out/, and
	// on 2026-09-14 that directory was offloaded to Drive: every scenario
	// ENOENT'd, and the only instrument that measures the policy could not
	// run on the machine it was built on. A tracked run document survives an
	// offload, a fresh clone and CI; a path under an ignored directory
	// survives none of them.
	const root = path.join(__dirname, '..');
	const manifest = JSON.parse(fs.readFileSync(
		path.join(root, 'scenarios', 'battery.json'), 'utf8'));
	const tracked = new Set(require('node:child_process').execFileSync('git', ['ls-files', 'fixtures/banked-runs'],
		{cwd: root, encoding: 'utf8'}).split('\n').filter(Boolean));
	const untracked = manifest.scenarios
		.filter(scenario => !tracked.has(scenario.report))
		.map(scenario => scenario.name + ' -> ' + scenario.report);
	assert.deepEqual(untracked, [],
		'these scenarios read files git does not track, so the next offload breaks them');
});

test('a scenario plays from a report or from its banked run document, nothing else', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'battery-doc-'));
	const doc = bankedRun();
	const bare = path.join(dir, 'x.run.json');
	const wrapped = path.join(dir, 'report-x.json');
	const neither = path.join(dir, 'other.json');
	fs.writeFileSync(bare, JSON.stringify(doc));
	fs.writeFileSync(wrapped, JSON.stringify({run: doc, argv: []}));
	fs.writeFileSync(neither, JSON.stringify({label: 'battery3', results: []}));

	assert.deepEqual(battery.loadDocument(bare), doc, 'the banked shelf reads as-is');
	assert.deepEqual(battery.loadDocument(wrapped), doc, 'a report still reads through .run');
	assert.throws(() => battery.loadDocument(neither), /neither a report nor a run document/,
		'a receipt handed in by mistake is refused, not played as an empty box');
});
