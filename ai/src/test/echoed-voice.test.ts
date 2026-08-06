import assert from 'node:assert/strict';
import {calculateActionFacts} from '../calc-adapter';
import {enumerateMoveActions} from '../actions';
import {deriveMoveResolution} from '../move-engine';
import {BattleState, MoveAction} from '../model';
import {applyAction, beginNextTurn} from '../transition';

function state(): BattleState {
  return {
    generation: 9,
    mode: 'Singles',
    turn: 1,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Pikachu', level: 100,
        hp: {current: 100, max: 100}, moves: [
          {name: 'Echoed Voice', pp: 15, maxPP: 15},
          {name: 'Tackle', pp: 35, maxPP: 35},
        ],
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Mewtwo', level: 100,
        hp: {current: 100000, max: 100000}, moves: [{name: 'Tackle'}],
      }]},
    },
  };
}

function move(fixture: BattleState, moveName: string) {
  const selected = enumerateMoveActions(fixture, 'ai').find((action: MoveAction) => action.moveName === moveName);
  assert.ok(selected);
  return selected;
}

const fixture = state();
const firstAction = move(fixture, 'Echoed Voice');
const firstFacts = calculateActionFacts(fixture, firstAction);
assert.ok(firstFacts.damage);
const firstResolution = deriveMoveResolution(fixture, firstAction, {
  facts: firstFacts,
  hit: true,
  random: () => 0,
});
const firstState = applyAction(fixture, firstAction, firstResolution);
const secondState = beginNextTurn(firstState);
const secondAction = move(secondState, 'Echoed Voice');
const secondFacts = calculateActionFacts(secondState, secondAction);
assert.ok(secondFacts.damage);
assert.ok((secondFacts.damage?.max || 0) > (firstFacts.damage?.max || 0));

const otherAction = move(secondState, 'Tackle');
const otherState = applyAction(secondState, otherAction, deriveMoveResolution(secondState, otherAction, {hit: true}));
const resetState = beginNextTurn(otherState);
const resetAction = move(resetState, 'Echoed Voice');
const resetFacts = calculateActionFacts(resetState, resetAction);
assert.equal(resetFacts.damage?.max, firstFacts.damage?.max);

const preGen5 = state();
preGen5.generation = 4;
assert.equal(enumerateMoveActions(preGen5, 'ai').some((action: MoveAction) => action.moveName === 'Echoed Voice'), false);
assert.equal(deriveMoveResolution(preGen5, firstAction, {hit: true}).hit, false);

console.log('Echoed Voice fixtures passed');
