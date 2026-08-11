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
 * Turn one player-party entry into a `PokemonState`.
 *
 * Two shapes are accepted, and the difference is not cosmetic:
 *
 *   {species, setLabel}                  — BORROWED: a trainer's build
 *   {species, level, moves, ability, …}  — DECLARED: the player's own box
 *
 * The borrowed form is the older one and it is a trap on the player's side of
 * the field. `Metagross (Trainer Steven Space Center)` is Steven's level 89
 * Metagross carrying his Life Orb, his Brave nature and his 0 Speed IV for
 * Trick Room. No player has that Pokemon, and the AI scores its actions against
 * whatever is across from it — so a borrowed build does not merely mislabel the
 * player's team, it changes the ranking the planner reports.
 *
 * It is kept, because scoring against a specific trainer's Pokemon is a real
 * question ("what does Norman's Slaking do into Norman's own Azumarill"), and
 * because the whole run map is reachable that way with no typing. It is no
 * longer the default and callers are told which one they used.
 */
function playerStateFromEntry(bridge_, mon, id) {
	if (mon && mon.setLabel) {
		return {state: bridge_.pokemonStateFromSet(mon.species, mon.setLabel, id), borrowed: true};
	}
	if (!mon || !mon.species) throw new Error(`${id}: needs a species`);
	if (!mon.moves || !mon.moves.length) throw new Error(`${id} (${mon.species}): needs at least one move`);
	// `rebuildZeroEvPokemon` is the same seam the set path uses, so a declared
	// Pokemon goes through the identical zero-EV Gen 8 projection rather than a
	// parallel construction that could drift from it.
	const built = bridge_.rebuildZeroEvPokemon({
		name: mon.species,
		level: mon.level || 100,
		ability: mon.ability,
		abilityOn: true,
		item: mon.item,
		nature: mon.nature,
		gender: mon.gender,
		ivs: Object.assign({hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31}, mon.ivs || {}),
		moves: mon.moves,
		teraType: mon.teraType,
		boosts: mon.boosts || {},
		status: mon.status || '',
	}, typeof mon.hpRatio === 'number' ? mon.hpRatio : 1);
	return {state: bridge_.pokemonStateFromCalcPokemon(built, id), borrowed: false};
}

/**
 * Build a serializable BattleState for a fight.
 *
 * The opposing party always comes from the run map. The player's party is the
 * caller's, in either of the shapes `playerStateFromEntry` describes; whether
 * any of it was borrowed from a trainer travels back with the state so a
 * consumer can say so rather than presenting a trainer's build as a plan.
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
	const built = opts.playerParty.map((mon, i) =>
		playerStateFromEntry(b, mon, `player-${i + 1}`));
	const playerParty = built.map(entry => entry.state);
	const borrowed = built.some(entry => entry.borrowed);

	const state = b.buildBattleState({
		aiActive: aiParty[0],
		aiBench: aiParty.slice(1),
		playerActive: playerParty[0],
		playerBench: playerParty.slice(1),
		mode: fight.isDouble && aiParty.length > 1 ? 'Singles' : 'Singles',
		field: opts.field || {},
	});
	ai.validateBattleState(state);
	return {fight, state, borrowed};
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
	const profile = getProfile(options && options.profileId);
	// The planner ranks actions by asking the policy. Run & Bun scores and rolls;
	// another game may script a decision tree or use stock vanilla AI, and those
	// need a different evaluator. Fail loudly rather than silently ranking a
	// policy this code cannot actually read.
	if (profile.policy && profile.policy.KIND !== 'scoring') {
		throw new Error(
			`planner cannot rank a '${profile.policy.KIND}' policy yet; ` +
			'only scoring policies are supported. See profiles/README.md.'
		);
	}
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
		// True when any player slot was filled from a trainer's set. The ranking
		// below is an answer about THAT Pokemon, not about a team a player could
		// field, and a consumer that hides this is reporting a plan for a box
		// nobody owns.
		borrowedPlayerBuild: built.borrowed,
		actions: scored,
		// The margin is the planning signal. A wide gap means the opponent's move
		// is effectively fixed; a narrow one means the plan has to survive both.
		margin: top && runnerUp ? Number((top.score - runnerUp.score).toFixed(3)) : undefined,
		confidence: !runnerUp ? 'only-option' :
			(top.score - runnerUp.score) >= 2 ? 'decided' : 'contested',
	};
}

/**
 * The hardest hitter among one side's actions, by top roll.
 *
 * Top roll first because a grid cell is read as "can this kill", and the roll
 * that decides that is the high one; the floor breaks ties, so two moves with
 * the same ceiling rank by the damage a player can actually count on.
 */
function bestDamagingMove(evaluations) {
	let best = null;
	for (const evaluation of evaluations) {
		if (evaluation.action.kind !== 'move') continue;
		// `isDamagingFacts` is the policy's own test, so a move that deals no
		// damage here is one the policy also refuses to score as damage —
		// Status moves, and immunities that came out of the calculator as zero.
		if (!ai.isDamagingFacts(evaluation.facts)) continue;
		const damage = ai.scoringDamageFacts(evaluation.facts);
		if (!best || damage.max > best.damage.max ||
			(damage.max === best.damage.max && damage.min > best.damage.min)) {
			best = {move: evaluation.action.moveName, damage};
		}
	}
	return best;
}

/**
 * One direction of a matchup, as fractions rather than HP.
 *
 * A grid puts a Poochyena's 20 HP bar next to a Metagross's 250 in the same
 * column, so raw damage compares nothing. A share of the defender's bar is the
 * only number that means the same thing in every cell.
 *
 * The KO booleans are NOT re-derived from those fractions. They are the
 * policy's own `guaranteedKO`/`possibleKO`, which already account for Sturdy,
 * Focus Sash, Disguise and multi-hit rolls — a cell that recomputed
 * `max >= 1` would disagree with the predictor about the same exchange.
 */
function matchupDirection(evaluations) {
	const speed = evaluations.length ? evaluations[0].facts.attackerSpeed : undefined;
	const best = bestDamagingMove(evaluations);
	if (!best) {
		// A side with nothing but status moves is a real cell, not an error: it
		// deals nothing, and saying so is the answer.
		return {move: null, max: 0, min: 0, guaranteedKO: false, possibleKO: false, speed};
	}
	const hp = best.damage.targetHp;
	return {
		move: best.move,
		max: hp > 0 ? best.damage.max / hp : 0,
		min: hp > 0 ? best.damage.min / hp : 0,
		guaranteedKO: best.damage.guaranteedKO,
		possibleKO: best.damage.possibleKO,
		speed,
	};
}

/** Faster/slower/tie, from the speeds each side's own facts reported. */
function speedRelation(us, them) {
	if (typeof us !== 'number' || typeof them !== 'number') return null;
	return us > them ? 'faster' : us < them ? 'slower' : 'tie';
}

/**
 * The box-versus-trainer matrix: every Pokemon offered against every one of a
 * trainer's, in both directions.
 *
 * The calculator's legacy box grid answered this by colouring each opposing
 * sprite from a raw damage call. Those colours were right about damage and
 * blind to everything else: they could not say whether the opponent would pick
 * the move being coloured, and their numbers agreed with nothing else on the
 * page. This asks the POLICY instead — the same `ai.evaluateActions` the
 * predictor ranks turns with — so a cell's KO pressure is the fact the AI is
 * acting on rather than a second opinion about it, and the grid, the plan and
 * the simulation cannot drift apart.
 *
 * Both directions are evaluated, because half a matchup is not one: "we OHKO
 * it" and "it OHKOs us first" are the same cell and only the pair decides the
 * fight.
 *
 * L5, so explicit inputs and no run awareness. `playerParty` is levels and
 * moves somebody handed in; this function does not know a save file exists and
 * cannot project a level to a cap. `run.boxMatrix` does that, and has to,
 * because the cap rules live at L6 with the save.
 *
 * Each pair is its own 1v1 state with no benches — not a simplification of a
 * six-on-six fight but the question the grid asks: if these two are the ones
 * on the field, who wins the exchange. A bench would only add switch actions
 * that no cell can show.
 */
function matchup(options) {
	const opts = options || {};
	const profile = getProfile(opts.profileId);
	const b = loadBridge(profile);
	const fight = getFight(opts.trainer, opts.profileId);

	if (!opts.playerParty || !opts.playerParty.length) {
		throw new Error('playerParty is required: the planner cannot compare a trainer to no team');
	}

	const ours = opts.playerParty.map((mon, i) =>
		playerStateFromEntry(b, mon, `player-${i + 1}`));
	const theirs = fight.party.map((mon, i) =>
		b.pokemonStateFromSet(mon.species, mon.setLabel, `ai-${i + 1}`));

	const grid = theirs.map(enemy => ({
		enemy: {species: enemy.species, level: enemy.level},
		versus: ours.map(entry => {
			// Every cell gets its own copy of both Pokemon under the ids a 1v1
			// state uses. Sharing one object across the row would let any state a
			// later cell wrote leak backwards into a number already reported.
			const player = Object.assign(clone(entry.state), {id: 'player-1'});
			const foe = Object.assign(clone(enemy), {id: 'ai-1'});
			const state = b.buildBattleState({
				aiActive: foe,
				playerActive: player,
				mode: 'Singles',
				field: opts.field || {},
			});
			ai.validateBattleState(state);
			const us = matchupDirection(
				ai.evaluateActions(state, ai.calculateActionFacts, 'player'));
			const them = matchupDirection(
				ai.evaluateActions(state, ai.calculateActionFacts, 'ai'));
			return {
				species: player.species,
				level: player.level,
				speed: speedRelation(us.speed, them.speed),
				us,
				them,
			};
		}),
	}));

	return {
		trainer: fight.trainer,
		order: fight.order,
		// Same warning `predict` carries: a borrowed slot is a trainer's build,
		// so its row is an answer about a Pokemon nobody owns.
		borrowedPlayerBuild: ours.some(entry => entry.borrowed),
		grid,
	};
}

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

module.exports = {
	loadRunMap, listFights, getFight, upcoming, buildFightState, predict,
	playerStateFromEntry, matchup,
};
