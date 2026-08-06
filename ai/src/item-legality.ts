import {getEffectiveAbility, isAbilityActive, isAbilityAvailable} from './abilities';
import {BattleState, PokemonState} from './model';

export const PURE_ITEM_TRANSFER_MOVE_IDS = new Set(['bestow', 'trick', 'switcheroo']);

function moveId(name: string | undefined): string {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function canRemoveHeldItem(state: BattleState, pokemon: PokemonState): boolean {
  return !isAbilityActive(pokemon, state) || !isAbilityAvailable(state.generation, getEffectiveAbility(pokemon)) ||
    moveId(getEffectiveAbility(pokemon)) !== 'stickyhold';
}

/** Whether a pure held-item transfer would produce a legal state change. */
export function hasPureItemTransferEffect(
  state: BattleState,
  actor: PokemonState,
  target: PokemonState | undefined,
  id: string,
): boolean {
  if (!PURE_ITEM_TRANSFER_MOVE_IDS.has(id) || !target) return false;
  if (id === 'bestow') return !!actor.item && !target.item;
  if (!actor.item && !target.item) return false;
  return !target.item || canRemoveHeldItem(state, target);
}
