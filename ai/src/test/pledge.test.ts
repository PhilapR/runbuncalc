import assert from 'node:assert/strict';
import {calculateActionFacts} from '../calc-adapter';
import {BattleState} from '../model';
import {deriveMoveResolution} from '../move-engine';
import {deriveEndTurnResolution} from '../end-turn';
import {canApplyMajorStatus} from '../eligibility';
import {applyAction, beginNextTurn} from '../transition';

const state: BattleState = {
  generation: 9,
  mode: 'Doubles',
  turn: 1,
  field: {},
  sides: {
    ai: {activeIds: ['ai-grass', 'ai-water'], party: [
      {id: 'ai-grass', species: 'Venusaur', level: 100, hp: {current: 200, max: 200}, moves: [{name: 'Grass Pledge'}]},
      {id: 'ai-water', species: 'Blastoise', level: 100, hp: {current: 200, max: 200}, moves: [{name: 'Water Pledge'}]},
    ]},
    player: {activeIds: ['player-1'], party: [
      {id: 'player-1', species: 'Charizard', level: 100, hp: {current: 200, max: 200}, moves: [{name: 'Tackle'}]},
    ]},
  },
  selectedMoveByPokemon: {['ai-water']: {moveName: 'Water Pledge'}},
};

const grassAction = {kind: 'move' as const, actorId: 'ai-grass', moveName: 'Grass Pledge', targetIds: ['player-1']};
const waterAction = {kind: 'move' as const, actorId: 'ai-water', moveName: 'Water Pledge', targetIds: ['player-1']};

const firstFacts = calculateActionFacts(state, grassAction);
const unpairedFacts = calculateActionFacts({...state, selectedMoveByPokemon: undefined}, grassAction);
assert.ok(firstFacts.damage && unpairedFacts.damage);
assert.ok(firstFacts.damage.max > unpairedFacts.damage.max);
const firstResolution = deriveMoveResolution(state, grassAction, {
  facts: firstFacts,
  random: () => 0,
});
assert.equal(firstResolution.damageByTarget, undefined);
assert.equal(firstResolution.pendingPledgeBySide?.ai?.actorId, 'ai-grass');

const waiting = applyAction(state, grassAction, firstResolution);
assert.equal(waiting.pendingPledgeBySide?.ai?.moveName, 'Grass Pledge');
assert.equal(waiting.sides.player.party[0].hp.current, 200);

const normalWaterFacts = calculateActionFacts(state, waterAction);
const combinedWaterFacts = calculateActionFacts(waiting, waterAction);
assert.ok(normalWaterFacts.damage && combinedWaterFacts.damage);
assert.ok(combinedWaterFacts.damage.max > normalWaterFacts.damage.max);

const secondResolution = deriveMoveResolution(waiting, waterAction, {
  facts: combinedWaterFacts,
  random: () => 0,
});
assert.ok((secondResolution.damageByTarget?.['player-1'] || 0) > 0);
assert.equal(secondResolution.pendingPledgeBySide?.ai, null);
assert.equal(secondResolution.sideEffectsBySide?.player?.pledgeSwamp, true);
assert.equal(secondResolution.sideEffectDurationsBySide?.player?.pledgeSwamp, 4);

const completed = applyAction(waiting, waterAction, secondResolution);
assert.equal(completed.pendingPledgeBySide, undefined);
assert.equal(completed.sides.player.effects?.pledgeSwamp, true);
assert.equal(completed.sides.player.effectDurations?.pledgeSwamp, 4);
assert.ok(completed.sides.player.party[0].hp.current < 200);

const cancelledByTurn = beginNextTurn(waiting);
assert.equal(cancelledByTurn.pendingPledgeBySide, undefined);
assert.equal(cancelledByTurn.selectedMoveByPokemon, undefined);

const cancelledByOtherMove = {...waiting, sides: {
  ...waiting.sides,
  ai: {...waiting.sides.ai, party: waiting.sides.ai.party.map(pokemon => pokemon.id === 'ai-water'
    ? {...pokemon, moves: [{name: 'Tackle'}]}
    : pokemon)},
}};
const otherMove = {kind: 'move' as const, actorId: 'ai-water', moveName: 'Tackle', targetIds: ['player-1']};
const otherResolution = deriveMoveResolution(cancelledByOtherMove, otherMove, {
  facts: calculateActionFacts(cancelledByOtherMove, otherMove),
  random: () => 0,
});
assert.equal(otherResolution.pendingPledgeBySide?.ai, null);
const otherCompleted = applyAction(cancelledByOtherMove, otherMove, otherResolution);
assert.equal(otherCompleted.pendingPledgeBySide, undefined);

const rainbowState: BattleState = {
  ...state,
  sides: {
    ...state.sides,
    ai: {...state.sides.ai, party: state.sides.ai.party.map(pokemon => pokemon.id === 'ai-grass'
      ? {...pokemon, moves: [{name: 'Fire Pledge'}]}
      : {...pokemon, species: 'Pikachu', moves: [{name: 'Water Pledge'}, {name: 'Thunderbolt'}]})},
    player: {...state.sides.player, party: state.sides.player.party.map(pokemon =>
      ({...pokemon, hp: {current: 1000, max: 1000}}))},
  },
  selectedMoveByPokemon: {['ai-water']: {moveName: 'Water Pledge'}},
};
const fireAction = {...grassAction, moveName: 'Fire Pledge'};
const rainbowFirst = deriveMoveResolution(rainbowState, fireAction, {
  facts: calculateActionFacts(rainbowState, fireAction),
  random: () => 0,
});
const rainbowWaiting = applyAction(rainbowState, fireAction, rainbowFirst);
const rainbowSecond = deriveMoveResolution(rainbowWaiting, waterAction, {
  facts: calculateActionFacts(rainbowWaiting, waterAction),
  random: () => 0,
});
const rainbowNormalFacts = calculateActionFacts(rainbowState, waterAction);
const rainbowCombinedFacts = calculateActionFacts(rainbowWaiting, waterAction);
assert.ok(rainbowNormalFacts.damage && rainbowCombinedFacts.damage);
assert.ok(rainbowCombinedFacts.damage.max > rainbowNormalFacts.damage.max);
assert.equal(rainbowSecond.sideEffectsBySide?.ai?.pledgeRainbow, true);
const rainbowCompleted = applyAction(rainbowWaiting, waterAction, rainbowSecond);
assert.equal(rainbowCompleted.sides.ai.effectDurations?.pledgeRainbow, 4);

const rainbowSecondary = deriveMoveResolution(rainbowCompleted, {
  kind: 'move', actorId: 'ai-water', moveName: 'Thunderbolt', targetIds: ['player-1'],
}, {
  facts: calculateActionFacts(rainbowCompleted, {
    kind: 'move', actorId: 'ai-water', moveName: 'Thunderbolt', targetIds: ['player-1'],
  }),
  random: () => 0.15,
});
assert.equal(canApplyMajorStatus(rainbowCompleted, 'ai-water', 'player-1', 'par', 'Electric', false, false, 'Special'), true);
assert.equal(rainbowSecondary.statusByPokemon?.['player-1'], 'par');

const seaState: BattleState = {
  ...state,
  sides: {
    ...state.sides,
    ai: {...state.sides.ai, party: state.sides.ai.party.map(pokemon => pokemon.id === 'ai-grass'
      ? {...pokemon, moves: [{name: 'Fire Pledge'}]}
      : {...pokemon, moves: [{name: 'Grass Pledge'}]})},
    player: {...state.sides.player, party: state.sides.player.party.map(pokemon =>
      ({...pokemon, species: 'Rattata', hp: {current: 1000, max: 1000}}))},
  },
  selectedMoveByPokemon: {['ai-water']: {moveName: 'Grass Pledge'}},
};
const seaFirst = deriveMoveResolution(seaState, fireAction, {
  facts: calculateActionFacts(seaState, fireAction),
  random: () => 0,
});
const seaWaiting = applyAction(seaState, fireAction, seaFirst);
const seaGrassAction = {...grassAction, actorId: 'ai-water'};
const seaSecond = deriveMoveResolution(seaWaiting, seaGrassAction, {
  facts: calculateActionFacts(seaWaiting, seaGrassAction),
  random: () => 0,
});
const seaCompleted = applyAction(seaWaiting, seaGrassAction, seaSecond);
assert.equal(seaCompleted.sides.player.effects?.pledgeSeaOfFire, true);
assert.equal(deriveEndTurnResolution(seaCompleted).hpDeltaByPokemon?.['player-1'], -125);

console.log('Pledge pairing fixtures passed');
