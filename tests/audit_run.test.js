/* eslint-env node, es6 */
'use strict';

/**
 * Gate for scripts/audit-run.js: a clean run passes, and each way a result
 * can be invalid is caught by the check that names it. Each tamper below is
 * a real failure found by hand on 2026-09-19 or a rule the run relies on.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const auditRun = require('../scripts/audit-run.js').auditRun;

const DOC = path.join(__dirname, '..', 'fixtures', 'banked-runs', 'br-21.run.json');

function cleanRow() {
	return {doc: JSON.parse(fs.readFileSync(DOC, 'utf8')),
		ledger: [{n: 1, trainer: 'Youngster Calvin', seed: 2, result: 'win', refusals: 0}],
		provenance: {revision: '0123456789abcdef', dirty: false, flags: ['--pp-model=1']}};
}

const statusOf = (result, name) => result.checks.find(entry => entry.name === name).status;

test('a clean run passes every check but the unfinished road', () => {
	const result = auditRun(cleanRow());
	assert.equal(result.ok, true, JSON.stringify(result.checks.filter(entry => entry.status === 'FAIL')));
	assert.equal(result.beatTheGame, false, 'an unfinished road never beats the game');
	for (const name of ['provenance', 'replay', 'one catch per area', 'removed species', 'prizes', 'level-ups',
		'moves', 'wins']) {
		assert.equal(statusOf(result, name), 'PASS', name);
	}
});

test('each invalid result is caught by the check that names it', () => {
	const tampered = (edit, name) => {
		const row = cleanRow();
		edit(row);
		const result = auditRun(row);
		assert.equal(statusOf(result, name), 'FAIL', name + ': ' + JSON.stringify(result.checks));
		assert.equal(result.ok, false);
	};
	// A second catch on a route already caught on.
	tampered(row => {
		const first = row.doc.log.find(entry => entry.command.kind === 'catch' && entry.command.map);
		row.doc.log.push({at: 't', command: Object.assign({}, first.command, {species: 'Zigzagoon'})});
	}, 'one catch per area');
	// A species the hack removed (the official Unavailable Pokemon sheet).
	tampered(row => {
		row.doc.log.push({at: 't', command: {kind: 'catch', species: 'Smeargle', level: 30,
			map: 'AlteringCave', method: 'walk', ivs: {hp: 1, atk: 1, def: 1, spa: 1, spd: 1, spe: 1},
			nature: 'Hardy', ability: 'Own Tempo'}});
	}, 'removed species');
	// A win the driver bought with a refused engine transition.
	tampered(row => {
		row.ledger.push({n: 2, trainer: 'Cool Trainer Jennifer & Callie', seed: 7, result: 'win', refusals: 1});
	}, 'wins');
	// Played from a tree with uncommitted changes.
	tampered(row => { row.provenance.dirty = true; }, 'provenance');
	// A box edited outside the log.
	tampered(row => { row.doc.box[0].level += 1; }, 'replay');
});

test('an engine crash is a lost fight, not a lost run, and the audit names it', () => {
	// Sweep 14's deepest run died at fight #271 after beating 410 of them
	// (a stat stage the calculator could not index), and its document went
	// with it, so the state could not be replayed.
	const headless = require('../scripts/headless-run.js');
	const battery = require('../scripts/scenario-battery.js');
	const policy = require('../scripts/ui-playthrough.js');
	const real = battery.playScenario;
	const crashes = [];
	let calls = 0;
	battery.playScenario = function crashOnceThenPlay() {
		calls += 1;
		if (calls === 3) throw new Error('Cannot read properties of undefined (reading \'0\')');
		return real.apply(this, arguments);
	};
	let row;
	try {
		process.argv.push('--budget=6');
		row = headless.playRun(policy, {species: 'Chimchar', rival: 'Blaziken'}, 41, headless.armFlags(''),
			{keepDoc: true, onCrash: (crash, doc) => crashes.push([crash, doc])});
	} finally {
		battery.playScenario = real;
		process.argv = process.argv.filter(arg => arg !== '--budget=6');
	}
	assert.equal(row.crashes, 1, 'the crash is counted');
	assert.equal(row.crashed.length, 1);
	assert.match(row.crashed[0].message, /Cannot read properties/);
	assert.ok(row.crashed[0].trainer && row.crashed[0].seed, 'the fight and its seed are named');
	assert.equal(crashes.length, 1, 'the document that met it is handed out');
	assert.ok(crashes[0][1].log.length > 0, 'and it is a real document');
	assert.ok(row.fights > 3, 'the run kept going: ' + row.fights);
	const audited = auditRun(row);
	const crashCheck = audited.checks.find(entry => entry.name === 'engine crashes');
	assert.equal(crashCheck.status, 'WARN');
	assert.match(crashCheck.detail, /Cannot read properties/);
});

test('a double gets a boss\'s attempts, not a dozen', () => {
	// Sweep 15's deepest run reached fight #290 of 358 and walked past four
	// doubles owing the debt: they are not bosses by name, so they got twelve
	// attempts each. The bridge rival fell on the ninth of sixty.
	const headless = require('../scripts/headless-run.js');
	assert.equal(headless.retryCap('Leader Norman', false), 20, 'a boss keeps its budget');
	assert.equal(headless.retryCap('Psychic Hannah & Sylvia', false), 12, 'an ordinary fight keeps its dozen');
	assert.equal(headless.retryCap('Psychic Hannah & Sylvia', true), 20, 'a double is given the boss budget');
	assert.equal(headless.retryCap('Trainer Rival Bridge Blaziken', true), 20);
});
