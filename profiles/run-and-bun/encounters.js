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
/**
 * Trainers the run map does not cover at all.
 *
 * The run map holds the mandatory progression: gyms, the Elite Four, rivals
 * (all three starter variants at each of three locations), admins and leaders.
 * It does NOT hold every optional trainer.
 *
 * Compared against an independent community transcription of the Run & Bun
 * trainer-battle document, roughly 69 trainers appear there with no counterpart
 * anywhere in this data — about 189 party members. The pattern is unambiguous:
 * 39 are Swimmers, and the rest are Sailors, Fishermen, Tubers, Triathletes and
 * similar route filler, almost all fielding two or three Pokemon. These are the
 * avoidable water-route encounters, not story battles.
 *
 * Where the two sources DO overlap the data agrees closely: 221 of the 222
 * trainers matched by name have identical party sizes, and 246 of our 362
 * battles match a dump party exactly on species and level. The gap is coverage,
 * not correctness.
 *
 * The counts are approximate on purpose. The dump uses a `~` continuation
 * marker inside long parties and names double-battle partners inside brackets,
 * so any automated count of it carries parse error. Treat these as the shape of
 * the gap, not a precise inventory.
 *
 * Not filled from that dump: it is a community transcription, and this project
 * does not take community sources as authoritative for values. Recorded so a
 * consumer knows the run map is a progression spine rather than a complete
 * trainer census — a planner built on it should not claim to cover every battle
 * a player can pick.
 */
const COVERAGE = {
	coversMandatoryProgression: true,
	completeTrainerCensus: false,
	approximateTrainersAbsent: 69,
	approximatePartyMembersAbsent: 189,
	absentKind: 'optional route trainers, overwhelmingly Swimmers and other water-route filler',
	comparedAgainst: 'community transcription of the Run & Bun trainer-battle document',
};

const KNOWN_GAPS = {
	indices: [789, 790],
	trainer: 'Bug Maniac Jeffrey',
	note: 'two of three Vivillon lost to a [species][label] key collision',
};

/**
 * Which battles are story milestones, as a filter over trainer names.
 *
 * This is a VIEW, not a value claim: it asserts nothing about the game beyond
 * the naming convention the run map already uses ("Leader Brawly", "Elite Four
 * Sidney"). A consumer walking all 362 battles gets a wall of route filler; a
 * consumer walking the milestones gets the shape of a playthrough.
 *
 * Kept in the profile rather than in the tool that uses it because the
 * convention is the game's, not the tool's — another game names its majors
 * differently and declares its own pattern here.
 *
 * `Double` variants of Elite Four members are the same trainer fought a second
 * time in the double-battle branch, so they are milestones too.
 */
const MILESTONE_PATTERN =
	/^(Leader |Elite Four |Champion |Trainer Rival |Aqua Leader |Magma Leader |Trainer Wally VR|Trainer Steven )/;

module.exports = {GLOBAL, SOURCE, INVARIANTS, KNOWN_GAPS, COVERAGE, MILESTONE_PATTERN};
