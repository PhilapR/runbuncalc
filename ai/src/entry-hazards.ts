import * as Calc from '@smogon/calc';
import {getCalculatorAbility, getEffectiveAbility, getGenerationAbility, isAbilityActive, isAbilityAvailable} from './abilities';
import {getPokemon, isStrongWeather, isWeatherSuppressed, sideForPokemon} from './actions';
import {canApplyMajorStatus, getEffectiveTypes, isGrounded} from './eligibility';
import {
  getBoosterEnergyVolatile,
  getParadoxAbilityVolatile,
  isItemAvailable,
  isItemEffectActive,
  preventsAbilityChange,
} from './items';
import {getMoveMaxPP} from './move-metadata';
import {
  BattleState,
  PokemonState,
  RUN_AND_BUN_EVS,
  StatBoosts,
  SideId,
  StatusName,
  SwitchAction,
  SwitchEntryResolution,
  Terrain,
  TypeName,
  Weather,
  VolatileState,
} from './model';
import {getEffectiveSpecies, getRawStats} from './stat-transforms';
import {isMimicryActive, mimicryTypeOverride} from './mimicry';
import {weatherFormSpeciesOverride} from './weather-forms';

function id(name: string | undefined): string {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function calcPokemon(state: BattleState, pokemon: PokemonState): Calc.Pokemon {
  const gen = Calc.Generations.get(state.generation);
  return new Calc.Pokemon(gen, getEffectiveSpecies(pokemon), {
    level: pokemon.level,
    ability: getCalculatorAbility(state, pokemon),
    abilityOn: isAbilityActive(pokemon, state) ? pokemon.abilityOn : false,
    item: isItemEffectActive(state, pokemon) ? pokemon.item : undefined,
    nature: pokemon.nature,
    ivs: pokemon.ivs,
    evs: RUN_AND_BUN_EVS,
    teraType: pokemon.teraType as Calc.State.Pokemon['teraType'],
    overrides: pokemon.typeOverride ? {types: pokemon.typeOverride as unknown as Calc.Pokemon['types']} : undefined,
  });
}

function hasAbility(state: BattleState, pokemon: PokemonState, ...abilities: string[]): boolean {
  if (!isAbilityActive(pokemon, state)) return false;
  const current = id(getEffectiveAbility(pokemon));
  return abilities.some(ability => current === id(ability) &&
    isAbilityAvailable(state.generation, ability));
}

function hasFlowerVeilProtection(state: BattleState, pokemon: PokemonState): boolean {
  if (state.generation < 6 || state.mode !== 'Doubles' ||
    !getEffectiveTypes(state, pokemon.id).some(type => id(type) === 'grass')) return false;
  const sideId = sideForPokemon(state, pokemon.id);
  return state.sides[sideId].activeIds.some(allyId => allyId !== pokemon.id &&
    (getPokemon(state, allyId)?.hp.current || 0) > 0 &&
    hasAbility(state, getPokemon(state, allyId)!, 'flowerveil'));
}

function hasType(types: string[], ...wanted: string[]): boolean {
  const normalized = new Set(types.map(id));
  return wanted.some(type => normalized.has(id(type)));
}

function addHpDelta(resolution: SwitchEntryResolution, pokemonId: string, delta: number) {
  if (!delta) return;
  resolution.hpDeltaByPokemon = {...(resolution.hpDeltaByPokemon || {})};
  resolution.hpDeltaByPokemon[pokemonId] = (resolution.hpDeltaByPokemon[pokemonId] || 0) + delta;
}

function applyHospitality(
  state: BattleState,
  resolution: SwitchEntryResolution,
  sideId: 'ai' | 'player',
  action: SwitchAction,
  pokemon: PokemonState,
) {
  if (state.generation < 9 || state.mode !== 'Doubles' || !hasAbility(state, pokemon, 'hospitality')) return;
  const entryDamage = resolution.hpDeltaByPokemon?.[pokemon.id] || 0;
  if (pokemon.hp.current + entryDamage <= 0) return;
  let healed = false;
  for (const allyId of state.sides[sideId].activeIds) {
    if (allyId === action.actorId || allyId === action.replacementId) continue;
    const ally = getPokemon(state, allyId);
    if (!ally || ally.hp.current <= 0 || ally.hp.current >= ally.hp.max) continue;
    addHpDelta(resolution, ally.id, Math.floor(ally.hp.max / 4));
    healed = true;
  }
  if (healed) resolution.trace!.notes!.push(`Hospitality healed active allies for ${pokemon.id}`);
}

function isTatsugiri(pokemon: PokemonState): boolean {
  return id(pokemon.species).startsWith('tatsugiri');
}

function isDondozo(pokemon: PokemonState): boolean {
  return id(pokemon.species) === 'dondozo';
}

function applyCommander(
  state: BattleState,
  resolution: SwitchEntryResolution,
  sideId: 'ai' | 'player',
  action: SwitchAction,
  pokemon: PokemonState,
) {
  if (state.generation < 9 || state.mode !== 'Doubles') return;
  const activeAllies = state.sides[sideId].activeIds
    .filter(allyId => allyId !== action.actorId && allyId !== action.replacementId)
    .map(allyId => getPokemon(state, allyId))
    .filter((ally): ally is PokemonState => !!ally && ally.hp.current > 0);
  for (const ally of activeAllies) {
    const tatsugiri = hasAbility(state, pokemon, 'commander') && isTatsugiri(pokemon)
      ? pokemon
      : hasAbility(state, ally, 'commander') && isTatsugiri(ally)
        ? ally
        : undefined;
    const dondozo = tatsugiri === pokemon
      ? isDondozo(ally) ? ally : undefined
      : isDondozo(pokemon) ? pokemon : undefined;
    if (!tatsugiri || !dondozo || tatsugiri.volatile?.commanding || dondozo.volatile?.commanded) continue;
    addBoost(resolution, dondozo.id, 'atk', stageDelta(dondozo, 'atk', [2]));
    addBoost(resolution, dondozo.id, 'def', stageDelta(dondozo, 'def', [2]));
    addBoost(resolution, dondozo.id, 'spa', stageDelta(dondozo, 'spa', [2]));
    addBoost(resolution, dondozo.id, 'spd', stageDelta(dondozo, 'spd', [2]));
    addBoost(resolution, dondozo.id, 'spe', stageDelta(dondozo, 'spe', [2]));
    addVolatile(resolution, tatsugiri.id, 'commanding', {sourceId: dondozo.id});
    addVolatile(resolution, dondozo.id, 'commanded', {sourceId: tatsugiri.id});
    resolution.trace!.notes!.push(`Commander linked ${tatsugiri.id} to ${dondozo.id}`);
  }
}

function applyCostar(
  state: BattleState,
  resolution: SwitchEntryResolution,
  sideId: 'ai' | 'player',
  action: SwitchAction,
  pokemon: PokemonState,
) {
  if (state.generation < 9 || state.mode !== 'Doubles' || !hasAbility(state, pokemon, 'costar')) return;
  const ally = state.sides[sideId].activeIds
    .filter(allyId => allyId !== action.actorId && allyId !== action.replacementId)
    .map(allyId => getPokemon(state, allyId))
    .find(candidate => candidate && candidate.hp.current > 0);
  if (!ally) return;
  setBoosts(resolution, pokemon.id, ally.boosts || {});
  for (const name of ['focusEnergy', 'laserFocus'] as const) {
    const volatile = ally.volatile?.[name];
    if (volatile) addVolatile(resolution, pokemon.id, name, {...volatile});
  }
  resolution.trace!.notes!.push(`Costar copied active ally state to ${pokemon.id}`);
}

function addBoost(resolution: SwitchEntryResolution, pokemonId: string, stat: keyof StatBoosts, amount: number) {
  if (!amount) return;
  resolution.boostsByPokemon = {...(resolution.boostsByPokemon || {})};
  resolution.boostsByPokemon[pokemonId] = {
    ...(resolution.boostsByPokemon[pokemonId] || {}),
    [stat]: amount,
  };
}

function setBoosts(resolution: SwitchEntryResolution, pokemonId: string, boosts: StatBoosts) {
  resolution.setBoostsByPokemon = {...(resolution.setBoostsByPokemon || {}), [pokemonId]: {...boosts}};
}

function setTypeOverride(resolution: SwitchEntryResolution, pokemonId: string, types: TypeName[] | null) {
  resolution.typeOverrideByPokemon = {
    ...(resolution.typeOverrideByPokemon || {}),
    [pokemonId]: types,
  };
}

function setSpeciesOverride(resolution: SwitchEntryResolution, pokemonId: string, species: string | null) {
  resolution.speciesOverrideByPokemon = {
    ...(resolution.speciesOverrideByPokemon || {}),
    [pokemonId]: species,
  };
}

function setAbilityOverride(resolution: SwitchEntryResolution, pokemonId: string, ability: string | null) {
  resolution.abilityOverrideByPokemon = {
    ...(resolution.abilityOverrideByPokemon || {}),
    [pokemonId]: ability,
  };
}

function setNoAbility(resolution: SwitchEntryResolution, pokemonId: string) {
  resolution.noAbilityByPokemon = {
    ...(resolution.noAbilityByPokemon || {}),
    [pokemonId]: true,
  };
}

function setStatOverrides(
  resolution: SwitchEntryResolution,
  pokemonId: string,
  stats: Partial<Record<'hp' | 'atk' | 'def' | 'spa' | 'spd' | 'spe', number>> | null,
) {
  resolution.statOverridesByPokemon = {
    ...(resolution.statOverridesByPokemon || {}),
    [pokemonId]: stats,
  };
}

function setMoves(resolution: SwitchEntryResolution, pokemonId: string, moves: PokemonState['moves'] | null) {
  resolution.movesByPokemon = {
    ...(resolution.movesByPokemon || {}),
    [pokemonId]: moves,
  };
}

function copiedTransformMoves(state: BattleState, target: PokemonState): PokemonState['moves'] {
  return target.moves.map(move => {
    const naturalMaxPP = getMoveMaxPP(move.name, state.generation);
    const copiedPP = state.generation >= 5
      ? Math.min(5, naturalMaxPP || 5)
      : naturalMaxPP || move.maxPP || 5;
    return {...move, pp: copiedPP, maxPP: copiedPP};
  });
}

function traceBlocked(state: BattleState, ability: string | undefined): boolean {
  if (!ability || id(ability) === 'noability') return true;
  const data = Calc.Generations.get(state.generation).abilities.get(Calc.toID(ability)) as
    {flags?: Record<string, number>} | undefined;
  return !!data?.flags?.notrace || NON_TRACEABLE_ABILITIES.has(id(ability));
}

// These abilities are intentionally opaque to Trace in the calculator's
// compact ability data. Keep this boundary explicit rather than inferring it
// from suppression behavior: the two sets are related but not identical.
const NON_TRACEABLE_ABILITIES = new Set([
  'asoneglastrier', 'asonespectrier', 'battlebond', 'comatose', 'commander',
  'disguise', 'gulpmissile', 'iceface', 'multitype', 'powerconstruct',
  'rkssystem', 'schooling', 'shieldsdown', 'stancechange', 'terashift',
  'zenmode', 'zerotohero',
]);

function copyEntryState(
  state: BattleState,
  resolution: SwitchEntryResolution,
  holder: PokemonState,
  target: PokemonState,
  label: string,
) {
  const targetAbility = getGenerationAbility(state.generation, target);
  const targetRaw = getRawStats(Calc.Generations.get(state.generation), target);
  setSpeciesOverride(resolution, holder.id, getEffectiveSpecies(target));
  setTypeOverride(resolution, holder.id, getEffectiveTypes(state, target.id));
  if (!preventsAbilityChange(state, holder)) {
    if (targetAbility) setAbilityOverride(resolution, holder.id, targetAbility);
    else if (getEffectiveAbility(target) === undefined) setNoAbility(resolution, holder.id);
  }
  setStatOverrides(resolution, holder.id, {
    atk: targetRaw.atk,
    def: targetRaw.def,
    spa: targetRaw.spa,
    spd: targetRaw.spd,
    spe: targetRaw.spe,
  });
  setBoosts(resolution, holder.id, target.boosts || {});
  setMoves(resolution, holder.id, copiedTransformMoves(state, target));
  resolution.trace!.notes!.push(`${label} copied ${getEffectiveSpecies(target)} and its battle state`);
}

function entryOpponentTargets(state: BattleState, sideId: SideId, holderId: string): PokemonState[] {
  const opposingSide: SideId = sideId === 'ai' ? 'player' : 'ai';
  const opposing = state.sides[opposingSide].activeIds
    .map(pokemonId => getPokemon(state, pokemonId))
    .filter((pokemon): pokemon is PokemonState => !!pokemon && pokemon.hp.current > 0);
  if (state.mode === 'Singles') return opposing.slice(0, 1);
  const slot = state.sides[sideId].activeIds.indexOf(holderId);
  const paired = slot >= 0 ? getPokemon(state, state.sides[opposingSide].activeIds[slot]) : undefined;
  return paired && paired.hp.current > 0 ? [paired] : opposing.slice(0, 1);
}

export interface SwitchEntryOptions {
  random?: () => number;
}

function applyCopyEntryAbilities(
  state: BattleState,
  resolution: SwitchEntryResolution,
  sideId: SideId,
  pokemon: PokemonState,
  options: SwitchEntryOptions,
) {
  if (!isAbilityActive(pokemon, state)) return;
  const ability = id(getEffectiveAbility(pokemon));
  if (ability === 'imposter' && state.generation >= 5 && !pokemon.substituteHp) {
    const target = entryOpponentTargets(state, sideId, pokemon.id)[0];
    if (target && !target.speciesOverride && !target.substituteHp) {
      copyEntryState(state, resolution, pokemon, target, 'Imposter');
    }
    return;
  }
  if (ability !== 'trace' || state.generation < 3 || preventsAbilityChange(state, pokemon)) return;
  const candidates = (state.sides[sideId === 'ai' ? 'player' : 'ai'].activeIds)
    .map(pokemonId => getPokemon(state, pokemonId))
    .filter((target): target is PokemonState => !!target && target.hp.current > 0 && isAbilityActive(target, state))
    .filter(target => !traceBlocked(state, getCalculatorAbility(state, target)));
  if (!candidates.length) return;
  const roll = options.random ? options.random() : Math.random();
  if (!Number.isFinite(roll)) throw new Error('Trace ability sampler must return a finite number');
  const bounded = Math.max(0, Math.min(0.999999999999, roll));
  const target = candidates[Math.floor(bounded * candidates.length)];
  const targetAbility = getCalculatorAbility(state, target);
  if (targetAbility) {
    setAbilityOverride(resolution, pokemon.id, targetAbility);
    resolution.trace!.notes!.push(`Trace copied ${targetAbility} from ${target.id}`);
  }
}

function consumeItem(resolution: SwitchEntryResolution, pokemonId: string, item: string) {
  resolution.itemByPokemon = {...(resolution.itemByPokemon || {}), [pokemonId]: null};
  resolution.consumedItemByPokemon = {
    ...(resolution.consumedItemByPokemon || {}),
    [pokemonId]: item,
  };
}

function addVolatile(
  resolution: SwitchEntryResolution,
  pokemonId: string,
  name: 'protosynthesis' | 'quarkDrive' | 'commanding' | 'commanded' | 'focusEnergy' | 'laserFocus' | 'slowStart',
  state: VolatileState = {},
) {
  resolution.volatileByPokemon = {...(resolution.volatileByPokemon || {})};
  resolution.volatileByPokemon[pokemonId] = {
    ...(resolution.volatileByPokemon[pokemonId] || {}),
    [name]: state,
  };
}

function hasSlowStartEntryAbility(
  state: BattleState,
  resolution: SwitchEntryResolution,
  pokemon: PokemonState,
): boolean {
  const overrides = resolution.abilityOverrideByPokemon;
  const hasOverride = !!overrides && Object.prototype.hasOwnProperty.call(overrides, pokemon.id);
  const ability = hasOverride ? overrides![pokemon.id] || undefined : getEffectiveAbility(pokemon);
  return state.generation >= 4 && isAbilityActive(pokemon, state) &&
    isAbilityAvailable(state.generation, ability) && id(ability) === 'slowstart';
}

function activateBoosterEnergy(
  state: BattleState,
  resolution: SwitchEntryResolution,
  pokemonIds: string[],
  weather: Weather | undefined,
  terrain: Terrain | undefined,
) {
  for (const pokemonId of Array.from(new Set(pokemonIds))) {
    const pokemon = getPokemon(state, pokemonId);
    if (!pokemon || pokemon.hp.current <= 0 || !isItemEffectActive(state, pokemon) ||
      id(pokemon.item) !== 'boosterenergy') continue;
    const volatile = getParadoxAbilityVolatile(state, pokemon);
    if (!volatile || getBoosterEnergyVolatile(state, pokemon)) continue;
    const weatherActive = volatile === 'protosynthesis' &&
      !isWeatherSuppressed(state) && (weather === 'Sun' || weather === 'Harsh Sunshine');
    const terrainActive = volatile === 'quarkDrive' && terrain === 'Electric';
    if (weatherActive || terrainActive) continue;
    addVolatile(resolution, pokemon.id, volatile);
    consumeItem(resolution, pokemon.id, pokemon.item!);
    resolution.trace!.notes!.push(`Booster Energy activated ${volatile} for ${pokemon.id}`);
  }
}

function stageDelta(pokemon: PokemonState, stat: keyof StatBoosts, deltas: number[]): number {
  const current = pokemon.boosts?.[stat] || 0;
  let next = current;
  for (const delta of deltas) next = Math.max(-6, Math.min(6, next + delta));
  return next - current;
}

const TERRAIN_SEEDS: Record<string, {terrain: Terrain; stat: keyof StatBoosts}> = {
  electricseed: {terrain: 'Electric', stat: 'def'},
  grassyseed: {terrain: 'Grassy', stat: 'def'},
  mistyseed: {terrain: 'Misty', stat: 'spd'},
  psychicseed: {terrain: 'Psychic', stat: 'spd'},
};

function activateTerrainSeeds(
  state: BattleState,
  resolution: SwitchEntryResolution,
  terrain: Terrain,
  targetIds: string[],
) {
  for (const pokemonId of Array.from(new Set(targetIds))) {
    const pokemon = getPokemon(state, pokemonId);
    if (!pokemon || pokemon.hp.current <= 0 || !isItemEffectActive(state, pokemon)) continue;
    const seed = TERRAIN_SEEDS[id(pokemon.item)];
    if (!seed || seed.terrain !== terrain) continue;
    const amount = hasAbility(state, pokemon, 'contrary')
      ? -1
      : hasAbility(state, pokemon, 'simple') ? 2 : 1;
    addBoost(resolution, pokemon.id, seed.stat, stageDelta(pokemon, seed.stat, [amount]));
    consumeItem(resolution, pokemon.id, pokemon.item!);
    resolution.trace!.notes!.push(`${pokemon.item} activated for ${pokemon.id} in ${terrain} Terrain`);
  }
}

function addIntimidateStatChange(
  resolution: SwitchEntryResolution,
  state: BattleState,
  source: PokemonState,
  target: PokemonState,
  allowMirrorArmor = true,
) {
  if (target.hp.current <= 0 ||
    (state.generation >= 8 && hasAbility(state, target, 'innerfocus')) ||
    hasAbility(state, target, 'clearbody', 'fullmetalbody', 'whitesmoke', 'hypercutter') ||
    (isItemEffectActive(state, target) && isItemAvailable(state, target.item) && id(target.item) === 'clearamulet')) return;
  if (state.generation >= 7 && isItemEffectActive(state, target) && id(target.item) === 'adrenalineorb') {
    const amount = hasAbility(state, target, 'contrary')
      ? -1
      : hasAbility(state, target, 'simple') ? 2 : 1;
    addBoost(resolution, target.id, 'spe', stageDelta(target, 'spe', [amount]));
    consumeItem(resolution, target.id, target.item!);
    resolution.trace!.notes!.push(`Adrenaline Orb raised ${target.id}'s Speed after Intimidate`);
  }
  if (allowMirrorArmor && state.generation >= 8 && hasAbility(state, target, 'mirrorarmor')) {
    addIntimidateStatChange(resolution, state, target, source, false);
    return;
  }
  if (allowMirrorArmor && state.generation >= 9 && hasAbility(state, target, 'guarddog')) {
    addBoost(resolution, target.id, 'atk', stageDelta(target, 'atk', [1]));
    return;
  }
  const contrary = hasAbility(state, target, 'contrary');
  const simple = hasAbility(state, target, 'simple');
  const drop = contrary ? 1 : simple ? -2 : -1;
  if (drop < 0 && hasFlowerVeilProtection(state, target)) return;
  const canTriggerResponse = drop < 0 && stageDelta(target, 'atk', [drop]) < 0;
  if (state.generation >= 5 && hasAbility(state, target, 'defiant') && canTriggerResponse) {
    addBoost(resolution, target.id, 'atk', stageDelta(target, 'atk', [-1, 2]));
    return;
  }
  if (state.generation >= 6 && hasAbility(state, target, 'competitive') && canTriggerResponse) {
    addBoost(resolution, target.id, 'atk', stageDelta(target, 'atk', [-1]));
    addBoost(resolution, target.id, 'spa', stageDelta(target, 'spa', [2]));
    return;
  }
  addBoost(resolution, target.id, 'atk', stageDelta(target, 'atk', [drop]));
}

function addStickyWebStatChange(
  resolution: SwitchEntryResolution,
  state: BattleState,
  target: PokemonState,
) {
  if (hasAbility(state, target, 'clearbody', 'fullmetalbody', 'whitesmoke') ||
    (isItemEffectActive(state, target) && isItemAvailable(state, target.item) && id(target.item) === 'clearamulet')) return;
  const drop = hasAbility(state, target, 'contrary') ? 1 : hasAbility(state, target, 'simple') ? -2 : -1;
  if (drop < 0 && hasFlowerVeilProtection(state, target)) return;
  const speedDelta = stageDelta(target, 'spe', [drop]);
  addBoost(resolution, target.id, 'spe', speedDelta);
  if (speedDelta >= 0) return;
  if (state.generation >= 5 && hasAbility(state, target, 'defiant')) {
    addBoost(resolution, target.id, 'atk', stageDelta(target, 'atk', [2]));
  }
  if (state.generation >= 6 && hasAbility(state, target, 'competitive')) {
    addBoost(resolution, target.id, 'spa', stageDelta(target, 'spa', [2]));
  }
}

function applySupersweetSyrup(
  state: BattleState,
  resolution: SwitchEntryResolution,
  sideId: 'ai' | 'player',
  pokemon: PokemonState,
) {
  if (state.generation < 9 || pokemon.syrupTriggered || !hasAbility(state, pokemon, 'supersweetsyrup')) return;
  resolution.syrupTriggeredByPokemon = {
    ...(resolution.syrupTriggeredByPokemon || {}),
    [pokemon.id]: true,
  };
  const opposingSide: 'ai' | 'player' = sideId === 'ai' ? 'player' : 'ai';
  for (const targetId of state.sides[opposingSide].activeIds) {
    const target = getPokemon(state, targetId);
    if (!target || target.hp.current <= 0 || (target.substituteHp || 0) > 0) continue;
    addBoost(resolution, target.id, 'eva', stageDelta(target, 'eva', [-1]));
  }
  resolution.trace!.notes!.push(`Supersweet Syrup triggered for ${pokemon.id}`);
}

function applyZeroToHeroEntry(
  state: BattleState,
  resolution: SwitchEntryResolution,
  pokemon: PokemonState,
) {
  if (state.generation < 9 || !pokemon.zeroToHeroTriggered ||
    !hasAbility(state, pokemon, 'zerotohero') || id(pokemon.species) !== 'palafin') return;
  setSpeciesOverride(resolution, pokemon.id, 'Palafin-Hero');
  resolution.trace!.notes!.push(`Zero to Hero changed ${pokemon.id} to Palafin-Hero`);
}

function applyCuriousMedicine(
  state: BattleState,
  resolution: SwitchEntryResolution,
  sideId: 'ai' | 'player',
  action: SwitchAction,
  pokemon: PokemonState,
) {
  if (state.generation < 8 || state.mode !== 'Doubles' || !hasAbility(state, pokemon, 'curiousmedicine')) return;
  let cleared = false;
  for (const allyId of state.sides[sideId].activeIds) {
    if (allyId === action.actorId || allyId === action.replacementId) continue;
    const ally = getPokemon(state, allyId);
    if (!ally || ally.hp.current <= 0) continue;
    setBoosts(resolution, ally.id, {});
    cleared = true;
  }
  if (cleared) resolution.trace!.notes!.push(`Curious Medicine cleared active ally boosts for ${pokemon.id}`);
}

function applyMimicryEntry(
  state: BattleState,
  resolution: SwitchEntryResolution,
  action: SwitchAction,
  pokemon: PokemonState,
  terrain: Terrain | undefined,
) {
  if (state.generation < 8 || !terrain) return;
  const targetIds = [pokemon.id, ...(['ai', 'player'] as const).flatMap(candidateSideId =>
    state.sides[candidateSideId].activeIds.filter(idValue => idValue !== action.actorId))];
  let changed = false;
  for (const pokemonId of Array.from(new Set(targetIds))) {
    const target = getPokemon(state, pokemonId);
    if (!target || target.hp.current <= 0 || !isMimicryActive(state, target)) continue;
    setTypeOverride(resolution, target.id, mimicryTypeOverride(terrain));
    changed = true;
  }
  if (changed) resolution.trace!.notes!.push(`Mimicry applied ${terrain} types on switch entry`);
}

function applyScreenCleaner(
  state: BattleState,
  resolution: SwitchEntryResolution,
  pokemon: PokemonState,
) {
  if (state.generation < 8 || pokemon.hp.current <= 0 || !hasAbility(state, pokemon, 'screencleaner')) return;
  const screens = ['reflect', 'lightScreen', 'auroraVeil'] as const;
  const updates: Partial<Record<'ai' | 'player', Partial<Record<typeof screens[number], boolean>>>> = {};
  let cleared = false;
  for (const sideId of ['ai', 'player'] as const) {
    const effects = state.sides[sideId].effects;
    const sideUpdate: Partial<Record<typeof screens[number], boolean>> = {};
    for (const screen of screens) {
      if (effects?.[screen]) {
        sideUpdate[screen] = false;
        cleared = true;
      }
    }
    if (Object.keys(sideUpdate).length) updates[sideId] = sideUpdate;
  }
  if (!cleared) return;
  resolution.sideEffectsBySide = updates;
  resolution.trace!.notes!.push(`Screen Cleaner cleared screens for ${pokemon.id}`);
}

function applyEntryStatBoostAbilities(
  state: BattleState,
  resolution: SwitchEntryResolution,
  pokemon: PokemonState,
) {
  if (state.generation < 8 || pokemon.hp.current <= 0) return;
  if (hasAbility(state, pokemon, 'intrepidsword') && !pokemon.intrepidSwordTriggered) {
    addBoost(resolution, pokemon.id, 'atk', stageDelta(pokemon, 'atk', [1]));
    resolution.intrepidSwordTriggeredByPokemon = {[pokemon.id]: true};
    resolution.trace!.notes!.push(`Intrepid Sword raised ${pokemon.id}'s Attack`);
  }
  if (hasAbility(state, pokemon, 'dauntlessshield') && !pokemon.dauntlessShieldTriggered) {
    addBoost(resolution, pokemon.id, 'def', stageDelta(pokemon, 'def', [1]));
    resolution.dauntlessShieldTriggeredByPokemon = {[pokemon.id]: true};
    resolution.trace!.notes!.push(`Dauntless Shield raised ${pokemon.id}'s Defense`);
  }
}

function applyWhiteHerbEntry(
  state: BattleState,
  resolution: SwitchEntryResolution,
) {
  if (state.generation < 4) return;
  const activeIds = (['ai', 'player'] as const).flatMap(sideId => state.sides[sideId].activeIds);
  for (const pokemonId of Array.from(new Set(activeIds))) {
    const holder = getPokemon(state, pokemonId);
    if (!holder || holder.hp.current <= 0 || !isItemEffectActive(state, holder) || id(holder.item) !== 'whiteherb') continue;
    const additive = resolution.boostsByPokemon?.[holder.id] || {};
    const absolute = resolution.setBoostsByPokemon?.[holder.id];
    const restoration: StatBoosts = {};
    for (const stat of ['atk', 'def', 'spa', 'spd', 'spe', 'acc', 'eva'] as const) {
      const base = absolute?.[stat] !== undefined ? absolute[stat]! : holder.boosts?.[stat] || 0;
      const additiveAmount = additive[stat] || 0;
      const finalStage = base + additiveAmount;
      if (finalStage < 0) restoration[stat] = additiveAmount ? -additiveAmount : 0;
    }
    if (!Object.keys(restoration).length) continue;
    setBoosts(resolution, holder.id, restoration);
    consumeItem(resolution, holder.id, holder.item!);
    resolution.trace!.notes!.push(`White Herb cleared negative entry stages for ${holder.id}`);
  }
}

function applyPastelVeilEntry(
  state: BattleState,
  resolution: SwitchEntryResolution,
  sideId: 'ai' | 'player',
  action: SwitchAction,
  pokemon: PokemonState,
) {
  if (state.generation < 8) return;
  const affectedIds = [pokemon.id, ...state.sides[sideId].activeIds.filter(idValue => idValue !== action.actorId)];
  const hasHolder = affectedIds.some(idValue => {
    const holder = getPokemon(state, idValue);
    return !!holder && holder.hp.current > 0 && hasAbility(state, holder, 'pastelveil');
  });
  if (!hasHolder) return;
  for (const targetId of Array.from(new Set(affectedIds))) {
    const target = getPokemon(state, targetId);
    if (!target || target.hp.current <= 0 || (target.status !== 'psn' && target.status !== 'tox')) continue;
    resolution.statusByPokemon = {
      ...(resolution.statusByPokemon || {}),
      [target.id]: '',
    };
    resolution.toxicCounterByPokemon = {
      ...(resolution.toxicCounterByPokemon || {}),
      [target.id]: 0,
    };
  }
  if (resolution.statusByPokemon) resolution.trace!.notes!.push(`Pastel Veil cured active allies on ${pokemon.id}'s entry`);
}

function entryFieldEffects(
  state: BattleState,
  pokemon: PokemonState,
): {weather?: Weather; terrain?: Terrain} {
  if (!isAbilityActive(pokemon, state)) return {};
  const ability = id(getEffectiveAbility(pokemon));
  if (!isAbilityAvailable(state.generation, ability)) return {};
  if (ability === 'drought') return {weather: 'Sun'};
  if (ability === 'drizzle') return {weather: 'Rain'};
  if (ability === 'sandstream') return {weather: 'Sand'};
  if (ability === 'snowwarning') return {weather: state.generation >= 9 ? 'Snow' : 'Hail'};
  if (state.generation >= 9 && ability === 'orichalcumpulse') return {weather: 'Sun'};
  if (state.generation >= 9 && ability === 'hadronengine') return {terrain: 'Electric'};
  if (state.generation >= 7 && ability === 'electricsurge') return {terrain: 'Electric'};
  if (state.generation >= 7 && ability === 'grassysurge') return {terrain: 'Grassy'};
  if (state.generation >= 7 && ability === 'psychicsurge') return {terrain: 'Psychic'};
  if (state.generation >= 7 && ability === 'mistysurge') return {terrain: 'Misty'};
  return {};
}

function damageFromEntryHazards(state: BattleState, pokemon: PokemonState, types: string[]): number {
  const effects = state.sides[sideForPokemon(state, pokemon.id)].effects;
  if ((state.generation >= 8 && isItemEffectActive(state, pokemon) && id(pokemon.item) === 'heavydutyboots') ||
    hasAbility(state, pokemon, 'magicguard', 'mountaineer')) return 0;
  const generation = Calc.Generations.get(state.generation);
  let damage = 0;
  for (const [effectName, typeName] of [['stealthRock', 'Rock'], ['steelsurge', 'Steel']] as const) {
    if ((effectName === 'stealthRock' && state.generation < 4) ||
      (effectName === 'steelsurge' && state.generation < 8)) continue;
    if (!effects?.[effectName]) continue;
    const type = generation.types.get(Calc.toID(typeName));
    if (!type) continue;
    const effectiveness = type.effectiveness as Readonly<Record<string, number | undefined>>;
    const multiplier = types.reduce((total, entryType) => total * (effectiveness[entryType] ?? 1), 1);
    if (multiplier > 0) damage += Math.max(1, Math.floor(multiplier * pokemon.hp.max / 8));
  }
  return damage;
}

/** Derive entry-hazard consequences for a legal switch or forced replacement. */
export function deriveSwitchEntryResolution(
  state: BattleState,
  action: SwitchAction,
  options: SwitchEntryOptions = {},
): SwitchEntryResolution {
  const sideId = sideForPokemon(state, action.actorId);
  const side = state.sides[sideId];
  const pokemon = getPokemon(state, action.replacementId);
  if (!pokemon) throw new Error('Switch entry references an unknown replacement');
  const effects = side.effects || {};
  const resolution: SwitchEntryResolution = {
    trace: {source: 'battle-engine', notes: ['derived switch entry effects']},
  };

  // Entry abilities are evaluated against the post-switch active roster so an
  // outgoing Neutralizing Gas holder no longer suppresses the replacement.
  const entrySide = {
    ...state.sides[sideId],
    activeIds: state.sides[sideId].activeIds.map(idValue =>
      idValue === action.actorId ? action.replacementId : idValue),
  };
  const entryRosterState: BattleState = {
    ...state,
    sides: {...state.sides, [sideId]: entrySide},
  };
  const fieldEffects = entryFieldEffects(entryRosterState, pokemon);
  if (fieldEffects.weather && isStrongWeather(state.field.weather) && state.field.weather !== fieldEffects.weather) {
    delete fieldEffects.weather;
    resolution.trace!.notes!.push('strong weather blocked the entry weather setter');
  }
  if (fieldEffects.weather || fieldEffects.terrain) {
    resolution.field = fieldEffects;
    resolution.fieldDurations = {
      ...(fieldEffects.weather ? {weather: null} : {}),
      ...(fieldEffects.terrain ? {terrain: null} : {}),
    };
    resolution.trace!.notes!.push('applied permanent entry weather/terrain ability');
  }
  const entryWeather = fieldEffects.weather || state.field.weather;
  const entryState: BattleState = {
    ...entryRosterState,
    field: {
      ...state.field,
      weather: entryWeather,
      terrain: fieldEffects.terrain || state.field.terrain,
    },
  };
  const boots = state.generation >= 8 && isItemEffectActive(entryState, pokemon) &&
    id(pokemon.item) === 'heavydutyboots';
  const grounded = isGrounded(entryState, pokemon.id);
  const types = getEffectiveTypes(entryState, pokemon.id);
  const weatherFormOverride = weatherFormSpeciesOverride(entryState, pokemon, entryWeather);
  if (weatherFormOverride !== undefined) {
    resolution.speciesOverrideByPokemon = {
      ...(resolution.speciesOverrideByPokemon || {}),
      [pokemon.id]: weatherFormOverride,
    };
    resolution.trace!.notes!.push(`Weather-form ability changed ${pokemon.id}'s form on entry`);
  }

  const entryTerrain = fieldEffects.terrain || state.field.terrain;
  applyMimicryEntry(entryState, resolution, action, pokemon, entryTerrain);
  applyZeroToHeroEntry(entryState, resolution, pokemon);
  applyScreenCleaner(entryState, resolution, pokemon);
  applyEntryStatBoostAbilities(entryState, resolution, pokemon);
  applyPastelVeilEntry(entryState, resolution, sideId, action, pokemon);
  activateBoosterEnergy(
    entryState,
    resolution,
    [
      pokemon.id,
      ...(fieldEffects.weather || fieldEffects.terrain
        ? (['ai', 'player'] as const).flatMap(candidateSideId =>
          entryState.sides[candidateSideId].activeIds.filter(idValue => idValue !== action.actorId))
        : []),
    ],
    fieldEffects.weather || entryState.field.weather,
    entryTerrain,
  );
  if (state.generation >= 7 && entryTerrain) {
    const activeIds = (['ai', 'player'] as const).flatMap(activeSide =>
      entryState.sides[activeSide].activeIds.filter(idValue => idValue !== action.actorId));
    activateTerrainSeeds(entryState, resolution, entryTerrain, [pokemon.id, ...activeIds]);
  }

  if (entryState.generation >= 3 && hasAbility(entryState, pokemon, 'intimidate')) {
    const opposingSide: 'ai' | 'player' = sideId === 'ai' ? 'player' : 'ai';
    for (const targetId of entryState.sides[opposingSide].activeIds) {
      const target = getPokemon(entryState, targetId);
      if (target) addIntimidateStatChange(resolution, entryState, pokemon, target);
    }
    resolution.trace!.notes!.push('applied Intimidate to opposing active targets');
  }
  applySupersweetSyrup(entryState, resolution, sideId, pokemon);
  applyCuriousMedicine(entryState, resolution, sideId, action, pokemon);
  applyCopyEntryAbilities(entryState, resolution, sideId, pokemon, options);
  if (hasSlowStartEntryAbility(entryState, resolution, pokemon)) {
    addVolatile(resolution, pokemon.id, 'slowStart', {turns: 5});
    resolution.trace!.notes!.push(`Slow Start began for ${pokemon.id}`);
  }

  if (!boots) {
    addHpDelta(resolution, pokemon.id, -damageFromEntryHazards(entryState, pokemon, types));
    if (grounded && !hasAbility(entryState, pokemon, 'magicguard')) {
      const spikes = effects.spikes || 0;
      const divisor = spikes === 1 ? 8 : spikes === 2 ? 6 : spikes === 3 ? 4 : undefined;
      if (entryState.generation >= 2 && divisor) {
        addHpDelta(resolution, pokemon.id, -Math.max(1, Math.floor(pokemon.hp.max / divisor)));
      }
    }
    if (entryState.generation >= 4 && grounded && (effects.toxicSpikes || 0) > 0) {
      if (hasType(types, 'Poison')) {
        resolution.clearToxicSpikesBySide = {[sideId]: true};
      } else if (!pokemon.status && canApplyMajorStatus(
        entryState,
        pokemon.id,
        pokemon.id,
        (effects.toxicSpikes || 0) >= 2 ? 'tox' : 'psn',
      )) {
        const status: StatusName = (effects.toxicSpikes || 0) >= 2 ? 'tox' : 'psn';
        resolution.statusByPokemon = {[pokemon.id]: status};
        if (status === 'tox') resolution.toxicCounterByPokemon = {[pokemon.id]: 1};
      }
    }
    if (entryState.generation >= 6 && grounded && effects.stickyWeb) addStickyWebStatChange(resolution, entryState, pokemon);
  }
  applyHospitality(entryState, resolution, sideId, action, pokemon);
  applyCommander(entryState, resolution, sideId, action, pokemon);
  applyCostar(entryState, resolution, sideId, action, pokemon);
  applyWhiteHerbEntry(entryState, resolution);
  return resolution;
}
