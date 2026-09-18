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
	// Every manifest in scenarios/, read from the directory so a new one is
	// held to this from its first commit rather than when someone lists it.
	const manifests = fs.readdirSync(path.join(root, 'scenarios'))
		.filter(file => file.endsWith('.json'));
	assert.ok(manifests.length >= 7, 'the manifests are where this gate expects them');
	const untracked = manifests.flatMap(file => JSON.parse(
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

test('--repick-party fields the ranker\'s six, lead first, by default; =0 plays the banked six', () => {
	const run = require('../lib/run.js');
	const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures',
		'banked-runs', 'brbank1-A-1.run.json'), 'utf8'));

	const off = withArgv(['--repick-party=0'], () => battery.prepareDocument(doc, 'Leader Brawly'));
	assert.equal(off.doc, doc, 'off: the banked party plays verbatim, as it always has');
	assert.equal(off.repick, null);

	const on = withArgv(['--repick-party=1'], () => battery.prepareDocument(doc, 'Leader Brawly'));
	const byDefault = withArgv([], () => battery.prepareDocument(doc, 'Leader Brawly'));
	assert.deepEqual(byDefault.repick, on.repick, 'adopted 2026-09-18: the battery re-picks unless told not to');
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
		argv: policyArgv, provenance: {revision: null}, results: [out],
		effective: {'switch-priced': '1', 'repick-party': '1'}}));
	const replayed = tapeRun(file, 'Leader Brawly', 1);
	assert.equal(replayed.status, 0, replayed.stderr);
	assert.equal(replayed.out.row.result, out.rows[0].result);
});

test('a priced-switch receipt replays through the tape tool, pricing and all', () => {
	// The tape tool must switch the driver's pricing on from the receipt's
	// argv, or every priced seed is refused as "the code moved".
	const driverModule = require('../lib/battle-driver.js');
	const argv = ['--report=fixtures/banked-runs/brkeys1-B-1.run.json',
		'--trainer=Lass Haley', '--seeds=1', '--repick-party=1', '--switch-priced=1'];
	const key = require.resolve('../scripts/ui-playthrough.js');
	let out;
	withArgv(argv, () => {
		delete require.cache[key];
		const priced = require('../scripts/ui-playthrough.js');
		try {
			driverModule.setSwitchPricing(true);
			out = battery.runScenario(priced, {name: 'Lass Haley', trainer: 'Lass Haley', seeds: 1,
				report: 'fixtures/banked-runs/brkeys1-B-1.run.json'});
		} finally {
			driverModule.setSwitchPricing(true);
			delete require.cache[key];
		}
	});
	assert.ok(out.counters.switchRepriced > 0,
		'the Lass Haley line reaches the switch the price exists to refuse');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priced-'));
	const file = path.join(dir, 'priced-test.json');
	fs.writeFileSync(file, JSON.stringify({label: 'priced-test', manifest: null, argv,
		provenance: {revision: null}, results: [out]}));
	const replayed = tapeRun(file, 'Lass Haley', 1);
	assert.equal(replayed.status, 0, replayed.stderr);
	assert.equal(replayed.out.row.result, out.rows[0].result);
	assert.ok(replayed.out.tape.every(step => !/this one resists/.test(step.why) ||
		!/^switch to Rhyhorn/.test(step.chose)), 'Rhyhorn is never the resist switch here');
});

test('an engine refusal is counted per seed and refuses the tally', () => {
	// The driver turns a transition the engine refused into a lost turn so a
	// live fight survives it. That is how a Burn Up user went unhittable and
	// 113 adopted-baseline wins were counted as real (ledger
	// burn-up-user-is-unhittable). The refusal is data now, and the battery
	// counts it.
	const driverModule = require('../lib/battle-driver.js');
	const event = driverModule.refusalEvent('Bisharp', new Error('Damage must be a finite non-negative number'));
	assert.equal(event.engineRefusal, true, 'a refusal is tagged, not just worded');
	assert.match(event.text, /^Bisharp flinched at the engine: Damage must be/);

	// A real fight, with one refusal injected into the second reply.
	const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'banked-runs',
		'flannery-3.run.json'), 'utf8'));
	const act = driverModule.act;
	let calls = 0;
	driverModule.act = (battle, action) => {
		const reply = act(battle, action);
		calls += 1;
		return calls === 2 ? Object.assign({}, reply, {events: (reply.events || []).concat(
			driverModule.refusalEvent('Mimikyu', new Error('injected')))}) : reply;
	};
	let played;
	try {
		played = battery.playScenario(policy, doc, 'Pokéfan Miguel', 3);
	} finally {
		driverModule.act = act;
	}
	assert.ok(calls >= 2, 'the fight lasted long enough to carry the injection');
	assert.equal(played.engineRefusals, 1, 'exactly the one refusal, counted');
	assert.equal(battery.playScenario(policy, doc, 'Pokéfan Miguel', 3).engineRefusals, 0,
		'and none in the same fight played honestly');

	const report = battery.engineRefusalReport([
		{name: 'clean', rows: [{seed: 1, engineRefusals: 0}]},
		{name: 'poisoned', rows: [{seed: 1, engineRefusals: 0}, {seed: 2, engineRefusals: 3},
			{seed: 5, engineRefusals: 1}]},
		{name: 'pre-counter receipt', rows: [{seed: 1}]},
	]);
	assert.deepEqual(report, [{name: 'poisoned', seeds: [2, 5], refusals: 4}],
		'only fights with refusals are named, with their seeds');
});

test('a charged move released after its target switched out hits the replacement', () => {
	// Triathlete Jacob, held-out, seed 3, under the re-pick arm with real PP:
	// Sawsbuck's Bounce went up at Walrein, we switched to Empoleon on turn 6,
	// and the release was refused ("Damage references a non-target of the
	// move") and turned into a lost turn. The same fight, played now.
	const driverModule = require('../lib/battle-driver.js');
	const argv = ['--switch-priced=0', '--repick-party=1', '--pp-model=1'];
	const key = require.resolve('../scripts/ui-playthrough.js');
	const scenario = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'scenarios', 'heldout.json'),
		'utf8')).scenarios.find(entry => entry.name === 'Triathlete Jacob @73');
	let played;
	const turn6 = [];
	withArgv(argv, () => {
		delete require.cache[key];
		const armed = require('../scripts/ui-playthrough.js');
		const act = driverModule.act;
		driverModule.act = (battle, action) => {
			const reply = act(battle, action);
			if (battle.state.turn === 6) turn6.push(...(reply.events || []).map(event => event.text));
			return reply;
		};
		try {
			driverModule.setPPModel(true);
			driverModule.setSwitchPricing(false);
			const doc = battery.prepareDocument(battery.requireScale(battery.loadDocument(scenario.report)),
				scenario.trainer).doc;
			played = battery.playScenario(armed, doc, scenario.trainer, 3);
		} finally {
			driverModule.act = act;
			driverModule.setPPModel(false);
			driverModule.setSwitchPricing(true);
			delete require.cache[key];
		}
	});
	assert.equal(played.engineRefusals, 0, 'no refusal anywhere in the fight: ' + turn6.join(' | '));
	assert.ok(turn6.some(text => /Empoleon was sent out/.test(text)), 'the switch happens: ' + turn6.join(' | '));
	assert.ok(turn6.some(text => /Foe Sawsbuck used Bounce\. \(\d+% to Empoleon\)/.test(text)),
		'and the Bounce lands on Empoleon: ' + turn6.join(' | '));
});

test('pick-by-play chooses among the ranker\'s sixes on selection seeds the grade never uses', () => {
	// br-19 at Roxanne: the ranker's first six wins 0/30 and its own seventh
	// 20/30 (LEADER-KEYS 2026-09-18). A six chosen by play must be chosen on
	// seeds the evaluation never plays, or it grades the seeds that picked it.
	const driverModule = require('../lib/battle-driver.js');
	const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'banked-runs',
		'br-19.run.json'), 'utf8'));
	const start = driverModule.start;
	const seeds = [];
	driverModule.start = (d, trainer, seed) => { seeds.push(seed); return start(d, trainer, seed); };
	let picked;
	try {
		picked = withArgv(['--pick-by-play=7', '--pick-seeds=2'],
			() => battery.prepareDocument(doc, 'Leader Roxanne', policy));
	} finally {
		driverModule.start = start;
	}
	const byPlay = picked.repick.byPlay;
	assert.equal(byPlay.k, 7);
	assert.equal(byPlay.wins.length, 7, 'every candidate gets a tally');
	assert.equal(seeds.length, 14, 'seven sixes, two selection seeds each');
	assert.ok(seeds.every(seed => seed > battery.SELECTION_SEED_BASE),
		'selection never plays an evaluation seed: ' + seeds.join(','));
	const best = Math.max(...byPlay.wins);
	assert.ok(best > Math.min(...byPlay.wins), 'the tallies must differ, or the choice is not tested: ' +
		byPlay.wins.join(','));
	assert.ok(byPlay.chosen > 1, 'at br-19 play overrules the ranker\'s first six');
	assert.equal(byPlay.wins[byPlay.chosen - 1], best, 'the most selection wins is fielded');
	assert.equal(byPlay.wins.indexOf(best) + 1, byPlay.chosen, 'and a tie keeps the ranker\'s order');

	const run = require('../lib/run.js');
	const ranked = run.rankParties(doc, 'Leader Roxanne', {}).parties[byPlay.chosen - 1];
	assert.equal(picked.doc.party[0], ranked.lead, 'the fielded six is that candidate, lead first');

	const off = withArgv([], () => battery.prepareDocument(doc, 'Leader Roxanne', policy));
	assert.equal(off.repick.byPlay, undefined, 'off by default: the ranker\'s first six, as adopted');
	assert.throws(() => withArgv(['--pick-by-play=3', '--repick-party=0'],
		() => battery.prepareDocument(doc, 'Leader Roxanne', policy)), /needs --repick-party=1/);
	assert.throws(() => withArgv(['--pick-by-play=3'],
		() => battery.prepareDocument(doc, 'Leader Roxanne')), /needs the policy/);
});

test('a pick-by-play receipt records its tallies and replays through the tape tool', () => {
	const argv = ['--report=fixtures/banked-runs/br-19.run.json', '--trainer=Leader Roxanne',
		'--seeds=1', '--pick-by-play=3', '--pick-seeds=1'];
	const out = withArgv(argv, () => battery.runScenario(policy, {name: 'Leader Roxanne',
		trainer: 'Leader Roxanne', seeds: 1, report: 'fixtures/banked-runs/br-19.run.json'}));
	assert.ok(out.repick.byPlay, 'the receipt says how the six was chosen');
	assert.equal(out.counters.pickedByPlay, out.repick.byPlay.chosen > 1 ? 1 : 0);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbp-'));
	const file = path.join(dir, 'pbp-test.json');
	fs.writeFileSync(file, JSON.stringify({label: 'pbp-test', manifest: null, argv,
		provenance: {revision: null}, results: [out],
		effective: {'switch-priced': '1', 'repick-party': '1', 'pick-by-play': '3', 'pick-seeds': '1'}}));
	const replayed = tapeRun(file, 'Leader Roxanne', 1);
	assert.equal(replayed.status, 0, replayed.stderr);
	assert.equal(replayed.out.row.result, out.rows[0].result);
});

test('shards split a manifest into disjoint slices that cover it', () => {
	const scenarios = Array.from({length: 11}, (x, i) => ({name: 's' + i}));
	const shards = [0, 1, 2].map(i => battery.shardOf(scenarios, i + '/3').map(s => s.name));
	assert.deepEqual(shards.flat().sort(), scenarios.map(s => s.name).sort(), 'together they are the manifest');
	assert.equal(new Set(shards.flat()).size, 11, 'and no scenario is in two');
	assert.deepEqual(battery.shardOf(scenarios, ''), scenarios, 'no shard is the whole manifest');
	assert.throws(() => battery.shardOf(scenarios, '3/3'), /i\/n with 0 <= i < n/);
});

test('a tie in selection wins keeps the ranker\'s order', () => {
	assert.equal(battery.chooseByTally([0, 0, 0]), 1, 'no wins anywhere: the ranker\'s first six');
	assert.equal(battery.chooseByTally([1, 3, 3, 2]), 2, 'the earlier of two equal tallies');
	assert.equal(battery.chooseByTally([2, 0, 5]), 3);
});
