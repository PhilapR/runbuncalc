import {getEffectiveAbility, isAbilityActive, isAbilityAvailable} from './abilities';
import {BattleState, PokemonState, Terrain, TypeName} from './model';

function id(name: string | undefined): string {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export const MIMICRY_TYPES: Record<Terrain, TypeName> = {
  Electric: 'Electric',
  Grassy: 'Grass',
  Misty: 'Fairy',
  Psychic: 'Psychic',
};

export function isMimicryActive(state: BattleState, pokemon: PokemonState): boolean {
  return isAbilityActive(pokemon, state) && isAbilityAvailable(state.generation, 'mimicry') &&
    id(getEffectiveAbility(pokemon)) === 'mimicry';
}

export function mimicryTypeOverride(terrain: Terrain | undefined): TypeName[] | null {
  return terrain ? [MIMICRY_TYPES[terrain]] : null;
}
