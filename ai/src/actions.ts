import * as Calc from '@smogon/calc';
import {getEffectiveAbility, isAbilityActive, isAbilityAvailable} from './abilities';
import {isItemEffectActive, preventsAbilityChange} from './items';
import {Action, BattleState, MoveAction, MoveTarget, PokemonState, SideId, SwitchAction, Weather} from './model';
import {
  CHARGE_MOVE_MIN_GENERATION,
  getMoveMetadata,
  isMoveAvailable,
  PROTECTION_MOVE_MIN_GENERATION,
  RECHARGE_MOVE_MIN_GENERATION,
  UPROAR_MOVE_MIN_GENERATION,
} from './move-metadata';
import {hasPureAbilityEffect, PURE_ABILITY_MOVE_IDS} from './ability-legality';
import {hasMoveCopyEffect, PURE_MOVE_COPY_IDS} from './copy-legality';
import {hasCallMoveEffect, PURE_CALL_MOVE_IDS} from './call-legality';
import {hasInstructEffect} from './instruct-legality';
import {hasPureItemTransferEffect, PURE_ITEM_TRANSFER_MOVE_IDS} from './item-legality';
import {hasSelfStageEffect} from './setup-legality';
import {PURE_STATUS_EFFECTS, PURE_STATUS_MOVE_IDS} from './status-legality';
import {canApplyMajorStatus, canApplyVolatile, getEffectiveTypes, isGhostTrapImmune, isGrounded} from './eligibility';
import {
  hasMixedTargetStageEffect,
  hasTargetStageBoostEffect,
  hasTargetStageEffect,
  hasTargetStageResetEffect,
  MIXED_TARGET_STAGE_MOVE_IDS,
  PURE_TARGET_STAGE_BOOST_IDS,
  PURE_TARGET_STAGE_DROP_IDS,
  PURE_TARGET_STAGE_RESET_MOVE_IDS,
} from './stage-legality';
import {PURE_CONFUSION_MOVE_IDS} from './volatile-legality';
import {hasPureStatTransferEffect, PURE_STAT_TRANSFER_MOVE_IDS} from './stat-transfer-legality';
import {hasPureTypeEffect, PURE_TYPE_MOVE_IDS} from './type-legality';
import {hasPurePPEffect, PURE_PP_MOVE_IDS} from './pp-legality';

const SELF_TARGET_MOVES = new Set([
  'acidarmor', 'agility', 'amnesia', 'aquaring', 'assist', 'autotomize', 'barrier', 'bellydrum', 'bulkup', 'calmmind',
  'camouflage', 'charge', 'conversion', 'conversion2', 'coil', 'cosmicpower', 'cottonguard', 'copycat', 'doubleteam',
  'dragondance', 'endure', 'focusenergy', 'growth', 'healingwish', 'harden', 'howl', 'honeclaws', 'ingrain',
  'irondefense', 'laserfocus', 'lunardance', 'magnetrise', 'nastyplot',
  'meditate', 'metronome', 'minimize', 'mirrormove', 'noretreat', 'protect', 'quiverdance',
  'powertrick', 'recover', 'recycle', 'refresh', 'rest', 'roost', 'rockpolish', 'shellsmash', 'sharpen',
  'slackoff', 'sleeptalk', 'splash', 'stockpile', 'substitute', 'swallow', 'synthesis',
  'swordsdance', 'tailglow', 'teleport', 'wish', 'workup', 'shelter', 'takeheart',
  'stuffcheeks', 'batonpass', 'shedtail', 'destinybond', 'grudge', 'detect', 'imprison', 'kingsshield', 'matblock', 'quickguard',
  'ragepowder', 'followme', 'allyswitch', 'magiccoat', 'snatch', 'wideguard', 'quickguard', 'matblock',
  'banefulbunker', 'spikyshield', 'silktrap', 'obstruct', 'burningbulwark', 'maxguard',
]);

const ALLY_TARGET_MOVES = new Set([
  'afteryou', 'aromaticmist', 'coaching', 'decorate', 'floralhealing', 'healpulse',
  'helpinghand', 'holdhands', 'instruct', 'purify',
]);

const ALLY_AND_SELF_TARGET_MOVES = new Set(['acupressure', 'junglehealing', 'lifedew', 'lunarblessing']);
const ALLY_TEAM_STATUS_MOVES = new Set(['aromatherapy', 'healbell']);

const OTHER_POKEMON_TARGET_MOVES = new Set([
  'bestow', 'guardsplit', 'guardswap', 'heartswap', 'mimic', 'painsplit', 'pollenpuff', 'powersplit', 'powerswap',
  'present', 'psychup', 'skillswap', 'speedswap', 'spotlight', 'sketch', 'transform',
]);

const ALL_ACTIVE_TARGET_MOVES = new Set(['flowershield', 'haze', 'perishsong', 'rototiller', 'teatime']);

const SIDE_TARGET_MOVES = new Set([
  'aromatherapy', 'auroraveil', 'courtchange', 'craftyshield', 'fairylock', 'gravity', 'grassyterrain', 'hail',
  'healbell', 'iondeluge', 'lightscreen', 'luckychant', 'magicroom', 'mist', 'psychicterrain', 'reflect',
  'raindance', 'safeguard', 'sandstorm', 'snowscape', 'spikes', 'stealthrock', 'stickyweb',
  'sunnyday', 'tailwind', 'toxicspikes', 'trickroom', 'watersport', 'mudsport', 'wonderroom',
]);

export function getPokemon(state: BattleState, id: string): PokemonState | undefined {
  for (const sideId of ['ai', 'player'] as SideId[]) {
    const side = state.sides[sideId];
    const pokemon = side.party.find(candidate => candidate.id === id);
    if (pokemon) return pokemon;
  }
  return undefined;
}

export function isDisguiseActive(state: BattleState, pokemon: PokemonState): boolean {
  return isAbilityActive(pokemon, state) && isAbilityAvailable(state.generation, 'disguise') &&
    moveId(getEffectiveAbility(pokemon)) === 'disguise' &&
    pokemon.disguiseBroken !== true;
}

export function isGhostType(state: BattleState, pokemonId: string): boolean {
  const pokemon = getPokemon(state, pokemonId);
  if (!pokemon) return false;
  return getEffectiveTypes(state, pokemon.id).some(type => Calc.toID(type) === 'ghost');
}

export function sideForPokemon(state: BattleState, pokemonId: string): SideId {
  for (const sideId of ['ai', 'player'] as SideId[]) {
    if (state.sides[sideId].party.some(pokemon => pokemon.id === pokemonId)) return sideId;
  }
  throw new Error(`Unknown Pokémon id: ${pokemonId}`);
}

export function isShedShellActive(state: BattleState, pokemon: PokemonState): boolean {
  return isItemEffectActive(state, pokemon) && moveId(pokemon.item) === 'shedshell';
}

type TrappingVolatile = 'trapped' | 'partiallyTrapped' | 'octolock';

export function canEscapeTrappingEffect(
  state: BattleState,
  pokemon: PokemonState,
  volatile?: TrappingVolatile,
): boolean {
  if (volatile === 'trapped' && pokemon.volatile?.trapped && !pokemon.volatile.trapped.sourceId) return false;
  return isShedShellActive(state, pokemon) || isGhostTrapImmune(state, pokemon.id);
}

/**
 * Return whether a living active PokÃ©mon is held by an opposing trapping ability.
 * The serializable model has no slot adjacency, so any living opposing active
 * holder is treated as able to reach the actor; callers can narrow this at a
 * battle-policy layer when they have positional information.
 */
export function isSwitchBlockedByAbility(state: BattleState, pokemonId: string): boolean {
  const actor = getPokemon(state, pokemonId);
  if (!actor || actor.hp.current <= 0 || state.generation < 3) return false;
  if (canEscapeTrappingEffect(state, actor)) return false;

  const actorSide = sideForPokemon(state, pokemonId);
  const opposingSide = actorSide === 'ai' ? 'player' : 'ai';
  const actorTypes = getEffectiveTypes(state, pokemonId).map(moveId);
  const ghostCanEscape = state.generation >= 6 && actorTypes.includes('ghost');
  if (ghostCanEscape) return false;

  const actorAbility = isAbilityActive(actor, state) && isAbilityAvailable(state.generation, getEffectiveAbility(actor))
    ? moveId(getEffectiveAbility(actor))
    : undefined;
  return state.sides[opposingSide].activeIds.some(holderId => {
    const holder = getPokemon(state, holderId);
    if (!holder || holder.hp.current <= 0 || !isAbilityActive(holder, state) ||
      !isAbilityAvailable(state.generation, getEffectiveAbility(holder))) return false;
    const ability = moveId(getEffectiveAbility(holder));
    if (ability === 'arenatrap') return isGrounded(state, pokemonId);
    if (ability === 'magnetpull') return actorTypes.includes('steel');
    if (ability === 'shadowtag') return actorAbility !== 'shadowtag';
    return false;
  });
}

/** Whether an active Cloud Nine or Air Lock suppresses weather effects. */
export function isWeatherSuppressed(state: BattleState): boolean {
  return (['ai', 'player'] as const).some(sideId =>
    state.sides[sideId].activeIds.some(pokemonId => {
      const pokemon = getPokemon(state, pokemonId);
      return !!pokemon && pokemon.hp.current > 0 &&
        isAbilityActive(pokemon, state) && isAbilityAvailable(state.generation, getEffectiveAbility(pokemon)) &&
        ['cloudnine', 'airlock'].includes(moveId(getEffectiveAbility(pokemon)));
    }));
}

export function isSunWeather(weather: Weather | undefined): boolean {
  return weather === 'Sun' || weather === 'Harsh Sunshine';
}

export function isRainWeather(weather: Weather | undefined): boolean {
  return weather === 'Rain' || weather === 'Heavy Rain';
}

export function isStrongWeather(weather: Weather | undefined): boolean {
  return weather === 'Harsh Sunshine' || weather === 'Heavy Rain' || weather === 'Strong Winds';
}

export function actionKey(action: Action): string {
  if (action.kind === 'switch') {
    const mode = action.forced ? 'forced' : action.batonPass ? 'batonpass' : action.preserveSubstitute ? 'substitutepass' : 'voluntary';
    return `switch:${action.actorId}:${action.replacementId}:${mode}`;
  }
  return `move:${action.actorId}:${action.moveName}:${action.targetIds.join(',')}`;
}

function activePokemon(state: BattleState, sideId: SideId): PokemonState[] {
  const side = state.sides[sideId];
  return side.activeIds
    .map(id => getPokemon(state, id))
    .filter((pokemon): pokemon is PokemonState => !!pokemon && pokemon.hp.current > 0 &&
      !state.pendingForcedSwitchIds?.includes(pokemon.id) &&
      !state.pendingBatonPassIds?.includes(pokemon.id) &&
      !state.pendingSubstitutePassIds?.includes(pokemon.id));
}

function hasActiveAlly(state: BattleState, pokemon: PokemonState): boolean {
  const sideId = sideForPokemon(state, pokemon.id);
  return state.mode === 'Doubles' && state.sides[sideId].activeIds.some(id =>
    id !== pokemon.id && (getPokemon(state, id)?.hp.current || 0) > 0);
}

function targetForMove(state: BattleState, move: PokemonState['moves'][number]): MoveTarget {
  if (move.target) return move.target;
  const id = move.name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (SELF_TARGET_MOVES.has(id)) return 'self';
  if (ALLY_TARGET_MOVES.has(id)) return 'adjacentAlly';
  if (SIDE_TARGET_MOVES.has(id)) return 'allySide';
  // Preserve the calculator's target projection for canonical moves: the
  // simulator dex and calculator use slightly different target vocabularies
  // for a few stateful moves such as Bide. The inherited calculator may not
  // contain caller-defined or newly added canonical moves, so fall back to
  // the shared metadata boundary for those names instead of throwing.
  try {
    const gen = Calc.Generations.get(state.generation);
    return new Calc.Move(gen, move.name).target as MoveTarget;
  } catch {
    return getMoveMetadata(move.name, state.generation).target || 'normal';
  }
}

function redirectionTarget(
  state: BattleState,
  actor: PokemonState,
  foes: PokemonState[],
  target: MoveTarget,
  moveName: string,
): PokemonState | undefined {
  if (!['adjacentFoe', 'any', 'normal', 'randomNormal'].includes(target)) return undefined;
  const redirector = foes.find(pokemon =>
    pokemon.volatile?.followMe || pokemon.volatile?.ragePowder || pokemon.volatile?.spotlight);
  if (!redirector) return undefined;
  const moveIdValue = moveId(moveName);
  if (moveIdValue === 'snipeshot' ||
    (isAbilityActive(actor, state) && isAbilityAvailable(state.generation, getEffectiveAbility(actor)) &&
      ['stalwart', 'propellertail'].includes(moveId(getEffectiveAbility(actor))))) {
    return undefined;
  }
  if (redirector.volatile?.ragePowder && state.generation >= 6 &&
    (effectiveTypesForRedirection(state, actor).some(type => moveId(type) === 'grass') ||
      (isAbilityActive(actor, state) && isAbilityAvailable(state.generation, getEffectiveAbility(actor)) &&
        moveId(getEffectiveAbility(actor)) === 'overcoat') ||
      (isItemEffectActive(state, actor) && moveId(actor.item) === 'safetygoggles'))) {
    return undefined;
  }
  return redirector;
}

function moveId(name: string | undefined): string {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isBerry(item: string | undefined): boolean {
  return moveId(item).endsWith('berry');
}

function sameStages(actor: PokemonState, target: PokemonState, stats: string[]): boolean {
  return stats.every(stat =>
    (actor.boosts?.[stat as keyof NonNullable<PokemonState['boosts']>] || 0) ===
    (target.boosts?.[stat as keyof NonNullable<PokemonState['boosts']>] || 0));
}

function hasTargetMoveEffect(state: BattleState, actor: PokemonState, id: string, targetIds: string[]): boolean {
  if (id === 'revivalblessing') {
    return state.generation >= 9 && targetIds.some(targetId => {
      const target = getPokemon(state, targetId);
      return !!target && target.id !== actor.id && target.hp.current <= 0 &&
        sideForPokemon(state, target.id) === sideForPokemon(state, actor.id);
    });
  }
  const targets = targetIds
    .map(targetId => getPokemon(state, targetId))
    .filter((target): target is PokemonState => !!target && target.hp.current > 0);
  if (id === 'lunarblessing') return targets.some(target => target.hp.current < target.hp.max ||
    !!target.status || !!target.toxicCounter);
  if (id === 'rest') return actor.hp.current < actor.hp.max && canApplyMajorStatus(
    state,
    actor.id,
    actor.id,
    'slp',
    undefined,
    false,
    true,
  );
  if (new Set([
    'healorder', 'milkdrink', 'moonlight', 'morningsun', 'recover', 'roost',
    'shoreup', 'slackoff', 'softboiled', 'synthesis',
  ]).has(id)) return actor.hp.current < actor.hp.max;
  if (id === 'teatime') return state.generation === 8 && targets.some(target => isBerry(target.item));
  const pureStatus = PURE_STATUS_EFFECTS[id];
  if (pureStatus) return targets.some(target => canApplyMajorStatus(
    state, actor.id, target.id, pureStatus.status, pureStatus.moveType, true,
  ));
  if (PURE_CONFUSION_MOVE_IDS.has(id)) return targets.some(target => canApplyVolatile(
    state, target.id, 'confusion', actor.id, true,
  ));
  if (PURE_TARGET_STAGE_RESET_MOVE_IDS.has(id)) return targets.some(target =>
    hasTargetStageResetEffect(target.boosts, id));
  if (MIXED_TARGET_STAGE_MOVE_IDS.has(id)) return targets.some(target =>
    hasMixedTargetStageEffect(target.boosts, id));
  if (PURE_TARGET_STAGE_BOOST_IDS.has(id)) return targets.some(target =>
    hasTargetStageBoostEffect(target.boosts, id));
  if (id === 'tarshot') return targets.some(target =>
    hasTargetStageEffect(target.boosts, id) ||
    canApplyVolatile(state, target.id, 'tarShot', actor.id, true, 'Status'));
  if (id === 'flowershield') return state.generation >= 6 && state.generation <= 8 && targets.some(target =>
    effectiveTypesForRedirection(state, target).some(type => moveId(type) === 'grass') &&
    (target.boosts?.def || 0) < 6);
  if (id === 'rototiller') return state.generation >= 6 && state.generation <= 7 && targets.some(target =>
    isGroundedForAction(state, target) && effectiveTypesForRedirection(state, target).some(type => moveId(type) === 'grass') &&
    ((target.boosts?.atk || 0) < 6 || (target.boosts?.spa || 0) < 6));
  const target = targets[0];
  if (!target) return false;
  if (PURE_ITEM_TRANSFER_MOVE_IDS.has(id)) return hasPureItemTransferEffect(state, actor, target, id);
  if (PURE_ABILITY_MOVE_IDS.has(id)) return hasPureAbilityEffect(state, actor, target, id);
  if (PURE_PP_MOVE_IDS.has(id)) return hasPurePPEffect(state, target, id);
  if (PURE_STAT_TRANSFER_MOVE_IDS.has(id)) return hasPureStatTransferEffect(state, actor, target, id);
  if (id === 'instruct') return hasInstructEffect(state, target);
  if (PURE_MOVE_COPY_IDS.has(id)) return hasMoveCopyEffect(state, actor, target, id);
  if (PURE_CALL_MOVE_IDS.has(id)) return hasCallMoveEffect(state, actor, target, id);
  if (PURE_TYPE_MOVE_IDS.has(id)) return hasPureTypeEffect(state, actor, target, id,
    pokemonId => getEffectiveTypes(state, pokemonId));
  if (PURE_TARGET_STAGE_DROP_IDS.has(id)) return hasTargetStageEffect(target.boosts, id) &&
    (id !== 'captivate' || !actor.gender || actor.gender === 'N' || !target.gender || target.gender === 'N' || actor.gender !== target.gender);
  if (id === 'attract') return !target.volatile?.infatuated &&
    canApplyVolatile(state, target.id, 'infatuated', actor.id, true, 'Status');
  if (id === 'yawn') return !target.volatile?.yawn &&
    canApplyMajorStatus(state, actor.id, target.id, 'slp', undefined, true);
  if (id === 'leechseed') return canApplyVolatile(state, target.id, 'leechSeed', actor.id, true, 'Status');
  if (id === 'telekinesis') return !state.field.gravity &&
    canApplyVolatile(state, target.id, 'telekinesis', actor.id, true, 'Status');
  if (id === 'nightmare') return canApplyVolatile(state, target.id, 'nightmare', actor.id, true, 'Status');
  if (id === 'acupressure') return !['atk', 'def', 'spa', 'spd', 'spe'].every(stat =>
    (target.boosts?.[stat as keyof NonNullable<PokemonState['boosts']>] || 0) >= 6);
  if (id === 'psychup') return !sameStages(actor, target, ['atk', 'def', 'spa', 'spd', 'spe']);
  if (id === 'guardswap') return !sameStages(actor, target, ['def', 'spd']);
  if (id === 'powerswap') return !sameStages(actor, target, ['atk', 'spa']);
  if (id === 'encore') return !!state.lastMoveByPokemon?.[target.id] &&
    !state.firstTurnOutIds?.includes(target.id) && !target.volatile?.encore;
  if (id === 'disable') return !!state.lastMoveByPokemon?.[target.id] && !target.volatile?.disable;
  if (id === 'taunt') return !target.volatile?.taunt;
  if (id === 'torment') return !target.volatile?.torment;
  if (id === 'leechseed') return !target.volatile?.leechSeed;
  if (id === 'perishsong') return targetIds.some(targetId => !getPokemon(state, targetId)?.volatile?.perishSong);
  if (id === 'foresight' || id === 'odorsleuth') return !target.volatile?.foresight;
  if (id === 'electrify') return !target.volatile?.electrified;
  if (id === 'octolock') return canApplyVolatile(state, target.id, 'octolock', actor.id, true, 'Status') &&
    !target.volatile?.trapped;
  if (id === 'miracleeye') return !target.volatile?.miracleEye;
  if (id === 'gastroacid') return !target.abilitySuppressed && !preventsAbilityChange(state, target);
  if (id === 'embargo') return !target.volatile?.embargo;
  if (id === 'healblock') return !target.volatile?.healBlock;
  if (['block', 'meanlook', 'spiderweb'].includes(id)) {
    return canApplyVolatile(state, target.id, 'trapped', actor.id, true, 'Status');
  }
  if (id === 'refresh') return !!actor.status || !!actor.toxicCounter;
  if (id === 'purify') return !!target.status || !!target.toxicCounter;
  if (id === 'painsplit') return actor.hp.current !== target.hp.current;
  if (['floralhealing', 'healpulse', 'pollenpuff'].includes(id) &&
    sideForPokemon(state, target.id) === sideForPokemon(state, actor.id)) {
    return target.hp.current < target.hp.max;
  }
  if (id === 'lifedew') return targets.some(candidate => candidate.hp.current < candidate.hp.max);
  if (id === 'junglehealing') return targets.some(candidate => candidate.hp.current < candidate.hp.max ||
    !!candidate.status || !!candidate.toxicCounter);
  if (id === 'aromatherapy' || id === 'healbell') return targets.some(candidate =>
    sideForPokemon(state, candidate.id) === sideForPokemon(state, actor.id) &&
    (!!candidate.status || !!candidate.toxicCounter));
  return true;
}

function isGroundedForAction(state: BattleState, pokemon: PokemonState): boolean {
  if (state.field.gravity || pokemon.volatile?.landed || pokemon.volatile?.roost) return true;
  if (pokemon.volatile?.magnetRise || pokemon.volatile?.telekinesis) return false;
  if (isItemEffectActive(state, pokemon) && moveId(pokemon.item) === 'ironball') return true;
  if (effectiveTypesForRedirection(state, pokemon).some(type => moveId(type) === 'flying')) return false;
  if (isAbilityActive(pokemon, state) && isAbilityAvailable(state.generation, getEffectiveAbility(pokemon)) &&
    moveId(getEffectiveAbility(pokemon)) === 'levitate') return false;
  return !(isItemEffectActive(state, pokemon) && moveId(pokemon.item) === 'airballoon');
}

function hasLegalReplacement(state: BattleState, actor: PokemonState): boolean {
  const sideId = sideForPokemon(state, actor.id);
  const sourceIsActive = (sourceId: string | undefined) =>
    !sourceId || (getPokemon(state, sourceId)?.hp.current || 0) > 0;
  if (actor.hp.current <= 0 || actor.volatile?.ingrain || actor.volatile?.commanding || actor.volatile?.commanded ||
    state.field.fairyLock || isSwitchBlockedByAbility(state, actor.id)) return false;
  if (!canEscapeTrappingEffect(state, actor, 'trapped') && actor.volatile?.trapped && sourceIsActive(actor.volatile.trapped.sourceId)) return false;
  if (!canEscapeTrappingEffect(state, actor, 'partiallyTrapped') && actor.volatile?.partiallyTrapped && sourceIsActive(actor.volatile.partiallyTrapped.sourceId)) return false;
  if (!canEscapeTrappingEffect(state, actor, 'octolock') && actor.volatile?.octolock && sourceIsActive(actor.volatile.octolock.sourceId)) return false;
  return state.sides[sideId].party.some(pokemon =>
    pokemon.id !== actor.id && pokemon.hp.current > 0 && !state.sides[sideId].activeIds.includes(pokemon.id));
}

function hasSelfMoveEffect(state: BattleState, actor: PokemonState, id: string): boolean {
  if (id === 'takeheart') return !!actor.status || hasSelfStageEffect(actor.boosts, id);
  if (!hasSelfStageEffect(actor.boosts, id)) return false;
  if (id === 'aquaring') return !actor.volatile?.aquaRing;
  if (id === 'ingrain') return !actor.volatile?.ingrain;
  if (id === 'magnetrise') return !actor.volatile?.magnetRise;
  if (id === 'psychoshift') return !!actor.status;
  if (id === 'magiccoat' && state.generation >= 4 && state.generation < 8) return !actor.volatile?.magicCoat;
  if (id === 'snatch' && state.generation >= 3 && state.generation < 8) return !actor.volatile?.snatch;
  if (id === 'grudge') return state.generation >= 3 && !actor.volatile?.grudge;
  if ((id === 'healingwish' || id === 'lunardance') && state.generation >= 4) return hasLegalReplacement(state, actor);
  if (id === 'shedtail' && state.generation >= 9) return actor.hp.current > Math.floor(actor.hp.max / 2) &&
    !(actor.substituteHp || 0) && hasLegalReplacement(state, actor);
  return true;
}

function hasFieldMoveEffect(state: BattleState, actor: PokemonState, id: string): boolean {
  const sideId = sideForPokemon(state, actor.id);
  const ownEffects = state.sides[sideId].effects || {};
  const foeEffects = state.sides[sideId === 'ai' ? 'player' : 'ai'].effects || {};
  if (id === 'stealthrock') return !foeEffects.stealthRock;
  if (id === 'spikes') return (foeEffects.spikes || 0) < 3;
  if (id === 'toxicspikes') return (foeEffects.toxicSpikes || 0) < 2;
  if (id === 'stickyweb') return !foeEffects.stickyWeb;
  if (id === 'reflect') return !ownEffects.reflect;
  if (id === 'lightscreen') return !ownEffects.lightScreen;
  if (id === 'auroraveil') return (state.field.weather === 'Hail' || state.field.weather === 'Snow') && !ownEffects.auroraVeil;
  if (id === 'tailwind') return !ownEffects.tailwind;
  if (id === 'mist') return !ownEffects.mist;
  if (id === 'luckychant') return !ownEffects.luckyChant;
  if (id === 'craftyshield') return !ownEffects.craftyShield;
  if (id === 'fairylock') return !state.field.fairyLock;
  if (id === 'gravity') return state.generation >= 4 && !state.field.gravity;
  if (id === 'watersport') {
    if (state.generation < 3 || state.generation >= 8) return false;
    return state.generation <= 5 ? !actor.volatile?.waterSport : !state.field.waterSport;
  }
  if (id === 'mudsport') {
    if (state.generation < 3 || state.generation >= 8) return false;
    return state.generation <= 5 ? !actor.volatile?.mudSport : !state.field.mudSport;
  }
  if (id === 'iondeluge') return state.generation >= 6 && state.generation <= 7 && !state.field.ionDeluge;
  if (id === 'steelroller') return !!state.field.terrain;
  if (id === 'defog') {
    const hasHazards = (effects: typeof ownEffects) => !!effects.stealthRock || !!effects.spikes ||
      !!effects.toxicSpikes || !!effects.stickyWeb;
    const hasScreens = (effects: typeof ownEffects) => !!effects.reflect || !!effects.lightScreen ||
      !!effects.auroraVeil || !!effects.safeguard;
    return hasHazards(state.sides.ai.effects || {}) || hasHazards(state.sides.player.effects || {}) ||
      hasScreens(state.sides[sideId === 'ai' ? 'player' : 'ai'].effects || {});
  }
  if (id === 'courtchange') {
    const hasPersistentSideEffect = (effects: typeof ownEffects) => !!effects.stealthRock || !!effects.spikes ||
      !!effects.toxicSpikes || !!effects.stickyWeb || !!effects.reflect || !!effects.lightScreen ||
      !!effects.auroraVeil || !!effects.safeguard || !!effects.mist || !!effects.luckyChant ||
      !!effects.craftyShield || !!effects.tailwind;
    return hasPersistentSideEffect(state.sides.ai.effects || {}) || hasPersistentSideEffect(state.sides.player.effects || {});
  }
  const weatherBySetter: Record<string, Weather> = {
    raindance: 'Rain', sunnyday: 'Sun', sandstorm: 'Sand', hail: 'Hail', snowscape: 'Snow', chillyreception: 'Snow',
  };
  const weather = weatherBySetter[id];
  if (weather) {
    if (state.field.weather === weather && (state.generation >= 3 || id === 'sandstorm')) return false;
    if (state.field.weather && isStrongWeather(state.field.weather) && state.field.weather !== weather) return false;
  }
  const terrainBySetter: Record<string, string> = {
    electricterrain: 'Electric', grassyterrain: 'Grassy', mistyterrain: 'Misty', psychicterrain: 'Psychic',
  };
  const terrain = terrainBySetter[id];
  if (terrain && state.generation >= 6 && state.field.terrain === terrain) return false;
  return true;
}

function effectiveTypesForRedirection(state: BattleState, pokemon: PokemonState): string[] {
  return getEffectiveTypes(state, pokemon.id);
}

export function isChoiceItem(pokemon: PokemonState, state?: BattleState): boolean {
  return (!state || isItemEffectActive(state, pokemon)) &&
    ['choiceband', 'choicescarf', 'choicespecs'].includes(moveId(pokemon.item || ''));
}

function targetsForMove(
  state: BattleState,
  sideId: SideId,
  actor: PokemonState,
  move: PokemonState['moves'][number],
): string[][] {
  const own = activePokemon(state, sideId);
  const opposingSide: SideId = sideId === 'ai' ? 'player' : 'ai';
  const foes = activePokemon(state, opposingSide);
  const allies = own.filter(pokemon => pokemon.id !== actor.id);
  const id = moveId(move.name);
  if (!move.target && id === 'revivalblessing') {
    return state.generation >= 9
      ? state.sides[sideId].party
        .filter(pokemon => pokemon.id !== actor.id && pokemon.hp.current <= 0)
        .map(pokemon => [pokemon.id])
      : [];
  }
  if (!move.target && id === 'conversion2' && state.generation >= 5) {
    const targets = [...allies, ...foes];
    return targets.length ? targets.map(pokemon => [pokemon.id]) : [[]];
  }
  if (!move.target && ALLY_TEAM_STATUS_MOVES.has(id)) {
    return [state.sides[sideId].party.map(pokemon => pokemon.id)];
  }
  if (!move.target && state.generation >= 9 && id === 'tidyup') {
    return [[...own, ...foes].map(pokemon => pokemon.id)];
  }
  if (!move.target && ALLY_AND_SELF_TARGET_MOVES.has(id)) return [own.map(pokemon => pokemon.id)];
  if (!move.target && ALL_ACTIVE_TARGET_MOVES.has(id)) return [[...own, ...foes].map(pokemon => pokemon.id)];
  if (!move.target && OTHER_POKEMON_TARGET_MOVES.has(id)) {
    const targets = [...allies, ...foes];
    return targets.length ? targets.map(pokemon => [pokemon.id]) : [[]];
  }
  const target = !move.target && moveId(move.name) === 'curse' && !isGhostType(state, actor.id)
    ? 'self' as const
    : targetForMove(state, move);
  const redirector = state.mode === 'Doubles'
    ? redirectionTarget(state, actor, foes, target, move.name)
    : undefined;

  switch (target) {
    case 'self':
      return [[actor.id]];
    case 'adjacentAllyOrSelf':
      return [actor, ...allies].map(pokemon => [pokemon.id]);
    case 'adjacentAlly':
    case 'allies':
      return allies.map(pokemon => [pokemon.id]);
    case 'allySide':
    case 'allyTeam':
    case 'foeSide':
      return [[]];
    case 'all':
    case 'allAdjacent':
      return [[...allies, ...foes].map(pokemon => pokemon.id)];
    case 'allAdjacentFoes':
      return [foes.map(pokemon => pokemon.id)];
    case 'adjacentFoe':
    case 'any':
    case 'normal':
    case 'randomNormal':
    case 'scripted':
    default:
      return redirector ? [[redirector.id]] : foes.length ? foes.map(pokemon => [pokemon.id]) : [[]];
  }
}

function canUseMove(state: BattleState, actor: PokemonState, move: PokemonState['moves'][number]): boolean {
  const moveMetadata = getMoveMetadata(move.name, state.generation);
  const id = moveId(move.name);
  if (actor.volatile?.commanding) return false;
  if (!isMoveAvailable(move.name, state.generation)) return false;
  if (actor.volatile?.bide && id !== 'bide') return false;
  if (actor.volatile?.rollout && id !== moveId(actor.volatile.rollout.moveName)) return false;
  if (actor.volatile?.rampage && id !== moveId(actor.volatile.rampage.moveName)) return false;
  if (actor.volatile?.recharge && id !== moveId(actor.volatile.recharge.moveName)) return false;
  if (actor.volatile?.charge && id !== moveId(actor.volatile.charge.moveName)) return false;
  if (actor.volatile?.uproar && id !== moveId(actor.volatile.uproar.moveName)) return false;
  if (actor.volatile?.throatChop && moveMetadata.sound) return false;
  if (id === 'gigatonhammer' && moveId(state.lastMoveUsedByPokemon?.[actor.id]) === id) return false;
  if (RECHARGE_MOVE_MIN_GENERATION[id] !== undefined &&
    state.generation < RECHARGE_MOVE_MIN_GENERATION[id]) return false;
  if (CHARGE_MOVE_MIN_GENERATION[id] !== undefined &&
    state.generation < CHARGE_MOVE_MIN_GENERATION[id]) return false;
  if (UPROAR_MOVE_MIN_GENERATION[id] !== undefined &&
    state.generation < UPROAR_MOVE_MIN_GENERATION[id]) return false;
  if (id === 'rollout' && state.generation < 2) return false;
  if (id === 'iceball' && state.generation < 3) return false;
  if (id === 'outrage' && state.generation < 2) return false;
  if (id === 'nightmare' && (state.generation < 2 || state.generation >= 8)) return false;
  if (id === 'electrify' && state.generation < 6) return false;
  if (id === 'shelltrap' && state.generation < 7) return false;
  if (id === 'octolock' && state.generation < 8) return false;
  if (id === 'miracleeye' && state.generation < 4) return false;
  if (PROTECTION_MOVE_MIN_GENERATION[id] !== undefined &&
    state.generation < PROTECTION_MOVE_MIN_GENERATION[id]) return false;
  if ((id === 'lockon' || id === 'mindreader') && state.generation < 2) return false;
  if (id === 'followme' && state.generation < 3) return false;
  if (id === 'ragepowder' && state.generation < 4) return false;
  if ((id === 'ragefist' || id === 'lastrespects') && state.generation < 9) return false;
  if (id === 'allyswitch' && (state.generation < 6 || !hasActiveAlly(state, actor))) return false;
  if (id === 'spotlight' && (state.generation < 7 || state.mode !== 'Doubles')) return false;
  if (id === 'magiccoat' && state.generation < 4) return false;
  if (id === 'snatch' && (state.generation < 3 || state.generation >= 8)) return false;
  if (id === 'mirrorcoat' && state.generation < 2) return false;
  if (id === 'metalburst' && state.generation < 4) return false;
  if (id === 'focuspunch' && state.generation < 3) return false;
  if (['wideguard', 'quickguard'].includes(id) && state.generation < 5) return false;
  if (id === 'matblock' && (state.generation < 6 ||
    (state.firstTurnOutIds !== undefined && !state.firstTurnOutIds.includes(actor.id)))) return false;
  if ((id === 'fakeout' && state.generation < 3) || (id === 'firstimpression' && state.generation < 7) ||
    (['fakeout', 'firstimpression'].includes(id) && state.firstTurnOutIds !== undefined &&
      !state.firstTurnOutIds.includes(actor.id))) return false;
  if (state.generation >= 6 && moveMetadata.category === 'Status' &&
    isItemEffectActive(state, actor) && moveId(actor.item) === 'assaultvest') return false;
  if (id === 'corrosivegas' && state.generation < 8) return false;
  if (id === 'burnup' && (state.generation < 7 || !getEffectiveTypes(state, actor.id).some(type => moveId(type) === 'fire'))) return false;
  if (id === 'doubleshock' && (state.generation < 9 || !getEffectiveTypes(state, actor.id).some(type => moveId(type) === 'electric'))) return false;
  if (id === 'naturalgift' && (state.generation < 4 || state.generation > 7)) return false;
  if (id === 'stuffcheeks' && (!actor.item || !moveId(actor.item).endsWith('berry') ||
    actor.itemCorroded || actor.volatile?.embargo)) {
    return false;
  }
  if (id === 'belch' && (state.generation < 6 || !isBerry(actor.lastConsumedItem))) return false;
  if (['sleeptalk', 'snore'].includes(id) && (actor.status !== 'slp' || actor.statusTurns === 0)) return false;
  const stockpileCount = actor.volatile?.stockpile?.stacks || 0;
  if (id === 'stockpile' && stockpileCount >= 3) return false;
  if ((id === 'swallow' || id === 'spitup') && stockpileCount === 0) return false;
  if (id === 'swallow' && actor.hp.current >= actor.hp.max) return false;
  if (id === 'rest' && actor.hp.current >= actor.hp.max) return false;
  if (id === 'bellydrum' && actor.hp.current <= Math.floor(actor.hp.max / 2)) return false;
  if (id === 'clangoroussoul' && state.generation >= 8 && actor.hp.current <= Math.floor(actor.hp.max / 3)) return false;
  if (id === 'filletaway' && state.generation >= 9 && actor.hp.current <= Math.floor(actor.hp.max / 2)) return false;
  if (id === 'substitute' && (actor.substituteHp || 0) > 0) return false;
  if (id === 'substitute' && actor.hp.current <= Math.floor(actor.hp.max / 4)) return false;
  if (id === 'noretreat' && actor.volatile?.trapped) return false;
  if (id === 'lastresort' && (actor.moves.length <= 1 || actor.moves.some(candidate =>
    moveId(candidate.name) !== 'lastresort' && (candidate.timesUsed || 0) < 1))) return false;
  if (id === 'recycle' && (state.generation < 3 || !!actor.item || !actor.lastConsumedItem)) return false;
  if (actor.volatile?.taunt && moveMetadata.category === 'Status') return false;
  if (actor.volatile?.healBlock && new Set([
    'healorder', 'milkdrink', 'moonlight', 'morningsun', 'recover', 'rest', 'roost',
    'shoreup', 'slackoff', 'softboiled', 'strengthsap', 'swallow', 'synthesis',
  ]).has(moveId(move.name))) return false;
  const encoreMove = actor.volatile?.encore?.moveName;
  if (encoreMove && moveId(move.name) !== moveId(encoreMove)) return false;
  const disabledMove = actor.volatile?.disable?.moveName;
  if (disabledMove && moveId(move.name) === moveId(disabledMove)) return false;
  const lastMove = state.lastMoveByPokemon?.[actor.id];
  if (actor.volatile?.torment && lastMove && moveId(move.name) === moveId(lastMove)) return false;
  const choiceMove = isItemEffectActive(state, actor) ? state.choiceLockByPokemon?.[actor.id] : undefined;
  if (choiceMove && moveId(move.name) !== moveId(choiceMove)) return false;
  const opponentSide: SideId = sideForPokemon(state, actor.id) === 'ai' ? 'player' : 'ai';
  const imprisoned = state.sides[opponentSide].activeIds.some(activeId =>
    (getPokemon(state, activeId)?.hp.current || 0) > 0 &&
    getPokemon(state, activeId)?.volatile?.imprison?.moveNames?.some(
      imprisonedMove => moveId(imprisonedMove) === moveId(move.name),
    ),
  );
  if (imprisoned) return false;
  return true;
}

export function enumerateMoveActions(state: BattleState, sideId: SideId = 'ai'): MoveAction[] {
  const actions: MoveAction[] = [];

  for (const actor of activePokemon(state, sideId)) {
    const actorActions: MoveAction[] = [];
    if (actor.volatile?.recharge) {
      const rechargeMove = actor.moves.find(move =>
        moveId(move.name) === moveId(actor.volatile?.recharge?.moveName),
      );
      if (rechargeMove) {
        actorActions.push({kind: 'move', actorId: actor.id, moveName: rechargeMove.name, targetIds: []});
      }
      actions.push(...actorActions);
      continue;
    }
    if (actor.volatile?.charge) {
      const chargedMove = actor.moves.find(move =>
        moveId(move.name) === moveId(actor.volatile?.charge?.moveName),
      );
      if (chargedMove) {
        actorActions.push({
          kind: 'move',
          actorId: actor.id,
          moveName: chargedMove.name,
          targetIds: [...(actor.volatile.charge.targetIds || [])],
        });
      }
      actions.push(...actorActions);
      continue;
    }
    for (const move of actor.moves) {
      if (move.disabled || move.pp === 0 || !canUseMove(state, actor, move)) continue;

      for (const targetIds of targetsForMove(state, sideId, actor, move)) {
        const id = moveId(move.name);
        if (!hasSelfMoveEffect(state, actor, id)) continue;
        if (['stealthrock', 'spikes', 'toxicspikes', 'stickyweb', 'reflect', 'lightscreen', 'auroraveil',
          'tailwind', 'mist', 'luckychant', 'craftyshield', 'fairylock', 'watersport', 'mudsport', 'iondeluge',
          'gravity', 'defog', 'courtchange', 'steelroller', 'flowershield', 'rototiller',
          'raindance', 'sunnyday', 'sandstorm', 'hail', 'snowscape', 'chillyreception', 'electricterrain',
          'grassyterrain', 'mistyterrain', 'psychicterrain'].includes(id) && !hasFieldMoveEffect(state, actor, id)) continue;
        if ([...Array.from(PURE_STATUS_MOVE_IDS), ...Array.from(PURE_TARGET_STAGE_DROP_IDS), ...Array.from(MIXED_TARGET_STAGE_MOVE_IDS), ...Array.from(PURE_TARGET_STAGE_BOOST_IDS), ...Array.from(PURE_ITEM_TRANSFER_MOVE_IDS), ...Array.from(PURE_ABILITY_MOVE_IDS), ...Array.from(PURE_STAT_TRANSFER_MOVE_IDS), ...Array.from(PURE_CONFUSION_MOVE_IDS), ...Array.from(PURE_TARGET_STAGE_RESET_MOVE_IDS), ...Array.from(PURE_MOVE_COPY_IDS), ...Array.from(PURE_CALL_MOVE_IDS), ...Array.from(PURE_TYPE_MOVE_IDS), ...Array.from(PURE_PP_MOVE_IDS), 'revivalblessing', 'lunarblessing', 'odorsleuth', 'instruct', 'acupressure', 'guardswap', 'powerswap', 'psychup', 'teatime', 'flowershield', 'rototiller', 'encore', 'disable',
          'taunt', 'torment', 'leechseed', 'attract', 'yawn', 'telekinesis', 'nightmare', 'perishsong', 'foresight', 'electrify', 'octolock',
          'miracleeye', 'gastroacid', 'embargo', 'healblock', 'block', 'meanlook', 'spiderweb',
          'healorder', 'milkdrink', 'moonlight', 'morningsun', 'recover', 'rest', 'roost', 'shoreup',
          'slackoff', 'softboiled', 'synthesis', 'refresh', 'purify', 'painsplit', 'floralhealing',
          'healpulse', 'pollenpuff', 'lifedew', 'junglehealing', 'aromatherapy', 'healbell'].includes(id) &&
          !hasTargetMoveEffect(state, actor, id, targetIds)) continue;
        if (id === 'dreameater' && !targetIds.some(targetId => getPokemon(state, targetId)?.status === 'slp')) continue;
        actorActions.push({
          kind: 'move',
          actorId: actor.id,
          moveName: move.name,
          targetIds,
          useZ: move.useZ,
          useMax: move.useMax,
        });
      }
    }
    if (!actorActions.length && !actor.volatile?.commanding && !actor.volatile?.commanded) {
      const struggle = {name: 'Struggle'} as PokemonState['moves'][number];
      for (const targetIds of targetsForMove(state, sideId, actor, struggle)) {
        actorActions.push({kind: 'move', actorId: actor.id, moveName: struggle.name, targetIds});
      }
    }
    actions.push(...actorActions);
  }

  return actions;
}

export function enumerateSwitchActions(state: BattleState, sideId: SideId = 'ai'): SwitchAction[] {
  if (state.mode !== 'Singles' && state.mode !== 'Doubles') return [];

  const side = state.sides[sideId];
  if (state.mode === 'Singles' && side.activeIds.length !== 1) return [];
  if (state.mode === 'Doubles' && (side.activeIds.length < 1 || side.activeIds.length > 2)) return [];

  return side.activeIds.flatMap(actorId => {
    const actor = getPokemon(state, actorId);
    const partialTrapSource = actor?.volatile?.partiallyTrapped?.sourceId
      ? getPokemon(state, actor.volatile.partiallyTrapped.sourceId)
      : undefined;
    const permanentTrapSource = actor?.volatile?.trapped?.sourceId
      ? getPokemon(state, actor.volatile.trapped.sourceId)
      : undefined;
    const octolockSource = actor?.volatile?.octolock?.sourceId
      ? getPokemon(state, actor.volatile.octolock.sourceId)
      : undefined;
    const activePartialTrap = Boolean(actor?.volatile?.partiallyTrapped && (partialTrapSource?.hp.current || 0) > 0);
    const activePermanentTrap = Boolean(actor?.volatile?.trapped &&
      (!actor.volatile.trapped.sourceId || (permanentTrapSource?.hp.current || 0) > 0));
    const activeOctolock = Boolean(actor?.volatile?.octolock && (octolockSource?.hp.current || 0) > 0);
    const canEscapePermanentTrap = actor ? canEscapeTrappingEffect(state, actor, 'trapped') : false;
    const canEscapePartialTrap = actor ? canEscapeTrappingEffect(state, actor, 'partiallyTrapped') : false;
    const canEscapeOctolock = actor ? canEscapeTrappingEffect(state, actor, 'octolock') : false;
    if (!actor || actor.hp.current <= 0 || actor.volatile?.commanding || actor.volatile?.commanded ||
      state.pendingForcedSwitchIds?.includes(actor.id) ||
      state.pendingBatonPassIds?.includes(actor.id) || state.pendingSubstitutePassIds?.includes(actor.id) ||
      actor.volatile?.ingrain || (!canEscapePermanentTrap && activePermanentTrap) ||
      (!canEscapeOctolock && activeOctolock) || (!canEscapePartialTrap && activePartialTrap) ||
      isSwitchBlockedByAbility(state, actor.id)) return [];
    return side.party
      .filter(pokemon => pokemon.id !== actorId && pokemon.hp.current > 0 && !side.activeIds.includes(pokemon.id))
      .map(pokemon => ({kind: 'switch' as const, actorId, replacementId: pokemon.id}));
  });
}

/**
 * Enumerate legal Singles or Doubles replacements after an active Pokémon has
 * fainted or is waiting on an explicit forced-switch queue. Post-KO replacement
 * preference is intentionally left to the battle/policy layer; this function
 * only exposes the legal state transition.
 */
export function enumerateForcedSwitchActions(state: BattleState, sideId: SideId = 'ai'): SwitchAction[] {
  if (state.mode !== 'Singles' && state.mode !== 'Doubles') return [];

  const side = state.sides[sideId];
  const pending = new Set(state.pendingForcedSwitchIds || []);
  const batonPass = new Set(state.pendingBatonPassIds || []);
  const substitutePass = new Set(state.pendingSubstitutePassIds || []);
  const forcedActors = side.activeIds
    .map(id => getPokemon(state, id))
    .filter((pokemon): pokemon is PokemonState => !!pokemon &&
      (pokemon.hp.current <= 0 || pending.has(pokemon.id) || batonPass.has(pokemon.id) || substitutePass.has(pokemon.id)));
  return forcedActors.flatMap(actor => side.party
    .filter(pokemon => pokemon.id !== actor.id && pokemon.hp.current > 0 && !side.activeIds.includes(pokemon.id))
    .map(pokemon => batonPass.has(actor.id)
      ? {kind: 'switch' as const, actorId: actor.id, replacementId: pokemon.id, batonPass: true}
      : substitutePass.has(actor.id)
        ? {kind: 'switch' as const, actorId: actor.id, replacementId: pokemon.id, preserveSubstitute: true}
        : {kind: 'switch' as const, actorId: actor.id, replacementId: pokemon.id, forced: true}));
}

export function enumerateActions(state: BattleState, sideId: SideId = 'ai'): Action[] {
  const forced = enumerateForcedSwitchActions(state, sideId);
  if (forced.length) return forced;
  return [...enumerateMoveActions(state, sideId), ...enumerateSwitchActions(state, sideId)];
}
