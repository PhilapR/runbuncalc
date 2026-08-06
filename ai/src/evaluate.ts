import {enumerateForcedSwitchActions, enumerateMoveActions} from './actions';
import {chooseAction} from './decision';
import {scoreDamagingActions} from './scoring';
import {scoreStatusAction} from './status';
import {evaluateForcedSwitchActions, evaluateSwitchActions} from './switch';
import {deriveReplacementViability} from './matchup';
import {normalizeGenerationFacts} from './facts';
import {ActionFacts, ActionEvaluation, BattleState, Decision, SideId} from './model';

export type ActionFactProvider = (state: BattleState, action: ActionEvaluation['action']) => ActionFacts;

export interface EvaluationOptions {
  includeSwitches?: boolean;
  viableReplacementIds?: ReadonlySet<string>;
  replacementViability?: Readonly<Record<string, {
    faster: boolean;
    notOHKOd: boolean;
    not2HKOd: boolean;
  }> >;
  /** Optional post-KO matchup scores supplied by the battle engine. */
  replacementScores?: Readonly<Record<string, number>>;
  /** Derive documented replacement viability when no caller override exists. */
  deriveReplacementViability?: boolean;
}

export function evaluateDamagingActions(
  state: BattleState,
  factsFor: ActionFactProvider,
  sideId: SideId = 'ai',
): ActionEvaluation[] {
  const actions = enumerateMoveActions(state, sideId);
  const evaluations = actions.map(action => ({
    action,
    facts: normalizeGenerationFacts(state, factsFor(state, action)),
  }));
  return scoreDamagingActions(evaluations);
}

export function evaluateActions(
  state: BattleState,
  factsFor: ActionFactProvider,
  sideId: SideId = 'ai',
  options: EvaluationOptions = {},
): ActionEvaluation[] {
  const forcedActions = enumerateForcedSwitchActions(state, sideId);
  if (forcedActions.length) {
    return evaluateForcedSwitchActions(state, sideId, {
      replacementScores: options.replacementScores,
    });
  }
  const actions = enumerateMoveActions(state, sideId);
  const factProvider = (factState: BattleState, action: ActionEvaluation['action']) =>
    normalizeGenerationFacts(factState, factsFor(factState, action));
  const evaluations = actions.map(action => ({action, facts: factProvider(state, action)}));
  const damaging = scoreDamagingActions(evaluations);
  const status = evaluations
    .filter(evaluation => evaluation.facts.moveCategory === 'Status')
    .map(evaluation => scoreStatusAction(state, {
      ...evaluation,
      outcomes: [],
      reasons: [],
    }));
  const moves = [...damaging, ...status];
  const derivedReplacementViability = options.includeSwitches &&
    options.deriveReplacementViability !== false
    ? deriveReplacementViability(state, sideId, factProvider)
    : {};
  const replacementViability = {
    ...derivedReplacementViability,
    ...(options.replacementViability || {}),
  };
  return options.includeSwitches
    ? [...moves, ...evaluateSwitchActions(state, sideId, {
      moveEvaluations: moves,
      viableReplacementIds: options.viableReplacementIds,
      replacementViability,
      replacementScores: options.replacementScores,
    })]
    : moves;
}

export function chooseStateAction(
  state: BattleState,
  factsFor: ActionFactProvider,
  sideId: SideId = 'ai',
  random: () => number = Math.random,
  options: EvaluationOptions = {},
): Decision {
  return chooseAction(evaluateActions(state, factsFor, sideId, options), random);
}
