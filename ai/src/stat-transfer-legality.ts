import * as Calc from '@smogon/calc';
import {BattleState, PokemonState} from './model';
import {getRawStats} from './stat-transforms';

export const PURE_STAT_TRANSFER_MOVE_IDS = new Set([
  'speedswap', 'guardsplit', 'powersplit', 'heartswap', 'powertrick', 'powershift',
]);

const STAGE_IDS = ['atk', 'def', 'spa', 'spd', 'spe', 'acc', 'eva'] as const;

function rawStats(state: BattleState, pokemon: PokemonState) {
  return getRawStats(Calc.Generations.get(state.generation), pokemon);
}

function sameStages(actor: PokemonState, target: PokemonState): boolean {
  return STAGE_IDS.every(stat => (actor.boosts?.[stat] || 0) === (target.boosts?.[stat] || 0));
}

/** Whether a pure stat/stage exchange would change the modeled state. */
export function hasPureStatTransferEffect(
  state: BattleState,
  actor: PokemonState,
  target: PokemonState | undefined,
  id: string,
): boolean {
  if (!PURE_STAT_TRANSFER_MOVE_IDS.has(id)) return true;
  if (id === 'powertrick' || id === 'powershift') {
    const stats = rawStats(state, actor);
    return stats.atk !== stats.def;
  }
  if (!target) return false;
  if (id === 'heartswap') return !sameStages(actor, target);
  const actorRaw = rawStats(state, actor);
  const targetRaw = rawStats(state, target);
  if (id === 'speedswap') return actorRaw.spe !== targetRaw.spe;
  if (id === 'guardsplit') return actorRaw.def !== targetRaw.def || actorRaw.spd !== targetRaw.spd;
  if (id === 'powersplit') return actorRaw.atk !== targetRaw.atk || actorRaw.spa !== targetRaw.spa;
  return false;
}
