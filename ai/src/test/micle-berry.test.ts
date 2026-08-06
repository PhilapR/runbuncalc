import assert from 'node:assert/strict';
import {getEffectiveMoveAccuracy} from '../accuracy';
import {deriveEndTurnResolution, applyEndTurnResolution} from '../end-turn';
import {deriveMoveResolution} from '../move-engine';
import {BattleState, MoveAction} from '../model';
import {beginNextTurn} from '../transition';

function state(): BattleState {
  return {
    generation: 9,
    mode: 'Singles',
    turn: 1,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Pikachu', level: 100, item: 'Micle Berry',
        hp: {current: 25, max: 100}, moves: [{name: 'Tackle'}],
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Rattata', level: 100,
        hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}],
      }]},
    },
  };
}

const action: MoveAction = {kind: 'move', actorId: 'ai-1', moveName: 'Tackle', targetIds: ['player-1']};
const initial = state();
const activation = deriveEndTurnResolution(initial);
assert.deepEqual(activation.itemByPokemon?.['ai-1'], null);
assert.equal(activation.consumedItemByPokemon?.['ai-1'], 'Micle Berry');
assert.deepEqual(activation.volatileByPokemon?.['ai-1']?.micleBerry, {turns: 2});

const cheekPouch = state();
cheekPouch.sides.ai.party[0].ability = 'Cheek Pouch';
const cheekPouchActivation = deriveEndTurnResolution(cheekPouch);
assert.equal(cheekPouchActivation.hpDeltaByPokemon?.['ai-1'], 33);

const armed = applyEndTurnResolution(initial, activation);
const accuracy = getEffectiveMoveAccuracy(armed, action, 95);
assert.equal(accuracy.accuracy, 100);
assert.ok(accuracy.modifiers.includes('Micle Berry'));

const moveResolution = deriveMoveResolution(armed, action, {hit: true});
assert.deepEqual(moveResolution.volatileByPokemon?.['ai-1']?.micleBerry, null);

const oneTurnLater = beginNextTurn(armed);
assert.deepEqual(oneTurnLater.sides.ai.party[0].volatile?.micleBerry, {turns: 1});
const twoTurnsLater = beginNextTurn(oneTurnLater);
assert.equal(twoTurnsLater.sides.ai.party[0].volatile?.micleBerry, undefined);

const magicRoom = state();
magicRoom.field.magicRoom = true;
const suppressed = deriveEndTurnResolution(magicRoom);
assert.equal(suppressed.itemByPokemon?.['ai-1'], undefined);
assert.equal(suppressed.volatileByPokemon?.['ai-1']?.micleBerry, undefined);

console.log('Micle Berry fixtures passed');
