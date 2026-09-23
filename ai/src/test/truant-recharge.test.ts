import assert from 'node:assert/strict';
import {calculateActionFacts} from '../calc-adapter';
import {deriveMoveResolution} from '../move-engine';
import {enumerateMoveActions} from '../actions';
import {BattleState} from '../model';
import {advanceTurn, applyAction} from '../transition';

// A Truant mon that uses a recharge move loafs and recharges on the SAME
// turn. Gen 8 (Showdown data/conditions.ts): mustrecharge gates at
// onBeforeMove priority 11, ahead of Truant at 9, and removes the truant
// volatile as it spends the turn. The Run & Bun doc does not list Truant or
// recharge, so the Gen 8 fallback applies; DECISIONS.json
// rom-gate-order-paralysis-before-infatuation already declares recharge the
// first gate. Not ROM-probed. The engine checked Truant first and left the
// recharge pending, so Slaking lost two turns after Hyper Beam, not one.
const fixture: BattleState = {
  generation: 8,
  mode: 'Singles',
  turn: 1,
  field: {},
  sides: {
    ai: {activeIds: ['ai-1'], party: [{
      id: 'ai-1', species: 'Slaking', level: 100, ability: 'Truant', abilityOn: true,
      hp: {current: 400, max: 400}, moves: [{name: 'Hyper Beam', pp: 5, maxPP: 5}],
    }]},
    player: {activeIds: ['player-1'], party: [{
      id: 'player-1', species: 'Blissey', level: 100,
      hp: {current: 2000, max: 2000}, moves: [{name: 'Splash'}],
    }]},
  },
};
// The engine's own offer each turn: the recharge turn offers Hyper Beam with
// no targets, the way the battle loop plays it.
function turn(state: BattleState) {
  const [action] = enumerateMoveActions(state, 'ai');
  assert.equal(action.moveName, 'Hyper Beam');
  const resolution = deriveMoveResolution(state, action, {
    facts: calculateActionFacts(state, action), random: () => 0.5,
  });
  return {resolution, after: advanceTurn(applyAction(state, action, resolution))};
}

// Turn 1: Hyper Beam lands, and both the loaf and the recharge are owed.
const one = turn(fixture);
assert.equal(one.resolution.hit, true, 'turn 1: Hyper Beam lands');
const armed = one.after.sides.ai.party[0].volatile;
assert.ok(armed?.truant, 'turn 1 arms the loaf');
assert.ok(armed?.recharge, 'turn 1 arms the recharge');

// Turn 2: the turn is spent recharging, and the loaf is spent with it.
const two = turn(one.after);
assert.equal(two.resolution.hit, false, 'turn 2 is lost');
const spent = two.after.sides.ai.party[0].volatile;
assert.equal(spent?.recharge, undefined, 'turn 2 spends the recharge');
assert.equal(spent?.truant, undefined, 'turn 2 spends the loaf with it');

// Turn 3: Slaking acts again. One lost turn, not two.
const three = turn(two.after);
assert.equal(three.resolution.actionFailure, undefined, 'turn 3 is not a loaf');
assert.equal(three.resolution.hit, true, 'turn 3: Hyper Beam lands again');

console.log('truant-recharge: ok');
