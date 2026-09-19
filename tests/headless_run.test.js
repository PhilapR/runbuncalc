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

test('a headless run plays the project\'s rules: one per route, the dupes clause by line, caps', () => {
	const doc = headless.startRun({species: 'Turtwig', rival: 'Blaziken'}, headless.dice(1000));
	assert.deepEqual([doc.rules.onePerRoute, doc.rules.permadeath, doc.rules.dupesClause, doc.rules.levelCap],
		[true, false, 'line', 'next-milestone-ace']);
	assert.deepEqual(doc.party, [doc.box[0].id], 'the starter is caught and fielded');
});

test('the harness teaches the priority answer a threshold fight demands', () => {
	// Sweep-3 run 5 (seed 523658) as it stalled at Aqua Admin Shelly: her
	// Mienshao holds a Focus Sash with Reversal and the party had no
	// priority attack; the library names Manectric's Quick Attack.
	const run = require('../lib/run.js');
	const doc = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..',
		'fixtures', 'banked-runs', 'headless-shelly-523658.run.json'), 'utf8'));
	const prep = run.preFightOpportunities(doc).thresholdPrep;
	assert.deepEqual(prep.threats.map(threat => threat.species + ' ' + threat.move + ' ' + threat.holds),
		['Mienshao Reversal Focus Sash']);
	assert.equal(prep.covered, false);
	const tally = {scaleSpends: 0};
	const taught = headless.thresholdPrep(doc, tally);
	assert.equal(tally.thresholdTeaches, 1);
	const row = prep.teachable[0];
	assert.ok(taught.box.find(mon => mon.id === row.id).moves.includes(row.move), row.species + ' learned ' + row.move);
	assert.ok(run.preFightOpportunities(taught).thresholdPrep.covered, 'and the demand is met');
	assert.equal(headless.thresholdPrep(taught, tally), taught, 'a met demand teaches nothing more');
});

test('the harness claims each Game Corner prize its badges have opened, once', () => {
	const doc = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..',
		'fixtures', 'banked-runs', 'headless-shelly-523658.run.json'), 'utf8'));
	const tiers = require('../profiles/run-and-bun/oracle/sources.json').gameCorner.tiers;
	const open = tiers.filter(tier => tier.opensAt !== null && tier.opensAt <= doc.position);
	const tally = {};
	const claimed = headless.claimPrizes(doc, headless.dice(5), tally);
	assert.equal(tally.prizes, open.length, 'one prize per badge earned by #' + doc.position);
	const prizes = claimed.log.filter(entry => entry.command.kind === 'catch' && entry.command.prize);
	assert.deepEqual(prizes.map(entry => entry.command.prize), open.map(tier => tier.badge));
	for (const entry of prizes) {
		const tier = tiers.find(row => row.badge === entry.command.prize);
		assert.ok(tier.options.includes(entry.command.species), entry.command.species + ' is a ' + tier.badge + ' prize');
	}
	assert.equal(headless.claimPrizes(claimed, headless.dice(6), {}).box.length, claimed.box.length, 'never twice');
	const fresh = headless.startRun({species: 'Turtwig', rival: 'Blaziken'}, headless.dice(1));
	assert.equal(headless.claimPrizes(fresh, headless.dice(2), {}).box.length, fresh.box.length, 'no badge, no prize');
});

test('the harness keeps catching past 24: a PC has no cap', () => {
	const doc = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..',
		'fixtures', 'banked-runs', 'headless-shelly-523658.run.json'), 'utf8'));
	assert.ok(doc.box.length >= 24, 'the stalled box is at the old cap: ' + doc.box.length);
	const tally = {catches: 0, keyRolls: 0};
	const swept = headless.sweepCatches(doc, new Set(), headless.dice(3), headless.armFlags(''), tally);
	assert.ok(swept.box.length > doc.box.length, 'open routes are still caught on: ' + swept.box.length);
});

test('the harness relearns clear level-up upgrades and keeps what raw power misreads', () => {
	// The Norman stall box with one Cufant from Granite Cave B1F, levelled to
	// 42 as a Copperajah still knowing Tackle, Growl, Rock Throw, Rock Smash.
	const doc = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..',
		'fixtures', 'banked-runs', 'headless-norman-cufant.run.json'), 'utf8'));
	const policy = require('../scripts/ui-playthrough.js');
	const tally = {};
	const after = headless.relearn(doc, policy, tally);
	const copperajah = after.box.find(mon => mon.species === 'Copperajah');
	assert.ok(copperajah.moves.includes('Iron Head'), 'a STAB upgrade: ' + copperajah.moves.join('/'));
	assert.ok(tally.relearned > 0);
	for (const mon of doc.box) {
		const now = after.box.find(entry => entry.id === mon.id);
		for (const move of mon.moves) {
			if (policy.isSlowControl(move)) assert.ok(now.moves.includes(move), mon.species + ' keeps ' + move);
		}
	}
});

test('the policy never presses Focus Punch into an attack, and breaks a sash with a multi-hit move', () => {
	const policy = require('../scripts/ui-playthrough.js');
	const move = (name, low, high) => ({move: name, ball: null, label: name, title: name,
		damage: low + '%+ up to ' + high + '%'});
	const attacked = {threat: 'Their hardest hit: Tri Attack 89%', foeHp: 13, foeItem: null, foeAbility: null,
		moves: [move('Focus Punch', 87, 104), move('Flare Blitz', 40, 48)]};
	assert.equal(policy.bestMove(attacked).move, 'Flare Blitz', 'Focus Punch moves last and is hit first');
	assert.equal(policy.bestMove(Object.assign({}, attacked, {threat: ''})).move, 'Focus Punch',
		'against a foe with no attack it lands');
	const sashed = {threat: 'Their hardest hit: Earthquake 90%', foeHp: 100, foeItem: 'Focus Sash', foeAbility: null,
		moves: [move('Ice Beam', 80, 95), move('Bullet Seed', 20, 60)]};
	assert.equal(policy.bestMove(sashed).move, 'Bullet Seed', 'the sash breaks to a multi-hit move');
	assert.equal(policy.bestMove(Object.assign({}, sashed, {foeHp: 60})).move, 'Ice Beam', 'a broken sash is no reason');
	assert.equal(policy.bestMove(Object.assign({}, sashed, {foeItem: null, foeAbility: 'Sturdy'})).move, 'Bullet Seed');
});
