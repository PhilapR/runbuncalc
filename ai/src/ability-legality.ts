import {getEffectiveAbility, getGenerationAbility, isAbilityActive} from './abilities';
import {preventsAbilityChange} from './items';
import {BattleState, PokemonState} from './model';

export const PURE_ABILITY_MOVE_IDS = new Set([
  'roleplay', 'skillswap', 'entrainment', 'simplebeam', 'worryseed', 'doodle',
]);

function moveId(name: string | undefined): string {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function activeAbility(state: BattleState, pokemon: PokemonState | undefined): string | undefined {
  if (!pokemon || !isAbilityActive(pokemon, state)) return undefined;
  return getGenerationAbility(state.generation, pokemon);
}

/** Whether a pure ability-changing move would produce a different modeled ability state. */
export function hasPureAbilityEffect(
  state: BattleState,
  actor: PokemonState,
  target: PokemonState | undefined,
  id: string,
): boolean {
  if (!PURE_ABILITY_MOVE_IDS.has(id) || !target) return false;
  const actorAbility = activeAbility(state, actor);
  const targetAbility = activeAbility(state, target);
  const effectiveTargetAbility = moveId(getEffectiveAbility(target));
  switch (id) {
    case 'roleplay':
      return !preventsAbilityChange(state, actor) && !!targetAbility && moveId(actorAbility) !== moveId(targetAbility);
    case 'skillswap':
      return !preventsAbilityChange(state, actor) && !preventsAbilityChange(state, target) &&
        !!actorAbility && !!targetAbility && moveId(actorAbility) !== moveId(targetAbility);
    case 'entrainment':
      return !preventsAbilityChange(state, target) && !!actorAbility && moveId(actorAbility) !== effectiveTargetAbility;
    case 'simplebeam':
      return !preventsAbilityChange(state, target) && effectiveTargetAbility !== 'simple';
    case 'worryseed':
      return !preventsAbilityChange(state, target) && effectiveTargetAbility !== 'insomnia';
    case 'doodle':
      return !preventsAbilityChange(state, actor) && !!targetAbility && moveId(actorAbility) !== moveId(targetAbility);
    default:
      return false;
  }
}
