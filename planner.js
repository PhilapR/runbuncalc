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

// Keyed by profile id, never bare module-level singletons: an unkeyed cache
// warmed by one game silently served its 362 fights to ANY profile id — the
// worst failure mode this file had, because every layer above inherits it.
const bridgeCache = new Map();
const runMapCache = new Map();

function loadBridge(profile) {
	if (bridgeCache.has(profile.id)) return bridgeCache.get(profile.id);
	const encounters = profile.encounters;
	if (!encounters) {
		throw new Error(`profile '${profile.id}' declares no encounters layer — ` +
			'there is no run map to plan against');
	}
	const setsPath = path.join(__dirname, encounters.SOURCE);
	const source = fs.readFileSync(setsPath, 'utf8');
	// The trainer data is a classic browser script — `var SETDEX_SS = {...};` —
	// so evaluating it in this realm is what actually reproduces how the page
	// loads it. `runInThisContext` says that plainly; building a Function to
	// return the value would only disguise the same evaluation.
	vm.runInThisContext(source, {filename: encounters.SOURCE});
	const bridge = require('./src/js/sets_to_battle_state.js');
	bridgeCache.set(profile.id, bridge);
	return bridge;
}

/**
 * Every battle in the run map, in authored playthrough order.
 *
 * Ordering comes from the global `index` sequence, which is why that invariant
 * is gated: it is the only thing that knows where a fight sits in a run.
 */
function loadRunMap(profileId) {
	// The profile resolves FIRST: an unknown id must throw whether the cache is
	// warm or cold, not ride out on another game's fights.
	const profile = getProfile(profileId);
	if (runMapCache.has(profile.id)) return runMapCache.get(profile.id);
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
	runMapCache.set(profile.id, fights);
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
	// The run layer deliberately lets a bag hold anything a player types, so an
	// unknown held item (or nature) first meets reality here. Refusing with the
	// mon named beats the alternative — the calculator dying mid-grid turned a
	// whole matrix into HTTP 500 with no hint of which entry was at fault.
	const gen = calc.Generations.get(8);
	if (mon.item && !gen.items.get(calc.toID(mon.item))) {
		throw new Error(`${mon.species} (${id}) holds ${JSON.stringify(mon.item)}, ` +
			'which is not an item this game can hold in battle — fix or take the item');
	}
	if (mon.nature && !gen.natures.get(calc.toID(mon.nature))) {
		throw new Error(`${mon.species} (${id}) has nature ${JSON.stringify(mon.nature)}, ` +
			'which is not a nature this game knows');
	}
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
 *
 * `{doubles: true}` is OPT-IN, and only for the 46 fights the map marks as
 * double battles. It stays opt-in because the two modes are measurably not the
 * same answer: over all 46, run with a level-matched probe team, the lead's
 * top action changed in 18 and its confidence in 21, with margins moving by as
 * much as 9.4 either way. That is a re-answer of 46 fights, not a refinement,
 * and the caller decides which question they asked. The larger reason is
 * `doublesLeads`: which two of a pair's Pokemon start on the field is an
 * assumption, not data.
 */
function buildFightState(options) {
	const opts = options || {};
	const profile = getProfile(opts.profileId);
	const b = loadBridge(profile);
	const fight = getFight(opts.trainer, opts.profileId);

	if (!opts.playerParty || !opts.playerParty.length) {
		throw new Error('playerParty is required: the planner cannot plan a fight with no team');
	}
	const doubles = !!opts.doubles;
	if (doubles && !fight.isDouble) {
		throw new Error(`${fight.trainer} is a single battle: there is no second slot to plan`);
	}
	if (doubles && opts.playerParty.length < 2) {
		throw new Error('doubles planning needs two player Pokemon: a double battle leads with two');
	}

	const aiParty = fight.party.map((mon, i) =>
		b.pokemonStateFromSet(mon.species, mon.setLabel, `ai-${i + 1}`));
	const built = opts.playerParty.map((mon, i) =>
		playerStateFromEntry(b, mon, `player-${i + 1}`));
	const playerParty = built.map(entry => entry.state);
	const borrowed = built.some(entry => entry.borrowed);
	const slots = doubles ? 2 : 1;

	// The fight's PERMANENT field: Route 119 is fought in rain whether anyone
	// asks or not, so the profile's declaration is the default and an explicit
	// `opts.field` (even `{}`) is the override. The Seafloor Cavern's veil is
	// the opponent's side, not the sky, and it starts already up.
	const declared = declaredField(profile, fight.trainer);
	const state = b.buildBattleState({
		aiActives: aiParty.slice(0, slots),
		aiBench: aiParty.slice(slots),
		playerActives: playerParty.slice(0, slots),
		playerBench: playerParty.slice(slots),
		// Doubles fights default to Singles: the limitation travels with the
		// result instead of hiding in it, and `{doubles: true}` is what asks for
		// the two-slot state.
		mode: doubles ? 'Doubles' : 'Singles',
		field: opts.field !== undefined ? opts.field : declared.field,
		aiEffects: declared.aiEffects,
	});
	ai.validateBattleState(state);
	return {
		fight,
		state,
		borrowed,
		plannedAsSingles: !!fight.isDouble && !doubles,
		doubles,
		// Only present when the second slot is real, because it is the one thing
		// about a Doubles plan the run map cannot source.
		leadAssumption: doubles ? doublesLeads(fight) : undefined,
		// Named when the fight carries a permanent condition, so every consumer
		// can SAY "planned in permanent Rain" instead of silently assuming it.
		...(declared.label ? {fightField: declared.label} : {}),
	};
}

/**
 * The permanent field a profile declares for a fight, split into what the
 * battle state can hold: the sky (weather/terrain), the opponent's starting
 * side effects, and a human-readable label. A note-only declaration (Route
 * 129's erratic weather) yields no field — a condition that cannot be
 * static is reported, never faked.
 */
function declaredField(profile, trainer) {
	const declared = profile.oracle && profile.oracle.fightFieldOf ?
		profile.oracle.fightFieldOf(trainer) : null;
	if (!declared) return {field: {}, aiEffects: undefined, label: null};
	const field = {
		...(declared.weather ? {weather: declared.weather} : {}),
		...(declared.terrain ? {terrain: declared.terrain} : {}),
	};
	const aiEffects = declared.enemyAuroraVeil ? {auroraVeil: true} : undefined;
	const parts = [];
	if (declared.weather) parts.push(`permanent ${declared.weather === 'Sand' ? 'Sandstorm' : declared.weather}`);
	if (declared.terrain) parts.push(`permanent ${declared.terrain} Terrain`);
	if (declared.enemyAuroraVeil) parts.push('opponent starts under Aurora Veil');
	if (declared.note) parts.push(declared.note + ' (not modeled)');
	return {field, aiEffects, label: parts.join(', ') || null};
}

/**
 * Which two of a pair's Pokemon start on the field — an ASSUMPTION, named.
 *
 * A double battle in this game is two trainers, and each sends out their own
 * first Pokemon. The set table records the pair as one combined party under a
 * joined label ("School Kid Jerry & Johnson") with a single `index` sequence
 * and no ownership column, so which mon belongs to which trainer is simply not
 * in the data. First-two-by-index is the only reading the map supports; if the
 * table is actually ordered trainer-by-trainer, the real leads are the 1st and
 * the (n/2 + 1)th, and every Doubles prediction here is for the wrong pair.
 *
 * This is the reason Doubles stays opt-in even where the engine is ready.
 */
function doublesLeads(fight) {
	return {
		leadIds: ['ai-1', 'ai-2'],
		leads: fight.party.slice(0, 2).map(mon => mon.species),
		assumed: 'first two by run-map index',
		unknown: 'the run map does not record which trainer of the pair owns which Pokemon',
	};
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
			// Which of the opponent's Pokemon this turn belongs to. In Singles
			// there is only one answer; in Doubles the ranking mixes two, and an
			// action read without its actor is a move attributed to the wrong mon.
			actorId: e.action.actorId,
			actorSpecies: nameById[e.action.actorId] || e.action.actorId,
			score: e.outcomes && e.outcomes.length ?
				e.outcomes.reduce((sum, o) => sum + o.score * o.probability, 0) :
				undefined,
			outcomes: e.outcomes,
			reasons: e.reasons,
		}))
		.filter(e => e.score !== undefined)
		.sort((a, b) => b.score - a.score);

	const slots = built.state.sides.ai.activeIds
		.map(actorId => slotRanking(scored.filter(e => e.actorId === actorId), actorId, nameById))
		.filter(Boolean);
	// The margin answers "how close was this Pokemon's second choice", so the
	// runner-up is the top actor's OWN. In Singles that is scored[1] and nothing
	// moves; in Doubles the gap between two different Pokemon's moves would have
	// been a number about no decision either of them makes.
	const lead = slots.find(slot => slot.actorId === (scored[0] && scored[0].actorId));
	return {
		trainer: built.fight.trainer,
		order: built.fight.order,
		state: built.state,
		// True when any player slot was filled from a trainer's set. The ranking
		// below is an answer about THAT Pokemon, not about a team a player could
		// field, and a consumer that hides this is reporting a plan for a box
		// nobody owns.
		borrowedPlayerBuild: built.borrowed,
		// True for the run map's double battles planned in the default Singles
		// mode: the prediction ranks the fight as a 1v1 exchange, which is a
		// simplification the reader must see.
		plannedAsSingles: built.plannedAsSingles,
		// Only set when `{doubles: true}` built a two-slot state, and it carries
		// the lead assumption the run map cannot source.
		leadAssumption: built.leadAssumption,
		// Named when the fight carries a permanent condition the state was
		// built under — "decided by 4.6" in permanent rain is a different
		// claim than in clear skies, and the reader must see which one it is.
		...(built.fightField ? {fightField: built.fightField} : {}),
		actions: scored,
		// One entry per Pokemon the opponent has on the field: their own ranking,
		// margin and confidence. A doubles turn is two decisions, not one.
		slots,
		margin: lead ? lead.margin : undefined,
		// No scored action at all keeps the old reading: there was nothing to
		// choose between.
		confidence: lead ? lead.confidence : 'only-option',
	};
}

/** One active's own ranking: what it does, and how close its second choice was. */
function slotRanking(actions, actorId, nameById) {
	if (!actions.length) return null;
	const top = actions[0];
	const runnerUp = actions[1];
	return {
		actorId,
		species: nameById[actorId] || actorId,
		top: top.label,
		runnerUp: runnerUp ? runnerUp.label : undefined,
		margin: runnerUp ? Number((top.score - runnerUp.score).toFixed(3)) : undefined,
		confidence: !runnerUp ? 'only-option' :
			(top.score - runnerUp.score) >= 2 ? 'decided' : 'contested',
		// Doubles ranks the same move at each target as two actions, so a zero
		// margin there often means the MOVE is settled and only the target is a
		// coin flip — a different warning than "it might do something else". Never
		// true in Singles, where a move has one target.
		targetSplit: !!(runnerUp && top.action.kind === 'move' && runnerUp.action.kind === 'move' &&
			top.action.moveName === runnerUp.action.moveName),
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
	let sacrifice = null;
	for (const evaluation of evaluations) {
		if (evaluation.action.kind !== 'move') continue;
		// `isDamagingFacts` is the policy's own test, so a move that deals no
		// damage here is one the policy also refuses to score as damage —
		// Status moves, and immunities that came out of the calculator as zero.
		if (!ai.isDamagingFacts(evaluation.facts)) continue;
		const damage = ai.scoringDamageFacts(evaluation.facts);
		// A move that faints its user is not this cell's claim: "beats X" and
		// "trades itself for X" are different sentences, and pricing Explosion
		// as the row's best move taught actual suicide as a +3 KO upgrade. The
		// sacrifice line is kept only as a FALLBACK — a mon whose sole damage
		// is Explosion still deals it — and the cell says so.
		const bucket = ai.isSelfSacrificeMove(evaluation.action.moveName) ? 'sacrifice' : 'best';
		const current = bucket === 'sacrifice' ? sacrifice : best;
		if (!current || damage.max > current.damage.max ||
			(damage.max === current.damage.max && damage.min > current.damage.min)) {
			const entry = {move: evaluation.action.moveName, damage};
			if (bucket === 'sacrifice') sacrifice = entry; else best = entry;
		}
	}
	if (best) return best;
	if (sacrifice) return Object.assign({selfKO: true}, sacrifice);
	return null;
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
		// Only present when the cell had to fall back to a move that faints
		// its user: the KO above costs the Pokemon, and every KO accountant
		// downstream must read it as a trade, never a clean answer.
		...(best.selfKO ? {selfKO: true} : {}),
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
 * predictor ranks turns with — so the DAMAGE NUMBERS share one authority: a
 * cell's rolls, clamps and KO booleans come from the policy's own damage
 * facts, never a parallel calculation. The claim stops there, deliberately: a
 * cell reports the best DAMAGING action, while the policy in a real turn may
 * prefer a status or utility move it scores higher — so a cell can name a
 * move `predict` would not lead with. What cannot disagree is the arithmetic;
 * what can is the choice.
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

	// The board is graded under the fight's own sky: a Route 119 cell without
	// its rain claims numbers the fight will never produce.
	const declared = declaredField(profile, fight.trainer);
	const cellField = opts.field !== undefined ? opts.field : declared.field;

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
				field: cellField,
				aiEffects: declared.aiEffects ? Object.assign({}, declared.aiEffects) : undefined,
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
		...(declared.label && opts.field === undefined ? {fightField: declared.label} : {}),
		grid,
	};
}

/**
 * Can a Pokemon hold this, as far as the calculator is concerned?
 *
 * A bag holds whatever the player says it holds — Rare Candy, Heart Scales,
 * a bike — and most of it is not a held item. A caller building candidate
 * builds asks here first, because the alternative is discovering it as the
 * refusal `playerStateFromEntry` throws halfway through a grid. Same gen and
 * same lookup as that check, so the two can never disagree.
 */
function holdableItem(name) {
	return !!(name && calc.Generations.get(8).items.get(calc.toID(name)));
}

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

module.exports = {
	loadRunMap, listFights, getFight, upcoming, buildFightState, predict,
	playerStateFromEntry, matchup, holdableItem,
};
