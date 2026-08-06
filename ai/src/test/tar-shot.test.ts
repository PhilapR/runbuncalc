import assert from 'node:assert/strict';
import {calculateActionFacts} from '../calc-adapter';
import {enumerateMoveActions} from '../actions';
import {deriveMoveResolution} from '../move-engine';
import {BattleState} from '../model';
import {applyAction, beginNextTurn} from '../transition';

function state(): BattleState {
  return {
    generation: 9,
    mode: 'Singles',
    turn: 1,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Rattata', level: 100,
        hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}],
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Charizard', level: 100,
        hp: {current: 100, max: 100}, moves: [
          {name: 'Tar Shot', pp: 15, maxPP: 15},
          {name: 'Flamethrower', pp: 15, maxPP: 15},
        ],
      }]},
    },
  };
}

const fixture = state();
const tarShotAction = enumerateMoveActions(fixture, 'player').find(action => action.moveName === 'Tar Shot');
assert.ok(tarShotAction);
const normalFire = calculateActionFacts(fixture, {
  kind: 'move', actorId: 'player-1', moveName: 'Flamethrower', targetIds: ['ai-1'],
});
const tarShotResolution = deriveMoveResolution(fixture, tarShotAction, {hit: true});
assert.equal(tarShotResolution.boostsByPokemon?.['ai-1']?.spe, -1);
assert.ok(tarShotResolution.volatileByPokemon?.['ai-1']?.tarShot);
const tarred = applyAction(fixture, tarShotAction, tarShotResolution);
assert.ok(tarred.sides.ai.party[0].volatile?.tarShot);
const tarredFire = calculateActionFacts(tarred, {
  kind: 'move', actorId: 'player-1', moveName: 'Flamethrower', targetIds: ['ai-1'],
});
assert.ok(normalFire.damage && tarredFire.damage);
assert.equal(tarredFire.damage.max, normalFire.damage.max * 2);

const persists = beginNextTurn(tarred);
assert.ok(persists.sides.ai.party[0].volatile?.tarShot);

const speedSaturated = state();
speedSaturated.sides.ai.party[0].boosts = {spe: -6};
assert.equal(enumerateMoveActions(speedSaturated, 'player').some(action => action.moveName === 'Tar Shot'), true);
const saturatedResolution = deriveMoveResolution(speedSaturated, {
  kind: 'move', actorId: 'player-1', moveName: 'Tar Shot', targetIds: ['ai-1'],
}, {hit: true});
assert.ok(saturatedResolution.volatileByPokemon?.['ai-1']?.tarShot);

const alreadyTarred = state();
alreadyTarred.sides.ai.party[0].boosts = {spe: -6};
alreadyTarred.sides.ai.party[0].volatile = {tarShot: {}};
assert.equal(enumerateMoveActions(alreadyTarred, 'player').some(action => action.moveName === 'Tar Shot'), false);
assert.equal(deriveMoveResolution(alreadyTarred, {
  kind: 'move', actorId: 'player-1', moveName: 'Tar Shot', targetIds: ['ai-1'],
}, {hit: true}).hit, false);

const preGen8 = state();
preGen8.generation = 7;
assert.equal(enumerateMoveActions(preGen8, 'player').some(action => action.moveName === 'Tar Shot'), false);
assert.equal(deriveMoveResolution(preGen8, tarShotAction, {hit: true}).hit, false);

console.log('Tar Shot fixtures passed');
