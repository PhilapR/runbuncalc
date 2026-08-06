import assert from 'node:assert/strict';
import {calculateActionFacts} from '../calc-adapter';
import {enumerateMoveActions} from '../actions';
import {deriveMoveResolution} from '../move-engine';
import {BattleState} from '../model';
import {applyAction, applySwitchAction} from '../transition';

function state(species: string, generation = 9): BattleState {
  return {
    generation: generation as BattleState['generation'],
    mode: 'Singles',
    turn: 1,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species, level: 100,
        hp: {current: 100, max: 100}, moves: [{name: 'Relic Song', pp: 10, maxPP: 10}],
      }, {
        id: 'ai-2', species: 'Pikachu', level: 100,
        hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}],
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Mewtwo', level: 100,
        hp: {current: 1000, max: 1000}, moves: [{name: 'Tackle'}],
      }]},
    },
  };
}

function action(fixture: BattleState) {
  const selected = enumerateMoveActions(fixture, 'ai').find(candidate => candidate.moveName === 'Relic Song');
  assert.ok(selected);
  return selected;
}

const aria = state('Meloetta');
const ariaAction = action(aria);
const ariaResolution = deriveMoveResolution(aria, ariaAction, {
  facts: calculateActionFacts(aria, ariaAction),
  hit: true,
  random: () => 0,
});
assert.equal(ariaResolution.speciesOverrideByPokemon?.['ai-1'], 'Meloetta-Pirouette');
const pirouette = applyAction(aria, ariaAction, ariaResolution);
assert.equal(pirouette.sides.ai.party[0].speciesOverride, 'Meloetta-Pirouette');

const pirouetteAction = action(pirouette);
const returnResolution = deriveMoveResolution(pirouette, pirouetteAction, {
  facts: calculateActionFacts(pirouette, pirouetteAction),
  hit: true,
  random: () => 0,
});
assert.equal(returnResolution.speciesOverrideByPokemon?.['ai-1'], 'Meloetta');

const switched = applySwitchAction(pirouette, {kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2'});
const switchedBack = applySwitchAction(switched, {kind: 'switch', actorId: 'ai-2', replacementId: 'ai-1'});
assert.equal(switchedBack.sides.ai.party[0].speciesOverride, undefined);

const nonMeloetta = state('Pikachu');
assert.equal(deriveMoveResolution(nonMeloetta, action(nonMeloetta), {hit: true}).speciesOverrideByPokemon, undefined);

const preGen5 = state('Meloetta', 4);
assert.equal(enumerateMoveActions(preGen5, 'ai').some(candidate => candidate.moveName === 'Relic Song'), false);
assert.equal(deriveMoveResolution(preGen5, ariaAction, {hit: true}).hit, false);

console.log('Relic Song fixtures passed');
