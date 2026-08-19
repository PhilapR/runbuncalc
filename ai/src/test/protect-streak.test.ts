import assert from 'node:assert/strict';
import {calculateActionFacts} from '../calc-adapter';
import {deriveMoveResolution} from '../move-engine';
import {BattleState} from '../model';

// Gen 8 stall: consecutive protection succeeds at (1/3)^n with a 1/729
// floor — not a flat 1/3 forever. And Wide/Quick Guard never take the
// roll at all (no stalling flag in Gen 8): they cannot fail from
// consecutive use, though they keep feeding the streak for what follows.
function state(move: string, streak?: {moveName: string; count: number}): BattleState {
  return {
    generation: 8,
    mode: 'Doubles',
    turn: 3,
    field: {},
    ...(streak ? {moveStreakByPokemon: {'ai-1': streak}} : {}),
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Pikachu', level: 100,
        hp: {current: 100, max: 100}, moves: [{name: move, pp: 16, maxPP: 16}],
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Blissey', level: 100,
        hp: {current: 300, max: 300}, moves: [{name: 'Tackle'}],
      }]},
    },
  };
}

function attempt(move: string, streak: {moveName: string; count: number} | undefined, roll: number) {
  const fixture = state(move, streak);
  const action = {kind: 'move' as const, actorId: 'ai-1', moveName: move, targetIds: ['ai-1']};
  return deriveMoveResolution(fixture, action, {
    facts: calculateActionFacts(fixture, action), random: () => roll,
  });
}

// First repeat (streak 1): success stays 1/3 — a 0.2 roll succeeds.
assert.notEqual(attempt('Protect', {moveName: 'Protect', count: 1}, 0.2).actionFailure, 'protect');
// Second repeat (streak 2): success is 1/9 — the same 0.2 roll now FAILS.
assert.equal(attempt('Protect', {moveName: 'Protect', count: 2}, 0.2).actionFailure, 'protect');
// ...and a 0.05 roll still squeaks through at 1/9.
assert.notEqual(attempt('Protect', {moveName: 'Protect', count: 2}, 0.05).actionFailure, 'protect');
// Deep streak: the floor holds at 1/729, never zero.
assert.notEqual(attempt('Protect', {moveName: 'Protect', count: 9}, 0.001).actionFailure, 'protect');
assert.equal(attempt('Protect', {moveName: 'Protect', count: 9}, 0.01).actionFailure, 'protect');
// Wide Guard after a Protect streak: no roll, cannot fail from consecutive use.
assert.notEqual(attempt('Wide Guard', {moveName: 'Protect', count: 3}, 0.999).actionFailure, 'protect');

console.log('protect-streak: ok');
