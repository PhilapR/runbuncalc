import assert from 'node:assert/strict';
import {calculateActionFacts} from '../calc-adapter';
import {BattleState, MoveState} from '../model';

function state(move: MoveState, attackerAbility?: string, defenderAbility?: string): BattleState {
  return {
    generation: 9,
    mode: 'Singles',
    turn: 1,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Pikachu', level: 100, ability: attackerAbility,
        hp: {current: 100, max: 100}, moves: [move],
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Mewtwo', level: 100, ability: defenderAbility,
        hp: {current: 1000, max: 1000}, moves: [{name: 'Tackle'}],
      }]},
    },
  };
}

function facts(move: MoveState, attackerAbility?: string, defenderAbility?: string) {
  const battle = state(move, attackerAbility, defenderAbility);
  return calculateActionFacts(battle, {
    kind: 'move', actorId: 'ai-1', moveName: move.name, targetIds: ['player-1'],
  });
}

const baseMove: MoveState = {
  name: 'Caller Defined Flag Move', basePower: 80, type: 'Normal', category: 'Physical', target: 'normal',
};
const baseDamage = facts(baseMove).damage?.max || 0;
assert.ok(baseDamage > 0);

assert.ok((facts({...baseMove, name: 'Caller Defined Punch Move', punch: true}, 'Iron Fist').damage?.max || 0) > baseDamage);
assert.ok((facts({...baseMove, name: 'Caller Defined Bite Move', type: 'Dark', bite: true}, 'Strong Jaw').damage?.max || 0) > baseDamage);
assert.ok((facts({...baseMove, name: 'Caller Defined Pulse Move', type: 'Water', category: 'Special', pulse: true}, 'Mega Launcher').damage?.max || 0) > baseDamage);
assert.ok((facts({...baseMove, name: 'Caller Defined Slicing Move', slicing: true}, 'Sharpness').damage?.max || 0) > baseDamage);

const bulletproofFacts = facts({
  ...baseMove, name: 'Caller Defined Bullet Move', bullet: true,
}, undefined, 'Bulletproof');
assert.equal(bulletproofFacts.damage?.max, 0);

console.log('Custom calculator flag fixtures passed');
