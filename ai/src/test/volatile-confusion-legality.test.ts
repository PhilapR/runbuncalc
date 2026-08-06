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
        id: 'player-1', species: 'Rattata', level: 100,
        hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}],
      }]},
    },
  };
}

function move(moveName: string) {
  return {kind: 'move' as const, actorId: 'ai-1', moveName, targetIds: ['player-1']};
}

for (const moveName of ['Confuse Ray', 'Sweet Kiss', 'Supersonic', 'Teeter Dance']) {
  const repeated = state(moveName);
  repeated.sides.player.party[0].volatile = {confusion: {turns: 2}};
  assert.equal(enumerateMoveActions(repeated, 'ai').some(action => action.moveName === moveName), false);
  assert.equal(deriveMoveResolution(repeated, move(moveName), {hit: true}).hit, false);
}

const ownTempo = state('Confuse Ray');
ownTempo.sides.player.party[0].ability = 'Own Tempo';
assert.equal(enumerateMoveActions(ownTempo, 'ai').some(action => action.moveName === 'Confuse Ray'), false);
assert.equal(deriveMoveResolution(ownTempo, move('Confuse Ray'), {hit: true}).hit, false);

const damaging = state('Chatter');
damaging.sides.player.party[0].volatile = {confusion: {turns: 2}};
assert.equal(enumerateMoveActions(damaging, 'ai').some(action => action.moveName === 'Chatter'), true);

console.log('Volatile confusion legality fixtures passed');
