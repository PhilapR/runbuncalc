import * as Calc from '@smogon/calc';
import {getCalculatorAbility, getEffectiveAbility, isAbilityActive, isAbilityAvailable} from './abilities';
import {getPokemon, isSunWeather, isWeatherSuppressed, sideForPokemon} from './actions';
import {isItemEffectActive} from './items';
import {BattleState, MoveCategory, PokemonState, RUN_AND_BUN_EVS, StatusName, VolatileStatusName} from './model';
import {getEffectiveSpecies} from './stat-transforms';

function id(name: string | undefined): string {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

const PLATE_TYPE_BY_ID: Record<string, string> = {
  dracoplate: 'Dragon', dreadplate: 'Dark', earthplate: 'Ground', fistplate: 'Fighting',
  flameplate: 'Fire', icicleplate: 'Ice', insectplate: 'Bug', ironplate: 'Steel',
  meadowplate: 'Grass', mindplate: 'Psychic', pixieplate: 'Fairy', skyplate: 'Flying',
  splashplate: 'Water', spookyplate: 'Ghost', stoneplate: 'Rock', toxicplate: 'Poison',
  zapplate: 'Electric',
};

const MEMORY_TYPE_BY_ID: Record<string, string> = {
  bugmemory: 'Bug', darkmemory: 'Dark', dragonmemory: 'Dragon', electricmemory: 'Electric',
  fairymemory: 'Fairy', fightingmemory: 'Fighting', firememory: 'Fire', flyingmemory: 'Flying',
  ghostmemory: 'Ghost', grassmemory: 'Grass', groundmemory: 'Ground', icememory: 'Ice',
  poisonmemory: 'Poison', psychicmemory: 'Psychic', rockmemory: 'Rock', steelmemory: 'Steel',
  watermemory: 'Water',
};

function itemDrivenTypeIdentity(state: BattleState, pokemon: PokemonState): string | undefined {
  if (!isItemEffectActive(state, pokemon) || !isAbilityActive(pokemon, state)) return undefined;
  const ability = id(getEffectiveAbility(pokemon));
  const item = id(pokemon.item);
  if (ability === 'multitype' && state.generation >= 4) return PLATE_TYPE_BY_ID[item];
  if ((ability === 'rkssystem' || ability === 'rksystem') && state.generation >= 7) {
    return MEMORY_TYPE_BY_ID[item];
  }
  return undefined;
}

function forecastTypeIdentity(state: BattleState, pokemon: PokemonState): string | undefined {
  if (state.generation < 3 || isWeatherSuppressed(state) || !isAbilityActive(pokemon, state) ||
    !isAbilityAvailable(state.generation, getEffectiveAbility(pokemon)) ||
    id(getEffectiveAbility(pokemon)) !== 'forecast' || id(pokemon.species) !== 'castform') return undefined;
  if (state.field.weather === 'Sun' || state.field.weather === 'Harsh Sunshine') return 'Fire';
  if (state.field.weather === 'Rain' || state.field.weather === 'Heavy Rain') return 'Water';
  if (state.field.weather === 'Hail' || state.field.weather === 'Snow') return 'Ice';
  return 'Normal';
}

function hasAbility(state: BattleState, pokemonId: string, ...abilities: string[]): boolean {
  const pokemon = getPokemon(state, pokemonId);
  if (!pokemon || !isAbilityActive(pokemon, state)) return false;
  const current = id(getEffectiveAbility(pokemon));
  return abilities.some(ability => {
    const abilityId = id(ability);
    return current === abilityId && isAbilityAvailable(state.generation, abilityId);
  });
}

function hasActiveAllyAbility(state: BattleState, pokemonId: string, ...abilities: string[]): boolean {
  const sideId = sideForPokemon(state, pokemonId);
  return state.sides[sideId].activeIds.some(allyId =>
    allyId !== pokemonId && (getPokemon(state, allyId)?.hp.current || 0) > 0 &&
    hasAbility(state, allyId, ...abilities));
}

export function getEffectiveTypesForPokemon(state: BattleState, pokemon: PokemonState): string[] {
  if (pokemon.typeOverride !== undefined && pokemon.typeOverride.length === 0) return [];
  const gen = Calc.Generations.get(state.generation);
  const itemType = pokemon.typeOverride === undefined ? itemDrivenTypeIdentity(state, pokemon) : undefined;
  const forecastType = pokemon.typeOverride === undefined && !itemType
    ? forecastTypeIdentity(state, pokemon)
    : undefined;
  const baseTypes = new Calc.Pokemon(gen, getEffectiveSpecies(pokemon), {
    level: pokemon.level,
    ability: getCalculatorAbility(state, pokemon),
    abilityOn: isAbilityActive(pokemon, state) ? pokemon.abilityOn : false,
    item: isItemEffectActive(state, pokemon) ? pokemon.item : undefined,
    evs: RUN_AND_BUN_EVS,
    teraType: pokemon.teraType as Calc.State.Pokemon['teraType'],
    overrides: pokemon.typeOverride !== undefined
      ? {types: pokemon.typeOverride as unknown as Calc.Pokemon['types']}
      : itemType ? {types: [itemType] as unknown as Calc.Pokemon['types']}
        : forecastType ? {types: [forecastType] as unknown as Calc.Pokemon['types']} : undefined,
  }).types as string[];
  if (!pokemon.volatile?.roost) return baseTypes;
  const withoutFlying = baseTypes.filter(type => id(type) !== 'flying');
  return withoutFlying.length ? withoutFlying : ['Normal'];
}

export function getEffectiveTypes(state: BattleState, pokemonId: string): string[] {
  const pokemon = getPokemon(state, pokemonId);
  return pokemon ? getEffectiveTypesForPokemon(state, pokemon) : [];
}

function types(state: BattleState, pokemonId: string): string[] {
  return getEffectiveTypes(state, pokemonId).map(id);
}

function hasType(state: BattleState, pokemonId: string, ...wanted: string[]): boolean {
  const targetTypes = new Set(types(state, pokemonId));
  return wanted.some(type => targetTypes.has(id(type)));
}

export function isGrounded(state: BattleState, pokemonId: string): boolean {
  if (state.field.gravity) return true;
  const pokemon = getPokemon(state, pokemonId);
  if (pokemon?.volatile?.landed) return true;
  if (pokemon?.volatile?.magnetRise) return false;
  if (pokemon?.volatile?.telekinesis) return false;
  if (pokemon?.volatile?.roost) return true;
  if (pokemon && isItemEffectActive(state, pokemon) && id(pokemon.item) === 'ironball') return true;
  if (hasType(state, pokemonId, 'Flying')) return false;
  if (hasAbility(state, pokemonId, 'levitate')) return false;
  return !(pokemon && isItemEffectActive(state, pokemon) && id(pokemon.item) === 'airballoon');
}

/** Ghost-types avoid move- and ability-based trapping from Generation VI onward. */
export function isGhostTrapImmune(state: BattleState, pokemonId: string): boolean {
  return state.generation >= 6 && getEffectiveTypes(state, pokemonId).some(type => id(type) === 'ghost');
}

/** Return whether an opposing priority move is blocked before it affects a target. */
export function isPriorityBlocked(
  state: BattleState,
  actorId: string,
  targetId: string,
  priority: number,
  moveCategory?: MoveCategory,
): boolean {
  if (priority <= 0 || sideForPokemon(state, actorId) === sideForPokemon(state, targetId)) return false;
  if (state.generation >= 7 && moveCategory === 'Status' &&
    hasAbility(state, actorId, 'prankster') && hasType(state, targetId, 'Dark')) return true;
  if (state.generation >= 7 && state.field.terrain === 'Psychic' && isGrounded(state, targetId)) return true;
  if (hasAbility(state, targetId, 'dazzling', 'queensmajesty', 'armortail')) return true;
  const targetSide = sideForPokemon(state, targetId);
  return state.generation >= 9 && state.sides[targetSide].activeIds.some(allyId =>
    allyId !== targetId && (getPokemon(state, allyId)?.hp.current || 0) > 0 &&
    hasAbility(state, allyId, 'armortail'));
}

/** Return whether an opposing move suppresses the target's ability for this resolution. */
export function ignoresTargetAbility(
  state: BattleState,
  actorId: string,
  targetId: string,
  moveCategory: MoveCategory = 'Status',
): boolean {
  return sideForPokemon(state, actorId) !== sideForPokemon(state, targetId) &&
    (hasAbility(state, actorId, 'moldbreaker', 'teravolt', 'turboblaze') ||
      (moveCategory === 'Status' && hasAbility(state, actorId, 'myceliummight')));
}

/** Return whether a holder blocks opposing additional/secondary move effects. */
export function blocksSecondaryEffects(state: BattleState, pokemonId: string): boolean {
  const pokemon = getPokemon(state, pokemonId);
  return !!pokemon &&
    ((isItemEffectActive(state, pokemon) && id(pokemon.item) === 'covertcloak') ||
      hasAbility(state, pokemonId, 'shielddust'));
}

export function canApplyMajorStatus(
  state: BattleState,
  actorId: string,
  targetId: string,
  status: StatusName,
  moveType?: string,
  statusMove = false,
  ignoreExistingStatus = false,
  moveCategory?: MoveCategory,
): boolean {
  const target = getPokemon(state, targetId);
  if (!target || target.hp.current <= 0 || (target.status && !ignoreExistingStatus)) return false;
  const targetSide = sideForPokemon(state, targetId);
  const opposingStatusMove = statusMove && sideForPokemon(state, actorId) !== targetSide;
  const effectiveMoveCategory = moveCategory || (statusMove ? 'Status' : undefined);
  const targetAbilityIgnored = sideForPokemon(state, actorId) !== targetSide &&
    effectiveMoveCategory !== undefined && ignoresTargetAbility(state, actorId, targetId, effectiveMoveCategory);
  if (opposingStatusMove && !targetAbilityIgnored && hasAbility(state, targetId, 'goodasgold')) return false;
  if (opposingStatusMove && (state.sides[targetSide].effects?.safeguard ||
    state.sides[targetSide].effects?.craftyShield)) return false;
  if (state.generation >= 6 && isGrounded(state, targetId)) {
    if (state.field.terrain === 'Misty') return false;
    if (status === 'slp' && state.field.terrain === 'Electric') return false;
  }

  if (status === 'slp') {
    const uproarActive = (['ai', 'player'] as const).some(sideId =>
      state.sides[sideId].activeIds.some(activeId => {
        const active = getPokemon(state, activeId);
        return !!active && active.hp.current > 0 && !!active.volatile?.uproar;
      }));
    if (uproarActive) return false;
    if ((!targetAbilityIgnored && hasAbility(state, targetId, 'insomnia', 'vitalspirit', 'sweetveil', 'comatose')) ||
      (opposingStatusMove && hasActiveAllyAbility(state, targetId, 'sweetveil'))) return false;
    if (!targetAbilityIgnored && hasAbility(state, targetId, 'leafguard') && isSunWeather(state.field.weather)) return false;
  }
  if (status === 'brn') {
    if (hasType(state, targetId, 'Fire') ||
      (!targetAbilityIgnored && hasAbility(state, targetId, 'waterveil', 'waterbubble', 'thermalexchange', 'purifyingsalt'))) return false;
  }
  if (status === 'psn' || status === 'tox') {
    const corrosion = hasAbility(state, actorId, 'corrosion');
    if ((!corrosion && hasType(state, targetId, 'Poison', 'Steel')) ||
      (!targetAbilityIgnored && hasAbility(state, targetId, 'immunity', 'pastelveil', 'purifyingsalt')) ||
      (opposingStatusMove && hasActiveAllyAbility(state, targetId, 'pastelveil'))) return false;
  }
  if (opposingStatusMove && hasActiveAllyAbility(state, targetId, 'flowerveil') &&
    getEffectiveTypes(state, targetId).some(type => id(type) === 'grass')) return false;
  if (status === 'par') {
    if (!targetAbilityIgnored && hasAbility(state, targetId, 'limber')) return false;
    if (state.generation >= 6 && hasType(state, targetId, 'Electric')) return false;
    if (moveType && id(moveType) === 'electric' && hasType(state, targetId, 'Ground')) return false;
  }
  if (status === 'frz') {
    if (!targetAbilityIgnored && hasAbility(state, targetId, 'magmaarmor')) return false;
    if (state.generation >= 6 && hasType(state, targetId, 'Fire')) return false;
    if (hasType(state, targetId, 'Ice')) return false;
  }
  return true;
}

export function canApplyVolatile(
  state: BattleState,
  targetId: string,
  volatile: VolatileStatusName,
  actorId?: string,
  statusMove = false,
  moveCategory?: MoveCategory,
): boolean {
  const target = getPokemon(state, targetId);
  if (!target || target.hp.current <= 0) return false;
  const targetSide = sideForPokemon(state, targetId);
  const effectiveMoveCategory = moveCategory || (statusMove ? 'Status' : undefined);
  const targetAbilityIgnored = !!actorId && effectiveMoveCategory !== undefined &&
    ignoresTargetAbility(state, actorId, targetId, effectiveMoveCategory);
  const allyAromaVeil = statusMove && !!actorId &&
    sideForPokemon(state, actorId) !== targetSide && hasActiveAllyAbility(state, targetId, 'aromaveil');
  if (statusMove && actorId && sideForPokemon(state, actorId) !== targetSide &&
    state.sides[targetSide].effects?.craftyShield) return false;
  if (volatile === 'aquaRing' && target.volatile?.aquaRing) return false;
  if (volatile === 'ingrain' && target.volatile?.ingrain) return false;
  if (volatile === 'magnetRise' && target.volatile?.magnetRise) return false;
  if (volatile === 'magnetRise' && target.volatile?.landed) return false;
  if (volatile === 'roost' && target.volatile?.roost) return false;
  if (volatile === 'telekinesis' && (target.volatile?.telekinesis || target.volatile?.ingrain)) return false;
  if (volatile === 'telekinesis' && target.volatile?.landed) return false;
  if (volatile === 'telekinesis' && isItemEffectActive(state, target) &&
    id(target.item) === 'ironball') return false;
  if (['trapped', 'partiallyTrapped', 'octolock'].includes(volatile) && isGhostTrapImmune(state, targetId)) return false;
  if (volatile === 'leechSeed' && (target.volatile?.leechSeed || hasType(state, targetId, 'Grass'))) return false;
  if (volatile === 'nightmare' && (target.status !== 'slp' || target.volatile?.nightmare)) return false;
  if (volatile === 'electrified' && target.volatile?.electrified) return false;
  if (volatile === 'octolock' && target.volatile?.octolock) return false;
  if (volatile === 'miracleEye' && target.volatile?.miracleEye) return false;
  if (volatile === 'foresight' && target.volatile?.foresight) return false;
  if (volatile === 'taunt' && target.volatile?.taunt) return false;
  if (volatile === 'encore' && target.volatile?.encore) return false;
  if (volatile === 'disable' && target.volatile?.disable) return false;
  if (volatile === 'torment' && target.volatile?.torment) return false;
  if (volatile === 'curse' && target.volatile?.curse) return false;
  if (volatile === 'perishSong' && target.volatile?.perishSong) return false;
  if (volatile === 'confusion' && (target.volatile?.confusion ||
    (!targetAbilityIgnored && hasAbility(state, targetId, 'owntempo')))) return false;
  if (volatile === 'flinch' && !targetAbilityIgnored && hasAbility(state, targetId, 'innerfocus')) return false;
  // The absence of a gender check here is the RULE, not an oversight. Run &
  // Bun makes infatuation gender-independent: profile flag
  // `mechanics.attractIsGenderIndependent`, tagged source-of-truth, stated
  // twice in docs/AI_DATA_MODEL.md, and settled by the DECISIONS ruling
  // `soul-dew-and-infatuation-verified` (2026-08-12), which closed the
  // question without changing code. It has been "fixed" once already and
  // reverted. tests/runbun_mechanics.test.js now fails if it is gated again.
  if (volatile === 'infatuated' &&
    (target.volatile?.infatuated || (!targetAbilityIgnored && hasAbility(state, targetId, 'oblivious')))) return false;
  if (volatile === 'taunt' &&
    ((!targetAbilityIgnored && hasAbility(state, targetId, 'oblivious', 'aromaveil')) || allyAromaVeil)) return false;
  if (volatile === 'encore' &&
    ((!targetAbilityIgnored && hasAbility(state, targetId, 'aromaveil')) || allyAromaVeil)) return false;
  if (volatile === 'disable' &&
    ((!targetAbilityIgnored && hasAbility(state, targetId, 'aromaveil')) || allyAromaVeil)) return false;
  if (volatile === 'torment' &&
    ((!targetAbilityIgnored && hasAbility(state, targetId, 'aromaveil')) || allyAromaVeil)) return false;
  if (volatile === 'infatuated' && !targetAbilityIgnored && allyAromaVeil) return false;
  if (volatile === 'healBlock' && !targetAbilityIgnored && allyAromaVeil) return false;
  if (volatile === 'yawn' && !!actorId && sideForPokemon(state, actorId) !== targetSide &&
    hasActiveAllyAbility(state, targetId, 'sweetveil')) return false;
  if (volatile === 'yawn' && !!actorId && sideForPokemon(state, actorId) !== targetSide &&
    hasActiveAllyAbility(state, targetId, 'flowerveil') &&
    getEffectiveTypes(state, targetId).some(type => id(type) === 'grass')) return false;
  if (volatile === 'perishSong' && !targetAbilityIgnored && hasAbility(state, targetId, 'soundproof')) return false;
  if (volatile === 'trapped' && target.volatile?.trapped) return false;
  if (volatile === 'tarShot' && target.volatile?.tarShot) return false;
  if (volatile === 'throatChop' && target.volatile?.throatChop) return false;
  if (volatile === 'embargo' && target.volatile?.embargo) return false;
  if (volatile === 'healBlock' && target.volatile?.healBlock) return false;
  if (volatile === 'spotlight' && target.volatile?.spotlight) return false;
  if (volatile === 'magicCoat' && target.volatile?.magicCoat) return false;
  return true;
}
