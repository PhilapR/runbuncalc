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
