import assert from 'node:assert/strict';
import {calculateActionFacts} from '../calc-adapter';
import {deriveEndTurnResolution} from '../end-turn';
import {deriveMoveResolution} from '../move-engine';
import {BattleState} from '../model';

// D4: Yawn grants a full grace turn and then inflicts an ORDINARY 2-4 sleep.
// It used to convert at the end of the turn it landed, always at counter 2.
function yawnState(turns: number): BattleState {
  return {
    generation: 8, mode: 'Singles', turn: 3, field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Snorlax', level: 50,
        hp: {current: 200, max: 200}, moves: [{name: 'Tackle'}],
        volatile: {yawn: {turns, sourceId: 'player-1'}},
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Blissey', level: 50,
        hp: {current: 250, max: 250}, moves: [{name: 'Yawn'}],
      }]},
    },
  };
}

// Freshly applied (turns 2): the grace turn — no sleep yet.
const grace = deriveEndTurnResolution(yawnState(2), {random: () => 0.5});
assert.notEqual(grace.statusByPokemon?.['ai-1'], 'slp',
  'the turn Yawn lands must not put the target to sleep');
// The following turn (turns 1): sleep lands, with a ROLLED counter.
const shortNap = deriveEndTurnResolution(yawnState(1), {random: () => 0.1});
assert.equal(shortNap.statusByPokemon?.['ai-1'], 'slp');
assert.equal(shortNap.statusTurnsByPokemon?.['ai-1'], 2, 'a low roll gives the 2-turn nap');
const longNap = deriveEndTurnResolution(yawnState(1), {random: () => 0.99});
assert.equal(longNap.statusTurnsByPokemon?.['ai-1'], 4, 'a high roll gives the 4-turn nap');

// Yawn is applied with two turns, not one.
const applyState: BattleState = {
  generation: 8, mode: 'Singles', turn: 1, field: {},
  sides: {
    ai: {activeIds: ['ai-1'], party: [{
      id: 'ai-1', species: 'Blissey', level: 50,
      hp: {current: 250, max: 250}, moves: [{name: 'Yawn', pp: 10, maxPP: 10}],
    }]},
    player: {activeIds: ['player-1'], party: [{
      id: 'player-1', species: 'Snorlax', level: 50,
      hp: {current: 200, max: 200}, moves: [{name: 'Tackle'}],
    }]},
  },
};
const applyAction = {kind: 'move' as const, actorId: 'ai-1', moveName: 'Yawn', targetIds: ['player-1']};
const applied = deriveMoveResolution(applyState, applyAction, {
  facts: calculateActionFacts(applyState, applyAction), hit: true, random: () => 0.5,
});
assert.equal((applied.volatileByPokemon?.['player-1'] as {yawn?: {turns: number}})?.yawn?.turns, 2,
  'Yawn lands with a grace turn');

// D17: Uproar is a fixed 3 turns from gen 5, not a 2-5 roll.
function uproarTurns(generation: 4 | 8, roll: number): number | undefined {
  const fixture: BattleState = {
    generation, mode: 'Singles', turn: 1, field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Exploud', level: 50,
        hp: {current: 200, max: 200}, moves: [{name: 'Uproar', pp: 10, maxPP: 10}],
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Blissey', level: 50,
        hp: {current: 250, max: 250}, moves: [{name: 'Tackle'}],
      }]},
    },
  };
  const action = {kind: 'move' as const, actorId: 'ai-1', moveName: 'Uproar', targetIds: ['player-1']};
  const resolution = deriveMoveResolution(fixture, action, {
    facts: calculateActionFacts(fixture, action), hit: true, random: () => roll,
  });
  return (resolution.volatileByPokemon?.['ai-1'] as {uproar?: {turns: number}})?.uproar?.turns;
}
assert.equal(uproarTurns(8, 0.01), 3, 'gen 8 Uproar is fixed at 3');
assert.equal(uproarTurns(8, 0.99), 3, 'gen 8 Uproar ignores the roll');
assert.equal(uproarTurns(4, 0.99), 5, 'gen 4 still rolls 2-5');

console.log('yawn-uproar-gates: ok');
