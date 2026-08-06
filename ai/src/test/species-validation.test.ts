import assert from 'node:assert/strict';
import {BattleState} from '../model';
import {validateBattleState} from '../validation';

/**
 * A species name must resolve in the target generation's calculator dex.
 *
 * Regression: `fixtures/ui/protect.json` carried `"Aegislash"`, which is not a
 * Gen 8 dex entry (the formes are `Aegislash-Shield` / `Aegislash-Blade`). It
 * passed validation and then threw `Cannot read properties of undefined
 * (reading 'hp')` from inside the calculator on the first evaluate. Invalid
 * boundary payloads must become explicit client errors instead.
 */

function state(species: string, generation: BattleState['generation'] = 8): BattleState {
  return {
    generation,
    mode: 'Singles',
    turn: 1,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species, level: 50,
        hp: {current: 100, max: 100}, moves: [{name: 'Shadow Ball'}],
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Garchomp', level: 50,
        hp: {current: 100, max: 100}, moves: [{name: 'Earthquake'}],
      }]},
    },
  };
}

// A real forme name validates.
assert.doesNotThrow(() => validateBattleState(state('Aegislash-Shield')));
assert.doesNotThrow(() => validateBattleState(state('Aegislash-Blade')));

// The bare, non-dex name is rejected as a client error, not an internal throw.
assert.throws(
  () => validateBattleState(state('Aegislash')),
  /Invalid BattleState: ai-1 species Aegislash is not a Generation 8 species/,
);

// Nonsense names are rejected the same way.
assert.throws(
  () => validateBattleState(state('Not A Real Pokemon')),
  /is not a Generation 8 species/,
);

// Generation gating: a Gen 9 species is not valid in a Gen 8 state.
assert.doesNotThrow(() => validateBattleState(state('Meowscarada', 9)));
assert.throws(
  () => validateBattleState(state('Meowscarada', 8)),
  /is not a Generation 8 species/,
);

// speciesOverride goes through the same dex boundary.
const withBadOverride = state('Aegislash-Shield');
withBadOverride.sides.ai.party[0].speciesOverride = 'Aegislash';
assert.throws(
  () => validateBattleState(withBadOverride),
  /speciesOverride Aegislash is not a Generation 8 species/,
);

const withGoodOverride = state('Aegislash-Shield');
withGoodOverride.sides.ai.party[0].speciesOverride = 'Aegislash-Blade';
assert.doesNotThrow(() => validateBattleState(withGoodOverride));

console.log('Species validation fixtures passed');
