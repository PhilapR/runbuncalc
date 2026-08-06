import assert from 'node:assert/strict';
import {applyEndTurnResolution, deriveEndTurnResolution} from '../end-turn';
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
        id: 'ai-1', species: 'Pikachu', level: 100, ability: 'Overgrow', item: 'Leppa Berry',
        hp: {current: 100, max: 100}, moves: [{name: 'Tackle', pp: 1, maxPP: 35}],
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Rattata', level: 100, ability: 'Overgrow',
        hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}],
      }]},
    },
  };
}

function move() {
  return {kind: 'move' as const, actorId: 'ai-1', moveName: 'Tackle', targetIds: ['player-1']};
}

const restored = recordMoveAction(state(), move());
assert.equal(restored.sides.ai.party[0].moves[0].pp, 10);
assert.equal(restored.sides.ai.party[0].item, undefined);
assert.equal(restored.sides.ai.party[0].itemLost, true);
assert.equal(restored.sides.ai.party[0].lastConsumedItem, 'Leppa Berry');

const capped = state();
capped.sides.ai.party[0].moves[0].maxPP = 5;
assert.equal(recordMoveAction(capped, move()).sides.ai.party[0].moves[0].pp, 5);

const ripen = state();
ripen.sides.ai.party[0].ability = 'Ripen';
assert.equal(recordMoveAction(ripen, move()).sides.ai.party[0].moves[0].pp, 20);
assert.equal(recordMoveAction(ripen, move()).sides.ai.party[0].lastConsumedItem, 'Leppa Berry');

const ripenGen7 = {...ripen, generation: 7 as const};
assert.equal(recordMoveAction(ripenGen7, move()).sides.ai.party[0].moves[0].pp, 10);

const naturalCudChew = state();
naturalCudChew.sides.ai.party[0].ability = 'Cud Chew';
const naturalCudChewResult = recordMoveAction(naturalCudChew, move());
assert.equal(naturalCudChewResult.sides.ai.party[0].moves[0].pp, 10);
assert.deepEqual(naturalCudChewResult.sides.ai.party[0].volatile?.cudChew, {
  turns: 2,
  item: 'Leppa Berry',
});

const naturalCheekPouch = state();
naturalCheekPouch.sides.ai.party[0].ability = 'Cheek Pouch';
naturalCheekPouch.sides.ai.party[0].hp.current = 50;
assert.equal(recordMoveAction(naturalCheekPouch, move()).sides.ai.party[0].hp.current, 83);

const cudChew = state();
cudChew.sides.ai.party[0].ability = 'Cud Chew';
cudChew.sides.ai.party[0].item = undefined;
cudChew.sides.ai.party[0].moves[0].pp = 0;
cudChew.sides.ai.party[0].volatile = {cudChew: {turns: 1, item: 'Leppa Berry'}};
const cudChewResolution = deriveEndTurnResolution(cudChew);
assert.equal(cudChewResolution.movesByPokemon?.['ai-1']?.[0].pp, 10);
const cudChewApplied = applyEndTurnResolution(cudChew, cudChewResolution);
assert.equal(cudChewApplied.sides.ai.party[0].moves[0].pp, 10);
assert.equal(cudChewApplied.sides.ai.party[0].volatile?.cudChew, undefined);

const notEmpty = state();
notEmpty.sides.ai.party[0].moves[0].pp = 2;
const notEmptyResult = recordMoveAction(notEmpty, move());
assert.equal(notEmptyResult.sides.ai.party[0].moves[0].pp, 1);
assert.equal(notEmptyResult.sides.ai.party[0].item, 'Leppa Berry');

for (const suppressed of [
  {...state(), generation: 2 as const},
  {...state(), field: {magicRoom: true}},
  {...state(), sides: {...state().sides, ai: {...state().sides.ai, party: state().sides.ai.party.map(pokemon => ({...pokemon, volatile: {embargo: {turns: 2}}}))}}},
  {...state(), sides: {...state().sides, ai: {...state().sides.ai, party: state().sides.ai.party.map(pokemon => ({...pokemon, ability: 'Klutz'}))}}},
]) {
  const result = recordMoveAction(suppressed, move());
  assert.equal(result.sides.ai.party[0].moves[0].pp, 0);
  assert.equal(result.sides.ai.party[0].item, 'Leppa Berry');
}

console.log('Leppa fixtures passed');
