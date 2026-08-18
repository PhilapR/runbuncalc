/* eslint-env node, es6 */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const calc = require('@smogon/calc');
const ai = require('../ai');

global.calc = calc;
const bridge = require('../src/js/sets_to_battle_state.js');

test('sets bridge rebuilds Gen 8 zero-EV Pokémon and emits valid BattleState', () => {
	const gen = calc.Generations.get(8);
	const source = new calc.Pokemon(gen, 'Gyarados', {
		level: 50,
		ability: 'Intimidate',
		item: 'Lum Berry',
		nature: 'Jolly',
		evs: {hp: 252, atk: 252, spe: 4},
		moves: ['Waterfall', 'Earthquake', 'Dragon Dance', 'Ice Fang'],
	});
	const ratio = 1;
	const rebuilt = bridge.rebuildZeroEvPokemon(source, ratio);
	assert.equal(rebuilt.evs.hp, 0);
	assert.equal(rebuilt.evs.atk, 0);
	assert.ok(rebuilt.maxHP(true) < source.maxHP(true));

	const player = bridge.pokemonStateFromCalcPokemon(rebuilt, 'player-1');
	const aiMon = bridge.pokemonStateFromCalcPokemon(new calc.Pokemon(gen, 'Pikachu', {
		level: 50,
		ability: 'Static',
		moves: ['Thunderbolt', 'Volt Switch'],
		evs: {hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0},
	}), 'ai-1');

	assert.deepEqual(player.evs, bridge.ZERO_EVS);
	assert.equal(player.species, 'Gyarados');
	assert.equal(player.moves[0].name, 'Waterfall');

	const state = bridge.buildBattleState({
		playerActive: player,
		aiActive: aiMon,
		aiBench: [{
			id: 'tmp',
			species: 'Heatran',
			level: 50,
			hp: {current: 160, max: 160},
			moves: [{name: 'Magma Storm'}],
			evs: bridge.ZERO_EVS,
		}],
	});

	assert.equal(state.generation, 8);
	assert.equal(state.mode, 'Singles');
	assert.equal(state.sides.ai.party.length, 2);
	assert.equal(state.sides.ai.party[1].id, 'ai-2');
	assert.deepEqual(state.firstTurnOutIds, ['ai-1', 'player-1']);
	assert.doesNotThrow(() => ai.validateBattleState(state));
});

test('sets bridge keeps duplicate-species bench members on the party', () => {
	// Two Zigzagoon on one team are two party members. The bench dedupe used
	// to key on species, which dropped the twin — and under permadeath a
	// missing party slot means the WRONG mon can be recorded as the death.
	const mon = (id, species) => ({
		id,
		species,
		level: 12,
		hp: {current: 40, max: 40},
		moves: [{name: 'Tackle'}],
		evs: bridge.ZERO_EVS,
	});
	const state = bridge.buildBattleState({
		playerActive: mon('player-1', 'Zigzagoon'),
		playerBench: [mon('player-2', 'Zigzagoon'), mon('player-3', 'Poochyena')],
		aiActive: mon('ai-1', 'Whismur'),
		aiBench: [mon('ai-2', 'Whismur')],
	});
	assert.equal(state.sides.player.party.length, 3);
	assert.deepEqual(
		state.sides.player.party.map(entry => entry.species),
		['Zigzagoon', 'Zigzagoon', 'Poochyena']);
	// Bench ids are reassigned positionally; the roster mapping relies on
	// nothing being dropped, so the count and order are the contract.
	assert.deepEqual(
		state.sides.player.party.map(entry => entry.id),
		['player-1', 'player-2', 'player-3']);
	assert.equal(state.sides.ai.party.length, 2);
	// The active itself arriving again via the bench is still skipped.
	const active = mon('player-1', 'Zigzagoon');
	const again = bridge.buildBattleState({
		playerActive: active,
		playerBench: [active, mon('player-2', 'Poochyena')],
		aiActive: mon('ai-1', 'Whismur'),
	});
	assert.equal(again.sides.player.party.length, 2);
});

test('sets bridge parses trainer-style set labels', () => {
	assert.deepEqual(bridge.parseSetLabel('[12]Gyarados (Leader Winona)'), {
		species: 'Gyarados',
		setName: 'Leader Winona',
	});
	assert.deepEqual(bridge.parseSetLabel('Pikachu (Custom Import)'), {
		species: 'Pikachu',
		setName: 'Custom Import',
	});
});

test('sets bridge surfaces Gen 8 and zero-EV projection callouts', () => {
	const callouts = bridge.projectionCallouts();
	assert.ok(Array.isArray(callouts));
	assert.equal(callouts.length, 2);
	assert.equal(callouts[0].id, 'generation');
	assert.match(callouts[0].text, /generation 8/i);
	assert.equal(callouts[1].id, 'zero-evs');
	assert.match(callouts[1].text, /EVs are forced to 0/i);
});
