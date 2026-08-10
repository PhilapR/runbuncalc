/* eslint-env node, es6 */
'use strict';

/**
 * Fight planner (L5).
 *
 * This is the layer the rest of the project exists to support. Every piece
 * below it was already here and validated; nothing composed them:
 *
 *   L1 profile     — Run & Bun content, ROM-verified
 *   L2 state       — serializable BattleState, legal actions, transitions
 *   L3 policy      — what the opponent does with a turn
 *   L4 encounters  — the authored run map, in playthrough order
 *   L5 planner     — "I am about to fight X with this team. What happens?"
 *
 * A damage calculator answers "how hard does this hit". A player mid-run is
 * asking something else: whether they survive the next fight, and what the
 * opponent does back. That question needs all five layers at once, and this
 * module is where they meet.
 *
 * It deliberately owns no rules. Parties come from the run map, damage from the
 * calculator, decisions from the AI policy. If an answer here is wrong, it is
 * wrong in a layer below, which is what keeps this thin.
 *
 * Coverage caveat, surfaced rather than buried: the run map is a progression
 * spine, not a complete trainer census — see `encounters.COVERAGE`. `listFights`
 * reports what is known missing so a caller cannot mistake this for every battle
 * in the game.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const calc = require('@smogon/calc');
const ai = require('./ai');
const getProfile = require('./profiles').getProfile;

// The sets bridge is browser-first: it reads the calculator and the trainer
// table from globals. Provide them before requiring it.
global.calc = calc;

let bridge = null;
let runMapCache = null;

function loadBridge(profile) {
	if (bridge) return bridge;
	const encounters = profile.encounters;
	const setsPath = path.join(__dirname, encounters.SOURCE);
	const source = fs.readFileSync(setsPath, 'utf8');
	// The trainer data is a classic browser script — `var SETDEX_SS = {...};` —
	// so evaluating it in this realm is what actually reproduces how the page
	// loads it. `runInThisContext` says that plainly; building a Function to
	// return the value would only disguise the same evaluation.
	vm.runInThisContext(source, {filename: encounters.SOURCE});
	bridge = require('./src/js/sets_to_battle_state.js');
	return bridge;
}

/**
 * Every battle in the run map, in authored playthrough order.
 *
 * Ordering comes from the global `index` sequence, which is why that invariant
 * is gated: it is the only thing that knows where a fight sits in a run.
 */
function loadRunMap(profileId) {
	if (runMapCache) return runMapCache;
	const profile = getProfile(profileId);
	loadBridge(profile);
	const setdex = global[profile.encounters.GLOBAL];

	const byTrainer = new Map();
	for (const species of Object.keys(setdex)) {
		for (const label of Object.keys(setdex[species])) {
			const entry = setdex[species][label];
			// Duplicate-species entries carry an explicit `trainer`; group on it or
			// a party with two of one species splits into two fights.
			const trainer = entry.trainer || label;
			if (!byTrainer.has(trainer)) byTrainer.set(trainer, {trainer, party: []});
			byTrainer.get(trainer).party.push({
				species,
				setLabel: label,
				level: entry.level,
				ability: entry.ability,
				item: entry.item,
				moves: entry.moves || [],
				index: entry.index,
			});
		}
	}

	const fights = [];
	for (const fight of byTrainer.values()) {
		fight.party.sort((a, b) => a.index - b.index);
		fight.order = fight.party[0].index;
		// A label naming two trainers is one double battle, not two fights.
		fight.isDouble = fight.trainer.includes('&');
		fights.push(fight);
	}
	fights.sort((a, b) => a.order - b.order);
	runMapCache = fights;
	return fights;
}

/** Fights in progression order, with the coverage caveat attached. */
function listFights(profileId) {
	const profile = getProfile(profileId);
	return {
		fights: loadRunMap(profileId),
		coverage: profile.encounters.COVERAGE,
	};
}

/** One fight by trainer name. Throws with near-misses rather than a bare miss. */
function getFight(trainer, profileId) {
	const fights = loadRunMap(profileId);
	const found = fights.find(f => f.trainer === trainer);
	if (found) return found;
	const needle = trainer.toLowerCase();
	const near = fights.filter(f => f.trainer.toLowerCase().includes(needle)).slice(0, 5);
	throw new Error(
		`no fight named ${JSON.stringify(trainer)}` +
		(near.length ? `; did you mean: ${near.map(f => f.trainer).join(', ')}` : '')
	);
}

/**
 * The fights immediately ahead of a point in the run.
 *
 * This is what makes the run map more than a list: `after` is a progression
 * index, so a caller mid-playthrough can ask what is coming rather than
 * searching by name.
 */
function upcoming(after, count, profileId) {
	const fights = loadRunMap(profileId);
	const from = typeof after === 'number' ? after : -1;
	return fights.filter(f => f.order > from).slice(0, count || 5);
}

/**
 * Build a serializable BattleState for a fight.
 *
 * `playerParty` is a list of `{species, setLabel}` drawn from the same set data,
 * which keeps the planner honest: it plans with sets the project can actually
 * describe rather than inventing Pokemon.
 */
function buildFightState(options) {
	const opts = options || {};
	const profile = getProfile(opts.profileId);
	const b = loadBridge(profile);
	const fight = getFight(opts.trainer, opts.profileId);

	if (!opts.playerParty || !opts.playerParty.length) {
		throw new Error('playerParty is required: the planner cannot plan a fight with no team');
	}

	const aiParty = fight.party.map((mon, i) =>
		b.pokemonStateFromSet(mon.species, mon.setLabel, `ai-${i + 1}`));
	const playerParty = opts.playerParty.map((mon, i) =>
		b.pokemonStateFromSet(mon.species, mon.setLabel, `player-${i + 1}`));

	const state = b.buildBattleState({
		aiActive: aiParty[0],
		aiBench: aiParty.slice(1),
		playerActive: playerParty[0],
		playerBench: playerParty.slice(1),
		mode: fight.isDouble && aiParty.length > 1 ? 'Singles' : 'Singles',
		field: opts.field || {},
	});
	ai.validateBattleState(state);
	return {fight, state};
}

/**
 * What the opponent is expected to do on this turn, and why.
 *
 * Returns the AI's scored actions rather than a single choice. A planner that
 * reports only the top move hides the thing a player most needs: how close the
 * second option is, and therefore how much of the plan rests on a coin flip.
 */
function predict(options) {
	const built = buildFightState(options);
	const evaluations = ai.evaluateActions(
		built.state, ai.calculateActionFacts, 'ai', {includeSwitches: true});
	const nameById = {};
	for (const mon of built.state.sides.ai.party) nameById[mon.id] = mon.species;

	const scored = evaluations
		.map(e => ({
			action: e.action,
			// A readable label, so a caller does not have to know that a switch
			// names its target `replacementId` while a move names `moveName`.
			label: e.action.kind === 'move' ?
				e.action.moveName :
				`switch to ${nameById[e.action.replacementId] || e.action.replacementId}`,
			score: e.outcomes && e.outcomes.length ?
				e.outcomes.reduce((sum, o) => sum + o.score * o.probability, 0) :
				undefined,
			outcomes: e.outcomes,
			reasons: e.reasons,
		}))
		.filter(e => e.score !== undefined)
		.sort((a, b) => b.score - a.score);

	const top = scored[0];
	const runnerUp = scored[1];
	return {
		trainer: built.fight.trainer,
		order: built.fight.order,
		state: built.state,
		actions: scored,
		// The margin is the planning signal. A wide gap means the opponent's move
		// is effectively fixed; a narrow one means the plan has to survive both.
		margin: top && runnerUp ? Number((top.score - runnerUp.score).toFixed(3)) : undefined,
		confidence: !runnerUp ? 'only-option' :
			(top.score - runnerUp.score) >= 2 ? 'decided' : 'contested',
	};
}

module.exports = {loadRunMap, listFights, getFight, upcoming, buildFightState, predict};
