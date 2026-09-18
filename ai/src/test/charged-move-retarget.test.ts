import assert from 'node:assert/strict';
import {calculateActionFacts} from '../calc-adapter';
import {chargeTargets, enumerateMoveActions} from '../actions';
import {deriveMoveResolution} from '../move-engine';
import {BattleState} from '../model';
import {applyAction} from '../transition';

// A charged move lands on whoever holds the target's position when it is
// released. The charge stored the original target's id and the engine used
// it verbatim: Sawsbuck's Bounce went up at Walrein, Walrein was switched out
// for Empoleon, and the release computed damage for the benched Walrein while
// the action named Empoleon — "Damage references a non-target of the move".

function state(activePlayer: string): BattleState {
  return {
    generation: 8,
    mode: 'Singles',
    turn: 2,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Sawsbuck', level: 50, hp: {current: 150, max: 150},
        moves: [{name: 'Bounce', pp: 5, maxPP: 5}],
        volatile: {charge: {turns: 1, moveName: 'Bounce', targetIds: ['player-1']}},
      } as never]},
      player: {activeIds: [activePlayer], party: [
        {id: 'player-1', species: 'Walrein', level: 50, hp: {current: 150, max: 150}, moves: [{name: 'Surf'}]},
        {id: 'player-2', species: 'Empoleon', level: 50, hp: {current: 150, max: 150}, moves: [{name: 'Surf'}]},
      ]},
    },
  };
}

// The target stayed in: nothing changes, the stored target is the target.
const stayed = state('player-1');
assert.deepEqual(chargeTargets(stayed, ['player-1']), ['player-1']);
assert.deepEqual(enumerateMoveActions(stayed, 'ai')[0].targetIds, ['player-1']);

// The target switched out: the release lands on the replacement.
const swapped = state('player-2');
assert.deepEqual(chargeTargets(swapped, ['player-1']), ['player-2']);
const release = enumerateMoveActions(swapped, 'ai')[0];
assert.equal(release.moveName, 'Bounce');
assert.deepEqual(release.targetIds, ['player-2'], 'the enumerated release aims at who is in');
const resolution = deriveMoveResolution(swapped, release, {
  facts: calculateActionFacts(swapped, release), hit: true, random: () => 0.5,
});
assert.deepEqual(Object.keys(resolution.damageByTarget || {}), ['player-2'],
  'and its damage is computed for who is in, not for the benched body');
const after = applyAction(swapped, release, resolution);
assert.ok(after.sides.player.party[1].hp.current < 150, 'Empoleon takes the Bounce');
assert.equal(after.sides.player.party[0].hp.current, 150, 'the benched Walrein is untouched');

console.log('Charged move retarget fixtures passed');
