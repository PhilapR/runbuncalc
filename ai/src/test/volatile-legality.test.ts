import assert from 'node:assert/strict';
import {enumerateMoveActions} from '../actions';
import {canApplyVolatile} from '../eligibility';
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

// Attract is a gender check with a move attached, so the whole rule is pinned
// here and not just the case that happens to be interesting. This block used
// to assert that Attract between two males IS enumerated and DOES infatuate —
// which is wrong in every generation, and was reached in play: Lady Cindy
// fields three Cute Charm users whose movepool is Attract and Thunder Wave,
// and with every Pokemon built male it locked turns it could never have
// locked. Captivate carried the gate; the move that IS the gate did not.
for (const [attacker, defender, allowed] of [
  ['M', 'F', true], ['F', 'M', true],
  ['M', 'M', false], ['F', 'F', false],
  ['N', 'F', false], ['M', 'N', false],
  [undefined, 'F', false], ['M', undefined, false],
] as const) {
  const attract = state();
  attract.sides.ai.party[0].gender = attacker;
  attract.sides.player.party[0].gender = defender;
  attract.sides.ai.party[0].moves = [{name: 'Attract'}];
  const why = `${attacker ?? 'unknown'} -> ${defender ?? 'unknown'}`;
  assert.equal(
    enumerateMoveActions(attract, 'ai').some((action: MoveAction) => action.moveName === 'Attract'),
    allowed, `Attract enumeration, ${why}`);
  assert.equal(
    deriveMoveResolution(attract, move('Attract'), {hit: true})
      .volatileByPokemon?.['player-1']?.infatuated !== undefined,
    allowed, `Attract infatuation, ${why}`);
  // Cute Charm infatuates the ATTACKER on contact and takes the same
  // eligibility path with the roles swapped, so the one gate has to answer
  // both directions.
  assert.equal(canApplyVolatile(attract, 'ai-1', 'infatuated', 'player-1'), allowed,
    `Cute Charm eligibility, ${why}`);
}

console.log('Volatile legality fixtures passed');
