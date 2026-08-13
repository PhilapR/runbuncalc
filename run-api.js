/* eslint-env node, es6 */
'use strict';

/**
 * The /run/* surface with the transport peeled off: payload in, JSON body out.
 *
 * `server.js` serves these over express; the demo build bundles this same file
 * into the page and serves them from a `fetch` shim — one implementation, two
 * transports, so the demo can never drift into a second set of rules.
 *
 * Refusals THROW, carrying the status and code the HTTP layer (real or
 * shimmed) should answer with: a malformed run is `InvalidRun`, a command the
 * game would refuse is `InvalidRunCommand`, and anything without a status is
 * a genuine bug that must keep crashing loudly.
 */

const runtime = require('./run');
const battleDriver = require('./battle-driver');

function refusal(message, code) {
	const error = new Error(message);
	error.statusCode = 400;
	error.code = code;
	return error;
}

function isRecord(value) {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Shared shape check, so every endpoint refuses a malformed run the same way.
 *
 * A version stamp is not a document. `run.js` reads `rules.levelCap`, iterates
 * `box`, `party` and `log` and clones `bag` without re-checking any of it —
 * correctly, because it is handed runs it built itself. Over the wire the run
 * arrives from a client, so a hand-written `{"version":1}` or a truncated save
 * used to reach `summarize` and come out a 500. Every field the run layer
 * assumes is checked here, once, and the failure names the field.
 */
function requireRun(payload) {
	if (!payload || typeof payload.run !== 'object' || payload.run === null) {
		throw refusal('run is required', 'InvalidRun');
	}
	const run = payload.run;
	if (run.version !== runtime.VERSION) {
		throw refusal(`run is version ${run.version}; this server reads version ${runtime.VERSION}`,
			'RunVersionMismatch');
	}
	if (!isRecord(run.rules) || typeof run.rules.levelCap !== 'string') {
		throw refusal('run.rules must be an object with a levelCap string', 'InvalidRun');
	}
	for (const field of ['box', 'log']) {
		if (!Array.isArray(run[field])) {
			throw refusal(`run.${field} must be an array`, 'InvalidRun');
		}
	}
	// The party holds ids into the box, not Pokemon; anything else makes the
	// lookup in `summarize` read a property of null.
	if (!Array.isArray(run.party) || run.party.some(id => typeof id !== 'string')) {
		throw refusal('run.party must be an array of box ids', 'InvalidRun');
	}
	// ...and each id must actually resolve, or that null-read happens anyway.
	const boxIds = new Set(run.box.map(entry => entry && entry.id).filter(Boolean));
	const missing = run.party.find(id => !boxIds.has(id));
	if (missing !== undefined) {
		throw refusal(`run.party names ${JSON.stringify(missing)}, which is not in run.box`,
			'InvalidRun');
	}
	if (!isRecord(run.bag)) {
		throw refusal('run.bag must be an object', 'InvalidRun');
	}
	for (const field of ['position', 'nextId']) {
		if (typeof run[field] !== 'number' || !Number.isFinite(run[field])) {
			throw refusal(`run.${field} must be a number`, 'InvalidRun');
		}
	}
	return run;
}

/**
 * The battle bundle round-trips through the client between turns, so it is
 * as untrusted as the run: a truncated or hand-edited bundle used to reach
 * the driver's first `state.sides.player` read and come out a 500. This
 * checks the spine the driver walks before any turn resolves — deep enough
 * to keep garbage out, shallow enough that a real bundle always passes.
 */
function requireBattle(payload) {
	const bundle = (payload || {}).battle;
	if (!isRecord(bundle) || !isRecord(bundle.state)) {
		throw refusal('battle is required — send the bundle from /run/battle/start',
			'InvalidBattle');
	}
	const sides = bundle.state.sides;
	if (!isRecord(sides) || !isRecord(sides.player) || !isRecord(sides.ai) ||
		!Array.isArray(sides.player.party) || !Array.isArray(sides.ai.party)) {
		throw refusal('battle.state is not a battle — send the bundle unaltered',
			'InvalidBattle');
	}
	for (const field of ['seed', 'step']) {
		if (!Number.isInteger(bundle[field])) {
			throw refusal(`battle.${field} must be an integer`, 'InvalidBattle');
		}
	}
	return bundle;
}

/**
 * Errors from `run.js` are almost all the player being told why something
 * could not have happened — a species that is not on that route, a move the
 * species cannot hold. Those become 400s with the message intact, because the
 * message IS the feature. Anything else re-throws untouched.
 */
function asRefusal(error) {
	if (/^[A-Z][a-z].*(does not|cannot|is not|has no)|^no |^teach:|^evolve:|^catch:|^levelUp:|^party:|^give:|^take:|^beat:|^acquire:|^use:|^faint:|^heartScale:|^hold:|^unhold:|^spend:|^roll:|^battle:|^playbook:|^unknown |^a command needs|^nothing |^the party is empty|^a party holds/.test(error.message || '')) {
		error.statusCode = 400;
		error.code = 'InvalidRunCommand';
	}
	throw error;
}

/** Run the work; engine refusals become 400s, typed refusals pass through. */
function guarded(work) {
	try {
		return work();
	} catch (error) {
		if (error.statusCode) throw error;
		return asRefusal(error);
	}
}

const api = {
	new(payload) {
		payload = payload || {};
		try {
			return {
				run: runtime.createRun({
					profileId: payload.profile,
					name: payload.name,
					levelCap: payload.levelCap,
					permadeath: payload.permadeath,
					// The encounter rules, each its own toggle; omitted they follow
					// the permadeath flag as the nuzlocke preset.
					onePerRoute: payload.onePerRoute,
					dupesClause: payload.dupesClause,
					shinyClause: payload.shinyClause,
					routeUnit: payload.routeUnit,
					rival: payload.rival || null,
					now: payload.now || null,
				}),
			};
		} catch (error) {
			throw refusal(error.message, 'InvalidRun');
		}
	},

	apply(payload) {
		const state = requireRun(payload);
		return guarded(() => {
			const next = runtime.apply(state, (payload || {}).command,
				{now: (payload || {}).now || null});
			return {
				run: next,
				summary: next.log[next.log.length - 1].summary,
				status: runtime.summarize(next),
			};
		});
	},

	undo(payload) {
		const state = requireRun(payload);
		return guarded(() => {
			const undone = runtime.undo(state);
			return {run: undone, status: runtime.summarize(undone)};
		});
	},

	status(payload) {
		const state = requireRun(payload);
		return guarded(() => {
			// How far ahead to look is the client's call — a panel showing the
			// road ahead wants more than a CLI status line — but bounded, because
			// upcoming parties are heavy and nobody plans 50 fights out.
			const wanted = Number((payload || {}).upcomingCount);
			const count = Number.isInteger(wanted) ? Math.min(Math.max(wanted, 1), 20) : 5;
			return {
				status: runtime.summarize(state),
				box: state.box,
				// The story spine travels with every status: "where am I" over a
				// 362-battle map is answered in milestones, not a position integer.
				milestones: runtime.milestones(state),
				// And so does the split sheet — it is how the run is narrated, and
				// small (boss-tier fights only), so every redraw stays current.
				splitPrep: runtime.splitPrep(state),
				upcoming: runtime.upcoming(state, count).map(fight => ({
					trainer: fight.trainer,
					order: fight.order,
					partySize: fight.party.length,
					topLevel: Math.max(...fight.party.map(mon => mon.level)),
					// 'boss' ends a split, 'story' is a mandatory fight that sets the
					// cap, null is route filler a client may render quietly.
					tier: runtime.fightTier(
						require('./profiles').getProfile(state.profileId), fight.trainer),
				})),
			};
		});
	},

	where(payload) {
		const state = requireRun(payload);
		return guarded(() => {
			const found = runtime.encountersOn(state, (payload || {}).map);
			if (!found) {
				throw refusal(`no map named ${JSON.stringify((payload || {}).map)} ` +
					'has a wild encounter table', 'UnknownMap');
			}
			// What is here is encounters AND items: the ledger's field pickups
			// standing on this location ride the same answer, so a client can
			// guide the player without a second question.
			return Object.assign({}, found, {items: runtime.fieldItems(state, (payload || {}).map)});
		});
	},

	learnable(payload) {
		const state = requireRun(payload);
		return guarded(() => runtime.learnable(state, (payload || {}).id));
	},

	plan(payload) {
		const state = requireRun(payload);
		return guarded(() => {
			const plan = runtime.planNext(state, {trainer: (payload || {}).trainer});
			return {
				trainer: plan.trainer,
				order: plan.order,
				confidence: plan.confidence,
				margin: plan.margin,
				borrowedPlayerBuild: plan.borrowedPlayerBuild,
				actions: plan.actions.map(action => ({label: action.label, score: action.score})),
			};
		});
	},

	/** Every wild-table map, used or not, with each unused route's prospects. */
	routes(payload) {
		const state = requireRun(payload);
		return guarded(() => runtime.unusedRoutes(state));
	},

	/** Every possible six from the alive box, ranked against a fight. */
	rank(payload) {
		const state = requireRun(payload);
		// The calibration knobs pass through, bounded: rollouts is per-candidate
		// playthroughs (0 turns adjudication off), adjudicate is how many top
		// grid candidates get played. Both are CPU multipliers, so the wire
		// caps them harder than the library does.
		const options = {};
		for (const knob of [['rollouts', 0, 48], ['adjudicate', 1, 8]]) {
			const value = (payload || {})[knob[0]];
			if (value === undefined) continue;
			if (!Number.isInteger(value) || value < knob[1] || value > knob[2]) {
				throw refusal(`${knob[0]} must be an integer from ${knob[1]} to ${knob[2]}`,
					'InvalidRunCommand');
			}
			options[knob[0]] = value;
		}
		return guarded(() => runtime.rankParties(state, (payload || {}).trainer, options));
	},

	/** The full fight plan: assignments, odds, endings, the expected line. */
	playbook(payload) {
		const state = requireRun(payload);
		const rollouts = (payload || {}).rollouts;
		if (rollouts !== undefined &&
			(!Number.isInteger(rollouts) || rollouts < 1 || rollouts > 48)) {
			throw refusal('rollouts must be an integer from 1 to 48', 'InvalidRunCommand');
		}
		return guarded(() => runtime.fightPlaybook(state, (payload || {}).trainer,
			rollouts ? {rollouts} : undefined));
	},

	/** The split as one sheet: boss, cap, remaining gauntlet, filler count.
	 * `rollouts` (bounded like rank's) plays the boss with the current party
	 * and pins the measured floor to the sheet. */
	split(payload) {
		const state = requireRun(payload);
		const rollouts = (payload || {}).rollouts;
		if (rollouts !== undefined &&
			(!Number.isInteger(rollouts) || rollouts < 0 || rollouts > 48)) {
			throw refusal('rollouts must be an integer from 0 to 48', 'InvalidRunCommand');
		}
		return guarded(() => runtime.splitPrep(state, rollouts ? {rollouts} : undefined));
	},

	/** The box-versus-trainer grid: which of the box beats which of theirs. */
	matrix(payload) {
		const state = requireRun(payload);
		return guarded(() => runtime.boxMatrix(state, (payload || {}).trainer));
	},

	/** The upgrade advisor: the single changes that most move the board. */
	advise(payload) {
		const state = requireRun(payload);
		return guarded(() => runtime.adviseUpgrades(state, (payload || {}).trainer));
	},

	/** The catch advisor: what the open routes could add against the boss. */
	scout(payload) {
		const state = requireRun(payload);
		return guarded(() => runtime.adviseCatches(state, (payload || {}).trainer));
	},

	/** The game master's die: nothing is written, the reply is what came up. */
	encounter(payload) {
		const state = requireRun(payload);
		return guarded(() => ({roll: runtime.rollEncounter(state, {
			map: payload.map,
			method: payload.method,
		})}));
	},

	battleStart(payload) {
		const state = requireRun(payload);
		return guarded(() => battleDriver.start(state, payload.trainer, payload.seed));
	},

	/** A rolled wild encounter, fought: the driver checks the roll against
	 * the route's real table, so this takes the roll at face value. */
	battleWild(payload) {
		const state = requireRun(payload);
		const roll = (payload || {}).roll;
		if (!isRecord(roll)) {
			throw refusal('roll is required — send what /run/encounter rolled', 'InvalidRunCommand');
		}
		return guarded(() => battleDriver.startWild(state, roll, payload.seed));
	},

	battleAct(payload) {
		payload = payload || {};
		return guarded(() => battleDriver.act(requireBattle(payload), payload.action));
	},

	/** The map list, so a client can offer somewhere to look, not a text box. */
	maps(query) {
		const profile = require('./profiles').getProfile((query || {}).profile);
		return {
			limits: profile.oracle.LIMITS,
			maps: profile.oracle.maps().map(map => ({
				map: map.map,
				name: map.name,
				methods: map.tables.map(table => table.method),
			})),
		};
	},
};

/**
 * The demo page's router: the exact paths the panel fetches, mapped onto the
 * functions above. Kept HERE so a new endpoint cannot be added to one
 * transport and forgotten by the other.
 */
const ROUTES = {
	'/run/new': api.new,
	'/run/apply': api.apply,
	'/run/undo': api.undo,
	'/run/status': api.status,
	'/run/where': api.where,
	'/run/learnable': api.learnable,
	'/run/plan': api.plan,
	'/run/routes': api.routes,
	'/run/rank': api.rank,
	'/run/playbook': api.playbook,
	'/run/split': api.split,
	'/run/matrix': api.matrix,
	'/run/advise': api.advise,
	'/run/scout': api.scout,
	'/run/encounter': api.encounter,
	'/run/battle/start': api.battleStart,
	'/run/battle/wild': api.battleWild,
	'/run/battle/act': api.battleAct,
	'/run/maps': api.maps,
};

module.exports = {api, ROUTES, requireRun};
