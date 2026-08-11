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
 * `party`, `beat`, `faint`, `release` — because a playthrough really is that
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
function createRun(options) {
	const opts = options || {};
	const profileId = opts.profileId || undefined;
	const profile = getProfile(profileId);
	const mode = opts.levelCap || 'next-milestone-ace';
	if (!LEVEL_CAP_MODES.has(mode)) {
		throw new Error(`unknown level cap mode ${JSON.stringify(mode)}`);
	}
	if (opts.rival !== undefined && opts.rival !== null &&
		!['Sceptile', 'Blaziken', 'Swampert'].includes(opts.rival)) {
		throw new Error(`unknown rival ${JSON.stringify(opts.rival)}; ` +
			'the rival is named for their ace: Sceptile, Blaziken or Swampert');
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
			// The nuzlocke ruleset, off by default. When on: a fainted Pokemon can
			// never re-enter the party, a map's wild table gives ONE catch for the
			// whole run (the encounter is random — the player reports what came up),
			// and a species whose evolution line is already in the box does not
			// count (the dupes clause: re-roll and report the non-dupe). Kept under
			// its historical field name so older saves stay readable.
			permadeath: !!opts.permadeath,
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
	const pattern = getProfile(run.profileId).encounters.RIVAL_VARIANT_PATTERN;
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
	const boss = profile.encounters.BOSS_PATTERN || profile.encounters.MILESTONE_PATTERN;
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
	const pattern = profile.encounters.MILESTONE_PATTERN;
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
 * The base form a species' evolution line is named for — the identity the
 * dupes clause compares. A Mightyena is a dupe of a caught Poochyena and the
 * other way around, because they are the same line.
 */
function familyOf(profile, species) {
	const line = profile.oracle.lineageOf(species);
	return line.length ? line[line.length - 1] : species;
}

/**
 * The catch this run already made on a map, if any — from the log, because the
 * box forgets: releasing or losing the catch does not refund the route.
 */
function routeCatch(run, profile, canonicalMap) {
	for (const entry of run.log) {
		if (!entry.command || entry.command.kind !== 'catch' || !entry.command.map) continue;
		const where = profile.oracle.encountersOn(entry.command.map);
		if (where && where.map === canonicalMap) return entry.command;
	}
	return null;
}

function encountersOn(run, map) {
	const profile = getProfile(run.profileId);
	const found = profile.oracle.encountersOn(map);
	if (!found) return null;
	const owned = new Set(run.box.map(mon => mon.species));
	const mons = found.mons.map(mon => Object.assign({owned: owned.has(mon.species)}, mon));
	const answer = {map: found.map, name: found.name, mons};

	// Under the nuzlocke rules the list is not a menu, it is a forecast: the
	// encounter is random, so each row carries its table odds, dupes are marked
	// (they do not count — the player re-rolls), and `odds` renormalizes the
	// chance over what can actually be kept. Per method, because walking and
	// fishing are separate dice.
	if (run.rules.permadeath) {
		const families = new Set(run.box.map(mon => familyOf(profile, mon.species)));
		const liveByMethod = {};
		for (const mon of mons) {
			mon.dupe = families.has(familyOf(profile, mon.species));
			if (!mon.dupe) {
				liveByMethod[mon.method] = (liveByMethod[mon.method] || 0) + mon.chance;
			}
		}
		for (const mon of mons) {
			mon.odds = mon.dupe || !liveByMethod[mon.method] ? 0 :
				Math.round(mon.chance / liveByMethod[mon.method] * 1000) / 10;
		}
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
function learnable(run, id) {
	const mon = requireMon(run, id);
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
		if (gated && soonest > mon.level) later.push(entry);
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

		// The nuzlocke encounter rules, on wild catches only — a gift, static or
		// trade (no map) is not the route's random encounter and stays exempt.
		if (run.rules.permadeath && origin.map) {
			const prior = routeCatch(run, profile, origin.map);
			if (prior) {
				throw new Error(`catch: this run already used its one ${origin.mapName} ` +
					`encounter on ${prior.species} — a route gives one random catch, ` +
					'and releasing or losing it does not refund it');
			}
			const family = familyOf(profile, command.species);
			const dupe = run.box.find(mon => familyOf(profile, mon.species) === family);
			if (dupe) {
				throw new Error(`catch: ${command.species} is a dupe of ${dupe.species} ` +
					`(${dupe.id}) — same evolution line, so it does not count; ` +
					're-roll and report what came up instead');
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
		mon.status = 'dead';
		run.party = run.party.filter(id => id !== mon.id);
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
		permadeath: run.rules.permadeath,
		rival: run.rules.rival,
	});
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
	VERSION, PARTY_LIMIT, LEVEL_CAP_MODES, COMMANDS,
	createRun, apply, applyAll, undo,
	findMon, levelCap, capAt, upcoming, milestones, split, splitPrep, fightTier, isExcludedVariant,
	encountersOn, unusedRoutes, learnable, partySpecs, planNext, boxMatrix, summarize,
};
