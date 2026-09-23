import assert from 'node:assert/strict';
import {calculateActionFacts} from '../calc-adapter';
import {deriveMoveResolution} from '../move-engine';
import {BattleState} from '../model';

// D2: a variable multi-hit is 35/35/15/15 for 2/3/4/5 hits. The calculator
// pins it at 3 for its damage display; a sampling engine must roll, or
// Rock Blast-class moves never deal their real spread.
function blastState(): BattleState {
  return {
    generation: 8, mode: 'Singles', turn: 1, field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Cloyster', level: 50,
        hp: {current: 150, max: 150}, moves: [{name: 'Rock Blast', pp: 10, maxPP: 10}],
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Blissey', level: 50,
        hp: {current: 250, max: 250}, moves: [{name: 'Tackle'}],
      }]},
    },
  };
}
function hitsAt(roll: number): number {
  const fixture = blastState();
  const action = {kind: 'move' as const, actorId: 'ai-1', moveName: 'Rock Blast', targetIds: ['player-1']};
  const resolution = deriveMoveResolution(fixture, action, {
    facts: calculateActionFacts(fixture, action), hit: true, random: () => roll,
  });
  return (resolution.hitDamageByTarget?.['player-1'] || []).length;
}
assert.equal(hitsAt(0.1), 2, '35% two hits');
assert.equal(hitsAt(0.5), 3, '35% three hits');
assert.equal(hitsAt(0.8), 4, '15% four hits');
assert.equal(hitsAt(0.95), 5, '15% five hits');

// D5: a defrost move always thaws its user and executes — no 20% roll.
function frozen(moveName: string): BattleState {
  return {
    generation: 8, mode: 'Singles', turn: 1, field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Blastoise', level: 50, status: 'frz',
        hp: {current: 150, max: 150}, moves: [{name: moveName, pp: 10, maxPP: 10}],
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Blissey', level: 50,
        hp: {current: 250, max: 250}, moves: [{name: 'Tackle'}],
      }]},
    },
  };
}
function thaws(moveName: string, roll: number): boolean {
  const fixture = frozen(moveName);
  const action = {kind: 'move' as const, actorId: 'ai-1', moveName, targetIds: ['player-1']};
  const resolution = deriveMoveResolution(fixture, action, {
    facts: calculateActionFacts(fixture, action), random: () => roll,
  });
  return resolution.actionFailure !== 'freeze';
}
assert.equal(thaws('Scald', 0.99), true, 'Scald always thaws its user');
assert.equal(thaws('Surf', 0.99), false, 'an ordinary move still needs the 20% roll');
assert.equal(thaws('Surf', 0.01), true, 'and passes it on a low roll');

// D9: a held King's Rock adds a 10% flinch to a move with no flinch of its own.
function rockState(item?: string): BattleState {
  return {
    generation: 8, mode: 'Singles', turn: 1, field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Machamp', level: 50, ...(item ? {item} : {}),
        hp: {current: 150, max: 150}, moves: [{name: 'Tackle', pp: 35, maxPP: 35}],
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Blissey', level: 50,
        hp: {current: 250, max: 250}, moves: [{name: 'Tackle'}],
      }]},
    },
  };
}
function flinched(item: string | undefined, roll: number): boolean {
  const fixture = rockState(item);
  const action = {kind: 'move' as const, actorId: 'ai-1', moveName: 'Tackle', targetIds: ['player-1']};
  const resolution = deriveMoveResolution(fixture, action, {
    facts: calculateActionFacts(fixture, action), hit: true, random: () => roll,
  });
  return !!(resolution.volatileByPokemon?.['player-1'] as {flinch?: unknown})?.flinch;
}
assert.equal(flinched("King's Rock", 0.05), true, 'a low roll flinches through the item');
assert.equal(flinched("King's Rock", 0.5), false, 'a high roll does not');
assert.equal(flinched(undefined, 0.05), false, 'no item, no flinch');

console.log('multihit-defrost-flinch: ok');
