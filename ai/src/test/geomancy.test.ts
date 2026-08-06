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
        id: 'ai-1', species: 'Xerneas', level: 100,
        hp: {current: 100, max: 100}, moves: [{name: 'Geomancy', pp: 10, maxPP: 10}, {name: 'Tackle'}],
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Rattata', level: 100,
        hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}],
      }]},
    },
  };
}

const fixture = state();
const firstAction = enumerateMoveActions(fixture, 'ai').find(action => action.moveName === 'Geomancy');
assert.ok(firstAction);
assert.equal(calculateActionFacts(fixture, firstAction).moveCategory, 'Status');
const firstResolution = deriveMoveResolution(fixture, firstAction, {hit: true});
assert.deepEqual(firstResolution.volatileByPokemon?.['ai-1']?.charge, {
  turns: 2, moveName: 'Geomancy', targetIds: ['ai-1'],
});
const charging = applyAction(fixture, firstAction, firstResolution);
assert.equal(charging.sides.ai.party[0].moves[0].pp, 9);
const ready = beginNextTurn(charging);
assert.deepEqual(enumerateMoveActions(ready, 'ai').map(action => action.targetIds), [['ai-1']]);
const releaseAction = enumerateMoveActions(ready, 'ai')[0];
const releaseResolution = deriveMoveResolution(ready, releaseAction, {hit: true});
assert.equal(releaseResolution.volatileByPokemon?.['ai-1']?.charge, null);
assert.deepEqual(releaseResolution.boostsByPokemon?.['ai-1'], {spa: 2, spd: 2, spe: 2});
const released = applyAction(ready, releaseAction, releaseResolution);
assert.equal(released.sides.ai.party[0].moves[0].pp, 9);
assert.deepEqual(released.sides.ai.party[0].boosts, {spa: 2, spd: 2, spe: 2});

const powerHerb = state();
powerHerb.sides.ai.party[0].item = 'Power Herb';
const herbAction = enumerateMoveActions(powerHerb, 'ai').find(action => action.moveName === 'Geomancy');
assert.ok(herbAction);
const herbResolution = deriveMoveResolution(powerHerb, herbAction, {hit: true});
assert.equal(herbResolution.volatileByPokemon, undefined);
assert.equal(herbResolution.consumedItemByPokemon?.['ai-1'], 'Power Herb');
assert.deepEqual(herbResolution.boostsByPokemon?.['ai-1'], {spa: 2, spd: 2, spe: 2});

const saturated = state();
saturated.sides.ai.party[0].boosts = {spa: 6, spd: 6, spe: 6};
assert.equal(enumerateMoveActions(saturated, 'ai').some(action => action.moveName === 'Geomancy'), false);
assert.equal(deriveMoveResolution(saturated, {
  kind: 'move', actorId: 'ai-1', moveName: 'Geomancy', targetIds: ['ai-1'],
}, {hit: true}).hit, false);

const preGen6 = state();
preGen6.generation = 5;
assert.equal(enumerateMoveActions(preGen6, 'ai').some(action => action.moveName === 'Geomancy'), false);
assert.equal(deriveMoveResolution(preGen6, {
  kind: 'move', actorId: 'ai-1', moveName: 'Geomancy', targetIds: ['ai-1'],
}, {hit: true}).hit, false);

console.log('Geomancy fixtures passed');
