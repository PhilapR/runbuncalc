import assert from 'node:assert/strict';
import {deriveMoveResolution} from '../move-engine';
import {BattleState, MoveAction} from '../model';
import {applyAction, applyDamageAction, beginNextTurn, resolveMoveAction} from '../transition';

function makeState(playerHp = 100): BattleState {
  return {
    generation: 8,
    mode: 'Singles',
    turn: 1,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Pikachu', level: 100, hp: {current: 100, max: 100},
        moves: [{name: 'Tackle'}, {name: 'Endure'}],
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Rattata', level: 100, hp: {current: playerHp, max: 100},
        moves: [{name: 'Tackle'}],
      }]},
    },
  };
}

function tackleAction(): MoveAction {
  return {kind: 'move', actorId: 'ai-1', moveName: 'Tackle', targetIds: ['player-1']};
}

function endureAction(): MoveAction {
  return {kind: 'move', actorId: 'ai-1', moveName: 'Endure', targetIds: ['ai-1']};
}

const endured = makeState();
endured.sides.player.party[0].volatile = {endure: {turns: 1}};
const enduredNext = resolveMoveAction(endured, tackleAction(), {
  hit: true,
  damageByTarget: {'player-1': 200},
});
assert.equal(enduredNext.sides.player.party[0].hp.current, 1);
assert.equal(enduredNext.sides.player.party[0].volatile?.endure?.turns, 1);
assert.equal(enduredNext.sides.player.party[0].volatile?.protected, undefined);

const ended = beginNextTurn(enduredNext);
assert.equal(ended.sides.player.party[0].volatile, undefined);

const notEndured = makeState();
assert.equal(resolveMoveAction(notEndured, tackleAction(), {
  hit: true,
  damageByTarget: {'player-1': 200},
}).sides.player.party[0].hp.current, 0);

const destinyBondState = makeState();
destinyBondState.sides.player.party[0].volatile = {
  endure: {turns: 1},
  destinyBond: {turns: 1},
};
const destinyBondNext = resolveMoveAction(destinyBondState, tackleAction(), {
  hit: true,
  damageByTarget: {'player-1': 200},
});
assert.equal(destinyBondNext.sides.player.party[0].hp.current, 1);
assert.equal(destinyBondNext.sides.ai.party[0].hp.current, 100);
assert.equal(destinyBondNext.sides.player.party[0].volatile?.destinyBond?.turns, 1);

const damageActionState = makeState();
damageActionState.sides.player.party[0].volatile = {endure: {turns: 1}};
assert.equal(applyDamageAction(damageActionState, tackleAction(), {'player-1': 200})
  .sides.player.party[0].hp.current, 1);

const setupState = makeState();
const setupResolution = deriveMoveResolution(setupState, endureAction());
assert.equal(setupResolution.actionFailure, undefined);
assert.equal(setupResolution.volatileByPokemon?.['ai-1']?.endure?.turns, 1);
const armed = applyAction(setupState, endureAction(), setupResolution);
assert.equal(armed.sides.ai.party[0].volatile?.endure?.turns, 1);
assert.equal(beginNextTurn(armed).sides.ai.party[0].volatile, undefined);

const repeatedState = applyAction(setupState, endureAction(), setupResolution);
const repeatedResolution = deriveMoveResolution(
  repeatedState,
  endureAction(),
  {random: () => 0.5},
);
assert.equal(repeatedResolution.actionFailure, 'protect');
assert.equal(repeatedResolution.hit, false);
console.log('Endure fixtures passed');
