import {Action, ActionFacts, BattleState, DelayedMoveState, EndTurnResolution, MoveAction, MoveResolution, ResolutionTrace, SideEffects, SideId, StatBoosts, SwitchAction, SwitchEntryResolution, VolatileState} from './model';
import {getMoveMetadata} from './move-metadata';
import {pledgeElement} from './pledge';

const STATUS_NAMES = new Set(['', 'slp', 'psn', 'brn', 'frz', 'par', 'tox']);
const STAT_NAMES = new Set(['hp', 'atk', 'def', 'spa', 'spd', 'spe', 'acc', 'eva']);
const MOVE_CATEGORY_NAMES = new Set(['Physical', 'Special', 'Status']);
const VOLATILE_NAMES = new Set([
  'confusion', 'taunt', 'encore', 'imprison', 'disable', 'torment', 'yawn',
  'leechSeed', 'perishSong', 'nightmare', 'electrified', 'octolock', 'miracleEye', 'destinyBond', 'focusEnergy', 'laserFocus',
  'helpingHand', 'foresight', 'protected', 'flinch', 'infatuated', 'flashFire',
  'curse', 'stockpile', 'endure', 'aquaRing', 'ingrain', 'magnetRise', 'roost', 'telekinesis', 'landed',
  'waterSport', 'mudSport', 'trapped', 'partiallyTrapped', 'embargo', 'healBlock', 'followMe', 'ragePowder', 'spotlight', 'magicCoat', 'snatch', 'grudge', 'bide', 'rollout', 'rampage', 'recharge', 'charge', 'charged', 'uproar', 'lockOn', 'shellTrap', 'protosynthesis', 'quarkDrive', 'cudChew', 'micleBerry', 'glaiveRush', 'tarShot', 'throatChop', 'commanding', 'commanded', 'truant', 'slowStart',
]);
const HAZARD_LIMITS: Array<[keyof SideEffects, number]> = [
  ['spikes', 3], ['toxicSpikes', 2],
];
const WEATHER_NAMES = new Set([
  'Sand', 'Sun', 'Rain', 'Hail', 'Snow', 'Harsh Sunshine', 'Heavy Rain', 'Strong Winds',
]);
const TERRAIN_NAMES = new Set(['Electric', 'Grassy', 'Psychic', 'Misty']);
const MOVE_TARGET_NAMES = new Set([
  'adjacentAlly', 'adjacentAllyOrSelf', 'adjacentFoe', 'all', 'allAdjacent',
  'allAdjacentFoes', 'allies', 'allySide', 'allyTeam', 'any', 'foeSide',
  'normal', 'randomNormal', 'scripted', 'self',
]);
const FIELD_BOOLEAN_NAMES = [
  'trickRoom', 'gravity', 'magicRoom', 'wonderRoom', 'fairyLock', 'waterSport', 'mudSport', 'ionDeluge', 'auraBreak', 'darkAura',
  'fairyAura', 'beadsOfRuin', 'swordOfRuin', 'tabletsOfRuin', 'vesselOfRuin',
] as const;
const FIELD_DURATION_NAMES = new Set([
  'weather', 'terrain', 'trickRoom', 'gravity', 'magicRoom', 'wonderRoom', 'fairyLock', 'waterSport', 'mudSport', 'ionDeluge',
]);
const SIDE_DURATION_NAMES = new Set([
  'reflect', 'lightScreen', 'auroraVeil', 'tailwind', 'safeguard', 'mist', 'luckyChant', 'craftyShield', 'helpingHand', 'protected', 'wideGuard', 'quickGuard', 'matBlock', 'pledgeRainbow', 'pledgeSwamp', 'pledgeSeaOfFire',
  'steelsurge', 'vinelash', 'wildfire', 'cannonade', 'volcalith',
]);
const SIDE_EFFECT_NAMES = new Set([
  'spikes', 'toxicSpikes', 'stickyWeb', 'stealthRock', 'steelsurge', 'vinelash', 'wildfire',
  'cannonade', 'volcalith', 'reflect', 'lightScreen', 'auroraVeil', 'safeguard', 'mist', 'luckyChant', 'craftyShield', 'tailwind',
  'helpingHand', 'friendGuard', 'battery', 'powerSpot', 'seeded', 'foresight', 'protected', 'wideGuard', 'quickGuard', 'matBlock', 'pledgeRainbow', 'pledgeSwamp', 'pledgeSeaOfFire',
]);
const FIELD_NAMES = new Set(['weather', 'terrain', ...FIELD_BOOLEAN_NAMES, 'durations']);
const ACTION_FAILURE_NAMES = new Set(['flinch', 'paralysis', 'sleep', 'freeze', 'confusion', 'infatuation', 'protect', 'truant']);

function clientError(kind: 'BattleState' | 'Action', message: string): never {
  const error = new Error(`Invalid ${kind}: ${message}`) as Error & {statusCode: number};
  error.statusCode = 400;
  throw error;
}

function invalid(message: string): never {
  return clientError('BattleState', message);
}

function invalidAction(message: string): never {
  return clientError('Action', message);
}

function requireString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value) invalid(`${label} must be a non-empty string`);
}

function requireBoolean(value: unknown, label: string) {
  if (typeof value !== 'boolean') invalid(`${label} must be boolean`);
}

function validatePendingPledge(value: unknown, label: string, partyIds: Set<string>) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object`);
  const pending = value as {actorId?: unknown; moveName?: unknown; targetIds?: unknown; useZ?: unknown; useMax?: unknown};
  if (typeof pending.actorId !== 'string' || !partyIds.has(pending.actorId)) {
    invalid(`${label}.actorId must reference a party Pokémon`);
  }
  if (typeof pending.moveName !== 'string' || !pledgeElement(pending.moveName)) {
    invalid(`${label}.moveName must be a Pledge move`);
  }
  if (pending.useZ !== undefined && typeof pending.useZ !== 'boolean') invalid(`${label}.useZ must be boolean`);
  if (pending.useMax !== undefined && typeof pending.useMax !== 'boolean') invalid(`${label}.useMax must be boolean`);
  if (!Array.isArray(pending.targetIds) || new Set(pending.targetIds).size !== pending.targetIds.length ||
    pending.targetIds.some(targetId => typeof targetId !== 'string' || !partyIds.has(targetId))) {
    invalid(`${label}.targetIds must reference party Pokémon`);
  }
}

/** Validate an externally supplied action against the already validated party IDs. */
export function validateAction(state: BattleState, action: unknown): asserts action is Action {
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    invalidAction('action must be an object');
  }
  const candidate = action as Record<string, unknown>;
  const partyIds = new Set([
    ...state.sides.ai.party.map(pokemon => pokemon.id),
    ...state.sides.player.party.map(pokemon => pokemon.id),
  ]);
  if (typeof candidate.actorId !== 'string' || !candidate.actorId) {
    invalidAction('action.actorId must be a non-empty string');
  }
  if (!partyIds.has(candidate.actorId)) {
    invalidAction(`action.actorId ${candidate.actorId} is not in either party`);
  }

  if (candidate.kind === 'move') {
    const allowed = new Set(['kind', 'actorId', 'moveName', 'targetIds', 'useZ', 'useMax']);
    for (const key of Object.keys(candidate)) {
      if (!allowed.has(key)) invalidAction(`move action has unsupported property ${key}`);
    }
    if (typeof candidate.moveName !== 'string' || !candidate.moveName) {
      invalidAction('action.moveName must be a non-empty string');
    }
    if (!Array.isArray(candidate.targetIds) || candidate.targetIds.some(targetId => typeof targetId !== 'string' || !targetId)) {
      invalidAction('action.targetIds must contain non-empty strings');
    }
    const targetIds = candidate.targetIds as string[];
    if (new Set(targetIds).size !== targetIds.length) {
      invalidAction('action.targetIds cannot contain duplicates');
    }
    for (const targetId of targetIds) {
      if (!partyIds.has(targetId)) invalidAction(`action target ${targetId} is not in either party`);
    }
    if (candidate.useZ !== undefined && typeof candidate.useZ !== 'boolean') {
      invalidAction('action.useZ must be boolean');
    }
    if (candidate.useMax !== undefined && typeof candidate.useMax !== 'boolean') {
      invalidAction('action.useMax must be boolean');
    }
    return;
  }

  if (candidate.kind === 'switch') {
    const allowed = new Set(['kind', 'actorId', 'replacementId', 'forced', 'batonPass', 'preserveSubstitute']);
    for (const key of Object.keys(candidate)) {
      if (!allowed.has(key)) invalidAction(`switch action has unsupported property ${key}`);
    }
    if (typeof candidate.replacementId !== 'string' || !candidate.replacementId) {
      invalidAction('action.replacementId must be a non-empty string');
    }
    if (!partyIds.has(candidate.replacementId)) {
      invalidAction(`action.replacementId ${candidate.replacementId} is not in either party`);
    }
    for (const property of ['forced', 'batonPass', 'preserveSubstitute']) {
      if (candidate[property] !== undefined && typeof candidate[property] !== 'boolean') {
        invalidAction(`action.${property} must be boolean`);
      }
    }
    return;
  }

  invalidAction('action.kind must be move or switch');
}

function partyIdsOf(state: BattleState): Set<string> {
  return new Set([
    ...state.sides.ai.party.map(pokemon => pokemon.id),
    ...state.sides.player.party.map(pokemon => pokemon.id),
  ]);
}

function validatePartyMap(state: BattleState, values: unknown, label: string): Record<string, unknown> | undefined {
  if (values === undefined) return undefined;
  if (!values || typeof values !== 'object' || Array.isArray(values)) invalid(`${label} must be an object`);
  const partyIds = partyIdsOf(state);
  for (const id of Object.keys(values)) if (!partyIds.has(id)) invalid(`${label} references unknown Pokémon ${id}`);
  return values as Record<string, unknown>;
}

/**
 * Move-engine secondary rolls use compound keys `pokemonId:effectIndex` or
 * `pokemonId:effectIndex:hitN` for multi-hit sequences. Accept those while still
 * requiring the Pokémon prefix to reference a party member.
 */
function validateSecondaryRollsMap(state: BattleState, values: unknown, label: string) {
  if (values === undefined) return;
  if (!values || typeof values !== 'object' || Array.isArray(values)) invalid(`${label} must be an object`);
  const partyIds = partyIdsOf(state);
  for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
    let pokemonId: string | undefined;
    for (const id of partyIds) {
      if (!key.startsWith(id)) continue;
      const suffix = key.slice(id.length);
      if (!/^:\d+(?::hit\d+)?$/.test(suffix)) continue;
      if (!pokemonId || id.length > pokemonId.length) pokemonId = id;
    }
    if (!pokemonId) invalid(`${label} references unknown Pokémon ${key}`);
    requireFinite(value, `${label}.${key}`);
  }
}

function validateNumberMap(state: BattleState, values: unknown, label: string, minimum?: number): Record<string, unknown> | undefined {
  const map = validatePartyMap(state, values, label);
  for (const [id, value] of Object.entries(map || {})) {
    requireFinite(value, `${label}.${id}`);
    if (minimum !== undefined && value < minimum) invalid(`${label}.${id} is below the allowed minimum`);
  }
  return map;
}

function validateNullableNumberMap(state: BattleState, values: unknown, label: string, minimum?: number): Record<string, unknown> | undefined {
  const map = validatePartyMap(state, values, label);
  for (const [id, value] of Object.entries(map || {})) {
    if (value === null) continue;
    requireFinite(value, `${label}.${id}`);
    if (minimum !== undefined && value < minimum) invalid(`${label}.${id} is below the allowed minimum`);
  }
  return map;
}

function validateNullableStringMap(state: BattleState, values: unknown, label: string) {
  const map = validatePartyMap(state, values, label);
  for (const [id, value] of Object.entries(map || {})) {
    if (value !== null && (typeof value !== 'string' || !value)) invalid(`${label}.${id} must be a string or null`);
  }
}

function validateBooleanMap(state: BattleState, values: unknown, label: string) {
  const map = validatePartyMap(state, values, label);
  for (const [id, value] of Object.entries(map || {})) {
    if (typeof value !== 'boolean') invalid(`${label}.${id} must be boolean`);
  }
}

function validateNullableBooleanMap(state: BattleState, values: unknown, label: string) {
  const map = validatePartyMap(state, values, label);
  for (const [id, value] of Object.entries(map || {})) {
    if (value !== null && typeof value !== 'boolean') invalid(`${label}.${id} must be boolean or null`);
  }
}

function validateResolutionBoostMap(state: BattleState, values: unknown, label: string) {
  const map = validatePartyMap(state, values, label);
  for (const [id, boosts] of Object.entries(map || {})) {
    if (!boosts || typeof boosts !== 'object' || Array.isArray(boosts)) invalid(`${label}.${id} must be an object`);
    for (const [stat, value] of Object.entries(boosts)) {
      if (!STAT_NAMES.has(stat)) invalid(`${label}.${id}.${stat} is not a supported stat`);
      requireInteger(value, `${label}.${id}.${stat}`, -6, 6);
    }
  }
}

function validateResolutionVolatileMap(state: BattleState, values: unknown, label: string) {
  const map = validatePartyMap(state, values, label);
  const partyIds = new Set([
    ...state.sides.ai.party.map(pokemon => pokemon.id),
    ...state.sides.player.party.map(pokemon => pokemon.id),
  ]);
  for (const [id, effects] of Object.entries(map || {})) {
    if (!effects || typeof effects !== 'object' || Array.isArray(effects)) {
      invalid(`${label}.${id} must be an object`);
    }
    for (const [name, effect] of Object.entries(effects as Record<string, unknown>)) {
      if (!VOLATILE_NAMES.has(name)) invalid(`${label}.${id}.${name} is not a modeled volatile`);
      if (effect !== null && (!effect || typeof effect !== 'object' || Array.isArray(effect))) {
        invalid(`${label}.${id}.${name} must be an object or null`);
      }
      if (effect !== null) {
        const volatileState = effect as VolatileState;
        validateVolatile(name, volatileState);
        if (volatileState.sourceId !== undefined && !partyIds.has(volatileState.sourceId)) {
          invalid(`${label}.${id}.${name}.sourceId must reference a party PokÃ©mon`);
        }
        if (name === 'lockOn' && volatileState.targetId !== undefined && !partyIds.has(volatileState.targetId)) {
          invalid(`${label}.${id}.${name}.targetId must reference a party PokÃ©mon`);
        }
        if (name === 'charge' && volatileState.targetIds !== undefined &&
          volatileState.targetIds.some(targetId => !partyIds.has(targetId))) {
          invalid(`${label}.${id}.${name}.targetIds must reference party PokÃ©mon`);
        }
      }
    }
  }
}

function validateResolutionSideEffects(values: unknown, label: string) {
  if (values === undefined) return;
  if (!values || typeof values !== 'object' || Array.isArray(values)) invalid(`${label} must be an object`);
  for (const [sideId, effects] of Object.entries(values as Record<string, unknown>)) {
    if (sideId !== 'ai' && sideId !== 'player') invalid(`${label} has invalid side ${sideId}`);
    if (!effects || typeof effects !== 'object' || Array.isArray(effects)) invalid(`${label}.${sideId} must be an object`);
    validateSideEffects(effects as SideEffects, `${label}.${sideId}` as SideId);
  }
}

function validateResolutionSideBooleanMap(values: unknown, label: string) {
  if (values === undefined) return;
  if (!values || typeof values !== 'object' || Array.isArray(values)) invalid(`${label} must be an object`);
  for (const [sideId, value] of Object.entries(values as Record<string, unknown>)) {
    if (sideId !== 'ai' && sideId !== 'player') invalid(`${label} has invalid side ${sideId}`);
    if (typeof value !== 'boolean') invalid(`${label}.${sideId} must be boolean`);
  }
}

function validateNullableDurationMap(
  values: unknown,
  label: string,
  allowedNames: ReadonlySet<string>,
) {
  if (values === undefined) return;
  if (!values || typeof values !== 'object' || Array.isArray(values)) invalid(`${label} must be an object`);
  for (const [name, value] of Object.entries(values as Record<string, unknown>)) {
    if (!allowedNames.has(name)) invalid(`${label}.${name} is not a modeled duration`);
    if (value !== null) requireInteger(value, `${label}.${name}`, 0);
  }
}

function validateResolutionTrace(state: BattleState, value: unknown, label: string) {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object`);
  const trace = value as Record<string, unknown>;
  const allowed = new Set([
    'source', 'hit', 'actionFailure', 'accuracyBase', 'accuracyRoll', 'accuracyThreshold', 'accuracyMultiplier',
    'accuracyModifiers', 'accuracyRollsByTarget', 'accuracyThresholdsByTarget', 'damageRollsByTarget',
    'hitDamageRollsByTarget', 'secondaryRolls', 'notes',
  ]);
  for (const key of Object.keys(trace)) if (!allowed.has(key)) invalid(`${label} has an unsupported property ${key}`);
  if (!['battle-engine', 'calculator', 'test'].includes(trace.source as string)) invalid(`${label}.source is invalid`);
  if (trace.hit !== undefined && typeof trace.hit !== 'boolean') invalid(`${label}.hit must be boolean`);
  if (trace.actionFailure !== undefined &&
    (typeof trace.actionFailure !== 'string' || !ACTION_FAILURE_NAMES.has(trace.actionFailure))) {
    invalid(`${label}.actionFailure is invalid`);
  }
  if (trace.accuracyBase !== undefined && trace.accuracyBase !== true) {
    requireFinite(trace.accuracyBase, `${label}.accuracyBase`);
    if (trace.accuracyBase < 0 || trace.accuracyBase > 100) invalid(`${label}.accuracyBase must be from 0 to 100`);
  }
  for (const field of ['accuracyRoll', 'accuracyThreshold', 'accuracyMultiplier'] as const) {
    if (trace[field] !== undefined) requireFinite(trace[field], `${label}.${field}`);
  }
  for (const field of ['accuracyModifiers', 'notes'] as const) {
    if (trace[field] !== undefined && (!Array.isArray(trace[field]) ||
      (trace[field] as unknown[]).some(value => typeof value !== 'string'))) {
      invalid(`${label}.${field} must contain strings`);
    }
  }
  for (const field of ['accuracyRollsByTarget', 'accuracyThresholdsByTarget', 'damageRollsByTarget'] as const) {
    const map = validatePartyMap(state, trace[field], `${label}.${field}`);
    for (const [id, number] of Object.entries(map || {})) requireFinite(number, `${label}.${field}.${id}`);
  }
  validateSecondaryRollsMap(state, trace.secondaryRolls, `${label}.secondaryRolls`);
  const hitRolls = validatePartyMap(state, trace.hitDamageRollsByTarget, `${label}.hitDamageRollsByTarget`);
  for (const [id, rolls] of Object.entries(hitRolls || {})) {
    if (!Array.isArray(rolls) || rolls.length === 0 ||
      rolls.some(roll => typeof roll !== 'number' || !Number.isFinite(roll) || roll < 0)) {
      invalid(`${label}.hitDamageRollsByTarget.${id} must contain finite non-negative numbers`);
    }
  }
}

function validateResolutionDelayedMoves(
  state: BattleState,
  action: MoveAction,
  values: unknown,
  label: string,
) {
  if (values === undefined) return;
  if (!Array.isArray(values)) invalid(`${label} must be an array`);
  const partyIds = new Set([
    ...state.sides.ai.party.map(pokemon => pokemon.id),
    ...state.sides.player.party.map(pokemon => pokemon.id),
  ]);
  const ids = new Set((state.delayedMoves || []).map(delayed => delayed.id));
  for (const [index, value] of values.entries()) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label}.${index} must be an object`);
    const delayed = value as Partial<DelayedMoveState>;
    if (typeof delayed.id !== 'string' || !delayed.id || ids.has(delayed.id)) invalid(`${label}.${index}.id is invalid or repeated`);
    ids.add(delayed.id);
    if (delayed.sourceId !== action.actorId || !partyIds.has(delayed.sourceId)) invalid(`${label}.${index}.sourceId must be the acting PokÃ©mon`);
    if (typeof delayed.moveName !== 'string' || !delayed.moveName) invalid(`${label}.${index}.moveName is required`);
    requireInteger(delayed.turns, `${label}.${index}.turns`, 1);
    const allowedTargets = new Set(action.targetIds);
    if (state.generation < 8 && getMoveMetadata(action.moveName, state.generation).snatchable) {
      partyIds.forEach(partyId => allowedTargets.add(partyId));
    }
    if (!Array.isArray(delayed.targetIds) || delayed.targetIds.length === 0 ||
      new Set(delayed.targetIds).size !== delayed.targetIds.length ||
      delayed.targetIds.some(targetId => typeof targetId !== 'string' || !allowedTargets.has(targetId))) {
      invalid(`${label}.${index}.targetIds must contain unique allowed PokÃ©mon IDs`);
    }
    for (const [targetId, slot] of Object.entries(delayed.targetSlotsByTarget || {})) {
      if (!delayed.targetIds.includes(targetId) || !Number.isInteger(slot) || slot < 0 ||
        slot >= (state.mode === 'Singles' ? 1 : 2)) invalid(`${label}.${index}.targetSlotsByTarget is invalid`);
    }
    for (const [targetId, damage] of Object.entries(delayed.damageByTarget || {})) {
      if (!delayed.targetIds.includes(targetId)) invalid(`${label}.${index}.damageByTarget has an unknown target`);
      requireFinite(damage, `${label}.${index}.damageByTarget.${targetId}`);
      if (damage < 0) invalid(`${label}.${index}.damageByTarget.${targetId} must be non-negative`);
    }
    for (const [targetId, fraction] of Object.entries(delayed.healingByTarget || {})) {
      if (!delayed.targetIds.includes(targetId) || !fraction ||
        !Number.isInteger(fraction.numerator) || fraction.numerator <= 0 ||
        !Number.isInteger(fraction.denominator) || fraction.denominator <= 0) {
        invalid(`${label}.${index}.healingByTarget is invalid`);
      }
    }
  }
}

/** Validate the serializable shape of a caller-supplied move resolution. */
export function validateMoveResolution(
  state: BattleState,
  action: MoveAction,
  resolution: unknown,
): asserts resolution is MoveResolution {
  if (!resolution || typeof resolution !== 'object' || Array.isArray(resolution)) invalid('resolution must be an object');
  const candidate = resolution as Record<string, unknown>;
  const allowed = new Set([
    'hit', 'actionFailure', 'criticalHitTargets', 'damageByTarget', 'hitDamageByTarget', 'hpDeltaByPokemon', 'itemByPokemon', 'allySwitchByPokemon', 'itemCorrodedByPokemon', 'consumedItemByPokemon',
    'substituteHpByPokemon', 'statusByPokemon', 'statusTurnsByPokemon', 'disguiseBrokenByPokemon',
    'isSaltCureByPokemon', 'toxicCounterByPokemon', 'boostsByPokemon', 'resetBoostsByPokemon',
    'setBoostsByPokemon', 'volatileByPokemon', 'typeOverrideByPokemon', 'abilityOverrideByPokemon', 'noAbilityByPokemon',
    'abilitySuppressedByPokemon', 'speciesOverrideByPokemon', 'baseStatsOverrideByPokemon',
    'typeChangeUsedByPokemon',
    'statOverridesByPokemon', 'movesByPokemon', 'copyMoveByPokemon', 'calledMoveByPokemon',
    'calledMoveModifiersByPokemon', 'calledMoveTargetIdsByPokemon', 'calledMoveExternalByPokemon', 'forcedSwitchByPokemon',
    'batonPassByPokemon', 'substitutePassByPokemon', 'sideEffectsBySide', 'sideEffectDurationsBySide',
    'field', 'fieldDurations', 'pendingFullHealBySide', 'pendingPledgeBySide', 'delayedMoves', 'trace',
  ]);
  for (const key of Object.keys(candidate)) if (!allowed.has(key)) invalid(`resolution has an unsupported property ${key}`);
  if (candidate.hit !== undefined && typeof candidate.hit !== 'boolean') invalid('resolution.hit must be boolean');
  if (candidate.actionFailure !== undefined &&
    (typeof candidate.actionFailure !== 'string' || !ACTION_FAILURE_NAMES.has(candidate.actionFailure))) {
    invalid('resolution.actionFailure is invalid');
  }
  const damageByTarget = validateNumberMap(state, candidate.damageByTarget, 'resolution.damageByTarget', 0);
  for (const id of Object.keys(damageByTarget || {})) {
    if (!action.targetIds.includes(id)) invalid(`resolution.damageByTarget.${id} is not a target of the action`);
  }
  const hitDamageByTarget = validatePartyMap(state, candidate.hitDamageByTarget, 'resolution.hitDamageByTarget');
  for (const [id, value] of Object.entries(hitDamageByTarget || {})) {
    if (!action.targetIds.includes(id)) invalid(`resolution.hitDamageByTarget.${id} is not a target of the action`);
    if (!Array.isArray(value) || value.length === 0 || value.some(hit => typeof hit !== 'number' || !Number.isFinite(hit) || hit < 0)) {
      invalid(`resolution.hitDamageByTarget.${id} must contain finite non-negative hit values`);
    }
    const aggregate = (value as number[]).reduce((total, hit) => total + hit, 0);
    if (damageByTarget?.[id] !== undefined && damageByTarget[id] !== aggregate) {
      invalid(`resolution.hitDamageByTarget.${id} must sum to damageByTarget.${id}`);
    }
  }
  validateNumberMap(state, candidate.hpDeltaByPokemon, 'resolution.hpDeltaByPokemon');
  validateNullableStringMap(state, candidate.itemByPokemon, 'resolution.itemByPokemon');
  validateBooleanMap(state, candidate.allySwitchByPokemon, 'resolution.allySwitchByPokemon');
  validateNullableBooleanMap(state, candidate.itemCorrodedByPokemon, 'resolution.itemCorrodedByPokemon');
  validateNullableStringMap(state, candidate.consumedItemByPokemon, 'resolution.consumedItemByPokemon');
  validateNumberMap(state, candidate.substituteHpByPokemon, 'resolution.substituteHpByPokemon', 0);
  const statusMap = validatePartyMap(state, candidate.statusByPokemon, 'resolution.statusByPokemon');
  for (const [id, status] of Object.entries(statusMap || {})) {
    if (typeof status !== 'string' || !STATUS_NAMES.has(status)) invalid(`resolution.statusByPokemon.${id} is invalid`);
  }
  validateNumberMap(state, candidate.statusTurnsByPokemon, 'resolution.statusTurnsByPokemon', 0);
  validateBooleanMap(state, candidate.disguiseBrokenByPokemon, 'resolution.disguiseBrokenByPokemon');
  validateBooleanMap(state, candidate.isSaltCureByPokemon, 'resolution.isSaltCureByPokemon');
  validateNumberMap(state, candidate.toxicCounterByPokemon, 'resolution.toxicCounterByPokemon', 0);
  validateResolutionBoostMap(state, candidate.boostsByPokemon, 'resolution.boostsByPokemon');
  validateBooleanMap(state, candidate.resetBoostsByPokemon, 'resolution.resetBoostsByPokemon');
  validateResolutionBoostMap(state, candidate.setBoostsByPokemon, 'resolution.setBoostsByPokemon');
  validateResolutionVolatileMap(state, candidate.volatileByPokemon, 'resolution.volatileByPokemon');
  const types = validatePartyMap(state, candidate.typeOverrideByPokemon, 'resolution.typeOverrideByPokemon');
  for (const [id, value] of Object.entries(types || {})) {
    if (value !== null && (!Array.isArray(value) || value.length > 3 ||
      value.some(type => typeof type !== 'string' || !type))) invalid(`resolution.typeOverrideByPokemon.${id} is invalid`);
    if (value !== null && new Set(value.map(type => type.toLowerCase())).size !== value.length) {
      invalid(`resolution.typeOverrideByPokemon.${id} cannot contain duplicate types`);
    }
  }
  validateNullableBooleanMap(state, candidate.typeChangeUsedByPokemon, 'resolution.typeChangeUsedByPokemon');
  validateNullableStringMap(state, candidate.abilityOverrideByPokemon, 'resolution.abilityOverrideByPokemon');
  validateBooleanMap(state, candidate.noAbilityByPokemon, 'resolution.noAbilityByPokemon');
  validateBooleanMap(state, candidate.abilitySuppressedByPokemon, 'resolution.abilitySuppressedByPokemon');
  validateNullableStringMap(state, candidate.speciesOverrideByPokemon, 'resolution.speciesOverrideByPokemon');
  const baseStats = validatePartyMap(state, candidate.baseStatsOverrideByPokemon, 'resolution.baseStatsOverrideByPokemon');
  for (const [id, value] of Object.entries(baseStats || {})) if (value !== null) validateStatMap(value, `resolution.baseStatsOverrideByPokemon.${id}`, 255);
  const rawStats = validatePartyMap(state, candidate.statOverridesByPokemon, 'resolution.statOverridesByPokemon');
  for (const [id, value] of Object.entries(rawStats || {})) if (value !== null) validateStatMap(value, `resolution.statOverridesByPokemon.${id}`, 10000);
  const moves = validatePartyMap(state, candidate.movesByPokemon, 'resolution.movesByPokemon');
  for (const [id, value] of Object.entries(moves || {})) if (value !== null) validateMoveArray(id, value, 'resolution moves');
  validateNullableStringMap(state, candidate.copyMoveByPokemon, 'resolution.copyMoveByPokemon');
  validateNullableStringMap(state, candidate.calledMoveByPokemon, 'resolution.calledMoveByPokemon');
  const calledModifiers = validatePartyMap(state, candidate.calledMoveModifiersByPokemon, 'resolution.calledMoveModifiersByPokemon');
  for (const [id, value] of Object.entries(calledModifiers || {})) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`resolution.calledMoveModifiersByPokemon.${id} is invalid`);
    const modifiers = value as Record<string, unknown>;
    for (const key of Object.keys(modifiers)) if (!['powerMultiplier', 'bypassAccuracy'].includes(key)) invalid(`resolution.calledMoveModifiersByPokemon.${id} has an unsupported property ${key}`);
    if (modifiers.powerMultiplier !== undefined) {
      requireFinite(modifiers.powerMultiplier, `resolution.calledMoveModifiersByPokemon.${id}.powerMultiplier`);
      if (modifiers.powerMultiplier <= 0) invalid(`resolution.calledMoveModifiersByPokemon.${id}.powerMultiplier must be positive`);
    }
    if (modifiers.bypassAccuracy !== undefined) requireBoolean(modifiers.bypassAccuracy, `resolution.calledMoveModifiersByPokemon.${id}.bypassAccuracy`);
  }
  const calledTargets = validatePartyMap(state, candidate.calledMoveTargetIdsByPokemon, 'resolution.calledMoveTargetIdsByPokemon');
  validateBooleanMap(state, candidate.calledMoveExternalByPokemon, 'resolution.calledMoveExternalByPokemon');
  for (const [id, value] of Object.entries(calledTargets || {})) {
    if (!Array.isArray(value) || value.some(targetId => typeof targetId !== 'string' || !targetId)) {
      invalid(`resolution.calledMoveTargetIdsByPokemon.${id} is invalid`);
    }
    const targetIds = value as string[];
    if (new Set(targetIds).size !== targetIds.length) {
      invalid(`resolution.calledMoveTargetIdsByPokemon.${id} cannot contain duplicate targets`);
    }
    const partyIds = new Set([
      ...state.sides.ai.party.map(pokemon => pokemon.id),
      ...state.sides.player.party.map(pokemon => pokemon.id),
    ]);
    if (targetIds.some(targetId => !partyIds.has(targetId))) {
      invalid(`resolution.calledMoveTargetIdsByPokemon.${id} must reference party Pokemon`);
    }
  }
  validateBooleanMap(state, candidate.forcedSwitchByPokemon, 'resolution.forcedSwitchByPokemon');
  validateBooleanMap(state, candidate.batonPassByPokemon, 'resolution.batonPassByPokemon');
  validateBooleanMap(state, candidate.substitutePassByPokemon, 'resolution.substitutePassByPokemon');
  validateResolutionSideEffects(candidate.sideEffectsBySide, 'resolution.sideEffectsBySide');
  if (candidate.sideEffectDurationsBySide !== undefined) {
    if (!candidate.sideEffectDurationsBySide || typeof candidate.sideEffectDurationsBySide !== 'object' ||
      Array.isArray(candidate.sideEffectDurationsBySide)) invalid('resolution.sideEffectDurationsBySide must be an object');
    for (const [sideId, durations] of Object.entries(candidate.sideEffectDurationsBySide as Record<string, unknown>)) {
      if (sideId !== 'ai' && sideId !== 'player') invalid(`resolution.sideEffectDurationsBySide has invalid side ${sideId}`);
      validateNullableDurationMap(durations, `resolution.sideEffectDurationsBySide.${sideId}`, SIDE_DURATION_NAMES);
    }
  }
  validateResolutionSideBooleanMap(candidate.pendingFullHealBySide, 'resolution.pendingFullHealBySide');
  if (candidate.field !== undefined) {
    if (!candidate.field || typeof candidate.field !== 'object' || Array.isArray(candidate.field)) {
      invalid('resolution.field must be an object');
    }
    validateField(candidate.field as BattleState['field'], 'resolution.field');
  }
  validateNullableDurationMap(candidate.fieldDurations, 'resolution.fieldDurations', FIELD_DURATION_NAMES);
  if (candidate.pendingPledgeBySide !== undefined) {
    if (!candidate.pendingPledgeBySide || typeof candidate.pendingPledgeBySide !== 'object' ||
      Array.isArray(candidate.pendingPledgeBySide)) invalid('resolution.pendingPledgeBySide must be an object');
    const partyIds = new Set([
      ...state.sides.ai.party.map(pokemon => pokemon.id),
      ...state.sides.player.party.map(pokemon => pokemon.id),
    ]);
    for (const [sideId, pending] of Object.entries(candidate.pendingPledgeBySide as Record<string, unknown>)) {
      if (sideId !== 'ai' && sideId !== 'player') invalid(`resolution.pendingPledgeBySide has invalid side ${sideId}`);
      if (pending !== null) validatePendingPledge(pending, `resolution.pendingPledgeBySide.${sideId}`, partyIds);
    }
  }
  validateResolutionDelayedMoves(state, action, candidate.delayedMoves, 'resolution.delayedMoves');
  validateResolutionTrace(state, candidate.trace, 'resolution.trace');
}

/** Validate the serializable shape of a caller-supplied end-turn outcome. */
export function validateEndTurnResolution(
  state: BattleState,
  resolution: unknown,
): asserts resolution is EndTurnResolution {
  if (!resolution || typeof resolution !== 'object' || Array.isArray(resolution)) invalid('end-turn resolution must be an object');
  const candidate = resolution as Record<string, unknown>;
  const allowed = new Set([
    'hpDeltaByPokemon', 'forcedSwitchByPokemon', 'itemByPokemon', 'consumedItemByPokemon',
    'speciesOverrideByPokemon', 'boostsByPokemon', 'movesByPokemon', 'substituteHpByPokemon',
    'statusByPokemon', 'statusTurnsByPokemon', 'disguiseBrokenByPokemon', 'toxicCounterByPokemon',
    'volatileByPokemon', 'removeDelayedMoveIds', 'trace',
  ]);
  for (const key of Object.keys(candidate)) if (!allowed.has(key)) invalid(`end-turn resolution has an unsupported property ${key}`);
  validateNumberMap(state, candidate.hpDeltaByPokemon, 'end-turn resolution.hpDeltaByPokemon');
  validateBooleanMap(state, candidate.forcedSwitchByPokemon, 'end-turn resolution.forcedSwitchByPokemon');
  validateNullableStringMap(state, candidate.itemByPokemon, 'end-turn resolution.itemByPokemon');
  validateNullableStringMap(state, candidate.consumedItemByPokemon, 'end-turn resolution.consumedItemByPokemon');
  validateNullableStringMap(state, candidate.speciesOverrideByPokemon, 'end-turn resolution.speciesOverrideByPokemon');
  validateResolutionBoostMap(state, candidate.boostsByPokemon, 'end-turn resolution.boostsByPokemon');
  const moves = validatePartyMap(state, candidate.movesByPokemon, 'end-turn resolution.movesByPokemon');
  for (const [id, value] of Object.entries(moves || {})) if (value !== null) validateMoveArray(id, value, 'end-turn resolution moves');
  validateNullableNumberMap(state, candidate.substituteHpByPokemon, 'end-turn resolution.substituteHpByPokemon', 0);
  const statusMap = validatePartyMap(state, candidate.statusByPokemon, 'end-turn resolution.statusByPokemon');
  for (const [id, status] of Object.entries(statusMap || {})) {
    if (typeof status !== 'string' || !STATUS_NAMES.has(status)) invalid(`end-turn resolution.statusByPokemon.${id} is invalid`);
  }
  validateNullableNumberMap(state, candidate.statusTurnsByPokemon, 'end-turn resolution.statusTurnsByPokemon', 0);
  validateBooleanMap(state, candidate.disguiseBrokenByPokemon, 'end-turn resolution.disguiseBrokenByPokemon');
  validateNumberMap(state, candidate.toxicCounterByPokemon, 'end-turn resolution.toxicCounterByPokemon', 0);
  validateResolutionVolatileMap(state, candidate.volatileByPokemon, 'end-turn resolution.volatileByPokemon');
  if (candidate.removeDelayedMoveIds !== undefined) {
    if (!Array.isArray(candidate.removeDelayedMoveIds) ||
      new Set(candidate.removeDelayedMoveIds).size !== candidate.removeDelayedMoveIds.length ||
      candidate.removeDelayedMoveIds.some(id => typeof id !== 'string' || !id ||
        !(state.delayedMoves || []).some(delayed => delayed.id === id))) {
      invalid('end-turn resolution.removeDelayedMoveIds must reference unique scheduled delayed moves');
    }
  }
  validateResolutionTrace(state, candidate.trace, 'end-turn resolution.trace');
}

/** Validate the serializable shape of a caller-supplied switch-entry outcome. */
export function validateSwitchEntryResolution(
  state: BattleState,
  action: SwitchAction,
  resolution: unknown,
): asserts resolution is SwitchEntryResolution {
  if (!resolution || typeof resolution !== 'object' || Array.isArray(resolution)) invalid('switch-entry resolution must be an object');
  const candidate = resolution as Record<string, unknown>;
  const allowed = new Set([
    'hpDeltaByPokemon', 'itemByPokemon', 'consumedItemByPokemon', 'abilityOverrideByPokemon', 'noAbilityByPokemon',
    'statusByPokemon', 'toxicCounterByPokemon', 'boostsByPokemon', 'setBoostsByPokemon', 'typeOverrideByPokemon',
    'speciesOverrideByPokemon', 'statOverridesByPokemon', 'movesByPokemon', 'syrupTriggeredByPokemon',
    'intrepidSwordTriggeredByPokemon', 'dauntlessShieldTriggeredByPokemon', 'volatileByPokemon',
    'sideEffectsBySide', 'field', 'fieldDurations', 'clearToxicSpikesBySide', 'trace',
  ]);
  for (const key of Object.keys(candidate)) if (!allowed.has(key)) invalid(`switch-entry resolution has an unsupported property ${key}`);
  validateNumberMap(state, candidate.hpDeltaByPokemon, 'switch-entry resolution.hpDeltaByPokemon');
  validateNullableStringMap(state, candidate.itemByPokemon, 'switch-entry resolution.itemByPokemon');
  validateNullableStringMap(state, candidate.consumedItemByPokemon, 'switch-entry resolution.consumedItemByPokemon');
  validateNullableStringMap(state, candidate.abilityOverrideByPokemon, 'switch-entry resolution.abilityOverrideByPokemon');
  validateBooleanMap(state, candidate.noAbilityByPokemon, 'switch-entry resolution.noAbilityByPokemon');
  const statusMap = validatePartyMap(state, candidate.statusByPokemon, 'switch-entry resolution.statusByPokemon');
  for (const [id, status] of Object.entries(statusMap || {})) {
    if (typeof status !== 'string' || !STATUS_NAMES.has(status)) invalid(`switch-entry resolution.statusByPokemon.${id} is invalid`);
  }
  validateNumberMap(state, candidate.toxicCounterByPokemon, 'switch-entry resolution.toxicCounterByPokemon', 0);
  validateResolutionBoostMap(state, candidate.boostsByPokemon, 'switch-entry resolution.boostsByPokemon');
  validateResolutionBoostMap(state, candidate.setBoostsByPokemon, 'switch-entry resolution.setBoostsByPokemon');
  const types = validatePartyMap(state, candidate.typeOverrideByPokemon, 'switch-entry resolution.typeOverrideByPokemon');
  for (const [id, value] of Object.entries(types || {})) {
    if (value !== null && (!Array.isArray(value) || value.length > 3 ||
      value.some(type => typeof type !== 'string' || !type))) invalid(`switch-entry resolution.typeOverrideByPokemon.${id} is invalid`);
    if (value !== null && new Set(value.map(type => type.toLowerCase())).size !== value.length) {
      invalid(`switch-entry resolution.typeOverrideByPokemon.${id} cannot contain duplicate types`);
    }
  }
  validateNullableStringMap(state, candidate.speciesOverrideByPokemon, 'switch-entry resolution.speciesOverrideByPokemon');
  const stats = validatePartyMap(state, candidate.statOverridesByPokemon, 'switch-entry resolution.statOverridesByPokemon');
  for (const [id, value] of Object.entries(stats || {})) if (value !== null) validateStatMap(value, `switch-entry resolution.statOverridesByPokemon.${id}`, 10000);
  const moves = validatePartyMap(state, candidate.movesByPokemon, 'switch-entry resolution.movesByPokemon');
  for (const [id, value] of Object.entries(moves || {})) if (value !== null) validateMoveArray(id, value, 'switch-entry resolution moves');
  validateBooleanMap(state, candidate.syrupTriggeredByPokemon, 'switch-entry resolution.syrupTriggeredByPokemon');
  validateBooleanMap(state, candidate.intrepidSwordTriggeredByPokemon, 'switch-entry resolution.intrepidSwordTriggeredByPokemon');
  validateBooleanMap(state, candidate.dauntlessShieldTriggeredByPokemon, 'switch-entry resolution.dauntlessShieldTriggeredByPokemon');
  validateResolutionVolatileMap(state, candidate.volatileByPokemon, 'switch-entry resolution.volatileByPokemon');
  validateResolutionSideEffects(candidate.sideEffectsBySide, 'switch-entry resolution.sideEffectsBySide');
  if (candidate.field !== undefined) {
    if (!candidate.field || typeof candidate.field !== 'object' || Array.isArray(candidate.field)) invalid('switch-entry resolution.field must be an object');
    validateField(candidate.field as BattleState['field'], 'switch-entry resolution.field');
  }
  validateNullableDurationMap(candidate.fieldDurations, 'switch-entry resolution.fieldDurations', FIELD_DURATION_NAMES);
  validateResolutionSideBooleanMap(candidate.clearToxicSpikesBySide, 'switch-entry resolution.clearToxicSpikesBySide');
  validateResolutionTrace(state, candidate.trace, 'switch-entry resolution.trace');
  if (!state.sides.ai.party.some(pokemon => pokemon.id === action.replacementId) &&
    !state.sides.player.party.some(pokemon => pokemon.id === action.replacementId)) {
    invalid(`switch-entry resolution action references an unknown replacement ${action.replacementId}`);
  }
}

function validateDamageFact(value: unknown, label: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object`);
  const damage = value as Record<string, unknown>;
  if (!Array.isArray(damage.rolls) || damage.rolls.some(roll => typeof roll !== 'number' || !Number.isFinite(roll) || roll < 0)) {
    invalid(`${label}.rolls must contain finite non-negative numbers`);
  }
  if (damage.hits !== undefined) requireInteger(damage.hits, `${label}.hits`, 2, 100);
  if (damage.hitRolls !== undefined) {
    if (!Array.isArray(damage.hitRolls) || damage.hitRolls.length < 2 || damage.hitRolls.length > 100 ||
      damage.hitRolls.some(rolls => !Array.isArray(rolls) || !rolls.length ||
        rolls.some(roll => typeof roll !== 'number' || !Number.isFinite(roll) || roll < 0))) {
      invalid(`${label}.hitRolls must contain non-empty per-hit finite non-negative roll arrays`);
    }
    if (damage.hits !== undefined && damage.hits !== (damage.hitRolls as unknown[]).length) {
      invalid(`${label}.hits must match hitRolls length`);
    }
  }
  for (const property of ['min', 'max', 'targetHp']) {
    const propertyValue = damage[property];
    requireFinite(propertyValue, `${label}.${property}`);
    if ((propertyValue as number) < 0) invalid(`${label}.${property} must be non-negative`);
  }
  for (const property of ['possibleKO', 'guaranteedKO']) {
    if (typeof damage[property] !== 'boolean') invalid(`${label}.${property} must be boolean`);
  }
}

function validateDamageFacts(state: BattleState, action: MoveAction, values: unknown, label: string) {
  const map = validatePartyMap(state, values, label);
  for (const [id, value] of Object.entries(map || {})) {
    if (!action.targetIds.includes(id)) invalid(`${label}.${id} is not a target of the action`);
    validateDamageFact(value, `${label}.${id}`);
  }
}

/** Validate caller-supplied facts/options used while deriving a move resolution. */
export function validateMoveEngineOptions(
  state: BattleState,
  action: MoveAction,
  options: unknown,
): void {
  if (!options || typeof options !== 'object' || Array.isArray(options)) invalid('move-engine options must be an object');
  const candidate = options as Record<string, unknown>;
  if (candidate.hit !== undefined && typeof candidate.hit !== 'boolean') invalid('move-engine hit must be boolean');
  if (candidate.accuracy !== undefined && candidate.accuracy !== true) {
    requireFinite(candidate.accuracy, 'move-engine accuracy');
    if (candidate.accuracy < 0 || candidate.accuracy > 100) invalid('move-engine accuracy must be from 0 to 100');
  }
  if (candidate.secondaryEffects !== undefined) validateSecondaryEffects(candidate.secondaryEffects, 'move-engine secondaryEffects');
  if (candidate.facts === undefined) return;
  if (!candidate.facts || typeof candidate.facts !== 'object' || Array.isArray(candidate.facts)) invalid('move-engine facts must be an object');
  const facts = candidate.facts as Record<string, unknown>;
  const allowed = new Set<keyof ActionFacts>([
    'damage', 'damageByTarget', 'confusionDamage', 'moveCategory', 'moveType', 'fieldTerrain', 'moveAccuracy', 'isMultiHit',
    'secondaryEffects', 'battleMode', 'priority', 'attackerSpeed', 'attackerCriticalHitStage',
    'criticalHitGuaranteed', 'criticalHit', 'attackerHp', 'attackerHpPercent', 'defenderSpeed', 'opponentSpeeds',
    'attackerAbility', 'attackerPartnerAbility', 'attackerPartnerItem', 'attackerPartnerTypes', 'attackerPartnerMoves',
    'attackerPartnerSpeed', 'attackerPartnerGroundImmune', 'attackerPartnerHasMagnetRise',
    'defenderAbility', 'defenderTypes', 'attackerSpecies', 'defenderSpecies', 'attackerItem', 'defenderItem',
    'attackerStatus', 'defenderStatus', 'defenderIncapacitated', 'defenderConfused', 'defenderInfatuated', 'attackerBoosts', 'defenderBoosts', 'attackerMoves', 'defenderMoves',
    'attackerHasPhysicalMove', 'attackerHasSpecialMove', 'attackerHasFlinchMove', 'defenderHasPhysicalMove', 'defenderHasSpecialMove',
    'defenderHasStatusMove', 'defenderHasSoundMove', 'defenderSeeded', 'attackerSubstitute',
    'attackerHelpingHand', 'defenderSubstitute', 'lastMoveUsed', 'attackerPartyAliveCount',
    'defenderPartyAliveCount', 'defenderHpPercent', 'defenderLastMoveUsed', 'defenderLastMoveIsStatus',
    'isFirstTurnOut', 'opponentCanKO', 'opponentCan2HKO', 'opponentMaxDamage', 'isSuperEffective',
    'isHighCrit', 'isImmune',
  ]);
  for (const key of Object.keys(facts)) if (!allowed.has(key as keyof ActionFacts)) invalid(`move-engine facts has an unsupported property ${key}`);
  validateDamageFacts(state, action, facts.damageByTarget, 'move-engine facts.damageByTarget');
  if (facts.damage !== undefined) validateDamageFacts(state, action, {[action.targetIds[0] || action.actorId]: facts.damage}, 'move-engine facts.damage');
  if (facts.confusionDamage !== undefined) validateDamageFact(facts.confusionDamage, 'move-engine facts.confusionDamage');
  if (facts.moveAccuracy !== undefined && facts.moveAccuracy !== true) {
    requireFinite(facts.moveAccuracy, 'move-engine facts.moveAccuracy');
    if (facts.moveAccuracy < 0 || facts.moveAccuracy > 100) invalid('move-engine facts.moveAccuracy must be from 0 to 100');
  }
  if (facts.secondaryEffects !== undefined) validateSecondaryEffects(facts.secondaryEffects, 'move-engine facts.secondaryEffects');
  if (facts.moveCategory !== undefined && !['Physical', 'Special', 'Status'].includes(facts.moveCategory as string)) invalid('move-engine facts.moveCategory is invalid');
  if (facts.moveType !== undefined && (typeof facts.moveType !== 'string' || !facts.moveType)) invalid('move-engine facts.moveType is invalid');
  if (facts.fieldTerrain !== undefined && !TERRAIN_NAMES.has(facts.fieldTerrain as string)) invalid('move-engine facts.fieldTerrain is invalid');
  if (facts.battleMode !== undefined && facts.battleMode !== 'Singles' && facts.battleMode !== 'Doubles') invalid('move-engine facts.battleMode is invalid');
  const numericFields = [
    'priority', 'attackerSpeed', 'attackerCriticalHitStage', 'attackerHp', 'attackerHpPercent', 'defenderSpeed',
    'attackerPartnerSpeed', 'defenderHpPercent', 'attackerPartyAliveCount', 'defenderPartyAliveCount', 'opponentMaxDamage',
  ];
  for (const field of numericFields) if (facts[field] !== undefined) requireFinite(facts[field], `move-engine facts.${field}`);
  for (const field of ['attackerHpPercent', 'defenderHpPercent']) {
    if (facts[field] !== undefined && ((facts[field] as number) < 0 || (facts[field] as number) > 100)) {
      invalid(`move-engine facts.${field} must be from 0 to 100`);
    }
  }
  for (const field of [
    'criticalHitGuaranteed', 'criticalHit', 'attackerPartnerGroundImmune', 'attackerPartnerHasMagnetRise', 'attackerHasPhysicalMove',
    'attackerHasSpecialMove', 'attackerHasFlinchMove', 'defenderHasPhysicalMove', 'defenderHasSpecialMove', 'defenderHasStatusMove',
    'defenderHasSoundMove', 'defenderSeeded', 'attackerSubstitute', 'attackerHelpingHand', 'defenderSubstitute', 'defenderIncapacitated',
    'defenderLastMoveIsStatus', 'defenderConfused', 'defenderInfatuated', 'isFirstTurnOut', 'opponentCanKO', 'opponentCan2HKO', 'isSuperEffective', 'isHighCrit', 'isImmune',
  ]) if (facts[field] !== undefined && typeof facts[field] !== 'boolean') invalid(`move-engine facts.${field} must be boolean`);
  for (const field of [
    'attackerAbility', 'attackerPartnerAbility', 'attackerPartnerItem', 'defenderAbility', 'attackerSpecies',
    'defenderSpecies', 'attackerItem', 'defenderItem', 'lastMoveUsed', 'defenderLastMoveUsed',
  ]) if (facts[field] !== undefined && (typeof facts[field] !== 'string' || !facts[field])) invalid(`move-engine facts.${field} must be a non-empty string`);
  for (const field of ['attackerStatus', 'defenderStatus']) {
    if (facts[field] !== undefined && (typeof facts[field] !== 'string' || !STATUS_NAMES.has(facts[field] as string))) invalid(`move-engine facts.${field} is invalid`);
  }
  for (const field of ['attackerBoosts', 'defenderBoosts']) {
    if (facts[field] !== undefined) validateResolutionBoostMap(state, {[action.actorId]: facts[field]}, `move-engine facts.${field}`);
  }
  for (const field of ['opponentSpeeds']) {
    const speeds = facts[field];
    if (speeds !== undefined && (!Array.isArray(speeds) || speeds.some((speed: unknown) => typeof speed !== 'number' || !Number.isFinite(speed)))) {
      invalid(`move-engine facts.${field} must contain finite numbers`);
    }
  }
  for (const field of ['attackerPartnerTypes', 'attackerPartnerMoves', 'attackerMoves', 'defenderTypes', 'defenderMoves']) {
    const values = facts[field];
    if (values !== undefined && (!Array.isArray(values) || values.some((value: unknown) => typeof value !== 'string' || !value))) {
      invalid(`move-engine facts.${field} must contain non-empty strings`);
    }
  }
}

function requireFinite(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(`${label} must be finite`);
}

function requireInteger(value: unknown, label: string, minimum?: number, maximum?: number) {
  requireFinite(value, label);
  if (!Number.isInteger(value) || (minimum !== undefined && value < minimum) ||
    (maximum !== undefined && value > maximum)) {
    invalid(`${label} must be an integer in the allowed range`);
  }
}

function validateVolatile(name: string, effect: VolatileState) {
  if (!VOLATILE_NAMES.has(name)) invalid(`unknown volatile effect ${name}`);
  for (const key of Object.keys(effect)) {
    if (!['turns', 'stacks', 'damage', 'item', 'moveName', 'targetIds', 'targetId', 'moveNames', 'sourceId'].includes(key)) {
      invalid(`volatile ${name} has an unsupported property ${key}`);
    }
  }
  if (effect.turns !== undefined) requireInteger(effect.turns, `volatile ${name} turns`, 0);
  if (effect.item !== undefined && (typeof effect.item !== 'string' || !effect.item)) {
    invalid(`volatile ${name} item must be a non-empty item name`);
  }
  if (effect.item !== undefined && name !== 'cudChew') {
    invalid(`volatile ${name} cannot contain item`);
  }
  if (name === 'cudChew') {
    if (!effect.item) invalid('volatile cudChew requires a stored Berry item');
    if (effect.turns === undefined) invalid('volatile cudChew requires turns');
    if (effect.item && !effect.item.toLowerCase().replace(/[^a-z0-9]/g, '').endsWith('berry')) {
      invalid('volatile cudChew item must be a Berry');
    }
  }
  if (name === 'stockpile') {
    if (effect.stacks === undefined) invalid('volatile stockpile stacks are required');
    requireInteger(effect.stacks, `volatile ${name} stacks`, 1, 3);
  } else if (!['rollout', 'furyCutter'].includes(name) && effect.stacks !== undefined) {
    invalid(`volatile ${name} cannot contain stacks`);
  }
  if (['rollout', 'furyCutter'].includes(name) && effect.stacks !== undefined) {
    requireInteger(effect.stacks, `volatile ${name} stacks`, 1, 4);
    if (effect.moveName === undefined) invalid(`volatile ${name} moveName is required`);
  }
  if (effect.damage !== undefined) {
    if (name !== 'bide') invalid(`volatile ${name} cannot contain damage`);
    requireFinite(effect.damage, `volatile ${name} damage`);
    if (effect.damage < 0) invalid(`volatile ${name} damage must be non-negative`);
  }
  if (effect.moveName !== undefined && typeof effect.moveName !== 'string') {
    invalid(`volatile ${name} moveName must be a string`);
  }
  if (name === 'recharge' && !effect.moveName) invalid('volatile recharge moveName is required');
  if (name === 'charge' && !effect.moveName) invalid('volatile charge moveName is required');
  if (name === 'uproar' && !effect.moveName) invalid('volatile uproar moveName is required');
  if (name === 'lockOn' && !effect.targetId) invalid('volatile lockOn targetId is required');
  if (effect.targetId !== undefined && (name !== 'lockOn' || typeof effect.targetId !== 'string' || !effect.targetId)) {
    invalid(`volatile ${name} targetId must be a non-empty string and only apply to lockOn`);
  }
  if (name === 'partiallyTrapped') {
    if (!effect.moveName) invalid('volatile partiallyTrapped moveName is required');
    if (!effect.sourceId) invalid('volatile partiallyTrapped sourceId is required');
    if (effect.turns === undefined) invalid('volatile partiallyTrapped turns are required');
  }
  if (name === 'octolock' && !effect.sourceId) invalid('volatile octolock sourceId is required');
  if (effect.targetIds !== undefined && (name !== 'charge' || !Array.isArray(effect.targetIds) ||
    effect.targetIds.some(targetId => typeof targetId !== 'string' || !targetId))) {
    invalid(`volatile ${name} targetIds must contain non-empty strings and only apply to charge`);
  }
  if (effect.moveNames !== undefined && (!Array.isArray(effect.moveNames) ||
    effect.moveNames.some(moveName => typeof moveName !== 'string' || !moveName))) {
    invalid(`volatile ${name} moveNames must contain non-empty strings`);
  }
  if (effect.sourceId !== undefined && typeof effect.sourceId !== 'string') {
    invalid(`volatile ${name} sourceId must be a string`);
  }
}

function validateSideEffects(effects: SideEffects | undefined, sideId: SideId) {
  if (!effects) return;
  for (const name of Object.keys(effects)) {
    if (!SIDE_EFFECT_NAMES.has(name)) invalid(`${sideId}.${name} is not a modeled side effect`);
  }
  for (const [name, limit] of HAZARD_LIMITS) {
    const value = effects[name];
    if (value !== undefined) requireInteger(value, `${sideId}.${name}`, 0, limit);
  }
  for (const name of ['stealthRock', 'steelsurge', 'vinelash', 'wildfire', 'cannonade',
    'volcalith', 'reflect', 'lightScreen', 'auroraVeil', 'safeguard', 'mist', 'luckyChant', 'craftyShield', 'tailwind',
    'stickyWeb', 'helpingHand', 'friendGuard', 'battery', 'powerSpot', 'seeded', 'foresight', 'pledgeRainbow', 'pledgeSwamp', 'pledgeSeaOfFire',
    'protected', 'wideGuard', 'quickGuard', 'matBlock'] as Array<keyof SideEffects>) {
    if (effects[name] !== undefined && typeof effects[name] !== 'boolean') {
      invalid(`${sideId}.${name} must be boolean`);
    }
  }
}

function validateStatMap(values: unknown, label: string, maximum: number) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) invalid(`${label} must be an object`);
  for (const [stat, value] of Object.entries(values)) {
    if (!['hp', 'atk', 'def', 'spa', 'spd', 'spe'].includes(stat)) invalid(`${label}.${stat} is not a supported stat`);
    requireInteger(value, `${label}.${stat}`, 0, maximum);
  }
}

function validateSecondaryEffects(effects: unknown, label: string) {
  if (!Array.isArray(effects)) invalid(`${label} must be an array`);
  for (const effectValue of effects) {
    if (!effectValue || typeof effectValue !== 'object' || Array.isArray(effectValue)) {
      invalid(`${label} must contain effect objects`);
    }
    const effect = effectValue as Record<string, unknown>;
    const allowed = new Set(['chance', 'target', 'status', 'statusChoices', 'boosts', 'volatile']);
    for (const key of Object.keys(effect)) if (!allowed.has(key)) invalid(`${label} has an unsupported property ${key}`);
    requireFinite(effect.chance, `${label} chance`);
    if (effect.chance < 0 || effect.chance > 100) invalid(`${label} chance must be from 0 to 100`);
    if (effect.target !== undefined && effect.target !== 'self' && effect.target !== 'target') {
      invalid(`${label} target must be self or target`);
    }
    if (effect.status !== undefined && (typeof effect.status !== 'string' || !STATUS_NAMES.has(effect.status))) {
      invalid(`${label} has an invalid status`);
    }
    if (effect.statusChoices !== undefined) {
      if (!Array.isArray(effect.statusChoices) || effect.statusChoices.length === 0) {
        invalid(`${label} statusChoices must be a non-empty array`);
      }
      for (const status of effect.statusChoices as unknown[]) {
        if (typeof status !== 'string' || !STATUS_NAMES.has(status)) invalid(`${label} has an invalid status choice`);
      }
    }
    if (effect.boosts !== undefined) {
      if (!effect.boosts || typeof effect.boosts !== 'object' || Array.isArray(effect.boosts)) {
        invalid(`${label} boosts must be an object`);
      }
      for (const [stat, value] of Object.entries(effect.boosts)) {
        if (!STAT_NAMES.has(stat)) invalid(`${label} has an unsupported boost ${stat}`);
        requireInteger(value, `${label} ${stat} boost`, -6, 6);
      }
    }
    if (effect.volatile !== undefined) {
      if (!effect.volatile || typeof effect.volatile !== 'object' || Array.isArray(effect.volatile)) {
        invalid(`${label} volatile must be an object`);
      }
      const volatile = effect.volatile as Record<string, unknown>;
      requireString(volatile.name, `${label} volatile name`);
      const {name, ...volatileState} = volatile;
      validateVolatile(name, volatileState);
    }
  }
}

function validateMoveArray(pokemonId: string, moves: unknown, label: string) {
  if (!Array.isArray(moves)) invalid(`${pokemonId} ${label} must be an array`);
  const moveNames = new Set<string>();
  for (const moveValue of moves) {
    if (!moveValue || typeof moveValue !== 'object' || Array.isArray(moveValue)) {
      invalid(`${pokemonId} ${label} has an invalid move`);
    }
    const move = moveValue as Record<string, unknown>;
    const allowed = new Set([
      'name', 'basePower', 'type', 'category', 'priority', 'accuracy', 'secondaryEffects', 'target',
      'contact', 'heal', 'punch', 'bite', 'pulse', 'slicing', 'bullet', 'snatchable', 'sound', 'wind', 'dance', 'reflectable', 'pp', 'maxPP', 'disabled',
      'useZ', 'useMax', 'hits', 'timesUsed', 'timesUsedWithMetronome',
    ]);
    for (const key of Object.keys(move)) if (!allowed.has(key)) invalid(`${pokemonId} ${label} has an unsupported property ${key}`);
    if (typeof move.name !== 'string' || !move.name) {
      invalid(`${pokemonId} ${label} has a move without a name`);
    }
    if (moveNames.has(move.name)) invalid(`${pokemonId} ${label} repeats move ${move.name}`);
    moveNames.add(move.name);
    if (move.basePower !== undefined) requireInteger(move.basePower, `${pokemonId} ${move.name} base power`, 0);
    if (move.type !== undefined && (typeof move.type !== 'string' || !move.type)) {
      invalid(`${pokemonId} ${move.name} type must be a non-empty string`);
    }
    if (move.category !== undefined && !['Physical', 'Special', 'Status'].includes(move.category as string)) {
      invalid(`${pokemonId} ${move.name} category must be Physical, Special, or Status`);
    }
    if (move.priority !== undefined) requireInteger(move.priority, `${pokemonId} ${move.name} priority`);
    for (const property of ['contact', 'heal', 'punch', 'bite', 'pulse', 'slicing', 'bullet', 'snatchable', 'sound', 'wind', 'dance', 'reflectable']) {
      if (move[property] !== undefined && typeof move[property] !== 'boolean') {
        invalid(`${pokemonId} ${move.name} ${property} must be boolean`);
      }
    }
    const pp = move.pp;
    const maxPP = move.maxPP;
    if (pp !== undefined) requireInteger(pp, `${pokemonId} ${move.name} PP`, 0);
    if (maxPP !== undefined) requireInteger(maxPP, `${pokemonId} ${move.name} max PP`, 0);
    if (typeof pp === 'number' && typeof maxPP === 'number' && pp > maxPP) {
      invalid(`${pokemonId} ${label} ${move.name} PP exceeds max PP`);
    }
    if (move.accuracy !== undefined && move.accuracy !== true) {
      requireFinite(move.accuracy, `${pokemonId} ${move.name} accuracy`);
      if (move.accuracy < 0 || move.accuracy > 100) invalid(`${pokemonId} ${move.name} accuracy must be from 0 to 100`);
    }
    if (move.secondaryEffects !== undefined) validateSecondaryEffects(move.secondaryEffects, `${pokemonId} ${move.name} secondaryEffects`);
    if (move.target !== undefined && (typeof move.target !== 'string' || !MOVE_TARGET_NAMES.has(move.target))) {
      invalid(`${pokemonId} ${move.name} has an invalid target`);
    }
    for (const property of ['disabled', 'useZ', 'useMax']) {
      if (move[property] !== undefined && typeof move[property] !== 'boolean') invalid(`${pokemonId} ${move.name} ${property} must be boolean`);
    }
    for (const property of ['hits', 'timesUsed', 'timesUsedWithMetronome']) {
      if (move[property] !== undefined) requireInteger(move[property], `${pokemonId} ${move.name} ${property}`, 1);
    }
  }
}

function validatePokemon(pokemon: BattleState['sides'][SideId]['party'][number]) {
  if (!pokemon.id || typeof pokemon.id !== 'string') invalid('Pokémon IDs must be non-empty strings');
  if (!pokemon.species || typeof pokemon.species !== 'string') invalid(`${pokemon.id} species is required`);
  requireInteger(pokemon.level, `${pokemon.id} level`, 1, 100);
  if (!pokemon.hp || typeof pokemon.hp !== 'object') invalid(`${pokemon.id} HP is required`);
  requireInteger(pokemon.hp.max, `${pokemon.id} max HP`, 1);
  requireInteger(pokemon.hp.current, `${pokemon.id} current HP`, 0, pokemon.hp.max);
  for (const property of ['ability', 'item', 'nature'] as const) {
    if (pokemon[property] !== undefined && (typeof pokemon[property] !== 'string' || !pokemon[property])) {
      invalid(`${pokemon.id} ${property} must be a non-empty string`);
    }
  }
  if (pokemon.abilityOn !== undefined && typeof pokemon.abilityOn !== 'boolean') {
    invalid(`${pokemon.id} abilityOn must be boolean`);
  }
  if (pokemon.gender !== undefined && !['M', 'F', 'N'].includes(pokemon.gender)) {
    invalid(`${pokemon.id} gender must be M, F, or N`);
  }
  if (pokemon.teraType !== undefined && (typeof pokemon.teraType !== 'string' || !pokemon.teraType)) {
    invalid(`${pokemon.id} teraType must be a non-empty type name`);
  }
  for (const property of ['isDynamaxed', 'isSaltCure'] as const) {
    if (pokemon[property] !== undefined && typeof pokemon[property] !== 'boolean') {
      invalid(`${pokemon.id} ${property} must be boolean`);
    }
  }
  if (pokemon.alliesFainted !== undefined) requireInteger(pokemon.alliesFainted, `${pokemon.id} alliesFainted`, 0);
  if (pokemon.rageFistHits !== undefined) requireInteger(pokemon.rageFistHits, `${pokemon.id} rageFistHits`, 0);
  if (pokemon.ivs !== undefined) validateStatMap(pokemon.ivs, `${pokemon.id} IVs`, 31);
  if (pokemon.evs !== undefined) validateStatMap(pokemon.evs, `${pokemon.id} EVs`, 255);
  validateMoveArray(pokemon.id, pokemon.moves, 'moves');
  if (pokemon.originalMoves !== undefined) validateMoveArray(pokemon.id, pokemon.originalMoves, 'originalMoves');
  if (pokemon.status !== undefined && !STATUS_NAMES.has(pokemon.status)) {
    invalid(`${pokemon.id} has an invalid major status`);
  }
  if (pokemon.statusTurns !== undefined) {
    requireInteger(pokemon.statusTurns, `${pokemon.id} status turns`, 0);
    if (pokemon.status !== 'slp') invalid(`${pokemon.id} status turns require sleep status`);
  }
  if (pokemon.status === 'slp' && pokemon.statusTurns === undefined) {
    invalid(`${pokemon.id} sleep status requires status turns`);
  }
  if (pokemon.disguiseBroken !== undefined && typeof pokemon.disguiseBroken !== 'boolean') {
    invalid(`${pokemon.id} disguiseBroken must be boolean`);
  }
  for (const property of ['syrupTriggered', 'intrepidSwordTriggered', 'dauntlessShieldTriggered', 'zeroToHeroTriggered', 'typeChangeUsed'] as const) {
    if (pokemon[property] !== undefined && typeof pokemon[property] !== 'boolean') {
      invalid(`${pokemon.id} ${property} must be boolean`);
    }
  }
  if (pokemon.isSaltCure !== undefined && typeof pokemon.isSaltCure !== 'boolean') {
    invalid(`${pokemon.id} isSaltCure must be boolean`);
  }
  if (pokemon.toxicCounter !== undefined) requireInteger(pokemon.toxicCounter, `${pokemon.id} toxic counter`, 0);
  if (pokemon.itemLost !== undefined && typeof pokemon.itemLost !== 'boolean') {
    invalid(`${pokemon.id} itemLost must be boolean`);
  }
  if (pokemon.itemCorroded !== undefined && typeof pokemon.itemCorroded !== 'boolean') {
    invalid(`${pokemon.id} itemCorroded must be boolean`);
  }
  if (pokemon.abilityOverride !== undefined && pokemon.abilityOverride !== null &&
    (typeof pokemon.abilityOverride !== 'string' || !pokemon.abilityOverride)) {
    invalid(`${pokemon.id} abilityOverride must be a non-empty ability name or null`);
  }
  if (pokemon.abilitySuppressed !== undefined && typeof pokemon.abilitySuppressed !== 'boolean') {
    invalid(`${pokemon.id} abilitySuppressed must be boolean`);
  }
  if (pokemon.speciesOverride !== undefined &&
    (typeof pokemon.speciesOverride !== 'string' || !pokemon.speciesOverride)) {
    invalid(`${pokemon.id} speciesOverride must be a non-empty species name`);
  }
  if (pokemon.lastConsumedItem !== undefined &&
    (typeof pokemon.lastConsumedItem !== 'string' || !pokemon.lastConsumedItem)) {
    invalid(`${pokemon.id} lastConsumedItem must be a non-empty item name`);
  }
  if (pokemon.typeOverride !== undefined) {
    if (!Array.isArray(pokemon.typeOverride) || pokemon.typeOverride.length > 3 ||
      pokemon.typeOverride.some(type => typeof type !== 'string' || !type)) {
      invalid(`${pokemon.id} typeOverride must contain zero to three non-empty type names`);
    }
    if (new Set(pokemon.typeOverride.map(type => type.toLowerCase())).size !== pokemon.typeOverride.length) {
      invalid(`${pokemon.id} typeOverride cannot contain duplicate types`);
    }
  }
  if (pokemon.typeChangeUsed !== undefined && typeof pokemon.typeChangeUsed !== 'boolean') {
    invalid(`${pokemon.id} typeChangeUsed must be boolean`);
  }
  if (pokemon.baseStatsOverride !== undefined) {
    if (!pokemon.baseStatsOverride || typeof pokemon.baseStatsOverride !== 'object' ||
      Array.isArray(pokemon.baseStatsOverride)) {
      invalid(`${pokemon.id} baseStatsOverride must be an object`);
    }
    for (const [stat, value] of Object.entries(pokemon.baseStatsOverride)) {
      if (!['hp', 'atk', 'def', 'spa', 'spd', 'spe'].includes(stat)) {
        invalid(`${pokemon.id} ${stat} is not a supported base stat`);
      }
      requireInteger(value, `${pokemon.id} ${stat} base stat`, 0, 255);
    }
  }
  if (pokemon.statOverrides !== undefined) {
    if (!pokemon.statOverrides || typeof pokemon.statOverrides !== 'object' || Array.isArray(pokemon.statOverrides)) {
      invalid(`${pokemon.id} statOverrides must be an object`);
    }
    for (const [stat, value] of Object.entries(pokemon.statOverrides)) {
      if (!['hp', 'atk', 'def', 'spa', 'spd', 'spe'].includes(stat)) {
        invalid(`${pokemon.id} ${stat} is not a supported stat override`);
      }
      requireInteger(value, `${pokemon.id} ${stat} stat override`, 0, 10000);
    }
  }
  if (pokemon.substituteHp !== undefined) {
    requireInteger(pokemon.substituteHp, `${pokemon.id} Substitute HP`, 1, Math.floor(pokemon.hp.max / 4));
  }
  for (const [stat, value] of Object.entries(pokemon.boosts || {})) {
    if (!STAT_NAMES.has(stat)) invalid(`${pokemon.id} ${stat} is not a supported stat`);
    requireInteger(value, `${pokemon.id} ${stat} boost`, -6, 6);
  }
  for (const [name, effect] of Object.entries(pokemon.volatile || {})) {
    if (!effect || typeof effect !== 'object' || Array.isArray(effect)) {
      invalid(`${pokemon.id} volatile ${name} must be an object`);
    }
    validateVolatile(name, effect);
  }
}

function validateDurationMap(
  values: Record<string, number> | undefined,
  label: string,
  allowedNames?: ReadonlySet<string>,
) {
  for (const [name, value] of Object.entries(values || {})) {
    if (allowedNames && !allowedNames.has(name)) invalid(`${label}.${name} is not a modeled duration`);
    requireInteger(value, `${label}.${name}`, 0);
  }
}

function validateField(field: BattleState['field'], label = 'field') {
  for (const name of Object.keys(field)) {
    if (!FIELD_NAMES.has(name)) invalid(`${label}.${name} is not a modeled field value`);
  }
  if (field.weather !== undefined && !WEATHER_NAMES.has(field.weather)) {
    invalid(`${label}.weather ${field.weather} is not a supported weather`);
  }
  if (field.terrain !== undefined && !TERRAIN_NAMES.has(field.terrain)) {
    invalid(`${label}.terrain ${field.terrain} is not a supported terrain`);
  }
  for (const name of FIELD_BOOLEAN_NAMES) {
    const value = field[name];
    if (value !== undefined && typeof value !== 'boolean') invalid(`${label}.${name} must be boolean`);
  }
  validateDurationMap(field.durations, `${label} duration`, FIELD_DURATION_NAMES);
}

/** Validate the serializable battle-state contract before policy or transition code consumes it. */
export function validateBattleState(state: BattleState): void {
  if (!state || typeof state !== 'object') invalid('state must be an object');
  requireInteger(state.generation, 'generation', 1, 9);
  if (state.mode !== 'Singles' && state.mode !== 'Doubles') invalid('mode must be Singles or Doubles');
  requireInteger(state.turn, 'turn', 0);
  if (!state.field || typeof state.field !== 'object') invalid('field is required');
  validateField(state.field);
  const partyIds = new Set<string>();
  const sideIds: SideId[] = ['ai', 'player'];
  for (const sideId of sideIds) {
    const side = state.sides?.[sideId];
    if (!side || !Array.isArray(side.party) || !Array.isArray(side.activeIds)) {
      invalid(`${sideId} side must have party and activeIds arrays`);
    }
    if (side.pendingFullHealOnSwitch !== undefined &&
      typeof side.pendingFullHealOnSwitch !== 'boolean') {
      invalid(`${sideId} pendingFullHealOnSwitch must be boolean`);
    }
    const activeLimit = state.mode === 'Singles' ? 1 : 2;
    if (side.activeIds.length > activeLimit) invalid(`${sideId} has too many active Pokémon`);
    const activeIds = new Set<string>();
    for (const activeId of side.activeIds) {
      if (activeIds.has(activeId)) invalid(`${sideId} repeats active Pokémon ${activeId}`);
      activeIds.add(activeId);
    }
    for (const pokemon of side.party) {
      validatePokemon(pokemon);
      if (partyIds.has(pokemon.id)) invalid(`duplicate Pokémon ID ${pokemon.id}`);
      partyIds.add(pokemon.id);
    }
    const sidePartyIds = new Set(side.party.map(pokemon => pokemon.id));
    for (const activeId of side.activeIds) {
      if (!sidePartyIds.has(activeId)) invalid(`${sideId} active ID ${activeId} is not in its party`);
    }
    validateSideEffects(side.effects, sideId);
    validateDurationMap(side.effectDurations, `${sideId} effect duration`, SIDE_DURATION_NAMES);
  }
  for (const sideId of sideIds) {
    for (const pokemon of state.sides[sideId].party) {
      for (const [name, effect] of Object.entries(pokemon.volatile || {})) {
        if (effect?.sourceId !== undefined && !partyIds.has(effect.sourceId)) {
          invalid(`${pokemon.id} ${name} source must reference a party Pokemon`);
        }
      }
      const chargeTargetIds = pokemon.volatile?.charge?.targetIds;
      if (chargeTargetIds !== undefined) {
        if (new Set(chargeTargetIds).size !== chargeTargetIds.length ||
          chargeTargetIds.some(targetId => !partyIds.has(targetId))) {
          invalid(`${pokemon.id} Charge targets must reference unique party Pokemon`);
        }
      }
      const targetId = pokemon.volatile?.lockOn?.targetId;
      if (targetId !== undefined && !partyIds.has(targetId)) {
        invalid(`${pokemon.id} Lock-On target must reference a party PokÃ©mon`);
      }
      const permanentTrapSourceId = pokemon.volatile?.trapped?.sourceId;
      if (permanentTrapSourceId !== undefined && !partyIds.has(permanentTrapSourceId)) {
        invalid(`${pokemon.id} trap source must reference a party Pokemon`);
      }
      const octolockSourceId = pokemon.volatile?.octolock?.sourceId;
      if (octolockSourceId !== undefined && !partyIds.has(octolockSourceId)) {
        invalid(`${pokemon.id} Octolock source must reference a party Pokemon`);
      }
      const sourceId = pokemon.volatile?.partiallyTrapped?.sourceId;
      if (sourceId !== undefined && !partyIds.has(sourceId)) {
        invalid(`${pokemon.id} partial trap source must reference a party PokÃ©mon`);
      }
    }
  }
  if (state.pendingForcedSwitchIds !== undefined) {
    if (!Array.isArray(state.pendingForcedSwitchIds)) invalid('pendingForcedSwitchIds must be an array');
    const pendingIds = new Set<string>();
    for (const pokemonId of state.pendingForcedSwitchIds) {
      if (typeof pokemonId !== 'string' || !pokemonId || pendingIds.has(pokemonId)) {
        invalid('pendingForcedSwitchIds must contain unique non-empty IDs');
      }
      pendingIds.add(pokemonId);
      const sideId = sideIds.find(candidate => state.sides[candidate].activeIds.includes(pokemonId));
      if (!sideId) invalid(`pending forced switch ${pokemonId} must reference an active Pokémon`);
    }
  }
  if (state.pendingBatonPassIds !== undefined) {
    if (!Array.isArray(state.pendingBatonPassIds)) invalid('pendingBatonPassIds must be an array');
    const pendingIds = new Set<string>();
    for (const pokemonId of state.pendingBatonPassIds) {
      if (typeof pokemonId !== 'string' || !pokemonId || pendingIds.has(pokemonId)) {
        invalid('pendingBatonPassIds must contain unique non-empty IDs');
      }
      pendingIds.add(pokemonId);
      const sideId = sideIds.find(candidate => state.sides[candidate].activeIds.includes(pokemonId));
      const pokemon = sideId ? state.sides[sideId].party.find(candidate => candidate.id === pokemonId) : undefined;
      if (!sideId || !pokemon || pokemon.hp.current <= 0) {
        invalid(`pending Baton Pass ${pokemonId} must reference a living active Pokémon`);
      }
    }
  }
  if (state.pendingSubstitutePassIds !== undefined) {
    if (!Array.isArray(state.pendingSubstitutePassIds)) invalid('pendingSubstitutePassIds must be an array');
    const pendingIds = new Set<string>();
    for (const pokemonId of state.pendingSubstitutePassIds) {
      if (typeof pokemonId !== 'string' || !pokemonId || pendingIds.has(pokemonId)) {
        invalid('pendingSubstitutePassIds must contain unique non-empty IDs');
      }
      pendingIds.add(pokemonId);
      const sideId = sideIds.find(candidate => state.sides[candidate].activeIds.includes(pokemonId));
      const pokemon = sideId ? state.sides[sideId].party.find(candidate => candidate.id === pokemonId) : undefined;
      if (!sideId || !pokemon || pokemon.hp.current <= 0 || !pokemon.substituteHp) {
        invalid(`pending Substitute pass ${pokemonId} must reference a living active Pokémon with a Substitute`);
      }
    }
  }
  const pendingForcedIds = new Set(state.pendingForcedSwitchIds || []);
  const pendingBatonPassIds = new Set(state.pendingBatonPassIds || []);
  const pendingSubstitutePassIds = new Set(state.pendingSubstitutePassIds || []);
  for (const pokemonId of Array.from(pendingBatonPassIds)) {
    if (pendingForcedIds.has(pokemonId) || pendingSubstitutePassIds.has(pokemonId)) {
      invalid(`replacement queues cannot overlap for ${pokemonId}`);
    }
  }
  for (const pokemonId of Array.from(pendingSubstitutePassIds)) {
    if (pendingForcedIds.has(pokemonId)) invalid(`replacement queues cannot overlap for ${pokemonId}`);
  }
  const delayedIds = new Set<string>();
  for (const delayed of state.delayedMoves || []) {
    if (!delayed || typeof delayed !== 'object' || !delayed.id || typeof delayed.id !== 'string' ||
      delayedIds.has(delayed.id)) invalid('delayed move IDs must be unique non-empty strings');
    delayedIds.add(delayed.id);
    if (!delayed.moveName || typeof delayed.moveName !== 'string') invalid(`delayed move ${delayed.id} needs a move name`);
    if (!partyIds.has(delayed.sourceId)) invalid(`delayed move ${delayed.id} has an unknown source`);
    if (!Array.isArray(delayed.targetIds) || !delayed.targetIds.length ||
      new Set(delayed.targetIds).size !== delayed.targetIds.length ||
      delayed.targetIds.some(targetId => !partyIds.has(targetId))) {
      invalid(`delayed move ${delayed.id} has invalid targets`);
    }
    for (const [targetId, slot] of Object.entries(delayed.targetSlotsByTarget || {})) {
      if (!delayed.targetIds.includes(targetId)) invalid(`delayed move ${delayed.id} has an unlisted target slot`);
      requireInteger(slot, `delayed move ${delayed.id} target slot`, 0,
        state.mode === 'Singles' ? 0 : 1);
    }
    requireInteger(delayed.turns, `delayed move ${delayed.id} turns`, 1);
    if (!delayed.damageByTarget || typeof delayed.damageByTarget !== 'object') {
      invalid(`delayed move ${delayed.id} needs damage facts`);
    }
    for (const [targetId, damage] of Object.entries(delayed.damageByTarget)) {
      if (!delayed.targetIds.includes(targetId)) invalid(`delayed move ${delayed.id} targets an unlisted PokÃ©mon`);
      requireFinite(damage, `delayed move ${delayed.id} damage`);
      if (damage < 0) invalid(`delayed move ${delayed.id} damage must be non-negative`);
    }
    for (const [targetId, fraction] of Object.entries(delayed.healingByTarget || {})) {
      if (!delayed.targetIds.includes(targetId)) {
        invalid(`delayed move ${delayed.id} healing references an unlisted target`);
      }
      if (!fraction || typeof fraction !== 'object' || Array.isArray(fraction)) {
        invalid(`delayed move ${delayed.id} healing must be a fraction`);
      }
      const healing = fraction as {numerator?: unknown; denominator?: unknown};
      requireInteger(healing.numerator, `delayed move ${delayed.id} healing numerator`, 1);
      requireInteger(healing.denominator, `delayed move ${delayed.id} healing denominator`, 1);
    }
  }
  const activeIds = new Set([
    ...state.sides.ai.activeIds,
    ...state.sides.player.activeIds,
  ]);
  for (const [pokemonId, moveName] of Object.entries(state.lastMoveByPokemon || {})) {
    if (!partyIds.has(pokemonId) || typeof moveName !== 'string' || !moveName) {
      invalid(`lastMoveByPokemon contains an invalid entry for ${pokemonId}`);
    }
  }
  for (const [pokemonId, moveName] of Object.entries(state.lastMoveUsedByPokemon || {})) {
    if (!partyIds.has(pokemonId) || !activeIds.has(pokemonId) || typeof moveName !== 'string' || !moveName) {
      invalid(`lastMoveUsedByPokemon contains an invalid entry for ${pokemonId}`);
    }
  }
  for (const [pokemonId, targetIds] of Object.entries(state.lastMoveTargetIdsByPokemon || {})) {
    if (!partyIds.has(pokemonId) || !activeIds.has(pokemonId) || !Array.isArray(targetIds) ||
      new Set(targetIds).size !== targetIds.length ||
      targetIds.some(targetId => !partyIds.has(targetId))) {
      invalid(`lastMoveTargetIdsByPokemon contains an invalid entry for ${pokemonId}`);
    }
  }
  if (state.lastMoveUsed !== undefined &&
    (typeof state.lastMoveUsed !== 'string' || !state.lastMoveUsed)) {
    invalid('lastMoveUsed must be a non-empty move name');
  }
  for (const [pokemonId, moveName] of Object.entries(state.lastMoveTargetedByPokemon || {})) {
    if (!partyIds.has(pokemonId) || !activeIds.has(pokemonId) || typeof moveName !== 'string' || !moveName) {
      invalid(`lastMoveTargetedByPokemon contains an invalid entry for ${pokemonId}`);
    }
  }
  for (const [pokemonId, moveName] of Object.entries(state.lastDamagingMoveByPokemon || {})) {
    if (!partyIds.has(pokemonId) || !activeIds.has(pokemonId) || typeof moveName !== 'string' || !moveName) {
      invalid(`lastDamagingMoveByPokemon contains an invalid entry for ${pokemonId}`);
    }
  }
  for (const [pokemonId, damage] of Object.entries(state.lastDamageTakenByPokemon || {})) {
    if (!partyIds.has(pokemonId) || !activeIds.has(pokemonId) ||
      !damage || typeof damage !== 'object' || Array.isArray(damage)) {
      invalid(`lastDamageTakenByPokemon contains an invalid entry for ${pokemonId}`);
    }
    const record = damage as {damage?: unknown; category?: unknown; sourceId?: unknown; moveName?: unknown; turn?: unknown};
    if (typeof record.damage !== 'number' || !Number.isFinite(record.damage) || record.damage <= 0 ||
      typeof record.category !== 'string' || !MOVE_CATEGORY_NAMES.has(record.category) ||
      typeof record.sourceId !== 'string' || !partyIds.has(record.sourceId) ||
      typeof record.moveName !== 'string' || !record.moveName ||
      typeof record.turn !== 'number' || !Number.isInteger(record.turn) || record.turn < 1) {
      invalid(`lastDamageTakenByPokemon contains an invalid entry for ${pokemonId}`);
    }
  }
  for (const [pokemonId, selected] of Object.entries(state.selectedMoveByPokemon || {})) {
    if (!partyIds.has(pokemonId) || !activeIds.has(pokemonId) ||
      !selected || typeof selected.moveName !== 'string' || !selected.moveName) {
      invalid(`selectedMoveByPokemon contains an invalid entry for ${pokemonId}`);
    }
    if (selected.useZ !== undefined && typeof selected.useZ !== 'boolean') {
      invalid(`selectedMoveByPokemon useZ is invalid for ${pokemonId}`);
    }
    if (selected.useMax !== undefined && typeof selected.useMax !== 'boolean') {
      invalid(`selectedMoveByPokemon useMax is invalid for ${pokemonId}`);
    }
  }
  for (const [sideId, pending] of Object.entries(state.pendingPledgeBySide || {})) {
    if (sideId !== 'ai' && sideId !== 'player') invalid(`pendingPledgeBySide has invalid side ${sideId}`);
    validatePendingPledge(pending, `pendingPledgeBySide.${sideId}`, partyIds);
    const side = state.sides[sideId as SideId];
    const actor = side.party.find(pokemon => pokemon.id === pending.actorId);
    if (!actor || !side.activeIds.includes(actor.id) || actor.hp.current <= 0) {
      invalid(`pendingPledgeBySide.${sideId}.actorId must reference a living active Pokémon on that side`);
    }
  }
  for (const [pokemonId, streak] of Object.entries(state.moveStreakByPokemon || {})) {
    if (!partyIds.has(pokemonId) || !activeIds.has(pokemonId) ||
      !streak || typeof streak.moveName !== 'string' || !streak.moveName) {
      invalid(`moveStreakByPokemon contains an invalid entry for ${pokemonId}`);
    }
    requireInteger(streak.count, `${pokemonId} move streak`, 1);
  }
  for (const [pokemonId, moveName] of Object.entries(state.choiceLockByPokemon || {})) {
    if (!partyIds.has(pokemonId) || !activeIds.has(pokemonId) || typeof moveName !== 'string' || !moveName) {
      invalid(`choiceLockByPokemon contains an invalid entry for ${pokemonId}`);
    }
  }
  if (state.firstTurnOutIds !== undefined) {
    if (new Set(state.firstTurnOutIds).size !== state.firstTurnOutIds.length) {
      invalid('firstTurnOutIds must contain unique IDs');
    }
    for (const pokemonId of state.firstTurnOutIds) {
      if (!partyIds.has(pokemonId) || !activeIds.has(pokemonId)) {
        invalid(`firstTurnOutIds must reference active party Pokémon: ${pokemonId}`);
      }
    }
  }
}
