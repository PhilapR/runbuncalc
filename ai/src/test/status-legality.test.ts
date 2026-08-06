import assert from 'node:assert/strict';
import {enumerateMoveActions} from '../actions';
import {deriveMoveResolution} from '../move-engine';
import {BattleState} from '../model';

function state(): BattleState {
  return {
    generation: 9,
    mode: 'Singles',
    turn: 1,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Pikachu', level: 100,
        hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}],
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

const historyState = state();
historyState.sides.ai.party[0].moves = [{name: 'Encore'}, {name: 'Disable'}];
assert.equal(enumerateMoveActions(historyState, 'ai').some(action => action.moveName === 'Encore'), false);
assert.equal(enumerateMoveActions(historyState, 'ai').some(action => action.moveName === 'Disable'), false);
assert.equal(deriveMoveResolution(historyState, move('Encore'), {hit: true}).hit, false);
historyState.lastMoveByPokemon = {'player-1': 'Tackle'};
assert.equal(enumerateMoveActions(historyState, 'ai').some(action => action.moveName === 'Encore'), true);
assert.equal(enumerateMoveActions(historyState, 'ai').some(action => action.moveName === 'Disable'), true);
historyState.sides.player.party[0].volatile = {encore: {turns: 3, moveName: 'Tackle'}};
assert.equal(enumerateMoveActions(historyState, 'ai').some(action => action.moveName === 'Encore'), false);

const repeatVolatileState = state();
repeatVolatileState.sides.ai.party[0].moves = [
  {name: 'Taunt'}, {name: 'Torment'}, {name: 'Leech Seed'}, {name: 'Perish Song'},
  {name: 'Foresight'}, {name: 'Electrify'}, {name: 'Miracle Eye'}, {name: 'Embargo'}, {name: 'Heal Block'},
];
repeatVolatileState.sides.player.party[0].volatile = {
  taunt: {turns: 3}, torment: {}, leechSeed: {}, perishSong: {turns: 3}, foresight: {},
  electrified: {turns: 1}, miracleEye: {}, embargo: {turns: 5}, healBlock: {turns: 5},
};
repeatVolatileState.sides.ai.party[0].volatile = {perishSong: {turns: 3}};
for (const moveName of repeatVolatileState.sides.ai.party[0].moves.map(candidate => candidate.name)) {
  assert.equal(enumerateMoveActions(repeatVolatileState, 'ai').some(action => action.moveName === moveName), false);
  assert.equal(deriveMoveResolution(repeatVolatileState, move(moveName), {hit: true}).hit, false);
}

const trappedStatusState = state();
trappedStatusState.sides.ai.party[0].moves = [{name: 'Octolock'}, {name: 'Mean Look'}, {name: 'Gastro Acid'}];
trappedStatusState.sides.player.party[0].volatile = {trapped: {},};
trappedStatusState.sides.player.party[0].abilitySuppressed = true;
for (const moveName of ['Octolock', 'Mean Look', 'Gastro Acid']) {
  assert.equal(enumerateMoveActions(trappedStatusState, 'ai').some(action => action.moveName === moveName), false);
  assert.equal(deriveMoveResolution(trappedStatusState, move(moveName), {hit: true}).hit, false);
}

console.log('Status legality fixtures passed');
