import assert from 'node:assert/strict';
import {calculateActionFacts} from '../calc-adapter';
import {enumerateMoveActions, enumerateSwitchActions} from '../actions';
import {deriveMoveResolution} from '../move-engine';
import {BattleState} from '../model';
import {applyAction} from '../transition';

function state(moveName: string): BattleState {
  return {
    generation: 9,
    mode: 'Singles',
    turn: 1,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: moveName === 'Anchor Shot' ? 'Dhelmise' : 'Decidueye', level: 100,
        hp: {current: 100, max: 100}, moves: [{name: moveName, pp: 15, maxPP: 15}],
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Pikachu', level: 100,
        hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}],
      }, {
        id: 'player-2', species: 'Pikachu', level: 100,
        hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}],
      }]},
    },
  };
}

for (const moveName of ['Anchor Shot', 'Spirit Shackle']) {
  const fixture = state(moveName);
  const action = enumerateMoveActions(fixture, 'ai').find(candidate => candidate.moveName === moveName);
  assert.ok(action);
  const resolution = deriveMoveResolution(fixture, action, {
    hit: true,
    facts: calculateActionFacts(fixture, action),
  });
  assert.deepEqual(resolution.volatileByPokemon?.['player-1']?.trapped, {sourceId: 'ai-1'});
  const trapped = applyAction(fixture, action, resolution);
  assert.deepEqual(trapped.sides.player.party[0].volatile?.trapped, {sourceId: 'ai-1'});
  assert.equal(enumerateSwitchActions(trapped, 'player').some(candidate => candidate.actorId === 'player-1'), false);

  const miss = deriveMoveResolution(fixture, action, {hit: false});
  assert.equal(miss.volatileByPokemon?.['player-1']?.trapped, undefined);
}

const preGen7 = state('Anchor Shot');
preGen7.generation = 6;
assert.equal(enumerateMoveActions(preGen7, 'ai').some(candidate => candidate.moveName === 'Anchor Shot'), false);
assert.equal(deriveMoveResolution(preGen7, {
  kind: 'move', actorId: 'ai-1', moveName: 'Anchor Shot', targetIds: ['player-1'],
}, {hit: true}).hit, false);

console.log('Damaging trap fixtures passed');
