import * as Calc from '@smogon/calc';
import {BattleState, PokemonState} from './model';

/** Minimum generations for abilities used by shared AI eligibility boundaries. */
export const ABILITY_MIN_GENERATION: Record<string, number> = {
  aftermath: 4,
  angerpoint: 4,
  angershell: 9,
  arenatrap: 3,
  aromaveil: 6,
  airlock: 3,
  armortail: 9,
  asoneglastrier: 8,
  asonespectrier: 8,
  aurabreak: 6,
  battlearmor: 3,
  battlebond: 7,
  baddreams: 4,
  battery: 7,
  beadsofruin: 9,
  bigpecks: 5,
  berserk: 7,
  cheekpouch: 6,
  chillingneigh: 8,
  chlorophyll: 3,
  colorchange: 5,
  comatose: 7,
  commander: 9,
  costar: 9,
  compoundeyes: 3,
  cottondown: 8,
  cutecharm: 3,
  cudchew: 9,
  curiousmedicine: 8,
  corrosion: 7,
  competitive: 6,
  contrary: 5,
  clearbody: 3,
  cloudnine: 3,
  cursedbody: 5,
  darkaura: 6,
  dancer: 7,
  dauntlessshield: 8,
  dazzling: 7,
  defiant: 5,
  disguise: 7,
  drizzle: 3,
  drought: 3,
  dryskin: 4,
  effectspore: 3,
  eartheater: 9,
  earlybird: 3,
  emergencyexit: 7,
  electricsurge: 7,
  electromorphosis: 9,
  fairyaura: 6,
  flamebody: 3,
  flowergift: 4,
  flowerveil: 6,
  fullmetalbody: 7,
  friendguard: 5,
  gooey: 6,
  goodasgold: 9,
  guarddog: 9,
  hadronengine: 9,
  hospitality: 9,
  grimneigh: 8,
  harvest: 5,
  healer: 5,
  heatproof: 4,
  hugepower: 3,
  hungerswitch: 8,
  hustle: 3,
  hypercutter: 3,
  hydration: 4,
  immunity: 3,
  icebody: 4,
  iceface: 8,
  illuminate: 9,
  innerfocus: 3,
  intrepidsword: 8,
  intimidate: 3,
  insomnia: 3,
  innardsout: 7,
  ironbarbs: 5,
  justified: 5,
  keeneye: 3,
  klutz: 4,
  leafguard: 4,
  libero: 8,
  levitate: 3,
  lingeringaroma: 9,
  liquidooze: 3,
  limber: 3,
  longreach: 7,
  magicguard: 4,
  magicbounce: 5,
  mindseye: 9,
  mimicry: 8,
  magician: 6,
  mirrorarmor: 8,
  magmaarmor: 3,
  magnetpull: 3,
  moxie: 5,
  motordrive: 4,
  multitype: 4,
  naturalcure: 3,
  moody: 5,
  myceliummight: 9,
  noguard: 4,
  overcoat: 5,
  orichalcumpulse: 9,
  oblivious: 3,
  opportunist: 9,
  owntempo: 3,
  pastelveil: 8,
  perishbody: 8,
  pickpocket: 5,
  poisonpoint: 3,
  purifyingsalt: 9,
  poisonheal: 4,
  poisonpuppeteer: 9,
  poisontouch: 5,
  powerconstruct: 7,
  protosynthesis: 9,
  powerspot: 8,
  protean: 6,
  purepower: 3,
  queensmajesty: 7,
  regenerator: 5,
  raindish: 3,
  rattled: 5,
  grassysurge: 7,
  psychicsurge: 7,
  mistysurge: 7,
  sandstream: 3,
  sandrush: 5,
  sandveil: 3,
  sapsipper: 5,
  schooling: 7,
  screencleaner: 8,
  simple: 4,
  slowstart: 4,
  shellarmor: 3,
  shadowtag: 3,
  shieldsdown: 7,
  sniper: 4,
  snowcloak: 4,
  snowwarning: 4,
  soundproof: 3,
  stalwart: 8,
  shedskin: 3,
  slushrush: 7,
  solarpower: 4,
  speedboost: 3,
  soulheart: 7,
  supremeoverlord: 9,
  stamina: 7,
  static: 3,
  steamengine: 8,
  stancechange: 6,
  stickyhold: 3,
  sturdy: 3,
  suctioncups: 3,
  superluck: 4,
  synchronize: 3,
  swiftswim: 3,
  sweetveil: 6,
  tanglinghair: 7,
  tangledfeet: 4,
  thermalexchange: 9,
  toughclaws: 6,
  toxicdebris: 9,
  truant: 3,
  unnerve: 5,
  unburden: 4,
  victorystar: 5,
  vitalspirit: 3,
  wimpout: 7,
  waterbubble: 7,
  watercompaction: 7,
  windrider: 9,
  windpower: 9,
  wonderskin: 5,
  waterveil: 3,
  wellbakedbody: 9,
  quarkdrive: 9,
  weakarmor: 5,
  whitesmoke: 3,
  propellertail: 8,
  rockhead: 3,
  rksystem: 7,
  surgesurfer: 7,
  wanderingspirit: 8,
  zerotohero: 9,
};

const canonicalAbilityMinimumGenerationCache = new Map<string, number | undefined>();

function canonicalAbilityMinimumGeneration(abilityId: string): number | undefined {
  if (canonicalAbilityMinimumGenerationCache.has(abilityId)) {
    return canonicalAbilityMinimumGenerationCache.get(abilityId);
  }
  for (let generation = 1; generation <= 9; generation++) {
    if (Calc.Generations.get(generation as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9).abilities.get(Calc.toID(abilityId))) {
      canonicalAbilityMinimumGenerationCache.set(abilityId, generation);
      return generation;
    }
  }
  canonicalAbilityMinimumGenerationCache.set(abilityId, undefined);
  return undefined;
}

/** The id vocabulary is small and the regex ran in every hot ability check;
 * one shared memo turns the whole family into map hits. */
const NAME_ID_CACHE = new Map<string, string>();
function nameId(name: string | undefined): string {
  const raw = name || '';
  let id = NAME_ID_CACHE.get(raw);
  if (id === undefined) {
    id = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
    NAME_ID_CACHE.set(raw, id);
  }
  return id;
}

export function isAbilityAvailable(generation: number, ability: string | undefined): boolean {
  const normalized = nameId(ability);
  const minimumGeneration = ABILITY_MIN_GENERATION[normalized] ||
    canonicalAbilityMinimumGeneration(normalized) || 1;
  return generation >= minimumGeneration;
}

/** Project an effective ability into a generation-safe calculator input. */
export function getGenerationAbility(
  generation: number | undefined,
  pokemon: PokemonState,
): string | undefined {
  const ability = getEffectiveAbility(pokemon);
  return generation === undefined || isAbilityAvailable(generation, ability) ? ability : undefined;
}

/** Project only an active, generation-safe ability into calculator state. */
export function getCalculatorAbility(
  state: BattleState,
  pokemon: PokemonState,
): string | undefined {
  return isAbilityActive(pokemon, state) ? getGenerationAbility(state.generation, pokemon) : undefined;
}

/** Return the currently effective ability, including modeled move replacements. */
export function getEffectiveAbility(pokemon: PokemonState): string | undefined {
  if (pokemon.abilityOverride === null) return undefined;
  return pokemon.abilityOverride ?? pokemon.ability;
}

/** Return whether the holder's five-turn Slow Start window is active. */
export function isSlowStartActive(state: BattleState, pokemon: PokemonState): boolean {
  return state.generation >= 4 && isAbilityActive(pokemon, state) &&
    isAbilityAvailable(state.generation, getEffectiveAbility(pokemon)) &&
    nameId(getEffectiveAbility(pokemon)) === 'slowstart' &&
    (pokemon.volatile?.slowStart?.turns || 0) > 0;
}

const NON_SUPPRESSIBLE_BY_NEUTRALIZING_GAS = new Set([
  'asoneglastrier', 'asonespectrier', 'battlebond', 'comatose', 'commander', 'disguise',
  'gulpmissile', 'iceface', 'multitype', 'powerconstruct', 'rkssystem', 'schooling',
  'shieldsdown', 'stancechange', 'terashift', 'zenmode', 'zerotohero',
]);

function isAbilityShieldActive(state: BattleState, pokemon: PokemonState, gasPresent: boolean): boolean {
  if (state.generation < 9 || nameId(pokemon.item) !== 'abilityshield' ||
    pokemon.itemCorroded || state.field.magicRoom || pokemon.volatile?.embargo) return false;
  // Klutz suppresses Ability Shield while Klutz itself is active. Neutralizing Gas
  // suppresses Klutz first, so the shield can protect the holder in that case.
  const ability = nameId(getEffectiveAbility(pokemon));
  return ability !== 'klutz' || gasPresent;
}

/** Scanned once per state, not once per ability check: the answer is a fact
 * of the (immutable) state, and every isAbilityActive call was re-walking
 * both parties for it. */
const GAS_CACHE = new WeakMap<BattleState, boolean>();
function hasActiveNeutralizingGas(state: BattleState): boolean {
  const cached = GAS_CACHE.get(state);
  if (cached !== undefined) return cached;
  const present = isAbilityAvailable(state.generation, 'neutralizinggas') &&
    (['ai', 'player'] as const).some(sideId => state.sides[sideId].activeIds.some(pokemonId => {
      const pokemon = state.sides[sideId].party.find(candidate => candidate.id === pokemonId);
      return !!pokemon && pokemon.hp.current > 0 && isAbilityActive(pokemon) &&
        nameId(getEffectiveAbility(pokemon)) === 'neutralizinggas';
    }));
  GAS_CACHE.set(state, present);
  return present;
}

export function isAbilityActive(pokemon: PokemonState, state?: BattleState): boolean {
  if (pokemon.abilityOn === false || pokemon.abilitySuppressed === true) return false;
  if (!state) return true;

  const gasPresent = hasActiveNeutralizingGas(state);
  const ability = nameId(getEffectiveAbility(pokemon));
  if (!gasPresent || ability === 'neutralizinggas' || NON_SUPPRESSIBLE_BY_NEUTRALIZING_GAS.has(ability)) return true;
  return isAbilityShieldActive(state, pokemon, gasPresent);
}
