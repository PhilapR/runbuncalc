/* eslint-env node, es6 */
'use strict';

/**
 * The battle driver — one trainer fight, played turn by turn in the browser.
 *
 * This is what makes the run PLAYABLE without the game running beside it: the
 * player picks a move, the trainer answers with the real AI policy, and the
 * same engine that adjudicates rollouts resolves the turn. Nothing here
 * invents mechanics — every transition is `ai/`'s, every fight is
 * `planner.buildFightState`'s (declared weather included), and the party
 * enters at the projected cap exactly as the planner grades it, because the
 * infinite candy IS this product's XP system.
 *
 * STATELESS ON PURPOSE, like every other server surface: the whole battle
 * bundle travels with each request and comes back changed. The seed rides in
 * the bundle, and each half-step draws from a stream derived from
 * (seed, step), so a replayed request resolves identically instead of
 * re-rolling until the crit lands.
 *
 * The turn contract mirrors the game's:
 *   - phase 'choose':  both actives stand; the player sends a move or a
 *     voluntary switch. The AI picks blind (it has not seen the choice),
 *     `ai.orderActions` settles who goes first, both resolve.
 *   - phase 'replace': the player's active fainted mid-turn; the turn is NOT
 *     advanced yet. The player names the replacement — the same moment the
 *     game asks — then end-of-turn effects run. The AI side never pauses: its
 *     replacements are the policy's own forced-switch pick.
 *
 * A pending forced switch (Eject Button, Roar) freezes BOTH sides' move
 * enumeration until answered — Brawly's Lopunny taught the rollout harness
 * that the hard way — so the driver drains AI-side pendings eagerly and turns
 * player-side pendings into the same 'replace' phase a faint uses.
 */

const planner = require('./planner');
const ai = require('../ai');

function mulberry32(seed) {
	return function () {
		seed |= 0; seed = seed + 0x6D2B79F5 | 0;
		let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
		t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
		return ((t ^ t >>> 14) >>> 0) / 4294967296;
	};
}

/** One RNG stream per (seed, step): replays resolve identically. */
function streamFor(seed, step) {
	return mulberry32((seed ^ Math.imul(step + 1, 0x9E3779B9)) | 0);
}

/**
 * PP model, OFF by default. The bridge builds every move as a name only,
 * so both sides of every fight here have always run with pp undefined —
 * infinite fuel. The engine models PP completely and activates the moment
 * a move defines it (ai transition deducts, eligibility filters at zero,
 * exhaustion forces Struggle), so filling pp at construction is the whole
 * switch. Off by default because every fixture and parity gate was
 * recorded fuel-free; the scenarios/ A/B decides whether the model earns
 * the default. The finding: docs/MODELLING-GAPS.md, 2026-08-30 addendum.
 */
let ppModelOn = false;
function setPPModel(on) { ppModelOn = !!on; }

/**
 * Whether a VOLUNTARY switch carries a price, as a forced replacement does.
 *
 * The policy's lost-race switch sent in whatever "resists", and it judged
 * resistance by the move on the threat line — the foe's hardest hit against
 * the body IN PLAY. At Lass Haley that sent Rhyhorn in against Air Slash on
 * all twenty seeds, and Lumineon's Surf killed it (commit 776bfdd). A priced
 * switch seats the candidate and asks what the foe does to IT. ON by default
 * since 2026-09-18: measured on 77 held-out fights (real PP +84, p < 0.0001,
 * receipts 540165b) and adopted by the operator with the re-pick. The panel
 * shows the price as it does for a forced replacement. `false` restores the
 * unpriced switch, for an arm that measures against it.
 */
let switchPricingOn = true;
function setSwitchPricing(on) { switchPricingOn = !!on; }
function switchPricing() { return switchPricingOn; }

/**
 * Whether move damage is priced against where the foe WILL be when the move
 * lands, around a charge move that hides it (Fly, Bounce, Dig, Dive, Phantom
 * Force, Shadow Force). OFF by default until the battery measures it.
 * Fisherman Darian (fight #7): Chimchar's Ember was priced at full into a
 * faster Magikarp about to Bounce and hit nothing; on the turn it came down,
 * every move was priced at 0 into the hidden state and the policy switched
 * out instead of hitting it. Two Level 12 Magikarp took 14 turns.
 */
let hidingForecastOn = false;
let hidingRepriced = 0;
function setHidingForecast(on) { hidingForecastOn = !!on; }
/** How many action lists the hiding turn has repriced, for the battery's unfired-flag audit. */
function hidingForecasts() { return hidingRepriced; }

const HIDING_MOVES = new Set(['fly', 'bounce', 'dig', 'dive', 'phantomforce', 'shadowforce']);

/** The foe's move with the highest expected score: what its AI most likely picks. */
function likelyFoeMove(state) {
	let best = null;
	let bestScore = -Infinity;
	for (const entry of ai.evaluateActions(state, ai.calculateActionFacts, 'ai')) {
		if (entry.action.kind !== 'move') continue;
		const score = (entry.outcomes || []).reduce((sum, outcome) => sum + outcome.score * outcome.probability, 0);
		if (score > bestScore) { best = entry.action; bestScore = score; }
	}
	return best;
}

/**
 * The state our moves land in this turn, when a hiding charge move moves the
 * foe before we do: a faster foe already hidden comes down first (priced on
 * the ground); a faster foe about to hide goes up first (priced hidden, so
 * only the moves that reach it do damage). Null when nothing changes.
 */
function hidingTurn(state) {
	const us = findMon(state, activeOf(state, 'player'));
	const them = findMon(state, activeOf(state, 'ai'));
	if (!us || !them || us.hp.current <= 0 || them.hp.current <= 0) return null;
	if (trueSpeed(state, them) <= trueSpeed(state, us)) return null;
	const withCharge = charge => Object.assign({}, state, {sides: Object.assign({}, state.sides, {
		ai: Object.assign({}, state.sides.ai, {party: state.sides.ai.party.map(mon => mon.id !== them.id ? mon :
			Object.assign({}, mon, {volatile: Object.assign({}, mon.volatile, {charge})}))}),
	})});
	const hidden = them.volatile && them.volatile.charge && HIDING_MOVES.has(moveKey(them.volatile.charge.moveName));
	if (hidden) return withCharge(null);
	let likely = null;
	try { likely = likelyFoeMove(state); } catch (error) { return null; }
	if (!likely || !HIDING_MOVES.has(moveKey(likely.moveName))) return null;
	return withCharge({moveName: likely.moveName, targetIds: [us.id]});
}
function fillPP(state) {
	if (!ppModelOn) return state;
	for (const sideId of ['player', 'ai']) {
		for (const mon of state.sides[sideId].party) {
			for (const move of mon.moves || []) {
				if (move.pp !== undefined) continue;
				const max = ai.getMoveMaxPP(move.name, state.generation);
				if (max) { move.maxPP = max; move.pp = max; }
			}
		}
	}
	return state;
}

const activeOf = (state, sideId) => state.sides[sideId].activeIds[0];
const findMon = (state, id) =>
	[...state.sides.ai.party, ...state.sides.player.party].find(mon => mon.id === id);
const sideOut = (state, sideId) => state.sides[sideId].party.every(mon => mon.hp.current <= 0);
const alive = (state, id) => {
	const mon = findMon(state, id);
	return !!mon && mon.hp.current > 0;
};

/**
 * Still on the field to act. A mon forced out mid-turn — Eject Button, Red
 * Card, Roar, Dragon Tail — loses the action it queued, as in the game; the
 * engine rightly refuses a move from the bench, and the driver used to hand
 * it one (Brawly's Lopunny, Eject Button, brkeys3b-A-7 seed 2, 2026-09-18).
 */
const onField = (state, id) => ['player', 'ai'].some(side => state.sides[side].activeIds.includes(id));

const moveKey = name => String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * A move chosen at the top of the turn that something faster locked out
 * before it acted. Encore makes the Pokemon use the encored move instead
 * (the modern rule this fork plays by); Taunt on a status move, Disable,
 * Torment and Imprison make the move fail and the turn is lost. The engine
 * enforces these when actions are offered, so a queued move they caught
 * mid-turn was refused as illegal — Accelgor's Encore on a Donphan that had
 * queued Knock Off. Returns the action to use, or null when it fails.
 */
function lockedOut(state, action, events) {
	if (action.kind !== 'move') return action;
	const actor = findMon(state, action.actorId);
	const volatile = (actor && actor.volatile) || {};
	const encored = volatile.encore && volatile.encore.moveName;
	if (encored && moveKey(encored) !== moveKey(action.moveName) &&
		actor.moves.some(move => moveKey(move.name) === moveKey(encored))) {
		return Object.assign({}, action, {moveName: actor.moves.find(move => moveKey(move.name) === moveKey(encored)).name});
	}
	const status = ai.getMoveMetadata(action.moveName, state.generation).category === 'Status';
	const last = (state.lastMoveByPokemon || {})[actor.id];
	const foeSide = state.sides.ai.party.some(mon => mon.id === actor.id) ? 'player' : 'ai';
	const imprisoned = state.sides[foeSide].activeIds.some(id => {
		const foe = findMon(state, id);
		return foe && foe.hp.current > 0 && ((foe.volatile || {}).imprison || {}).moveNames &&
			foe.volatile.imprison.moveNames.some(name => moveKey(name) === moveKey(action.moveName));
	});
	const blocked = (volatile.taunt && status) ||
		(volatile.disable && moveKey(volatile.disable.moveName) === moveKey(action.moveName)) ||
		(volatile.torment && last && moveKey(last) === moveKey(action.moveName)) || imprisoned;
	if (!blocked) return action;
	events.push({text: `${actor.species} can't use ${action.moveName}!`});
	return null;
}

/**
 * The three ways a body waits to be replaced: a forced switch (a faint, an
 * Eject Button, U-turn), a Baton Pass and a Substitute pass. The driver read
 * only the first, so a Baton Pass never brought its replacement in: Battle
 * Girl Vivian's Prankster Volbeat passed, stayed listed active, and our
 * Double-Edge at it was refused; our own Baton Pass never asked us for a
 * replacement at all. enumerateForcedSwitchActions already answers all three.
 */
const PENDING_KEYS = ['pendingForcedSwitchIds', 'pendingBatonPassIds', 'pendingSubstitutePassIds'];

// A body dragged out (Whirlwind) or leaving (Emergency Exit) waits for its
// replacement and does not act: the engine refused the move it had queued
// (Porygon2's Trick Room, Golisopod's Leech Life).
const leaving = (state, id) => PENDING_KEYS.some(key => (state[key] || []).includes(id));

function pendingOn(state, sideId) {
	return PENDING_KEYS.some(key => (state[key] || [])
		.some(id => state.sides[sideId].party.some(mon => mon.id === id)));
}

/** The state with every pending replacement `reject` names removed. */
function clearPending(state, reject) {
	const next = Object.assign({}, state);
	for (const key of PENDING_KEYS) {
		if ((state[key] || []).length) next[key] = state[key].filter(id => !reject(id));
	}
	return next;
}

/**
 * Drain the AI side's forced replacements (faints and pending forced
 * switches), and clear a pending that has nobody left to answer it so it
 * cannot freeze the fight. The player side is NEVER auto-switched here —
 * choosing the replacement is the player's turn to talk.
 */
function settleAiSide(state, events) {
	let guard = 0;
	for (;;) {
		if (guard++ > 16) break;
		const activeId = activeOf(state, 'ai');
		const active = state.sides.ai.party.find(mon => mon.id === activeId);
		const fainted = active && active.hp.current <= 0;
		const pending = pendingOn(state, 'ai');
		if (!fainted && !pending) break;
		const actions = ai.enumerateForcedSwitchActions(state, 'ai');
		if (actions.length) {
			state = ai.applyAction(state, actions[0]);
			const incoming = findMon(state, activeOf(state, 'ai'));
			if (incoming) events.push({text: `The foe sent out ${incoming.species}.`});
		} else if (pending && !fainted) {
			state = clearPending(state, id => state.sides.ai.party.some(mon => mon.id === id));
		} else {
			break;
		}
	}
	return state;
}

/** A player-side pending forced switch with nobody to answer it is cleared
 * the same way, so an Eject Button on the last mon cannot freeze the turn. */
function clearDeadPlayerPending(state) {
	if (!pendingOn(state, 'player')) return state;
	if (ai.enumerateForcedSwitchActions(state, 'player').length) return state;
	const playerActive = findMon(state, activeOf(state, 'player'));
	if (playerActive && playerActive.hp.current <= 0) return state;
	return clearPending(state, id => state.sides.player.party.some(mon => mon.id === id));
}

/** Singles retarget: whatever the enumeration aimed at, the move lands on the
 * CURRENT foe active — the one that switched in mid-turn included. A move
 * that never aimed at the opponent (Splash, Camouflage, a self-boost) keeps
 * its own targets: forcing a foe onto it fails the engine's legality check,
 * which is how a random-policy wild Buneary taught this function about
 * Splash. */
function retarget(state, action) {
	if (action.kind !== 'move') return action;
	const foeSide = state.sides.ai.party.some(mon => mon.id === action.actorId) ? 'player' : 'ai';
	const aimedAtFoe = (action.targetIds || []).some(id =>
		state.sides[foeSide].party.some(mon => mon.id === id));
	if (!aimedAtFoe) return action;
	const target = activeOf(state, foeSide);
	if (!target || !alive(state, target)) return null;
	return Object.assign({}, action, {targetIds: [target]});
}

/** Deaths are the events a nuzlocke is about: compare who stood before and
 * after one application and write the epitaph while the killer is known. */
function recordFaints(before, after, byMove, ofMonId, events, faints) {
	for (const side of ['ai', 'player']) {
		for (const mon of after.sides[side].party) {
			const was = before.sides[side].party.find(prior => prior.id === mon.id);
			if (!was || was.hp.current <= 0 || mon.hp.current > 0) continue;
			const killer = ofMonId ? findMon(after, ofMonId) : null;
			events.push({text: `${mon.species} fainted!`});
			faints.push({
				battleId: mon.id,
				side,
				species: mon.species,
				by: byMove || null,
				of: killer ? killer.species : null,
			});
		}
	}
}

/**
 * What the player may do right now, priced: moves carry the calculator's
 * damage forecast (the buttons wear it), switches carry the bench. In the
 * 'replace' phase the ONLY legal answers are the forced switches.
 */
function legalActions(state, options) {
	// A rollout's bundle is lean: its greedy hand reads move damage and the
	// forced replacement's race, and the voluntary switches' pricing is most
	// of an action list's cost (24 of an act's 30 ms).
	const lean = !!(options && options.lean);
	const playerActive = findMon(state, activeOf(state, 'player'));
	const mustReplace = (playerActive && playerActive.hp.current <= 0) || pendingOn(state, 'player');
	if (mustReplace) {
		return ai.enumerateForcedSwitchActions(state, 'player').map(action => ({
			kind: 'switch',
			action,
			species: findMon(state, action.replacementId).species,
			hp: findMon(state, action.replacementId).hp,
			// Who gets sent in is where a fight is spent, and the picker used
			// to see one resist multiplier and a health bar. The same race
			// the threat line runs for the active body, run for each
			// candidate as if it were already in.
			// Forced replacements keep their race even in a lean rollout: a
			// faint is rare, and the greedy hand picks the replacement by it.
			race: benchRace(state, action.replacementId),
		}));
	}
	const landing = hidingForecastOn ? hidingTurn(state) : null;
	const landed = landing ? ai.evaluateActions(landing, ai.calculateActionFacts, 'player') : null;
	if (landing) hidingRepriced += 1;
	const moves = ai.evaluateActions(state, ai.calculateActionFacts, 'player')
		.filter(entry => entry.action.kind === 'move')
		.map(entry => {
			// A priority move acts before the foe moves, where it stands now.
			const there = landed && movePriority(state, entry.action.moveName) <= 0 ?
				landed.find(other => ai.actionKey(other.action) === ai.actionKey(entry.action)) : null;
			const damage = ((there || entry).facts || {}).damage;
			const targetId = entry.action.targetIds && entry.action.targetIds[0];
			const target = targetId ? findMon(state, targetId) : null;
			return {
				kind: 'move',
				action: entry.action,
				move: entry.action.moveName,
				// Keep the number stable as HP falls. The KO flag already answers
				// whether the remaining health is covered; changing 55% into 275%
				// after one hit makes the same move look five times stronger.
				damage: damage && target && target.hp.max ? {
					min: Math.round(damage.min / target.hp.max * 100),
					max: Math.round(damage.max / target.hp.max * 100),
					// The floor is what a plan may rely on: a move that KOs on
					// its WORST roll is a different promise from one that KOs
					// on its best, and only the first survives bad luck.
					floorKO: damage.min >= target.hp.current,
					crit: damage.critMax !== undefined ?
						Math.round(damage.critMax / target.hp.max * 100) : null,
					guaranteedKO: !!damage.guaranteedKO,
				} : null,
			};
		});
	const switches = ai.enumerateSwitchActions(state, 'player').map(action => Object.assign({
		kind: 'switch',
		action,
		species: findMon(state, action.replacementId).species,
		hp: findMon(state, action.replacementId).hp,
	}, switchPricingOn && !lean ? {race: switchRace(state, action.replacementId)} : {}));
	return moves.concat(switches);
}

/**
 * What the active opponent can do to us this turn, at its worst: the hardest
 * crit across its whole movepool, and whether we survive it. Planning is
 * pessimal by design — the fight itself still rolls fair dice.
 */
/**
 * The attrition race a replacement candidate would run, priced by seating it.
 *
 * attritionRace and the foe's ceiling both read the ACTIVE bodies, so the
 * bench could never be priced — the replacement picker saw one resist
 * multiplier and a health bar, which is how Bayleef was sent into an Ice
 * Beam Poliwhirl. A cloned state with the candidate seated asks the exact
 * machinery the threat line already trusts. The battle bundle round-trips
 * through the client as JSON, so the clone is safe by construction.
 */
function benchRace(state, id) {
	let seated;
	try {
		seated = structuredClone(state);
	} catch (error) {
		return null;
	}
	seated.sides.player.activeIds = [id];
	const us = findMon(seated, id);
	const them = findMon(seated, activeOf(seated, 'ai'));
	if (!us || !them || !us.hp || us.hp.current <= 0) return null;
	let ceiling = 0;
	for (const entry of ai.evaluateActions(seated, ai.calculateActionFacts, 'ai')) {
		if (entry.action.kind !== 'move' || !ai.isDamagingFacts(entry.facts)) continue;
		const damage = ai.scoringDamageFacts(entry.facts);
		const top = damage.critMax !== undefined ? damage.critMax : damage.max;
		if (top > ceiling) ceiling = top;
	}
	if (!ceiling) return null;
	return attritionRace(seated, us, them, ceiling);
}

/**
 * The race a VOLUNTARY switch would run: benchRace, less the hit it concedes.
 *
 * A forced replacement comes in free; a voluntary one eats the foe's hit on
 * the way in, and that hit is one of the turns the race counts. So the
 * candidate lives one fewer of their turns, and a body the entry hit kills
 * has lost before it acts. Same words as attritionRace, so the panel's
 * tooltip and the policy's raceRank read it unchanged.
 */
/**
 * The event for a transition the engine refused.
 *
 * The fight goes on — one illegal transition must not eat a live player's
 * fight — but the refusal is a DEFECT, and it read as a flinch. A Burn Up
 * user was unhittable for weeks that way: every foe move threw, every throw
 * became a lost turn, and 113 battery wins were built on it (ledger
 * burn-up-user-is-unhittable). `engineRefusal` makes it data, so the battery
 * counts it and refuses the batch instead of anyone having to read the text.
 */
function refusalEvent(species, error) {
	return {text: `${species} flinched at the engine: ${error.message}`, engineRefusal: true};
}

function switchRace(state, id) {
	const race = benchRace(state, id);
	if (!race) return null;
	const turnsToDie = race.turnsToDie - 1;
	let outcome;
	if (race.turnsToKill === null) outcome = 'cannot-win';
	else if (turnsToDie <= 0) outcome = 'lose';
	else if (race.turnsToKill < turnsToDie) outcome = 'win';
	else if (race.turnsToKill > turnsToDie) outcome = 'lose';
	else outcome = race.faster ? 'win' : 'lose';
	return {turnsToKill: race.turnsToKill, turnsToDie, faster: race.faster, outcome};
}

function incomingThreat(state) {
	const us = findMon(state, activeOf(state, 'player'));
	const them = findMon(state, activeOf(state, 'ai'));
	if (!us || !them || !us.hp.max) return null;
	let worst = null;
	let pursuit = null;
	for (const entry of ai.evaluateActions(state, ai.calculateActionFacts, 'ai')) {
		if (entry.action.kind !== 'move') continue;
		if (!ai.isDamagingFacts(entry.facts)) continue;
		const damage = ai.scoringDamageFacts(entry.facts);
		const ceiling = damage.critMax !== undefined ? damage.critMax : damage.max;
		if (!worst || ceiling > worst.ceiling) {
			worst = {move: entry.action.moveName, ceiling, max: damage.max};
		}
		// Pursuit doubles its power against a body on the way out, and the
		// Run & Bun AI clicks it on the prediction. Damage is linear in
		// power, so twice the standing hit is the price of the switch —
		// which the hardest-hit number cannot say, because standing Pursuit
		// is one of the foe's weakest moves.
		if (entry.action.moveName === 'Pursuit') {
			const caught = damage.max * 2;
			pursuit = {
				max: Math.round(caught / us.hp.max * 100),
				kills: caught >= us.hp.current,
			};
		}
	}
	if (!worst) {
		return {move: null, max: 0, crit: 0, survivesCrit: true, survivesTwoCrits: true,
			race: null, pursuit: null};
	}
	return {
		move: worst.move,
		max: Math.round(worst.max / us.hp.max * 100),
		crit: Math.round(worst.ceiling / us.hp.max * 100),
		survivesCrit: us.hp.current > worst.ceiling,
		survivesTwoCrits: us.hp.current > worst.ceiling * 2,
		race: attritionRace(state, us, them, worst.ceiling),
		pursuit: pursuit,
	};
}

/**
 * Who runs out of HP first — the question "can I survive one hit" cannot ask.
 *
 * A full nuzlocke wiped to a Yanma's Sonic Boom while the panel read
 * "survives one crit, not two". That sentence is TRUE and reads as a mild
 * caution. The real position was 2 turns to die against 8 turns to kill:
 * Sonic Boom is a fixed 20 into 34 HP, and the best answer available did 5 on
 * its floor into 38 HP. Losing a race four to one is not a caution.
 *
 * Pessimal on both sides, the same fold the rest of the planning uses: THEIR
 * ceiling lands every turn (crits included), OUR floor is all we may count on.
 * Speed only decides a tie, because the faster side gets the last hit in.
 */
function attritionRace(state, us, them, theirCeiling) {
	if (!theirCeiling || !them.hp || !them.hp.current) return null;
	let ourFloor = 0;
	// A priority move that KOs on its worst roll moves first whatever the
	// speeds. The race read Speed only, so a Quick Attack Manectric facing a
	// sashed Mienshao at 1% read as a lost race and was never sent in, while
	// five slower bodies came in one by one to "KO" it and were Reversed
	// first (Aqua Admin Shelly, 0 of 80 attempts).
	let priorityKO = false;
	for (const entry of ai.evaluateActions(state, ai.calculateActionFacts, 'player')) {
		if (entry.action.kind !== 'move' || !ai.isDamagingFacts(entry.facts)) continue;
		const damage = ai.scoringDamageFacts(entry.facts);
		if (damage && damage.min > ourFloor) ourFloor = damage.min;
		if (damage && damage.min >= them.hp.current && movePriority(state, entry.action.moveName) > 0) {
			priorityKO = true;
		}
	}
	if (priorityKO) return {turnsToKill: 1, turnsToDie: Math.ceil(us.hp.current / theirCeiling), faster: true,
		outcome: 'win', priority: true};
	const turnsToDie = Math.ceil(us.hp.current / theirCeiling);
	// No damaging answer at all is not a slow race, it is an unwinnable one.
	const turnsToKill = ourFloor > 0 ? Math.ceil(them.hp.current / ourFloor) : null;
	const faster = speedOf(state, us) > speedOf(state, them);
	let outcome;
	if (turnsToKill === null) outcome = 'cannot-win';
	else if (turnsToKill < turnsToDie) outcome = 'win';
	else if (turnsToKill > turnsToDie) outcome = 'lose';
	else outcome = faster ? 'win' : 'lose';
	return {turnsToKill, turnsToDie, faster, outcome};
}

/** A move's priority bracket (0 when the metadata does not say). */
function movePriority(state, moveName) {
	try {
		return ai.getMoveMetadata(moveName, state.generation || 8).priority || 0;
	} catch (error) {
		return 0;
	}
}

/** Effective Speed, so a tie in the race is broken by who moves first. */
/**
 * Whether races read the engine's effective Speed. OFF by default until the
 * battery measures it: speedOf called ai.buildStats, which the engine has
 * never exported, and the state's mons carry no stat block, so every Speed
 * read 0 from 3b9f53e (2026-08-21) on. race.faster was always false, every
 * tied race read lost, and the threat line said "they act first" every turn.
 */
let realSpeedOn = false;
let speedReads = 0;
function setRealSpeed(on) { realSpeedOn = !!on; }
/** How many Speed reads the real-speed switch served, for the unfired-flag audit. */
function realSpeedReads() { return speedReads; }

/** The engine's effective Speed: stages, paralysis, Tailwind, items, abilities. */
function trueSpeed(state, mon) {
	return ai.getEffectivePokemonSpeed(state, mon.id);
}

function speedOf(state, mon) {
	if (realSpeedOn) {
		speedReads += 1;
		return trueSpeed(state, mon);
	}
	try {
		const built = ai.buildStats ? ai.buildStats(state, mon.id) : null;
		if (built && typeof built.spe === 'number') return built.spe;
	} catch (error) {
		// fall through to the stat block the state already carries
	}
	return (mon.stats && mon.stats.spe) || 0;
}

/** The compact view the panel draws: actives with HP, benches as chips. */
/**
 * The volatiles a player has to see to choose this turn's action.
 *
 * The card carried `status` and nothing else, so the one condition a SWITCH
 * cures was the one the screen never showed: infatuation costs half your
 * turns, is cleared by the ordinary switch reset, and appeared only as a line
 * in the scrolling log. Measured over 66 scripted fights it was 13 of 58 lost
 * turns. Confusion is the same shape; Leech Seed and the two trapping states
 * change whether switching is even an option.
 *
 * Deliberately not the whole `VolatileStatusName` union — most of it is
 * bookkeeping (`landed`, `roost`, `charged`) that would be noise on a card.
 */
const SHOWN_VOLATILES = [
	'infatuated', 'confusion', 'leechSeed', 'trapped', 'partiallyTrapped',
	'taunt', 'encore', 'disable', 'torment', 'yawn', 'nightmare', 'perishSong',
];

const VOLATILE_LABELS = {
	infatuated: 'infatuated', confusion: 'confused', leechSeed: 'seeded',
	trapped: 'trapped', partiallyTrapped: 'trapped', taunt: 'taunted',
	encore: 'encored', disable: 'disabled', torment: 'tormented',
	yawn: 'drowsy', nightmare: 'nightmare', perishSong: 'perish song',
};

function shownVolatilesOf(mon) {
	const active = mon.volatile || {};
	const seen = [];
	for (const name of SHOWN_VOLATILES) {
		if (!active[name]) continue;
		const label = VOLATILE_LABELS[name];
		if (seen.indexOf(label) === -1) seen.push(label);
	}
	return seen;
}

function view(state) {
	const card = mon => ({
		id: mon.id,
		species: mon.species,
		level: mon.level,
		hp: {current: Math.max(0, mon.hp.current), max: mon.hp.max},
		status: mon.status || null,
		// Cleared by switching, unlike `status` — which is exactly why it has
		// to be on screen next to the switch buttons.
		volatiles: shownVolatilesOf(mon),
		item: mon.item || null,
		types: (mon.types || []).slice(),
		ability: mon.ability || null,
	});
	return {
		turn: state.turn,
		player: {
			active: card(findMon(state, activeOf(state, 'player'))),
			bench: state.sides.player.party.map(card),
		},
		foe: {
			active: card(findMon(state, activeOf(state, 'ai'))),
			bench: state.sides.ai.party.map(card),
		},
	};
}

function phaseOf(state) {
	const playerActive = findMon(state, activeOf(state, 'player'));
	if ((playerActive && playerActive.hp.current <= 0) || pendingOn(state, 'player')) {
		return 'replace';
	}
	return 'choose';
}

function contributionRoster(party, activeBattleId) {
	return (party || []).map(member => ({
		monId: member.monId,
		battleId: member.battleId,
		species: member.species,
		appearances: member.battleId === activeBattleId ? 1 : 0,
		switchIns: 0,
		moveAttempts: 0,
		opposingHpRemoved: 0,
		kos: 0,
	}));
}

function contributionRowsAreValid(bundle) {
	var party = bundle.party || [];
	var rows = bundle.contributions;
	var ids = new Set();
	if (!Array.isArray(rows) || rows.length !== party.length) return false;
	return rows.every(row => {
		if (!row || typeof row.monId !== 'string' || !row.monId ||
			typeof row.battleId !== 'string' || !row.battleId ||
			typeof row.species !== 'string' || !row.species || ids.has(row.monId) ||
			!party.some(member => member.monId === row.monId && member.battleId === row.battleId)) {
			return false;
		}
		ids.add(row.monId);
		var validCounters = ['appearances', 'switchIns', 'moveAttempts', 'opposingHpRemoved', 'kos']
			.every(field => Number.isInteger(row[field]) && row[field] >= 0 && row[field] <= 0xffffffff);
		return validCounters && row.switchIns <= row.appearances &&
			(row.appearances > 0 || row.moveAttempts + row.opposingHpRemoved + row.kos === 0);
	});
}

function contributionState(bundle) {
	var complete = bundle.contributionVersion === 1 && bundle.contributionComplete !== false &&
		contributionRowsAreValid(bundle);
	var rows = complete ? bundle.contributions.map(row => Object.assign({}, row)) :
		contributionRoster(bundle.party, activeOf(bundle.state, 'player'));
	return {complete, rows};
}

function recordContribution(rows, before, after, action) {
	if (!action || typeof action.actorId !== 'string' || action.actorId.indexOf('player') !== 0) return;
	if (action.kind === 'switch') {
		const incoming = rows.find(row => row.battleId === action.replacementId);
		if (incoming) {
			incoming.appearances += 1;
			incoming.switchIns += 1;
		}
		return;
	}
	if (action.kind !== 'move') return;
	const actor = rows.find(row => row.battleId === action.actorId);
	if (!actor) return;
	actor.moveAttempts += 1;
	const opposingIds = new Set(before.sides.ai.party.map(mon => mon.id));
	const targets = (action.targetIds || []).filter(id => opposingIds.has(id));
	for (const id of targets) {
		const prior = findMon(before, id);
		const current = findMon(after, id);
		if (!prior || !current) continue;
		actor.opposingHpRemoved += Math.max(0, prior.hp.current - current.hp.current);
		if (prior.hp.current > 0 && current.hp.current <= 0) actor.kos += 1;
	}
}

function finished(state) {
	if (sideOut(state, 'ai')) return 'win';
	if (sideOut(state, 'player')) return 'loss';
	return null;
}

/**
 * The ball tiers the recreation throws, with Emerald's multipliers. The
 * plain Poke Ball is the free baseline — always offered, never counted —
 * and the better tiers are BAG items: offered while the bundle's bag
 * snapshot still covers what this fight has thrown, and spent into the
 * document (`use` commands) when the fight settles.
 */
const BALLS = {'Poke Ball': 1, 'Great Ball': 1.5, 'Ultra Ball': 2};

/**
 * The Gen 3 capture formula, floors and all — the one mechanic a wild fight
 * has that a trainer fight does not. Sleep and freeze double the odds, any
 * other status is half again, exactly as Emerald rolls it.
 */
function catchMath(mon, rate, ballBonus) {
	const maxHP = mon.hp.max;
	const curHP = Math.max(1, mon.hp.current);
	const status = String(mon.status || '').toLowerCase();
	const bonus = /slp|sleep|frz|freeze/.test(status) ? 2 :
		status ? 1.5 : 1;
	const a = Math.min(255,
		Math.floor(Math.floor((3 * maxHP - 2 * curHP) * rate * (ballBonus || 1) / (3 * maxHP)) * bonus));
	if (a >= 255) return {a, b: 65536, chance: 1};
	const b = Math.floor(1048560 /
		Math.floor(Math.sqrt(Math.floor(Math.sqrt(Math.floor(16711680 / Math.max(1, a)))))));
	return {a, b, chance: Math.pow(b / 65536, 4)};
}

/**
 * Pre-fight catch odds for a rolled encounter, before any battle exists.
 * At full HP the (3*maxHP - 2*curHP) / (3*maxHP) term reduces to 1/3, so
 * the answer needs only the species' catch rate — no stat projection. The
 * free Poke Ball is always quoted; tiered balls only when the bag holds
 * them, with the count, mirroring what the fight itself will offer.
 */
function catchOddsAtFullHp(doc, speciesName) {
	const profile = require('../profiles').getProfile(doc.profileId);
	const rate = profile.oracle.catchRateOf(speciesName);
	if (!rate) throw new Error(`battle: no catch rate on file for ${speciesName}`);
	const fullHp = {hp: {max: 3, current: 3}, status: ''};
	return Object.keys(BALLS)
		.filter(ball => BALLS[ball] === 1 || (doc.bag && doc.bag[ball] > 0))
		.map(ball => ({
			ball,
			chance: Math.round(catchMath(fullHp, rate, BALLS[ball]).chance * 100),
			held: BALLS[ball] === 1 ? null : doc.bag[ball],
		}));
}

/** How the grass fights back: a uniformly random known move, no policy. */
function wildAction(state, rng) {
	const options = ai.enumerateMoveActions(state, 'ai');
	return options.length ? options[Math.floor(rng() * options.length)] : null;
}

/** How many of a ball this fight can still throw: Poke Balls never run out,
 * the tiers count down from the bundle's bag snapshot. */
function ballsLeft(bundle, ball) {
	if (BALLS[ball] === 1) return Infinity;
	const held = (bundle.wild.balls || {})[ball] || 0;
	return held - ((bundle.wild.thrown || {})[ball] || 0);
}

/** Every throwable ball, priced like the move buttons are. */
function ballActions(state, bundle) {
	const wildMon = findMon(state, activeOf(state, 'ai'));
	return Object.keys(BALLS)
		.filter(ball => ballsLeft(bundle, ball) > 0)
		.map(ball => {
			const math = catchMath(wildMon, bundle.wild.rate, BALLS[ball]);
			const left = ballsLeft(bundle, ball);
			return {
				kind: 'ball',
				ball,
				label: ball,
				chance: Math.round(math.chance * 100),
				...(left === Infinity ? {} : {left}),
			};
		});
}

function actionsFor(state, bundle) {
	const base = legalActions(state, {lean: !!bundle.lean});
	if (bundle.wild && phaseOf(state) === 'choose') {
		return base.concat(ballActions(state, bundle));
	}
	return base;
}

/**
 * Open a fight against the run's next trainer (or a named one): the party at
 * the cap it is fought under, the trainer with their declared field. The
 * bundle that comes back is everything `act` needs — the server keeps nothing.
 */
function start(doc, trainerName, seed) {
	const runtime = require('./run');
	if (!doc.party || !doc.party.length) {
		throw new Error('battle: the party is empty — set a party before fighting');
	}
	const ahead = runtime.upcoming(doc, 1);
	const named = trainerName || (ahead.length ? ahead[0].trainer : null);
	if (!named) throw new Error('battle: nothing ahead in the run map to fight');
	const fight = planner.getFight(named, doc.profileId);
	// Doubles are real doubles (operator ruling, 2026-08-28), and this play
	// stack runs one active per side. Every past "win" against an And-spelled
	// pair was adjudicated in the wrong mode; refusing is the honest state
	// until two-active play exists. The run layer lets any double battle be
	// skipped and owed, which is the way past.
	if (fight.isDouble) {
		throw new Error(`battle: ${fight.trainer} is a double battle, and doubles ` +
			'play is not modeled yet — skip the fight (it stays owed) instead of ' +
			'playing it in the wrong mode');
	}
	const specs = runtime.partySpecs(doc, {atOrder: fight.order});
	const built = planner.buildFightState({
		trainer: fight.trainer,
		playerParty: specs,
		profileId: doc.profileId,
	});
	const state = fillPP(built.state);
	const bundle = {
		state,
		seed: Number.isInteger(seed) ? seed : Math.floor(Math.random() * 0x7fffffff),
		step: 0,
		trainer: fight.trainer,
		order: fight.order,
		phase: 'choose',
		// The map from battle ids back to box ids, so a faint in here can be
		// written into the run document out there.
		party: doc.party.map((monId, slot) => ({
			battleId: `player-${slot + 1}`,
			monId,
			species: specs[slot].species,
		})),
	};
	bundle.contributionVersion = 1;
	bundle.contributionComplete = true;
	bundle.contributions = contributionRoster(bundle.party, activeOf(state, 'player'));
	return {
		battle: bundle,
		viewState: view(state),
		actions: legalActions(state),
		threat: incomingThreat(state),
		events: [{text: `${fight.trainer} wants to battle!`}],
	};
}

/**
 * Open a fight against a rolled WILD encounter. The roll is checked against
 * the route's real table — a wild fight is only offered for what that grass
 * can produce — and the wild mon fights with the last level-up moves its
 * rolled level knows, at that level, uncapped. The party enters at the cap
 * of the run's next fight, same as everywhere. The bundle is `act`'s usual,
 * plus `wild`: the roll and the species' catch rate, which is what makes
 * the ball a legal action.
 */
function startWild(doc, roll, seed) {
	const runtime = require('./run');
	if (!doc.party || !doc.party.length) {
		throw new Error('battle: the party is empty — set a party before fighting');
	}
	const wild = roll || {};
	if (!wild.map || !wild.species || !wild.level) {
		throw new Error('battle: a wild fight needs the roll — map, species and level');
	}
	const profile = require('../profiles').getProfile(doc.profileId);
	const table = profile.oracle.encountersOn(wild.map);
	if (!table) throw new Error(`battle: no wild table for ${JSON.stringify(wild.map)}`);
	const slot = table.mons.find(mon => mon.species === wild.species &&
		(!wild.method || mon.method === wild.method) &&
		wild.level >= mon.minLevel && wild.level <= mon.maxLevel);
	if (!slot) {
		throw new Error(`battle: ${wild.species} L${wild.level} is not on ` +
			`${table.name}'s table — fight what the die rolled`);
	}
	const rate = profile.oracle.catchRateOf(wild.species);
	if (!rate) throw new Error(`battle: no catch rate on file for ${wild.species}`);
	const missingIvs = Object.keys(runtime.IV_STATS).filter(stat =>
		!wild.ivs || !Object.prototype.hasOwnProperty.call(wild.ivs, stat));
	if (missingIvs.length) {
		throw new Error(`battle: wild ${wild.species} is missing its rolled IVs: ` +
			`${missingIvs.join(', ')} — roll the encounter once before fighting it`);
	}
	const learned = [];
	for (const pair of profile.oracle.levelUpMoves(wild.species)) {
		if (pair[0] <= wild.level && learned.indexOf(pair[1]) === -1) learned.push(pair[1]);
	}
	// Run & Bun gives a few species NO level-up moves at all (the catch
	// command documents the same quirk); in the game they fight with
	// Struggle, so here they do too.
	if (!learned.length) learned.push('Struggle');
	const ahead = runtime.upcoming(doc, 1);
	const specs = runtime.partySpecs(doc,
		ahead.length ? {atOrder: ahead[0].order} : {});
	const built = planner.buildWildState({
		playerParty: specs,
		wild: {
			species: wild.species,
			level: wild.level,
			moves: learned.slice(-4),
			ivs: wild.ivs,
			nature: wild.nature,
			ability: wild.ability,
		},
		profileId: doc.profileId,
	});
	const bundle = {
		state: fillPP(built.state),
		seed: Number.isInteger(seed) ? seed : Math.floor(Math.random() * 0x7fffffff),
		step: 0,
		trainer: `Wild ${wild.species}`,
		phase: 'choose',
		wild: {
			map: table.name,
			method: slot.method,
			species: wild.species,
			level: wild.level,
			// This same roll drives the wild battle and becomes owned on capture.
			// Never reroll an encounter while its identity crosses that boundary.
			ivs: wild.ivs || null,
			nature: wild.nature || null,
			ability: wild.ability || null,
			rate,
			// The bag's better balls, snapshotted: what this fight may spend.
			// Throws are counted in `thrown` and settled into the document as
			// `use` commands when the fight ends.
			balls: Object.keys(BALLS).reduce((held, ball) => {
				if (BALLS[ball] > 1 && doc.bag && doc.bag[ball] > 0) held[ball] = doc.bag[ball];
				return held;
			}, {}),
			thrown: {},
		},
		party: doc.party.map((monId, slotIndex) => ({
			battleId: `player-${slotIndex + 1}`,
			monId,
			species: specs[slotIndex].species,
		})),
	};
	bundle.contributionVersion = 1;
	bundle.contributionComplete = true;
	bundle.contributions = contributionRoster(bundle.party, activeOf(built.state, 'player'));
	return {
		battle: bundle,
		viewState: view(built.state),
		actions: actionsFor(built.state, bundle),
		threat: incomingThreat(built.state),
		events: [{text: `A wild ${wild.species} appeared!`}],
	};
}

/**
 * Resolve one player decision. In 'choose', that is a full turn: the AI picks
 * blind, order settles, both resolve, end-of-turn runs (unless the player's
 * active fell — then the turn holds for the replacement). In 'replace', the
 * named switch lands and the held end-of-turn runs.
 */
function act(bundle, chosen) {
	if (!bundle || !bundle.state) throw new Error('battle: the battle bundle is required');
	if (!chosen || !chosen.kind) throw new Error('battle: an action is required');
	let state = bundle.state;
	const events = [];
	const faints = [];
	const contribution = contributionState(bundle);
	const rng = streamFor(bundle.seed, bundle.step);
	// A caught fight ends with the wild mon still standing, so the phase is
	// the record of that ending, not the HP table.
	if (finished(state) || bundle.phase === 'done') {
		throw new Error('battle: this fight is over — start another');
	}
	let caught = false;

	const applyOne = (action, label) => {
		const before = state;
		if (action.kind === 'move') {
			const facts = ai.calculateActionFacts(state, action);
			const resolution = ai.deriveMoveResolution(state, action, {facts, random: rng});
			state = ai.applyAction(state, action, resolution);
			const actor = findMon(before, action.actorId);
			const target = action.targetIds && action.targetIds[0] ?
				findMon(state, action.targetIds[0]) : null;
			const was = target && findMon(before, target.id);
			const dealt = target && was ? Math.max(0, was.hp.current - target.hp.current) : 0;
			const failure = {
				flinch: `${actor.species} flinched and could not move!`,
				sleep: `${actor.species} is fast asleep.`,
				freeze: `${actor.species} is frozen solid.`,
				paralysis: `${actor.species} is paralyzed and could not move!`,
				confusion: `${actor.species} hurt itself in confusion!`,
				infatuation: `${actor.species} is immobilized by love.`,
				protect: `${actor.species}'s ${action.moveName} failed.`,
				truant: `${actor.species} is loafing around.`,
			}[resolution.actionFailure];
			if (failure) {
				events.push({text: label + failure});
			} else if (resolution.hit === false) {
				events.push({text: `${label}${actor.species}'s ${action.moveName} missed!`});
			} else {
				// A crit the player cannot see is not an experience. The engine
				// samples the event; the log has to say it landed.
				const crit = (resolution.criticalHitTargets || []).length > 0;
				events.push({text: `${label}${actor.species} used ${action.moveName}.` +
					(crit ? ' A critical hit!' : '') +
					(target && dealt ? ` (${Math.round(dealt / target.hp.max * 100)}% to ${target.species})` : '')});
			}
		} else {
			state = ai.applyAction(state, action);
			const incoming = findMon(state, action.replacementId);
			events.push({text: `${label}${incoming.species} was sent out.`});
		}
		recordContribution(contribution.rows, before, state, action);
		recordFaints(before, state, action.kind === 'move' ? action.moveName : null,
			action.actorId, events, faints);
	};
	// The queued actions of a turn, in order. A player pivot (U-turn, Volt
	// Switch) that sends our body out mid-turn PAUSES the queue: the game
	// brings the replacement in at once and the slower moves land on it, so
	// the rest of the queue waits on the bundle (`resume`) until the player
	// picks the replacement. The driver used to run on, and the slower foe
	// move — aimed at a body already leaving — was refused as illegal (the
	// open ledger entry pivot-leaves-foe-move-without-target).
	const runQueue = queue => {
		for (let index = 0; index < queue.length; index++) {
			const action = queue[index].action || queue[index];
			if (!alive(state, action.actorId) || !onField(state, action.actorId) || leaving(state, action.actorId)) continue;
			const isPlayers = action.actorId.indexOf('player') === 0;
			const unlocked = lockedOut(state, action, events);
			if (!unlocked) continue;
			const aimed = retarget(state, unlocked);
			if (!aimed) continue;
			try {
				applyOne(aimed, isPlayers ? '' : bundle.wild ? 'Wild ' : 'Foe ');
			} catch (error) {
				// One illegal transition must not eat the fight: the actor simply
				// loses the beat (the engine refused it), and the turn goes on.
				events.push(Object.assign(refusalEvent(findMon(state, action.actorId).species, error),
					{action: aimed, turn: state.turn,
						actives: ['player', 'ai'].map(sideId => state.sides[sideId].activeIds.join('+')).join(' / ')}));
			}
			state = settleAiSide(state, events);
			state = clearDeadPlayerPending(state);
			if (finished(state)) return null;
			const playerActive = findMon(state, activeOf(state, 'player'));
			if (pendingOn(state, 'player') && playerActive && playerActive.hp.current > 0 &&
				index + 1 < queue.length) {
				return queue.slice(index + 1).map(entry => entry.action || entry);
			}
		}
		return null;
	};
	let resume = null;


	if (bundle.phase === 'replace') {
		// The one legal answer is a forced switch; anything else is refused by
		// name so a stale client learns what phase it is in.
		if (chosen.kind !== 'switch') {
			throw new Error('battle: a replacement must be chosen first');
		}
		const legal = ai.enumerateForcedSwitchActions(state, 'player')
			.find(action => action.replacementId === chosen.replacementId);
		if (!legal) {
			throw new Error(`battle: ${JSON.stringify(chosen.replacementId)} is not a legal replacement`);
		}
		applyOne(legal, '');
		state = settleAiSide(state, events);
		// A turn paused on a pivot resumes now, against the body that came in.
		if (bundle.resume && bundle.resume.length && !finished(state)) runQueue(bundle.resume);
		// The held end-of-turn now runs — the same order the engine's own
		// rollouts resolve (replacement first, then the turn boundary).
		if (!finished(state) && phaseOf(state) !== 'replace') state = ai.advanceTurn(state, {random: rng});
	} else if (chosen.kind === 'ball') {
		// The throw is the player's whole turn, exactly as the game plays it:
		// a break-out gives the wild mon its move.
		if (!bundle.wild) {
			throw new Error('battle: only a wild encounter takes a ball');
		}
		const ball = chosen.ball || 'Poke Ball';
		if (!BALLS[ball]) {
			throw new Error(`battle: ${JSON.stringify(ball)} is not a ball this recreation throws — ` +
				`it has: ${Object.keys(BALLS).join(', ')}`);
		}
		if (ballsLeft(bundle, ball) < 1) {
			throw new Error(`battle: no ${ball} left — this fight has thrown ` +
				`${(bundle.wild.thrown || {})[ball] || 0} and the bag held ` +
				`${(bundle.wild.balls || {})[ball] || 0}`);
		}
		bundle = Object.assign({}, bundle, {wild: Object.assign({}, bundle.wild,
			{thrown: Object.assign({}, bundle.wild.thrown,
				{[ball]: ((bundle.wild.thrown || {})[ball] || 0) + 1})})});
		const wildMon = findMon(state, activeOf(state, 'ai'));
		const math = catchMath(wildMon, bundle.wild.rate, BALLS[ball]);
		events.push({text: `You threw a ${ball}!`});
		let shakes = 0;
		while (shakes < 4 && Math.floor(rng() * 65536) < math.b) shakes++;
		if (shakes === 4) {
			caught = true;
			events.push({text: `Gotcha! The wild ${wildMon.species} was caught!`});
		} else {
			events.push({text: shakes === 0 ? 'The ball missed the mark entirely!' :
				`It shook ${shakes} time${shakes === 1 ? '' : 's'}... and broke free!`});
			const answer = wildAction(state, rng);
			const aimed = answer ? retarget(state, answer) : null;
			if (aimed) {
				try {
					applyOne(aimed, 'Wild ');
				} catch (error) {
					// Same contract as the trainer loop: one illegal transition
					// loses the actor its beat, never the fight.
					events.push(refusalEvent(findMon(state, aimed.actorId).species, error));
				}
			}
			state = settleAiSide(state, events);
			state = clearDeadPlayerPending(state);
			if (!finished(state) && phaseOf(state) !== 'replace') {
				state = ai.advanceTurn(state, {random: rng});
			}
		}
	} else {
		// Reconstruct the chosen action against the CURRENT state — the client
		// sends intent (a move name, a replacement id), never a raw transition.
		let playerAction = null;
		if (chosen.kind === 'move') {
			playerAction = ai.enumerateMoveActions(state, 'player')
				.find(action => action.moveName === chosen.move);
			if (!playerAction) {
				throw new Error(`battle: ${JSON.stringify(chosen.move)} is not usable right now`);
			}
		} else if (chosen.kind === 'switch') {
			const legal = ai.enumerateSwitchActions(state, 'player')
				.find(action => action.replacementId === chosen.replacementId);
			if (!legal) {
				throw new Error(`battle: ${JSON.stringify(chosen.replacementId)} is not a legal switch`);
			}
			playerAction = legal;
		} else {
			throw new Error(`battle: unknown action kind ${JSON.stringify(chosen.kind)}`);
		}

		let aiPick = null;
		if (bundle.wild) {
			// Wild mons do not run the trainer policy: the grass picks at
			// random, off the same seeded stream everything else rolls on.
			const answer = wildAction(state, rng);
			aiPick = answer ? {action: answer} : null;
		} else {
			try {
				aiPick = ai.chooseStateAction(state, ai.calculateActionFacts, 'ai', rng,
					{includeSwitches: false});
			} catch (error) {
				aiPick = null; // a policy with nothing to say forfeits its action, never the fight
			}
		}
		const entries = ai.orderActions(state,
			[aiPick && aiPick.action, playerAction].filter(Boolean), {random: rng});
		resume = runQueue(entries);
		// End-of-turn effects wait for the player's replacement when their
		// active fell mid-turn; otherwise the turn closes now.
		if (!finished(state) && phaseOf(state) !== 'replace') {
			state = ai.advanceTurn(state, {random: rng});
		}
	}

	state = settleAiSide(state, events);
	const result = caught ? 'catch' : finished(state);
	const phase = result ? 'done' : phaseOf(state);
	// Epitaphs ride the bundle: the server keeps nothing, so each turn's
	// player-side faints are folded in here, where the killer is still known.
	const carried = (bundle.deaths || []).slice();
	for (const death of faints) {
		if (death.side !== 'player') continue;
		if (!carried.some(existing => existing.battleId === death.battleId)) {
			carried.push(death);
		}
	}
	// The tape: every chosen action, in order, riding the bundle. With the
	// per-(seed, step) streams above, (seed, tape) replays the whole fight
	// exactly — against the engine revision that played it, which is why
	// battle.ended binds the engine identity beside the tape.
	const tape = (bundle.tape || []).concat([Object.assign({step: bundle.step},
		chosen.kind === 'move' ? {kind: 'move', move: chosen.move} :
			chosen.kind === 'switch' ? {kind: 'switch', replacementId: chosen.replacementId} :
				{kind: 'ball', ball: chosen.ball || 'Poke Ball'})]);
	const next = Object.assign({}, bundle, {state, step: bundle.step + 1, phase, deaths: carried,
		tape, resume: resume && resume.length ? resume : null,
		contributionVersion: 1, contributionComplete: contribution.complete,
		contributions: contribution.rows});
	const monIdOf = battleId => {
		const row = (bundle.party || []).find(member => member.battleId === battleId);
		return row ? row.monId : null;
	};
	return {
		battle: next,
		viewState: view(state),
		events,
		phase,
		result,
		threat: result ? null : incomingThreat(state),
		// Player-side deaths with the epitaph fields `faint` wants, box ids
		// attached; reported ONLY at the end so a mid-fight refresh cannot
		// half-record a fight.
		deaths: result ? next.state.sides.player.party
			.filter(mon => mon.hp.current <= 0)
			.map(mon => {
				const known = carried.find(death => death.battleId === mon.id) || {};
				return {
					monId: monIdOf(mon.id),
					species: mon.species,
					by: known.by || null,
					of: known.of || null,
				};
			}) : [],
		actions: result ? [] : actionsFor(state, next),
	};
}

/**
 * Adjudicate a fight: play it to the end N times under a mechanical policy
 * and report what actually happened — the calibration layer the grid score
 * cannot provide (a full-HP damage matrix knows nothing of speed order or
 * attrition; a 3.28 "all answered" six wiped 30/30 Brawly rollouts while a
 * 0.62 six won 26/30, which is how this function earned its place).
 *
 * The policy is the assignment-following player: switch to the mon the
 * ranker says answers the enemy's active (when alive and not already in),
 * otherwise the best move by the driver's own forecast — guaranteed KO
 * first, then max damage. Replacements pick the assignment too. It is a
 * FLOOR, not optimal play: real players do better, so pWin here is a lower
 * bound and a comparison key, never a promise.
 *
 * Deterministic on purpose: seeds derive from `seedBase`, so the same box
 * asks the same question and gets the same answer twice.
 */
/** One seeded rollout under the floor policy, with its whole story: the
 * turn-by-turn narration, the ending, the fallen. Both adjudication and the
 * playbook read from this one tape deck so their numbers can never drift. */
/**
 * One assignment-following playout, with voluntary switches left unpriced.
 *
 * The playout picks its switches by id from the answer assignment and never
 * reads a voluntary switch's race, so pricing them here is pure cost: with
 * pricing on by default, a twelve-rollout adjudication built 21,646
 * calculator objects against a measured 12,994 and broke its budget
 * (tests/adjudication_cost.test.js). Off for the playout and restored after,
 * which is safe because a playout is synchronous from start to finish.
 */
function playRollout(doc, trainerName, seed, answerFor) {
	const priced = switchPricingOn;
	switchPricingOn = false;
	try {
		return playAssignment(doc, trainerName, seed, answerFor);
	} finally {
		switchPricingOn = priced;
	}
}

function playAssignment(doc, trainerName, seed, answerFor) {
	const best = actions => {
		const moves = actions.filter(entry => entry.kind === 'move');
		if (!moves.length) return actions[0] || null;
		return moves.reduce((top, entry) => {
			const score = entry.damage ?
				(entry.damage.guaranteedKO ? 1000 : 0) + entry.damage.max : 0;
			const topScore = top.damage ?
				(top.damage.guaranteedKO ? 1000 : 0) + top.damage.max : 0;
			return score > topScore ? entry : top;
		});
	};

	const opened = start(doc, trainerName, seed);
	let bundle = opened.battle;
	let actions = opened.actions;
	let viewState = opened.viewState;
	const events = opened.events.map(event => event.text);
	let guard = 0;
	let reply = null;
	while (guard++ < 120) {
		if (!actions.length) break;
		let chosen = null;
		const want = answerFor[viewState.foe.active.species];
		const wantAlive = want && viewState.player.bench.some(mon =>
			mon.id === want && mon.hp.current > 0);
		const swap = actions.find(entry => entry.kind === 'switch' &&
			entry.action.replacementId === want);
		if (wantAlive && want !== viewState.player.active.id && swap) {
			chosen = {kind: 'switch', replacementId: want};
		} else {
			const pick = best(actions);
			chosen = pick.kind === 'move' ?
				{kind: 'move', move: pick.move} :
				{kind: 'switch', replacementId: pick.action.replacementId};
		}
		reply = act(bundle, chosen);
		bundle = reply.battle;
		actions = reply.actions;
		viewState = reply.viewState;
		for (const event of reply.events) events.push(event.text);
		if (reply.result) break;
	}
	return {
		seed,
		result: reply && reply.result ? reply.result : 'unresolved',
		lost: bundle.state.sides.player.party.filter(mon => mon.hp.current <= 0).length,
		turns: viewState.turn,
		events,
		deaths: reply && reply.result ? reply.deaths : [],
	};
}

function adjudicate(doc, trainerName, options) {
	options = options || {};
	const rollouts = options.rollouts === undefined ? 12 : options.rollouts;
	const seedBase = options.seedBase === undefined ? 1000 : options.seedBase;
	const answerFor = options.answerFor || {};

	let wins = 0;
	let deaths = 0;
	let deathless = 0;
	for (let i = 0; i < rollouts; i++) {
		const story = playRollout(doc, trainerName, seedBase + i, answerFor);
		if (story.result === 'win') wins += 1;
		deaths += story.lost;
		if (story.lost === 0) deathless += 1;
	}
	return {
		pWin: rollouts ? Math.round(wins / rollouts * 100) / 100 : null,
		eDeaths: rollouts ? Math.round(deaths / rollouts * 100) / 100 : null,
		pDeathless: rollouts ? Math.round(deathless / rollouts * 100) / 100 : null,
		rollouts,
	};
}

/**
 * The playbook's played half: the same seeded rollouts adjudication runs,
 * kept as stories. What comes back is the odds, the OUTCOME SPREAD (how the
 * N endings distribute over result and deaths), and the EXPECTED LINE — the
 * full narration of one representative rollout: majority result, then the
 * most common death count inside it, earliest seed as the tie-break, so the
 * same question always replays the same tape.
 */
function playbook(doc, trainerName, options) {
	options = options || {};
	const rollouts = options.rollouts === undefined ? 12 : options.rollouts;
	const seedBase = options.seedBase === undefined ? 1000 : options.seedBase;
	const answerFor = options.answerFor || {};

	const stories = [];
	let wins = 0;
	let deaths = 0;
	let deathless = 0;
	for (let i = 0; i < rollouts; i++) {
		const story = playRollout(doc, trainerName, seedBase + i, answerFor);
		stories.push(story);
		if (story.result === 'win') wins += 1;
		deaths += story.lost;
		if (story.lost === 0) deathless += 1;
	}

	const buckets = {};
	for (const story of stories) {
		const bucketKey = `${story.result}:${story.lost}`;
		if (!buckets[bucketKey]) {
			buckets[bucketKey] = {result: story.result, lost: story.lost, count: 0, turns: []};
		}
		buckets[bucketKey].count += 1;
		buckets[bucketKey].turns.push(story.turns);
	}
	const outcomes = Object.keys(buckets).map(bucketKey => {
		const bucket = buckets[bucketKey];
		bucket.turns.sort((a, b) => a - b);
		return {
			result: bucket.result,
			deaths: bucket.lost,
			count: bucket.count,
			medianTurns: bucket.turns[Math.floor(bucket.turns.length / 2)],
		};
	}).sort((a, b) => b.count - a.count || a.deaths - b.deaths);

	let line = null;
	if (stories.length) {
		const majorityResult = wins * 2 >= stories.length ? 'win' : 'loss';
		const inMajority = stories.filter(story => story.result === majorityResult);
		const pool = inMajority.length ? inMajority : stories;
		const lostCounts = {};
		for (const story of pool) lostCounts[story.lost] = (lostCounts[story.lost] || 0) + 1;
		const modalLost = Number(Object.keys(lostCounts)
			.sort((a, b) => lostCounts[b] - lostCounts[a] || a - b)[0]);
		line = pool.find(story => story.lost === modalLost) || pool[0];
	}

	return {
		odds: {
			pWin: rollouts ? Math.round(wins / rollouts * 100) / 100 : null,
			eDeaths: rollouts ? Math.round(deaths / rollouts * 100) / 100 : null,
			pDeathless: rollouts ? Math.round(deathless / rollouts * 100) / 100 : null,
			rollouts,
		},
		outcomes,
		line,
	};
}

/**
 * A double battle, played headless: two actives a side, both sides chosen by
 * the engine's trainer AI.
 *
 * start() refuses doubles because the play stack (decide(), the view, the
 * panel) is one active per side, and a fight adjudicated in the wrong mode is
 * not a result (operator ruling, 2026-08-28). This is the two-slot loop the
 * engine already supports (buildFightState {doubles: true}): each active picks
 * from its own slice of evaluateActions, the four actions are ordered by the
 * engine, a move whose target has fallen or left is redirected to the other
 * foe as the game does, and faints are replaced for both sides before the
 * next turn. OUR side is played by the same AI as the trainer's — a baseline
 * policy, not decide(); stated wherever its results are used. The road has 62
 * doubles, Juan and three of the Elite Four among them, so a run that skips
 * them has not beaten the game.
 */
/**
 * Our side's doubles hand: each active takes the damaging move worth the
 * most of the foes' remaining HP — a KO on the worst roll first, a spread
 * move counted for every foe it reaches, a hit on our own ally counted
 * against — and a status move only when nothing damages. The engine's AI,
 * which played our side before, is the foe's script: taped at School Kid
 * Jerry & Johnson it opened with Quick Attack and Bubble over Hydro Pump
 * and used Sweet Scent three turns running (1 win in 25 from level 25
 * boxes against a level-23 team).
 */
function greedyDoubles(state, mine) {
	const worth = entry => {
		if (!ai.isDamagingFacts(entry.facts)) return -1;
		const damage = ai.scoringDamageFacts(entry.facts);
		if (!damage) return -1;
		const accuracy = entry.facts.moveAccuracy === true || entry.facts.moveAccuracy === undefined ?
			1 : Math.min(1, (entry.facts.moveAccuracy || 100) / 100);
		let total = 0;
		for (const id of entry.action.targetIds || []) {
			const target = findMon(state, id);
			if (!target || target.hp.current <= 0) continue;
			const share = Math.min(1, ((damage.min + damage.max) / 2) / target.hp.current) +
				(damage.min >= target.hp.current ? 1 : 0);
			total += state.sides.player.party.some(mon => mon.id === id) ? -share : share;
		}
		return total * accuracy;
	};
	const best = mine.reduce((top, entry) => worth(entry) > worth(top) ? entry : top, mine[0]);
	return worth(best) > 0 ? best.action : null;
}

/**
 * One double battle's state and dice, played a turn at a time. `turn` plays
 * a turn — the engine's AI for the foe, and for us unless `overrides` names
 * an action for one of our actives — and returns the result once decided.
 * playDoubles drives one; the doubles search drives throwaway copies.
 */
function doublesMachine(initial, rng, ourPolicy) {
	let state = initial;
	const events = [];
	const faints = [];
	let refusals = 0;
	let applied = 0;
	const settle = () => {
		for (let guard = 0; guard < 8; guard++) {
			let moved = false;
			for (const sideId of ['ai', 'player']) {
				const forced = ai.enumerateForcedSwitchActions(state, sideId);
				if (!forced.length) continue;
				state = ai.applyAction(state, forced[0]);
				moved = true;
			}
			if (!moved) break;
		}
		// A pending replacement nobody can answer is cleared, as in singles.
		state = clearPending(state, id => !['ai', 'player'].some(sideId =>
			state.sides[sideId].party.some(mon => mon.id === id) &&
			ai.enumerateForcedSwitchActions(state, sideId).length));
	};
	// Targets are re-derived from the engine's own legal actions for this
	// actor and move, never edited by hand: a spread move (Earthquake hits
	// the ally and both foes) whose foe fell has a different legal target set,
	// and a hand-edited list was refused ("Move action is not legal",
	// "Damage references a non-target"). The chosen set stands if it is still
	// legal; otherwise the legal set sharing most of it, preferring one that
	// still reaches a standing foe; with no legal set the move is used as
	// chosen and the engine decides (a move that lost its effect is used and
	// fails).
	const aim = action => {
		if (action.kind !== 'move') return action;
		const sideId = state.sides.ai.party.some(mon => mon.id === action.actorId) ? 'ai' : 'player';
		const foeSide = sideId === 'ai' ? 'player' : 'ai';
		const legal = ai.enumerateMoveActions(state, sideId)
			.filter(entry => entry.actorId === action.actorId && entry.moveName === action.moveName);
		const key = ids => (ids || []).slice().sort().join(',');
		if (!legal.length) {
			// Every set filtered out by an effect (Thunder Wave at a body
			// already paralysed): the move is still used and fails, so aim it
			// at a set the actor can still reach — isSelectableMoveAction keeps
			// the actor-level rules and drops only the effect filters.
			if (ai.isSelectableMoveAction(state, sideId, action)) return action;
			const standing = side => state.sides[side].activeIds.filter(id => alive(state, id));
			const foes = standing(foeSide);
			const allies = standing(sideId).filter(id => id !== action.actorId);
			// The actor itself too: Life Dew whose ally fell is aimed at the
			// user alone, and Encore's Synthesis at the user, not at the foe the
			// encored-over attack was aimed at.
			const candidates = foes.map(id => [id]).concat([foes, allies.concat(foes), allies, [],
				[action.actorId], standing(sideId)])
				.map(targetIds => Object.assign({}, action, {targetIds}));
			const overlap = entry => entry.targetIds.filter(id => (action.targetIds || []).includes(id)).length;
			const reachable = candidates.filter(entry => ai.isSelectableMoveAction(state, sideId, entry))
				.sort((x, y) => overlap(y) - overlap(x));
			return reachable.length ? reachable[0] : action;
		}
		if (legal.some(entry => key(entry.targetIds) === key(action.targetIds))) return action;
		const standingFoe = id => state.sides[foeSide].activeIds.includes(id) && alive(state, id);
		const score = entry => (entry.targetIds || []).filter(id => (action.targetIds || []).includes(id)).length * 2 +
			((entry.targetIds || []).some(standingFoe) ? 1 : 0);
		return legal.slice().sort((a, b) => score(b) - score(a))[0];
	};
	const turn = overrides => {
		settle();
		let result = finished(state);
		if (result) return result;
		const chosen = [];
		for (const sideId of ['player', 'ai']) {
			let scored;
			try {
				scored = ai.evaluateActions(state, ai.calculateActionFacts, sideId, {includeSwitches: false});
			} catch (error) {
				scored = [];
			}
			for (const actorId of state.sides[sideId].activeIds) {
				if (!alive(state, actorId)) continue;
				if (sideId === 'player' && overrides && overrides[actorId]) {
					chosen.push(overrides[actorId]);
					continue;
				}
				const mine = scored.filter(entry => entry.action.actorId === actorId);
				if (!mine.length) continue;
				const greedy = sideId === 'player' && ourPolicy === 'greedy' ? greedyDoubles(state, mine) : null;
				chosen.push(greedy || ai.chooseAction(mine, rng).action);
			}
		}
		for (const entry of ai.orderActions(state, chosen, {random: rng})) {
			const action = entry.action || entry;
			if (!alive(state, action.actorId) || !onField(state, action.actorId) || leaving(state, action.actorId)) continue;
			const unlocked = lockedOut(state, action, events);
			if (!unlocked) continue;
			const aimed = aim(unlocked);
			if (!aimed) continue;
			const before = state;
			let resolution = null;
			try {
				const facts = ai.calculateActionFacts(state, aimed);
				resolution = ai.deriveMoveResolution(state, aimed, {facts, random: rng});
				state = ai.applyAction(state, aimed, resolution);
				applied += 1;
				// The doubles tape: who did what to whom, and for how much.
				const hits = (aimed.targetIds || []).map(id => {
					const was = findMon(before, id);
					const now = findMon(state, id);
					const dealt = was && now ? Math.max(0, was.hp.current - now.hp.current) : 0;
					return (now ? now.species : id) + (dealt ? ' -' + Math.round(dealt / now.hp.max * 100) + '%' : '');
				});
				events.push({turn: state.turn, text: findMon(before, aimed.actorId).species + ' used ' + aimed.moveName +
					(hits.length ? ' → ' + hits.join(', ') : '') + (resolution.hit === false ? ' (missed)' : '') +
					(resolution.actionFailure ? ' (' + resolution.actionFailure + ')' : '')});
			} catch (error) {
				refusals += 1;
				// The refused action travels with the event: a refusal is a
				// defect to fix, and the action is its reproduction.
				events.push(Object.assign(refusalEvent(findMon(state, action.actorId).species, error),
					{action: aimed, turn: state.turn, references: resolution ? {
						boosts: Object.keys(resolution.setBoostsByPokemon || {}),
						called: Object.keys(resolution.calledMoveTargetIdsByPokemon || {}),
						actives: ['player', 'ai'].map(sideId => state.sides[sideId].activeIds.join('+')).join(' / '),
					} : null, pending: PENDING_KEYS.flatMap(key => state[key] || [])}));
				continue;
			}
			recordFaints(before, state, aimed.moveName, aimed.actorId, events, faints);
			result = finished(state);
			if (result) break;
		}
		if (result) return result;
		try {
			state = ai.advanceTurn(state, {random: rng});
		} catch (error) {
			settle();
			try {
				state = ai.advanceTurn(state, {random: rng});
			} catch (again) {
				refusals += 1;
				events.push(refusalEvent('the turn', again));
			}
		}
		return finished(state);
	};
	return {turn, settle, events, faints, ourPolicy,
		get state() { return state; },
		counts: () => ({refusals, applied})};
}

/**
 * Our actives' actions for this turn, by search: each active tries its
 * engine-best `width` options, its partner held at the engine's choice, in
 * `rollouts` playouts from here on the engine; the best mean is played.
 */
function searchDoubles(machine, seed, rollouts, width) {
	machine.settle();
	const state = machine.state;
	let scored;
	try {
		scored = ai.evaluateActions(state, ai.calculateActionFacts, 'player', {includeSwitches: false});
	} catch (error) {
		return null;
	}
	const expected = entry => (entry.outcomes || []).reduce((sum, outcome) =>
		sum + outcome.probability * outcome.score, 0);
	const overrides = {};
	let dice = 0;
	for (const actorId of state.sides.player.activeIds) {
		if (!alive(state, actorId)) continue;
		const mine = scored.filter(entry => entry.action.actorId === actorId)
			.sort((a, b) => expected(b) - expected(a)).slice(0, width);
		if (mine.length < 2) continue;
		let best = null;
		let bestValue = -1;
		for (const entry of mine) {
			let total = 0;
			for (let k = 0; k < rollouts; k++) {
				dice += 1;
				const sim = doublesMachine(structuredClone(state),
					streamFor(((seed * 7919) ^ (dice * 104729) ^ state.turn) | 0, 0), machine.ourPolicy);
				let result = null;
				try {
					result = sim.turn({[actorId]: entry.action});
					for (let depth = 0; depth < 30 && !result; depth++) result = sim.turn(null);
				} catch (error) {
					result = null;
				}
				if (result === 'win') {
					total += 1;
				} else {
					const foes = sim.state.sides.ai.party;
					const left = foes.reduce((sum, mon) => sum + Math.max(0, mon.hp.current) / (mon.hp.max || 1), 0);
					total += 0.3 * (1 - left / foes.length);
				}
			}
			if (total / rollouts > bestValue) {
				bestValue = total / rollouts;
				best = entry.action;
			}
		}
		if (best) overrides[actorId] = best;
	}
	return overrides;
}

function playDoubles(doc, trainerName, seed, options) {
	const runtime = require('./run');
	const fight = planner.getFight(trainerName, doc.profileId);
	if (!fight.isDouble) throw new Error('playDoubles: ' + fight.trainer + ' is a single battle');
	const specs = runtime.partySpecs(doc, {atOrder: fight.order});
	if (specs.length < 2) {
		return {result: 'loss', turns: 0, deaths: 0, engineRefusals: 0, killers: [],
			why: 'a double battle needs two Pokemon'};
	}
	let state = fillPP(planner.buildFightState({trainer: fight.trainer, playerParty: specs,
		profileId: doc.profileId, doubles: true}).state);
	const rng = streamFor(Number.isInteger(seed) ? seed : 1, 0);
	const search = (options && options.search) || 0;
	// The engine's AI stays our default hand: the greedy hand won 103 of 372
	// doubles against its 94 (+32 -23, p = 0.28) and raised one refusal, and
	// search at the worst double (School Kid Jerry & Johnson) won 0 of 25
	// against its 1. Both stay selectable; neither has earned the default.
	const machine = doublesMachine(state, rng, (options && options.ourPolicy) || 'engine');
	let turns = 0;
	let result = null;
	for (; turns < 300 && !result; turns++) {
		const overrides = search ? searchDoubles(machine, (Number.isInteger(seed) ? seed : 1) + turns, search, 3) : null;
		result = machine.turn(overrides);
	}
	const counts = machine.counts();
	const events = machine.events;
	const ours = machine.faints.filter(entry => entry.side === 'player');
	return {result: result || 'stuck', turns, deaths: ours.length, engineRefusals: counts.refusals, actions: counts.applied,
		killers: ours.map(entry => ({species: entry.species, by: entry.by, of: entry.of})), events};
}

/** The move with the biggest forecast, a guaranteed KO first — the rollout's
 * own hand, the same greedy rule playAssignment plays. Replacements go to
 * the best race. */
function greedyChoice(actions) {
	const moves = actions.filter(entry => entry.kind === 'move');
	if (moves.length) {
		const score = entry => entry.damage ? (entry.damage.guaranteedKO ? 1000 : 0) + entry.damage.max : 0;
		const pick = moves.reduce((top, entry) => score(entry) > score(top) ? entry : top);
		return {kind: 'move', move: pick.move};
	}
	const rank = {win: 3, lose: 1, 'cannot-win': 0};
	const switches = actions.filter(entry => entry.kind === 'switch');
	if (!switches.length) return null;
	const pick = switches.reduce((top, entry) =>
		(rank[(entry.race || {}).outcome] || 2) > (rank[(top.race || {}).outcome] || 2) ? entry : top);
	return {kind: 'switch', replacementId: pick.action.replacementId};
}

/** What a finished or cut-off rollout is worth: a win is 1; otherwise the
 * share of the foe's HP taken, discounted, so near misses rank above wipes. */
function rolloutValue(bundle, reply) {
	if (reply && reply.result === 'win') return 1;
	const foes = bundle.state.sides.ai.party;
	const left = foes.reduce((sum, mon) => sum + Math.max(0, mon.hp.current) / (mon.hp.max || 1), 0);
	return 0.3 * (1 - left / foes.length);
}

/** One decision by search: every distinct legal action, `rollouts` playouts
 * each, the best mean played. `dice` numbers the rollouts so no two share
 * a stream; the updated count comes back with the choice. */
function searchChoice(bundle, actions, seed, rollouts, dice) {
	const candidates = actions.map(entry => entry.kind === 'move' ?
		{kind: 'move', move: entry.move} : {kind: 'switch', replacementId: entry.action.replacementId})
		.filter((choice, index, list) => list.findIndex(other =>
			JSON.stringify(other) === JSON.stringify(choice)) === index);
	let chosen = candidates[0];
	if (candidates.length > 1) {
		let bestValue = -1;
		for (const candidate of candidates) {
			let total = 0;
			for (let k = 0; k < rollouts; k++) {
				dice += 1;
				let sim = Object.assign({}, bundle, {seed: ((seed * 7919) ^ (dice * 104729)) | 0, step: 0, lean: true});
				let simReply = null;
				try {
					simReply = act(sim, candidate);
					sim = simReply.battle;
					let simActions = simReply.actions;
					for (let depth = 0; depth < 60 && !simReply.result && simActions.length; depth++) {
						const next = greedyChoice(simActions);
						if (!next) break;
						simReply = act(sim, next);
						sim = simReply.battle;
						simActions = simReply.actions;
					}
				} catch (error) {
					simReply = null;
				}
				total += rolloutValue(sim, simReply);
			}
			const value = total / rollouts;
			if (value > bestValue) {
				bestValue = value;
				chosen = candidate;
			}
		}
	}
	return {chosen, dice};
}

/**
 * A fight played by search: at every decision each legal action is tried in
 * `rollouts` playouts with fresh dice, both sides continuing on the engine
 * (the foe on its own AI, ours on greedyChoice), and the action with the
 * best mean is played. The real fight's dice are its own seed; a rollout's
 * are derived from it and never replayed by the real fight.
 *
 * Why: every lever measured so far was preparation — catches, items, moves,
 * the six — and the walls stayed near 1% per attempt (Brawly 0.8%, Norman
 * under 0.5%, Shelly 0 of 80). decide() is a hand-built heuristic; this asks
 * the engine instead, at about a minute a fight.
 */
function playSearch(doc, trainerName, seed, options) {
	const opts = options || {};
	const rollouts = opts.rollouts || 6;
	const opened = start(doc, trainerName, seed);
	let bundle = opened.battle;
	let actions = opened.actions;
	let reply = null;
	let refusals = 0;
	let dice = 0;
	for (let guard = 0; guard < 150 && actions.length; guard++) {
		const searched = searchChoice(bundle, actions, seed, rollouts, dice);
		const chosen = searched.chosen;
		dice = searched.dice;
		reply = act(bundle, chosen);
		refusals += (reply.events || []).filter(event => event.engineRefusal).length;
		bundle = reply.battle;
		actions = reply.actions;
		if (reply.result) break;
	}
	const foes = bundle.state.sides.ai.party;
	return {result: reply && reply.result ? reply.result : 'stuck', turns: bundle.state.turn,
		// What was left standing, as the battery reports for decide()'s fights.
		foe: {alive: foes.filter(mon => mon.hp.current > 0).length, of: foes.length,
			hpPct: Math.round(100 * foes.reduce((sum, mon) => sum + Math.max(0, mon.hp.current), 0) /
				Math.max(1, foes.reduce((sum, mon) => sum + mon.hp.max, 0)))},
		deaths: reply && reply.result ? (reply.deaths || []).length : null, engineRefusals: refusals,
		killers: reply && reply.deaths ? reply.deaths.map(death => ({species: death.species, by: death.by, of: death.of})) : []};
}

module.exports = {start, startWild, act, legalActions, view, streamFor, adjudicate, playbook, catchMath, catchOddsAtFullHp, incomingThreat, setPPModel, setSwitchPricing, switchPricing, setHidingForecast, hidingForecasts, setRealSpeed, realSpeedReads, benchRace, refusalEvent, playDoubles, lockedOut, settleAiSide, phaseOf, playSearch, searchChoice, BALLS};
