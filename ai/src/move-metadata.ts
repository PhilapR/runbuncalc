import {Dex} from '@pkmn/dex';
import {
  GenerationNum,
  MoveCategory,
  MoveTarget,
  MoveState,
  SecondaryEffect,
  StatBoosts,
  StatusName,
  VolatileStatusName,
} from './model';

export type MoveMetadataSource = 'canonical' | 'run-and-bun' | 'unavailable';

/** Canonical moves that consume the following turn for recharge. */
export const RECHARGE_MOVE_MIN_GENERATION: Record<string, GenerationNum> = {
  hyperbeam: 1,
  blastburn: 3,
  frenzyplant: 3,
  hydrocannon: 3,
  gigaimpact: 4,
  rockwrecker: 4,
  roaroftime: 4,
  prismaticlaser: 7,
  eternabeam: 8,
  meteorassault: 8,
};

/** Canonical moves that resolve their damage on the following turn. */
export const CHARGE_MOVE_MIN_GENERATION: Record<string, GenerationNum> = {
  razorwind: 1,
  skullbash: 1,
  solarbeam: 1,
  fly: 1,
  dig: 1,
  skyattack: 1,
  bounce: 3,
  dive: 3,
  freezeshock: 5,
  iceburn: 5,
  phantomforce: 5,
  shadowforce: 5,
  solarblade: 7,
  meteorbeam: 8,
  electroshot: 9,
};

/** Charge moves that hide the user until their release turn. */
export const SEMI_INVULNERABLE_CHARGE_MOVES = new Set([
  'fly', 'dig', 'dive', 'bounce', 'phantomforce', 'shadowforce',
]);

/** Canonical moves that can strike a semi-invulnerable charge target. */
export const SEMI_INVULNERABLE_BYPASS_MOVES = new Set([
  'gust', 'twister', 'thunder', 'hurricane', 'smackdown', 'skyuppercut', 'thousandarrows',
]);

/** Uproar is a Generation III+ multi-turn sound move. */
export const UPROAR_MOVE_MIN_GENERATION: Record<string, GenerationNum> = {
  uproar: 3,
};

/** Curse is a Generation II+ stateful move. */
export const CURSE_MOVE_MIN_GENERATION = 2 as GenerationNum;

/** Protection moves with generation-specific availability or counter-effects. */
export const PROTECTION_MOVE_MIN_GENERATION: Record<string, GenerationNum> = {
  kingsshield: 6,
  spikyshield: 6,
  banefulbunker: 7,
  obstruct: 8,
  silktrap: 9,
  burningbulwark: 9,
};

/** Damaging moves that create a temporary partial-trap effect on hit. */
export const PARTIAL_TRAPPING_MOVES = new Set([
  'bind', 'clamp', 'firespin', 'infestation', 'magmastorm', 'sandtomb',
  'snaptrap', 'thundercage', 'whirlpool', 'wrap',
]);

export interface MoveMetadata {
  basePower?: number;
  /** Only set when Run & Bun or caller data should override calculator power. */
  basePowerOverride?: number;
  maxPP?: number;
  accuracy?: number | true;
  secondaryEffects?: SecondaryEffect[];
  type?: string;
  /** Only set for the Run & Bun type overlay; canonical type remains informational. */
  typeOverride?: string;
  category?: MoveCategory;
  /** Canonical or caller-defined action priority. */
  priority?: number;
  /** Canonical target shape used by control moves such as Snatch. */
  target?: MoveTarget;
  /** Canonical move-data flag used by contact-triggered effects. */
  contact?: boolean;
  /** Canonical move-data flag used by Triage and healing-aware calculation. */
  heal?: boolean;
  /** Canonical move-data flags used by calculator ability/item modifiers. */
  punch?: boolean;
  bite?: boolean;
  pulse?: boolean;
  slicing?: boolean;
  bullet?: boolean;
  /** Canonical move-data flag: this status move can be stolen by Snatch. */
  snatchable?: boolean;
  /** Canonical move-data flag: this move is sound-based and bypasses Substitute. */
  sound?: boolean;
  /** Canonical move-data flag used by Wind Rider and wind-move interactions. */
  wind?: boolean;
  /** Canonical move-data flag used by the Generation VII Dancer ability. */
  dance?: boolean;
  /** Canonical move-data flag used by Magic Bounce and Magic Coat. */
  reflectable?: boolean;
  source: MoveMetadataSource;
}

// The bundled canonical dex/calculator fork predates Electro Shot. Keep this
// small compatibility record in the AI metadata boundary until the upstream
// data package is refreshed; it is canonical data, not a Run & Bun overlay.
const CANONICAL_FALLBACK_MOVES: Record<string, MoveMetadata> = {
  electroshot: {
    basePower: 130,
    maxPP: 10,
    accuracy: 100,
    type: 'Electric',
    category: 'Special',
    target: 'normal',
    sound: false,
    wind: false,
    source: 'canonical',
  },
};

const CANONICAL_FALLBACK_MIN_GENERATION: Record<string, GenerationNum> = {
  electroshot: 9,
};

// These are the accuracy changes in MOVE_CHANGES.MD. They are kept as a
// versioned overlay instead of reading the parent markdown file at runtime.
const CUSTOM_ACCURACY: Record<string, number> = {
  aeroblast: 100, aircutter: 100, airslash: 100, aquatail: 95, barrage: 100,
  belch: 100, bind: 100, blazekick: 100, blizzard: 80, blueflare: 90,
  boltstrike: 90, boneclub: 100, bonemerang: 100, bounce: 95, chargebeam: 100,
  circlethrow: 95, clamp: 100, cometpunch: 90, crabhammer: 100, crosschop: 90,
  cut: 100, darkvoid: 80, diamondstorm: 100, doublehit: 100, doubleslap: 100,
  dracometeor: 100, dragonrush: 85, dragontail: 95, drillrun: 100, dualchop: 100,
  dualwingbeat: 100, electroweb: 100, firefang: 100, firespin: 100, flash: 70,
  fleurcannon: 100, fly: 100, flyingpress: 100, focusblast: 80, freezeshock: 100,
  frenzyplant: 100, frostbreath: 100, furyattack: 100, furyswipes: 90,
  geargrind: 100, gigaimpact: 100, glaciate: 100, grasswhistle: 70, gunkshot: 85,
  hammerarm: 100, headsmash: 85, heatwave: 100, highhorsepower: 100, hurricane: 80,
  hydrocannon: 100, hydropump: 85, hyperbeam: 100, hyperfang: 100, hypnosis: 70,
  iceburn: 100, icefang: 100, icehammer: 100, iciclecrash: 100, icywind: 100,
  irontail: 85, kinesis: 100, leafstorm: 100, leaftornado: 100, leechseed: 100,
  lightofruin: 100, lovelykiss: 80, magmastorm: 90, megakick: 85, megapunch: 100,
  megahorn: 90, metalclaw: 100, metalsound: 100, meteorbeam: 100, meteormash: 100,
  mirrorshot: 100, mudbomb: 100, muddywater: 95, naturesmadness: 100, nightdaze: 100,
  octazooka: 100, originpulse: 100, overheat: 100, pinmissile: 100, playrough: 100,
  poisonpowder: 90, powerwhip: 90, precipiceblades: 100,
  psychoboost: 100, razorleaf: 100, razorshell: 100, roaroftime: 100,
  rockblast: 100, rockclimb: 95, rockslide: 100, rockthrow: 100, rockwrecker: 100,
  rollingkick: 100, sacredfire: 100, sandtomb: 100, scaleshot: 100, screech: 100,
  seedflare: 90, sing: 70, skittersmack: 100, skyattack: 100, skyuppercut: 100,
  slam: 90, sleeppowder: 80, smog: 90, snarl: 100, sonicboom: 100, spacialrend: 100,
  steameruption: 100, steelbeam: 100, steelwing: 100, stoneedge: 85, strangesteam: 100,
  stunspore: 90, submission: 100, superfang: 100, supersonic: 70, swagger: 90,
  sweetkiss: 80, tailslap: 100, takedown: 100, thunder: 80, thundercage: 100,
  thunderfang: 100, whirlpool: 100, wrap: 100, zenheadbutt: 100,
};

// These are the documented Run & Bun move-power changes. Keep them in the
// application overlay: the inherited calculator remains an upstream oracle,
// while the Run & Bun policy selects these values at its adapter boundary.
const CUSTOM_BASE_POWER: Record<string, number> = {
  absorb: 40,
  astonish: 40,
  chargebeam: 40,
  frustration: 102,
  lick: 40,
  megadrain: 60,
  mistyexplosion: 200,
  octazooka: 80,
  return: 102,
};

const CUSTOM_MAX_PP: Record<string, number> = {
  babydolleyes: 10,
  captivate: 5,
  charm: 5,
  confide: 10,
  eerieimpulse: 5,
  fakeout: 5,
  faketears: 5,
  featherdance: 5,
  growl: 10,
  harden: 5,
  leer: 10,
  metalsound: 5,
  nobleroar: 10,
  playnice: 10,
  roost: 5,
  sandattack: 5,
  screech: 5,
  snarl: 10,
  strugglebug: 10,
  tearfullook: 10,
  tickle: 10,
};

const CUSTOM_SECONDARY_CHANCE: Record<string, number> = {
  chargebeam: 100, leaftornado: 30, mirrorshot: 20, mudbomb: 20,
  nightdaze: 30, octazooka: 30, rocksmash: 100, smog: 100,
};

const RANDOM_STATUS_SECONDARIES: Record<string, StatusName[]> = {
  direclaw: ['slp', 'psn', 'par'],
  triattack: ['par', 'brn', 'frz'],
};

const CUSTOM_TYPE: Record<string, string> = {
  covet: 'Fairy',
  superfang: 'Dark',
};

/**
 * Every move id named by a Run & Bun overlay table.
 *
 * Exported so the data gate can assert each one resolves to a real move. A
 * mistyped key is invisible at runtime — `getMoveMetadata` simply finds no
 * override and falls through to the canonical value, so the Run & Bun
 * correction is dropped with no error and no failing comparison.
 */
export const OVERLAY_MOVE_IDS: string[] = Array.from(new Set([
  ...Object.keys(CUSTOM_ACCURACY),
  ...Object.keys(CUSTOM_BASE_POWER),
  ...Object.keys(CUSTOM_MAX_PP),
  ...Object.keys(CUSTOM_SECONDARY_CHANCE),
  ...Object.keys(CUSTOM_TYPE),
])).sort();

const SUPPORTED_STAT_IDS = new Set(['hp', 'atk', 'def', 'spa', 'spd', 'spe']);
const SUPPORTED_STATUS_NAMES = new Set<StatusName>(['slp', 'psn', 'brn', 'frz', 'par', 'tox']);
const SUPPORTED_VOLATILES: Record<string, VolatileStatusName> = {
  confusion: 'confusion',
  flinch: 'flinch',
  taunt: 'taunt',
  encore: 'encore',
  leechseed: 'leechSeed',
  perishsong: 'perishSong',
  destinybond: 'destinyBond',
  focusenergy: 'focusEnergy',
  laserfocus: 'laserFocus',
};

function moveId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function toBoosts(boosts: Record<string, number> | undefined): StatBoosts | undefined {
  if (!boosts) return undefined;
  const result: StatBoosts = {};
  for (const [stat, amount] of Object.entries(boosts)) {
    if (SUPPORTED_STAT_IDS.has(stat)) result[stat as keyof StatBoosts] = amount;
  }
  return Object.keys(result).length ? result : undefined;
}

function toStatus(status: string | undefined): StatusName | undefined {
  return status && SUPPORTED_STATUS_NAMES.has(status as StatusName) ? status as StatusName : undefined;
}

function toSecondaryEffects(move: ReturnType<typeof Dex.moves.get>, id: string): SecondaryEffect[] | undefined {
  const moveSelf = move.self as {
    chance?: number;
    boosts?: Record<string, number>;
  } | null | undefined;
  if (!move.secondaries?.length && moveSelf?.chance === undefined) return undefined;
  const effects: SecondaryEffect[] = [];
  for (const secondary of move.secondaries || []) {
    const boosts = toBoosts(secondary.boosts as Record<string, number> | undefined);
    const status = toStatus(secondary.status);
    const volatileName = secondary.volatileStatus ? SUPPORTED_VOLATILES[secondary.volatileStatus] : undefined;
    const self = secondary.self;
    const selfBoosts = self ? toBoosts(self.boosts as Record<string, number> | undefined) : undefined;
    const statusChoices = RANDOM_STATUS_SECONDARIES[id];
    if (!boosts && !status && !volatileName && !selfBoosts && !statusChoices) continue;
    const chance = CUSTOM_SECONDARY_CHANCE[id] ?? secondary.chance;
    if (selfBoosts) effects.push({chance, target: 'self', boosts: selfBoosts});
    else effects.push({
      chance,
      status,
      statusChoices,
      boosts,
      volatile: volatileName ? {name: volatileName} : undefined,
    });
  }
  const selfBoosts = moveSelf?.chance === undefined
    ? undefined
    : toBoosts(moveSelf.boosts);
  if (selfBoosts && moveSelf?.chance !== undefined) {
    effects.push({chance: moveSelf.chance, target: 'self', boosts: selfBoosts});
  }
  return effects.length ? effects : undefined;
}

export function getMoveMetadata(name: string, generation: GenerationNum): MoveMetadata {
  const id = moveId(name);
  const move = Dex.forGen(generation).moves.get(name);
  if (!move.exists) {
    const canonicalFallback = CANONICAL_FALLBACK_MOVES[id];
    if (canonicalFallback && generation >= CANONICAL_FALLBACK_MIN_GENERATION[id]) return canonicalFallback;
    return {
      basePower: CUSTOM_BASE_POWER[id],
      basePowerOverride: CUSTOM_BASE_POWER[id],
      maxPP: CUSTOM_MAX_PP[id],
      accuracy: CUSTOM_ACCURACY[id],
      type: CUSTOM_TYPE[id],
      typeOverride: CUSTOM_TYPE[id],
      contact: false,
      heal: false,
      punch: false,
      bite: false,
      pulse: false,
      slicing: false,
      bullet: false,
      sound: false,
      wind: false,
      source: CUSTOM_BASE_POWER[id] !== undefined || CUSTOM_MAX_PP[id] !== undefined ||
        CUSTOM_ACCURACY[id] !== undefined || CUSTOM_TYPE[id] !== undefined ? 'run-and-bun' : 'unavailable',
    };
  }

  const customBasePower = CUSTOM_BASE_POWER[id];
  const customMaxPP = CUSTOM_MAX_PP[id];
  const customAccuracy = CUSTOM_ACCURACY[id];
  const customType = CUSTOM_TYPE[id];
  const secondaryEffects = toSecondaryEffects(move, id);
  return {
    basePower: customBasePower ?? move.basePower,
    basePowerOverride: customBasePower,
    maxPP: customMaxPP ?? move.pp,
    accuracy: customAccuracy ?? move.accuracy,
    secondaryEffects,
    type: customType ?? move.type,
    typeOverride: customType,
    category: move.category as MoveCategory,
    priority: move.priority,
    target: move.target as MoveTarget,
    contact: !!move.flags?.contact,
    heal: !!move.flags?.heal,
    punch: !!move.flags?.punch,
    bite: !!move.flags?.bite,
    pulse: !!move.flags?.pulse,
    slicing: !!move.flags?.slicing,
    bullet: !!move.flags?.bullet,
    snatchable: !!move.flags?.snatch,
    sound: !!move.flags?.sound,
    wind: !!move.flags?.wind,
    dance: !!move.flags?.dance,
    reflectable: !!move.flags?.reflectable,
    source: customBasePower !== undefined || customMaxPP !== undefined || customAccuracy !== undefined ||
      customType !== undefined || CUSTOM_SECONDARY_CHANCE[id] !== undefined
      ? 'run-and-bun'
      : 'canonical',
  };
}

/**
 * Canonical moves are only legal from the generation in which the inherited
 * Dex first exposes them. Unknown names remain available for caller-defined
 * custom moves handled outside the canonical move table.
 */
export function isMoveAvailable(name: string, generation: GenerationNum): boolean {
  const move = Dex.forGen(9).moves.get(name);
  if (move.exists) return move.gen <= generation;
  const fallbackGeneration = CANONICAL_FALLBACK_MIN_GENERATION[moveId(name)];
  if (fallbackGeneration !== undefined) return generation >= fallbackGeneration;
  return true;
}

export function getEffectiveMoveMetadata(
  move: MoveState,
  generation: GenerationNum,
): MoveMetadata {
  const defaults = getMoveMetadata(move.name, generation);
  const explicit = move.basePower !== undefined || move.type !== undefined || move.category !== undefined ||
    move.priority !== undefined || move.accuracy !== undefined || move.secondaryEffects !== undefined ||
    move.target !== undefined || move.contact !== undefined || move.heal !== undefined || move.punch !== undefined ||
    move.bite !== undefined || move.pulse !== undefined || move.slicing !== undefined || move.bullet !== undefined ||
    move.snatchable !== undefined || move.sound !== undefined ||
    move.wind !== undefined || move.dance !== undefined || move.reflectable !== undefined;
  return {
    basePower: move.basePower ?? defaults.basePower,
    basePowerOverride: move.basePower ?? defaults.basePowerOverride,
    maxPP: move.maxPP ?? defaults.maxPP,
    accuracy: move.accuracy ?? defaults.accuracy,
    secondaryEffects: move.secondaryEffects ?? defaults.secondaryEffects,
    type: move.type ?? defaults.type,
    typeOverride: move.type ?? defaults.typeOverride,
    category: move.category ?? defaults.category,
    priority: move.priority ?? defaults.priority,
    target: move.target ?? defaults.target,
    contact: move.contact ?? defaults.contact,
    heal: move.heal ?? defaults.heal,
    punch: move.punch ?? defaults.punch,
    bite: move.bite ?? defaults.bite,
    pulse: move.pulse ?? defaults.pulse,
    slicing: move.slicing ?? defaults.slicing,
    bullet: move.bullet ?? defaults.bullet,
    snatchable: move.snatchable ?? defaults.snatchable,
    sound: move.sound ?? defaults.sound,
    wind: move.wind ?? defaults.wind,
    dance: move.dance ?? defaults.dance,
    reflectable: move.reflectable ?? defaults.reflectable,
    source: explicit ? 'run-and-bun' : defaults.source,
  };
}

/** Return canonical maximum PP for a move, when the generation data exposes it. */
export function getMoveMaxPP(name: string, generation: GenerationNum): number | undefined {
  const move = Dex.forGen(generation).moves.get(name);
  return move.exists
    ? CUSTOM_MAX_PP[moveId(name)] ?? move.pp
    : getMoveMetadata(name, generation).maxPP ?? CUSTOM_MAX_PP[moveId(name)];
}
