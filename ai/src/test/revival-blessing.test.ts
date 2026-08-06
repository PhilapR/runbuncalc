import assert from 'node:assert/strict';
import {enumerateMoveActions} from '../actions';
import {deriveMoveResolution} from '../move-engine';
import {resolveMoveAction} from '../transition';
import {BattleState} from '../model';

function state(): BattleState {
  return {
    generation: 9,
    mode: 'Singles',
    turn: 1,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [
        {
          id: 'ai-1', species: 'Pawmot', level: 100,
          hp: {current: 100, max: 100}, moves: [{name: 'Revival Blessing'}],
        },
        {
          id: 'ai-2', species: 'Rattata', level: 100,
          hp: {current: 0, max: 100}, status: 'brn', toxicCounter: 2,
          moves: [{name: 'Tackle'}],
        },
      ]},
      player: {activeIds: ['player-1'], party: [
        {
          id: 'player-1', species: 'Pikachu', level: 100,
          hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}],
        },
      ]},
    },
  };
}

const fixture = state();
const actions = enumerateMoveActions(fixture, 'ai');
assert.deepEqual(actions.filter(action => action.moveName === 'Revival Blessing').map(action => action.targetIds), [['ai-2']]);

const action = actions.find(candidate => candidate.moveName === 'Revival Blessing');
assert.ok(action);
const resolution = deriveMoveResolution(fixture, action, {hit: true});
assert.equal(resolution.hit, true);
assert.equal(resolution.hpDeltaByPokemon?.['ai-2'], 50);
assert.equal(resolution.statusByPokemon?.['ai-2'], '');

const revived = resolveMoveAction(fixture, action, resolution);
const revivedPokemon = revived.sides.ai.party.find(pokemon => pokemon.id === 'ai-2');
assert.equal(revivedPokemon?.hp.current, 50);
assert.equal(revivedPokemon?.status, '');
assert.equal(revivedPokemon?.toxicCounter, 0);

const noFaintedAlly = state();
noFaintedAlly.sides.ai.party[1].hp.current = 100;
noFaintedAlly.sides.ai.party[1].status = undefined;
noFaintedAlly.sides.ai.party[1].toxicCounter = undefined;
assert.equal(enumerateMoveActions(noFaintedAlly, 'ai').some(candidate => candidate.moveName === 'Revival Blessing'), false);
assert.equal(deriveMoveResolution(noFaintedAlly, {
  kind: 'move', actorId: 'ai-1', moveName: 'Revival Blessing', targetIds: ['player-1'],
}, {hit: true}).hit, false);

const preGen9 = state();
preGen9.generation = 8;
assert.equal(enumerateMoveActions(preGen9, 'ai').some(candidate => candidate.moveName === 'Revival Blessing'), false);
assert.equal(deriveMoveResolution(preGen9, action, {hit: true}).hit, false);

console.log('Revival Blessing fixtures passed');
