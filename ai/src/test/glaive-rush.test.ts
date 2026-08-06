import assert from 'node:assert/strict';
import {getEffectiveMoveAccuracy} from '../accuracy';
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
        id: 'ai-1', species: 'Baxcalibur', level: 100,
        hp: {current: 100, max: 100}, moves: [{name: 'Glaive Rush', pp: 5, maxPP: 5}, {name: 'Tackle'}],
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Mewtwo', level: 100,
        hp: {current: 100, max: 100}, moves: [{name: 'Tackle', pp: 35, maxPP: 35}],
      }]},
    },
  };
}

const fixture = state();
const glaiveAction = enumerateMoveActions(fixture, 'ai').find(action => action.moveName === 'Glaive Rush');
assert.ok(glaiveAction);
const glaiveResolution = deriveMoveResolution(fixture, glaiveAction, {hit: true});
assert.equal(glaiveResolution.volatileByPokemon?.['ai-1']?.glaiveRush?.turns, 1);
const vulnerable = applyAction(fixture, glaiveAction, glaiveResolution);
assert.equal(vulnerable.sides.ai.party[0].volatile?.glaiveRush?.turns, 1);

const incomingAction = {
  kind: 'move' as const,
  actorId: 'player-1',
  moveName: 'Tackle',
  targetIds: ['ai-1'],
};
const normalFacts = calculateActionFacts(fixture, incomingAction);
const vulnerableFacts = calculateActionFacts(vulnerable, incomingAction);
assert.ok(normalFacts.damage && vulnerableFacts.damage);
assert.equal(vulnerableFacts.damage.max, normalFacts.damage.max * 2);
assert.deepEqual(
  getEffectiveMoveAccuracy(vulnerable, incomingAction, 20),
  {accuracy: true, multiplier: 1, modifiers: ['Glaive Rush']},
);

const nextTurn = beginNextTurn(vulnerable);
assert.equal(nextTurn.sides.ai.party[0].volatile?.glaiveRush, undefined);

const preGen9 = state();
preGen9.generation = 8;
assert.equal(enumerateMoveActions(preGen9, 'ai').some(action => action.moveName === 'Glaive Rush'), false);
assert.equal(deriveMoveResolution(preGen9, glaiveAction, {hit: true}).hit, false);

console.log('Glaive Rush fixtures passed');
