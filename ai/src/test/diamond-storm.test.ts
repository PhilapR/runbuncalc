import assert from 'node:assert/strict';
import {enumerateMoveActions} from '../actions';
import {deriveMoveResolution} from '../move-engine';
import {BattleState} from '../model';
import {validateMoveResolution} from '../validation';

function state(): BattleState {
  return {
    generation: 9,
    mode: 'Singles',
    turn: 1,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Diancie', level: 100,
        hp: {current: 100, max: 100}, moves: [{name: 'Diamond Storm', pp: 5, maxPP: 5}],
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Rattata', level: 100,
        hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}],
      }]},
    },
  };
}

const fixture = state();
const action = enumerateMoveActions(fixture, 'ai')[0];
assert.equal(action.moveName, 'Diamond Storm');
const boosted = deriveMoveResolution(fixture, action, {hit: true, random: () => 0});
assert.equal(boosted.boostsByPokemon?.['ai-1']?.def, 2);
assert.equal(boosted.trace?.secondaryRolls?.['player-1:0'], 0);
assert.doesNotThrow(() => validateMoveResolution(fixture, action, boosted));

const missed = deriveMoveResolution(fixture, action, {hit: true, random: () => 0.99});
assert.equal(missed.boostsByPokemon?.['ai-1'], undefined);
assert.equal(missed.trace?.secondaryRolls?.['player-1:0'], 0.99);
assert.doesNotThrow(() => validateMoveResolution(fixture, action, missed));

const preGen6 = state();
preGen6.generation = 5;
assert.equal(enumerateMoveActions(preGen6, 'ai').some(candidate => candidate.moveName === 'Diamond Storm'), false);
assert.equal(deriveMoveResolution(preGen6, {
  kind: 'move', actorId: 'ai-1', moveName: 'Diamond Storm', targetIds: ['player-1'],
}, {hit: true}).hit, false);

console.log('Diamond Storm fixtures passed');
