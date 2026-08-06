import assert from 'node:assert/strict';
import {enumerateMoveActions} from '../actions';
import {deriveMoveResolution} from '../move-engine';
import {BattleState, MoveAction} from '../model';

function state(moveName: string): BattleState {
  return {
    generation: 9,
    mode: 'Singles',
    turn: 2,
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

function move(moveName: string, targetIds = ['player-1']) {
  return {kind: 'move' as const, actorId: 'ai-1', moveName, targetIds};
}

for (const [moveName, type] of [['Soak', 'Water'], ['Magic Powder', 'Psychic']] as const) {
  const repeated = state(moveName);
  repeated.sides.player.party[0].typeOverride = [type];
  assert.equal(enumerateMoveActions(repeated, 'ai').some((action: MoveAction) => action.moveName === moveName), false);
  assert.equal(deriveMoveResolution(repeated, move(moveName), {hit: true}).hit, false);
}

for (const [moveName, type] of [['Forest\'s Curse', 'Grass'], ['Trick-or-Treat', 'Ghost']] as const) {
  const repeated = state(moveName);
  repeated.sides.player.party[0].typeOverride = [type];
  assert.equal(enumerateMoveActions(repeated, 'ai').some((action: MoveAction) => action.moveName === moveName), false);
}

const reflect = state('Reflect Type');
reflect.sides.ai.party[0].typeOverride = ['Normal'];
reflect.sides.player.party[0].typeOverride = ['Normal'];
assert.equal(enumerateMoveActions(reflect, 'ai').some((action: MoveAction) => action.moveName === 'Reflect Type'), false);
reflect.sides.player.party[0].typeOverride = ['Fire'];
assert.equal(enumerateMoveActions(reflect, 'ai').some((action: MoveAction) => action.moveName === 'Reflect Type'), true);

const camouflage = state('Camouflage');
camouflage.sides.ai.party[0].typeOverride = ['Normal'];
assert.equal(enumerateMoveActions(camouflage, 'ai').some((action: MoveAction) => action.moveName === 'Camouflage'), false);
camouflage.field.terrain = 'Electric';
assert.equal(enumerateMoveActions(camouflage, 'ai').some((action: MoveAction) => action.moveName === 'Camouflage'), true);

const conversion = state('Conversion');
conversion.sides.ai.party[0].species = 'Eevee';
conversion.sides.ai.party[0].moves = [{name: 'Thunderbolt'}, {name: 'Conversion'}];
conversion.sides.ai.party[0].typeOverride = ['Electric'];
assert.equal(enumerateMoveActions(conversion, 'ai').some((action: MoveAction) => action.moveName === 'Conversion'), false);

const conversion2 = state('Conversion 2');
conversion2.sides.ai.party[0].species = 'Eevee';
assert.equal(enumerateMoveActions(conversion2, 'ai').some((action: MoveAction) => action.moveName === 'Conversion 2'), false);
conversion2.lastMoveUsedByPokemon = {'player-1': 'Thunderbolt'};
assert.equal(enumerateMoveActions(conversion2, 'ai').some((action: MoveAction) => action.moveName === 'Conversion 2'), true);

console.log('Type legality fixtures passed');
