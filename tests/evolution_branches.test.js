/* eslint-env node, es6 */
'use strict';

/**
 * Gate for stat-conditioned evolution (Tyrogue).
 *
 * The importer folded EVO_LEVEL_ATK_GT_DEF and kin into plain 'level', so
 * the data held three unconditioned level-20 paths and every consumer took
 * the first: every Tyrogue became Hitmonchan, whatever its stats. The rule
 * is now data (`requires`), judged from the Pokemon's own IVs and nature at
 * the evolution level, and every consumer that fields a Tyrogue asks it.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const dossier = require('../lib/dossier');
const run = require('../lib/run');
const battery = require('../scripts/scenario-battery.js');

test('the importer keeps what a method demands of the Pokemon', () => {
	const importer = require('../scripts/import-oracle.js');
	const decomp = fs.mkdtempSync(path.join(os.tmpdir(), 'decomp-'));
	fs.mkdirSync(path.join(decomp, 'species'));
	fs.writeFileSync(path.join(decomp, 'species', 'evolution.h'), [
		'[SPECIES_TYROGUE] = {{EVO_LEVEL_ATK_LT_DEF, 20, SPECIES_HITMONCHAN},',
		'                     {EVO_LEVEL_ATK_GT_DEF, 20, SPECIES_HITMONLEE},',
		'                     {EVO_LEVEL_ATK_EQ_DEF, 20, SPECIES_HITMONTOP}},',
		'[SPECIES_COMBEE] = {{EVO_LEVEL_FEMALE, 21, SPECIES_VESPIQUEN}},',
		'[SPECIES_ZIGZAGOON] = {{EVO_LEVEL, 20, SPECIES_LINOONE}},',
	].join('\n'));
	const problems = [];
	const out = importer.importEvolutions(decomp, problems);
	assert.deepEqual(problems, []);
	assert.deepEqual(out.Tyrogue.map(step => [step.into, step.method, step.level, step.requires]), [
		['Hitmonchan', 'level', 20, 'atk<def'], ['Hitmonlee', 'level', 20, 'atk>def'],
		['Hitmontop', 'level', 20, 'atk=def']]);
	assert.equal(out.Combee[0].requires, 'female', 'a gender rule is recorded, whether or not the run judges it');
	assert.equal(out.Zigzagoon[0].requires, undefined, 'a plain level evolution demands nothing more');
});

test('the shipped data carries Tyrogue\'s rule', () => {
	const rows = require('../profiles/run-and-bun/oracle/evolutions.json').Tyrogue;
	assert.deepEqual(rows.map(step => step.into + ' ' + step.requires).sort(),
		['Hitmonchan atk<def', 'Hitmonlee atk>def', 'Hitmontop atk=def']);
});

test('a Tyrogue becomes the Hitmon its Attack and Defense at 20 decide', () => {
	const tyrogue = (atk, def, nature) => dossier.evolveMon({species: 'Tyrogue', ivs: {atk, def}, nature}, 21);
	assert.equal(tyrogue(31, 0, 'Hardy'), 'Hitmonlee');
	assert.equal(tyrogue(0, 31, 'Hardy'), 'Hitmonchan');
	assert.equal(tyrogue(15, 15, 'Hardy'), 'Hitmontop', 'equal bases, equal IVs, neutral nature');
	assert.equal(tyrogue(15, 15, 'Adamant'), 'Hitmonlee', '+Atk');
	assert.equal(tyrogue(15, 15, 'Bold'), 'Hitmonchan', '+Def');
	// brkeys3-A-5's Dewford encounter: Atk 30, Def 21, Relaxed. At 20:
	// Atk floor(100 * 20 / 100) + 5 = 25; Def (floor(91 * 20 / 100) + 5) x 1.1 = 25.
	assert.equal(dossier.statAt('Tyrogue', 'atk', 20, 30, 'Relaxed'), 25);
	assert.equal(dossier.statAt('Tyrogue', 'def', 20, 21, 'Relaxed'), 25);
	assert.equal(tyrogue(30, 21, 'Relaxed'), 'Hitmontop');
	assert.equal(dossier.evolveTo('Tyrogue', 21), 'Hitmonchan', 'with no Pokemon to read, the first path');
	// The branch is judged at 20, where it happens, even for a Tyrogue that
	// stands at 30 now: Atk 0 / Def 4 ties at 20 (19 and 19) but not at 30.
	assert.equal(dossier.evolveMon({species: 'Tyrogue', ivs: {atk: 0, def: 4}, nature: 'Hardy'}, 30), 'Hitmontop');
	assert.equal(dossier.evolveMon({species: 'Zigzagoon', ivs: {}, nature: 'Hardy'}, 21), 'Linoone');
});

test('a fresh Tyrogue is Hitmonchan or Hitmonlee 44% of the time each, Hitmontop 11%', () => {
	const odds = dossier.branchOdds('Tyrogue', 20);
	assert.deepEqual(Object.keys(odds), ['Hitmonchan', 'Hitmonlee', 'Hitmontop']);
	assert.equal(odds.Hitmonchan, odds.Hitmonlee, 'equal base stats: the two sides are mirror images');
	assert.equal(Math.round(odds.Hitmontop * 25600), 2934);
	assert.ok(Math.abs(odds.Hitmonchan + odds.Hitmonlee + odds.Hitmontop - 1) < 1e-12);
	assert.deepEqual(dossier.branchOdds('Zigzagoon', 21), {Linoone: 1});
});

/** A banked box with one member turned into a level-21 Tyrogue of the given roll. */
function withTyrogue(atk, def, nature) {
	const doc = battery.loadDocument(path.join(__dirname, '..', 'fixtures', 'banked-runs', 'brkeys3-A-5.run.json'));
	const next = structuredClone(doc);
	const mon = next.box.find(entry => entry.id === 'mon-12');
	Object.assign(mon, {species: 'Tyrogue', level: 21, nature, ivs: Object.assign({}, mon.ivs, {atk, def}),
		ability: 'Guts', moves: ['Tackle', 'Fake Out']});
	return {doc: next, id: mon.id};
}

test('the evolve command takes the branch the stats decide, and refuses another', () => {
	const leeRoll = withTyrogue(31, 0, 'Hardy');
	const evolved = run.apply(leeRoll.doc, {kind: 'evolve', id: leeRoll.id});
	assert.equal(evolved.box.find(mon => mon.id === leeRoll.id).species, 'Hitmonlee', 'no into: the stats choose');
	assert.throws(() => run.apply(leeRoll.doc, {kind: 'evolve', id: leeRoll.id, into: 'Hitmonchan'}),
		/make it a Hitmonlee, not Hitmonchan/);
	const chanRoll = withTyrogue(0, 31, 'Hardy');
	assert.equal(run.apply(chanRoll.doc, {kind: 'evolve', id: chanRoll.id, into: 'Hitmonchan'})
		.box.find(mon => mon.id === chanRoll.id).species, 'Hitmonchan');
});

test('--swap-catch fields the branch the encounter\'s own roll decides', () => {
	const doc = battery.loadDocument(path.join(__dirname, '..', 'fixtures', 'banked-runs', 'brkeys3-A-5.run.json'));
	assert.equal(battery.swapCatch(doc, 'MAP_DEWFORD_TOWN:Tyrogue').swapped.fielded, 'Hitmontop',
		'the Dewford slot rolled Atk 30, Def 21, Relaxed');
});

test('the upgrade advisor offers only the evolution this Tyrogue can take', () => {
	for (const roll of [{atk: 31, def: 0, form: 'Hitmonlee'}, {atk: 0, def: 31, form: 'Hitmonchan'}]) {
		const atk = roll.atk;
		const def = roll.def;
		const form = roll.form;
		const box = withTyrogue(atk, def, 'Hardy');
		box.doc.party = [box.id].concat(box.doc.party.filter(id => id !== box.id)).slice(0, 6);
		const rows = run.adviseUpgrades(box.doc, 'Leader Brawly').upgrades
			.filter(row => row.kind === 'evolve' && row.id === box.id).map(row => row.detail);
		assert.deepEqual(rows.filter(detail => /Hitmon/.test(detail)), ['evolve into ' + form],
			'Atk ' + atk + ', Def ' + def);
	}
});
