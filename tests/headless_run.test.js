/* eslint-env node, es6 */
'use strict';

/**
 * Gate for the headless run harness's preparation between fights.
 *
 * It parsed a teach row as "learn X" when the advisor writes "X over Y", so
 * no headless run ever taught a move, and it never levelled the box, so the
 * advice that did parse was refused at the stored catch level. A run that
 * prepares like that measures a player who never grinds and never learns.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const run = require('../lib/run.js');
const headless = require('../scripts/headless-run.js');

function freshBox() {
	let doc = run.createRun({name: 'gate', now: 't0', levelCap: 'next-milestone-ace',
		permadeath: false, onePerRoute: true, rival: 'Blaziken'});
	const random = headless.dice(1000);
	doc = run.apply(doc, Object.assign({kind: 'catch', species: 'Turtwig', level: 5},
		run.rollIdentity('Turtwig', random, {perfectIvs: 3})));
	for (const map of ['MAP_ROUTE101', 'MAP_ROUTE102', 'MAP_ROUTE103']) {
		const rolled = run.rollEncounter(doc, {map, random});
		doc = run.apply(doc, {kind: 'catch', map, species: rolled.species, level: rolled.level,
			ivs: rolled.ivs, nature: rolled.nature, ability: rolled.ability});
	}
	return run.apply(doc, {kind: 'party', ids: doc.box.map(mon => mon.id)});
}

test('the harness levels the box to the cap before a fight', () => {
	const doc = freshBox();
	const cap = run.levelCap(doc).cap;
	assert.ok(doc.box.every(mon => mon.level < cap), 'caught below the cap');
	const tally = {scaleSpends: 0};
	const levelled = headless.levelToCap(doc, tally);
	assert.ok(levelled.box.every(mon => mon.level === cap), levelled.box.map(mon => mon.level).join(','));
	assert.equal(tally.levelUps, doc.box.length);
	const turtwig = levelled.box.find(mon => mon.species === 'Turtwig');
	assert.ok(turtwig.moves.length === 4, 'levelling fills free slots: ' + turtwig.moves.join('/'));
});

test('the harness applies the advisor\'s teach rows as the advisor writes them', () => {
	// A headless run as it stopped at Camper Gavi before this was fixed (seed
	// 1000, Turtwig): stored levels 2-14, never taught.
	const stalled = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..',
		'fixtures', 'banked-runs', 'headless-stall-1000.run.json'), 'utf8'));
	assert.ok(!stalled.log.some(entry => entry.command.kind === 'teach'), 'the stalled run never taught');
	const tally = {scaleSpends: 0};
	const levelled = headless.levelToCap(stalled, tally);
	const rows = run.adviseUpgrades(levelled).upgrades.filter(row => row.kind === 'teach');
	assert.ok(rows.some(row => / over /.test(row.detail)), 'the advisor writes "X over Y": ' +
		rows.map(row => row.detail).join('; '));
	const taught = headless.followAdvice(levelled, headless.armFlags(''), tally);
	assert.ok(tally.teaches > 0, 'at least one teach row became a teach');
	const first = rows.find(row => / over /.test(row.detail));
	const move = /^(.+?) over /.exec(first.detail)[1];
	assert.ok(taught.box.some(mon => mon.moves.includes(move)) ||
		taught.log.some(entry => entry.command.kind === 'teach'), 'the moves changed in the document');
});

test('the harness hands out the held items the advisor names', () => {
	const stalled = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..',
		'fixtures', 'banked-runs', 'headless-stall-1000.run.json'), 'utf8'));
	assert.ok(stalled.box.every(mon => !mon.item), 'the stalled run held nothing');
	const tally = {scaleSpends: 0};
	const prepared = headless.followAdvice(headless.levelToCap(stalled, tally), headless.armFlags(''), tally);
	assert.ok(tally.gives > 0, 'a give row became a give');
	assert.ok(prepared.box.some(mon => mon.item), 'and a Pokemon holds it');
});

test('levelling evolves as the game does, not only when the advisor asks', () => {
	const stalled = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..',
		'fixtures', 'banked-runs', 'headless-stall-1000.run.json'), 'utf8'));
	const tally = {scaleSpends: 0};
	const levelled = headless.levelToCap(stalled, tally);
	const dossier = require('../lib/dossier');
	for (const mon of levelled.box.filter(entry => entry.status !== 'dead')) {
		assert.equal(dossier.evolveMon(mon, mon.level), mon.species,
			mon.species + ' at ' + mon.level + ' should already have evolved');
	}
	assert.ok(tally.evolves > 0);
	assert.ok(!levelled.box.some(mon => mon.species === 'Turtwig'), 'Turtwig is a Grotle by the cap');
});
