import assert from 'node:assert/strict';
import {getEffectiveTypes, getEffectiveTypesForPokemon} from '../eligibility';
import {BattleState} from '../model';

/**
 * The memo in front of the effective-types lookup.
 *
 * The lookup builds a whole `Calc.Pokemon` to read one field, and a playbook
 * calls it 19,794 times against 2,537 distinct questions. Caching it took a
 * fight from 489,657 constructed calculator objects to 442,363.
 *
 * Its key is NARROW — generation, field, the Pokemon, and the actives — rather
 * than the whole serialized state, because stamping the whole state 19,794
 * times would cost more than the constructions it saves. Narrow keys are how
 * this engine got its worst cache bug: an earlier one omitted
 * `defender.isGrounded` and silently turned a Ground move's full damage roll
 * into zero. So the two assertions that matter here are about WIDTH.
 *
 * The width that is easy to get wrong is the actives. A Pokemon's own types
 * depend on an OPPOSING Pokemon's ability, because Forecast reads the weather
 * and Cloud Nine or Air Lock suppresses it. A key holding only the Pokemon and
 * the field would answer Castform-under-sun for a battle where the sun has
 * stopped mattering.
 *
 * Before shipping, the key was validated against ground truth over six real
 * playthroughs: 82,888 calls, 5,923 distinct keys, zero cases of one key
 * standing for two different answers.
 */

function castformState(weather: string | undefined, opposingAbility: string): BattleState {
  return {
    generation: 9,
    mode: 'Singles',
    turn: 1,
    field: weather ? {weather} : {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Castform', level: 50, ability: 'Forecast',
        hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}],
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Psyduck', level: 50, ability: opposingAbility,
        hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}],
      }]},
    },
  } as BattleState;
}

// The lookup still answers, and answers the same way twice.
const sun = castformState('Sun', 'Damp');
assert.deepEqual(getEffectiveTypes(sun, 'ai-1'), ['Fire'], 'Forecast reads the sun');
assert.deepEqual(getEffectiveTypes(sun, 'ai-1'), ['Fire'], 'and a repeat agrees with it');
assert.deepEqual(getEffectiveTypes(castformState('Rain', 'Damp'), 'ai-1'), ['Water']);
assert.deepEqual(getEffectiveTypes(castformState(undefined, 'Damp'), 'ai-1'), ['Normal']);

// THE WIDTH TEST. One state object, asked before and after an OPPOSING ability
// becomes a weather suppressor. The tables are per state object, so this is the
// only shape in which a too-narrow key can be caught: two separate states never
// share a table and would pass however narrow the key was.
const suppressing = castformState('Sun', 'Damp');
assert.deepEqual(getEffectiveTypes(suppressing, 'ai-1'), ['Fire']);
suppressing.sides.player.party[0].ability = 'Cloud Nine';
assert.deepEqual(getEffectiveTypes(suppressing, 'ai-1'), ['Normal'],
  'an opposing Cloud Nine suppresses the weather, so Forecast must fall back');
suppressing.sides.player.party[0].ability = 'Air Lock';
assert.deepEqual(getEffectiveTypes(suppressing, 'ai-1'), ['Normal'],
  'Air Lock suppresses it too');
suppressing.sides.player.party[0].ability = 'Damp';
assert.deepEqual(getEffectiveTypes(suppressing, 'ai-1'), ['Fire'],
  'and removing the suppressor restores the sun, rather than sticking');

// The field is part of the key, checked the same way: one object, edited.
const shifting = castformState('Sun', 'Damp');
assert.deepEqual(getEffectiveTypes(shifting, 'ai-1'), ['Fire']);
shifting.field.weather = 'Rain';
assert.deepEqual(getEffectiveTypes(shifting, 'ai-1'), ['Water'],
  'the field is part of the key');

// And the Pokemon itself, asked about a BENCHED one. An active Pokemon is
// already described by the actives digest above, so editing one proves nothing
// about whether the key carries the Pokemon: the first version of this
// assertion edited the active Castform, and dropping the Pokemon from the key
// entirely still passed it.
const benched = castformState('Sun', 'Damp');
benched.sides.ai.party.push({
  id: 'ai-2', species: 'Castform', level: 50, ability: 'Forecast',
  hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}],
});
const bench = benched.sides.ai.party[1];
assert.deepEqual(getEffectiveTypesForPokemon(benched, bench), ['Fire'],
  'a benched Forecast still reads the weather');
bench.ability = 'Levitate';
assert.deepEqual(getEffectiveTypesForPokemon(benched, bench), ['Normal'],
  'the Pokemon itself must be part of the key, not just the actives');

// THE ALIASING TEST. The cached array must never reach a caller, because
// `move-engine` hands this straight to `setTypeOverride`, which stores it on a
// resolution and therefore into a later state.
//
// The array has to come from a cache HIT. The first call to a fresh state is a
// miss, and a miss returned a copy even in the version of this code that
// handed the table's own array back on every hit — so mutating a first result
// proves nothing.
const aliased = castformState('Sun', 'Damp');
getEffectiveTypes(aliased, 'ai-1');
const fromHit = getEffectiveTypes(aliased, 'ai-1');
fromHit.push('Ghost');
fromHit[0] = 'Poison';
assert.deepEqual(getEffectiveTypes(aliased, 'ai-1'), ['Fire'],
  'editing a returned array must not edit the table behind it');

// The by-Pokemon entry point is the one the engine calls in hot paths, and it
// has to agree with the by-id one.
const direct = castformState('Rain', 'Damp');
assert.deepEqual(
  getEffectiveTypesForPokemon(direct, direct.sides.ai.party[0]),
  getEffectiveTypes(direct, 'ai-1'),
  'both entry points must answer the same question the same way');

console.log('Effective types memo fixtures passed');
