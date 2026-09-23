import assert from 'node:assert/strict';
import {calculateActionFacts} from '../calc-adapter';
import {deriveMoveResolution} from '../move-engine';
import {BattleState} from '../model';

// D1: before this, P(crit) was ZERO in every sampled outcome outside Laser
// Focus — the engine computed a crit STAGE with no consumer. Kaizo plans
// that read "survives two hits" were blind to the 1/16 event that ends runs.
function state(opts: {defenderAbility?: string; luckyChant?: boolean; item?: string} = {}): BattleState {
  return {
    generation: 8,
    mode: 'Singles',
    turn: 1,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Machamp', level: 50,
        hp: {current: 150, max: 150}, moves: [{name: 'Karate Chop', pp: 25, maxPP: 25}],
        ...(opts.item ? {item: opts.item} : {}),
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Blissey', level: 50,
        hp: {current: 250, max: 250}, moves: [{name: 'Tackle'}],
        ...(opts.defenderAbility ? {ability: opts.defenderAbility, abilityOn: true} : {}),
      }], ...(opts.luckyChant ? {effects: {luckyChant: true}} : {})},
    },
  };
}

function damageAt(roll: number, opts?: Parameters<typeof state>[0]): number {
  const fixture = state(opts);
  const action = {kind: 'move' as const, actorId: 'ai-1', moveName: 'Karate Chop', targetIds: ['player-1']};
  const resolution = deriveMoveResolution(fixture, action, {
    facts: calculateActionFacts(fixture, action), random: () => roll,
  });
  return resolution.damageByTarget?.['player-1'] ?? 0;
}

function critFlagged(roll: number, opts?: Parameters<typeof state>[0]): boolean {
  const fixture = state(opts);
  const action = {kind: 'move' as const, actorId: 'ai-1', moveName: 'Karate Chop', targetIds: ['player-1']};
  const resolution = deriveMoveResolution(fixture, action, {
    facts: calculateActionFacts(fixture, action), random: () => roll,
  });
  return !!resolution.criticalHitTargets?.includes('player-1');
}

// Karate Chop is a high-crit move (stage 1 = 1/8): a 0.01 roll crits,
// a 0.9 roll does not — and the crit lands strictly harder.
assert.equal(critFlagged(0.01), true, 'a low roll must produce a critical hit');
assert.equal(critFlagged(0.9), false, 'a high roll must not');
assert.ok(damageAt(0.01) > damageAt(0.9),
  'the sampled critical must deal more damage than the ordinary hit');

// Lucky Chant and Battle Armor make crits impossible — no crit, ever.
assert.equal(critFlagged(0.001, {luckyChant: true}), false, 'Lucky Chant blocks crits');
assert.equal(critFlagged(0.001, {defenderAbility: 'Battle Armor'}), false, 'Battle Armor blocks crits');
// R&B extends the block to Magma Armor (documented hack change).
assert.equal(critFlagged(0.001, {defenderAbility: 'Magma Armor'}), false, 'Magma Armor blocks crits in R&B');

console.log('critical-hits: ok');
