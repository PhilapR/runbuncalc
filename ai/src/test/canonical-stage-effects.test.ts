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

function selected(fixture: BattleState, moveName: string) {
  const action = enumerateMoveActions(fixture, 'ai').find(candidate => candidate.moveName === moveName);
  assert.ok(action);
  return action;
}

for (const [moveName, expected] of [
  ['Defend Order', {def: 1, spd: 1}],
  ['Extreme Evoboost', {atk: 2, def: 2, spa: 2, spd: 2, spe: 2}],
] as const) {
  const fixture = state(moveName);
  const resolution = deriveMoveResolution(fixture, selected(fixture, moveName), {hit: true});
  assert.deepEqual(resolution.boostsByPokemon?.['ai-1'], expected);
  const noOp = state(moveName);
  noOp.sides.ai.party[0].boosts = Object.fromEntries(Object.keys(expected).map(stat => [stat, 6]));
  assert.equal(enumerateMoveActions(noOp, 'ai').some(action => action.moveName === moveName), false);
  assert.equal(deriveMoveResolution(noOp, {
    kind: 'move', actorId: 'ai-1', moveName, targetIds: ['ai-1'],
  }, {hit: true}).hit, false);
}

const aromatic = state('Aromatic Mist');
aromatic.mode = 'Doubles';
aromatic.sides.ai.activeIds = ['ai-1', 'ai-2'];
aromatic.sides.ai.party.push({
  id: 'ai-2', species: 'Bulbasaur', level: 100,
  hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}],
});
const aromaticResolution = deriveMoveResolution(aromatic, selected(aromatic, 'Aromatic Mist'), {hit: true});
assert.deepEqual(aromaticResolution.boostsByPokemon?.['ai-2'], {spd: 1});
const aromaticNoOp = {...aromatic, sides: {...aromatic.sides,
  ai: {...aromatic.sides.ai, party: aromatic.sides.ai.party.map(pokemon =>
    pokemon.id === 'ai-2' ? {...pokemon, boosts: {spd: 6}} : pokemon)},
}};
assert.equal(enumerateMoveActions(aromaticNoOp, 'ai').some(action => action.moveName === 'Aromatic Mist'), false);
assert.equal(deriveMoveResolution(aromaticNoOp, {
  kind: 'move', actorId: 'ai-1', moveName: 'Aromatic Mist', targetIds: ['ai-2'],
}, {hit: true}).hit, false);

for (const [moveName, expected] of [
  ['Coil', {atk: 1, def: 1, acc: 1}],
  ['Hone Claws', {atk: 1, acc: 1}],
] as const) {
  const fixture = state(moveName);
  const resolution = deriveMoveResolution(fixture, selected(fixture, moveName), {hit: true});
  assert.deepEqual(resolution.boostsByPokemon?.['ai-1'], expected);
  const saturated = state(moveName);
  saturated.sides.ai.party[0].boosts = Object.fromEntries(Object.keys(expected).map(stat => [stat, 6]));
  assert.equal(enumerateMoveActions(saturated, 'ai').some(action => action.moveName === moveName), false);
  assert.equal(deriveMoveResolution(saturated, {
    kind: 'move', actorId: 'ai-1', moveName, targetIds: ['ai-1'],
  }, {hit: true}).hit, false);
}

for (const [moveName, expected] of [
  ['Armor Cannon', {def: -1, spd: -1}],
  ['Dragon Ascent', {def: -1, spd: -1}],
  ['Headlong Rush', {def: -1, spd: -1}],
  ['Ice Hammer', {spe: -1}],
] as const) {
  const fixture = state(moveName);
  const resolution = deriveMoveResolution(fixture, selected(fixture, moveName), {
    hit: true,
    facts: {
      moveCategory: moveName === 'Armor Cannon' ? 'Special' : 'Physical',
      damage: {rolls: [20], min: 20, max: 20, targetHp: 100, possibleKO: false, guaranteedKO: false},
    },
  });
  assert.deepEqual(resolution.boostsByPokemon?.['ai-1'], expected);
}

console.log('Canonical stage-effect fixtures passed');
