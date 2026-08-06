import assert from 'node:assert/strict';
import {calculateActionFacts} from '../calc-adapter';
import {enumerateMoveActions} from '../actions';
import {deriveMoveResolution} from '../move-engine';
import {BattleState} from '../model';
import {applyAction, beginNextTurn} from '../transition';

function state(): BattleState {
  return {
    generation: 9,
    mode: 'Singles',
    turn: 1,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Miraidon', level: 100,
        hp: {current: 100, max: 100}, moves: [{name: 'Electro Shot', pp: 10, maxPP: 10}, {name: 'Tackle'}],
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Rattata', level: 100,
        hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}],
      }]},
    },
  };
}

const fixture = state();
const firstAction = enumerateMoveActions(fixture, 'ai').find(action => action.moveName === 'Electro Shot');
assert.ok(firstAction);
assert.equal(calculateActionFacts(fixture, firstAction).moveCategory, 'Status');
const firstResolution = deriveMoveResolution(fixture, firstAction, {hit: true});
assert.deepEqual(firstResolution.volatileByPokemon?.['ai-1']?.charge, {
  turns: 2, moveName: 'Electro Shot', targetIds: ['player-1'],
});
const charging = applyAction(fixture, firstAction, firstResolution);
assert.equal(charging.sides.ai.party[0].moves[0].pp, 9);
const ready = beginNextTurn(charging);
const releaseAction = enumerateMoveActions(ready, 'ai')[0];
const releaseResolution = deriveMoveResolution(ready, releaseAction, {hit: true});
assert.equal(releaseResolution.volatileByPokemon?.['ai-1']?.charge, null);
assert.equal(releaseResolution.boostsByPokemon?.['ai-1']?.spa, 1);
const released = applyAction(ready, releaseAction, releaseResolution);
assert.equal(released.sides.ai.party[0].moves[0].pp, 9);
assert.equal(released.sides.ai.party[0].boosts?.spa, 1);

const powerHerb = state();
powerHerb.sides.ai.party[0].item = 'Power Herb';
const herbAction = enumerateMoveActions(powerHerb, 'ai').find(action => action.moveName === 'Electro Shot');
assert.ok(herbAction);
assert.equal(calculateActionFacts(powerHerb, herbAction).moveCategory, 'Special');
const herbResolution = deriveMoveResolution(powerHerb, herbAction, {hit: true});
assert.equal(herbResolution.volatileByPokemon, undefined);
assert.equal(herbResolution.consumedItemByPokemon?.['ai-1'], 'Power Herb');
assert.equal(herbResolution.boostsByPokemon?.['ai-1']?.spa, 1);

const rain = state();
rain.field.weather = 'Rain';
const rainAction = enumerateMoveActions(rain, 'ai').find(action => action.moveName === 'Electro Shot');
assert.ok(rainAction);
assert.equal(calculateActionFacts(rain, rainAction).moveCategory, 'Special');
const rainResolution = deriveMoveResolution(rain, rainAction, {hit: true});
assert.equal(rainResolution.volatileByPokemon, undefined);
assert.equal(rainResolution.boostsByPokemon?.['ai-1']?.spa, 1);

const preGen9 = state();
preGen9.generation = 8;
assert.equal(enumerateMoveActions(preGen9, 'ai').some(action => action.moveName === 'Electro Shot'), false);
assert.equal(deriveMoveResolution(preGen9, firstAction, {hit: true}).hit, false);

console.log('Electro Shot fixtures passed');
