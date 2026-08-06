import * as Calc from '@smogon/calc';
import {getCalculatorAbility, getEffectiveAbility, isAbilityActive} from './abilities';
import {getPokemon, isWeatherSuppressed, sideForPokemon} from './actions';
import {ignoresTargetAbility} from './eligibility';
import {isItemEffectActive} from './items';
import {Action, BattleState, MoveAction, MoveCategory, PokemonState, RUN_AND_BUN_EVS} from './model';
import {getCalcSpeciesOverrides, getEffectiveSpecies} from './stat-transforms';

export interface EffectiveAccuracy {
  accuracy: number | true;
  multiplier: number;
  modifiers: string[];
}

function id(name: string | undefined): string {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function hasAbility(state: BattleState, pokemon: PokemonState | undefined, ...abilities: string[]): boolean {
  return !!pokemon && isAbilityActive(pokemon, state) && abilities.includes(id(getEffectiveAbility(pokemon)));
}

function baseSpeed(state: BattleState, pokemon: PokemonState): number {
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
    statOverrides: pokemon.statOverrides,
    overrides,
  }).stats.spe;
}

/** Whether the holder's consumed Micle Berry volatile boosts this move's accuracy. */
export function isMicleBerryReady(
  state: BattleState,
  action: MoveAction,
  baseAccuracy: number | true | undefined,
): boolean {
  if (state.generation < 4 || baseAccuracy === undefined || baseAccuracy === true) return false;
  const actor = getPokemon(state, action.actorId);
  if (!actor?.volatile?.micleBerry) return false;
  try {
    const move = new Calc.Move(Calc.Generations.get(state.generation), action.moveName, {
      ability: getCalculatorAbility(state, actor),
      useZ: action.useZ,
      useMax: action.useMax,
    });
    return !(move as Calc.Move & {ohko?: boolean}).ohko;
  } catch {
    // Unknown caller-defined moves are not known to be OHKO moves.
    return true;
  }
}

function moveCategory(state: BattleState, action: MoveAction): MoveCategory {
  const gen = Calc.Generations.get(state.generation);
  return new Calc.Move(gen, action.moveName).category as MoveCategory;
}

function stageMultiplier(stage: number, inverse = false): number {
  if (stage >= 0) return inverse ? 3 / (3 + stage) : (3 + stage) / 3;
  return inverse ? (3 - stage) / 3 : 3 / (3 - stage);
}

export function getEffectiveMoveAccuracy(
  state: BattleState,
  action: MoveAction,
  baseAccuracy: number | true,
  category?: MoveCategory,
  attackerSpeed?: number,
  targetSpeed?: number,
): EffectiveAccuracy {
  if (baseAccuracy === true) return {accuracy: true, multiplier: 1, modifiers: []};
  if (!Number.isFinite(baseAccuracy) || baseAccuracy < 0 || baseAccuracy > 100) {
    throw new Error('Move accuracy must be true or a percentage from 0 to 100');
  }
  const actor = getPokemon(state, action.actorId);
  const target = action.targetIds.length ? getPokemon(state, action.targetIds[0]) : undefined;
  if (state.generation >= 9 && target?.volatile?.glaiveRush) {
    return {accuracy: true, multiplier: 1, modifiers: ['Glaive Rush']};
  }
  const actualCategory = category || moveCategory(state, action);
  let multiplier = 1;
  const modifiers: string[] = [];
  const actorSide = actor ? sideForPokemon(state, actor.id) : undefined;
  if (state.generation >= 2 && actor?.volatile?.lockOn &&
    action.targetIds.includes(actor.volatile.lockOn.targetId || '')) {
    return {accuracy: true, multiplier: 1, modifiers: ['Lock-On/Mind Reader']};
  }
  const partner = actorSide
    ? state.sides[actorSide].activeIds
      .filter(pokemonId => pokemonId !== action.actorId)
      .map(pokemonId => getPokemon(state, pokemonId))
      .find(pokemon => !!pokemon)
    : undefined;

  if (isMicleBerryReady(state, action, baseAccuracy)) {
    multiplier *= 4915 / 4096;
    modifiers.push('Micle Berry');
  }

  if (state.generation >= 4 && (hasAbility(state, actor, 'noguard') || hasAbility(state, target, 'noguard'))) {
    return {accuracy: true, multiplier: 1, modifiers: ['No Guard']};
  }
  const ignoresEvasion = (state.generation >= 3 && hasAbility(state, actor, 'keeneye')) ||
    (state.generation >= 9 && hasAbility(state, actor, 'mindseye')) ||
    (state.generation >= 9 && hasAbility(state, actor, 'illuminate'));
  if (ignoresEvasion) {
    const evasionAbility = hasAbility(state, actor, 'mindseye')
      ? "Mind's Eye"
      : hasAbility(state, actor, 'illuminate')
        ? 'Illuminate'
        : 'Keen Eye';
    modifiers.push(`${evasionAbility} ignores evasion`);
  }
  if (state.generation >= 3 && hasAbility(state, actor, 'compoundeyes')) {
    multiplier *= 1.3;
    modifiers.push('Compound Eyes');
  }
  if (state.generation >= 5 && (hasAbility(state, actor, 'victorystar') || hasAbility(state, partner, 'victorystar'))) {
    multiplier *= 1.1;
    modifiers.push('Victory Star');
  }
  if (state.generation >= 3 && hasAbility(state, actor, 'hustle') && actualCategory === 'Physical') {
    multiplier *= 0.8;
    modifiers.push('Hustle');
  }
  const item = id(actor?.item);
  if (state.generation >= 4 && !!actor && isItemEffectActive(state, actor) && item === 'widelens') {
    multiplier *= 1.1;
    modifiers.push('Wide Lens');
  }
  const attackerBaseSpeed = attackerSpeed ?? (actor ? baseSpeed(state, actor) : undefined);
  const targetBaseSpeed = targetSpeed ?? (target ? baseSpeed(state, target) : undefined);
  if (state.generation >= 4 && !!actor && isItemEffectActive(state, actor) && item === 'zoomlens' &&
    attackerBaseSpeed !== undefined && targetBaseSpeed !== undefined &&
    attackerBaseSpeed < targetBaseSpeed) {
    multiplier *= 1.2;
    modifiers.push('Zoom Lens');
  }
  if (state.generation >= 4 && state.field.gravity) {
    multiplier *= 5 / 3;
    modifiers.push('Gravity');
  }
  const targetAbilityIgnored = !!target &&
    ignoresTargetAbility(state, action.actorId, target.id, actualCategory);
  if (state.generation >= 3 && target && !targetAbilityIgnored && !isWeatherSuppressed(state) &&
    state.field.weather === 'Sand' && hasAbility(state, target, 'sandveil')) {
    multiplier *= 0.8;
    modifiers.push('Sand Veil');
  }
  if (state.generation >= 4 && target && !targetAbilityIgnored && !isWeatherSuppressed(state) &&
    (state.field.weather === 'Hail' || state.field.weather === 'Snow') && hasAbility(state, target, 'snowcloak')) {
    multiplier *= 0.8;
    modifiers.push('Snow Cloak');
  }
  if (state.generation >= 4 && target && !targetAbilityIgnored && target.volatile?.confusion &&
    hasAbility(state, target, 'tangledfeet')) {
    multiplier *= 0.5;
    modifiers.push('Tangled Feet');
  }
  if (actor?.boosts?.acc) {
    multiplier *= stageMultiplier(actor.boosts.acc);
    modifiers.push(`Accuracy stage ${actor.boosts.acc}`);
  }
  if (!ignoresEvasion && target?.boosts?.eva && !target.volatile?.miracleEye) {
    multiplier *= stageMultiplier(target.boosts.eva, true);
    modifiers.push(`Evasion stage ${target.boosts.eva}`);
  } else if (!ignoresEvasion && target?.boosts?.eva && target.volatile?.miracleEye) {
    modifiers.push('Miracle Eye ignores evasion changes');
  }
  const evasionItem = id(target?.item);
  if (!ignoresEvasion && target && isItemEffectActive(state, target) &&
    ((state.generation >= 2 && evasionItem === 'brightpowder') ||
      (state.generation >= 3 && evasionItem === 'laxincense'))) {
    multiplier *= 0.9;
    modifiers.push(target?.item || 'evasion item');
  }
  let accuracy = Math.min(100, Math.max(0, baseAccuracy * multiplier));
  // Wonder Skin caps opposing Status moves at 50% after ordinary modifiers.
  // Moves that already check at or below 50% are left unchanged; sure-hit moves
  // never reach this path.
  if (state.generation >= 5 && actualCategory === 'Status' && target && !targetAbilityIgnored &&
    hasAbility(state, target, 'wonderskin') && accuracy > 50) {
    accuracy = 50;
    modifiers.push('Wonder Skin');
  }
  return {
    accuracy,
    multiplier,
    modifiers,
  };
}
