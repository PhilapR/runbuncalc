import assert from 'node:assert/strict';
import {enumerateMoveActions} from '../actions';
import {deriveMoveResolution} from '../move-engine';
import {BattleState} from '../model';

function state(moveName: string, generation = 9): BattleState {
  return {
    generation: generation as BattleState['generation'],
    mode: 'Singles',
    turn: 2,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Pikachu', level: 100,
        hp: {current: 100, max: 100}, moves: [{name: moveName}],
      }, {
        id: 'ai-2', species: 'Raichu', level: 100,
        hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}],
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

const sleepTalk = state('Sleep Talk');
sleepTalk.sides.ai.party[0].status = 'slp';
assert.equal(enumerateMoveActions(sleepTalk, 'ai').some(action => action.moveName === 'Sleep Talk'), false);
assert.equal(deriveMoveResolution(sleepTalk, move('Sleep Talk', ['ai-1']), {hit: true}).hit, false);
sleepTalk.sides.ai.party[0].moves.push({name: 'Tackle'});
assert.equal(enumerateMoveActions(sleepTalk, 'ai').some(action => action.moveName === 'Sleep Talk'), true);

const meFirst = state('Me First', 7);
assert.equal(enumerateMoveActions(meFirst, 'ai').some(action => action.moveName === 'Me First'), false);
meFirst.selectedMoveByPokemon = {'player-1': {moveName: 'Tackle'}};
assert.equal(enumerateMoveActions(meFirst, 'ai').some(action => action.moveName === 'Me First'), true);
meFirst.selectedMoveByPokemon = {'player-1': {moveName: 'Protect'}};
assert.equal(enumerateMoveActions(meFirst, 'ai').some(action => action.moveName === 'Me First'), false);

const assist = state('Assist', 7);
assist.sides.ai.activeIds = ['ai-1'];
assist.sides.ai.party[1].moves = [{name: 'Transform'}];
assert.equal(enumerateMoveActions(assist, 'ai').some(action => action.moveName === 'Assist'), false);
assist.sides.ai.party[1].moves = [{name: 'Tackle'}];
assert.equal(enumerateMoveActions(assist, 'ai').some(action => action.moveName === 'Assist'), true);

const metronome = state('Metronome');
assert.equal(enumerateMoveActions(metronome, 'ai').some(action => action.moveName === 'Metronome'), true);

console.log('Call legality fixtures passed');
