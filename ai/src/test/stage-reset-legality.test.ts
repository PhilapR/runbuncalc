import assert from 'node:assert/strict';
import {enumerateMoveActions} from '../actions';
import {deriveMoveResolution} from '../move-engine';
import {BattleState, MoveAction} from '../model';

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
  return {kind: 'move' as const, actorId: 'ai-1', moveName, targetIds: ['ai-1', 'player-1']};
}

const haze = state('Haze');
assert.equal(enumerateMoveActions(haze, 'ai').some((action: MoveAction) => action.moveName === 'Haze'), false);
assert.equal(deriveMoveResolution(haze, move('Haze'), {hit: true}).hit, false);
haze.sides.player.party[0].boosts = {atk: 2};
assert.equal(enumerateMoveActions(haze, 'ai').some((action: MoveAction) => action.moveName === 'Haze'), true);

const topsy = state('Topsy-Turvy');
topsy.sides.ai.party[0].moves = [{name: 'Topsy-Turvy'}];
topsy.sides.player.party[0].boosts = {};
const topsyMove = {...move('Topsy-Turvy'), targetIds: ['player-1']};
assert.equal(enumerateMoveActions(topsy, 'ai').some((action: MoveAction) => action.moveName === 'Topsy-Turvy'), false);
assert.equal(deriveMoveResolution(topsy, topsyMove, {hit: true}).hit, false);
topsy.sides.player.party[0].boosts = {spe: -2};
assert.equal(enumerateMoveActions(topsy, 'ai').some((action: MoveAction) => action.moveName === 'Topsy-Turvy'), true);

const damaging = state('Clear Smog');
damaging.sides.ai.party[0].moves = [{name: 'Clear Smog'}];
assert.equal(enumerateMoveActions(damaging, 'ai').some((action: MoveAction) => action.moveName === 'Clear Smog'), true);

console.log('Stage reset legality fixtures passed');
