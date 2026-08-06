/* eslint-env node, es6 */

const path = require("path");
const express = require("express");
const calc = require("@smogon/calc");
const ai = require("./ai");
const app = express();

function startServer(port = 3000) {
	return app.listen(port, () => {
		console.log(`Server running on port ${port}`);
	});
}

// parse application/json
app.use(express.json());

const calculateHandler = (req, res, next) => {
	const input = req.method === "GET" ? req.query : (req.body || {});
	const genNumber = Number(typeof input.gen === 'undefined' ? 9 : input.gen);
	if (!Number.isInteger(genNumber) || genNumber < 1 || genNumber > 9) {
		return jsonError(res, 400, "gen must be an integer from 1 through 9");
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
		return jsonError(res, 400, error.trim());
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

function errorCodeForMessage(message, status) {
	if (/^Invalid BattleState:/.test(message)) return "InvalidBattleState";
	if (/^Invalid Action:/.test(message)) return "InvalidAction";
	if (status >= 500) return "InternalError";
	return "BadRequest";
}

function jsonError(res, status, message) {
	return res.status(status).json({
		error: message,
		code: errorCodeForMessage(message, status),
	});
}

function badOption(message) {
	const error = new Error(`Invalid Action: ${message}`);
	error.statusCode = 400;
	error.code = "InvalidAction";
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
			return jsonError(res, 400, "Invalid BattleState: BattleState with sides is required");
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
			return jsonError(res, 400, "Invalid BattleState: BattleState with sides is required");
		}
		if (!options || typeof options !== "object" || Array.isArray(options)) {
			return jsonError(res, 400, "Invalid Action: options must be an object");
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
			return jsonError(res, 400, "Invalid BattleState: BattleState with sides is required");
		}
		if (!options || typeof options !== "object" || Array.isArray(options)) {
			return jsonError(res, 400, "Invalid Action: options must be an object");
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
		if (!payload.state || !payload.state.sides) {
			return jsonError(res, 400, "Invalid BattleState: state with sides is required");
		}
		if (!payload.action) {
			return jsonError(res, 400, "Invalid Action: action is required");
		}
		ai.validateBattleState(payload.state);
		ai.validateAction(payload.state, payload.action);
		if (payload.action.kind === "move" && payload.resolution === undefined) {
			return jsonError(res, 400, "Invalid Action: move actions require a resolution");
		}
		if (payload.action.kind === "switch" && payload.resolution !== undefined) {
			return jsonError(res, 400, "Invalid Action: switch actions do not accept a resolution");
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
		if (!payload.state || !payload.state.sides) {
			return jsonError(res, 400, "Invalid BattleState: state with sides is required");
		}
		if (!payload.action) {
			return jsonError(res, 400, "Invalid Action: switch action is required");
		}
		ai.validateBattleState(payload.state);
		ai.validateAction(payload.state, payload.action);
		if (payload.action.kind !== "switch") {
			return jsonError(res, 400, "Invalid Action: action.kind must be switch");
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
			return jsonError(res, 400, "Invalid BattleState: BattleState with sides is required");
		}
		const sideId = payload.sideId === undefined ? "ai" : payload.sideId;
		if (sideId !== "ai" && sideId !== "player") {
			return jsonError(res, 400, "Invalid Action: sideId must be ai or player");
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
		if (!payload.state || !payload.state.sides) {
			return jsonError(res, 400, "Invalid BattleState: state with sides is required");
		}
		if (!payload.action) {
			return jsonError(res, 400, "Invalid Action: action is required");
		}
		ai.validateBattleState(payload.state);
		ai.validateAction(payload.state, payload.action);
		if (payload.action.kind !== "move") {
			return jsonError(res, 400, "Invalid Action: action.kind must be move");
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
			return jsonError(res, 400, "Invalid BattleState: BattleState with sides is required");
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
			return jsonError(res, 400, "Invalid BattleState: BattleState with sides is required");
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
		if (!state || !state.sides) {
			return jsonError(res, 400, "Invalid BattleState: state with sides is required");
		}
		if (!Array.isArray(payload.actions)) {
			return jsonError(res, 400, "Invalid Action: actions are required");
		}
		ai.validateBattleState(state);
		for (const action of payload.actions) ai.validateAction(state, action);
		validateItemRolls(state, payload.itemRollsByPokemon);
		return res.json({actions: ai.orderActions(state, payload.actions, {itemRollsByPokemon: payload.itemRollsByPokemon})});
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
	} else if (
		typeof req.path === "string" &&
		req.path.startsWith("/ai/") &&
		error instanceof Error &&
		!(error instanceof TypeError) &&
		!(error instanceof RangeError)
	) {
		// AI domain Errors after boundary validation are client contract failures
		// (illegal action, transition rejection), not unexpected server faults.
		status = 400;
	}
	let message = error?.message || "Internal server error";
	if (error?.type === "entity.parse.failed") {
		message = "request body must contain valid JSON";
	} else if (status < 500 && status >= 400 && !/^Invalid (BattleState|Action):/.test(message) &&
		message !== "request body must contain valid JSON") {
		const kind = error?.code === "InvalidBattleState" ? "BattleState" : "Action";
		message = `Invalid ${kind}: ${message}`;
	}
	const finalStatus = status >= 400 && status < 600 ? status : 500;
	const bodyMessage = finalStatus >= 500 ? "Internal server error" : message;
	return res.status(finalStatus).json({
		error: bodyMessage,
		code: error?.code || errorCodeForMessage(bodyMessage, finalStatus),
	});
});

// Named UI BattleState fixtures + goldens for AI Debug (FIX-01/02/03).
app.use('/fixtures', express.static(path.join(__dirname, 'fixtures')));

app.use(express.static('dist'));

if (require.main === module) {
	startServer();
}

module.exports = {app, startServer};
