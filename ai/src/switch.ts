import {enumerateForcedSwitchActions, enumerateSwitchActions, getPokemon} from './actions';
import {ActionEvaluation, BattleState, SideId, SwitchAction} from './model';

const SWITCH_PROBABILITY = 0.5;

export interface SwitchPolicyContext {
  moveEvaluations: ActionEvaluation[];
  viableReplacementIds?: ReadonlySet<string>;
  replacementViability?: Readonly<Record<string, {
    faster: boolean;
    notOHKOd: boolean;
    not2HKOd: boolean;
  }>>;
  replacementScores?: Readonly<Record<string, number>>;
}

function highestScore(evaluation: ActionEvaluation): number {
  return Math.max(...evaluation.outcomes.map(outcome => outcome.score));
}

function canOnlyUseIneffectiveMoves(evaluations: ActionEvaluation[]): boolean {
  return evaluations.length > 0 && evaluations.every(evaluation => highestScore(evaluation) <= -5);
}

function isEligibleReplacement(
  state: BattleState,
  sideId: SideId,
  action: SwitchAction,
  viableReplacementIds?: ReadonlySet<string>,
  replacementViability?: SwitchPolicyContext['replacementViability'],
): boolean {
  if (state.mode !== 'Singles' && state.mode !== 'Doubles') return false;
  const side = state.sides[sideId];
  if (state.mode === 'Singles' && (side.activeIds.length !== 1 || side.activeIds[0] !== action.actorId)) return false;
  if (state.mode === 'Doubles' && (side.activeIds.length < 1 || side.activeIds.length > 2 ||
    !side.activeIds.includes(action.actorId))) return false;
  const replacement = getPokemon(state, action.replacementId);
  const viability = replacementViability?.[action.replacementId];
  const passesDocumentedViability = state.mode === 'Doubles' || !viability ||
    (viability.faster && viability.notOHKOd) || (!viability.faster && viability.not2HKOd);
  return !!replacement && replacement.hp.current > 0 &&
    side.party.some(pokemon => pokemon.id === replacement.id) &&
    !side.activeIds.includes(replacement.id) &&
    (!viableReplacementIds || viableReplacementIds.has(replacement.id)) &&
    passesDocumentedViability;
}

export function scoreSwitchAction(
  state: BattleState,
  sideId: SideId,
  action: SwitchAction,
  context: SwitchPolicyContext,
): ActionEvaluation {
  const active = getPokemon(state, action.actorId);
  const actorMoves = context.moveEvaluations.filter(evaluation =>
    evaluation.action.kind === 'move' && evaluation.action.actorId === action.actorId);
  // The documented hard-switch routine is Singles-only. Doubles replacement
  // decisions such as Perish Song use their own policy and must not inherit
  // the generic 50% switch roll.
  const eligible = state.mode === 'Singles' && !!active && active.hp.current * 2 >= active.hp.max &&
    canOnlyUseIneffectiveMoves(actorMoves) &&
    isEligibleReplacement(state, sideId, action, context.viableReplacementIds, context.replacementViability);
  const replacementScore = context.replacementScores?.[action.replacementId];
  if (replacementScore !== undefined && !Number.isFinite(replacementScore)) {
    throw new Error(`Replacement score for ${action.replacementId} must be finite`);
  }

  return {
    action,
    facts: {},
    outcomes: eligible
      ? [
        {score: replacementScore === undefined ? 0 : replacementScore, probability: SWITCH_PROBABILITY},
        {score: -20, probability: 1 - SWITCH_PROBABILITY},
      ]
      : [{score: -20, probability: 1}],
    reasons: eligible
      ? [
        'eligible hard switch; 50% switch roll',
        ...(replacementScore === undefined ? [] : ['caller-supplied replacement score']),
      ]
      : ['switch conditions are not met'],
  };
}

export function evaluateSwitchActions(
  state: BattleState,
  sideId: SideId,
  context: SwitchPolicyContext,
): ActionEvaluation[] {
  return enumerateSwitchActions(state, sideId)
    .map(action => scoreSwitchAction(state, sideId, action, context));
}

/**
 * Evaluate required post-KO replacements. Matchup scores are deliberately
 * supplied by the caller because a switch action has no single calculator
 * damage target to use as an implicit score.
 */
export function evaluateForcedSwitchActions(
  state: BattleState,
  sideId: SideId,
  context: Pick<SwitchPolicyContext, 'replacementScores'> = {},
): ActionEvaluation[] {
  return enumerateForcedSwitchActions(state, sideId).map(action => {
    const score = context.replacementScores?.[action.replacementId];
    if (score !== undefined && !Number.isFinite(score)) {
      throw new Error(`Forced replacement score for ${action.replacementId} must be finite`);
    }
    return {
      action,
      facts: {},
      outcomes: [{score: score === undefined ? 0 : score, probability: 1}],
      reasons: [score === undefined
        ? 'forced replacement; no matchup score supplied, tie-randomized'
        : 'forced replacement; caller-supplied matchup score'],
    };
  });
}
