import assert from 'node:assert/strict';
import {calculateActionFacts} from '../calc-adapter';
import {enumerateMoveActions} from '../actions';
import {deriveMoveResolution} from '../move-engine';
import {BattleState} from '../model';
import {applyAction} from '../transition';

function state(): BattleState {
  return {
    generation: 9,
    mode: 'Singles',
    turn: 1,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Scizor', level: 100,
        hp: {current: 100, max: 100}, moves: [
          {name: 'Fury Cutter', pp: 20, maxPP: 20},
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
  const selected = enumerateMoveActions(fixture, 'ai').find(action => action.moveName === moveName);
  assert.ok(selected);
  return selected;
}

const fixture = state();
const firstAction = move(fixture, 'Fury Cutter');
const firstFacts = calculateActionFacts(fixture, firstAction);
assert.ok(firstFacts.damage);
const firstResolution = deriveMoveResolution(fixture, firstAction, {
  facts: firstFacts,
  hit: true,
  random: () => 0,
});
const firstState = applyAction(fixture, firstAction, firstResolution);
assert.deepEqual(firstState.sides.ai.party[0].volatile?.furyCutter, {stacks: 1, moveName: 'Fury Cutter'});

const secondAction = move(firstState, 'Fury Cutter');
const secondFacts = calculateActionFacts(firstState, secondAction);
assert.ok(secondFacts.damage);
assert.ok((secondFacts.damage?.max || 0) > (firstFacts.damage?.max || 0));
const secondState = applyAction(firstState, secondAction, deriveMoveResolution(firstState, secondAction, {
  facts: secondFacts,
  hit: true,
  random: () => 0,
}));
assert.equal(secondState.sides.ai.party[0].volatile?.furyCutter?.stacks, 2);

const otherAction = move(secondState, 'Tackle');
const resetState = applyAction(secondState, otherAction, deriveMoveResolution(secondState, otherAction, {hit: true}));
assert.equal(resetState.sides.ai.party[0].volatile?.furyCutter, undefined);

const missState = applyAction(firstState, secondAction, deriveMoveResolution(firstState, secondAction, {
  facts: secondFacts,
  hit: false,
  random: () => 0,
}));
assert.equal(missState.sides.ai.party[0].volatile?.furyCutter, undefined);

const preGen2 = state();
preGen2.generation = 1;
assert.equal(enumerateMoveActions(preGen2, 'ai').some(action => action.moveName === 'Fury Cutter'), false);
assert.equal(deriveMoveResolution(preGen2, firstAction, {hit: true}).hit, false);

console.log('Fury Cutter fixtures passed');
