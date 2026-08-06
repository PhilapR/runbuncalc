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

for (const [moveName, boost] of [['Growl', {atk: -6}], ['Screech', {def: -6}] ] as const) {
  const repeated = state();
  repeated.sides.ai.party[0].moves = [{name: moveName}];
  repeated.sides.player.party[0].boosts = boost;
  assert.equal(enumerateMoveActions(repeated, 'ai').some(action => action.moveName === moveName), false);
  assert.equal(deriveMoveResolution(repeated, move(moveName), {hit: true}).hit, false);
  repeated.sides.player.party[0].boosts = moveName === 'Growl' ? {atk: -5} : {def: -5};
  assert.equal(enumerateMoveActions(repeated, 'ai').some(action => action.moveName === moveName), true);
}

const captivate = state();
captivate.sides.ai.party[0].moves = [{name: 'Captivate'}];
captivate.sides.ai.party[0].gender = 'M';
captivate.sides.player.party[0].gender = 'M';
assert.equal(enumerateMoveActions(captivate, 'ai').some(action => action.moveName === 'Captivate'), false);
assert.equal(deriveMoveResolution(captivate, move('Captivate'), {hit: true}).hit, false);
captivate.sides.player.party[0].gender = 'F';
captivate.sides.player.party[0].boosts = {spa: -6};
assert.equal(enumerateMoveActions(captivate, 'ai').some(action => action.moveName === 'Captivate'), false);
captivate.sides.player.party[0].boosts = {spa: -5};
assert.equal(enumerateMoveActions(captivate, 'ai').some(action => action.moveName === 'Captivate'), true);

const damagingDebuff = state();
damagingDebuff.sides.ai.party[0].moves = [{name: 'Snarl'}];
damagingDebuff.sides.player.party[0].boosts = {spa: -6};
assert.equal(enumerateMoveActions(damagingDebuff, 'ai').some(action => action.moveName === 'Snarl'), true);

console.log('Stage legality fixtures passed');
