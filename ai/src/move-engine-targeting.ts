import * as Calc from '@smogon/calc';
import {getCalculatorAbility, getEffectiveAbility, isAbilityActive} from './abilities';
import {getPokemon, sideForPokemon} from './actions';
import {isPriorityBlocked} from './eligibility';
import {isItemEffectActive} from './items';
import {
  getEffectiveMoveMetadata,
  getMoveMetadata,
  SEMI_INVULNERABLE_BYPASS_MOVES,
  SEMI_INVULNERABLE_CHARGE_MOVES,
} from './move-metadata';
import {getActionOrderFacts} from './order';
import {getEffectiveSpecies} from './stat-transforms';
import {PROTECT_BYPASS_MOVES} from './move-engine-tables';
import {moveId} from './move-engine-utils';
import {
  ActionFacts,
  BattleState,
  MoveAction,
  MoveCategory,
  MoveTarget,
  PokemonState,
} from './model';

/**
 * Target eligibility, contact, and protection checks.
 *
 * Decides which targets a move actually reaches: accuracy sampling, contact
 * classification, personal Protect variants vs. side-level guards, and
 * calculator-confirmed damage immunity.
 */

export function moveMakesContact(
  state: BattleState,
  moveName: string,
  actor?: PokemonState,
  action?: Pick<MoveAction, 'useZ' | 'useMax'>,
): boolean {
  const moveState = actor?.moves.find(move => move.name === moveName);
  const moveMetadata = moveState
    ? getEffectiveMoveMetadata(moveState, state.generation)
    : getMoveMetadata(moveName, state.generation);
  try {
    const move = new Calc.Move(Calc.Generations.get(state.generation), moveName, {
      ability: actor ? getCalculatorAbility(state, actor) : undefined,
      item: actor && isItemEffectActive(state, actor) ? actor.item : undefined,
      species: actor ? getEffectiveSpecies(actor) : undefined,
      useZ: action?.useZ,
      useMax: action?.useMax,
    });
    if (!(moveMetadata.contact ?? !!move.flags.contact)) return false;
    if (actor && state.generation >= 7 && isAbilityActive(actor, state) &&
      moveId(getEffectiveAbility(actor)) === 'longreach') return false;
    if (actor && state.generation >= 7 && isItemEffectActive(state, actor) &&
      moveId(actor.item) === 'protectivepads') return false;
    if (actor && state.generation >= 9 && isItemEffectActive(state, actor) &&
      moveId(actor.item) === 'punchingglove' && (moveMetadata.punch ?? !!move.flags.punch)) return false;
    return true;
  } catch {
    return moveMetadata.contact === true;
  }
}

export function sampleAccuracy(
  accuracy: number | true,
  random: () => number,
): {hit: boolean; roll?: number; threshold: number} {
  const threshold = accuracy === true ? 1 : accuracy / 100;
  if (accuracy !== true && (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 100)) {
    throw new Error('Move accuracy must be true or a percentage from 0 to 100');
  }
  const roll = random();
  if (!Number.isFinite(roll)) throw new Error('Accuracy sampler must return a finite number');
  const bounded = Math.max(0, Math.min(0.999999999999, roll));
  return {hit: accuracy === true || bounded < threshold, roll, threshold};
}

export function moveTargetForProtection(state: BattleState, action: MoveAction): MoveTarget | undefined {
  const actor = getPokemon(state, action.actorId);
  const moveState = actor?.moves.find(move => move.name === action.moveName);
  if (moveState?.target) return moveState.target;
  try {
    return new Calc.Move(Calc.Generations.get(state.generation), action.moveName).target as MoveTarget;
  } catch {
    return undefined;
  }
}

export function moveCategoryForProtection(
  state: BattleState,
  action: MoveAction,
  facts?: ActionFacts,
): MoveCategory | undefined {
  if (facts?.moveCategory) return facts.moveCategory;
  try {
    return new Calc.Move(Calc.Generations.get(state.generation), action.moveName).category;
  } catch {
    return undefined;
  }
}

export function movePriorityForProtection(state: BattleState, action: MoveAction, facts?: ActionFacts): number {
  try {
    return getActionOrderFacts(state, action).priority;
  } catch {
    return facts?.priority || 0;
  }
}

export function isProtectedTarget(
  state: BattleState,
  targetId: string,
  attackMoveId: string,
  action: MoveAction,
  facts?: ActionFacts,
): boolean {
  if (PROTECT_BYPASS_MOVES.has(attackMoveId)) return false;
  const target = getPokemon(state, targetId);
  if (!target) return false;
  const side = sideForPokemon(state, target.id);
  const actorSide = sideForPokemon(state, action.actorId);
  const opposing = side !== actorSide;
  const sideEffects = state.sides[side].effects;
  const moveTarget = moveTargetForProtection(state, action);
  const moveCategory = moveCategoryForProtection(state, action, facts);
  const attacker = getPokemon(state, action.actorId);
  const protectedMoveId = moveId(target.volatile?.protected?.moveName || '');
  const unseenFistBypassesProtection = state.generation >= 8 && opposing &&
    !!attacker && moveMakesContact(state, action.moveName, attacker, action) && isAbilityActive(attacker, state) &&
    moveId(getEffectiveAbility(attacker) || '') === 'unseenfist' &&
    protectedMoveId !== 'maxguard';
  const wideGuardBlocks = opposing && !!sideEffects?.wideGuard &&
    ['all', 'allAdjacent', 'allAdjacentFoes'].includes(moveTarget || '') &&
    (state.generation >= 7 || moveCategory !== 'Status');
  const quickGuardBlocks = opposing && !!sideEffects?.quickGuard &&
    movePriorityForProtection(state, action, facts) > 0;
  const matBlockBlocks = opposing && !!sideEffects?.matBlock && moveCategory !== 'Status';
  const craftShieldBlocks = attackMoveId === 'conversion2' && state.generation >= 6 &&
    opposing && !!sideEffects?.craftyShield;
  const priorityBlocked = opposing && isPriorityBlocked(
    state, action.actorId, target.id, movePriorityForProtection(state, action, facts), moveCategory,
  );
  const personalProtectionBlocks = (!!target.volatile?.protected || !!sideEffects?.protected) &&
    !unseenFistBypassesProtection;
  return priorityBlocked || personalProtectionBlocks || (wideGuardBlocks && !unseenFistBypassesProtection) ||
    (quickGuardBlocks && !unseenFistBypassesProtection) ||
    (matBlockBlocks && !unseenFistBypassesProtection) || craftShieldBlocks;
}

export function isDamageImmuneTarget(
  state: BattleState,
  action: MoveAction,
  targetId: string,
  facts: ActionFacts | undefined,
): boolean {
  const target = getPokemon(state, targetId);
  const chargeMove = target?.volatile?.charge?.moveName;
  if (chargeMove && SEMI_INVULNERABLE_CHARGE_MOVES.has(moveId(chargeMove)) &&
    !SEMI_INVULNERABLE_BYPASS_MOVES.has(moveId(action.moveName))) return true;
  if (!facts || facts.moveCategory === 'Status') return false;
  if (action.targetIds.length === 1) return facts.isImmune === true;
  return facts.damageByTarget?.[targetId]?.max === 0;
}

export function eligibleTargetIds(
  state: BattleState,
  action: MoveAction,
  moveId: string,
  facts: ActionFacts | undefined,
  missedIds: string[] = [],
): {targetIds: string[]; protectedIds: string[]; immuneIds: string[]} {
  const protectedIds = action.targetIds.filter(targetId => isProtectedTarget(state, targetId, moveId, action, facts));
  const immuneIds = action.targetIds.filter(targetId =>
    !protectedIds.includes(targetId) && !missedIds.includes(targetId) && isDamageImmuneTarget(state, action, targetId, facts));
  const excluded = new Set([...protectedIds, ...immuneIds, ...missedIds]);
  return {
    targetIds: action.targetIds.filter(targetId => !excluded.has(targetId)),
    protectedIds,
    immuneIds,
  };
}
