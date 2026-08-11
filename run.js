/* eslint-env node, es6 */
'use strict';

/**
 * The run (L6) — a playthrough as a document.
 *
 * Everything below this layer answers a question about a POSITION: how hard does
 * this hit, what will the opponent do, how does a team fare across a stretch of
 * the map. None of them remember anything. A player mid-run does not have a
 * position, they have a save file: a box of Pokemon caught in particular places,
 * a party picked out of it, some items, and a point in the story they have
 * reached.
 *
 * This module is that save file, and the rules for changing it.
 *
 * DESIGN
 *
 * A run is plain JSON. No classes, no methods on the data, nothing that does not
 * survive `JSON.stringify` — the same document has to live in a file, in
 * `localStorage` and in an HTTP body, and anything clever would only survive one
 * of those.
 *
 * Every change goes through `apply(run, command)`, which returns a NEW run and
 * never mutates the old one. That is what makes undo a one-liner and what lets
 * the UI show a change before committing it. The command list is deliberately
 * small and concrete — `catch`, `evolve`, `teach`, `levelUp`, `give`, `take`,
 * `heartScale`, `party`, `beat`, `faint`, `release` — because a playthrough really is that
 * short a list of verbs, and a generic "edit this field" command would give up
 * every check below.
 *
 * WHAT IS CHECKED, AND WHAT IS NOT
 *
 * The oracle makes most of this verifiable rather than trusted, and the
 * difference between the two shows up as an error message rather than a
 * plausible-looking box:
 *
 *   catch    the species must actually appear on that map, by that method, and
 *            the level must be inside the slot's range
 *   evolve   the target must be a real evolution, and a level evolution must
 *            have the level
 *   teach    the move must be legal for the species by level-up, TM, tutor or
 *            an egg move inherited down the line
 *   levelUp  respects the level cap when the run declares one
 *
 * The two scarce items are checked the same way, because in this game they are
 * rules rather than inventory: levels over the cap cost Rare Candy from the
 * bag, and a Heart Scale sets exactly one IV to 31 and is gone.
 *
 * A catch with no map is still allowed, and that is not laziness: starters,
 * gifts, statics and trades are scripted events with no wild table anywhere in
 * the decomp, so refusing them would refuse half of a real box. Such a catch is
 * recorded as `origin.method: 'declared'`, so a consumer can tell a checked
 * entry from an asserted one.
 *
 * WHAT IS NOT MODELLED, on purpose:
 *
 *   - EXP and level-up pacing. The game's growth rates are not imported and
 *     guessing them would produce a confident wrong answer. A player states the
 *     level they reached; the run records it.
 *   - Item locations and Mart stock. The bag counts what a player says they
 *     have. Nothing claims where it came from.
 *   - Battle outcome. `beat` records that a fight happened, it does not simulate
 *     it. The planner is for deciding whether it will go well.
 */

const getProfile = require('./profiles').getProfile;

/** Document format. Bumped when a stored run would need migrating. */
const VERSION = 1;

/** A party is six, and the box is everything else. */
const PARTY_LIMIT = 6;

/**
 * Level caps.
 *
 * Run & Bun's caps are HARDCODED IN THE GAME: EXP-based play stops at the cap,
 * an infinite Rare Candy levels anything straight to it (so the whole box is
 * always playable at cap, grind-free), and the only way past it is spending
 * the limited Rare Candies found through the game. The cap is a mechanic, not
 * a player convention — which is why it is on by default here and 'none' is
 * the escape hatch, not the other way round.
 *
 * `next-milestone-ace` is the stored mode name for how the VALUES are
 * obtained: the published decomp carries no cap table, so the caps are derived
 * as the ace of the next boss-tier fight — a derivation that reproduces the
 * game's known caps (12, 16, 21, 25...). If the hardcoded table ever surfaces,
 * it becomes an import and this derivation becomes a cross-check.
 *
 * Going OVER the cap consumes Rare Candy from the bag, one per level above
 * it — the same economy the game runs. A soft-cap game (overlevel freely, or
 * EXP keeps flowing) should arrive as a NEW mode; the modes are the
 * portability seam.
 */
const LEVEL_CAP_MODES = new Set(['none', 'next-milestone-ace']);

/**
 * The IV keys the box stores, with the names a log line wants.
 *
 * These are the calculator's own spat keys, so an IV set here reaches the
 * planner without a translation table in between — the reason the box picked
 * them in the first place.
 */
const IV_STATS = {
	hp: 'HP', atk: 'Attack', def: 'Defense',
	spa: 'Sp. Atk', spd: 'Sp. Def', spe: 'Speed',
};

/**
 * Heart Scales are the game's IV economy: one scale sets ONE IV to 31, they
 * are found rather than sold, and nothing refunds them. Named once because
 * the bag key, the refusal and the advisor all have to agree on the spelling.
 */
const HEART_SCALE = 'Heart Scale';

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

/**
 * Create an empty run.
 *
 * `now` is passed in rather than read from the clock. A module that stamps its
 * own timestamps cannot be tested for equality and cannot be replayed, and this
 * document's whole value is that applying the same commands gives the same run.
 */
const DUPES_MODES = new Set(['off', 'species', 'line', 'forms']);

function dupesMode(opts) {
	if (opts.dupesClause === undefined) return opts.permadeath ? 'line' : 'off';
	if (!DUPES_MODES.has(opts.dupesClause)) {
		throw new Error(`unknown dupes clause ${JSON.stringify(opts.dupesClause)}; ` +
			`the modes are: ${[...DUPES_MODES].join(', ')}`);
	}
	return opts.dupesClause;
}

/**
 * The encounter rules in force, normalized. Saves written before the rules
 * became individual toggles carry only `permadeath`; they keep the behavior
 * they were played under — the bundle — rather than silently losing it.
 */
function encounterRules(run) {
	const rules = run.rules;
	// A stored mode nobody defined is refused, not quietly played as 'line':
	// the server accepts arbitrary run JSON, and a corrupted or future-vintage
	// save silently enforcing rules the player never chose is the exact class
	// of bug the toggles exist to prevent.
	if (rules.dupesClause !== undefined && !DUPES_MODES.has(rules.dupesClause)) {
		throw new Error(`unknown dupes clause ${JSON.stringify(rules.dupesClause)} ` +
			`stored in this run's rules; the modes are: ${[...DUPES_MODES].join(', ')}`);
	}
	return {
		onePerRoute: rules.onePerRoute !== undefined ?
			!!rules.onePerRoute : !!rules.permadeath,
		dupes: rules.dupesClause !== undefined ?
			rules.dupesClause : rules.permadeath ? 'line' : 'off',
		shiny: rules.shinyClause !== undefined ?
			!!rules.shinyClause : !!rules.permadeath,
	};
}

function createRun(options) {
	const opts = options || {};
	const profileId = opts.profileId || undefined;
	const profile = getProfile(profileId);
	const mode = opts.levelCap || 'next-milestone-ace';
	if (!LEVEL_CAP_MODES.has(mode)) {
		throw new Error(`unknown level cap mode ${JSON.stringify(mode)}`);
	}
	// The rival list is the PROFILE's, not this module's: isExcludedVariant
	// already reads the variant pattern from the profile, and a hardcoded list
	// here was the half of the concept the engine still owned.
	if (opts.rival !== undefined && opts.rival !== null) {
		const aces = (profile.encounters && profile.encounters.RIVAL_ACES) || null;
		if (!aces) {
			throw new Error(`profile '${profile.id}' declares no rivals; ` +
				'a rival cannot be named for this game');
		}
		if (!aces.includes(opts.rival)) {
			throw new Error(`unknown rival ${JSON.stringify(opts.rival)}; ` +
				`the rival is named for their ace: ${aces.join(', ')}`);
		}
	}
	return {
		version: VERSION,
		profileId: profile.id,
		name: opts.name || 'Untitled run',
		createdAt: opts.now || null,
		updatedAt: opts.now || null,
		// Progression index of the last battle beaten. -1 is "nothing yet", which
		// has to be distinguishable from 0 — the first fight in the map is index 0.
		position: -1,
		rules: {
			levelCap: mode,
			// Permadeath: a fainted Pokemon can never re-enter the party. Also
			// the nuzlocke PRESET: the three encounter toggles below default to
			// match it, because that is the common table — but each stands alone
			// once stated, because nuzlocke tables vary rule by rule.
			permadeath: !!opts.permadeath,
			// One wild catch per map for the whole run. The encounter is random;
			// the player reports what came up.
			onePerRoute: opts.onePerRoute !== undefined ?
				!!opts.onePerRoute : !!opts.permadeath,
			// What counts as a dupe: 'off', 'species' (the exact species only),
			// 'line' (the game's own evolution graph — regionals separate unless
			// this hack connects them, which it does for Grimer/Muk-Alola and
			// Basculin/Basculegion), or 'forms' (line plus every regional form
			// of it — the strictest common table rule).
			dupesClause: dupesMode(opts),
			// A naturally-encountered shiny is keepable over both rules above.
			shinyClause: opts.shinyClause !== undefined ?
				!!opts.shinyClause : !!opts.permadeath,
			// Which rival variant this run faces — fixed by the starter choice at
			// the top of the game. Null means undeclared: all variants stay
			// visible, which is honest but counts three playthroughs at once.
			rival: opts.rival || null,
		},
		nextId: 1,
		box: [],
		party: [],
		bag: {},
		log: [],
	};
}

// ------------------------------------------------------------------- accessors

function findMon(run, id) {
	return run.box.find(mon => mon.id === id) || null;
}

function requireMon(run, id) {
	const mon = findMon(run, id);
	if (!mon) {
		const known = run.box.map(m => `${m.id} (${m.species})`).slice(0, 8).join(', ');
		throw new Error(`no Pokemon with id ${JSON.stringify(id)}` +
			(known ? `; the box holds: ${known}` : '; the box is empty'));
	}
	return mon;
}

/**
 * Is this fight a rival variant this run can never face?
 *
 * The three variants of a rival location are one story event; a run that has
 * declared its rival faces exactly one of them. A run that has not declared
 * one sees all three — honest, but a count of three playthroughs at once.
 */
function isExcludedVariant(run, trainer) {
	if (!run.rules.rival) return false;
	const encounters = getProfile(run.profileId).encounters;
	const pattern = encounters && encounters.RIVAL_VARIANT_PATTERN;
	if (!pattern) return false;
	const match = pattern.exec(trainer);
	return !!match && match[1] !== run.rules.rival;
}

/**
 * The run map as THIS run experiences it: rival variants the declared starter
 * choice rules out are not fights, and every view below — upcoming, caps,
 * milestones, the planner — reads through this one choke point.
 */
function visibleFights(run) {
	// No encounters layer means no run map: the fight views (upcoming, splits,
	// milestones, caps) all answer empty rather than throwing, because a
	// data-only profile still has a box worth keeping.
	if (!getProfile(run.profileId).encounters) return [];
	return require('./planner').loadRunMap(run.profileId)
		.filter(fight => !isExcludedVariant(run, fight.trainer));
}

/**
 * Which boss tier a fight belongs to, per the profile's declared patterns.
 *
 * 'boss' ends a split; 'story' is a mandatory fight inside one. Both set the
 * level cap. Null is route filler. Falls back to the milestone pattern for a
 * profile that has not declared tiers, so a second game degrades gracefully
 * rather than losing its cap.
 */
function fightTier(profile, trainer) {
	// A profile with no encounters layer has no tiers; every fight is filler.
	// Views degrade to empty rather than TypeError — a data-only profile is a
	// legitimate profile, and `summarize` must survive it.
	if (!profile.encounters) return null;
	const boss = profile.encounters.BOSS_PATTERN;
	const story = profile.encounters.STORY_BOSS_PATTERN;
	if (boss || story) {
		if (boss && boss.test(trainer)) return 'boss';
		if (story && story.test(trainer)) return 'story';
		return null;
	}
	const milestone = profile.encounters.MILESTONE_PATTERN;
	return milestone && milestone.test(trainer) ? 'boss' : null;
}

/**
 * The cap governing the stretch of map that starts at `from`: the ace of the
 * first boss-tier fight of either kind at or after that order.
 *
 * One derivation serves both questions asked of the cap — "what am I capped at
 * now" (from the position) and "what will I be capped at there" (from a fight's
 * order) — because they are the same question asked from two points on the map,
 * and two copies of the tier filter would be two places to get boss tiers wrong.
 */
function capFrom(run, from) {
	if (run.rules.levelCap === 'none') return {cap: null, mode: 'none'};
	const profile = getProfile(run.profileId);
	const fights = visibleFights(run)
		.filter(f => f.order >= from)
		.filter(f => fightTier(profile, f.trainer) !== null);
	if (!fights.length) return {cap: null, mode: run.rules.levelCap, reason: 'no boss ahead'};
	const next = fights[0];
	const ace = next.party.reduce((top, mon) => mon.level > top.level ? mon : top, next.party[0]);
	return {
		cap: ace.level,
		mode: run.rules.levelCap,
		trainer: next.trainer,
		order: next.order,
		ace: ace.species,
		tier: fightTier(profile, next.trainer),
	};
}

/**
 * The level ceiling this run is playing under, and where it comes from.
 *
 * The cap is the ace of the next BOSS-TIER fight of either kind — which is the
 * game's actual pacing, not the next badge's. A fresh run is capped at 12 by
 * the Petalburg Woods grunt's Croagunk; Brawly's 21 only applies once the two
 * story fights before him are cleared. Deriving it this way keeps every cap a
 * value read out of the run map rather than a number somebody transcribed.
 *
 * Returned with the fight that sets it, not as a bare number: "capped at 12"
 * is a rule, "capped at 12 by the Petalburg Woods grunt's Croagunk" is a
 * reason, and a player arguing with the cap needs the reason.
 */
function levelCap(run) {
	// Orders are integers, so the stretch the run is in starts one past the last
	// fight it beat.
	return capFrom(run, run.position + 1);
}

/**
 * The cap that will be in force WHEN the fight at `order` is fought.
 *
 * A cap is a stretch of map, not a point: every fight from the one after a
 * boss up to and including the next boss is played under that next boss's ace.
 * So the fight at that order belongs to the stretch ending at the first
 * boss-tier fight at or after it — Brawly (#77) is fought at 21, the filler
 * before him (#59) is fought at 21 too, and filler back at #20 is still under
 * the Museum grunts' 16.
 *
 * Bare number, unlike `levelCap`: this answers a look-ahead question about a
 * fight the run has not reached, where the interesting fact is the ceiling
 * itself. Null when the run declines caps or nothing boss-tier lies ahead.
 */
function capAt(run, order) {
	return capFrom(run, order).cap;
}

/**
 * Which split the run is in: the next split-ending boss, and how many are
 * behind it. "Split 1 of 18 — Leader Brawly" is how a player narrates a run;
 * the position integer is how the map stores it.
 */
function split(run) {
	const profile = getProfile(run.profileId);
	const encounters = profile.encounters || {};
	const boss = encounters.BOSS_PATTERN || encounters.MILESTONE_PATTERN;
	if (!boss) return null;
	const bosses = visibleFights(run).filter(fight => boss.test(fight.trainer));
	if (!bosses.length) return null;
	const beaten = bosses.filter(fight => fight.order <= run.position).length;
	const current = bosses[Math.min(beaten, bosses.length - 1)];
	return {
		index: Math.min(beaten + 1, bosses.length),
		of: bosses.length,
		boss: current.trainer,
		order: current.order,
		finished: beaten === bosses.length,
	};
}

/**
 * The split as one sheet: the unit a run is actually narrated in.
 *
 * "The Wattson split" is a boss, the cap that holds on the way, the mandatory
 * story fights between here and it, and how much filler is left. Every number
 * is assembled from views that already exist — split, capAt, fightTier — so a
 * prep sheet cannot drift from the tiers and caps the rest of the product
 * shows.
 */
function splitPrep(run) {
	const here = split(run);
	if (!here) return null;
	const profile = getProfile(run.profileId);
	const ahead = here.finished ? [] : visibleFights(run)
		.filter(fight => fight.order > run.position && fight.order <= here.order);
	// The gauntlet: every remaining boss-tier fight in the split, the boss
	// last, each with the cap in force when it is fought.
	const gauntlet = [];
	let filler = 0;
	for (const fight of ahead) {
		const tier = fightTier(profile, fight.trainer);
		if (!tier) { filler++; continue; }
		const cap = capAt(run, fight.order);
		gauntlet.push({
			trainer: fight.trainer,
			order: fight.order,
			tier,
			partySize: fight.party.length,
			...(cap !== null ? {cap} : {}),
		});
	}
	return {
		split: here,
		cap: levelCap(run),
		gauntlet,
		fightsAhead: ahead.length,
		filler,
	};
}

/** The fights immediately ahead of where the run has got to. */
function upcoming(run, count) {
	return visibleFights(run)
		.filter(fight => fight.order > run.position)
		.slice(0, count || 5);
}

/**
 * The story spine: every milestone fight, with whether the run is past it.
 *
 * This is what "where am I" means over a 362-battle map. The position integer
 * answers it precisely and uselessly; a player thinks in badges and admins,
 * and those are exactly the fights the profile's MILESTONE_PATTERN names.
 *
 * `beaten` is derived from position, not stored — beating fight #337 means the
 * run is past #253 whether or not each rival variant was ever named in a
 * command. That is also what makes bulk progress cheap: marking the last fight
 * of a route beaten moves the spine, no per-trainer bookkeeping required.
 */
function milestones(run) {
	const profile = getProfile(run.profileId);
	const pattern = profile.encounters && profile.encounters.MILESTONE_PATTERN;
	if (!pattern) return [];
	return visibleFights(run)
		.filter(fight => pattern.test(fight.trainer))
		.map(fight => ({
			trainer: fight.trainer,
			order: fight.order,
			beaten: fight.order <= run.position,
			tier: fightTier(profile, fight.trainer),
		}));
}

/** What can be caught on a map, with what the run already holds marked. */
/**
 * The evolution family a species belongs to — the identity the dupes clause
 * compares. A Mightyena is a dupe of a caught Poochyena and the other way
 * around. The oracle owns the derivation (a connected component of the
 * evolution graph, not a pre-evolution walk) because a first-key-wins walk
 * filed Muk-Alola under plain Grimer and let a run keep both halves of the
 * Alolan line. A profile without the derivation falls back to the lineage
 * walk, which is right for unbranched lines.
 */
/**
 * The layer an operation NEEDS, or a contract error naming it — never a
 * TypeError three calls deep. Views degrade gracefully without a layer;
 * operations that verify claims against it cannot, and must say so.
 */
function requireLayer(profile, name, why) {
	if (!profile[name]) {
		throw new Error(`profile '${profile.id}' declares no ${name} layer — ${why}`);
	}
	return profile[name];
}

function familyOf(profile, species) {
	if (profile.oracle.familyOf) return profile.oracle.familyOf(species);
	const line = profile.oracle.lineageOf(species);
	return line.length ? line[line.length - 1] : species;
}

/**
 * The 'forms' identity: families closed over the dex's base-form links, so
 * every regional branch of a line shares one key with the base line.
 *
 * A CLOSURE, not a per-species collapse. familyOf(baseForm(species)) looked
 * right and was not a superset of 'line': Obstagoon's base form is itself, so
 * it kept the Galar line's key while Zigzagoon-Galar collapsed to the Kanto
 * line's — the strictest mode accepting a catch the default refuses. Instead,
 * every dex form entry unions its family with its base species' family once,
 * and a key is the merged component's root. Cached per profile, because the
 * unkeyed-singleton trap is already on this project's audit wall.
 */
const formsMergeByProfile = new Map();

function formsRootOf(profile, species) {
	let merged = formsMergeByProfile.get(profile.id);
	if (!merged) {
		const parent = new Map();
		const find = key => {
			let root = key;
			while (parent.get(root) !== root) root = parent.get(root);
			parent.set(key, root);
			return root;
		};
		const ensure = key => {
			if (!parent.has(key)) parent.set(key, key);
			return key;
		};
		const calc = require('@smogon/calc');
		for (const dexEntry of calc.Generations.get(8).species) {
			if (!dexEntry.baseSpecies || dexEntry.baseSpecies === dexEntry.name) continue;
			const formRoot = find(ensure(familyOf(profile, dexEntry.name)));
			const baseRoot = find(ensure(familyOf(profile, dexEntry.baseSpecies)));
			if (formRoot !== baseRoot) parent.set(formRoot, baseRoot);
		}
		merged = {find, ensure};
		formsMergeByProfile.set(profile.id, merged);
	}
	return merged.find(merged.ensure(familyOf(profile, species)));
}

/**
 * The identity a catch is compared under, for a dupes mode — or null when the
 * clause is off. The mode is resolved once by the caller, not re-derived per
 * box entry: a dupe scan asks this for every mon it holds.
 */
function dupeKey(mode, profile, species) {
	if (mode === 'off') return null;
	if (mode === 'species') return species;
	if (mode === 'forms') return formsRootOf(profile, species);
	return familyOf(profile, species);
}

/**
 * The catch this run already made on a map, if any — from the log, because the
 * box forgets: releasing or losing the catch does not refund the route. A
 * shiny-claimed catch under the shiny clause is skipped: the clause's whole
 * point is that a shiny is a bonus, so it must not CONSUME the route either —
 * a shiny stumbled on first would otherwise block the route's real encounter.
 */
function routeCatch(run, profile, canonicalMap) {
	const shinyFree = encounterRules(run).shiny;
	for (const entry of run.log) {
		if (!entry.command || entry.command.kind !== 'catch' || !entry.command.map) continue;
		if (shinyFree && entry.command.shiny) continue;
		const where = profile.oracle.encountersOn(entry.command.map);
		if (where && where.map === canonicalMap) return entry.command;
	}
	return null;
}

function encountersOn(run, map) {
	const profile = getProfile(run.profileId);
	requireLayer(profile, 'oracle', 'there are no wild tables to look up');
	const found = profile.oracle.encountersOn(map);
	if (!found) return null;
	const owned = new Set(run.box.map(mon => mon.species));
	const mons = found.mons.map(mon => Object.assign({owned: owned.has(mon.species)}, mon));
	const answer = {map: found.map, name: found.name, mons};

	// Under the encounter rules the list is not a menu, it is a forecast: the
	// encounter is random, so each row carries its table odds; under a dupes
	// clause the dupes are marked (they do not count — the player re-rolls)
	// and `odds` renormalizes the chance over what can actually be kept, per
	// method, because walking and fishing are separate dice. Each decoration
	// follows its own toggle.
	const rules = encounterRules(run);
	if (rules.dupes !== 'off') {
		const keys = new Set(run.box.map(mon => dupeKey(rules.dupes, profile, mon.species)));
		const liveByMethod = {};
		for (const mon of mons) {
			mon.dupe = keys.has(dupeKey(rules.dupes, profile, mon.species));
			if (!mon.dupe) {
				liveByMethod[mon.method] = (liveByMethod[mon.method] || 0) + mon.chance;
			}
		}
		for (const mon of mons) {
			mon.odds = mon.dupe || !liveByMethod[mon.method] ? 0 :
				Math.round(mon.chance / liveByMethod[mon.method] * 1000) / 10;
		}
	}
	if (rules.onePerRoute) {
		const used = routeCatch(run, profile, found.map);
		if (used) answer.used = {species: used.species, level: used.level};
	}
	return answer;
}

/**
 * Every map with a wild table, and whether this run has spent its catch there.
 *
 * The catch planner's wide view: under the nuzlocke rules each map is one
 * random encounter for the whole run, so the question "where can I still get
 * something" is a real resource question. Each unused route carries its best
 * prospects — top odds rows, dupes excluded — so the list reads as "what is
 * still out there", not just "where".
 *
 * Honesty note: the list is in the decomp's declaration order, which is
 * roughly the region's geography, NOT the order routes unlock. When a route
 * becomes reachable is not data this profile has (ENC-02), and guessing would
 * be worse than saying so.
 */
function unusedRoutes(run) {
	const profile = getProfile(run.profileId);
	requireLayer(profile, 'oracle', 'there are no wild tables to walk');
	const routes = [];
	for (const map of profile.oracle.maps()) {
		const here = encountersOn(run, map.name);
		const entry = {map: here.map, name: here.name};
		// Where a catch happened is a fact of the log, not of the ruleset, so it
		// is reported for every run — only its consequences are nuzlocke-gated.
		const used = routeCatch(run, profile, here.map);
		if (used) entry.used = {species: used.species, level: used.level};
		// Best prospects: what a re-roll can actually keep, best odds first.
		// Ties broken by table order, which is the game's own slot order.
		entry.best = here.mons
			.filter(mon => !mon.dupe)
			.sort((a, b) => (b.odds !== undefined ? b.odds : b.chance) -
				(a.odds !== undefined ? a.odds : a.chance))
			.slice(0, 3)
			.map(mon => ({
				species: mon.species,
				method: mon.method,
				minLevel: mon.minLevel,
				maxLevel: mon.maxLevel,
				chance: mon.odds !== undefined ? mon.odds : mon.chance,
				...(mon.rod ? {rod: mon.rod} : {}),
			}));
		routes.push(entry);
	}
	return {
		order: 'declaration',
		routes,
	};
}

/** What a box entry could be taught, split by whether it can be taught NOW. */
function learnable(run, id, options) {
	const mon = requireMon(run, id);
	// `atLevel` moves the now/later line: the advisor asks at the CAP the fight
	// is fought under, because the free candy guarantees the mon reaches it —
	// gating on today's level hid every level-up move between here and the cap.
	const atLevel = options && options.atLevel !== undefined ? options.atLevel : mon.level;
	const profile = getProfile(run.profileId);
	const all = profile.oracle.legalMoves(mon.species);
	const known = new Set(mon.moves);
	const now = [];
	const later = [];
	for (const move of Object.keys(all)) {
		if (known.has(move)) continue;
		const sources = all[move].sources;
		// A level-up move is only available once the level is reached; anything
		// with a non-level source (TM, tutor, egg) is available immediately.
		const gated = sources.every(s => s.level !== undefined);
		const soonest = sources.reduce((min, s) =>
			s.level !== undefined && (min === null || s.level < min) ? s.level : min, null);
		const entry = {move, sources};
		if (soonest !== null) entry.level = soonest;
		if (gated && soonest > atLevel) later.push(entry);
		else now.push(entry);
	}
	const byName = (a, b) => a.move.localeCompare(b.move);
	return {now: now.sort(byName), later: later.sort((a, b) => a.level - b.level || byName(a, b))};
}

/**
 * The run's party as `team.js` specs, ready for the planner.
 *
 * `atOrder` projects the party to the cap it will be playing under at that
 * point in the map. That is not a guess about EXP: the infinite Rare Candy
 * levels the whole box to cap for free, so a mon below the cap of a future
 * fight WILL be at that cap by the time it is fought, and planning it at
 * today's level answers a question about a team the player will never field.
 */
function partySpecs(run, options) {
	const opts = options || {};
	// Projection only ever raises. A mon taken over the cap with the run's
	// limited Rare Candies keeps those levels — nothing in the game takes them
	// back — so a max, never an assignment.
	const projected = opts.atOrder === undefined || opts.atOrder === null ?
		null : capAt(run, opts.atOrder);
	return run.party.map(id => {
		const mon = requireMon(run, id);
		return {
			species: mon.species,
			level: projected === null ? mon.level : Math.max(mon.level, projected),
			nature: mon.nature,
			ability: mon.ability,
			item: mon.item,
			moves: mon.moves,
			ivs: mon.ivs || {},
		};
	});
}

/**
 * What a fight does against the party the run will legally have when it gets
 * there.
 *
 * The whole stack in one call: the run says who you are and where you are, the
 * map says who is next, and the planner says what they do about it.
 *
 * The party is projected to the cap of the fight being planned, and that
 * projection is why this function lives at L6 rather than in the planner. A
 * look-ahead plan built from today's levels lies: planning Brawly from the
 * start of the run fights him with a level 12 box when the player would stand
 * there at 21, and every damage roll in the answer is wrong. Only this layer
 * can fix it, because only this layer reads the save and the cap rules — the
 * planner takes explicit levels and never learns that a run exists, which is
 * what keeps it usable for a hypothetical team nobody owns.
 *
 * `projection` travels back with the plan so a consumer can say "at the cap
 * you will legally have" rather than presenting projected levels as the box.
 */
function planNext(run, options) {
	const opts = options || {};
	if (!run.party.length) {
		throw new Error('the party is empty: add Pokemon to the party before planning');
	}
	const ahead = upcoming(run, 1);
	const trainer = opts.trainer || (ahead.length ? ahead[0].trainer : null);
	if (!trainer) throw new Error('nothing ahead in the run map to plan against');
	const planner = require('./planner');
	const fight = planner.getFight(trainer, run.profileId);
	const cap = capAt(run, fight.order);
	const specs = partySpecs(run, {atOrder: fight.order});
	const plan = planner.predict({
		trainer,
		playerParty: specs,
		profileId: run.profileId,
	});
	// `from` is not `applied` restated: a party already at or over the cap plans
	// at exactly the levels the box holds, and a consumer that framed that as a
	// projection would be hedging about numbers the player can see.
	const raised = cap !== null &&
		run.party.some((id, i) => specs[i].level > requireMon(run, id).level);
	plan.projection = {
		applied: cap !== null,
		cap,
		from: raised ? 'projected' : 'current',
	};
	return plan;
}

/**
 * Every Pokemon the run still has against every Pokemon a trainer fields.
 *
 * `planNext` answers "what does the party do here". This answers the question
 * that comes first and is harder: WHICH SIX. A box of twenty and a boss of six
 * is a hundred and twenty exchanges, and no player works them out one damage
 * calc at a time — which is why the calculator grew a colour-coded box grid,
 * and why this replaces it.
 *
 * The whole box, alive only. A party filter would answer the question with the
 * answer already assumed, and a dead Pokemon under permadeath is not a choice
 * — it is a row that can only mislead.
 *
 * Projected to the cap of the fight being compared, for the same reason
 * `planNext` projects: a level 3 Lillipup stands in front of the first grunt at
 * 12, so a grid built from today's levels grades every row against a box the
 * player will never field. That projection is why this lives at L6 —
 * `planner.matchup` takes explicit levels and never learns that a run exists.
 */
function boxMatrix(run, trainer) {
	const planner = require('./planner');
	const ahead = upcoming(run, 1);
	const named = trainer || (ahead.length ? ahead[0].trainer : null);
	if (!named) throw new Error('nothing ahead in the run map to compare against');
	const fight = planner.getFight(named, run.profileId);

	const alive = run.box.filter(mon => mon.status !== 'dead');
	if (!alive.length) {
		throw new Error('no Pokemon in the box to compare; catch something first');
	}

	const cap = capAt(run, fight.order);
	// The box is handed to `partySpecs` AS the party rather than projected here.
	// The rule — raise to the cap, never lower — is one line, and two copies of
	// it would be two places for the projection to drift from the plan the
	// player reads next to this grid.
	const specs = partySpecs(
		Object.assign({}, run, {party: alive.map(mon => mon.id)}),
		{atOrder: fight.order});

	const matrix = planner.matchup({
		trainer: named,
		playerParty: specs,
		profileId: run.profileId,
	});
	// A grid row is a species and a level; a player acts on it by putting an id
	// in the party. Two Poochyena in one box make the species alone ambiguous,
	// so the row keys travel with the grid, in the order the rows are in.
	matrix.box = alive.map((mon, i) => ({
		id: mon.id,
		species: mon.species,
		nickname: mon.nickname,
		level: specs[i].level,
		from: mon.level,
	}));
	matrix.projection = {
		applied: cap !== null,
		cap,
		from: alive.some((mon, i) => specs[i].level > mon.level) ? 'projected' : 'current',
	};
	return matrix;
}

// -------------------------------------------------------------- upgrade advisor

/** How many changes the advisor reports. A shortlist, not a catalogue. */
const ADVICE_LIMIT = 10;

/** Guaranteed-KO cells on one side of a row, and the summed damage on it. */
function countKO(row, side) {
	return row.filter(cell => cell[side].guaranteedKO).length;
}
function sumMax(row, side) {
	return row.reduce((total, cell) => total + cell[side].max, 0);
}

/**
 * What a candidate did to one mon's row of the board.
 *
 * KOs first and damage only as a tie-break, because that is the order the
 * fight decides things in: a cell that flips to a guaranteed KO removes a
 * Pokemon from the fight, while chip damage only makes the same exchange
 * closer. Both sides count — an item that gains us a KO and hands them two is
 * not an upgrade, and a scoring function that only looked at our column would
 * happily recommend it.
 *
 * The damage figure is rounded to a thousandth of a bar so float noise cannot
 * decide the order of two otherwise identical candidates; the list has to come
 * out the same on every call for the same run.
 */
function upgradeDelta(base, row) {
	const gained = (sumMax(row, 'us') - sumMax(base, 'us')) -
		(sumMax(row, 'them') - sumMax(base, 'them'));
	return {
		koGained: countKO(row, 'us') - countKO(base, 'us'),
		koConceded: countKO(row, 'them') - countKO(base, 'them'),
		damage: Math.round(gained * 1000) / 1000,
	};
}

/**
 * Which of four known moves a taught move would replace.
 *
 * The advisor has to name one to score one: the game gives four slots, so a
 * fifth move is not a candidate, it is a different question. The move picked
 * is the one THIS fight leans on least — never the best hit against any of the
 * trainer's Pokemon, and failing that best against the fewest of them.
 *
 * The heuristic only chooses which candidate to price. The price is measured:
 * the row is rebuilt with the four moves that survive, so whatever the swap
 * costs shows up in the delta rather than being assumed away.
 */
function leastUsedMove(moves, base) {
	const uses = new Map(moves.map(move => [move, 0]));
	for (const cell of base) {
		if (cell.us.move && uses.has(cell.us.move)) {
			uses.set(cell.us.move, uses.get(cell.us.move) + 1);
		}
	}
	// `reduce` keeps the earlier move on a tie, so the choice is stable.
	return moves.reduce((worst, move) => uses.get(move) < uses.get(worst) ? move : worst, moves[0]);
}

/**
 * Every single change one party member could make before this fight.
 *
 * Single is the whole point: a player between two fights teaches one move,
 * hands over one item, spends one scale. Ranking combinations would rank
 * plans nobody can execute in the time they have, and the search would be the
 * product of three lists instead of their sum.
 *
 * Each candidate carries the SPEC it would produce, because the score is not
 * estimated from the change — the row is rebuilt with it.
 */
function upgradeCandidates(run, mon, spec, base) {
	const planner = require('./planner');
	const list = [];

	// Candidates are drawn at the SPEC's level — the projected cap — not the
	// box's: the board is scored there, and the free candy makes those moves
	// teachable before the fight.
	for (const entry of learnable(run, mon.id, {atLevel: spec.level}).now) {
		const moves = spec.moves.slice();
		let detail = entry.move;
		if (moves.length >= 4) {
			const dropped = leastUsedMove(moves, base);
			moves[moves.indexOf(dropped)] = entry.move;
			detail = `${entry.move} over ${dropped}`;
		} else {
			moves.push(entry.move);
		}
		list.push({kind: 'teach', detail, spec: Object.assign({}, spec, {moves})});
	}

	for (const item of Object.keys(run.bag).sort()) {
		// Most of a bag is not a held item — Rare Candy, Heart Scales, repels —
		// and handing one to the calculator is a refusal, not a build. Asking L5
		// what it can hold beats discovering it as a thrown error mid-board.
		if (!planner.holdableItem(item)) continue;
		if (item === spec.item) continue;
		list.push({
			kind: 'give',
			detail: spec.item ? `${item} over ${spec.item}` : item,
			spec: Object.assign({}, spec, {item}),
		});
	}

	// One scale in the bag is enough to make every stat a candidate: these are
	// alternatives, and the player spends it on one of them.
	if (run.bag[HEART_SCALE]) {
		const ivs = mon.ivs || {};
		for (const stat of Object.keys(IV_STATS)) {
			// Only an IV the box RECORDS can be priced. An unrecorded one already
			// reaches the calculator as 31, so a scale on it would score a flat
			// zero and read as "this does nothing" when the truth is "nobody has
			// told this run what that IV is".
			if (typeof ivs[stat] !== 'number' || ivs[stat] === 31) continue;
			list.push({
				kind: 'heartScale',
				detail: `${IV_STATS[stat]} IV ${ivs[stat]} → 31`,
				spec: Object.assign({}, spec, {ivs: Object.assign({}, spec.ivs, {[stat]: 31})}),
			});
		}
	}
	return list;
}

/**
 * The single changes that most improve the party against a fight.
 *
 * The board says which of your Pokemon beat which of theirs. This answers the
 * question a player asks straight after reading it: what can I do about the
 * cells that are red. Every answer is scored the same way the board is scored,
 * by rebuilding the affected mon's row through `planner.matchup` with the
 * change applied — so an upgrade's claim is the same claim the grid next to it
 * makes, and never a heuristic about type charts or base stats.
 *
 * THE PARTY, not the box. Six mons times their learnsets, the bag and six IVs
 * is already hundreds of policy evaluations; the box would be thousands, and a
 * tool a player waits a minute for is a report, not an advisor. Which six is
 * the board's question anyway — this one starts once that is settled.
 *
 * Candidates and specs are built HERE and handed down. `planner.matchup` is
 * given a one-mon party and never learns that a bag, a learnset or a run
 * exists, which is the same layering rule `boxMatrix` and `planNext` follow.
 *
 * Changes that do not improve anything are dropped rather than listed with a
 * zero: an advisor whose top ten is padded with moves that change nothing has
 * told the player nothing. An empty list is a real answer — nothing in reach
 * moves this board.
 */
function adviseUpgrades(run, trainer) {
	const planner = require('./planner');
	if (!run.party.length) {
		throw new Error('the party is empty: add Pokemon to the party before asking what to change');
	}
	const ahead = upcoming(run, 1);
	const named = trainer || (ahead.length ? ahead[0].trainer : null);
	if (!named) throw new Error('nothing ahead in the run map to improve against');
	const fight = planner.getFight(named, run.profileId);
	const cap = capAt(run, fight.order);
	const specs = partySpecs(run, {atOrder: fight.order});

	const baseline = planner.matchup({
		trainer: named,
		playerParty: specs,
		profileId: run.profileId,
	});

	const upgrades = [];
	let considered = 0;
	run.party.forEach((id, slot) => {
		const mon = requireMon(run, id);
		const base = baseline.grid.map(cell => cell.versus[slot]);
		for (const candidate of upgradeCandidates(run, mon, specs[slot], base)) {
			considered += 1;
			const row = planner.matchup({
				trainer: named,
				playerParty: [candidate.spec],
				profileId: run.profileId,
			}).grid.map(cell => cell.versus[0]);
			const delta = upgradeDelta(base, row);
			if (delta.koGained - delta.koConceded <= 0 && delta.damage <= 0) continue;
			upgrades.push({kind: candidate.kind, id, detail: candidate.detail, delta});
		}
	});

	upgrades.sort((a, b) =>
		(b.delta.koGained - b.delta.koConceded) - (a.delta.koGained - a.delta.koConceded) ||
		b.delta.damage - a.delta.damage ||
		// Never a coin flip: the same run must produce the same shortlist twice.
		a.id.localeCompare(b.id) || a.kind.localeCompare(b.kind) ||
		a.detail.localeCompare(b.detail));

	return {
		trainer: fight.trainer,
		order: fight.order,
		considered,
		party: run.party.map((id, slot) => {
			const mon = requireMon(run, id);
			return {
				id, species: mon.species, nickname: mon.nickname,
				level: specs[slot].level, from: mon.level,
			};
		}),
		projection: {
			applied: cap !== null,
			cap,
			from: run.party.some((id, slot) => specs[slot].level > requireMon(run, id).level) ?
				'projected' : 'current',
		},
		upgrades: upgrades.slice(0, ADVICE_LIMIT),
	};
}

// -------------------------------------------------------------------- commands

/**
 * Validate a catch against the map it claims to have happened on.
 *
 * The check is the point of the whole oracle import. Without it a box is
 * whatever somebody typed; with it, "Ralts on Route 101 at level 12" is refused
 * with the reason, and a nuzlocke's rules mean something.
 */
function checkEncounter(profile, command) {
	if (!command.map) {
		// Gifts, statics, trades and starters have no wild table anywhere in the
		// decomp. Refusing them would refuse half a real box, so they are recorded
		// as declared rather than checked — and marked as such.
		return {method: 'declared', map: null};
	}
	const found = profile.oracle.encountersOn(command.map);
	if (!found) {
		throw new Error(`no map named ${JSON.stringify(command.map)} has a wild encounter table`);
	}
	const slots = found.mons.filter(mon => mon.species === command.species);
	if (!slots.length) {
		const roster = [...new Set(found.mons.map(m => m.species))].slice(0, 10).join(', ');
		throw new Error(`${command.species} does not appear on ${found.name}; it holds: ${roster}`);
	}
	const byLevel = slots.filter(slot =>
		command.level >= slot.minLevel && command.level <= slot.maxLevel);
	if (!byLevel.length) {
		const ranges = slots.map(s => `${s.method} ${s.minLevel}-${s.maxLevel}`).join(', ');
		throw new Error(
			`${command.species} on ${found.name} is level ${ranges}, not ${command.level}`);
	}
	// A named method is a claim about how the catch happened, so a wrong one is a
	// wrong catch. Falling back to another slot would silently rewrite the claim
	// and store 'fish' under a player who said 'walk' — an asserted fact turned
	// into a fabricated one, which is the opposite of what the oracle is for.
	if (command.method) {
		const named = byLevel.find(s => s.method === command.method);
		if (!named) {
			const methods = [...new Set(byLevel.map(s => s.method))].join(', ');
			throw new Error(`${command.species} on ${found.name} at level ` +
				`${command.level} is not caught by ${command.method}; it is caught by: ${methods}`);
		}
		return {method: named.method, map: found.map, mapName: found.name, rod: named.rod};
	}
	const slot = byLevel[0];
	return {method: slot.method, map: found.map, mapName: found.name, rod: slot.rod};
}

const COMMANDS = {
	/** Add a Pokemon to the box, checked against the map it was caught on. */
	catch(run, command) {
		const profile = getProfile(run.profileId);
		requireLayer(profile, 'oracle', 'a catch cannot be verified without the wild tables and learnsets');
		if (!command.species) throw new Error('catch: species is required');
		if (!profile.oracle.levelUpMoves(command.species).length &&
			!profile.oracle.teachableMoves(command.species).length) {
			throw new Error(`catch: ${command.species} is not a species this game knows`);
		}
		const level = Number(command.level);
		if (!Number.isInteger(level) || level < 1 || level > 100) {
			throw new Error('catch: level must be an integer from 1 to 100');
		}
		const origin = checkEncounter(profile, Object.assign({}, command, {level}));

		// The encounter rules, each its own toggle, on wild catches only — a
		// gift, static or trade (no map) is not the route's random encounter
		// and stays exempt. A shiny claim exempts a catch from both rules when
		// the shiny clause is on; the claim is recorded on the mon, so the box
		// shows which catches rode the exemption.
		const rules = encounterRules(run);
		const shinyExempt = command.shiny && rules.shiny;
		if (rules.onePerRoute && origin.map && !shinyExempt) {
			const prior = routeCatch(run, profile, origin.map);
			if (prior) {
				throw new Error(`catch: this run already used its one ${origin.mapName} ` +
					`encounter on ${prior.species} — a route gives one random catch, ` +
					'and releasing or losing it does not refund it');
			}
		}
		if (rules.dupes !== 'off' && origin.map && !shinyExempt) {
			const key = dupeKey(rules.dupes, profile, command.species);
			const dupe = run.box.find(mon => dupeKey(rules.dupes, profile, mon.species) === key);
			if (dupe) {
				throw new Error(`catch: ${command.species} is a dupe of ${dupe.species} ` +
					`(${dupe.id}) under the ${JSON.stringify(rules.dupes)} dupes clause, ` +
					'so it does not count; re-roll and report what came up instead');
			}
		}

		// Default the moveset to what the species would actually know at this
		// level. A caught Pokemon arrives with moves; making the player type four
		// of them before the entry is usable would make catching feel like data
		// entry rather than playing.
		//
		// Explicit moves are checked for legality, because an unchecked list here
		// would be a bypass around everything `teach` enforces.
		let moves;
		if (command.moves && command.moves.length) {
			// Trimming to four silently dropped the surplus BEFORE it was checked, so
			// an illegal fifth move raised nothing at all — the one hole in the wall
			// `teach` builds. Refuse the list instead: four is the game's limit, and
			// which four is the player's call, not this module's.
			if (command.moves.length > 4) {
				throw new Error(`catch: ${command.species} knows four moves, not ` +
					`${command.moves.length} (${command.moves.join(', ')}) — name four`);
			}
			moves = command.moves.slice();
			for (const move of moves) {
				if (!profile.oracle.canLearn(command.species, move).legal) {
					throw new Error(`catch: ${command.species} cannot know ${move} — ` +
						'not by level-up, TM, tutor, or an egg move inherited down its line');
				}
			}
		} else {
			moves = profile.oracle.levelUpMoves(command.species)
				.filter(pair => pair[0] <= level)
				.slice(-4)
				.map(pair => pair[1]);
		}
		// A movesless entry is a time bomb: the box stores it happily and the
		// planner detonates on it later. It is also real — Run & Bun gives some
		// species (Skarmory) NO level-up moves at all, so the default can
		// legitimately come up empty and the moves must be named.
		if (!moves.length) {
			const teachable = profile.oracle.teachableMoves(command.species).slice(0, 6);
			throw new Error(`catch: ${command.species} at level ${level} has no ` +
				'level-up moves in this game — name its moves' +
				(teachable.length ? `; it can be taught: ${teachable.join(', ')}` : ''));
		}

		const mon = {
			id: `mon-${run.nextId}`,
			species: command.species,
			nickname: command.nickname || null,
			level,
			nature: command.nature || null,
			ability: command.ability || null,
			item: command.item || null,
			moves,
			ivs: command.ivs || {},
			status: 'boxed',
			// Recorded because it carries a rules exemption, not as flavor.
			...(command.shiny ? {shiny: true} : {}),
			origin: Object.assign({at: run.position}, origin),
		};
		run.nextId += 1;
		run.box.push(mon);
		return `caught ${mon.species} (${mon.id}) at level ${level}` +
			(origin.mapName ? ` on ${origin.mapName}` : ' — declared, no wild table');
	},

	/**
	 * Set a Pokemon's level.
	 *
	 * `to: 'cap'` levels straight to the current cap — the game's infinite Rare
	 * Candy makes that free, so the tool makes it one word. Levels ABOVE the cap
	 * cost one Rare Candy from the bag each, which is the game's own economy:
	 * the candies found through the run are the only way over.
	 */
	levelUp(run, command) {
		const mon = requireMon(run, command.id);
		const cap = levelCap(run);
		let to = command.to;
		if (to === 'cap') {
			if (cap.cap === null) throw new Error('levelUp: this run has no cap — give a number');
			to = cap.cap;
		}
		to = Number(to);
		if (!Number.isInteger(to) || to < 1 || to > 100) {
			throw new Error('levelUp: to must be an integer from 1 to 100, or "cap"');
		}
		if (to < mon.level) {
			throw new Error(`levelUp: ${mon.species} is already level ${mon.level}; ` +
				'levels do not go down');
		}
		let spent = 0;
		if (cap.cap !== null && to > cap.cap) {
			spent = to - Math.max(cap.cap, mon.level);
			const candies = run.bag['Rare Candy'] || 0;
			if (candies < spent) {
				throw new Error(`levelUp: the cap is ${cap.cap} ` +
					`(${cap.trainer}'s ${cap.ace}); each level above it costs a Rare Candy — ` +
					`need ${spent}, the bag has ${candies}`);
			}
			run.bag['Rare Candy'] -= spent;
			if (!run.bag['Rare Candy']) delete run.bag['Rare Candy'];
		}
		const from = mon.level;
		mon.level = to;
		return `${mon.species} (${mon.id}) ${from} → ${to}` +
			(spent ? ` (${spent} Rare Candy over the cap)` : '');
	},

	/** Evolve a Pokemon, checked against the evolution table. */
	evolve(run, command) {
		const mon = requireMon(run, command.id);
		const profile = getProfile(run.profileId);
		const options = profile.oracle.evolutionsOf(mon.species);
		if (!options.length) {
			throw new Error(`evolve: ${mon.species} does not evolve`);
		}
		const target = command.into ?
			options.find(step => step.into === command.into) :
			options.length === 1 ? options[0] : null;
		if (!target) {
			const list = options.map(s => s.into).join(', ');
			throw new Error(command.into ?
				`evolve: ${mon.species} does not become ${command.into}; it becomes ${list}` :
				`evolve: ${mon.species} has more than one evolution — pick one of ${list}`);
		}
		if (target.level !== undefined && mon.level < target.level) {
			throw new Error(`evolve: ${mon.species} becomes ${target.into} at level ` +
				`${target.level}; it is ${mon.level}`);
		}
		const from = mon.species;
		mon.species = target.into;
		return `${from} → ${target.into} (${mon.id})`;
	},

	/** Teach a move, checked against the species' full legal movepool. */
	teach(run, command) {
		const mon = requireMon(run, command.id);
		const profile = getProfile(run.profileId);
		if (!command.move) throw new Error('teach: move is required');
		const verdict = profile.oracle.canLearn(mon.species, command.move);
		if (!verdict.legal) {
			throw new Error(`teach: ${mon.species} cannot learn ${command.move} — ` +
				'not by level-up, TM, tutor, or an egg move inherited down its line');
		}
		// A level-up-only move is not available before its level. Anything with a
		// TM, tutor or egg source is available as soon as the Pokemon exists.
		const onlyByLevel = verdict.sources.every(s => s.level !== undefined);
		const soonest = verdict.sources.reduce((min, s) =>
			s.level !== undefined && (min === null || s.level < min) ? s.level : min, null);
		if (onlyByLevel && soonest > mon.level) {
			throw new Error(`teach: ${mon.species} learns ${command.move} at level ` +
				`${soonest}; it is ${mon.level}`);
		}
		if (mon.moves.includes(command.move)) {
			throw new Error(`teach: ${mon.species} already knows ${command.move}`);
		}
		if (mon.moves.length >= 4) {
			if (!command.replace) {
				throw new Error(`teach: ${mon.species} knows four moves ` +
					`(${mon.moves.join(', ')}) — name one to replace`);
			}
			const at = mon.moves.indexOf(command.replace);
			if (at === -1) {
				throw new Error(`teach: ${mon.species} does not know ${command.replace}`);
			}
			mon.moves[at] = command.move;
			return `${mon.species} (${mon.id}) forgot ${command.replace}, learned ${command.move}`;
		}
		// A named replace is honored below four moves too — a player who says
		// "over Water Gun" wants Water Gun GONE, and silently appending instead
		// kept the move while the summary implied the swap happened.
		if (command.replace) {
			const at = mon.moves.indexOf(command.replace);
			if (at === -1) {
				throw new Error(`teach: ${mon.species} does not know ${command.replace}`);
			}
			mon.moves[at] = command.move;
			return `${mon.species} (${mon.id}) forgot ${command.replace}, learned ${command.move}`;
		}
		mon.moves.push(command.move);
		return `${mon.species} (${mon.id}) learned ${command.move}`;
	},

	/** Move an item from the bag onto a Pokemon. */
	give(run, command) {
		const mon = requireMon(run, command.id);
		if (!command.item) throw new Error('give: item is required');
		if (!run.bag[command.item]) {
			throw new Error(`give: the bag has no ${command.item}`);
		}
		if (mon.item) {
			// Swapping returns the old item rather than destroying it, because a bag
			// that loses items on every swap is worse than no bag at all.
			run.bag[mon.item] = (run.bag[mon.item] || 0) + 1;
		}
		run.bag[command.item] -= 1;
		if (!run.bag[command.item]) delete run.bag[command.item];
		const previous = mon.item;
		mon.item = command.item;
		return `${mon.species} (${mon.id}) is holding ${command.item}` +
			(previous ? `; ${previous} went back to the bag` : '');
	},

	/** Take a Pokemon's held item back into the bag. */
	take(run, command) {
		const mon = requireMon(run, command.id);
		if (!mon.item) throw new Error(`take: ${mon.species} is not holding anything`);
		run.bag[mon.item] = (run.bag[mon.item] || 0) + 1;
		const item = mon.item;
		mon.item = null;
		return `took ${item} from ${mon.species} (${mon.id})`;
	},

	/**
	 * Spend a Heart Scale: one IV to 31.
	 *
	 * The other half of the game's own economy. Rare Candy buys levels over the
	 * cap; a Heart Scale buys a single perfect IV, one stat at a time, from a
	 * supply the map hands out and no Mart stocks. That scarcity is the whole
	 * mechanic, so the scale is spent from the bag here rather than assumed
	 * infinite — a run that could max six IVs for free would plan fights it
	 * cannot actually field.
	 *
	 * An IV the box has not recorded is not a refusal. The box stores only the
	 * IVs a player stated and the calculator reads a missing one as 31, so
	 * scaling one records a fact rather than buying a stat — which is also why
	 * `adviseUpgrades` cannot price it and never offers it.
	 */
	heartScale(run, command) {
		const mon = requireMon(run, command.id);
		if (!Object.prototype.hasOwnProperty.call(IV_STATS, command.stat)) {
			throw new Error('heartScale: stat must be one of ' +
				`${Object.keys(IV_STATS).join(', ')}; got ${JSON.stringify(command.stat)}`);
		}
		if (!mon.ivs) mon.ivs = {};
		const current = mon.ivs[command.stat];
		// Checked before the bag, so a player is never sent to look for a scale
		// that would buy nothing.
		if (current === 31) {
			throw new Error(`heartScale: ${mon.species} (${mon.id}) already has a 31 ` +
				`${IV_STATS[command.stat]} IV; a Heart Scale would buy nothing`);
		}
		const held = run.bag[HEART_SCALE] || 0;
		if (!held) {
			throw new Error('heartScale: one Heart Scale sets one IV to 31 and no shop ' +
				`sells them — need 1, the bag has ${held}`);
		}
		run.bag[HEART_SCALE] = held - 1;
		if (!run.bag[HEART_SCALE]) delete run.bag[HEART_SCALE];
		mon.ivs[command.stat] = 31;
		return `${mon.species} (${mon.id}) ${IV_STATS[command.stat]} IV ` +
			`${current === undefined ? 'unrecorded' : current} → 31 ` +
			`(Heart Scale spent, ${held - 1} left)`;
	},

	/** Add items to the bag. Nothing claims where they came from. */
	acquire(run, command) {
		if (!command.item) throw new Error('acquire: item is required');
		const count = command.count === undefined ? 1 : Number(command.count);
		if (!Number.isInteger(count) || count < 1) {
			throw new Error('acquire: count must be a positive integer');
		}
		run.bag[command.item] = (run.bag[command.item] || 0) + count;
		return `bag: ${command.item} x${run.bag[command.item]}`;
	},

	/** Set the party, in order. The first entry leads. */
	party(run, command) {
		const ids = command.ids || [];
		if (!Array.isArray(ids)) throw new Error('party: ids must be an array');
		if (ids.length > PARTY_LIMIT) {
			throw new Error(`party: ${ids.length} Pokemon, but a party holds ${PARTY_LIMIT}`);
		}
		if (new Set(ids).size !== ids.length) {
			throw new Error('party: the same Pokemon cannot occupy two slots');
		}
		for (const id of ids) {
			const mon = requireMon(run, id);
			if (mon.status === 'dead') {
				throw new Error(`party: ${mon.species} (${id}) has fainted for good`);
			}
		}
		for (const mon of run.box) mon.status = mon.status === 'dead' ? 'dead' : 'boxed';
		for (const id of ids) findMon(run, id).status = 'party';
		run.party = ids.slice();
		return `party: ${ids.map(id => findMon(run, id).species).join(', ') || '(empty)'}`;
	},

	/** Record a fight as beaten, moving the run forward. */
	beat(run, command) {
		const planner = require('./planner');
		const fight = planner.getFight(command.trainer, run.profileId);
		if (isExcludedVariant(run, fight.trainer)) {
			throw new Error(`beat: this run faces the ${run.rules.rival} rival; ` +
				`${fight.trainer} is a fight it can never see`);
		}
		if (fight.order <= run.position) {
			throw new Error(`beat: ${fight.trainer} is at ${fight.order}, ` +
				`already behind the run at ${run.position}`);
		}
		run.position = fight.order;
		return `beat ${fight.trainer} (now at ${fight.order})`;
	},

	/**
	 * A Pokemon fainted.
	 *
	 * Under permadeath this is final and removes it from the party. Without that
	 * rule it is a no-op on status — fainting is not a state a save file keeps,
	 * and pretending otherwise would make every run look like a nuzlocke.
	 */
	faint(run, command) {
		const mon = requireMon(run, command.id);
		if (!run.rules.permadeath) {
			return `${mon.species} (${mon.id}) fainted; permadeath is off, so nothing changed`;
		}
		// A second faint would re-run the handler and overwrite the epitaph —
		// with nothing, if the command names no cause. A death is written once.
		if (mon.status === 'dead') {
			throw new Error(`faint: ${mon.species} (${mon.id}) is already gone` +
				(mon.died && mon.died.to ? ` — ${mon.died.to} took it` : ''));
		}
		mon.status = 'dead';
		run.party = run.party.filter(id => id !== mon.id);
		// The cause is the mon's epitaph, checked like any other claim: a named
		// trainer must be a fight this run can see. The move is free text — the
		// game does not constrain what killed you, only who.
		if (command.to) {
			const fight = visibleFights(run).find(f => f.trainer === command.to);
			if (!fight) {
				throw new Error(`faint: no fight named ${JSON.stringify(command.to)} ` +
					'in this run\'s map — name the trainer as the run map spells it');
			}
			mon.died = {
				to: command.to,
				order: fight.order,
				...(command.move ? {move: command.move} : {}),
				at: run.position,
			};
			return `${mon.species} (${mon.id}) is gone — ${command.to}` +
				(command.move ? `'s ${command.move}` : '');
		}
		mon.died = {at: run.position};
		return `${mon.species} (${mon.id}) is gone`;
	},

	/** Remove a Pokemon from the run entirely. */
	release(run, command) {
		const mon = requireMon(run, command.id);
		run.box = run.box.filter(entry => entry.id !== mon.id);
		run.party = run.party.filter(id => id !== mon.id);
		if (mon.item) run.bag[mon.item] = (run.bag[mon.item] || 0) + 1;
		return `released ${mon.species} (${mon.id})`;
	},

	/** Rename. Cosmetic, and the only reason a box feels like yours. */
	nickname(run, command) {
		const mon = requireMon(run, command.id);
		mon.nickname = command.nickname || null;
		return `${mon.species} (${mon.id}) is now ${mon.nickname || 'unnamed'}`;
	},
};

/**
 * Apply one command, returning a new run.
 *
 * The old run is never touched, which is what makes `undo` trivial and lets a
 * caller show the result of a command before committing to it. A command that
 * throws leaves the caller's run exactly as it was, because the clone it would
 * have modified is discarded.
 */
function apply(run, command, options) {
	const opts = options || {};
	if (!command || !command.kind) throw new Error('a command needs a kind');
	const handler = COMMANDS[command.kind];
	if (!handler) {
		throw new Error(`unknown command ${JSON.stringify(command.kind)}; ` +
			`known: ${Object.keys(COMMANDS).join(', ')}`);
	}
	const next = clone(run);
	// The boundary owns the copy, not the handlers. Handlers park pieces of a
	// command straight in the document — `ivs`, `moves`, `ids` — so a raw command
	// leaves the caller holding a reference INTO a run that has already been
	// returned; mutating it afterwards edits the run, and the log's separate copy
	// then disagrees with the live document, so undo replays a different history
	// than the one on screen. One clone here, handed to both the handler and the
	// log, means no handler can leak caller structure whatever it decides to store.
	const owned = clone(command);
	const summary = handler(next, owned);
	next.updatedAt = opts.now || run.updatedAt;
	next.log.push({command: owned, summary, at: opts.now || null});
	return next;
}

/** Apply a list of commands in order. Throws on the first that fails. */
function applyAll(run, commands, options) {
	let current = run;
	for (const command of commands || []) current = apply(current, command, options);
	return current;
}

/**
 * Undo the last command by replaying the log without it.
 *
 * Replay rather than an inverse for each command: an inverse has to be written
 * once per command and is wrong in a different way each time, while a replay is
 * correct by construction as long as the commands are deterministic — which is
 * the reason `createRun` and `apply` take `now` instead of reading a clock.
 */
function undo(run) {
	if (!run.log.length) throw new Error('nothing to undo');
	const fresh = createRun({
		profileId: run.profileId,
		name: run.name,
		now: run.createdAt,
		levelCap: run.rules.levelCap,
	});
	// The rules travel VERBATIM, not through createRun's options: createRun
	// writes today's rule fields, and a save from before a rule existed must
	// come back from undo byte-identical, not silently upgraded. The readers
	// normalize old shapes (`encounterRules`), so preserving them is safe.
	fresh.rules = JSON.parse(JSON.stringify(run.rules));
	// Each entry replays under the timestamp it was applied with, one `now` per
	// command rather than one for the batch, so the rebuilt document reproduces
	// the original by construction — log entries and `updatedAt` included. The
	// old patch-up wrote `updatedAt` from the last entry's `at`, which is null on
	// the shipped browser path (the panel posts no `now`, so `apply` inherits
	// `updatedAt` and logs null), and undo(apply(r, c)) came back unequal to r.
	let rebuilt = fresh;
	for (const entry of run.log.slice(0, -1)) {
		rebuilt = apply(rebuilt, entry.command, {now: entry.at});
	}
	return rebuilt;
}

/** A readable statement of where the run has got to. */
function summarize(run) {
	const cap = levelCap(run);
	const ahead = upcoming(run, 1);
	const alive = run.box.filter(mon => mon.status !== 'dead');
	return {
		name: run.name,
		profileId: run.profileId,
		position: run.position,
		// The rules in force, normalized: what a client shows and what an old
		// save actually plays under, whichever vintage wrote it.
		rules: Object.assign({
			permadeath: !!run.rules.permadeath,
			rival: run.rules.rival || null,
		}, encounterRules(run)),
		split: split(run),
		next: ahead.length ? {trainer: ahead[0].trainer, order: ahead[0].order} : null,
		levelCap: cap,
		boxed: alive.length,
		lost: run.box.length - alive.length,
		party: run.party.map(id => {
			const mon = findMon(run, id);
			return {
				id, species: mon.species, level: mon.level,
				nickname: mon.nickname, item: mon.item,
			};
		}),
		bag: clone(run.bag),
		commands: run.log.length,
	};
}

module.exports = {
	VERSION, PARTY_LIMIT, LEVEL_CAP_MODES, COMMANDS, IV_STATS, HEART_SCALE,
	createRun, apply, applyAll, undo,
	findMon, levelCap, capAt, upcoming, milestones, split, splitPrep, fightTier, isExcludedVariant,
	encountersOn, unusedRoutes, encounterRules, requireLayer, learnable, partySpecs, planNext, boxMatrix,
	adviseUpgrades, summarize,
};
