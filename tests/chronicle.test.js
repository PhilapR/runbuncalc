/* eslint-env node, es6 */
'use strict';

/**
 * The run has to be tellable.
 *
 * The record was a tally — 18 catches, 146 fights, 2924 deaths in a sweep —
 * and every death named a SPECIES, which a sweep buries a dozen times, so no
 * loss belonged to anybody. These gates hold the three things that make it a
 * story instead: a caught body gets a name, the record says what that body
 * took down as well as what took it down, and the telling uses the line that
 * actually stuck rather than the sixty rehearsals at a wall.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const nicknames = require('../lib/nicknames.js');
const chronicle = require('../scripts/chronicle.js');
const run = require('../lib/run.js');

test('a nickname is stable for a run and never repeated', () => {
	const first = nicknames.nicknameFor('Staravia', 3, []);
	assert.equal(nicknames.nicknameFor('Staravia', 3, []), first, 'same catch, same name');
	assert.notEqual(nicknames.nicknameFor('Staravia', 4, []), first, 'a later catch differs');
	const second = nicknames.nicknameFor('Staravia', 3, [first]);
	assert.notEqual(second, first, 'a taken name is walked past, not reused');
	assert.ok(nicknames.POOL.includes(second), 'and the walk stays in the pool');
});

test('the chronicle tells the line that stuck, not the rehearsals at the wall', () => {
	// The harness retries a lost boss up to sixty times and does not carry
	// death between attempts, so the raw ledger buried one body twenty-eight
	// times at a single Leader and called it a life.
	const ledger = [
		{n: 1, order: 10, trainer: 'Leader Brawly', result: 'loss', policy: 'decide',
			killers: [{name: 'Hob', species: 'Timburr', of: 'Kubfu', by: 'Brick Break'}], kos: []},
		{n: 2, order: 10, trainer: 'Leader Brawly', result: 'win', policy: 'search-8',
			killers: [], kos: [{name: 'Hob', foe: 'Kubfu', by: 'Rock Slide'}]},
		{n: 3, order: 11, trainer: 'Camper Gavi', result: 'loss', policy: 'decide',
			killers: [{name: 'Hob', species: 'Gurdurr', of: null, by: null}], kos: []},
	];
	const line = chronicle.theLine(ledger);
	assert.deepEqual(line.map(fight => fight.n), [2, 3], 'one row per fight on the road, the last');

	const text = chronicle.chronicle({starter: 'Chimchar', seed: 1, ledger,
		box: [{id: 'mon-1', species: 'Gurdurr', nickname: 'Hob',
			origin: {at: 4, mapName: 'Route102'}}]});
	assert.match(text, /1 attempt was spent and lost on walls/, 'the rehearsal is counted, not told');
	assert.match(text, /\*\*Hob\*\* the Gurdurr, caught on Route 102/, 'the place name is readable');
	assert.match(text, /1 knockout/, 'what it took down');
	assert.match(text, /fell at Camper Gavi \(fight 3\) with no killer recorded/,
		'an unattributed death says so instead of printing a null');
	assert.doesNotMatch(text, /null/, 'no null reaches the prose: ' + text);
	assert.doesNotMatch(text, /Brick Break/, 'the rehearsal death is not in the roster');
});

test('a fight names the body that fell and the body that took the enemy down', () => {
	// Composed through the real pipeline, not from hand-built rows: the
	// battery's own return dropped the box id on the way out, so a
	// fixture-level check passed while every name in a real run read '?'.
	const battery = require('./../scripts/scenario-battery.js');
	const base = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'banked-runs',
		'brkeys3b-A-7.run.json'), 'utf8'));
	const doc = base.party.reduce((carry, id, index) =>
		run.apply(carry, {kind: 'nickname', id, nickname: nicknames.POOL[index]}), base);
	const played = battery.playScenario(require('../scripts/ui-playthrough.js'),
		doc, 'Leader Brawly', 3);
	const named = new Set(doc.box.filter(mon => mon.nickname).map(mon => mon.nickname));
	assert.ok(named.size >= 2, 'the fixture has named bodies to attribute to');

	const kos = played.knockouts || [];
	assert.ok(kos.length > 0, 'Brawly loses somebody in this fight');
	const attributed = kos.filter(kill => kill.byMonId);
	assert.ok(attributed.length > 0, 'a knockout carries the box id of whoever landed it');
	const who = doc.box.find(mon => mon.id === attributed[0].byMonId);
	assert.ok(who && named.has(who.nickname), 'and that id resolves to a named body');

	for (const death of played.killers || []) {
		assert.ok(Object.prototype.hasOwnProperty.call(death, 'monId'),
			'a death carries the box id, so the chronicle can name the individual');
	}
});
