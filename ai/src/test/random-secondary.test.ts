import assert from 'node:assert/strict';
import {calculateActionFacts} from '../calc-adapter';
import {enumerateMoveActions} from '../actions';
import {deriveMoveResolution} from '../move-engine';
import {BattleState, MoveAction} from '../model';

function state(moveName: string, ability?: string, targetSpecies = 'Rattata'): BattleState {
  return {
    generation: 9,
    mode: 'Singles',
    turn: 1,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Pikachu', level: 100, ability,
        hp: {current: 100, max: 100}, moves: [{name: moveName, pp: 10, maxPP: 10}],
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: targetSpecies, level: 100,
        hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}],
      }]},
    },
  };
}

function actionAndFacts(fixture: BattleState, moveName: string) {
  const action = enumerateMoveActions(fixture, 'ai').find((candidate: MoveAction) => candidate.moveName === moveName);
  assert.ok(action);
  return {action, facts: calculateActionFacts(fixture, action)};
}

const direClaw = state('Dire Claw');
const direClawData = actionAndFacts(direClaw, 'Dire Claw');
assert.deepEqual(direClawData.facts.secondaryEffects?.[0]?.statusChoices, ['slp', 'psn', 'par']);
const sleep = deriveMoveResolution(direClaw, direClawData.action, {
  hit: true, facts: direClawData.facts, random: (() => {
    const rolls = [0.5, 0, 0, 0.1]; let index = 0;
    return () => rolls[Math.min(index++, rolls.length - 1)];
  })(),
});
assert.equal(sleep.statusByPokemon?.['player-1'], 'slp');

const poison = state('Dire Claw');
const poisonData = actionAndFacts(poison, 'Dire Claw');
const poisoned = deriveMoveResolution(poison, poisonData.action, {
  hit: true, facts: poisonData.facts, random: (() => {
    const rolls = [0.5, 0, 0.34]; let index = 0;
    return () => rolls[Math.min(index++, rolls.length - 1)];
  })(),
});
assert.equal(poisoned.statusByPokemon?.['player-1'], 'psn');

const triAttack = state('Tri Attack');
const triAttackData = actionAndFacts(triAttack, 'Tri Attack');
assert.deepEqual(triAttackData.facts.secondaryEffects?.[0]?.statusChoices, ['par', 'brn', 'frz']);
const frozen = deriveMoveResolution(triAttack, triAttackData.action, {
  hit: true, facts: triAttackData.facts, random: (() => {
    const rolls = [0.5, 0, 0.9]; let index = 0;
    return () => rolls[Math.min(index++, rolls.length - 1)];
  })(),
});
assert.equal(frozen.statusByPokemon?.['player-1'], 'frz');

const serene = state('Dire Claw', 'Serene Grace');
const sereneData = actionAndFacts(serene, 'Dire Claw');
const sereneResolution = deriveMoveResolution(serene, sereneData.action, {
  hit: true, facts: sereneData.facts, random: (() => {
    const rolls = [0.5, 0.9, 0.67]; let index = 0;
    return () => rolls[Math.min(index++, rolls.length - 1)];
  })(),
});
assert.equal(sereneResolution.statusByPokemon?.['player-1'], 'par');

const immune = state('Dire Claw', undefined, 'Gengar');
const immuneData = actionAndFacts(immune, 'Dire Claw');
const immuneResolution = deriveMoveResolution(immune, immuneData.action, {
  hit: true, facts: immuneData.facts, random: () => 0.34,
});
assert.equal(immuneResolution.statusByPokemon?.['player-1'], undefined);

const sheerForce = state('Dire Claw', 'Sheer Force');
const sheerForceData = actionAndFacts(sheerForce, 'Dire Claw');
const suppressed = deriveMoveResolution(sheerForce, sheerForceData.action, {
  hit: true, facts: sheerForceData.facts, random: () => 0,
});
assert.equal(suppressed.statusByPokemon, undefined);

console.log('Random secondary fixtures passed');
