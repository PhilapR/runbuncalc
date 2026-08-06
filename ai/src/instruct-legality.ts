import {isMoveAvailable} from './move-metadata';
import {BattleState, PokemonState} from './model';

const INSTRUCT_BLOCKED_MOVES = new Set([
  'assist', 'beakblast', 'bide', 'bounce', 'counter', 'copycat', 'dig', 'dive', 'fly',
  'focuspunch', 'metronome', 'mimic', 'mirrormove', 'naturepower', 'phantomforce',
  'shelltrap', 'shadowforce', 'sketch', 'skydrop', 'sleeptalk', 'struggle', 'transform',
  'metalburst', 'mirrorcoat',
]);

function moveId(name: string | undefined): string {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Whether Instruct has a callable last move for its selected ally. */
export function hasInstructEffect(
  state: BattleState,
  target: PokemonState | undefined,
): boolean {
  if (state.generation < 7 || !target || target.isDynamaxed) return false;
  const calledMove = state.lastMoveUsedByPokemon?.[target.id];
  const calledId = moveId(calledMove);
  const targetMove = calledMove && target.moves.find(move => moveId(move.name) === calledId);
  return !!calledMove && isMoveAvailable(calledMove, state.generation) && !!targetMove &&
    targetMove.pp !== 0 && !INSTRUCT_BLOCKED_MOVES.has(calledId);
}
