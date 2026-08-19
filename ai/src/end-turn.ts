import {getPokemon, isDisguiseActive, isRainWeather, isSunWeather, isWeatherSuppressed, sideForPokemon} from './actions';
import {getEffectiveAbility, isAbilityActive, isAbilityAvailable} from './abilities';
import {canApplyMajorStatus, canApplyVolatile, getEffectiveTypes, isGrounded} from './eligibility';
import {confusionBerryDislikesNature, statusBerryCures} from './berry-effects';
import {isItemAvailable, isItemEffectActive} from './items';
import {getEffectiveSpecies} from './stat-transforms';
import {weatherFormSpeciesOverride} from './weather-forms';
import {getMoveMaxPP} from './move-metadata';
import {
  BattleState,
  EndTurnResolution,
  PokemonState,
  StatBoosts,
  StatusName,
  VolatileState,
  VolatileStatusName,
} from './model';
import {validateEndTurnResolution} from './validation';

const MOODY_STATS = ['atk', 'def', 'spa', 'spd', 'spe', 'acc', 'eva'] as const;
const CONFUSION_BERRIES = new Set(['aguavberry', 'figyberry', 'iapapaberry', 'magoberry', 'wikiberry']);
const STAT_BOOST_BERRIES: Record<string, keyof StatBoosts> = {
  liechiberry: 'atk',
  ganlonberry: 'def',
  salacberry: 'spe',
  petayaberry: 'spa',
  apicotberry: 'spd',
};
const RANDOM_BERRY_BOOST_STATS: Array<keyof StatBoosts> = ['atk', 'def', 'spa', 'spd', 'spe'];

function id(name: string | undefined): string {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isBerry(item: string | undefined): boolean {
  return id(item).endsWith('berry');
}

function activePokemon(state: BattleState): PokemonState[] {
  return (['ai', 'player'] as const).flatMap(sideId =>
    state.sides[sideId].activeIds
      .map(pokemonId => getPokemon(state, pokemonId))
      .filter((pokemon): pokemon is PokemonState => !!pokemon && pokemon.hp.current > 0));
}

function calcTypes(state: BattleState, pokemon: PokemonState): string[] {
  return getEffectiveTypes(state, pokemon.id);
}

function hasAbility(state: BattleState, pokemon: PokemonState, ...abilities: string[]): boolean {
  return isAbilityActive(pokemon, state) && abilities.some(ability =>
    isAbilityAvailable(state.generation, ability) && id(getEffectiveAbility(pokemon)) === id(ability));
}

function berryEffectMultiplier(state: BattleState, pokemon: PokemonState): number {
  return hasAbility(state, pokemon, 'ripen') ? 2 : 1;
}

function itemEffectsActive(state: BattleState, pokemon: PokemonState): boolean {
  return isItemEffectActive(state, pokemon);
}

function hasActiveWeatherItem(state: BattleState, pokemon: PokemonState, item: string): boolean {
  return state.generation >= 6 && id(pokemon.item) === item &&
    itemEffectsActive(state, pokemon);
}

function hasType(types: string[], ...wanted: string[]): boolean {
  const normalized = new Set(types.map(id));
  return wanted.some(type => normalized.has(id(type)));
}

function drainRecoveryAmount(state: BattleState, pokemon: PokemonState, amount: number): number {
  if (state.generation >= 4 && itemEffectsActive(state, pokemon) && id(pokemon.item) === 'bigroot') {
    return Math.floor(amount * 13 / 10);
  }
  return amount;
}

function isMagicGuard(state: BattleState, pokemon: PokemonState): boolean {
  return state.generation >= 4 && hasAbility(state, pokemon, 'magicguard');
}

function weatherDamage(state: BattleState, pokemon: PokemonState, types: string[]): number {
  const weatherImmunity = state.generation >= 5 && hasAbility(state, pokemon, 'overcoat');
  if (isWeatherSuppressed(state) || isMagicGuard(state, pokemon) || weatherImmunity ||
    hasActiveWeatherItem(state, pokemon, 'safetygoggles')) return 0;
  if (state.generation >= 2 && state.field.weather === 'Sand' &&
    !hasType(types, 'Rock', 'Ground', 'Steel')) {
    // Sand Rush/Sand Force always exempt; Sand Veil's immunity began Gen 4.
    if (hasAbility(state, pokemon, 'sandrush') || hasAbility(state, pokemon, 'sandforce') ||
      (state.generation >= 4 && hasAbility(state, pokemon, 'sandveil'))) return 0;
    const denominator = state.generation === 2 ? 8 : 16;
    return Math.max(1, Math.floor(pokemon.hp.max / denominator));
  }
  if (state.generation >= 3 && state.field.weather === 'Hail' && state.generation < 9 &&
    !hasType(types, 'Ice')) {
    // Ice Body nets +1/16 (was charged the chip AND credited the heal,
    // netting zero); Snow Cloak and Slush Rush take no hail chip either.
    if (hasAbility(state, pokemon, 'icebody') || hasAbility(state, pokemon, 'snowcloak') ||
      hasAbility(state, pokemon, 'slushrush')) return 0;
    return Math.max(1, Math.floor(pokemon.hp.max / 16));
  }
  return 0;
}

function grassyTerrainDelta(state: BattleState, pokemon: PokemonState): number {
  if (state.generation < 6 || state.field.terrain !== 'Grassy' ||
    !isGrounded(state, pokemon.id)) return 0;
  return Math.max(1, Math.floor(pokemon.hp.max / 16));
}

function volatileRecoveryDelta(pokemon: PokemonState): number {
  if (!pokemon.volatile?.aquaRing && !pokemon.volatile?.ingrain) return 0;
  return Math.max(1, Math.floor(pokemon.hp.max / 16));
}

function addDelta(resolution: EndTurnResolution, pokemonId: string, delta: number) {
  if (!Number.isFinite(delta) || delta === 0) return;
  resolution.hpDeltaByPokemon = {...(resolution.hpDeltaByPokemon || {})};
  resolution.hpDeltaByPokemon[pokemonId] =
    (resolution.hpDeltaByPokemon[pokemonId] || 0) + delta;
}

function setItem(resolution: EndTurnResolution, pokemonId: string, item: string | null) {
  resolution.itemByPokemon = {...(resolution.itemByPokemon || {}), [pokemonId]: item};
}

function setMoves(resolution: EndTurnResolution, pokemonId: string, moves: PokemonState['moves']) {
  resolution.movesByPokemon = {
    ...(resolution.movesByPokemon || {}),
    [pokemonId]: moves,
  };
}

function setSpeciesOverride(resolution: EndTurnResolution, pokemonId: string, species: string | null) {
  resolution.speciesOverrideByPokemon = {
    ...(resolution.speciesOverrideByPokemon || {}),
    [pokemonId]: species,
  };
}

function applyForecastFormChange(state: BattleState, resolution: EndTurnResolution, pokemon: PokemonState) {
  const override = weatherFormSpeciesOverride(state, pokemon);
  if (override === undefined) return;
  setSpeciesOverride(resolution, pokemon.id, override);
  resolution.trace!.notes!.push(`Forecast changed ${pokemon.id}'s form`);
}

function applyHpThresholdFormChange(
  state: BattleState,
  resolution: EndTurnResolution,
  pokemon: PokemonState,
  projectedHp: number,
) {
  if (projectedHp <= 0) return;
  const baseSpecies = id(pokemon.species);
  const currentSpecies = id(getEffectiveSpecies(pokemon));
  const setForm = (species: string | null, note: string) => {
    if (species === null && currentSpecies === baseSpecies) return;
    if (species !== null && currentSpecies === id(species)) return;
    setSpeciesOverride(resolution, pokemon.id, species);
    resolution.trace!.notes!.push(note);
  };

  if (state.generation >= 7 && hasAbility(state, pokemon, 'schooling') &&
    baseSpecies === 'wishiwashi' && pokemon.level >= 20) {
    if (projectedHp > pokemon.hp.max / 4) {
      setForm('Wishiwashi-School', `Schooling changed ${pokemon.id} to School Form`);
    } else if (currentSpecies === 'wishiwashischool') {
      setForm(null, `Schooling changed ${pokemon.id} to Solo Form`);
    }
  }

  if (state.generation >= 7 && hasAbility(state, pokemon, 'shieldsdown') && baseSpecies === 'minior') {
    if (projectedHp > pokemon.hp.max / 2) {
      setForm('Minior-Meteor', `Shields Down restored Meteor Form for ${pokemon.id}`);
    } else if (currentSpecies === 'miniormeteor') {
      setForm(null, `Shields Down exposed the core of ${pokemon.id}`);
    }
  }

  if (state.generation >= 5 && hasAbility(state, pokemon, 'zenmode') &&
    (baseSpecies === 'darmanitan' || baseSpecies === 'darmanitangalar')) {
    const zenForm = baseSpecies === 'darmanitangalar'
      ? 'Darmanitan-Galar-Zen'
      : 'Darmanitan-Zen';
    if (projectedHp <= pokemon.hp.max / 2) {
      setForm(zenForm, `Zen Mode changed ${pokemon.id} to ${zenForm}`);
    } else if (currentSpecies === id(zenForm)) {
      setForm(null, `Zen Mode restored ${pokemon.id}'s base form`);
    }
  }

  if (state.generation >= 7 && hasAbility(state, pokemon, 'powerconstruct') &&
    baseSpecies.startsWith('zygarde') && currentSpecies !== 'zygardecomplete' &&
    projectedHp <= pokemon.hp.max / 2) {
    setForm('Zygarde-Complete', `Power Construct changed ${pokemon.id} to Complete Form`);
  }

  if (state.generation >= 8 && hasAbility(state, pokemon, 'hungerswitch') && baseSpecies === 'morpeko') {
    setForm(currentSpecies === 'morpekohangry' ? 'Morpeko' : 'Morpeko-Hangry',
      `Hunger Switch toggled ${pokemon.id}'s form`);
  }
}

function requestEmergencySwitch(state: BattleState, resolution: EndTurnResolution, pokemon: PokemonState) {
  const sourceIsActive = (sourceId: string | undefined) =>
    !sourceId || (getPokemon(state, sourceId)?.hp.current || 0) > 0;
  const trapped = pokemon.volatile?.trapped;
  const partiallyTrapped = pokemon.volatile?.partiallyTrapped;
  const octolock = pokemon.volatile?.octolock;
  if (pokemon.hp.current <= 0 || pokemon.volatile?.ingrain || pokemon.volatile?.commanding ||
    pokemon.volatile?.commanded || state.field.fairyLock ||
    (trapped && sourceIsActive(trapped.sourceId)) ||
    (partiallyTrapped && sourceIsActive(partiallyTrapped.sourceId)) ||
    (octolock && sourceIsActive(octolock.sourceId))) return;
  const sideId = sideForPokemon(state, pokemon.id);
  const hasReplacement = state.sides[sideId].party.some(candidate =>
    candidate.id !== pokemon.id && candidate.hp.current > 0 && !state.sides[sideId].activeIds.includes(candidate.id));
  if (!hasReplacement) return;
  resolution.forcedSwitchByPokemon = {
    ...(resolution.forcedSwitchByPokemon || {}),
    [pokemon.id]: true,
  };
}

function consumeItem(resolution: EndTurnResolution, pokemonId: string, item: string) {
  setItem(resolution, pokemonId, null);
  resolution.consumedItemByPokemon = {
    ...(resolution.consumedItemByPokemon || {}),
    [pokemonId]: item,
  };
}

function armCudChew(
  resolution: EndTurnResolution,
  state: BattleState,
  pokemon: PokemonState,
  item: string,
) {
  if (state.generation < 9 || !isBerry(item) || !hasAbility(state, pokemon, 'cudchew')) return;
  setVolatile(resolution, pokemon.id, 'cudChew', {turns: 2, item});
  resolution.trace!.notes!.push(`Cud Chew stored ${item} for ${pokemon.id}`);
}

function addBoosts(
  resolution: EndTurnResolution,
  state: BattleState,
  pokemonId: string,
  boosts: StatBoosts,
  alreadyNormalized = false,
) {
  const pokemon = getPokemon(state, pokemonId);
  if (!pokemon) return;
  const contrary = !alreadyNormalized && hasAbility(state, pokemon, 'contrary');
  const simple = !alreadyNormalized && hasAbility(state, pokemon, 'simple');
  const previous = resolution.boostsByPokemon?.[pokemonId] || {};
  const normalized: StatBoosts = {};
  for (const stat of Object.keys(boosts) as Array<keyof StatBoosts>) {
    const amount = boosts[stat];
    if (amount === undefined) continue;
    const adjusted = alreadyNormalized
      ? amount
      : amount * (contrary ? -1 : 1) * (simple ? 2 : 1);
    const current = (pokemon.boosts?.[stat] || 0) + (previous[stat] || 0);
    const effective = Math.max(-6, Math.min(6, current + adjusted)) - current;
    if (effective) normalized[stat] = effective;
  }
  if (!Object.keys(normalized).length) return;
  resolution.boostsByPokemon = {...(resolution.boostsByPokemon || {})};
  resolution.boostsByPokemon[pokemonId] = {
    ...previous,
    ...Object.fromEntries(Object.entries(normalized).map(([stat, amount]) => [
      stat,
      (previous[stat as keyof StatBoosts] || 0) + amount,
    ])),
  };
}

function sampleIndex(random: () => number, length: number, label: string): number {
  const roll = random();
  if (!Number.isFinite(roll)) throw new Error(`${label} sampler must return a finite number`);
  return Math.min(length - 1, Math.floor(Math.max(0, Math.min(0.999999999999, roll)) * length));
}

function passesChance(random: () => number, chance: number, label: string): boolean {
  const roll = random();
  if (!Number.isFinite(roll)) throw new Error(`${label} sampler must return a finite number`);
  return roll >= 0 && roll < chance;
}

function applyMoody(
  resolution: EndTurnResolution,
  pokemon: PokemonState,
  state: BattleState,
  random: () => number,
) {
  const generation = state.generation;
  if (generation < 5 || !hasAbility(state, pokemon, 'moody')) return;
  const stats = MOODY_STATS;
  const current = pokemon.boosts || {};
  const raiseable = stats.filter(stat => (current[stat] || 0) < 6);
  if (!raiseable.length) return;
  const raised = raiseable[sampleIndex(random, raiseable.length, 'Moody raise')];
  const droppable = stats.filter(stat => stat !== raised && (current[stat] || 0) > -6);
  const boosts: StatBoosts = {[raised]: 2};
  let dropped: typeof MOODY_STATS[number] | undefined;
  if (droppable.length) {
    dropped = droppable[sampleIndex(random, droppable.length, 'Moody drop')];
    boosts[dropped] = -1;
  }
  addBoosts(resolution, state, pokemon.id, boosts);
  resolution.trace!.notes!.push(`Moody raised ${raised}${dropped ? ` and lowered ${dropped}` : ''}`);
}

function addDelayedDamage(
  resolution: EndTurnResolution,
  state: BattleState,
  pokemonId: string,
  damage: number,
): boolean {
  if (!Number.isFinite(damage) || damage <= 0) return false;
  const pokemon = getPokemon(state, pokemonId);
  if (!pokemon) return false;
  if (isDisguiseActive(state, pokemon)) {
    resolution.disguiseBrokenByPokemon = {
      ...(resolution.disguiseBrokenByPokemon || {}),
      [pokemonId]: true,
    };
    return true;
  }
  const hasResolution = resolution.substituteHpByPokemon &&
    Object.prototype.hasOwnProperty.call(resolution.substituteHpByPokemon, pokemonId);
  const substituteHp = hasResolution
    ? resolution.substituteHpByPokemon?.[pokemonId] || 0
    : pokemon.substituteHp || 0;
  if (substituteHp > 0) {
    resolution.substituteHpByPokemon = {
      ...(resolution.substituteHpByPokemon || {}),
      [pokemonId]: Math.max(0, substituteHp - damage) || null,
    };
  } else {
    addDelta(resolution, pokemonId, -damage);
  }
  return false;
}

function setStatus(resolution: EndTurnResolution, pokemonId: string, status: StatusName | '') {
  resolution.statusByPokemon = {...(resolution.statusByPokemon || {}), [pokemonId]: status};
}

function setStatusTurns(resolution: EndTurnResolution, pokemonId: string, turns: number | null) {
  resolution.statusTurnsByPokemon = {
    ...(resolution.statusTurnsByPokemon || {}),
    [pokemonId]: turns,
  };
}

function setToxicCounter(resolution: EndTurnResolution, pokemonId: string, counter: number) {
  resolution.toxicCounterByPokemon = {
    ...(resolution.toxicCounterByPokemon || {}),
    [pokemonId]: counter,
  };
}

function setVolatile(
  resolution: EndTurnResolution,
  pokemonId: string,
  name: VolatileStatusName,
  value: VolatileState | null,
) {
  resolution.volatileByPokemon = {...(resolution.volatileByPokemon || {})};
  resolution.volatileByPokemon[pokemonId] = {
    ...(resolution.volatileByPokemon[pokemonId] || {}),
    [name]: value,
  };
}

function residualStatusDamage(state: BattleState, pokemon: PokemonState): number {
  if (isMagicGuard(state, pokemon)) return 0;
  let damage = 0;
  if (pokemon.status === 'brn') {
    const denominator = state.generation === 1 || state.generation >= 7 ? 16 : 8;
    const burnDamage = Math.max(1, Math.floor(pokemon.hp.max / denominator));
    damage += state.generation >= 4 && hasAbility(state, pokemon, 'heatproof')
      ? Math.max(1, Math.floor(burnDamage / 2))
      : burnDamage;
  }
  if (pokemon.status === 'psn') {
    damage += Math.max(1, Math.floor(pokemon.hp.max / (state.generation === 1 ? 16 : 8)));
  }
  if (pokemon.status === 'tox') {
    const counter = Math.max(1, pokemon.toxicCounter || 1);
    damage += Math.max(1, Math.floor(pokemon.hp.max * Math.min(counter, 15) / 16));
  }
  if (state.generation >= 2 && state.generation < 8 && pokemon.status === 'slp' && pokemon.volatile?.nightmare) {
    damage += Math.max(1, Math.floor(pokemon.hp.max / 4));
  }
  if (state.generation >= 2 && pokemon.volatile?.curse) {
    damage += Math.max(1, Math.floor(pokemon.hp.max / 4));
  }
  return damage;
}

function partialTrapDamage(state: BattleState, pokemon: PokemonState): number {
  const trap = pokemon.volatile?.partiallyTrapped;
  if (!trap || isMagicGuard(state, pokemon)) return 0;
  const source = trap.sourceId ? getPokemon(state, trap.sourceId) : undefined;
  if (!source || source.hp.current <= 0) return 0;
  const bindingBand = itemEffectsActive(state, source) && id(source.item) === 'bindingband';
  const denominator = bindingBand
    ? state.generation >= 6 ? 6 : 8
    : state.generation >= 6 ? 8 : 16;
  return Math.max(1, Math.floor(pokemon.hp.max / denominator));
}

function applyOctolockDrops(
  state: BattleState,
  resolution: EndTurnResolution,
  target: PokemonState,
  source: PokemonState,
  allowMirrorArmor = true,
) {
  if (source.hp.current <= 0 || !state.sides[sideForPokemon(state, source.id)].activeIds.includes(source.id)) return;
  const targetAbility = id(getEffectiveAbility(target));
  const contrary = hasAbility(state, target, 'contrary');
  const simple = hasAbility(state, target, 'simple');
  let amount = contrary ? 1 : -1;
  if (simple) amount *= 2;
  if (amount < 0) {
    const blocksDrop = hasAbility(state, target, 'clearbody', 'fullmetalbody', 'whitesmoke') ||
      state.sides[sideForPokemon(state, target.id)].effects?.mist === true ||
      (itemEffectsActive(state, target) && isItemAvailable(state, target.item) && id(target.item) === 'clearamulet');
    if (blocksDrop) return;
    if (allowMirrorArmor && hasAbility(state, target, 'mirrorarmor')) {
      applyOctolockDrops(state, resolution, source, target, false);
      return;
    }
  }
  addBoosts(resolution, state, target.id, {def: amount, spd: amount}, true);
  if (amount < 0 && hasAbility(state, target, 'defiant')) {
    addBoosts(resolution, state, target.id, {atk: 2}, true);
  }
  if (amount < 0 && hasAbility(state, target, 'competitive')) {
    addBoosts(resolution, state, target.id, {spa: 2}, true);
  }
}

function residualAbilityDelta(
  state: BattleState,
  pokemon: PokemonState,
  magicGuard: boolean,
): number {
  if (state.generation < 3 || !isAbilityActive(pokemon, state) || isWeatherSuppressed(state)) return 0;
  const ability = id(getEffectiveAbility(pokemon));
  const weather = state.field.weather;
  const eighth = Math.max(1, Math.floor(pokemon.hp.max / 8));
  const sixteenth = Math.max(1, Math.floor(pokemon.hp.max / 16));
  if (state.generation >= 3 && isRainWeather(weather) && ability === 'raindish') return sixteenth;
  if (state.generation >= 4 && isRainWeather(weather) && ability === 'dryskin') return eighth;
  if (state.generation >= 4 && ((weather === 'Hail' && state.generation < 9) || weather === 'Snow')) {
    if (ability === 'icebody') return sixteenth;
  }
  if (state.generation >= 4 && isSunWeather(weather) && ability === 'dryskin') return magicGuard ? 0 : -eighth;
  if (state.generation >= 4 && isSunWeather(weather) && ability === 'solarpower') return magicGuard ? 0 : -eighth;
  return 0;
}

function residualItemDelta(state: BattleState, pokemon: PokemonState, types: string[], magicGuard: boolean): number {
  if (!itemEffectsActive(state, pokemon)) return 0;
  const item = id(pokemon.item);
  const eighth = Math.max(1, Math.floor(pokemon.hp.max / 8));
  const sixteenth = Math.max(1, Math.floor(pokemon.hp.max / 16));
  if (state.generation >= 2 && item === 'leftovers') return sixteenth;
  if (state.generation >= 4 && item === 'blacksludge') {
    if (hasType(types, 'Poison')) return sixteenth;
    return magicGuard ? 0 : -eighth;
  }
  if (state.generation >= 4 && item === 'stickybarb') return magicGuard ? 0 : -eighth;
  return 0;
}

function applyHealingBerry(
  resolution: EndTurnResolution,
  state: BattleState,
  pokemon: PokemonState,
  projectedHp: number,
) {
  if (state.generation < 2 || projectedHp <= 0 || projectedHp > Math.floor(pokemon.hp.max / 2) ||
    !itemEffectsActive(state, pokemon)) return;
  const itemId = id(pokemon.item);
  let healing = 0;
  let restorativeItem = false;
  if (itemId === 'berryjuice') {
    restorativeItem = true;
    healing = 20;
  } else if (itemId === 'oranberry' && state.generation >= 3) {
    restorativeItem = true;
    healing = 10 * berryEffectMultiplier(state, pokemon);
  } else if (itemId === 'sitrusberry' && state.generation >= 3) {
    restorativeItem = true;
    healing = (state.generation === 3 ? 30 : Math.floor(pokemon.hp.max / 4)) * berryEffectMultiplier(state, pokemon);
  }
  if (!restorativeItem) return;
  if (!pokemon.volatile?.healBlock) addDelta(resolution, pokemon.id, healing);
  const item = pokemon.item!;
  consumeItem(resolution, pokemon.id, item);
  armCudChew(resolution, state, pokemon, item);
  if (!pokemon.volatile?.healBlock && isBerry(item) && state.generation >= 6 &&
    hasAbility(state, pokemon, 'cheekpouch')) {
    addDelta(resolution, pokemon.id, Math.floor(pokemon.hp.max / 3));
  }
  resolution.trace!.notes!.push(pokemon.volatile?.healBlock
    ? `${item} was consumed at the half-HP threshold, but Heal Block prevented recovery`
    : `${item} restored HP at the half-HP threshold`);
}

function applyStatBoostBerry(
  resolution: EndTurnResolution,
  state: BattleState,
  pokemon: PokemonState,
  projectedHp: number,
  random: () => number,
) {
  if (state.generation < 3 || projectedHp <= 0 || !itemEffectsActive(state, pokemon)) return;
  const itemId = id(pokemon.item);
  const stat = STAT_BOOST_BERRIES[itemId];
  const isLansat = itemId === 'lansatberry';
  const isStarf = itemId === 'starfberry';
  if (!stat && !isLansat && !isStarf) return;
  const threshold = state.generation >= 4 && hasAbility(state, pokemon, 'gluttony')
    ? Math.floor(pokemon.hp.max / 2)
    : Math.floor(pokemon.hp.max / 4);
  if (projectedHp > threshold) return;
  const berryMultiplier = berryEffectMultiplier(state, pokemon);
  if (stat) {
    addBoosts(resolution, state, pokemon.id, {[stat]: berryMultiplier});
  } else if (isLansat && !pokemon.volatile?.focusEnergy) {
    setVolatile(resolution, pokemon.id, 'focusEnergy', {});
  } else if (isStarf) {
    const available = RANDOM_BERRY_BOOST_STATS.filter(statId => (pokemon.boosts?.[statId] || 0) < 6);
    if (available.length) {
      const roll = random();
      if (!Number.isFinite(roll)) throw new Error('Starf Berry stat sampler must return a finite number');
      const bounded = Math.max(0, Math.min(0.999999999999, roll));
      const randomStat = available[Math.floor(bounded * available.length)];
      addBoosts(resolution, state, pokemon.id, {[randomStat]: 2 * berryMultiplier});
    }
  }
  const item = pokemon.item!;
  consumeItem(resolution, pokemon.id, item);
  armCudChew(resolution, state, pokemon, item);
  if (!pokemon.volatile?.healBlock && state.generation >= 6 && hasAbility(state, pokemon, 'cheekpouch')) {
    addDelta(resolution, pokemon.id, Math.floor(pokemon.hp.max / 3));
  }
  resolution.trace!.notes!.push(`${item} activated at the low-HP threshold`);
}

function applyMicleBerry(
  resolution: EndTurnResolution,
  state: BattleState,
  pokemon: PokemonState,
  projectedHp: number,
) {
  if (state.generation < 4 || projectedHp <= 0 || !itemEffectsActive(state, pokemon) ||
    id(pokemon.item) !== 'micleberry') return;
  const threshold = state.generation >= 4 && hasAbility(state, pokemon, 'gluttony')
    ? Math.floor(pokemon.hp.max / 2)
    : Math.floor(pokemon.hp.max / 4);
  if (projectedHp > threshold) return;
  const item = pokemon.item!;
  consumeItem(resolution, pokemon.id, item);
  setVolatile(resolution, pokemon.id, 'micleBerry', {turns: 2});
  armCudChew(resolution, state, pokemon, item);
  if (!pokemon.volatile?.healBlock && state.generation >= 6 && hasAbility(state, pokemon, 'cheekpouch')) {
    addDelta(resolution, pokemon.id, Math.floor(pokemon.hp.max / 3));
  }
  resolution.trace!.notes!.push(`${item} raised ${pokemon.id}'s move accuracy for its next move`);
}

function applyStatusBerry(
  resolution: EndTurnResolution,
  state: BattleState,
  pokemon: PokemonState,
): boolean {
  if (state.generation < 3 || pokemon.hp.current <= 0 || !itemEffectsActive(state, pokemon)) return false;
  const item = pokemon.item;
  const curesStatus = statusBerryCures(item, pokemon.status || '');
  const curesConfusion = (id(item) === 'lumberry' || id(item) === 'persimberry') &&
    !!pokemon.volatile?.confusion;
  if (!curesStatus && !curesConfusion) return false;
  if (curesStatus) {
    setStatus(resolution, pokemon.id, '');
    setStatusTurns(resolution, pokemon.id, null);
    setToxicCounter(resolution, pokemon.id, 0);
  }
  if (curesConfusion) setVolatile(resolution, pokemon.id, 'confusion', null);
  consumeItem(resolution, pokemon.id, item!);
  armCudChew(resolution, state, pokemon, item!);
  if (!pokemon.volatile?.healBlock && state.generation >= 6 && hasAbility(state, pokemon, 'cheekpouch')) {
    addDelta(resolution, pokemon.id, Math.floor(pokemon.hp.max / 3));
  }
  resolution.trace!.notes!.push(`${item} cured ${pokemon.id}`);
  return true;
}

function residualGmaxDamage(state: BattleState, pokemon: PokemonState, types: string[], magicGuard: boolean): number {
  if (state.generation < 8 || magicGuard) return 0;
  const effects = state.sides[sideForPokemon(state, pokemon.id)].effects || {};
  const sixteenth = Math.max(1, Math.floor(pokemon.hp.max / 6));
  let damage = 0;
  if (effects.vinelash && !hasType(types, 'Grass')) damage += sixteenth;
  if (effects.wildfire && !hasType(types, 'Fire')) damage += sixteenth;
  if (effects.cannonade && !hasType(types, 'Water')) damage += sixteenth;
  if (effects.volcalith && !hasType(types, 'Rock')) damage += sixteenth;
  return damage;
}

function residualPledgeDamage(state: BattleState, pokemon: PokemonState, types: string[], magicGuard: boolean): number {
  if (state.generation < 5 || magicGuard) return 0;
  const effects = state.sides[sideForPokemon(state, pokemon.id)].effects || {};
  return effects.pledgeSeaOfFire && !hasType(types, 'Fire')
    ? Math.max(1, Math.floor(pokemon.hp.max / 8))
    : 0;
}

function applyConfusionBerry(
  resolution: EndTurnResolution,
  state: BattleState,
  pokemon: PokemonState,
  projectedHp: number,
  random: () => number,
) {
  const confusionBerryThreshold = state.generation >= 4 && hasAbility(state, pokemon, 'gluttony')
    ? Math.floor(pokemon.hp.max / 2)
    : Math.floor(pokemon.hp.max / 4);
  if (state.generation < 3 || !itemEffectsActive(state, pokemon) ||
    !CONFUSION_BERRIES.has(id(pokemon.item)) || projectedHp <= 0 ||
    projectedHp > confusionBerryThreshold) return;
  if (!pokemon.volatile?.healBlock) {
    addDelta(resolution, pokemon.id, Math.floor(pokemon.hp.max / 2) * berryEffectMultiplier(state, pokemon));
  }
  if (confusionBerryDislikesNature(pokemon, pokemon.item) && canApplyVolatile(state, pokemon.id, 'confusion')) {
    setVolatile(resolution, pokemon.id, 'confusion', {
      turns: Math.floor(Math.max(0, Math.min(0.999999999999, random())) * 4) + 2,
    });
  }
  const item = pokemon.item!;
  consumeItem(resolution, pokemon.id, item);
  armCudChew(resolution, state, pokemon, item);
  if (!pokemon.volatile?.healBlock && state.generation >= 6 && hasAbility(state, pokemon, 'cheekpouch')) {
    addDelta(resolution, pokemon.id, Math.floor(pokemon.hp.max / 3));
  }
  resolution.trace!.notes!.push(`${item} restored half HP at the custom quarter-HP threshold`);
}

function replayCudChew(
  resolution: EndTurnResolution,
  state: BattleState,
  pokemon: PokemonState,
  random: () => number,
) {
  const stored = pokemon.volatile?.cudChew;
  if (state.generation < 9 || !stored?.item || stored.turns === undefined || stored.turns > 1 ||
    !hasAbility(state, pokemon, 'cudchew') || pokemon.hp.current <= 0 || !isBerry(stored.item)) return;

  const item = id(stored.item);
  const berryMultiplier = berryEffectMultiplier(state, pokemon);
  if (!pokemon.volatile?.healBlock) {
    if (item === 'oranberry') addDelta(resolution, pokemon.id, 10 * berryMultiplier);
    if (item === 'sitrusberry') addDelta(resolution, pokemon.id, Math.floor(pokemon.hp.max / 4) * berryMultiplier);
  }
  if (CONFUSION_BERRIES.has(item)) {
    if (!pokemon.volatile?.healBlock) {
      addDelta(resolution, pokemon.id, Math.floor(pokemon.hp.max / 2) * berryMultiplier);
    }
    if (confusionBerryDislikesNature(pokemon, item) && canApplyVolatile(state, pokemon.id, 'confusion')) {
      setVolatile(resolution, pokemon.id, 'confusion', {
        turns: Math.floor(Math.max(0, Math.min(0.999999999999, random())) * 4) + 2,
      });
    }
  }
  const stat = STAT_BOOST_BERRIES[item];
  if (stat) addBoosts(resolution, state, pokemon.id, {[stat]: berryMultiplier});
  if (item === 'keeberry' && (pokemon.boosts?.def || 0) < 6) {
    addBoosts(resolution, state, pokemon.id, {def: berryMultiplier});
  } else if (item === 'marangaberry' && (pokemon.boosts?.spd || 0) < 6) {
    addBoosts(resolution, state, pokemon.id, {spd: berryMultiplier});
  } else if (item === 'lansatberry' && !pokemon.volatile?.focusEnergy) {
    setVolatile(resolution, pokemon.id, 'focusEnergy', {});
  } else if (item === 'starfberry') {
    const available = RANDOM_BERRY_BOOST_STATS.filter(statId => (pokemon.boosts?.[statId] || 0) < 6);
    if (available.length) {
      const roll = random();
      if (!Number.isFinite(roll)) throw new Error('Starf Berry stat sampler must return a finite number');
      const bounded = Math.max(0, Math.min(0.999999999999, roll));
      const randomStat = available[Math.floor(bounded * available.length)];
      addBoosts(resolution, state, pokemon.id, {[randomStat]: 2 * berryMultiplier});
    }
  }
  if (statusBerryCures(stored.item, pokemon.status || '')) {
    setStatus(resolution, pokemon.id, '');
    setStatusTurns(resolution, pokemon.id, null);
    setToxicCounter(resolution, pokemon.id, 0);
  } 
  if (item === 'leppaberry') {
    const candidate = pokemon.moves.find(move => move.pp === 0 && move.maxPP !== 0) ||
      pokemon.moves.find(move => {
        if (move.pp === undefined) return false;
        const maxPP = move.maxPP ?? getMoveMaxPP(move.name, state.generation) ?? 0;
        return maxPP > 0 && move.pp < maxPP;
      });
    if (candidate && candidate.pp !== undefined) {
      const maxPP = candidate.maxPP ?? getMoveMaxPP(candidate.name, state.generation) ?? 0;
      if (maxPP > 0 && candidate.pp < maxPP) {
        const amount = hasAbility(state, pokemon, 'ripen') ? 20 : 10;
        const restoredPP = Math.min(maxPP, candidate.pp + amount);
        setMoves(resolution, pokemon.id, pokemon.moves.map(move =>
          move === candidate ? {...move, pp: restoredPP, maxPP} : move));
      }
    }
  }
  if (item === 'lumberry' || item === 'persimberry') {
    setVolatile(resolution, pokemon.id, 'confusion', null);
  } else if (item === 'micleberry') {
    setVolatile(resolution, pokemon.id, 'micleBerry', {turns: 2});
  }
  if (!pokemon.volatile?.healBlock && state.generation >= 6 && hasAbility(state, pokemon, 'cheekpouch')) {
    addDelta(resolution, pokemon.id, Math.floor(pokemon.hp.max / 3));
  }
  setVolatile(resolution, pokemon.id, 'cudChew', null);
  resolution.trace!.notes!.push(`Cud Chew re-ate ${stored.item} for ${pokemon.id}`);
}

function applyOrbStatus(resolution: EndTurnResolution, state: BattleState, pokemon: PokemonState) {
  if (state.generation < 4 || !itemEffectsActive(state, pokemon) || pokemon.status) return;
  const item = id(pokemon.item);
  if (item === 'flameorb' && canApplyMajorStatus(state, pokemon.id, pokemon.id, 'brn')) {
    setStatus(resolution, pokemon.id, 'brn');
  }
  if (item === 'toxicorb' && canApplyMajorStatus(state, pokemon.id, pokemon.id, 'tox')) {
    setStatus(resolution, pokemon.id, 'tox');
    setToxicCounter(resolution, pokemon.id, 1);
  }
}

function applyShedSkin(
  resolution: EndTurnResolution,
  state: BattleState,
  pokemon: PokemonState,
  projectedHp: number,
  random: () => number,
) {
  if (projectedHp <= 0 || state.generation < 3 || !hasAbility(state, pokemon, 'shedskin') || !pokemon.status ||
    !passesChance(random, 1 / 3, 'Shed Skin')) return;
  setStatus(resolution, pokemon.id, '');
  setStatusTurns(resolution, pokemon.id, null);
  setToxicCounter(resolution, pokemon.id, 0);
  resolution.trace!.notes!.push('Shed Skin cured the major status');
}

function applyHarvest(
  resolution: EndTurnResolution,
  state: BattleState,
  pokemon: PokemonState,
  projectedHp: number,
  random: () => number,
) {
  if (projectedHp <= 0 || state.generation < 5 || !hasAbility(state, pokemon, 'harvest') || pokemon.item ||
    !isBerry(pokemon.lastConsumedItem)) return;
  const guaranteedBySun = isSunWeather(state.field.weather) && !isWeatherSuppressed(state);
  if (!passesChance(random, guaranteedBySun ? 1 : 0.5, 'Harvest')) return;
  setItem(resolution, pokemon.id, pokemon.lastConsumedItem!);
  resolution.trace!.notes!.push(`Harvest restored ${pokemon.lastConsumedItem}`);
}

function applyHealer(
  resolution: EndTurnResolution,
  state: BattleState,
  pokemon: PokemonState,
  random: () => number,
) {
  if (state.generation < 5 || state.mode !== 'Doubles' || !hasAbility(state, pokemon, 'healer')) return;
  const sideId = sideForPokemon(state, pokemon.id);
  const allies = state.sides[sideId].activeIds
    .filter(pokemonId => pokemonId !== pokemon.id)
    .map(pokemonId => getPokemon(state, pokemonId))
    .filter((ally): ally is PokemonState => !!ally && ally.hp.current > 0 && !!ally.status);
  if (!allies.length || !passesChance(random, 0.3, 'Healer')) return;
  for (const ally of allies) {
    setStatus(resolution, ally.id, '');
    setStatusTurns(resolution, ally.id, null);
    setToxicCounter(resolution, ally.id, 0);
  }
  resolution.trace!.notes!.push(`Healer cured ${allies.map(ally => ally.id).join(', ')}`);
}

/**
 * Derive the state-representable end-of-turn consequences for active Pokémon.
 * Turn order between simultaneous residual effects is intentionally collapsed
 * into one atomic delta; switch order, faint replacement, and other simulator
 * events remain outside this boundary.
 */
export interface EndTurnOptions {
  random?: () => number;
}

export function deriveEndTurnResolution(state: BattleState, options: EndTurnOptions = {}): EndTurnResolution {
  const random = options.random || Math.random;
  const resolution: EndTurnResolution = {
    trace: {source: 'battle-engine', notes: ['derived end-of-turn residual effects']},
  };
  for (const delayed of state.delayedMoves || []) {
    if (delayed.turns > 1) continue;
    for (const [targetId, damage] of Object.entries(delayed.damageByTarget)) {
      const targetSide = sideForPokemon(state, targetId);
      const targetSlot = delayed.targetSlotsByTarget?.[targetId];
      const resolvedTargetId = targetSlot === undefined
        ? targetId
        : state.sides[targetSide].activeIds[targetSlot];
      if (resolvedTargetId && addDelayedDamage(resolution, state, resolvedTargetId, damage)) {
        resolution.trace!.notes!.push(`Disguise broke on ${resolvedTargetId} and prevented delayed damage`);
      }
    }
    for (const [targetId, fraction] of Object.entries(delayed.healingByTarget || {})) {
      const targetSide = sideForPokemon(state, targetId);
      const targetSlot = delayed.targetSlotsByTarget?.[targetId];
      const resolvedTargetId = targetSlot === undefined
        ? targetId
        : state.sides[targetSide].activeIds[targetSlot];
      const resolvedTarget = resolvedTargetId ? getPokemon(state, resolvedTargetId) : undefined;
      if (resolvedTarget && resolvedTarget.hp.current > 0 && !resolvedTarget.volatile?.healBlock) {
        addDelta(resolution, resolvedTarget.id,
          Math.floor(resolvedTarget.hp.max * fraction.numerator / fraction.denominator));
      }
    }
    resolution.removeDelayedMoveIds = [
      ...(resolution.removeDelayedMoveIds || []),
      delayed.id,
    ];
    resolution.trace!.notes!.push(`resolved delayed ${delayed.moveName} effect`);
  }
  for (const pokemon of activePokemon(state)) {
    applyForecastFormChange(state, resolution, pokemon);
    const types = calcTypes(state, pokemon);
    const magicGuard = isMagicGuard(state, pokemon);
    let delta = 0;
    const statusBerryUsed = applyStatusBerry(resolution, state, pokemon);

    const restoresIceFace = state.generation >= 8 && !isWeatherSuppressed(state) &&
      ((state.generation === 8 && state.field.weather === 'Hail') ||
        (state.generation >= 9 && state.field.weather === 'Snow')) &&
      hasAbility(state, pokemon, 'iceface') &&
      id(pokemon.species) === 'eiscue' &&
      id(getEffectiveSpecies(pokemon)) === 'eiscuenoice';
    if (restoresIceFace) {
      setSpeciesOverride(resolution, pokemon.id, null);
      resolution.trace!.notes!.push(`Ice Face restored ${pokemon.id}'s Ice Face in the weather`);
    }

    const statusDamage = statusBerryUsed ? 0 : residualStatusDamage(state, pokemon);
    if (statusDamage) delta -= statusDamage;
    const partialTrap = partialTrapDamage(state, pokemon);
    if (partialTrap) delta -= partialTrap;
    const partialTrapSource = pokemon.volatile?.partiallyTrapped?.sourceId
      ? getPokemon(state, pokemon.volatile.partiallyTrapped.sourceId)
      : undefined;
    const permanentTrapSource = pokemon.volatile?.trapped?.sourceId
      ? getPokemon(state, pokemon.volatile.trapped.sourceId)
      : undefined;
    if (pokemon.volatile?.partiallyTrapped && (!partialTrapSource || partialTrapSource.hp.current <= 0)) {
      setVolatile(resolution, pokemon.id, 'partiallyTrapped', null);
    }
    if (pokemon.volatile?.trapped?.sourceId && (!permanentTrapSource || permanentTrapSource.hp.current <= 0)) {
      setVolatile(resolution, pokemon.id, 'trapped', null);
    }
    const octolock = pokemon.volatile?.octolock;
    const octolockSource = octolock?.sourceId ? getPokemon(state, octolock.sourceId) : undefined;
    if (octolock && octolockSource && octolockSource.hp.current > 0 &&
      state.sides[sideForPokemon(state, octolockSource.id)].activeIds.includes(octolockSource.id)) {
      applyOctolockDrops(state, resolution, pokemon, octolockSource);
    } else if (octolock) {
      setVolatile(resolution, pokemon.id, 'octolock', null);
      if (pokemon.volatile?.trapped?.sourceId === octolock.sourceId) {
        setVolatile(resolution, pokemon.id, 'trapped', null);
      }
    }
    if (pokemon.volatile?.nightmare && pokemon.status !== 'slp') {
      setVolatile(resolution, pokemon.id, 'nightmare', null);
    }
    if (state.generation >= 4 && pokemon.status && hasAbility(state, pokemon, 'poisonheal') &&
      (pokemon.status === 'psn' || pokemon.status === 'tox')) {
      delta += Math.max(1, Math.floor(pokemon.hp.max / 8)) + statusDamage;
    }

    const weather = weatherDamage(state, pokemon, types);
    if (weather) delta -= weather;

    const grassyTerrain = grassyTerrainDelta(state, pokemon);
    if (grassyTerrain) delta += grassyTerrain;

    const volatileRecovery = volatileRecoveryDelta(pokemon);
    if (volatileRecovery) delta += volatileRecovery;

    const gmaxDamage = residualGmaxDamage(state, pokemon, types, magicGuard);
    if (gmaxDamage) delta -= gmaxDamage;

    const pledgeDamage = residualPledgeDamage(state, pokemon, types, magicGuard);
    if (pledgeDamage) delta -= pledgeDamage;

    const abilityDelta = residualAbilityDelta(state, pokemon, magicGuard);
    if (abilityDelta) delta += abilityDelta;

    if (state.generation >= 9 && pokemon.isSaltCure && !magicGuard) {
      delta -= Math.max(1, Math.floor(pokemon.hp.max / (hasType(types, 'Water', 'Steel') ? 4 : 8)));
    }

    const leechSeed = pokemon.volatile?.leechSeed;
    if (leechSeed && !magicGuard) {
      const drain = Math.max(1, Math.floor(pokemon.hp.max / 8));
      delta -= drain;
      const source = leechSeed.sourceId ? getPokemon(state, leechSeed.sourceId) : undefined;
      if (source?.hp.current) {
        const amount = drainRecoveryAmount(state, source, drain);
        if (state.generation >= 3 && hasAbility(state, pokemon, 'liquidooze')) {
          if (!isMagicGuard(state, source)) addDelta(resolution, source.id, -amount);
          resolution.trace!.notes!.push(`Liquid Ooze damaged ${source.id} through Leech Seed`);
        } else {
          addDelta(resolution, source.id, amount);
        }
      }
    }

    const projectedHp = pokemon.hp.current + delta;
    if (projectedHp > 0) delta += residualItemDelta(state, pokemon, types, magicGuard);
    applyHealingBerry(resolution, state, pokemon, pokemon.hp.current + delta);
    applyConfusionBerry(resolution, state, pokemon, pokemon.hp.current + delta, random);
    applyStatBoostBerry(resolution, state, pokemon, pokemon.hp.current + delta, random);
    applyMicleBerry(resolution, state, pokemon, pokemon.hp.current + delta);
    replayCudChew(resolution, state, pokemon, random);
    if (delta) addDelta(resolution, pokemon.id, delta);
    if (pokemon.status === 'tox' && !statusBerryUsed) {
      const counter = Math.min(15, Math.max(1, pokemon.toxicCounter || 1) + 1);
      setToxicCounter(resolution, pokemon.id, counter);
    }

    applyOrbStatus(resolution, state, pokemon);
    applyShedSkin(resolution, state, pokemon, pokemon.hp.current + delta, random);
    applyHarvest(resolution, state, pokemon, pokemon.hp.current + delta, random);
    applyHealer(resolution, state, pokemon, random);

    if (state.generation >= 4 && isRainWeather(state.field.weather) && !isWeatherSuppressed(state) &&
      hasAbility(state, pokemon, 'hydration') &&
      (pokemon.status || pokemon.statusTurns !== undefined || pokemon.toxicCounter !== undefined)) {
      setStatus(resolution, pokemon.id, '');
      setStatusTurns(resolution, pokemon.id, null);
      setToxicCounter(resolution, pokemon.id, 0);
    }

    const yawn = pokemon.volatile?.yawn;
    if (yawn) {
      if (!pokemon.status && canApplyMajorStatus(
        state,
        yawn.sourceId || pokemon.id,
        pokemon.id,
        'slp',
      )) {
        setStatus(resolution, pokemon.id, 'slp');
        setStatusTurns(resolution, pokemon.id, 2);
      }
      setVolatile(resolution, pokemon.id, 'yawn', null);
    }

    if (state.generation >= 3 && hasAbility(state, pokemon, 'speedboost')) {
      addBoosts(resolution, state, pokemon.id, {spe: 1});
      resolution.trace!.notes!.push(`Speed Boost raised ${pokemon.id}'s Speed`);
    }

    const perishSong = pokemon.volatile?.perishSong;
    if (perishSong?.turns !== undefined) {
      if (perishSong.turns <= 1) {
        addDelta(resolution, pokemon.id, -pokemon.hp.current);
        setVolatile(resolution, pokemon.id, 'perishSong', null);
      }
    }
    const finalProjectedHp = pokemon.hp.current + delta + (resolution.hpDeltaByPokemon?.[pokemon.id] || 0);
    applyHpThresholdFormChange(state, resolution, pokemon, finalProjectedHp);
    const crossedEmergencyThreshold = pokemon.hp.current > pokemon.hp.max / 2 &&
      finalProjectedHp > 0 && finalProjectedHp <= pokemon.hp.max / 2;
    if (crossedEmergencyThreshold && state.generation >= 7 &&
      hasAbility(state, pokemon, 'emergencyexit', 'wimpout')) {
      requestEmergencySwitch(state, resolution, pokemon);
      resolution.trace!.notes!.push(`${getEffectiveAbility(pokemon)} requested a replacement for ${pokemon.id}`);
    }
    applyMoody(resolution, pokemon, state, random);
  }

  if (state.generation >= 4) {
    for (const holder of activePokemon(state)) {
      if (!hasAbility(state, holder, 'baddreams')) continue;
      const holderSide = sideForPokemon(state, holder.id);
      const opposingSide = holderSide === 'ai' ? 'player' : 'ai';
      for (const targetId of state.sides[opposingSide].activeIds) {
        const target = getPokemon(state, targetId);
        if (!target || target.hp.current <= 0 || target.status !== 'slp' || isMagicGuard(state, target)) continue;
        addDelta(resolution, target.id, -Math.max(1, Math.floor(target.hp.max / 8)));
        resolution.trace!.notes!.push(`Bad Dreams damaged sleeping ${target.id}`);
      }
    }
  }
  return resolution;
}

function mergeVolatile(
  current: PokemonState['volatile'],
  delta: Partial<Record<VolatileStatusName, VolatileState | null>>,
) {
  const result: Partial<Record<VolatileStatusName, VolatileState>> = {...(current || {})};
  for (const [name, value] of Object.entries(delta) as Array<[
    VolatileStatusName,
    VolatileState | null,
  ]>) {
    if (value === null) delete result[name];
    else result[name] = {...(result[name] || {}), ...value};
  }
  return Object.keys(result).length ? result : undefined;
}

function clearFaintedCommanderLinks(sides: BattleState['sides']): BattleState['sides'] {
  const faintedIds = new Set<string>();
  for (const sideId of ['ai', 'player'] as const) {
    for (const pokemon of sides[sideId].party) {
      if (pokemon.hp.current <= 0) faintedIds.add(pokemon.id);
    }
  }
  const cleanParty = (party: BattleState['sides']['ai']['party']) => party.map(pokemon => {
    let volatile = pokemon.volatile;
    if (volatile?.commanding && (pokemon.hp.current <= 0 || faintedIds.has(volatile.commanding.sourceId || ''))) {
      volatile = mergeVolatile(volatile, {commanding: null});
    }
    if (volatile?.commanded && (pokemon.hp.current <= 0 || faintedIds.has(volatile.commanded.sourceId || ''))) {
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

function validateMap(state: BattleState, values: Record<string, unknown> | undefined, label: string) {
  for (const pokemonId of Object.keys(values || {})) {
    if (!getPokemon(state, pokemonId)) throw new Error(`${label} references an unknown Pokémon`);
  }
}

/** Apply an already-derived end-turn result without advancing the turn. */
export function applyEndTurnResolution(state: BattleState, resolution: EndTurnResolution): BattleState {
  validateEndTurnResolution(state, resolution);
  validateMap(state, resolution.hpDeltaByPokemon, 'HP delta');
  validateMap(state, resolution.forcedSwitchByPokemon, 'Forced switch');
  validateMap(state, resolution.itemByPokemon, 'Item state');
  validateMap(state, resolution.consumedItemByPokemon, 'Consumed item');
  validateMap(state, resolution.speciesOverrideByPokemon, 'Species override');
  validateMap(state, resolution.boostsByPokemon, 'Boost');
  validateMap(state, resolution.movesByPokemon, 'Move set');
  validateMap(state, resolution.substituteHpByPokemon, 'Substitute HP');
  validateMap(state, resolution.statusByPokemon, 'Status');
  validateMap(state, resolution.statusTurnsByPokemon, 'Status turns');
  validateMap(state, resolution.disguiseBrokenByPokemon, 'Disguise state');
  validateMap(state, resolution.toxicCounterByPokemon, 'Toxic counter');
  validateMap(state, resolution.volatileByPokemon, 'Volatile state');
  const delayedIds = new Set((state.delayedMoves || []).map(delayed => delayed.id));
  const removeDelayedMoveIds = resolution.removeDelayedMoveIds || [];
  if (new Set(removeDelayedMoveIds).size !== removeDelayedMoveIds.length ||
    removeDelayedMoveIds.some(id => !delayedIds.has(id))) {
    throw new Error('Delayed move removal references an unknown or repeated ID');
  }
  for (const [pokemonId, delta] of Object.entries(resolution.hpDeltaByPokemon || {})) {
    if (!Number.isFinite(delta)) throw new Error(`HP delta for ${pokemonId} must be finite`);
  }
  for (const [pokemonId, forced] of Object.entries(resolution.forcedSwitchByPokemon || {})) {
    if (typeof forced !== 'boolean') throw new Error(`Forced switch for ${pokemonId} must be boolean`);
    if (!forced) continue;
    const sideId = sideForPokemon(state, pokemonId);
    const pokemon = getPokemon(state, pokemonId);
    if (!state.sides[sideId].activeIds.includes(pokemonId) || !pokemon || pokemon.hp.current <= 0) {
      throw new Error(`Forced switch for ${pokemonId} requires a living active Pokémon`);
    }
  }
  for (const [pokemonId, item] of Object.entries(resolution.itemByPokemon || {})) {
    if (item !== null && (typeof item !== 'string' || !item)) {
      throw new Error(`Item state for ${pokemonId} must be a non-empty item name or null`);
    }
  }
  for (const [pokemonId, item] of Object.entries(resolution.consumedItemByPokemon || {})) {
    if (item !== null && (typeof item !== 'string' || !item)) {
      throw new Error(`Consumed item for ${pokemonId} must be a non-empty item name or null`);
    }
  }
  for (const [pokemonId, species] of Object.entries(resolution.speciesOverrideByPokemon || {})) {
    if (species !== null && (typeof species !== 'string' || !species)) {
      throw new Error(`Species override for ${pokemonId} must be a non-empty species name or null`);
    }
  }
  for (const [pokemonId, boosts] of Object.entries(resolution.boostsByPokemon || {})) {
    for (const [stat, amount] of Object.entries(boosts)) {
      if (!['atk', 'def', 'spa', 'spd', 'spe', 'acc', 'eva'].includes(stat) ||
        !Number.isInteger(amount)) {
        throw new Error(`Boost ${stat} for ${pokemonId} must be an integer`);
      }
    }
  }
  for (const [pokemonId, moves] of Object.entries(resolution.movesByPokemon || {})) {
    if (moves !== null && (!Array.isArray(moves) || moves.some(move =>
      !move || typeof move.name !== 'string' || !move.name ||
      (move.pp !== undefined && (!Number.isInteger(move.pp) || move.pp < 0)) ||
      (move.maxPP !== undefined && (!Number.isInteger(move.maxPP) || move.maxPP < 0))))) {
      throw new Error(`Move set for ${pokemonId} is invalid`);
    }
  }
  for (const [pokemonId, substituteHp] of Object.entries(resolution.substituteHpByPokemon || {})) {
    if (substituteHp !== null && (!Number.isInteger(substituteHp) || substituteHp < 0)) {
      throw new Error(`Substitute HP for ${pokemonId} must be a non-negative integer or null`);
    }
  }
  for (const [pokemonId, counter] of Object.entries(resolution.toxicCounterByPokemon || {})) {
    if (!Number.isInteger(counter) || counter < 0) {
      throw new Error(`Toxic counter for ${pokemonId} must be a non-negative integer`);
    }
  }
  for (const [pokemonId, turns] of Object.entries(resolution.statusTurnsByPokemon || {})) {
    if (turns !== null && (!Number.isInteger(turns) || turns < 0)) {
      throw new Error(`Status turns for ${pokemonId} must be a non-negative integer or null`);
    }
  }
  for (const [pokemonId, broken] of Object.entries(resolution.disguiseBrokenByPokemon || {})) {
    if (typeof broken !== 'boolean') throw new Error(`Disguise state for ${pokemonId} must be boolean`);
  }
  for (const effects of Object.values(resolution.volatileByPokemon || {})) {
    for (const [name, value] of Object.entries(effects || {}) as Array<[
      VolatileStatusName,
      VolatileState | null,
    ]>) {
      if (value?.turns !== undefined && (!Number.isInteger(value.turns) || value.turns < 0)) {
        throw new Error(`Volatile duration ${name} must be a non-negative integer`);
      }
    }
  }
  const sides = {...state.sides};
  for (const sideId of ['ai', 'player'] as const) {
    sides[sideId] = {
      ...sides[sideId],
      party: sides[sideId].party.map(pokemon => {
        const hpDelta = resolution.hpDeltaByPokemon?.[pokemon.id] || 0;
        const item = resolution.itemByPokemon?.[pokemon.id];
        const hasItemResolution = !!resolution.itemByPokemon &&
          Object.prototype.hasOwnProperty.call(resolution.itemByPokemon, pokemon.id);
        const consumedItem = resolution.consumedItemByPokemon?.[pokemon.id];
        const hasConsumedItemResolution = !!resolution.consumedItemByPokemon &&
          Object.prototype.hasOwnProperty.call(resolution.consumedItemByPokemon, pokemon.id);
        const speciesOverride = resolution.speciesOverrideByPokemon?.[pokemon.id];
        const hasSpeciesOverride = !!resolution.speciesOverrideByPokemon &&
          Object.prototype.hasOwnProperty.call(resolution.speciesOverrideByPokemon, pokemon.id);
        const boosts = resolution.boostsByPokemon?.[pokemon.id];
        const moves = resolution.movesByPokemon?.[pokemon.id];
        const hasMovesResolution = !!resolution.movesByPokemon &&
          Object.prototype.hasOwnProperty.call(resolution.movesByPokemon, pokemon.id);
        const hasSubstituteResolution = resolution.substituteHpByPokemon &&
          Object.prototype.hasOwnProperty.call(resolution.substituteHpByPokemon, pokemon.id);
        const substituteHp = resolution.substituteHpByPokemon?.[pokemon.id];
        const status = resolution.statusByPokemon?.[pokemon.id];
        const statusTurns = resolution.statusTurnsByPokemon?.[pokemon.id];
        const disguiseBroken = resolution.disguiseBrokenByPokemon?.[pokemon.id];
        const toxicCounter = resolution.toxicCounterByPokemon?.[pokemon.id];
      const volatile = resolution.volatileByPokemon?.[pokemon.id];
        if (!hpDelta && !hasItemResolution && !hasConsumedItemResolution && !hasSpeciesOverride && boosts === undefined && !hasMovesResolution && !hasSubstituteResolution && status === undefined && statusTurns === undefined &&
          disguiseBroken === undefined && toxicCounter === undefined && volatile === undefined) return pokemon;
        return {
          ...pokemon,
          hp: {...pokemon.hp, current: Math.max(0, Math.min(pokemon.hp.max, pokemon.hp.current + hpDelta))},
          ...(hasItemResolution ? {item: item === null ? undefined : item} : {}),
          ...(hasItemResolution && item === null ? {itemLost: true} : {}),
          ...(hasConsumedItemResolution
            ? {lastConsumedItem: consumedItem === null ? undefined : consumedItem}
            : hasItemResolution ? {lastConsumedItem: undefined} : {}),
          ...(hasSpeciesOverride ? {speciesOverride: speciesOverride === null ? undefined : speciesOverride} : {}),
          ...(hasMovesResolution ? {
            moves: moves === null ? (pokemon.originalMoves || pokemon.moves) : moves,
            originalMoves: moves === null ? undefined : pokemon.originalMoves || pokemon.moves,
          } : {}),
          ...(boosts === undefined ? {} : {boosts: (() => {
            const next = {...(pokemon.boosts || {})};
            for (const [stat, amount] of Object.entries(boosts) as Array<[keyof StatBoosts, number]>) {
              next[stat] = Math.max(-6, Math.min(6, (next[stat] || 0) + amount));
            }
            const compacted: StatBoosts = {};
            for (const [stat, value] of Object.entries(next) as Array<[keyof StatBoosts, number]>) {
              if (value !== 0) compacted[stat] = value;
            }
            return Object.keys(compacted).length ? compacted : undefined;
          })()}),
          ...(hasSubstituteResolution
            ? {substituteHp: substituteHp === null || substituteHp === 0 ? undefined : substituteHp}
            : {}),
          ...(status === undefined ? {} : {
            status,
            ...(status === '' ? {statusTurns: undefined, toxicCounter: undefined} : {}),
          }),
          ...(statusTurns === undefined ? {} : {statusTurns: statusTurns === null ? undefined : statusTurns}),
          ...(disguiseBroken === undefined ? {} : {disguiseBroken}),
          ...(toxicCounter === undefined ? {} : {toxicCounter}),
          ...(volatile === undefined ? {} : {volatile: mergeVolatile(pokemon.volatile, volatile)}),
        };
      }),
    };
  }
  const cleanedSides = clearFaintedCommanderLinks(sides);
  return {
    ...state,
    sides: cleanedSides,
    pendingForcedSwitchIds: (() => {
      const ids = new Set(state.pendingForcedSwitchIds || []);
      for (const [pokemonId, forced] of Object.entries(resolution.forcedSwitchByPokemon || {})) {
        if (forced) ids.add(pokemonId);
        else ids.delete(pokemonId);
      }
      return ids.size ? Array.from(ids) : undefined;
    })(),
    delayedMoves: (() => {
      const remaining = state.delayedMoves?.filter(delayed => !removeDelayedMoveIds.includes(delayed.id));
      return remaining?.length ? remaining : undefined;
    })(),
    lastResolution: resolution.trace || {source: 'battle-engine', notes: ['applied end-of-turn resolution']},
  };
}
