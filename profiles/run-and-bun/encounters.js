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
	/**
	 * Battles, not trainers.
	 *
	 * Each entry is keyed by a battle label. 46 of those labels are double
	 * battles naming two trainers at once ("Cool Trainer Hope & Albert"), so the
	 * number of human trainers is materially higher than the number of battles:
	 * 316 solo + 46 paired = 408 trainer slots, of which four are Elite Four
	 * double-battle variants duplicating a trainer who also appears alone,
	 * giving roughly 404 distinct trainers.
	 *
	 * This was previously named `trainerCount`, which was wrong and understated
	 * the roster by about a sixth.
	 */
	battleCount: 362,
	/** Battle labels naming two trainers at once. */
	pairedBattles: 46,
	/** Solo + (paired x 2). Not the distinct-trainer count; see above. */
	trainerSlots: 408,
	/** Raw entry keys, which exceed battleCount by the number of duplicates. */
	labelCount: 365,
	/** Entries carrying an explicit `trainer` because they are extra copies. */
	duplicateEntries: 3,
	/** The progression sequence starts here. */
	indexMin: 0,
	/** Every index is globally unique across all trainers. */
	indexUnique: true,
};

/**
 * Party members known to be missing from the run map.
 *
 * The progression sequence is otherwise dense, so a gap is evidence of loss
 * rather than of a deliberately sparse numbering. These two indices sit
 * immediately before Bug Maniac Jeffrey's surviving Vivillon at 791.
 *
 * Jeffrey fields three Vivillon. Because entries are keyed [species][label],
 * three of one species under one trainer collide, and only the last survived —
 * the same collision the space-prefix hack worked around for Fisherman Phil and
 * Fisherman Darian, which nobody applied here. The explicit `trainer`/`copy`
 * shape now used for duplicates is what these entries need in order to be
 * restored.
 *
 * They are declared rather than quietly tolerated so the density check cannot
 * report a complete run map while two party members are absent.
 */
const KNOWN_GAPS = {
	indices: [789, 790],
	trainer: 'Bug Maniac Jeffrey',
	note: 'two of three Vivillon lost to a [species][label] key collision',
};

module.exports = {GLOBAL, SOURCE, INVARIANTS, KNOWN_GAPS};
