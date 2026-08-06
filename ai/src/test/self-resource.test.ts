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

function move(stateValue: BattleState, moveName: string, targetIds = ['player-1']) {
  return {kind: 'move' as const, actorId: 'ai-1', moveName, targetIds};
}

const bellyDrum = state();
bellyDrum.sides.ai.party[0].moves = [{name: 'Belly Drum'}];
bellyDrum.sides.ai.party[0].hp = {current: 50, max: 100};
assert.equal(enumerateMoveActions(bellyDrum, 'ai').some(action => action.moveName === 'Belly Drum'), false);
assert.equal(deriveMoveResolution(bellyDrum, move(bellyDrum, 'Belly Drum'), {hit: true}).hit, false);
bellyDrum.sides.ai.party[0].hp.current = 51;
assert.equal(enumerateMoveActions(bellyDrum, 'ai')[0].moveName, 'Belly Drum');
const healBlockedBellyDrum = state();
healBlockedBellyDrum.sides.ai.party[0].moves = [{name: 'Belly Drum'}];
healBlockedBellyDrum.sides.ai.party[0].hp.current = 51;
healBlockedBellyDrum.sides.ai.party[0].item = 'Sitrus Berry';
healBlockedBellyDrum.sides.ai.party[0].volatile = {healBlock: {turns: 2}};
const healBlockedBellyDrumResolution = deriveMoveResolution(
  healBlockedBellyDrum, move(healBlockedBellyDrum, 'Belly Drum'), {hit: true},
);
assert.equal(healBlockedBellyDrumResolution.hpDeltaByPokemon?.['ai-1'], -1);
assert.equal(healBlockedBellyDrumResolution.itemByPokemon?.['ai-1'], null);

const bellyDrumScoreState = state();
bellyDrumScoreState.sides.ai.party[0].moves = [{name: 'Belly Drum'}];
bellyDrumScoreState.sides.ai.party[0].hp.current = 51;
bellyDrumScoreState.sides.ai.party[0].item = 'Sitrus Berry';
const bellyDrumScoreAction = move(bellyDrumScoreState, 'Belly Drum');
const bellyDrumScoreFacts = {
  moveCategory: 'Status' as const,
  attackerHp: 51,
  attackerHpPercent: 51,
  opponentCanKO: true,
  opponentMaxDamage: 60,
};
assert.deepEqual(scoreStatusAction(bellyDrumScoreState, {
  action: bellyDrumScoreAction, facts: bellyDrumScoreFacts, outcomes: [], reasons: [],
}).outcomes, [{score: 8, probability: 1}]);
const bellyDrumHealBlockedScore = {...bellyDrumScoreState, sides: {
  ...bellyDrumScoreState.sides,
  ai: {...bellyDrumScoreState.sides.ai, party: bellyDrumScoreState.sides.ai.party.map(pokemon => ({
    ...pokemon, volatile: {healBlock: {turns: 2}},
  }))},
}};
assert.deepEqual(scoreStatusAction(bellyDrumHealBlockedScore, {
  action: bellyDrumScoreAction, facts: bellyDrumScoreFacts, outcomes: [], reasons: [],
}).outcomes, [{score: 4, probability: 1}]);

const cudChewBellyDrum = state();
cudChewBellyDrum.sides.ai.party[0].moves = [{name: 'Belly Drum'}];
cudChewBellyDrum.sides.ai.party[0].hp.current = 51;
cudChewBellyDrum.sides.ai.party[0].ability = 'Cud Chew';
cudChewBellyDrum.sides.ai.party[0].item = 'Sitrus Berry';
const cudChewBellyDrumResolution = deriveMoveResolution(
  cudChewBellyDrum, move(cudChewBellyDrum, 'Belly Drum'), {hit: true},
);
assert.equal(cudChewBellyDrumResolution.itemByPokemon?.['ai-1'], null);
assert.deepEqual(cudChewBellyDrumResolution.volatileByPokemon?.['ai-1']?.cudChew, {
  turns: 2,
  item: 'Sitrus Berry',
});

const substitute = state();
substitute.sides.ai.party[0].moves = [{name: 'Substitute'}];
substitute.sides.ai.party[0].hp = {current: 25, max: 100};
assert.equal(enumerateMoveActions(substitute, 'ai').some(action => action.moveName === 'Substitute'), false);
assert.equal(deriveMoveResolution(substitute, move(substitute, 'Substitute'), {hit: true}).hit, false);
substitute.sides.ai.party[0].hp.current = 26;
assert.equal(enumerateMoveActions(substitute, 'ai')[0].moveName, 'Substitute');
substitute.sides.ai.party[0].substituteHp = 25;
assert.equal(enumerateMoveActions(substitute, 'ai').some(action => action.moveName === 'Substitute'), false);

const fullRest = state();
fullRest.sides.ai.party[0].moves = [{name: 'Rest'}];
assert.equal(enumerateMoveActions(fullRest, 'ai').some(action => action.moveName === 'Rest'), false);
assert.equal(deriveMoveResolution(fullRest, move(fullRest, 'Rest'), {hit: true}).hit, false);

const sacrifice = state();
sacrifice.sides.ai.party[0].moves = [{name: 'Clangorous Soul'}];
sacrifice.sides.ai.party[0].hp = {current: 33, max: 100};
assert.equal(enumerateMoveActions(sacrifice, 'ai').some(action => action.moveName === 'Clangorous Soul'), false);
sacrifice.sides.ai.party[0].hp.current = 34;
assert.equal(enumerateMoveActions(sacrifice, 'ai')[0].moveName, 'Clangorous Soul');
sacrifice.sides.ai.party[0].moves = [{name: 'Fillet Away'}];
sacrifice.sides.ai.party[0].hp.current = 50;
assert.equal(enumerateMoveActions(sacrifice, 'ai').some(action => action.moveName === 'Fillet Away'), false);
sacrifice.sides.ai.party[0].hp.current = 51;
assert.equal(enumerateMoveActions(sacrifice, 'ai')[0].moveName, 'Fillet Away');

const trappedNoRetreat = state();
trappedNoRetreat.sides.ai.party[0].moves = [{name: 'No Retreat'}];
trappedNoRetreat.sides.ai.party[0].volatile = {trapped: {}};
assert.equal(enumerateMoveActions(trappedNoRetreat, 'ai').some(action => action.moveName === 'No Retreat'), false);
assert.equal(deriveMoveResolution(trappedNoRetreat, move(trappedNoRetreat, 'No Retreat'), {hit: true}).hit, false);

const emptyStuffCheeks = state();
emptyStuffCheeks.sides.ai.party[0].moves = [{name: 'Stuff Cheeks'}];
assert.equal(deriveMoveResolution(emptyStuffCheeks, move(emptyStuffCheeks, 'Stuff Cheeks'), {hit: true}).hit, false);

const emptyTeatime = {...state(), generation: 8 as const};
emptyTeatime.sides.ai.party[0].moves = [{name: 'Teatime'}];
assert.equal(enumerateMoveActions(emptyTeatime, 'ai').some(action => action.moveName === 'Teatime'), false);
assert.equal(deriveMoveResolution(emptyTeatime, move(emptyTeatime, 'Teatime'), {hit: true}).hit, false);
emptyTeatime.sides.player.party[0].item = 'Lum Berry';
assert.equal(enumerateMoveActions(emptyTeatime, 'ai').some(action => action.moveName === 'Teatime'), true);

const maxAcupressure = state();
maxAcupressure.sides.ai.party[0].moves = [{name: 'Acupressure'}];
maxAcupressure.sides.ai.party[0].boosts = {atk: 6, def: 6, spa: 6, spd: 6, spe: 6};
assert.equal(enumerateMoveActions(maxAcupressure, 'ai').some(action => action.moveName === 'Acupressure'), false);
assert.equal(deriveMoveResolution(maxAcupressure, move(maxAcupressure, 'Acupressure', ['ai-1']), {hit: true}).hit, false);

const equalStageMoves = state();
equalStageMoves.sides.ai.party[0].moves = [{name: 'Psych Up'}, {name: 'Guard Swap'}, {name: 'Power Swap'}];
equalStageMoves.sides.ai.party[0].boosts = {atk: 1, def: -1, spa: 2, spd: 3};
equalStageMoves.sides.player.party[0].boosts = {atk: 1, def: -1, spa: 2, spd: 3};
for (const moveName of ['Psych Up', 'Guard Swap', 'Power Swap']) {
  assert.equal(enumerateMoveActions(equalStageMoves, 'ai').some(action => action.moveName === moveName), false);
  assert.equal(deriveMoveResolution(equalStageMoves, move(equalStageMoves, moveName), {hit: true}).hit, false);
}

console.log('Self-resource legality fixtures passed');
