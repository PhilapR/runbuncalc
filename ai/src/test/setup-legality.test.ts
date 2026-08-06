import assert from 'node:assert/strict';
import {enumerateMoveActions} from '../actions';
import {deriveMoveResolution} from '../move-engine';
import {BattleState} from '../model';

function state(): BattleState {
  return {
    generation: 9,
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
  return {kind: 'move' as const, actorId: 'ai-1', moveName, targetIds: ['player-1']};
}

const swordsDance = state();
swordsDance.sides.ai.party[0].moves = [{name: 'Swords Dance'}];
swordsDance.sides.ai.party[0].boosts = {atk: 6};
assert.equal(enumerateMoveActions(swordsDance, 'ai').some(action => action.moveName === 'Swords Dance'), false);
assert.equal(deriveMoveResolution(swordsDance, move('Swords Dance'), {hit: true}).hit, false);
swordsDance.sides.ai.party[0].boosts = {atk: 5};
assert.equal(enumerateMoveActions(swordsDance, 'ai').some(action => action.moveName === 'Swords Dance'), true);

const calmMind = state();
calmMind.sides.ai.party[0].moves = [{name: 'Calm Mind'}];
calmMind.sides.ai.party[0].boosts = {spa: 6, spd: 6};
assert.equal(enumerateMoveActions(calmMind, 'ai').some(action => action.moveName === 'Calm Mind'), false);
assert.equal(deriveMoveResolution(calmMind, move('Calm Mind'), {hit: true}).hit, false);

const victoryDance = state();
victoryDance.sides.ai.party[0].moves = [{name: 'Victory Dance'}];
victoryDance.sides.ai.party[0].boosts = {atk: 6, def: 6, spe: 6};
assert.equal(enumerateMoveActions(victoryDance, 'ai').some(action => action.moveName === 'Victory Dance'), false);
assert.equal(deriveMoveResolution(victoryDance, move('Victory Dance'), {hit: true}).hit, false);

const shellSmash = state();
shellSmash.sides.ai.party[0].moves = [{name: 'Shell Smash'}];
shellSmash.sides.ai.party[0].boosts = {atk: 6, spa: 6, spe: 6, def: -6, spd: -6};
assert.equal(enumerateMoveActions(shellSmash, 'ai').some(action => action.moveName === 'Shell Smash'), true);

const damagingSetup = state();
damagingSetup.sides.ai.party[0].moves = [{name: 'Power-Up Punch'}];
damagingSetup.sides.ai.party[0].boosts = {atk: 6};
assert.equal(enumerateMoveActions(damagingSetup, 'ai').some(action => action.moveName === 'Power-Up Punch'), true);

console.log('Setup legality fixtures passed');
