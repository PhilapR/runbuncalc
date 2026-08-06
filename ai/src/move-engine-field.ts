import {isItemEffectActive} from './items';
import {addSideEffects} from './move-engine-writers';
import {moveId} from './move-engine-utils';
import {
  BattleState,
  MoveResolution,
  PokemonState,
  SideEffects,
  SideId,
  TimedFieldName,
  TimedSideEffectName,
} from './model';

/**
 * Side-effect and field-state transitions.
 *
 * Hazard clearing, Court Change, screen/room durations, and the extension
 * items (Light Clay, weather rocks, Terrain Extender) that decide how long a
 * newly created field effect lasts.
 */

export function clearEntryHazards(resolution: MoveResolution, sideId: SideId) {
  addSideEffects(resolution, sideId, {
    stealthRock: false,
    steelsurge: false,
    spikes: 0,
    toxicSpikes: 0,
    stickyWeb: false,
  });
  addSideEffectDuration(resolution, sideId, 'steelsurge', null);
}

export function clearSubstitutes(resolution: MoveResolution, pokemonIds: string[]) {
  if (!pokemonIds.length) return;
  resolution.substituteHpByPokemon = {...(resolution.substituteHpByPokemon || {})};
  for (const pokemonId of pokemonIds) resolution.substituteHpByPokemon[pokemonId] = null;
}

export function courtChangeSideEffects(source: SideEffects): Partial<SideEffects> {
  return {
    stealthRock: !!source.stealthRock,
    steelsurge: !!source.steelsurge,
    spikes: source.spikes || 0,
    toxicSpikes: source.toxicSpikes || 0,
    stickyWeb: !!source.stickyWeb,
    reflect: !!source.reflect,
    lightScreen: !!source.lightScreen,
    auroraVeil: !!source.auroraVeil,
    safeguard: !!source.safeguard,
    mist: !!source.mist,
    luckyChant: !!source.luckyChant,
    craftyShield: !!source.craftyShield,
    tailwind: !!source.tailwind,
    wideGuard: !!source.wideGuard,
    quickGuard: !!source.quickGuard,
    matBlock: !!source.matBlock,
  };
}

export function addSideEffectDuration(
  resolution: MoveResolution,
  sideId: SideId,
  effect: TimedSideEffectName,
  turns: number | null,
) {
  resolution.sideEffectDurationsBySide = {...(resolution.sideEffectDurationsBySide || {})};
  resolution.sideEffectDurationsBySide[sideId] = {
    ...(resolution.sideEffectDurationsBySide[sideId] || {}),
    [effect]: turns,
  };
}

export function addField(resolution: MoveResolution, field: Partial<BattleState['field']>) {
  resolution.field = {...(resolution.field || {}), ...field};
}

export function addFieldDuration(resolution: MoveResolution, field: TimedFieldName, turns: number | null) {
  resolution.fieldDurations = {...(resolution.fieldDurations || {}), [field]: turns};
}

export function extendedFieldDuration(
  state: BattleState,
  pokemon: PokemonState,
  field: 'screen' | 'weather' | 'terrain',
): number {
  if (!isItemEffectActive(state, pokemon)) return 5;
  const item = moveId(pokemon.item);
  if (field === 'screen' && state.generation >= 4 && item === 'lightclay') return 8;
  if (field === 'weather' && state.generation >= 4 &&
    ['heatrock', 'damprock', 'smoothrock', 'icyrock'].includes(item)) return 8;
  if (field === 'terrain' && state.generation >= 7 && item === 'terrainextender') return 8;
  return 5;
}
