import assert from 'node:assert/strict';
import {calculateActionFacts} from '../calc-adapter';
import {enumerateMoveActions} from '../actions';
import {deriveMoveResolution} from '../move-engine';
import {BattleState, MoveAction} from '../model';
import {applyAction} from '../transition';

function state(): BattleState {
  return {
    generation: 9,
    mode: 'Singles',
    turn: 1,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Cloyster', level: 100,
        hp: {current: 100, max: 100}, moves: [{name: 'Scale Shot', pp: 15, maxPP: 15}],
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Mewtwo', level: 100,
        hp: {current: 1000, max: 1000}, moves: [{name: 'Tackle'}],
      }]},
    },
  };
}

const fixture = state();
const scaleShot = enumerateMoveActions(fixture, 'ai').find((action: MoveAction) => action.moveName === 'Scale Shot');
assert.ok(scaleShot);
const facts = calculateActionFacts(fixture, scaleShot);
assert.equal(facts.isMultiHit, true);
const resolution = deriveMoveResolution(fixture, scaleShot, {
  facts,
  hit: true,
  random: () => 0,
});
assert.deepEqual(resolution.boostsByPokemon?.['ai-1'], {def: -1, spe: 1});
const applied = applyAction(fixture, scaleShot, resolution);
assert.deepEqual(applied.sides.ai.party[0].boosts, {def: -1, spe: 1});

const miss = deriveMoveResolution(fixture, scaleShot, {facts, hit: false, random: () => 0});
assert.equal(miss.boostsByPokemon, undefined);

const preGen8 = state();
preGen8.generation = 7;
assert.equal(enumerateMoveActions(preGen8, 'ai').some((action: MoveAction) => action.moveName === 'Scale Shot'), false);
assert.equal(deriveMoveResolution(preGen8, scaleShot, {hit: true}).hit, false);

console.log('Scale Shot fixtures passed');
