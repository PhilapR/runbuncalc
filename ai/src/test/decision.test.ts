import assert from 'node:assert/strict';
import {chooseAction, sampleScore} from '../decision';
import {ActionEvaluation} from '../model';

function evaluation(moveName: string, score: number): ActionEvaluation {
  return {
    action: {kind: 'move', actorId: 'ai-1', moveName, targetIds: ['player-1']},
    facts: {},
    outcomes: [{score, probability: 1}],
    reasons: [],
  };
}

assert.equal(sampleScore(evaluation('Tackle', 3), () => 1), 3);
assert.equal(sampleScore(evaluation('Tackle', 3), () => -1), 3);
assert.throws(() => sampleScore(evaluation('Tackle', 3), () => Number.NaN), /finite number/);
assert.throws(() => sampleScore({...evaluation('Tackle', 3), outcomes: []}, () => 0), /no outcomes/);

const tieChoice = chooseAction([evaluation('Tackle', 3), evaluation('Growl', 3)], () => 1);
assert.equal(tieChoice.action.kind, 'move');
assert.equal(tieChoice.action.moveName, 'Growl');

console.log('Decision fixtures passed');
