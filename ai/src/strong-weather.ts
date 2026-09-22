import {BattleState} from './model';

// Its own module so that entry-hazards can settle a strong weather before it
// judges an entry setter, without an import cycle through transition.

/**
 * A strong weather is PERMANENT in Run & Bun, like every weather an ability
 * sets: "Weather abilities: Will set Weather permanently." (the hack's
 * Mechanic Changes.txt; the operator, 2026-09-22). Primordial Sea, Desolate
 * Land and Delta Stream are weather abilities, so the heavy rain stays when
 * Primal Kyogre faints or leaves — Wallace's Swift Swim Barraskewda and Mega
 * Swampert, sent in behind it, fight IN it.
 *
 * On 2026-09-22 this first ended a strong weather when no holder stood, which
 * is the mainline rule, applied to a hack that changed it. The function stays
 * as the one place the rule is stated, and every caller still passes through
 * it, so a ROM probe that finds otherwise changes one function. The weather it
 * keeps still blocks an ordinary setter (entry-hazards): the document does not
 * change that, and pokemon-mono's P3 probe measures it.
 */
export function settleStrongWeather(state: BattleState): BattleState {
  return state;
}
