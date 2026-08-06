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
        id: 'ai-1', species: 'Rattata', level: 100,
        hp: {current: 1000, max: 1000}, moves: [{name: 'Snarl'}, {name: 'Tackle'}],
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Pangoro', level: 100,
        hp: {current: 100, max: 100}, moves: [
          {name: 'Throat Chop', pp: 15, maxPP: 15}, {name: 'Tackle'},
        ],
      }]},
    },
  };
}

const fixture = state();
const action = enumerateMoveActions(fixture, 'player').find(candidate => candidate.moveName === 'Throat Chop');
assert.ok(action);
const resolution = deriveMoveResolution(fixture, action, {
  hit: true,
  facts: calculateActionFacts(fixture, action),
});
assert.equal(resolution.volatileByPokemon?.['ai-1']?.throatChop?.turns, 2);
const silenced = applyAction(fixture, action, resolution);
assert.equal(silenced.sides.ai.party[0].volatile?.throatChop?.turns, 2);
assert.equal(enumerateMoveActions(silenced, 'ai').some(candidate => candidate.moveName === 'Snarl'), false);
assert.equal(enumerateMoveActions(silenced, 'ai').some(candidate => candidate.moveName === 'Tackle'), true);
assert.equal(deriveMoveResolution(silenced, {
  kind: 'move', actorId: 'ai-1', moveName: 'Snarl', targetIds: ['player-1'],
}, {hit: true}).hit, false);

const factsAgainstSilenced = calculateActionFacts(silenced, {
  kind: 'move', actorId: 'player-1', moveName: 'Tackle', targetIds: ['ai-1'],
});
assert.equal(factsAgainstSilenced.defenderHasSoundMove, false);

const afterOneTurn = beginNextTurn(silenced);
assert.equal(afterOneTurn.sides.ai.party[0].volatile?.throatChop?.turns, 1);
const afterTwoTurns = beginNextTurn(afterOneTurn);
assert.equal(afterTwoTurns.sides.ai.party[0].volatile?.throatChop, undefined);

const miss = state();
const missAction = enumerateMoveActions(miss, 'player').find(candidate => candidate.moveName === 'Throat Chop');
assert.ok(missAction);
assert.equal(deriveMoveResolution(miss, missAction, {hit: false}).volatileByPokemon?.['ai-1']?.throatChop, undefined);

const preGen7 = state();
preGen7.generation = 6;
assert.equal(enumerateMoveActions(preGen7, 'player').some(candidate => candidate.moveName === 'Throat Chop'), false);
assert.equal(deriveMoveResolution(preGen7, {
  kind: 'move', actorId: 'player-1', moveName: 'Throat Chop', targetIds: ['ai-1'],
}, {hit: true}).hit, false);

console.log('Throat Chop fixtures passed');
