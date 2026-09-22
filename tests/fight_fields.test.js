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

const fightFields = require('../profiles/run-and-bun/oracle/fight-fields.json');

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
