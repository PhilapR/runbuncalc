import {actionKey} from './actions';
import {ActionEvaluation, BattleState, Decision} from './model';

export type FactProvider = (state: BattleState, action: ActionEvaluation['action']) => ActionEvaluation['facts'];

function boundedRandom(random: () => number, label: string): number {
  const value = random();
  if (!Number.isFinite(value)) throw new Error(`${label} sampler must return a finite number`);
  return Math.max(0, Math.min(0.999999999999, value));
}

export function sampleScore(evaluation: ActionEvaluation, random: () => number): number {
  if (!evaluation.outcomes.length) throw new Error('Cannot sample an evaluation with no outcomes');
  let cursor = boundedRandom(random, 'Decision score');
  for (const outcome of evaluation.outcomes) {
    if (cursor < outcome.probability) return outcome.score;
    cursor -= outcome.probability;
  }
  return evaluation.outcomes[evaluation.outcomes.length - 1].score;
}

export function chooseAction(
  evaluations: ActionEvaluation[],
  random: () => number = Math.random,
): Decision {
  if (!evaluations.length) throw new Error('Cannot choose an action from an empty list');

  const sampled = evaluations.map(evaluation => ({
    evaluation,
    score: sampleScore(evaluation, random),
  }));
  const selectedScore = Math.max(...sampled.map(candidate => candidate.score));
  const tied = sampled.filter(candidate => candidate.score === selectedScore);
  const selected = tied[Math.floor(boundedRandom(random, 'Decision tie') * tied.length)];
  if (!selected) throw new Error('Decision tie sampling produced no candidate');

  return {
    action: selected.evaluation.action,
    evaluations,
    selectedScore,
  };
}

export function evaluationKey(evaluation: ActionEvaluation): string {
  return actionKey(evaluation.action);
}
