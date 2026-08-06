import {getEffectiveAbility, isAbilityActive, isAbilityAvailable} from './abilities';
import {isWeatherSuppressed} from './actions';
import {BattleState, PokemonState, Weather} from './model';
import {getEffectiveSpecies} from './stat-transforms';

function id(name: string | undefined): string {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Return Forecast's form for the current effective weather, or undefined when it is not applicable. */
export function forecastSpeciesOverride(
  state: BattleState,
  pokemon: PokemonState,
  weather: Weather | undefined = state.field.weather,
): string | null | undefined {
  if (state.generation < 3 || !isAbilityActive(pokemon, state) ||
    !isAbilityAvailable(state.generation, getEffectiveAbility(pokemon)) ||
    id(getEffectiveAbility(pokemon)) !== 'forecast' || id(pokemon.species) !== 'castform') return undefined;
  const effectiveWeather = isWeatherSuppressed(state) ? undefined : weather;
  const targetSpecies = effectiveWeather === 'Sun' || effectiveWeather === 'Harsh Sunshine'
    ? 'Castform-Sunny'
    : effectiveWeather === 'Rain' || effectiveWeather === 'Heavy Rain'
      ? 'Castform-Rainy'
      : effectiveWeather === 'Hail' || effectiveWeather === 'Snow'
        ? 'Castform-Snowy'
        : undefined;
  const currentSpecies = id(getEffectiveSpecies(pokemon));
  if (targetSpecies) return currentSpecies === id(targetSpecies) ? undefined : targetSpecies;
  return ['castformrainy', 'castformsunny', 'castformsnowy'].includes(currentSpecies)
    ? null
    : undefined;
}

export function flowerGiftSpeciesOverride(
  state: BattleState,
  pokemon: PokemonState,
  weather: Weather | undefined = state.field.weather,
): string | null | undefined {
  if (state.generation < 4 || !isAbilityActive(pokemon, state) ||
    !isAbilityAvailable(state.generation, getEffectiveAbility(pokemon)) ||
    id(getEffectiveAbility(pokemon)) !== 'flowergift' || id(pokemon.species) !== 'cherrim') return undefined;
  const sunny = !isWeatherSuppressed(state) && (weather === 'Sun' || weather === 'Harsh Sunshine');
  const currentSpecies = id(getEffectiveSpecies(pokemon));
  if (sunny) return currentSpecies === 'cherrimsunshine' ? undefined : 'Cherrim-Sunshine';
  return currentSpecies === 'cherrimsunshine' ? null : undefined;
}

export function weatherFormSpeciesOverride(
  state: BattleState,
  pokemon: PokemonState,
  weather: Weather | undefined = state.field.weather,
): string | null | undefined {
  const forecast = forecastSpeciesOverride(state, pokemon, weather);
  return forecast !== undefined ? forecast : flowerGiftSpeciesOverride(state, pokemon, weather);
}
