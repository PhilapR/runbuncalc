import assert from 'node:assert/strict';
import {calculateActionFacts} from '../calc-adapter';
import {deriveMoveResolution} from '../move-engine';
import {BattleState, MoveAction} from '../model';
import {applyAction} from '../transition';

// Parental Bond hits twice and each hit rolls its own critical hit (Showdown
// runs getDamage, and with it the crit roll, once per hit in
// hitStepMoveHitLoop). The engine drew the per-hit crit flags, reported the
// crit in criticalHitTargets and the trace — and then sampled the split-hit
// branch without the crit flag, so the announced crit dealt ordinary damage.
const state: BattleState = {
  generation: 8,
  mode: 'Singles',
  turn: 1,
  field: {},
  sides: {
    ai: {activeIds: ['ai-1'], party: [{
      id: 'ai-1', species: 'Kangaskhan', level: 100, ability: 'Parental Bond', abilityOn: true,
      hp: {current: 300, max: 300}, moves: [{name: 'Tackle'}],
    }]},
    player: {activeIds: ['player-1'], party: [{
      id: 'player-1', species: 'Mewtwo', level: 100,
      hp: {current: 1000, max: 1000}, moves: [{name: 'Tackle'}],
    }]},
  },
};
const action: MoveAction = {kind: 'move', actorId: 'ai-1', moveName: 'Tackle', targetIds: ['player-1']};
const facts = calculateActionFacts(state, action);
const damage = facts.damage!;
assert.equal(damage.hitRolls?.length, 2, 'Parental Bond is a split two-hit fact');
assert.equal(damage.critHitRolls?.length, 2, 'the crit band is split per hit too');
assert.ok(damage.critHitRolls![0][0] > damage.hitRolls![0][0], 'a critical first hit is bigger');

// Draw order: one crit draw per hit, then one damage draw per hit. The first
// hit crits (0 < 1/16), the second does not (0.9), and both damage draws
// take the lowest roll.
function drawing(sequence: number[]): () => number {
  let index = 0;
  return () => (index < sequence.length ? sequence[index++] : 0);
}
const firstCrits = deriveMoveResolution(state, action, {facts, hit: true, random: drawing([0, 0.9, 0, 0])});
assert.deepEqual(firstCrits.criticalHitTargets, ['player-1']);
assert.deepEqual(firstCrits.hitDamageByTarget?.['player-1'],
  [damage.critHitRolls![0][0], damage.hitRolls![1][0]],
  'the critting hit deals crit damage; the other hit does not');
const applied = applyAction(state, action, firstCrits);
assert.equal(applied.sides.player.party[0].hp.current,
  1000 - damage.critHitRolls![0][0] - damage.hitRolls![1][0]);

// Only the second hit crits.
const secondCrits = deriveMoveResolution(state, action, {facts, hit: true, random: drawing([0.9, 0, 0, 0])});
assert.deepEqual(secondCrits.hitDamageByTarget?.['player-1'],
  [damage.hitRolls![0][0], damage.critHitRolls![1][0]]);

// No crit: both hits ordinary, and no crit is announced.
const noCrit = deriveMoveResolution(state, action, {facts, hit: true, random: drawing([0.9, 0.9, 0, 0])});
assert.equal(noCrit.criticalHitTargets, undefined);
assert.deepEqual(noCrit.hitDamageByTarget?.['player-1'], [damage.hitRolls![0][0], damage.hitRolls![1][0]]);

console.log('parental-bond-crit: ok');
