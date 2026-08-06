import * as Calc from '@smogon/calc';
import {getMoveMetadata} from './move-metadata';
import {BattleState, PokemonState} from './model';

export const PURE_TYPE_MOVE_IDS = new Set([
  'soak', 'magicpowder', 'forestscurse', 'trickortreat', 'reflecttype', 'camouflage',
  'conversion', 'conversion2',
]);

function moveId(name: string | undefined): string {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function sameTypes(current: string[], desired: string[]): boolean {
  return current.length === desired.length && current.every((type, index) =>
    moveId(type) === moveId(desired[index]));
}

function conversion2HasCandidate(
  state: BattleState,
  actor: PokemonState,
  target: PokemonState | undefined,
  currentTypes: string[],
): boolean {
  const sourcePokemonId = state.generation >= 5 ? target?.id : actor.id;
  const sourceMoveName = state.generation >= 5
    ? (sourcePokemonId ? state.lastMoveUsedByPokemon?.[sourcePokemonId] : undefined)
    : state.lastDamagingMoveByPokemon?.[actor.id];
  const sourceMoveType = sourceMoveName ? getMoveMetadata(sourceMoveName, state.generation).type : undefined;
  const typeData = sourceMoveType && moveId(sourceMoveType) !== '???'
    ? Calc.Generations.get(state.generation).types.get(Calc.toID(sourceMoveType))
    : undefined;
  if (!typeData || (state.generation >= 9 && moveId(sourceMoveType) === 'stellar')) return false;
  return Array.from(Calc.Generations.get(state.generation).types)
    .filter(type => moveId(type.name) !== '???')
    .filter(type => state.generation < 4 || !currentTypes.some(current => moveId(current) === moveId(type.name)))
    .some(type => (typeData.effectiveness[type.name] ?? 1) < 1);
}

/** Whether a modeled pure type move would change the target or actor types. */
export function hasPureTypeEffect(
  state: BattleState,
  actor: PokemonState,
  target: PokemonState | undefined,
  id: string,
  getTypes: (pokemonId: string) => string[],
): boolean {
  if (!PURE_TYPE_MOVE_IDS.has(id)) return true;
  const actorTypes = getTypes(actor.id);
  const targetTypes = target ? getTypes(target.id) : [];
  switch (id) {
    case 'soak': return !!target && !sameTypes(targetTypes, ['Water']);
    case 'magicpowder': return !!target && !sameTypes(targetTypes, ['Psychic']);
    case 'forestscurse': return !!target && !targetTypes.some(type => moveId(type) === 'grass');
    case 'trickortreat': return !!target && !targetTypes.some(type => moveId(type) === 'ghost');
    case 'reflecttype': return !!target && targetTypes.length > 0 && !sameTypes(actorTypes, targetTypes);
    case 'camouflage': {
      const terrainType: Record<string, string> = {
        Electric: 'Electric', Grassy: 'Grass', Misty: 'Fairy', Psychic: 'Psychic',
      };
      return !sameTypes(actorTypes, [terrainType[state.field.terrain || ''] || 'Normal']);
    }
    case 'conversion': {
      const move = state.generation >= 6
        ? actor.moves[0]
        : actor.moves.find(candidate => !['conversion', 'conversion2'].includes(moveId(candidate.name)));
      const moveType = move ? getMoveMetadata(move.name, state.generation).type : undefined;
      return !!moveType && moveId(moveType) !== '???' &&
        !actorTypes.some(type => moveId(type) === moveId(moveType));
    }
    case 'conversion2': return conversion2HasCandidate(state, actor, target, actorTypes);
    default: return false;
  }
}
