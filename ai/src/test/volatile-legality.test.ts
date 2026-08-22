import assert from 'node:assert/strict';
import {enumerateMoveActions} from '../actions';
import {deriveMoveResolution} from '../move-engine';
import {BattleState, MoveAction} from '../model';

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

function move(moveName: string, targetIds = ['player-1']) {
  return {kind: 'move' as const, actorId: 'ai-1', moveName, targetIds};
}

for (const [moveName, volatileName] of [
  ['Aqua Ring', 'aquaRing'], ['Ingrain', 'ingrain'], ['Magnet Rise', 'magnetRise'],
] as const) {
  const repeated = state();
  repeated.sides.ai.party[0].moves = [{name: moveName}];
  repeated.sides.ai.party[0].volatile = {[volatileName]: {turns: 3}};
  assert.equal(enumerateMoveActions(repeated, 'ai').some((action: MoveAction) => action.moveName === moveName), false);
  assert.equal(deriveMoveResolution(repeated, move(moveName, ['ai-1']), {hit: true}).hit, false);
}

for (const [moveName, volatileName] of [['Magic Coat', 'magicCoat'], ['Snatch', 'snatch']] as const) {
  const selfVolatile = state(7);
  selfVolatile.sides.ai.party[0].moves = [{name: moveName}];
  selfVolatile.sides.ai.party[0].volatile = {[volatileName]: {turns: 1}};
  assert.equal(enumerateMoveActions(selfVolatile, 'ai').some((action: MoveAction) => action.moveName === moveName), false);
  assert.equal(deriveMoveResolution(selfVolatile, move(moveName, ['ai-1']), {hit: true}).hit, false);
}

const repeatedAttract = state();
repeatedAttract.sides.ai.party[0].gender = 'M';
repeatedAttract.sides.player.party[0].gender = 'F';
repeatedAttract.sides.ai.party[0].moves = [{name: 'Attract'}];
repeatedAttract.sides.player.party[0].volatile = {infatuated: {}};
assert.equal(enumerateMoveActions(repeatedAttract, 'ai').some((action: MoveAction) => action.moveName === 'Attract'), false);
assert.equal(deriveMoveResolution(repeatedAttract, move('Attract'), {hit: true}).hit, false);

for (const [moveName, volatileName] of [
  ['Leech Seed', 'leechSeed'], ['Yawn', 'yawn'], ['Telekinesis', 'telekinesis'],
] as const) {
  const repeated = state();
  repeated.sides.ai.party[0].moves = [{name: moveName}];
  repeated.sides.player.party[0].volatile = {[volatileName]: {turns: 2}};
  assert.equal(enumerateMoveActions(repeated, 'ai').some((action: MoveAction) => action.moveName === moveName), false);
  assert.equal(deriveMoveResolution(repeated, move(moveName), {hit: true}).hit, false);
}

const repeatedNightmare = state(7);
repeatedNightmare.sides.ai.party[0].moves = [{name: 'Nightmare'}];
repeatedNightmare.sides.player.party[0].status = 'slp';
repeatedNightmare.sides.player.party[0].volatile = {nightmare: {turns: 2}};
assert.equal(enumerateMoveActions(repeatedNightmare, 'ai').some((action: MoveAction) => action.moveName === 'Nightmare'), false);
assert.equal(deriveMoveResolution(repeatedNightmare, move('Nightmare'), {hit: true}).hit, false);

// Deliberate, and sourced: Run & Bun's Attract is gender-independent
// (`mechanics.attractIsGenderIndependent`, source-of-truth; ruling
// `soul-dew-and-infatuation-verified`). This asserts the rule, not an
// omission — it has been flipped once by someone reading it as a locked-in
// bug, and reverted. See tests/runbun_mechanics.test.js.
const sameGenderAttract = state();
sameGenderAttract.sides.ai.party[0].gender = 'M';
sameGenderAttract.sides.player.party[0].gender = 'M';
sameGenderAttract.sides.ai.party[0].moves = [{name: 'Attract'}];
assert.equal(enumerateMoveActions(sameGenderAttract, 'ai').some((action: MoveAction) => action.moveName === 'Attract'), true);
assert.equal(deriveMoveResolution(sameGenderAttract, move('Attract'), {hit: true}).volatileByPokemon?.['player-1']?.infatuated !== undefined, true);

console.log('Volatile legality fixtures passed');
