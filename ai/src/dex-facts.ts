import * as Calc from '@smogon/calc';

/**
 * Immutable dex facts about a move, read without building a Move to read them.
 *
 * A twelve-rollout adjudication constructed 66,768 calculator objects, about
 * 220 a turn, and a profile put ~18% of its time in construction and cloning
 * rather than in calculation. Most of that was this shape: a whole `Calc.Move`
 * built to read one field of a dex entry, then thrown away. The three largest
 * were 24,480 asking `flags?.sound`, 6,864 asking `target`, and 6,360 asking
 * only whether `flags` was defined at all.
 *
 * None of them depend on the battle. They are properties of the dex entry for
 * a (generation, move) pair, so they cache exactly the way `getMoveMetadata`
 * already caches its own lookup.
 *
 * Two rules keep the cache honest:
 *
 *   - the key carries the GENERATION. Bite is Special in Generation 3 and
 *     Physical in 8 — the same move with a different answer — so a name-only
 *     key would serve whichever generation asked first. That is the bug a
 *     cache introduces, and a suite of single-generation fixtures never sees
 *     it. `tests/adjudication_cost.test.js` pins it.
 *   - PRIMITIVES are returned, never the Move. A shared mutable calculator
 *     object escaping into a caller that mutates it is a different and much
 *     worse bug than a slow one.
 *
 * This module deliberately imports nothing but the calculator: `calc-adapter`
 * imports `actions`, so anything both of them use has to sit below both.
 */

export interface BareMoveFacts {
  category: Calc.Move['category'];
  target: Calc.Move['target'];
  sound: boolean;
  hasFlags: boolean;
}

const BARE_MOVE_FACTS = new Map<string, BareMoveFacts>();

/**
 * Throws exactly as `new Calc.Move` does for a name the calculator does not
 * carry — callers already catch that and fall back to the metadata boundary,
 * and a failure is never cached.
 */
export function bareMoveFacts(
  gen: ReturnType<typeof Calc.Generations.get>,
  moveName: string,
): BareMoveFacts {
  const key = `${gen.num}|${moveName}`;
  const cached = BARE_MOVE_FACTS.get(key);
  if (cached) return cached;
  const move = new Calc.Move(gen, moveName);
  const facts: BareMoveFacts = {
    category: move.category,
    target: move.target,
    sound: !!move.flags?.sound,
    hasFlags: move.flags !== undefined,
  };
  BARE_MOVE_FACTS.set(key, facts);
  return facts;
}
