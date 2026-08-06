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

const lunar = state('Lunar Blessing');
lunar.sides.ai.party[0].hp.current = 50;
lunar.sides.ai.party[0].status = 'brn';
const lunarAction = selected(lunar, 'Lunar Blessing');
assert.deepEqual(lunarAction.targetIds, ['ai-1']);
const lunarResolution = deriveMoveResolution(lunar, lunarAction, {hit: true});
assert.equal(lunarResolution.hpDeltaByPokemon?.['ai-1'], 25);
assert.equal(lunarResolution.statusByPokemon?.['ai-1'], '');

const lunarNoOp = state('Lunar Blessing');
assert.equal(enumerateMoveActions(lunarNoOp, 'ai').some(action => action.moveName === 'Lunar Blessing'), false);
assert.equal(deriveMoveResolution(lunarNoOp, {
  kind: 'move', actorId: 'ai-1', moveName: 'Lunar Blessing', targetIds: ['ai-1'],
}, {hit: true}).hit, false);

const shelter = state('Shelter');
const shelterResolution = deriveMoveResolution(shelter, selected(shelter, 'Shelter'), {hit: true});
assert.equal(shelterResolution.boostsByPokemon?.['ai-1']?.def, 2);
const shelterNoOp = state('Shelter');
shelterNoOp.sides.ai.party[0].boosts = {def: 6};
assert.equal(enumerateMoveActions(shelterNoOp, 'ai').some(action => action.moveName === 'Shelter'), false);
assert.equal(deriveMoveResolution(shelterNoOp, {
  kind: 'move', actorId: 'ai-1', moveName: 'Shelter', targetIds: ['ai-1'],
}, {hit: true}).hit, false);

const spicy = state('Spicy Extract');
const spicyResolution = deriveMoveResolution(spicy, selected(spicy, 'Spicy Extract'), {hit: true});
assert.equal(spicyResolution.boostsByPokemon?.['player-1']?.atk, 2);
assert.equal(spicyResolution.boostsByPokemon?.['player-1']?.def, -2);
const spicyNoOp = state('Spicy Extract');
spicyNoOp.sides.player.party[0].boosts = {atk: 6, def: -6};
assert.equal(enumerateMoveActions(spicyNoOp, 'ai').some(action => action.moveName === 'Spicy Extract'), false);
assert.equal(deriveMoveResolution(spicyNoOp, {
  kind: 'move', actorId: 'ai-1', moveName: 'Spicy Extract', targetIds: ['player-1'],
}, {hit: true}).hit, false);

const takeHeart = state('Take Heart');
takeHeart.sides.ai.party[0].status = 'brn';
takeHeart.sides.ai.party[0].boosts = {spa: 6, spd: 6};
const takeHeartResolution = deriveMoveResolution(takeHeart, selected(takeHeart, 'Take Heart'), {hit: true});
assert.equal(takeHeartResolution.statusByPokemon?.['ai-1'], '');
const takeHeartNoOp = state('Take Heart');
takeHeartNoOp.sides.ai.party[0].boosts = {spa: 6, spd: 6};
assert.equal(enumerateMoveActions(takeHeartNoOp, 'ai').some(action => action.moveName === 'Take Heart'), false);
assert.equal(deriveMoveResolution(takeHeartNoOp, {
  kind: 'move', actorId: 'ai-1', moveName: 'Take Heart', targetIds: ['ai-1'],
}, {hit: true}).hit, false);

const odor = state('Odor Sleuth');
const odorResolution = deriveMoveResolution(odor, selected(odor, 'Odor Sleuth'), {hit: true});
assert.deepEqual(odorResolution.volatileByPokemon?.['player-1']?.foresight, {});
const odorNoOp = state('Odor Sleuth');
odorNoOp.sides.player.party[0].volatile = {foresight: {}};
assert.equal(enumerateMoveActions(odorNoOp, 'ai').some(action => action.moveName === 'Odor Sleuth'), false);
assert.equal(deriveMoveResolution(odorNoOp, {
  kind: 'move', actorId: 'ai-1', moveName: 'Odor Sleuth', targetIds: ['player-1'],
}, {hit: true}).hit, false);

console.log('Canonical status fixtures passed');
