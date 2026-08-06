import assert from 'node:assert/strict';
import {enumerateMoveActions} from '../actions';
import {deriveMoveResolution} from '../move-engine';
import {BattleState, MoveAction} from '../model';

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

function move(moveName: string, targetIds = ['player-1']) {
  return {kind: 'move' as const, actorId: 'ai-1', moveName, targetIds};
}

const fullRecovery = state();
fullRecovery.sides.ai.party[0].moves = [{name: 'Recover'}];
assert.equal(enumerateMoveActions(fullRecovery, 'ai').some((action: MoveAction) => action.moveName === 'Recover'), false);
assert.equal(deriveMoveResolution(fullRecovery, move('Recover', ['ai-1']), {hit: true}).hit, false);
fullRecovery.sides.ai.party[0].hp.current = 99;
assert.equal(enumerateMoveActions(fullRecovery, 'ai').some((action: MoveAction) => action.moveName === 'Recover'), true);

const refresh = state();
refresh.sides.ai.party[0].moves = [{name: 'Refresh'}];
assert.equal(enumerateMoveActions(refresh, 'ai').some((action: MoveAction) => action.moveName === 'Refresh'), false);
assert.equal(deriveMoveResolution(refresh, move('Refresh', ['ai-1']), {hit: true}).hit, false);
refresh.sides.ai.party[0].status = 'psn';
assert.equal(enumerateMoveActions(refresh, 'ai').some((action: MoveAction) => action.moveName === 'Refresh'), true);

const purify = state();
purify.mode = 'Doubles';
purify.sides.ai.activeIds = ['ai-1', 'ai-2'];
purify.sides.ai.party.push({
  id: 'ai-2', species: 'Bulbasaur', level: 100,
  hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}],
});
purify.sides.ai.party[0].moves = [{name: 'Purify'}];
assert.equal(enumerateMoveActions(purify, 'ai').some((action: MoveAction) => action.moveName === 'Purify'), false);
assert.equal(deriveMoveResolution(purify, move('Purify', ['ai-2']), {hit: true}).hit, false);
purify.sides.ai.party[1].status = 'tox';
assert.equal(enumerateMoveActions(purify, 'ai').some((action: MoveAction) => action.moveName === 'Purify'), true);

const painSplit = state();
painSplit.sides.ai.party[0].moves = [{name: 'Pain Split'}];
assert.equal(enumerateMoveActions(painSplit, 'ai').some((action: MoveAction) => action.moveName === 'Pain Split'), false);
assert.equal(deriveMoveResolution(painSplit, move('Pain Split'), {hit: true}).hit, false);
painSplit.sides.player.party[0].hp.current = 50;
assert.equal(enumerateMoveActions(painSplit, 'ai').some((action: MoveAction) => action.moveName === 'Pain Split'), true);

const lifeDew = state();
lifeDew.sides.ai.party[0].moves = [{name: 'Life Dew'}];
assert.equal(enumerateMoveActions(lifeDew, 'ai').some((action: MoveAction) => action.moveName === 'Life Dew'), false);
assert.equal(deriveMoveResolution(lifeDew, move('Life Dew', ['ai-1']), {hit: true}).hit, false);
lifeDew.sides.ai.party[0].hp.current = 50;
assert.equal(enumerateMoveActions(lifeDew, 'ai').some((action: MoveAction) => action.moveName === 'Life Dew'), true);

const cleanse = state();
cleanse.sides.ai.party[0].moves = [{name: 'Aromatherapy'}, {name: 'Heal Bell'}];
assert.equal(enumerateMoveActions(cleanse, 'ai').some((action: MoveAction) => action.moveName === 'Aromatherapy'), false);
assert.equal(enumerateMoveActions(cleanse, 'ai').some((action: MoveAction) => action.moveName === 'Heal Bell'), false);
cleanse.sides.ai.party[0].status = 'brn';
assert.equal(enumerateMoveActions(cleanse, 'ai').some((action: MoveAction) => action.moveName === 'Aromatherapy'), true);

console.log('Support legality fixtures passed');
