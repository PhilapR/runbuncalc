import assert from 'node:assert/strict';
import {enumerateSwitchActions} from '../actions';
import {calculateActionFacts} from '../calc-adapter';
import {deriveReplacementViability} from '../matchup';
import {BattleState, MoveAction} from '../model';
import {evaluateActions} from '../evaluate';
import {applySwitchAction} from '../transition';

function makeState(): BattleState {
  return {
    generation: 8,
    mode: 'Singles',
    turn: 1,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [
        {id: 'ai-1', species: 'Pikachu', level: 100, hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}]},
        {id: 'ai-2', species: 'Jolteon', level: 100, hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}]},
      ]},
      player: {activeIds: ['player-1'], party: [
        {id: 'player-1', species: 'Snorlax', level: 100, hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}]},
      ]},
    },
  };
}

function damageFacts(possibleKO: boolean, max: number, targetHp = 100) {
  return {
    rolls: [max],
    min: max,
    max,
    targetHp,
    possibleKO,
    guaranteedKO: possibleKO,
  };
}

const safeFacts = (_state: BattleState, action: MoveAction) => ({
  damage: action.actorId === 'player-1' ? damageFacts(false, 40) : undefined,
});
const safe = deriveReplacementViability(makeState(), 'ai', safeFacts);
assert.equal(safe['ai-2'].faster, true);
assert.equal(safe['ai-2'].notOHKOd, true);
assert.equal(safe['ai-2'].not2HKOd, true);

const tiedState = makeState();
tiedState.sides.ai.party[1].statOverrides = {spe: 100};
tiedState.sides.player.party[0].statOverrides = {spe: 100};
const tied = deriveReplacementViability(tiedState, 'ai', safeFacts);
assert.equal(tied['ai-2'].faster, true);

const unsafeFacts = (_state: BattleState, action: MoveAction) => ({
  damage: action.actorId === 'player-1' ? damageFacts(true, 120) : undefined,
});
const unsafe = deriveReplacementViability(makeState(), 'ai', unsafeFacts);
assert.equal(unsafe['ai-2'].faster, true);
assert.equal(unsafe['ai-2'].notOHKOd, false);
assert.equal(unsafe['ai-2'].not2HKOd, false);

const switchState = makeState();
switchState.sides.ai.party[0].moves = [{name: 'Stealth Rock'}];
const evaluations = evaluateActions(switchState, () => ({moveCategory: 'Status'}), 'ai', {
  includeSwitches: true,
  viableReplacementIds: new Set(['ai-2']),
  replacementViability: {['ai-2']: unsafe['ai-2']},
});
const switchEvaluation = evaluations.find(evaluation => evaluation.action.kind === 'switch');
assert.deepEqual(switchEvaluation?.outcomes, [{score: -20, probability: 1}]);

const automaticEvaluations = evaluateActions(switchState, (_state, action) =>
  action.actorId === 'player-1'
    ? {damage: damageFacts(true, 120)}
    : {moveCategory: 'Status'}, 'ai', {
      includeSwitches: true,
      viableReplacementIds: new Set(['ai-2']),
    });
const automaticSwitch = automaticEvaluations.find(evaluation => evaluation.action.kind === 'switch');
assert.deepEqual(automaticSwitch?.outcomes, [{score: -20, probability: 1}]);

const realViability = deriveReplacementViability(makeState(), 'ai', calculateActionFacts);
assert.ok(realViability['ai-2']);
const realEvaluations = evaluateActions(makeState(), calculateActionFacts, 'ai', {
  includeSwitches: true,
  viableReplacementIds: new Set(['ai-2']),
});
assert.ok(realEvaluations.some(evaluation => evaluation.action.kind === 'switch'));
const rankedSwitchEvaluations = evaluateActions(makeState(), () => ({
  damage: damageFacts(false, 0),
  moveCategory: 'Physical',
}), 'ai', {
  includeSwitches: true,
  viableReplacementIds: new Set(['ai-2']),
  replacementScores: {['ai-2']: 11},
});
const rankedSwitch = rankedSwitchEvaluations.find(evaluation => evaluation.action.kind === 'switch');
assert.deepEqual(rankedSwitch?.outcomes, [{score: 11, probability: 0.5}, {score: -20, probability: 0.5}]);
assert.ok(rankedSwitch?.reasons.includes('caller-supplied replacement score'));

const doubles = makeState();
doubles.mode = 'Doubles';
doubles.sides.ai.activeIds = ['ai-1', 'ai-2'];
doubles.sides.player.activeIds = ['player-1'];
doubles.sides.ai.party.push({
  id: 'ai-3', species: 'Raichu', level: 100, hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}],
});
const doublesSwitches = enumerateSwitchActions(doubles);
assert.deepEqual(
  doublesSwitches.map(action => [action.actorId, action.replacementId]),
  [['ai-1', 'ai-3'], ['ai-2', 'ai-3']],
);
const doublesSwitched = applySwitchAction(doubles, doublesSwitches[0]);
assert.deepEqual(doublesSwitched.sides.ai.activeIds, ['ai-3', 'ai-2']);
const doublesEvaluations = evaluateActions(doubles, () => ({
  damage: damageFacts(false, 0),
  moveCategory: 'Physical',
}), 'ai', {includeSwitches: true});
const doublesSwitchEvaluations = doublesEvaluations.filter(evaluation => evaluation.action.kind === 'switch');
assert.ok(doublesSwitchEvaluations.length > 0);
assert.ok(doublesSwitchEvaluations.every(evaluation =>
  evaluation.outcomes.length === 1 && evaluation.outcomes[0].score === -20 &&
  evaluation.outcomes[0].probability === 1));

const partnerCanAttack = evaluateActions(doubles, (_state, action) => ({
  damage: damageFacts(action.actorId === 'ai-2', action.actorId === 'ai-2' ? 80 : 0),
  moveCategory: 'Physical',
}), 'ai', {includeSwitches: true});
const actorSwitch = partnerCanAttack.find(evaluation =>
  evaluation.action.kind === 'switch' && evaluation.action.actorId === 'ai-1');
const partnerSwitch = partnerCanAttack.find(evaluation =>
  evaluation.action.kind === 'switch' && evaluation.action.actorId === 'ai-2');
assert.deepEqual(actorSwitch?.outcomes, [{score: -20, probability: 1}]);
assert.deepEqual(partnerSwitch?.outcomes, [{score: -20, probability: 1}]);
console.log('Matchup fixtures passed');
