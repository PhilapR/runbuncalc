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
	const tracked = new Set(require('node:child_process').execFileSync('git', ['ls-files', 'fixtures/banked-runs'],
		{cwd: root, encoding: 'utf8'}).split('\n').filter(Boolean));
	// The battery and the held-out set are the instruments; the older
	// experiment manifests still read the ignored archive and are not held
	// to this until they are banked.
	const untracked = ['battery.json', 'heldout.json', 'heldout2.json'].flatMap(file => JSON.parse(
		fs.readFileSync(path.join(root, 'scenarios', file), 'utf8')).scenarios
		.filter(scenario => !tracked.has(scenario.report))
		.map(scenario => file + ': ' + scenario.name + ' -> ' + scenario.report));
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

test('a flag that swallowed the next one is refused on sight', () => {
	// The exact argv koorder1-pp was first launched with: one argument, two
	// flags. It ran fuel-free under a real-PP label.
	const argv = ['node', 'battery', '--label=koorder1-pp', '--ko-respects-order=1 --pp-model=1'];
	assert.deepEqual(policy.gluedFlags(argv), ['--ko-respects-order=1 --pp-model=1']);
	// A value may hold a space; only a second flag inside it is the fault.
	assert.deepEqual(policy.gluedFlags(['node', 'battery', '--trainer=Leader Wattson',
		'--pp-model=1', '--ko-respects-order=1']), []);
});

/** Run the battery for real, one seed, and report what it did. */
function batteryRun(extra, label) {
	const root = path.join(__dirname, '..');
	const receipt = path.join(root, 'scenarios', 'receipts', label + '.json');
	const scratch = path.join(root, 'ui-playthrough-out', label + '-battery.json');
	fs.mkdirSync(path.dirname(scratch), {recursive: true});
	const result = require('node:child_process').spawnSync(process.execPath,
		[path.join(root, 'scripts', 'scenario-battery.js'),
			'--report=fixtures/banked-runs/flannery-3.run.json',
			'--trainer=Pokéfan Miguel', '--seeds=1', '--label=' + label].concat(extra),
		{cwd: root, encoding: 'utf8'});
	const wrote = fs.existsSync(receipt);
	fs.rmSync(receipt, {force: true});
	fs.rmSync(scratch, {force: true});
	return {status: result.status, stderr: result.stderr, wrote};
}

test('the battery refuses what it would silently misread, before playing a fight', () => {
	const glued = batteryRun(['--ko-respects-order=1 --pp-model=1'], 'guard-glued');
	assert.notEqual(glued.status, 0, 'a glued pair must not run');
	assert.match(glued.stderr, /second flag inside its value/);
	assert.equal(glued.wrote, false, 'and must leave no receipt behind');

	const typo = batteryRun(['--ko-respect-order=1'], 'guard-typo');
	assert.equal(typo.status, 1, 'a flag nothing reads must not run as the control');
	assert.match(typo.stderr, /nothing reads --ko-respect-order/);
	assert.equal(typo.wrote, false);
});

test('the unread-flag guard is not a wall: real flags, one per argument, pass it', () => {
	// Checked in-process rather than by running a batch: a real batch writes a
	// receipt into scenarios/receipts, and the provenance gate lists that
	// directory from a parallel process — a file that comes and goes between
	// its readdir and its read is a flake this test would own.
	const key = require.resolve('../scripts/ui-playthrough.js');
	const saved = process.argv;
	delete require.cache[key];
	let unread;
	try {
		process.argv = ['node', 'battery', '--label=x', '--pp-model=1', '--race-sends=1',
			'--ko-respect-order=1'];
		// Asked while this argv stands: the audit reads argv when called.
		unread = battery.unreadBy(require('../scripts/ui-playthrough.js'), battery.OWN_FLAGS);
	} finally {
		process.argv = saved;
		delete require.cache[key];
	}
	assert.deepEqual(unread, ['ko-respect-order'],
		'the battery\'s own flags and the policy\'s pass; only the typo is left');
});

/** Run the tape tool as a player would, since it swaps argv before loading. */
function tapeRun(receipt, scenario, seed) {
	const root = path.join(__dirname, '..');
	const result = require('node:child_process').spawnSync(process.execPath,
		[path.join(root, 'scripts', 'battery-tape.js'), '--receipt=' + receipt,
			'--scenario=' + scenario, '--seed=' + seed, '--json'],
		{cwd: root, encoding: 'utf8'});
	return {status: result.status, stderr: result.stderr,
		out: result.status === 0 ? JSON.parse(result.stdout) : null};
}

test('a tape replays a receipt\'s seed and proves it is the fight the receipt measured', () => {
	// Tapes are regenerated, never stored, so the only thing that makes one
	// evidence is that it reproduces the row the batch wrote down.
	const receipt = 'scenarios/receipts/koorder1-pp.json';
	const jose = 'Bug Catcher Jose @37';
	const recorded = JSON.parse(fs.readFileSync(path.join(__dirname, '..', receipt), 'utf8'))
		.results.find(row => row.name === jose).rows.find(row => row.seed === 4);
	const run = tapeRun(receipt, jose, 4);
	assert.equal(run.status, 0, run.stderr);
	assert.equal(run.out.row.result, recorded.result);
	assert.equal(run.out.row.turns, recorded.turns);
	assert.ok(run.out.tape.length > 0, 'the fight has turns');
	assert.ok(run.out.tape.every(step => step.chose && step.why),
		'every decision says what it chose and why');
	// koorder1-pp ran with the treatment on, and seed 4 is one it gained: the
	// yield has to be on the tape, or the tape is not the treatment's fight.
	assert.ok(run.out.tape.some(step => /lands after their hit/.test(step.why)),
		'the treatment\'s own decision is on the tape');

	// A row the replay cannot reproduce means the code moved: refuse.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tape-'));
	const doctored = JSON.parse(fs.readFileSync(path.join(__dirname, '..', receipt), 'utf8'));
	const row = doctored.results.find(entry => entry.name === jose).rows
		.find(entry => entry.seed === 4);
	row.turns += 1;
	const file = path.join(dir, 'koorder1-pp.json');
	fs.writeFileSync(file, JSON.stringify(doctored));
	const refused = tapeRun(file, jose, 4);
	assert.notEqual(refused.status, 0, 'a tape of different code must not print');
	assert.match(refused.stderr, /does not reproduce the receipt's row/);
});

/** Call fn with argv in place: the battery reads its flags when asked. */
function withArgv(extra, fn) {
	const saved = process.argv;
	process.argv = ['node', 'battery'].concat(extra);
	try {
		return fn();
	} finally {
		process.argv = saved;
	}
}

test('--repick-party fields the ranker\'s six, lead first, and nothing when off', () => {
	const run = require('../lib/run.js');
	const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures',
		'banked-runs', 'brbank1-A-1.run.json'), 'utf8'));

	const off = withArgv([], () => battery.prepareDocument(doc, 'Leader Brawly'));
	assert.equal(off.doc, doc, 'off: the banked party plays verbatim, as it always has');
	assert.equal(off.repick, null);

	const on = withArgv(['--repick-party=1'], () => battery.prepareDocument(doc, 'Leader Brawly'));
	const top = run.rankParties(doc, 'Leader Brawly', {}).parties[0];
	assert.equal(on.doc.party[0], top.lead, 'the ranker\'s lead leads');
	assert.deepEqual([...on.doc.party].sort(), top.members.map(member => member.id).sort(),
		'and the six are the ranker\'s six');
	assert.equal(on.repick.changed, true, 'at Brawly the ranker disagrees with the banked six');
	assert.deepEqual(on.repick.from, doc.party);
	assert.deepEqual(doc.party, on.repick.from, 'the banked document is not mutated');

	assert.throws(() => withArgv(['--repick-party=yes'],
		() => battery.prepareDocument(doc, 'Leader Brawly')), /must be 0 or 1/);
});

test('a re-picked receipt replays through the tape tool', () => {
	// The tape tool must make the same pre-fight choice the batch made, or
	// every re-picked seed is refused as "the code moved".
	const policyArgv = ['--report=fixtures/banked-runs/brbank1-A-1.run.json',
		'--trainer=Leader Brawly', '--seeds=1', '--repick-party=1'];
	const out = withArgv(policyArgv, () => battery.runScenario(policy, {
		name: 'Leader Brawly', trainer: 'Leader Brawly', seeds: 1,
		report: 'fixtures/banked-runs/brbank1-A-1.run.json'}));
	assert.equal(out.repick.changed, true);
	assert.equal(out.counters.repicked, 1, 'the arm fired, and the gated counter says so');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repick-'));
	const file = path.join(dir, 'repick-test.json');
	fs.writeFileSync(file, JSON.stringify({label: 'repick-test', manifest: null,
		argv: policyArgv, provenance: {revision: null}, results: [out]}));
	const replayed = tapeRun(file, 'Leader Brawly', 1);
	assert.equal(replayed.status, 0, replayed.stderr);
	assert.equal(replayed.out.row.result, out.rows[0].result);
});
