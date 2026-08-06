import assert from 'node:assert/strict';
import {enumerateMoveActions} from '../actions';
import {deriveMoveResolution} from '../move-engine';
import {BattleState} from '../model';

function state(moveName: string): BattleState {
  return {
    generation: 9,
    mode: 'Singles',
    turn: 1,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Pikachu', level: 100,
        hp: {current: 100, max: 100}, moves: [{name: moveName}],
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Pikachu', level: 100,
        hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}],
      }]},
    },
  };
}

function move(moveName: string, targetIds = ['player-1']) {
  return {kind: 'move' as const, actorId: 'ai-1', moveName, targetIds};
}

for (const moveName of ['Speed Swap', 'Guard Split', 'Power Split']) {
  const repeated = state(moveName);
  assert.equal(enumerateMoveActions(repeated, 'ai').some(action => action.moveName === moveName), false);
  assert.equal(deriveMoveResolution(repeated, move(moveName), {hit: true}).hit, false);
  repeated.sides.player.party[0].species = 'Rattata';
  assert.equal(enumerateMoveActions(repeated, 'ai').some(action => action.moveName === moveName), true);
}

const heartSwap = state('Heart Swap');
heartSwap.sides.ai.party[0].moves = [{name: 'Heart Swap'}];
assert.equal(enumerateMoveActions(heartSwap, 'ai').some(action => action.moveName === 'Heart Swap'), false);
assert.equal(deriveMoveResolution(heartSwap, move('Heart Swap'), {hit: true}).hit, false);
heartSwap.sides.player.party[0].boosts = {atk: 2};
assert.equal(enumerateMoveActions(heartSwap, 'ai').some(action => action.moveName === 'Heart Swap'), true);

for (const moveName of ['Power Trick', 'Power Shift']) {
  const repeated = state(moveName);
  repeated.sides.ai.party[0].moves = [{name: moveName}];
  repeated.sides.ai.party[0].statOverrides = {atk: 100, def: 100};
  assert.equal(enumerateMoveActions(repeated, 'ai').some(action => action.moveName === moveName), false);
  assert.equal(deriveMoveResolution(repeated, move(moveName, ['ai-1']), {hit: true}).hit, false);
  repeated.sides.ai.party[0].statOverrides = {atk: 120, def: 100};
  assert.equal(enumerateMoveActions(repeated, 'ai').some(action => action.moveName === moveName), true);
}

console.log('Stat transfer legality fixtures passed');
