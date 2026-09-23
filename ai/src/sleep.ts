import {PokemonState} from './model';

/**
 * Sleep, in the one place that decides what a sleeping Pokemon may do.
 *
 * The counter burns on the ACTION ATTEMPT, matching Showdown's
 * `slp.onBeforeMove` — a counter of N means N-1 missed turns, and the Nth
 * attempt is the one that wakes the sleeper. That makes `statusTurns === 0`
 * unreachable, which is what three separate legality gates were still
 * testing for: they let Sleep Talk and Snore execute on the way out of
 * sleep, one free turn per sleep cycle for every Rest staller.
 *
 * This module exists so the rule has ONE home. The gates live in
 * move-engine, actions and call-legality, and three hand-kept copies of a
 * predicate is how they drifted apart in the first place.
 */

/** The attempt that ends the sleep. The sleeper wakes and does nothing. */
export function wakesOnThisAttempt(actor: PokemonState): boolean {
  // An undefined counter means the caller is not tracking sleep length —
  // hand-built states do this. Treat it as "still asleep" rather than
  // inventing a wake, which is what the old `=== 0` test effectively did.
  return actor.status === 'slp' &&
    actor.statusTurns !== undefined && actor.statusTurns <= 1;
}

/**
 * May this actor use a move that REQUIRES being asleep (Sleep Talk, Snore)?
 * Mainline gates both on `source.status === 'slp'` in their onTry, which runs
 * after the wake, so the waking attempt fails them.
 */
export function canUseSleepOnlyMove(actor: PokemonState): boolean {
  return actor.status === 'slp' && !wakesOnThisAttempt(actor);
}
