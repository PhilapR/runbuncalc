import {getEffectiveAbility, isAbilityActive, isAbilityAvailable} from './abilities';
import {getEffectiveTypesForPokemon} from './eligibility';
import {getEffectiveMoveMetadata, getMoveMetadata} from './move-metadata';
import {BattleState, MoveAction, PokemonState} from './model';

function id(name: string | undefined): string {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

const CALLED_MOVE_WRAPPERS = new Set([
  'assist', 'copycat', 'instruct', 'metronome', 'mirrormove', 'naturepower', 'sleeptalk',
]);

function weatherBallType(state: BattleState): string {
  switch (state.field.weather) {
    case 'Sun':
    case 'Harsh Sunshine':
      return 'Fire';
    case 'Rain':
    case 'Heavy Rain':
      return 'Water';
    case 'Sand':
      return 'Rock';
    case 'Hail':
    case 'Snow':
      return 'Ice';
    default:
      return 'Normal';
  }
}

/** Resolve the move type available to Protean/Libero before the move executes. */
export function getTypeChangeMoveType(
  state: BattleState,
  action: MoveAction,
  pokemon: PokemonState,
): string | undefined {
  const moveId = id(action.moveName);
  if (CALLED_MOVE_WRAPPERS.has(moveId)) return undefined;
  const moveState = pokemon.moves.find(move => move.name === action.moveName);
  const metadata = moveState
    ? getEffectiveMoveMetadata(moveState, state.generation)
    : getMoveMetadata(action.moveName, state.generation);
  if (metadata.typeOverride) return metadata.typeOverride;
  if (moveId === 'weatherball') return weatherBallType(state);
  return metadata.type;
}

function typeChangingAbility(state: BattleState, pokemon: PokemonState): string | undefined {
  if (!isAbilityActive(pokemon, state)) return undefined;
  const ability = id(getEffectiveAbility(pokemon));
  if (ability !== 'protean' && ability !== 'libero') return undefined;
  if (!isAbilityAvailable(state.generation, ability)) return undefined;
  return ability;
}

/** Project the type that Protean/Libero will use for the pending move. */
export function projectTypeChangingPokemon(
  state: BattleState,
  action: MoveAction,
  pokemon: PokemonState,
): PokemonState {
  if (!typeChangingAbility(state, pokemon) || (state.generation >= 9 && pokemon.typeChangeUsed)) return pokemon;
  const moveType = getTypeChangeMoveType(state, action, pokemon);
  if (!moveType || id(moveType) === '???' || getEffectiveTypesForPokemon(state, pokemon)
    .some(type => id(type) === id(moveType))) return pokemon;
  return {
    ...pokemon,
    typeOverride: [moveType],
    typeChangeUsed: true,
  };
}

export function getTypeChangeResolution(
  state: BattleState,
  action: MoveAction,
  pokemon: PokemonState,
): {types: string[]; used: boolean} | undefined {
  const projected = projectTypeChangingPokemon(state, action, pokemon);
  if (projected === pokemon || projected.typeOverride === undefined) return undefined;
  return {types: projected.typeOverride, used: state.generation >= 9};
}
