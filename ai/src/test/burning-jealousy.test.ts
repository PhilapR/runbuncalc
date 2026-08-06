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
        id: 'ai-1', species: 'Pikachu', level: 100,
        hp: {current: 100, max: 100}, moves: [{name: 'Burning Jealousy', pp: 5, maxPP: 5}],
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Mewtwo', level: 100,
        hp: {current: 1000, max: 1000}, moves: [{name: 'Work Up', pp: 30, maxPP: 30}],
      }]},
    },
  };
}

function action(fixture: BattleState, side: 'ai' | 'player', moveName: string) {
  const selected = enumerateMoveActions(fixture, side).find(candidate => candidate.moveName === moveName);
  assert.ok(selected);
  return selected;
}

const fixture = state();
const workUp = action(fixture, 'player', 'Work Up');
const workUpResolution = deriveMoveResolution(fixture, workUp, {hit: true});
const boosted = applyAction(fixture, workUp, workUpResolution);
assert.deepEqual(boosted.sides.player.party[0].boosts, {atk: 1, spa: 1});
assert.deepEqual(boosted.statBoostsThisTurnByPokemon?.['player-1'], {atk: 1, spa: 1});

const burning = action(boosted, 'ai', 'Burning Jealousy');
const burningFacts = calculateActionFacts(boosted, burning);
assert.ok(burningFacts.damage);
const burningResolution = deriveMoveResolution(boosted, burning, {
  facts: burningFacts,
  hit: true,
  random: () => 0,
});
assert.equal(burningResolution.statusByPokemon?.['player-1'], 'brn');

const noBoost = state();
const noBoostAction = action(noBoost, 'ai', 'Burning Jealousy');
const noBoostFacts = calculateActionFacts(noBoost, noBoostAction);
assert.equal(deriveMoveResolution(noBoost, noBoostAction, {
  facts: noBoostFacts,
  hit: true,
  random: () => 0,
}).statusByPokemon, undefined);

const nextTurn = beginNextTurn(boosted);
assert.equal(nextTurn.statBoostsThisTurnByPokemon, undefined);
const nextTurnAction = action(nextTurn, 'ai', 'Burning Jealousy');
const nextTurnFacts = calculateActionFacts(nextTurn, nextTurnAction);
assert.equal(deriveMoveResolution(nextTurn, nextTurnAction, {
  facts: nextTurnFacts,
  hit: true,
  random: () => 0,
}).statusByPokemon, undefined);

const preGen8 = state();
preGen8.generation = 7;
assert.equal(enumerateMoveActions(preGen8, 'ai').some(candidate => candidate.moveName === 'Burning Jealousy'), false);
assert.equal(deriveMoveResolution(preGen8, {
  kind: 'move', actorId: 'ai-1', moveName: 'Burning Jealousy', targetIds: ['player-1'],
}, {hit: true}).hit, false);

console.log('Burning Jealousy fixtures passed');
