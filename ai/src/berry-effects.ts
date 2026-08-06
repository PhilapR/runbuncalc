import {PokemonState, StatBoosts, StatusName} from './model';

const CONFUSION_BERRY_MINUS_STAT: Record<string, keyof StatBoosts> = {
  aguavberry: 'spd',
  figyberry: 'atk',
  iapapaberry: 'def',
  magoberry: 'spa',
  wikiberry: 'spe',
};

const NATURE_MINUS_STAT: Record<string, keyof StatBoosts> = {
  lonely: 'def', brave: 'spe', adamant: 'spa', naughty: 'spd',
  bold: 'atk', relaxed: 'spe', impish: 'spa', lax: 'spd',
  timid: 'atk', hasty: 'def', jolly: 'spa', naive: 'spd',
  modest: 'atk', mild: 'def', quiet: 'spe', rash: 'spd',
  calm: 'atk', gentle: 'def', sassy: 'spe', careful: 'spa',
};

function id(name: string | undefined): string {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Whether a flavor-dependent Berry confuses this holder's known nature. */
export function confusionBerryDislikesNature(pokemon: PokemonState, berry: string | undefined): boolean {
  const berryMinusStat = CONFUSION_BERRY_MINUS_STAT[id(berry)];
  return berryMinusStat !== undefined && NATURE_MINUS_STAT[id(pokemon.nature)] === berryMinusStat;
}

/** Whether a status-curing Berry removes this major status when eaten. */
export function statusBerryCures(item: string | undefined, status: StatusName | ''): boolean {
  const itemId = id(item);
  if (!status) return false;
  if (itemId === 'lumberry') return true;
  if (itemId === 'cheriberry') return status === 'par';
  if (itemId === 'chestoberry') return status === 'slp';
  if (itemId === 'pechaberry') return status === 'psn' || status === 'tox';
  if (itemId === 'rawstberry') return status === 'brn';
  if (itemId === 'aspearberry') return status === 'frz';
  return false;
}
