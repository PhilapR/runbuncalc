import {
  MoveResolution,
  PokemonState,
  SideEffects,
  SideId,
  StatBoosts,
} from './model';

/**
 * Serializable `MoveResolution` writers.
 *
 * Each helper records one explicit outcome on the resolution object. They hold
 * no battle state and read nothing back, which is what keeps the resolution
 * contract serializable and order-independent.
 */

export function addHpDelta(resolution: MoveResolution, pokemonId: string, delta: number) {
  if (!Number.isFinite(delta) || delta === 0) return;
  resolution.hpDeltaByPokemon = {...(resolution.hpDeltaByPokemon || {})};
  resolution.hpDeltaByPokemon[pokemonId] = (resolution.hpDeltaByPokemon[pokemonId] || 0) + delta;
}

export function setItem(resolution: MoveResolution, pokemonId: string, item: string | null) {
  resolution.itemByPokemon = {
    ...(resolution.itemByPokemon || {}),
    [pokemonId]: item,
  };
}

export function setItemCorroded(resolution: MoveResolution, pokemonId: string, corroded: boolean | null) {
  resolution.itemCorrodedByPokemon = {
    ...(resolution.itemCorrodedByPokemon || {}),
    [pokemonId]: corroded,
  };
}

export function setSaltCure(resolution: MoveResolution, pokemonId: string, active: boolean | null) {
  resolution.isSaltCureByPokemon = {
    ...(resolution.isSaltCureByPokemon || {}),
    [pokemonId]: active,
  };
}

export function setTypeOverride(resolution: MoveResolution, pokemonId: string, types: string[] | null) {
  resolution.typeOverrideByPokemon = {
    ...(resolution.typeOverrideByPokemon || {}),
    [pokemonId]: types,
  };
}

export function setTypeChangeUsed(resolution: MoveResolution, pokemonId: string, used: boolean | null) {
  resolution.typeChangeUsedByPokemon = {
    ...(resolution.typeChangeUsedByPokemon || {}),
    [pokemonId]: used,
  };
}

export function setAbilityOverride(resolution: MoveResolution, pokemonId: string, ability: string | null) {
  resolution.abilityOverrideByPokemon = {
    ...(resolution.abilityOverrideByPokemon || {}),
    [pokemonId]: ability,
  };
}

export function setNoAbility(resolution: MoveResolution, pokemonId: string) {
  resolution.noAbilityByPokemon = {
    ...(resolution.noAbilityByPokemon || {}),
    [pokemonId]: true,
  };
}

export function setAbilitySuppressed(resolution: MoveResolution, pokemonId: string, suppressed: boolean | null) {
  resolution.abilitySuppressedByPokemon = {
    ...(resolution.abilitySuppressedByPokemon || {}),
    [pokemonId]: suppressed,
  };
}

export function setSpeciesOverride(resolution: MoveResolution, pokemonId: string, species: string | null) {
  resolution.speciesOverrideByPokemon = {
    ...(resolution.speciesOverrideByPokemon || {}),
    [pokemonId]: species,
  };
}

export function setStatOverrides(
  resolution: MoveResolution,
  pokemonId: string,
  stats: Partial<Record<'hp' | 'atk' | 'def' | 'spa' | 'spd' | 'spe', number>> | null,
) {
  resolution.statOverridesByPokemon = {
    ...(resolution.statOverridesByPokemon || {}),
    [pokemonId]: stats,
  };
}

export function setMoves(resolution: MoveResolution, pokemonId: string, moves: PokemonState['moves'] | null) {
  resolution.movesByPokemon = {
    ...(resolution.movesByPokemon || {}),
    [pokemonId]: moves,
  };
}

export function setCopyMove(resolution: MoveResolution, pokemonId: string, moveName: string | null) {
  resolution.copyMoveByPokemon = {
    ...(resolution.copyMoveByPokemon || {}),
    [pokemonId]: moveName,
  };
}

export function setCalledMove(resolution: MoveResolution, pokemonId: string, moveName: string | null) {
  resolution.calledMoveByPokemon = {
    ...(resolution.calledMoveByPokemon || {}),
    [pokemonId]: moveName,
  };
}

export function setCalledMoveModifiers(
  resolution: MoveResolution,
  pokemonId: string,
  modifiers: {powerMultiplier?: number; bypassAccuracy?: boolean},
) {
  resolution.calledMoveModifiersByPokemon = {
    ...(resolution.calledMoveModifiersByPokemon || {}),
    [pokemonId]: modifiers,
  };
}

export function setCalledMoveTargets(resolution: MoveResolution, pokemonId: string, targetIds: string[]) {
  resolution.calledMoveTargetIdsByPokemon = {
    ...(resolution.calledMoveTargetIdsByPokemon || {}),
    [pokemonId]: [...targetIds],
  };
}

export function setCalledMoveExternal(resolution: MoveResolution, pokemonId: string) {
  resolution.calledMoveExternalByPokemon = {
    ...(resolution.calledMoveExternalByPokemon || {}),
    [pokemonId]: true,
  };
}

export function setForcedSwitch(resolution: MoveResolution, pokemonId: string, forced = true) {
  resolution.forcedSwitchByPokemon = {
    ...(resolution.forcedSwitchByPokemon || {}),
    [pokemonId]: forced,
  };
}

export function setStatusTurns(resolution: MoveResolution, pokemonId: string, turns: number | null) {
  resolution.statusTurnsByPokemon = {
    ...(resolution.statusTurnsByPokemon || {}),
    [pokemonId]: turns,
  };
}

export function addSubstituteHp(resolution: MoveResolution, pokemonId: string, hp: number) {
  resolution.substituteHpByPokemon = {
    ...(resolution.substituteHpByPokemon || {}),
    [pokemonId]: hp,
  };
}

export function resetBoosts(resolution: MoveResolution, pokemonIds: string[]) {
  if (!pokemonIds.length) return;
  resolution.resetBoostsByPokemon = {...(resolution.resetBoostsByPokemon || {})};
  for (const pokemonId of pokemonIds) resolution.resetBoostsByPokemon[pokemonId] = true;
}

export function setBoosts(resolution: MoveResolution, pokemonId: string, boosts: StatBoosts) {
  resolution.setBoostsByPokemon = {
    ...(resolution.setBoostsByPokemon || {}),
    [pokemonId]: {...(resolution.setBoostsByPokemon?.[pokemonId] || {}), ...boosts},
  };
}

export function addSideEffects(resolution: MoveResolution, sideId: SideId, effects: Partial<SideEffects>) {
  resolution.sideEffectsBySide = {...(resolution.sideEffectsBySide || {})};
  resolution.sideEffectsBySide[sideId] = {
    ...(resolution.sideEffectsBySide[sideId] || {}),
    ...effects,
  };
}

export function setPendingFullHeal(resolution: MoveResolution, sideId: SideId) {
  resolution.pendingFullHealBySide = {
    ...(resolution.pendingFullHealBySide || {}),
    [sideId]: true,
  };
}
