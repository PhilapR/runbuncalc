import assert from 'node:assert/strict';
import {calculateActionFacts} from '../calc-adapter';
import {deriveMoveResolution} from '../move-engine';
import {BattleState} from '../model';

// An explicit MoveState.hits pins a multi-hit count. The calculator honours
// it (calc-adapter passes it to Calc.Move), but getEffectiveMoveMetadata
// still reported the move's 2-5 multiHitRange, so the engine rolled a count
// and overwrote the pinned one.
function state(hits?: number): BattleState {
  return {
    generation: 8,
    mode: 'Singles',
    turn: 1,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Cloyster', level: 100,
        hp: {current: 300, max: 300},
        moves: [{name: 'Rock Blast', pp: 10, maxPP: 10, ...(hits === undefined ? {} : {hits})}],
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Blissey', level: 100,
        hp: {current: 600, max: 600}, moves: [{name: 'Tackle'}],
      }]},
    },
  };
}
const action = {kind: 'move' as const, actorId: 'ai-1', moveName: 'Rock Blast', targetIds: ['player-1']};

// Pinned at five: facts carry five hits and no range, and a 0 draw (which
// would roll two hits) still lands five.
{
  const fixture = state(5);
  const facts = calculateActionFacts(fixture, action);
  assert.equal(facts.damage?.hits, 5);
  assert.equal(facts.multiHitRange, undefined, 'a pinned count carries no range to roll');
  const resolution = deriveMoveResolution(fixture, action, {facts, hit: true, random: () => 0});
  assert.equal(resolution.hitDamageByTarget?.['player-1']?.length, 5, 'the pinned count is honoured');
}

// Unpinned, the range still rolls: a 0 draw is two hits.
{
  const fixture = state();
  const facts = calculateActionFacts(fixture, action);
  assert.deepEqual(facts.multiHitRange, [2, 5]);
  const resolution = deriveMoveResolution(fixture, action, {facts, hit: true, random: () => 0});
  assert.equal(resolution.hitDamageByTarget?.['player-1']?.length, 2);
}

console.log('move-state-hits: ok');
