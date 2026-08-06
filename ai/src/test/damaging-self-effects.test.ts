import assert from 'node:assert/strict';
import {enumerateMoveActions} from '../actions';
import {deriveMoveResolution} from '../move-engine';
import {BattleState} from '../model';
import {applyAction} from '../transition';

function state(moveName: string, species: string): BattleState {
  return {
    generation: 9,
    mode: 'Singles',
    turn: 1,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species, level: 100,
        hp: {current: 100, max: 100}, moves: [{name: moveName, pp: 5, maxPP: 5}],
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Rattata', level: 100,
        hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}],
      }]},
    },
  };
}

const vcreate = state('V-create', 'Victini');
const vcreateAction = enumerateMoveActions(vcreate, 'ai')[0];
assert.equal(vcreateAction.moveName, 'V-create');
const vcreateResolution = deriveMoveResolution(vcreate, vcreateAction, {hit: true});
assert.deepEqual(vcreateResolution.boostsByPokemon?.['ai-1'], {def: -1, spd: -1, spe: -1});
const vcreated = applyAction(vcreate, vcreateAction, vcreateResolution);
assert.deepEqual(vcreated.sides.ai.party[0].boosts, {def: -1, spd: -1, spe: -1});

const hyperspace = state('Hyperspace Fury', 'Hoopa-Unbound');
const hyperspaceAction = enumerateMoveActions(hyperspace, 'ai')[0];
assert.equal(hyperspaceAction.moveName, 'Hyperspace Fury');
const hyperspaceResolution = deriveMoveResolution(hyperspace, hyperspaceAction, {hit: true});
assert.deepEqual(hyperspaceResolution.boostsByPokemon?.['ai-1'], {def: -1});

const preVcreate = state('V-create', 'Victini');
preVcreate.generation = 4;
assert.equal(enumerateMoveActions(preVcreate, 'ai').some(action => action.moveName === 'V-create'), false);
assert.equal(deriveMoveResolution(preVcreate, {
  kind: 'move', actorId: 'ai-1', moveName: 'V-create', targetIds: ['player-1'],
}, {hit: true}).hit, false);

const preHyperspace = state('Hyperspace Fury', 'Hoopa-Unbound');
preHyperspace.generation = 5;
assert.equal(enumerateMoveActions(preHyperspace, 'ai').some(action => action.moveName === 'Hyperspace Fury'), false);
assert.equal(deriveMoveResolution(preHyperspace, {
  kind: 'move', actorId: 'ai-1', moveName: 'Hyperspace Fury', targetIds: ['player-1'],
}, {hit: true}).hit, false);

console.log('Damaging self-effect fixtures passed');
