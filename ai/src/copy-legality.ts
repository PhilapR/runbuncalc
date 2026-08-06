import {isMoveAvailable} from './move-metadata';
import {BattleState, PokemonState} from './model';

export const PURE_MOVE_COPY_IDS = new Set(['copycat', 'mirrormove', 'mimic', 'sketch']);

export const COPY_BLOCKED_MOVES = new Set([
  'assist', 'banefulbunker', 'beakblast', 'belch', 'bestow', 'celebrate', 'chatter', 'circlethrow',
  'copycat', 'counter', 'covet', 'destinybond', 'detect', 'dragontail', 'dynamaxcannon', 'endure',
  'feint', 'focuspunch', 'followme', 'helpinghand', 'holdhands', 'kingsshield', 'matblock', 'mefirst',
  'metronome', 'mimic', 'mirrormove', 'naturepower', 'protect', 'ragepowder', 'roar', 'shelltrap',
  'sketch', 'sleeptalk', 'snatch', 'spikyshield', 'spotlight', 'struggle', 'switcheroo', 'thief',
  'transform', 'trick', 'whirlwind',
]);

function moveId(name: string | undefined): string {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function legalCopyName(state: BattleState, name: string | undefined): boolean {
  return !!name && isMoveAvailable(name, state.generation) && !COPY_BLOCKED_MOVES.has(moveId(name));
}

/** Whether a pure move-copy action has a legal source move. */
export function hasMoveCopyEffect(
  state: BattleState,
  actor: PokemonState,
  target: PokemonState | undefined,
  id: string,
): boolean {
  if (!PURE_MOVE_COPY_IDS.has(id)) return true;
  const copyName = id === 'copycat'
    ? state.lastMoveUsed
    : id === 'mirrormove'
      ? state.lastMoveTargetedByPokemon?.[actor.id]
      : target ? state.lastMoveUsedByPokemon?.[target.id] : undefined;
  if (!legalCopyName(state, copyName)) return false;
  if ((id === 'mimic' || id === 'sketch') &&
    (!target || actor.moves.some(move => moveId(move.name) === moveId(copyName)))) return false;
  return true;
}
