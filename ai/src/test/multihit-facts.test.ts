import assert from 'node:assert/strict';
import {calculateActionFacts} from '../calc-adapter';
import {BattleState} from '../model';

// The engine rolls a [2,5] move at 35/35/15/15 (see multihit-defrost-flinch).
// The FACTS the planner reads must span that same range. @smogon/calc pins
// every variable multi-hit at 3 hits for its damage display; a fact built
// from that pin claims a ceiling the game beats 30% of the time, and a
// guaranteedKO the game misses 35% of the time. Planning is worst-case:
// our floor is two hits at the minimum roll, their ceiling is five at the
// maximum.
function spearState(targetHp: number): BattleState {
  return {
    generation: 8, mode: 'Singles', turn: 1, field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Cloyster', level: 50,
        hp: {current: 150, max: 150}, moves: [{name: 'Icicle Spear', pp: 10, maxPP: 10}],
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Blissey', level: 50,
        hp: {current: targetHp, max: 250}, moves: [{name: 'Tackle'}],
      }]},
    },
  };
}
function damageFacts(targetHp: number) {
  const fixture = spearState(targetHp);
  const facts = calculateActionFacts(fixture, {
    kind: 'move', actorId: 'ai-1', moveName: 'Icicle Spear', targetIds: ['player-1'],
  });
  const damage = facts.damage;
  assert.ok(damage, 'the fixture must produce damage facts');
  return damage;
}

const wide = damageFacts(250);
assert.deepEqual(wide.hitRange, [2, 5], 'a variable multi-hit carries its hit range');
const perHitMin = Math.min(...wide.rolls);
const perHitMax = Math.max(...wide.rolls);
assert.equal(wide.min, perHitMin * 2, 'the floor is two hits, not the calculator pin of three');
assert.equal(wide.max, perHitMax * 5, 'the ceiling is five hits, not three');
assert.ok(wide.critMax !== undefined && wide.critMax >= wide.max,
  'the crit ceiling is built over the same range');

// A target the move kills only on four or five hits is POSSIBLE, not guaranteed.
const marginal = damageFacts(Math.floor(perHitMax * 5) - 1);
assert.equal(marginal.possibleKO, true, 'five maximum hits reach it');
assert.equal(marginal.guaranteedKO, false,
  'a KO that needs more than two hits is never guaranteed');

// The one target it does guarantee: two minimum hits already kill.
const doomed = damageFacts(perHitMin * 2);
assert.equal(doomed.guaranteedKO, true, 'two minimum hits killing it IS a guarantee');

// Skill Link removes the roll, so it removes the range too.
const skillLink = spearState(250);
skillLink.sides.ai.party[0].ability = 'Skill Link';
skillLink.sides.ai.party[0].abilityOn = true;
const pinned = calculateActionFacts(skillLink, {
  kind: 'move', actorId: 'ai-1', moveName: 'Icicle Spear', targetIds: ['player-1'],
}).damage;
assert.ok(pinned, 'Skill Link still produces damage facts');
assert.equal(pinned.hitRange, undefined, 'Skill Link has no range to span');
assert.equal(pinned.hits, 5, 'Skill Link always hits five times');

console.log('multihit-facts: ok');
