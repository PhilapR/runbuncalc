import {ActionFacts, DamageFacts, MoveAction, MoveResolution} from './model';

function pickRoll(facts: DamageFacts, random: () => number, critical = false): number {
  if (critical && facts.critRolls?.length) {
    const critSample = random();
    if (!Number.isFinite(critSample)) throw new Error('Damage sampler must return a finite number');
    const critBounded = Math.max(0, Math.min(0.999999999999, critSample));
    return facts.critRolls[Math.floor(critBounded * facts.critRolls.length)];
  }
  if (!facts.rolls.length) return 0;
  const sample = random();
  if (!Number.isFinite(sample)) throw new Error('Damage sampler must return a finite number');
  const bounded = Math.max(0, Math.min(0.999999999999, sample));
  return facts.rolls[Math.floor(bounded * facts.rolls.length)];
}

/** Sample a single calculator damage fact for a non-targeted consequence. */
export function sampleDamageFact(facts: DamageFacts, random: () => number = Math.random): number {
  return pickRoll(facts, random);
}

/**
 * Convert calculator damage facts into a serializable sampled outcome. This
 * does not model accuracy or secondary effects; a battle engine may add those
 * fields before passing the outcome to resolveMoveAction().
 */
export function sampleDamageResolution(
  action: Extract<MoveAction, {kind: 'move'}>,
  facts: ActionFacts,
  random: () => number = Math.random,
  criticalByTarget: Record<string, boolean> = {},
  hitCountOverride?: number,
): MoveResolution {
  const damageByTarget: Record<string, number> = {};
  const damageRollsByTarget: Record<string, number> = {};
  const hitDamageByTarget: Record<string, number[]> = {};
  const hitDamageRollsByTarget: Record<string, number[]> = {};
  const damageFactsByTarget = facts.damageByTarget || {};

  for (const targetId of action.targetIds) {
    const targetFacts = damageFactsByTarget[targetId] ||
      (action.targetIds.length === 1 ? facts.damage : undefined);
    if (!targetFacts) continue;
    const hitCount = hitCountOverride ?? targetFacts.hits ?? 1;
    const critical = criticalByTarget[targetId] === true;
    const hits = targetFacts.hitRolls
      ? targetFacts.hitRolls.map(rolls => pickRoll({rolls, min: 0, max: 0, targetHp: 0,
        possibleKO: false, guaranteedKO: false}, random))
      : Array.from({length: hitCount}, () => pickRoll(targetFacts, random, critical));
    const damage = hits.reduce((total, hit) => total + hit, 0);
    damageByTarget[targetId] = damage;
    damageRollsByTarget[targetId] = damage;
    if (hitCount > 1) {
      hitDamageByTarget[targetId] = hits;
      hitDamageRollsByTarget[targetId] = hits;
    }
  }

  return {
    damageByTarget: Object.keys(damageByTarget).length ? damageByTarget : undefined,
    hitDamageByTarget: Object.keys(hitDamageByTarget).length ? hitDamageByTarget : undefined,
    trace: {
      source: 'calculator',
      damageRollsByTarget: Object.keys(damageRollsByTarget).length
        ? damageRollsByTarget
        : undefined,
      hitDamageRollsByTarget: Object.keys(hitDamageRollsByTarget).length
        ? hitDamageRollsByTarget
        : undefined,
      notes: ['sampled from calculator damage facts'],
    },
  };
}
