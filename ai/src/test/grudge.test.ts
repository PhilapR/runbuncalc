import assert from 'node:assert/strict';
import {enumerateMoveActions} from '../actions';
import {deriveMoveResolution} from '../move-engine';
import {resolveMoveAction} from '../transition';
import {BattleState, MoveAction} from '../model';

function state(): BattleState {
  return {
    generation: 9,
    mode: 'Singles',
    turn: 1,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Gengar', level: 100, ability: 'Levitate',
        hp: {current: 100, max: 100}, moves: [{name: 'Grudge'}],
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Pikachu', level: 100, ability: 'Overgrow',
        hp: {current: 100, max: 100}, moves: [{name: 'Tackle', pp: 10, maxPP: 35}],
      }]},
    },
  };
}

function action(actorId: string, moveName: string, targetIds: string[]): MoveAction {
  return {kind: 'move', actorId, moveName, targetIds};
}

function koResolution(stateValue: BattleState) {
  return deriveMoveResolution(stateValue, action('player-1', 'Tackle', ['ai-1']), {
    hit: true,
    facts: {
      moveCategory: 'Physical',
      damage: {rolls: [100], min: 100, max: 100, targetHp: 100, possibleKO: true, guaranteedKO: true},
    },
  });
}

const initial = state();
assert.equal(enumerateMoveActions(initial, 'ai').some(candidate => candidate.moveName === 'Grudge'), true);
const armedResolution = deriveMoveResolution(initial, action('ai-1', 'Grudge', ['ai-1']), {hit: true});
assert.deepEqual(armedResolution.volatileByPokemon?.['ai-1']?.grudge, {});
const armed = resolveMoveAction(initial, action('ai-1', 'Grudge', ['ai-1']), armedResolution);
assert.ok(armed.sides.ai.party[0].volatile?.grudge);
assert.equal(enumerateMoveActions(armed, 'ai').some(candidate => candidate.moveName === 'Grudge'), false);
assert.equal(deriveMoveResolution(armed, action('ai-1', 'Grudge', ['ai-1']), {hit: true}).hit, false);

const ko = koResolution(armed);
const afterKo = resolveMoveAction(armed, action('player-1', 'Tackle', ['ai-1']), ko);
assert.equal(afterKo.sides.ai.party[0].hp.current, 0);
assert.equal(afterKo.sides.player.party[0].moves[0].pp, 0);

const substitute = {...armed, sides: {
  ...armed.sides,
  ai: {...armed.sides.ai, party: armed.sides.ai.party.map(pokemon => ({...pokemon, hp: {current: 100, max: 100}, substituteHp: 20}))},
}};
const afterSubstitute = resolveMoveAction(substitute, action('player-1', 'Tackle', ['ai-1']), koResolution(substitute));
assert.equal(afterSubstitute.sides.player.party[0].moves[0].pp, 9);
assert.equal(afterSubstitute.sides.ai.party[0].hp.current, 100);

const endure = {...armed, sides: {
  ...armed.sides,
  ai: {...armed.sides.ai, party: armed.sides.ai.party.map(pokemon => ({...pokemon, volatile: {...pokemon.volatile, endure: {turns: 1}}}))},
}};
const afterEndure = resolveMoveAction(endure, action('player-1', 'Tackle', ['ai-1']), koResolution(endure));
assert.equal(afterEndure.sides.player.party[0].moves[0].pp, 9);
assert.equal(afterEndure.sides.ai.party[0].hp.current, 1);

const preGrudge = state();
preGrudge.generation = 2;
assert.equal(enumerateMoveActions(preGrudge, 'ai').some(candidate => candidate.moveName === 'Grudge'), false);
assert.equal(deriveMoveResolution(preGrudge, action('ai-1', 'Grudge', ['ai-1']), {hit: true}).hit, false);

console.log('Grudge fixtures passed');
