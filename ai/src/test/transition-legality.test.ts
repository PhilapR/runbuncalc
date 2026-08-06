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

for (const moveName of ['Healing Wish', 'Lunar Dance']) {
  const noReplacement = state();
  noReplacement.sides.ai.party[0].moves = [{name: moveName}];
  assert.equal(enumerateMoveActions(noReplacement, 'ai').some(action => action.moveName === moveName), false);
  assert.equal(deriveMoveResolution(noReplacement, move(moveName), {hit: true}).hit, false);

  const replacementAvailable = state();
  replacementAvailable.sides.ai.party[0].moves = [{name: moveName}];
  replacementAvailable.sides.ai.party.push({
    id: 'ai-2', species: 'Bulbasaur', level: 100,
    hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}],
  });
  assert.equal(enumerateMoveActions(replacementAvailable, 'ai').some(action => action.moveName === moveName), true);
}

const shedTailNoReplacement = state();
shedTailNoReplacement.sides.ai.party[0].moves = [{name: 'Shed Tail'}];
shedTailNoReplacement.sides.ai.party[0].hp.current = 75;
assert.equal(enumerateMoveActions(shedTailNoReplacement, 'ai').some(action => action.moveName === 'Shed Tail'), false);
assert.equal(deriveMoveResolution(shedTailNoReplacement, move('Shed Tail'), {hit: true}).hit, false);

const shedTailWithReplacement = state();
shedTailWithReplacement.sides.ai.party[0].moves = [{name: 'Shed Tail'}];
shedTailWithReplacement.sides.ai.party[0].hp.current = 75;
shedTailWithReplacement.sides.ai.party.push({
  id: 'ai-2', species: 'Bulbasaur', level: 100,
  hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}],
});
assert.equal(enumerateMoveActions(shedTailWithReplacement, 'ai').some(action => action.moveName === 'Shed Tail'), true);

const psychoShift = state();
psychoShift.sides.ai.party[0].moves = [{name: 'Psycho Shift'}];
assert.equal(enumerateMoveActions(psychoShift, 'ai').some(action => action.moveName === 'Psycho Shift'), false);
assert.equal(deriveMoveResolution(psychoShift, move('Psycho Shift'), {hit: true}).hit, false);
psychoShift.sides.ai.party[0].status = 'brn';
assert.equal(enumerateMoveActions(psychoShift, 'ai').some(action => action.moveName === 'Psycho Shift'), true);
const psychoShiftResolution = deriveMoveResolution(psychoShift, move('Psycho Shift'), {hit: true});
assert.equal(psychoShiftResolution.statusByPokemon?.['ai-1'], '');
assert.equal(psychoShiftResolution.statusByPokemon?.['player-1'], 'brn');

console.log('Transition legality fixtures passed');
