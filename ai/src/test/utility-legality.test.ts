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

const empty = state();
empty.sides.ai.party[0].moves = [{name: 'Defog'}, {name: 'Court Change'}, {name: 'Steel Roller'}];
for (const moveName of ['Defog', 'Court Change', 'Steel Roller']) {
  assert.equal(enumerateMoveActions(empty, 'ai').some(action => action.moveName === moveName), false);
  assert.equal(deriveMoveResolution(empty, move(moveName), {hit: true}).hit, false);
}

const effectful = state();
effectful.sides.ai.party[0].moves = [{name: 'Defog'}, {name: 'Court Change'}, {name: 'Steel Roller'}];
effectful.sides.player.effects = {stealthRock: true, reflect: true};
effectful.sides.ai.effects = {lightScreen: true};
effectful.field.terrain = 'Grassy';
for (const moveName of ['Defog', 'Court Change', 'Steel Roller']) {
  assert.equal(enumerateMoveActions(effectful, 'ai').some(action => action.moveName === moveName), true);
}

const flowerShield = state();
flowerShield.generation = 8;
flowerShield.sides.ai.party[0].moves = [{name: 'Flower Shield'}];
flowerShield.sides.player.party[0].species = 'Bulbasaur';
flowerShield.sides.player.party[0].boosts = {def: 6};
assert.equal(enumerateMoveActions(flowerShield, 'ai').some(action => action.moveName === 'Flower Shield'), false);
assert.equal(deriveMoveResolution(flowerShield, move('Flower Shield'), {hit: true}).hit, false);
flowerShield.sides.player.party[0].boosts = {def: 5};
assert.equal(enumerateMoveActions(flowerShield, 'ai').some(action => action.moveName === 'Flower Shield'), true);

const rototiller = state();
rototiller.generation = 7;
rototiller.sides.ai.party[0].moves = [{name: 'Rototiller'}];
rototiller.sides.player.party[0].species = 'Bulbasaur';
rototiller.sides.player.party[0].boosts = {atk: 6, spa: 6};
assert.equal(enumerateMoveActions(rototiller, 'ai').some(action => action.moveName === 'Rototiller'), false);
assert.equal(deriveMoveResolution(rototiller, move('Rototiller'), {hit: true}).hit, false);
rototiller.sides.player.party[0].boosts = {atk: 5, spa: 6};
assert.equal(enumerateMoveActions(rototiller, 'ai').some(action => action.moveName === 'Rototiller'), true);

console.log('Utility legality fixtures passed');
