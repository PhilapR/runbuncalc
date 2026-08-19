import * as Calc from '@smogon/calc';
import {getCalculatorAbility, getEffectiveAbility, getGenerationAbility, isAbilityActive, isAbilityAvailable} from './abilities';
import {canEscapeTrappingEffect, getPokemon, isDisguiseActive, isGhostType, isRainWeather, isStrongWeather, isSunWeather, isSwitchBlockedByAbility, isWeatherSuppressed, sideForPokemon} from './actions';
import {calculateActionFacts} from './calc-adapter';
import {getEffectiveMoveAccuracy, isMicleBerryReady} from './accuracy';
import {
  blocksSecondaryEffects,
  canApplyMajorStatus,
  canApplyVolatile,
  getEffectiveTypes,
  ignoresTargetAbility,
  isGrounded,
  isPriorityBlocked,
} from './eligibility';
import {
  getBoosterEnergyVolatile,
  getParadoxAbilityVolatile,
  isItemAvailable,
  isItemEffectActive,
  preventsAbilityChange,
} from './items';
import {
  CHARGE_MOVE_MIN_GENERATION,
  CURSE_MOVE_MIN_GENERATION,
  getEffectiveMoveMetadata,
  getMoveMaxPP,
  getMoveMetadata,
  isMoveAvailable,
  isSelfSacrificeMove,
  RECHARGE_MOVE_MIN_GENERATION,
  PARTIAL_TRAPPING_MOVES,
  PROTECTION_MOVE_MIN_GENERATION,
  SEMI_INVULNERABLE_BYPASS_MOVES,
  SEMI_INVULNERABLE_CHARGE_MOVES,
  UPROAR_MOVE_MIN_GENERATION,
} from './move-metadata';
import {getActionOrderFacts, getEffectivePokemonSpeed} from './order';
import {sampleDamageFact, sampleDamageResolution} from './resolution';
import {getCalcSpeciesOverrides, getEffectiveSpecies, getRawStats} from './stat-transforms';
import {isMimicryActive, mimicryTypeOverride} from './mimicry';
import {hasPureAbilityEffect, PURE_ABILITY_MOVE_IDS} from './ability-legality';
import {COPY_BLOCKED_MOVES, hasMoveCopyEffect, PURE_MOVE_COPY_IDS} from './copy-legality';
import {ASSIST_BLOCKED_MOVES, hasCallMoveEffect, ME_FIRST_BLOCKED_MOVES, PURE_CALL_MOVE_IDS} from './call-legality';
import {hasPureTypeEffect, PURE_TYPE_MOVE_IDS} from './type-legality';
import {hasInstructEffect} from './instruct-legality';
import {canRemoveHeldItem, hasPureItemTransferEffect, PURE_ITEM_TRANSFER_MOVE_IDS} from './item-legality';
import {hasSelfStageEffect} from './setup-legality';
import {PURE_STATUS_EFFECTS} from './status-legality';
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
import {getLastMoveState, getPurePPLoss, hasPurePPEffect, PURE_PP_MOVE_IDS} from './pp-legality';
import {getTypeChangeResolution} from './type-changes';
import {weatherFormSpeciesOverride} from './weather-forms';
import {confusionBerryDislikesNature, statusBerryCures} from './berry-effects';
import {pledgeCombination} from './pledge';
import {
  ActionFacts,
  ActionFailure,
  BattleState,
  DelayedMoveState,
  MoveAction,
  MoveResolution,
  MoveTarget,
  MoveCategory,
  PokemonState,
  RUN_AND_BUN_EVS,
  SideEffects,
  SideId,
  StatBoosts,
  StatusName,
  SecondaryEffect,
  Terrain,
  TimedFieldName,
  TimedSideEffectName,
  VolatileState,
  VolatileStatusName,
  Weather,
} from './model';

export interface MoveEngineOptions {
  facts?: ActionFacts;
  hit?: boolean;
  accuracy?: number | true;
  secondaryEffects?: SecondaryEffect[];
  random?: () => number;
}

const WEATHER_BY_SETTER: Record<string, Weather> = {
  raindance: 'Rain', sunnyday: 'Sun', sandstorm: 'Sand', hail: 'Hail', snowscape: 'Snow', chillyreception: 'Snow',
};
const TERRAIN_BY_SETTER: Record<string, Terrain> = {
  electricterrain: 'Electric', grassyterrain: 'Grassy', psychicterrain: 'Psychic', mistyterrain: 'Misty',
};
const WEATHER_SETTER_MIN_GENERATION: Record<string, number> = {
  raindance: 2, sunnyday: 2, sandstorm: 2, hail: 3, snowscape: 9, chillyreception: 9,
};
const FLING_ITEM_STATUSES: Record<string, StatusName> = {
  flameorb: 'brn', lightball: 'par', poisonbarb: 'psn', toxicorb: 'tox',
};
const FLING_ITEM_VOLATILES: Record<string, VolatileStatusName> = {
  kingsrock: 'flinch', razorfang: 'flinch',
};
const FLING_CONFUSION_BERRIES = new Set(['aguavberry', 'figyberry', 'iapapaberry', 'magoberry', 'wikiberry']);
const FLING_STAT_BERRIES: Record<string, keyof StatBoosts> = {
  liechiberry: 'atk', ganlonberry: 'def', salacberry: 'spe', petayaberry: 'spa', apicotberry: 'spd',
};
const FLING_RANDOM_BOOST_STATS: Array<keyof StatBoosts> = ['atk', 'def', 'spa', 'spd', 'spe'];
const MENTAL_HERB_VOLATILES: VolatileStatusName[] = [
  'infatuated', 'taunt', 'encore', 'torment', 'disable', 'healBlock',
];

export function fieldSetterNoOpReason(state: BattleState, moveName: string): string | undefined {
  const id = moveId(moveName);
  const weather = WEATHER_BY_SETTER[id];
  if (weather && state.generation >= (WEATHER_SETTER_MIN_GENERATION[id] || 1) && state.field.weather === weather &&
    (state.generation >= 3 || id === 'sandstorm')) {
    return `${moveName} failed because ${weather} was already active`;
  }
  if (weather && state.field.weather && isStrongWeather(state.field.weather) &&
    state.field.weather !== weather) {
    return `${moveName} failed because ${state.field.weather} cannot be overridden`;
  }
  const terrain = TERRAIN_BY_SETTER[id];
  if (terrain && state.generation >= 6 && state.field.terrain === terrain) {
    return `${moveName} failed because ${terrain} Terrain was already active`;
  }
  if (id === 'gravity' && state.generation >= 4 && state.field.gravity) {
    return `${moveName} failed because Gravity was already active`;
  }
  return undefined;
}

const SELF_BOOSTS: Record<string, StatBoosts> = {
  acidarmor: {def: 2}, agility: {spe: 2}, amnesia: {spd: 2}, autotomize: {spe: 2}, barrier: {def: 2},
  bulkup: {atk: 1, def: 1}, calmmind: {spa: 1, spd: 1}, chargebeam: {spa: 1},
  charge: {spd: 1}, coil: {atk: 1, def: 1, acc: 1}, cosmicpower: {def: 1, spd: 1}, cottonguard: {def: 3},
  defensecurl: {def: 1}, doubleteam: {eva: 1},
  dragondance: {atk: 1, spe: 1}, growth: {atk: 1, spa: 1}, harden: {def: 1}, howl: {atk: 1},
  honeclaws: {atk: 1, acc: 1}, irondefense: {def: 2}, meditate: {atk: 1}, nastyplot: {spa: 2},
  minimize: {eva: 2},
  poweruppunch: {atk: 1}, quiverdance: {spa: 1, spd: 1, spe: 1}, rockpolish: {spe: 2},
  sharpen: {atk: 1}, shiftgear: {atk: 1, spe: 2}, swordsdance: {atk: 2}, tailglow: {spa: 3},
  withdraw: {def: 1}, workup: {atk: 1, spa: 1}, stockpile: {def: 1, spd: 1}, shelter: {def: 2},
  takeheart: {spa: 1, spd: 1}, defendorder: {def: 1, spd: 1},
  extremeevoboost: {atk: 2, def: 2, spa: 2, spd: 2, spe: 2},
};

const STAT_STAGE_MOVE_GENERATIONS: Record<string, number> = {
  charge: 3, sweetscent: 2, sweetspore: 2, scaryface: 2, cottonspore: 2,
  featherdance: 3, metalsound: 3, tickle: 3, captivate: 4, babydolleyes: 6,
  confide: 6, nobleroar: 6, playnice: 6, toxicthread: 7, tearfullook: 7, tarshot: 8,
  shelter: 9, takeheart: 9, spicyextract: 9, defendorder: 4, extremeevoboost: 7, aromaticmist: 6,
};

const TARGET_BOOSTS: Record<string, StatBoosts> = {
  babydolleyes: {atk: -1}, captivate: {spa: -2}, confide: {spa: -1}, cottonspore: {spe: -2},
  growl: {atk: -1}, leer: {def: -1},
  tailwhip: {def: -1}, charm: {atk: -2},
  scaryface: {spe: -2}, sandattack: {acc: -1}, smokescreen: {acc: -1}, flash: {acc: -1},
  kinesis: {acc: -1}, sweetscent: {eva: -2}, sweetspore: {eva: -2}, featherdance: {atk: -2}, metalsound: {spd: -2},
  stringshot: {spe: -2}, tickle: {atk: -1, def: -1}, tearfullook: {atk: -1, spa: -1},
  nobleroar: {atk: -1, spa: -1}, playnice: {atk: -1}, toxicthread: {spe: -1}, tarshot: {spe: -1},
  faketears: {spd: -2}, screech: {def: -2}, eerieimpulse: {spa: -2},
  snarl: {spa: -1}, strugglebug: {spa: -1}, skittersmack: {spa: -1},
  tropkick: {atk: -1}, lunge: {atk: -1}, breakingswipe: {atk: -1}, icywind: {spe: -1},
  electroweb: {spe: -1}, rocktomb: {spe: -1}, mudshot: {spe: -1}, lowsweep: {spe: -1},
  acidspray: {spd: -2},
  swagger: {atk: 2}, flatter: {spa: 1}, spicyextract: {atk: 2, def: -2}, aromaticmist: {spd: 1},
};

const STATUS_BY_MOVE: Record<string, StatusName> = {
  toxic: 'tox', poisonpowder: 'psn', poisongas: 'psn', toxicthread: 'psn', willowisp: 'brn', thunderwave: 'par', glare: 'par',
  nuzzle: 'par', stunspore: 'par', spore: 'slp', sleeppowder: 'slp', hypnosis: 'slp',
  sing: 'slp', lovelykiss: 'slp', darkvoid: 'slp', grasswhistle: 'slp',
};

const RECOVERY_MOVES = new Set([
  'healorder', 'milkdrink', 'moonlight', 'morningsun', 'recover', 'roost', 'shoreup',
  'slackoff', 'softboiled', 'synthesis',
]);
const HEAL_BLOCKED_MOVES = new Set([
  'floralhealing', 'healorder', 'healingwish', 'healpulse', 'junglehealing', 'lifedew',
  'lunardance', 'milkdrink', 'moonlight', 'morningsun', 'purify', 'recover', 'rest',
  'roost', 'shoreup', 'slackoff', 'softboiled', 'strengthsap', 'swallow', 'synthesis', 'wish',
]);

const DELAYED_DAMAGE_MOVES = new Set(['futuresight', 'doomdesire']);
const RAMPAGE_MOVES = new Set(['outrage', 'thrash', 'petaldance', 'ragingfury']);
const SHELL_TRAP_MIN_GENERATION = 7;
const PROTECTIVE_MOVES = new Set([
  'protect', 'detect', 'kingsshield', 'wideguard', 'quickguard', 'matblock',
  'banefulbunker', 'spikyshield', 'silktrap', 'obstruct', 'burningbulwark',
  'maxguard',
]);
const CONSECUTIVE_PROTECTIVE_MOVES = new Set(Array.from(PROTECTIVE_MOVES).concat('endure'));
// Moves that thaw their own user before executing (Gen 8).
const DEFROST_MOVES = new Set([
  'flamewheel', 'sacredfire', 'flareblitz', 'scald', 'steameruption',
  'burnup', 'pyroball', 'fusionflare', 'scorchingsands', 'matchagotcha',
]);
const FIRST_TURN_MOVE_MIN_GENERATION: Record<string, number> = {
  fakeout: 3,
  firstimpression: 7,
};

function isFirstTurnMoveAvailable(state: BattleState, actor: PokemonState, moveIdValue: string): boolean {
  const minimumGeneration = FIRST_TURN_MOVE_MIN_GENERATION[moveIdValue];
  return minimumGeneration === undefined ||
    (state.generation >= minimumGeneration &&
      (state.firstTurnOutIds === undefined || state.firstTurnOutIds.includes(actor.id)));
}

function recoveryFraction(state: BattleState, moveId: string): [number, number] {
  const weatherRecovery = new Set(['moonlight', 'morningsun', 'synthesis']).has(moveId);
  const sandRecovery = moveId === 'shoreup';
  if ((weatherRecovery && isSunWeather(state.field.weather)) ||
    (sandRecovery && state.field.weather === 'Sand')) return [2, 3];
  if ((weatherRecovery || sandRecovery) && state.field.weather) return [1, 4];
  return [1, 2];
}

function currentAttackStat(state: BattleState, pokemon: BattleState['sides'][SideId]['party'][number]): number {
  const gen = Calc.Generations.get(state.generation);
  const overrides = getCalcSpeciesOverrides(gen, pokemon);
  return new Calc.Pokemon(gen, getEffectiveSpecies(pokemon), {
    level: pokemon.level,
    ability: getCalculatorAbility(state, pokemon),
    abilityOn: isAbilityActive(pokemon, state) ? pokemon.abilityOn : false,
    item: isItemEffectActive(state, pokemon) ? pokemon.item : undefined,
    nature: pokemon.nature,
    ivs: pokemon.ivs,
    evs: RUN_AND_BUN_EVS,
    boosts: pokemon.boosts ? {
      atk: pokemon.boosts.atk,
      def: pokemon.boosts.def,
      spa: pokemon.boosts.spa,
      spd: pokemon.boosts.spd,
      spe: pokemon.boosts.spe,
    } : undefined,
    statOverrides: pokemon.statOverrides,
    overrides,
  }).stats.atk;
}

const RECOIL: Record<string, [number, number]> = {
  bravebird: [33, 100], doubleedge: [33, 100], flareblitz: [33, 100], headsmash: [1, 2],
  submission: [1, 4], takedown: [1, 4], volttackle: [1, 3], wildcharge: [1, 4],
  woodhammer: [1, 3], struggle: [1, 4],
};

const DRAIN: Record<string, [number, number]> = {
  absorb: [1, 2], drainpunch: [1, 2], dreameater: [1, 2], gigadrain: [1, 2],
  hornleech: [1, 2], leechlife: [1, 2], megadrain: [1, 2], oblivionwing: [3, 4],
  drainingkiss: [3, 4],
};

function getMoveHpEffects(generation: BattleState['generation'], moveName: string) {
  const id = moveId(moveName);
  let canonical: Calc.Move | undefined;
  try {
    canonical = new Calc.Move(generation, moveName);
  } catch {
    // Custom move metadata can be supplied by the caller even when the
    // calculator has no matching canonical move entry.
  }

  return {
    recoil: canonical?.recoil || (canonical?.struggleRecoil ? [1, 4] : RECOIL[id]),
    fixedRecoil: canonical?.mindBlownRecoil ? [1, 2] : undefined,
    crashDamage: canonical?.hasCrashDamage || false,
    drain: canonical?.drain || DRAIN[id],
  };
}

const SELF_STAT_CHANGES: Record<string, StatBoosts> = {
  closecombat: {def: -1, spd: -1}, dracometeor: {spa: -2}, fleurcannon: {spa: -2},
  hammerarm: {spe: -1}, leafstorm: {spa: -2}, makeitrain: {spa: -1}, overheat: {spa: -2},
  psychoboost: {spa: -2}, spinout: {spe: -2}, superpower: {atk: -1, def: -1},
  vcreate: {def: -1, spd: -1, spe: -1}, hyperspacefury: {def: -1},
  armorcannon: {def: -1, spd: -1},
  dragonascent: {def: -1, spd: -1}, headlongrush: {def: -1, spd: -1}, icehammer: {spe: -1},
  scaleshot: {def: -1, spe: 1},
};

const STAGE_IDS = ['atk', 'def', 'spa', 'spd', 'spe', 'acc', 'eva'] as const;

const SECONDARY_BOOST_MOVES = new Set([
  'chargebeam', 'poweruppunch', 'growl', 'leer', 'tailwhip', 'charm', 'faketears',
  'screech', 'eerieimpulse', 'snarl', 'strugglebug', 'skittersmack', 'tropkick',
  'lunge', 'breakingswipe', 'icywind', 'electroweb', 'rocktomb', 'mudshot', 'lowsweep',
  'acidspray',
]);

const PROTECT_BYPASS_MOVES = new Set([
  'feint', 'hyperspacefury', 'hyperspacehole', 'mightycleave', 'phantomforce',
  'shadowforce',
]);

const INSTRUCT_BLOCKED_MOVES = new Set([
  'assist', 'beakblast', 'bide', 'bounce', 'counter', 'copycat', 'dig', 'dive', 'fly',
  'focuspunch', 'metronome', 'mimic', 'mirrormove', 'naturepower', 'phantomforce',
  'shelltrap', 'shadowforce', 'sketch', 'skydrop', 'sleeptalk', 'struggle', 'transform',
  'metalburst', 'mirrorcoat',
]);

const ABILITY_CHANGE_IMMUNITIES = new Set([
  'asoneglastrier', 'asonespectrier', 'battlebond', 'comatose', 'commander', 'disguise',
  'gulpmissile', 'iceface', 'lingeringaroma', 'mummy', 'multitype', 'powerconstruct',
  'rkssystem', 'rksystem', 'schooling', 'shieldsdown', 'stancechange', 'terashift', 'zenmode',
  'zerotohero',
]);

function canChangeAbility(ability: string | undefined): boolean {
  return !!ability && !ABILITY_CHANGE_IMMUNITIES.has(moveId(ability));
}

function moveId(name: string | undefined): string {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isTruantActive(state: BattleState, pokemon: PokemonState): boolean {
  return state.generation >= 3 && isAbilityActive(pokemon, state) &&
    isAbilityAvailable(state.generation, getEffectiveAbility(pokemon)) &&
    moveId(getEffectiveAbility(pokemon)) === 'truant';
}

function activePokemonForSide(state: BattleState, sideId: SideId): PokemonState[] {
  return state.sides[sideId].activeIds
    .map(id => getPokemon(state, id))
    .filter((pokemon): pokemon is PokemonState => !!pokemon && pokemon.hp.current > 0);
}

function snatchUsers(state: BattleState, actorId: string): PokemonState[] {
  return (['ai', 'player'] as SideId[]).flatMap(sideId => activePokemonForSide(state, sideId))
    .filter(pokemon => pokemon.id !== actorId && !!pokemon.volatile?.snatch);
}

function snatchUser(state: BattleState, actorId: string): PokemonState | undefined {
  const users = snatchUsers(state, actorId);
  if (!users.length) return undefined;
  return [...users].sort((left, right) => {
    const speedDifference = getEffectivePokemonSpeed(state, left.id) - getEffectivePokemonSpeed(state, right.id);
    // In Generations III-IV the stolen move chains through every Snatch user,
    // so the slowest user receives the final effect. Later generations use
    // the first Snatch in execution order, which is the fastest at +4.
    return state.generation <= 4 ? speedDifference : -speedDifference;
  })[0];
}

function snatchEffectTargets(
  state: BattleState,
  snatcher: PokemonState,
  target: MoveTarget | undefined,
  moveIdValue: string,
  sourceId: string,
): string[] {
  // In the legacy generations Psych Up follows the Pokémon whose move was
  // stolen, while Acupressure is always applied to the Snatch user.
  if (moveIdValue === 'psychup') return [sourceId];
  if (target === 'self' || !target) return [snatcher.id];
  if (target === 'allyTeam') return state.sides[sideForPokemon(state, snatcher.id)].party.map(pokemon => pokemon.id);
  if (target === 'allies') {
    return activePokemonForSide(state, sideForPokemon(state, snatcher.id))
      .filter(pokemon => pokemon.id !== snatcher.id)
      .map(pokemon => pokemon.id);
  }
  // Ally-side effects are represented by sideEffectsBySide and therefore do
  // not need Pokémon target IDs. Any remaining supported target shape is a
  // single Snatch recipient.
  return [snatcher.id];
}

function otherSide(sideId: SideId): SideId {
  return sideId === 'ai' ? 'player' : 'ai';
}

function hasActiveAlly(state: BattleState, pokemon: PokemonState): boolean {
  const sideId = sideForPokemon(state, pokemon.id);
  return state.mode === 'Doubles' && state.sides[sideId].activeIds.some(id =>
    id !== pokemon.id && (getPokemon(state, id)?.hp.current || 0) > 0);
}

function hasFlowerVeilProtection(state: BattleState, pokemon: PokemonState): boolean {
  if (state.generation < 6 || state.mode !== 'Doubles' ||
    !getEffectiveTypes(state, pokemon.id).some(type => moveId(type) === 'grass')) return false;
  return activePokemonForSide(state, sideForPokemon(state, pokemon.id))
    .some(ally => ally.id !== pokemon.id && hasAbility(state, ally, 'flowerveil'));
}

function addHpDelta(resolution: MoveResolution, pokemonId: string, delta: number) {
  if (!Number.isFinite(delta) || delta === 0) return;
  resolution.hpDeltaByPokemon = {...(resolution.hpDeltaByPokemon || {})};
  resolution.hpDeltaByPokemon[pokemonId] = (resolution.hpDeltaByPokemon[pokemonId] || 0) + delta;
}

function setItem(resolution: MoveResolution, pokemonId: string, item: string | null) {
  resolution.itemByPokemon = {
    ...(resolution.itemByPokemon || {}),
    [pokemonId]: item,
  };
}

function setItemCorroded(resolution: MoveResolution, pokemonId: string, corroded: boolean | null) {
  resolution.itemCorrodedByPokemon = {
    ...(resolution.itemCorrodedByPokemon || {}),
    [pokemonId]: corroded,
  };
}

const TERRAIN_SEEDS: Record<string, {terrain: Terrain; stat: keyof StatBoosts}> = {
  electricseed: {terrain: 'Electric', stat: 'def'},
  grassyseed: {terrain: 'Grassy', stat: 'def'},
  mistyseed: {terrain: 'Misty', stat: 'spd'},
  psychicseed: {terrain: 'Psychic', stat: 'spd'},
};

const RESIST_BERRY_TYPES: Record<string, string> = {
  occaberry: 'fire',
  passhoberry: 'water',
  wacanberry: 'electric',
  rindoberry: 'grass',
  yacheberry: 'ice',
  chopleberry: 'fighting',
  kebiaberry: 'poison',
  shucaberry: 'ground',
  cobaberry: 'flying',
  payapaberry: 'psychic',
  tangaberry: 'bug',
  chartiberry: 'rock',
  kasibberry: 'ghost',
  habanberry: 'dragon',
  colburberry: 'dark',
  babiriberry: 'steel',
  roseliberry: 'fairy',
  chilanberry: 'normal',
};

const REACTIVE_STAT_BERRIES: Record<string, {category: MoveCategory; stat: keyof StatBoosts}> = {
  keeberry: {category: 'Physical', stat: 'def'},
  marangaberry: {category: 'Special', stat: 'spd'},
};

const REACTIVE_DAMAGE_BERRIES: Record<string, MoveCategory> = {
  jabocaberry: 'Physical',
  rowapberry: 'Special',
};

function activateTerrainSeeds(resolution: MoveResolution, state: BattleState, terrain: Terrain) {
  if (state.generation < 7) return;
  for (const sideId of ['ai', 'player'] as const) {
    for (const pokemonId of state.sides[sideId].activeIds) {
      const pokemon = getPokemon(state, pokemonId);
      if (!pokemon || pokemon.hp.current <= 0 || !heldItemEffectsActive(state, pokemon)) continue;
      const seed = TERRAIN_SEEDS[moveId(pokemon.item)];
      if (!seed || seed.terrain !== terrain) continue;
      addBoosts(resolution, state, pokemon.id, {[seed.stat]: 1});
      consumeItem(resolution, pokemon.id, pokemon.item!);
      resolution.trace!.notes!.push(`${pokemon.item} activated for ${pokemon.id} in ${terrain} Terrain`);
    }
  }
}

function setSaltCure(resolution: MoveResolution, pokemonId: string, active: boolean | null) {
  resolution.isSaltCureByPokemon = {
    ...(resolution.isSaltCureByPokemon || {}),
    [pokemonId]: active,
  };
}

function setTypeOverride(resolution: MoveResolution, pokemonId: string, types: string[] | null) {
  resolution.typeOverrideByPokemon = {
    ...(resolution.typeOverrideByPokemon || {}),
    [pokemonId]: types,
  };
}

function setTypeChangeUsed(resolution: MoveResolution, pokemonId: string, used: boolean | null) {
  resolution.typeChangeUsedByPokemon = {
    ...(resolution.typeChangeUsedByPokemon || {}),
    [pokemonId]: used,
  };
}

function applyMimicry(
  resolution: MoveResolution,
  state: BattleState,
  terrain: Terrain | undefined,
) {
  const override = mimicryTypeOverride(terrain);
  let changed = false;
  for (const sideId of ['ai', 'player'] as SideId[]) {
    for (const pokemonId of state.sides[sideId].activeIds) {
      const pokemon = getPokemon(state, pokemonId);
      if (!pokemon || pokemon.hp.current <= 0 || !isMimicryActive(state, pokemon)) continue;
      setTypeOverride(resolution, pokemon.id, override);
      changed = true;
    }
  }
  if (changed) resolution.trace!.notes!.push(`Mimicry changed active types for ${terrain || 'base species types'}`);
}

function applyForecast(
  resolution: MoveResolution,
  state: BattleState,
  weather: Weather | undefined,
) {
  if (state.field.weather === weather) return;
  const nextState = {...state, field: {...state.field, weather}};
  for (const sideId of ['ai', 'player'] as SideId[]) {
    for (const pokemonId of state.sides[sideId].activeIds) {
      const pokemon = getPokemon(state, pokemonId);
      if (!pokemon || pokemon.hp.current <= 0) continue;
      const override = weatherFormSpeciesOverride(nextState, pokemon, weather);
      if (override === undefined) continue;
      setSpeciesOverride(resolution, pokemon.id, override);
      resolution.trace!.notes!.push(`Forecast changed ${pokemon.id}'s form`);
    }
  }
}

function setAbilityOverride(resolution: MoveResolution, pokemonId: string, ability: string | null) {
  resolution.abilityOverrideByPokemon = {
    ...(resolution.abilityOverrideByPokemon || {}),
    [pokemonId]: ability,
  };
}

function setNoAbility(resolution: MoveResolution, pokemonId: string) {
  resolution.noAbilityByPokemon = {
    ...(resolution.noAbilityByPokemon || {}),
    [pokemonId]: true,
  };
}

function setAbilitySuppressed(resolution: MoveResolution, pokemonId: string, suppressed: boolean | null) {
  resolution.abilitySuppressedByPokemon = {
    ...(resolution.abilitySuppressedByPokemon || {}),
    [pokemonId]: suppressed,
  };
}

function setSpeciesOverride(resolution: MoveResolution, pokemonId: string, species: string | null) {
  resolution.speciesOverrideByPokemon = {
    ...(resolution.speciesOverrideByPokemon || {}),
    [pokemonId]: species,
  };
}

function stanceChangeSpecies(
  state: BattleState,
  actor: PokemonState,
  moveName: string,
  moveCategory: MoveCategory | undefined,
): string | undefined {
  if (state.generation < 6 ||
    (actor.speciesOverride && !['aegislashblade', 'aegislashshield', 'aegislashboth']
      .includes(moveId(actor.speciesOverride))) || !isAbilityActive(actor, state) ||
    !isAbilityAvailable(state.generation, getEffectiveAbility(actor)) ||
    moveId(getEffectiveAbility(actor) || '') !== 'stancechange') return undefined;
  const species = moveId(getEffectiveSpecies(actor));
  if (!['aegislashblade', 'aegislashshield', 'aegislashboth'].includes(species)) return undefined;
  if (moveCategory === 'Status' && moveId(moveName) !== 'kingsshield') return undefined;
  return moveId(moveName) === 'kingsshield' ? 'Aegislash-Shield' : 'Aegislash-Blade';
}

function setStatOverrides(
  resolution: MoveResolution,
  pokemonId: string,
  stats: Partial<Record<'hp' | 'atk' | 'def' | 'spa' | 'spd' | 'spe', number>> | null,
) {
  resolution.statOverridesByPokemon = {
    ...(resolution.statOverridesByPokemon || {}),
    [pokemonId]: stats,
  };
}

function setMoves(resolution: MoveResolution, pokemonId: string, moves: PokemonState['moves'] | null) {
  resolution.movesByPokemon = {
    ...(resolution.movesByPokemon || {}),
    [pokemonId]: moves,
  };
}

function setCopyMove(resolution: MoveResolution, pokemonId: string, moveName: string | null) {
  resolution.copyMoveByPokemon = {
    ...(resolution.copyMoveByPokemon || {}),
    [pokemonId]: moveName,
  };
}

function setCalledMove(resolution: MoveResolution, pokemonId: string, moveName: string | null) {
  resolution.calledMoveByPokemon = {
    ...(resolution.calledMoveByPokemon || {}),
    [pokemonId]: moveName,
  };
}

function setCalledMoveModifiers(
  resolution: MoveResolution,
  pokemonId: string,
  modifiers: {powerMultiplier?: number; bypassAccuracy?: boolean},
) {
  resolution.calledMoveModifiersByPokemon = {
    ...(resolution.calledMoveModifiersByPokemon || {}),
    [pokemonId]: modifiers,
  };
}

function setCalledMoveTargets(resolution: MoveResolution, pokemonId: string, targetIds: string[]) {
  resolution.calledMoveTargetIdsByPokemon = {
    ...(resolution.calledMoveTargetIdsByPokemon || {}),
    [pokemonId]: [...targetIds],
  };
}

function setCalledMoveExternal(resolution: MoveResolution, pokemonId: string) {
  resolution.calledMoveExternalByPokemon = {
    ...(resolution.calledMoveExternalByPokemon || {}),
    [pokemonId]: true,
  };
}

function getNaturePowerMove(state: BattleState): string {
  if (state.generation <= 3) return 'Swift';
  if (state.generation <= 5) return 'Tri Attack';
  const terrainMoves: Partial<Record<Terrain, string>> = {
    Electric: 'Thunderbolt',
    Grassy: 'Energy Ball',
    Misty: 'Moonblast',
    Psychic: 'Psychic',
  };
  const terrain = state.field.terrain;
  return (terrain && terrainMoves[terrain]) || 'Tri Attack';
}

function setForcedSwitch(resolution: MoveResolution, pokemonId: string, forced = true) {
  resolution.forcedSwitchByPokemon = {
    ...(resolution.forcedSwitchByPokemon || {}),
    [pokemonId]: forced,
  };
}

export function canRequestMoveSwitch(state: BattleState, actor: PokemonState): boolean {
  const sourceIsActive = (sourceId: string | undefined) =>
    !sourceId || (getPokemon(state, sourceId)?.hp.current || 0) > 0;
  if (actor.hp.current <= 0 || actor.volatile?.ingrain || actor.volatile?.commanding ||
    actor.volatile?.commanded || state.field.fairyLock) return false;
  if (!canEscapeTrappingEffect(state, actor, 'trapped') && actor.volatile?.trapped && sourceIsActive(actor.volatile.trapped.sourceId)) return false;
  if (!canEscapeTrappingEffect(state, actor, 'partiallyTrapped') && actor.volatile?.partiallyTrapped && sourceIsActive(actor.volatile.partiallyTrapped.sourceId)) return false;
  if (!canEscapeTrappingEffect(state, actor, 'octolock') && actor.volatile?.octolock && sourceIsActive(actor.volatile.octolock.sourceId)) return false;
  if (isSwitchBlockedByAbility(state, actor.id)) return false;
  const sideId = sideForPokemon(state, actor.id);
  return state.sides[sideId].party.some(pokemon =>
    pokemon.id !== actor.id && pokemon.hp.current > 0 && !state.sides[sideId].activeIds.includes(pokemon.id));
}

function requestMoveSwitch(
  state: BattleState,
  actor: PokemonState,
  resolution: MoveResolution,
  passMode?: 'batonPass' | 'substitute',
): boolean {
  if (!canRequestMoveSwitch(state, actor)) return false;
  setForcedSwitch(resolution, actor.id);
  if (passMode === 'batonPass') {
    resolution.batonPassByPokemon = {
      ...(resolution.batonPassByPokemon || {}),
      [actor.id]: true,
    };
  }
  if (passMode === 'substitute') {
    resolution.substitutePassByPokemon = {
      ...(resolution.substitutePassByPokemon || {}),
      [actor.id]: true,
    };
  }
  return true;
}

function canBeForcedOut(
  state: BattleState,
  pokemonId: string,
  sourceId?: string,
  moveCategory: MoveCategory = 'Status',
): boolean {
  const target = getPokemon(state, pokemonId);
  if (!target || target.hp.current <= 0) return false;
  if (target.volatile?.commanding || target.volatile?.commanded) return false;
  if (state.generation >= 3 && isAbilityActive(target, state) &&
    moveId(getEffectiveAbility(target)) === 'suctioncups' &&
    (!sourceId || !ignoresTargetAbility(state, sourceId, pokemonId, moveCategory))) return false;
  if (state.generation >= 4 && target.volatile?.ingrain) return false;
  return true;
}

function consumeItem(
  resolution: MoveResolution,
  pokemonId: string,
  item: string,
  consumerId = pokemonId,
  recyclable = true,
) {
  setItem(resolution, pokemonId, null);
  resolution.consumedItemByPokemon = {
    ...(resolution.consumedItemByPokemon || {}),
    [consumerId]: recyclable ? item : null,
  };
}

function hasAbility(state: BattleState, pokemon: PokemonState, ability: string): boolean {
  return isAbilityActive(pokemon, state) && isAbilityAvailable(state.generation, ability) &&
    moveId(getEffectiveAbility(pokemon)) === ability;
}

function isBerryUseSuppressedByUnnerve(
  state: BattleState,
  actorId: string,
  targetId: string,
): boolean {
  if (state.generation < 5 || sideForPokemon(state, actorId) === sideForPokemon(state, targetId)) return false;
  const actorSide = sideForPokemon(state, actorId);
  return state.sides[actorSide].activeIds.some(activeId => {
    const holder = getPokemon(state, activeId);
    return !!holder && holder.hp.current > 0 && hasAbility(state, holder, 'unnerve');
  });
}

function hasMagicGuard(state: BattleState, pokemon: PokemonState): boolean {
  return state.generation >= 4 && hasAbility(state, pokemon, 'magicguard');
}

function isIceFaceActive(state: BattleState, pokemon: PokemonState): boolean {
  return state.generation >= 8 && hasAbility(state, pokemon, 'iceface') &&
    moveId(getEffectiveSpecies(pokemon)) === 'eiscue';
}

function applyCheekPouch(
  resolution: MoveResolution,
  state: BattleState,
  consumer: PokemonState,
  item: string,
) {
  if (state.generation >= 6 && moveId(item).endsWith('berry') &&
    !consumer.volatile?.healBlock && hasAbility(state, consumer, 'cheekpouch')) {
    addHpDelta(resolution, consumer.id, Math.floor(consumer.hp.max / 3));
  }
}

function isBerry(item: string | undefined): boolean {
  return moveId(item).endsWith('berry');
}

function armCudChew(
  resolution: MoveResolution,
  state: BattleState,
  pokemon: PokemonState,
  item: string,
) {
  if (state.generation < 9 || !isBerry(item) || !hasAbility(state, pokemon, 'cudchew')) return;
  addVolatile(resolution, [pokemon.id], 'cudChew', {turns: 2, item});
  resolution.trace!.notes!.push(`Cud Chew stored ${item} for ${pokemon.id}`);
}

function canUseFling(state: BattleState, actor: PokemonState): boolean {
  if (!actor.item || !isItemEffectActive(state, actor)) return false;
  if (state.generation >= 5 && hasAbility(state, actor, 'klutz')) return false;
  return true;
}

function canUseNaturalGift(state: BattleState, actor: PokemonState): boolean {
  return state.generation >= 4 && state.generation <= 7 && isBerry(actor.item) &&
    isItemEffectActive(state, actor);
}

function resolvedItem(
  state: BattleState,
  resolution: MoveResolution,
  pokemon: PokemonState,
): string | undefined {
  if (resolution.itemByPokemon && Object.prototype.hasOwnProperty.call(resolution.itemByPokemon, pokemon.id)) {
    const item = resolution.itemByPokemon[pokemon.id];
    return item === null ? undefined : item;
  }
  return pokemon.item;
}

function moveMakesContact(
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

function moveBreaksProtection(state: BattleState, moveName: string): boolean {
  try {
    return new Calc.Move(Calc.Generations.get(state.generation), moveName).breaksProtect;
  } catch {
    return false;
  }
}

function addHealing(
  resolution: MoveResolution,
  state: BattleState,
  pokemonId: string,
  numerator: number,
  denominator: number,
) {
  const pokemon = getPokemon(state, pokemonId);
  if (!pokemon || pokemon.hp.current >= pokemon.hp.max || pokemon.volatile?.healBlock) return;
  addHpDelta(resolution, pokemonId, Math.floor(pokemon.hp.max * numerator / denominator));
}

function clearMajorStatus(resolution: MoveResolution, state: BattleState, pokemonIds: string[]) {
  const statusByPokemon = {...(resolution.statusByPokemon || {})};
  const statusTurnsByPokemon = {...(resolution.statusTurnsByPokemon || {})};
  const toxicCounterByPokemon = {...(resolution.toxicCounterByPokemon || {})};
  let changed = false;
  for (const pokemonId of pokemonIds) {
    const pokemon = getPokemon(state, pokemonId);
    if (!pokemon || (!pokemon.status && !pokemon.toxicCounter && pokemon.statusTurns === undefined)) continue;
    statusByPokemon[pokemonId] = '';
    statusTurnsByPokemon[pokemonId] = null;
    toxicCounterByPokemon[pokemonId] = 0;
    changed = true;
  }
  if (changed) {
    resolution.statusByPokemon = statusByPokemon;
    resolution.statusTurnsByPokemon = statusTurnsByPokemon;
    resolution.toxicCounterByPokemon = toxicCounterByPokemon;
  }
}

function setStatusTurns(resolution: MoveResolution, pokemonId: string, turns: number | null) {
  resolution.statusTurnsByPokemon = {
    ...(resolution.statusTurnsByPokemon || {}),
    [pokemonId]: turns,
  };
}

function sampleActionRoll(random: () => number, label: string): number {
  const roll = random();
  if (!Number.isFinite(roll)) throw new Error(`${label} sampler must return a finite number`);
  return Math.max(0, Math.min(0.999999999999, roll));
}

function actionFailure(
  state: BattleState,
  actor: BattleState['sides'][SideId]['party'][number],
  actionMoveId: string,
  random: () => number,
): {failure?: ActionFailure; clearStatus?: boolean; sleepTurns?: number; wake?: boolean} {
  if (actor.volatile?.flinch) return {failure: 'flinch'};
  if (actor.status === 'slp') {
    // Gen 8 sleep: the counter burns on each ACTION ATTEMPT — a 2-4 counter
    // is always 1-3 missed turns, whoever moved first. The old boundary
    // decrement handed a faster sleeper's target one extra missed turn.
    const earlyBird = state.generation >= 3 && isAbilityActive(actor, state) &&
      moveId(getEffectiveAbility(actor)) === 'earlybird';
    const remaining = Math.max(0, (actor.statusTurns ?? 0) - (earlyBird ? 2 : 1));
    if (remaining > 0) {
      return ['sleeptalk', 'snore'].includes(actionMoveId) ?
        {sleepTurns: remaining} : {failure: 'sleep', sleepTurns: remaining};
    }
    return {wake: true};
  }
  if (actor.status === 'frz') {
    // Defrost-flag moves always thaw the user and execute — no roll. Sacking
    // a "frozen solid" mon that could Scald its way out every time is the
    // kind of misread that ends a nuzlocke.
    if (DEFROST_MOVES.has(actionMoveId)) return {clearStatus: true};
    if (sampleActionRoll(random, 'Freeze') >= 0.2) return {failure: 'freeze'};
    return {clearStatus: true};
  }
  // Confusion is checked BEFORE paralysis: Showdown's onBeforeMovePriority
  // and the pokeemerald lineage agree. With paralysis first, a mon that was
  // both paralyzed and confused self-hit 25% of the time and was fully
  // paralyzed 25%; the truth is 33% / 16.7%, and self-hit damage is real
  // chip the misallocation moved.
  //
  // Gen 8 confusion: 33% chance to hit yourself (the cartridge is 33/100,
  // which is also what the sibling predictor uses). Run & Bun's own doc
  // lists no confusion change and mandates Gen 8 defaults for anything
  // unlisted. The old `>= 1/3` (a 2/3 self-hit, wrong in EVERY generation)
  // was copy-patterned from the Protect streak check below, where 2/3
  // failure is genuinely correct.
  if (actor.volatile?.confusion && sampleActionRoll(random, 'Confusion') < 0.33) {
    return {failure: 'confusion'};
  }
  if (actor.status === 'par' && sampleActionRoll(random, 'Paralysis') < 0.25) {
    return {failure: 'paralysis'};
  }
  if (actor.volatile?.infatuated && sampleActionRoll(random, 'Infatuation') < 0.5) {
    return {failure: 'infatuation'};
  }
  if (CONSECUTIVE_PROTECTIVE_MOVES.has(actionMoveId) &&
    !['wideguard', 'quickguard'].includes(actionMoveId) &&
    CONSECUTIVE_PROTECTIVE_MOVES.has(moveId(state.moveStreakByPokemon?.[actor.id]?.moveName))) {
    // Gen 8 stall: success is (1/3)^n with a 1/729 floor, not a flat 1/3
    // forever. Wide/Quick Guard carry no stalling flag — they never take
    // this roll, though their use keeps feeding the streak for what
    // follows. Known simplification: the streak counter keys by exact
    // move, so alternating Protect/Detect resets it where the cartridge
    // stall counter would persist — strictly player-favorable, and rare.
    const streak = state.moveStreakByPokemon?.[actor.id]?.count ?? 1;
    const successChance = Math.max(1 / 729, Math.pow(1 / 3, streak));
    if (sampleActionRoll(random, 'Protect') >= successChance) return {failure: 'protect'};
  }
  return {};
}

function addSubstituteHp(resolution: MoveResolution, pokemonId: string, hp: number) {
  resolution.substituteHpByPokemon = {
    ...(resolution.substituteHpByPokemon || {}),
    [pokemonId]: hp,
  };
}

function hasSubstitute(state: BattleState, pokemonId: string): boolean {
  return (getPokemon(state, pokemonId)?.substituteHp || 0) > 0;
}

function itemMoveFailure(
  state: BattleState,
  actor: PokemonState,
  target: PokemonState | undefined,
  id: string,
): string | undefined {
  if (id === 'trick' || id === 'switcheroo') {
    if (!target) return `${id} requires a target`;
    if (!actor.item && !target.item) return `${id} failed because neither Pokémon is holding an item`;
    if (hasSubstitute(state, target.id)) return `${id} failed because the target is behind a Substitute`;
    if (!canRemoveHeldItem(state, target) && target.item) {
      return `${id} failed because Sticky Hold protected the target item`;
    }
  }
  if (id === 'bestow') {
    if (!target || !actor.item || target.item) return 'Bestow failed because the item transfer was not possible';
  }
  if (id === 'thief' || id === 'covet') {
    if (!target || actor.item || !target.item || !canRemoveHeldItem(state, target)) {
      return `${id} failed because the target item could not be stolen`;
    }
  }
  if (PURE_ITEM_TRANSFER_MOVE_IDS.has(id) && !hasPureItemTransferEffect(state, actor, target, id)) {
    return `${actionNameForId(id)} failed because the held-item transfer was not possible`;
  }
  if (id === 'recycle' && (state.generation < 3 || actor.item || !actor.lastConsumedItem)) {
    return 'Recycle failed because no consumed item can be restored';
  }
  if (id === 'belch' && (state.generation < 6 || !isBerry(actor.lastConsumedItem))) {
    return 'Belch failed because the actor has not consumed a Berry';
  }
  if (id === 'stuffcheeks' && (state.generation < 8 || !isBerry(actor.item) ||
    actor.itemCorroded || actor.volatile?.embargo)) {
    return 'Stuff Cheeks failed because the actor has no usable held Berry';
  }
  if (id === 'lastresort' && (actor.moves.length <= 1 || actor.moves.some(move =>
    moveId(move.name) !== 'lastresort' && (move.timesUsed || 0) < 1))) {
    return 'Last Resort failed because not all other moves have been used';
  }
  return undefined;
}

function selfMoveFailure(
  state: BattleState,
  actor: PokemonState,
  id: string,
): string | undefined {
  const stockpileCount = actor.volatile?.stockpile?.stacks || 0;
  if (id === 'stockpile' && stockpileCount >= 3) return 'Stockpile failed because its stack limit was reached';
  if ((id === 'swallow' || id === 'spitup') && stockpileCount === 0) {
    return `${id === 'swallow' ? 'Swallow' : 'Spit Up'} failed because no Stockpile energy was available`;
  }
  if (id === 'swallow' && actor.hp.current >= actor.hp.max) return 'Swallow failed because the actor was at full HP';
  if (id === 'rest' && actor.hp.current >= actor.hp.max) return 'Rest failed because the actor was at full HP';
  if (id === 'rest' && !canApplyMajorStatus(state, actor.id, actor.id, 'slp', undefined, false, true)) {
    return 'Rest failed because sleep was blocked';
  }
  if (id === 'bellydrum' && actor.hp.current <= Math.floor(actor.hp.max / 2)) {
    return 'Belly Drum failed because the actor lacked more than half HP';
  }
  if (id === 'clangoroussoul' && state.generation >= 8 && actor.hp.current <= Math.floor(actor.hp.max / 3)) {
    return 'Clangorous Soul failed because the actor lacked more than one-third HP';
  }
  if (id === 'filletaway' && state.generation >= 9 && actor.hp.current <= Math.floor(actor.hp.max / 2)) {
    return 'Fillet Away failed because the actor lacked more than half HP';
  }
  if (id === 'substitute' && (actor.substituteHp || 0) > 0) return 'Substitute failed because one was already active';
  if (id === 'substitute' && actor.hp.current <= Math.floor(actor.hp.max / 4)) {
    return 'Substitute failed because the actor lacked enough HP';
  }
  if (id === 'noretreat' && actor.volatile?.trapped) return 'No Retreat failed because the actor was already trapped';
  if (id === 'aquaring' && actor.volatile?.aquaRing) return 'Aqua Ring failed because it was already active';
  if (id === 'ingrain' && actor.volatile?.ingrain) return 'Ingrain failed because it was already active';
  if (id === 'magnetrise' && actor.volatile?.magnetRise) return 'Magnet Rise failed because it was already active';
  if (id === 'psychoshift' && !actor.status) return 'Psycho Shift failed because the actor had no major status';
  if (id === 'magiccoat' && state.generation >= 4 && state.generation < 8 && actor.volatile?.magicCoat) {
    return 'Magic Coat failed because it was already active';
  }
  if (id === 'snatch' && state.generation >= 3 && state.generation < 8 && actor.volatile?.snatch) {
    return 'Snatch failed because it was already active';
  }
  if (id === 'grudge' && state.generation >= 3 && actor.volatile?.grudge) {
    return 'Grudge failed because it was already active';
  }
  if (id === 'grudge' && state.generation < 3) return 'Grudge failed because it is unavailable in this generation';
  if (id === 'gigatonhammer' && moveId(state.lastMoveUsedByPokemon?.[actor.id]) === id) {
    return 'Gigaton Hammer failed because it cannot be used twice in a row';
  }
  if (id === 'burnup' && !getEffectiveTypes(state, actor.id).some(type => moveId(type) === 'fire')) {
    return 'Burn Up failed because the actor was not Fire-type';
  }
  if (id === 'doubleshock' && !getEffectiveTypes(state, actor.id).some(type => moveId(type) === 'electric')) {
    return 'Double Shock failed because the actor was not Electric-type';
  }
  if (id === 'geomancy' && moveId(actor.volatile?.charge?.moveName) === id) return undefined;
  if (id === 'takeheart' && !actor.status && !hasSelfStageEffect(actor.boosts, id)) {
    return 'Take Heart failed because it would have no effect';
  }
  if (id !== 'takeheart' && !hasSelfStageEffect(actor.boosts, id)) {
    return `${actionNameForId(id)} failed because its affected stages were already maxed`;
  }
  if (new Set([
    'healorder', 'milkdrink', 'moonlight', 'morningsun', 'recover', 'rest', 'roost',
    'shoreup', 'slackoff', 'softboiled', 'synthesis',
  ]).has(id) && actor.hp.current >= actor.hp.max) {
    return `${actionNameForId(id)} failed because the actor was at full HP`;
  }
  return undefined;
}

function actionNameForId(id: string): string {
  return id.replace(/(^|[a-z])([a-z])/g, (match, prefix: string, letter: string) =>
    `${prefix ? `${prefix} ` : ''}${letter.toUpperCase()}`).trim();
}

function targetMoveFailure(
  state: BattleState,
  actor: PokemonState,
  id: string,
  targetIds: string[],
): string | undefined {
  if (id === 'revivalblessing') {
    const targetId = targetIds[0];
    const target = targetId ? getPokemon(state, targetId) : undefined;
    if (state.generation < 9 || !target || target.id === actor.id || target.hp.current > 0 ||
      sideForPokemon(state, target.id) !== sideForPokemon(state, actor.id)) {
      return 'Revival Blessing failed because it did not target a fainted ally';
    }
    return undefined;
  }
  const targets = targetIds
    .map(targetId => getPokemon(state, targetId))
    .filter((target): target is PokemonState => !!target && target.hp.current > 0);
  if (id === 'teatime' && (state.generation !== 8 || !targets.some(target => isBerry(target.item)))) {
    return 'Teatime failed because no active target held a Berry';
  }
  if (id === 'flowershield' && (state.generation < 6 || state.generation > 8 || !targets.some(target =>
    getEffectiveTypes(state, target.id).some(type => moveId(type) === 'grass') && (target.boosts?.def || 0) < 6))) {
    return 'Flower Shield failed because no Grass target could gain Defense';
  }
  if (id === 'rototiller' && (state.generation < 6 || state.generation > 7 || !targets.some(target =>
    isGrounded(state, target.id) && getEffectiveTypes(state, target.id).some(type => moveId(type) === 'grass') &&
    ((target.boosts?.atk || 0) < 6 || (target.boosts?.spa || 0) < 6)))) {
    return 'Rototiller failed because no grounded Grass target could gain stages';
  }
  if (id === 'lunarblessing' && targets.every(target => target.hp.current >= target.hp.max &&
    !target.status && !target.toxicCounter)) {
    return 'Lunar Blessing failed because all allies were already healed';
  }
  if (MIXED_TARGET_STAGE_MOVE_IDS.has(id) && targets.every(target =>
    !hasMixedTargetStageEffect(target.boosts, id))) {
    return `${actionNameForId(id)} failed because the target had no affected stage to change`;
  }
  if (id === 'tarshot' && targets.length && targets.every(target =>
    !hasTargetStageEffect(target.boosts, id) &&
    !canApplyVolatile(state, target.id, 'tarShot', actor.id, true, 'Status'))) {
    return 'Tar Shot failed because no target could gain its effects';
  }
  if (PURE_TARGET_STAGE_BOOST_IDS.has(id) && targets.every(target =>
    !hasTargetStageBoostEffect(target.boosts, id))) {
    return `${actionNameForId(id)} failed because the target could not gain another affected stage`;
  }
  const pureStatus = PURE_STATUS_EFFECTS[id];
  if (pureStatus && targets.length && targets.every(target => !canApplyMajorStatus(
    state, actor.id, target.id, pureStatus.status, pureStatus.moveType, true,
  ))) {
    return `${actionNameForId(id)} failed because no target was eligible for its status`;
  }
  const target = targets[0];
  if (!target) return undefined;
  if (PURE_ITEM_TRANSFER_MOVE_IDS.has(id) && !hasPureItemTransferEffect(state, actor, target, id)) {
    return `${actionNameForId(id)} failed because the held-item transfer was not possible`;
  }
  if (PURE_ABILITY_MOVE_IDS.has(id) && !hasPureAbilityEffect(state, actor, target, id)) {
    return `${actionNameForId(id)} failed because it would not change an ability`;
  }
  if (PURE_PP_MOVE_IDS.has(id) && !hasPurePPEffect(state, target, id)) {
    return `${actionNameForId(id)} failed because the target had no tracked PP to reduce`;
  }
  if (PURE_STAT_TRANSFER_MOVE_IDS.has(id) && !hasPureStatTransferEffect(state, actor, target, id)) {
    return `${actionNameForId(id)} failed because it would not change the modeled stats`;
  }
  if (id === 'instruct' && !hasInstructEffect(state, target)) {
    return 'Instruct failed because the target had no callable last move';
  }
  if (PURE_MOVE_COPY_IDS.has(id) && !hasMoveCopyEffect(state, actor, target, id)) {
    return `${actionNameForId(id)} failed because no legal move was available to copy`;
  }
  if (PURE_CALL_MOVE_IDS.has(id) && !hasCallMoveEffect(state, actor, target, id)) {
    return `${actionNameForId(id)} failed because no legal candidate move was available`;
  }
  if (PURE_TYPE_MOVE_IDS.has(id) && !hasPureTypeEffect(
    state, actor, target, id, pokemonId => getEffectiveTypes(state, pokemonId),
  )) {
    return `${actionNameForId(id)} failed because the type change had no effect`;
  }
  if (PURE_CONFUSION_MOVE_IDS.has(id) && targets.every(candidate =>
    !canApplyVolatile(state, candidate.id, 'confusion', actor.id, true))) {
    return `${actionNameForId(id)} failed because no target was eligible for confusion`;
  }
  if (PURE_TARGET_STAGE_RESET_MOVE_IDS.has(id) && targets.every(candidate =>
    !hasTargetStageResetEffect(candidate.boosts, id))) {
    return `${actionNameForId(id)} failed because no target had stages to reset`;
  }
  if (PURE_TARGET_STAGE_DROP_IDS.has(id) && id !== 'tarshot' && (!hasTargetStageEffect(target.boosts, id) ||
    (id === 'captivate' && actor.gender && actor.gender !== 'N' && target.gender && target.gender !== 'N' && actor.gender === target.gender))) {
    return `${actionNameForId(id)} failed because the target could not lose another affected stage`;
  }
  if (id === 'attract' && (target.volatile?.infatuated ||
    !canApplyVolatile(state, target.id, 'infatuated', actor.id, true, 'Status'))) {
    return 'Attract failed because the target was not eligible';
  }
  if (id === 'yawn' && (target.volatile?.yawn || !canApplyMajorStatus(state, actor.id, target.id, 'slp', undefined, true))) {
    return 'Yawn failed because the target was not eligible for sleep';
  }
  if (id === 'leechseed' && !canApplyVolatile(state, target.id, 'leechSeed', actor.id, true, 'Status')) {
    return 'Leech Seed failed because the target was not eligible';
  }
  if (id === 'telekinesis' && (state.field.gravity ||
    !canApplyVolatile(state, target.id, 'telekinesis', actor.id, true, 'Status'))) {
    return 'Telekinesis failed because the target was not eligible';
  }
  if (id === 'nightmare' && !canApplyVolatile(state, target.id, 'nightmare', actor.id, true, 'Status')) {
    return 'Nightmare failed because the target was not eligible';
  }
  if (id === 'acupressure' && ['atk', 'def', 'spa', 'spd', 'spe'].every(stat =>
    (target.boosts?.[stat as keyof NonNullable<PokemonState['boosts']>] || 0) >= 6)) {
    return 'Acupressure failed because all target stats were already maxed';
  }
  if (id === 'psychup' && ['atk', 'def', 'spa', 'spd', 'spe'].every(stat =>
    (actor.boosts?.[stat as keyof NonNullable<PokemonState['boosts']>] || 0) ===
    (target.boosts?.[stat as keyof NonNullable<PokemonState['boosts']>] || 0))) {
    return 'Psych Up failed because it would not change the user\'s stat stages';
  }
  const swapStats = id === 'guardswap' ? ['def', 'spd'] : id === 'powerswap' ? ['atk', 'spa'] : [];
  if (swapStats.length && swapStats.every(stat =>
    (actor.boosts?.[stat as keyof NonNullable<PokemonState['boosts']>] || 0) ===
    (target.boosts?.[stat as keyof NonNullable<PokemonState['boosts']>] || 0))) {
    return `${id === 'guardswap' ? 'Guard Swap' : 'Power Swap'} failed because the stages were already equal`;
  }
  if (id === 'encore' && (!state.lastMoveByPokemon?.[target.id] ||
    state.firstTurnOutIds?.includes(target.id) || target.volatile?.encore)) {
    return 'Encore failed because the target had no eligible move history';
  }
  if (id === 'disable' && (!state.lastMoveByPokemon?.[target.id] || target.volatile?.disable)) {
    return 'Disable failed because the target had no eligible move';
  }
  if (id === 'taunt' && target.volatile?.taunt) return 'Taunt failed because the target was already Taunted';
  if (id === 'torment' && target.volatile?.torment) return 'Torment failed because the target was already Tormented';
  if (id === 'leechseed' && target.volatile?.leechSeed) return 'Leech Seed failed because the target was already seeded';
  if (id === 'perishsong' && targets.length && targets.every(candidate => candidate.volatile?.perishSong)) {
    return 'Perish Song failed because every target was already under Perish Song';
  }
  if ((id === 'foresight' || id === 'odorsleuth') && target.volatile?.foresight) {
    return `${actionNameForId(id)} failed because the target was already identified`;
  }
  if (id === 'electrify' && target.volatile?.electrified) return 'Electrify failed because the target was already Electrified';
  if (id === 'octolock' && (target.volatile?.octolock || target.volatile?.trapped)) {
    return 'Octolock failed because the target was already trapped';
  }
  if (id === 'miracleeye' && target.volatile?.miracleEye) return 'Miracle Eye failed because it was already active';
  if (id === 'gastroacid' && preventsAbilityChange(state, target)) {
    return 'Gastro Acid failed because the target ability was protected by Ability Shield';
  }
  if (id === 'gastroacid' && target.abilitySuppressed) return 'Gastro Acid failed because the target ability was already suppressed';
  if (id === 'embargo' && target.volatile?.embargo) return 'Embargo failed because the target was already under Embargo';
  if (id === 'healblock' && target.volatile?.healBlock) return 'Heal Block failed because it was already active';
  if (['block', 'meanlook', 'spiderweb'].includes(id) && target.volatile?.trapped) {
    return `${id === 'block' ? 'Block' : id === 'meanlook' ? 'Mean Look' : 'Spider Web'} failed because the target was already trapped`;
  }
  if (id === 'refresh' && !actor.status && !actor.toxicCounter) return 'Refresh failed because the actor had no major status';
  if (id === 'purify' && !target.status && !target.toxicCounter) return 'Purify failed because the target had no major status';
  if (id === 'painsplit' && actor.hp.current === target.hp.current) {
    return 'Pain Split failed because both HP totals were equal';
  }
  if (['floralhealing', 'healpulse', 'pollenpuff'].includes(id) &&
    sideForPokemon(state, target.id) === sideForPokemon(state, actor.id) && target.hp.current >= target.hp.max) {
    return `${actionNameForId(id)} failed because the ally was at full HP`;
  }
  if (id === 'lifedew' && targets.every(candidate => candidate.hp.current >= candidate.hp.max)) {
    return 'Life Dew failed because all allies were at full HP';
  }
  if ((id === 'junglehealing' || id === 'lunarblessing') && targets.every(candidate => candidate.hp.current >= candidate.hp.max &&
    !candidate.status && !candidate.toxicCounter)) {
    return 'Jungle Healing failed because all allies were already healed';
  }
  if ((id === 'aromatherapy' || id === 'healbell') && targets.every(candidate =>
    sideForPokemon(state, candidate.id) !== sideForPokemon(state, actor.id) ||
    (!candidate.status && !candidate.toxicCounter))) {
    return `${actionNameForId(id)} failed because no ally had a major status`;
  }
  return undefined;
}

function fieldMoveFailure(state: BattleState, actor: PokemonState, id: string): string | undefined {
  const sideId = sideForPokemon(state, actor.id);
  const ownEffects = state.sides[sideId].effects || {};
  const foeEffects = state.sides[sideId === 'ai' ? 'player' : 'ai'].effects || {};
  const fail = (move: string, reason: string) => `${move} failed because ${reason}`;
  if (id === 'stealthrock' && foeEffects.stealthRock) return fail('Stealth Rock', 'it was already active');
  if (id === 'spikes' && (foeEffects.spikes || 0) >= 3) return fail('Spikes', 'three layers were already active');
  if (id === 'toxicspikes' && (foeEffects.toxicSpikes || 0) >= 2) return fail('Toxic Spikes', 'two layers were already active');
  if (id === 'stickyweb' && foeEffects.stickyWeb) return fail('Sticky Web', 'it was already active');
  const sideMoveEffects: Record<string, keyof SideEffects> = {
    reflect: 'reflect', lightscreen: 'lightScreen', auroraveil: 'auroraVeil', tailwind: 'tailwind',
    mist: 'mist', luckychant: 'luckyChant', craftyshield: 'craftyShield',
  };
  const sideEffect = sideMoveEffects[id];
  if (sideEffect && ownEffects[sideEffect]) return fail(actionNameForId(id), 'it was already active');
  if (id === 'auroraveil' && state.field.weather !== 'Hail' && state.field.weather !== 'Snow') {
    return fail('Aurora Veil', 'hail or snow was not active');
  }
  if (id === 'fairylock' && state.field.fairyLock) return fail('Fairy Lock', 'it was already active');
  if (id === 'watersport') {
    if (state.generation < 3 || state.generation >= 8) return fail('Water Sport', 'it had no effect in this generation');
    if (state.generation <= 5 ? actor.volatile?.waterSport : state.field.waterSport) {
      return fail('Water Sport', 'it was already active');
    }
  }
  if (id === 'mudsport') {
    if (state.generation < 3 || state.generation >= 8) return fail('Mud Sport', 'it had no effect in this generation');
    if (state.generation <= 5 ? actor.volatile?.mudSport : state.field.mudSport) {
      return fail('Mud Sport', 'it was already active');
    }
  }
  if (id === 'iondeluge') {
    if (state.generation < 6 || state.generation > 7) return fail('Ion Deluge', 'it had no effect in this generation');
    if (state.field.ionDeluge) return fail('Ion Deluge', 'it was already active');
  }
  const hasHazards = (effects: SideEffects) => !!effects.stealthRock || !!effects.spikes ||
    !!effects.toxicSpikes || !!effects.stickyWeb;
  const hasScreens = (effects: SideEffects) => !!effects.reflect || !!effects.lightScreen ||
    !!effects.auroraVeil || !!effects.safeguard;
  if (id === 'defog' && (!hasHazards(state.sides.ai.effects || {}) && !hasHazards(state.sides.player.effects || {}) &&
    !hasScreens(state.sides[sideId === 'ai' ? 'player' : 'ai'].effects || {}))) {
    return 'Defog failed because there were no hazards or target-side screens';
  }
  if (id === 'courtchange') {
    const hasPersistentSideEffect = (effects: SideEffects) => hasHazards(effects) || hasScreens(effects) ||
      !!effects.mist || !!effects.luckyChant || !!effects.craftyShield || !!effects.tailwind;
    if (!hasPersistentSideEffect(state.sides.ai.effects || {}) && !hasPersistentSideEffect(state.sides.player.effects || {})) {
      return 'Court Change failed because there were no side conditions to swap';
    }
  }
  if (id === 'steelroller' && !state.field.terrain) return 'Steel Roller failed because no Terrain was active';
  return undefined;
}

function addBoosts(
  resolution: MoveResolution,
  state: BattleState,
  pokemonId: string,
  boosts: StatBoosts,
  sourceId = pokemonId,
  allowMirrorArmor = true,
  ignoreTargetAbility = false,
) {
  const pokemon = getPokemon(state, pokemonId);
  if (!pokemon) return;
  const ability = isAbilityActive(pokemon, state) && isAbilityAvailable(state.generation, getEffectiveAbility(pokemon))
    ? moveId(getEffectiveAbility(pokemon)) : '';
  const contrary = !ignoreTargetAbility && ability === 'contrary';
  const simple = !ignoreTargetAbility && ability === 'simple';
  const mirrorArmor = sourceId !== pokemonId && !ignoreTargetAbility && ability === 'mirrorarmor';
  const blocksDrops = sourceId !== pokemonId && !ignoreTargetAbility &&
    ['clearbody', 'fullmetalbody', 'whitesmoke'].includes(ability);
  const sourceSide = sideForPokemon(state, sourceId);
  const targetSide = sideForPokemon(state, pokemonId);
  const mistBlocksDrops = sourceId !== pokemonId && sourceSide !== targetSide &&
    state.sides[targetSide].effects?.mist === true;
  const clearAmulet = sourceId !== pokemonId && isItemEffectActive(state, pokemon) &&
    isItemAvailable(state, pokemon.item) &&
    moveId(pokemon.item) === 'clearamulet';
  const flowerVeilBlocksDrops = sourceId !== pokemonId && hasFlowerVeilProtection(state, pokemon);
  const clampStage = (stage: number) => Math.max(-6, Math.min(6, stage));
  const current = resolution.boostsByPokemon?.[pokemonId] || {};
  const normalized: StatBoosts = {};
  for (const stat of Object.keys(boosts) as Array<keyof StatBoosts>) {
    const amount = boosts[stat];
    if (amount === undefined) continue;
    let adjusted = amount * (contrary ? -1 : 1) * (simple ? 2 : 1);
    const accuracyDropBlocked = adjusted < 0 && stat === 'acc' &&
      !ignoreTargetAbility && (ability === 'keeneye' || ability === 'mindseye');
    if (adjusted < 0 && mirrorArmor && allowMirrorArmor && getPokemon(state, sourceId)) {
      addBoosts(resolution, state, sourceId, {[stat]: adjusted}, pokemonId, false);
      continue;
    }
    if (adjusted < 0 && (blocksDrops || clearAmulet || mistBlocksDrops || flowerVeilBlocksDrops || accuracyDropBlocked)) continue;
    const currentStage = (pokemon.boosts?.[stat] || 0) + (current[stat] || 0);
    const effective = clampStage(currentStage + adjusted) - currentStage;
    if (effective) normalized[stat] = effective;
  }
  const hasIncomingDrop = Object.values(normalized).some(amount => amount < 0);
  if (sourceId !== pokemonId && !ignoreTargetAbility && hasIncomingDrop && state.generation >= 5 && ability === 'defiant') {
    const currentStage = (pokemon.boosts?.atk || 0) + (current.atk || 0);
    normalized.atk = clampStage(currentStage + (normalized.atk || 0) + 2) - currentStage;
  }
  if (sourceId !== pokemonId && !ignoreTargetAbility && hasIncomingDrop && state.generation >= 6 && ability === 'competitive') {
    const currentStage = (pokemon.boosts?.spa || 0) + (current.spa || 0);
    normalized.spa = clampStage(currentStage + (normalized.spa || 0) + 2) - currentStage;
  }
  for (const stat of Object.keys(normalized) as Array<keyof StatBoosts>) {
    if (!normalized[stat]) delete normalized[stat];
  }
  if (!Object.keys(normalized).length) return;
  resolution.boostsByPokemon = {...(resolution.boostsByPokemon || {})};
  const merged = {...current};
  for (const stat of Object.keys(normalized) as Array<keyof StatBoosts>) {
    const amount = normalized[stat];
    if (amount !== undefined) merged[stat] = (merged[stat] || 0) + amount;
  }
  resolution.boostsByPokemon[pokemonId] = merged;
}

function applyOpportunist(
  resolution: MoveResolution,
  state: BattleState,
) {
  if (state.generation < 9 || !resolution.boostsByPokemon) return;
  const originalBoosts = Object.entries(resolution.boostsByPokemon);
  for (const holder of activePokemonForSide(state, 'ai').concat(activePokemonForSide(state, 'player'))) {
    if (!hasAbility(state, holder, 'opportunist')) continue;
    const opposingSide = otherSide(sideForPokemon(state, holder.id));
    const copied: StatBoosts = {};
    for (const [sourceId, boosts] of originalBoosts) {
      const source = getPokemon(state, sourceId);
      if (!source || source.hp.current <= 0 || sideForPokemon(state, source.id) !== opposingSide) continue;
      for (const [stat, amount] of Object.entries(boosts) as Array<[keyof StatBoosts, number | undefined]>) {
        if ((amount || 0) > 0) copied[stat] = (copied[stat] || 0) + amount!;
      }
    }
    if (!Object.keys(copied).length) continue;
    addBoosts(resolution, state, holder.id, copied, holder.id, false);
    resolution.trace!.notes!.push(`Opportunist copied opposing stat boosts for ${holder.id}`);
  }
}

function applyMirrorHerb(
  resolution: MoveResolution,
  state: BattleState,
) {
  if (state.generation < 9 || !resolution.boostsByPokemon) return;

  const positiveBySide: Partial<Record<SideId, StatBoosts>> = {};
  for (const [pokemonId, boosts] of Object.entries(resolution.boostsByPokemon)) {
    const source = getPokemon(state, pokemonId);
    if (!source || source.hp.current <= 0) continue;
    const positive = Object.fromEntries(
      Object.entries(boosts).filter(([, amount]) => (amount || 0) > 0),
    ) as StatBoosts;
    if (!Object.keys(positive).length) continue;
    const sideId = sideForPokemon(state, pokemonId);
    positiveBySide[sideId] = {
      ...(positiveBySide[sideId] || {}),
      ...Object.fromEntries(Object.entries(positive).map(([stat, amount]) => [
        stat,
        (positiveBySide[sideId]?.[stat as keyof StatBoosts] || 0) + amount,
      ])),
    };
  }

  for (const holder of activePokemonForSide(state, 'ai').concat(activePokemonForSide(state, 'player'))) {
    if (moveId(resolvedItem(state, resolution, holder)) !== 'mirrorherb' ||
      !heldItemEffectsActive(state, holder)) continue;
    const opposingBoosts = positiveBySide[otherSide(sideForPokemon(state, holder.id))];
    if (!opposingBoosts || !Object.keys(opposingBoosts).length) continue;
    addBoosts(resolution, state, holder.id, opposingBoosts, holder.id, false);
    consumeItem(resolution, holder.id, holder.item!);
    resolution.trace!.notes!.push(`Mirror Herb copied opposing stat boosts for ${holder.id}`);
  }
}

function applyWhiteHerb(
  resolution: MoveResolution,
  state: BattleState,
) {
  if (state.generation < 4) return;
  for (const holder of activePokemonForSide(state, 'ai').concat(activePokemonForSide(state, 'player'))) {
    const resolved = resolvedItem(state, resolution, holder);
    const consumed = resolution.consumedItemByPokemon?.[holder.id];
    const activeWhiteHerb = !!resolved && moveId(resolved) === 'whiteherb' &&
      heldItemEffectsActive(state, holder);
    const consumedWhiteHerb = !!consumed && moveId(consumed) === 'whiteherb';
    if (!activeWhiteHerb && !consumedWhiteHerb) continue;

    const additive = resolution.boostsByPokemon?.[holder.id] || {};
    const absolute = resolution.setBoostsByPokemon?.[holder.id];
    const reset = resolution.resetBoostsByPokemon?.[holder.id] === true;
    const restoration: StatBoosts = {};
    for (const stat of STAGE_IDS) {
      const base = absolute?.[stat] !== undefined
        ? absolute[stat]!
        : reset ? 0 : holder.boosts?.[stat] || 0;
      const additiveAmount = additive[stat] || 0;
      const finalStage = base + additiveAmount;
      if (finalStage < 0) restoration[stat] = additiveAmount ? -additiveAmount : 0;
    }
    if (!Object.keys(restoration).length) continue;

    setBoosts(resolution, holder.id, restoration);
    if (activeWhiteHerb) consumeItem(resolution, holder.id, resolved!);
    resolution.trace!.notes!.push(`White Herb cleared negative stat stages for ${holder.id}`);
  }
}

function applyDancer(
  resolution: MoveResolution,
  state: BattleState,
  action: MoveAction,
  moveMetadata: {dance?: boolean},
) {
  if (state.generation < 7 || !moveMetadata.dance || resolution.hit === false) return;
  const actor = getPokemon(state, action.actorId);
  if (!actor) return;
  const actorSide = sideForPokemon(state, actor.id);
  const dancers = activePokemonForSide(state, 'ai').concat(activePokemonForSide(state, 'player'))
    .filter(pokemon => pokemon.id !== actor.id && pokemon.hp.current > 0 &&
      hasAbility(state, pokemon, 'dancer') &&
      !SEMI_INVULNERABLE_CHARGE_MOVES.has(moveId(pokemon.volatile?.charge?.moveName || '')))
    .sort((left, right) => getEffectivePokemonSpeed(state, left.id) - getEffectivePokemonSpeed(state, right.id));
  for (const dancer of dancers) {
    if (resolution.calledMoveByPokemon?.[dancer.id] !== undefined) continue;
    const targetIds = sideForPokemon(state, dancer.id) === actorSide
      ? action.targetIds
      : [actor.id];
    setCalledMove(resolution, dancer.id, action.moveName);
    setCalledMoveTargets(resolution, dancer.id, targetIds);
    setCalledMoveExternal(resolution, dancer.id);
    resolution.trace!.notes!.push(`Dancer queued ${action.moveName} for ${dancer.id}`);
  }
}

function resetBoosts(resolution: MoveResolution, pokemonIds: string[]) {
  if (!pokemonIds.length) return;
  resolution.resetBoostsByPokemon = {...(resolution.resetBoostsByPokemon || {})};
  for (const pokemonId of pokemonIds) resolution.resetBoostsByPokemon[pokemonId] = true;
}

function setBoosts(resolution: MoveResolution, pokemonId: string, boosts: StatBoosts) {
  resolution.setBoostsByPokemon = {
    ...(resolution.setBoostsByPokemon || {}),
    [pokemonId]: {...(resolution.setBoostsByPokemon?.[pokemonId] || {}), ...boosts},
  };
}

function allBoostStages(pokemon: BattleState['sides'][SideId]['party'][number]): StatBoosts {
  return Object.fromEntries(STAGE_IDS.map(stat => [stat, pokemon.boosts?.[stat] || 0]));
}

function randomAcupressureStat(
  state: BattleState,
  pokemonId: string,
  random: () => number,
): keyof StatBoosts | undefined {
  const pokemon = getPokemon(state, pokemonId);
  if (!pokemon) return undefined;
  const available = STAGE_IDS.filter(stat => (pokemon.boosts?.[stat] || 0) < 6);
  if (!available.length) return undefined;
  const roll = random();
  if (!Number.isFinite(roll)) throw new Error('Acupressure sampler must return a finite number');
  const bounded = Math.max(0, Math.min(0.999999999999, roll));
  return available[Math.floor(bounded * available.length)];
}

function randomFlingBoostStat(
  pokemon: PokemonState,
  random: () => number,
): keyof StatBoosts | undefined {
  const available = FLING_RANDOM_BOOST_STATS.filter(stat => (pokemon.boosts?.[stat] || 0) < 6);
  if (!available.length) return undefined;
  return available[Math.floor(sampleActionRoll(random, 'Starf Berry stat') * available.length)];
}

function addSideEffects(resolution: MoveResolution, sideId: SideId, effects: Partial<SideEffects>) {
  resolution.sideEffectsBySide = {...(resolution.sideEffectsBySide || {})};
  resolution.sideEffectsBySide[sideId] = {
    ...(resolution.sideEffectsBySide[sideId] || {}),
    ...effects,
  };
}

function setPendingFullHeal(resolution: MoveResolution, sideId: SideId) {
  resolution.pendingFullHealBySide = {
    ...(resolution.pendingFullHealBySide || {}),
    [sideId]: true,
  };
}

function heldItemEffectsActive(state: BattleState, pokemon: PokemonState): boolean {
  return isItemEffectActive(state, pokemon);
}

function drainAmount(
  state: BattleState,
  actor: PokemonState,
  damage: number,
  fraction: [number, number],
): number {
  const base = Math.floor(damage * fraction[0] / fraction[1]);
  if (state.generation >= 4 && heldItemEffectsActive(state, actor) && moveId(actor.item) === 'bigroot') {
    return Math.floor(base * 13 / 10);
  }
  return base;
}

function liquidOozeApplies(
  state: BattleState,
  target: PokemonState | undefined,
  moveName: string,
): boolean {
  if (state.generation < 3 || !target || !hasAbility(state, target, 'liquidooze')) return false;
  return moveId(moveName) !== 'dreameater' || state.generation >= 5;
}

function clearEntryHazards(resolution: MoveResolution, sideId: SideId) {
  addSideEffects(resolution, sideId, {
    stealthRock: false,
    steelsurge: false,
    spikes: 0,
    toxicSpikes: 0,
    stickyWeb: false,
  });
  addSideEffectDuration(resolution, sideId, 'steelsurge', null);
}

function clearSubstitutes(resolution: MoveResolution, pokemonIds: string[]) {
  if (!pokemonIds.length) return;
  resolution.substituteHpByPokemon = {...(resolution.substituteHpByPokemon || {})};
  for (const pokemonId of pokemonIds) resolution.substituteHpByPokemon[pokemonId] = null;
}

function courtChangeSideEffects(source: SideEffects): Partial<SideEffects> {
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

function addSideEffectDuration(
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

function addField(resolution: MoveResolution, field: Partial<BattleState['field']>) {
  resolution.field = {...(resolution.field || {}), ...field};
}

function addFieldDuration(resolution: MoveResolution, field: TimedFieldName, turns: number | null) {
  resolution.fieldDurations = {...(resolution.fieldDurations || {}), [field]: turns};
}

function extendedFieldDuration(
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

function addVolatile(
  resolution: MoveResolution,
  pokemonIds: string[],
  name: VolatileStatusName,
  effect: VolatileState = {},
) {
  if (!pokemonIds.length) return;
  resolution.volatileByPokemon = {...(resolution.volatileByPokemon || {})};
  for (const pokemonId of pokemonIds) {
    resolution.volatileByPokemon[pokemonId] = {
      ...(resolution.volatileByPokemon[pokemonId] || {}),
      [name]: effect,
    };
  }
}

function activateBoosterEnergy(resolution: MoveResolution, state: BattleState) {
  if (state.generation < 9) return;
  const weather = resolution.field && Object.prototype.hasOwnProperty.call(resolution.field, 'weather')
    ? resolution.field.weather
    : state.field.weather;
  const terrain = resolution.field && Object.prototype.hasOwnProperty.call(resolution.field, 'terrain')
    ? resolution.field.terrain
    : state.field.terrain;
  for (const sideId of ['ai', 'player'] as SideId[]) {
    for (const pokemonId of state.sides[sideId].activeIds) {
      const pokemon = getPokemon(state, pokemonId);
      if (!pokemon || pokemon.hp.current <= 0 || !isItemEffectActive(state, pokemon) ||
        moveId(pokemon.item) !== 'boosterenergy') continue;
      const volatile = getParadoxAbilityVolatile(state, pokemon);
      if (!volatile || getBoosterEnergyVolatile(state, pokemon)) continue;
      const weatherActive = volatile === 'protosynthesis' &&
        !isWeatherSuppressed(state) && (weather === 'Sun' || weather === 'Harsh Sunshine');
      const terrainActive = volatile === 'quarkDrive' && terrain === 'Electric';
      if (weatherActive || terrainActive) continue;
      addVolatile(resolution, [pokemon.id], volatile);
      consumeItem(resolution, pokemon.id, pokemon.item!);
      resolution.trace!.notes!.push(`Booster Energy activated ${volatile} for ${pokemon.id}`);
    }
  }
}

function activateBlunderPolicy(
  resolution: MoveResolution,
  state: BattleState,
  actor: PokemonState,
  missedAccuracy: boolean,
) {
  if (!missedAccuracy || state.generation < 8 || !isItemEffectActive(state, actor) ||
    moveId(actor.item) !== 'blunderpolicy') return;
  addBoosts(resolution, state, actor.id, {spe: 2}, actor.id);
  consumeItem(resolution, actor.id, actor.item!);
  resolution.trace!.notes!.push(`Blunder Policy raised ${actor.id}'s Speed after a missed move`);
}

function clearVolatile(resolution: MoveResolution, pokemonId: string, name: VolatileStatusName) {
  resolution.volatileByPokemon = {...(resolution.volatileByPokemon || {})};
  resolution.volatileByPokemon[pokemonId] = {
    ...(resolution.volatileByPokemon[pokemonId] || {}),
    [name]: null,
  };
}

function addEligibleVolatile(
  resolution: MoveResolution,
  state: BattleState,
  targetIds: string[],
  name: VolatileStatusName,
  effect: VolatileState = {},
  actorId?: string,
  statusMove = false,
) {
  const eligible = targetIds.filter(targetId => canApplyVolatile(state, targetId, name, actorId, statusMove));
  addVolatile(resolution, eligible, name, effect);
}

function addConfusion(
  resolution: MoveResolution,
  state: BattleState,
  targetIds: string[],
  random: () => number,
  actorId?: string,
) {
  for (const targetId of targetIds) {
    if (!canApplyVolatile(state, targetId, 'confusion', actorId, true)) continue;
    addVolatile(resolution, [targetId], 'confusion', {
      turns: Math.floor(sampleActionRoll(random, 'Confusion duration') * 4) + 2,
    });
  }
}

function applyPoisonPuppeteer(
  resolution: MoveResolution,
  state: BattleState,
  actor: PokemonState,
  effectTargetIds: string[],
  random: () => number,
) {
  if (state.generation < 9 || !hasAbility(state, actor, 'poisonpuppeteer') ||
    moveId(getEffectiveSpecies(actor)) !== 'pecharunt') return;
  const poisonedTargets = effectTargetIds.filter(targetId => {
    const status = resolution.statusByPokemon?.[targetId];
    return targetId !== actor.id && (status === 'psn' || status === 'tox');
  });
  if (!poisonedTargets.length) return;
  addConfusion(resolution, state, poisonedTargets, random, actor.id);
  if (resolution.volatileByPokemon) {
    resolution.trace!.notes!.push(`Poison Puppeteer confused poisoned targets for ${actor.id}`);
  }
}

function applySynchronize(
  resolution: MoveResolution,
  state: BattleState,
  actor: PokemonState,
  effectTargetIds: string[],
  moveCategory: MoveCategory,
) {
  if (state.generation < 3) return;
  for (const targetId of effectTargetIds) {
    const target = getPokemon(state, targetId);
    const status = resolution.statusByPokemon?.[targetId];
    if (!target || target.id === actor.id || sideForPokemon(state, target.id) === sideForPokemon(state, actor.id) ||
      !hasAbility(state, target, 'synchronize') ||
      ignoresTargetAbility(state, actor.id, target.id, moveCategory) ||
      !['brn', 'psn', 'tox', 'par'].includes(status || '') ||
      Object.prototype.hasOwnProperty.call(resolution.statusByPokemon || {}, actor.id)) continue;
    if (!canApplyMajorStatus(state, actor.id, actor.id, status as StatusName)) continue;
    addStatus(resolution, state, [actor.id], status as StatusName);
    resolution.trace!.notes!.push(`Synchronize reflected ${status} from ${target.id} to ${actor.id}`);
    break;
  }
}

function addStatus(
  resolution: MoveResolution,
  state: BattleState,
  targetIds: string[],
  status: StatusName,
  replaceExisting = false,
) {
  if (!targetIds.length) return;
  const statusByPokemon = {...(resolution.statusByPokemon || {})};
  const toxicCounterByPokemon = {...(resolution.toxicCounterByPokemon || {})};
  let changed = false;
  for (const targetId of targetIds) {
    if (!replaceExisting && getPokemon(state, targetId)?.status) continue;
    statusByPokemon[targetId] = status;
    if (status === 'tox') toxicCounterByPokemon[targetId] = 1;
    changed = true;
    const target = getPokemon(state, targetId);
    if (target && state.generation >= 3 && isItemEffectActive(state, target)) {
      const item = moveId(target.item);
      const curesStatus = statusBerryCures(target.item, status);
      if (curesStatus) {
        statusByPokemon[targetId] = '';
        toxicCounterByPokemon[targetId] = 0;
        resolution.statusTurnsByPokemon = {
          ...(resolution.statusTurnsByPokemon || {}),
          [targetId]: null,
        };
        if (item === 'lumberry') clearVolatile(resolution, targetId, 'confusion');
        consumeItem(resolution, targetId, target.item!);
        applyCheekPouch(resolution, state, target, target.item!);
        armCudChew(resolution, state, target, target.item!);
        resolution.trace = {
          ...(resolution.trace || {source: 'battle-engine' as const}),
          notes: [
            ...(resolution.trace?.notes || []),
            `${target.item} cured ${status} on ${targetId}`,
          ],
        };
      }
    }
  }
  if (changed) {
    resolution.statusByPokemon = statusByPokemon;
    if (status === 'tox') resolution.toxicCounterByPokemon = toxicCounterByPokemon;
  }
}

function resolveFlingItemEffects(
  resolution: MoveResolution,
  state: BattleState,
  actor: PokemonState,
  targetIds: string[],
  moveType: string | undefined,
  moveCategory: MoveCategory,
) {
  if (!isItemEffectActive(state, actor) || !actor.item) return;
  const itemId = moveId(actor.item);
  if (itemId === 'mentalherb') {
    for (const targetId of targetIds) {
      const target = getPokemon(state, targetId);
      if (!target || target.hp.current <= 0) continue;
      clearMentalHerbVolatiles(resolution, target, false);
    }
  }
  if (itemId === 'whiteherb') {
    for (const targetId of targetIds) {
      const target = getPokemon(state, targetId);
      if (!target || target.hp.current <= 0) continue;
      const restoration = Object.fromEntries(
        STAGE_IDS
          .filter(stat => (target.boosts?.[stat] || 0) < 0)
          .map(stat => [stat, 0]),
      ) as StatBoosts;
      if (!Object.keys(restoration).length) continue;
      setBoosts(resolution, target.id, restoration);
      resolution.trace!.notes!.push(`Fling White Herb cleared negative stat stages for ${target.id}`);
    }
  }
  const status = !hasAbility(state, actor, 'sheerforce') ? FLING_ITEM_STATUSES[itemId] : undefined;
  if (status) {
    const targets = targetIds.filter(targetId =>
      !blocksSecondaryEffects(state, targetId) &&
      canApplyMajorStatus(state, actor.id, targetId, status, moveType, false, false, moveCategory));
    addStatus(resolution, state, targets, status);
    if (targets.length) resolution.trace!.notes!.push(`Fling applied ${status} from ${actor.item} to ${targets.join(', ')}`);
  }
  const volatile = !hasAbility(state, actor, 'sheerforce') ? FLING_ITEM_VOLATILES[itemId] : undefined;
  if (volatile) {
    const targets = targetIds.filter(targetId =>
      !blocksSecondaryEffects(state, targetId) &&
      canApplyVolatile(state, targetId, volatile, actor.id, false, moveCategory));
    addVolatile(resolution, targets, volatile, {turns: 1});
    if (targets.length) resolution.trace!.notes!.push(`Fling applied ${volatile} from ${actor.item} to ${targets.join(', ')}`);
  }
}

function applyBerryEatEffect(
  resolution: MoveResolution,
  state: BattleState,
  consumer: PokemonState,
  berryItem: string,
  random: () => number,
  sourceLabel: string,
  storeCudChew = true,
) {
  const berry = moveId(berryItem);
  let changed = false;
  const berryMultiplier = hasAbility(state, consumer, 'ripen') ? 2 : 1;
  if (berry === 'oranberry' && consumer.hp.current < consumer.hp.max && !consumer.volatile?.healBlock) {
    addHpDelta(resolution, consumer.id, 10 * berryMultiplier);
    changed = true;
  } else if (berry === 'sitrusberry' && consumer.hp.current < consumer.hp.max && !consumer.volatile?.healBlock) {
    addHpDelta(resolution, consumer.id, Math.floor(consumer.hp.max / 4) * berryMultiplier);
    changed = true;
  } else if (FLING_CONFUSION_BERRIES.has(berry) && !consumer.volatile?.healBlock) {
    if (consumer.hp.current < consumer.hp.max) {
      addHpDelta(resolution, consumer.id, Math.floor(consumer.hp.max / 2) * berryMultiplier);
      changed = true;
    }
    if (confusionBerryDislikesNature(consumer, berry) && canApplyVolatile(state, consumer.id, 'confusion')) {
      addVolatile(resolution, [consumer.id], 'confusion', {
        turns: Math.floor(sampleActionRoll(random, 'Confusion duration') * 4) + 2,
      });
      changed = true;
    }
  } else if (berry === 'lansatberry' && !consumer.volatile?.focusEnergy) {
    addVolatile(resolution, [consumer.id], 'focusEnergy');
    changed = true;
  } else if (berry === 'micleberry' && !consumer.volatile?.micleBerry) {
    addVolatile(resolution, [consumer.id], 'micleBerry', {turns: 2});
    changed = true;
  } else if (berry === 'keeberry' && (consumer.boosts?.def || 0) < 6) {
    addBoosts(resolution, state, consumer.id, {def: berryMultiplier});
    changed = true;
  } else if (berry === 'marangaberry' && (consumer.boosts?.spd || 0) < 6) {
    addBoosts(resolution, state, consumer.id, {spd: berryMultiplier});
    changed = true;
  } else if (berry === 'starfberry') {
    const stat = randomFlingBoostStat(consumer, random);
    if (stat) {
      addBoosts(resolution, state, consumer.id, {[stat]: 2 * berryMultiplier});
      changed = true;
    }
  }
  if (statusBerryCures(berryItem, consumer.status || '')) {
    clearMajorStatus(resolution, state, [consumer.id]);
    changed = true;
  }
  if (berry === 'lumberry' || berry === 'persimberry') {
    if (consumer.volatile?.confusion) {
      clearVolatile(resolution, consumer.id, 'confusion');
      changed = true;
    }
  }
  const stat = FLING_STAT_BERRIES[berry];
  if (stat && (consumer.boosts?.[stat] || 0) < 6) {
    addBoosts(resolution, state, consumer.id, {[stat]: berryMultiplier}, consumer.id);
    changed = true;
  }
  if (berry === 'leppaberry') {
    const candidate = consumer.moves.find(move => move.pp === 0 && move.maxPP !== 0) ||
      consumer.moves.find(move => {
        if (move.pp === undefined) return false;
        const maxPP = move.maxPP ?? getMoveMaxPP(move.name, state.generation) ?? 0;
        return maxPP > 0 && move.pp < maxPP;
      });
    if (candidate && candidate.pp !== undefined) {
      const maxPP = candidate.maxPP ?? getMoveMaxPP(candidate.name, state.generation) ?? 0;
      if (maxPP > 0 && candidate.pp < maxPP) {
        const amount = hasAbility(state, consumer, 'ripen') ? 20 : 10;
        const restoredPP = Math.min(maxPP, candidate.pp + amount);
        setMoves(resolution, consumer.id, consumer.moves.map(move =>
          move === candidate ? {...move, pp: restoredPP, maxPP} : move));
        changed = true;
      }
    }
  }
  if (changed || isBerry(berryItem)) {
    applyCheekPouch(resolution, state, consumer, berryItem);
    if (storeCudChew) armCudChew(resolution, state, consumer, berryItem);
  }
  if (changed) resolution.trace!.notes!.push(`${sourceLabel} triggered ${berryItem} for ${consumer.id}`);
  return changed;
}

function resolveFlingBerryEffect(
  resolution: MoveResolution,
  state: BattleState,
  actor: PokemonState,
  targetIds: string[],
  random: () => number,
) {
  if (!isItemEffectActive(state, actor) || !actor.item || !isBerry(actor.item)) return;
  for (const targetId of targetIds) {
    const target = getPokemon(state, targetId);
    if (!target || target.hp.current <= 0 ||
      isBerryUseSuppressedByUnnerve(state, actor.id, targetId)) continue;
    applyBerryEatEffect(resolution, state, target, actor.item, random, 'Fling');
  }
}

function totalDamage(resolution: MoveResolution): number {
  let total = 0;
  for (const targetId of Object.keys(resolution.damageByTarget || {})) {
    total += resolution.damageByTarget![targetId];
  }
  return total;
}

function setSequentialDamage(resolution: MoveResolution, targetId: string, hits: number[]): void {
  if (!resolution.hitDamageByTarget) return;
  const aggregateDamage = hits.reduce((total, hit) => total + hit, 0);
  resolution.hitDamageByTarget[targetId] = hits;
  resolution.damageByTarget = {
    ...(resolution.damageByTarget || {}),
    [targetId]: aggregateDamage,
  };
  if (resolution.trace?.damageRollsByTarget) {
    resolution.trace.damageRollsByTarget[targetId] = aggregateDamage;
  }
  if (resolution.trace?.hitDamageRollsByTarget) {
    resolution.trace.hitDamageRollsByTarget[targetId] = hits;
  }
}

interface SequentialDamageOutcome {
  directDamage: number;
  hitCount: number;
  fainted: boolean;
}

function sequentialDamageOutcome(
  target: PokemonState,
  hits: number[] | undefined,
  aggregateDamage: number,
): SequentialDamageOutcome {
  if (!hits) {
    const damageAfterSubstitute = Math.max(0, aggregateDamage - (target.substituteHp || 0));
    const directDamage = damageAfterSubstitute > 0
      ? target.volatile?.endure
        ? Math.min(damageAfterSubstitute, Math.max(0, target.hp.current - 1))
        : Math.min(damageAfterSubstitute, target.hp.current)
      : 0;
    return {
      directDamage,
      hitCount: directDamage > 0 ? 1 : 0,
      fainted: directDamage >= target.hp.current && directDamage > 0 && !target.volatile?.endure,
    };
  }

  let hp = target.hp.current;
  let substituteHp = Math.max(0, target.substituteHp || 0);
  let directDamage = 0;
  let hitCount = 0;
  for (const hit of hits) {
    if (hp <= 0) break;
    if (hit <= 0) continue;
    if (substituteHp > 0) {
      substituteHp = Math.max(0, substituteHp - hit);
      continue;
    }
    hitCount += 1;
    const actualDamage = target.volatile?.endure
      ? Math.min(hit, Math.max(0, hp - 1))
      : Math.min(hit, hp);
    directDamage += actualDamage;
    hp -= actualDamage;
  }
  return {directDamage, hitCount, fainted: hp <= 0};
}

function directDamageTotal(
  state: BattleState,
  resolution: MoveResolution,
  actorId: string,
): number {
  let total = 0;
  for (const [targetId, aggregateDamage] of Object.entries(resolution.damageByTarget || {})) {
    if (targetId === actorId) continue;
    const target = getPokemon(state, targetId);
    if (!target) continue;
    total += sequentialDamageOutcome(
      target,
      resolution.hitDamageByTarget?.[targetId],
      aggregateDamage,
    ).directDamage;
  }
  return total;
}

function directDamageTakenByPokemon(
  state: BattleState,
  resolution: MoveResolution,
  pokemon: PokemonState,
): number {
  const aggregateDamage = resolution.damageByTarget?.[pokemon.id] || 0;
  if (!aggregateDamage) return 0;
  return sequentialDamageOutcome(
    pokemon,
    resolution.hitDamageByTarget?.[pokemon.id],
    aggregateDamage,
  ).directDamage;
}

function applyBerryJuiceAfterMove(
  resolution: MoveResolution,
  state: BattleState,
  actor: PokemonState,
) {
  if (resolution.hit === false) return;
  const candidateIds = new Set([
    actor.id,
    ...Object.keys(resolution.damageByTarget || {}),
    ...Object.keys(resolution.hpDeltaByPokemon || {}),
  ]);
  for (const pokemonId of candidateIds) {
    const pokemon = getPokemon(state, pokemonId);
    if (!pokemon || pokemon.hp.current <= 0 ||
      !heldItemEffectsActive(state, pokemon) ||
      moveId(resolvedItem(state, resolution, pokemon)) !== 'berryjuice') continue;
    const directDamage = directDamageTakenByPokemon(state, resolution, pokemon);
    const pendingDelta = resolution.hpDeltaByPokemon?.[pokemon.id] || 0;
    if (directDamage <= 0 && pendingDelta >= 0) continue;
    const projectedHp = pokemon.hp.current - directDamage + pendingDelta;
    if (projectedHp <= 0 || projectedHp > Math.floor(pokemon.hp.max / 2)) continue;
    addHpDelta(resolution, pokemon.id, 20);
    consumeItem(resolution, pokemon.id, pokemon.item!);
    resolution.trace!.notes!.push(`Berry Juice restored 20 HP for ${pokemon.id} after damage`);
  }
}

function clearMentalHerbVolatiles(
  resolution: MoveResolution,
  pokemon: PokemonState,
  consumeHeldItem: boolean,
): boolean {
  const volatileDelta = resolution.volatileByPokemon?.[pokemon.id];
  const hasMentalVolatile = MENTAL_HERB_VOLATILES.some(name => {
    const value = volatileDelta && Object.prototype.hasOwnProperty.call(volatileDelta, name)
      ? volatileDelta[name]
      : pokemon.volatile?.[name];
    return value !== undefined && value !== null;
  });
  if (!hasMentalVolatile) return false;
  for (const name of MENTAL_HERB_VOLATILES) clearVolatile(resolution, pokemon.id, name);
  if (consumeHeldItem) consumeItem(resolution, pokemon.id, pokemon.item!);
  resolution.trace!.notes!.push(consumeHeldItem
    ? `Mental Herb cleared disabling conditions from ${pokemon.id}`
    : `Fling Mental Herb cleared disabling conditions from ${pokemon.id}`);
  return true;
}

function applyMentalHerbAfterMove(resolution: MoveResolution, state: BattleState) {
  if (!resolution.volatileByPokemon) return;
  for (const pokemonId of Object.keys(resolution.volatileByPokemon)) {
    const pokemon = getPokemon(state, pokemonId);
    if (!pokemon || !heldItemEffectsActive(state, pokemon) ||
      moveId(resolvedItem(state, resolution, pokemon)) !== 'mentalherb') continue;
    clearMentalHerbVolatiles(resolution, pokemon, true);
  }
}

function hasSurvivingDirectHit(
  target: PokemonState,
  hits: number[] | undefined,
  aggregateDamage: number,
): boolean {
  if (!hits) {
    const damageAfterSubstitute = Math.max(0, aggregateDamage - (target.substituteHp || 0));
    if (damageAfterSubstitute <= 0) return false;
    const actualDamage = target.volatile?.endure
      ? Math.min(damageAfterSubstitute, Math.max(0, target.hp.current - 1))
      : Math.min(damageAfterSubstitute, target.hp.current);
    return actualDamage > 0 && actualDamage < target.hp.current;
  }

  let hp = target.hp.current;
  let substituteHp = Math.max(0, target.substituteHp || 0);
  for (const hit of hits) {
    if (hit <= 0) continue;
    if (substituteHp > 0) {
      substituteHp = Math.max(0, substituteHp - hit);
      continue;
    }
    const actualDamage = target.volatile?.endure
      ? Math.min(hit, Math.max(0, hp - 1))
      : Math.min(hit, hp);
    if (actualDamage > 0 && actualDamage < hp) return true;
    hp -= actualDamage;
    if (hp <= 0) return false;
  }
  return false;
}

function hasDirectMoveHitAfterSubstitute(
  target: PokemonState,
  hits: number[] | undefined,
  aggregateDamage: number,
): boolean {
  if (!hits) return !(target.substituteHp && aggregateDamage <= target.substituteHp);
  let substituteHp = Math.max(0, target.substituteHp || 0);
  for (const hit of hits) {
    if (substituteHp > 0) {
      if (hit > 0) substituteHp = Math.max(0, substituteHp - hit);
      continue;
    }
    return true;
  }
  return false;
}

function adjustFirstSequentialHit(
  resolution: MoveResolution,
  targetId: string,
  adjust: (damage: number) => number,
): boolean {
  const hits = resolution.hitDamageByTarget?.[targetId];
  if (!hits || !hits.length || hits[0] <= 0) return false;
  const nextHits = [...hits];
  nextHits[0] = Math.max(0, adjust(nextHits[0]));
  setSequentialDamage(resolution, targetId, nextHits);
  return true;
}

function adjustFirstDirectSequentialHit(
  resolution: MoveResolution,
  target: PokemonState,
  targetId: string,
  adjust: (damage: number) => number,
): boolean {
  const hits = resolution.hitDamageByTarget?.[targetId];
  if (!hits || !hits.length) return false;
  let substituteHp = Math.max(0, target.substituteHp || 0);
  const nextHits = [...hits];
  for (let index = 0; index < nextHits.length; index += 1) {
    const hit = nextHits[index];
    if (hit <= 0) continue;
    if (substituteHp > 0) {
      substituteHp = Math.max(0, substituteHp - hit);
      continue;
    }
    nextHits[index] = Math.max(0, adjust(hit));
    setSequentialDamage(resolution, targetId, nextHits);
    return true;
  }
  return false;
}

function adjustFirstFatalDirectSequentialHit(
  resolution: MoveResolution,
  target: PokemonState,
  targetId: string,
  adjust: (damage: number, remainingHp: number) => number,
): boolean {
  const hits = resolution.hitDamageByTarget?.[targetId];
  if (!hits || !hits.length) return false;
  let hp = target.hp.current;
  let substituteHp = Math.max(0, target.substituteHp || 0);
  const nextHits = [...hits];
  for (let index = 0; index < nextHits.length; index += 1) {
    const hit = nextHits[index];
    if (hit <= 0) continue;
    if (substituteHp > 0) {
      substituteHp = Math.max(0, substituteHp - hit);
      continue;
    }
    if (!target.volatile?.endure && hit >= hp) {
      nextHits[index] = Math.max(0, adjust(hit, hp));
      setSequentialDamage(resolution, targetId, nextHits);
      return true;
    }
    hp = Math.max(0, hp - hit);
    if (hp <= 0) break;
  }
  return false;
}

function adjustFirstFatalFirstDirectSequentialHit(
  resolution: MoveResolution,
  target: PokemonState,
  targetId: string,
  adjust: (damage: number) => number,
): boolean {
  const hits = resolution.hitDamageByTarget?.[targetId];
  if (!hits || !hits.length) return false;
  let substituteHp = Math.max(0, target.substituteHp || 0);
  const nextHits = [...hits];
  for (let index = 0; index < nextHits.length; index += 1) {
    const hit = nextHits[index];
    if (hit <= 0) continue;
    if (substituteHp > 0) {
      substituteHp = Math.max(0, substituteHp - hit);
      continue;
    }
    if (target.volatile?.endure || hit < target.hp.current) return false;
    nextHits[index] = Math.max(0, adjust(hit));
    setSequentialDamage(resolution, targetId, nextHits);
    return true;
  }
  return false;
}

function crashDamageOnMiss(
  state: BattleState,
  actor: PokemonState,
  action: MoveAction,
  facts: ActionFacts | undefined,
  resolution: MoveResolution,
  random: () => number,
): number {
  if (state.generation === 1) return 1;
  if (state.generation === 2) return Math.max(1, Math.floor(actor.hp.max / 8));
  if (state.generation >= 5) return Math.max(1, Math.floor(actor.hp.max / 2));

  const target = action.targetIds[0] ? getPokemon(state, action.targetIds[0]) : undefined;
  if (target && isGhostType(state, target.id)) return 0;

  const sampled = totalDamage(resolution) || (facts
    ? totalDamage(sampleDamageResolution(action, facts, random))
    : 0);
  return Math.floor(sampled / 2);
}

function sampleAccuracy(
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

function moveTargetForProtection(state: BattleState, action: MoveAction): MoveTarget | undefined {
  const actor = getPokemon(state, action.actorId);
  const moveState = actor?.moves.find(move => move.name === action.moveName);
  if (moveState?.target) return moveState.target;
  try {
    return new Calc.Move(Calc.Generations.get(state.generation), action.moveName).target as MoveTarget;
  } catch {
    return undefined;
  }
}

function moveCategoryForProtection(
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

function movePriorityForProtection(state: BattleState, action: MoveAction, facts?: ActionFacts): number {
  try {
    return getActionOrderFacts(state, action).priority;
  } catch {
    return facts?.priority || 0;
  }
}

function isProtectedTarget(
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

function isDamageImmuneTarget(
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

function eligibleTargetIds(
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

function resolveSecondaryEffects(
  resolution: MoveResolution,
  state: BattleState,
  action: MoveAction,
  facts: ActionFacts,
  moveType: string | undefined,
  random: () => number,
) {
  if (!facts.secondaryEffects?.length) return;
  const attacker = getPokemon(state, action.actorId);
  const suppressesSecondaries = facts.moveCategory !== 'Status' && !!attacker &&
    hasAbility(state, attacker, 'sheerforce');
  // Serene Grace and a Rainbow stack multiplicatively (x4, capped at 100):
  // a Serene Grace user behind its own Rainbow flinches with Iron Head 100%
  // of the time, not 60%.
  let secondaryChanceMultiplier = 1;
  if (attacker && hasAbility(state, attacker, 'serenegrace')) secondaryChanceMultiplier *= 2;
  if (attacker && state.generation >= 5 &&
    state.sides[sideForPokemon(state, attacker.id)].effects?.pledgeRainbow === true) {
    secondaryChanceMultiplier *= 2;
  }
  const secondaryRolls: Record<string, number> = {};
  const secondaryTargetIds = facts.isMultiHit
    ? Array.from(new Set([
      ...action.targetIds,
      ...Object.keys(resolution.damageByTarget || {}).filter(targetId => {
        const target = getPokemon(state, targetId);
        return !!target && sequentialDamageOutcome(
          target,
          resolution.hitDamageByTarget?.[targetId],
          resolution.damageByTarget?.[targetId] || 0,
        ).hitCount > 0;
      }),
    ]))
    : action.targetIds;
  for (const targetId of secondaryTargetIds) {
    const target = getPokemon(state, targetId);
    const hitCount = facts.isMultiHit
      ? target
        ? sequentialDamageOutcome(
          target,
          resolution.hitDamageByTarget?.[targetId],
          resolution.damageByTarget?.[targetId] || 0,
        ).hitCount
        : 0
      : 1;
    for (let hitIndex = 0; hitIndex < hitCount; hitIndex += 1) {
      for (let index = 0; index < facts.secondaryEffects.length; index++) {
        const effect: SecondaryEffect = facts.secondaryEffects[index];
        if (!Number.isFinite(effect.chance) || effect.chance < 0 || effect.chance > 100) {
          throw new Error('Secondary effect chance must be a percentage from 0 to 100');
        }
        const roll = random();
        if (!Number.isFinite(roll)) throw new Error('Secondary sampler must return a finite number');
        const bounded = Math.max(0, Math.min(0.999999999999, roll));
        const rollKey = facts.isMultiHit && resolution.hitDamageByTarget?.[targetId] !== undefined
          ? `${targetId}:${index}:hit${hitIndex + 1}`
          : `${targetId}:${index}`;
        secondaryRolls[rollKey] = roll;
        const chance = Math.min(100, effect.chance * secondaryChanceMultiplier);
        if (suppressesSecondaries || bounded >= chance / 100) continue;

        const recipientId = effect.target === 'self' ? action.actorId : targetId;
        // Shield Dust and Covert Cloak block opposing additional effects, not
        // self-inflicted secondary boosts/statuses from the holder's own move.
        if (recipientId !== action.actorId && blocksSecondaryEffects(state, recipientId)) continue;
        const statusChoiceRoll = effect.statusChoices && effect.statusChoices.length
          ? sampleActionRoll(random, 'Secondary status choice')
          : undefined;
        const selectedStatus = effect.statusChoices && effect.statusChoices.length && statusChoiceRoll !== undefined
          ? effect.statusChoices[Math.floor(statusChoiceRoll * effect.statusChoices.length)]
          : effect.status;
        const statusAlreadyResolved = Object.prototype.hasOwnProperty.call(
          resolution.statusByPokemon || {}, recipientId,
        ) && resolution.statusByPokemon?.[recipientId] !== '';
        if (selectedStatus && !statusAlreadyResolved && canApplyMajorStatus(
          state,
          action.actorId,
          recipientId,
          selectedStatus,
          moveType,
          false,
          false,
          facts.moveCategory || 'Physical',
        )) {
          addStatus(resolution, state, [recipientId], selectedStatus);
          if (selectedStatus === 'slp' && resolution.statusByPokemon?.[recipientId] !== '') {
            setStatusTurns(resolution, recipientId, Math.floor(sampleActionRoll(random, 'Sleep duration') * 3) + 2);
          }
        }
        if (effect.boosts) addBoosts(
          resolution,
          state,
          recipientId,
          effect.boosts,
          action.actorId,
          true,
          ignoresTargetAbility(state, action.actorId, recipientId, facts.moveCategory || 'Physical'),
        );
        const volatileAlreadyResolved = !!effect.volatile &&
          !!resolution.volatileByPokemon?.[recipientId]?.[effect.volatile.name];
        if (effect.volatile && !volatileAlreadyResolved && canApplyVolatile(
          state,
          recipientId,
          effect.volatile.name,
          action.actorId,
          false,
          facts.moveCategory || 'Physical',
        )) {
          const turns = effect.volatile.name === 'confusion' && effect.volatile.turns === undefined
            ? Math.floor(sampleActionRoll(random, 'Confusion duration') * 4) + 2
            : effect.volatile.name === 'flinch' && effect.volatile.turns === undefined
              ? 1
              : effect.volatile.turns;
          addVolatile(resolution, [recipientId], effect.volatile.name, {
            turns,
            moveName: effect.volatile.moveName,
          });
        }
      }
    }
  }
  resolution.trace = {
    ...(resolution.trace || {source: 'battle-engine' as const}),
    secondaryRolls,
  };
}

/**
 * Derive the state-representable portion of common move effects. This is a
 * deliberately small battle-engine slice: it resolves source-aware move
 * accuracy, common target eligibility, and supported secondary effects, but
 * leaves uncommon/uncertain accuracy modifiers to the caller. Common deterministic volatile and
 * duration-backed effects are represented here; callers can pass `hit: false`
 * or richer effects through MoveResolution when those rules are resolved
 * elsewhere.
 */
export function deriveMoveResolution(
  state: BattleState,
  action: MoveAction,
  options: MoveEngineOptions = {},
): MoveResolution {
  const actor = getPokemon(state, action.actorId);
  if (!actor) throw new Error('Move action references an unknown attacker');
  const actorSide = sideForPokemon(state, actor.id);
  const foeSide = otherSide(actorSide);
  const id = moveId(action.moveName);
  const pendingPledge = state.pendingPledgeBySide?.[actorSide];
  const combinedPledge = state.generation >= 5 && !!pendingPledge &&
    !pendingPledge.useZ && !pendingPledge.useMax && !action.useZ && !action.useMax &&
    pledgeCombination(pendingPledge.moveName, action.moveName);
  const pledgePartner = state.mode === 'Doubles'
    ? state.sides[actorSide].activeIds
      .filter(partnerId => partnerId !== actor.id)
      .map(partnerId => getPokemon(state, partnerId))
      .find((partner): partner is PokemonState => !!partner && partner.hp.current > 0)
    : undefined;
  const partnerIntent = pledgePartner ? state.selectedMoveByPokemon?.[pledgePartner.id] : undefined;
  const startsPledge = state.generation >= 5 && !pendingPledge && !!partnerIntent &&
    !action.useZ && !action.useMax && !partnerIntent.useZ && !partnerIntent.useMax &&
    !!pledgeCombination(action.moveName, partnerIntent.moveName);
  if (id === 'ragingfury' && state.generation < 9) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} is unavailable before Generation IX`],
      },
    };
  }
  if (id === 'geomancy' && state.generation < 6) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} is unavailable before Generation VI`],
      },
    };
  }
  if (id === 'electroshot' && state.generation < 9) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} is unavailable before Generation IX`],
      },
    };
  }
  if (id === 'vcreate' && state.generation < 5) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} is unavailable before Generation V`],
      },
    };
  }
  if (id === 'hyperspacefury' && state.generation < 6) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} is unavailable before Generation VI`],
      },
    };
  }
  if (id === 'diamondstorm' && state.generation < 6) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} is unavailable before Generation VI`],
      },
    };
  }
  if (id === 'tarshot' && state.generation < 8) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} is unavailable before Generation VIII`],
      },
    };
  }
  if (id === 'orderup' && state.generation < 9) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} is unavailable before Generation IX`],
      },
    };
  }
  if ((id === 'anchorshot' || id === 'spiritshackle') && state.generation < 7) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} is unavailable before Generation VII`],
      },
    };
  }
  if (id === 'throatchop' && state.generation < 7) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} is unavailable before Generation VII`],
      },
    };
  }
  if (id === 'burningjealousy' && state.generation < 8) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} is unavailable before Generation VIII`],
      },
    };
  }
  if (id === 'gigatonhammer' && state.generation < 9) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} is unavailable before Generation IX`],
      },
    };
  }
  if (id === 'scaleshot' && state.generation < 8) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} is unavailable before Generation VIII`],
      },
    };
  }
  if (id === 'echoedvoice' && state.generation < 5) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} is unavailable before Generation V`],
      },
    };
  }
  if (id === 'furycutter' && state.generation < 2) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} is unavailable before Generation II`],
      },
    };
  }
  if (id === 'burnup' && state.generation < 7) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} is unavailable before Generation VII`],
      },
    };
  }
  if (id === 'doubleshock' && state.generation < 9) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} is unavailable before Generation IX`],
      },
    };
  }
  if (id === 'relicsong' && state.generation < 5) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} is unavailable before Generation V`],
      },
    };
  }
  if (id === 'glaiverush' && state.generation < 9) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} is unavailable before Generation IX`],
      },
    };
  }
  const chargeState = actor.volatile?.charge;
  if (chargeState?.targetIds) action = {...action, targetIds: [...chargeState.targetIds]};
  const moveState = actor.moves.find(move => move.name === action.moveName);
  const moveMetadata = moveState
    ? getEffectiveMoveMetadata(moveState, state.generation)
    : getMoveMetadata(action.moveName, state.generation);
  const random = options.random || Math.random;
  const accuracy = id === 'nightmare' && state.generation === 2
    ? true
    : options.accuracy ?? options.facts?.moveAccuracy ?? moveMetadata.accuracy;
  const secondaryEffects = options.secondaryEffects ?? options.facts?.secondaryEffects ?? moveMetadata.secondaryEffects;
  const moveType = options.facts?.moveType ?? moveMetadata.type;
  const moveCategory = options.facts?.moveCategory ?? moveMetadata.category;
  if (isTruantActive(state, actor) && actor.volatile?.truant) {
    return {
      hit: false,
      actionFailure: 'truant',
      volatileByPokemon: {[actor.id]: {truant: null}},
      trace: {
        source: 'battle-engine',
        hit: false,
        actionFailure: 'truant',
        notes: [`${actor.id} loafed around because of Truant`],
      },
    };
  }
  const gate = actionFailure(state, actor, id, random);
  if (actor.volatile?.recharge && id === moveId(actor.volatile.recharge.moveName)) {
    return {
      hit: false,
      volatileByPokemon: {[actor.id]: {recharge: null}},
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${actor.id} spent the turn recharging after ${actor.volatile.recharge.moveName}`],
      },
    };
  }
  if (gate.failure) {
    const resolution: MoveResolution = {
      hit: false,
      actionFailure: gate.failure,
      volatileByPokemon: gate.failure === 'flinch' ? {[actor.id]: {flinch: null}} : undefined,
      trace: {
        source: 'battle-engine',
        hit: false,
        actionFailure: gate.failure,
        notes: [`actor failed to act: ${gate.failure}`],
      },
    };
    if (gate.sleepTurns !== undefined) {
      resolution.statusTurnsByPokemon = {[actor.id]: gate.sleepTurns};
      resolution.trace!.notes!.push('sleep counter burned on the attempt');
    }
    if (gate.failure === 'confusion' && options.facts?.confusionDamage) {
      const damage = sampleDamageFact(options.facts.confusionDamage, random);
      if (damage > 0) addHpDelta(resolution, actor.id, -damage);
      resolution.trace!.damageRollsByTarget = {[actor.id]: damage};
      resolution.trace!.notes!.push('sampled calculator confusion self-damage');
    }
    return resolution;
  }
  if (!isFirstTurnMoveAvailable(state, actor, id)) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} failed because it can only be used on the actor's first turn out`],
      },
    };
  }
  if (state.generation >= 6 && moveCategory === 'Status' &&
    isItemEffectActive(state, actor) && moveId(actor.item) === 'assaultvest') {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} failed because Assault Vest prevents status moves`],
      },
    };
  }
  if (id === 'steelroller' && state.generation >= 8 && !state.field.terrain) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: ['Steel Roller failed because no Terrain was active'],
      },
    };
  }
  if (id === 'fling' && !canUseFling(state, actor)) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} failed because the actor cannot use its held item`],
      },
    };
  }
  if (id === 'naturalgift' && !canUseNaturalGift(state, actor)) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} failed because the actor cannot use a held Berry`],
      },
    };
  }
  if (id === 'focuspunch' && state.generation < 3) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} is unavailable before Generation III`],
      },
    };
  }
  const focusPunchDamage = id === 'focuspunch'
    ? state.lastDamageTakenByPokemon?.[actor.id]
    : undefined;
  if (id === 'focuspunch' && focusPunchDamage?.turn === state.turn) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} failed because ${actor.id} was hit earlier this turn`],
      },
    };
  }
  if (id === 'shedtail' && state.generation >= 9) {
    const cost = Math.floor(actor.hp.max / 2);
    const failure = actor.hp.current <= cost
      ? `${action.moveName} failed because the actor lacks enough HP`
      : hasSubstitute(state, actor.id)
        ? `${action.moveName} failed because the actor already has a Substitute`
        : !canRequestMoveSwitch(state, actor)
          ? `${action.moveName} failed because no legal replacement was available`
          : undefined;
    if (failure) {
      return {
        hit: false,
        trace: {source: 'battle-engine', hit: false, notes: [failure]},
      };
    }
  }
  if (id === 'corrosivegas' && state.generation < 8) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} is unavailable before Generation VIII`],
      },
    };
  }
  if ((id === 'followme' && state.generation < 3) || (id === 'ragepowder' && state.generation < 4)) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} is unavailable in Generation ${state.generation}`],
      },
    };
  }
  if (id === 'allyswitch' && (state.generation < 6 || !hasActiveAlly(state, actor))) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} requires a live ally in a Generation VI+ Doubles battle`],
      },
    };
  }
  if (id === 'spotlight' && (state.generation < 7 || state.mode !== 'Doubles')) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} requires a Generation VII+ Doubles battle`],
      },
    };
  }
  if (id === 'magiccoat' && state.generation < 4) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} is unavailable before Generation IV`],
      },
    };
  }
  if (id === 'snatch' && (state.generation < 3 || state.generation >= 8)) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} cannot be selected in Generation ${state.generation}`],
      },
    };
  }
  if ((id === 'rollout' && state.generation < 2) || (id === 'iceball' && state.generation < 3)) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} is unavailable in Generation ${state.generation}`],
      },
    };
  }
  if (RECHARGE_MOVE_MIN_GENERATION[id] !== undefined &&
    state.generation < RECHARGE_MOVE_MIN_GENERATION[id]) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} is unavailable in Generation ${state.generation}`],
      },
    };
  }
  if (CHARGE_MOVE_MIN_GENERATION[id] !== undefined &&
    state.generation < CHARGE_MOVE_MIN_GENERATION[id]) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} is unavailable in Generation ${state.generation}`],
      },
    };
  }
  if (UPROAR_MOVE_MIN_GENERATION[id] !== undefined &&
    state.generation < UPROAR_MOVE_MIN_GENERATION[id]) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} is unavailable in Generation ${state.generation}`],
      },
    };
  }
  if ((id === 'lockon' || id === 'mindreader') && state.generation < 2) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} is unavailable before Generation II`],
      },
    };
  }
  if (id === 'outrage' && state.generation < 2) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} is unavailable before Generation II`],
      },
    };
  }
  if ((id === 'ragefist' || id === 'lastrespects') && state.generation < 9) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} is unavailable before Generation IX`],
      },
    };
  }
  if (id === 'nightmare' && (state.generation < 2 || state.generation >= 8)) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} is unavailable in Generation ${state.generation}`],
      },
    };
  }
  if (id === 'dreameater' && !action.targetIds.some(targetId => getPokemon(state, targetId)?.status === 'slp')) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} failed because the target is not asleep`],
      },
    };
  }
  if (id === 'curse' && state.generation < CURSE_MOVE_MIN_GENERATION) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} is unavailable before Generation II`],
      },
    };
  }
  if (id === 'electrify' && state.generation < 6) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} is unavailable before Generation VI`],
      },
    };
  }
  if (id === 'shelltrap' && state.generation < SHELL_TRAP_MIN_GENERATION) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} is unavailable before Generation VII`],
      },
    };
  }
  if (['sleeptalk', 'snore'].includes(id) && (actor.status !== 'slp' || actor.statusTurns === 0)) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} failed because the actor is not asleep`],
      },
    };
  }
  if (id === 'octolock' && state.generation < 8) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} is unavailable before Generation VIII`],
      },
    };
  }
  if (id === 'miracleeye' && state.generation < 4) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} is unavailable before Generation IV`],
      },
    };
  }
  if (PROTECTION_MOVE_MIN_GENERATION[id] !== undefined &&
    state.generation < PROTECTION_MOVE_MIN_GENERATION[id]) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} is unavailable before Generation ${PROTECTION_MOVE_MIN_GENERATION[id]}`],
      },
    };
  }
  if (actor.volatile?.rollout && moveId(actor.volatile.rollout.moveName) !== id) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} failed because ${actor.id} is locked into ${actor.volatile.rollout.moveName}`],
      },
    };
  }
  if (actor.volatile?.recharge && moveId(actor.volatile.recharge.moveName) !== id) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} failed because ${actor.id} must recharge after ${actor.volatile.recharge.moveName}`],
      },
    };
  }
  if (actor.volatile?.rampage && moveId(actor.volatile.rampage.moveName) !== id) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} failed because ${actor.id} is locked into ${actor.volatile.rampage.moveName}`],
      },
    };
  }
  if ((id === 'mirrorcoat' && state.generation < 2) || (id === 'metalburst' && state.generation < 4)) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} is unavailable in Generation ${state.generation}`],
      },
    };
  }
  if ((['wideguard', 'quickguard'].includes(id) && state.generation < 5) ||
    (id === 'matblock' && (state.generation < 6 ||
      (state.firstTurnOutIds !== undefined && !state.firstTurnOutIds.includes(actor.id))))) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} is unavailable in this battle state`],
      },
    };
  }
  if (id === 'followme' && state.generation >= 8 && state.mode === 'Singles') {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: ['Follow Me fails in Singles from Generation VIII onward'],
      },
    };
  }
  if (id === 'telekinesis' && state.generation >= 5 && state.field.gravity) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: ['Telekinesis failed because Gravity was active'],
      },
    };
  }
  const fieldSetterFailure = fieldSetterNoOpReason(state, action.moveName);
  if (fieldSetterFailure) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [fieldSetterFailure],
      },
    };
  }
  const selfFailure = selfMoveFailure(state, actor, id);
  if (selfFailure) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [selfFailure],
      },
    };
  }
  const targetFailure = targetMoveFailure(state, actor, id, action.targetIds);
  if (targetFailure) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [targetFailure],
      },
    };
  }
  const fieldFailure = fieldMoveFailure(state, actor, id);
  if (fieldFailure) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [fieldFailure],
      },
    };
  }
  if (state.generation >= 4 && !action.useZ && !action.useMax && actor.volatile?.healBlock &&
    HEAL_BLOCKED_MOVES.has(id)) {
    return {
      hit: false,
      trace: {
        source: 'battle-engine',
        hit: false,
        notes: [`${action.moveName} failed because Heal Block was active`],
      },
    };
  }
  const resolutionFacts = options.facts || accuracy !== undefined || secondaryEffects !== undefined
    ? {
      ...(options.facts || {}),
      moveAccuracy: accuracy,
      secondaryEffects,
    }
    : undefined;
  const accuracySamples: Record<string, ReturnType<typeof sampleAccuracy> & {
    multiplier: number;
    modifiers: string[];
  }> = {};
  if (options.hit === undefined && accuracy !== undefined) {
    const accuracyTargetIds = action.targetIds.length ? action.targetIds : [action.actorId];
    for (const targetId of accuracyTargetIds) {
      const effective = getEffectiveMoveAccuracy(
        state,
        // Accuracy modifiers are resolved per target. In particular,
        // Lock-On/Mind Reader only guarantees the locked target of a spread
        // move, not every target in the action's target list.
        {...action, targetIds: [targetId]},
        accuracy,
        moveCategory,
        options.facts?.attackerSpeed,
        targetId === action.targetIds[0] ? options.facts?.defenderSpeed : undefined,
      );
      accuracySamples[targetId] = {
        ...sampleAccuracy(effective.accuracy, random),
        multiplier: effective.multiplier,
        modifiers: effective.modifiers,
      };
    }
  }
  const sampledAccuracy = accuracySamples[action.targetIds[0] || action.actorId];
  const missedAccuracyIds = action.targetIds.filter(targetId => accuracySamples[targetId]?.hit === false);
  const sampledHits = Object.values(accuracySamples);
  const hit = options.hit === undefined
    ? (sampledHits.length ? sampledHits.some(sample => sample.hit) : true)
    : options.hit;
  const resolution: MoveResolution = {
    hit,
    trace: {
      source: 'battle-engine',
      hit,
      accuracyBase: accuracy,
      accuracyRoll: sampledAccuracy?.roll,
      accuracyThreshold: sampledAccuracy?.threshold,
      accuracyMultiplier: sampledAccuracy?.multiplier,
      accuracyModifiers: sampledAccuracy?.modifiers,
      accuracyRollsByTarget: action.targetIds.length > 1
        ? Object.fromEntries(Object.entries(accuracySamples)
          .filter(([, sample]) => sample.roll !== undefined)
          .map(([targetId, sample]) => [targetId, sample.roll as number]))
        : undefined,
      accuracyThresholdsByTarget: action.targetIds.length > 1
        ? Object.fromEntries(Object.entries(accuracySamples).map(([targetId, sample]) => [targetId, sample.threshold]))
        : undefined,
      notes: [
        'derived common move effects',
        ...(accuracy === undefined ? ['accuracy metadata unavailable; treated as a hit'] : []),
      ],
    },
  };
  if (isMicleBerryReady(state, action, accuracy)) {
    clearVolatile(resolution, actor.id, 'micleBerry');
    resolution.trace!.notes!.push('Micle Berry boosted move accuracy and was consumed');
  }
  const stanceSpecies = stanceChangeSpecies(state, actor, action.moveName, moveCategory);
  if (stanceSpecies && moveId(getEffectiveSpecies(actor)) !== moveId(stanceSpecies)) {
    setSpeciesOverride(resolution, actor.id, stanceSpecies);
    resolution.trace!.notes!.push(`Stance Change changed ${actor.id} to ${stanceSpecies}`);
  }
  const typeChange = getTypeChangeResolution(state, action, actor);
  if (typeChange) {
    setTypeOverride(resolution, actor.id, typeChange.types);
    if (typeChange.used) setTypeChangeUsed(resolution, actor.id, true);
    resolution.trace!.notes!.push(`Type-changing ability changed ${actor.id}'s type to ${typeChange.types.join('/')}`);
  }
  if (isTruantActive(state, actor)) {
    resolution.volatileByPokemon = {[actor.id]: {truant: {}}};
    resolution.trace!.notes!.push('Truant armed the next-turn loafing state');
  }
  if (actor.volatile?.furyCutter && id !== 'furycutter') {
    clearVolatile(resolution, actor.id, 'furyCutter');
    resolution.trace!.notes!.push(`${action.moveName} reset Fury Cutter's consecutive-use power`);
  }
  if (state.generation >= 8 && (id === 'dive' || (id === 'surf' && resolution.hit !== false)) &&
    !actor.isDynamaxed && !action.useMax && moveId(actor.species) === 'cramorant' &&
    isAbilityActive(actor, state) && isAbilityAvailable(state.generation, getEffectiveAbility(actor)) &&
    moveId(getEffectiveAbility(actor)) === 'gulpmissile') {
    const form = actor.hp.current > actor.hp.max / 2 ? 'Cramorant-Gulping' : 'Cramorant-Gorging';
    setSpeciesOverride(resolution, actor.id, form);
    resolution.trace!.notes!.push(`Gulp Missile changed ${actor.id} to ${form}`);
  }
  const callerProvidedAccuracy = options.accuracy !== undefined || options.facts?.moveAccuracy !== undefined;
  const accuracyMiss = missedAccuracyIds.length > 0 ||
    (options.hit === false && callerProvidedAccuracy && accuracy !== true);
  activateBlunderPolicy(resolution, state, actor, accuracyMiss);

  const powerHerbBypass = state.generation >= 4 && !chargeState &&
    isItemEffectActive(state, actor) && moveId(actor.item) === 'powerherb';
  const weatherBypass = !chargeState &&
    (((id === 'solarbeam' || id === 'solarblade') && isSunWeather(state.field.weather)) ||
      (id === 'electroshot' && isRainWeather(state.field.weather))) &&
    !isWeatherSuppressed(state);
  if (id === 'geomancy' && state.generation >= 6) {
    if (resolution.hit === false) return resolution;
    if (chargeState) {
      clearVolatile(resolution, actor.id, 'charge');
      addBoosts(resolution, state, actor.id, {spa: 2, spd: 2, spe: 2}, actor.id);
      resolution.trace!.notes!.push(`${action.moveName} released and raised Special Attack, Special Defense, and Speed`);
      return resolution;
    }
    if (powerHerbBypass) {
      consumeItem(resolution, actor.id, actor.item!);
      addBoosts(resolution, state, actor.id, {spa: 2, spd: 2, spe: 2}, actor.id);
      resolution.trace!.notes!.push(`${action.moveName} used Power Herb to skip its charge turn`);
      return resolution;
    }
    addVolatile(resolution, [actor.id], 'charge', {
      turns: 2,
      moveName: action.moveName,
      targetIds: [actor.id],
    });
    resolution.trace!.notes!.push(`${action.moveName} began charging for the following turn`);
    return resolution;
  }
  if (CHARGE_MOVE_MIN_GENERATION[id] !== undefined && !chargeState &&
    !powerHerbBypass && !weatherBypass && options.hit !== false) {
    addVolatile(resolution, [actor.id], 'charge', {
      turns: 2,
      moveName: action.moveName,
      targetIds: [...action.targetIds],
    });
    if (id === 'skullbash') addBoosts(resolution, state, actor.id, {def: 1}, actor.id);
    if (id === 'meteorbeam') addBoosts(resolution, state, actor.id, {spa: 1}, actor.id);
    resolution.trace!.notes!.push(`${action.moveName} began charging for the following turn`);
    return resolution;
  }
  if (id === 'electroshot' && state.generation >= 9 && resolution.hit !== false &&
    (powerHerbBypass || weatherBypass)) {
    if (powerHerbBypass) consumeItem(resolution, actor.id, actor.item!);
    addBoosts(resolution, state, actor.id, {spa: 1}, actor.id);
    resolution.trace!.notes!.push(`${action.moveName} skipped its charge turn and raised Special Attack`);
  }
  if (chargeState) {
    clearVolatile(resolution, actor.id, 'charge');
    if (id === 'electroshot' && state.generation >= 9 && resolution.hit !== false) {
      addBoosts(resolution, state, actor.id, {spa: 1}, actor.id);
      resolution.trace!.notes!.push(`${action.moveName} released and raised Special Attack`);
    }
    resolution.trace!.notes!.push(`${action.moveName} released after its charge turn`);
  }
  const lockOnState = actor.volatile?.lockOn;
  if (lockOnState && id !== 'lockon' && id !== 'mindreader') {
    clearVolatile(resolution, actor.id, 'lockOn');
    resolution.trace!.notes!.push(`${action.moveName} consumed Lock-On/Mind Reader accuracy`);
  }

  if (gate.sleepTurns !== undefined) {
    resolution.statusTurnsByPokemon = {[actor.id]: gate.sleepTurns};
  }
  if (gate.clearStatus) {
    resolution.statusByPokemon = {[actor.id]: ''};
    resolution.statusTurnsByPokemon = {[actor.id]: null};
    resolution.toxicCounterByPokemon = {[actor.id]: 0};
    resolution.trace!.notes!.push('actor thawed and cleared freeze');
  } else if (gate.wake) {
    resolution.statusByPokemon = {[actor.id]: ''};
    resolution.statusTurnsByPokemon = {[actor.id]: null};
    resolution.toxicCounterByPokemon = {[actor.id]: 0};
    resolution.trace!.notes!.push('actor woke on the attempt and acted');
  } else if (actor.status === 'slp' && actor.statusTurns === 0) {
    resolution.statusByPokemon = {[actor.id]: ''};
    resolution.statusTurnsByPokemon = {[actor.id]: null};
    resolution.toxicCounterByPokemon = {[actor.id]: 0};
    resolution.trace!.notes!.push('actor woke before acting');
  }

  if (id === 'fling' && canUseFling(state, actor)) {
    consumeItem(resolution, actor.id, actor.item!);
    resolution.trace!.notes!.push('Fling consumed the actor item');
  }

  if (CHARGE_MOVE_MIN_GENERATION[id] !== undefined && powerHerbBypass && id !== 'electroshot') {
    consumeItem(resolution, actor.id, actor.item!);
    resolution.trace!.notes!.push(`${action.moveName} used Power Herb to skip its charge turn`);
  }

  if (id === 'orderup' && state.generation >= 9 && moveId(actor.species) === 'dondozo') {
    const commanderId = actor.volatile?.commanded?.sourceId;
    const tatsugiri = commanderId ? getPokemon(state, commanderId) : undefined;
    const tatsugiriSpecies = tatsugiri ? moveId(getEffectiveSpecies(tatsugiri)) : '';
    const stat = tatsugiriSpecies.includes('curly')
      ? 'atk'
      : tatsugiriSpecies.includes('droopy')
        ? 'def'
        : tatsugiriSpecies.includes('stretchy')
          ? 'spe'
          : undefined;
    if (stat) {
      addBoosts(resolution, state, actor.id, {[stat]: 1}, actor.id);
      resolution.trace!.notes!.push(`${action.moveName} raised ${actor.id}'s ${stat} from Commander form`);
    }
  }

  if (hit === false) {
    if (id === 'furycutter' && actor.volatile?.furyCutter) {
      clearVolatile(resolution, actor.id, 'furyCutter');
      resolution.trace!.notes!.push(`${action.moveName} missed and reset its consecutive-use power`);
    }
    if ((id === 'rollout' || id === 'iceball') && actor.volatile?.rollout) {
      clearVolatile(resolution, actor.id, 'rollout');
      resolution.trace!.notes!.push(`${action.moveName} interrupted and its consecutive sequence ended`);
    }
    if (id === 'naturalgift' && canUseNaturalGift(state, actor)) {
      consumeItem(resolution, actor.id, actor.item!);
      resolution.trace!.notes!.push('Natural Gift consumed the actor Berry');
    }
    const hpEffects = getMoveHpEffects(state.generation, action.moveName);
    if (hpEffects.crashDamage) {
      const crashDamage = crashDamageOnMiss(state, actor, action, options.facts, resolution, random);
      if (crashDamage > 0) addHpDelta(resolution, actor.id, -crashDamage);
    }
    return resolution;
  }

  if (id === 'shelltrap') {
    addVolatile(resolution, [actor.id], 'shellTrap', {turns: 1});
    resolution.trace!.notes!.push(`${action.moveName} armed a one-turn contact trap`);
    return resolution;
  }

  const eligibility = eligibleTargetIds(state, action, id, resolutionFacts, missedAccuracyIds);
  const targetIds = eligibility.targetIds;
  const actionForTargets = {...action, targetIds};
  const priorityBlockedIds = action.targetIds.filter(targetId => {
    const target = getPokemon(state, targetId);
    return !!target && isPriorityBlocked(
      state,
      action.actorId,
      targetId,
      movePriorityForProtection(state, action, resolutionFacts),
      moveCategory,
    );
  });
  // Sound moves and copy/field-inspection moves bypass Substitute. Soundproof
  // blocks the entire sound move unless the attacker suppresses abilities.
  const bypassesSubstitute = !!moveMetadata.sound ||
    ['conversion2', 'mimic', 'sketch', 'haze', 'flowershield', 'rototiller', 'teatime'].includes(id);
  const originalEffectTargetIds = targetIds.filter(targetId => {
    const target = getPokemon(state, targetId);
    const soundBlocked = !!moveMetadata.sound && !!target && hasAbility(state, target, 'soundproof') &&
      !ignoresTargetAbility(state, actor.id, targetId, moveCategory);
    return targetId === actor.id || soundBlocked === false && (bypassesSubstitute || !hasSubstitute(state, targetId));
  });
  const reflectedTargetIds = moveCategory === 'Status'
    ? originalEffectTargetIds.filter(targetId => {
      const target = getPokemon(state, targetId);
      return !!target && target.id !== actor.id && sideForPokemon(state, target.id) !== actorSide &&
        !!target.volatile?.magicCoat && id !== 'nightmare';
    })
    : [];
  const magicBounceTargetIds = state.generation >= 5 && moveCategory === 'Status' && moveMetadata.reflectable
    ? originalEffectTargetIds.filter(targetId => {
      const target = getPokemon(state, targetId);
      return !!target && !reflectedTargetIds.includes(targetId) && target.id !== actor.id &&
        sideForPokemon(state, target.id) !== actorSide && hasAbility(state, target, 'magicbounce') &&
        !ignoresTargetAbility(state, actor.id, target.id, moveCategory) &&
        !SEMI_INVULNERABLE_CHARGE_MOVES.has(moveId(target.volatile?.charge?.moveName || ''));
    })
    : [];
  const reflectedTargetSet = new Set([...reflectedTargetIds, ...magicBounceTargetIds]);
  let effectTargetIds = Array.from(new Set(originalEffectTargetIds.map(targetId =>
    reflectedTargetSet.has(targetId) ? actor.id : targetId)));
  for (const targetId of reflectedTargetIds) {
    clearVolatile(resolution, targetId, 'magicCoat');
    resolution.trace!.notes!.push(`Magic Coat reflected ${action.moveName} from ${targetId} to ${actor.id}`);
  }
  for (const targetId of magicBounceTargetIds) {
    resolution.trace!.notes!.push(`Magic Bounce reflected ${action.moveName} from ${targetId} to ${actor.id}`);
  }
  const snatcher = state.generation < 8 && !action.useZ && !action.useMax &&
    moveCategory === 'Status' && moveMetadata.snatchable
    ? snatchUser(state, actor.id)
    : undefined;
  if (snatcher) {
    effectTargetIds = snatchEffectTargets(state, snatcher, moveMetadata.target, id, actor.id);
    const consumedSnatchers = state.generation <= 4
      ? snatchUsers(state, actor.id)
      : [snatcher];
    for (const consumedSnatcher of consumedSnatchers) {
      clearVolatile(resolution, consumedSnatcher.id, 'snatch');
    }
    resolution.trace!.notes!.push(`Snatch stole ${action.moveName} for ${snatcher.id}`);
  }
  const magicBounceActor = magicBounceTargetIds[0] ? getPokemon(state, magicBounceTargetIds[0]) : undefined;
  const effectActor = magicBounceActor || snatcher || actor;
  const effectActorId = effectActor.id;
  const effectActorSide = sideForPokemon(state, effectActorId);
  const actionForEffects = {...action, actorId: effectActorId, targetIds: effectTargetIds};
  if (state.generation >= 9 && moveMetadata.wind) {
    for (const targetId of action.targetIds) {
      const target = getPokemon(state, targetId);
      if (!target || target.hp.current <= 0 || target.id === actor.id ||
        sideForPokemon(state, target.id) === actorSide ||
        eligibility.protectedIds.includes(targetId) || missedAccuracyIds.includes(targetId) ||
        ignoresTargetAbility(state, actor.id, targetId, moveCategory) ||
        !hasAbility(state, target, 'windrider')) continue;
      addBoosts(resolution, state, target.id, {atk: 1}, target.id);
      resolution.trace!.notes!.push(`Wind Rider raised ${target.id}'s Attack`);
    }
  }
  if (state.generation >= 9 && actor.volatile?.charged &&
    moveType === 'Electric' && moveCategory !== 'Status') {
    clearVolatile(resolution, actor.id, 'charged');
    resolution.trace!.notes!.push(`${action.moveName} consumed the Charged state`);
  }
  if (actor.volatile?.electrified && id !== 'electrify') {
    clearVolatile(resolution, actor.id, 'electrified');
    resolution.trace!.notes!.push(`${action.moveName} consumed Electrify on ${actor.id}`);
  }
  if (actor.volatile?.throatChop && moveMetadata.sound) {
    return {
      ...resolution,
      hit: false,
      trace: {
        ...(resolution.trace || {source: 'battle-engine' as const}),
        hit: false,
        notes: [...(resolution.trace?.notes || []), `${action.moveName} was blocked by Throat Chop`],
      },
    };
  }
  if (id === 'electrify') {
    addEligibleVolatile(resolution, state, effectTargetIds, 'electrified', {turns: 1}, effectActorId, true);
  }
  if (id === 'octolock') {
    const octolockTargets = effectTargetIds.filter(targetId => {
      const target = getPokemon(state, targetId);
      return !!target && !target.volatile?.trapped &&
        canApplyVolatile(state, targetId, 'octolock', effectActorId, true);
    });
    if (!octolockTargets.length) {
      return {
        ...resolution,
        hit: false,
        trace: {
          ...(resolution.trace || {source: 'battle-engine' as const}),
          hit: false,
          notes: [...(resolution.trace?.notes || []), 'Octolock failed because no target could be trapped'],
        },
      };
    }
    addVolatile(resolution, octolockTargets, 'octolock', {sourceId: effectActorId});
    addVolatile(resolution, octolockTargets, 'trapped', {sourceId: effectActorId});
  }
  if (id === 'nightmare') {
    const nightmareTargets = effectTargetIds.filter(targetId =>
      canApplyVolatile(state, targetId, 'nightmare', effectActorId, true));
    if (!nightmareTargets.length) {
      return {
        ...resolution,
        hit: false,
        trace: {
          ...(resolution.trace || {source: 'battle-engine' as const}),
          hit: false,
          notes: [...(resolution.trace?.notes || []), 'Nightmare failed because no target was asleep'],
        },
      };
    }
    addVolatile(resolution, nightmareTargets, 'nightmare');
  }
  if (priorityBlockedIds.length) {
    const source = state.field.terrain === 'Psychic'
      ? 'Psychic Terrain'
      : 'priority-blocking ability';
    resolution.trace!.notes!.push(`blocked by ${source}: ${priorityBlockedIds.join(', ')}`);
  }
  if (eligibility.protectedIds.length) {
    resolution.trace!.notes!.push(`blocked by Protect: ${eligibility.protectedIds.join(', ')}`);
  }
  if (eligibility.immuneIds.length) {
    resolution.trace!.notes!.push(`immune targets: ${eligibility.immuneIds.join(', ')}`);
  }
  if (missedAccuracyIds.length) {
    resolution.trace!.notes!.push(`missed accuracy check: ${missedAccuracyIds.join(', ')}`);
  }

  if (id === 'bide') {
    const bideState = actor.volatile?.bide;
    if (!bideState) {
      const turns = state.generation === 1
        ? Math.floor(sampleActionRoll(random, 'Bide duration') * 2) + 2
        : state.generation === 2
          ? Math.floor(sampleActionRoll(random, 'Bide duration') * 2) + 3
          : 2;
      addVolatile(resolution, [actor.id], 'bide', {turns, damage: 0});
      resolution.trace!.notes!.push(`${action.moveName} began storing damage for ${turns} turns`);
      return resolution;
    }
    if ((bideState.turns || 0) > 1) {
      resolution.trace!.notes!.push(`${action.moveName} continued storing ${bideState.damage || 0} damage`);
      return resolution;
    }

    clearVolatile(resolution, actor.id, 'bide');
    const storedDamage = bideState.damage || 0;
    const candidateTargetIds = [bideState.sourceId, ...action.targetIds].filter(
      (targetId, index, ids): targetId is string => !!targetId && ids.indexOf(targetId) === index,
    );
    const targetId = candidateTargetIds.find(candidateId => {
      const target = getPokemon(state, candidateId);
      if (!target || target.hp.current <= 0 || sideForPokemon(state, candidateId) === actorSide) return false;
      return state.sides[sideForPokemon(state, candidateId)].activeIds.includes(candidateId);
    });
    if (!storedDamage || !targetId) {
      resolution.trace!.notes!.push(`${action.moveName} failed because no damage was stored`);
      return resolution;
    }
    resolution.damageByTarget = {[targetId]: storedDamage * 2};
    resolution.trace!.notes!.push(`${action.moveName} released ${storedDamage * 2} fixed damage at ${targetId}`);
    return resolution;
  }

  const itemFailure = itemMoveFailure(
    state,
    actor,
    effectTargetIds[0] ? getPokemon(state, effectTargetIds[0]) : undefined,
    id,
  );
  if (itemFailure) {
    return {
      ...resolution,
      hit: false,
      trace: {
        ...(resolution.trace || {source: 'battle-engine' as const}),
        hit: false,
        notes: [...(resolution.trace?.notes || []), itemFailure],
      },
    };
  }

  if (PROTECT_BYPASS_MOVES.has(id) || moveBreaksProtection(state, action.moveName)) {
    for (const targetId of action.targetIds) {
      const targetSide = sideForPokemon(state, targetId);
      if (targetSide === actorSide) continue;
      if (getPokemon(state, targetId)?.volatile?.protected) {
        clearVolatile(resolution, targetId, 'protected');
        resolution.trace!.notes!.push(`${action.moveName} removed personal protection from ${targetId}`);
      }
      addSideEffects(resolution, targetSide, {wideGuard: false, quickGuard: false, matBlock: false});
      addSideEffectDuration(resolution, targetSide, 'wideGuard', null);
      addSideEffectDuration(resolution, targetSide, 'quickGuard', null);
      addSideEffectDuration(resolution, targetSide, 'matBlock', null);
      resolution.trace!.notes!.push(`${action.moveName} removed side protection from ${targetSide}`);
    }
  }

  const copyMoveName = id === 'copycat'
    ? state.lastMoveUsed
    : id === 'mirrormove'
      ? state.lastMoveTargetedByPokemon?.[actor.id]
      : (id === 'mimic' || id === 'sketch')
        ? (targetIds[0] ? state.lastMoveUsedByPokemon?.[targetIds[0]] : undefined)
        : undefined;
  if (['copycat', 'mirrormove', 'mimic', 'sketch'].includes(id)) {
    const copiedId = moveId(copyMoveName);
    const target = targetIds[0] ? getPokemon(state, targetIds[0]) : undefined;
    const cannotCopy = !copyMoveName || COPY_BLOCKED_MOVES.has(copiedId) ||
      (copyMoveName !== undefined && !isMoveAvailable(copyMoveName, state.generation)) ||
      ((id === 'mimic' || id === 'sketch') &&
        (!target || actor.moves.some(move => moveId(move.name) === copiedId)));
    if (cannotCopy) {
      return {
        ...resolution,
        hit: false,
        trace: {
          ...(resolution.trace || {source: 'battle-engine' as const}),
          hit: false,
          notes: [...(resolution.trace?.notes || []), `${action.moveName} failed: no legal move to copy`],
        },
      };
    }
    if (id === 'mimic' || id === 'sketch') {
      const maxPP = getMoveMaxPP(copyMoveName!, state.generation);
      const movesAfterUse = actor.moves.map(move => move.name === action.moveName
        ? {...move, pp: move.pp === undefined ? undefined : Math.max(0, move.pp - 1)}
        : move);
      const copiedMoves = movesAfterUse.map(move => move.name === action.moveName
        ? {...move, name: copyMoveName!, pp: maxPP, maxPP}
        : move);
      setMoves(resolution, actor.id, copiedMoves);
      resolution.trace!.notes!.push(`${action.moveName} copied ${copyMoveName}`);
    } else {
      setCopyMove(resolution, actor.id, copyMoveName!);
      resolution.trace!.notes!.push(`${action.moveName} selected ${copyMoveName}`);
    }
  }

  if (id === 'metronome' || id === 'sleeptalk') {
    if (id === 'sleeptalk' && (state.generation < 2 || actor.status !== 'slp')) {
      return {
        ...resolution,
        hit: false,
        trace: {
          ...(resolution.trace || {source: 'battle-engine' as const}),
          hit: false,
          notes: [...(resolution.trace?.notes || []), `${action.moveName} failed because the actor is not asleep`],
        },
      };
    }
    const candidates = id === 'sleeptalk'
      ? actor.moves
        .filter(move => isMoveAvailable(move.name, state.generation) &&
          moveId(move.name) !== 'sleeptalk' && !move.disabled)
        .map(move => move.name)
      : Array.from(Calc.Generations.get(state.generation).moves)
        .map(move => move.name)
        .filter(name => !!name && isMoveAvailable(name, state.generation) &&
          !COPY_BLOCKED_MOVES.has(moveId(name)) && moveId(name) !== 'metronome');
    if (!candidates.length) {
      return {
        ...resolution,
        hit: false,
        trace: {
          ...(resolution.trace || {source: 'battle-engine' as const}),
          hit: false,
          notes: [...(resolution.trace?.notes || []), `${action.moveName} failed: no legal move to call`],
        },
      };
    }
    const calledMove = candidates[Math.floor(sampleActionRoll(random, `${action.moveName} sampler`) * candidates.length)];
    setCalledMove(resolution, actor.id, calledMove);
    resolution.trace!.notes!.push(`${action.moveName} selected ${calledMove}`);
  }
  if (id === 'naturepower' && state.generation >= 3) {
    const calledMove = getNaturePowerMove(state);
    setCalledMove(resolution, actor.id, calledMove);
    resolution.trace!.notes!.push(`${action.moveName} selected ${calledMove}`);
  }
  if (id === 'assist') {
    if (state.generation < 3 || state.generation >= 8) {
      return {
        ...resolution,
        hit: false,
        trace: {
          ...(resolution.trace || {source: 'battle-engine' as const}),
          hit: false,
          notes: [...(resolution.trace?.notes || []), `${action.moveName} cannot be selected in this generation`],
        },
      };
    }
    const actorSide = sideForPokemon(state, actor.id);
    const candidates: string[] = [];
    for (const pokemon of state.sides[actorSide].party) {
      if (pokemon.id === actor.id) continue;
      const moves = state.generation <= 4 ? (pokemon.originalMoves || pokemon.moves) : pokemon.moves;
      for (const candidate of moves) {
        if (isMoveAvailable(candidate.name, state.generation) &&
          !ASSIST_BLOCKED_MOVES.has(moveId(candidate.name))) candidates.push(candidate.name);
      }
    }
    if (!candidates.length) {
      return {
        ...resolution,
        hit: false,
        trace: {
          ...(resolution.trace || {source: 'battle-engine' as const}),
          hit: false,
          notes: [...(resolution.trace?.notes || []), `${action.moveName} failed: no eligible party move`],
        },
      };
    }
    const calledMove = candidates[Math.floor(sampleActionRoll(random, `${action.moveName} sampler`) * candidates.length)];
    setCalledMove(resolution, actor.id, calledMove);
    resolution.trace!.notes!.push(`${action.moveName} selected ${calledMove}`);
  }

  if (id === 'mefirst') {
    if (state.generation < 4 || state.generation >= 8) {
      return {
        ...resolution,
        hit: false,
        trace: {
          ...(resolution.trace || {source: 'battle-engine' as const}),
          hit: false,
          notes: [...(resolution.trace?.notes || []), `${action.moveName} cannot be selected in this generation`],
        },
      };
    }
    const targetId = targetIds[0];
    const selected = targetId ? state.selectedMoveByPokemon?.[targetId] : undefined;
    const selectedId = moveId(selected?.moveName);
    const selectedMetadata = selected?.moveName
      ? getMoveMetadata(selected.moveName, state.generation)
      : undefined;
    const cannotCopy = !selected || selected.useZ || selected.useMax || !selectedMetadata ||
      !isMoveAvailable(selected.moveName, state.generation) ||
      selectedMetadata.category === 'Status' || ME_FIRST_BLOCKED_MOVES.has(selectedId);
    if (cannotCopy) {
      return {
        ...resolution,
        hit: false,
        trace: {
          ...(resolution.trace || {source: 'battle-engine' as const}),
          hit: false,
          notes: [...(resolution.trace?.notes || []), `${action.moveName} failed: no eligible pending damaging move`],
        },
      };
    }
    setCalledMove(resolution, actor.id, selected.moveName);
    setCalledMoveModifiers(resolution, actor.id, {powerMultiplier: 1.5, bypassAccuracy: true});
    resolution.trace!.notes!.push(`${action.moveName} selected ${selected.moveName} at 1.5x power`);
  }

  if (id === 'instruct') {
    if (state.generation < 7) {
      return {
        ...resolution,
        hit: false,
        trace: {
          ...(resolution.trace || {source: 'battle-engine' as const}),
          hit: false,
          notes: [...(resolution.trace?.notes || []), `${action.moveName} cannot be selected in this generation`],
        },
      };
    }
    const targetId = effectTargetIds[0];
    const target = targetId ? getPokemon(state, targetId) : undefined;
    const calledMove = targetId ? state.lastMoveUsedByPokemon?.[targetId] : undefined;
    const calledId = moveId(calledMove);
    const targetMove = target && calledMove
      ? target.moves.find(move => moveId(move.name) === calledId)
      : undefined;
    const cannotInstruct = !target || !calledMove || !isMoveAvailable(calledMove, state.generation) ||
      !targetMove || targetMove.pp === 0 ||
      !!target.isDynamaxed || INSTRUCT_BLOCKED_MOVES.has(calledId);
    if (cannotInstruct) {
      return {
        ...resolution,
        hit: false,
        trace: {
          ...(resolution.trace || {source: 'battle-engine' as const}),
          hit: false,
          notes: [...(resolution.trace?.notes || []), `${action.moveName} failed: target has no callable last move`],
        },
      };
    }
    setCalledMove(resolution, target.id, calledMove!);
    const previousTargets = state.lastMoveTargetIdsByPokemon?.[target.id];
    if (previousTargets) setCalledMoveTargets(resolution, target.id, previousTargets);
    resolution.trace!.notes!.push(`${action.moveName} instructed ${target.id} to repeat ${calledMove}`);
  }

  if (id === 'transform' && state.generation >= 1) {
    const targetId = targetIds[0];
    const target = targetId ? getPokemon(state, targetId) : undefined;
    const targetAbility = target ? getGenerationAbility(state.generation, target) : undefined;
    const blockedByAbility = target && sideForPokemon(state, target.id) !== actorSide &&
      isAbilityActive(target, state) && isAbilityAvailable(state.generation, targetAbility) &&
      moveId(targetAbility) === 'goodasgold';
    const cannotTransform = !target || !effectTargetIds.includes(target.id) ||
      (state.generation >= 5 && !!actor.speciesOverride) ||
      (state.generation >= 2 && !!target.speciesOverride) || blockedByAbility;
    if (cannotTransform) {
      return {
        ...resolution,
        hit: false,
        trace: {
          ...(resolution.trace || {source: 'battle-engine' as const}),
          hit: false,
          notes: [...(resolution.trace?.notes || []), `${action.moveName} failed against the selected target`],
        },
      };
    }
    const gen = Calc.Generations.get(state.generation);
    const targetRaw = getRawStats(gen, target);
    const copiedMoves = target.moves.map(move => {
      const naturalMaxPP = getMoveMaxPP(move.name, state.generation);
      const copiedMaxPP = state.generation >= 5
        ? Math.min(5, naturalMaxPP || 5)
        : naturalMaxPP || move.maxPP || 5;
      return {...move, pp: copiedMaxPP, maxPP: copiedMaxPP};
    });
    setSpeciesOverride(resolution, actor.id, getEffectiveSpecies(target));
    setTypeOverride(resolution, actor.id, getEffectiveTypes(state, target.id));
    if (!preventsAbilityChange(state, actor)) {
      if (targetAbility) setAbilityOverride(resolution, actor.id, targetAbility);
      else if (getEffectiveAbility(target) === undefined) setNoAbility(resolution, actor.id);
    }
    setStatOverrides(resolution, actor.id, {
      atk: targetRaw.atk,
      def: targetRaw.def,
      spa: targetRaw.spa,
      spd: targetRaw.spd,
      spe: targetRaw.spe,
    });
    resetBoosts(resolution, [actor.id]);
    setBoosts(resolution, actor.id, allBoostStages(target));
    setMoves(resolution, actor.id, copiedMoves);
    resolution.trace!.notes!.push(`${action.moveName} copied ${getEffectiveSpecies(target)} and its battle state`);
  }

  if (startsPledge) {
    resolution.pendingPledgeBySide = {
      [actorSide]: {
        actorId: actor.id,
        moveName: action.moveName,
        targetIds: [...action.targetIds],
        useZ: action.useZ,
        useMax: action.useMax,
      },
    };
    resolution.trace!.notes!.push(`${action.moveName} is waiting for ${pledgePartner!.id}'s paired Pledge move`);
  } else if (resolutionFacts) {
    // The crit event, sampled per target before its damage. Base 1/16 is
    // the hack's own emulator-observed rate (profiles/run-and-bun: Gen 8
    // mainline is 1/24); stage progression is the Gen 8 default, so
    // stage 1 = 1/8, stage 2 = 1/2, stage 3+ = always. Facts carry the
    // crit distribution; a move with no critRolls cannot crit.
    // Gen 8 variable multi-hit: 35% two, 35% three, 15% four, 15% five.
    // The calculator pins these at three for its damage display; a sampling
    // engine must roll, or Rock Blast-class moves never deal their real
    // spread (up to 67% more than predicted, 15% of the time).
    let hitCountOverride: number | undefined;
    const range = resolutionFacts.multiHitRange;
    if (range && range[0] === 2 && range[1] === 5) {
      const draw = sampleActionRoll(random, 'Multi-hit count');
      hitCountOverride = draw < 0.35 ? 2 : draw < 0.7 ? 3 : draw < 0.85 ? 4 : 5;
    }
    const criticalByTarget: Record<string, boolean> = {};
    const critStage = resolutionFacts.attackerCriticalHitStage ?? 0;
    const critChance = critStage >= 3 ? 1 : critStage === 2 ? 0.5 : critStage === 1 ? 0.125 : 1 / 16;
    for (const targetId of actionForTargets.targetIds) {
      const targetFacts = resolutionFacts.damageByTarget?.[targetId] ||
        (actionForTargets.targetIds.length === 1 ? resolutionFacts.damage : undefined);
      if (!targetFacts?.critRolls?.length) continue;
      if (sampleActionRoll(random, 'Critical hit') < critChance) criticalByTarget[targetId] = true;
    }
    const sampled = sampleDamageResolution(actionForTargets, resolutionFacts, random, criticalByTarget, hitCountOverride);
    const criticalTargets = Object.keys(criticalByTarget);
    resolution.damageByTarget = sampled.damageByTarget;
    resolution.hitDamageByTarget = sampled.hitDamageByTarget;
    resolution.trace = {
      ...(resolution.trace || {}),
      source: 'battle-engine',
      hit: resolution.trace?.hit,
      damageRollsByTarget: sampled.trace?.damageRollsByTarget,
      hitDamageRollsByTarget: sampled.trace?.hitDamageRollsByTarget,
      notes: [...(resolution.trace?.notes || []),
        criticalTargets.length
          ? `sampled calculator damage — critical hit on ${criticalTargets.join(', ')}`
          : 'sampled calculator damage'],
    };
    if (criticalTargets.length) resolution.criticalHitTargets = criticalTargets;
  }

  if (combinedPledge) {
    resolution.pendingPledgeBySide = {[actorSide]: null};
    if (resolution.hit !== false) {
      const combination = pledgeCombination(pendingPledge!.moveName, action.moveName);
      const sideEffects: Partial<SideEffects> = combination === 'rainbow'
        ? {pledgeRainbow: true}
        : combination === 'swamp'
          ? {pledgeSwamp: true}
          : {pledgeSeaOfFire: true};
      resolution.sideEffectsBySide = {
        ...(resolution.sideEffectsBySide || {}),
        [combination === 'rainbow' ? actorSide : foeSide]: {
          ...(resolution.sideEffectsBySide?.[combination === 'rainbow' ? actorSide : foeSide] || {}),
          ...sideEffects,
        },
      };
      resolution.sideEffectDurationsBySide = {
        ...(resolution.sideEffectDurationsBySide || {}),
        [combination === 'rainbow' ? actorSide : foeSide]: {
          ...(resolution.sideEffectDurationsBySide?.[combination === 'rainbow' ? actorSide : foeSide] || {}),
          ...(combination === 'rainbow' ? {pledgeRainbow: 4} :
            combination === 'swamp' ? {pledgeSwamp: 4} : {pledgeSeaOfFire: 4}),
        },
      };
      resolution.trace!.notes!.push(`${action.moveName} completed the ${combination} Pledge combination`);
    }
  }
  if (pendingPledge && !combinedPledge) {
    resolution.pendingPledgeBySide = {[actorSide]: null};
    resolution.trace!.notes!.push('the pending Pledge combination was cleared by a non-paired action');
  }

  if (id === 'burningjealousy' && state.generation >= 8 && resolution.hit !== false) {
    const raisedThisTurn = state.statBoostsThisTurnByPokemon || {};
    const burnedTargets = effectTargetIds.filter(targetId =>
      (resolution.damageByTarget?.[targetId] || 0) > 0 &&
      Object.keys(raisedThisTurn[targetId] || {}).length > 0 &&
      canApplyMajorStatus(state, actor.id, targetId, 'brn', moveType, false, false, moveCategory),
    );
    if (burnedTargets.length) {
      addStatus(resolution, state, burnedTargets, 'brn');
      resolution.trace!.notes!.push(`${action.moveName} burned targets that raised a stat this turn: ${burnedTargets.join(', ')}`);
    }
  }

  if (id === 'glaiverush' && state.generation >= 9 && resolution.hit !== false) {
    addVolatile(resolution, [actor.id], 'glaiveRush', {turns: 1});
    resolution.trace!.notes!.push(`${action.moveName} left ${actor.id} vulnerable until its next turn`);
  }

  if (PARTIAL_TRAPPING_MOVES.has(id) && resolution.hit !== false) {
    const trapTargets = effectTargetIds.filter(targetId =>
      (resolution.damageByTarget?.[targetId] || 0) > 0 &&
      canApplyVolatile(state, targetId, 'partiallyTrapped', actor.id, false, moveCategory));
    if (trapTargets.length) {
      const duration = state.generation >= 5
        ? Math.floor(sampleActionRoll(random, `${action.moveName} duration`) * 2) + 4
        : Math.floor(sampleActionRoll(random, `${action.moveName} duration`) * 4) + 2;
      const source = getPokemon(state, actor.id);
      const gripClaw = source && heldItemEffectsActive(state, source) && moveId(source.item) === 'gripclaw';
      const finalDuration = gripClaw && state.generation >= 5
        ? 7
        : gripClaw && state.generation >= 4
          ? 5
          : duration;
      addVolatile(resolution, trapTargets, 'partiallyTrapped', {
        turns: finalDuration,
        moveName: action.moveName,
        sourceId: actor.id,
      });
      resolution.trace!.notes!.push(`${action.moveName} trapped ${trapTargets.join(', ')} for ${finalDuration} turns`);
    }
  }
  if ((id === 'anchorshot' || id === 'spiritshackle') && resolution.hit !== false) {
    const trapTargets = effectTargetIds.filter(targetId =>
      (resolution.damageByTarget?.[targetId] || 0) > 0 &&
      canApplyVolatile(state, targetId, 'trapped', actor.id));
    if (trapTargets.length) {
      addVolatile(resolution, trapTargets, 'trapped', {sourceId: actor.id});
      resolution.trace!.notes!.push(`${action.moveName} permanently trapped ${trapTargets.join(', ')}`);
    }
  }
  if (id === 'throatchop' && resolution.hit !== false) {
    const silencedTargets = effectTargetIds.filter(targetId =>
      (resolution.damageByTarget?.[targetId] || 0) > 0 &&
      canApplyVolatile(state, targetId, 'throatChop', actor.id, false, moveCategory));
    if (silencedTargets.length) {
      addVolatile(resolution, silencedTargets, 'throatChop', {turns: 2});
      resolution.trace!.notes!.push(`${action.moveName} suppressed sound moves for ${silencedTargets.join(', ')}`);
    }
  }

  if (RECHARGE_MOVE_MIN_GENERATION[id] !== undefined && resolution.hit !== false) {
    const targetKOs = Object.entries(resolution.damageByTarget || {}).some(([targetId, damage]) => {
      const target = getPokemon(state, targetId);
      return !!target && target.hp.current <= damage;
    });
    const gen1HyperBeamKO = state.generation === 1 && id === 'hyperbeam' && targetKOs;
    if (!gen1HyperBeamKO) {
      addVolatile(resolution, [actor.id], 'recharge', {moveName: action.moveName});
      resolution.trace!.notes!.push(`${action.moveName} requires recharge on the following turn`);
    }
  }

  if (id === 'rollout' || id === 'iceball') {
    const previous = actor.volatile?.rollout;
    const stacks = (previous?.stacks || 0) + 1;
    if (stacks >= 5) {
      clearVolatile(resolution, actor.id, 'rollout');
      resolution.trace!.notes!.push(`${action.moveName} completed its five-hit sequence`);
    } else {
      addVolatile(resolution, [actor.id], 'rollout', {
        ...(previous ? {} : {turns: 5}),
        stacks,
        moveName: action.moveName,
      });
      resolution.trace!.notes!.push(`${action.moveName} advanced to consecutive hit ${stacks}`);
    }
  }

  if (id === 'furycutter') {
    const stacks = Math.min(4, (actor.volatile?.furyCutter?.stacks || 0) + 1);
    addVolatile(resolution, [actor.id], 'furyCutter', {stacks, moveName: action.moveName});
    resolution.trace!.notes!.push(`${action.moveName} advanced to consecutive hit ${stacks}`);
  }

  if (RAMPAGE_MOVES.has(id)) {
    const previous = actor.volatile?.rampage;
    if (!previous) {
      const turns = Math.floor(sampleActionRoll(random, `${action.moveName} duration`) * 2) + 2;
      addVolatile(resolution, [actor.id], 'rampage', {turns, moveName: action.moveName});
      resolution.trace!.notes!.push(`${action.moveName} locked the actor for ${turns} turns`);
    } else if ((previous.turns || 0) <= 1) {
      clearVolatile(resolution, actor.id, 'rampage');
      if (canApplyVolatile(state, actor.id, 'confusion')) {
        const confusionTurns = Math.floor(sampleActionRoll(random, 'Confusion duration') * 4) + 2;
        addVolatile(resolution, [actor.id], 'confusion', {turns: confusionTurns});
        resolution.trace!.notes!.push(`${action.moveName} ended and confused ${actor.id} for ${confusionTurns} turns`);
      }
    }
  }

  if (id === 'uproar') {
    const previous = actor.volatile?.uproar;
    if (!previous) {
      // Gen 5+ is a fixed 3; the 2-5 roll is the Gen 3/4 table.
      const turns = state.generation >= 5
        ? 3
        : Math.floor(sampleActionRoll(random, `${action.moveName} duration`) * 4) + 2;
      addVolatile(resolution, [actor.id], 'uproar', {turns, moveName: action.moveName});
      clearMajorStatus(resolution, state, (['ai', 'player'] as const).flatMap(sideId =>
        state.sides[sideId].activeIds));
      resolution.trace!.notes!.push(`${action.moveName} started a ${turns}-turn uproar and woke active Pokémon`);
    } else if ((previous.turns || 0) <= 1) {
      clearVolatile(resolution, actor.id, 'uproar');
      resolution.trace!.notes!.push(`${action.moveName} ended its uproar`);
    }
  }

  if (id === 'lockon' || id === 'mindreader') {
    const targetId = effectTargetIds[0];
    if (targetId) {
      addVolatile(resolution, [effectActorId], 'lockOn', {turns: 2, targetId});
      resolution.trace!.notes!.push(`${action.moveName} locked onto ${targetId}`);
    }
  }

  if (id === 'counter' || id === 'mirrorcoat' || id === 'metalburst') {
    const targetId = effectTargetIds[0];
    const history = state.lastDamageTakenByPokemon?.[actor.id];
    const requiredCategory = id === 'counter' ? 'Physical' : id === 'mirrorcoat' ? 'Special' : undefined;
    const canReflect = !!targetId && !!history && history.sourceId === targetId && history.damage > 0 &&
      (requiredCategory === undefined || history.category === requiredCategory);
    if (!canReflect) {
      return {
        ...resolution,
        hit: false,
        trace: {
          ...(resolution.trace || {source: 'battle-engine' as const}),
          hit: false,
          notes: [...(resolution.trace?.notes || []), `${action.moveName} failed: no compatible damage to reflect`],
        },
      };
    }
    const multiplier = id === 'metalburst' ? 1.5 : 2;
    resolution.damageByTarget = {[targetId!]: Math.max(1, Math.floor(history!.damage * multiplier))};
    resolution.trace!.notes!.push(`${action.moveName} reflected ${history!.damage} damage from ${targetId}`);
  }

  if (DELAYED_DAMAGE_MOVES.has(id)) {
    if (resolution.damageByTarget && Object.keys(resolution.damageByTarget).length) {
      const delayedMove: DelayedMoveState = {
        id: `delayed-${state.turn}-${actor.id}-${state.delayedMoves?.length || 0}`,
        moveName: action.moveName,
        sourceId: actor.id,
        targetIds: [...actionForTargets.targetIds],
        turns: 2,
        targetSlotsByTarget: Object.fromEntries(actionForTargets.targetIds.map(targetId => {
          const targetSide = sideForPokemon(state, targetId);
          return [targetId, state.sides[targetSide].activeIds.indexOf(targetId)];
        })),
        damageByTarget: resolution.damageByTarget,
      };
      resolution.delayedMoves = [delayedMove];
      resolution.damageByTarget = undefined;
      resolution.hitDamageByTarget = undefined;
      resolution.trace = {
        ...(resolution.trace || {source: 'battle-engine' as const}),
        notes: [...(resolution.trace?.notes || []), 'scheduled delayed damage for a later turn boundary'],
      };
    } else {
      resolution.trace!.notes!.push('delayed damage requires calculator damage facts');
    }
  }

  if (id === 'revivalblessing' && state.generation >= 9) {
    const targetId = effectTargetIds[0];
    const target = targetId ? getPokemon(state, targetId) : undefined;
    if (target) {
      addHpDelta(resolution, target.id, Math.floor(target.hp.max / 2));
      clearMajorStatus(resolution, state, [target.id]);
      resolution.trace!.notes!.push(`Revival Blessing revived ${target.id} at half HP`);
    }
  }

  if (id === 'wish') {
    const targetSide = effectActorSide;
    const targetSlot = state.sides[targetSide].activeIds.indexOf(effectActorId);
    resolution.delayedMoves = [{
      id: `delayed-${state.turn}-${effectActorId}-${state.delayedMoves?.length || 0}`,
      moveName: action.moveName,
      sourceId: actor.id,
      targetIds: [effectActorId],
      turns: 2,
      targetSlotsByTarget: {[effectActorId]: targetSlot},
      damageByTarget: {},
      healingByTarget: {[effectActorId]: {numerator: 1, denominator: 2}},
    }];
    resolution.trace = {
      ...(resolution.trace || {source: 'battle-engine' as const}),
      notes: [...(resolution.trace?.notes || []), 'scheduled delayed Wish healing for a later turn boundary'],
    };
  }

  if (!DELAYED_DAMAGE_MOVES.has(id)) {
    for (const targetId of Object.keys(resolution.damageByTarget || {})) {
      const target = getPokemon(state, targetId);
      const damageOutcome = target
        ? sequentialDamageOutcome(target, resolution.hitDamageByTarget?.[targetId],
          resolution.damageByTarget?.[targetId] || 0)
        : undefined;
      if (target && !!damageOutcome?.directDamage &&
        isDisguiseActive(state, target) && !ignoresTargetAbility(state, actor.id, targetId, moveCategory)) {
        const blocked = resolution.hitDamageByTarget
          ? adjustFirstDirectSequentialHit(resolution, target, targetId, () => 0)
          : (resolution.damageByTarget![targetId] = 0, true);
        if (!blocked) continue;
        resolution.disguiseBrokenByPokemon = {
          ...(resolution.disguiseBrokenByPokemon || {}),
          [targetId]: true,
        };
        resolution.trace!.notes!.push(`Disguise broke on ${targetId} and prevented damage`);
      }
    }
  }

  if (state.generation >= 4 && moveCategory !== 'Status' &&
    resolutionFacts?.isSuperEffective === true && moveType) {
    const berryType = moveId(moveType);
    for (const targetId of Object.keys(resolution.damageByTarget || {})) {
      const target = getPokemon(state, targetId);
      const damage = resolution.damageByTarget?.[targetId] || 0;
      const damageOutcome = target
        ? sequentialDamageOutcome(target, resolution.hitDamageByTarget?.[targetId], damage)
        : undefined;
      const berry = target ? moveId(target.item) : '';
      if (!target || target.id === actor.id || !damageOutcome?.directDamage ||
        !heldItemEffectsActive(state, target) || RESIST_BERRY_TYPES[berry] !== berryType ||
        isBerryUseSuppressedByUnnerve(state, actor.id, target.id) ||
        resolution.consumedItemByPokemon?.[target.id] !== undefined) continue;
      const adjusted = resolution.hitDamageByTarget
        ? adjustFirstDirectSequentialHit(resolution, target, targetId,
          hit => Math.max(1, Math.floor(hit / 2)))
        : !resolutionFacts.isMultiHit;
      if (!adjusted) continue;
      if (!resolution.hitDamageByTarget) {
        resolution.damageByTarget![targetId] = Math.max(1, Math.floor(damage / 2));
      }
      consumeItem(resolution, target.id, target.item!);
      resolution.trace!.notes!.push(`${target.item} halved the super-effective damage to ${target.id}`);
    }
  }

  if (state.generation >= 3 && moveCategory !== 'Status' &&
    resolutionFacts?.isSuperEffective === true) {
    for (const targetId of Object.keys(resolution.damageByTarget || {})) {
      const target = getPokemon(state, targetId);
      const damage = resolution.damageByTarget?.[targetId] || 0;
      const damageOutcome = target
        ? sequentialDamageOutcome(target, resolution.hitDamageByTarget?.[targetId], damage)
        : undefined;
      if (!target || target.id === actor.id || !damageOutcome?.directDamage ||
        !hasSurvivingDirectHit(target, resolution.hitDamageByTarget?.[targetId], damage) ||
        moveId(target.item) !== 'enigmaberry' || !heldItemEffectsActive(state, target) ||
        target.hp.current >= target.hp.max || target.volatile?.healBlock ||
        isBerryUseSuppressedByUnnerve(state, actor.id, target.id) ||
        resolution.consumedItemByPokemon?.[target.id] !== undefined) continue;
      const healing = Math.floor(target.hp.max / 4) * (hasAbility(state, target, 'ripen') ? 2 : 1);
      addHpDelta(resolution, target.id, healing);
      consumeItem(resolution, target.id, target.item!);
      applyCheekPouch(resolution, state, target, target.item!);
      resolution.trace!.notes!.push(`Enigma Berry restored HP to ${target.id}`);
    }
  }

  const firstHitProtectedBySturdy = new Set<string>();
  if (state.generation >= 5 && moveCategory !== 'Status') {
    for (const targetId of Object.keys(resolution.damageByTarget || {})) {
      const target = getPokemon(state, targetId);
      const damage = resolution.damageByTarget?.[targetId] || 0;
      const damageOutcome = target
        ? sequentialDamageOutcome(target, resolution.hitDamageByTarget?.[targetId], damage)
        : undefined;
      if (!target || target.id === actor.id || target.hp.current !== target.hp.max || !damageOutcome?.fainted ||
        !hasAbility(state, target, 'sturdy') ||
        ignoresTargetAbility(state, actor.id, targetId, moveCategory)) continue;
      const adjusted = resolution.hitDamageByTarget
        ? adjustFirstFatalFirstDirectSequentialHit(resolution, target, targetId,
          () => Math.max(0, target.hp.current - 1))
        : !resolutionFacts?.isMultiHit;
      if (!adjusted) continue;
      if (!resolution.hitDamageByTarget) resolution.damageByTarget![targetId] = Math.max(0, target.hp.current - 1);
      firstHitProtectedBySturdy.add(targetId);
      resolution.trace!.notes!.push(`Sturdy kept ${target.id} at 1 HP on the first hit`);
    }
  }

  if (state.generation >= 8 && moveCategory === 'Physical') {
    for (const targetId of Object.keys(resolution.damageByTarget || {})) {
      const target = getPokemon(state, targetId);
      const damage = resolution.damageByTarget?.[targetId] || 0;
      const damageOutcome = target
        ? sequentialDamageOutcome(target, resolution.hitDamageByTarget?.[targetId], damage)
        : undefined;
      if (!target || target.id === actor.id || !damageOutcome?.directDamage ||
        !isIceFaceActive(state, target) || ignoresTargetAbility(state, actor.id, targetId, moveCategory)) continue;
      const adjusted = resolution.hitDamageByTarget
        ? adjustFirstDirectSequentialHit(resolution, target, targetId, () => 0)
        : !resolutionFacts?.isMultiHit;
      if (!adjusted) continue;
      if (!resolution.hitDamageByTarget) resolution.damageByTarget![targetId] = 0;
      setSpeciesOverride(resolution, target.id, 'Eiscue-Noice');
      resolution.trace!.notes!.push(`Ice Face blocked the first physical hit and changed ${target.id} to Noice Face`);
    }
  }

  if (state.generation >= 4 && moveCategory !== 'Status') {
    for (const targetId of Object.keys(resolution.damageByTarget || {})) {
      const target = getPokemon(state, targetId);
      const damage = resolution.damageByTarget?.[targetId] || 0;
      const damageOutcome = target
        ? sequentialDamageOutcome(target, resolution.hitDamageByTarget?.[targetId], damage)
        : undefined;
      if (!target || target.id === actor.id || target.hp.current !== target.hp.max || !damageOutcome?.fainted ||
        !heldItemEffectsActive(state, target) ||
        moveId(target.item) !== 'focussash' || firstHitProtectedBySturdy.has(targetId)) continue;
      const adjusted = resolution.hitDamageByTarget
        ? adjustFirstFatalFirstDirectSequentialHit(resolution, target, targetId,
          () => Math.max(0, target.hp.current - 1))
        : !resolutionFacts?.isMultiHit;
      if (!adjusted) continue;
      if (!resolution.hitDamageByTarget) resolution.damageByTarget![targetId] = Math.max(0, target.hp.current - 1);
      consumeItem(resolution, target.id, target.item!);
      resolution.trace!.notes!.push(`Focus Sash kept ${target.id} at 1 HP on the first hit`);
    }
  }

  if (state.generation >= 2 && moveCategory !== 'Status') {
    for (const targetId of Object.keys(resolution.damageByTarget || {})) {
      const target = getPokemon(state, targetId);
      const damage = resolution.damageByTarget?.[targetId] || 0;
      const damageOutcome = target
        ? sequentialDamageOutcome(target, resolution.hitDamageByTarget?.[targetId], damage)
        : undefined;
      if (!target || target.id === actor.id || !damageOutcome?.fainted ||
        !heldItemEffectsActive(state, target) || moveId(target.item) !== 'focusband' ||
        random() >= 0.1) continue;
      const adjusted = resolution.hitDamageByTarget
        ? adjustFirstFatalDirectSequentialHit(resolution, target, targetId,
          (_hit, remainingHp) => Math.max(0, remainingHp - 1))
        : !resolutionFacts?.isMultiHit;
      if (!adjusted) continue;
      if (!resolution.hitDamageByTarget) resolution.damageByTarget![targetId] = Math.max(0, target.hp.current - 1);
      resolution.trace!.notes!.push(`Focus Band kept ${target.id} at 1 HP`);
    }
  }

  if (state.generation >= 5 && moveCategory !== 'Status') {
    for (const targetId of Object.keys(resolution.damageByTarget || {})) {
      const target = getPokemon(state, targetId);
      const damage = resolution.damageByTarget?.[targetId] || 0;
      if (!target || !heldItemEffectsActive(state, target) || moveId(target.item) !== 'airballoon' ||
        !hasDirectMoveHitAfterSubstitute(target, resolution.hitDamageByTarget?.[targetId], damage)) continue;
      consumeItem(resolution, target.id, target.item!);
      resolution.trace!.notes!.push(`Air Balloon burst on ${target.id}`);
    }
  }

  if (state.generation >= 6 && resolutionFacts?.isSuperEffective === true) {
    for (const targetId of Object.keys(resolution.damageByTarget || {})) {
      const target = getPokemon(state, targetId);
      const damage = resolution.damageByTarget?.[targetId] || 0;
      const damageOutcome = target
        ? sequentialDamageOutcome(target, resolution.hitDamageByTarget?.[targetId], damage)
        : undefined;
      if (!target || target.id === actor.id || !damageOutcome?.directDamage ||
        !hasSurvivingDirectHit(target, resolution.hitDamageByTarget?.[targetId], damage) ||
        !heldItemEffectsActive(state, target) || moveId(target.item) !== 'weaknesspolicy') continue;
      addBoosts(resolution, state, target.id, {atk: 2, spa: 2});
      consumeItem(resolution, target.id, target.item!);
      resolution.trace!.notes!.push(`Weakness Policy activated on ${target.id}`);
    }
  }

  if (resolutionFacts?.isSuperEffective === true && moveType) {
    const reactiveItems: Record<string, {generation: number; type: string; boosts: StatBoosts}> = {
      absorbbulb: {generation: 5, type: 'water', boosts: {spa: 1}},
      cellbattery: {generation: 5, type: 'electric', boosts: {atk: 1}},
      snowball: {generation: 6, type: 'ice', boosts: {atk: 1}},
      luminousmoss: {generation: 6, type: 'water', boosts: {spd: 1}},
    };
    for (const targetId of Object.keys(resolution.damageByTarget || {})) {
      const target = getPokemon(state, targetId);
      const damage = resolution.damageByTarget?.[targetId] || 0;
      const damageOutcome = target
        ? sequentialDamageOutcome(target, resolution.hitDamageByTarget?.[targetId], damage)
        : undefined;
      const reactiveItem = target ? reactiveItems[moveId(target.item)] : undefined;
      if (!target || target.id === actor.id || !damageOutcome?.directDamage ||
        !hasSurvivingDirectHit(target, resolution.hitDamageByTarget?.[targetId], damage) ||
        !reactiveItem || state.generation < reactiveItem.generation ||
        moveId(moveType) !== reactiveItem.type || !heldItemEffectsActive(state, target)) continue;
      addBoosts(resolution, state, target.id, reactiveItem.boosts);
      consumeItem(resolution, target.id, target.item!);
      resolution.trace!.notes!.push(`${target.item} activated on ${target.id}`);
    }
  }

  if (moveCategory === 'Physical' || moveCategory === 'Special') {
    for (const targetId of Object.keys(resolution.damageByTarget || {})) {
      const target = getPokemon(state, targetId);
      const damage = resolution.damageByTarget?.[targetId] || 0;
      const damageOutcome = target
        ? sequentialDamageOutcome(target, resolution.hitDamageByTarget?.[targetId], damage)
        : undefined;
      const reactiveBerry = target ? REACTIVE_STAT_BERRIES[moveId(target.item)] : undefined;
      if (!target || target.id === actor.id || !damageOutcome?.directDamage || damageOutcome.fainted ||
        !reactiveBerry || reactiveBerry.category !== moveCategory ||
        !heldItemEffectsActive(state, target) ||
        isBerryUseSuppressedByUnnerve(state, actor.id, target.id)) continue;
      addBoosts(resolution, state, target.id, {[reactiveBerry.stat]: 1});
      consumeItem(resolution, target.id, target.item!);
      resolution.trace!.notes!.push(`${target.item} raised ${target.id}'s ${reactiveBerry.stat.toUpperCase()}`);
    }
  }

  if (moveCategory === 'Physical' || moveCategory === 'Special') {
    for (const targetId of Object.keys(resolution.damageByTarget || {})) {
      const target = getPokemon(state, targetId);
      const damage = resolution.damageByTarget?.[targetId] || 0;
      const damageOutcome = target
        ? sequentialDamageOutcome(target, resolution.hitDamageByTarget?.[targetId], damage)
        : undefined;
      const berryCategory = target ? REACTIVE_DAMAGE_BERRIES[moveId(target.item)] : undefined;
      if (!target || target.id === actor.id || !damageOutcome?.directDamage ||
        berryCategory !== moveCategory || !heldItemEffectsActive(state, target) ||
        isBerryUseSuppressedByUnnerve(state, actor.id, target.id) || hasMagicGuard(state, actor)) continue;
      const damageFraction = hasAbility(state, target, 'ripen') ? 4 : 8;
      addHpDelta(resolution, actor.id, -Math.max(1, Math.floor(target.hp.max / damageFraction)));
      consumeItem(resolution, target.id, target.item!);
      resolution.trace!.notes!.push(`${target.item} damaged ${actor.id}`);
    }
  }

  if (state.generation >= 5) {
    for (const targetId of Object.keys(resolution.damageByTarget || {})) {
      const target = getPokemon(state, targetId);
      const damage = resolution.damageByTarget?.[targetId] || 0;
      const damageOutcome = target
        ? sequentialDamageOutcome(target, resolution.hitDamageByTarget?.[targetId], damage)
        : undefined;
      if (!target || !damageOutcome?.directDamage || !heldItemEffectsActive(state, target) ||
        targetId === actor.id) continue;
      const item = moveId(target.item);
      if (item === 'redcard' && sideForPokemon(state, target.id) !== actorSide) {
        if (requestMoveSwitch(state, actor, resolution)) {
          consumeItem(resolution, target.id, target.item!);
          resolution.trace!.notes!.push(`Red Card forced ${actor.id} out`);
        }
      } else if (item === 'ejectbutton') {
        if (requestMoveSwitch(state, target, resolution)) {
          consumeItem(resolution, target.id, target.item!);
          resolution.trace!.notes!.push(`Eject Button forced ${target.id} out`);
        }
      }
    }
  }

  if (id === 'naturalgift' && canUseNaturalGift(state, actor)) {
    if (state.generation >= 5 && resolution.forcedSwitchByPokemon?.[actor.id]) {
      resolution.trace!.notes!.push('Natural Gift preserved the actor Berry because Red Card forced a switch');
    } else {
      consumeItem(resolution, actor.id, actor.item!);
      resolution.trace!.notes!.push('Natural Gift consumed the actor Berry');
    }
  }

  const contactMove = moveMakesContact(state, action.moveName, actor, action);
  if (contactMove) {
    for (const targetId of eligibility.protectedIds) {
      const protectedTarget = getPokemon(state, targetId);
      const shieldMove = moveId(protectedTarget?.volatile?.protected?.moveName);
      if (!protectedTarget || !protectedTarget.volatile?.protected ||
        sideForPokemon(state, targetId) === actorSide) continue;

      if (shieldMove === 'kingsshield') {
        addBoosts(resolution, state, actor.id, {atk: -1}, targetId);
        resolution.trace!.notes!.push(`King's Shield lowered ${actor.id}'s Attack`);
      } else if (shieldMove === 'obstruct') {
        addBoosts(resolution, state, actor.id, {def: -2}, targetId);
        resolution.trace!.notes!.push(`Obstruct lowered ${actor.id}'s Defense`);
      } else if (shieldMove === 'silktrap') {
        addBoosts(resolution, state, actor.id, {spe: -1}, targetId);
        resolution.trace!.notes!.push(`Silk Trap lowered ${actor.id}'s Speed`);
      } else if (shieldMove === 'spikyshield') {
        addHpDelta(resolution, actor.id, -Math.max(1, Math.floor(actor.hp.max / 8)));
        resolution.trace!.notes!.push(`Spiky Shield damaged ${actor.id}`);
      } else if (shieldMove === 'banefulbunker' &&
        canApplyMajorStatus(state, targetId, actor.id, 'psn', undefined, false)) {
        addStatus(resolution, state, [actor.id], 'psn');
        resolution.trace!.notes!.push(`Baneful Bunker poisoned ${actor.id}`);
      } else if (shieldMove === 'burningbulwark' &&
        canApplyMajorStatus(state, targetId, actor.id, 'brn', undefined, false)) {
        addStatus(resolution, state, [actor.id], 'brn');
        resolution.trace!.notes!.push(`Burning Bulwark burned ${actor.id}`);
      }
    }

    const contactTargetIds = Array.from(new Set([
      ...effectTargetIds,
      ...Object.keys(resolution.damageByTarget || {}).filter(targetId => {
        const target = getPokemon(state, targetId);
        return !!target && sequentialDamageOutcome(
          target,
          resolution.hitDamageByTarget?.[targetId],
          resolution.damageByTarget?.[targetId] || 0,
        ).hitCount > 0;
      }),
    ]));
    for (const targetId of contactTargetIds) {
      const target = getPokemon(state, targetId);
      if (!target || target.id === actor.id || target.hp.current <= 0) continue;
      const targetDamage = resolution.damageByTarget?.[targetId] || 0;
      if (state.generation >= SHELL_TRAP_MIN_GENERATION && target.volatile?.shellTrap &&
        targetDamage > 0 && sequentialDamageOutcome(
          target,
          resolution.hitDamageByTarget?.[targetId],
          targetDamage,
        ).directDamage > 0) {
        const shellTrapAction: MoveAction = {
          kind: 'move', actorId: target.id, moveName: 'Shell Trap', targetIds: [actor.id],
        };
        const shellTrapFacts = calculateActionFacts(state, shellTrapAction, {reactive: true});
        const shellTrapDamage = sampleDamageResolution(shellTrapAction, shellTrapFacts, random).damageByTarget?.[actor.id] || 0;
        if (shellTrapDamage > 0) addHpDelta(resolution, actor.id, -shellTrapDamage);
        clearVolatile(resolution, target.id, 'shellTrap');
        resolution.trace!.notes!.push(`Shell Trap from ${target.id} triggered on ${actor.id}`);
      }
      // A held King's Rock / Razor Fang (or Stench) adds a 10% flinch to any
      // damaging move that has no flinch secondary of its own — doubled by
      // Serene Grace. Unmodeled before, so enemy flinch-denial chains never
      // appeared in a prediction.
      const flinchItemHeld = isItemEffectActive(state, actor) &&
        ['kingsrock', 'razorfang'].includes(moveId(actor.item || ''));
      const stench = hasAbility(state, actor, 'stench');
      const carriesOwnFlinch = (options.facts?.secondaryEffects || []).some(
        (effect: {volatile?: {name?: string}}) => effect.volatile?.name === 'flinch');
      if ((flinchItemHeld || stench) && !carriesOwnFlinch && moveCategory !== 'Status' &&
        (resolution.damageByTarget?.[targetId] || 0) > 0 && !target.volatile?.flinch &&
        canApplyVolatile(state, targetId, 'flinch')) {
        const flinchChance = hasAbility(state, actor, 'serenegrace') ? 0.2 : 0.1;
        if (sampleActionRoll(random, 'Held flinch item') < flinchChance) {
          addVolatile(resolution, [targetId], 'flinch', {turns: 1});
          resolution.trace!.notes!.push(`${actor.id} flinched ${targetId} with a held item effect`);
        }
      }
      const targetAbility = moveId(getEffectiveAbility(target));
      const targetAbilityIgnored = ignoresTargetAbility(state, actor.id, targetId, moveCategory);
      const damageOutcome = sequentialDamageOutcome(
        target,
        resolution.hitDamageByTarget?.[targetId],
        targetDamage,
      );
      const contactHits = damageOutcome.hitCount;
      const contactAttempts = contactHits;
      const stickyBarb = resolvedItem(state, resolution, target);
      if (state.generation >= 4 && contactHits > 0 && stickyBarb && moveId(stickyBarb) === 'stickybarb' &&
        heldItemEffectsActive(state, target) && !resolvedItem(state, resolution, actor) &&
        canRemoveHeldItem(state, target)) {
        setItem(resolution, target.id, null);
        setItem(resolution, actor.id, stickyBarb);
        resolution.trace!.notes!.push(`Sticky Barb transferred from ${target.id} to ${actor.id}`);
      }
      const abilityDamagePerHit = [
        !targetAbilityIgnored && state.generation >= 3 && isAbilityActive(target, state) && targetAbility === 'roughskin'
          ? Math.max(1, Math.floor(actor.hp.max / 8)) : 0,
        !targetAbilityIgnored && state.generation >= 5 && isAbilityActive(target, state) && targetAbility === 'ironbarbs'
          ? Math.max(1, Math.floor(actor.hp.max / 8)) : 0,
        state.generation >= 5 && heldItemEffectsActive(state, target) &&
        moveId(resolvedItem(state, resolution, target)) === 'rockyhelmet'
          ? Math.max(1, Math.floor(actor.hp.max / 6)) : 0,
      ].reduce((total, damage) => total + damage, 0);
      const abilityDamage = abilityDamagePerHit * contactHits;
      if (abilityDamage > 0 && !hasMagicGuard(state, actor)) {
        addHpDelta(resolution, actor.id, -abilityDamage);
        resolution.trace!.notes!.push(`${target.id} dealt ${abilityDamage} contact damage to ${actor.id}`);
      }

      const targetWouldFaint = targetDamage > 0 && damageOutcome.fainted;
      if (!targetAbilityIgnored && state.generation >= 4 && isAbilityActive(target, state) && targetAbility === 'aftermath' && targetWouldFaint &&
        !hasMagicGuard(state, actor)) {
        addHpDelta(resolution, actor.id, -Math.max(1, Math.floor(actor.hp.max / 4)));
        resolution.trace!.notes!.push(`Aftermath dealt contact damage to ${actor.id}`);
      }

      const contactStatus = targetAbility === 'static'
        ? 'par' as const
        : targetAbility === 'flamebody'
          ? 'brn' as const
          : targetAbility === 'poisonpoint'
            ? 'psn' as const
            : undefined;
      const contactStatusGeneration = targetAbility === 'poisonpoint' || targetAbility === 'static' ||
        targetAbility === 'flamebody' ? 3 : 10;
      if (!targetAbilityIgnored && contactStatus && state.generation >= contactStatusGeneration && isAbilityActive(target, state) &&
        contactAttempts > 0 && canApplyMajorStatus(state, target.id, actor.id, contactStatus)) {
        for (let attempt = 0; attempt < contactAttempts; attempt += 1) {
          if (sampleActionRoll(random, `${targetAbility} contact chance`) >= 0.3) continue;
          addStatus(resolution, state, [actor.id], contactStatus);
          resolution.trace!.notes!.push(`${targetAbility} inflicted ${contactStatus} on ${actor.id}`);
          break;
        }
      }
      if (!targetAbilityIgnored && hasAbility(state, target, 'effectspore') && contactAttempts > 0) {
        for (let attempt = 0; attempt < contactAttempts; attempt += 1) {
          const effectSporeRoll = sampleActionRoll(random, 'Effect Spore contact chance');
          // Gen 8 split: 9% psn / 10% par / 11% slp (the 10/10/10 was the
          // Gen 3/4 table — sleep, the worst status, was underweighted).
          const effectSporeStatus = effectSporeRoll < 0.09
            ? 'psn' as const
            : effectSporeRoll < 0.19
              ? 'par' as const
              : effectSporeRoll < 0.3
                ? 'slp' as const
                : undefined;
          if (!effectSporeStatus || !canApplyMajorStatus(state, target.id, actor.id, effectSporeStatus)) continue;
          addStatus(resolution, state, [actor.id], effectSporeStatus);
          if (effectSporeStatus === 'slp' && resolution.statusByPokemon?.[actor.id] === 'slp') {
            setStatusTurns(resolution, actor.id, Math.floor(sampleActionRoll(random, 'Effect Spore sleep duration') * 3) + 2);
          }
          resolution.trace!.notes!.push(`Effect Spore inflicted ${effectSporeStatus} on ${actor.id}`);
          break;
        }
      }
      if (!targetAbilityIgnored && hasAbility(state, target, 'cutecharm') && contactAttempts > 0 &&
        canApplyVolatile(state, actor.id, 'infatuated', target.id)) {
        for (let attempt = 0; attempt < contactAttempts; attempt += 1) {
          if (sampleActionRoll(random, 'Cute Charm contact chance') >= 0.3) continue;
          addVolatile(resolution, [actor.id], 'infatuated');
          resolution.trace!.notes!.push(`Cute Charm infatuated ${actor.id}`);
          break;
        }
      }
      if (state.generation >= 5 && hasAbility(state, actor, 'poisontouch') && contactAttempts > 0 &&
        canApplyMajorStatus(state, actor.id, target.id, 'psn')) {
        for (let attempt = 0; attempt < contactAttempts; attempt += 1) {
          if (sampleActionRoll(random, 'Poison Touch chance') >= 0.3) continue;
          addStatus(resolution, state, [target.id], 'psn');
          resolution.trace!.notes!.push(`Poison Touch poisoned ${target.id}`);
          break;
        }
      }
      if (!targetAbilityIgnored && isAbilityActive(target, state) && (targetAbility === 'gooey' || targetAbility === 'tanglinghair') &&
        ((targetAbility === 'gooey' && state.generation >= 6) ||
          (targetAbility === 'tanglinghair' && state.generation >= 7)) && contactAttempts > 0) {
        for (let attempt = 0; attempt < contactAttempts; attempt += 1) {
          addBoosts(resolution, state, actor.id, {spe: -1}, target.id);
          resolution.trace!.notes!.push(`${targetAbility} lowered ${actor.id}'s Speed`);
        }
      }

      if (!targetAbilityIgnored && state.generation >= 8 && targetAbility === 'perishbody' &&
        isAbilityActive(target, state) && contactHits > 0) {
        const perishRecipients = target.id === actor.id ? [target.id] : [target.id, actor.id];
        for (const recipientId of perishRecipients) {
          if (!canApplyVolatile(state, recipientId, 'perishSong', target.id)) continue;
          addVolatile(resolution, [recipientId], 'perishSong', {turns: 3, sourceId: target.id});
        }
        resolution.trace!.notes!.push(`Perish Body started Perish Song for ${target.id} and ${actor.id}`);
      }

      const actorAbility = getGenerationAbility(state.generation, actor);
      if (!targetAbilityIgnored && isAbilityActive(target, state) && actorAbility && canChangeAbility(actorAbility) &&
        contactHits > 0) {
        if (state.generation >= 5 && targetAbility === 'mummy' && !preventsAbilityChange(state, actor) &&
          moveId(actorAbility) !== 'mummy') {
          setAbilityOverride(resolution, actor.id, 'Mummy');
          resolution.trace!.notes!.push(`Mummy changed ${actor.id}'s Ability`);
        } else if (state.generation >= 9 && targetAbility === 'lingeringaroma' && !preventsAbilityChange(state, actor) &&
          moveId(actorAbility) !== 'lingeringaroma') {
          setAbilityOverride(resolution, actor.id, 'Lingering Aroma');
          resolution.trace!.notes!.push(`Lingering Aroma changed ${actor.id}'s Ability`);
        } else if (state.generation >= 8 && targetAbility === 'wanderingspirit') {
          const targetCurrentAbility = getGenerationAbility(state.generation, target);
          if (!preventsAbilityChange(state, actor) && !preventsAbilityChange(state, target) &&
            targetCurrentAbility && canChangeAbility(targetCurrentAbility) &&
            moveId(actorAbility) !== moveId(targetCurrentAbility)) {
            setAbilityOverride(resolution, actor.id, targetCurrentAbility);
            setAbilityOverride(resolution, target.id, actorAbility);
            resolution.trace!.notes!.push(`Wandering Spirit swapped Abilities between ${actor.id} and ${target.id}`);
          }
        }
      }
    }
  }
  const criticalHit = resolutionFacts?.criticalHit === true || resolutionFacts?.criticalHitGuaranteed === true;
  if (criticalHit && resolution.hit !== false) {
    for (const targetId of targetIds) {
      const target = getPokemon(state, targetId);
      if (!target || target.id === actor.id || !hasAbility(state, target, 'angerpoint') ||
        ignoresTargetAbility(state, actor.id, target.id, moveCategory)) continue;
      const damage = resolution.damageByTarget?.[targetId] || 0;
      if (damage <= 0 && !hasSubstitute(state, target.id)) continue;
      const actualDamage = hasSubstitute(state, target.id)
        ? 0
        : target.volatile?.endure
          ? Math.min(damage, Math.max(0, target.hp.current - 1))
          : damage;
      if (target.hp.current - actualDamage <= 0) continue;
      addBoosts(resolution, state, target.id, {atk: 12}, target.id);
      resolution.trace!.notes!.push(`Anger Point maximized ${target.id}'s Attack`);
    }
  }
  for (const targetId of targetIds) {
    const target = getPokemon(state, targetId);
    const damage = resolution.damageByTarget?.[targetId] || 0;
    const damageOutcome = target
      ? sequentialDamageOutcome(target, resolution.hitDamageByTarget?.[targetId], damage)
      : undefined;
    const hitAttempts = resolution.hitDamageByTarget?.[targetId] !== undefined
      ? damageOutcome?.hitCount || 0
      : damage > 0 ? 1 : 0;
    if (!target || !hasAbility(state, target, 'cottondown') || hitAttempts <= 0 ||
      ignoresTargetAbility(state, actor.id, target.id, moveCategory)) continue;
    for (let attempt = 0; attempt < hitAttempts; attempt += 1) {
      for (const sideId of ['ai', 'player'] as const) {
        for (const activeId of state.sides[sideId].activeIds) {
          const active = getPokemon(state, activeId);
          if (!active || active.id === target.id || active.hp.current <= 0) continue;
          addBoosts(resolution, state, active.id, {spe: -1}, target.id);
        }
      }
    }
    resolution.trace!.notes!.push(`Cotton Down lowered the Speed of active Pokemon other than ${target.id}`);
  }
  const thresholdTargetIds = Array.from(new Set([
    ...effectTargetIds,
    ...Object.keys(resolution.damageByTarget || {}).filter(targetId => {
      const target = getPokemon(state, targetId);
      return !!target && sequentialDamageOutcome(
        target,
        resolution.hitDamageByTarget?.[targetId],
        resolution.damageByTarget?.[targetId] || 0,
      ).hitCount > 0;
    }),
  ]));
  for (const targetId of thresholdTargetIds) {
    const target = getPokemon(state, targetId);
    const damage = resolution.damageByTarget?.[targetId] || 0;
    const damageOutcome = target
      ? sequentialDamageOutcome(target, resolution.hitDamageByTarget?.[targetId], damage)
      : undefined;
    if (!target || target.id === actor.id || target.hp.current <= 0 || damage <= 0 ||
      target.hp.current <= target.hp.max / 2 || !damageOutcome?.directDamage ||
      ignoresTargetAbility(state, actor.id, target.id, moveCategory)) continue;
    const targetAbility = moveId(getEffectiveAbility(target));
    if (!['emergencyexit', 'wimpout'].includes(targetAbility) || !isAbilityActive(target, state) ||
      !isAbilityAvailable(state.generation, targetAbility)) continue;
    const actualDamage = damageOutcome.directDamage;
    const projectedHp = target.hp.current - actualDamage;
    if (actualDamage <= 0 || projectedHp <= 0 || projectedHp > target.hp.max / 2) continue;
    if (requestMoveSwitch(state, target, resolution)) {
      resolution.trace!.notes!.push(`${targetAbility} requested a replacement for ${target.id}`);
    }
  }
  const actorItemAfterMove = resolvedItem(state, resolution, effectActor);
  if (id === 'corrosivegas' && state.generation >= 8) {
    for (const targetId of effectTargetIds) {
      const target = getPokemon(state, targetId);
      if (!target || targetId === actor.id || !target.item || !canRemoveHeldItem(state, target)) continue;
      setItemCorroded(resolution, target.id, true);
      resolution.trace!.notes!.push(`Corrosive Gas rendered ${target.id}'s ${target.item} unusable`);
    }
  }
  for (const targetId of Object.keys(resolution.damageByTarget || {})) {
    const target = getPokemon(state, targetId);
    const damage = resolution.damageByTarget?.[targetId] || 0;
    const damageOutcome = target
      ? sequentialDamageOutcome(target, resolution.hitDamageByTarget?.[targetId], damage)
      : undefined;
    const reachedTarget = effectTargetIds.includes(targetId) || !!damageOutcome?.directDamage;
    if (!target || targetId === actor.id || damage <= 0 || !reachedTarget) continue;
    const targetItem = resolvedItem(state, resolution, target);
    const targetFaints = !!damageOutcome?.fainted;
    if (id === 'incinerate' && state.generation >= 5 && targetItem && isBerry(targetItem) &&
      (canRemoveHeldItem(state, target) || targetFaints)) {
      setItem(resolution, target.id, null);
      resolution.trace!.notes!.push(`Incinerate destroyed ${target.id}'s ${targetItem}`);
    }
  }

  const damagingTargetIds = Object.keys(resolution.damageByTarget || {})
    .filter(targetId => {
      const target = getPokemon(state, targetId);
      const targetDamage = resolution.damageByTarget?.[targetId] || 0;
      return !!target && targetId !== actor.id && targetDamage > 0 &&
        sequentialDamageOutcome(target, resolution.hitDamageByTarget?.[targetId], targetDamage).directDamage > 0;
    });
  for (const targetId of damagingTargetIds) {
    const target = getPokemon(state, targetId);
    const targetForm = target ? moveId(getEffectiveSpecies(target)) : '';
    if (!target || state.generation < 8 || !isAbilityActive(target, state) ||
      !isAbilityAvailable(state.generation, getEffectiveAbility(target)) ||
      moveId(getEffectiveAbility(target)) !== 'gulpmissile' ||
      !['cramorantgulping', 'cramorantgorging'].includes(targetForm)) continue;
    if (!hasMagicGuard(state, actor)) {
      addHpDelta(resolution, actor.id, -Math.max(1, Math.floor(actor.hp.max / 4)));
      resolution.trace!.notes!.push(`Gulp Missile dealt damage to ${actor.id}`);
    }
    if (targetForm === 'cramorantgulping') {
      addBoosts(resolution, state, actor.id, {def: -1}, target.id);
      resolution.trace!.notes!.push(`Gulp Missile lowered ${actor.id}'s Defense`);
    } else if (canApplyMajorStatus(state, target.id, actor.id, 'par')) {
      addStatus(resolution, state, [actor.id], 'par');
      resolution.trace!.notes!.push(`Gulp Missile paralyzed ${actor.id}`);
    }
    setSpeciesOverride(resolution, target.id, null);
  }
  const resolvedMoveType = moveType || moveMetadata.type;
  if (resolvedMoveType) {
    const typeId = moveId(resolvedMoveType);
    for (const targetId of action.targetIds) {
      const target = getPokemon(state, targetId);
      if (!target || target.id === actor.id || target.hp.current <= 0 ||
        eligibility.protectedIds.includes(targetId) || missedAccuracyIds.includes(targetId) ||
        ignoresTargetAbility(state, actor.id, targetId, moveCategory)) continue;
      const targetAbility = moveId(getEffectiveAbility(target));
      const targetDamageOutcome = sequentialDamageOutcome(
        target,
        resolution.hitDamageByTarget?.[target.id],
        resolution.damageByTarget?.[target.id] || 0,
      );
      const tookDirectDamage = targetDamageOutcome.directDamage > 0;
      if (state.generation >= 9 && typeId === 'fire' && targetAbility === 'wellbakedbody' && isAbilityActive(target, state)) {
        addBoosts(resolution, state, target.id, {def: 2}, target.id);
        resolution.trace!.notes!.push(`Well-Baked Body raised ${target.id}'s Defense`);
      } else if (state.generation >= 9 && typeId === 'ground' && targetAbility === 'eartheater' && isAbilityActive(target, state)) {
        addHpDelta(resolution, target.id, Math.floor(target.hp.max / 4));
        resolution.trace!.notes!.push(`Earth Eater restored HP for ${target.id}`);
      } else if (state.generation >= 9 && tookDirectDamage &&
        moveCategory !== 'Status' && targetAbility === 'electromorphosis' && isAbilityActive(target, state)) {
        addVolatile(resolution, [target.id], 'charged');
        resolution.trace!.notes!.push(`Electromorphosis charged ${target.id}`);
      } else if (state.generation >= 9 && tookDirectDamage &&
        moveCategory !== 'Status' && moveMetadata.wind && targetAbility === 'windpower' && isAbilityActive(target, state)) {
        addVolatile(resolution, [target.id], 'charged');
        resolution.trace!.notes!.push(`Wind Power charged ${target.id}`);
      } else if (state.generation >= 9 && state.field.terrain !== 'Grassy' && tookDirectDamage &&
        moveCategory !== 'Status' && targetAbility === 'seedsower' && isAbilityActive(target, state)) {
        addField(resolution, {terrain: 'Grassy'});
        addFieldDuration(resolution, 'terrain', extendedFieldDuration(state, target, 'terrain'));
        resolution.trace!.notes!.push(`Seed Sower made the terrain Grassy`);
      } else if (typeId === 'water' && state.generation >= 3 &&
        targetAbility === 'waterabsorb' && isAbilityActive(target, state)) {
        addHpDelta(resolution, target.id, Math.floor(target.hp.max / 4));
        resolution.trace!.notes!.push(`Water Absorb restored HP for ${target.id}`);
      } else if (typeId === 'electric' && state.generation >= 3 &&
        targetAbility === 'voltabsorb' && isAbilityActive(target, state)) {
        addHpDelta(resolution, target.id, Math.floor(target.hp.max / 4));
        resolution.trace!.notes!.push(`Volt Absorb restored HP for ${target.id}`);
      } else if (typeId === 'water' && state.generation >= 4 &&
        targetAbility === 'dryskin' && isAbilityActive(target, state)) {
        addHpDelta(resolution, target.id, Math.floor(target.hp.max / 4));
        resolution.trace!.notes!.push(`Dry Skin restored HP for ${target.id}`);
      } else if (typeId === 'electric' && state.generation >= 4 &&
        targetAbility === 'lightningrod' && isAbilityActive(target, state)) {
        addBoosts(resolution, state, target.id, {spa: 1}, target.id);
        resolution.trace!.notes!.push(`Lightning Rod raised ${target.id}'s Special Attack`);
      } else if (typeId === 'water' && state.generation >= 5 &&
        targetAbility === 'stormdrain' && isAbilityActive(target, state)) {
        addBoosts(resolution, state, target.id, {spa: 1}, target.id);
        resolution.trace!.notes!.push(`Storm Drain raised ${target.id}'s Special Attack`);
      } else if (typeId === 'fire' && state.generation >= 3 &&
        targetAbility === 'flashfire' && isAbilityActive(target, state)) {
        addVolatile(resolution, [target.id], 'flashFire');
        resolution.trace!.notes!.push(`Flash Fire activated for ${target.id}`);
      }
    }
  }
  if (state.generation >= 5 && moveCategory !== 'Status' && resolvedMoveType &&
    moveId(resolvedMoveType) !== '???') {
    for (const targetId of damagingTargetIds) {
      const target = getPokemon(state, targetId);
      const damageOutcome = target
        ? sequentialDamageOutcome(
          target,
          resolution.hitDamageByTarget?.[targetId],
          resolution.damageByTarget?.[targetId] || 0,
        )
        : undefined;
      if (!target || target.hp.current <= 0 || damageOutcome?.fainted ||
        !isAbilityActive(target, state) || !isAbilityAvailable(state.generation, getEffectiveAbility(target)) ||
        moveId(getEffectiveAbility(target)) !== 'colorchange' ||
        ignoresTargetAbility(state, actor.id, target.id, moveCategory)) continue;
      if (getEffectiveTypes(state, target.id).some(type => moveId(type) === moveId(resolvedMoveType))) continue;
      setTypeOverride(resolution, target.id, [resolvedMoveType]);
      resolution.trace!.notes!.push(`Color Change changed ${target.id}'s type to ${resolvedMoveType}`);
    }
  }
  const koTargetIds = damagingTargetIds.filter(targetId => {
    const target = getPokemon(state, targetId);
    const damage = resolution.damageByTarget?.[targetId] || 0;
    return !!target && target.hp.current > 0 && sequentialDamageOutcome(
      target,
      resolution.hitDamageByTarget?.[targetId],
      damage,
      ).fainted;
  });
  if (koTargetIds.length && state.generation >= 7 && isAbilityActive(actor, state) &&
    isAbilityAvailable(state.generation, getEffectiveAbility(actor)) &&
    moveId(getEffectiveAbility(actor)) === 'battlebond' &&
    moveId(actor.species) === 'greninja' &&
    moveId(getEffectiveSpecies(actor)) !== 'greninjaash' && !actor.speciesOverride) {
    const opposingSide = sideForPokemon(state, actor.id) === 'ai' ? 'player' : 'ai';
    const hasRemainingOpponent = state.sides[opposingSide].party.some(pokemon =>
      !koTargetIds.includes(pokemon.id) && pokemon.hp.current > 0);
    if (hasRemainingOpponent) {
      setSpeciesOverride(resolution, actor.id, 'Greninja-Ash');
      addBoosts(resolution, state, actor.id, {atk: 1, spa: 1, spe: 1}, actor.id);
      resolution.trace!.notes!.push(`Battle Bond changed ${actor.id} to Greninja-Ash after a KO`);
    }
  }
  if (koTargetIds.length && state.generation >= 5 && isAbilityActive(actor, state)) {
    const actorAbility = moveId(getEffectiveAbility(actor));
    const attackBoostAbility = actorAbility === 'moxie' ||
      (state.generation >= 8 && ['chillingneigh', 'asoneglastrier'].includes(actorAbility));
    const specialAttackBoostAbility = state.generation >= 8 &&
      ['grimneigh', 'asonespectrier'].includes(actorAbility);
    if (attackBoostAbility) {
      addBoosts(resolution, state, actor.id, {atk: 1}, actor.id);
      resolution.trace!.notes!.push(`${actorAbility} raised ${actor.id}'s Attack after a KO`);
    } else if (specialAttackBoostAbility) {
      addBoosts(resolution, state, actor.id, {spa: 1}, actor.id);
      resolution.trace!.notes!.push(`${actorAbility} raised ${actor.id}'s Special Attack after a KO`);
    } else if (state.generation >= 7 && actorAbility === 'beastboost') {
      const rawStats = getRawStats(Calc.Generations.get(state.generation), actor);
      const boostStat = (['atk', 'def', 'spa', 'spd', 'spe'] as const)
        .reduce((highest, stat) => rawStats[stat] > rawStats[highest] ? stat : highest, 'atk');
      addBoosts(resolution, state, actor.id, {[boostStat]: 1}, actor.id);
      resolution.trace!.notes!.push(`Beast Boost raised ${actor.id}'s ${boostStat} after a KO`);
    }
  }
  if (koTargetIds.length && state.generation >= 7) {
    for (const sideId of ['ai', 'player'] as const) {
      for (const pokemonId of state.sides[sideId].activeIds) {
        const pokemon = getPokemon(state, pokemonId);
        if (!pokemon || pokemon.hp.current <= 0 || koTargetIds.includes(pokemon.id) ||
          !isAbilityActive(pokemon, state) || moveId(getEffectiveAbility(pokemon)) !== 'soulheart') continue;
        addBoosts(resolution, state, pokemon.id, {spa: koTargetIds.length}, pokemon.id);
        resolution.trace!.notes!.push(`Soul-Heart raised ${pokemon.id}'s Special Attack after a faint`);
      }
    }
  }
  if (koTargetIds.length && state.generation >= 7) {
    for (const targetId of koTargetIds) {
      const target = getPokemon(state, targetId);
      if (!target || !isAbilityActive(target, state) || moveId(getEffectiveAbility(target)) !== 'innardsout' ||
        hasMagicGuard(state, actor)) continue;
      addHpDelta(resolution, actor.id, -target.hp.current);
      resolution.trace!.notes!.push(`Innards Out dealt ${target.hp.current} damage to ${actor.id}`);
    }
  }
  for (const targetId of damagingTargetIds) {
    const target = getPokemon(state, targetId);
    const targetDamage = resolution.damageByTarget?.[targetId] || 0;
    const damageOutcome = target
      ? sequentialDamageOutcome(target, resolution.hitDamageByTarget?.[targetId], targetDamage)
      : undefined;
    const hitAttempts = resolution.hitDamageByTarget?.[targetId] !== undefined
      ? damageOutcome?.hitCount || 0
      : 1;
    if (!target || !isAbilityActive(target, state) ||
      ignoresTargetAbility(state, actor.id, targetId, moveCategory) || hitAttempts <= 0) continue;
    const targetAbility = moveId(getEffectiveAbility(target));
    const physicalHit = moveCategory === 'Physical';
    const typeId = moveId(resolvedMoveType);
    if (state.generation >= 5 && targetAbility === 'weakarmor' && physicalHit) {
      for (let attempt = 0; attempt < hitAttempts; attempt += 1) {
        if (!hasAbility(state, target, 'bigpecks')) addBoosts(resolution, state, target.id, {def: -1}, target.id);
        addBoosts(resolution, state, target.id, {spe: 2}, target.id);
        resolution.trace!.notes!.push(`Weak Armor changed ${target.id}'s Defense and Speed`);
      }
    } else if (state.generation >= 7 && targetAbility === 'stamina') {
      for (let attempt = 0; attempt < hitAttempts; attempt += 1) {
        addBoosts(resolution, state, target.id, {def: 1}, target.id);
        resolution.trace!.notes!.push(`Stamina raised ${target.id}'s Defense`);
      }
    }
    if (state.generation >= 7 && targetAbility === 'berserk' &&
      !(hasAbility(state, actor, 'sheerforce') && !!moveMetadata.secondaryEffects?.length &&
        !resolutionFacts?.isMultiHit)) {
      const halfHp = Math.floor(target.hp.max / 2);
      const actualDamage = damageOutcome?.directDamage || 0;
      if (target.hp.current > halfHp && actualDamage > 0 && target.hp.current - actualDamage <= halfHp) {
        addBoosts(resolution, state, target.id, {spa: 1}, target.id);
        resolution.trace!.notes!.push(`Berserk raised ${target.id}'s Special Attack`);
      }
    }
    if (state.generation >= 9 && targetAbility === 'angershell' &&
      !(hasAbility(state, actor, 'sheerforce') && !!moveMetadata.secondaryEffects?.length &&
        !resolutionFacts?.isMultiHit)) {
      const actualDamage = damageOutcome?.directDamage || 0;
      const projectedHp = target.hp.current - actualDamage;
      if (target.hp.current > target.hp.max / 2 && actualDamage > 0 && projectedHp > 0 &&
        projectedHp <= target.hp.max / 2) {
        addBoosts(resolution, state, target.id,
          {atk: 1, spa: 1, spe: 1, def: -1, spd: -1}, target.id);
        resolution.trace!.notes!.push(`Anger Shell changed ${target.id}'s offenses and defenses`);
      }
    }
    if (state.generation >= 4 && targetAbility === 'motordrive' && typeId === 'electric') {
      addBoosts(resolution, state, target.id, {spe: 1}, target.id);
      resolution.trace!.notes!.push(`Motor Drive raised ${target.id}'s Speed`);
    }
    if (state.generation >= 8 && targetAbility === 'steamengine' &&
      ['fire', 'water'].includes(typeId)) {
      for (let attempt = 0; attempt < hitAttempts; attempt += 1) {
        addBoosts(resolution, state, target.id, {spe: 6}, target.id);
        resolution.trace!.notes!.push(`Steam Engine raised ${target.id}'s Speed`);
      }
    }
    if (state.generation >= 5 && targetAbility === 'sapsipper' && typeId === 'grass') {
      addBoosts(resolution, state, target.id, {atk: 1}, target.id);
      resolution.trace!.notes!.push(`Sap Sipper raised ${target.id}'s Attack`);
    }
    if (state.generation >= 5 && targetAbility === 'justified' && typeId === 'dark') {
      for (let attempt = 0; attempt < hitAttempts; attempt += 1) {
        addBoosts(resolution, state, target.id, {atk: 1}, target.id);
        resolution.trace!.notes!.push(`Justified raised ${target.id}'s Attack`);
      }
    }
    if (state.generation >= 7 && targetAbility === 'watercompaction' && typeId === 'water') {
      for (let attempt = 0; attempt < hitAttempts; attempt += 1) {
        addBoosts(resolution, state, target.id, {def: 2}, target.id);
        resolution.trace!.notes!.push(`Water Compaction raised ${target.id}'s Defense`);
      }
    }
    if (state.generation >= 5 && targetAbility === 'rattled' &&
      ['bug', 'dark', 'ghost'].includes(typeId)) {
      for (let attempt = 0; attempt < hitAttempts; attempt += 1) {
        addBoosts(resolution, state, target.id, {spe: 1}, target.id);
        resolution.trace!.notes!.push(`Rattled raised ${target.id}'s Speed`);
      }
    }
    if (state.generation >= 9 && targetAbility === 'toxicdebris' && physicalHit) {
      const targetSide = sideForPokemon(state, target.id);
      const toxicSpikes = state.sides[targetSide].effects?.toxicSpikes || 0;
      const additions = Math.min(hitAttempts, Math.max(0, 2 - toxicSpikes));
      if (additions > 0) {
        addSideEffects(resolution, targetSide, {toxicSpikes: toxicSpikes + additions});
        resolution.trace!.notes!.push(`Toxic Debris added ${additions} Toxic Spike layer(s) to ${targetSide}`);
      }
    }
    if (state.generation >= 9 && targetAbility === 'thermalexchange' && typeId === 'fire') {
      for (let attempt = 0; attempt < hitAttempts; attempt += 1) {
        addBoosts(resolution, state, target.id, {atk: 1}, target.id);
        resolution.trace!.notes!.push(`Thermal Exchange raised ${target.id}'s Attack`);
      }
    }
  }
  for (const targetId of damagingTargetIds) {
    const target = getPokemon(state, targetId);
    const targetDamage = resolution.damageByTarget?.[targetId] || 0;
    const damageOutcome = target
      ? sequentialDamageOutcome(target, resolution.hitDamageByTarget?.[targetId], targetDamage)
      : undefined;
    const attempts = resolution.hitDamageByTarget?.[targetId] !== undefined
      ? damageOutcome?.hitCount || 0
      : 1;
    if (!target || !isAbilityActive(target, state) ||
      ignoresTargetAbility(state, actor.id, targetId, moveCategory) ||
      moveId(getEffectiveAbility(target)) !== 'cursedbody' ||
      state.generation < 5 || attempts <= 0 || actor.volatile?.disable) continue;
    const moveName = action.moveName;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (sampleActionRoll(random, 'Cursed Body chance') >= 0.3) continue;
      if (!canApplyVolatile(state, actor.id, 'disable', target.id)) break;
      addVolatile(resolution, [actor.id], 'disable', {turns: 4, moveName});
      resolution.trace!.notes!.push(`Cursed Body disabled ${moveName} on ${actor.id}`);
      break;
    }
  }
  if (state.generation >= 6 && isAbilityActive(actor, state) &&
    moveId(getEffectiveAbility(actor)) === 'magician' && !actorItemAfterMove) {
    for (const targetId of damagingTargetIds) {
      const target = getPokemon(state, targetId);
      if (!target) continue;
      const targetItem = resolvedItem(state, resolution, target);
      const targetDamage = resolution.damageByTarget?.[targetId] || 0;
      const targetFaints = sequentialDamageOutcome(
        target,
        resolution.hitDamageByTarget?.[targetId],
        targetDamage,
      ).fainted;
      if (!targetItem || (!canRemoveHeldItem(state, target) && !targetFaints)) continue;
      setItem(resolution, actor.id, targetItem);
      setItem(resolution, target.id, null);
      resolution.trace!.notes!.push(`Magician stole ${targetItem} from ${target.id}`);
      break;
    }
  }

  if (state.generation >= 5 && contactMove) {
    for (const targetId of damagingTargetIds) {
      const target = getPokemon(state, targetId);
      if (!target || !isAbilityActive(target, state) ||
        ignoresTargetAbility(state, actor.id, targetId, moveCategory) ||
        moveId(getEffectiveAbility(target)) !== 'pickpocket' ||
        sequentialDamageOutcome(
          target,
          resolution.hitDamageByTarget?.[targetId],
          resolution.damageByTarget?.[targetId] || 0,
        ).fainted) continue;
      const targetItem = resolvedItem(state, resolution, target);
      const attackerItem = resolvedItem(state, resolution, actor);
      if (targetItem || !attackerItem || !canRemoveHeldItem(state, actor)) continue;
      setItem(resolution, actor.id, null);
      setItem(resolution, target.id, attackerItem);
      resolution.trace!.notes!.push(`Pickpocket stole ${attackerItem} from ${actor.id}`);
      break;
    }
  }

  const hazardEffects: Partial<SideEffects> = {};
  if (id === 'stealthrock' && state.generation >= 4) hazardEffects.stealthRock = true;
  if (id === 'spikes' && state.generation >= 2) {
    hazardEffects.spikes = Math.min(3, (state.sides[otherSide(effectActorSide)].effects?.spikes || 0) + 1);
  }
  if (id === 'toxicspikes' && state.generation >= 4) {
    hazardEffects.toxicSpikes = Math.min(2, (state.sides[otherSide(effectActorSide)].effects?.toxicSpikes || 0) + 1);
  }
  if (id === 'stickyweb' && state.generation >= 6) hazardEffects.stickyWeb = true;
  if (Object.keys(hazardEffects).length) addSideEffects(resolution, otherSide(effectActorSide), hazardEffects);

  const screenBreakingMove = (id === 'brickbreak' && state.generation >= 3) ||
    (id === 'psychicfangs' && state.generation >= 7) ||
    (id === 'ragingbull' && state.generation >= 9);
  if (screenBreakingMove) {
    const targetSide = effectTargetIds[0] ? sideForPokemon(state, effectTargetIds[0]) : foeSide;
    addSideEffects(resolution, targetSide, {reflect: false, lightScreen: false, auroraVeil: false});
    addSideEffectDuration(resolution, targetSide, 'reflect', null);
    addSideEffectDuration(resolution, targetSide, 'lightScreen', null);
    addSideEffectDuration(resolution, targetSide, 'auroraVeil', null);
  }
  if (id === 'ceaselessedge' && state.generation >= 9) {
    const targetSide = effectTargetIds[0] ? sideForPokemon(state, effectTargetIds[0]) : foeSide;
    addSideEffects(resolution, targetSide, {
      spikes: Math.min(3, (state.sides[targetSide].effects?.spikes || 0) + 1),
    });
  }
  if (id === 'stoneaxe' && state.generation >= 9) {
    const targetSide = effectTargetIds[0] ? sideForPokemon(state, effectTargetIds[0]) : foeSide;
    addSideEffects(resolution, targetSide, {stealthRock: true});
  }

  const gmaxSideEffectByMove: Record<string, TimedSideEffectName> = {
    gmaxsteelsurge: 'steelsurge',
    gmaxvinelash: 'vinelash',
    gmaxwildfire: 'wildfire',
    gmaxcannonade: 'cannonade',
    gmaxvolcalith: 'volcalith',
  };
  const gmaxSideEffect = state.generation >= 8 ? gmaxSideEffectByMove[id] : undefined;
  if (gmaxSideEffect) {
    addSideEffects(resolution, foeSide, {[gmaxSideEffect]: true});
    addSideEffectDuration(resolution, foeSide, gmaxSideEffect, 4);
  }

  if (id === 'rapidspin' && state.generation >= 2) clearEntryHazards(resolution, actorSide);
  if (id === 'mortalspin' && state.generation >= 9) clearEntryHazards(resolution, actorSide);
  if (id === 'mortalspin' && state.generation >= 9) {
    const poisonTargets = effectTargetIds.filter(targetId =>
      canApplyMajorStatus(state, effectActorId, targetId, 'psn', moveType, true));
    addStatus(resolution, state, poisonTargets, 'psn');
  }
  if (id === 'saltcure' && state.generation >= 9) {
    for (const targetId of effectTargetIds) setSaltCure(resolution, targetId, true);
  }
  if (id === 'tidyup' && state.generation >= 9) {
    clearEntryHazards(resolution, actorSide);
    clearEntryHazards(resolution, foeSide);
    clearSubstitutes(resolution, action.targetIds);
  }

  if (id === 'defog' && state.generation >= 4) {
    for (const sideId of ['ai', 'player'] as SideId[]) {
      clearEntryHazards(resolution, sideId);
    }
    const targetSide = effectTargetIds[0] ? sideForPokemon(state, effectTargetIds[0]) : foeSide;
    addSideEffects(resolution, targetSide, {
      reflect: false,
      lightScreen: false,
      auroraVeil: false,
      safeguard: false,
    });
    addSideEffectDuration(resolution, targetSide, 'reflect', null);
    addSideEffectDuration(resolution, targetSide, 'lightScreen', null);
    addSideEffectDuration(resolution, targetSide, 'auroraVeil', null);
    addSideEffectDuration(resolution, targetSide, 'safeguard', null);
    if (state.generation <= 7) {
      for (const targetId of effectTargetIds) addBoosts(
        resolution,
        state,
        targetId,
        {eva: -1},
        effectActorId,
        true,
        ignoresTargetAbility(state, effectActorId, targetId, moveCategory),
      );
    }
  }

  if (id === 'steelroller' && state.generation >= 8 && state.field.terrain) {
    addField(resolution, {terrain: undefined});
    addFieldDuration(resolution, 'terrain', null);
    resolution.trace!.notes!.push('removed active Terrain with Steel Roller');
  }

  if (id === 'knockoff') {
    for (const targetId of effectTargetIds) {
      const target = getPokemon(state, targetId);
      if (target?.item && canRemoveHeldItem(state, target)) {
        setItem(resolution, target.id, null);
        resolution.trace!.notes!.push(`Knock Off removed the item from ${target.id}`);
      }
    }
  }
  if (id === 'trick' || id === 'switcheroo') {
    const target = effectTargetIds[0] ? getPokemon(state, effectTargetIds[0]) : undefined;
    if (target && (actor.item || target.item)) {
      setItem(resolution, actor.id, target.item || null);
      setItem(resolution, target.id, actor.item || null);
      resolution.trace!.notes!.push(`${action.moveName} exchanged held items`);
    }
  }
  if (id === 'bestow') {
    const target = effectTargetIds[0] ? getPokemon(state, effectTargetIds[0]) : undefined;
    if (target && actor.item && !target.item) {
      setItem(resolution, actor.id, null);
      setItem(resolution, target.id, actor.item);
      resolution.trace!.notes!.push('Bestow transferred the actor item');
    }
  }
  if (id === 'thief' || id === 'covet') {
    const target = effectTargetIds[0] ? getPokemon(state, effectTargetIds[0]) : undefined;
    if (target && !actor.item && target.item && canRemoveHeldItem(state, target)) {
      setItem(resolution, actor.id, target.item);
      setItem(resolution, target.id, null);
      resolution.trace!.notes!.push(`${action.moveName} stole the target item`);
    }
  }
  if (id === 'recycle' && state.generation >= 3 && !effectActor.item && effectActor.lastConsumedItem) {
    setItem(resolution, effectActorId, effectActor.lastConsumedItem);
    resolution.trace!.notes!.push(`Recycle restored ${effectActor.lastConsumedItem}`);
  }
  if (id === 'bugbite' || id === 'pluck') {
    for (const targetId of effectTargetIds) {
      const target = getPokemon(state, targetId);
      if (target && isBerry(target.item) && canRemoveHeldItem(state, target)) {
        const berry = target.item!;
        consumeItem(resolution, target.id, berry, actor.id, state.generation < 5);
        applyBerryEatEffect(resolution, state, actor, berry, random, action.moveName, false);
        resolution.trace!.notes!.push(`${action.moveName} consumed the target berry`);
      }
    }
  }

  if (id === 'courtchange') {
    addSideEffects(resolution, 'ai', courtChangeSideEffects(state.sides.player.effects || {}));
    addSideEffects(resolution, 'player', courtChangeSideEffects(state.sides.ai.effects || {}));
    const timedEffects: TimedSideEffectName[] = [
      'reflect', 'lightScreen', 'auroraVeil', 'tailwind', 'safeguard', 'mist', 'luckyChant', 'craftyShield', 'wideGuard', 'quickGuard', 'matBlock', 'steelsurge',
    ];
    for (const effect of timedEffects) {
      addSideEffectDuration(resolution, 'ai', effect, state.sides.player.effectDurations?.[effect] ?? null);
      addSideEffectDuration(resolution, 'player', effect, state.sides.ai.effectDurations?.[effect] ?? null);
    }
  }

  if (id === 'reflect' && state.generation >= 1) {
    addSideEffects(resolution, effectActorSide, {reflect: true});
    addSideEffectDuration(resolution, effectActorSide, 'reflect', extendedFieldDuration(state, effectActor, 'screen'));
  }
  if (id === 'lightscreen' && state.generation >= 1) {
    addSideEffects(resolution, effectActorSide, {lightScreen: true});
    addSideEffectDuration(resolution, effectActorSide, 'lightScreen', extendedFieldDuration(state, effectActor, 'screen'));
  }
  if (id === 'auroraveil' && state.generation >= 7 &&
    (state.field.weather === 'Hail' || state.field.weather === 'Snow')) {
    addSideEffects(resolution, effectActorSide, {auroraVeil: true});
    addSideEffectDuration(resolution, effectActorSide, 'auroraVeil', extendedFieldDuration(state, effectActor, 'screen'));
  }
  if (id === 'safeguard' && state.generation >= 2) {
    addSideEffects(resolution, effectActorSide, {safeguard: true});
    addSideEffectDuration(resolution, effectActorSide, 'safeguard', 5);
  }
  if (id === 'mist' && state.generation >= 1 && !state.sides[effectActorSide].effects?.mist) {
    addSideEffects(resolution, effectActorSide, {mist: true});
    if (state.generation >= 2) addSideEffectDuration(resolution, effectActorSide, 'mist', 5);
  }
  if (id === 'luckychant' && state.generation >= 4 && !state.sides[effectActorSide].effects?.luckyChant) {
    addSideEffects(resolution, effectActorSide, {luckyChant: true});
    addSideEffectDuration(resolution, effectActorSide, 'luckyChant', 5);
  }
  if (id === 'craftyshield' && state.generation >= 6 && !state.sides[effectActorSide].effects?.craftyShield) {
    addSideEffects(resolution, effectActorSide, {craftyShield: true});
    addSideEffectDuration(resolution, effectActorSide, 'craftyShield', 1);
  }
  if (id === 'tailwind' && state.generation >= 4) {
    const startsTailwind = !state.sides[effectActorSide].effects?.tailwind;
    addSideEffects(resolution, effectActorSide, {tailwind: true});
    addSideEffectDuration(resolution, effectActorSide, 'tailwind', 4);
    if (state.generation >= 9 && startsTailwind) {
      for (const holder of activePokemonForSide(state, effectActorSide)) {
        if (!hasAbility(state, holder, 'windpower')) continue;
        addVolatile(resolution, [holder.id], 'charged');
        resolution.trace!.notes!.push(`Wind Power charged ${holder.id} when Tailwind started`);
      }
    }
  }
  if (id === 'helpinghand') {
    addVolatile(resolution, effectTargetIds, 'helpingHand', {turns: 1});
  }
  if (id === 'followme' && state.generation >= 3) {
    addVolatile(resolution, [actor.id], 'followMe', {turns: 1});
  }
  if (id === 'ragepowder' && state.generation >= 4) {
    addVolatile(resolution, [actor.id], 'ragePowder', {turns: 1});
  }
  if (id === 'spotlight' && state.generation >= 7 && state.mode === 'Doubles') {
    addEligibleVolatile(resolution, state, effectTargetIds, 'spotlight', {turns: 1}, effectActorId, true);
  }
  if (id === 'magiccoat' && state.generation >= 4) {
    addEligibleVolatile(resolution, state, [actor.id], 'magicCoat', {turns: 1});
  }
  if (id === 'snatch' && state.generation >= 3 && state.generation < 8) {
    addEligibleVolatile(resolution, state, [actor.id], 'snatch', {turns: 1});
  }
  if (id === 'allyswitch' && state.generation >= 6) {
    resolution.allySwitchByPokemon = {[actor.id]: true};
  }
  if (id === 'wideguard' && state.generation >= 5) {
    addSideEffects(resolution, effectActorSide, {wideGuard: true});
    addSideEffectDuration(resolution, effectActorSide, 'wideGuard', 1);
  }
  if (id === 'quickguard' && state.generation >= 5) {
    addSideEffects(resolution, effectActorSide, {quickGuard: true});
    addSideEffectDuration(resolution, effectActorSide, 'quickGuard', 1);
  }
  if (id === 'matblock' && state.generation >= 6) {
    addSideEffects(resolution, effectActorSide, {matBlock: true});
    addSideEffectDuration(resolution, effectActorSide, 'matBlock', 1);
  }
  if (PROTECTIVE_MOVES.has(id) && !['wideguard', 'quickguard', 'matblock'].includes(id)) {
    addVolatile(resolution, [actor.id], 'protected', {turns: 1, moveName: action.moveName});
  }
  if (id === 'endure') {
    addVolatile(resolution, [actor.id], 'endure', {turns: 1});
  }
  if (id === 'substitute') {
    const cost = Math.floor(effectActor.hp.max / 4);
    if (effectActor.hp.current > cost && !hasSubstitute(state, effectActorId)) {
      addHpDelta(resolution, effectActorId, -cost);
      addSubstituteHp(resolution, effectActorId, cost);
    }
  }
  if (id === 'shedtail' && state.generation >= 9) {
    const cost = Math.floor(actor.hp.max / 2);
    if (actor.hp.current > cost && !hasSubstitute(state, actor.id) &&
      requestMoveSwitch(state, actor, resolution, 'substitute')) {
      addHpDelta(resolution, actor.id, -cost);
      addSubstituteHp(resolution, actor.id, Math.floor(actor.hp.max / 4));
    }
  }

  if (WEATHER_BY_SETTER[id] && state.generation >= (WEATHER_SETTER_MIN_GENERATION[id] || 1)) {
    addField(resolution, {weather: WEATHER_BY_SETTER[id]});
    addFieldDuration(resolution, 'weather', extendedFieldDuration(state, effectActor, 'weather'));
  }
  if (TERRAIN_BY_SETTER[id] && state.generation >= 6) {
    addField(resolution, {terrain: TERRAIN_BY_SETTER[id]});
    addFieldDuration(resolution, 'terrain', extendedFieldDuration(state, effectActor, 'terrain'));
    activateTerrainSeeds(resolution, state, TERRAIN_BY_SETTER[id]);
  }
  if (id === 'trickroom' && state.generation >= 4) {
    addField(resolution, {trickRoom: !state.field.trickRoom});
    if (!state.field.trickRoom) addFieldDuration(resolution, 'trickRoom', 5);
    else resolution.fieldDurations = {...(resolution.fieldDurations || {}), trickRoom: null};
  }
  if (id === 'gravity' && state.generation >= 4) {
    addField(resolution, {gravity: true});
    addFieldDuration(resolution, 'gravity', 5);
    for (const sideId of ['ai', 'player'] as SideId[]) {
      for (const pokemon of state.sides[sideId].party) {
        if (!state.sides[sideId].activeIds.includes(pokemon.id)) continue;
        if (pokemon.volatile?.magnetRise) clearVolatile(resolution, pokemon.id, 'magnetRise');
        if (pokemon.volatile?.telekinesis) clearVolatile(resolution, pokemon.id, 'telekinesis');
      }
    }
  }
  if (id === 'magicroom' && state.generation >= 5) {
    const active = state.field.magicRoom === true;
    addField(resolution, {magicRoom: !active});
    addFieldDuration(resolution, 'magicRoom', active ? null : 5);
  }
  if (id === 'wonderroom' && state.generation >= 5) {
    const active = state.field.wonderRoom === true;
    addField(resolution, {wonderRoom: !active});
    addFieldDuration(resolution, 'wonderRoom', active ? null : 5);
  }
  if (id === 'fairylock' && state.generation >= 6) {
    addField(resolution, {fairyLock: true});
    // Keep the lock through the following beginNextTurn boundary.
    addFieldDuration(resolution, 'fairyLock', 2);
  }
  if ((id === 'watersport' || id === 'mudsport') && state.generation >= 3 && state.generation <= 7) {
    const effect = id === 'watersport' ? 'waterSport' : 'mudSport';
    if (state.generation <= 5) {
    addVolatile(resolution, [effectActorId], effect);
    } else {
      addField(resolution, {[effect]: true});
      addFieldDuration(resolution, effect, 5);
    }
  }
  if (id === 'iondeluge' && state.generation >= 6 && state.generation <= 7) {
    addField(resolution, {ionDeluge: true});
    addFieldDuration(resolution, 'ionDeluge', 1);
  }

  if (id === 'flowershield' && state.generation >= 6 && state.generation <= 8) {
    for (const targetId of effectTargetIds) {
      if (getEffectiveTypes(state, targetId).some(type => moveId(type) === 'grass')) {
        addBoosts(
          resolution,
          state,
          targetId,
          {def: 1},
          effectActorId,
          true,
          ignoresTargetAbility(state, effectActorId, targetId, moveCategory),
        );
      }
    }
  }
  if (id === 'rototiller' && state.generation >= 6 && state.generation <= 7) {
    for (const targetId of effectTargetIds) {
      if (isGrounded(state, targetId) &&
        getEffectiveTypes(state, targetId).some(type => moveId(type) === 'grass')) {
        addBoosts(
          resolution,
          state,
          targetId,
          {atk: 1, spa: 1},
          effectActorId,
          true,
          ignoresTargetAbility(state, effectActorId, targetId, moveCategory),
        );
      }
    }
  }
  if (id === 'teatime' && state.generation === 8) {
    for (const targetId of effectTargetIds) {
      const target = getPokemon(state, targetId);
      if (!target || !isBerry(target.item)) continue;
      const berry = target.item!;
      consumeItem(resolution, target.id, berry);
      applyBerryEatEffect(resolution, state, target, berry, random, 'Teatime');
      resolution.trace!.notes!.push(`Teatime consumed ${target.id}'s ${berry}`);
    }
  }

  if (id === 'soak' && state.generation >= 5) {
    const targetId = effectTargetIds[0];
    if (targetId) setTypeOverride(resolution, targetId, ['Water']);
  }
  if (id === 'magicpowder' && state.generation >= 8) {
    const targetId = effectTargetIds[0];
    if (targetId) setTypeOverride(resolution, targetId, ['Psychic']);
  }
  if (id === 'forestscurse' && state.generation >= 6) {
    const targetId = effectTargetIds[0];
    const targetTypes = targetId ? getEffectiveTypes(state, targetId) : [];
    if (targetId && !targetTypes.some(type => moveId(type) === 'grass')) {
      setTypeOverride(resolution, targetId, [...targetTypes, 'Grass']);
    }
  }
  if (id === 'trickortreat' && state.generation >= 6) {
    const targetId = effectTargetIds[0];
    const targetTypes = targetId ? getEffectiveTypes(state, targetId) : [];
    if (targetId && !targetTypes.some(type => moveId(type) === 'ghost')) {
      setTypeOverride(resolution, targetId, [...targetTypes, 'Ghost']);
    }
  }
  if (id === 'reflecttype' && state.generation >= 5) {
    const targetId = effectTargetIds[0];
    const targetTypes = targetId ? getEffectiveTypes(state, targetId) : [];
    if (targetTypes.length) setTypeOverride(resolution, effectActorId, targetTypes);
  }
  if (id === 'camouflage' && state.generation >= 4) {
    const terrainType: Record<string, string> = {
      Electric: 'Electric', Grassy: 'Grass', Misty: 'Fairy', Psychic: 'Psychic',
    };
    setTypeOverride(resolution, effectActorId, [terrainType[state.field.terrain || ''] || 'Normal']);
  }
  if (id === 'conversion' && state.generation >= 1) {
    const move = state.generation >= 6
      ? effectActor.moves[0]
      : effectActor.moves.find(candidate => !['conversion', 'conversion2'].includes(moveId(candidate.name)));
    const moveType = move ? getMoveMetadata(move.name, state.generation).type : undefined;
    const currentTypes = getEffectiveTypes(state, effectActorId);
    if (moveType && moveId(moveType) !== '???' && !currentTypes.some(type => moveId(type) === moveId(moveType))) {
      setTypeOverride(resolution, effectActorId, [moveType]);
    }
  }
  if (id === 'conversion2' && state.generation >= 2) {
    const sourcePokemonId = state.generation >= 5 ? targetIds[0] : actor.id;
    const sourceMoveName = state.generation >= 5
      ? (sourcePokemonId ? state.lastMoveUsedByPokemon?.[sourcePokemonId] : undefined)
      : state.lastDamagingMoveByPokemon?.[actor.id];
    const sourceMoveType = sourceMoveName
      ? getMoveMetadata(sourceMoveName, state.generation).type
      : undefined;
    const typeData = sourceMoveType && moveId(sourceMoveType) !== '???'
      ? Calc.Generations.get(state.generation).types.get(Calc.toID(sourceMoveType))
      : undefined;
    const currentTypes = getEffectiveTypes(state, effectActorId);
    const candidates = typeData
      ? Array.from(Calc.Generations.get(state.generation).types)
        .filter(type => moveId(type.name) !== '???')
        .filter(type => state.generation < 4 || !currentTypes.some(current => moveId(current) === moveId(type.name)))
        .filter(type => (typeData.effectiveness[type.name] ?? 1) < 1)
        .map(type => type.name)
      : [];
    if (state.generation >= 9 && moveId(sourceMoveType) === 'stellar') candidates.length = 0;
    if (!candidates.length) {
      return {
        ...resolution,
        hit: false,
        trace: {
          ...(resolution.trace || {source: 'battle-engine' as const}),
          hit: false,
          notes: [...(resolution.trace?.notes || []), `${action.moveName} failed: no resistant type was available`],
        },
      };
    }
    const selectedType = candidates[Math.floor(random() * candidates.length)];
    setTypeOverride(resolution, effectActorId, [selectedType]);
    resolution.trace!.notes!.push(`${action.moveName} selected ${selectedType} against ${sourceMoveType}`);
  }

  if (id === 'roleplay' && state.generation >= 3) {
    const targetId = effectTargetIds[0];
    const target = targetId ? getPokemon(state, targetId) : undefined;
    const ability = target && isAbilityActive(target, state)
      ? getGenerationAbility(state.generation, target)
      : undefined;
    if (ability && !preventsAbilityChange(state, actor)) setAbilityOverride(resolution, actor.id, ability);
  }
  if (id === 'skillswap' && state.generation >= 3) {
    const targetId = effectTargetIds[0];
    const target = targetId ? getPokemon(state, targetId) : undefined;
    const actorAbility = isAbilityActive(actor, state) ? getGenerationAbility(state.generation, actor) : undefined;
    const targetAbility = target && isAbilityActive(target, state)
      ? getGenerationAbility(state.generation, target)
      : undefined;
    if (target && actorAbility && targetAbility && !preventsAbilityChange(state, actor) &&
      !preventsAbilityChange(state, target)) {
      setAbilityOverride(resolution, actor.id, targetAbility);
      setAbilityOverride(resolution, target.id, actorAbility);
    }
  }
  if (id === 'entrainment' && state.generation >= 5) {
    const targetId = effectTargetIds[0];
    const ability = isAbilityActive(actor, state) ? getGenerationAbility(state.generation, actor) : undefined;
    const target = targetId ? getPokemon(state, targetId) : undefined;
    if (targetId && ability && target && !preventsAbilityChange(state, target)) setAbilityOverride(resolution, targetId, ability);
  }
  if (id === 'simplebeam' && state.generation >= 5) {
    const targetId = effectTargetIds[0];
    const target = targetId ? getPokemon(state, targetId) : undefined;
    if (targetId && target && !preventsAbilityChange(state, target)) setAbilityOverride(resolution, targetId, 'Simple');
  }
  if (id === 'worryseed' && state.generation >= 4) {
    const targetId = effectTargetIds[0];
    const target = targetId ? getPokemon(state, targetId) : undefined;
    if (targetId && target && !preventsAbilityChange(state, target)) setAbilityOverride(resolution, targetId, 'Insomnia');
  }
  if (id === 'doodle' && state.generation >= 9) {
    const targetId = effectTargetIds[0];
    const target = targetId ? getPokemon(state, targetId) : undefined;
    const ability = target && isAbilityActive(target, state)
      ? getGenerationAbility(state.generation, target)
      : undefined;
    if (ability && !preventsAbilityChange(state, actor)) setAbilityOverride(resolution, actor.id, ability);
  }
  if (id === 'gastroacid' && state.generation >= 4) {
    const targetId = effectTargetIds[0];
    const target = targetId ? getPokemon(state, targetId) : undefined;
    if (targetId && target && !preventsAbilityChange(state, target)) setAbilitySuppressed(resolution, targetId, true);
  }
  if ((id === 'powertrick' && state.generation >= 4) || (id === 'powershift' && state.generation >= 9)) {
    const rawStats = getRawStats(Calc.Generations.get(state.generation), effectActor);
    setStatOverrides(resolution, effectActorId, {atk: rawStats.def, def: rawStats.atk});
  }
  if ((id === 'roar' || id === 'whirlwind') && state.generation >= 2) {
    for (const targetId of effectTargetIds) {
      if (canBeForcedOut(state, targetId, actor.id, moveCategory)) setForcedSwitch(resolution, targetId);
    }
  }
  if ((id === 'dragontail' || id === 'circlethrow') && state.generation >= 5) {
    for (const targetId of effectTargetIds) {
      if (canBeForcedOut(state, targetId, actor.id, moveCategory)) setForcedSwitch(resolution, targetId);
    }
  }
  if (id === 'partingshot' && state.generation >= 6 && effectTargetIds.length) {
    for (const targetId of effectTargetIds) addBoosts(
      resolution,
      state,
      targetId,
      {atk: -1, spa: -1},
      actor.id,
      true,
      ignoresTargetAbility(state, actor.id, targetId, moveCategory),
    );
    requestMoveSwitch(state, actor, resolution);
  }
  if (id === 'uturn' && state.generation >= 4 && effectTargetIds.length) {
    requestMoveSwitch(state, actor, resolution);
  }
  if (id === 'voltswitch' && state.generation >= 5 && effectTargetIds.length) {
    requestMoveSwitch(state, actor, resolution);
  }
  if (id === 'flipturn' && state.generation >= 8 && effectTargetIds.length) {
    requestMoveSwitch(state, actor, resolution);
  }
  if (id === 'teleport' && state.generation >= 2) {
    requestMoveSwitch(state, actor, resolution);
  }
  if (id === 'chillyreception' && state.generation >= 9) {
    requestMoveSwitch(state, actor, resolution);
  }
  if (id === 'batonpass' && state.generation >= 2) {
    requestMoveSwitch(state, actor, resolution, 'batonPass');
  }

  const selfBoosts = SELF_BOOSTS[id];
  const stockpileCount = effectActor.volatile?.stockpile?.stacks || 0;
  if (selfBoosts && state.generation >= (STAT_STAGE_MOVE_GENERATIONS[id] || 1) &&
    !(id === 'stockpile' && stockpileCount >= 3) &&
    !(SECONDARY_BOOST_MOVES.has(id) && secondaryEffects !== undefined)) {
    addBoosts(resolution, state, effectActorId, selfBoosts, effectActorId);
  }
  if (id === 'noretreat' && state.generation >= 8 && !actor.volatile?.trapped) {
    addBoosts(resolution, state, actor.id, {atk: 1, def: 1, spa: 1, spd: 1, spe: 1}, actor.id);
    addVolatile(resolution, [actor.id], 'trapped');
  }
  if (id === 'clangoroussoul' && state.generation >= 8 && actor.hp.current > Math.floor(actor.hp.max / 3)) {
    addHpDelta(resolution, actor.id, -Math.floor(actor.hp.max / 3));
    addBoosts(resolution, state, actor.id, {atk: 1, def: 1, spa: 1, spd: 1, spe: 1}, actor.id);
  }
  if (id === 'filletaway' && state.generation >= 9 && actor.hp.current > Math.floor(actor.hp.max / 2)) {
    addHpDelta(resolution, actor.id, -Math.floor(actor.hp.max / 2));
    addBoosts(resolution, state, actor.id, {atk: 2, def: 2, spa: 2, spd: 2, spe: 2}, actor.id);
  }
  if (id === 'victorydance' && state.generation >= 9) {
    addBoosts(resolution, state, actor.id, {atk: 1, def: 1, spe: 1}, actor.id);
  }
  if (id === 'stockpile' && stockpileCount < 3) {
    addVolatile(resolution, [effectActorId], 'stockpile', {stacks: stockpileCount + 1});
  }
  if (id === 'stuffcheeks' && state.generation >= 8 && effectActor.item && isBerry(effectActor.item) &&
    !effectActor.itemCorroded && !effectActor.volatile?.embargo) {
    addBoosts(resolution, state, effectActorId, {def: 2}, effectActorId);
    const berry = effectActor.item;
    consumeItem(resolution, effectActorId, berry);
    applyCheekPouch(resolution, state, effectActor, berry);
    armCudChew(resolution, state, effectActor, berry);
    resolution.trace!.notes!.push('Stuff Cheeks consumed the actor berry and raised Defense');
  }
  if (id === 'aquaring' && state.generation >= 4) {
    addEligibleVolatile(resolution, state, [effectActorId], 'aquaRing');
  }
  if (id === 'ingrain' && state.generation >= 3) {
    addEligibleVolatile(resolution, state, [effectActorId], 'ingrain');
  }
  if (id === 'magnetrise' && state.generation >= 4) {
    addEligibleVolatile(resolution, state, [effectActorId], 'magnetRise', {turns: 5});
  }
  if (id === 'telekinesis' && state.generation >= 5) {
    addEligibleVolatile(resolution, state, effectTargetIds, 'telekinesis', {turns: 3}, effectActorId, true);
  }
  if ((id === 'smackdown' && state.generation >= 5) ||
    (id === 'thousandarrows' && state.generation >= 6)) {
    for (const targetId of effectTargetIds) {
      if (isGrounded(state, targetId)) continue;
      const target = getPokemon(state, targetId);
      if (target?.volatile?.magnetRise) clearVolatile(resolution, targetId, 'magnetRise');
      if (target?.volatile?.telekinesis) clearVolatile(resolution, targetId, 'telekinesis');
      addEligibleVolatile(resolution, state, [targetId], 'landed');
    }
  }
  if (id === 'roost' && state.generation >= 4 && effectActor.hp.current < effectActor.hp.max) {
    addEligibleVolatile(resolution, state, [effectActorId], 'roost', {turns: 1});
  }
  if (id === 'coaching') {
    for (const targetId of effectTargetIds) addBoosts(resolution, state, targetId, {atk: 1, def: 1}, effectActorId);
  }
  if (id === 'decorate') {
    for (const targetId of effectTargetIds) addBoosts(
      resolution,
      state,
      targetId,
      {atk: 2, spa: 2},
      effectActorId,
      true,
      ignoresTargetAbility(state, effectActorId, targetId, moveCategory),
    );
  }
  if (id === 'acupressure') {
    for (const targetId of effectTargetIds) {
      const stat = randomAcupressureStat(state, targetId, random);
      if (stat) addBoosts(resolution, state, targetId, {[stat]: 2});
    }
  }
  const statTarget = effectTargetIds[0] ? getPokemon(state, effectTargetIds[0]) : undefined;
  if (statTarget && id === 'speedswap' && state.generation >= 7) {
    const gen = Calc.Generations.get(state.generation);
    const actorRaw = getRawStats(gen, actor);
    const targetRaw = getRawStats(gen, statTarget);
    setStatOverrides(resolution, actor.id, {spe: targetRaw.spe});
    setStatOverrides(resolution, statTarget.id, {spe: actorRaw.spe});
  }
  if (statTarget && id === 'guardsplit' && state.generation >= 5) {
    const gen = Calc.Generations.get(state.generation);
    const actorRaw = getRawStats(gen, actor);
    const targetRaw = getRawStats(gen, statTarget);
    const def = Math.floor((actorRaw.def + targetRaw.def) / 2);
    const spd = Math.floor((actorRaw.spd + targetRaw.spd) / 2);
    setStatOverrides(resolution, actor.id, {def, spd});
    setStatOverrides(resolution, statTarget.id, {def, spd});
  }
  if (statTarget && id === 'powersplit' && state.generation >= 5) {
    const gen = Calc.Generations.get(state.generation);
    const actorRaw = getRawStats(gen, actor);
    const targetRaw = getRawStats(gen, statTarget);
    const atk = Math.floor((actorRaw.atk + targetRaw.atk) / 2);
    const spa = Math.floor((actorRaw.spa + targetRaw.spa) / 2);
    setStatOverrides(resolution, actor.id, {atk, spa});
    setStatOverrides(resolution, statTarget.id, {atk, spa});
  }
  if (statTarget && id === 'psychup') {
    setBoosts(resolution, actor.id, allBoostStages(statTarget));
  }
  if (statTarget && id === 'guardswap') {
    setBoosts(resolution, actor.id, {
      def: statTarget.boosts?.def || 0,
      spd: statTarget.boosts?.spd || 0,
    });
    setBoosts(resolution, statTarget.id, {
      def: actor.boosts?.def || 0,
      spd: actor.boosts?.spd || 0,
    });
  }
  if (statTarget && id === 'powerswap') {
    setBoosts(resolution, actor.id, {
      atk: statTarget.boosts?.atk || 0,
      spa: statTarget.boosts?.spa || 0,
    });
    setBoosts(resolution, statTarget.id, {
      atk: actor.boosts?.atk || 0,
      spa: actor.boosts?.spa || 0,
    });
  }
  if (statTarget && id === 'heartswap' && state.generation >= 4) {
    setBoosts(resolution, actor.id, allBoostStages(statTarget));
    setBoosts(resolution, statTarget.id, allBoostStages(actor));
  }
  if (statTarget && id === 'spectralthief' && state.generation >= 7) {
    const actorStages = allBoostStages(actor);
    const targetStages = allBoostStages(statTarget);
    for (const stat of STAGE_IDS) {
      const stolen = Math.max(0, targetStages[stat] || 0);
      actorStages[stat] = Math.max(-6, Math.min(6, (actorStages[stat] || 0) + stolen));
      targetStages[stat] = (targetStages[stat] || 0) - stolen;
    }
    setBoosts(resolution, actor.id, actorStages);
    setBoosts(resolution, statTarget.id, targetStages);
  }
  const selfStatChanges = SELF_STAT_CHANGES[id];
  if (selfStatChanges) addBoosts(resolution, state, effectActorId, selfStatChanges, effectActorId);
  if ((id === 'burnup' && state.generation >= 7) || (id === 'doubleshock' && state.generation >= 9)) {
    setTypeOverride(resolution, effectActorId, []);
    resolution.trace!.notes!.push(`${action.moveName} made ${effectActorId} typeless until switching`);
  }
  if (id === 'relicsong' && state.generation >= 5) {
    const effectiveSpecies = moveId(getEffectiveSpecies(effectActor));
    if (effectiveSpecies === 'meloetta' || effectiveSpecies === 'meloettapirouette') {
      const nextSpecies = effectiveSpecies === 'meloettapirouette' ? 'Meloetta' : 'Meloetta-Pirouette';
      setSpeciesOverride(resolution, effectActorId, nextSpecies);
      resolution.trace!.notes!.push(`${action.moveName} changed ${effectActorId} to ${nextSpecies}`);
    }
  }
  if (id === 'tidyup' && state.generation >= 9) {
    addBoosts(resolution, state, actor.id, {atk: 1, spe: 1}, actor.id);
  }
  if (id === 'haze') resetBoosts(resolution, effectTargetIds);
  if (id === 'clearsmog') resetBoosts(resolution, effectTargetIds);
  const targetBoosts = TARGET_BOOSTS[id];
  if (targetBoosts && state.generation >= (STAT_STAGE_MOVE_GENERATIONS[id] || 1) &&
    !(SECONDARY_BOOST_MOVES.has(id) && secondaryEffects !== undefined)) {
    const boostTargetIds = id === 'captivate'
      ? effectTargetIds.filter(targetId => {
        const target = getPokemon(state, targetId);
        return !!actor.gender && actor.gender !== 'N' && !!target?.gender && target.gender !== 'N' &&
          actor.gender !== target.gender;
      })
      : effectTargetIds;
    for (const targetId of boostTargetIds) addBoosts(
      resolution,
      state,
      targetId,
      targetBoosts,
      effectActorId,
      true,
      ignoresTargetAbility(state, effectActorId, targetId, moveCategory),
    );
  }
  if (id === 'tarshot') {
    addEligibleVolatile(resolution, state, effectTargetIds, 'tarShot', {}, effectActorId, true);
  }
  if (id === 'swagger' || id === 'flatter') {
    addConfusion(resolution, state, effectTargetIds, random, effectActorId);
  }
  if (id === 'attract') addEligibleVolatile(resolution, state, effectTargetIds, 'infatuated', {}, effectActorId, true);
  const status = STATUS_BY_MOVE[id];
  if (status) {
    const statusTargets = effectTargetIds.filter(targetId =>
      canApplyMajorStatus(state, effectActorId, targetId, status, moveType, true));
    addStatus(resolution, state, statusTargets, status);
    if (status === 'slp') {
      for (const targetId of statusTargets) {
        if (resolution.statusByPokemon?.[targetId] !== '') {
          setStatusTurns(resolution, targetId, Math.floor(sampleActionRoll(random, 'Sleep duration') * 3) + 2);
        }
      }
    }
  }
  // Taunt is 3 turns, which yields the correct three taunted actions for a
  // target that has not yet moved. A target Taunted AFTER it acted gets only
  // two, because this engine decrements at the turn boundary and the state
  // model carries no already-moved signal to compensate with. Documented
  // rather than guessed: inventing that signal from lastMoveByPokemon would
  // misfire on any mon that moved on an earlier turn.
  if (id === 'taunt') addEligibleVolatile(resolution, state, effectTargetIds, 'taunt', {turns: 3}, effectActorId, true);
  if (id === 'embargo' && state.generation >= 4) {
    addEligibleVolatile(resolution, state, effectTargetIds, 'embargo', {turns: 5}, effectActorId, true);
  }
  if (id === 'healblock' && state.generation >= 4) {
    addEligibleVolatile(resolution, state, effectTargetIds, 'healBlock', {turns: 5}, effectActorId, true);
  }
  if (id === 'encore') {
    for (const targetId of effectTargetIds) {
      addEligibleVolatile(resolution, state, [targetId], 'encore', {
        turns: 3,
        moveName: state.lastMoveByPokemon?.[targetId],
      }, effectActorId, true);
    }
  }
  if (id === 'imprison') {
    addVolatile(resolution, [effectActorId], 'imprison', {
      moveNames: effectActor.moves.map(move => move.name),
    });
  }
  if (id === 'disable') {
    for (const targetId of effectTargetIds) {
      const moveName = state.lastMoveByPokemon?.[targetId];
      if (moveName) addEligibleVolatile(resolution, state, [targetId], 'disable', {
        turns: 4,
        moveName,
      }, effectActorId, true);
    }
  }
  if (PURE_PP_MOVE_IDS.has(id)) {
    const ppLoss = getPurePPLoss(state, id);
    for (const targetId of effectTargetIds) {
      const target = getPokemon(state, targetId);
      const lastMove = target ? getLastMoveState(state, target) : undefined;
      if (!target || !lastMove || lastMove.pp === undefined) continue;
      const reducedPP = Math.max(0, lastMove.pp - ppLoss);
      const lastMoveId = moveId(lastMove.name);
      setMoves(resolution, target.id, target.moves.map(candidate =>
        moveId(candidate.name) === lastMoveId ? {...candidate, pp: reducedPP} : candidate));
      resolution.trace!.notes!.push(`${action.moveName} reduced ${target.id}'s ${lastMove.name} PP by ${ppLoss}`);
    }
  }
  if (id === 'torment') {
    addEligibleVolatile(resolution, state, effectTargetIds, 'torment', {}, effectActorId, true);
  }
  if (id === 'yawn') {
    const yawnTargets = effectTargetIds.filter(targetId =>
      !getPokemon(state, targetId)?.volatile?.yawn &&
      canApplyMajorStatus(state, effectActorId, targetId, 'slp', moveType, true));
    // Duration 2: this turn is the grace turn Gen 8 gives the target to
    // switch or act; the sleep lands at the end of the NEXT turn.
    addVolatile(resolution, yawnTargets, 'yawn', {turns: 2, sourceId: effectActorId});
  }
  if (id === 'leechseed') {
    const seedTargets = effectTargetIds.filter(targetId =>
      canApplyVolatile(state, targetId, 'leechSeed', effectActorId, true));
    addVolatile(resolution, seedTargets, 'leechSeed', {sourceId: effectActorId});
  }
  if (id === 'perishsong') {
    addEligibleVolatile(resolution, state, effectTargetIds, 'perishSong', {turns: 3}, effectActorId, true);
  }
  if (id === 'foresight' || id === 'odorsleuth') {
    addEligibleVolatile(resolution, state, effectTargetIds, 'foresight', {}, effectActorId, true);
  }
  if (id === 'miracleeye') {
    addEligibleVolatile(resolution, state, effectTargetIds, 'miracleEye', {}, effectActorId, true);
  }
  if (id === 'destinybond') addVolatile(resolution, [actor.id], 'destinyBond', {turns: 1});
  if (id === 'grudge' && state.generation >= 3) addVolatile(resolution, [actor.id], 'grudge');
  if (id === 'focusenergy') addVolatile(resolution, [actor.id], 'focusEnergy');
  if (id === 'laserfocus') addVolatile(resolution, [actor.id], 'laserFocus', {turns: 1});

  if (resolutionFacts) {
    resolveSecondaryEffects(resolution, state, actionForEffects, resolutionFacts, moveType, random);
  }
  if (id === 'fling') {
    resolveFlingItemEffects(resolution, state, actor, effectTargetIds, moveType, moveCategory || 'Physical');
    resolveFlingBerryEffect(resolution, state, actor, effectTargetIds, random);
  }

  if (id === 'confuseray' || id === 'sweetkiss' || id === 'supersonic' || id === 'teeterdance') {
    addConfusion(resolution, state, effectTargetIds, random, actor.id);
  }
  if (id === 'block' || id === 'meanlook' || id === 'spiderweb') {
    addEligibleVolatile(resolution, state, effectTargetIds, 'trapped', {sourceId: actor.id}, actor.id, true);
  }
  if (id === 'psychoshift' && actor.status) {
    const targetId = effectTargetIds[0];
    const target = targetId ? getPokemon(state, targetId) : undefined;
    if (target && canApplyMajorStatus(state, actor.id, target.id, actor.status, moveType, true)) {
      const transferredStatus = actor.status;
      addStatus(resolution, state, [target.id], transferredStatus);
      clearMajorStatus(resolution, state, [actor.id]);
    }
  }
  if (id === 'topsyturvy' && state.generation >= 6) {
    for (const targetId of effectTargetIds) {
      const target = getPokemon(state, targetId);
      if (!target) continue;
      setBoosts(resolution, targetId, Object.fromEntries(
        STAGE_IDS.map(stat => {
          const stage = target.boosts?.[stat] || 0;
          return [stat, stage ? -stage : 0];
        }),
      ));
    }
  }
  if (id === 'curse') {
    if (isGhostType(state, actor.id)) {
      const curseTargets = effectTargetIds.filter(targetId =>
        canApplyVolatile(state, targetId, 'curse', actor.id, true));
      if (curseTargets.length) {
        addHpDelta(resolution, actor.id, -Math.floor(actor.hp.max / 2));
        addVolatile(resolution, curseTargets, 'curse', {sourceId: actor.id});
      }
    } else {
      addBoosts(resolution, state, actor.id, {atk: 1, def: 1, spe: -1}, actor.id);
    }
  } else if (id === 'strengthsap') {
    const targetId = effectTargetIds[0];
    const target = targetId ? getPokemon(state, targetId) : undefined;
    if (target) {
      const recovery = heldItemEffectsActive(state, actor) && state.generation >= 4 &&
        moveId(actor.item) === 'bigroot'
        ? Math.floor(currentAttackStat(state, target) * 13 / 10)
        : currentAttackStat(state, target);
      if (liquidOozeApplies(state, target, action.moveName)) {
        if (!hasMagicGuard(state, actor)) addHpDelta(resolution, actor.id, -recovery);
        resolution.trace!.notes!.push(`Liquid Ooze damaged ${actor.id} through Strength Sap`);
      } else {
        addHpDelta(resolution, actor.id, recovery);
      }
      addBoosts(
        resolution,
        state,
        target.id,
        {atk: -1},
        actor.id,
        true,
        ignoresTargetAbility(state, actor.id, target.id, moveCategory),
      );
    }
  } else if (id === 'rest') {
    const canRest = effectActor.hp.current < effectActor.hp.max && canApplyMajorStatus(
      state,
      effectActorId,
      effectActorId,
      'slp',
      undefined,
      false,
      true,
    );
    if (canRest && !effectActor.volatile?.healBlock) {
      addHpDelta(resolution, effectActorId, effectActor.hp.max - effectActor.hp.current);
      addStatus(resolution, state, [effectActorId], 'slp', true);
      setStatusTurns(resolution, effectActorId, 3);
      resolution.toxicCounterByPokemon = {[effectActorId]: 0};
    }
  } else if (RECOVERY_MOVES.has(id) && !effectActor.volatile?.healBlock) {
    const [numerator, denominator] = recoveryFraction(state, id);
    addHpDelta(resolution, effectActorId, Math.floor(effectActor.hp.max * numerator / denominator));
  }
  if (id === 'swallow') {
    if (stockpileCount > 0 && !effectActor.volatile?.healBlock) {
      const numerator = 1;
      const denominator = stockpileCount === 3 ? 1 : stockpileCount === 2 ? 2 : 4;
      addHealing(resolution, state, effectActorId, numerator, denominator);
      clearVolatile(resolution, effectActorId, 'stockpile');
    }
  }
  if (id === 'spitup' && stockpileCount > 0) clearVolatile(resolution, effectActorId, 'stockpile');

  if (id === 'healpulse' || id === 'floralhealing' ||
    (id === 'pollenpuff' && effectTargetIds.some(targetId => sideForPokemon(state, targetId) === effectActorSide))) {
    const [numerator, denominator] = id === 'floralhealing' && state.field.terrain === 'Grassy'
      ? [2, 3]
      : [1, 2];
    for (const targetId of effectTargetIds) {
      if (sideForPokemon(state, targetId) === effectActorSide) {
        addHealing(resolution, state, targetId, numerator, denominator);
      }
    }
  }
  if (id === 'lifedew' || id === 'junglehealing' || id === 'lunarblessing') {
    const allies = effectTargetIds.filter(targetId => sideForPokemon(state, targetId) === effectActorSide);
    for (const targetId of allies) addHealing(resolution, state, targetId, 1, 4);
    if (id === 'junglehealing' || id === 'lunarblessing') clearMajorStatus(resolution, state, allies);
  }
  if (id === 'painsplit') {
    const targetId = effectTargetIds[0];
    const target = targetId ? getPokemon(state, targetId) : undefined;
    if (target) {
      const average = Math.floor((actor.hp.current + target.hp.current) / 2);
      addHpDelta(resolution, actor.id, average - actor.hp.current);
      addHpDelta(resolution, target.id, average - target.hp.current);
    }
  }
  if (id === 'refresh' || id === 'takeheart') clearMajorStatus(resolution, state, [effectActorId]);
  if (id === 'purify') {
    const targetId = effectTargetIds[0];
    const target = targetId ? getPokemon(state, targetId) : undefined;
    if (target && (target.status || target.toxicCounter)) {
      clearMajorStatus(resolution, state, [target.id]);
      addHealing(resolution, state, actor.id, 1, 2);
    }
  }
  if (id === 'aromatherapy' || id === 'healbell') {
    clearMajorStatus(resolution, state, effectTargetIds.filter(targetId =>
      sideForPokemon(state, targetId) === effectActorSide));
  }

  if (id === 'bellydrum' && effectActor.hp.current > Math.floor(effectActor.hp.max / 2)) {
    addHpDelta(resolution, effectActorId, Math.floor(effectActor.hp.max / 2) - effectActor.hp.current);
    addBoosts(resolution, state, effectActorId, {atk: 6}, effectActorId);
    if (heldItemEffectsActive(state, effectActor) && moveId(effectActor.item) === 'sitrusberry') {
      if (!effectActor.volatile?.healBlock) {
        addHpDelta(resolution, effectActorId, Math.floor(effectActor.hp.max / 4));
      }
      const berry = effectActor.item!;
      consumeItem(resolution, effectActorId, berry);
      applyCheekPouch(resolution, state, effectActor, berry);
      armCudChew(resolution, state, effectActor, berry);
      resolution.trace!.notes!.push('Belly Drum triggered and consumed Sitrus Berry');
    }
  }
  if (id === 'shellsmash') {
    addBoosts(resolution, state, effectActorId,
      {atk: 2, spa: 2, spe: 2, def: -1, spd: -1}, effectActorId);
  }
  if (id === 'memento') {
    for (const targetId of effectTargetIds) addBoosts(
      resolution,
      state,
      targetId,
      {atk: -2, spa: -2},
      actor.id,
      true,
      ignoresTargetAbility(state, actor.id, targetId, moveCategory),
    );
    addHpDelta(resolution, actor.id, -actor.hp.current);
  }
  if ((id === 'healingwish' || id === 'lunardance') && state.generation >= 4) {
    if (!requestMoveSwitch(state, effectActor, resolution)) {
      return {
        ...resolution,
        hit: false,
        trace: {
          ...(resolution.trace || {source: 'battle-engine' as const}),
          hit: false,
          notes: [
            ...(resolution.trace?.notes || []),
            `${action.moveName} failed because no legal replacement was available`,
          ],
        },
      };
    }
    addHpDelta(resolution, effectActorId, -effectActor.hp.current);
    setPendingFullHeal(resolution, effectActorSide);
    resolution.trace!.notes!.push(`scheduled ${action.moveName} full healing on the next replacement`);
  }
  if (isSelfSacrificeMove(action.moveName)) {
    addHpDelta(resolution, actor.id, -actor.hp.current);
  }

  const hpEffects = getMoveHpEffects(state.generation, action.moveName);
  const damage = totalDamage(resolution);
  const recoilBlocked = isAbilityActive(actor, state) && isAbilityAvailable(state.generation, getEffectiveAbility(actor)) &&
    moveId(getEffectiveAbility(actor)) === 'rockhead' && id !== 'struggle';
  const recoilDamage = id === 'struggle'
    ? Math.max(1, Math.floor(actor.hp.max / 4))
    : hpEffects.recoil && damage > 0
      ? Math.max(1, Math.floor(damage * hpEffects.recoil[0] / hpEffects.recoil[1]))
      : 0;
  if (hpEffects.recoil && !recoilBlocked && !hasMagicGuard(state, actor) && recoilDamage > 0) {
    addHpDelta(
      resolution,
      actor.id,
      -recoilDamage,
    );
  }
  if (hpEffects.fixedRecoil && resolution.hit !== false) {
    addHpDelta(
      resolution,
      actor.id,
      -Math.max(1, Math.floor(actor.hp.max * hpEffects.fixedRecoil[0] / hpEffects.fixedRecoil[1]))
    );
  }
  const lifeOrbActive = state.generation >= 4 && isItemEffectActive(state, actor) &&
    moveId(actor.item) === 'lifeorb';
  const sheerForceLifeOrbException = hasAbility(state, actor, 'sheerforce') &&
    moveCategory !== 'Status' && !!secondaryEffects?.length;
  if (lifeOrbActive && damage > 0 && !hasMagicGuard(state, actor) && !sheerForceLifeOrbException) {
    addHpDelta(resolution, actor.id, -Math.max(1, Math.floor(actor.hp.max / 10)));
    resolution.trace!.notes!.push('Life Orb dealt recoil damage to the actor');
  }
  const throatSprayItem = resolvedItem(state, resolution, actor);
  if (state.generation >= 8 && resolution.hit !== false && moveMetadata.sound &&
    throatSprayItem && heldItemEffectsActive(state, actor) && moveId(throatSprayItem) === 'throatspray') {
    addBoosts(resolution, state, actor.id, {spa: 1});
    consumeItem(resolution, actor.id, throatSprayItem);
    resolution.trace!.notes!.push(`Throat Spray raised ${actor.id}'s Special Attack`);
  }
  if (hpEffects.drain && damage > 0) {
    let recovery = 0;
    let oozeDamage = 0;
    for (const targetId of effectTargetIds) {
      const targetDamage = resolution.damageByTarget?.[targetId] || 0;
      if (targetId === actor.id || targetDamage <= 0) continue;
      const target = getPokemon(state, targetId);
      const amount = drainAmount(state, actor, targetDamage, hpEffects.drain);
      if (liquidOozeApplies(state, target, action.moveName)) oozeDamage += amount;
      else recovery += amount;
    }
    if (!recovery && !oozeDamage) recovery = drainAmount(state, actor, damage, hpEffects.drain);
    if (recovery && !actor.volatile?.healBlock) addHpDelta(resolution, actor.id, recovery);
    if (oozeDamage && !hasMagicGuard(state, actor)) {
      addHpDelta(resolution, actor.id, -oozeDamage);
      resolution.trace!.notes!.push(`Liquid Ooze damaged ${actor.id} instead of healing`);
    }
  }

  applyPoisonPuppeteer(resolution, state, actor, effectTargetIds, random);
  applySynchronize(resolution, state, actor, effectTargetIds, moveCategory || 'Status');
  if (resolution.field && Object.prototype.hasOwnProperty.call(resolution.field, 'terrain')) {
    applyMimicry(resolution, state, resolution.field.terrain);
  }
  if (resolution.field && Object.prototype.hasOwnProperty.call(resolution.field, 'weather')) {
    applyForecast(resolution, state, resolution.field.weather);
  }
  activateBoosterEnergy(resolution, state);
  applyWhiteHerb(resolution, state);
  applyOpportunist(resolution, state);
  applyMirrorHerb(resolution, state);

  if (state.generation >= 8) {
    for (const [pokemonId, boosts] of Object.entries(resolution.boostsByPokemon || {})) {
      if (!Object.values(boosts).some(amount => (amount || 0) < 0)) continue;
      const pokemon = getPokemon(state, pokemonId);
      if (!pokemon || moveId(pokemon.item) !== 'ejectpack' || !heldItemEffectsActive(state, pokemon)) continue;
      if (requestMoveSwitch(state, pokemon, resolution)) {
        consumeItem(resolution, pokemon.id, pokemon.item!);
        resolution.trace!.notes!.push(`Eject Pack forced ${pokemon.id} out after a stat drop`);
      }
    }
  }

  applyDancer(resolution, state, action, moveMetadata);
  applyMentalHerbAfterMove(resolution, state);
  applyBerryJuiceAfterMove(resolution, state, actor);

  const shellBellItem = resolvedItem(state, resolution, actor);
  const shellBellDamage = resolution.hit !== false
    ? directDamageTotal(state, resolution, actor.id)
    : 0;
  const pendingActorHp = actor.hp.current + (resolution.hpDeltaByPokemon?.[actor.id] || 0);
  if (state.generation >= 3 && shellBellDamage > 0 && shellBellItem &&
    moveId(shellBellItem) === 'shellbell' && heldItemEffectsActive(state, actor) &&
    !actor.volatile?.healBlock && !resolution.forcedSwitchByPokemon?.[actor.id] && pendingActorHp > 0) {
    const healing = Math.floor(shellBellDamage / 8);
    if (healing > 0) {
      addHpDelta(resolution, actor.id, healing);
      resolution.trace!.notes!.push(`Shell Bell healed ${actor.id} for ${healing}`);
    }
  }

  return resolution;
}
