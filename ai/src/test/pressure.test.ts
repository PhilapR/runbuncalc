import assert from 'node:assert/strict';
import {recordMoveAction} from '../transition';
import {BattleState} from '../model';

function state(): BattleState {
  return {
    generation: 9,
    mode: 'Singles',
    turn: 1,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Pikachu', level: 100, ability: 'Overgrow',
        hp: {current: 100, max: 100}, moves: [{name: 'Tackle', pp: 10, maxPP: 10}],
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Mewtwo', level: 100, ability: 'Pressure',
        hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}],
      }]},
    },
  };
}

function move() {
  return {kind: 'move' as const, actorId: 'ai-1', moveName: 'Tackle', targetIds: ['player-1']};
}

const pressured = recordMoveAction(state(), move());
assert.equal(pressured.sides.ai.party[0].moves[0].pp, 8);

const ordinary = state();
ordinary.sides.player.party[0].ability = 'Overgrow';
assert.equal(recordMoveAction(ordinary, move()).sides.ai.party[0].moves[0].pp, 9);

const prePressure = state();
prePressure.generation = 2;
assert.equal(recordMoveAction(prePressure, move()).sides.ai.party[0].moves[0].pp, 9);

const suppressedPressure = state();
suppressedPressure.sides.player.party[0].abilitySuppressed = true;
assert.equal(recordMoveAction(suppressedPressure, move()).sides.ai.party[0].moves[0].pp, 9);

console.log('Pressure fixtures passed');
