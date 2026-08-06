/** The three Generation V+ Pledge moves, normalized for rule checks. */
export type PledgeElement = 'fire' | 'grass' | 'water';
export type PledgeCombination = 'rainbow' | 'swamp' | 'seaOfFire';

export function pledgeElement(moveName: string | undefined): PledgeElement | undefined {
  const id = (moveName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (id === 'firepledge') return 'fire';
  if (id === 'grasspledge') return 'grass';
  if (id === 'waterpledge') return 'water';
  return undefined;
}

export function pledgeCombination(
  left: string | undefined,
  right: string | undefined,
): PledgeCombination | undefined {
  const first = pledgeElement(left);
  const second = pledgeElement(right);
  if ((first === 'fire' && second === 'water') || (first === 'water' && second === 'fire')) return 'rainbow';
  if ((first === 'grass' && second === 'water') || (first === 'water' && second === 'grass')) return 'swamp';
  if ((first === 'fire' && second === 'grass') || (first === 'grass' && second === 'fire')) return 'seaOfFire';
  return undefined;
}

export function isSwampPledgePair(left: string | undefined, right: string | undefined): boolean {
  return pledgeCombination(left, right) === 'swamp';
}
