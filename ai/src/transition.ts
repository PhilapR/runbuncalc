import {actionKey, canEscapeTrappingEffect, enumerateMoveActions, getPokemon, isChoiceItem, isSwitchBlockedByAbility, sideForPokemon} from './actions';
import {getEffectiveAbility, isAbilityActive, isAbilityAvailable} from './abilities';
import {applyEndTurnResolution, deriveEndTurnResolution, EndTurnOptions} from './end-turn';
import {deriveSwitchEntryResolution, SwitchEntryOptions} from './entry-hazards';
import {getMoveMaxPP, getMoveMetadata} from './move-metadata';
import {isMimicryActive, mimicryTypeOverride} from './mimicry';
import {weatherFormSpeciesOverride} from './weather-forms';
import {getActionOrderFacts} from './order';
import {isItemEffectActive} from './items';
import {
  Action,
  BattleState,
  DelayedMoveState,
  LastDamageTaken,
  MoveAction,
  MoveResolution,
  PokemonState,
  SideId,
  StatBoosts,
  SwitchAction,
  TimedFieldName,
  TimedSideEffectName,
  VolatileState,
  VolatileStatusName,
} from './model';

const ACTION_FAILURES = new Set([
  'flinch', 'paralysis', 'sleep', 'freeze', 'confusion', 'infatuation', 'protect', 'truant',
]);
const FRESH_SLEEP_TURNS = 3;

function moveId(name: string | undefined): string {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isTruantActive(state: BattleState, pokemon: PokemonState): boolean {
  return state.generation >= 3 && isAbilityActive(pokemon, state) &&
    isAbilityAvailable(state.generation, getEffectiveAbility(pokemon)) &&
    moveId(getEffectiveAbility(pokemon)) === 'truant';
}

function pressureTargetCount(state: BattleState, actor: PokemonState, targetIds: string[]): number {
  if (state.generation < 3) return 0;
  const actorSide = sideForPokemon(state, actor.id);
  return targetIds.filter(targetId => {
    const target = getPokemon(state, targetId);
    return !!target && target.hp.current > 0 && sideForPokemon(state, target.id) !== actorSide &&
      isAbilityActive(target, state) && isAbilityAvailable(state.generation, getEffectiveAbility(target)) &&
      moveId(getEffectiveAbility(target)) === 'pressure';
  }).length;
}

function isLeppaActive(state: BattleState, actor: PokemonState): boolean {
  return state.generation >= 3 && isItemEffectActive(state, actor) &&
    moveId(actor.item) === 'leppaberry';
}

function isRipenActive(state: BattleState, actor: PokemonState): boolean {
  return isAbilityActive(actor, state) &&
    isAbilityAvailable(state.generation, getEffectiveAbility(actor)) &&
    moveId(getEffectiveAbility(actor)) === 'ripen';
}

function isCudChewActive(state: BattleState, actor: PokemonState): boolean {
  return state.generation >= 9 && isAbilityActive(actor, state) &&
    isAbilityAvailable(state.generation, getEffectiveAbility(actor)) &&
    moveId(getEffectiveAbility(actor)) === 'cudchew';
}

function isCheekPouchActive(state: BattleState, actor: PokemonState): boolean {
  return state.generation >= 6 && isAbilityActive(actor, state) &&
    isAbilityAvailable(state.generation, getEffectiveAbility(actor)) &&
    moveId(getEffectiveAbility(actor)) === 'cheekpouch';
}

function consumeCustapIfNeeded(
  state: BattleState,
  action: MoveAction,
  resolution: MoveResolution,
): MoveResolution {
  const hasItemResolution = !!resolution.itemByPokemon &&
    Object.prototype.hasOwnProperty.call(resolution.itemByPokemon, action.actorId);
  const hasConsumptionResolution = !!resolution.consumedItemByPokemon &&
    Object.prototype.hasOwnProperty.call(resolution.consumedItemByPokemon, action.actorId);
  if (hasItemResolution || hasConsumptionResolution) return resolution;
  let orderFacts;
  try {
    orderFacts = getActionOrderFacts(state, action);
  } catch {
    // Caller-defined custom moves may not have calculator order metadata.
    return resolution;
  }
  if (orderFacts.itemPriorityItem !== 'Custap Berry') return resolution;
  return {
    ...resolution,
    itemByPokemon: {
      ...(resolution.itemByPokemon || {}),
      [action.actorId]: null,
    },
    consumedItemByPokemon: {
      ...(resolution.consumedItemByPokemon || {}),
      [action.actorId]: 'Custap Berry',
    },
    trace: {
      ...(resolution.trace || {source: 'battle-engine' as const}),
      notes: [
        ...(resolution.trace?.notes || []),
        'Custap Berry granted fractional priority and was consumed',
      ],
    },
  };
}

function replaceActive(
  side: BattleState['sides'][SideId],
  actorId: string,
  replacementId: string,
  mode: BattleState['mode'],
) {
  if (mode === 'Singles') return {...side, activeIds: [replacementId]};
  return {...side, activeIds: side.activeIds.map(id => id === actorId ? replacementId : id)};
}

/** Clear state that does not persist through an ordinary switch. */
function resetSwitchState(pokemon: BattleState['sides'][SideId]['party'][number]) {
  return {
    ...pokemon,
    moves: pokemon.originalMoves || pokemon.moves,
    originalMoves: undefined,
    boosts: undefined,
    toxicCounter: undefined,
    itemLost: undefined,
    lastConsumedItem: undefined,
    abilityOverride: undefined,
    abilitySuppressed: undefined,
    speciesOverride: undefined,
    typeOverride: undefined,
    typeChangeUsed: undefined,
    baseStatsOverride: undefined,
    statOverrides: undefined,
    volatile: undefined,
    substituteHp: undefined,
    disguiseBroken: undefined,
    isDynamaxed: undefined,
    isSaltCure: undefined,
  };
}

function resetSleepOnEntry(pokemon: BattleState['sides'][SideId]['party'][number]) {
  return pokemon.status === 'slp'
    ? {...pokemon, statusTurns: FRESH_SLEEP_TURNS}
    : pokemon;
}

function applySwitchEntryResolution(
  state: BattleState,
  sideId: SideId,
  replacementId: string,
  resolution: ReturnType<typeof deriveSwitchEntryResolution>,
): BattleState {
  const sides = {...state.sides};
  const side = sides[sideId];
  const replacement = getPokemon(state, replacementId);
  if (!replacement) throw new Error('Switch entry references an unknown replacement');
  const pendingFullHeal = side.pendingFullHealOnSwitch === true;

  const applyItemState = (pokemon: BattleState['sides'][SideId]['party'][number]) => {
    const item = resolution.itemByPokemon?.[pokemon.id];
    const hasItem = !!resolution.itemByPokemon &&
      Object.prototype.hasOwnProperty.call(resolution.itemByPokemon, pokemon.id);
    const consumedItem = resolution.consumedItemByPokemon?.[pokemon.id];
    const hasConsumedItem = !!resolution.consumedItemByPokemon &&
      Object.prototype.hasOwnProperty.call(resolution.consumedItemByPokemon, pokemon.id);
    if (!hasItem && !hasConsumedItem) return pokemon;
    return {
      ...pokemon,
      ...(hasItem ? {item: item === null ? undefined : item} : {}),
      ...(hasItem && item === null ? {itemLost: true} : {}),
      ...(hasConsumedItem
        ? {lastConsumedItem: consumedItem === null ? undefined : consumedItem}
        : hasItem ? {lastConsumedItem: undefined} : {}),
    };
  };

  const hpDelta = resolution.hpDeltaByPokemon?.[replacementId] || 0;
  const entryHp = Math.max(0, Math.min(replacement.hp.max, replacement.hp.current + hpDelta));
  const pendingFullHealApplies = pendingFullHeal && entryHp > 0;
  const status = resolution.statusByPokemon?.[replacementId];
  const toxicCounter = resolution.toxicCounterByPokemon?.[replacementId];
  const boosts = resolution.boostsByPokemon?.[replacementId];
  const setBoosts = resolution.setBoostsByPokemon?.[replacementId];
  const abilityOverride = resolution.abilityOverrideByPokemon?.[replacementId];
  const hasAbilityOverride = !!resolution.abilityOverrideByPokemon &&
    Object.prototype.hasOwnProperty.call(resolution.abilityOverrideByPokemon, replacementId);
  const noAbility = resolution.noAbilityByPokemon?.[replacementId];
  const hasNoAbility = !!resolution.noAbilityByPokemon &&
    Object.prototype.hasOwnProperty.call(resolution.noAbilityByPokemon, replacementId);
  const syrupTriggered = resolution.syrupTriggeredByPokemon?.[replacementId];
  const intrepidSwordTriggered = resolution.intrepidSwordTriggeredByPokemon?.[replacementId];
  const dauntlessShieldTriggered = resolution.dauntlessShieldTriggeredByPokemon?.[replacementId];
  const speciesOverride = resolution.speciesOverrideByPokemon?.[replacementId];
  const hasSpeciesOverride = !!resolution.speciesOverrideByPokemon &&
    Object.prototype.hasOwnProperty.call(resolution.speciesOverrideByPokemon, replacementId);
  const typeOverride = resolution.typeOverrideByPokemon?.[replacementId];
  const hasTypeOverride = !!resolution.typeOverrideByPokemon &&
    Object.prototype.hasOwnProperty.call(resolution.typeOverrideByPokemon, replacementId);
  const statOverrides = resolution.statOverridesByPokemon?.[replacementId];
  const hasStatOverrides = !!resolution.statOverridesByPokemon &&
    Object.prototype.hasOwnProperty.call(resolution.statOverridesByPokemon, replacementId);
  const movesOverride = resolution.movesByPokemon?.[replacementId];
  const hasMovesOverride = !!resolution.movesByPokemon &&
    Object.prototype.hasOwnProperty.call(resolution.movesByPokemon, replacementId);
  const volatile = resolution.volatileByPokemon?.[replacementId];
  const copiedMoves = hasMovesOverride
    ? movesOverride === null ? replacement.originalMoves || replacement.moves : movesOverride
    : undefined;
  const nextReplacement = {
    ...applyItemState(replacement),
    hp: pendingFullHealApplies
      ? {...replacement.hp, current: replacement.hp.max}
      : hpDelta
      ? {...replacement.hp, current: Math.max(0, Math.min(replacement.hp.max, replacement.hp.current + hpDelta))}
      : replacement.hp,
    ...(pendingFullHealApplies
      ? {status: '' as const, statusTurns: undefined, toxicCounter: undefined}
      : status === undefined ? {} : {
        status,
        ...(status === '' ? {statusTurns: undefined, toxicCounter: undefined} : {}),
      }),
    ...(!pendingFullHeal && toxicCounter !== undefined ? {toxicCounter} : {}),
    ...(setBoosts === undefined
      ? boosts === undefined ? {} : {boosts: mergeBoosts(replacement.boosts, boosts)}
      : {boosts: compactBoosts(setBoosts)}),
    ...(hasAbilityOverride ? {abilityOverride: abilityOverride === null ? undefined : abilityOverride} : {}),
    ...(hasNoAbility ? {abilityOverride: noAbility ? null : undefined} : {}),
    ...(syrupTriggered === undefined ? {} : {syrupTriggered}),
    ...(intrepidSwordTriggered === undefined ? {} : {intrepidSwordTriggered}),
    ...(dauntlessShieldTriggered === undefined ? {} : {dauntlessShieldTriggered}),
    ...(hasSpeciesOverride ? {speciesOverride: speciesOverride === null ? undefined : speciesOverride} : {}),
    ...(hasTypeOverride ? {typeOverride: typeOverride === null ? undefined : typeOverride} : {}),
    ...(hasStatOverrides ? {statOverrides: statOverrides === null ? undefined : statOverrides} : {}),
    ...(hasMovesOverride ? {
      moves: copiedMoves,
      originalMoves: movesOverride === null ? undefined : replacement.originalMoves || replacement.moves,
    } : {}),
    ...(volatile === undefined ? {} : {volatile: mergeVolatile(replacement.volatile, volatile)}),
  };
  const field = resolution.field ? {...state.field, ...resolution.field} : state.field;
  const fieldWithDurations = resolution.fieldDurations
    ? {...field, durations: mergeDurations(field.durations, resolution.fieldDurations)}
    : field;

  for (const candidateSideId of ['ai', 'player'] as const) {
    const candidateSide = sides[candidateSideId];
    const effects = {
      ...(candidateSide.effects || {}),
      ...(resolution.sideEffectsBySide?.[candidateSideId] || {}),
    };
    if (candidateSideId === sideId && resolution.clearToxicSpikesBySide?.[sideId]) delete effects.toxicSpikes;
    sides[candidateSideId] = {
      ...candidateSide,
      party: candidateSide.party.map(pokemon => {
        if (pokemon.id === replacementId) return nextReplacement;
        const partyHpDelta = resolution.hpDeltaByPokemon?.[pokemon.id] || 0;
        const partyBoosts = resolution.boostsByPokemon?.[pokemon.id];
        const partySetBoosts = resolution.setBoostsByPokemon?.[pokemon.id];
        const partyStatus = resolution.statusByPokemon?.[pokemon.id];
        const partyToxicCounter = resolution.toxicCounterByPokemon?.[pokemon.id];
        const partyIntrepidSwordTriggered = resolution.intrepidSwordTriggeredByPokemon?.[pokemon.id];
        const partyDauntlessShieldTriggered = resolution.dauntlessShieldTriggeredByPokemon?.[pokemon.id];
        const partyTypeOverride = resolution.typeOverrideByPokemon?.[pokemon.id];
        const hasPartyTypeOverride = !!resolution.typeOverrideByPokemon &&
          Object.prototype.hasOwnProperty.call(resolution.typeOverrideByPokemon, pokemon.id);
        const partyVolatile = resolution.volatileByPokemon?.[pokemon.id];
        const itemState = applyItemState(pokemon);
        if (!partyHpDelta && partyBoosts === undefined && partySetBoosts === undefined &&
          partyStatus === undefined && partyToxicCounter === undefined &&
          partyIntrepidSwordTriggered === undefined && partyDauntlessShieldTriggered === undefined &&
          !hasPartyTypeOverride && partyVolatile === undefined) {
          return itemState;
        }
        return {
          ...itemState,
          ...(partyHpDelta ? {hp: {...itemState.hp,
            current: Math.max(0, Math.min(itemState.hp.max, itemState.hp.current + partyHpDelta)),
          }} : {}),
          ...(partySetBoosts === undefined
            ? partyBoosts === undefined ? {} : {boosts: mergeBoosts(itemState.boosts, partyBoosts)}
            : {boosts: compactBoosts(partySetBoosts)}),
          ...(partyStatus === undefined ? {} : {
            status: partyStatus,
            ...(partyStatus === '' ? {statusTurns: undefined, toxicCounter: undefined} : {}),
          }),
          ...(partyToxicCounter === undefined ? {} : {
            toxicCounter: partyToxicCounter || undefined,
          }),
          ...(partyIntrepidSwordTriggered === undefined ? {} : {intrepidSwordTriggered: partyIntrepidSwordTriggered}),
          ...(partyDauntlessShieldTriggered === undefined ? {} : {dauntlessShieldTriggered: partyDauntlessShieldTriggered}),
          ...(hasPartyTypeOverride ? {typeOverride: partyTypeOverride === null ? undefined : partyTypeOverride} : {}),
          ...(partyVolatile === undefined ? {} : {volatile: mergeVolatile(itemState.volatile, partyVolatile)}),
        };
      }),
      effects: Object.keys(effects).length ? effects : undefined,
      ...(candidateSideId === sideId && pendingFullHeal
        ? {pendingFullHealOnSwitch: undefined}
        : {}),
    };
  }
  const cleanedSides = clearInactiveCommanderLinks(sides);
  return {
    ...state,
    sides: cleanedSides,
    field: fieldWithDurations,
    lastResolution: resolution.trace
      ? {...resolution.trace, hit: true}
      : state.lastResolution,
  };
}

function applyDamageToPokemon(
  pokemon: BattleState['sides'][SideId]['party'][number],
  damage: number,
) {
  if (!damage) return pokemon;
  if ((pokemon.substituteHp || 0) > 0) {
    const substituteHp = Math.max(0, pokemon.substituteHp! - damage);
    return {...pokemon, substituteHp: substituteHp || undefined};
  }
  const effectiveDamage = pokemon.volatile?.endure
    ? Math.min(damage, Math.max(0, pokemon.hp.current - 1))
    : damage;
  return {...pokemon, hp: {...pokemon.hp, current: Math.max(0, pokemon.hp.current - effectiveDamage)}};
}

interface AppliedDamageSequence {
  directDamage: number;
  hitCount: number;
  fainted: boolean;
}

function applyDamageSequence(
  pokemon: BattleState['sides'][SideId]['party'][number],
  hits: number[],
): AppliedDamageSequence {
  let current = pokemon;
  let directDamage = 0;
  let hitCount = 0;
  for (const hit of hits) {
    if (current.hp.current <= 0) break;
    if (hit <= 0) continue;
    hitCount += 1;
    const beforeHp = current.hp.current;
    current = applyDamageToPokemon(current, hit);
    directDamage += beforeHp - current.hp.current;
  }
  return {directDamage, hitCount, fainted: current.hp.current <= 0};
}

/** Increment Rage Fist's per-appearance incoming-hit counter for damaging hits. */
function applyRageFistHits(
  state: BattleState,
  sides: BattleState['sides'],
  action: MoveAction,
  damageByTarget: Record<string, number> | undefined,
  hit = true,
  hitDamageByTarget?: Record<string, number[]>,
): BattleState['sides'] {
  if (state.generation < 9 || !hit || !damageByTarget ||
    getMoveMetadata(action.moveName, state.generation).category === 'Status') return sides;
  const targets = new Set(Object.keys(damageByTarget).filter(targetId => targetId !== action.actorId));
  if (!targets.size) return sides;
  const nextSides = {...sides};
  for (const sideId of ['ai', 'player'] as SideId[]) {
    nextSides[sideId] = {
        ...nextSides[sideId],
        party: nextSides[sideId].party.map(pokemon => targets.has(pokemon.id)
        ? {...pokemon, rageFistHits: (pokemon.rageFistHits || 0) +
          (hitDamageByTarget?.[pokemon.id]
            ? applyDamageSequence(getPokemon(state, pokemon.id) || pokemon, hitDamageByTarget[pokemon.id]).hitCount
            : 1)}
        : pokemon),
    };
  }
  return nextSides;
}

function grudgeTriggered(state: BattleState, action: MoveAction, resolution: MoveResolution): boolean {
  if (resolution.hit === false) return false;
  return action.targetIds.some(targetId => {
    const target = getPokemon(state, targetId);
    const damage = resolution.damageByTarget?.[targetId] || 0;
    const outcome = target
      ? applyDamageSequence(target, resolution.hitDamageByTarget?.[targetId] || [damage])
      : undefined;
    return !!target && targetId !== action.actorId && target.hp.current > 0 && damage > 0 &&
      !!target.volatile?.grudge && !!outcome?.fainted;
  });
}

/** Accumulate direct HP damage for an active Bide user after Substitute/Endure. */
function accumulateBideDamage(
  state: BattleState,
  sides: BattleState['sides'],
  actorId: string,
  damageByTarget: Record<string, number> | undefined,
  hitDamageByTarget?: Record<string, number[]>,
): BattleState['sides'] {
  if (!damageByTarget) return sides;
  const nextSides = {...sides};
  for (const [targetId, damage] of Object.entries(damageByTarget)) {
    const target = getPokemon(state, targetId);
    if (!target || targetId === actorId || damage <= 0 || !target.volatile?.bide) continue;
    const actualDamage = applyDamageSequence(
      target,
      hitDamageByTarget?.[targetId] || [damage],
    ).directDamage;
    if (actualDamage <= 0) continue;
    const targetSide = sideForPokemon(state, targetId);
    nextSides[targetSide] = {
      ...nextSides[targetSide],
      party: nextSides[targetSide].party.map(pokemon => pokemon.id !== targetId
        ? pokemon
        : {
          ...pokemon,
          volatile: {
            ...(pokemon.volatile || {}),
            bide: {
              ...(pokemon.volatile?.bide || {}),
              damage: (pokemon.volatile?.bide?.damage || 0) + actualDamage,
              sourceId: actorId,
            },
          },
        }),
    };
  }
  return nextSides;
}

function updateLastDamageTaken(
  state: BattleState,
  action: MoveAction,
  damageByTarget: Record<string, number> | undefined,
  hitDamageByTarget: Record<string, number[]> | undefined,
  current: Record<string, LastDamageTaken> | undefined,
): Record<string, LastDamageTaken> | undefined {
  const category = getMoveMetadata(action.moveName, state.generation).category;
  if (!category || !damageByTarget) return current;
  const next = {...(current || {})};
  for (const [targetId, damage] of Object.entries(damageByTarget)) {
    const target = getPokemon(state, targetId);
    if (!target || targetId === action.actorId || damage <= 0) continue;
    const actualDamage = applyDamageSequence(target, hitDamageByTarget?.[targetId] || [damage]).directDamage;
    if (actualDamage <= 0) continue;
    next[targetId] = {
      damage: actualDamage,
      category,
      sourceId: action.actorId,
      moveName: action.moveName,
      turn: state.turn,
    };
  }
  return Object.keys(next).length ? next : undefined;
}

function mergeVolatile(
  current: BattleState['sides'][SideId]['party'][number]['volatile'],
  delta: Partial<Record<VolatileStatusName, VolatileState | null>>,
) {
  const result = {...(current || {})} as Partial<Record<VolatileStatusName, VolatileState>>;
  for (const [name, value] of Object.entries(delta) as Array<[
    VolatileStatusName,
    VolatileState | null,
  ]>) {
    if (value === null) delete result[name];
    else result[name] = {...(result[name] || {}), ...value};
  }
  return Object.keys(result).length ? result : undefined;
}

function clearInactiveCommanderLinks(sides: BattleState['sides']): BattleState['sides'] {
  const byId = new Map<string, BattleState['sides'][SideId]['party'][number]>();
  const activeIds = new Set<string>();
  for (const sideId of ['ai', 'player'] as SideId[]) {
    for (const pokemon of sides[sideId].party) byId.set(pokemon.id, pokemon);
    for (const pokemonId of sides[sideId].activeIds) activeIds.add(pokemonId);
  }
  const linkedSourceActive = (sourceId: string | undefined) => {
    const source = sourceId ? byId.get(sourceId) : undefined;
    return !!source && source.hp.current > 0 && activeIds.has(source.id);
  };
  const cleanParty = (party: BattleState['sides'][SideId]['party']) => party.map(pokemon => {
    let volatile = pokemon.volatile;
    if (volatile?.commanding && (pokemon.hp.current <= 0 || !linkedSourceActive(volatile.commanding.sourceId))) {
      volatile = mergeVolatile(volatile, {commanding: null});
    }
    if (volatile?.commanded && (pokemon.hp.current <= 0 || !linkedSourceActive(volatile.commanded.sourceId))) {
      volatile = mergeVolatile(volatile, {commanded: null});
    }
    return volatile === pokemon.volatile ? pokemon : {...pokemon, volatile};
  });
  return {
    ...sides,
    ai: {...sides.ai, party: cleanParty(sides.ai.party)},
    player: {...sides.player, party: cleanParty(sides.player.party)},
  };
}

function mergeDurations<T extends string>(
  current: Partial<Record<T, number>> | undefined,
  delta: Partial<Record<T, number | null>>,
) {
  const result = {...(current || {})} as Partial<Record<T, number>>;
  for (const [name, value] of Object.entries(delta) as Array<[T, number | null]>) {
    if (value === null) delete result[name];
    else result[name] = value;
  }
  return Object.keys(result).length ? result : undefined;
}

function decrementVolatile(state: BattleState, pokemon: BattleState['sides'][SideId]['party'][number]) {
  if (!pokemon.volatile) return pokemon;
  const volatile = {...pokemon.volatile};
  for (const [name, effect] of Object.entries(volatile) as Array<[VolatileStatusName, VolatileState]>) {
    if (effect.turns === undefined) continue;
    // Cud Chew owns its countdown through the active ability. A suppressed
    // ability does not advance the delayed Berry re-eat.
    if (name === 'cudChew' && !isAbilityActive(pokemon, state)) continue;
    const turns = effect.turns - 1;
    if (turns <= 0) delete volatile[name];
    else volatile[name] = {...effect, turns};
  }
  return {...pokemon, volatile: Object.keys(volatile).length ? volatile : undefined};
}

function decrementSleep(
  state: BattleState,
  pokemon: BattleState['sides'][SideId]['party'][number],
  generation: BattleState['generation'],
) {
  // Sleep burns on the action attempt now (Gen 8 semantics, applied in the
  // move engine's action gate). The boundary leaves the counter alone; this
  // shim survives only so unrelated duration bookkeeping keeps its shape.
  void state; void generation;
  return pokemon;
}

function decrementSideDurations(state: BattleState, side: BattleState['sides'][SideId]) {
  const effects = {...(side.effects || {})};
  const durations = {...(side.effectDurations || {})};
  for (const [name, duration] of Object.entries(durations) as Array<[TimedSideEffectName, number]>) {
    const turns = duration - 1;
    if (turns <= 0) {
      delete durations[name];
      delete effects[name];
    } else {
      durations[name] = turns;
    }
  }
  if (side.effects) {
    effects.protected = false;
    effects.helpingHand = false;
    effects.wideGuard = false;
    effects.quickGuard = false;
    effects.matBlock = false;
  }
  return {
    ...side,
    party: side.party.map(pokemon => side.activeIds.includes(pokemon.id)
      ? decrementSleep(state, decrementVolatile(state, pokemon), state.generation)
      : pokemon),
    effects: Object.keys(effects).length ? effects : undefined,
    effectDurations: Object.keys(durations).length ? durations : undefined,
  };
}

function decrementFieldDurations(field: BattleState['field']) {
  const next = {...field};
  const durations = {...(field.durations || {})};
  for (const [name, duration] of Object.entries(durations) as Array<[TimedFieldName, number]>) {
    const turns = duration - 1;
    if (turns <= 0) {
      delete durations[name];
      delete next[name];
    } else {
      durations[name] = turns;
    }
  }
  next.durations = Object.keys(durations).length ? durations : undefined;
  return next;
}

function updateMimicryAfterTerrainChange(
  state: BattleState,
  sides: BattleState['sides'],
  terrain: BattleState['field']['terrain'],
): BattleState['sides'] {
  if (state.field.terrain === terrain) return sides;
  const override = mimicryTypeOverride(terrain);
  const nextSides = {...sides};
  for (const sideId of ['ai', 'player'] as SideId[]) {
    nextSides[sideId] = {
      ...nextSides[sideId],
      party: nextSides[sideId].party.map(pokemon =>
        nextSides[sideId].activeIds.includes(pokemon.id) && pokemon.hp.current > 0 && isMimicryActive(state, pokemon)
          ? {...pokemon, typeOverride: override === null ? undefined : override}
          : pokemon),
    };
  }
  return nextSides;
}

function updateForecastAfterWeatherChange(
  state: BattleState,
  sides: BattleState['sides'],
  weather: BattleState['field']['weather'],
): BattleState['sides'] {
  if (state.field.weather === weather) return sides;
  const nextState = {...state, field: {...state.field, weather}};
  const nextSides = {...sides};
  for (const sideId of ['ai', 'player'] as SideId[]) {
    nextSides[sideId] = {
      ...nextSides[sideId],
      party: nextSides[sideId].party.map(pokemon => {
        if (!nextSides[sideId].activeIds.includes(pokemon.id) || pokemon.hp.current <= 0) return pokemon;
        const override = weatherFormSpeciesOverride(nextState, pokemon, weather);
        return override === undefined ? pokemon : {...pokemon, speciesOverride: override || undefined};
      }),
    };
  }
  return nextSides;
}

function decrementDelayedMoves(delayedMoves: DelayedMoveState[] | undefined) {
  if (!delayedMoves?.length) return delayedMoves;
  return delayedMoves.map(delayed => ({...delayed, turns: Math.max(1, delayed.turns - 1)}));
}

export function applySwitchAction(
  state: BattleState,
  action: SwitchAction,
  options: SwitchEntryOptions = {},
): BattleState {
  const sideId = sideForPokemon(state, action.actorId);
  const side = state.sides[sideId];
  const actor = getPokemon(state, action.actorId);
  const replacement = getPokemon(state, action.replacementId);
  const partialTrapSource = actor?.volatile?.partiallyTrapped?.sourceId
    ? getPokemon(state, actor.volatile.partiallyTrapped.sourceId)
    : undefined;
  const permanentTrapSource = actor?.volatile?.trapped?.sourceId
    ? getPokemon(state, actor.volatile.trapped.sourceId)
    : undefined;
  const octolockSource = actor?.volatile?.octolock?.sourceId
    ? getPokemon(state, actor.volatile.octolock.sourceId)
    : undefined;

  const activeIndex = side.activeIds.indexOf(action.actorId);
  const pendingForcedSwitch = state.pendingForcedSwitchIds?.includes(action.actorId) === true;
  const pendingBatonPass = state.pendingBatonPassIds?.includes(action.actorId) === true;
  const pendingSubstitutePass = state.pendingSubstitutePassIds?.includes(action.actorId) === true;
  const pendingReplacement = pendingForcedSwitch || pendingBatonPass || pendingSubstitutePass;
  const legalSwitchMode = state.mode === 'Singles'
    ? side.activeIds.length === 1 && activeIndex === 0
    : side.activeIds.length > 0 && side.activeIds.length <= 2 && activeIndex >= 0 &&
      (action.forced || pendingBatonPass || pendingSubstitutePass ||
        (!pendingReplacement && !!actor && actor.hp.current > 0));
  if (!legalSwitchMode || (action.forced && (action.batonPass || action.preserveSubstitute)) ||
    (action.batonPass && action.preserveSubstitute)) {
    throw new Error('Switch action is not legal in this battle state');
  }
  if (action.batonPass && !pendingBatonPass) {
    throw new Error('Baton Pass switch requires a pending Baton Pass resolution');
  }
  if (action.batonPass && pendingSubstitutePass) {
    throw new Error('Baton Pass switch cannot overlap a pending Shed Tail resolution');
  }
  if (action.preserveSubstitute && !pendingSubstitutePass) {
    throw new Error('Substitute-preserving switch requires a pending Shed Tail resolution');
  }
  if (action.preserveSubstitute && pendingBatonPass) {
    throw new Error('Substitute-preserving switch cannot overlap a pending Baton Pass resolution');
  }
  if (!actor || !replacement || replacement.hp.current <= 0 ||
    !(action.batonPass
      ? pendingBatonPass && !pendingForcedSwitch && actor.hp.current > 0
      : action.preserveSubstitute
        ? pendingSubstitutePass && !pendingForcedSwitch && actor.hp.current > 0
      : action.forced
        ? pendingForcedSwitch || actor.hp.current <= 0
        : !pendingReplacement && actor.hp.current > 0) ||
    !side.party.some(pokemon => pokemon.id === replacement.id) ||
    side.activeIds.includes(replacement.id)) {
    throw new Error('Switch action references an unavailable replacement');
  }
  if (actor.hp.current > 0 && actor.volatile?.ingrain) {
    throw new Error('Ingrain prevents the active Pokémon from switching');
  }
  if (actor.hp.current > 0 && (actor.volatile?.commanding || actor.volatile?.commanded)) {
    throw new Error('Commander prevents the active Pokemon from switching');
  }
  if (actor.hp.current > 0 && !action.forced && !canEscapeTrappingEffect(state, actor, 'trapped') && actor.volatile?.trapped &&
    (!actor.volatile.trapped.sourceId || (permanentTrapSource?.hp.current || 0) > 0)) {
    throw new Error('the active Pokémon is trapped and cannot switch');
  }
  if (actor.hp.current > 0 && !action.forced && !canEscapeTrappingEffect(state, actor, 'partiallyTrapped') && actor.volatile?.partiallyTrapped &&
    (partialTrapSource?.hp.current || 0) > 0) {
    throw new Error('the active Pokemon is partially trapped and cannot switch');
  }
  if (actor.hp.current > 0 && !action.forced && !canEscapeTrappingEffect(state, actor, 'octolock') && actor.volatile?.octolock &&
    (octolockSource?.hp.current || 0) > 0) {
    throw new Error('the active Pokemon is trapped by Octolock and cannot switch');
  }
  if (actor.hp.current > 0 && !action.forced && isSwitchBlockedByAbility(state, actor.id)) {
    throw new Error('an opposing trapping ability prevents switching');
  }
  if (actor.hp.current > 0 && !action.forced && !pendingBatonPass && !pendingSubstitutePass && state.field.fairyLock) {
    throw new Error('Fairy Lock prevents voluntary switching');
  }
  if (action.batonPass && !actor.moves.some(move => move.name.toLowerCase().replace(/[^a-z0-9]/g, '') === 'batonpass')) {
    throw new Error('Baton Pass switch requires the outgoing Pokémon to know Baton Pass');
  }

  const resetActor = resetSwitchState(actor);
  const naturalCure = actor.hp.current > 0 && isAbilityActive(actor, state) &&
    isAbilityAvailable(state.generation, getEffectiveAbility(actor)) &&
    moveId(getEffectiveAbility(actor)) === 'naturalcure';
  const regeneratorHp = actor.hp.current > 0 &&
    isAbilityActive(actor, state) && isAbilityAvailable(state.generation, getEffectiveAbility(actor)) &&
    moveId(getEffectiveAbility(actor)) === 'regenerator'
    ? Math.min(actor.hp.max, actor.hp.current + Math.floor(actor.hp.max / 3))
    : undefined;
  const switchedActor = {
    ...resetActor,
    rageFistHits: undefined,
    ...(state.generation >= 9 && isAbilityActive(actor, state) &&
      isAbilityAvailable(state.generation, getEffectiveAbility(actor)) &&
      moveId(getEffectiveAbility(actor)) === 'zerotohero' && moveId(actor.species) === 'palafin'
      ? {zeroToHeroTriggered: true}
      : {}),
    ...(naturalCure ? {status: '', statusTurns: undefined, toxicCounter: undefined} : {}),
    ...(regeneratorHp === undefined ? {} : {hp: {...resetActor.hp, current: regeneratorHp}}),
  };
  const resetReplacement = {
    ...resetSleepOnEntry(resetSwitchState(replacement)),
    rageFistHits: undefined,
  };
  const batonPassReplacement = action.batonPass
    ? {
      ...resetReplacement,
      boosts: actor.boosts,
      substituteHp: actor.substituteHp,
    }
    : resetReplacement;
  const replacementWithPassedState = action.preserveSubstitute
    ? {...resetReplacement, substituteHp: actor.substituteHp}
    : batonPassReplacement;

  const switched = {
    ...state,
    sides: {
      ...state.sides,
      [sideId]: {
        ...replaceActive(side, actor.id, replacement.id, state.mode),
        party: side.party.map(pokemon =>
          pokemon.id === actor.id
            ? switchedActor
            : pokemon.id === replacement.id
              ? replacementWithPassedState
              : (pokemon.volatile?.partiallyTrapped?.sourceId === actor.id ||
                pokemon.volatile?.trapped?.sourceId === actor.id ||
                pokemon.volatile?.octolock?.sourceId === actor.id)
                ? {...pokemon, volatile: mergeVolatile(pokemon.volatile, {
                  partiallyTrapped: null,
                  trapped: null,
                  octolock: null,
                })}
              : pokemon),
      },
    },
    firstTurnOutIds: [
      ...(state.firstTurnOutIds || []).filter(id => id !== actor.id && id !== replacement.id),
      replacement.id,
    ],
    choiceLockByPokemon: (() => {
      const locks = {...(state.choiceLockByPokemon || {})};
      delete locks[actor.id];
      delete locks[replacement.id];
      return Object.keys(locks).length ? locks : undefined;
    })(),
    lastMoveTargetedByPokemon: (() => {
      const moves = {...(state.lastMoveTargetedByPokemon || {})};
      delete moves[actor.id];
      delete moves[replacement.id];
      return Object.keys(moves).length ? moves : undefined;
    })(),
    lastMoveUsedByPokemon: (() => {
      const moves = {...(state.lastMoveUsedByPokemon || {})};
      delete moves[actor.id];
      delete moves[replacement.id];
      return Object.keys(moves).length ? moves : undefined;
    })(),
    lastMoveTargetIdsByPokemon: (() => {
      const targets = {...(state.lastMoveTargetIdsByPokemon || {})};
      delete targets[actor.id];
      delete targets[replacement.id];
      return Object.keys(targets).length ? targets : undefined;
    })(),
    lastDamagingMoveByPokemon: (() => {
      const moves = {...(state.lastDamagingMoveByPokemon || {})};
      delete moves[actor.id];
      delete moves[replacement.id];
      return Object.keys(moves).length ? moves : undefined;
    })(),
    lastDamageTakenByPokemon: (() => {
      const damage = {...(state.lastDamageTakenByPokemon || {})};
      delete damage[actor.id];
      delete damage[replacement.id];
      return Object.keys(damage).length ? damage : undefined;
    })(),
    selectedMoveByPokemon: (() => {
      const selected = {...(state.selectedMoveByPokemon || {})};
      delete selected[actor.id];
      delete selected[replacement.id];
      return Object.keys(selected).length ? selected : undefined;
    })(),
    pendingPledgeBySide: (() => {
      const pending = {...(state.pendingPledgeBySide || {})};
      delete pending[sideId];
      return Object.keys(pending).length ? pending : undefined;
    })(),
    moveStreakByPokemon: (() => {
      const streaks = {...(state.moveStreakByPokemon || {})};
      delete streaks[actor.id];
      delete streaks[replacement.id];
      return Object.keys(streaks).length ? streaks : undefined;
    })(),
    pendingForcedSwitchIds: (() => {
      const pending = new Set(state.pendingForcedSwitchIds || []);
      pending.delete(actor.id);
      return pending.size ? Array.from(pending) : undefined;
    })(),
    pendingBatonPassIds: (() => {
      const pending = new Set(state.pendingBatonPassIds || []);
      pending.delete(actor.id);
      return pending.size ? Array.from(pending) : undefined;
    })(),
    pendingSubstitutePassIds: (() => {
      const pending = new Set(state.pendingSubstitutePassIds || []);
      pending.delete(actor.id);
      return pending.size ? Array.from(pending) : undefined;
    })(),
  };
  const trapReleasedSides = {...switched.sides};
  for (const candidateSideId of ['ai', 'player'] as SideId[]) {
    const candidateSide = trapReleasedSides[candidateSideId];
    trapReleasedSides[candidateSideId] = {
      ...candidateSide,
      party: candidateSide.party.map(pokemon =>
        (pokemon.volatile?.partiallyTrapped?.sourceId === actor.id ||
          pokemon.volatile?.trapped?.sourceId === actor.id ||
          pokemon.volatile?.octolock?.sourceId === actor.id)
          ? {...pokemon, volatile: mergeVolatile(pokemon.volatile, {
            partiallyTrapped: null,
            trapped: null,
            octolock: null,
          })}
          : pokemon),
    };
  }
  return applySwitchEntryResolution(
    {...switched, sides: trapReleasedSides}, sideId, replacement.id, deriveSwitchEntryResolution(state, action, options),
  );
}

/**
 * Record bookkeeping that is safe before a separate battle engine resolves a
 * move. This deliberately does not apply damage, status, boosts, hazards, or
 * secondary-effect probabilities.
 */
export function recordMoveAction(state: BattleState, action: MoveAction): BattleState {
  const sideId = sideForPokemon(state, action.actorId);
  const side = state.sides[sideId];
  const actor = getPokemon(state, action.actorId);
  const move = actor?.moves.find(candidate => candidate.name === action.moveName);
  const isStruggle = moveId(action.moveName) === 'struggle';
  const isEnumerated = enumerateMoveActions(state, sideId)
    .some(candidate => actionKey(candidate) === actionKey(action));

  if (!actor || !side.activeIds.includes(actor.id) || actor.hp.current <= 0 ||
    (!isStruggle && !move) || (!isStruggle && !actor.volatile?.recharge && (move!.disabled || move!.pp === 0)) ||
    !isEnumerated) {
    throw new Error('Move action is not legal in this battle state');
  }

  // A recharge action consumes the turn without spending PP or rewriting the
  // previous move history; the resolution boundary clears the volatile.
  if (actor.volatile?.recharge) return state;
  const recordedMoveName = move?.name || action.moveName;
  const isChargeRelease = !!actor.volatile?.charge;
  const ppCost = move && move.pp !== undefined
    ? isChargeRelease ? 0 : 1 + pressureTargetCount(state, actor, action.targetIds)
    : 0;
  const moveAfterUse = move && move.pp !== undefined
    ? Math.max(0, move.pp - ppCost)
    : undefined;
  const leppaRestores = !!move && moveAfterUse === 0 && isLeppaActive(state, actor);
  const leppaMaxPP = leppaRestores
    ? move!.maxPP ?? getMoveMaxPP(move!.name, state.generation)
    : undefined;
  const leppaPP = leppaRestores
    ? Math.min(leppaMaxPP ?? Number.POSITIVE_INFINITY, isRipenActive(state, actor) ? 20 : 10)
    : undefined;
  const leppaCheekPouch = leppaRestores && isCheekPouchActive(state, actor) && !actor.volatile?.healBlock;
  const leppaCudChew = leppaRestores && isCudChewActive(state, actor);

  const nextParty = side.party.map(pokemon => {
    if (pokemon.id !== actor.id) return pokemon;
    return {
      ...pokemon,
      ...(leppaCheekPouch ? {
        hp: {...pokemon.hp, current: Math.min(pokemon.hp.max, pokemon.hp.current + Math.floor(pokemon.hp.max / 3))},
      } : {}),
      moves: pokemon.moves.map(candidate => !isStruggle && candidate.name === action.moveName
        ? {
          ...candidate,
          pp: candidate.pp === undefined
            ? undefined
            : leppaRestores && leppaPP !== undefined
              ? leppaPP
              : Math.max(0, candidate.pp - ppCost),
          timesUsed: (candidate.timesUsed || 0) + 1,
        }
        : candidate),
      ...(leppaRestores
        ? {
          item: undefined,
          itemLost: true,
          lastConsumedItem: actor.item,
          ...(leppaCudChew
            ? {volatile: mergeVolatile(pokemon.volatile, {cudChew: {turns: 2, item: actor.item!}})}
            : {}),
        }
        : {}),
    };
  });
  const choiceLocks = {...(state.choiceLockByPokemon || {})};
  if (move && isChoiceItem(actor, state)) choiceLocks[actor.id] = move.name;
  else delete choiceLocks[actor.id];

  return {
    ...state,
    sides: {
      ...state.sides,
      [sideId]: {...side, party: nextParty},
    },
    lastMoveByPokemon: {
      ...(state.lastMoveByPokemon || {}),
      [actor.id]: recordedMoveName,
    },
    lastMoveUsedByPokemon: {
      ...(state.lastMoveUsedByPokemon || {}),
      [actor.id]: recordedMoveName,
    },
    lastMoveTargetIdsByPokemon: {
      ...(state.lastMoveTargetIdsByPokemon || {}),
      [actor.id]: [...action.targetIds],
    },
    lastMoveUsed: recordedMoveName,
    selectedMoveByPokemon: (() => {
      const selected = {...(state.selectedMoveByPokemon || {})};
      delete selected[actor.id];
      return Object.keys(selected).length ? selected : undefined;
    })(),
    moveStreakByPokemon: {
      ...(state.moveStreakByPokemon || {}),
      [actor.id]: {
        moveName: recordedMoveName,
        count: state.moveStreakByPokemon?.[actor.id]?.moveName === recordedMoveName
          ? state.moveStreakByPokemon[actor.id].count + 1
          : 1,
      },
    },
    choiceLockByPokemon: Object.keys(choiceLocks).length ? choiceLocks : undefined,
  };
}

/**
 * Apply already-resolved damage to the targets of a legal move. The caller is
 * responsible for selecting a roll and for resolving all other move effects.
 */
export function applyDamageAction(
  state: BattleState,
  action: MoveAction,
  damageByTarget: Record<string, number>,
): BattleState {
  const targetIds = new Set(action.targetIds);
  for (const targetId of Object.keys(damageByTarget)) {
    if (!targetIds.has(targetId)) throw new Error('Damage references a non-target of the move');
    const damage = damageByTarget[targetId];
    if (!Number.isFinite(damage) || damage < 0) throw new Error('Damage must be a finite non-negative number');
    if (!getPokemon(state, targetId)) throw new Error('Damage references an unknown PokÃ©mon');
  }

  const recorded = recordMoveAction(state, action);
  const actor = getPokemon(state, action.actorId);
  if (actor && isTruantActive(state, actor) && actor.volatile?.truant) {
    throw new Error('Truant prevents the active PokÃ©mon from acting this turn');
  }
  let sides = {...recorded.sides};
  for (const sideId of ['ai', 'player'] as SideId[]) {
    const side = sides[sideId];
    sides[sideId] = {
      ...side,
      party: side.party.map(pokemon => {
        const damage = damageByTarget[pokemon.id];
        if (damage === undefined) return pokemon;
        return applyDamageToPokemon(pokemon, damage);
      }),
    };
  }
  sides = clearInactiveCommanderLinks(
    accumulateBideDamage(state, sides, action.actorId, damageByTarget),
  );
  sides = applyRageFistHits(state, sides, action, damageByTarget);
  if (actor && isTruantActive(state, actor)) {
    const actorSide = sideForPokemon(state, actor.id);
    sides[actorSide] = {
      ...sides[actorSide],
      party: sides[actorSide].party.map(pokemon => pokemon.id === actor.id
        ? {...pokemon, volatile: {...(pokemon.volatile || {}), truant: {}}}
        : pokemon),
    };
  }

  return {
    ...recorded,
    sides,
    lastDamageTakenByPokemon: updateLastDamageTaken(
      state, action, damageByTarget, undefined, recorded.lastDamageTakenByPokemon,
    ),
    lastDamagingMoveByPokemon: Object.keys(damageByTarget).length
      ? {
        ...(recorded.lastDamagingMoveByPokemon || {}),
        ...Object.fromEntries(Object.keys(damageByTarget).map(targetId => [targetId, action.moveName])),
      }
      : recorded.lastDamagingMoveByPokemon,
    lastMoveTargetedByPokemon: action.targetIds.some(targetId => targetId !== action.actorId)
      ? {
        ...(recorded.lastMoveTargetedByPokemon || {}),
        ...Object.fromEntries(action.targetIds
          .filter(targetId => targetId !== action.actorId)
          .map(targetId => [targetId, action.moveName])),
      }
      : recorded.lastMoveTargetedByPokemon,
  };
}

function clampBoost(value: number): number {
  return Math.max(-6, Math.min(6, value));
}

function mergeBoosts(current: StatBoosts | undefined, delta: StatBoosts): StatBoosts {
  const result = {...(current || {})};
  for (const stat of Object.keys(delta) as Array<keyof StatBoosts>) {
    const amount = delta[stat];
    if (amount === undefined) continue;
    result[stat] = clampBoost((result[stat] || 0) + amount);
  }
  return result;
}

function compactBoosts(boosts: StatBoosts | undefined): StatBoosts | undefined {
  if (!boosts) return undefined;
  const result: StatBoosts = {};
  for (const [stat, value] of Object.entries(boosts) as Array<[keyof StatBoosts, number]>) {
    if (value) result[stat] = clampBoost(value);
  }
  return Object.keys(result).length ? result : undefined;
}

function recordStatBoostsThisTurn(
  state: BattleState,
  resolution: MoveResolution,
): Record<string, StatBoosts> | undefined {
  const recorded = {...(state.statBoostsThisTurnByPokemon || {})};
  const pokemonIds = [
    ...Object.keys(resolution.boostsByPokemon || {}),
    ...Object.keys(resolution.setBoostsByPokemon || {}),
  ].filter((pokemonId, index, ids) => ids.indexOf(pokemonId) === index);
  for (const pokemonId of pokemonIds) {
    const pokemon = getPokemon(state, pokemonId);
    if (!pokemon) continue;
    const previous = pokemon.boosts || {};
    const additive = resolution.boostsByPokemon?.[pokemonId] || {};
    const absolute = resolution.setBoostsByPokemon?.[pokemonId];
    const positive: StatBoosts = {};
    const statIds = [
      ...Object.keys(additive),
      ...Object.keys(absolute || {}),
    ].filter((stat, index, stats) => stats.indexOf(stat) === index) as Array<keyof StatBoosts>;
    for (const stat of statIds) {
      const additiveAmount = additive[stat] || 0;
      const setValue = absolute?.[stat];
      const previousValue = previous[stat] || 0;
      if (additiveAmount > 0 || (setValue !== undefined && setValue > previousValue)) {
        positive[stat] = Math.max(1, additiveAmount, (setValue || 0) - previousValue);
      }
    }
    if (Object.keys(positive).length) {
      recorded[pokemonId] = {...(recorded[pokemonId] || {}), ...positive};
    }
  }
  return Object.keys(recorded).length ? recorded : undefined;
}

function validatePokemonMap(
  state: BattleState,
  action: MoveAction,
  values: Record<string, unknown> | undefined,
  label: string,
  allowActiveResponses = false,
) {
  if (!values) return;
  const allowed = new Set([action.actorId, ...action.targetIds]);
  if (allowActiveResponses) {
    for (const sideId of ['ai', 'player'] as SideId[]) {
      for (const pokemonId of state.sides[sideId].activeIds) allowed.add(pokemonId);
    }
  }
  if (state.generation < 8 && getMoveMetadata(action.moveName, state.generation).snatchable) {
    for (const sideId of ['ai', 'player'] as SideId[]) {
      for (const pokemon of state.sides[sideId].party) allowed.add(pokemon.id);
    }
  }
  if (moveId(action.moveName) === 'gravity') {
    for (const sideId of ['ai', 'player'] as SideId[]) {
      for (const pokemonId of state.sides[sideId].activeIds) allowed.add(pokemonId);
    }
  }
  for (const id of Object.keys(values)) {
    if (!allowed.has(id) || !getPokemon(state, id)) {
      throw new Error(`${label} references an invalid PokÃ©mon`);
    }
  }
}

function validateMoveList(value: unknown, label: string) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array or null`);
  const names = new Set<string>();
  for (const move of value) {
    if (!move || typeof move !== 'object' || typeof move.name !== 'string' || !move.name) {
      throw new Error(`${label} contains a move without a name`);
    }
    if (names.has(move.name)) throw new Error(`${label} repeats move ${move.name}`);
    names.add(move.name);
    if (move.pp !== undefined && (!Number.isInteger(move.pp) || move.pp < 0)) {
      throw new Error(`${label} ${move.name} PP must be a non-negative integer`);
    }
    if (move.maxPP !== undefined && (!Number.isInteger(move.maxPP) || move.maxPP < 0)) {
      throw new Error(`${label} ${move.name} max PP must be a non-negative integer`);
    }
    if (move.pp !== undefined && move.maxPP !== undefined && move.pp > move.maxPP) {
      throw new Error(`${label} ${move.name} PP exceeds max PP`);
    }
  }
}

function validateDurationMap<T extends string>(
  values: Partial<Record<T, number | null>> | undefined,
  label: string,
) {
  for (const [name, value] of Object.entries(values || {}) as Array<[T, number | null]>) {
    if (value !== null && (!Number.isInteger(value) || value < 0)) {
      throw new Error(`${label} ${name} must be a non-negative integer or null`);
    }
  }
}

function validateVolatileMap(
  state: BattleState,
  action: MoveAction,
  values: MoveResolution['volatileByPokemon'],
) {
  if (!values) return;
  validatePokemonMap(state, action, values, 'Volatile state');
  for (const effects of Object.values(values)) {
    for (const [name, effect] of Object.entries(effects || {}) as Array<[VolatileStatusName, VolatileState | null]>) {
      if (effect && effect.turns !== undefined &&
        (!Number.isInteger(effect.turns) || effect.turns < 0)) {
        throw new Error(`Volatile duration ${name} must be a non-negative integer`);
      }
    }
  }
}

function validateDelayedMoves(
  state: BattleState,
  action: MoveAction,
  values: DelayedMoveState[] | undefined,
) {
  if (!values) return;
  const allowedTargets = new Set(action.targetIds);
  if (state.generation < 8 && getMoveMetadata(action.moveName, state.generation).snatchable) {
    for (const sideId of ['ai', 'player'] as SideId[]) {
      for (const pokemon of state.sides[sideId].party) allowedTargets.add(pokemon.id);
    }
  }
  const existingIds = new Set((state.delayedMoves || []).map(delayed => delayed.id));
  for (const delayed of values) {
    if (!delayed.id || typeof delayed.id !== 'string' || existingIds.has(delayed.id)) {
      throw new Error('Delayed move IDs must be unique and not already scheduled');
    }
    existingIds.add(delayed.id);
    if (delayed.sourceId !== action.actorId || !getPokemon(state, delayed.sourceId)) {
      throw new Error('Delayed move source must be the acting PokÃ©mon');
    }
    if (!delayed.moveName || typeof delayed.moveName !== 'string' ||
      !Number.isInteger(delayed.turns) || delayed.turns < 1) {
      throw new Error('Delayed move name and turns are required');
    }
    if (!delayed.targetIds.length || delayed.targetIds.some(targetId =>
      !allowedTargets.has(targetId) || !getPokemon(state, targetId))) {
      throw new Error('Delayed move targets must be targets of the action');
    }
    for (const [targetId, slot] of Object.entries(delayed.targetSlotsByTarget || {})) {
      if (!delayed.targetIds.includes(targetId) || !Number.isInteger(slot) || slot < 0 ||
        slot >= (state.mode === 'Singles' ? 1 : 2)) {
        throw new Error('Delayed move target slots must identify an active slot');
      }
    }
    for (const [targetId, damage] of Object.entries(delayed.damageByTarget || {})) {
      if (!delayed.targetIds.includes(targetId) || !Number.isFinite(damage) || damage < 0) {
        throw new Error('Delayed move damage must reference a target and be non-negative');
      }
    }
    for (const [targetId, fraction] of Object.entries(delayed.healingByTarget || {})) {
      if (!delayed.targetIds.includes(targetId) || !fraction ||
        !Number.isInteger(fraction.numerator) || fraction.numerator <= 0 ||
        !Number.isInteger(fraction.denominator) || fraction.denominator <= 0) {
        throw new Error('Delayed move healing must reference a target and use a positive fraction');
      }
    }
  }
}

/**
 * Apply a serializable, already-resolved move outcome atomically. This is the
 * integration point for a battle engine: it handles state bookkeeping, while
 * move-specific accuracy, secondary effects, recoil, and turn order remain
 * responsible for producing the resolution object.
 */
export function resolveMoveAction(
  state: BattleState,
  action: MoveAction,
  resolution: MoveResolution,
): BattleState {
  if (resolution.actionFailure !== undefined && !ACTION_FAILURES.has(resolution.actionFailure)) {
    throw new Error(`Unknown action failure ${resolution.actionFailure}`);
  }
  if (resolution.actionFailure !== undefined && resolution.hit !== false) {
    throw new Error('Action failures must be recorded as misses');
  }
  const actor = getPokemon(state, action.actorId);
  const truantActive = actor ? isTruantActive(state, actor) : false;
  const truantLoafing = truantActive && !!actor?.volatile?.truant;
  if (truantLoafing && resolution.actionFailure !== 'truant') {
    throw new Error('Truant requires a truant action failure while loafing');
  }
  if (!truantLoafing && resolution.actionFailure === 'truant') {
    throw new Error('Truant action failure requires an active Truant loafing state');
  }
  resolution = consumeCustapIfNeeded(state, action, resolution);
  const targetIds = new Set(action.targetIds);
  for (const targetId of Object.keys(resolution.damageByTarget || {})) {
    if (!targetIds.has(targetId)) throw new Error('Damage references a non-target of the move');
    const damage = resolution.damageByTarget![targetId];
    if (!Number.isFinite(damage) || damage < 0) throw new Error('Damage must be a finite non-negative number');
  }
  for (const [targetId, hits] of Object.entries(resolution.hitDamageByTarget || {})) {
    if (!targetIds.has(targetId)) throw new Error('Hit damage references a non-target of the move');
    if (!Array.isArray(hits) || hits.length === 0 || hits.some(hit => !Number.isFinite(hit) || hit < 0)) {
      throw new Error('Hit damage must contain finite non-negative values');
    }
    const aggregate = hits.reduce((total, hit) => total + hit, 0);
    if (resolution.damageByTarget?.[targetId] !== aggregate) {
      throw new Error('Hit damage must sum to aggregate target damage');
    }
  }
  if (grudgeTriggered(state, action, resolution)) {
    const actor = getPokemon(state, action.actorId);
    if (actor) {
      const usedMoveId = moveId(action.moveName);
      const currentMoves = resolution.movesByPokemon?.[actor.id] || actor.moves;
      resolution = {
        ...resolution,
        movesByPokemon: {
          ...(resolution.movesByPokemon || {}),
          [actor.id]: currentMoves.map(move => moveId(move.name) === usedMoveId
            ? {...move, pp: 0}
            : move),
        },
      };
    }
  }
  const destinyBondTargets = new Set<string>();
  if (resolution.hit !== false) {
    for (const [targetId, damage] of Object.entries(resolution.damageByTarget || {})) {
      const target = getPokemon(state, targetId);
      const volatileDelta = resolution.volatileByPokemon?.[targetId];
      const destinyBondCleared = volatileDelta &&
        Object.prototype.hasOwnProperty.call(volatileDelta, 'destinyBond') &&
        volatileDelta.destinyBond === null;
      const damageOutcome = target
        ? applyDamageSequence(target, resolution.hitDamageByTarget?.[targetId] || [damage])
        : undefined;
      if (target && targetId !== action.actorId && target.hp.current > 0 &&
        target.volatile?.destinyBond && !destinyBondCleared &&
        !!damageOutcome?.fainted) {
        destinyBondTargets.add(targetId);
      }
    }
  }
  const hpDeltaByPokemon = {...(resolution.hpDeltaByPokemon || {})};
  const volatileByPokemon = {...(resolution.volatileByPokemon || {})};
  if (actor && truantActive) {
    volatileByPokemon[actor.id] = {
      ...(volatileByPokemon[actor.id] || {}),
      truant: truantLoafing ? null : {},
    };
  }
  if (destinyBondTargets.size) {
    hpDeltaByPokemon[action.actorId] = -getPokemon(state, action.actorId)!.hp.current;
    destinyBondTargets.forEach(targetId => {
      volatileByPokemon[targetId] = {
        ...(volatileByPokemon[targetId] || {}),
        destinyBond: null,
      };
    });
  }
  validatePokemonMap(state, action, hpDeltaByPokemon, 'HP delta');
  validatePokemonMap(state, action, resolution.itemByPokemon, 'Item state', true);
  validatePokemonMap(state, action, resolution.allySwitchByPokemon, 'Ally Switch state');
  validatePokemonMap(state, action, resolution.itemCorrodedByPokemon, 'Corroded item state');
  validatePokemonMap(state, action, resolution.abilityOverrideByPokemon, 'Ability override');
  validatePokemonMap(state, action, resolution.noAbilityByPokemon, 'No Ability projection');
  validatePokemonMap(state, action, resolution.abilitySuppressedByPokemon, 'Ability suppression');
  validatePokemonMap(state, action, resolution.speciesOverrideByPokemon, 'Species override');
  validatePokemonMap(state, action, resolution.typeOverrideByPokemon, 'Type override', true);
  validatePokemonMap(state, action, resolution.typeChangeUsedByPokemon, 'Type-change marker');
  validatePokemonMap(state, action, resolution.baseStatsOverrideByPokemon, 'Base-stat override');
  validatePokemonMap(state, action, resolution.statOverridesByPokemon, 'Stat override');
  validatePokemonMap(state, action, resolution.movesByPokemon, 'Move set');
  validatePokemonMap(state, action, resolution.copyMoveByPokemon, 'Copied move');
  validatePokemonMap(state, action, resolution.calledMoveModifiersByPokemon, 'Called move modifiers');
  validatePokemonMap(state, action, resolution.calledMoveTargetIdsByPokemon, 'Called move targets');
  validatePokemonMap(state, action, resolution.calledMoveExternalByPokemon, 'Called move external');
  validatePokemonMap(state, action, resolution.forcedSwitchByPokemon, 'Forced switch');
  validatePokemonMap(state, action, resolution.batonPassByPokemon, 'Baton Pass switch');
  validatePokemonMap(state, action, resolution.substitutePassByPokemon, 'Substitute switch');
  validatePokemonMap(state, action, resolution.consumedItemByPokemon, 'Consumed item', true);
  validatePokemonMap(state, action, resolution.substituteHpByPokemon, 'Substitute HP');
  validatePokemonMap(state, action, resolution.statusByPokemon, 'Status');
  validatePokemonMap(state, action, resolution.statusTurnsByPokemon, 'Status turns');
  validatePokemonMap(state, action, resolution.disguiseBrokenByPokemon, 'Disguise state');
  validatePokemonMap(state, action, resolution.isSaltCureByPokemon, 'Salt Cure state');
  validatePokemonMap(state, action, resolution.toxicCounterByPokemon, 'Toxic counter');
  validatePokemonMap(state, action, resolution.boostsByPokemon, 'Boost', true);
  validatePokemonMap(state, action, resolution.resetBoostsByPokemon, 'Boost reset');
  validatePokemonMap(state, action, resolution.setBoostsByPokemon, 'Boost set');
  for (const [id, swap] of Object.entries(resolution.allySwitchByPokemon || {})) {
    if (typeof swap !== 'boolean') throw new Error(`Ally Switch state for ${id} must be boolean`);
    if (!swap) continue;
    if (resolution.hit === false || id !== action.actorId || state.mode !== 'Doubles') {
      throw new Error(`Ally Switch state for ${id} requires a successful Doubles move by the actor`);
    }
    const sideId = sideForPokemon(state, id);
    const side = state.sides[sideId];
    if (!side.activeIds.includes(id) || !side.activeIds.some(allyId =>
      allyId !== id && (getPokemon(state, allyId)?.hp.current || 0) > 0)) {
      throw new Error(`Ally Switch state for ${id} requires a live active ally`);
    }
  }
  for (const [sideId, pending] of Object.entries(resolution.pendingFullHealBySide || {})) {
    if (!['ai', 'player'].includes(sideId) || typeof pending !== 'boolean') {
      throw new Error('Pending full-heal side state is invalid');
    }
  }
  validateVolatileMap(state, action, volatileByPokemon);
  validateDelayedMoves(state, action, resolution.delayedMoves);
  for (const sideId of ['ai', 'player'] as SideId[]) {
    validateDurationMap(resolution.sideEffectDurationsBySide?.[sideId], 'Side effect duration');
  }
  validateDurationMap(resolution.fieldDurations, 'Field duration');
  for (const [id, delta] of Object.entries(hpDeltaByPokemon)) {
    if (!Number.isFinite(delta)) throw new Error(`HP delta for ${id} must be finite`);
  }
  for (const [id, item] of Object.entries(resolution.itemByPokemon || {})) {
    if (item !== null && (typeof item !== 'string' || !item)) {
      throw new Error(`Item state for ${id} must be a non-empty item name or null`);
    }
  }
  for (const [id, corroded] of Object.entries(resolution.itemCorrodedByPokemon || {})) {
    if (corroded !== null && typeof corroded !== 'boolean') {
      throw new Error(`Corroded item state for ${id} must be boolean or null`);
    }
  }
  for (const [id, types] of Object.entries(resolution.typeOverrideByPokemon || {})) {
    if (types !== null && (!Array.isArray(types) || types.length > 3 ||
      types.some(type => typeof type !== 'string' || !type))) {
      throw new Error(`Type override for ${id} must contain zero to three non-empty type names`);
    }
    if (types !== null && new Set(types.map(type => type.toLowerCase())).size !== types.length) {
      throw new Error(`Type override for ${id} cannot contain duplicate types`);
    }
  }
  for (const [id, ability] of Object.entries(resolution.abilityOverrideByPokemon || {})) {
    if (ability !== null && (typeof ability !== 'string' || !ability)) {
      throw new Error(`Ability override for ${id} must be a non-empty ability name or null`);
    }
  }
  for (const [id, noAbility] of Object.entries(resolution.noAbilityByPokemon || {})) {
    if (typeof noAbility !== 'boolean') throw new Error(`No Ability projection for ${id} must be boolean`);
  }
  for (const [id, suppressed] of Object.entries(resolution.abilitySuppressedByPokemon || {})) {
    if (suppressed !== null && typeof suppressed !== 'boolean') {
      throw new Error(`Ability suppression for ${id} must be boolean or null`);
    }
  }
  for (const [id, species] of Object.entries(resolution.speciesOverrideByPokemon || {})) {
    if (species !== null && (typeof species !== 'string' || !species)) {
      throw new Error(`Species override for ${id} must be a non-empty species name or null`);
    }
  }
  for (const [id, baseStats] of Object.entries(resolution.baseStatsOverrideByPokemon || {})) {
    if (baseStats !== null) {
      for (const [stat, value] of Object.entries(baseStats)) {
        if (!['hp', 'atk', 'def', 'spa', 'spd', 'spe'].includes(stat) ||
          !Number.isInteger(value) || value < 0 || value > 255) {
          throw new Error(`Base-stat override ${stat} for ${id} must be an integer from 0 to 255`);
        }
      }
    }
  }
  for (const [id, stats] of Object.entries(resolution.statOverridesByPokemon || {})) {
    if (stats !== null) {
      for (const [stat, value] of Object.entries(stats)) {
        if (!['hp', 'atk', 'def', 'spa', 'spd', 'spe'].includes(stat) ||
          !Number.isInteger(value) || value < 0 || value > 10000) {
          throw new Error(`Stat override ${stat} for ${id} must be an integer from 0 to 10000`);
        }
      }
    }
  }
  for (const [id, moves] of Object.entries(resolution.movesByPokemon || {})) {
    if (moves !== null) validateMoveList(moves, `Move set for ${id}`);
  }
  for (const [id, moveName] of Object.entries(resolution.copyMoveByPokemon || {})) {
    if (moveName !== null && (typeof moveName !== 'string' || !moveName)) {
      throw new Error(`Copied move for ${id} must be a non-empty move name or null`);
    }
  }
  for (const [id, moveName] of Object.entries(resolution.calledMoveByPokemon || {})) {
    if (moveName !== null && (typeof moveName !== 'string' || !moveName)) {
      throw new Error(`Called move for ${id} must be a non-empty move name or null`);
    }
  }
  for (const [id, modifiers] of Object.entries(resolution.calledMoveModifiersByPokemon || {})) {
    if (!modifiers || typeof modifiers !== 'object') throw new Error(`Called move modifiers for ${id} must be an object`);
    if (modifiers.powerMultiplier !== undefined &&
      (!Number.isFinite(modifiers.powerMultiplier) || modifiers.powerMultiplier <= 0)) {
      throw new Error(`Called move power multiplier for ${id} must be positive and finite`);
    }
    if (modifiers.bypassAccuracy !== undefined && typeof modifiers.bypassAccuracy !== 'boolean') {
      throw new Error(`Called move accuracy override for ${id} must be boolean`);
    }
  }
  for (const [id, targetIds] of Object.entries(resolution.calledMoveTargetIdsByPokemon || {})) {
    if (!Array.isArray(targetIds) || targetIds.some(targetId => !getPokemon(state, targetId))) {
      throw new Error(`Called move targets for ${id} must contain known Pokémon IDs`);
    }
  }
  for (const [id, forced] of Object.entries(resolution.forcedSwitchByPokemon || {})) {
    if (typeof forced !== 'boolean') throw new Error(`Forced switch for ${id} must be boolean`);
    if (forced) {
      const sideId = sideForPokemon(state, id);
      if (!state.sides[sideId].activeIds.includes(id)) throw new Error(`Forced switch for ${id} requires an active Pokémon`);
    }
  }
  for (const [id, batonPass] of Object.entries(resolution.batonPassByPokemon || {})) {
    if (typeof batonPass !== 'boolean') throw new Error(`Baton Pass switch for ${id} must be boolean`);
    if (batonPass) {
      const pokemon = getPokemon(state, id);
      const sideId = pokemon ? sideForPokemon(state, id) : undefined;
      if (!pokemon || pokemon.hp.current <= 0 || !state.sides[sideId!].activeIds.includes(id)) {
        throw new Error(`Baton Pass switch for ${id} requires a living active Pokémon`);
      }
    }
  }
  for (const [id, substitutePass] of Object.entries(resolution.substitutePassByPokemon || {})) {
    if (typeof substitutePass !== 'boolean') throw new Error(`Substitute switch for ${id} must be boolean`);
    if (substitutePass) {
      const pokemon = getPokemon(state, id);
      const sideId = pokemon ? sideForPokemon(state, id) : undefined;
      const pendingSubstituteHp = resolution.substituteHpByPokemon?.[id];
      if (!pokemon || pokemon.hp.current <= 0 ||
        (!pokemon.substituteHp && (!pendingSubstituteHp || pendingSubstituteHp <= 0)) ||
        !state.sides[sideId!].activeIds.includes(id)) {
        throw new Error(`Substitute switch for ${id} requires a living active Pokémon with a Substitute`);
      }
    }
  }
  for (const [id, item] of Object.entries(resolution.consumedItemByPokemon || {})) {
    if (item !== null && (typeof item !== 'string' || !item)) {
      throw new Error(`Consumed item for ${id} must be a non-empty item name or null`);
    }
  }
  for (const [id, substituteHp] of Object.entries(resolution.substituteHpByPokemon || {})) {
    if (substituteHp !== null && (!Number.isInteger(substituteHp) || substituteHp < 0)) {
      throw new Error(`Substitute HP for ${id} must be a non-negative integer or null`);
    }
  }
  for (const [id, counter] of Object.entries(resolution.toxicCounterByPokemon || {})) {
    if (!Number.isFinite(counter) || counter < 0) throw new Error(`Toxic counter for ${id} must be non-negative`);
  }
  for (const [id, turns] of Object.entries(resolution.statusTurnsByPokemon || {})) {
    if (turns !== null && (!Number.isInteger(turns) || turns < 0)) {
      throw new Error(`Status turns for ${id} must be a non-negative integer or null`);
    }
  }
  for (const [id, broken] of Object.entries(resolution.disguiseBrokenByPokemon || {})) {
    if (typeof broken !== 'boolean') throw new Error(`Disguise state for ${id} must be boolean`);
  }
  for (const [id, saltCure] of Object.entries(resolution.isSaltCureByPokemon || {})) {
    if (saltCure !== null && typeof saltCure !== 'boolean') {
      throw new Error(`Salt Cure state for ${id} must be boolean or null`);
    }
  }
  for (const [id, boosts] of Object.entries(resolution.boostsByPokemon || {})) {
    for (const [stat, amount] of Object.entries(boosts)) {
      if (!Number.isFinite(amount)) throw new Error(`Boost ${stat} for ${id} must be finite`);
    }
  }
  for (const [id, reset] of Object.entries(resolution.resetBoostsByPokemon || {})) {
    if (reset !== true) throw new Error(`Boost reset for ${id} must be true`);
  }
  for (const [id, boosts] of Object.entries(resolution.setBoostsByPokemon || {})) {
    for (const [stat, value] of Object.entries(boosts)) {
      if (!['hp', 'atk', 'def', 'spa', 'spd', 'spe', 'acc', 'eva'].includes(stat) ||
        !Number.isInteger(value) || value < -6 || value > 6) {
        throw new Error(`Boost set ${stat} for ${id} must be an integer from -6 to 6`);
      }
    }
  }

  const recorded = recordMoveAction(state, action);
  const failedMove = resolution.hit === false;
  const bookkeeping = failedMove
    ? {
      ...recorded,
      moveStreakByPokemon: (() => {
        const streaks = {...(recorded.moveStreakByPokemon || {})};
        delete streaks[action.actorId];
        return Object.keys(streaks).length ? streaks : undefined;
      })(),
    }
    : recorded;
  const trace = resolution.trace || {
    source: 'battle-engine' as const,
    hit: resolution.hit !== false,
  };
  const hasFailedMoveSelfState = [
    resolution.itemByPokemon,
    resolution.consumedItemByPokemon,
    resolution.boostsByPokemon,
    resolution.typeOverrideByPokemon,
    resolution.typeChangeUsedByPokemon,
    resolution.speciesOverrideByPokemon,
  ].some(map => map !== undefined && Object.prototype.hasOwnProperty.call(map, action.actorId));
  if (resolution.hit === false && resolution.actionFailure === undefined && !hasFailedMoveSelfState) {
    const failedSides = {...bookkeeping.sides};
    for (const sideId of ['ai', 'player'] as SideId[]) {
      const side = failedSides[sideId];
      failedSides[sideId] = {
        ...side,
        party: side.party.map(pokemon => {
          const volatile = resolution.volatileByPokemon?.[pokemon.id];
          return volatile === undefined
            ? pokemon
            : {...pokemon, volatile: mergeVolatile(pokemon.volatile, volatile)};
        }),
      };
    }
    return {...bookkeeping, sides: failedSides, lastResolution: {...trace, hit: false}};
  }
  const sides = {...bookkeeping.sides};
  for (const sideId of ['ai', 'player'] as SideId[]) {
    const side = sides[sideId];
    sides[sideId] = {
      ...side,
      party: side.party.map(pokemon => {
        const damage = resolution.damageByTarget?.[pokemon.id] || 0;
        const hitDamage = resolution.hitDamageByTarget?.[pokemon.id];
        const hpDelta = hpDeltaByPokemon[pokemon.id] || 0;
        const item = resolution.itemByPokemon?.[pokemon.id];
        const hasItemResolution = !!resolution.itemByPokemon &&
          Object.prototype.hasOwnProperty.call(resolution.itemByPokemon, pokemon.id);
        const itemCorroded = resolution.itemCorrodedByPokemon?.[pokemon.id];
        const hasItemCorroded = !!resolution.itemCorrodedByPokemon &&
          Object.prototype.hasOwnProperty.call(resolution.itemCorrodedByPokemon, pokemon.id);
        const typeOverride = resolution.typeOverrideByPokemon?.[pokemon.id];
        const hasTypeOverride = !!resolution.typeOverrideByPokemon &&
          Object.prototype.hasOwnProperty.call(resolution.typeOverrideByPokemon, pokemon.id);
        const typeChangeUsed = resolution.typeChangeUsedByPokemon?.[pokemon.id];
        const hasTypeChangeUsed = !!resolution.typeChangeUsedByPokemon &&
          Object.prototype.hasOwnProperty.call(resolution.typeChangeUsedByPokemon, pokemon.id);
        const abilityOverride = resolution.abilityOverrideByPokemon?.[pokemon.id];
        const hasAbilityOverride = !!resolution.abilityOverrideByPokemon &&
          Object.prototype.hasOwnProperty.call(resolution.abilityOverrideByPokemon, pokemon.id);
        const noAbility = resolution.noAbilityByPokemon?.[pokemon.id];
        const hasNoAbility = !!resolution.noAbilityByPokemon &&
          Object.prototype.hasOwnProperty.call(resolution.noAbilityByPokemon, pokemon.id);
        const abilitySuppressed = resolution.abilitySuppressedByPokemon?.[pokemon.id];
        const hasAbilitySuppressed = !!resolution.abilitySuppressedByPokemon &&
          Object.prototype.hasOwnProperty.call(resolution.abilitySuppressedByPokemon, pokemon.id);
        const speciesOverride = resolution.speciesOverrideByPokemon?.[pokemon.id];
        const hasSpeciesOverride = !!resolution.speciesOverrideByPokemon &&
          Object.prototype.hasOwnProperty.call(resolution.speciesOverrideByPokemon, pokemon.id);
        const baseStatsOverride = resolution.baseStatsOverrideByPokemon?.[pokemon.id];
        const hasBaseStatsOverride = !!resolution.baseStatsOverrideByPokemon &&
          Object.prototype.hasOwnProperty.call(resolution.baseStatsOverrideByPokemon, pokemon.id);
        const statOverrides = resolution.statOverridesByPokemon?.[pokemon.id];
        const hasStatOverrides = !!resolution.statOverridesByPokemon &&
          Object.prototype.hasOwnProperty.call(resolution.statOverridesByPokemon, pokemon.id);
        const movesOverride = resolution.movesByPokemon?.[pokemon.id];
        const hasMovesOverride = !!resolution.movesByPokemon &&
          Object.prototype.hasOwnProperty.call(resolution.movesByPokemon, pokemon.id);
        const consumedItem = resolution.consumedItemByPokemon?.[pokemon.id];
        const hasConsumedItemResolution = !!resolution.consumedItemByPokemon &&
          Object.prototype.hasOwnProperty.call(resolution.consumedItemByPokemon, pokemon.id);
        const hasSubstituteResolution = !!resolution.substituteHpByPokemon &&
          Object.prototype.hasOwnProperty.call(resolution.substituteHpByPokemon, pokemon.id);
        const substituteHpResolution = resolution.substituteHpByPokemon?.[pokemon.id];
        const damageToSubstitute = damage > 0 && (pokemon.substituteHp || 0) > 0;
        const damageAppliedPokemon = hitDamage
          ? hitDamage.reduce((current, hit) => applyDamageToPokemon(current, hit), pokemon)
          : applyDamageToPokemon(pokemon, damage);
        const damageToHp = pokemon.hp.current - damageAppliedPokemon.hp.current;
        const nextSubstituteHp = hasSubstituteResolution
          ? (substituteHpResolution === null || substituteHpResolution === 0 ? undefined : substituteHpResolution)
          : hitDamage
            ? damageAppliedPokemon.substituteHp
            : damageToSubstitute
              ? Math.max(0, pokemon.substituteHp! - damage) || undefined
            : pokemon.substituteHp;
        const status = resolution.statusByPokemon?.[pokemon.id];
        const statusTurns = resolution.statusTurnsByPokemon?.[pokemon.id];
        const disguiseBroken = resolution.disguiseBrokenByPokemon?.[pokemon.id];
        const isSaltCure = resolution.isSaltCureByPokemon?.[pokemon.id];
        const hasSaltCure = !!resolution.isSaltCureByPokemon &&
          Object.prototype.hasOwnProperty.call(resolution.isSaltCureByPokemon, pokemon.id);
        const toxicCounter = resolution.toxicCounterByPokemon?.[pokemon.id];
        const boosts = resolution.boostsByPokemon?.[pokemon.id];
        const resetBoosts = resolution.resetBoostsByPokemon?.[pokemon.id];
        const setBoosts = resolution.setBoostsByPokemon?.[pokemon.id];
        const volatile = volatileByPokemon[pokemon.id];
        if (!damage && !hitDamage && !hpDelta && !hasItemResolution && !hasItemCorroded && !hasTypeOverride && !hasTypeChangeUsed && !hasAbilityOverride && !hasNoAbility && !hasAbilitySuppressed && !hasSpeciesOverride && !hasBaseStatsOverride && !hasStatOverrides && !hasMovesOverride && !hasConsumedItemResolution && !hasSubstituteResolution && status === undefined &&
          statusTurns === undefined && disguiseBroken === undefined && !hasSaltCure &&
          toxicCounter === undefined && boosts === undefined && resetBoosts === undefined &&
          setBoosts === undefined && volatile === undefined) return pokemon;
        const baseBoosts = resetBoosts ? undefined : pokemon.boosts;
        const stagedBoosts = setBoosts === undefined
          ? baseBoosts
          : {...(baseBoosts || {}), ...setBoosts};
        const nextBoosts = boosts === undefined
          ? stagedBoosts
          : mergeBoosts(stagedBoosts, boosts);
        const nextMoves = movesOverride === null
          ? (pokemon.originalMoves || pokemon.moves)
          : movesOverride;
        const nextOriginalMoves = movesOverride === null
          ? undefined
          : pokemon.originalMoves || pokemon.moves;
        return {
          ...pokemon,
          ...(hasMovesOverride ? {moves: nextMoves, originalMoves: nextOriginalMoves} : {}),
          hp: {...pokemon.hp, current: Math.max(0, Math.min(pokemon.hp.max, pokemon.hp.current - damageToHp + hpDelta))},
          ...(hasItemResolution ? {item: item === null ? undefined : item} : {}),
          ...(hasItemCorroded
            ? {itemCorroded: itemCorroded === null ? undefined : itemCorroded}
            : hasItemResolution && item === null ? {itemCorroded: undefined} : {}),
          ...(hasTypeOverride ? {typeOverride: typeOverride === null ? undefined : typeOverride} : {}),
          ...(hasTypeChangeUsed ? {typeChangeUsed: typeChangeUsed === null ? undefined : typeChangeUsed} : {}),
          ...(hasAbilityOverride ? {abilityOverride: abilityOverride === null ? undefined : abilityOverride} : {}),
          ...(hasNoAbility ? {abilityOverride: noAbility ? null : undefined} : {}),
          ...(hasAbilitySuppressed ? {abilitySuppressed: abilitySuppressed === null ? undefined : abilitySuppressed} : {}),
          ...(hasSpeciesOverride ? {speciesOverride: speciesOverride === null ? undefined : speciesOverride} : {}),
          ...(hasBaseStatsOverride ? {baseStatsOverride: baseStatsOverride === null ? undefined : baseStatsOverride} : {}),
          ...(hasStatOverrides ? {statOverrides: statOverrides === null ? undefined : statOverrides} : {}),
          ...(hasItemResolution && item === null ? {itemLost: true} : {}),
          ...(hasConsumedItemResolution
            ? {lastConsumedItem: consumedItem === null ? undefined : consumedItem}
            : hasItemResolution ? {lastConsumedItem: undefined} : {}),
          ...(damageToSubstitute || hasSubstituteResolution ? {substituteHp: nextSubstituteHp} : {}),
          ...(status === undefined ? {} : {
            status,
            ...(status === '' ? {statusTurns: undefined, toxicCounter: undefined} : {}),
          }),
          ...(statusTurns === undefined ? {} : {statusTurns: statusTurns === null ? undefined : statusTurns}),
          ...(disguiseBroken === undefined ? {} : {disguiseBroken}),
          ...(hasSaltCure ? {isSaltCure: isSaltCure === null ? undefined : isSaltCure} : {}),
          ...(toxicCounter === undefined ? {} : {toxicCounter}),
          ...((resetBoosts === undefined && boosts === undefined && setBoosts === undefined)
            ? {} : {boosts: compactBoosts(nextBoosts)}),
          ...(volatile === undefined ? {} : {volatile: mergeVolatile(pokemon.volatile, volatile)}),
        };
      }),
      effects: resolution.sideEffectsBySide?.[sideId]
        ? {...(side.effects || {}), ...resolution.sideEffectsBySide[sideId]}
        : side.effects,
      effectDurations: resolution.sideEffectDurationsBySide?.[sideId]
        ? mergeDurations(side.effectDurations, resolution.sideEffectDurationsBySide[sideId]!)
        : side.effectDurations,
      ...(resolution.pendingFullHealBySide?.[sideId] === undefined
        ? {}
        : {pendingFullHealOnSwitch: resolution.pendingFullHealBySide[sideId]}),
    };
  }

  const resolvedSides = applyRageFistHits(
    state,
    clearInactiveCommanderLinks(
      accumulateBideDamage(state, sides, action.actorId, resolution.damageByTarget, resolution.hitDamageByTarget),
    ),
    action,
    resolution.damageByTarget,
    resolution.hit !== false,
    resolution.hitDamageByTarget,
  );
  if (resolution.hit !== false) {
    for (const [id, swap] of Object.entries(resolution.allySwitchByPokemon || {})) {
      if (!swap) continue;
      const sideId = sideForPokemon(state, id);
      const activeIds = [...resolvedSides[sideId].activeIds];
      const actorIndex = activeIds.indexOf(id);
      const partnerIndex = activeIds.findIndex((allyId, index) => index !== actorIndex &&
        (getPokemon(state, allyId)?.hp.current || 0) > 0);
      if (actorIndex < 0 || partnerIndex < 0) throw new Error(`Ally Switch state for ${id} cannot swap active slots`);
      [activeIds[actorIndex], activeIds[partnerIndex]] = [activeIds[partnerIndex], activeIds[actorIndex]];
      resolvedSides[sideId] = {...resolvedSides[sideId], activeIds};
    }
  }

  const field = resolution.field ? {...recorded.field, ...resolution.field} : recorded.field;
  const fieldWithDurations = resolution.fieldDurations
    ? {...field, durations: mergeDurations(field.durations, resolution.fieldDurations)}
    : field;
  const pendingForcedSwitchIds = (() => {
    const pending = new Set(recorded.pendingForcedSwitchIds || []);
    for (const [id, forced] of Object.entries(resolution.forcedSwitchByPokemon || {})) {
      if (forced) pending.add(id);
      else pending.delete(id);
    }
    return pending.size ? Array.from(pending) : undefined;
  })();
  const pendingBatonPassIds = (() => {
    const pending = new Set(recorded.pendingBatonPassIds || []);
    for (const [id, batonPass] of Object.entries(resolution.batonPassByPokemon || {})) {
      if (batonPass) pending.add(id);
      else pending.delete(id);
    }
    return pending.size ? Array.from(pending) : undefined;
  })();
  const pendingSubstitutePassIds = (() => {
    const pending = new Set(recorded.pendingSubstitutePassIds || []);
    for (const [id, substitutePass] of Object.entries(resolution.substitutePassByPokemon || {})) {
      if (substitutePass) pending.add(id);
      else pending.delete(id);
    }
    return pending.size ? Array.from(pending) : undefined;
  })();
  const pendingPledgeBySide = (() => {
    const pending = {...(recorded.pendingPledgeBySide || {})};
    for (const [sideId, value] of Object.entries(resolution.pendingPledgeBySide || {})) {
      if (value === null) delete pending[sideId as SideId];
      else pending[sideId as SideId] = value;
    }
    return Object.keys(pending).length ? pending : undefined;
  })();
  const pendingForcedSwitchIdsWithBatonPass = (() => {
    const pending = new Set(pendingForcedSwitchIds || []);
    for (const [id, batonPass] of Object.entries(resolution.batonPassByPokemon || {})) {
      if (batonPass) pending.delete(id);
    }
    for (const [id, substitutePass] of Object.entries(resolution.substitutePassByPokemon || {})) {
      if (substitutePass) pending.delete(id);
    }
    return pending.size ? Array.from(pending) : undefined;
  })();
  const statBoostsThisTurnByPokemon = recordStatBoostsThisTurn(state, resolution);
  return {
    ...bookkeeping,
    sides: resolvedSides,
    lastDamageTakenByPokemon: updateLastDamageTaken(
      state,
      action,
      resolution.hit === false ? undefined : resolution.damageByTarget,
      resolution.hit === false ? undefined : resolution.hitDamageByTarget,
      bookkeeping.lastDamageTakenByPokemon,
    ),
    lastDamagingMoveByPokemon: resolution.hit === false || !Object.keys(resolution.damageByTarget || {}).length
      ? bookkeeping.lastDamagingMoveByPokemon
      : {
        ...(bookkeeping.lastDamagingMoveByPokemon || {}),
        ...Object.fromEntries(Object.keys(resolution.damageByTarget || {})
          .map(targetId => [targetId, action.moveName])),
      },
    lastMoveTargetedByPokemon: action.targetIds.some(targetId => targetId !== action.actorId)
      ? {
        ...(bookkeeping.lastMoveTargetedByPokemon || {}),
        ...(resolution.hit === false
          ? {}
          : Object.fromEntries(action.targetIds
            .filter(targetId => targetId !== action.actorId)
            .map(targetId => [targetId, action.moveName]))),
      }
      : bookkeeping.lastMoveTargetedByPokemon,
    field: fieldWithDurations,
    delayedMoves: resolution.delayedMoves
      ? [...(recorded.delayedMoves || []), ...resolution.delayedMoves]
      : recorded.delayedMoves,
    pendingForcedSwitchIds: pendingForcedSwitchIdsWithBatonPass,
    pendingBatonPassIds,
    pendingSubstitutePassIds,
    pendingPledgeBySide,
    statBoostsThisTurnByPokemon,
    lastResolution: {...trace, hit: trace.hit === undefined ? true : trace.hit},
  };
}

/** Advance the explicit turn lifecycle without guessing unmodeled durations. */
export function beginNextTurn(state: BattleState): BattleState {
  const sides = {...state.sides};
  for (const sideId of ['ai', 'player'] as SideId[]) {
    sides[sideId] = decrementSideDurations(state, sides[sideId]);
  }
  const lastDamageTakenByPokemon = Object.fromEntries(
    Object.entries(state.lastDamageTakenByPokemon || {})
      .filter(([, damage]) => damage.turn === state.turn),
  );
  const field = decrementFieldDurations(state.field);
  const mimicrySides = updateMimicryAfterTerrainChange(state, sides, field.terrain);
  const forecastSides = updateForecastAfterWeatherChange(state, mimicrySides, field.weather);
  return {
    ...state,
    turn: state.turn + 1,
    sides: clearInactiveCommanderLinks(forecastSides),
    field,
    lastDamageTakenByPokemon: Object.keys(lastDamageTakenByPokemon).length
      ? lastDamageTakenByPokemon
      : undefined,
    delayedMoves: decrementDelayedMoves(state.delayedMoves),
    firstTurnOutIds: [],
    selectedMoveByPokemon: undefined,
    pendingPledgeBySide: undefined,
    statBoostsThisTurnByPokemon: undefined,
  };
}

/** Resolve modeled residual effects, then advance timers and the turn counter. */
export function advanceTurn(state: BattleState, options: EndTurnOptions = {}): BattleState {
  return beginNextTurn(applyEndTurnResolution(state, deriveEndTurnResolution(state, options)));
}

export function applyAction(
  state: BattleState,
  action: Action,
  resolution?: MoveResolution,
): BattleState {
  if (action.kind === 'switch') return applySwitchAction(state, action);
  if (!resolution) throw new Error('Move resolution is required for move actions');
  return resolveMoveAction(state, action, resolution);
}
