/* eslint-env node, es6 */
'use strict';

/**
 * Run & Bun — encounter layer (L4).
 *
 * The authored trainer parties are the run map: who you fight, with what, and
 * in what order. They exist in no upstream source and can be reconstructed from
 * nothing, which makes them the most irreplaceable data in the project.
 *
 * The parties themselves stay in `src/js/data/sets/gen8.js`, because the browser
 * loads that file directly as a classic script defining `SETDEX_SS`. This module
 * declares their SHAPE and INVARIANTS so the profile can describe the run map
 * without duplicating ~288KB of party data into a second source of truth.
 *
 * Structure of the underlying data:
 *
 *   SETDEX_SS[speciesName][label] = {level, ability, moves, nature, item, index, ...}
 *
 * `label` is normally the trainer's name. A party may hold more than one of the
 * same species, and those entries need distinct keys, so a duplicate carries an
 * explicit `trainer` naming the trainer it belongs to and a `copy` ordinal.
 * Consumers must group on `entry.trainer || label` and must never parse the key.
 *
 * This replaced an earlier convention where duplicates were keyed by prefixing
 * the trainer name with spaces (" Fisherman Phil"). Whitespace carried meaning,
 * nothing declared it, and `getTrainerOrder` grouped on the raw key — so the
 * Trainer Wheel produced 365 navigation stops for 362 trainers and "next"
 * re-rendered an identical party before advancing.
 */

/** Global name of the browser script's trainer party table. */
const GLOBAL = 'SETDEX_SS';

/** Path to the authored party data, relative to the repository root. */
const SOURCE = 'src/js/data/sets/gen8.js';

/**
 * Invariants the run map must satisfy. Asserted by `runbun_sets.test.js`.
 *
 * `index` is not a per-party slot number: it is one global sequence encoding
 * authored playthrough order across every trainer, and it is the sole ordering
 * key for Trainer Wheel navigation. Because it is a progression ordering, it is
 * also what lets a consumer ask "where am I in the run" — the basis for the
 * planner layer.
 */
const INVARIANTS = {
	/** Distinct trainers, grouping duplicate-species entries by `trainer`. */
	trainerCount: 362,
	/** Raw entry keys, which exceed trainerCount by the number of duplicates. */
	labelCount: 365,
	/** Entries carrying an explicit `trainer` because they are extra copies. */
	duplicateEntries: 3,
	/** The progression sequence starts here. */
	indexMin: 0,
	/** Every index is globally unique across all trainers. */
	indexUnique: true,
};

module.exports = {GLOBAL, SOURCE, INVARIANTS};
