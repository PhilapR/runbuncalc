const PURE_SELF_STAGE_STATS: Record<string, readonly string[]> = {
  acidarmor: ['def'], agility: ['spe'], amnesia: ['spd'], autotomize: ['spe'], barrier: ['def'],
  bulkup: ['atk', 'def'], calmmind: ['spa', 'spd'], coil: ['atk', 'def', 'acc'], cosmicpower: ['def', 'spd'],
  cottonguard: ['def'], defensecurl: ['def'], doubleteam: ['eva'], dragondance: ['atk', 'spe'],
  growth: ['atk', 'spa'], harden: ['def'], irondefense: ['def'], minimize: ['eva'],
  nastyplot: ['spa'], quiverdance: ['spa', 'spd', 'spe'], rockpolish: ['spe'], shiftgear: ['atk', 'spe'],
  sharpen: ['atk'], honeclaws: ['atk', 'acc'], swordsdance: ['atk'], tailglow: ['spa'], victorydance: ['atk', 'def', 'spe'],
  withdraw: ['def'], workup: ['atk', 'spa'], shelter: ['def'], takeheart: ['spa', 'spd'],
  defendorder: ['def', 'spd'], extremeevoboost: ['atk', 'def', 'spa', 'spd', 'spe'], geomancy: ['spa', 'spd', 'spe'],
};

export const PURE_SELF_STAGE_MOVE_IDS = new Set(Object.keys(PURE_SELF_STAGE_STATS));

export function hasSelfStageEffect(boosts: Partial<Record<string, number>> | undefined, id: string): boolean {
  const stats = PURE_SELF_STAGE_STATS[id];
  return !stats || stats.some(stat => (boosts?.[stat] || 0) < 6);
}
