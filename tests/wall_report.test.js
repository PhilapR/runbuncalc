/* eslint-env node, es6 */
'use strict';

/**
 * A trouble fight is broken down the same way every time.
 *
 * Each wall so far was understood by a throwaway script that asked the same
 * questions in a different order. scripts/wall-report.js asks them once; this
 * holds the parts of its answer that were each a real finding.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const wall = require('../scripts/wall-report.js');

const doc = () => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'banked-runs',
	'brbank1-A-1.run.json'), 'utf8'));

test('the report reads their kit for what it demands, abilities included', () => {
	const out = wall.report(doc(), 'Leader Brawly', 2);
	assert.equal(out.theirs.length, 6);
	assert.equal(out.board.length, 6);
	// Brawly's Combusken took 2.10 bodies a facing from a box whose board
	// listed three one-on-one winners against it: Speed Boost outruns them.
	assert.ok(out.considerations.some(note => /Combusken has Speed Boost: the board's speed read is true on turn one only/.test(note)),
		out.considerations.join(' | '));
	assert.ok(out.considerations.some(note => /Combusken sets up with Work Up/.test(note)));
	assert.ok(out.considerations.some(note => /Scraggy has Rest/.test(note)));
	for (const row of out.board) {
		assert.ok(row.outspedBy >= 0 && row.outspedBy <= row.box);
		assert.ok(row.winnersInSix.every(name => row.winners.includes(name)), 'the six is part of the box');
	}
});

test('the report counts what each of theirs costs, and says what is left on the table', () => {
	const bare = doc();
	bare.box = bare.box.map(mon => bare.party.includes(mon.id) ? Object.assign({}, mon, {item: null}) : mon);
	bare.bag = Object.assign({}, bare.bag, {'Heart Scale': 2});
	const out = wall.report(bare, 'Leader Brawly', 3);
	assert.equal(out.played.of, 3);
	const faced = Object.values(out.played.cost).reduce((sum, row) => sum + row.faced, 0);
	assert.ok(faced >= 3, 'every fight faces at least their lead');
	assert.ok(out.unused.some(note => /^holding nothing: /.test(note)), out.unused.join(' | '));
	assert.ok(out.unused.some(note => /2 Heart Scale\(s\) unspent/.test(note)));
	const text = wall.render(out);
	assert.match(text, /## Can the box do it/);
	assert.match(text, /Our bodies lost per facing/);
	assert.doesNotMatch(text, /undefined|NaN/, 'nothing unformatted reaches the page');
});

test('a saved run opens at a fight it got past, as it walked up to it', () => {
	// A saved run ends where it stopped, but the fight worth reading is often
	// one it beat on the twentieth attempt, and the box that won is the lesson.
	const saved = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'banked-runs',
		'headless-norman-cufant.run.json'), 'utf8'));
	const at = wall.docAt(saved, 'Leader Wattson');
	assert.ok(at.position < 229, 'before Wattson (order 229) is beaten: ' + at.position);
	assert.ok(at.box.length > 0 && at.box.length <= saved.box.length);
	assert.equal(require('../lib/run.js').levelCap(at).cap, 35, 'and under the cap she was fought at');
	assert.throws(() => wall.docAt(saved, 'Champion Wallace'), /never beat Champion Wallace/);
});
