import assert from 'node:assert/strict';
import {enumerateMoveActions} from '../actions';
import {deriveMoveResolution} from '../move-engine';
import {BattleState} from '../model';
import {scoreStatusAction} from '../status';

function state(generation = 9): BattleState {
  return {
    generation: generation as BattleState['generation'],
    mode: 'Singles',
    turn: 1,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Pikachu', level: 100,
        hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}],
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Rattata', level: 100,
        hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}],
      }]},
    },
  };
}

function move(moveName: string) {
  return {kind: 'move' as const, actorId: 'ai-1', moveName, targetIds: []};
}

const hazards = state();
hazards.sides.player.effects = {stealthRock: true, spikes: 3, toxicSpikes: 2, stickyWeb: true};
hazards.sides.ai.party[0].moves = [
  {name: 'Stealth Rock'}, {name: 'Spikes'}, {name: 'Toxic Spikes'}, {name: 'Sticky Web'},
];
for (const moveName of ['Stealth Rock', 'Spikes', 'Toxic Spikes', 'Sticky Web']) {
  assert.equal(enumerateMoveActions(hazards, 'ai').some(action => action.moveName === moveName), false);
  assert.equal(deriveMoveResolution(hazards, move(moveName), {hit: true}).hit, false);
}

const screens = state();
screens.field.weather = 'Hail';
screens.sides.ai.effects = {
  reflect: true, lightScreen: true, auroraVeil: true, tailwind: true,
  mist: true, luckyChant: true, craftyShield: true,
};
screens.sides.ai.party[0].moves = [
  {name: 'Reflect'}, {name: 'Light Screen'}, {name: 'Aurora Veil'}, {name: 'Tailwind'},
  {name: 'Mist'}, {name: 'Lucky Chant'}, {name: 'Crafty Shield'},
];
for (const moveName of ['Reflect', 'Light Screen', 'Aurora Veil', 'Tailwind', 'Mist', 'Lucky Chant', 'Crafty Shield']) {
  assert.equal(enumerateMoveActions(screens, 'ai').some(action => action.moveName === moveName), false);
  assert.equal(deriveMoveResolution(screens, move(moveName), {hit: true}).hit, false);
}

const fieldState = state();
fieldState.field.fairyLock = true;
fieldState.field.ionDeluge = true;
fieldState.field.gravity = true;
fieldState.sides.ai.party[0].moves = [{name: 'Fairy Lock'}, {name: 'Ion Deluge'}, {name: 'Gravity'}];
fieldState.generation = 7;
for (const moveName of ['Fairy Lock', 'Ion Deluge', 'Gravity']) {
  assert.equal(enumerateMoveActions(fieldState, 'ai').some(action => action.moveName === moveName), false);
  assert.equal(deriveMoveResolution(fieldState, move(moveName), {hit: true}).hit, false);
}

const sports = state(7);
sports.field.waterSport = true;
sports.field.mudSport = true;
sports.sides.ai.party[0].moves = [{name: 'Water Sport'}, {name: 'Mud Sport'}];
for (const moveName of ['Water Sport', 'Mud Sport']) {
  assert.equal(enumerateMoveActions(sports, 'ai').some(action => action.moveName === moveName), false);
  assert.equal(deriveMoveResolution(sports, move(moveName), {hit: true}).hit, false);
}

const repeatedSetters = state();
repeatedSetters.field.weather = 'Rain';
repeatedSetters.field.terrain = 'Electric';
repeatedSetters.sides.ai.party[0].moves = [{name: 'Rain Dance'}, {name: 'Electric Terrain'}];
for (const moveName of ['Rain Dance', 'Electric Terrain']) {
  assert.equal(enumerateMoveActions(repeatedSetters, 'ai').some(action => action.moveName === moveName), false);
  assert.equal(deriveMoveResolution(repeatedSetters, move(moveName), {hit: true}).hit, false);
}

const toggleRooms = state();
toggleRooms.field.trickRoom = true;
toggleRooms.field.magicRoom = true;
toggleRooms.field.wonderRoom = true;
toggleRooms.sides.ai.party[0].moves = [{name: 'Trick Room'}, {name: 'Magic Room'}, {name: 'Wonder Room'}];
for (const moveName of ['Trick Room', 'Magic Room', 'Wonder Room']) {
  assert.equal(enumerateMoveActions(toggleRooms, 'ai').some(action => action.moveName === moveName), true);
}
const repeatedTrickRoomScore = scoreStatusAction(toggleRooms, {
  action: move('Trick Room'),
  facts: {moveCategory: 'Status', battleMode: 'Doubles', attackerSpeed: 100, opponentSpeeds: [50]},
  outcomes: [], reasons: [],
});
assert.equal(repeatedTrickRoomScore.outcomes[0].score, -20);

console.log('Field legality fixtures passed');
