import assert from 'node:assert/strict';
import {enumerateMoveActions} from '../actions';
import {deriveMoveResolution} from '../move-engine';
import {BattleState} from '../model';
import {applyAction} from '../transition';

function state(): BattleState {
  return {
    generation: 9,
    mode: 'Singles',
    turn: 1,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Tinkaton', level: 100,
        hp: {current: 100, max: 100}, moves: [{name: 'Gigaton Hammer', pp: 5, maxPP: 5}, {name: 'Tackle'}],
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Rattata', level: 100,
        hp: {current: 1000, max: 1000}, moves: [{name: 'Tackle'}],
      }]},
    },
  };
}

const fixture = state();
const hammer = enumerateMoveActions(fixture, 'ai').find(action => action.moveName === 'Gigaton Hammer');
assert.ok(hammer);
const firstResolution = deriveMoveResolution(fixture, hammer, {hit: true});
const afterFirst = applyAction(fixture, hammer, firstResolution);
assert.equal(afterFirst.lastMoveUsedByPokemon?.['ai-1'], 'Gigaton Hammer');
assert.equal(enumerateMoveActions(afterFirst, 'ai').some(action => action.moveName === 'Gigaton Hammer'), false);
assert.equal(deriveMoveResolution(afterFirst, hammer, {hit: true}).hit, false);

const otherMove = enumerateMoveActions(afterFirst, 'ai').find(action => action.moveName === 'Tackle');
assert.ok(otherMove);
const afterOther = applyAction(afterFirst, otherMove, deriveMoveResolution(afterFirst, otherMove, {hit: true}));
assert.equal(enumerateMoveActions(afterOther, 'ai').some(action => action.moveName === 'Gigaton Hammer'), true);

const preGen9 = state();
preGen9.generation = 8;
assert.equal(enumerateMoveActions(preGen9, 'ai').some(action => action.moveName === 'Gigaton Hammer'), false);
assert.equal(deriveMoveResolution(preGen9, hammer, {hit: true}).hit, false);

console.log('Gigaton Hammer fixtures passed');
