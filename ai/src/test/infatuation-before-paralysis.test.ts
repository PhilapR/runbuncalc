import assert from 'node:assert/strict';
import {calculateActionFacts} from '../calc-adapter';
import {deriveMoveResolution} from '../move-engine';
import {BattleState, PokemonState} from '../model';

// Infatuation gates an action BEFORE paralysis: the Gen 8 order (Showdown's
// onBeforeMovePriority: attract 2, par 1). Run & Bun's doc changes
// infatuation only to be gender-free and mandates Gen 8 for the rest; the
// operator ruled it on 2026-09-22 over the pokeemerald order CONSTANTS-AUDIT
// D12 had chosen. A mon both infatuated and paralysed then loses its turn to
// love 50% of the time and to paralysis 12.5%.
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

// A low first draw is spent on the FIRST gate: love under Gen 8, paralysis under the old order.
assert.equal(failureAt(0.1), 'infatuation', 'infatuation is checked before paralysis');
// A draw that passes love (>= 0.5) never reaches a paralysis failure (needs < 0.25) on the same roll.
assert.equal(failureAt(0.6), undefined, 'past love, the same draw passes paralysis');

console.log('infatuation-before-paralysis: ok');
