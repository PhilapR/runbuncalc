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
 * `identify`, `heartScale`, `party`, `beat`, `faint`, `release` — because a
 * playthrough really is that short a list of verbs. `identify` records facts
 * learned from the summary screen; it is intentionally narrower than a generic
 * field editor, so an observation cannot rewrite species, level, or history.
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
const NATURES = require('./team').NATURES;

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
 * Validate facts observed on the Pokemon summary screen.
 *
 * Ability is free text because Run & Bun changes ability slots and an observed
 * individual is more authoritative than a species default. Nature and IVs have
 * closed game taxonomies, so typos there are refused before they enter replay.
 * A partial IV map is deliberate: an absent stat remains unknown.
 */
function observedFacts(command, kind) {
	const facts = {};
	if (command.nature !== undefined && command.nature !== null && command.nature !== '') {
		if (typeof command.nature !== 'string' || !NATURES.has(command.nature.trim())) {
			throw new Error(`${kind}: nature must be one of ${[...NATURES].join(', ')}`);
		}
		facts.nature = command.nature.trim();
	}
	if (command.ability !== undefined && command.ability !== null && command.ability !== '') {
		if (typeof command.ability !== 'string' || !command.ability.trim() ||
			command.ability.trim().length > 80) {
			throw new Error(`${kind}: ability must be a name up to 80 characters`);
		}
		facts.ability = command.ability.trim();
	}
	if (command.ivs !== undefined && command.ivs !== null) {
		if (typeof command.ivs !== 'object' || Array.isArray(command.ivs)) {
			throw new Error(`${kind}: ivs must be a partial stat map`);
		}
		facts.ivs = {};
		for (const entry of Object.entries(command.ivs)) {
			const stat = entry[0];
			const raw = entry[1];
			if (!Object.prototype.hasOwnProperty.call(IV_STATS, stat)) {
				throw new Error(`${kind}: IV stat must be one of ${Object.keys(IV_STATS).join(', ')}; ` +
					`got ${JSON.stringify(stat)}`);
			}
			const value = Number(raw);
			if (!Number.isInteger(value) || value < 0 || value > 31) {
				throw new Error(`${kind}: ${IV_STATS[stat]} IV must be an integer from 0 to 31`);
			}
			facts.ivs[stat] = value;
		}
	}
	return facts;
}

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
const ROUTE_UNITS = new Set(['area', 'map']);

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
	if (rules.routeUnit !== undefined && !ROUTE_UNITS.has(rules.routeUnit)) {
		throw new Error(`unknown route unit ${JSON.stringify(rules.routeUnit)} ` +
			`stored in this run's rules; the units are: ${[...ROUTE_UNITS].join(', ')}`);
	}
	return {
		onePerRoute: rules.onePerRoute !== undefined ?
			!!rules.onePerRoute : !!rules.permadeath,
		// What "one per route" counts: 'area' spends the whole LOCATION (a
		// cave's floors are one encounter; a route's water is the same route),
		// 'map' spends only the one wild table. Saves from before the unit
		// existed keep 'map' — that is the rule their log was legal under, and
		// undo replays the log.
		routeUnit: rules.routeUnit !== undefined ? rules.routeUnit : 'map',
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
	const routeUnit = opts.routeUnit !== undefined ? opts.routeUnit : 'area';
	if (!ROUTE_UNITS.has(routeUnit)) {
		throw new Error(`unknown route unit ${JSON.stringify(routeUnit)}; ` +
			`the units are: ${[...ROUTE_UNITS].join(', ')}`);
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
		// Assigned by the owning client. Older imported runs legitimately lack
		// one; the history layer derives a stable legacy id when they are archived.
		...(opts.attemptId ? {attemptId: String(opts.attemptId)} : {}),
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
			// One wild catch per LOCATION for the whole run. The encounter is
			// random; the player reports what came up.
			onePerRoute: opts.onePerRoute !== undefined ?
				!!opts.onePerRoute : !!opts.permadeath,
			// The location is the unit, not the wild table: Granite Cave's four
			// floors are one encounter, and a route's water is the same route —
			// an extra method is never an extra catch. 'map' (one per table) is
			// what pre-unit saves played under and stays available.
			routeUnit: routeUnit,
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
		// Deliberately unspent encounters: a location the player is SAVING for
		// a better table later (Petalburg City held for Popplio until Surf).
		// Keyed by the route rule's unit. Legacy saves lack the field; every
		// reader treats absence as "no holds".
		holds: {},
		log: [],
	};
}

// ------------------------------------------------------------------- accessors

function findMon(run, id) {
	return run.box.find(mon => mon.id === id) || null;
}

/** An egg-line legality source. The oracle writes these as 'egg (Treecko)'
 * — the base species rides in the string — so equality against 'egg' is the
 * bug that once taught a giftling Leaf Storm for free. Prefix match only. */
function isEggSource(source) {
	return typeof source.source === 'string' && source.source.indexOf('egg') === 0;
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
 * Every fight this run has beaten, as a set of orders.
 *
 * `position` is the fast-forward: beating a fight ahead means the run
 * traveled there, and everything on the road behind it fell on the way —
 * that is how a run is recorded ("I'm at Cycling Road now"). The one
 * exception is DECLARED: a fight in `skipped` was walked past on purpose
 * (Camper Gavi, delayed until the box can afford him), exactly as `hold`
 * declares a delayed encounter. Beaten = at-or-behind position, minus the
 * skips still outstanding.
 */
function beatenOrders(run) {
	const skipped = new Set(run.skipped || []);
	return new Set(visibleFights(run)
		.filter(fight => fight.order <= run.position && !skipped.has(fight.order))
		.map(fight => fight.order));
}

/**
 * Is a map with this unlock anchor open — keyed on its GUARD FIGHT being
 * beaten, not on how far the road happens to reach. The anchor reproduces
 * the old `position + 1 >= opensAt` under in-order play (the guard is the
 * first fight at order >= opensAt - 1); the difference appears exactly when
 * a fight is skipped: passing Camper Gavi does not open the route he
 * guards.
 */
function anchorOpen(run, opensAt) {
	if (opensAt === undefined || opensAt === null || opensAt <= 0) return true;
	const guard = visibleFights(run)
		.filter(fight => fight.order >= opensAt - 1)
		.reduce((min, fight) => min === null || fight.order < min.order ? fight : min, null);
	if (!guard) return true;
	return beatenOrders(run).has(guard.order);
}

/** The guard fight behind an unlock anchor, for refusals that name it. */
function anchorGuard(run, opensAt) {
	return visibleFights(run)
		.filter(fight => fight.order >= opensAt - 1)
		.reduce((min, fight) => min === null || fight.order < min.order ? fight : min, null);
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
	// A profile that DECLARES its ladder is believed over any derivation: the
	// authored caps are the game's own numbers (usually one below the boss's
	// ace, with rungs no ace predicts), transcribed with their provenance in
	// the profile. Derivation below remains the fallback for profiles that
	// never authored one.
	const ladder = profile.encounters && profile.encounters.LEVEL_CAPS;
	if (ladder) {
		const row = ladder.find(r => r.order >= from);
		if (!row) return {cap: null, mode: run.rules.levelCap, reason: 'no boss ahead'};
		// The reason line names the run's OWN fight: rival rows carry the
		// triplet's prefix, and the visible variant is the declared rival's.
		const fight = visibleFights(run).find(f =>
			f.order >= from && f.order <= row.order && f.trainer.startsWith(row.trainer));
		const ace = fight ?
			fight.party.reduce((top, mon) => mon.level > top.level ? mon : top, fight.party[0]) :
			null;
		return {
			cap: row.cap,
			mode: run.rules.levelCap,
			trainer: fight ? fight.trainer : row.trainer,
			order: row.order,
			...(ace ? {ace: ace.species} : {}),
			tier: fight ? fightTier(profile, fight.trainer) : 'boss',
		};
	}
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
function splitPrep(run, options) {
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
	// The split's field pickups: items the overworld hands out inside this
	// split's window that the run has not collected. Prep is exactly this —
	// what to grab BEFORE the boss — and a sheet that omits it sends the
	// player in without the Silk Scarf sitting two routes back.
	const pickups = [];
	if (!here.finished && profile.oracle.itemsObtainableBy) {
		const carried = new Set(run.box.map(mon => mon.item).filter(Boolean));
		for (const item of profile.oracle.itemsObtainableBy(here.order)) {
			if (run.bag[item.name] || carried.has(item.name)) continue;
			pickups.push({
				name: item.name,
				kind: item.kind,
				location: item.location,
				opensAt: item.opensAt,
				// Not yet reachable pickups are listed with their order, so the
				// sheet reads as an itinerary rather than a scavenger hunt.
				reachable: anchorOpen(run, item.opensAt),
			});
		}
	}
	// Play the boss on request: `{rollouts: N}` adjudicates the CURRENT party
	// against the split's boss and pins the measured floor to the sheet. Off
	// by default — the sheet repaints after every command, and a measurement
	// that expensive is asked for, not ambient.
	let adjudication = null;
	if (options && options.rollouts > 0 && !here.finished && run.party.length) {
		const driver = require('./battle-driver');
		const played = driver.adjudicate(run, here.boss, {rollouts: options.rollouts});
		adjudication = {
			trainer: here.boss,
			pWin: played.pWin,
			eDeaths: played.eDeaths,
			pDeathless: played.pDeathless,
			rollouts: played.rollouts,
			policy: 'floor: best forecast move, forced switches only — a lower bound',
		};
	}
	return {
		split: here,
		cap: levelCap(run),
		gauntlet,
		fightsAhead: ahead.length,
		filler,
		pickups,
		adjudication,
	};
}

/** The fights immediately ahead of where the run has got to. */
function upcoming(run, count) {
	// Unbeaten, not merely ahead: a DELAYED fight (Gavi, mandatory but
	// walked past) is still on the road and sorts FIRST — it is owed, and
	// the nearest thing left standing. A skipped OPTIONAL fight is different:
	// never owed, so once declared skipped it is simply not the road.
	const beaten = beatenOrders(run);
	const skipped = new Set(run.skipped || []);
	const optional = getProfile(run.profileId).optionalFights || [];
	return visibleFights(run)
		.filter(fight => !beaten.has(fight.order) &&
			!(skipped.has(fight.order) && optional.includes(fight.trainer)))
		.slice(0, count || 5);
}

/** The debts: mandatory fights walked past and not yet settled. */
function owedFights(run) {
	const skipped = new Set(run.skipped || []);
	if (!skipped.size) return [];
	const optional = getProfile(run.profileId).optionalFights || [];
	return visibleFights(run)
		.filter(fight => skipped.has(fight.order) && !optional.includes(fight.trainer))
		.map(fight => ({trainer: fight.trainer, order: fight.order}));
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
/** The route-rule key for a map under a unit: the whole location for 'area'
 * (a profile without area knowledge falls back to the map itself), the one
 * wild table for 'map'. */
function routeKey(profile, unit, canonicalMap) {
	if (unit === 'area' && profile.oracle.areaOf) {
		const area = profile.oracle.areaOf(canonicalMap);
		if (area !== null) return area;
	}
	return canonicalMap;
}

function routeCatch(run, profile, canonicalMap) {
	const rules = encounterRules(run);
	const target = routeKey(profile, rules.routeUnit, canonicalMap);
	for (const entry of run.log) {
		// A `spend` consumes the route exactly like a catch: the encounter came
		// and went (fled, fainted, out of balls) and the rule does not refund it.
		if (!entry.command || !entry.command.map ||
			(entry.command.kind !== 'catch' && entry.command.kind !== 'spend')) continue;
		if (rules.shiny && entry.command.shiny) continue;
		const where = profile.oracle.encountersOn(entry.command.map);
		if (where && routeKey(profile, rules.routeUnit, where.map) === target) {
			return entry.command;
		}
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
		if (used) answer.used = {species: used.species || null, level: used.level || null};
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
 * Ordering: routes with a known unlock date come first, in the order they
 * open; `open` says whether the run's next fight is at-or-past that date.
 * Maps the availability import never dated carry no `opensAt` and trail in
 * declaration order — absence means "unlock order unknown", not "never".
 */
function unusedRoutes(run, options) {
	const opts = options || {};
	const profile = getProfile(run.profileId);
	requireLayer(profile, 'oracle', 'there are no wild tables to walk');
	const rules = encounterRules(run);
	// One row per unit the route rule counts: under 'area' a multi-floor
	// location is ONE row (its floors are one encounter), under 'map' — and
	// for any profile without area knowledge — every wild table is its own.
	const groups = new Map();
	for (const map of profile.oracle.maps()) {
		const key = routeKey(profile, rules.routeUnit, map.map);
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(map);
	}
	const routes = [];
	for (const members of groups.values()) {
		const entry = {
			name: rules.routeUnit === 'area' && profile.oracle.areaOf ?
				profile.oracle.areaOf(members[0].map) : members[0].name,
		};
		if (members.length === 1) entry.map = members[0].map;
		else entry.maps = members.map(m => m.name);
		// The location opens when its FIRST table does — you are in Granite
		// Cave the moment 1F is, whatever the back floors' dates say. The date
		// is the order of the first fight had standing there, so the map is
		// reachable once that fight is the run's NEXT one, not only after it
		// is beaten — a fresh run must see Route 101 (opensAt 0) open.
		let opensAt;
		for (const map of members) {
			const when = profile.oracle.availabilityOf && profile.oracle.availabilityOf(map.map);
			if (when && when.opensAt !== null &&
				(opensAt === undefined || when.opensAt < opensAt)) {
				opensAt = when.opensAt;
			}
		}
		if (opensAt !== undefined) {
			entry.opensAt = opensAt;
			entry.open = anchorOpen(run, opensAt);
		}
		// Where a catch happened is a fact of the log, not of the ruleset, so it
		// is reported for every run — only its consequences are nuzlocke-gated.
		const used = routeCatch(run, profile, members[0].map);
		if (used) {
			entry.used = {species: used.species || null, level: used.level || null};
			const usedOn = members.length > 1 && profile.oracle.encountersOn(used.map);
			if (usedOn && usedOn.name !== entry.name) entry.used.where = usedOn.name;
		}
		// A held location is being walked past ON PURPOSE; the view says why,
		// and says when the wait has paid off — `ready` means the awaited
		// species' method is open now, so the player can go collect.
		const held = !used && run.holds &&
			run.holds[routeKey(profile, rules.routeUnit, members[0].map)];
		if (held) {
			entry.held = held.for ? {for: held.for} : {};
			if (held.for && profile.oracle.methodOpensAt) {
				const slots = members.flatMap(map =>
					profile.oracle.encountersOn(map.name).mons.filter(mon => mon.species === held.for));
				entry.held.ready = slots.some(slot => {
					const gate = profile.oracle.methodOpensAt(slot.method);
					return gate === null || run.position + 1 >= gate;
				});
			}
		}
		// Best prospects: what a re-roll can actually keep, best odds first,
		// across every table the location holds. Ties broken by table order,
		// which is the game's own slot order.
		const pool = [];
		for (const map of members) {
			const here = encountersOn(run, map.name);
			for (const mon of here.mons) {
				if (mon.dupe) continue;
				pool.push(members.length > 1 ?
					Object.assign({where: here.name}, mon) : mon);
			}
		}
		// The VIEW shows a three-row shortlist; a GRADER must see the whole
		// table — the scout once read this display cap and graded 21 of 131
		// catchable species, which is how Gligar (the single biggest Brawly
		// lever) went unoffered while surf rows it could not use ate the
		// shortlist. `allProspects` is the grader's door.
		entry.best = pool
			.sort((a, b) => (b.odds !== undefined ? b.odds : b.chance) -
				(a.odds !== undefined ? a.odds : a.chance))
			.slice(0, opts.allProspects ? pool.length : 3)
			.map(mon => {
				// A slot whose method waits on an HM is listed — it is still this
				// route's future — but marked, so "best prospects" never quietly
				// promises surfing before Surf exists.
				const gate = profile.oracle.methodOpensAt ?
					profile.oracle.methodOpensAt(mon.method) : null;
				return {
					species: mon.species,
					method: mon.method,
					minLevel: mon.minLevel,
					maxLevel: mon.maxLevel,
					chance: mon.odds !== undefined ? mon.odds : mon.chance,
					...(mon.rod ? {rod: mon.rod} : {}),
					...(mon.where ? {where: mon.where} : {}),
					...(gate !== null && run.position + 1 < gate ? {gated: gate} : {}),
				};
			});
		routes.push(entry);
	}
	routes.sort((a, b) =>
		(a.opensAt === undefined ? 1 : 0) - (b.opensAt === undefined ? 1 : 0) ||
		(a.opensAt !== undefined ? a.opensAt - b.opensAt : 0));
	return {
		order: 'opensAt-then-declaration',
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
		// Available is not the same as free: when the only live route is the
		// egg line, the move comes from the relearner and costs one Heart
		// Scale — the teach command charges it, so this list must say so.
		if (sources.every(s => isEggSource(s) ||
			(s.level !== undefined && s.level > atLevel)) &&
			sources.some(isEggSource)) {
			entry.scale = true;
		}
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

/** Guaranteed-KO cells on one side of a row, and the summed damage on it.
 * A self-KO cell (the side's only damage faints its own user) counts for
 * 'them' but never for 'us': their sacrifice still kills OUR Pokemon, which
 * in this ruleset is permanent — ours costs a Pokemon to buy the KO, and an
 * accountant that called that a clean answer taught Explosion as an upgrade. */
function countKO(row, side) {
	return row.filter(cell => cell[side].guaranteedKO &&
		(side === 'them' || !cell[side].selfKO)).length;
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
function upgradeCandidates(run, mon, spec, base, order) {
	const planner = require('./planner');
	const profile = getProfile(run.profileId);
	const list = [];
	let undatedMovesExcluded = 0;

	// Candidates are drawn at the SPEC's level — the projected cap — not the
	// box's: the board is scored there, and the free candy makes those moves
	// teachable before the fight.
	for (const entry of learnable(run, mon.id, {atLevel: spec.level}).now) {
		const levelRoute = entry.sources.some(source =>
			source.level !== undefined && source.level <= spec.level);
		const eggRoute = entry.sources.some(isEggSource);
		const teachableRoute = entry.sources.some(source => source.source === 'teachable');
		// Only HMs currently have dated story gates. An undated TM/tutor is a
		// legal possibility, not proof the player can use it before this fight.
		// Keep it out of "What to change now" unless a level-up or paid egg route
		// independently makes the same move available.
		const gate = profile.oracle.moveObtainableAt ?
			profile.oracle.moveObtainableAt(entry.move) : null;
		const datedTeachRoute = teachableRoute && gate !== null &&
			(order === undefined || gate <= order);
		const paidEggRoute = eggRoute && !!run.bag[HEART_SCALE];
		if (!levelRoute && !datedTeachRoute && !paidEggRoute) {
			if (teachableRoute && gate === null) undatedMovesExcluded += 1;
			continue;
		}
		const spendsScale = !levelRoute && !datedTeachRoute && paidEggRoute;
		const moves = spec.moves.slice();
		let detail = entry.move;
		if (moves.length >= 4) {
			const dropped = leastUsedMove(moves, base);
			moves[moves.indexOf(dropped)] = entry.move;
			detail = `${entry.move} over ${dropped}`;
		} else {
			moves.push(entry.move);
		}
		if (spendsScale) detail += ' (one Heart Scale)';
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

	// Field pickups the overworld has ALREADY handed out by this fight but the
	// run has not collected: the bag-only view priced no items at all for a
	// player who never recorded pickups, which read as "items do nothing".
	// The detail names where to go get it; a pickup already in the bag or on
	// somebody's mon is not offered twice.
	if (order !== undefined && profile.oracle.itemsObtainableBy) {
		const carried = new Set(run.box.map(mon => mon.item).filter(Boolean));
		for (const pickup of profile.oracle.itemsObtainableBy(order)) {
			if (!planner.holdableItem(pickup.name)) continue;
			if (pickup.name === spec.item) continue;
			if (run.bag[pickup.name] || carried.has(pickup.name)) continue;
			list.push({
				kind: 'pickup',
				detail: `${pickup.name} (pickup @ ${pickup.location})` +
					(spec.item ? ` over ${spec.item}` : ''),
				spec: Object.assign({}, spec, {item: pickup.name}),
			});
		}
	}

	// An evolution the run has already earned is the cheapest upgrade on the
	// board and the one this advisor used to be blind to: a box of level-16+
	// Treeckos graded as Treeckos called Brawly unwinnable when Grovyle wins
	// it. Eligibility is judged at the SPEC's level (the projected cap, same
	// as teaches): a level evo the candy reaches is real, a stone evo is only
	// real with the stone in the bag, a move evo only with the move known.
	for (const step of profile.oracle.evolutionsOf(mon.species)) {
		const eligible =
			(step.method === 'level' && spec.level >= step.level) ||
			(step.method === 'item' && !!run.bag[step.item]) ||
			(step.method === 'move' && spec.moves.includes(step.move));
		if (!eligible) continue;
		list.push({
			kind: 'evolve',
			detail: `evolve into ${step.into}` +
				(step.method === 'item' ? ` (${step.item})` : ''),
			spec: Object.assign({}, spec, {species: step.into}),
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
	return {list, undatedMovesExcluded};
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
	let undatedMovesExcluded = 0;
	run.party.forEach((id, slot) => {
		const mon = requireMon(run, id);
		const base = baseline.grid.map(cell => cell.versus[slot]);
		const candidates = upgradeCandidates(run, mon, specs[slot], base, fight.order);
		undatedMovesExcluded += candidates.undatedMovesExcluded;
		for (const candidate of candidates.list) {
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
		availability: {
			undatedMovesExcluded,
			note: undatedMovesExcluded ?
				'Undated TM and tutor options are withheld until their locations are sourced.' : null,
		},
		upgrades: upgrades.slice(0, ADVICE_LIMIT),
	};
}

/** The last four level-up moves a species knows by a level — a fresh catch's
 * real moveset once the free candy takes it there. TM tuning is the upgrade
 * advisor's job AFTER the catch is real; promising it here would grade a
 * hypothetical nobody has caught by moves nobody has taught. */
function movesAt(profile, species, level) {
	const learned = [];
	for (const pair of profile.oracle.levelUpMoves(species)) {
		if (pair[0] <= level && learned.indexOf(pair[1]) === -1) learned.push(pair[1]);
	}
	return learned.slice(-4);
}

/**
 * What the open, unspent routes could add against the next boss.
 *
 * The Wattson diagnosis, turned into a tool: when a box cannot answer a boss,
 * the fix is usually not a better six but a catch nobody has made yet. This
 * walks every route the availability data says is reachable NOW and still
 * holding its encounter, takes each route's best non-dupe prospects, and
 * grades a hypothetical catch the same way the board grades everything —
 * through `planner.matchup`, at the cap the fight is fought under.
 *
 * `newAnswers` is the number that matters: boss Pokemon this catch KOs that
 * NO current party member can. A catch that only duplicates coverage sorts
 * below one that closes a hole, however hard it hits.
 *
 * The hypothetical is honest about what a fresh catch is: its last four
 * level-up moves at the projected level, the route's real odds of even
 * getting the species, and a level that follows the run's face-value rule —
 * cap-level normally, the wild slot's floor when the slot only spawns above
 * the cap.
 */
function adviseCatches(run, trainer) {
	const planner = require('./planner');
	const profile = getProfile(run.profileId);
	requireLayer(profile, 'oracle', 'there are no wild tables to scout');

	const here = split(run);
	const target = trainer || (here && !here.finished ? here.boss : null);
	if (!target) throw new Error('nothing ahead in the run map to catch for');
	const fight = planner.getFight(target, run.profileId);
	const cap = capAt(run, fight.order);

	// Coverage the party already has, projected the way the board projects it.
	// With no party, every enemy is uncovered and every KO is a new answer.
	let covered = [];
	if (run.party.length) {
		covered = planner.matchup({
			trainer: fight.trainer,
			playerParty: partySpecs(run, {atOrder: fight.order}),
			profileId: run.profileId,
		}).grid.map(cell => cell.versus.some(v => v.us.guaranteedKO && !v.us.selfKO));
	}

	// A held route is being saved on purpose: the scout neither recommends
	// spending it nor forgets it exists — the count travels in the answer.
	const all = unusedRoutes(run, {allProspects: true}).routes
		.filter(route => !route.used && route.open);
	const routes = all.filter(route => !route.held);
	const held = all.length - routes.length;
	// One species can walk three open routes; its row costs the same everywhere.
	const rows = new Map();
	const catches = [];
	let gated = 0;
	for (const route of routes) {
		for (const prospect of route.best) {
			// An open route is not an open slot: surfing water before Surf exists
			// is not a catch anyone can make, so a gated method is skipped and
			// counted, never silently recommended.
			if (prospect.gated !== undefined) {
				gated += 1;
				continue;
			}
			const level = cap !== null ? Math.max(cap, prospect.minLevel) : prospect.maxLevel;
			const moves = movesAt(profile, prospect.species, level);
			if (!moves.length) continue;
			const key = `${prospect.species}@${level}`;
			if (!rows.has(key)) {
				rows.set(key, planner.matchup({
					trainer: fight.trainer,
					playerParty: [{species: prospect.species, level, moves}],
					profileId: run.profileId,
				}).grid.map(cell => cell.versus[0]));
			}
			const row = rows.get(key);
			catches.push({
				// The location is the encounter the catch would SPEND; `name`
				// points at the exact table the prospect walks when they differ.
				area: route.name, name: prospect.where || route.name,
				species: prospect.species, method: prospect.method, chance: prospect.chance,
				level,
				kos: countKO(row, 'us'),
				newAnswers: row.filter((cell, e) =>
					cell.us.guaranteedKO && !cell.us.selfKO && !covered[e]).length,
				kosConceded: countKO(row, 'them'),
				damage: Math.round(sumMax(row, 'us') * 1000) / 1000,
			});
		}
	}
	catches.sort((a, b) => b.newAnswers - a.newAnswers || b.kos - a.kos ||
		a.kosConceded - b.kosConceded || b.damage - a.damage ||
		// Never a coin flip: the same run must produce the same shortlist twice.
		a.name.localeCompare(b.name) || a.species.localeCompare(b.species));
	return {
		trainer: fight.trainer,
		order: fight.order,
		cap,
		routesOpen: routes.length,
		considered: catches.length,
		gated,
		held,
		enemies: covered.length || fight.party.length,
		partyCovers: covered.filter(Boolean).length,
		catches: catches.slice(0, ADVICE_LIMIT),
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
/**
 * Roll the route's one random encounter — the game master's die, for the run
 * played entirely in the browser. Everything a catch would be checked against
 * decides what can come up: the map's real tables, the method's HM gate, and
 * the dupes clause (a dupe "does not count — the player re-rolls", so the
 * roll itself skips them, weighted by the same renormalized odds the routes
 * view prints). The roll is advice with dice in it: nothing is written until
 * the player catches or spends, and both of those still verify everything.
 */
function rollEncounter(run, options) {
	const profile = getProfile(run.profileId);
	requireLayer(profile, 'oracle', 'there are no wild tables to roll on');
	if (!options || !options.map) throw new Error('roll: map is required');
	const random = options.random || Math.random;
	const found = encountersOn(run, options.map);
	if (!found) {
		throw new Error(`no map named ${JSON.stringify(options.map)} has a wild encounter table`);
	}
	if (found.used) {
		throw new Error(`roll: ${found.name} already gave its encounter` +
			(found.used.species ? ` (${found.used.species})` : ' — it was spent'));
	}
	// The die only rolls where the run can stand: a route whose guard fight
	// is unbeaten refuses with the guard's name — Route 110's electric grass
	// is exactly what Camper Gavi is standing in front of.
	const when = profile.oracle.availabilityOf && profile.oracle.availabilityOf(found.map);
	if (when && when.opensAt !== null && !anchorOpen(run, when.opensAt)) {
		const guard = anchorGuard(run, when.opensAt);
		throw new Error(`roll: ${found.name} is not reachable yet — ` +
			(guard ? `${guard.trainer} (#${guard.order}) guards it` :
				`it opens at fight #${when.opensAt}`));
	}
	const methodOpen = method => {
		if (!profile.oracle.methodOpensAt) return true;
		const gate = profile.oracle.methodOpensAt(method);
		return gate === null || run.position + 1 >= gate;
	};
	const methods = [...new Set(found.mons.map(mon => mon.method))].filter(methodOpen);
	if (!methods.length) {
		throw new Error(`roll: no encounter method on ${found.name} is open yet — ` +
			'the HMs that unlock them have not been handed over');
	}
	let method = options.method;
	if (method && !methods.includes(method)) {
		throw new Error(`roll: ${JSON.stringify(method)} is not open on ${found.name}; ` +
			`open methods: ${methods.join(', ')}`);
	}
	if (!method) method = methods.includes('walk') ? 'walk' : methods[0];

	// The pool is what this run can actually keep: dupes are skipped (the
	// clause's own words — they do not count, re-roll), everything else keeps
	// its table weight.
	const pool = found.mons.filter(mon => mon.method === method && !mon.dupe);
	if (!pool.length) {
		throw new Error(`roll: everything ${method} turns up on ${found.name} is a dupe — ` +
			'roll another method or another route');
	}

	// THE LEAD'S ABILITY PULLS THE GRASS — the mainline mechanic the delay
	// strategies are built on: a Static lead makes half of all encounters
	// Electric (Magnet Pull, Steel), when the table has any. This is why a
	// player HOLDS Granite Cave until they own a Static lead: Togedemaru's
	// 5% slot becomes a coin flip. The ability is the run's own record (the
	// catch declared it); no declared ability, no pull — face value, as
	// everything here is.
	const PULLS = {static: 'Electric', magnetpull: 'Steel'};
	const lead = run.party.length ?
		run.box.find(mon => mon.id === run.party[0] && mon.status !== 'dead') : null;
	const pullType = lead && lead.ability ?
		PULLS[String(lead.ability).toLowerCase().replace(/[^a-z]/g, '')] : null;
	let pulled = false;
	let pool2 = pool;
	if (pullType) {
		const calc = require('./calc');
		const gen = calc.Generations.get(8);
		const typed = pool.filter(mon => {
			const species = gen.species.get(calc.toID(mon.species));
			return species && species.types.includes(pullType);
		});
		if (typed.length && random() < 0.5) {
			pool2 = typed;
			pulled = true;
		}
	}

	const total = pool2.reduce((sum, mon) => sum + mon.chance, 0);
	let draw = random() * total;
	let slot = pool2[pool2.length - 1];
	for (const mon of pool2) {
		draw -= mon.chance;
		if (draw < 0) { slot = mon; break; }
	}
	const level = slot.minLevel +
		Math.floor(random() * (slot.maxLevel - slot.minLevel + 1));
	return {
		species: slot.species,
		level,
		method,
		chance: slot.chance,
		map: found.name,
		owned: !!slot.owned,
		...(pulled ? {pull: {ability: lead.ability, type: pullType}} : {}),
	};
}

/**
 * The field items standing on a location: the guided half of "what is here".
 *
 * The ledger's locations are prose ("Route 104", "Mt. Pyre"); maps and areas
 * are identifiers — matching normalizes both and allows a prefix only when
 * what follows is not a digit, so "Mauville" finds Mauville City without
 * "Route 11" ever swallowing Route 110.
 *
 * `collected` is read from the log's own acquires: the Nth ledger row of a
 * name is collected once the log holds N acquires of it. No new command and
 * no new state — picking an item up IS the acquire the bag already records.
 */
function normPlace(name) {
	return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function fieldItems(run, map) {
	const profile = getProfile(run.profileId);
	if (!profile.oracle.fieldItems) return [];
	const names = [];
	const found = profile.oracle.encountersOn(map);
	if (found) {
		names.push(found.name);
		if (profile.oracle.areaOf) {
			const area = profile.oracle.areaOf(found.map);
			if (area) names.push(area);
		}
	} else {
		names.push(map);
	}
	const keys = names.map(normPlace);
	const matches = key => keys.some(place =>
		place === key ||
		(place.startsWith(key) && !/^[0-9]/.test(place.slice(key.length))) ||
		(key.startsWith(place) && !/^[0-9]/.test(key.slice(place.length))));

	const acquired = {};
	for (const entry of run.log) {
		if (!entry.command || entry.command.kind !== 'acquire') continue;
		acquired[entry.command.item] =
			(acquired[entry.command.item] || 0) + (entry.command.count || 1);
	}
	const seen = {};
	return profile.oracle.fieldItems()
		.filter(item => matches(normPlace(item.location)))
		.map(item => {
			seen[item.name] = seen[item.name] || 0;
			const collected = (acquired[item.name] || 0) > seen[item.name];
			seen[item.name] += 1;
			return {
				name: item.name,
				kind: item.kind,
				location: item.location,
				opensAt: item.opensAt,
				open: item.opensAt !== null && anchorOpen(run, item.opensAt),
				collected,
			};
		});
}

/** Do two location labels describe the same playable place? */
function samePlace(left, right) {
	const a = normPlace(left);
	const b = normPlace(right);
	if (!a || !b) return false;
	return a === b ||
		(a.startsWith(b) && !/^[0-9]/.test(a.slice(b.length))) ||
		(b.startsWith(a) && !/^[0-9]/.test(b.slice(a.length)));
}

/**
 * The optional work that is genuinely reachable before the next fight.
 *
 * This is a small status projection, not a second progression engine. Routes
 * come from `unusedRoutes`, item reachability comes from the same anchor used
 * by the guided pickup view, and move timing is a profile capability. That last
 * distinction matters: Run & Bun knows TM/tutor legality but has not imported
 * their locations, so an honest card reports the gap rather than calling every
 * legal move available now.
 */
function preFightOpportunities(run) {
	const next = upcoming(run, 1)[0] || null;
	const empty = {
		before: next ? {trainer: next.trainer, order: next.order} : null,
		encounters: {count: 0, mode: encounterRules(run).onePerRoute ? 'unspent' : 'open', routes: []},
		items: {count: 0, pickups: []},
		moves: {status: 'unknown', available: [], note: 'Move unlock timing is not available for this profile.'},
	};
	if (!next) return empty;

	const rules = encounterRules(run);
	const routes = unusedRoutes(run).routes
		.filter(route => route.open && (!rules.onePerRoute || !route.used) &&
			(!route.held || route.held.ready))
		.map(route => ({
			name: route.name,
			// The browser map selector stores authored map names. Area-grouped
			// routes expose their member names; a single-map route's display name
			// is already the selector value.
			map: route.maps ? route.maps[0] : route.name,
			...(route.held ? {held: route.held} : {}),
		}));
	empty.encounters = {
		count: routes.length,
		mode: rules.onePerRoute ? 'unspent' : 'open',
		routes,
	};

	const profile = getProfile(run.profileId);
	if (profile.oracle.fieldItems) {
		const acquired = {};
		for (const entry of run.log) {
			if (!entry.command || entry.command.kind !== 'acquire') continue;
			acquired[entry.command.item] =
				(acquired[entry.command.item] || 0) + (entry.command.count || 1);
		}
		const seen = {};
		const maps = profile.oracle.maps();
		const pickups = profile.oracle.fieldItems()
			.map(item => {
				seen[item.name] = seen[item.name] || 0;
				const collected = (acquired[item.name] || 0) > seen[item.name];
				seen[item.name] += 1;
				if (collected || item.opensAt === null || !anchorOpen(run, item.opensAt)) return null;
				const found = maps.find(map => samePlace(map.name, item.location) ||
					(profile.oracle.areaOf && samePlace(profile.oracle.areaOf(map.map) || '', item.location)));
				return {
					name: item.name,
					kind: item.kind,
					location: item.location,
					opensAt: item.opensAt,
					...(found ? {map: found.name} : {}),
				};
			})
			.filter(Boolean)
			.sort((a, b) => a.opensAt - b.opensAt ||
				a.location.localeCompare(b.location) || a.name.localeCompare(b.name));
		empty.items = {count: pickups.length, pickups};
	}

	if (profile.oracle.moveAvailability) {
		empty.moves = profile.oracle.moveAvailability();
	}
	return empty;
}

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
	/**
	 * Save a location's encounter ON PURPOSE — the delay strategy, recorded.
	 *
	 * A player rarely spends every route the moment it opens: a few choice
	 * locations are worth holding until a better table unlocks (Petalburg
	 * City's rod offers Croagunk today; its surf water holds Popplio at 50%
	 * once Surf exists). A hold changes no rule — the encounter simply stays
	 * unspent — but recording it lets every advisor stop nagging about the
	 * route, and lets the routes view say WHY it is being walked past and
	 * when the wait pays off.
	 */
	hold(run, command) {
		const profile = getProfile(run.profileId);
		requireLayer(profile, 'oracle', 'there are no encounter tables to hold');
		if (!command.map) throw new Error('hold: map is required');
		const found = profile.oracle.encountersOn(command.map);
		if (!found) {
			throw new Error(`no map named ${JSON.stringify(command.map)} has a wild encounter table`);
		}
		const rules = encounterRules(run);
		const key = routeKey(profile, rules.routeUnit, found.map);
		const label = rules.routeUnit === 'area' ? key : found.name;
		const spent = routeCatch(run, profile, found.map);
		if (spent) {
			throw new Error(`hold: ${label} already gave its encounter ` +
				`(${spent.species || 'spent, nothing kept'}) — there is nothing left to save`);
		}
		if (!run.holds) run.holds = {};
		if (run.holds[key]) {
			throw new Error(`hold: ${label} is already held` +
				`${run.holds[key].for ? ` for ${run.holds[key].for}` : ''}`);
		}
		if (command.for) {
			// The awaited species must actually live somewhere in this location —
			// on ANY method, including ones still gated. Waiting for a ghost is
			// exactly the mistake this check exists to catch.
			const members = profile.oracle.areaOf ?
				profile.oracle.maps().filter(map => profile.oracle.areaOf(map.map) === key) :
				[found];
			const everything = members.flatMap(map => profile.oracle.encountersOn(map.name).mons);
			if (!everything.some(mon => mon.species === command.for)) {
				const roster = [...new Set(everything.map(m => m.species))].slice(0, 12).join(', ');
				throw new Error(`hold: ${command.for} does not appear anywhere on ` +
					`${label}; it holds: ${roster}`);
			}
		}
		run.holds[key] = command.for ? {for: command.for} : {};
		return `held ${label}${command.for ? ` for ${command.for}` : ''} — ` +
			'its encounter stays unspent on purpose';
	},

	/**
	 * The route's encounter came and went with nothing kept: it fled, it
	 * fainted, the balls ran out. A real nuzlocke event the document could not
	 * express — the only way to mark a route used was a catch that never
	 * happened. The played-in-browser mode's "it got away" writes this.
	 */
	spend(run, command) {
		const profile = getProfile(run.profileId);
		requireLayer(profile, 'oracle', 'there are no encounter tables to spend');
		if (!command.map) throw new Error('spend: map is required');
		const found = profile.oracle.encountersOn(command.map);
		if (!found) {
			throw new Error(`no map named ${JSON.stringify(command.map)} has a wild encounter table`);
		}
		const rules = encounterRules(run);
		const key = routeKey(profile, rules.routeUnit, found.map);
		const label = rules.routeUnit === 'area' ? key : found.name;
		const prior = routeCatch(run, profile, found.map);
		if (prior) {
			throw new Error(`spend: ${label} already gave its encounter ` +
				(prior.species ? `(${prior.species})` : '(spent, nothing kept)'));
		}
		// Spending a held location resolves the hold the same way a catch does:
		// the wait is over, however it ended.
		if (run.holds) delete run.holds[key];
		return `${label} spent — ${command.reason || 'the encounter got away'}; nothing kept`;
	},

	/** Release a hold: the location goes back to being ordinary unspent. */
	unhold(run, command) {
		const profile = getProfile(run.profileId);
		requireLayer(profile, 'oracle', 'there are no encounter tables to hold');
		if (!command.map) throw new Error('unhold: map is required');
		const found = profile.oracle.encountersOn(command.map);
		if (!found) {
			throw new Error(`no map named ${JSON.stringify(command.map)} has a wild encounter table`);
		}
		const rules = encounterRules(run);
		const key = routeKey(profile, rules.routeUnit, found.map);
		const label = rules.routeUnit === 'area' ? key : found.name;
		if (!run.holds || !run.holds[key]) {
			throw new Error(`unhold: ${label} is not held`);
		}
		const held = run.holds[key];
		delete run.holds[key];
		return `released the hold on ${label}` +
			`${held.for ? ` (was waiting for ${held.for})` : ''}`;
	},

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
				// The refusal names the LOCATION the rule counts, and the exact
				// table the prior catch came off when they differ — "Granite Cave
				// is spent, its catch was on B1f" reads as a rule; naming only the
				// floor would read as a bug on every other floor.
				const where = rules.routeUnit === 'area' ?
					routeKey(profile, 'area', origin.map) : origin.mapName;
				const priorMap = profile.oracle.encountersOn(prior.map);
				const detail = priorMap && priorMap.name !== where ?
					` on ${priorMap.name}` : '';
				const what = prior.species ? `on ${prior.species}${detail}` :
					`with nothing kept${detail} — it got away`;
				throw new Error(`catch: this run already used its one ${where} ` +
					`encounter ${what} — a location gives one ` +
					'random catch, and releasing or losing it does not refund it');
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

		// A catch that spends a held location resolves the hold — fulfilled or
		// abandoned, either way the wait is over. A shiny-exempt catch spends
		// nothing, so the hold stays.
		if (origin.map && !shinyExempt && run.holds) {
			delete run.holds[routeKey(profile, rules.routeUnit, origin.map)];
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
			// Same derivation the scout uses — movesAt dedupes moves a species
			// relearns at two levels, which the raw slice(-4) did not.
			moves = movesAt(profile, command.species, level);
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

		const facts = observedFacts(command, 'catch');
		const mon = {
			id: `mon-${run.nextId}`,
			species: command.species,
			nickname: command.nickname || null,
			level,
			nature: facts.nature || null,
			ability: facts.ability || null,
			item: command.item || null,
			moves,
			ivs: facts.ivs || {},
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

	/** Record summary-screen facts without pretending unknown values are facts. */
	identify(run, command) {
		const mon = requireMon(run, command.id);
		const facts = observedFacts(command, 'identify');
		const changed = [];
		if (facts.nature) {
			mon.nature = facts.nature;
			changed.push(`nature ${facts.nature}`);
		}
		if (facts.ability) {
			mon.ability = facts.ability;
			changed.push(`ability ${facts.ability}`);
		}
		if (facts.ivs && Object.keys(facts.ivs).length) {
			mon.ivs = Object.assign({}, mon.ivs || {}, facts.ivs);
			changed.push(`${Object.keys(facts.ivs).length} IV` +
				(Object.keys(facts.ivs).length === 1 ? '' : 's'));
		}
		if (!changed.length) {
			throw new Error('identify: record a nature, ability, or at least one IV');
		}
		return `recorded ${mon.species} (${mon.id}): ${changed.join(', ')}`;
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
		// A stone evolution spends the stone; without one in the bag it is not
		// an event this run can record. Same contract as the Heart Scale: the
		// resource is charged where it is used, never assumed.
		if (target.method === 'item') {
			if (!run.bag[target.item]) {
				throw new Error(`evolve: ${mon.species} becomes ${target.into} with a ` +
					`${target.item}; there is none in the bag`);
			}
			run.bag[target.item] -= 1;
			if (!run.bag[target.item]) delete run.bag[target.item];
		}
		// A move evolution (Yanma with Ancient Power) needs the move on the mon
		// as it levels — knowing it is the whole requirement.
		if (target.method === 'move' && !mon.moves.includes(target.move)) {
			throw new Error(`evolve: ${mon.species} becomes ${target.into} by ` +
				`levelling up knowing ${target.move}; it does not know it`);
		}
		const from = mon.species;
		mon.species = target.into;
		return `${from} → ${target.into} (${mon.id})` +
			(target.method === 'item' ? ` (${target.item} spent)` : '');
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
		// An egg move has no field route: it lives down the line, and the Move
		// Reminder hands it over for one Heart Scale. A move with any live free
		// route — a TM, a tutor, a level-up prompt at or below this level — costs
		// nothing; the scale is the relearner's fee, not a tax on moves.
		const relearnerOnly = verdict.sources.every(s =>
			isEggSource(s) || (s.level !== undefined && s.level > mon.level)) &&
			verdict.sources.some(isEggSource);
		if (relearnerOnly) {
			const held = run.bag[HEART_SCALE] || 0;
			if (!held) {
				throw new Error(`teach: ${command.move} is an egg move for ${mon.species} — ` +
					`the relearner charges one Heart Scale, and the bag has ${held}`);
			}
			run.bag[HEART_SCALE] = held - 1;
			if (!run.bag[HEART_SCALE]) delete run.bag[HEART_SCALE];
		}
		const price = relearnerOnly ? ', for one Heart Scale' : '';
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
			return `${mon.species} (${mon.id}) forgot ${command.replace}, learned ${command.move}${price}`;
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
			return `${mon.species} (${mon.id}) forgot ${command.replace}, learned ${command.move}${price}`;
		}
		mon.moves.push(command.move);
		return `${mon.species} (${mon.id}) learned ${command.move}${price}`;
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

	/** Consume from the bag: thrown balls, a used Repel — acquire's other
	 * half, refusing the same way every bag spend in this file refuses. */
	use(run, command) {
		if (!command.item) throw new Error('use: item is required');
		const count = command.count === undefined ? 1 : Number(command.count);
		if (!Number.isInteger(count) || count < 1) {
			throw new Error('use: count must be a positive integer');
		}
		const held = run.bag[command.item] || 0;
		if (held < count) {
			throw new Error(`use: need ${count} ${command.item}, the bag has ${held}`);
		}
		run.bag[command.item] = held - count;
		if (!run.bag[command.item]) delete run.bag[command.item];
		return `used ${count > 1 ? `${count} ` : ''}${command.item}` +
			`${count > 1 ? 's' : ''} (${held - count} left)`;
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
		// Position fast-forwards (beating ahead means the road behind fell on
		// the way); the one way BACK is through a declared skip — beating a
		// skipped fight settles the debt without moving the run.
		const skipped = new Set(run.skipped || []);
		if (skipped.has(fight.order)) {
			skipped.delete(fight.order);
			run.skipped = [...skipped].sort((a, b) => a - b);
			if (!run.skipped.length) delete run.skipped;
			return `beat ${fight.trainer} (#${fight.order}, skipped earlier — ` +
				`still at ${run.position})`;
		}
		if (fight.order <= run.position) {
			throw new Error(`beat: ${fight.trainer} is at ${fight.order}, ` +
				`already behind the run at ${run.position}`);
		}
		run.position = fight.order;
		return `beat ${fight.trainer} (now at ${fight.order})`;
	},

	/**
	 * Walk past a fight ON PURPOSE — Gavi held until the box can afford him.
	 * The declared twin of `hold`: the fight stays on the road (upcoming
	 * lists it first once passed), whatever it guards stays closed, and
	 * beating it later settles the skip without moving the run.
	 */
	skip(run, command) {
		const planner = require('./planner');
		const fight = planner.getFight(command.trainer, run.profileId);
		if (isExcludedVariant(run, fight.trainer)) {
			throw new Error(`skip: this run faces the ${run.rules.rival} rival; ` +
				`${fight.trainer} is a fight it can never see`);
		}
		// Most fights are required IN PLACE — the road goes through them. The
		// profile names the exceptions: DELAYABLE fights are mandatory but
		// reorderable (they stay owed until beaten), OPTIONAL ones are never
		// owed at all.
		const profile = getProfile(run.profileId);
		const delayable = profile.delayableFights || [];
		const optional = profile.optionalFights || [];
		if (!delayable.includes(fight.trainer) && !optional.includes(fight.trainer)) {
			const legal = delayable.concat(optional);
			throw new Error(`skip: ${fight.trainer} is a required fight — the road goes ` +
				'through them. Only these can be walked past: ' +
				(legal.length ? legal.join(', ') : '(none declared for this profile)'));
		}
		const skipped = new Set(run.skipped || []);
		if (skipped.has(fight.order)) {
			throw new Error(`skip: ${fight.trainer} is already being skipped`);
		}
		if (fight.order <= run.position) {
			throw new Error(`skip: ${fight.trainer} is at ${fight.order}, ` +
				`already beaten — a skip is declared before walking past`);
		}
		skipped.add(fight.order);
		run.skipped = [...skipped].sort((a, b) => a - b);
		return `skipping ${fight.trainer} (#${fight.order})` +
			(command.for ? ` — waiting for ${command.for}` : '');
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
		// No trainer named: a wild fight, a self-KO, a hand-kept note. The
		// killer is free text (`of`, e.g. "wild Lillipup") — the map cannot
		// verify the grass, only the trainers on it.
		mon.died = {
			at: run.position,
			...(command.move ? {move: command.move} : {}),
			...(command.of ? {of: command.of} : {}),
		};
		return `${mon.species} (${mon.id}) is gone` +
			(command.of ? ` — ${command.of}${command.move ? `'s ${command.move}` : ''} took it` :
				command.move ? ` — ${command.move} took it` : '');
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
		attemptId: run.attemptId,
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

/**
 * Rank every possible six from the alive box against a fight.
 *
 * The design decision this rides on, measured before it was believed: a grid
 * cell does not depend on which other five you bring — `planner.matchup`
 * builds each cell as its own benchless 1v1 — so the expensive part (the
 * box-wide grid) is computed once through `boxMatrix`, and scoring every
 * C(box,6) six off the cached cells is nearly free. Exhaustive, no pruning.
 *
 * The score is explicit and decomposable, per the co-design: for each enemy,
 * take the six's best answer and sum. An answer is
 *
 *   offense − danger/2 − entry
 *
 *   offense  our best hit as a fraction of their bar (capped at 1) plus a
 *            bonus for a guaranteed KO (+0.5), a possible KO (+0.2), and a
 *            guaranteed KO from the faster side (+0.25 — they may never move)
 *   danger   the same reading of their best hit back, half-weighted
 *   entry    the hit taken on the switch-in turn (them.max, capped at 1) —
 *            bringing your best answer is priced, not free. The LEAD pays no
 *            entry against the enemy's lead: it starts on the field.
 *
 * An enemy no member answers above zero is UNANSWERED: named in the result
 * and charged one point, rather than hidden inside a sum.
 *
 * The lead is marginalised with max, not average — the player picks it with
 * full information — and the argmax lead is reported, with a collapse flag
 * when the choice of lead swings the six by more than 0.75: a six that only
 * works led correctly should say so.
 *
 * L6 on purpose, next to `boxMatrix`, whose projection it inherits verbatim:
 * there is NO party argument, because a caller handing in current levels
 * would rank a team the player will never field. The box comes from the run
 * or the function does not run.
 */
/**
 * The board turned into answer scores: answers[m][e] prices member m into
 * enemy e's column with the entry cost in, `leadFree` with it out (for the
 * enemy-lead column, where the lead is already standing). Rounded so
 * ordering cannot ride floating dust. Shared by the ranker and the playbook
 * so "who answers whom" is one arithmetic, not two.
 */
function answerTable(matrix) {
	const enemies = matrix.grid.map(cell => cell.enemy);
	const clamp1 = value => Math.min(value, 1);
	const round = value => Math.round(value * 1000) / 1000;
	return matrix.box.map((member, m) => enemies.map((enemy, e) => {
		const cell = matrix.grid[e].versus[m];
		// A self-KO fallback cell earns no KO bonus: trading the mon away is
		// not an answer this score should chase (the raw damage still counts).
		const cleanKO = cell.us.guaranteedKO && !cell.us.selfKO;
		const offense = clamp1(cell.us.max) +
			(cleanKO ? 0.5 : cell.us.possibleKO && !cell.us.selfKO ? 0.2 : 0) +
			(cleanKO && cell.speed === 'faster' ? 0.25 : 0);
		const danger = clamp1(cell.them.max) +
			(cell.them.guaranteedKO ? 0.5 : cell.them.possibleKO ? 0.2 : 0);
		return {
			withEntry: round(offense - danger / 2 - clamp1(cell.them.max)),
			leadFree: round(offense - danger / 2),
		};
	}));
}

function rankParties(run, trainer, options) {
	const opts = options || {};
	const matrix = boxMatrix(run, trainer);
	const members = matrix.box;
	const enemies = matrix.grid.map(cell => cell.enemy);
	const round = value => Math.round(value * 1000) / 1000;
	const answers = answerTable(matrix);

	const size = Math.min(PARTY_LIMIT, members.length);
	const star = members.reduce((best, member, m) => {
		const total = answers[m].reduce((sum, cell) => sum + cell.withEntry, 0);
		return best === null || total > best.total ? {m, total} : best;
	}, null).m;

	const collapseThreshold = 0.75;
	function scoreSix(picks) {
		// Every column past the enemy lead is lead-invariant: best answer with
		// the entry cost priced in, and a point charged when nobody clears zero.
		let tailSum = 0;
		const tailUnanswered = [];
		for (let e = 1; e < enemies.length; e++) {
			let top = -Infinity;
			for (const m of picks) top = Math.max(top, answers[m][e].withEntry);
			tailSum += top;
			if (top <= 0) tailUnanswered.push(enemies[e].species);
		}
		// The enemy-lead column moves with the lead choice — including its
		// unanswered penalty. An enemy the chosen lead answers for free is
		// ANSWERED, and marking it unanswered off the entry-priced column was
		// exactly the pessimism the lead marginalisation exists to remove.
		let best = null;
		let worst = null;
		for (const lead of picks) {
			let leadColumn = -Infinity;
			for (const m of picks) {
				leadColumn = Math.max(leadColumn,
					m === lead ? answers[m][0].leadFree : answers[m][0].withEntry);
			}
			const total = round(tailSum + leadColumn -
				tailUnanswered.length - (leadColumn <= 0 ? 1 : 0));
			if (best === null || total > best.total) {
				best = {lead, total, leadUnanswered: leadColumn <= 0};
			}
			if (worst === null || total < worst.total) worst = {lead, total};
		}
		return {
			score: best.total,
			lead: best.lead,
			leadCollapse: best.total - worst.total > collapseThreshold,
			unanswered: best.leadUnanswered ?
				[enemies[0].species, ...tailUnanswered] : tailUnanswered,
		};
	}

	// One pass over every combination: top N, the best six without the star
	// member, and the best six per argmax lead (for the different-lead pick).
	const keep = opts.top || 10;
	const top = [];
	let withoutStar = null;
	const bestPerLead = new Map();
	const picks = Array.from({length: size}, (unused, i) => i);
	const key = list => list.join(',');
	const compareScored = (a, b) =>
		b.score - a.score || a.pickKey.localeCompare(b.pickKey);
	function retainTop(scored) {
		if (top.length < keep) {
			top.push(scored);
			top.sort(compareScored);
			return;
		}
		// Most combinations cannot enter the shortlist. Do not repeatedly sort
		// batches of losing candidates: compare with the current floor first and
		// only reorder the bounded top N when that floor actually changes.
		if (compareScored(scored, top[top.length - 1]) < 0) {
			top[top.length - 1] = scored;
			top.sort(compareScored);
		}
	}
	for (;;) {
		const scoredPicks = picks.slice();
		const scored = Object.assign({picks: scoredPicks, pickKey: key(scoredPicks)},
			scoreSix(picks));
		retainTop(scored);
		if (!picks.includes(star) && (!withoutStar || scored.score > withoutStar.score)) {
			withoutStar = scored;
		}
		const perLead = bestPerLead.get(scored.lead);
		if (!perLead || scored.score > perLead.score) bestPerLead.set(scored.lead, scored);
		// Next combination in lexicographic order.
		let i = size - 1;
		while (i >= 0 && picks[i] === members.length - size + i) i--;
		if (i < 0) break;
		picks[i]++;
		for (let j = i + 1; j < size; j++) picks[j] = picks[j - 1] + 1;
	}

	function present(scored, label) {
		// The per-enemy assignment: which member answers which — the next thing
		// a player does with a six is decide who takes what.
		const perEnemy = enemies.map((enemy, e) => {
			let bestMember = null;
			let bestValue = -Infinity;
			for (const m of scored.picks) {
				const value = e === 0 && m === scored.lead ?
					answers[m][0].leadFree : answers[m][e].withEntry;
				if (value > bestValue) { bestValue = value; bestMember = m; }
			}
			return {enemy: enemy.species, answeredBy: members[bestMember].id,
				answers: round(bestValue)};
		});
		return {
			label,
			score: scored.score,
			members: scored.picks.map(m => ({id: members[m].id,
				species: members[m].species, nickname: members[m].nickname,
				level: members[m].level})),
			lead: members[scored.lead].id,
			leadCollapse: scored.leadCollapse,
			unanswered: scored.unanswered,
			perEnemy,
		};
	}

	const parties = top.map((scored, i) => present(scored, i === 0 ? 'top' : null));
	if (withoutStar && !top.some(t => key(t.picks) === key(withoutStar.picks))) {
		parties.push(present(withoutStar, `diversity: without ${members[star].species}`));
	}
	const topLead = top.length ? top[0].lead : null;
	let otherLead = null;
	for (const scored of bestPerLead.values()) {
		if (scored.lead !== topLead && (!otherLead || scored.score > otherLead.score)) {
			otherLead = scored;
		}
	}
	if (otherLead && !top.some(t => key(t.picks) === key(otherLead.picks)) &&
		(!withoutStar || key(otherLead.picks) !== key(withoutStar.picks))) {
		parties.push(present(otherLead, 'diversity: different lead'));
	}

	// ADJUDICATION: the grid is a full-HP damage matrix — it knows nothing of
	// speed order or attrition, and it has called a wipe "all answered" (a
	// 3.28 six lost 30/30 Brawly rollouts while a 0.62 six won 26/30, the
	// finding that opened this ledger question). So the top candidates are
	// PLAYED: seeded rollouts under the assignment-following policy, and what
	// actually happened outranks what the matrix predicted. The floor caveat
	// is real — a mechanical player underestimates every six — but it
	// underestimates them all with the same hands, which is what a ranking
	// needs. `rollouts: 0` turns it off.
	const rollouts = opts.rollouts === undefined ? 12 : opts.rollouts;
	if (rollouts > 0 && parties.length) {
		const driver = require('./battle-driver');
		const adjudicated = Math.min(opts.adjudicate === undefined ? 4 : opts.adjudicate,
			parties.length);
		for (let i = 0; i < adjudicated; i++) {
			const party = parties[i];
			const staged = Object.assign({}, run, {party: party.members.map(m => m.id)});
			const answerFor = {};
			for (const entry of party.perEnemy) {
				const slot = party.members.findIndex(m => m.id === entry.answeredBy);
				if (slot >= 0) answerFor[entry.enemy] = `player-${slot + 1}`;
			}
			party.adjudication = driver.adjudicate(staged, matrix.trainer,
				{rollouts, answerFor});
		}
		// Played beats predicted: adjudicated parties sort by what happened
		// (wins, then deaths), the grid score only breaks ties; the un-played
		// tail keeps its grid order behind them.
		const played = parties.slice(0, adjudicated);
		played.sort((a, b) =>
			b.adjudication.pWin - a.adjudication.pWin ||
			a.adjudication.eDeaths - b.adjudication.eDeaths ||
			b.score - a.score);
		parties.splice(0, adjudicated, ...played);
		// 'top' is a claim about the whole ranking, and the ranking changed.
		parties.forEach((party, i) => {
			if (party.label === 'top') party.label = null;
			if (i === 0) party.label = 'top';
		});
	}

	return {
		trainer: matrix.trainer,
		order: matrix.order,
		projection: matrix.projection,
		boxSize: members.length,
		combinations: top.length ? countCombinations(members.length, size) : 0,
		adjudication: rollouts > 0 ? {
			rollouts,
			policy: 'assignment-following floor — pWin is a lower bound and a comparison key, never a promise',
		} : null,
		caveats: [
			'the set score assumes you can always switch to the chosen answer; the entry cost prices the switch-in hit, not a blocked switch',
			'a cell reports the best DAMAGING action; the opponent may prefer a status move it scores higher',
			...(matrix.grid.length && require('./planner').getFight(matrix.trainer, run.profileId).isDouble ?
				['this is a double battle, planned as Singles — see plannedAsSingles'] : []),
		],
		parties,
	};
}

function countCombinations(n, k) {
	let result = 1;
	for (let i = 0; i < k; i++) result = result * (n - i) / (i + 1);
	return Math.round(result);
}

/**
 * The full fight plan for the CURRENT party against one trainer: who answers
 * whom (the ranker's own arithmetic, restricted to the six that will
 * actually walk in), what each answer hits with and what hits back, and the
 * fight PLAYED — odds, the outcome spread, and one representative rollout's
 * turn-by-turn line. Everything a player wants taped to the monitor before
 * a boss, sourced from the same tables and the same tape deck as everything
 * else, so the plan can never disagree with the ranker or the recreation.
 */
function fightPlaybook(run, trainer, options) {
	const opts = options || {};
	if (!run.party.length) {
		throw new Error('playbook: set a party first — the plan is the party\'s');
	}
	const driver = require('./battle-driver');
	const matrix = boxMatrix(run, trainer);
	const members = matrix.box;
	const enemies = matrix.grid.map(cell => cell.enemy);
	const answers = answerTable(matrix);
	const picks = run.party
		.map(id => members.findIndex(member => member.id === id))
		.filter(index => index >= 0);
	const lead = picks[0];

	// Who answers whom — the same scores the ranker assigns with, plus the
	// concrete cell behind the assignment: the move, the damage, the threat.
	const assignments = enemies.map((enemy, e) => {
		let bestMember = null;
		let bestValue = -Infinity;
		for (const m of picks) {
			const value = e === 0 && m === lead ?
				answers[m][0].leadFree : answers[m][e].withEntry;
			if (value > bestValue) { bestValue = value; bestMember = m; }
		}
		const cell = matrix.grid[e].versus[bestMember];
		const pct = value => Math.round(value * 100);
		return {
			enemy: enemy.species,
			enemyLevel: enemy.level,
			answeredBy: members[bestMember].id,
			answer: members[bestMember].species,
			answerNickname: members[bestMember].nickname,
			move: cell.us.move,
			damage: {min: pct(cell.us.min), max: pct(cell.us.max),
				guaranteedKO: !!cell.us.guaranteedKO},
			speed: cell.speed,
			threat: {move: cell.them.move, max: pct(cell.them.max),
				guaranteedKO: !!cell.them.guaranteedKO},
			answered: bestValue > 0,
		};
	});

	const slotOf = id => {
		const slot = run.party.indexOf(id);
		return slot >= 0 ? `player-${slot + 1}` : null;
	};
	const answerForOf = plan => {
		const answerFor = {};
		for (const assignment of plan) {
			const slot = slotOf(assignment.answeredBy);
			if (slot) answerFor[assignment.enemy] = slot;
		}
		return answerFor;
	};

	// ASSIGNMENT OPTIMIZATION — the ranker's lesson applied one level down.
	// The paper assignment is a full-HP turn-zero claim; a Speed Boost
	// Combusken makes it two turns stale before the answer even switches in.
	// So the runner-up answer for each contested column is TRIED: every
	// variant is played (short rollouts, same seeds), and whichever
	// assignment map actually wins the most keeps the job. Bounded: the four
	// most contested columns, 16 variants, so the answer arrives while the
	// question still matters.
	const rollouts = opts.rollouts === undefined ? 12 : opts.rollouts;
	const optimize = opts.optimize === undefined ? true : !!opts.optimize;
	let explored = 0;
	let chosen = assignments;
	if (optimize && picks.length > 1) {
		const contested = [];
		for (let e = 0; e < enemies.length; e++) {
			const scored = picks.map(m => ({
				member: m,
				value: e === 0 && m === lead ? answers[m][0].leadFree : answers[m][e].withEntry,
			})).sort((a, b) => b.value - a.value);
			if (scored.length > 1 && scored[1].value > -Infinity &&
				members[scored[0].member].id === assignments[e].answeredBy) {
				contested.push({e, runnerUp: members[scored[1].member].id,
					gap: scored[0].value - scored[1].value});
			}
		}
		contested.sort((a, b) => a.gap - b.gap);
		const flips = contested.slice(0, 4);
		const variants = [];
		for (let mask = 0; mask < (1 << flips.length); mask++) {
			const plan = assignments.map(entry => Object.assign({}, entry));
			flips.forEach((flip, bit) => {
				if (mask & (1 << bit)) {
					const member = members.find(entry => entry.id === flip.runnerUp);
					const cell = matrix.grid[flip.e].versus[
						members.findIndex(entry => entry.id === flip.runnerUp)];
					const pct = value => Math.round(value * 100);
					Object.assign(plan[flip.e], {
						answeredBy: member.id,
						answer: member.species,
						answerNickname: member.nickname,
						move: cell.us.move,
						damage: {min: pct(cell.us.min), max: pct(cell.us.max),
							guaranteedKO: !!cell.us.guaranteedKO},
						speed: cell.speed,
						threat: {move: cell.them.move, max: pct(cell.them.max),
							guaranteedKO: !!cell.them.guaranteedKO},
						playedOver: assignments[flip.e].answer,
					});
				}
			});
			variants.push(plan);
		}
		explored = variants.length;
		let best = null;
		for (const plan of variants) {
			const trial = driver.adjudicate(run, matrix.trainer, {
				rollouts: Math.min(4, rollouts),
				answerFor: answerForOf(plan),
			});
			const keyOf = trial.pWin * 1000 - trial.eDeaths;
			if (best === null || keyOf > best.keyOf) best = {plan, keyOf};
		}
		if (best) chosen = best.plan;
	}
	const played = driver.playbook(run, matrix.trainer, {
		rollouts,
		answerFor: answerForOf(chosen),
		...(opts.seedBase !== undefined ? {seedBase: opts.seedBase} : {}),
	});

	return {
		trainer: matrix.trainer,
		order: matrix.order,
		projection: matrix.projection,
		party: run.party.map(id => {
			const member = members.find(entry => entry.id === id);
			return member ? {id, species: member.species, nickname: member.nickname,
				level: member.level} : {id};
		}),
		assignments: chosen,
		explored,
		odds: played.odds,
		outcomes: played.outcomes,
		line: played.line,
		policy: 'floor: assignment switches + best forecast move — a lower bound, not a promise',
	};
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
		// Mandatory fights walked past and not settled: the run's open debts.
		owed: owedFights(run),
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
	adviseUpgrades, adviseCatches, rankParties, fightPlaybook, summarize, rollEncounter, fieldItems,
	preFightOpportunities,
};
