import {BattleState, PokemonState} from './model';

export const PURE_PP_MOVE_IDS = new Set(['spite', 'eeriespell']);

const PP_LOSS_BY_MOVE: Record<string, number> = {
  spite: 4,
  eeriespell: 3,
};

function moveId(name: string | undefined): string {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function ppLossForMove(state: BattleState, id: string): number {
  if (id === 'spite') return state.generation >= 2 ? PP_LOSS_BY_MOVE[id] : 0;
  if (id === 'eeriespell') return state.generation >= 8 ? PP_LOSS_BY_MOVE[id] : 0;
  return 0;
}

export function getLastMoveState(state: BattleState, target: PokemonState): PokemonState['moves'][number] | undefined {
  const lastMove = state.lastMoveUsedByPokemon?.[target.id];
  return lastMove ? target.moves.find(move => moveId(move.name) === moveId(lastMove)) : undefined;
}

/** Whether a tracked last move can lose PP from a pure PP-reduction move. */
export function hasPurePPEffect(state: BattleState, target: PokemonState | undefined, id: string): boolean {
  if (!target || !PURE_PP_MOVE_IDS.has(id) || ppLossForMove(state, id) === 0) return false;
  const lastMove = getLastMoveState(state, target);
  return !!lastMove && lastMove.pp !== 0;
}

export function getPurePPLoss(state: BattleState, id: string): number {
  return ppLossForMove(state, id);
}
