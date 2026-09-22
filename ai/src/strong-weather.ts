import {getEffectiveAbility, isAbilityActive} from './abilities';
import {getPokemon} from './actions';
import {BattleState} from './model';

// Its own module so that entry-hazards can settle a strong weather before it
// judges an entry setter, without an import cycle through transition.

const STRONG_WEATHER_SOURCE: Readonly<Record<string, string>> = {
  'Heavy Rain': 'primordialsea',
  'Harsh Sunshine': 'desolateland',
  'Strong Winds': 'deltastream',
};

/**
 * A strong weather lasts only while a Pokemon with its ability stands on the
 * field. When Primal Kyogre faints or leaves, the heavy rain ends at once —
 * which is what Wallace's Swift Swim Barraskewda and Mega Swampert, sent in
 * behind it, fight without.
 */
export function settleStrongWeather(state: BattleState): BattleState {
  const weather = state.field.weather;
  const source = weather === undefined ? undefined : STRONG_WEATHER_SOURCE[weather];
  if (source === undefined) return state;
  const held = (['ai', 'player'] as const).some(sideId => state.sides[sideId].activeIds.some(pokemonId => {
    const pokemon = getPokemon(state, pokemonId);
    return !!pokemon && pokemon.hp.current > 0 && isAbilityActive(pokemon, state) &&
      (getEffectiveAbility(pokemon) ?? '').toLowerCase().replace(/[^a-z0-9]/g, '') === source;
  }));
  if (held) return state;
  const field = {...state.field};
  delete field.weather;
  if (field.durations) {
    const durations = {...field.durations};
    delete durations.weather;
    field.durations = durations;
  }
  return {...state, field};
}
