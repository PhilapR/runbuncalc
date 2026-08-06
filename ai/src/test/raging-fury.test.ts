import assert from 'node:assert/strict';
import {enumerateMoveActions} from '../actions';
import {deriveMoveResolution} from '../move-engine';
import {BattleState} from '../model';
import {applyAction, beginNextTurn} from '../transition';

function state(): BattleState {
  return {
    generation: 9,
    mode: 'Singles',
    turn: 1,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Entei', level: 100,
        hp: {current: 100, max: 100}, moves: [{name: 'Raging Fury'}, {name: 'Tackle'}],
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Rattata', level: 100,
        hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}],
      }]},
    },
  };
}

const fixture = state();
const firstAction = enumerateMoveActions(fixture, 'ai').find(action => action.moveName === 'Raging Fury');
assert.ok(firstAction);
const firstResolution = deriveMoveResolution(fixture, firstAction, {hit: true, random: () => 0});
assert.deepEqual(firstResolution.volatileByPokemon?.['ai-1']?.rampage, {
  turns: 2, moveName: 'Raging Fury',
});
const locked = applyAction(fixture, firstAction, firstResolution);
assert.deepEqual(enumerateMoveActions(locked, 'ai').map(action => action.moveName), ['Raging Fury']);

const finalTurn = beginNextTurn(locked);
const finalAction = enumerateMoveActions(finalTurn, 'ai')[0];
assert.equal(finalAction?.moveName, 'Raging Fury');
const finalResolution = deriveMoveResolution(finalTurn, finalAction, {hit: true, random: () => 0});
assert.equal(finalResolution.volatileByPokemon?.['ai-1']?.rampage, null);
assert.equal(finalResolution.volatileByPokemon?.['ai-1']?.confusion?.turns, 2);

const preGen9 = state();
preGen9.generation = 8;
assert.equal(enumerateMoveActions(preGen9, 'ai').some(action => action.moveName === 'Raging Fury'), false);
assert.equal(deriveMoveResolution(preGen9, {
  kind: 'move', actorId: 'ai-1', moveName: 'Raging Fury', targetIds: ['player-1'],
}, {hit: true}).hit, false);

console.log('Raging Fury fixtures passed');
