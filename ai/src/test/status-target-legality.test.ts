import assert from 'node:assert/strict';
import {enumerateMoveActions} from '../actions';
import {deriveMoveResolution} from '../move-engine';
import {BattleState} from '../model';
import {scoreStatusAction} from '../status';

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

for (const [moveName, status] of [['Toxic', 'brn'], ['Spore', 'par'], ['Will-O-Wisp', 'tox']] as const) {
  const repeated = state();
  repeated.sides.ai.party[0].moves = [{name: moveName}];
  repeated.sides.player.party[0].status = status;
  assert.equal(enumerateMoveActions(repeated, 'ai').some(action => action.moveName === moveName), false);
  assert.equal(deriveMoveResolution(repeated, move(moveName), {hit: true}).hit, false);
  repeated.sides.player.party[0].status = '';
  assert.equal(enumerateMoveActions(repeated, 'ai').some(action => action.moveName === moveName), true);
}

const toxicThread = state();
toxicThread.sides.ai.party[0].moves = [{name: 'Toxic Thread'}];
toxicThread.sides.player.party[0].status = 'brn';
assert.equal(enumerateMoveActions(toxicThread, 'ai').some(action => action.moveName === 'Toxic Thread'), true);

for (const [moveName, configure] of [
  ['Thunder Wave', (blocked: BattleState) => { blocked.sides.player.party[0].species = 'Diglett'; }],
  ['Toxic', (blocked: BattleState) => { blocked.sides.player.party[0].ability = 'Immunity'; }],
  ['Spore', (blocked: BattleState) => { blocked.field.terrain = 'Electric'; }],
  ['Will-O-Wisp', (blocked: BattleState) => { blocked.sides.player.effects = {safeguard: true}; }],
] as const) {
  const blocked = state();
  blocked.sides.ai.party[0].moves = [{name: moveName}];
  configure(blocked);
  assert.equal(enumerateMoveActions(blocked, 'ai').some(action => action.moveName === moveName), false);
  assert.equal(deriveMoveResolution(blocked, move(moveName), {hit: true}).hit, false);
}

for (const [moveName, configure] of [
  ['Leech Seed', (blocked: BattleState) => { blocked.sides.player.party[0].species = 'Bulbasaur'; }],
  ['Attract', (blocked: BattleState) => { blocked.sides.player.party[0].ability = 'Oblivious'; }],
  ['Yawn', (blocked: BattleState) => { blocked.sides.player.party[0].ability = 'Insomnia'; }],
] as const) {
  const blocked = state();
  blocked.sides.ai.party[0].moves = [{name: moveName}];
  configure(blocked);
  assert.equal(enumerateMoveActions(blocked, 'ai').some(action => action.moveName === moveName), false);
  assert.equal(deriveMoveResolution(blocked, move(moveName), {hit: true}).hit, false);
}

const spreadSleep = state();
spreadSleep.mode = 'Doubles';
spreadSleep.sides.ai.activeIds = ['ai-1', 'ai-2'];
spreadSleep.sides.ai.party.push({
  id: 'ai-2', species: 'Bulbasaur', level: 100,
  hp: {current: 100, max: 100}, moves: [{name: 'Dark Void'}],
});
spreadSleep.sides.player.activeIds = ['player-1', 'player-2'];
spreadSleep.sides.player.party.push({
  id: 'player-2', species: 'Rattata', level: 100,
  hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}],
});
spreadSleep.sides.ai.party[1].moves = [{name: 'Dark Void'}];
spreadSleep.sides.player.party[0].status = 'brn';
assert.equal(enumerateMoveActions(spreadSleep, 'ai').some(action => action.moveName === 'Dark Void'), true);

const sweetVeilDoesNotBlockRest = state();
sweetVeilDoesNotBlockRest.mode = 'Doubles';
sweetVeilDoesNotBlockRest.sides.ai.activeIds = ['ai-1', 'ai-2'];
sweetVeilDoesNotBlockRest.sides.ai.party[0].moves = [{name: 'Rest'}];
sweetVeilDoesNotBlockRest.sides.ai.party[0].hp.current = 50;
sweetVeilDoesNotBlockRest.sides.ai.party.push({
  id: 'ai-2', species: 'Spritzee', level: 100,
  hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}], ability: 'Sweet Veil',
});
const rest = {kind: 'move' as const, actorId: 'ai-1', moveName: 'Rest', targetIds: ['ai-1']};
assert.equal(enumerateMoveActions(sweetVeilDoesNotBlockRest, 'ai').some(action => action.moveName === 'Rest'), true);
const restResolution = deriveMoveResolution(sweetVeilDoesNotBlockRest, rest, {hit: true});
assert.equal(restResolution.hpDeltaByPokemon?.['ai-1'], 50);
assert.equal(restResolution.statusByPokemon?.['ai-1'], 'slp');

for (const configure of [
  (blocked: BattleState) => { blocked.sides.ai.party[0].ability = 'Insomnia'; },
  (blocked: BattleState) => { blocked.field.terrain = 'Electric'; },
  (blocked: BattleState) => { blocked.field.terrain = 'Misty'; },
] as const) {
  const blocked = state();
  blocked.sides.ai.party[0].moves = [{name: 'Rest'}];
  blocked.sides.ai.party[0].hp.current = 50;
  configure(blocked);
  assert.equal(enumerateMoveActions(blocked, 'ai').some(action => action.moveName === 'Rest'), false);
  const blockedResolution = deriveMoveResolution(blocked, {
    kind: 'move', actorId: 'ai-1', moveName: 'Rest', targetIds: ['ai-1'],
  }, {hit: true});
  assert.equal(blockedResolution.hit, false);
  assert.ok(blockedResolution.trace?.notes?.some(note => note.includes('sleep was blocked')));
  const blockedScore = scoreStatusAction(blocked, {
    action: {kind: 'move', actorId: 'ai-1', moveName: 'Rest', targetIds: ['ai-1']},
    facts: {moveCategory: 'Status'}, outcomes: [], reasons: [],
  });
  assert.deepEqual(blockedScore.outcomes, [{score: -20, probability: 1}]);
  assert.ok(blockedScore.reasons.some(reason => reason.includes('sleep eligibility')));
}

const sweetVeilStillBlocksOpposingSleep = state();
sweetVeilStillBlocksOpposingSleep.mode = 'Doubles';
sweetVeilStillBlocksOpposingSleep.sides.player.activeIds = ['player-1', 'player-2'];
sweetVeilStillBlocksOpposingSleep.sides.player.party.push({
  id: 'player-2', species: 'Spritzee', level: 100,
  hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}], ability: 'Sweet Veil',
});
sweetVeilStillBlocksOpposingSleep.sides.ai.party[0].moves = [{name: 'Spore'}];
assert.equal(enumerateMoveActions(sweetVeilStillBlocksOpposingSleep, 'ai').some(action => action.moveName === 'Spore'), false);

console.log('Status target legality fixtures passed');
