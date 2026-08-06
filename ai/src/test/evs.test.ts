import assert from 'node:assert/strict';
import * as Calc from '@smogon/calc';
import {calculateActionFacts} from '../calc-adapter';
import {getRawStats} from '../stat-transforms';
import {BattleState} from '../model';

function state(
  generation: BattleState['generation'] = 9,
  evs?: BattleState['sides']['ai']['party'][number]['evs'],
): BattleState {
  return {
    generation,
    mode: 'Singles',
    turn: 1,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Pikachu', level: 100, hp: {current: 100, max: 100},
        moves: [{name: 'Thunderbolt'}], evs,
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Rattata', level: 100, hp: {current: 100, max: 100},
        moves: [{name: 'Tackle'}], evs,
      }]},
    },
  };
}

const maxEvs = {hp: 252, atk: 252, def: 252, spa: 252, spd: 252, spe: 252};
const action = {kind: 'move' as const, actorId: 'ai-1', moveName: 'Thunderbolt', targetIds: ['player-1']};
const zeroFacts = calculateActionFacts(state(), action);
const suppliedFacts = calculateActionFacts(state(9, maxEvs), action);
assert.deepEqual(suppliedFacts.damage, zeroFacts.damage);

const generation = Calc.Generations.get(9);
const zeroStats = getRawStats(generation, state().sides.ai.party[0]);
const suppliedStats = getRawStats(generation, state(9, maxEvs).sides.ai.party[0]);
assert.deepEqual(suppliedStats, zeroStats);

const gen2ZeroFacts = calculateActionFacts(state(2), {
  kind: 'move', actorId: 'ai-1', moveName: 'Thunderbolt', targetIds: ['player-1'],
});
const gen2SuppliedFacts = calculateActionFacts(state(2, maxEvs), {
  kind: 'move', actorId: 'ai-1', moveName: 'Thunderbolt', targetIds: ['player-1'],
});
assert.deepEqual(gen2SuppliedFacts.damage, gen2ZeroFacts.damage);

const gen2 = Calc.Generations.get(2);
assert.deepEqual(
  getRawStats(gen2, state(2).sides.ai.party[0]),
  getRawStats(gen2, state(2, maxEvs).sides.ai.party[0]),
);

console.log('Run & Bun EV-removal fixtures passed');
