import * as Calc from '@smogon/calc';
import {getEffectiveAbility, isAbilityActive, isAbilityAvailable} from './abilities';
import {BattleState, PokemonState} from './model';

const KLUTZ_ITEM_EXCEPTIONS = new Set([
  'machobrace', 'poweranklet', 'powerband', 'powerbelt', 'powerbracer',
  'powerlens', 'powerweight',
]);

/** Minimum generations for items whose modeled effects are generation-bound. */
export const ITEM_MIN_GENERATION: Record<string, number> = {
  brightpowder: 2,
  boosterenergy: 9,
  blunderpolicy: 8,
  quickclaw: 2,
  scopelens: 2,
  focusband: 2,
  leftovers: 2,
  berryjuice: 2,
  shellbell: 3,
  metronome: 4,
  mentalherb: 3,
  airballoon: 5,
  aguavberry: 3,
  absorbbulb: 5,
  babiriberry: 4,
  chartiberry: 4,
  chilanberry: 4,
  chopleberry: 4,
  cobaberry: 4,
  colburberry: 4,
  adrenalineorb: 7,
  electricseed: 7,
  assaultvest: 6,
  bindingband: 5,
  bigroot: 4,
  blacksludge: 4,
  choiceband: 3,
  choicescarf: 4,
  choicespecs: 4,
  covertcloak: 9,
  custapberry: 4,
  heavydutyboots: 8,
  clearamulet: 9,
  abilityshield: 9,
  ejectbutton: 5,
  ejectpack: 8,
  expertbelt: 4,
  figyberry: 3,
  flameorb: 4,
  focussash: 4,
  fullincense: 4,
  gripclaw: 4,
  habanberry: 4,
  iapapaberry: 3,
  jabocaberry: 4,
  kasibberry: 4,
  kebiaberry: 4,
  keeberry: 6,
  liechiberry: 3,
  ganlonberry: 3,
  petayaberry: 3,
  apicotberry: 3,
  ironball: 4,
  laggingtail: 4,
  laxincense: 3,
  lifeorb: 4,
  lightclay: 4,
  lumberry: 3,
  magoberry: 3,
  machobrace: 3,
  marangaberry: 6,
  mirrorherb: 9,
  occaberry: 4,
  passhoberry: 4,
  payapaberry: 4,
  rindoberry: 4,
  roseliberry: 6,
  rowapberry: 4,
  poweranklet: 4,
  powerband: 4,
  powerbelt: 4,
  powerbracer: 4,
  powerherb: 4,
  powerlens: 4,
  powerweight: 4,
  punchingglove: 9,
  protectivepads: 7,
  redcard: 5,
  razorclaw: 4,
  rockyhelmet: 5,
  salacberry: 3,
  safetygoggles: 6,
  shucaberry: 4,
  sitrusberry: 3,
  stickybarb: 4,
  chestoberry: 3,
  cellbattery: 5,
  luminousmoss: 6,
  grassyseed: 7,
  mistyseed: 7,
  psychicseed: 7,
  snowball: 6,
  terrainextender: 7,
  throatspray: 8,
  tangaberry: 4,
  toxicorb: 4,
  weaknesspolicy: 6,
  whiteherb: 3,
  wikiberry: 3,
  widelens: 4,
  wacanberry: 4,
  yacheberry: 4,
  zoomlens: 4,
};

const canonicalItemMinimumGenerationCache = new Map<string, number | undefined>();

function canonicalItemMinimumGeneration(itemId: string): number | undefined {
  if (canonicalItemMinimumGenerationCache.has(itemId)) {
    return canonicalItemMinimumGenerationCache.get(itemId);
  }
  for (let generation = 1; generation <= 9; generation++) {
    if (Calc.Generations.get(generation as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9).items.get(Calc.toID(itemId))) {
      canonicalItemMinimumGenerationCache.set(itemId, generation);
      return generation;
    }
  }
  canonicalItemMinimumGenerationCache.set(itemId, undefined);
  return undefined;
}

function id(name: string | undefined): string {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function isItemAvailable(state: BattleState, item: string | undefined): boolean {
  const itemId = id(item);
  const minimumGeneration = ITEM_MIN_GENERATION[itemId] || canonicalItemMinimumGeneration(itemId) || 1;
  return state.generation >= minimumGeneration;
}

/** Whether a held item's normal effect is available to policy and mechanics. */
export function isItemEffectActive(state: BattleState, pokemon: PokemonState): boolean {
  if (!pokemon.item || !isItemAvailable(state, pokemon.item) || pokemon.itemCorroded ||
    state.field.magicRoom || pokemon.volatile?.embargo) return false;
  if (isAbilityActive(pokemon, state) && isAbilityAvailable(state.generation, getEffectiveAbility(pokemon)) &&
    id(getEffectiveAbility(pokemon)) === 'klutz') {
    return KLUTZ_ITEM_EXCEPTIONS.has(id(pokemon.item));
  }
  return true;
}

/** Whether the holder's ability cannot be changed by another Pokémon. */
export function preventsAbilityChange(state: BattleState, pokemon: PokemonState): boolean {
  return state.generation >= 9 && isItemEffectActive(state, pokemon) &&
    id(pokemon.item) === 'abilityshield';
}

export type BoosterEnergyVolatile = 'protosynthesis' | 'quarkDrive';

/** Return the Generation IX Paradox ability represented by a Pokémon. */
export function getParadoxAbilityVolatile(
  state: BattleState,
  pokemon: PokemonState,
): BoosterEnergyVolatile | undefined {
  if (state.generation < 9 || !isAbilityActive(pokemon, state)) return undefined;
  const ability = id(getEffectiveAbility(pokemon));
  if (!isAbilityAvailable(state.generation, ability)) return undefined;
  if (ability === 'protosynthesis') return 'protosynthesis';
  if (ability === 'quarkdrive') return 'quarkDrive';
  return undefined;
}

/** Return the Generation IX Paradox ability represented by an active volatile. */
export function getBoosterEnergyVolatile(
  state: BattleState,
  pokemon: PokemonState,
): BoosterEnergyVolatile | undefined {
  const volatile = getParadoxAbilityVolatile(state, pokemon);
  return volatile && pokemon.volatile?.[volatile] !== undefined ? volatile : undefined;
}

/** Project a consumed Booster Energy's persistent ability state to the calculator. */
export function getEffectiveCalculatorItem(
  state: BattleState,
  pokemon: PokemonState,
): string | undefined {
  if (isItemEffectActive(state, pokemon)) return pokemon.item;
  return getBoosterEnergyVolatile(state, pokemon) ? 'Booster Energy' : undefined;
}
