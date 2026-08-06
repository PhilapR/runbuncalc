import assert from 'node:assert/strict';
import {enumerateMoveActions} from '../actions';
import {deriveMoveResolution} from '../move-engine';
import {BattleState} from '../model';

function state(moveName: string): BattleState {
  return {
    generation: 9,
    mode: 'Singles',
    turn: 2,
    field: {},
    lastMoveUsed: undefined,
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Pikachu', level: 100,
        hp: {current: 100, max: 100}, moves: [{name: moveName}],
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Rattata', level: 100,
        hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}],
      }]},
    },
  };
}

function move(moveName: string, targetIds = ['player-1']) {
  return {kind: 'move' as const, actorId: 'ai-1', moveName, targetIds};
}

const copycat = state('Copycat');
assert.equal(enumerateMoveActions(copycat, 'ai').some(action => action.moveName === 'Copycat'), false);
assert.equal(deriveMoveResolution(copycat, move('Copycat', ['ai-1']), {hit: true}).hit, false);
copycat.lastMoveUsed = 'Tackle';
assert.equal(enumerateMoveActions(copycat, 'ai').some(action => action.moveName === 'Copycat'), true);

const mirror = state('Mirror Move');
mirror.lastMoveTargetedByPokemon = {'ai-1': 'Tackle'};
assert.equal(enumerateMoveActions(mirror, 'ai').some(action => action.moveName === 'Mirror Move'), true);
mirror.lastMoveTargetedByPokemon = {'ai-1': 'Metronome'};
assert.equal(enumerateMoveActions(mirror, 'ai').some(action => action.moveName === 'Mirror Move'), false);

for (const moveName of ['Mimic', 'Sketch']) {
  const copied = state(moveName);
  copied.lastMoveUsedByPokemon = {'player-1': 'Tackle'};
  assert.equal(enumerateMoveActions(copied, 'ai').some(action => action.moveName === moveName), true);
  copied.sides.ai.party[0].moves = [{name: moveName}, {name: 'Tackle'}];
  assert.equal(enumerateMoveActions(copied, 'ai').some(action => action.moveName === moveName), false);
}

console.log('Copy legality fixtures passed');
