import {enumerateForcedSwitchActions, enumerateMoveActions, getPokemon, isSelectableMoveAction} from './actions';
import {chooseAction} from './decision';
import {scoreDamagingActions} from './scoring';
import {isScoredWithoutEffect, scoreStatusAction, scoreWithoutEffect} from './status';
import {evaluateForcedSwitchActions, evaluateSwitchActions} from './switch';
import {deriveReplacementViability} from './matchup';
import {normalizeGenerationFacts} from './facts';
import {ActionFacts, ActionEvaluation, BattleState, Decision, MoveAction, SideId} from './model';

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

/**
 * Moves the AI scores although they would have no effect.
 *
 * enumerateMoveActions drops a move that would do nothing. The ROM still
 * scores some of them, at their normal score less 20: Recover at full HP 85
 * (r1, h7), Thunder Wave into a Ground type 85/86 (s7, h1), Hypnosis into
 * Insomnia 86 (s2, h2), Toxic into a Steel or Poison type 86 (s11, h3), Sleep
 * Powder into a Grass type 86/87 (s3); Hold Hands with no ally reads 81 like
 * Splash (s12). Only those probed classes are added back (isScoredWithoutEffect),
 * each aimed at the first target set isSelectableMoveAction accepts (a foe, the
 * user, no one); the battle driver already uses such a move and lets it fail.
 * An actor left with only Struggle keeps Struggle. Enemy side only.
 */
function movesScoredWithoutEffect(state: BattleState, sideId: SideId, actions: MoveAction[]): MoveAction[] {
  const extra: MoveAction[] = [];
  const opposing: SideId = sideId === 'ai' ? 'player' : 'ai';
  const foes = state.sides[opposing].activeIds.filter(id => (getPokemon(state, id)?.hp.current || 0) > 0);
  for (const actorId of state.sides[sideId].activeIds) {
    const actor = getPokemon(state, actorId);
    const own = actions.filter(action => action.actorId === actorId);
    if (!actor || !own.length || own.every(action => action.moveName === 'Struggle')) continue;
    for (const move of actor.moves) {
      if (own.some(action => action.moveName === move.name)) continue;
      const selectable = [...foes.map(id => [id]), [actorId], []]
        .map(targetIds => ({kind: 'move' as const, actorId, moveName: move.name, targetIds}))
        .find(action => isSelectableMoveAction(state, sideId, action));
      if (selectable && isScoredWithoutEffect(state, selectable)) extra.push(selectable);
    }
  }
  return extra;
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
  // The trainer AI's rule, so the enemy side only. The player side's
  // evaluations are our own menu, and the driver refuses a player move that
  // enumerateMoveActions does not offer.
  const withoutEffect = (sideId === 'ai' ? movesScoredWithoutEffect(state, sideId, actions) : [])
    .map(action => scoreWithoutEffect(state, {
      action,
      facts: factProvider(state, action),
      outcomes: [],
      reasons: [],
    }));
  const moves = [...damaging, ...status, ...withoutEffect];
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
