import * as Calc from '@smogon/calc';
import {PokemonState, RUN_AND_BUN_EVS, StatID} from './model';

/** Return the temporary effective species used by calculator-facing adapters. */
export function getEffectiveSpecies(pokemon: PokemonState): string {
  return pokemon.speciesOverride || pokemon.species;
}

/** Build the calculator species override for a persistent base-stat transform. */
export function getCalcSpeciesOverrides(
  gen: ReturnType<typeof Calc.Generations.get>,
  pokemon: PokemonState,
): Calc.State.Pokemon['overrides'] | undefined {
  if (!pokemon.baseStatsOverride) return undefined;
  const species = new Calc.Pokemon(gen, getEffectiveSpecies(pokemon), {
    evs: RUN_AND_BUN_EVS,
  }).species;
  return {
    baseStats: {
      ...species.baseStats,
      ...pokemon.baseStatsOverride,
    },
  };
}

/** Return the species base stats in the model's stat naming scheme. */
export function getSpeciesBaseStats(
  gen: ReturnType<typeof Calc.Generations.get>,
  pokemon: PokemonState,
): Record<StatID, number> {
  const baseStats = new Calc.Pokemon(gen, getEffectiveSpecies(pokemon), {
    evs: RUN_AND_BUN_EVS,
  }).species.baseStats;
  return {
    hp: baseStats.hp,
    atk: baseStats.atk,
    def: baseStats.def,
    spa: baseStats.spa,
    spd: baseStats.spd,
    spe: baseStats.spe,
  };
}

/** Return the calculator raw stat inputs, including any active raw override. */
export function getRawStats(
  gen: ReturnType<typeof Calc.Generations.get>,
  pokemon: PokemonState,
): Record<StatID, number> {
  const calcPokemon = new Calc.Pokemon(gen, getEffectiveSpecies(pokemon), {
    level: pokemon.level,
    nature: pokemon.nature,
    ivs: pokemon.ivs,
    evs: RUN_AND_BUN_EVS,
    statOverrides: pokemon.statOverrides,
    overrides: getCalcSpeciesOverrides(gen, pokemon),
  });
  return {
    hp: calcPokemon.rawStats.hp,
    atk: calcPokemon.rawStats.atk,
    def: calcPokemon.rawStats.def,
    spa: calcPokemon.rawStats.spa,
    spd: calcPokemon.rawStats.spd,
    spe: calcPokemon.rawStats.spe,
  };
}
