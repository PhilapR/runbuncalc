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
 * One absence is NOT route filler and is left explicitly unresolved: vanilla
 * Emerald's mandatory pre-Wattson Wally fight and the early rival fights before
 * Cycling Road have no counterpart anywhere in this map — the only Wally here is
 * Victory Road, and the earliest rival is Cycling Road. Whether Run & Bun cut
 * them or whether they were lost on the way into this data cannot be settled
 * from the decomp, which carries no trainer parties at all. Recorded as unknown
 * rather than asserted either way, because "dekzeh removed them" and "we lost
 * them" are different claims and nothing available distinguishes the two.
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
	// Not filler, and not decidable: vanilla's mandatory pre-Wattson Wally and the
	// early rival fights are absent, and the decomp has no trainer data to say
	// whether the hack cut them or this data lost them.
	earlyStoryFightsUnverified: ['pre-Wattson Wally', 'early rival fights'],
};

const KNOWN_GAPS = {
	indices: [789, 790],
	trainer: 'Bug Maniac Jeffrey',
	note: 'two of three Vivillon lost to a [species][label] key collision',
};

/**
 * Boss tiers, as filters over trainer names.
 *
 * These are VIEWS, not value claims: they assert nothing about the game beyond
 * the naming convention the run map already uses ("Leader Brawly", "Team Aqua
 * Grunt Petalburg Woods"). Kept in the profile rather than in the tools that
 * use them because the convention is the game's, not the tool's — another game
 * names its majors differently and declares its own patterns here.
 *
 * Three tiers, because they answer three different questions:
 *
 *   BOSS_PATTERN         split-enders: badges, the Elite Four gauntlet, the
 *                        Champion. A run is narrated in these — "the Brawly
 *                        split" is everything up to and including #77.
 *   STORY_BOSS_PATTERN   the mini-bosses: rivals, the seven Aqua/Magma ADMIN
 *                        battles (Tabitha x3, Shelly x2, Matt, Courtney),
 *                        Archie, Maxie, Wally, Steven, both Chelle fights and
 *                        Dumbass Soupercell — plus the two standalone grunt
 *                        fights that ARE walls in their own right, Petalburg
 *                        Woods and the Museum pair. Together with bosses these
 *                        SET THE LEVEL CAP: the cap is the ace of the next
 *                        fight in either tier, so a fresh run is capped at 12
 *                        by the Petalburg Woods grunt's Croagunk, not at 21 by
 *                        Brawly two story fights later.
 *
 *                        Chelle follows the same Name+Location convention the
 *                        admins do, and her two fights slot monotonically into
 *                        the cap walk (Roxanne 25 → Chelle 32 → Wattson 35;
 *                        Archie 77 → Chelle 77 → Tabitha 79) — a wall between
 *                        badges, not filler between them. Dumbass Soupercell
 *                        is a one-off trainer fielding a full L100 party as
 *                        the Victory Road capstone; it moves no cap (Sidney
 *                        aces 100 too) but a run is narrated through it.
 *
 *                        GAUNTLET grunts are deliberately NOT here. The
 *                        Weather Institute, Mt Chimney, Mt Pyre, both
 *                        hideouts, the Space Center and the Seafloor Cavern
 *                        are corridors of grunts ending at an admin or a team
 *                        leader — the road TO the boss, not bosses. The cap
 *                        through a gauntlet is the ace at the end of it
 *                        (Shelly's 65 through the Weather Institute, Tabitha
 *                        and Maxie closing Mt Chimney), which falls out of the
 *                        tiering with no per-grunt caps. The Space Center is
 *                        the one corridor that does not read cleanly: it has
 *                        no grunt #4 label, and Courtney sits mid-corridor
 *                        with grunts still after her rather than at its end.
 *   MILESTONE_PATTERN    the narrative spine: bosses plus the NAMED story
 *                        bosses — rivals, admins, team leaders, Wally, Steven,
 *                        Chelle, Soupercell. 44 ticks. Grunt fights are story
 *                        but not landmarks, even the two that set caps.
 *
 * `Double` variants of Elite Four members are the same trainer fought a second
 * time in the double-battle branch, so they are bosses too. One admin battle
 * is keyed "Aqua Admin ShellySeafloorCavern" with no space before the
 * location — the patterns anchor on "Aqua Admin " and survive it.
 */
const BOSS_PATTERN = /^(Leader |Elite Four |Champion )/;

/**
 * Rival battles come in three variants per location, named for the RIVAL'S ace
 * — which one a run actually faces is fixed by the player's starter choice at
 * the top of the game. The three variants of one location are the SAME story
 * event: dekzeh balanced them to identical ace levels (38/38/38 at Cycling
 * Road, 66x3 at the Bridge, 73x3 at Lilycove), so the level cap is indifferent
 * to the choice — but a run fights exactly one of each triplet, and a model
 * that counts all nine is describing three playthroughs at once.
 *
 * The Elite Four `Double` battles are NOT variants of this kind: Phoebe and
 * PhoebeDouble field different parties (Crobat lead vs Decidueye-Hisui lead)
 * and both are fought. They stay real.
 */
const RIVAL_VARIANT_PATTERN = /^Trainer Rival .* (Sceptile|Blaziken|Swampert)$/;

/**
 * The rival aces a run may declare — the same three the pattern above matches,
 * stated as data so the run layer validates against the PROFILE's list rather
 * than a copy of it. Another game's profile declares its own, or none.
 */
const RIVAL_ACES = ['Sceptile', 'Blaziken', 'Swampert'];

/**
 * What the game starts YOU with — the Sinnoh trio, not the Hoenn one.
 *
 * Run & Bun replaces the player's starter choice while leaving the rival's
 * teams hand-built around the Hoenn line, so RIVAL_ACES above stays as it is:
 * these two lists are deliberately from different generations and neither is
 * a copy of the other.
 *
 * `beats` is the rival ace this pick is strong into, which is how the game
 * decides what the rival takes — you pick Grass, they take the Water one.
 * That relationship is by TYPE, so it survives the species change untouched.
 *
 * Stated as data because it was hardcoded in src/index.template.html and
 * nowhere else. Nothing could validate it, and that is exactly how it sat
 * wrong: `node scripts/ask.js starters` reported NOT MODELLED, and the
 * disagreement about which trio this game uses was only possible because no
 * file said so.
 */
const STARTERS = [
	{species: 'Turtwig', type: 'grass', beats: 'Swampert'},
	{species: 'Chimchar', type: 'fire', beats: 'Sceptile'},
	{species: 'Piplup', type: 'water', beats: 'Blaziken'},
];

/**
 * Two story fights carry no team or title prefix to anchor on, so they are named
 * outright. "Trainer Chelle " matches her two fights and nothing else — the only
 * other Chelle-ish label is "Cool Trainer Michelle", which the anchor rules out.
 */
const STORY_BOSS_PATTERN =
	/^(Trainer Rival |Aqua Admin |Magma Admin |Aqua Leader |Magma Leader |Trainer Wally VR|Trainer Steven |Trainer Chelle |Dumbass Soupercell$|Team Aqua Grunt (Petalburg Woods|Museum))/;

const MILESTONE_PATTERN =
	/^(Leader |Elite Four |Champion |Trainer Rival |Aqua Admin |Magma Admin |Aqua Leader |Magma Leader |Trainer Wally VR|Trainer Steven |Trainer Chelle |Dumbass Soupercell$)/;

/**
 * The AUTHORED level-cap ladder — transcribed row for row from the game's own
 * `Mechanic Changes.txt` ("Level Cap" section, 23 rows), NOT derived.
 *
 * Deriving each cap as "the next boss's ace level" was wrong on ten rows:
 * the authored cap is usually one below the ace (Flannery's ace is 58, her
 * cap is 57; Wallace's ace is 100, the final cap is 99), the Museum grunts
 * cap at 17 not their ace's 16, the Fallarbor Vito rung (48) has no badge to
 * hang on, and derivation invented rungs at mini-bosses (Chelle at Mt Pyre,
 * Maxie at the Space Center) that the game does not lift the cap for.
 *
 * `order` is the fight whose DEFEAT lifts the cap — every fight at or below
 * it plays under `cap`. Rival rows carry the triplet's PREFIX and its last
 * variant's order, so the boundary holds whichever rival a run declares.
 */
const LEVEL_CAPS = [
	{trainer: 'Team Aqua Grunt Petalburg Woods', order: 19, cap: 12},
	{trainer: 'Team Aqua Grunt Museum #2', order: 56, cap: 17},
	{trainer: 'Leader Brawly', order: 77, cap: 21},
	{trainer: 'Leader Roxanne', order: 139, cap: 25},
	{trainer: 'Trainer Chelle Daycare', order: 181, cap: 32},
	{trainer: 'Leader Wattson', order: 224, cap: 35},
	{trainer: 'Trainer Rival Cycling Road', order: 265, cap: 38},
	{trainer: 'Leader Norman', order: 337, cap: 42},
	{trainer: 'Winstrate Vito Fallarbor', order: 434, cap: 48},
	{trainer: 'Magma Leader Maxie Mt Chimney', order: 519, cap: 54},
	{trainer: 'Leader Flannery', order: 571, cap: 57},
	{trainer: 'Aqua Admin Shelly Weather Institute', order: 696, cap: 65},
	{trainer: 'Trainer Rival Bridge', order: 714, cap: 66},
	{trainer: 'Leader Winona', order: 758, cap: 69},
	{trainer: 'Trainer Rival Lilycove', order: 855, cap: 73},
	{trainer: 'Aqua Leader Archie Mt Pyre', order: 927, cap: 76},
	{trainer: 'Magma Leader Maxie Magma Hideout', order: 1009, cap: 79},
	{trainer: 'Aqua Admin Matt Aqua Hideout', order: 1056, cap: 81},
	{trainer: 'Leader Liza', order: 1130, cap: 85},
	{trainer: 'Aqua Leader Archie Seafloor Cavern', order: 1247, cap: 89},
	{trainer: 'Leader Juan', order: 1364, cap: 91},
	{trainer: 'Winstrate Vito VR', order: 1454, cap: 95},
	{trainer: 'Champion Wallace', order: 1620, cap: 99},
];

module.exports = {
	GLOBAL, SOURCE, INVARIANTS, KNOWN_GAPS, COVERAGE,
	BOSS_PATTERN, STORY_BOSS_PATTERN, MILESTONE_PATTERN, RIVAL_VARIANT_PATTERN, RIVAL_ACES, STARTERS,
	LEVEL_CAPS,
};
