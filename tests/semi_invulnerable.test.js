/* eslint-env node, es6 */
'use strict';

/**
 * Gate for the semi-invulnerable states: each is reached by its own moves.
 * One list served them all, so Gust struck a Pokemon underground and
 * Earthquake missed one there, and nothing hit for double. Fisherman Darian's
 * Choice Band Bounce Magikarp (fight #7) is where a player reaches for Gust.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const ai = require('../ai');
const planner = require('../lib/planner');

const IVS = {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31};

function damageInto(moveName, charge) {
	const lead = {species: 'Pidgey', level: 12, nature: 'Hardy', ability: 'Keen Eye', item: null,
		moves: ['Gust', 'Tackle', 'Earthquake', 'Surf'], ivs: IVS};
	let state = planner.buildFightState({trainer: 'Fisherman Darian', playerParty: [lead],
		profileId: 'run-and-bun'}).state;
	const foe = state.sides.ai.activeIds[0];
	const me = state.sides.player.activeIds[0];
	if (charge) {
		state = Object.assign({}, state, {sides: Object.assign({}, state.sides, {ai: Object.assign({}, state.sides.ai, {
			party: state.sides.ai.party.map(mon => mon.id !== foe ? mon : Object.assign({}, mon,
				{volatile: Object.assign({}, mon.volatile, {charge: {moveName: charge, targetIds: [me]}})})),
		})})});
	}
	const facts = ai.calculateActionFacts(state, {kind: 'move', actorId: me, moveName, targetIds: [foe]});
	const damage = (facts.damageByTarget && facts.damageByTarget[foe]) || facts.damage;
	return damage.max;
}

test('each hidden state is reached by its own moves, some for double', () => {
	const gust = damageInto('Gust');
	assert.ok(gust > 0);
	assert.equal(damageInto('Gust', 'Bounce'), gust * 2, 'Gust into the air is doubled');
	assert.equal(damageInto('Gust', 'Dig'), 0, 'Gust does not reach underground');
	assert.equal(damageInto('Gust', 'Dive'), 0);
	assert.equal(damageInto('Tackle', 'Bounce'), 0, 'a plain move does not reach the air');
	const quake = damageInto('Earthquake');
	assert.ok(quake > 0);
	assert.equal(damageInto('Earthquake', 'Dig'), quake * 2, 'Earthquake underground is doubled');
	assert.equal(damageInto('Earthquake', 'Fly'), 0);
	const surf = damageInto('Surf');
	assert.equal(damageInto('Surf', 'Dive'), surf * 2, 'Surf into the water is doubled');
	assert.equal(damageInto('Surf', 'Phantom Force'), 0);
});

test('a hiding foe that moves first is priced where it will be, behind a switch', () => {
	// Magikarp (Speed 27) outruns Pidgey (21) and Bounces: Tackle lands on
	// nothing this turn, Gust lands for double. Off, the list prices the
	// ground as it stands.
	const driver = require('../lib/battle-driver.js');
	const lead = {species: 'Pidgey', level: 12, nature: 'Hardy', ability: 'Keen Eye', item: null,
		moves: ['Gust', 'Tackle'], ivs: IVS};
	const state = planner.buildFightState({trainer: 'Fisherman Darian', playerParty: [lead],
		profileId: 'run-and-bun'}).state;
	const priced = () => {
		const out = {};
		for (const entry of driver.legalActions(state)) if (entry.kind === 'move') out[entry.move] = entry.damage.max;
		return out;
	};
	const ground = priced();
	try {
		driver.setHidingForecast(true);
		const air = priced();
		assert.equal(air.Tackle, 0, 'Tackle into the air');
		assert.ok(air.Gust >= ground.Gust * 2 - 1, 'Gust into the air: ' + air.Gust + ' vs ' + ground.Gust);
	} finally {
		driver.setHidingForecast(false);
	}
	assert.ok(ground.Tackle > 0);
});

test('races read the engine Speed behind a switch; off, they read the old zero', () => {
	// Off, every Speed read 0 and no body was ever "faster". A Level 30
	// Starly outruns Bug Catcher Rick's lead by any count.
	const driver = require('../lib/battle-driver.js');
	const lead = {species: 'Pidgey', level: 12, nature: 'Hardy', ability: 'Keen Eye', item: null,
		moves: ['Gust', 'Tackle'], ivs: IVS};
	const bench = {species: 'Starly', level: 30, nature: 'Hardy', ability: 'Keen Eye', item: null,
		moves: ['Wing Attack', 'Growl'], ivs: IVS};
	const state = planner.buildFightState({trainer: 'Bug Catcher Rick', playerParty: [lead, bench],
		profileId: 'run-and-bun'}).state;
	const starly = state.sides.player.party.find(mon => mon.species === 'Starly').id;
	assert.equal(driver.benchRace(state, starly).faster, false, 'the old zero');
	try {
		driver.setRealSpeed(true);
		const before = driver.realSpeedReads();
		assert.equal(driver.benchRace(state, starly).faster, true, 'faster on the engine Speed');
		assert.ok(driver.realSpeedReads() > before, 'the switch served the read');
	} finally {
		driver.setRealSpeed(false);
	}
});
