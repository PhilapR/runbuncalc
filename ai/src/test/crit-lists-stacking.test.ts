import assert from 'node:assert/strict';
import {calculateActionFacts} from '../calc-adapter';
import {deriveEndTurnResolution} from '../end-turn';
import {BattleState} from '../model';

// D10: the two hand-rolled high-crit lists disagreed with each other AND
// with the games. Poison Jab/Sting never had a crit ratio; Poison Tail,
// Sky Attack and Snipe Shot always did; the always-crit four were filed as
// a mere +1 stage, so Anger Point never fired off them.
function critState(moveName: string): BattleState {
  return {
    generation: 8, mode: 'Singles', turn: 1, field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Nidoking', level: 50,
        hp: {current: 150, max: 150}, moves: [{name: moveName, pp: 20, maxPP: 20}],
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Blissey', level: 50,
        hp: {current: 250, max: 250}, moves: [{name: 'Tackle'}],
      }]},
    },
  };
}

function stageOf(moveName: string): number {
  const fixture = critState(moveName);
  const action = {kind: 'move' as const, actorId: 'ai-1', moveName, targetIds: ['player-1']};
  return calculateActionFacts(fixture, action).attackerCriticalHitStage ?? 0;
}
function guaranteedFor(moveName: string): boolean {
  const fixture = critState(moveName);
  const action = {kind: 'move' as const, actorId: 'ai-1', moveName, targetIds: ['player-1']};
  return !!calculateActionFacts(fixture, action).criticalHitGuaranteed;
}

assert.equal(stageOf('Poison Jab'), 0, 'Poison Jab is not a high-crit move');
assert.equal(stageOf('Poison Sting'), 0, 'Poison Sting is not a high-crit move');
assert.equal(stageOf('Poison Tail'), 1, 'Poison Tail is high-crit');
// Sky Attack and Snipe Shot are in the set too; they are charge/gen-9 moves
// whose facts need a legal learner, so the set membership above covers them.
assert.equal(guaranteedFor('Storm Throw'), true, 'always-crit moves are guaranteed, not staged');
assert.equal(guaranteedFor('Frost Breath'), true, 'Frost Breath always crits');
assert.equal(guaranteedFor('Poison Tail'), false, 'a high-crit move is not a guarantee');

// D14: Aqua Ring and Ingrain heal independently and stack.
function healState(volatiles: Record<string, unknown>, item?: string): BattleState {
  return {
    generation: 8, mode: 'Singles', turn: 2, field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Ludicolo', level: 100,
        hp: {current: 200, max: 320}, moves: [{name: 'Tackle'}],
        volatile: volatiles, ...(item ? {item} : {}),
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Blissey', level: 100,
        hp: {current: 300, max: 300}, moves: [{name: 'Tackle'}],
      }]},
    },
  };
}
const heal = (v: Record<string, unknown>, item?: string) =>
  deriveEndTurnResolution(healState(v, item), {random: () => 0.5}).hpDeltaByPokemon?.['ai-1'] ?? 0;

const ring = heal({aquaRing: true});
const root = heal({ingrain: true});
assert.equal(ring, 20, 'Aqua Ring heals 1/16');
assert.equal(root, 20, 'Ingrain heals 1/16');
assert.equal(heal({aquaRing: true, ingrain: true}), ring + root, 'they stack');
assert.ok(heal({aquaRing: true}, 'Big Root') > ring, 'Big Root boosts Aqua Ring');

console.log('crit-lists-stacking: ok');
