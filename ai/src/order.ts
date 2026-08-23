import * as Calc from '@smogon/calc';
import {getCalculatorAbility, getEffectiveAbility, getGenerationAbility, isAbilityActive, isSlowStartActive} from './abilities';
import {actionKey, getPokemon, isRainWeather, isSunWeather, isWeatherSuppressed, sideForPokemon} from './actions';
import {getBoosterEnergyVolatile, getEffectiveCalculatorItem, isItemEffectActive} from './items';
import {getEffectiveMoveMetadata, getMoveMetadata} from './move-metadata';
import {Action, BattleState, MoveAction, PokemonState, RUN_AND_BUN_EVS} from './model';
import {getCalcSpeciesOverrides, getEffectiveSpecies} from './stat-transforms';

export interface ActionOrderFacts {
  action: Action;
  actorId: string;
  priority: number;
  speed: number;
  trickRoom: boolean;
  movesLast: boolean;
  itemPriority: boolean;
  itemPriorityItem?: 'Quick Claw' | 'Custap Berry';
}

export interface ActionOrderOptions {
  /** Optional pre-sampled Quick Claw rolls keyed by holder ID. */
  itemRollsByPokemon?: Readonly<Record<string, number>>;
  random?: () => number;
}

function id(name: string | undefined): string {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function calcPokemon(state: BattleState, pokemon: PokemonState): Calc.Pokemon {
  const gen = Calc.Generations.get(state.generation);
  const overrides = getCalcSpeciesOverrides(gen, pokemon);
  return new Calc.Pokemon(gen, getEffectiveSpecies(pokemon), {
    level: pokemon.level,
    ability: getCalculatorAbility(state, pokemon),
    abilityOn: isAbilityActive(pokemon, state) ? pokemon.abilityOn : false,
    item: getEffectiveCalculatorItem(state, pokemon),
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
    status: pokemon.status,
    teraType: pokemon.teraType as Calc.State.Pokemon['teraType'],
    overrides,
  });
}

const HEALING_MOVES = new Set([
  // Canonical move flags.heal entries. Triage follows the move flag, including
  // moves that heal an ally or require a sleeping target.
  'absorb', 'bouncybubble', 'drainingkiss', 'drainpunch', 'dreameater', 'floralhealing',
  'gigadrain', 'healingwish', 'healorder', 'healpulse', 'hornleech', 'junglehealing',
  'leechlife', 'lifedew', 'lunarblessing', 'lunardance', 'megadrain', 'milkdrink',
  'moonlight', 'morningsun', 'oblivionwing', 'paraboliccharge', 'purify', 'recover',
  'rest', 'roost', 'shoreup', 'slackoff', 'softboiled', 'strengthsap', 'swallow', 'synthesis',
  'wish',
]);

function moveOrderData(state: BattleState, action: MoveAction, actor: PokemonState) {
  const gen = Calc.Generations.get(state.generation);
  const moveState = actor.moves.find(move => move.name === action.moveName);
  const metadata = moveState
    ? getEffectiveMoveMetadata(moveState, state.generation)
    : getMoveMetadata(action.moveName, state.generation);
  let canonicalMove: Calc.Move | undefined;
  try {
    canonicalMove = new Calc.Move(gen, action.moveName, {
      ability: getCalculatorAbility(state, actor),
      item: getEffectiveCalculatorItem(state, actor),
      species: getEffectiveSpecies(actor),
      useZ: action.useZ || moveState?.useZ,
      useMax: action.useMax || moveState?.useMax,
    });
  } catch {
    // Caller-defined and calculator-fallback moves still have a deterministic
    // default order slot even when the inherited calculator has no Move entry.
  }
  const moveCategory = metadata.category ?? canonicalMove?.category;
  const moveType = metadata.type ?? canonicalMove?.type;
  let priority = moveState?.priority ?? metadata.priority ?? canonicalMove?.priority ?? 0;
  if (isAbilityActive(actor, state) && state.generation >= 5 && id(getEffectiveAbility(actor)) === 'prankster' && moveCategory === 'Status') {
    priority += 1;
  }
  if (isAbilityActive(actor, state) && state.generation >= 6 &&
    id(getEffectiveAbility(actor)) === 'galewings' && moveType === 'Flying') {
    priority += 1;
  }
  if (isAbilityActive(actor, state) && state.generation >= 7 &&
    id(getEffectiveAbility(actor)) === 'triage' &&
    (metadata.heal ?? HEALING_MOVES.has(id(action.moveName)))) {
    priority += 3;
  }
  const movesLast = isAbilityActive(actor, state) &&
    ((state.generation >= 4 && id(getEffectiveAbility(actor)) === 'stall') ||
      (state.generation >= 9 && id(getEffectiveAbility(actor)) === 'myceliummight' && moveCategory === 'Status')) ||
    isItemEffectActive(state, actor) && ['laggingtail', 'fullincense'].includes(id(actor.item));
  return {priority, movesLast, category: moveCategory};
}

/**
 * Unboosted Speed, cached, because building a Pokemon to read one number was
 * 6,720 constructions in a twelve-rollout adjudication — a quarter of all the
 * calculator objects it made. Speed is asked for constantly: every action the
 * AI scores wants to know whether it moves first.
 *
 * The key is every input that actually moves `stats.spe`, established by
 * probing the calculator rather than by reading it, and pinned by
 * `tests/adjudication_cost.test.js` so the cache cannot outlive its
 * assumption:
 *
 *   MOVES it   level, nature, ivs.spe, evs.spe, statOverrides.spe,
 *              overrides.baseStats.spe, and the effective species
 *   does NOT   boosts, status, item, ability, teraType
 *
 * That second list is why this is safe to share across a battle: the things
 * that change mid-fight are exactly the things the constructor ignores. They
 * are applied below, by hand, to the cached base — which the same probe
 * confirms is not double counting, since the constructor drops the boosts it
 * is handed.
 */
const BASE_SPEED = new Map<string, number>();

function baseSpeed(state: BattleState, pokemon: PokemonState): number {
  const overrides = getCalcSpeciesOverrides(Calc.Generations.get(state.generation), pokemon);
  const key = [
    state.generation,
    getEffectiveSpecies(pokemon),
    pokemon.level,
    pokemon.nature || '',
    pokemon.ivs?.spe,
    RUN_AND_BUN_EVS.spe,
    pokemon.statOverrides?.spe,
    (overrides as {baseStats?: {spe?: number}} | undefined)?.baseStats?.spe,
  ].join('|');
  const cached = BASE_SPEED.get(key);
  if (cached !== undefined) return cached;
  const computed = calcPokemon(state, pokemon).stats.spe;
  BASE_SPEED.set(key, computed);
  return computed;
}

function effectiveSpeed(state: BattleState, pokemon: PokemonState): number {
  let speed = baseSpeed(state, pokemon);
  const stage = pokemon.boosts?.spe || 0;
  speed *= stage >= 0 ? (2 + stage) / 2 : 2 / (2 - stage);
  if (isSlowStartActive(state, pokemon)) speed *= 0.5;
  const quickFeet = state.generation >= 4 && isAbilityActive(pokemon, state) &&
    id(getEffectiveAbility(pokemon)) === 'quickfeet' && !!pokemon.status;
  if (pokemon.status === 'par' && !quickFeet) speed *= 0.25;
  if (quickFeet) speed *= 1.5;
  const item = id(pokemon.item);
  if (isItemEffectActive(state, pokemon)) {
    if (item === 'choicescarf') speed *= 1.5;
    if (['ironball', 'machobrace', 'poweranklet', 'powerband', 'powerbelt', 'powerbracer', 'powerlens', 'powerweight'].includes(item)) {
      speed *= 0.5;
    }
  }
  if (isAbilityActive(pokemon, state)) {
    const ability = id(getEffectiveAbility(pokemon));
    const weather = state.field.weather;
    const terrain = state.field.terrain;
    if (!isWeatherSuppressed(state) &&
      ((state.generation >= 3 && ability === 'swiftswim' && isRainWeather(weather)) ||
        (state.generation >= 3 && ability === 'chlorophyll' && isSunWeather(weather)) ||
        (state.generation >= 5 && ability === 'sandrush' && weather === 'Sand') ||
        (state.generation >= 7 && ability === 'slushrush' && (weather === 'Hail' || weather === 'Snow')) ||
        (state.generation >= 7 && ability === 'surgesurfer' && terrain === 'Electric'))) speed *= 2;
    if (state.generation >= 4 && ability === 'unburden' && pokemon.itemLost) speed *= 2;
    if (state.generation >= 9 && (ability === 'protosynthesis' || ability === 'quarkdrive')) {
      const weatherActive = ability === 'protosynthesis' && !isWeatherSuppressed(state) &&
        (weather === 'Sun' || weather === 'Harsh Sunshine');
      const terrainActive = ability === 'quarkdrive' && terrain === 'Electric';
      const itemActive = isItemEffectActive(state, pokemon) && id(pokemon.item) === 'boosterenergy';
      const volatileActive = !!getBoosterEnergyVolatile(state, pokemon);
      // Only this branch needs the whole Pokemon, and only when a Booster
      // Energy trigger is live — so it is built here rather than for every
      // speed lookup in the battle.
      if ((weatherActive || terrainActive || itemActive || volatileActive) &&
        mostProficientStat(calcPokemon(state, pokemon)) === 'spe') {
        speed *= 1.5;
      }
    }
  }
  const sideId = sideForPokemon(state, pokemon.id);
  if (state.sides[sideId].effects?.tailwind) speed *= 2;
  if (state.generation >= 5 && state.sides[sideId].effects?.pledgeSwamp) speed *= 0.25;
  return speed;
}

function mostProficientStat(pokemon: Calc.Pokemon): 'atk' | 'def' | 'spa' | 'spd' | 'spe' {
  const modified = (stat: 'atk' | 'def' | 'spa' | 'spd' | 'spe') => {
    const stage = pokemon.boosts[stat] || 0;
    const raw = pokemon.rawStats[stat];
    return stage >= 0 ? raw * (2 + stage) / 2 : raw * 2 / (2 - stage);
  };
  let best: 'atk' | 'def' | 'spa' | 'spd' | 'spe' = 'atk';
  for (const stat of ['def', 'spa', 'spd', 'spe'] as const) {
    if (modified(stat) > modified(best)) best = stat;
  }
  return best;
}

/** Return a Pokémon's modeled execution speed without requiring a move action. */
export function getEffectivePokemonSpeed(state: BattleState, pokemonId: string): number {
  const pokemon = getPokemon(state, pokemonId);
  if (!pokemon) throw new Error(`Unknown Pokémon id: ${pokemonId}`);
  return effectiveSpeed(state, pokemon);
}

function boundedRoll(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} sampler must return a finite number`);
  return Math.max(0, Math.min(0.999999999999, value));
}

function itemPriorityData(
  state: BattleState,
  actor: PokemonState,
  itemRoll: number | undefined,
  moveData: ReturnType<typeof moveOrderData>,
): {itemPriority: boolean; itemPriorityItem?: 'Quick Claw' | 'Custap Berry'} {
  if (!isItemEffectActive(state, actor)) {
    return {itemPriority: false};
  }
  const item = id(actor.item);
  if (item === 'quickclaw' && state.generation >= 2 && itemRoll !== undefined && itemRoll < 0.2) {
    return {itemPriority: true, itemPriorityItem: 'Quick Claw'};
  }
  const myceliumStatus = state.generation >= 9 && moveData.category === 'Status' &&
    isAbilityActive(actor, state) && id(getEffectiveAbility(actor)) === 'myceliummight';
  const gluttonyThreshold = state.generation >= 4 && isAbilityActive(actor, state) &&
    id(getEffectiveAbility(actor)) === 'gluttony' && actor.hp.current * 2 <= actor.hp.max;
  if (item === 'custapberry' && state.generation >= 4 && moveData.priority <= 0 &&
    !myceliumStatus && (actor.hp.current * 4 <= actor.hp.max || gluttonyThreshold)) {
    return {itemPriority: true, itemPriorityItem: 'Custap Berry'};
  }
  return {itemPriority: false};
}

export function getActionOrderFacts(state: BattleState, action: Action, itemRoll: number | undefined = undefined): ActionOrderFacts {
  const actor = getPokemon(state, action.actorId);
  if (!actor) throw new Error('Action order references an unknown actor');
  const moveData = action.kind === 'move' ? moveOrderData(state, action, actor) : undefined;
  return {
    action,
    actorId: actor.id,
    priority: action.kind === 'switch' ? 6 : moveData!.priority,
    speed: effectiveSpeed(state, actor),
    trickRoom: !!state.field.trickRoom,
    movesLast: action.kind === 'switch' ? false : moveData!.movesLast,
    ...(action.kind === 'move'
      ? itemPriorityData(state, actor, itemRoll, moveData!)
      : {itemPriority: false}),
  };
}

function tieBreak(random: () => number): number {
  const value = random();
  if (!Number.isFinite(value)) throw new Error('Action order sampler must return a finite number');
  return Math.max(0, Math.min(0.999999999999, value));
}

/**
 * Order simultaneous intents by battle priority, then effective speed. A
 * switch uses the standard +6 switch priority. Speed ties are randomized once
 * per action, making the result reproducible when a seeded sampler is passed.
 * Quick Claw and Custap Berry are modeled at the item-priority boundary;
 * Quick Claw uses the supplied sampler (or the order sampler), while item
 * consumption remains a battle-engine transition.
 */
export function orderActions(
  state: BattleState,
  actions: Action[],
  options: ActionOrderOptions = {},
): Action[] {
  const random = options.random || Math.random;
  return actions
    .map((action, index) => {
      const actor = getPokemon(state, action.actorId);
      const quickClaw = actor && id(actor.item) === 'quickclaw' &&
        isItemEffectActive(state, actor) && state.generation >= 2;
      const suppliedRoll = options.itemRollsByPokemon && options.itemRollsByPokemon[action.actorId];
      const itemRoll = suppliedRoll === undefined
        ? quickClaw ? boundedRoll(random(), 'Quick Claw') : undefined
        : boundedRoll(suppliedRoll, 'Quick Claw');
      return {
        action,
        index,
        facts: getActionOrderFacts(state, action, itemRoll),
        tie: tieBreak(random),
      };
    })
    .sort((left, right) => {
      if (left.facts.priority !== right.facts.priority) {
        return right.facts.priority - left.facts.priority;
      }
      if (left.facts.movesLast !== right.facts.movesLast) {
        return left.facts.movesLast ? 1 : -1;
      }
      if (left.facts.itemPriority !== right.facts.itemPriority) {
        return left.facts.itemPriority ? -1 : 1;
      }
      if (left.facts.speed !== right.facts.speed) {
        const direction = state.field.trickRoom ? -1 : 1;
        return direction * (right.facts.speed - left.facts.speed);
      }
      if (left.tie !== right.tie) return left.tie - right.tie;
      if (actionKey(left.action) !== actionKey(right.action)) {
        return actionKey(left.action).localeCompare(actionKey(right.action));
      }
      return left.index - right.index;
    })
    .map(entry => entry.action);
}
