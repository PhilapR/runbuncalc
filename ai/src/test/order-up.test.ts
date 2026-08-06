import assert from 'node:assert/strict';
import {enumerateMoveActions} from '../actions';
import {deriveMoveResolution} from '../move-engine';
import {BattleState} from '../model';

function state(form: string): BattleState {
  return {
    generation: 9,
    mode: 'Doubles',
    turn: 1,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1', 'ai-2'], party: [
        {
          id: 'ai-1', species: 'Dondozo', level: 100,
          hp: {current: 100, max: 100},
          moves: [{name: 'Order Up', pp: 10, maxPP: 10}],
          volatile: {commanded: {sourceId: 'ai-2'}},
        },
        {
          id: 'ai-2', species: `Tatsugiri-${form}`, level: 100,
          hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}],
        },
      ]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Rattata', level: 100,
        hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}],
      }]},
    },
  };
}

for (const [form, stat] of [['Curly', 'atk'], ['Droopy', 'def'], ['Stretchy', 'spe']] as const) {
  const fixture = state(form);
  const action = enumerateMoveActions(fixture, 'ai').find(candidate => candidate.moveName === 'Order Up');
  assert.ok(action);
  const resolution = deriveMoveResolution(fixture, action, {hit: true});
  assert.equal(resolution.boostsByPokemon?.['ai-1']?.[stat], 1);
}

const miss = state('Curly');
const missAction = enumerateMoveActions(miss, 'ai').find(candidate => candidate.moveName === 'Order Up');
assert.ok(missAction);
const missResolution = deriveMoveResolution(miss, missAction, {hit: false});
assert.equal(missResolution.hit, false);
assert.equal(missResolution.boostsByPokemon?.['ai-1']?.atk, 1);

const noCommander = state('Curly');
noCommander.sides.ai.party[0].volatile = undefined;
const noCommanderAction = enumerateMoveActions(noCommander, 'ai').find(candidate => candidate.moveName === 'Order Up');
assert.ok(noCommanderAction);
assert.equal(deriveMoveResolution(noCommander, noCommanderAction, {hit: true}).boostsByPokemon, undefined);

const preGen9 = state('Curly');
preGen9.generation = 8;
assert.equal(enumerateMoveActions(preGen9, 'ai').some(candidate => candidate.moveName === 'Order Up'), false);
assert.equal(deriveMoveResolution(preGen9, {
  kind: 'move', actorId: 'ai-1', moveName: 'Order Up', targetIds: ['player-1'],
}, {hit: true}).hit, false);

console.log('Order Up fixtures passed');
