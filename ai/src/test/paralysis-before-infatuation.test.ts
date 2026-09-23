import assert from 'node:assert/strict';
import {calculateActionFacts} from '../calc-adapter';
import {deriveMoveResolution} from '../move-engine';
import {BattleState, PokemonState} from '../model';

// Paralysis gates an action BEFORE infatuation: the ROM (pokemon-mono P4,
// 2026-09-22): over 300 turns of a paralysed and infatuated mon, a paralysis
// message never followed a love message, and full paralysis came at the
// paralysis-only rate (78/300 against 75/300). The Gen 8 order (infatuation
// first) was ruled the same day from the doc's fallback and is superseded.
function state(actor: Partial<PokemonState>): BattleState {
  return {
    generation: 8,
    mode: 'Singles',
    turn: 1,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Lopunny', level: 100,
        hp: {current: 300, max: 300}, moves: [{name: 'Tackle', pp: 35, maxPP: 35}],
        ...actor,
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Blissey', level: 100,
        hp: {current: 600, max: 600}, moves: [{name: 'Tackle'}],
      }]},
    },
  };
}
const action = {kind: 'move' as const, actorId: 'ai-1', moveName: 'Tackle', targetIds: ['player-1']};
function failureAt(draw: number): string | undefined {
  const fixture = state({status: 'par', volatile: {infatuated: {sourceId: 'player-1'}}} as Partial<PokemonState>);
  return deriveMoveResolution(fixture, action, {facts: calculateActionFacts(fixture, action), random: () => draw})
    .actionFailure;
}

// A low first draw is spent on the FIRST gate: paralysis in the ROM's order, love in Gen 8's.
assert.equal(failureAt(0.1), 'paralysis', 'paralysis is checked before infatuation');
// A draw that passes paralysis (>= 0.25) can still fall to love on the same roll (< 0.5).
assert.equal(failureAt(0.3), 'infatuation', 'past paralysis, love');
assert.equal(failureAt(0.6), undefined, 'past both');

console.log('paralysis-before-infatuation: ok');
