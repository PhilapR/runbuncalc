import * as Calc from '@smogon/calc';
import {getCalculatorAbility, getEffectiveAbility, getGenerationAbility, isAbilityActive, isAbilityAvailable, isSlowStartActive} from './abilities';
import {enumerateMoveActions, getPokemon, isDisguiseActive, isRainWeather, isSunWeather, isWeatherSuppressed} from './actions';
import {DamageInput, makeDamageFacts} from './facts';
import {
  CHARGE_MOVE_MIN_GENERATION,
  getEffectiveMoveMetadata,
  getMoveMetadata,
  isMoveAvailable,
  SEMI_INVULNERABLE_BYPASS_MOVES,
  SEMI_INVULNERABLE_CHARGE_MOVES,
} from './move-metadata';
import {getEffectiveCalculatorItem, isItemEffectActive} from './items';
import {getEffectiveTypes, getEffectiveTypesForPokemon, ignoresTargetAbility, isGrounded} from './eligibility';
import {getActionOrderFacts} from './order';
import {getCalcSpeciesOverrides, getEffectiveSpecies} from './stat-transforms';
import {
  Action,
  ActionFacts,
  BattleState,
  DamageFacts,
  PokemonState,
  RUN_AND_BUN_EVS,
  SideEffects,
  SideId,
  StatBoosts,
} from './model';
import {pledgeCombination} from './pledge';
import {projectTypeChangingPokemon} from './type-changes';

function findSide(state: BattleState, pokemonId: string): SideId {
  if (state.sides.ai.party.some(pokemon => pokemon.id === pokemonId)) return 'ai';
  if (state.sides.player.party.some(pokemon => pokemon.id === pokemonId)) return 'player';
  throw new Error(`Unknown PokÃ©mon id: ${pokemonId}`);
}

function toCalcBoosts(boosts: PokemonState['boosts']) {
  if (!boosts) return undefined;
  return {
    atk: boosts.atk,
    def: boosts.def,
    spa: boosts.spa,
    spd: boosts.spd,
    spe: boosts.spe,
  };
}

function confusionBoostedStat(stat: number, boost: number | undefined, generation: number): number {
  // An unboosted stat arrives as `undefined` from calc Pokemon whose boosts
  // table was never touched, and the stage tables below index by stage —
  // `6 + undefined` walked off the table and crashed the whole evaluation.
  const stage = Math.max(-6, Math.min(6, boost ?? 0));
  if (generation < 3) {
    if (stage >= 0) return Math.floor(stat * [1, 1.5, 2, 2.5, 3, 3.5, 4][stage]);
    return Math.floor(stat * [1, 0.66, 0.5, 0.4, 0.33, 0.28, 0.25][-stage]);
  }
  const [numerator, denominator] = [
    [2, 8], [2, 7], [2, 6], [2, 5], [2, 4], [2, 3], [2, 2],
    [3, 2], [4, 2], [5, 2], [6, 2], [7, 2], [8, 2],
  ][6 + stage];
  return Math.floor(stat * numerator / denominator);
}

/**
 * Confusion self-hit damage is a distinct simulator calculation: 40 physical
 * power, the actor's boosted Attack and Defense, and the ordinary 85-100
 * random range, without STAB, type, critical, item, or ability modifiers.
 */
function calculateConfusionDamage(state: BattleState, actor: PokemonState): DamageFacts {
  const gen = Calc.Generations.get(state.generation);
  const pokemon = toCalcPokemon(gen, actor, state);
  const attack = confusionBoostedStat(pokemon.stats.atk, pokemon.boosts.atk, state.generation);
  const defense = confusionBoostedStat(pokemon.stats.def, pokemon.boosts.def, state.generation);
  const baseDamage = Math.floor(
    Math.floor(Math.floor(Math.floor((2 * actor.level / 5 + 2) * 40 * attack) / defense) / 50),
  ) + 2;
  const rolls = Array.from({length: 16}, (_, index) =>
    Math.max(1, Math.floor(baseDamage * (85 + index) / 100)));
  return makeDamageFacts(rolls, actor.hp.current);
}

/**
 * Conversion cache: one battle state evaluates many actions against the same
 * two or four Pokemon, and rebuilding a Calc.Pokemon (species lookup, stat
 * derivation, deep option merge) dominated the fact pipeline's profile.
 * Sound because BOTH keys are immutable by construction — `transition.ts`
 * only ever spread-copies Pokemon and state — and no caller mutates the
 * returned Calc.Pokemon (`calculate()` clones its inputs). Stateless
 * conversions are not cached; they have no state to key on.
 */
const CALC_POKEMON_CACHE = new WeakMap<BattleState, WeakMap<PokemonState, Calc.Pokemon>>();

function toCalcPokemon(
  gen: ReturnType<typeof Calc.Generations.get>,
  pokemon: PokemonState,
  state?: BattleState,
) {
  if (state) {
    let byMon = CALC_POKEMON_CACHE.get(state);
    if (!byMon) {
      byMon = new WeakMap();
      CALC_POKEMON_CACHE.set(state, byMon);
    }
    const cached = byMon.get(pokemon);
    if (cached) return cached;
    const built = buildCalcPokemon(gen, pokemon, state);
    byMon.set(pokemon, built);
    return built;
  }
  return buildCalcPokemon(gen, pokemon, state);
}

function buildCalcPokemon(
  gen: ReturnType<typeof Calc.Generations.get>,
  pokemon: PokemonState,
  state?: BattleState,
) {
  const moveNames = state
    ? pokemon.moves.filter(move => isMoveAvailable(move.name, state.generation)).map(move => move.name)
    : pokemon.moves.map(move => move.name);
  const effectiveTypes = state ? getEffectiveTypesForPokemon(state, pokemon) : undefined;
  const groundedOverride = state && (pokemon.volatile?.magnetRise || pokemon.volatile?.roost ||
    pokemon.volatile?.telekinesis || pokemon.volatile?.landed)
    ? isGrounded(state, pokemon.id)
    : undefined;
  const speciesOverrides = getCalcSpeciesOverrides(gen, pokemon);
  const abilityActive = isAbilityActive(pokemon, state);
  const generationAbility = getGenerationAbility(state?.generation, pokemon);
  const calcPokemon = new Calc.Pokemon(gen, getEffectiveSpecies(pokemon), {
    level: pokemon.level,
    ability: abilityActive ? generationAbility : undefined,
    abilityOn: abilityActive
      ? pokemon.abilityOn === true || !!pokemon.volatile?.flashFire || !!state && isSlowStartActive(state, pokemon) ||
        !!state && isAbilityAvailable(state.generation, getEffectiveAbility(pokemon)) &&
        moveId(getEffectiveAbility(pokemon) || '') === 'parentalbond'
      : false,
    item: state && pokemon.itemCorroded && pokemon.item
      ? pokemon.item
      : state ? getEffectiveCalculatorItem(state, pokemon) : pokemon.item,
    itemSuppressed: !!pokemon.itemCorroded,
    nature: pokemon.nature,
    gender: pokemon.gender,
    ivs: pokemon.ivs,
    evs: RUN_AND_BUN_EVS,
    boosts: toCalcBoosts(pokemon.boosts),
    statOverrides: pokemon.statOverrides,
    originalCurHP: pokemon.hp.current,
    status: pokemon.status,
    toxicCounter: pokemon.toxicCounter,
    teraType: pokemon.teraType as Calc.State.Pokemon['teraType'],
    isDynamaxed: pokemon.isDynamaxed,
    isSaltCure: pokemon.isSaltCure,
    isGrounded: groundedOverride,
    alliesFainted: pokemon.alliesFainted,
    moves: moveNames,
    overrides: effectiveTypes || speciesOverrides
      ? {
        ...(speciesOverrides || {}),
        ...(effectiveTypes ? {types: effectiveTypes as unknown as Calc.Pokemon['types']} : {}),
      }
      : undefined,
  });
  return calcPokemon;
}

function projectStanceChangePokemon(
  state: BattleState,
  action: Extract<Action, {kind: 'move'}>,
  pokemon: PokemonState,
): PokemonState {
  if (state.generation < 6 ||
    (pokemon.speciesOverride && !['aegislashblade', 'aegislashshield', 'aegislashboth']
      .includes(moveId(pokemon.speciesOverride))) || !isAbilityActive(pokemon, state) ||
    !isAbilityAvailable(state.generation, getEffectiveAbility(pokemon)) ||
    moveId(getEffectiveAbility(pokemon) || '') !== 'stancechange') return pokemon;
  const species = moveId(getEffectiveSpecies(pokemon));
  if (!['aegislashblade', 'aegislashshield', 'aegislashboth'].includes(species)) return pokemon;
  const moveState = pokemon.moves.find(move => move.name === action.moveName);
  const category = moveState
    ? getEffectiveMoveMetadata(moveState, state.generation).category
    : getMoveMetadata(action.moveName, state.generation).category;
  if (category === 'Status' && moveId(action.moveName) !== 'kingsshield') return pokemon;
  const targetSpecies = moveId(action.moveName) === 'kingsshield'
    ? 'Aegislash-Shield'
    : 'Aegislash-Blade';
  return species === moveId(targetSpecies) ? pokemon : {...pokemon, speciesOverride: targetSpecies};
}

function toCalcSide(
  effects: SideEffects = {},
  helpingHand?: boolean,
  foresight?: boolean,
  miracleEye?: boolean,
  seeded?: boolean,
  friendGuard?: boolean,
  battery?: boolean,
  powerSpot?: boolean,
  flowerGift?: boolean,
  pledgeSwamp?: boolean,
): Calc.State.Side {
  return {
    spikes: effects.spikes,
    steelsurge: effects.steelsurge,
    vinelash: effects.vinelash,
    wildfire: effects.wildfire,
    cannonade: effects.cannonade,
    volcalith: effects.volcalith,
    isSR: effects.stealthRock,
    isReflect: effects.reflect,
    isLightScreen: effects.lightScreen,
    isAuroraVeil: effects.auroraVeil,
    isLuckyChant: effects.luckyChant,
    isTailwind: effects.tailwind,
    isHelpingHand: helpingHand === undefined ? effects.helpingHand : helpingHand || effects.helpingHand,
    isFriendGuard: friendGuard === undefined ? effects.friendGuard : friendGuard || effects.friendGuard,
    isBattery: battery === undefined ? effects.battery : battery || effects.battery,
    isPowerSpot: powerSpot === undefined ? effects.powerSpot : powerSpot || effects.powerSpot,
    isPledgeSwamp: pledgeSwamp,
    isFlowerGift: flowerGift === undefined ? false : flowerGift,
    isSeeded: seeded === undefined ? effects.seeded : seeded || effects.seeded,
    isForesight: foresight === undefined ? effects.foresight : foresight || effects.foresight,
    isMiracleEye: miracleEye === undefined ? false : miracleEye,
  };
}

function hasActiveAllyAbility(
  state: BattleState,
  sideId: SideId,
  excludedPokemonId: string | undefined,
  ability: string,
): boolean {
  const minimumGeneration = ability === 'flowergift'
    ? 4
    : ability === 'friendguard'
      ? 5
      : ability === 'battery'
        ? 7
        : ability === 'powerspot'
          ? 8
          : 1;
  if (ability === 'flowergift' &&
    (!isSunWeather(state.field.weather) || isWeatherSuppressed(state))) return false;
  return state.generation >= minimumGeneration &&
    state.sides[sideId].activeIds.some(pokemonId => {
      if (pokemonId === excludedPokemonId) return false;
      const pokemon = getPokemon(state, pokemonId);
      return !!pokemon && pokemon.hp.current > 0 && isAbilityActive(pokemon, state) &&
        moveId(getEffectiveAbility(pokemon) || '') === ability;
    });
}

function hasActiveAbility(state: BattleState, ability: string, minimumGeneration: number): boolean {
  return state.generation >= minimumGeneration &&
    (['ai', 'player'] as const).some(sideId => state.sides[sideId].activeIds.some(pokemonId => {
      const pokemon = getPokemon(state, pokemonId);
      return !!pokemon && pokemon.hp.current > 0 && isAbilityActive(pokemon, state) &&
        moveId(getEffectiveAbility(pokemon) || '') === ability;
    }));
}

function toCalcField(
  state: BattleState,
  attackerSide: SideId,
  defenderSide: SideId,
  attackerId?: string,
  defenderId?: string,
) {
  const activeVolatile = (name: 'waterSport' | 'mudSport') =>
    (['ai', 'player'] as const).some(sideId => state.sides[sideId].activeIds.some(pokemonId =>
      (getPokemon(state, pokemonId)?.hp.current || 0) > 0 && !!getPokemon(state, pokemonId)?.volatile?.[name]));
  const waterSport = state.field.waterSport ||
    (state.generation >= 3 && state.generation <= 5 && activeVolatile('waterSport'));
  const mudSport = state.field.mudSport ||
    (state.generation >= 3 && state.generation <= 5 && activeVolatile('mudSport'));
  return new Calc.Field({
    gameType: state.mode,
    weather: state.field.weather,
    terrain: state.field.terrain,
    isGravity: state.field.gravity,
    isWaterSport: waterSport,
    isMudSport: mudSport,
    isIonDeluge: state.field.ionDeluge,
    isMagicRoom: state.field.magicRoom,
    isWonderRoom: state.field.wonderRoom,
    isDarkAura: state.field.darkAura || hasActiveAbility(state, 'darkaura', 6),
    isFairyAura: state.field.fairyAura || hasActiveAbility(state, 'fairyaura', 6),
    isAuraBreak: state.field.auraBreak || hasActiveAbility(state, 'aurabreak', 6),
    isBeadsOfRuin: state.field.beadsOfRuin || hasActiveAbility(state, 'beadsofruin', 9),
    isSwordOfRuin: state.field.swordOfRuin || hasActiveAbility(state, 'swordofruin', 9),
    isTabletsOfRuin: state.field.tabletsOfRuin || hasActiveAbility(state, 'tabletsofruin', 9),
    isVesselOfRuin: state.field.vesselOfRuin || hasActiveAbility(state, 'vesselofruin', 9),
    attackerSide: toCalcSide(
      state.sides[attackerSide].effects,
      attackerId ? !!getPokemon(state, attackerId)?.volatile?.helpingHand : undefined,
      attackerId ? !!getPokemon(state, attackerId)?.volatile?.foresight : undefined,
      attackerId ? !!getPokemon(state, attackerId)?.volatile?.miracleEye : undefined,
      attackerId ? !!getPokemon(state, attackerId)?.volatile?.leechSeed : undefined,
      hasActiveAllyAbility(state, attackerSide, attackerId, 'friendguard'),
      hasActiveAllyAbility(state, attackerSide, attackerId, 'battery'),
      hasActiveAllyAbility(state, attackerSide, attackerId, 'powerspot'),
      hasActiveAllyAbility(state, attackerSide, attackerId, 'flowergift'),
      state.generation >= 5 && !!state.sides[attackerSide].effects?.pledgeSwamp,
    ),
    defenderSide: toCalcSide(
      state.sides[defenderSide].effects,
      undefined,
      defenderId ? !!getPokemon(state, defenderId)?.volatile?.foresight : undefined,
      defenderId ? !!getPokemon(state, defenderId)?.volatile?.miracleEye : undefined,
      defenderId ? !!getPokemon(state, defenderId)?.volatile?.leechSeed : undefined,
      hasActiveAllyAbility(state, defenderSide, defenderId, 'friendguard'),
      undefined,
      undefined,
      hasActiveAllyAbility(state, defenderSide, defenderId, 'flowergift'),
      state.generation >= 5 && !!state.sides[defenderSide].effects?.pledgeSwamp,
    ),
  });
}

export const HIGH_CRIT_MOVES = new Set([
  'aeroblast', 'aircutter', 'attackorder', 'blazekick', 'crabhammer', 'crosschop',
  'crosspoison', 'drillrun', 'karatechop', 'leafblade', 'nightslash',
  'poisontail', 'psychocut', 'razorleaf', 'razorwind', 'shadowclaw',
  'skyattack', 'slash', 'snipeshot', 'spacialrend', 'stoneedge',
]);
// Always-crit moves: not a stage bonus, a guarantee. Kept apart so the
// stage math never double-counts them.
export const ALWAYS_CRIT_MOVES = new Set([
  'frostbreath', 'stormthrow', 'surgingstrikes', 'wickedblow',
]);
const CRIT_BLOCKING_ABILITIES = new Set(['battlearmor', 'shellarmor', 'magmaarmor']);

const MOVE_ID_CACHE = new Map<string, string>();
function moveId(name: string): string {
  let id = MOVE_ID_CACHE.get(name);
  if (id === undefined) {
    id = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    MOVE_ID_CACHE.set(name, id);
  }
  return id;
}

function isParentalBondSplit(state: BattleState, pokemon: PokemonState, move: Calc.Move): boolean {
  const isSpread = state.mode !== 'Singles' && ['allAdjacent', 'allAdjacentFoes'].includes(move.target);
  return state.generation >= 6 && !isSpread && move.hits === 1 && isAbilityActive(pokemon, state) &&
    isAbilityAvailable(state.generation, getEffectiveAbility(pokemon)) &&
    moveId(getEffectiveAbility(pokemon) || '') === 'parentalbond';
}

function mapDamageFacts(damage: DamageFacts, map: (value: number) => number): DamageFacts {
  if (damage.hitRolls) {
    return makeDamageFacts(
      damage.hitRolls.map(rolls => rolls.map(map)) as [number[], number[]],
      damage.targetHp,
    );
  }
  return makeDamageFacts(damage.rolls.map(map), damage.targetHp, damage.hits || 1, damage.hitRange);
}

function isIceFaceActive(state: BattleState, pokemon: PokemonState): boolean {
  return state.generation >= 8 && isAbilityActive(pokemon, state) &&
    isAbilityAvailable(state.generation, getEffectiveAbility(pokemon)) &&
    moveId(getEffectiveAbility(pokemon) || '') === 'iceface' &&
    moveId(getEffectiveSpecies(pokemon)) === 'eiscue';
}

function hasFlinchMove(
  moves: PokemonState['moves'],
  generation: BattleState['generation'],
): boolean {
  return moves.filter(move => isMoveAvailable(move.name, generation)).some(move =>
    getEffectiveMoveMetadata(move, generation).secondaryEffects?.some(effect =>
    effect.volatile?.name === 'flinch') === true);
}

function availableMoveNames(state: BattleState, pokemon: PokemonState): string[] {
  return pokemon.moves
    .filter(move => isMoveAvailable(move.name, state.generation))
    .map(move => move.name);
}

/**
 * Immutable dex facts about a move, read without building a Move to read them.
 *
 * A 12-rollout adjudication constructed 66,768 calculator objects, and 24,480
 * of them were one line: `new Calc.Move(gen, name).flags?.sound`, built for
 * every defender move on every damage calculation to read a single boolean.
 * Another 6,360 existed only to ask whether `flags` was defined at all, and
 * 2,640 to read a category.
 *
 * These depend on nothing but the generation and the move name — they are
 * properties of the dex entry, not of the battle — so they are cached the way
 * getMoveMetadata already caches its own lookup. Primitives are returned
 * rather than the Move itself: a shared mutable calculator object escaping
 * into a caller is a different and much worse bug than a slow one.
 */
const BARE_MOVE_FACTS = new Map<string, {category: Calc.Move['category'];
  sound: boolean; hasFlags: boolean}>();

function bareMoveFacts(gen: ReturnType<typeof Calc.Generations.get>, moveName: string) {
  const key = `${gen.num}|${moveName}`;
  const cached = BARE_MOVE_FACTS.get(key);
  if (cached) return cached;
  const move = new Calc.Move(gen, moveName);
  const facts = {
    category: move.category,
    sound: !!move.flags?.sound,
    hasFlags: move.flags !== undefined,
  };
  BARE_MOVE_FACTS.set(key, facts);
  return facts;
}

function canonicalCalculatorFallback(
  generation: BattleState['generation'],
  moveName: string,
  metadata: ReturnType<typeof getMoveMetadata>,
) {
  if (bareMoveFacts(Calc.Generations.get(generation), moveName).hasFlags || metadata.basePower === undefined ||
    metadata.type === undefined || metadata.category === undefined) return undefined;
  return {
    basePower: metadata.basePower,
    type: metadata.type as Calc.Move['type'],
    category: metadata.category,
    target: metadata.target || 'any',
    flags: {
      contact: (metadata.contact ? 1 : 0) as 0 | 1,
      heal: (metadata.heal ? 1 : 0) as 0 | 1,
      punch: (metadata.punch ? 1 : 0) as 0 | 1,
      bite: (metadata.bite ? 1 : 0) as 0 | 1,
      pulse: (metadata.pulse ? 1 : 0) as 0 | 1,
      slicing: (metadata.slicing ? 1 : 0) as 0 | 1,
      bullet: (metadata.bullet ? 1 : 0) as 0 | 1,
      sound: (metadata.sound ? 1 : 0) as 0 | 1,
      wind: (metadata.wind ? 1 : 0) as 0 | 1,
    },
  };
}

function criticalHitStage(
  state: BattleState,
  attacker: PokemonState,
  moveName: string,
): number {
  let stage = 0;
  if (state.generation >= 2 && attacker.volatile?.focusEnergy) stage += 2;
  if (state.generation >= 2 && HIGH_CRIT_MOVES.has(moveId(moveName))) stage += 1;
  if (state.generation >= 4 && isAbilityActive(attacker, state) &&
    moveId(getEffectiveAbility(attacker) || '') === 'superluck') stage += 1;
  if (state.generation >= 2 && isItemEffectActive(state, attacker) && moveId(attacker.item || '') === 'scopelens') stage += 1;
  if (state.generation >= 4 && isItemEffectActive(state, attacker) && moveId(attacker.item || '') === 'razorclaw') stage += 1;
  return stage;
}

function projectShellSmashState(state: BattleState, actorId: string): BattleState {
  const actor = getPokemon(state, actorId);
  if (!actor) return state;
  const sideId = findSide(state, actorId);
  const ability = isAbilityActive(actor, state) && isAbilityAvailable(state.generation, getEffectiveAbility(actor))
    ? moveId(getEffectiveAbility(actor) || '') : '';
  const contrary = ability === 'contrary';
  const simple = ability === 'simple';
  const whiteHerb = isItemEffectActive(state, actor) && moveId(actor.item || '') === 'whiteherb';
  const deltas: StatBoosts = {atk: 2, spa: 2, spe: 2, def: -1, spd: -1};
  const projectedBoosts: StatBoosts = {...(actor.boosts || {})};
  for (const stat of Object.keys(deltas) as Array<keyof StatBoosts>) {
    let amount = deltas[stat] || 0;
    if (contrary) amount = -amount;
    if (simple) amount *= 2;
    projectedBoosts[stat] = Math.max(-6, Math.min(6, (projectedBoosts[stat] || 0) + amount));
  }
  if (whiteHerb) {
    for (const stat of Object.keys(projectedBoosts) as Array<keyof StatBoosts>) {
      if ((projectedBoosts[stat] || 0) < 0) projectedBoosts[stat] = 0;
    }
  }
  return {
    ...state,
    sides: {
      ...state.sides,
      [sideId]: {
        ...state.sides[sideId],
        party: state.sides[sideId].party.map(pokemon =>
          pokemon.id === actorId ? {...pokemon, boosts: projectedBoosts} : pokemon),
      },
    },
  };
}

function typeMultiplier(
  gen: ReturnType<typeof Calc.Generations.get>,
  moveType: string,
  defender: Calc.Pokemon,
): number | undefined {
  const attackingType = gen.types.get(Calc.toID(moveType));
  if (!attackingType) return undefined;
  const defenderTypes = defender.teraType ? [defender.teraType] : defender.types;
  let multiplier = 1;
  for (const defenderType of defenderTypes) {
    multiplier *= attackingType.effectiveness[defenderType] ?? 1;
  }
  return multiplier;
}

interface MoveContext {
  state: BattleState;
  attackerState: PokemonState;
  attackerSide: SideId;
  gen: ReturnType<typeof Calc.Generations.get>;
  attacker: Calc.Pokemon;
  move: Calc.Move;
  baseFacts: ActionFacts;
}

function makeMoveContext(state: BattleState, action: Extract<Action, {kind: 'move'}>): MoveContext {
  const attackerState = getPokemon(state, action.actorId);
  if (!attackerState) throw new Error('Action references an unknown attacker');

  const attackerSide = findSide(state, attackerState.id);
  const gen = Calc.Generations.get(state.generation);
  const stanceAttackerState = projectStanceChangePokemon(state, action, attackerState);
  const projectedAttackerState = projectTypeChangingPokemon(state, action, stanceAttackerState);
  const attacker = toCalcPokemon(gen, projectedAttackerState, state);
  const opposingSide: SideId = attackerSide === 'ai' ? 'player' : 'ai';
  const opponentSpeeds = state.sides[opposingSide].activeIds
    .map(id => getPokemon(state, id))
    .filter((pokemon): pokemon is PokemonState => !!pokemon && pokemon.hp.current > 0)
    .map(pokemon => {
      const speed = toCalcPokemon(gen, pokemon, state).stats.spe;
      return state.generation >= 5 && state.sides[opposingSide].effects?.pledgeSwamp
        ? Math.floor(speed / 4)
        : speed;
    });
  const attackerSideState = state.sides[attackerSide];
  const opponentSideState = state.sides[opposingSide];
  const partner = attackerSideState.activeIds
    .filter(id => id !== attackerState.id)
    .map(id => getPokemon(state, id))
    .find((pokemon): pokemon is PokemonState => !!pokemon && pokemon.hp.current > 0);
  const partnerCalc = partner ? toCalcPokemon(gen, partner, state) : undefined;
  const attackerMoveNames = availableMoveNames(state, attackerState);
  const attackerMoveCategories = attackerMoveNames.map(moveName => {
    const moveState = attackerState.moves.find(candidate => candidate.name === moveName);
    return (moveState ? getEffectiveMoveMetadata(moveState, state.generation) : getMoveMetadata(moveName, state.generation)).category ||
      bareMoveFacts(gen, moveName).category;
  });
  const moveState = attackerState.moves.find(move => move.name === action.moveName);
  const moveMetadata = moveState
    ? getEffectiveMoveMetadata(moveState, state.generation)
    : getMoveMetadata(action.moveName, state.generation);
  const pendingPledge = state.pendingPledgeBySide?.[attackerSide];
  const partnerIntent = partner ? state.selectedMoveByPokemon?.[partner.id] : undefined;
  const isStartingCombinedPledge = state.generation >= 5 && !pendingPledge && !!partnerIntent &&
    !partnerIntent.useZ && !partnerIntent.useMax && !action.useZ && !action.useMax &&
    !!pledgeCombination(partnerIntent.moveName, action.moveName);
  const isCombinedPledge = state.generation >= 5 &&
    ((!!pendingPledge && !pendingPledge.useZ && !pendingPledge.useMax &&
      !action.useZ && !action.useMax && !!pledgeCombination(pendingPledge.moveName, action.moveName)) ||
      isStartingCombinedPledge);
  const lockOnAccuracy = state.generation >= 2 && attackerState.volatile?.lockOn &&
    action.targetIds.includes(attackerState.volatile.lockOn.targetId || '');
  const stockpileCount = attackerState.volatile?.stockpile?.stacks || 0;
  const rolloutState = attackerState.volatile?.rollout;
  const rolloutId = moveId(action.moveName);
  const rolloutPower = rolloutState && moveId(rolloutState.moveName || '') === rolloutId
    ? (moveMetadata.basePower || 0) * (2 ** (rolloutState.stacks || 0))
    : undefined;
  const echoedVoiceStreak = state.moveStreakByPokemon?.[attackerState.id];
  const echoedVoiceUses = echoedVoiceStreak?.moveName && moveId(echoedVoiceStreak.moveName) === 'echoedvoice'
    ? echoedVoiceStreak.count + 1
    : 1;
  const echoedVoicePower = rolloutId === 'echoedvoice' && state.generation >= 5
    ? Math.min(200, (moveMetadata.basePower || 40) * echoedVoiceUses)
    : undefined;
  const calculatorItem = getEffectiveCalculatorItem(state, attackerState);
  const metronomeStreak = state.moveStreakByPokemon?.[attackerState.id];
  const derivedMetronomeUses = calculatorItem && moveId(calculatorItem) === 'metronome' &&
    metronomeStreak?.moveName && moveId(metronomeStreak.moveName) === rolloutId
    ? metronomeStreak.count
    : undefined;
  const furyCutterPower = rolloutId === 'furycutter'
    ? Math.min(160, (moveMetadata.basePower || 10) * (2 ** (attackerState.volatile?.furyCutter?.stacks || 0)))
    : undefined;
  const rageFistPower = rolloutId === 'ragefist' && state.generation >= 9
    ? Math.min(350, (moveMetadata.basePower || 50) + 50 * (attackerState.rageFistHits || 0))
    : undefined;
  const lastRespectsPower = rolloutId === 'lastrespects' && state.generation >= 9
    ? (moveMetadata.basePower || 50) + 50 * (attackerState.alliesFainted || 0)
    : undefined;
  const useZ = action.useZ || moveState?.useZ;
  const useMax = action.useMax || moveState?.useMax;
  const chargedElectricMove = !!attackerState.volatile?.charged &&
    (moveMetadata.type === 'Electric' || !!attackerState.volatile?.electrified) &&
    moveMetadata.category !== 'Status' && !useZ && !useMax;
  const spitUpPower = moveId(action.moveName) === 'spitup' && stockpileCount > 0
    ? stockpileCount * 100
    : undefined;
  const pledgePower = isCombinedPledge ? 150 : undefined;
  const basePowerOverride = pledgePower ?? echoedVoicePower ?? furyCutterPower ?? rageFistPower ?? lastRespectsPower ??
    rolloutPower ?? spitUpPower ?? moveMetadata.basePowerOverride;
  const chargedBasePower = chargedElectricMove
    ? (rolloutPower ?? spitUpPower ?? moveMetadata.basePowerOverride ?? moveMetadata.basePower)
    : undefined;
  const moveOverrides = {
    ...(basePowerOverride === undefined ? {} : {basePower: basePowerOverride}),
    ...(moveMetadata.typeOverride === undefined
      ? {}
      : {type: moveMetadata.typeOverride as unknown as Calc.Move['type']}),
    ...(moveState?.category === undefined ? {} : {category: moveState.category}),
    ...(moveState?.priority === undefined ? {} : {priority: moveState.priority}),
    ...(attackerState.volatile?.electrified
      ? {type: 'Electric' as unknown as Calc.Move['type']}
      : {}),
    ...(moveState?.target ? {target: moveState.target} : {}),
    ...((moveState?.contact !== undefined || moveState?.heal !== undefined || moveState?.punch !== undefined ||
      moveState?.bite !== undefined || moveState?.pulse !== undefined || moveState?.slicing !== undefined ||
      moveState?.bullet !== undefined || moveState?.sound !== undefined || moveState?.wind !== undefined)
      ? {flags: {
        ...(moveState.contact === undefined ? {} : {contact: (moveState.contact ? 1 : 0) as 0 | 1}),
        ...(moveState.heal === undefined ? {} : {heal: (moveState.heal ? 1 : 0) as 0 | 1}),
        ...(moveState.punch === undefined ? {} : {punch: (moveState.punch ? 1 : 0) as 0 | 1}),
        ...(moveState.bite === undefined ? {} : {bite: (moveState.bite ? 1 : 0) as 0 | 1}),
        ...(moveState.pulse === undefined ? {} : {pulse: (moveState.pulse ? 1 : 0) as 0 | 1}),
        ...(moveState.slicing === undefined ? {} : {slicing: (moveState.slicing ? 1 : 0) as 0 | 1}),
        ...(moveState.bullet === undefined ? {} : {bullet: (moveState.bullet ? 1 : 0) as 0 | 1}),
        ...(moveState.sound === undefined ? {} : {sound: (moveState.sound ? 1 : 0) as 0 | 1}),
        ...(moveState.wind === undefined ? {} : {wind: (moveState.wind ? 1 : 0) as 0 | 1}),
      }} : {}),
    ...(chargedBasePower === undefined ? {} : {basePower: chargedBasePower * 2}),
  };
  const move = new Calc.Move(gen, action.moveName, {
    ability: getCalculatorAbility(state, attackerState),
    item: calculatorItem,
    species: getEffectiveSpecies(projectedAttackerState),
    isCrit: !!attackerState.volatile?.laserFocus,
    useZ,
    useMax,
    hits: moveState?.hits ??
      (moveId(action.moveName) === 'watershuriken' && moveId(getEffectiveSpecies(projectedAttackerState)) === 'greninjaash'
        ? 3
        : undefined),
    timesUsed: moveState?.timesUsed,
    timesUsedWithMetronome: moveState?.timesUsedWithMetronome ?? derivedMetronomeUses,
    forceSTAB: isCombinedPledge,
    overrides: Object.keys(moveOverrides).length
      ? {...(canonicalCalculatorFallback(state.generation, action.moveName, moveMetadata) || {}), ...moveOverrides}
      : canonicalCalculatorFallback(state.generation, action.moveName, moveMetadata),
  });

  return {
    state,
    attackerState,
    attackerSide,
    gen,
    attacker,
    move,
    baseFacts: {
      moveCategory: move.category,
      moveType: move.type,
      fieldTerrain: state.field.terrain,
      moveAccuracy: lockOnAccuracy || (moveId(action.moveName) === 'nightmare' && state.generation === 2)
        ? true
        : moveMetadata.accuracy,
      isMultiHit: move.hits > 1 || isParentalBondSplit(state, attackerState, move),
      // The calculator resolves a variable multi-hit to a fixed 3 for its
      // damage display; a sampling engine has to roll the count instead.
      multiHitRange: getCalculatorAbility(state, attackerState) === 'Skill Link'
        ? undefined
        : moveMetadata.multiHitRange,
      secondaryEffects: moveMetadata.secondaryEffects,
      battleMode: state.mode,
      // Use the shared action-order boundary so ability-granted priority is
      // visible to policy facts; fractional item priority remains an order fact.
      priority: getActionOrderFacts(state, action).priority,
      attackerSpeed: attacker.stats.spe,
      attackerCriticalHitStage: criticalHitStage(state, attackerState, action.moveName),
      criticalHitGuaranteed: !!attackerState.volatile?.laserFocus ||
        ALWAYS_CRIT_MOVES.has(moveId(action.moveName)),
      attackerHp: attackerState.hp.current,
      attackerHpPercent: attackerState.hp.max > 0
        ? attackerState.hp.current / attackerState.hp.max * 100
        : 0,
      opponentSpeeds,
      attackerAbility: isAbilityActive(attackerState, state) ? getGenerationAbility(state.generation, attackerState) : undefined,
      attackerPartnerAbility: partner && isAbilityActive(partner, state) ? getGenerationAbility(state.generation, partner) : undefined,
      attackerPartnerItem: partner && isItemEffectActive(state, partner) ? partner.item : undefined,
      attackerPartnerTypes: partnerCalc?.types,
      attackerPartnerMoves: partner ? availableMoveNames(state, partner) : undefined,
      attackerPartnerSpeed: partnerCalc?.stats.spe,
      attackerPartnerGroundImmune: partner ? !isGrounded(state, partner.id) : undefined,
      attackerPartnerHasMagnetRise: !!partner?.volatile?.magnetRise,
      attackerSpecies: getEffectiveSpecies(attackerState),
      attackerItem: isItemEffectActive(state, attackerState) ? attackerState.item : undefined,
      attackerStatus: attackerState.status,
      attackerBoosts: attackerState.boosts,
      attackerMoves: attackerMoveNames,
      attackerHasPhysicalMove: attackerMoveCategories.includes('Physical'),
      attackerHasSpecialMove: attackerMoveCategories.includes('Special'),
      attackerHasFlinchMove: hasFlinchMove(attackerState.moves, state.generation),
      attackerPartyAliveCount: attackerSideState.party.filter(pokemon => pokemon.hp.current > 0).length,
      defenderPartyAliveCount: opponentSideState.party.filter(pokemon => pokemon.hp.current > 0).length,
      isFirstTurnOut: state.firstTurnOutIds?.includes(attackerState.id),
      lastMoveUsed: state.lastMoveByPokemon?.[attackerState.id],
      attackerSubstitute: (attackerState.substituteHp || 0) > 0,
      attackerHelpingHand: !!attackerState.volatile?.helpingHand,
    },
  };
}

function calculateTargetFacts(context: MoveContext, targetId: string): ActionFacts {
  const defenderState = getPokemon(context.state, targetId);
  if (!defenderState) throw new Error(`Action references an unknown target: ${targetId}`);

  const defenderSide = findSide(context.state, defenderState.id);
  const defender = toCalcPokemon(context.gen, defenderState, context.state);
  const defenderMoveNames = availableMoveNames(context.state, defenderState);
  const defenderMoveCategories = defenderMoveNames.map(moveName => {
    const moveState = defenderState.moves.find(candidate => candidate.name === moveName);
    return (moveState ? getEffectiveMoveMetadata(moveState, context.state.generation) : getMoveMetadata(moveName, context.state.generation)).category ||
      bareMoveFacts(context.gen, moveName).category;
  });
  const lastMoveUsed = context.state.lastMoveByPokemon?.[defenderState.id];
  const defenderLastMoveUsed = lastMoveUsed && isMoveAvailable(lastMoveUsed, context.state.generation)
    ? lastMoveUsed : undefined;
  const defenderLastMoveIsStatus = defenderLastMoveUsed === undefined
    ? undefined
    : bareMoveFacts(context.gen, defenderLastMoveUsed).category === 'Status';
  const defenderHasSoundMove = defenderMoveNames.some(moveName => {
    const moveState = defenderState.moves.find(candidate => candidate.name === moveName);
    const metadata = moveState
      ? getEffectiveMoveMetadata(moveState, context.state.generation)
      : getMoveMetadata(moveName, context.state.generation);
    return !defenderState.volatile?.throatChop &&
      (metadata.sound === true || bareMoveFacts(context.gen, moveName).sound);
  });
  const field = toCalcField(
    context.state,
    context.attackerSide,
    defenderSide,
    context.attackerState.id,
    defenderState.id,
  );
  const result = Calc.calculate(context.gen, context.attacker, defender, context.move, field);
  const parentalBondSplit = isParentalBondSplit(context.state, context.attackerState, context.move);
  const calculatorDamage = result.damage as DamageInput;
  const splitDamage = parentalBondSplit && Array.isArray(calculatorDamage) &&
    calculatorDamage.length === 2 && typeof calculatorDamage[0] === 'number' &&
    typeof calculatorDamage[1] === 'number'
    ? [[calculatorDamage[0]], [calculatorDamage[1]]] as [number[], number[]]
    : calculatorDamage;
  const rawDamage = makeDamageFacts(
    splitDamage,
    defenderState.hp.current,
    context.baseFacts.isMultiHit ? context.move.hits : 1,
    context.baseFacts.multiHitRange,
  );
  // Every damage-shaping guard below applies to the crit distribution too:
  // Sturdy caps a crit at HP-1 exactly as it caps a normal hit, Disguise
  // eats a crit whole. Extracted so the crit pass cannot drift from it.
  const applyDamageGuards = (input: DamageFacts): DamageFacts => {
    const semiInvulnerable = defenderState.volatile?.charge?.moveName &&
      SEMI_INVULNERABLE_CHARGE_MOVES.has(moveId(defenderState.volatile.charge.moveName)) &&
      !SEMI_INVULNERABLE_BYPASS_MOVES.has(moveId(context.move.name));
    let guarded = semiInvulnerable ||
      (context.move.category !== 'Status' && !context.baseFacts.isMultiHit &&
        isDisguiseActive(context.state, defenderState) && input.max > 0)
      ? makeDamageFacts([0], defenderState.hp.current)
      : input;
    if (context.state.generation >= 8 && context.move.category === 'Physical' &&
      !context.baseFacts.isMultiHit && !defenderState.substituteHp && guarded.max > 0 &&
      isIceFaceActive(context.state, defenderState) &&
      !ignoresTargetAbility(context.state, context.attackerState.id, defenderState.id, context.move.category)) {
      guarded = makeDamageFacts([0], defenderState.hp.current);
    }
    if (context.state.generation >= 8 && context.move.category !== 'Status' &&
      moveId(context.move.type) === 'fire' && defenderState.volatile?.tarShot && guarded.max > 0) {
      guarded = mapDamageFacts(guarded, roll => roll * 2);
    }
    if (context.state.generation >= 9 && defenderState.volatile?.glaiveRush &&
      context.move.category !== 'Status' && guarded.max > 0) {
      guarded = mapDamageFacts(guarded, roll => roll * 2);
    }
    if (context.state.generation >= 5 && context.move.category !== 'Status' && !context.baseFacts.isMultiHit &&
      defenderState.hp.current === defenderState.hp.max && !defenderState.substituteHp &&
      isAbilityActive(defenderState, context.state) && moveId(getEffectiveAbility(defenderState) || '') === 'sturdy' &&
      guarded.max >= defenderState.hp.current) {
      guarded = makeDamageFacts(
        guarded.rolls.map(roll => Math.min(roll, Math.max(0, defenderState.hp.current - 1))),
        defenderState.hp.current,
        guarded.hits,
      );
    }
    if (context.state.generation >= 4 && context.move.category !== 'Status' && !context.baseFacts.isMultiHit &&
      defenderState.hp.current === defenderState.hp.max && !defenderState.substituteHp &&
      isItemEffectActive(context.state, defenderState) && moveId(defenderState.item || '') === 'focussash' &&
      guarded.max >= defenderState.hp.current) {
      guarded = makeDamageFacts(
        guarded.rolls.map(roll => Math.min(roll, Math.max(0, defenderState.hp.current - 1))),
        defenderState.hp.current,
        guarded.hits,
      );
    }
    return guarded;
  };
  let damage = applyDamageGuards(rawDamage);

  // The crit distribution, computed once beside the normal one. Without it
  // P(crit) was zero in every sampled outcome outside Laser Focus — the
  // engine knew the crit STAGE and had no consumer for it.
  const critBlocked = !!context.state.sides[defenderSide].effects?.luckyChant ||
    (isAbilityActive(defenderState, context.state) &&
      isAbilityAvailable(context.state.generation, getEffectiveAbility(defenderState)) &&
      CRIT_BLOCKING_ABILITIES.has(moveId(getEffectiveAbility(defenderState) || '')));
  if (context.move.category !== 'Status' && damage.max > 0 &&
    !context.baseFacts.criticalHitGuaranteed && !critBlocked) {
    const critMove = new Calc.Move(context.gen, context.move.name, {
      ...(context.move as unknown as {originalOptions?: object}).originalOptions,
      ability: getCalculatorAbility(context.state, context.attackerState),
      item: context.move.item,
      species: getEffectiveSpecies(context.attackerState),
      isCrit: true,
      hits: context.move.hits,
      overrides: (context.move as unknown as {overrides?: object}).overrides,
    });
    const critResult = Calc.calculate(context.gen, context.attacker, defender, critMove, field);
    const critFacts = applyDamageGuards(makeDamageFacts(
      critResult.damage as DamageInput,
      defenderState.hp.current,
      context.baseFacts.isMultiHit ? context.move.hits : 1,
      context.baseFacts.multiHitRange,
    ));
    damage = {...damage, critRolls: critFacts.rolls, critMax: critFacts.max, critMin: critFacts.min};
  }

  return {
    ...context.baseFacts,
    damage,
    defenderAbility: isAbilityActive(defenderState, context.state) ? getGenerationAbility(context.state.generation, defenderState) : undefined,
    defenderTypes: defender.types,
    defenderSpecies: getEffectiveSpecies(defenderState),
    defenderItem: isItemEffectActive(context.state, defenderState) ? defenderState.item : undefined,
    defenderStatus: defenderState.status,
    ...(defenderState.id === context.attackerState.id ? {} : {
      defenderIncapacitated: defenderState.status === 'slp' || defenderState.status === 'frz' ||
        !!defenderState.volatile?.recharge || !!defenderState.volatile?.truant,
    }),
    defenderConfused: !!defenderState.volatile?.confusion,
    defenderInfatuated: !!defenderState.volatile?.infatuated,
    defenderBoosts: defenderState.boosts,
    defenderMoves: defenderMoveNames,
    defenderHasPhysicalMove: defenderMoveCategories.includes('Physical'),
    defenderHasSpecialMove: defenderMoveCategories.includes('Special'),
    defenderHasStatusMove: defenderMoveCategories.includes('Status'),
    defenderHasSoundMove,
    defenderSeeded: !!defenderState.volatile?.leechSeed || !!context.state.sides[defenderSide].effects?.seeded,
    defenderSubstitute: (defenderState.substituteHp || 0) > 0,
    defenderHpPercent: defenderState.hp.max > 0
      ? defenderState.hp.current / defenderState.hp.max * 100
      : 0,
    defenderLastMoveUsed,
    defenderLastMoveIsStatus,
    defenderSpeed: defender.stats.spe,
    isSuperEffective: typeMultiplier(context.gen, context.move.type, defender)! > 1,
    isHighCrit: !context.state.sides[defenderSide].effects?.luckyChant &&
      (HIGH_CRIT_MOVES.has(moveId(context.move.name)) ||
      ALWAYS_CRIT_MOVES.has(moveId(context.move.name)) ||
      !!context.attackerState.volatile?.laserFocus) &&
      !(isAbilityActive(defenderState, context.state) &&
        isAbilityAvailable(context.state.generation, getEffectiveAbility(defenderState)) &&
        CRIT_BLOCKING_ABILITIES.has(moveId(getEffectiveAbility(defenderState) || ''))),
    criticalHitGuaranteed: context.baseFacts.criticalHitGuaranteed &&
      !context.state.sides[defenderSide].effects?.luckyChant,
    criticalHit: context.baseFacts.criticalHitGuaranteed &&
      !context.state.sides[defenderSide].effects?.luckyChant,
    isImmune: damage.max === 0,
  };
}

function calculateMoveActionFacts(
  state: BattleState,
  action: Extract<Action, {kind: 'move'}>,
): ActionFacts {
  const context = makeMoveContext(state, action);
  if (action.targetIds.length === 0) return context.baseFacts;

  const factsByTarget = action.targetIds.map(targetId => ({
    targetId,
    facts: calculateTargetFacts(context, targetId),
  }));
  const damageByTarget: Record<string, DamageFacts> = {};
  for (const result of factsByTarget) {
    if (result.facts.damage) damageByTarget[result.targetId] = result.facts.damage;
  }

  return {
    ...factsByTarget[0].facts,
    damageByTarget,
  };
}

export function calculateActionFacts(
  state: BattleState,
  action: Action,
  options: {reactive?: boolean} = {},
): ActionFacts {
  if (action.kind === 'switch') {
    throw new Error('The calculator adapter does not score switch actions yet');
  }

  // Shell Trap is selected as a one-turn status/setup action. Its canonical
  // 150-power move data is used only when the armed trap is triggered by a
  // contact move in the move engine.
  if (!options.reactive && state.generation >= 7 && moveId(action.moveName) === 'shelltrap') {
    return {moveCategory: 'Status', moveAccuracy: true, priority: 0};
  }

  const rechargeActor = getPokemon(state, action.actorId);
  if (rechargeActor?.volatile?.recharge) {
    return {moveCategory: 'Status', moveAccuracy: true, priority: 0};
  }
  const actionMoveId = moveId(action.moveName);
  const chargeGeneration = CHARGE_MOVE_MIN_GENERATION[actionMoveId] ??
    (actionMoveId === 'geomancy' ? 6 : undefined);
  if (rechargeActor && !rechargeActor.volatile?.charge &&
    chargeGeneration !== undefined && state.generation >= chargeGeneration &&
    !(state.generation >= 4 && isItemEffectActive(state, rechargeActor) &&
      moveId(rechargeActor.item || '') === 'powerherb') &&
    !(((actionMoveId === 'solarbeam' || actionMoveId === 'solarblade') && isSunWeather(state.field.weather)) ||
      (actionMoveId === 'electroshot' && isRainWeather(state.field.weather)) &&
      !isWeatherSuppressed(state))) {
    return {moveCategory: 'Status', moveAccuracy: true, priority: 0};
  }

  const facts = calculateMoveActionFacts(state, action);
  const actor = getPokemon(state, action.actorId);
  if (actor?.volatile?.confusion) facts.confusionDamage = calculateConfusionDamage(state, actor);
  const attackerSide = state.sides.ai.party.some(pokemon => pokemon.id === action.actorId)
    ? 'ai'
    : 'player';

  // Derive incoming threat facts from the evaluated actor's perspective. The
  // public chooser supports either side, so restricting this to the AI side
  // would silently omit KO/survival facts when callers evaluate the player.
  const incomingState = action.kind === 'move' && moveId(action.moveName) === 'shellsmash'
    ? projectShellSmashState(state, action.actorId)
    : state;
  const opposingSide: SideId = attackerSide === 'ai' ? 'player' : 'ai';
  const incomingFacts = enumerateMoveActions(incomingState, opposingSide)
    .filter(candidate => candidate.targetIds.includes(action.actorId))
    .map(candidate => calculateMoveActionFacts(incomingState, candidate));
  const incomingDamage = (candidate: ActionFacts): DamageFacts | undefined =>
    candidate.damageByTarget?.[action.actorId] ?? candidate.damage;
  const incoming = incomingFacts.some(candidate => incomingDamage(candidate)?.possibleKO);
  const incomingTwoHit = !!actor && incomingFacts.some(candidate =>
    !!incomingDamage(candidate) && incomingDamage(candidate)!.max * 2 >= actor.hp.current);
  const opponentMaxDamage = incomingFacts.reduce((maximum, candidate) =>
    Math.max(maximum, incomingDamage(candidate)?.max || 0), 0);
  facts.opponentCanKO = incoming;
  facts.opponentCan2HKO = incomingTwoHit;
  facts.opponentMaxDamage = opponentMaxDamage;

  return facts;
}
