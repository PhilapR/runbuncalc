/* eslint-env node, es6 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const provenance = require('../lib/provenance.js');

const ROOT = path.join(__dirname, '..');

/** A tree with one file in every part, so a byte can be moved in any of them. */
function tinyTree() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-'));
	const put = (rel, text) => {
		fs.mkdirSync(path.dirname(path.join(root, rel)), {recursive: true});
		fs.writeFileSync(path.join(root, rel), text);
	};
	put('ai/src/abilities.ts', 'export const a = 1;');
	put('ai/src/test/model.test.ts', 'test');
	put('ai/dist/abilities.js', 'exports.a = 1;');
	put('ai/dist/abilities.d.ts', 'export declare const a: number;');
	put('calc/src/calc.ts', 'c');
	put('calc/dist/calc.js', 'c');
	put('profiles/run-and-bun/data.js', 'd');
	put('profiles/run-and-bun/fidelity/events.json', '[]');
	put('src/js/data/sets/gen8.js', 's');
	put('lib/battle-driver.js', 'b');
	put('scripts/ui-playthrough.js', 'p');
	put('scripts/scenario-battery.js', 'q');
	put('scripts/headless-run.js', 'h');
	return {root, put};
}

test('the engine stamp is a hash of the bytes that play, and names the part that moved', () => {
	const tree = tinyTree();
	const before = provenance.engineStamp(tree.root);
	assert.match(before.engine, /^e-[0-9a-f]{12}$/);
	assert.deepEqual(provenance.engineStamp(tree.root), before, 'the same bytes give the same stamp');

	// A copied build that moved while the revision did not: the case a revision cannot see.
	tree.put('ai/dist/abilities.js', 'exports.a = 2;');
	const rebuilt = provenance.engineStamp(tree.root);
	assert.notEqual(rebuilt.engine, before.engine);
	assert.deepEqual(provenance.compareStamps(before, rebuilt).differs, ['ai-dist']);
	assert.match(provenance.compareStamps(before, rebuilt).text, /ai-dist differ/);

	// Tests, type declarations and the fidelity observations do not play.
	tree.put('ai/src/test/model.test.ts', 'another test');
	tree.put('ai/dist/abilities.d.ts', 'export declare const a: string;');
	tree.put('profiles/run-and-bun/fidelity/events.json', '[1]');
	assert.equal(provenance.engineStamp(tree.root).engine, rebuilt.engine);

	for (const pair of [['lib/battle-driver.js', 'driver'], ['src/js/data/sets/gen8.js', 'data'],
		['scripts/ui-playthrough.js', 'policy'], ['scripts/scenario-battery.js', 'battery']]) {
		const rel = pair[0];
		const part = pair[1];
		const was = provenance.engineStamp(tree.root);
		tree.put(rel, 'moved ' + rel);
		assert.deepEqual(provenance.compareStamps(was, provenance.engineStamp(tree.root)).differs, [part], rel);
	}

	// The real tree's parts are all present: a stamp of "absent" would compare equal to any other absence.
	const here = provenance.engineStamp(ROOT);
	for (const name of Object.keys(provenance.PARTS)) assert.notEqual(here.parts[name], 'absent', name);
	// And the calc the planner loads by package name, which in a pinned worktree is the main checkout's.
	assert.match(here.parts['calc-linked'], /^[0-9a-f]{12}$/, 'the linked calc is hashed where it resolves');
	assert.match(here.revision, /^[0-9a-f]{40}$/);
});

test('the engine digest is what plays: build inputs, sources and browser bundles do not move it', () => {
	const tree = tinyTree();
	tree.put('profiles/run-and-bun/oracle.js', "const load = name => name;\nload('growth');\n" +
		"const sources = require('./oracle/sources.json');\n");
	tree.put('profiles/run-and-bun/oracle/growth.json', '{}');
	tree.put('profiles/run-and-bun/oracle/sources.json', '{}');
	tree.put('lib/dossier.js', "const table = require('../profiles/run-and-bun/oracle/learnsets.json');");
	tree.put('profiles/run-and-bun/oracle/learnsets.json', '{}');
	tree.put('profiles/run-and-bun/oracle/tracker-order.json', '[]');
	tree.put('profiles/run-and-bun/rebuild-model.json', '{}');
	tree.put('calc/dist/production.min.js', 'bundle');
	const files = provenance.filesOf(tree.root, provenance.PARTS.data);
	for (const rel of ['profiles/run-and-bun/oracle/growth.json', 'profiles/run-and-bun/oracle/sources.json',
		'profiles/run-and-bun/oracle/learnsets.json']) assert.ok(files.includes(rel), rel + ' is loaded, so hashed');
	const before = provenance.engineStamp(tree.root);
	assert.equal(before.version, 2);

	// c831f98 touched only tracker-order.json and moved `data`: a build input does not play.
	tree.put('profiles/run-and-bun/oracle/tracker-order.json', '[1]');
	tree.put('profiles/run-and-bun/rebuild-model.json', '{"a": 1}');
	tree.put('calc/dist/production.min.js', 'another bundle');
	assert.deepEqual(provenance.engineStamp(tree.root), before);

	// A source nobody rebuilt is recorded, but it did not play.
	tree.put('ai/src/abilities.ts', 'export const a = 2;');
	const edited = provenance.engineStamp(tree.root);
	assert.notEqual(edited.parts['ai-src'], before.parts['ai-src'], 'the source is still hashed, for information');
	assert.equal(edited.engine, before.engine);
	assert.equal(provenance.compareStamps(before, edited).same, true);

	// A table the oracle loads lazily, hours into a run, does play.
	tree.put('profiles/run-and-bun/oracle/growth.json', '{"Pikachu": "fast"}');
	assert.deepEqual(provenance.compareStamps(before, provenance.engineStamp(tree.root)).differs, ['data']);
	tree.put('profiles/run-and-bun/oracle/learnsets.json', '{"Pikachu": []}');
	assert.notEqual(provenance.engineStamp(tree.root).parts.data, before.parts.data);
});

test('the profile policy is policy, the linked calc hashes like the tree calc, and a skipped directory is named', () => {
	const tree = tinyTree();
	tree.put('profiles/run-and-bun/policy.js', 'module.exports = {};');
	const was = provenance.engineStamp(tree.root);
	tree.put('profiles/run-and-bun/policy.js', 'module.exports = {lead: 1};');
	assert.deepEqual(provenance.compareStamps(was, provenance.engineStamp(tree.root)).differs, ['policy']);

	// The calc resolves by package name to this tree's own calc: the two parts agree.
	tree.put('calc/package.json', JSON.stringify({name: '@smogon/calc', main: 'dist/calc.js'}));
	fs.mkdirSync(path.join(tree.root, 'node_modules', '@smogon'), {recursive: true});
	fs.symlinkSync(path.join(tree.root, 'calc'), path.join(tree.root, 'node_modules', '@smogon', 'calc'), 'dir');
	const linked = provenance.engineStamp(tree.root);
	assert.match(linked.parts['calc-linked'], /^[0-9a-f]{12}$/);
	assert.equal(linked.parts['calc-linked'], linked.parts['calc-dist'], 'the same bytes hash the same from either root');
	assert.deepEqual(linked.skipped, []);

	fs.mkdirSync(path.join(tree.root, 'elsewhere'));
	fs.writeFileSync(path.join(tree.root, 'elsewhere', 'more.js'), 'x');
	fs.symlinkSync(path.join(tree.root, 'elsewhere'), path.join(tree.root, 'ai', 'dist', 'linked'), 'dir');
	assert.deepEqual(provenance.engineStamp(tree.root).skipped, ['ai/dist/linked (symlinked directory, not followed)']);
});

test('the stamp names node and each installed package where the engine resolves it', () => {
	const tree = tinyTree();
	tree.put('node_modules/@pkmn/dex/package.json', JSON.stringify({name: '@pkmn/dex', version: '0.7.13'}));
	tree.put('node_modules/@pkmn/dex/index.js', '');
	tree.put('ai/node_modules/@pkmn/dex/package.json', JSON.stringify({name: '@pkmn/dex', version: '0.7.59', main: 'index.js'}));
	tree.put('ai/node_modules/@pkmn/dex/index.js', '');
	const was = provenance.engineStamp(tree.root);
	assert.deepEqual(was.runtime, {node: process.version, packages: {'@pkmn/dex': '0.7.59'}},
		'ai/dist loads ai/node_modules, not the root copy');
	tree.put('ai/node_modules/@pkmn/dex/package.json', JSON.stringify({name: '@pkmn/dex', version: '0.7.60', main: 'index.js'}));
	const now = provenance.engineStamp(tree.root);
	assert.notEqual(now.engine, was.engine, 'a package upgrade is another engine');
	assert.deepEqual(provenance.compareStamps(was, now).differs, ['runtime']);

	// The real tree: the version the engine plays, read where ai/dist finds it.
	const here = provenance.engineStamp(ROOT);
	const installed = JSON.parse(fs.readFileSync(require.resolve('@pkmn/dex/package.json',
		{paths: [path.join(ROOT, 'ai', 'dist')]}), 'utf8')).version;
	assert.equal(here.runtime.packages['@pkmn/dex'], installed);
	assert.equal(here.runtime.node, process.version);
});

test('a stamp of another format is not compared as an engine', () => {
	const now = provenance.engineStamp(ROOT);
	const old = Object.assign({}, now, {version: 1});
	const compared = provenance.compareStamps(old, now);
	assert.equal(compared.same, false, 'never a match, even with the same engine string');
	assert.equal(compared.format, true);
	assert.match(compared.text, /^different stamp format \(v1 against v2\)/);
	const unversioned = Object.assign({}, now);
	delete unversioned.version;
	assert.equal(provenance.compareStamps(unversioned, now).format, true, 'a stamp without a version is v1');
});

test('a record without a stamp is engine unknown, never a match', () => {
	const known = provenance.engineStamp(ROOT);
	assert.equal(provenance.describe(null), 'engine unknown (before stamps)');
	assert.equal(provenance.compareStamps(null, known).same, null);
	assert.equal(provenance.compareStamps(known, null).same, null);
	assert.equal(provenance.stampOf({provenance: {revision: 'abc'}}), null);
	assert.equal(provenance.stampOf({provenance: {engine: known}}), known);
	const legs = provenance.enginesOfLegs([{leg: 1, engine: null}, {leg: 2, engine: known}, {leg: 3, engine: known}]);
	assert.deepEqual(legs.map(entry => [entry.key, entry.legs]),
		[['engine unknown (before stamps)', [1]], [known.engine, [2, 3]]]);
});

test('a battery receipt carries the engine that played it', () => {
	const battery = require('../scripts/scenario-battery.js');
	const made = battery.provenance();
	assert.deepEqual(made.engine, provenance.currentStamp());
	assert.match(made.engine.engine, /^e-/);
});

/** Two receipts that differ only in their stamps. */
function receipts(a, b) {
	const rows = results => [{name: 'Leader Brawly @26', rows: results.map((result, i) => ({seed: i + 1, result}))}];
	return [{provenance: Object.assign({revision: 'r1'}, a ? {engine: a} : {}), results: rows(['loss', 'win', 'loss'])},
		{provenance: Object.assign({revision: 'r1'}, b ? {engine: b} : {}), results: rows(['win', 'win', 'loss'])}];
}

test('battery-pair refuses to join receipts from different engines unless told the difference is intended', () => {
	const pair = require('../scripts/battery-pair.js');
	const one = provenance.engineStamp(ROOT);
	const other = Object.assign({}, one, {engine: 'e-000000000000', parts: Object.assign({}, one.parts, {'ai-dist': 'x'})});

	const same = pair.engineGate(...receipts(one, one), false);
	assert.equal(same.ok, true);
	assert.equal(same.warning, null);
	assert.deepEqual(pair.pair(...receipts(one, one)).map(row => [row.control, row.treatment, row.gained, row.lost]),
		[[1, 2, [1], []]]);

	const split = pair.engineGate(...receipts(one, other), false);
	assert.equal(split.ok, false, 'a treatment against a control on another engine is refused');
	assert.match(split.text, /ai-dist differ/);
	const intended = pair.engineGate(...receipts(one, other), true);
	assert.equal(intended.ok, true);
	assert.match(intended.warning, /intended/);

	assert.equal(pair.engineGate(...receipts(one, null), false).ok, false,
		'a stamped receipt against an unstamped one is the before-and-after-a-fix case');
	const old = pair.engineGate(...receipts(null, null), false);
	assert.equal(old.ok, true, 'two unstamped receipts at one revision still join');
	assert.match(old.warning, /engine unknown \(before stamps\)/);
	const apart = receipts(null, null);
	apart[1].provenance.revision = 'r2';
	assert.equal(pair.engineGate(apart[0], apart[1], false).ok, false, 'two unstamped receipts at different revisions do not');

	// And from the command line: a refusal is an exit code, not a line to miss.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-'));
	const both = receipts(one, other);
	fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify(both[0]));
	fs.writeFileSync(path.join(dir, 't.json'), JSON.stringify(both[1]));
	const run = extra => childProcess.spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'battery-pair.js'),
		'--control=' + path.join(dir, 'c.json'), '--treatment=' + path.join(dir, 't.json')].concat(extra), {encoding: 'utf8'});
	const refused = run([]);
	assert.equal(refused.status, 1);
	assert.match(refused.stderr, /REFUSING to join: different engines/);
	const allowed = run(['--engine-differs=intended']);
	assert.equal(allowed.status, 0, allowed.stderr);
	assert.match(allowed.stdout, /Leader Brawly @26 .*gained 1 .*\[engine unverified\]/);
});

test('battery-tape refuses a stamped receipt from another engine, and warns on one from before stamps', () => {
	const tape = require('../scripts/battery-tape.js');
	const here = provenance.engineStamp(ROOT);
	const other = Object.assign({}, here, {engine: 'e-000000000000', parts: Object.assign({}, here.parts, {driver: 'x'})});
	assert.equal(tape.engineCheck({provenance: {engine: here}}, here, false).warning, null);
	assert.throws(() => tape.engineCheck({provenance: {engine: other}}, here, false), /another engine[\s\S]*driver differ/);
	assert.match(tape.engineCheck({provenance: {engine: other}}, here, true).warning, /intended/);
	assert.match(tape.engineCheck({provenance: {revision: 'r'}}, here, false).warning, /engine unknown \(before stamps\)/);

	// From the command line, before a fight is played.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tape-engine-'));
	const receipt = JSON.parse(fs.readFileSync(path.join(ROOT, 'scenarios', 'receipts', 'koorder1-pp.json'), 'utf8'));
	receipt.provenance.engine = other;
	fs.writeFileSync(path.join(dir, 'r.json'), JSON.stringify(receipt));
	const refused = childProcess.spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'battery-tape.js'),
		'--receipt=' + path.join(dir, 'r.json'), '--scenario=Bug Catcher Jose @37', '--seed=4', '--json'],
	{cwd: ROOT, encoding: 'utf8'});
	assert.notEqual(refused.status, 0);
	assert.match(refused.stderr, /REFUSING: the receipt was played on another engine/);
});

test('a run on two engines says so in the list and in its audit; a run from before legs says unknown', () => {
	const runs = require('../scripts/runs.js');
	const audit = require('../scripts/audit-run.js');
	const runOne = require('../scripts/run-one.js');
	const one = provenance.engineStamp(ROOT);
	const other = Object.assign({}, one, {engine: 'e-000000000000', revision: 'f'.repeat(40)});
	const legs = [{leg: 1, engine: one, from: {position: 0, fights: 0}, to: {position: 30, fights: 12}},
		{leg: 2, engine: other, from: {position: 30, fights: 12}, to: {position: 44, fights: 20}}];

	const status = {run: 'x/run-1', state: 'ended', position: 44, fights: 20, secondsPerFight: 1, rssMb: 1,
		updatedAt: Date.now(), spec: '', legs};
	status.engines = runs.enginesOf(status);
	assert.match(runs.table([status])[1], /SPANS 2 ENGINES \(e-[0-9a-f]{12}, e-000000000000\)/);
	const single = Object.assign({}, status, {legs: [legs[0]]});
	single.engines = runs.enginesOf(single);
	assert.doesNotMatch(runs.table([single])[1], /SPANS/);
	const old = Object.assign({}, status, {legs: undefined});
	old.engines = runs.enginesOf(old);
	assert.match(runs.table([old])[1], /engine unknown \(before stamps\)/);

	const split = audit.enginesCheck({legs});
	assert.equal(split.status, 'WARN', 'a split is visible, not a FAIL');
	assert.match(split.detail, /^played on 2 engines: e-[0-9a-f]{12} \(leg 1 at [0-9a-f]{10}\), e-000000000000 \(leg 2 at ffffffffff\)$/);
	assert.equal(audit.enginesCheck({legs: [legs[0]]}).status, 'PASS');
	assert.match(audit.enginesCheck({provenance: {revision: 'r'}, restoredAt: [3]}).detail,
		/engine unknown \(before stamps\); carried on 1 time/);

	// A checkpoint from before legs is one leg of unknown engine, and the next leg follows it.
	const restore = {spec: 'budget=4', position: 30, state: {tally: {fights: 12}}};
	const prior = runOne.priorLegs(restore);
	assert.deepEqual(prior.map(leg => [leg.leg, leg.engine, leg.to]), [[1, null, {position: 30, fights: 12}]]);
	const next = runOne.openLeg(prior, one, 'budget=8', restore, null);
	assert.deepEqual([next.leg, next.from, next.engine.engine, next.spec], [2, {position: 30, fights: 12}, one.engine, 'budget=8']);
	assert.equal(audit.enginesCheck({legs: prior.concat([next])}).status, 'WARN');
});

test('a batch of arms on more than one engine is refused as a batch', () => {
	const arms = require('../scripts/battery-arms.js');
	const both = arms.enginesOfResults([{label: 'a', receipt: true, engine: 'e-1'}, {label: 'b', receipt: true, engine: 'e-1'},
		{label: 'c', receipt: false, engine: null}]);
	assert.equal(both.split, false);
	assert.equal(both.text, 'one engine: e-1');
	const split = arms.enginesOfResults([{label: 'a', receipt: true, engine: 'e-1'}, {label: 'b', receipt: true, engine: 'e-2'}]);
	assert.equal(split.split, true, 'a rebuild mid-batch splits the arms');
	assert.equal(split.text, 'the arms played on 2 engines: e-1 (a); e-2 (b)');
});
