import assert from 'node:assert/strict';
import {
  BattleState,
  calculateActionFacts,
  evaluateActions,
  validateBattleState,
} from '../index';

const state: BattleState = {
  generation: 9,
  mode: 'Singles',
  turn: 1,
  field: {},
  sides: {
    ai: {
      activeIds: ['ai-1'],
      party: [{
        id: 'ai-1', species: 'Pikachu', level: 100,
        hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}],
      }],
    },
    player: {
      activeIds: ['player-1'],
      party: [{
        id: 'player-1', species: 'Rattata', level: 100,
        hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}],
      }],
    },
  },
};

validateBattleState(state);
const evaluations = evaluateActions(state, calculateActionFacts);

assert.ok(evaluations.length > 0);
assert.equal(evaluations[0].action.kind, 'move');
assert.ok(evaluations[0].outcomes.length > 0);

console.log('public AI API fixture passed');
