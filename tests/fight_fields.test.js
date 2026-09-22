/* eslint-env node, es6 */
'use strict';

/**
 * fight-fields.json says how each fight was placed, and its importer can be
 * re-run off the build machine.
 *
 * ledger: fight-fields-claims-exact-name-matching-it-does-not-do. The file
 * said "exactly-name-matched trainers only" while 14 of its 35 fights were
 * placed by three other rules, and three rab annotations sat in `unmatched`
 * although a rule had filled them.
 *
 * ledger: import-fight-fields-cannot-be-re-run. The rab path was hard-coded
 * to /workspace, with no RAB_DATA override like import-availability.js has.
 */

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const fs = require('node:fs');
const os = require('node:os');

const fightFields = require('../profiles/run-and-bun/oracle/fight-fields.json');
const importer = require('../scripts/import-fight-fields.js');

// The rab data the importer reads. Absent off the build machine: the drift
// gate below then SKIPS and says why, and the fixture tests still run.
const RAB_DATA = process.env.RAB_DATA ||
	path.join(os.homedir(), 'Projects', 'pokemon-mono', 'engines', 'rab', 'backend', 'src', 'data');
const RAB_DB = path.join(RAB_DATA, 'rab-trainers-database.json');

const RULES = ['exact', 'duo-prefix', 'seafloor-location', 'bridge-rival'];

test('every placed fight names the rule that placed it, and the method names all four', () => {
	const names = Object.keys(fightFields.fields);
	assert.deepEqual(Object.keys(fightFields.derivation).sort(), names.slice().sort());
	const counts = {};
	for (const name of names) {
		assert.ok(RULES.includes(fightFields.derivation[name]), `${name}: ${fightFields.derivation[name]}`);
		counts[fightFields.derivation[name]] = (counts[fightFields.derivation[name]] || 0) + 1;
	}
	assert.deepEqual(counts, {'exact': 21, 'duo-prefix': 4, 'seafloor-location': 7, 'bridge-rival': 3});
	assert.doesNotMatch(fightFields.method, /exactly-name-matched/);
	for (const rule of ['exact name', 'duo prefix', 'Seafloor Cavern location', 'bridge rival']) {
		assert.match(fightFields.method, new RegExp(rule));
	}
	assert.equal(fightFields.provenance, 'transcribed + derived');
	assert.deepEqual(fightFields.unmatched, [], 'nothing is reported as a gap that a rule filled');
});

test('the importer reads rab from RAB_DATA', () => {
	// A directory with no database in it: the run must fail on THAT path,
	// before it writes anything.
	const missing = path.join(__dirname, 'no-such-rab-data-dir');
	const result = childProcess.spawnSync(process.execPath,
		[path.join(__dirname, '..', 'scripts', 'import-fight-fields.js')],
		{env: Object.assign({}, process.env, {RAB_DATA: missing}), encoding: 'utf8'});
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /no-such-rab-data-dir[\\/]rab-trainers-database\.json/);
});

// review 2026-09-22: the tests above read only the committed JSON, because
// main() was not exported — a placement rule could change and nothing here
// would notice until someone re-ran the importer. The rules are now pure
// functions, tested on fixtures, and the whole import is re-run against rab
// whenever rab is on this machine.

const NAMES = ['Hiker Lucas', 'Ruin Maniac Bryan & Celia', 'Team Aqua Grunt Seafloor Cavern #1',
	'Team Aqua Grunt Seafloor Cavern #2', 'Trainer Rival Bridge Mudkip', 'Trainer Rival Bridge Torchic',
	'Leader Roxanne'];

test('each of the four placement rules places the fixture it names, and nothing else', () => {
	const place = importer.makePlacer(NAMES);
	assert.deepEqual(place({name: 'Hiker Lucas'}, 'Route 111 (Desert)'), {rule: 'exact', names: ['Hiker Lucas']});
	assert.deepEqual(place({name: 'Lucas', className: 'Hiker'}, 'Route 111 (Desert)'),
		{rule: 'exact', names: ['Hiker Lucas']}, 'class + name is an exact match too');
	assert.deepEqual(place({name: 'Ruin Maniac Bryan'}, 'Route 111 (Desert)'),
		{rule: 'duo-prefix', names: ['Ruin Maniac Bryan & Celia']});
	assert.deepEqual(place({name: 'Team Aqua Grunt'}, 'Seafloor Cavern'), {rule: 'seafloor-location',
		names: ['Team Aqua Grunt Seafloor Cavern #1', 'Team Aqua Grunt Seafloor Cavern #2']});
	assert.deepEqual(place({name: 'Pokemon Trainer May [Boss]'}, 'Route 119 (East)'), {rule: 'bridge-rival',
		names: ['Trainer Rival Bridge Mudkip', 'Trainer Rival Bridge Torchic']});
	// The bridge rule is Route 119 (East)'s alone, and a stranger is no one.
	assert.equal(place({name: 'Pokemon Trainer May [Boss]'}, 'Route 110'), null);
	assert.equal(place({name: 'Nobody'}, 'Route 119 (West)'), null);
});

test('buildFields reads the annotation, records the rule, and reports what no rule places', () => {
	const built = importer.buildFields([
		{name: 'Hiker Lucas', location: 'Route 111 (Desert), permanent Sandstorm'},
		{name: 'Leader Roxanne', location: 'Rustboro Gym'},
		{name: 'Pokemon Trainer May [Boss]', location: 'Route 119 (East), permanent Rain and Electric Terrain'},
		{name: 'Nobody', location: 'Route 129, erratic weather'},
	], NAMES);
	assert.equal(built.annotated, 3, 'an unannotated location is not counted');
	assert.deepEqual(built.output.fields, {
		'Hiker Lucas': {weather: 'Sand'},
		'Trainer Rival Bridge Mudkip': {weather: 'Rain', terrain: 'Electric'},
		'Trainer Rival Bridge Torchic': {weather: 'Rain', terrain: 'Electric'},
	});
	assert.deepEqual(built.output.derivation, {'Hiker Lucas': 'exact',
		'Trainer Rival Bridge Mudkip': 'bridge-rival', 'Trainer Rival Bridge Torchic': 'bridge-rival'});
	assert.deepEqual(built.output.unmatched, ['Nobody @ Route 129, erratic weather']);
	assert.deepEqual(importer.parseAnnotation('Seafloor Cavern, permanent Aurora Veil'), {enemyAuroraVeil: true});
});

const rabMissing = fs.existsSync(RAB_DB) ? false :
	'rab data is not on this machine (' + RAB_DB + '); set RAB_DATA to re-run the import';

test('re-running the import against rab reproduces the committed file', {skip: rabMissing}, () => {
	const built = importer.buildFields(importer.readTrainers(RAB_DATA), importer.fightNames());
	assert.deepEqual(built.output, fightFields,
		'fight-fields.json has drifted from its importer: RAB_DATA=... node scripts/import-fight-fields.js');
});
