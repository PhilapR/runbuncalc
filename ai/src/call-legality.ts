import * as Calc from '@smogon/calc';
import {COPY_BLOCKED_MOVES} from './copy-legality';
import {getMoveMetadata, isMoveAvailable} from './move-metadata';
import {BattleState, PokemonState} from './model';

export const PURE_CALL_MOVE_IDS = new Set(['assist', 'mefirst', 'sleeptalk', 'metronome']);

export const ASSIST_BLOCKED_MOVES = new Set([
  ...Array.from(COPY_BLOCKED_MOVES),
  'bounce', 'dig', 'dive', 'fly', 'phantomforce', 'shadowforce', 'skydrop',
]);
export const ME_FIRST_BLOCKED_MOVES = new Set([...Array.from(COPY_BLOCKED_MOVES), 'metalburst', 'mirrorcoat']);

function moveId(name: string | undefined): string {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function hasAssistCandidate(state: BattleState, actor: PokemonState): boolean {
  if (state.generation < 3 || state.generation >= 8) return false;
  const sideId = state.sides.ai.activeIds.includes(actor.id) ? 'ai' : 'player';
  for (const pokemon of state.sides[sideId].party) {
    if (pokemon.id === actor.id) continue;
    const moves = state.generation <= 4 ? (pokemon.originalMoves || pokemon.moves) : pokemon.moves;
    if (moves.some(move => isMoveAvailable(move.name, state.generation) &&
      !ASSIST_BLOCKED_MOVES.has(moveId(move.name)))) return true;
  }
  return false;
}

function hasMeFirstCandidate(state: BattleState, target: PokemonState | undefined): boolean {
  if (state.generation < 4 || state.generation >= 8 || !target) return false;
  const selected = state.selectedMoveByPokemon?.[target.id];
  const selectedMetadata = selected?.moveName
    ? getMoveMetadata(selected.moveName, state.generation)
    : undefined;
  if (!selected || selected.useZ || selected.useMax || !selectedMetadata ||
    !isMoveAvailable(selected.moveName, state.generation) || selectedMetadata.category === 'Status') return false;
  return !ME_FIRST_BLOCKED_MOVES.has(moveId(selected.moveName));
}

function hasSleepTalkCandidate(state: BattleState, actor: PokemonState): boolean {
  if (state.generation < 2 || actor.status !== 'slp' || actor.statusTurns === 0) return false;
  return actor.moves.some(move => isMoveAvailable(move.name, state.generation) &&
    moveId(move.name) !== 'sleeptalk' && !move.disabled);
}

function hasMetronomeCandidate(state: BattleState): boolean {
  return Array.from(Calc.Generations.get(state.generation).moves).some(move =>
    !!move.name && isMoveAvailable(move.name, state.generation) &&
    moveId(move.name) !== 'metronome' && !COPY_BLOCKED_MOVES.has(moveId(move.name)));
}

/** Whether a candidate-source move has at least one legal source action. */
export function hasCallMoveEffect(
  state: BattleState,
  actor: PokemonState,
  target: PokemonState | undefined,
  id: string,
): boolean {
  switch (id) {
    case 'assist': return hasAssistCandidate(state, actor);
    case 'mefirst': return hasMeFirstCandidate(state, target);
    case 'sleeptalk': return hasSleepTalkCandidate(state, actor);
    case 'metronome': return hasMetronomeCandidate(state);
    default: return true;
  }
}
