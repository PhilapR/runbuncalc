/* eslint-env node, es6 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const ask = require('../scripts/ask.js');

const root = path.join(__dirname, '..');

function run(args) {
	return childProcess.execFileSync(process.execPath,
		[path.join(root, 'scripts', 'ask.js'), ...args],
		{cwd: root, encoding: 'utf8'});
}

test('every question the CLI advertises actually answers', () => {
	// A help list that names a command which throws is worse than no help.
	const questions = [
		['where', 'Ponyta'],
		['encounters', 'Oldale Town'],
		['opens', 'Route101'],
		['moves', 'Mudkip', '12'],
		['learn', 'Mudkip', 'Surf'],
		['evolve', 'Mudkip'],
		['catch', 'Poochyena'],
		['fight', 'Bug Catcher Rick'],
		['starters'],
		['coverage'],
	];
	for (const question of questions) {
		const out = run(question);
		assert.ok(out.trim().length > 0, `${question[0]} produced no answer`);
		assert.doesNotMatch(out, /undefined|\[object Object\]|NaN/,
			`${question[0]} leaked a raw value into its answer: ${out.slice(0, 120)}`);
	}
	// Every advertised command must be in the list the error message prints.
	const unknown = childProcess.spawnSync(process.execPath,
		[path.join(root, 'scripts', 'ask.js'), 'nonsense'], {cwd: root, encoding: 'utf8'});
	assert.equal(unknown.status, 1, 'an unknown question exits non-zero');
	for (const name of Object.keys(ask.COMMANDS)) {
		assert.match(unknown.stderr, new RegExp(name),
			`the help list must name ${name}`);
	}
});

test('the documented shapes are the real shapes', () => {
	// docs/DATA-ACCESS.md exists because these shapes are not uniform and two
	// of them cost real time. A doc that drifts from them is worse than none,
	// so the traps it calls out are asserted here rather than trusted.
	const oracle = ask.oracle;

	// levelUpMoves returns PAIRS. The doc's whole warning rests on this.
	const pairs = oracle.levelUpMoves('Mudkip');
	assert.ok(Array.isArray(pairs) && pairs.length, 'Mudkip has level-up moves');
	assert.ok(Array.isArray(pairs[0]),
		'levelUpMoves must return [level, move] pairs — the doc warns callers about this');
	assert.equal(typeof pairs[0][0], 'number', 'index 0 is the level');
	assert.equal(typeof pairs[0][1], 'string', 'index 1 is the move');
	// And the misuse the doc names must genuinely fail, or the warning is noise.
	assert.equal(pairs.filter(move => move.level <= 5).length, 0,
		'the object-style filter the doc warns about must return nothing');

	// encountersOn wraps its list.
	const table = oracle.encountersOn('Oldale Town');
	assert.ok(!Array.isArray(table), 'encountersOn does not return a bare array');
	assert.ok(Array.isArray(table.mons), 'the list is under .mons');

	// availabilityOf null means undated, and undated locations really exist.
	const undated = oracle.maps().filter(map => !oracle.availabilityOf(map.name));
	assert.ok(undated.length > 0,
		'some locations are genuinely undatable — the doc says seven');
	assert.equal(oracle.availabilityOf('no such place'), null);

	// Provenance is real and distinguishable, which the doc leans on.
	const derived = oracle.availabilityOf('Oldale Town');
	assert.equal(derived.provenance, 'derived', 'a tracker-placed entry says so');
	const transcribed = oracle.availabilityOf('Route101');
	assert.equal(transcribed.provenance, undefined,
		'an original transcription carries no provenance field');
});

test('the doc names every command, and every command it names exists', () => {
	// The failure this prevents: adding a question and never documenting it,
	// or documenting one that was renamed.
	const doc = fs.readFileSync(path.join(root, 'docs/DATA-ACCESS.md'), 'utf8');
	for (const name of Object.keys(ask.COMMANDS)) {
		assert.match(doc, new RegExp(`ask\\.js ${name}\\b`),
			`docs/DATA-ACCESS.md must show how to ask '${name}'`);
	}
	const advertised = [...doc.matchAll(/ask\.js (\w+)/g)].map(match => match[1]);
	for (const name of new Set(advertised)) {
		assert.ok(ask.COMMANDS[name],
			`the doc advertises '${name}', which the CLI does not answer`);
	}
});
