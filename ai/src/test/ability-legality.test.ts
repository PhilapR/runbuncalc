import assert from 'node:assert/strict';
import {enumerateMoveActions} from '../actions';
import {deriveMoveResolution} from '../move-engine';
import {BattleState} from '../model';

function state(moveName: string): BattleState {
  return {
    generation: 9,
    mode: 'Singles',
    turn: 1,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Pikachu', level: 100, ability: 'Levitate',
        hp: {current: 100, max: 100}, moves: [{name: moveName}],
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Rattata', level: 100, ability: 'Levitate',
        hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}],
      }]},
    },
  };
}

function move(moveName: string) {
  return {kind: 'move' as const, actorId: 'ai-1', moveName, targetIds: ['player-1']};
}

for (const moveName of ['Role Play', 'Skill Swap', 'Doodle']) {
  const repeated = state(moveName);
  assert.equal(enumerateMoveActions(repeated, 'ai').some(action => action.moveName === moveName), false);
  assert.equal(deriveMoveResolution(repeated, move(moveName), {hit: true}).hit, false);
  repeated.sides.player.party[0].ability = 'Intimidate';
  assert.equal(enumerateMoveActions(repeated, 'ai').some(action => action.moveName === moveName), true);
}

for (const [moveName, existingAbility] of [['Simple Beam', 'Simple'], ['Worry Seed', 'Insomnia']] as const) {
  const repeated = state(moveName);
  repeated.sides.player.party[0].ability = existingAbility;
  assert.equal(enumerateMoveActions(repeated, 'ai').some(action => action.moveName === moveName), false);
  assert.equal(deriveMoveResolution(repeated, move(moveName), {hit: true}).hit, false);
  repeated.sides.player.party[0].ability = 'Intimidate';
  assert.equal(enumerateMoveActions(repeated, 'ai').some(action => action.moveName === moveName), true);
}

const entrainment = state('Entrainment');
assert.equal(enumerateMoveActions(entrainment, 'ai').some(action => action.moveName === 'Entrainment'), false);
entrainment.sides.player.party[0].ability = 'Intimidate';
assert.equal(enumerateMoveActions(entrainment, 'ai').some(action => action.moveName === 'Entrainment'), true);

const shieldedAbilityMoves: Array<[string, 'ai' | 'player']> = [
  ['Role Play', 'ai'], ['Doodle', 'ai'], ['Skill Swap', 'ai'],
  ['Entrainment', 'player'], ['Simple Beam', 'player'], ['Worry Seed', 'player'],
  ['Skill Swap', 'player'],
];
for (const [moveName, holder] of shieldedAbilityMoves) {
  const shielded = state(moveName);
  shielded.sides[holder].party[0].item = 'Ability Shield';
  assert.equal(enumerateMoveActions(shielded, 'ai').some(action => action.moveName === moveName), false);
  assert.equal(deriveMoveResolution(shielded, move(moveName), {hit: true}).hit, false);
}

const gastroAcidShield = state('Gastro Acid');
gastroAcidShield.sides.player.party[0].item = 'Ability Shield';
assert.equal(enumerateMoveActions(gastroAcidShield, 'ai').some(action => action.moveName === 'Gastro Acid'), false);
assert.equal(deriveMoveResolution(gastroAcidShield, move('Gastro Acid'), {hit: true}).hit, false);

const gastroAcidMagicRoom = state('Gastro Acid');
gastroAcidMagicRoom.sides.player.party[0].item = 'Ability Shield';
gastroAcidMagicRoom.field.magicRoom = true;
assert.equal(enumerateMoveActions(gastroAcidMagicRoom, 'ai').some(action => action.moveName === 'Gastro Acid'), true);
assert.deepEqual(
  deriveMoveResolution(gastroAcidMagicRoom, move('Gastro Acid'), {hit: true}).abilitySuppressedByPokemon,
  {'player-1': true},
);

const transformShield = state('Transform');
transformShield.sides.ai.party[0].item = 'Ability Shield';
transformShield.sides.player.party[0].ability = 'Blaze';
assert.equal(
  deriveMoveResolution(transformShield, move('Transform'), {hit: true}).abilityOverrideByPokemon,
  undefined,
);

console.log('Ability legality fixtures passed');
