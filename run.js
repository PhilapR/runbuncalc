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
 * `next-milestone-ace` is the convention most Run & Bun players actually use:
 * you may not exceed the level of the highest Pokemon in the next story fight.
 * It is computed from the run map rather than declared, which means it is real
 * data rather than a number somebody typed.
 *
 * `none` is the honest default. A hard cap is a self-imposed rule, and turning
 * it on for everyone would refuse levels that are perfectly legal in the game.
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
	const mode = opts.levelCap || 'none';
	if (!LEVEL_CAP_MODES.has(mode)) {
		throw new Error(`unknown level cap mode ${JSON.stringify(mode)}`);
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
			// Permadeath is the nuzlocke rule, off by default. When on, a fainted
			// Pokemon can never re-enter the party.
			permadeath: !!opts.permadeath,
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
 * The level ceiling this run is playing under, and where it comes from.
 *
 * Returned with the fight that sets it, not as a bare number: "capped at 20" is
 * a rule, "capped at 20 by Leader Brawly's Kubfu" is a reason, and a player
 * arguing with the cap needs the reason.
 */
function levelCap(run) {
	if (run.rules.levelCap === 'none') return {cap: null, mode: 'none'};
	const profile = getProfile(run.profileId);
	const pattern = profile.encounters.MILESTONE_PATTERN;
	const planner = require('./planner');
	const fights = planner.loadRunMap(run.profileId)
		.filter(f => f.order > run.position)
		.filter(f => !pattern || pattern.test(f.trainer));
	if (!fights.length) return {cap: null, mode: run.rules.levelCap, reason: 'no milestone ahead'};
	const next = fights[0];
	const ace = next.party.reduce((top, mon) => mon.level > top.level ? mon : top, next.party[0]);
	return {
		cap: ace.level,
		mode: run.rules.levelCap,
		trainer: next.trainer,
		order: next.order,
		ace: ace.species,
	};
}

/** The fights immediately ahead of where the run has got to. */
function upcoming(run, count) {
	return require('./planner').upcoming(run.position, count || 5, run.profileId);
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
	return require('./planner').loadRunMap(run.profileId)
		.filter(fight => pattern.test(fight.trainer))
		.map(fight => ({
			trainer: fight.trainer,
			order: fight.order,
			beaten: fight.order <= run.position,
		}));
}

/** What can be caught on a map, with what the run already holds marked. */
function encountersOn(run, map) {
	const profile = getProfile(run.profileId);
	const found = profile.oracle.encountersOn(map);
	if (!found) return null;
	const owned = new Set(run.box.map(mon => mon.species));
	return {
		map: found.map,
		name: found.name,
		mons: found.mons.map(mon => Object.assign({owned: owned.has(mon.species)}, mon)),
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

/** The run's party as `team.js` specs, ready for the planner. */
function partySpecs(run) {
	return run.party.map(id => {
		const mon = requireMon(run, id);
		return {
			species: mon.species,
			level: mon.level,
			nature: mon.nature,
			ability: mon.ability,
			item: mon.item,
			moves: mon.moves,
			ivs: mon.ivs || {},
		};
	});
}

/**
 * What the next fight does against the current party.
 *
 * The whole stack in one call: the run says who you are and where you are, the
 * map says who is next, and the planner says what they do about it.
 */
function planNext(run, options) {
	const opts = options || {};
	if (!run.party.length) {
		throw new Error('the party is empty: add Pokemon to the party before planning');
	}
	const ahead = upcoming(run, 1);
	const trainer = opts.trainer || (ahead.length ? ahead[0].trainer : null);
	if (!trainer) throw new Error('nothing ahead in the run map to plan against');
	return require('./planner').predict({
		trainer,
		playerParty: partySpecs(run),
		profileId: run.profileId,
	});
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
	const slot = command.method ?
		byLevel.find(s => s.method === command.method) || byLevel[0] :
		byLevel[0];
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

		// Default the moveset to what the species would actually know at this
		// level. A caught Pokemon arrives with moves; making the player type four
		// of them before the entry is usable would make catching feel like data
		// entry rather than playing.
		//
		// Explicit moves are checked for legality, because an unchecked list here
		// would be a bypass around everything `teach` enforces.
		let moves;
		if (command.moves && command.moves.length) {
			moves = command.moves.slice(0, 4);
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

	/** Set a Pokemon's level, respecting the run's cap. */
	levelUp(run, command) {
		const mon = requireMon(run, command.id);
		const to = Number(command.to);
		if (!Number.isInteger(to) || to < 1 || to > 100) {
			throw new Error('levelUp: to must be an integer from 1 to 100');
		}
		if (to < mon.level) {
			throw new Error(`levelUp: ${mon.species} is already level ${mon.level}; ` +
				'levels do not go down');
		}
		const cap = levelCap(run);
		if (cap.cap !== null && to > cap.cap) {
			throw new Error(`levelUp: the cap is ${cap.cap} ` +
				`(${cap.trainer}'s ${cap.ace}); ${to} is over it`);
		}
		const from = mon.level;
		mon.level = to;
		return `${mon.species} (${mon.id}) ${from} → ${to}`;
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
	const summary = handler(next, command);
	next.updatedAt = opts.now || run.updatedAt;
	next.log.push({command: clone(command), summary, at: opts.now || null});
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
	});
	const replay = run.log.slice(0, -1);
	const rebuilt = applyAll(fresh, replay.map(entry => entry.command));
	rebuilt.log = clone(replay);
	rebuilt.updatedAt = replay.length ? replay[replay.length - 1].at : run.createdAt;
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
	findMon, levelCap, upcoming, milestones, encountersOn, learnable, partySpecs, planNext,
	summarize,
};
