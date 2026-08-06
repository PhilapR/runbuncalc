import assert from 'node:assert/strict';
import {enumerateMoveActions} from '../actions';
import {deriveMoveResolution} from '../move-engine';
import {BattleState, MoveAction} from '../model';

function state(): BattleState {
  return {
    generation: 9,
    mode: 'Singles',
    turn: 1,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Pikachu', level: 100,
        hp: {current: 100, max: 100}, moves: [{name: 'Trick'}],
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Rattata', level: 100,
        hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}],
      }]},
    },
  };
}

function move(moveName: string) {
  return {kind: 'move' as const, actorId: 'ai-1', moveName, targetIds: ['player-1']};
}

for (const moveName of ['Trick', 'Switcheroo']) {
  const empty = state();
  empty.sides.ai.party[0].moves = [{name: moveName}];
  assert.equal(enumerateMoveActions(empty, 'ai').some((action: MoveAction) => action.moveName === moveName), false);
  assert.equal(deriveMoveResolution(empty, move(moveName), {hit: true}).hit, false);

  empty.sides.ai.party[0].item = 'Choice Band';
  assert.equal(enumerateMoveActions(empty, 'ai').some((action: MoveAction) => action.moveName === moveName), true);
}

const bestow = state();
bestow.sides.ai.party[0].moves = [{name: 'Bestow'}];
bestow.sides.ai.party[0].item = 'Sitrus Berry';
assert.equal(enumerateMoveActions(bestow, 'ai').some((action: MoveAction) => action.moveName === 'Bestow'), true);
bestow.sides.player.party[0].item = 'Leftovers';
assert.equal(enumerateMoveActions(bestow, 'ai').some((action: MoveAction) => action.moveName === 'Bestow'), false);
assert.equal(deriveMoveResolution(bestow, move('Bestow'), {hit: true}).hit, false);

const stickyHold = state();
stickyHold.sides.ai.party[0].moves = [{name: 'Trick'}];
stickyHold.sides.player.party[0].item = 'Leftovers';
stickyHold.sides.player.party[0].ability = 'Sticky Hold';
assert.equal(enumerateMoveActions(stickyHold, 'ai').some((action: MoveAction) => action.moveName === 'Trick'), false);
assert.equal(deriveMoveResolution(stickyHold, move('Trick'), {hit: true}).hit, false);

console.log('Item legality fixtures passed');
