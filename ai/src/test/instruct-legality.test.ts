import assert from 'node:assert/strict';
import {enumerateMoveActions} from '../actions';
import {deriveMoveResolution} from '../move-engine';
import {BattleState} from '../model';

function state(): BattleState {
  return {
    generation: 9,
    mode: 'Doubles',
    turn: 2,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1', 'ai-2'], party: [
        {id: 'ai-1', species: 'Pikachu', level: 100, hp: {current: 100, max: 100}, moves: [{name: 'Instruct'}]},
        {id: 'ai-2', species: 'Raichu', level: 100, hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}]},
      ]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Rattata', level: 100,
        hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}],
      }]},
    },
  };
}

function move() {
  return {kind: 'move' as const, actorId: 'ai-1', moveName: 'Instruct', targetIds: ['ai-2']};
}

const missing = state();
assert.equal(enumerateMoveActions(missing, 'ai').some(action => action.moveName === 'Instruct'), false);
assert.equal(deriveMoveResolution(missing, move(), {hit: true}).hit, false);

const valid = state();
valid.lastMoveUsedByPokemon = {'ai-2': 'Tackle'};
assert.equal(enumerateMoveActions(valid, 'ai').some(action => action.moveName === 'Instruct'), true);

const blocked = state();
blocked.lastMoveUsedByPokemon = {'ai-2': 'Metronome'};
assert.equal(enumerateMoveActions(blocked, 'ai').some(action => action.moveName === 'Instruct'), false);

const spent = state();
spent.lastMoveUsedByPokemon = {'ai-2': 'Tackle'};
spent.sides.ai.party[1].moves[0].pp = 0;
assert.equal(enumerateMoveActions(spent, 'ai').some(action => action.moveName === 'Instruct'), false);

console.log('Instruct legality fixtures passed');
