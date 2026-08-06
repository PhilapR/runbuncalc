import {isAbilityAvailable} from './abilities';
import {isItemAvailable} from './items';
import {ActionFacts, BattleState, DamageFacts} from './model';

const ABILITY_FACT_KEYS = [
  'attackerAbility', 'attackerPartnerAbility', 'defenderAbility',
] as const;
const ITEM_FACT_KEYS = [
  'attackerItem', 'attackerPartnerItem', 'defenderItem',
] as const;

/** Remove known pre-introduction ability/item facts before policy consumes them. */
export function normalizeGenerationFacts(state: BattleState, facts: ActionFacts): ActionFacts {
  const normalized = {...facts};
  for (const key of ABILITY_FACT_KEYS) {
    const ability = normalized[key];
    if (ability !== undefined && !isAbilityAvailable(state.generation, ability)) normalized[key] = undefined;
  }
  for (const key of ITEM_FACT_KEYS) {
    const item = normalized[key];
    if (item !== undefined && !isItemAvailable(state, item)) normalized[key] = undefined;
  }
  return normalized;
}

export type DamageInput = number | number[] | [number, number] | [number[], number[]];

export function normalizeDamageRolls(damage: DamageInput): number[] {
  if (typeof damage === 'number') return [Math.max(0, damage)];

  if (damage.length === 0) return [0];

  if (typeof damage[0] === 'number') {
    const rolls = damage as number[];
    // The calculator uses a two-number tuple for fixed two-hit damage.
    if (rolls.length === 2) return [Math.max(0, rolls[0] + rolls[1])];
    return rolls.map(roll => Math.max(0, roll));
  }

  const [firstHit, secondHit] = damage as [number[], number[]];
  const rolls: number[] = [];
  for (const first of firstHit) {
    for (const second of secondHit) {
      rolls.push(Math.max(0, first + second));
    }
  }
  return rolls.length ? rolls : [0];
}

/** Preserve calculator-provided independent hit distributions when present. */
export function normalizeDamageHitRolls(damage: DamageInput): number[][] | undefined {
  if (!Array.isArray(damage) || damage.length !== 2 ||
    !Array.isArray(damage[0]) || !Array.isArray(damage[1])) return undefined;
  return (damage as [number[], number[]]).map(rolls =>
    rolls.length ? rolls.map(roll => Math.max(0, roll)) : [0]);
}

export function makeDamageFacts(damage: DamageInput, targetHp: number, hits = 1): DamageFacts {
  const hitRolls = normalizeDamageHitRolls(damage);
  const rolls = normalizeDamageRolls(damage);
  const hitCount = hitRolls ? hitRolls.length : Math.max(1, Math.floor(hits));
  const min = hitRolls
    ? hitRolls.reduce((total, perHit) => total + Math.min(...perHit), 0)
    : Math.min(...rolls) * hitCount;
  const max = hitRolls
    ? hitRolls.reduce((total, perHit) => total + Math.max(...perHit), 0)
    : Math.max(...rolls) * hitCount;

  return {
    rolls,
    ...(hitCount > 1 ? {hits: hitCount} : {}),
    ...(hitRolls ? {hitRolls} : {}),
    min,
    max,
    targetHp,
    possibleKO: targetHp > 0 && max >= targetHp,
    guaranteedKO: targetHp > 0 && min >= targetHp,
  };
}

export function scoringDamageFacts(facts: ActionFacts): DamageFacts | undefined {
  const damages: DamageFacts[] = [];
  if (facts.damageByTarget) {
    for (const targetId of Object.keys(facts.damageByTarget)) {
      damages.push(facts.damageByTarget[targetId]);
    }
  } else if (facts.damage) {
    damages.push(facts.damage);
  }
  if (damages.length === 0) return undefined;
  if (damages.length === 1) return damages[0];

  const rolls: number[] = [];
  for (const damage of damages) rolls.push(...damage.rolls);
  return {
    rolls,
    min: Math.min(...damages.map(damage => damage.min)),
    max: Math.max(...damages.map(damage => damage.max)),
    targetHp: damages[0].targetHp,
    possibleKO: damages.some(damage => damage.possibleKO),
    guaranteedKO: damages.some(damage => damage.guaranteedKO),
  };
}

export function isDamagingFacts(facts: ActionFacts): boolean {
  return !!scoringDamageFacts(facts) && facts.moveCategory !== 'Status';
}
