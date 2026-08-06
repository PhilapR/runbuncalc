const PURE_TARGET_STAGE_DROPS: Record<string, readonly string[]> = {
  babydolleyes: ['atk'], captivate: ['spa'], charm: ['atk'], confide: ['spa'], cottonspore: ['spe'],
  featherdance: ['atk'], faketears: ['spd'], flash: ['acc'], growl: ['atk'],
  kinesis: ['acc'], leer: ['def'], metalsound: ['spd'], playnice: ['atk'], scaryface: ['spe'],
  sandattack: ['acc'], screech: ['def'], smokescreen: ['acc'], stringshot: ['spe'], sweetscent: ['eva'],
  tearfullook: ['atk', 'spa'], tickle: ['atk', 'def'], tailwhip: ['def'], tarshot: ['spe'],
};

const PURE_TARGET_STAGE_BOOSTS: Record<string, readonly string[]> = {
  aromaticmist: ['spd'],
};

export const PURE_TARGET_STAGE_RESET_MOVE_IDS = new Set(['haze', 'topsyturvy']);

export const MIXED_TARGET_STAGE_MOVE_IDS = new Set(['spicyextract']);

export const PURE_TARGET_STAGE_DROP_IDS = new Set(Object.keys(PURE_TARGET_STAGE_DROPS));
export const PURE_TARGET_STAGE_BOOST_IDS = new Set(Object.keys(PURE_TARGET_STAGE_BOOSTS));

export function hasTargetStageEffect(boosts: Partial<Record<string, number>> | undefined, id: string): boolean {
  const stats = PURE_TARGET_STAGE_DROPS[id];
  return !stats || stats.some(stat => (boosts?.[stat] || 0) > -6);
}

export function hasTargetStageBoostEffect(
  boosts: Partial<Record<string, number>> | undefined,
  id: string,
): boolean {
  const stats = PURE_TARGET_STAGE_BOOSTS[id];
  return !stats || stats.some(stat => (boosts?.[stat] || 0) < 6);
}

export function hasTargetStageResetEffect(
  boosts: Partial<Record<string, number>> | undefined,
  id: string,
): boolean {
  if (!PURE_TARGET_STAGE_RESET_MOVE_IDS.has(id)) return true;
  return ['atk', 'def', 'spa', 'spd', 'spe', 'acc', 'eva'].some(stat => (boosts?.[stat] || 0) !== 0);
}

export function hasMixedTargetStageEffect(
  boosts: Partial<Record<string, number>> | undefined,
  id: string,
): boolean {
  if (id !== 'spicyextract') return true;
  return (boosts?.atk || 0) < 6 || (boosts?.def || 0) > -6;
}
