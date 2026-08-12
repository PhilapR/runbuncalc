/* eslint-env node, es6 */

const path = require("path");
const express = require("express");
const calc = require("@smogon/calc");
const ai = require("./ai");
const planner = require("./planner");
const playerTeam = require("./team");
const runtime = require("./run");
const app = express();

function startServer(port = 3000) {
	return app.listen(port, () => {
		console.log(`Server running on port ${port}`);
	});
}

// parse application/json. The default 100kb body limit is smaller than a
// late-game run document (every /run/* command posts the whole save, and a
// full playthrough's log projects to ~150-300KB), so a stock limit would turn
// the run panel into HTTP 413s mid-game.
app.use(express.json({limit: '5mb'}));

const calculateHandler = (req, res, next) => {
	const input = req.method === "GET" ? req.query : (req.body || {});
	const genNumber = Number(typeof input.gen === 'undefined' ? 9 : input.gen);
	if (!Number.isInteger(genNumber) || genNumber < 1 || genNumber > 9) {
		return res.status(400).json({error: "gen must be an integer from 1 through 9"});
	}
	const gen = calc.Generations.get(genNumber);
	let error = "";
	if (typeof input.attackingPokemon !== 'string' || !gen.species.get(calc.toID(input.attackingPokemon)))
		error += "attackingPokemon must exist and have a valid pokemon name\n";
	if (typeof input.defendingPokemon !== 'string' || !gen.species.get(calc.toID(input.defendingPokemon)))
		error += "defendingPokemon must exist and have a valid pokemon name\n";
	if (typeof input.moveName !== 'string' || !gen.moves.get(calc.toID(input.moveName)))
		error += "moveName must exist and have a valid move name\n";
	if (error) {
		return res.status(400).json({error});
	}
	const result = calc.calculate(
		gen,
		new calc.Pokemon(gen, input.attackingPokemon, input.attackingPokemonOptions),
		new calc.Pokemon(gen, input.defendingPokemon, input.defendingPokemonOptions),
		new calc.Move(gen, input.moveName),
		new calc.Field((typeof input.field === 'undefined') ? undefined : input.field)
	);
	res.json(result);
};

app.get("/calculate", calculateHandler);
app.post("/calculate", calculateHandler);

function badOption(message) {
	const error = new Error(message);
	error.statusCode = 400;
	throw error;
}

function requireRecord(value, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		badOption(`${label} must be an object`);
	}
	return value;
}

function validatePartyOptionKeys(state, value, label) {
	const record = requireRecord(value, label);
	const partyIds = new Set([
		...state.sides.ai.party.map(pokemon => pokemon.id),
		...state.sides.player.party.map(pokemon => pokemon.id),
	]);
	for (const id of Object.keys(record)) {
		if (!partyIds.has(id)) badOption(`${label} references unknown Pok\u00e9mon ${id}`);
	}
	return record;
}

function validateChooseOptions(state, options) {
	const allowed = new Set([
		"sideId", "includeSwitches", "viableReplacementIds", "replacementViability",
		"deriveReplacementViability", "replacementScores",
	]);
	for (const key of Object.keys(options)) {
		if (!allowed.has(key)) badOption(`options has an unsupported property ${key}`);
	}
	for (const key of ["includeSwitches", "deriveReplacementViability"]) {
		if (options[key] !== undefined && typeof options[key] !== "boolean") {
			badOption(`options.${key} must be boolean`);
		}
	}
	if (options.viableReplacementIds !== undefined) {
		if (!Array.isArray(options.viableReplacementIds) ||
			options.viableReplacementIds.some(id => typeof id !== "string" || !id) ||
			new Set(options.viableReplacementIds).size !== options.viableReplacementIds.length) {
			badOption("options.viableReplacementIds must be a duplicate-free array of non-empty IDs");
		}
		const partyIds = new Set([
			...state.sides.ai.party.map(pokemon => pokemon.id),
			...state.sides.player.party.map(pokemon => pokemon.id),
		]);
		for (const id of options.viableReplacementIds) {
			if (!partyIds.has(id)) badOption(`options.viableReplacementIds references unknown Pok\u00e9mon ${id}`);
		}
	}
	if (options.replacementViability !== undefined) {
		const viability = validatePartyOptionKeys(state, options.replacementViability, "options.replacementViability");
		for (const [id, value] of Object.entries(viability)) {
			const entry = requireRecord(value, `options.replacementViability.${id}`);
			for (const key of ["faster", "notOHKOd", "not2HKOd"]) {
				if (typeof entry[key] !== "boolean") {
					badOption(`options.replacementViability.${id}.${key} must be boolean`);
				}
			}
			if (Object.keys(entry).some(key => !["faster", "notOHKOd", "not2HKOd"].includes(key))) {
				badOption(`options.replacementViability.${id} has an unsupported property`);
			}
		}
	}
	if (options.replacementScores !== undefined) {
		const scores = validatePartyOptionKeys(state, options.replacementScores, "options.replacementScores");
		for (const [id, score] of Object.entries(scores)) {
			if (typeof score !== "number" || !Number.isFinite(score)) {
				badOption(`options.replacementScores.${id} must be a finite number`);
			}
		}
	}
}

function validateItemRolls(state, value) {
	if (value === undefined) return;
	const rolls = validatePartyOptionKeys(state, value, "itemRollsByPokemon");
	for (const [id, roll] of Object.entries(rolls)) {
		if (typeof roll !== "number" || !Number.isFinite(roll) || roll < 0 || roll >= 1) {
			badOption(`itemRollsByPokemon.${id} must be a finite number from 0 inclusive to 1 exclusive`);
		}
	}
}

function getChoiceSideId(options) {
	const sideId = options.sideId === undefined ? "ai" : options.sideId;
	if (sideId !== "ai" && sideId !== "player") {
		badOption("options.sideId must be ai or player");
	}
	return sideId;
}

function getEvaluationOptions(state, options) {
	validateChooseOptions(state, options);
	return {
		includeSwitches: !!options.includeSwitches,
		viableReplacementIds: options.viableReplacementIds === undefined
			? undefined
			: new Set(options.viableReplacementIds),
		replacementViability: options.replacementViability || undefined,
		deriveReplacementViability: options.deriveReplacementViability !== false,
		replacementScores: options.replacementScores || undefined,
	};
}

app.post("/ai/validate-battle-state", (req, res, next) => {
	try {
		const payload = req.body || {};
		const state = payload.state || payload;
		if (!state || !state.sides) {
			return res.status(400).json({error: "BattleState with sides is required"});
		}
		ai.validateBattleState(state);
		return res.json({ok: true});
	} catch (error) {
		next(error);
	}
});

app.post("/ai/choose-action", (req, res, next) => {
	try {
		const payload = req.body || {};
		const state = payload.state || payload;
		const options = payload.options === undefined ? {} : payload.options;
		if (!state || !state.sides) {
			return res.status(400).json({error: "BattleState with sides is required"});
		}
		if (!options || typeof options !== "object" || Array.isArray(options)) {
			return res.status(400).json({error: "options must be an object"});
		}
		const sideId = getChoiceSideId(options);
		ai.validateBattleState(state);
		const evaluationOptions = getEvaluationOptions(state, options);
		const decision = ai.chooseStateAction(
			state,
			ai.calculateActionFacts,
			sideId,
			Math.random,
			evaluationOptions
		);
		return res.json({
			action: decision.action,
			selectedScore: decision.selectedScore,
			evaluations: decision.evaluations,
		});
	} catch (error) {
		next(error);
	}
});

app.post("/ai/evaluate-actions", (req, res, next) => {
	try {
		const payload = req.body || {};
		const state = payload.state || payload;
		const options = payload.options === undefined ? {} : payload.options;
		if (!state || !state.sides) {
			return res.status(400).json({error: "BattleState with sides is required"});
		}
		if (!options || typeof options !== "object" || Array.isArray(options)) {
			return res.status(400).json({error: "options must be an object"});
		}
		const sideId = getChoiceSideId(options);
		ai.validateBattleState(state);
		const evaluationOptions = getEvaluationOptions(state, options);
		return res.json({
			evaluations: ai.evaluateActions(state, ai.calculateActionFacts, sideId, evaluationOptions),
		});
	} catch (error) {
		next(error);
	}
});

app.post("/ai/apply-action", (req, res, next) => {
	try {
		const payload = req.body || {};
		if (!payload.state || !payload.state.sides || !payload.action) {
			return res.status(400).json({error: "state with sides and action are required"});
		}
		ai.validateBattleState(payload.state);
		ai.validateAction(payload.state, payload.action);
		if (payload.action.kind === "move" && payload.resolution === undefined) {
			return res.status(400).json({error: "move actions require a resolution"});
		}
		if (payload.action.kind === "switch" && payload.resolution !== undefined) {
			return res.status(400).json({error: "switch actions do not accept a resolution"});
		}
		if (payload.action.kind === "move") {
			ai.validateMoveResolution(payload.state, payload.action, payload.resolution);
		}
		const nextState = ai.applyAction(payload.state, payload.action, payload.resolution);
		ai.validateBattleState(nextState);
		return res.json(nextState);
	} catch (error) {
		next(error);
	}
});

app.post("/ai/derive-switch-entry", (req, res, next) => {
	try {
		const payload = req.body || {};
		if (!payload.state || !payload.state.sides || !payload.action) {
			return res.status(400).json({error: "state with sides and switch action are required"});
		}
		ai.validateBattleState(payload.state);
		ai.validateAction(payload.state, payload.action);
		if (payload.action.kind !== "switch") {
			return res.status(400).json({error: "action.kind must be switch"});
		}
		const resolution = ai.deriveSwitchEntryResolution(payload.state, payload.action);
		ai.validateSwitchEntryResolution(payload.state, payload.action, resolution);
		return res.json(resolution);
	} catch (error) {
		next(error);
	}
});

app.post("/ai/forced-switch-actions", (req, res, next) => {
	try {
		const payload = req.body || {};
		const state = payload.state || payload;
		if (!state || !state.sides) {
			return res.status(400).json({error: "BattleState with sides is required"});
		}
		const sideId = payload.sideId === undefined ? "ai" : payload.sideId;
		if (sideId !== "ai" && sideId !== "player") {
			return res.status(400).json({error: "sideId must be ai or player"});
		}
		ai.validateBattleState(state);
		return res.json({actions: ai.enumerateForcedSwitchActions(state, sideId)});
	} catch (error) {
		next(error);
	}
});

app.post("/ai/derive-resolution", (req, res, next) => {
	try {
		const payload = req.body || {};
		if (!payload.state || !payload.state.sides || !payload.action) {
			return res.status(400).json({error: "state with sides and action are required"});
		}
		ai.validateBattleState(payload.state);
		ai.validateAction(payload.state, payload.action);
		if (payload.action.kind !== "move") {
			return res.status(400).json({error: "action.kind must be move"});
		}
		ai.validateMoveEngineOptions(payload.state, payload.action, {
			facts: payload.facts,
			hit: payload.hit,
			accuracy: payload.accuracy,
			secondaryEffects: payload.secondaryEffects,
		});
		const resolution = ai.deriveMoveResolution(payload.state, payload.action, {
			facts: payload.facts,
			hit: payload.hit,
			accuracy: payload.accuracy,
			secondaryEffects: payload.secondaryEffects,
			random: Math.random,
		});
		ai.validateMoveResolution(payload.state, payload.action, resolution);
		return res.json(resolution);
	} catch (error) {
		next(error);
	}
});

app.post("/ai/derive-end-turn", (req, res, next) => {
	try {
		const payload = req.body || {};
		const state = payload.state || payload;
		if (!state || !state.sides) {
			return res.status(400).json({error: "BattleState with sides is required"});
		}
		ai.validateBattleState(state);
		const resolution = ai.deriveEndTurnResolution(state);
		ai.validateEndTurnResolution(state, resolution);
		return res.json(resolution);
	} catch (error) {
		next(error);
	}
});

app.post("/ai/advance-turn", (req, res, next) => {
	try {
		const payload = req.body || {};
		const state = payload.state || payload;
		if (!state || !state.sides) {
			return res.status(400).json({error: "BattleState with sides is required"});
		}
		ai.validateBattleState(state);
		const nextState = ai.advanceTurn(state);
		ai.validateBattleState(nextState);
		return res.json(nextState);
	} catch (error) {
		next(error);
	}
});

app.post("/ai/order-actions", (req, res, next) => {
	try {
		const payload = req.body || {};
		const state = payload.state;
		if (!state || !state.sides || !Array.isArray(payload.actions)) {
			return res.status(400).json({error: "state with sides and actions are required"});
		}
		ai.validateBattleState(state);
		for (const action of payload.actions) ai.validateAction(state, action);
		validateItemRolls(state, payload.itemRollsByPokemon);
		return res.json({actions: ai.orderActions(state, payload.actions, {itemRollsByPokemon: payload.itemRollsByPokemon})});
	} catch (error) {
		next(error);
	}
});

// ---------------------------------------------------------------- planner
//
// The AI endpoints above all take a caller-supplied BattleState: they answer
// "given this position, what happens". The planner answers the question a
// player actually has mid-run — "I am about to fight X with this team" — by
// building the position from the authored run map itself.
//
// Kept thin on purpose. Every one of these delegates to `planner.js`, which
// delegates to the layers beneath it; the server adds HTTP and nothing else.

app.get("/planner/fights", (req, res, next) => {
	try {
		const listed = planner.listFights(req.query.profile);
		// The coverage caveat travels with the list rather than being available
		// separately, so a client cannot present the run map as a complete
		// trainer census without having been told otherwise.
		return res.json({
			coverage: listed.coverage,
			fights: listed.fights.map(fight => ({
				trainer: fight.trainer,
				order: fight.order,
				isDouble: fight.isDouble,
				partySize: fight.party.length,
			})),
		});
	} catch (error) {
		next(error);
	}
});

app.get("/planner/fight", (req, res, next) => {
	try {
		if (!req.query.trainer) {
			return res.status(400).json({error: "trainer is required"});
		}
		return res.json({fight: planner.getFight(req.query.trainer, req.query.profile)});
	} catch (error) {
		// An unknown trainer is a client mistake, not a server fault, and the
		// planner's message already carries the near-misses worth showing.
		return res.status(400).json({error: error.message, code: "UnknownTrainer"});
	}
});

app.get("/planner/upcoming", (req, res, next) => {
	try {
		const after = req.query.after === undefined ? undefined : Number(req.query.after);
		if (after !== undefined && !Number.isFinite(after)) {
			return res.status(400).json({error: "after must be a number when supplied"});
		}
		const count = req.query.count === undefined ? 5 : Number(req.query.count);
		if (!Number.isInteger(count) || count < 1 || count > 50) {
			return res.status(400).json({error: "count must be an integer from 1 through 50"});
		}
		const fights = planner.upcoming(after, count, req.query.profile).map(fight => ({
			trainer: fight.trainer,
			order: fight.order,
			partySize: fight.party.length,
		}));
		return res.json({fights});
	} catch (error) {
		next(error);
	}
});

app.post("/planner/predict", (req, res, next) => {
	try {
		const payload = req.body || {};
		if (!payload.trainer) {
			return res.status(400).json({error: "trainer is required"});
		}
		// Two ways to name a team, and the difference matters. `playerPaste` is a
		// Showdown paste — the player's own box, declared. `playerParty` is the
		// structured form, which also admits `{species, setLabel}`: a TRAINER'S
		// build, which the AI scores against and which therefore changes the
		// ranking. Both are served; the response says which was used.
		let playerParty = payload.playerParty;
		let notes = [];
		if (typeof payload.playerPaste === "string") {
			if (playerParty) {
				return res.status(400).json({
					error: "send playerPaste or playerParty, not both",
					code: "InvalidPlannerRequest",
				});
			}
			const parsed = playerTeam.parseTeam(payload.playerPaste);
			playerParty = parsed.party;
			notes = parsed.notes;
		}
		if (!Array.isArray(playerParty) || !playerParty.length) {
			return res.status(400).json({
				error: "playerParty is required: the planner cannot plan a fight with no team",
			});
		}
		const result = planner.predict({
			trainer: payload.trainer,
			playerParty,
			field: payload.field,
			profileId: payload.profile,
		});
		// The state is omitted by default: it is large, and a client asking what
		// the opponent will do rarely wants the whole position back.
		return res.json({
			trainer: result.trainer,
			order: result.order,
			confidence: result.confidence,
			margin: result.margin,
			// Travels with every prediction so a client cannot present a plan built
			// on a trainer's Pokemon as a plan for the player's team.
			borrowedPlayerBuild: result.borrowedPlayerBuild,
			// The same reason: 46 fights in the map are double battles ranked here
			// as a 1v1 exchange. The library says so on every prediction, and a
			// client that never receives the flag cannot repeat the caveat.
			plannedAsSingles: result.plannedAsSingles,
			notes,
			actions: result.actions.map(action => ({
				label: action.label,
				score: action.score,
				action: action.action,
			})),
			...(payload.includeState ? {state: result.state} : {}),
		});
	} catch (error) {
		// Unknown trainers, unknown sets and unreadable pastes are all client input
		// problems; the messages name the near-miss, the bad set or the exact line.
		if (/^no fight named|^Unknown set:|playerParty is required|^Pokemon \d+|^empty team|^a party holds six|needs a species|needs at least one move/
			.test(error.message || "")) {
			return res.status(400).json({error: error.message, code: "InvalidPlannerRequest"});
		}
		next(error);
	}
});


// -------------------------------------------------------------------- the run
//
// The run is a playthrough: a box, a party, a bag and a position in the map.
// Everything else the server exposes is stateless, and so is this — the RUN
// TRAVELS IN THE REQUEST rather than living here.
//
// That is a deliberate choice, not a shortcut. A run belongs to one player and
// nobody else, this server has no accounts and no storage, and the moment it
// held save files it would need both. Keeping the document client-side means the
// browser can persist it in `localStorage`, the CLI can persist it in a file,
// and the rules live in exactly one place either way.
//
// The cost is that every call carries the whole run. At a few kilobytes for a
// full box that is cheaper than the alternative.

function invalidRun(res, message) {
	res.status(400).json({error: message, code: "InvalidRun"});
	return null;
}

function isRecord(value) {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Shared shape check, so every endpoint refuses a malformed run the same way.
 *
 * A version stamp is not a document. `run.js` reads `rules.levelCap`, iterates
 * `box`, `party` and `log` and clones `bag` without re-checking any of it —
 * correctly, because it is handed runs it built itself. Over HTTP the run
 * arrives from a client, so a hand-written `{"version":1}` or a truncated save
 * pasted into the panel's import box used to reach `summarize` and come out a
 * 500. Every field the run layer assumes is checked here, once, and the failure
 * names the field: a malformed run is the caller's mistake to fix.
 */
function requireRun(payload, res) {
	if (!payload || typeof payload.run !== "object" || payload.run === null) {
		return invalidRun(res, "run is required");
	}
	const run = payload.run;
	if (run.version !== runtime.VERSION) {
		res.status(400).json({
			error: `run is version ${run.version}; this server reads version ${runtime.VERSION}`,
			code: "RunVersionMismatch",
		});
		return null;
	}
	if (!isRecord(run.rules) || typeof run.rules.levelCap !== "string") {
		return invalidRun(res, "run.rules must be an object with a levelCap string");
	}
	for (const field of ["box", "log"]) {
		if (!Array.isArray(run[field])) {
			return invalidRun(res, `run.${field} must be an array`);
		}
	}
	// The party holds ids into the box, not Pokemon; anything else makes the
	// lookup in `summarize` read a property of null.
	if (!Array.isArray(run.party) || run.party.some(id => typeof id !== "string")) {
		return invalidRun(res, "run.party must be an array of box ids");
	}
	if (!isRecord(run.bag)) {
		return invalidRun(res, "run.bag must be an object");
	}
	for (const field of ["position", "nextId"]) {
		if (typeof run[field] !== "number" || !Number.isFinite(run[field])) {
			return invalidRun(res, `run.${field} must be a number`);
		}
	}
	return run;
}

/**
 * Errors from `run.js` are almost all the player being told why something could
 * not have happened — a species that is not on that route, a move the species
 * cannot hold. Those are 400s with the message intact, because the message IS
 * the feature.
 */
function runError(error, res, next) {
	if (/^[A-Z][a-z].*(does not|cannot|is not|has no)|^no |^teach:|^evolve:|^catch:|^levelUp:|^party:|^give:|^take:|^beat:|^acquire:|^faint:|^heartScale:|^hold:|^unhold:|^unknown |^a command needs|^nothing |^the party is empty|^a party holds/.test(error.message || "")) {
		return res.status(400).json({error: error.message, code: "InvalidRunCommand"});
	}
	return next(error);
}

app.post("/run/new", (req, res, next) => {
	try {
		const payload = req.body || {};
		return res.json({
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
		});
	} catch (error) {
		return res.status(400).json({error: error.message, code: "InvalidRun"});
	}
});

app.post("/run/apply", (req, res, next) => {
	const state = requireRun(req.body, res);
	if (!state) return undefined;
	try {
		const next_ = runtime.apply(state, (req.body || {}).command, {now: (req.body || {}).now || null});
		return res.json({
			run: next_,
			summary: next_.log[next_.log.length - 1].summary,
			status: runtime.summarize(next_),
		});
	} catch (error) {
		return runError(error, res, next);
	}
});

app.post("/run/undo", (req, res, next) => {
	const state = requireRun(req.body, res);
	if (!state) return undefined;
	try {
		const undone = runtime.undo(state);
		return res.json({run: undone, status: runtime.summarize(undone)});
	} catch (error) {
		return runError(error, res, next);
	}
});

app.post("/run/status", (req, res, next) => {
	const state = requireRun(req.body, res);
	if (!state) return undefined;
	try {
		// How far ahead to look is the client's call — a panel showing the road
		// ahead wants more than a CLI status line — but bounded, because upcoming
		// parties are heavy and nobody plans 50 fights out.
		const wanted = Number((req.body || {}).upcomingCount);
		const count = Number.isInteger(wanted) ? Math.min(Math.max(wanted, 1), 20) : 5;
		return res.json({
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
					require("./profiles").getProfile(state.profileId), fight.trainer),
			})),
		});
	} catch (error) {
		return runError(error, res, next);
	}
});

app.post("/run/where", (req, res, next) => {
	const state = requireRun(req.body, res);
	if (!state) return undefined;
	try {
		const found = runtime.encountersOn(state, (req.body || {}).map);
		if (!found) {
			return res.status(400).json({
				error: `no map named ${JSON.stringify((req.body || {}).map)} has a wild encounter table`,
				code: "UnknownMap",
			});
		}
		return res.json(found);
	} catch (error) {
		return runError(error, res, next);
	}
});

app.post("/run/learnable", (req, res, next) => {
	const state = requireRun(req.body, res);
	if (!state) return undefined;
	try {
		return res.json(runtime.learnable(state, (req.body || {}).id));
	} catch (error) {
		return runError(error, res, next);
	}
});

app.post("/run/plan", (req, res, next) => {
	const state = requireRun(req.body, res);
	if (!state) return undefined;
	try {
		const plan = runtime.planNext(state, {trainer: (req.body || {}).trainer});
		return res.json({
			trainer: plan.trainer,
			order: plan.order,
			confidence: plan.confidence,
			margin: plan.margin,
			borrowedPlayerBuild: plan.borrowedPlayerBuild,
			actions: plan.actions.map(action => ({label: action.label, score: action.score})),
		});
	} catch (error) {
		return runError(error, res, next);
	}
});

/**
 * The box-versus-trainer grid: which of the box beats which of theirs.
 *
 * Sent whole, unlike `/run/plan` — a grid IS its cells, and a client that only
 * got the top row would be back to asking one damage calc at a time. The
 * projection travels with it so the panel can say "at the cap you will legally
 * have" rather than presenting raised levels as the box.
 */
/** Every wild-table map, used or not, with each unused route's best prospects. */
app.post("/run/routes", (req, res, next) => {
	const state = requireRun(req.body, res);
	if (!state) return undefined;
	try {
		return res.json(runtime.unusedRoutes(state));
	} catch (error) {
		return runError(error, res, next);
	}
});

/** Every possible six from the alive box, ranked against a fight. */
app.post("/run/rank", (req, res, next) => {
	const state = requireRun(req.body, res);
	if (!state) return undefined;
	try {
		return res.json(runtime.rankParties(state, (req.body || {}).trainer));
	} catch (error) {
		return runError(error, res, next);
	}
});

/** The split as one sheet: boss, cap, remaining gauntlet, filler count. */
app.post("/run/split", (req, res, next) => {
	const state = requireRun(req.body, res);
	if (!state) return undefined;
	try {
		return res.json(runtime.splitPrep(state));
	} catch (error) {
		return runError(error, res, next);
	}
});

app.post("/run/matrix", (req, res, next) => {
	const state = requireRun(req.body, res);
	if (!state) return undefined;
	try {
		return res.json(runtime.boxMatrix(state, (req.body || {}).trainer));
	} catch (error) {
		return runError(error, res, next);
	}
});

/**
 * The upgrade advisor: the single changes that most move the board.
 *
 * The heaviest call the run layer serves — every teachable move, every bag
 * item and every recorded IV is priced by rebuilding a matchup row through the
 * policy. Scoped to the party for exactly that reason, and answered whole,
 * because a shortlist of ten IS the answer.
 */
app.post("/run/advise", (req, res, next) => {
	const state = requireRun(req.body, res);
	if (!state) return undefined;
	try {
		return res.json(runtime.adviseUpgrades(state, (req.body || {}).trainer));
	} catch (error) {
		return runError(error, res, next);
	}
});

/**
 * The catch advisor: what the open, unspent routes could add against the next
 * boss. Cheaper than /run/advise — one row per distinct prospect — but the
 * same discipline: every claim is a matchup row, never a heuristic.
 */
app.post("/run/scout", (req, res, next) => {
	const state = requireRun(req.body, res);
	if (!state) return undefined;
	try {
		return res.json(runtime.adviseCatches(state, (req.body || {}).trainer));
	} catch (error) {
		return runError(error, res, next);
	}
});

/** The map list, so a client can offer somewhere to look rather than a text box. */
app.get("/run/maps", (req, res, next) => {
	try {
		const profile = require("./profiles").getProfile(req.query.profile);
		return res.json({
			limits: profile.oracle.LIMITS,
			maps: profile.oracle.maps().map(map => ({
				map: map.map,
				name: map.name,
				methods: map.tables.map(table => table.method),
			})),
		});
	} catch (error) {
		next(error);
	}
});

app.use((error, req, res, next) => {
	if (res.headersSent) {
		return next(error);
	}
	let status = 500;
	if (Number.isInteger(error?.statusCode)) {
		status = error.statusCode;
	} else if (Number.isInteger(error?.status)) {
		status = error.status;
	} else if (error?.type === "entity.parse.failed") {
		status = 400;
	}
	let message = error?.message || "Internal server error";
	if (error?.type === "entity.parse.failed") {
		message = "request body must contain valid JSON";
	}
	return res.status(status >= 400 && status < 600 ? status : 500).json({
		error: status >= 500 ? "Internal server error" : message,
	});
});

// Named UI BattleState fixtures + goldens for AI Debug (FIX-01/02/03).
app.use('/fixtures', express.static(path.join(__dirname, 'fixtures')));

// Resolved against this file, not the working directory. A bare "dist" made the
// whole shipped page depend on being started from the repository root: run from
// anywhere else and every request fell through to a 404, with the page loading
// enough to look alive and no panel on it.
app.use(express.static(path.join(__dirname, 'dist')));

if (require.main === module) {
	startServer();
}

module.exports = {app, startServer};
