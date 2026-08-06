import assert from 'node:assert/strict';
import {enumerateMoveActions} from '../actions';
import {deriveMoveResolution} from '../move-engine';
import {resolveMoveAction} from '../transition';
import {BattleState, MoveAction} from '../model';

function state(moveName: string): BattleState {
  return {
    generation: 9,
    mode: 'Singles',
    turn: 2,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Pikachu', level: 100, ability: 'Overgrow',
        hp: {current: 100, max: 100}, moves: [{name: moveName}],
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Mewtwo', level: 100, ability: 'Pressure',
        hp: {current: 100, max: 100}, moves: [
          {name: 'Tackle', pp: 7, maxPP: 35}, {name: 'Psychic', pp: 10, maxPP: 10},
        ],
      }]},
    },
    lastMoveUsedByPokemon: {'player-1': 'Tackle'},
  };
}

function move(moveName: string) {
  return {kind: 'move' as const, actorId: 'ai-1', moveName, targetIds: ['player-1']};
}

for (const [moveName, pp] of [['Spite', 3], ['Eerie Spell', 4]] as const) {
  const fixture = state(moveName);
  assert.equal(enumerateMoveActions(fixture, 'ai').some((action: MoveAction) => action.moveName === moveName), true);
  const action = move(moveName);
  const resolution = deriveMoveResolution(fixture, action, {hit: true});
  assert.equal(resolution.movesByPokemon?.['player-1']?.[0].pp, pp);
  const next = resolveMoveAction(fixture, action, resolution);
  assert.equal(next.sides.player.party[0].moves[0].pp, pp);
}

const noHistory = state('Spite');
delete noHistory.lastMoveUsedByPokemon;
assert.equal(enumerateMoveActions(noHistory, 'ai').some((action: MoveAction) => action.moveName === 'Spite'), false);
assert.equal(deriveMoveResolution(noHistory, move('Spite'), {hit: true}).hit, false);

const emptyPP = state('Spite');
emptyPP.sides.player.party[0].moves[0].pp = 0;
assert.equal(enumerateMoveActions(emptyPP, 'ai').some((action: MoveAction) => action.moveName === 'Spite'), false);
assert.equal(deriveMoveResolution(emptyPP, move('Spite'), {hit: true}).hit, false);

const unknownPP = state('Spite');
unknownPP.sides.player.party[0].moves[0].pp = undefined;
assert.equal(enumerateMoveActions(unknownPP, 'ai').some((action: MoveAction) => action.moveName === 'Spite'), true);
assert.equal(deriveMoveResolution(unknownPP, move('Spite'), {hit: true}).movesByPokemon, undefined);

const preEerieSpell = state('Eerie Spell');
preEerieSpell.generation = 7;
assert.equal(enumerateMoveActions(preEerieSpell, 'ai').some((action: MoveAction) => action.moveName === 'Eerie Spell'), false);
assert.equal(deriveMoveResolution(preEerieSpell, move('Eerie Spell'), {hit: true}).hit, false);

console.log('PP legality fixtures passed');
