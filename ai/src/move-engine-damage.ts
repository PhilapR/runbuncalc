import {getPokemon, isGhostType} from './actions';
import {sampleDamageResolution} from './resolution';
import {
  ActionFacts,
  BattleState,
  MoveAction,
  MoveResolution,
  PokemonState,
} from './model';

/**
 * Multi-hit damage sequencing.
 *
 * Walks sampled hit arrays through the Substitute boundary so later hits, KOs,
 * and one-HP survival effects (Sturdy, Focus Sash, Focus Band, Endure) all see
 * the same per-hit view of damage.
 */

export function totalDamage(resolution: MoveResolution): number {
  let total = 0;
  for (const targetId of Object.keys(resolution.damageByTarget || {})) {
    total += resolution.damageByTarget![targetId];
  }
  return total;
}

export function setSequentialDamage(resolution: MoveResolution, targetId: string, hits: number[]): void {
  if (!resolution.hitDamageByTarget) return;
  const aggregateDamage = hits.reduce((total, hit) => total + hit, 0);
  resolution.hitDamageByTarget[targetId] = hits;
  resolution.damageByTarget = {
    ...(resolution.damageByTarget || {}),
    [targetId]: aggregateDamage,
  };
  if (resolution.trace?.damageRollsByTarget) {
    resolution.trace.damageRollsByTarget[targetId] = aggregateDamage;
  }
  if (resolution.trace?.hitDamageRollsByTarget) {
    resolution.trace.hitDamageRollsByTarget[targetId] = hits;
  }
}

export interface SequentialDamageOutcome {
  directDamage: number;
  hitCount: number;
  fainted: boolean;
}

export function sequentialDamageOutcome(
  target: PokemonState,
  hits: number[] | undefined,
  aggregateDamage: number,
): SequentialDamageOutcome {
  if (!hits) {
    const damageAfterSubstitute = Math.max(0, aggregateDamage - (target.substituteHp || 0));
    const directDamage = damageAfterSubstitute > 0
      ? target.volatile?.endure
        ? Math.min(damageAfterSubstitute, Math.max(0, target.hp.current - 1))
        : Math.min(damageAfterSubstitute, target.hp.current)
      : 0;
    return {
      directDamage,
      hitCount: directDamage > 0 ? 1 : 0,
      fainted: directDamage >= target.hp.current && directDamage > 0 && !target.volatile?.endure,
    };
  }

  let hp = target.hp.current;
  let substituteHp = Math.max(0, target.substituteHp || 0);
  let directDamage = 0;
  let hitCount = 0;
  for (const hit of hits) {
    if (hp <= 0) break;
    if (hit <= 0) continue;
    if (substituteHp > 0) {
      substituteHp = Math.max(0, substituteHp - hit);
      continue;
    }
    hitCount += 1;
    const actualDamage = target.volatile?.endure
      ? Math.min(hit, Math.max(0, hp - 1))
      : Math.min(hit, hp);
    directDamage += actualDamage;
    hp -= actualDamage;
  }
  return {directDamage, hitCount, fainted: hp <= 0};
}

export function directDamageTotal(
  state: BattleState,
  resolution: MoveResolution,
  actorId: string,
): number {
  let total = 0;
  for (const [targetId, aggregateDamage] of Object.entries(resolution.damageByTarget || {})) {
    if (targetId === actorId) continue;
    const target = getPokemon(state, targetId);
    if (!target) continue;
    total += sequentialDamageOutcome(
      target,
      resolution.hitDamageByTarget?.[targetId],
      aggregateDamage,
    ).directDamage;
  }
  return total;
}

export function directDamageTakenByPokemon(
  state: BattleState,
  resolution: MoveResolution,
  pokemon: PokemonState,
): number {
  const aggregateDamage = resolution.damageByTarget?.[pokemon.id] || 0;
  if (!aggregateDamage) return 0;
  return sequentialDamageOutcome(
    pokemon,
    resolution.hitDamageByTarget?.[pokemon.id],
    aggregateDamage,
  ).directDamage;
}

export function hasSurvivingDirectHit(
  target: PokemonState,
  hits: number[] | undefined,
  aggregateDamage: number,
): boolean {
  if (!hits) {
    const damageAfterSubstitute = Math.max(0, aggregateDamage - (target.substituteHp || 0));
    if (damageAfterSubstitute <= 0) return false;
    const actualDamage = target.volatile?.endure
      ? Math.min(damageAfterSubstitute, Math.max(0, target.hp.current - 1))
      : Math.min(damageAfterSubstitute, target.hp.current);
    return actualDamage > 0 && actualDamage < target.hp.current;
  }

  let hp = target.hp.current;
  let substituteHp = Math.max(0, target.substituteHp || 0);
  for (const hit of hits) {
    if (hit <= 0) continue;
    if (substituteHp > 0) {
      substituteHp = Math.max(0, substituteHp - hit);
      continue;
    }
    const actualDamage = target.volatile?.endure
      ? Math.min(hit, Math.max(0, hp - 1))
      : Math.min(hit, hp);
    if (actualDamage > 0 && actualDamage < hp) return true;
    hp -= actualDamage;
    if (hp <= 0) return false;
  }
  return false;
}

export function hasDirectMoveHitAfterSubstitute(
  target: PokemonState,
  hits: number[] | undefined,
  aggregateDamage: number,
): boolean {
  if (!hits) return !(target.substituteHp && aggregateDamage <= target.substituteHp);
  let substituteHp = Math.max(0, target.substituteHp || 0);
  for (const hit of hits) {
    if (substituteHp > 0) {
      if (hit > 0) substituteHp = Math.max(0, substituteHp - hit);
      continue;
    }
    return true;
  }
  return false;
}

export function adjustFirstSequentialHit(
  resolution: MoveResolution,
  targetId: string,
  adjust: (damage: number) => number,
): boolean {
  const hits = resolution.hitDamageByTarget?.[targetId];
  if (!hits || !hits.length || hits[0] <= 0) return false;
  const nextHits = [...hits];
  nextHits[0] = Math.max(0, adjust(nextHits[0]));
  setSequentialDamage(resolution, targetId, nextHits);
  return true;
}

export function adjustFirstDirectSequentialHit(
  resolution: MoveResolution,
  target: PokemonState,
  targetId: string,
  adjust: (damage: number) => number,
): boolean {
  const hits = resolution.hitDamageByTarget?.[targetId];
  if (!hits || !hits.length) return false;
  let substituteHp = Math.max(0, target.substituteHp || 0);
  const nextHits = [...hits];
  for (let index = 0; index < nextHits.length; index += 1) {
    const hit = nextHits[index];
    if (hit <= 0) continue;
    if (substituteHp > 0) {
      substituteHp = Math.max(0, substituteHp - hit);
      continue;
    }
    nextHits[index] = Math.max(0, adjust(hit));
    setSequentialDamage(resolution, targetId, nextHits);
    return true;
  }
  return false;
}

export function adjustFirstFatalDirectSequentialHit(
  resolution: MoveResolution,
  target: PokemonState,
  targetId: string,
  adjust: (damage: number, remainingHp: number) => number,
): boolean {
  const hits = resolution.hitDamageByTarget?.[targetId];
  if (!hits || !hits.length) return false;
  let hp = target.hp.current;
  let substituteHp = Math.max(0, target.substituteHp || 0);
  const nextHits = [...hits];
  for (let index = 0; index < nextHits.length; index += 1) {
    const hit = nextHits[index];
    if (hit <= 0) continue;
    if (substituteHp > 0) {
      substituteHp = Math.max(0, substituteHp - hit);
      continue;
    }
    if (!target.volatile?.endure && hit >= hp) {
      nextHits[index] = Math.max(0, adjust(hit, hp));
      setSequentialDamage(resolution, targetId, nextHits);
      return true;
    }
    hp = Math.max(0, hp - hit);
    if (hp <= 0) break;
  }
  return false;
}

export function adjustFirstFatalFirstDirectSequentialHit(
  resolution: MoveResolution,
  target: PokemonState,
  targetId: string,
  adjust: (damage: number) => number,
): boolean {
  const hits = resolution.hitDamageByTarget?.[targetId];
  if (!hits || !hits.length) return false;
  let substituteHp = Math.max(0, target.substituteHp || 0);
  const nextHits = [...hits];
  for (let index = 0; index < nextHits.length; index += 1) {
    const hit = nextHits[index];
    if (hit <= 0) continue;
    if (substituteHp > 0) {
      substituteHp = Math.max(0, substituteHp - hit);
      continue;
    }
    if (target.volatile?.endure || hit < target.hp.current) return false;
    nextHits[index] = Math.max(0, adjust(hit));
    setSequentialDamage(resolution, targetId, nextHits);
    return true;
  }
  return false;
}

export function crashDamageOnMiss(
  state: BattleState,
  actor: PokemonState,
  action: MoveAction,
  facts: ActionFacts | undefined,
  resolution: MoveResolution,
  random: () => number,
): number {
  if (state.generation === 1) return 1;
  if (state.generation === 2) return Math.max(1, Math.floor(actor.hp.max / 8));
  if (state.generation >= 5) return Math.max(1, Math.floor(actor.hp.max / 2));

  const target = action.targetIds[0] ? getPokemon(state, action.targetIds[0]) : undefined;
  if (target && isGhostType(state, target.id)) return 0;

  const sampled = totalDamage(resolution) || (facts
    ? totalDamage(sampleDamageResolution(action, facts, random))
    : 0);
  return Math.floor(sampled / 2);
}
