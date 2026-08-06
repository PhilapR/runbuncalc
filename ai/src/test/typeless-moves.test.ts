import assert from 'node:assert/strict';
import {calculateActionFacts} from '../calc-adapter';
import {enumerateMoveActions} from '../actions';
import {getEffectiveTypes} from '../eligibility';
import {deriveMoveResolution} from '../move-engine';
import {BattleState} from '../model';
import {applyAction, applySwitchAction} from '../transition';

function state(moveName: string, species: string, generation = 9): BattleState {
  return {
    generation: generation as BattleState['generation'],
    mode: 'Singles',
    turn: 1,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [
        {
          id: 'ai-1', species, level: 100,
          hp: {current: 100, max: 100}, moves: [{name: moveName, pp: 5, maxPP: 5}, {name: 'Tackle'}],
        },
        {id: 'ai-2', species: 'Bulbasaur', level: 100, hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}]},
      ]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Mewtwo', level: 100,
        hp: {current: 1000, max: 1000}, moves: [{name: 'Tackle'}],
      }]},
    },
  };
}

function selected(fixture: BattleState, moveName: string) {
  const action = enumerateMoveActions(fixture, 'ai').find(candidate => candidate.moveName === moveName);
  assert.ok(action);
  return action;
}

const burnUp = state('Burn Up', 'Charizard');
assert.ok(getEffectiveTypes(burnUp, 'ai-1').some(type => type === 'Fire'));
const burnUpAction = selected(burnUp, 'Burn Up');
const burnUpFacts = calculateActionFacts(burnUp, burnUpAction);
const burnUpResolution = deriveMoveResolution(burnUp, burnUpAction, {facts: burnUpFacts, hit: true, random: () => 0});
assert.deepEqual(burnUpResolution.typeOverrideByPokemon?.['ai-1'], []);
const typelessFire = applyAction(burnUp, burnUpAction, burnUpResolution);
assert.deepEqual(getEffectiveTypes(typelessFire, 'ai-1'), []);
assert.equal(enumerateMoveActions(typelessFire, 'ai').some(action => action.moveName === 'Burn Up'), false);
assert.equal(deriveMoveResolution(typelessFire, burnUpAction, {hit: true}).hit, false);
const switchedOut = applySwitchAction(typelessFire, {kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2'});
const switchedBack = applySwitchAction(switchedOut, {kind: 'switch', actorId: 'ai-2', replacementId: 'ai-1'});
assert.ok(getEffectiveTypes(switchedBack, 'ai-1').some(type => type === 'Fire'));

const doubleShock = state('Double Shock', 'Pikachu');
assert.ok(getEffectiveTypes(doubleShock, 'ai-1').some(type => type === 'Electric'));
const doubleShockAction = selected(doubleShock, 'Double Shock');
const doubleShockResolution = deriveMoveResolution(doubleShock, doubleShockAction, {
  facts: calculateActionFacts(doubleShock, doubleShockAction),
  hit: true,
  random: () => 0,
});
assert.deepEqual(doubleShockResolution.typeOverrideByPokemon?.['ai-1'], []);
assert.deepEqual(getEffectiveTypes(applyAction(doubleShock, doubleShockAction, doubleShockResolution), 'ai-1'), []);

const wrongType = state('Burn Up', 'Rattata');
assert.equal(enumerateMoveActions(wrongType, 'ai').some(action => action.moveName === 'Burn Up'), false);
assert.equal(deriveMoveResolution(wrongType, {
  kind: 'move', actorId: 'ai-1', moveName: 'Burn Up', targetIds: ['player-1'],
}, {hit: true}).hit, false);

const preGen7 = state('Burn Up', 'Charizard', 6);
assert.equal(enumerateMoveActions(preGen7, 'ai').some(action => action.moveName === 'Burn Up'), false);
assert.equal(deriveMoveResolution(preGen7, burnUpAction, {hit: true}).hit, false);
const preGen9 = state('Double Shock', 'Pikachu', 8);
assert.equal(enumerateMoveActions(preGen9, 'ai').some(action => action.moveName === 'Double Shock'), false);
assert.equal(deriveMoveResolution(preGen9, doubleShockAction, {hit: true}).hit, false);

console.log('Typeless move fixtures passed');
