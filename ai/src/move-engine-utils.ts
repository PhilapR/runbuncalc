import {getEffectiveAbility, isAbilityActive, isAbilityAvailable} from './abilities';
import {getPokemon, sideForPokemon} from './actions';
import {getEffectiveSpecies} from './stat-transforms';
import {ABILITY_CHANGE_IMMUNITIES} from './move-engine-tables';
import {BattleState, PokemonState, SideId} from './model';

/**
 * Small shared predicates used across the move-engine modules.
 *
 * Everything here is a one-liner over state or a name; anything that writes to
 * a resolution belongs in `move-engine-writers.ts` instead.
 */

export function canChangeAbility(ability: string | undefined): boolean {
  return !!ability && !ABILITY_CHANGE_IMMUNITIES.has(moveId(ability));
}

export function moveId(name: string | undefined): string {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function otherSide(sideId: SideId): SideId {
  return sideId === 'ai' ? 'player' : 'ai';
}

export function hasActiveAlly(state: BattleState, pokemon: PokemonState): boolean {
  const sideId = sideForPokemon(state, pokemon.id);
  return state.mode === 'Doubles' && state.sides[sideId].activeIds.some(id =>
    id !== pokemon.id && (getPokemon(state, id)?.hp.current || 0) > 0);
}

export function hasAbility(state: BattleState, pokemon: PokemonState, ability: string): boolean {
  return isAbilityActive(pokemon, state) && isAbilityAvailable(state.generation, ability) &&
    moveId(getEffectiveAbility(pokemon)) === ability;
}

export function hasMagicGuard(state: BattleState, pokemon: PokemonState): boolean {
  return state.generation >= 4 && hasAbility(state, pokemon, 'magicguard');
}

export function isIceFaceActive(state: BattleState, pokemon: PokemonState): boolean {
  return state.generation >= 8 && hasAbility(state, pokemon, 'iceface') &&
    moveId(getEffectiveSpecies(pokemon)) === 'eiscue';
}

export function isBerry(item: string | undefined): boolean {
  return moveId(item).endsWith('berry');
}

export function hasSubstitute(state: BattleState, pokemonId: string): boolean {
  return (getPokemon(state, pokemonId)?.substituteHp || 0) > 0;
}
