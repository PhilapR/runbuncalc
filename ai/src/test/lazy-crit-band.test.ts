import * as Calc from '@smogon/calc';
import assert from 'node:assert/strict';

/**
 * The crit band is DEFERRED until something reads it.
 *
 * It costs a second `Calc.Move` and a second `Calc.calculate`, and it was the
 * largest remaining source of constructed objects in a played fight. The policy
 * prices every candidate action while only the chosen one ever has its crit
 * sampled: counted over six real playthroughs, 151,170 bands were computed and
 * 31,583 were ever read. Deferring took a fight from 442,363 constructed
 * objects to 322,776.
 *
 * Two things have to hold, and only one of them is about the numbers.
 *
 * It must not compute until asked — which is the whole point, and which a test
 * that only checks values would pass without deferring anything.
 *
 * And it must remain INDISTINGUISHABLE from data properties to every caller.
 * `lib/planner.js` reads `damage.critMax !== undefined`, `lib/battle-driver.js`
 * divides by it, `resolution.ts` indexes `critRolls`, and the run API serializes
 * whole facts objects to JSON. Enumerable accessors satisfy all of those by
 * forcing the computation, which is correct; a non-enumerable one, or a plain
 * thunk, would silently drop the band out of `JSON.stringify` and out of every
 * `deepEqual` in this suite.
 */

// Count Move construction, which is what the deferral is avoiding. Patch
// before the adapter loads so the class the engine closes over is the counted
// one.
let movesBuilt = 0;
class CountedMove extends Calc.Move {
  constructor(...args: ConstructorParameters<typeof Calc.Move>) {
    super(...args);
    movesBuilt += 1;
  }
}
Object.defineProperty(Calc, 'Move', {value: CountedMove, writable: true});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {calculateActionFacts} = require('../calc-adapter');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {BattleState} = require('../model');
void BattleState;

function state() {
  return {
    generation: 9,
    mode: 'Singles',
    turn: 1,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Pikachu', level: 100,
        hp: {current: 300, max: 300}, moves: [{name: 'Thunderbolt'}],
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Snorlax', level: 100,
        hp: {current: 300, max: 300}, moves: [{name: 'Tackle'}],
      }]},
    },
  };
}
const bolt = {
  kind: 'move' as const, actorId: 'ai-1', moveName: 'Thunderbolt', targetIds: ['player-1'],
};

// DEFERRAL. Building the facts must not build the crit move; reading the band
// must. A fresh state each time, so the facts memo cannot serve the answer.
movesBuilt = 0;
const facts = calculateActionFacts(state(), bolt);
const afterFacts = movesBuilt;
assert.ok(facts.damage && facts.damage.max > 0, 'the fixture must actually deal damage');
const beforeRead = movesBuilt;
const critMax = facts.damage.critMax;
assert.ok(movesBuilt > beforeRead,
  'reading the band must build the crit move; nothing was deferred if it did not');

// Reading the other two must NOT build a second one: all three come from one
// calculation and the closure has to remember it.
const afterFirstRead = movesBuilt;
void facts.damage.critRolls;
void facts.damage.critMin;
void facts.damage.critMax;
assert.equal(movesBuilt, afterFirstRead,
  'the band must be computed once and shared, not once per property');
void afterFacts;

// VALUES. A crit is at least as hard as an ordinary hit, and the band has to
// be a real distribution rather than a placeholder.
assert.ok(typeof critMax === 'number' && critMax >= facts.damage.max,
  'a critical hit cannot land for less than the ordinary maximum');
assert.ok(Array.isArray(facts.damage.critRolls) && facts.damage.critRolls.length > 0,
  'the band must carry its rolls');
assert.ok(typeof facts.damage.critMin === 'number' && facts.damage.critMin <= critMax);

// INDISTINGUISHABLE FROM DATA. Every one of these is a real caller pattern, and
// each would break on a non-enumerable accessor or a thunk.
const fresh = calculateActionFacts(state(), bolt).damage;
assert.ok(Object.keys(fresh).includes('critMax'), 'Object.keys must see the band');
assert.ok('critMax' in fresh, 'the `in` operator must see it');
const spread = {...calculateActionFacts(state(), bolt).damage};
assert.equal(typeof spread.critMax, 'number', 'spread must carry a value, not a getter');
const roundTripped = JSON.parse(
  JSON.stringify(calculateActionFacts(state(), bolt).damage));
assert.equal(typeof roundTripped.critMax, 'number',
  'JSON.stringify must serialize the band, which is how the run API ships it');
assert.ok(Array.isArray(roundTripped.critRolls));

// A status move has no band at all, and deferring must not invent one.
const growl = {
  kind: 'move' as const, actorId: 'ai-1', moveName: 'Growl', targetIds: ['player-1'],
};
const statusFacts = calculateActionFacts(state(), growl);
assert.equal(statusFacts.damage?.critMax, undefined,
  'a status move must still have no crit band');

console.log('Lazy crit band fixtures passed');
