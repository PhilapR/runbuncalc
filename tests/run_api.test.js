/* eslint-env node, es6 */
'use strict';

/**
 * Gate for docs/RUN_API.md.
 *
 * The doc exists because reading the source was not enough: in one session an
 * agent misread `learnable`, `fieldItems` and three command signatures, each
 * time producing a confident wrong answer — "this Pokemon has 0 teachable
 * moves" for one with 33, "no field items exist" because the map argument was
 * missing, and a `teach` refusal blamed on the wrong cause.
 *
 * A doc that drifts is worse than none, because it is trusted. Every shape the
 * doc states is asserted here, so the two cannot disagree for long.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const run = require('../lib/run');
const DOC = fs.readFileSync(path.join(__dirname, '..', 'docs', 'RUN_API.md'), 'utf8');

function fresh() {
	let doc = run.createRun({
		name: 'api', now: 't0', levelCap: 'next-milestone-ace',
		permadeath: false, onePerRoute: false,
	});
	doc = run.apply(doc, {
		kind: 'catch', species: 'Prinplup', level: 21,
		ivs: {hp: 20, atk: 20, def: 20, spa: 20, spd: 20, spe: 20},
	});
	return {doc: doc, id: doc.box[0].id};
}

test('learnable returns {now, later}, not an array', () => {
	const state = fresh();
	const out = run.learnable(state.doc, state.id, {atLevel: 21});
	assert.ok(!Array.isArray(out), 'the doc says OBJECT, and .length on it is undefined');
	assert.ok(Array.isArray(out.now) && Array.isArray(out.later));
	assert.ok(out.now.length > 20, 'a Prinplup at 21 has a real movepool, not zero');
	// sources[].source is a STRING, which is how an egg move is identified.
	const first = out.now[0];
	assert.equal(typeof first.sources[0].source, 'string');
	assert.ok(out.now.some(entry => entry.sources.every(src => /^egg/.test(src.source))),
		'egg-only moves are identified by every source starting "egg"');
});

test('fieldItems needs its map, and gates on `open`', () => {
	const state = fresh();
	assert.deepEqual(run.fieldItems(state.doc), [],
		'no map means no answer — and NOT because the game has no items');
	const here = run.fieldItems(state.doc, 'Route101');
	assert.ok(here.length > 0, 'Route 101 carries at least one item');
	assert.ok('open' in here[0], 'the gate field is `open`');
	assert.ok(!('reachable' in here[0]),
		'there is no `reachable` field; reading one yields undefined and reads as locked');
});

test('teach replaces with `replace`, and the refusal does not name the real cause', () => {
	const state = fresh();
	// The documented shape works.
	assert.doesNotThrow(() => run.apply(state.doc,
		{kind: 'teach', id: state.id, move: 'Ice Beam', replace: 'Pluck'}));
	// Every wrong key name fails with the SAME message, which is why that
	// message must not be read as evidence about the value.
	const message = key => {
		try {
			const command = {kind: 'teach', id: state.id, move: 'Ice Beam'};
			command[key] = 'Pluck';
			run.apply(state.doc, command);
			return null;
		} catch (error) { return error.message; }
	};
	const over = message('over');
	assert.ok(over && /knows four moves/.test(over));
	assert.equal(message('forget'), over, 'a wrong key gives the same message as no key');
});

test('teaching is gated on legality, not on owning a TM', () => {
	const state = fresh();
	assert.throws(() => run.apply(state.doc,
		{kind: 'teach', id: state.id, move: 'Roar of Time', replace: 'Pluck'}),
	/cannot learn/, 'an illegal move is refused by legality');
	// A legal move is accepted with an empty bag, which is the surprising half.
	assert.doesNotThrow(() => run.apply(state.doc,
		{kind: 'teach', id: state.id, move: 'Blizzard', replace: 'Pluck'}));
});

test('a Heart Scale cannot be obtained, so every egg move is unreachable', () => {
	const availability = require('../profiles/run-and-bun/oracle/availability.json');
	const scales = JSON.stringify(availability).match(/Heart Scale/g) || [];
	assert.equal(scales.length, 0,
		'if a Heart Scale is ever added to availability, retire this assertion and ' +
		'the RUN_API section that depends on it — egg moves become reachable');
});

test('the doc states the shapes it is gated on', () => {
	// Cheap, and it catches the doc being gutted while the gate stays green.
	for (const claim of ['{now: [...], later: [...]}', '**the map is required**',
		'**`replace`**', 'zero** Heart Scales']) {
		assert.ok(DOC.includes(claim.replace(/\*/g, '')) || DOC.includes(claim),
			'docs/RUN_API.md no longer states: ' + claim);
	}
});
