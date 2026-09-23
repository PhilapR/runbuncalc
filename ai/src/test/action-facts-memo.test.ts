import assert from 'node:assert/strict';
import {calculateActionFacts} from '../calc-adapter';
import {BattleState} from '../model';

/**
 * The memo in front of `calculateActionFacts`, gated on the two things that
 * can make it wrong rather than on the speedup.
 *
 * It exists because the policy prices every candidate action every turn: one
 * playbook called that function 20,681 times against 2,407 distinct states.
 * Memoizing it took a fight from 1,098,727 constructed calculator objects to
 * 489,657 with byte-identical output.
 *
 * The first key shipped here was the state's IDENTITY, on the strength of
 * instrumenting 20,681 production calls and finding zero cases of a state
 * object changing under it. That evidence was real and the conclusion was
 * wrong: `metadata.test.ts` builds fixtures by editing a state in place and
 * re-querying it, which is a legitimate thing to do and which identity-keying
 * silently answers from before the edit. It turned a Scope Lens into
 * `undefined`. The first assertion below is that exact case.
 *
 * The second is the other half of the key. `MoveAction` is six fields, and a
 * key that forgets one answers a different question with the same table.
 */

function freshState(): BattleState {
  return {
    generation: 9,
    mode: 'Singles',
    turn: 1,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Pikachu', level: 100,
        hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}, {name: 'Thunderbolt'}],
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Rattata', level: 100,
        hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}],
      }]},
    },
  };
}

const tackle = {
  kind: 'move' as const, actorId: 'ai-1', moveName: 'Tackle', targetIds: ['player-1'],
};

// A repeat of the same question on the same untouched state is the whole point:
// same answer, and the identical object rather than an equal one.
const state = freshState();
const first = calculateActionFacts(state, tackle);
const second = calculateActionFacts(state, tackle);
assert.equal(first, second, 'a repeated question must come back from the memo');

// EDITED IN PLACE. This is the case that identity-keying got wrong, and it is
// not exotic: it is how the fixtures in this directory are written.
state.sides.ai.party[0].item = 'Scope Lens';
const afterItem = calculateActionFacts(state, tackle);
assert.equal(afterItem.attackerItem, 'Scope Lens',
  'a state edited in place must not answer from before the edit');
assert.notEqual(afterItem, first, 'the memo must have rebuilt, not been reused');

// And the edit is not a one-way door: editing back must answer as before.
state.sides.ai.party[0].item = undefined;
const afterRemoval = calculateActionFacts(state, tackle);
assert.equal(afterRemoval.attackerItem, undefined,
  'removing the item must answer as it did before the item existed');

// Two states that are equal but separate objects must both answer, and answer
// the same. A memo keyed on identity alone would hold two tables here, which is
// wasteful but correct; one keyed on content alone would hold one. Either is
// fine. Answering differently is not.
const twin = freshState();
const twinFacts = calculateActionFacts(twin, tackle);
assert.deepEqual(twinFacts.damage, calculateActionFacts(freshState(), tackle).damage,
  'equal states must produce equal facts');

// EVERY FIELD OF THE ACTION KEY. A key that drops one of these hands the
// answer for one action to a different action. `moveName` is checked by damage
// because Thunderbolt and Tackle differ enormously against a Rattata.
const bolt = {...tackle, moveName: 'Thunderbolt'};
const boltFacts = calculateActionFacts(state, bolt);
assert.ok((boltFacts.damage?.max || 0) !== (afterRemoval.damage?.max || 0),
  'moveName must be part of the key');

// `actorId` and `targetIds`, checked SEPARATELY. Swapping both at once looks
// like a stronger test and is a weaker one: with both changed, dropping either
// from the key still leaves the other to tell them apart, so the assertion
// passes while half of what it claims is unguarded. Removing `targetIds` from
// the key was falsified against a both-at-once version of this and it passed.
const otherActor = {
  kind: 'move' as const, actorId: 'player-1', moveName: 'Tackle', targetIds: ['player-1'],
};
assert.ok(calculateActionFacts(state, otherActor) !== afterRemoval,
  'actorId must be part of the key');

const otherTarget = {
  kind: 'move' as const, actorId: 'ai-1', moveName: 'Tackle', targetIds: ['ai-1'],
};
assert.ok(calculateActionFacts(state, otherTarget) !== afterRemoval,
  'targetIds must be part of the key');

// `useZ`, `useMax` and `reactive` are the three flags easiest to leave out,
// because a fixture rarely sets them. Each must still key separately.
const plain = calculateActionFacts(state, tackle);
const maxed = calculateActionFacts(state, {...tackle, useMax: true});
assert.ok(plain !== maxed, 'useMax must be part of the key');
const zeta = calculateActionFacts(state, {...tackle, useZ: true});
assert.ok(plain !== zeta && maxed !== zeta, 'useZ must be part of the key');
const reactive = calculateActionFacts(state, tackle, {reactive: true});
assert.ok(plain !== reactive, 'the reactive option must be part of the key');

console.log('Action facts memo fixtures passed');
