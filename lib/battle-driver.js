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
/**
 * Whether a searched double searches its two actives as ONE choice. OFF by
 * default until the battery measures it. Trainer Rival Bridge (a double, six
 * at Level 65-66 led by a Speed Boost Mega Blaziken) went 0 of 120 attempts
 * in a full run and 0 of 12 on every hand here; searched jointly, with Fake
 * Out taught, it won 1 of 8.
 */
let doublesJointOn = true;
function setDoublesJoint(on) { doublesJointOn = !!on; }
function doublesJoint() { return doublesJointOn; }

let hidingForecastOn = false;
let hidingRepriced = 0;
function setHidingForecast(on) { hidingForecastOn = !!on; }
/** How many action lists the hiding turn has repriced, for the battery's unfired-flag audit. */
function hidingForecasts() { return hidingRepriced; }

const HIDING_MOVES = new Set(['fly', 'bounce', 'dig', 'dive', 'phantomforce', 'shadowforce']);

/**
 * Whether the race and the threat line price a damaging charge move (Fly,
 * Dig, Bounce, Solar Beam, Sky Attack, ...) by its release turn. OFF by
 * default until the battery measures it. The engine resolves the charge turn
 * as a Status move, and the race read those facts: Fisherman Darian's Bounce
 * Magikarp had no damage ceiling at all, and our own Solar Beam counted for
 * nothing. On, the hit is the release, landing every other turn.
 */
let chargeThreatOn = false;
let chargePriced = 0;
function setChargeThreat(on) { chargeThreatOn = !!on; }
/** How many charge moves the switch priced by their release, for the unfired-flag audit. */
function chargeThreats() { return chargePriced; }

/**
 * A side's scored moves, each with the facts the race should read and how
 * many turns one hit takes: a charge move's release facts and 2, with the
 * switch on; the engine's own entry and 1 otherwise.
 */
function raceMoves(state, sideId) {
	return ai.evaluateActions(state, ai.calculateActionFacts, sideId)
		.filter(entry => entry.action.kind === 'move')
		.map(entry => {
			if (!chargeThreatOn || !entry.facts || entry.facts.moveCategory !== 'Status') return {entry, facts: entry.facts, turns: 1};
			const actor = findMon(state, entry.action.actorId);
			let category = 'Status';
			try { category = ai.getMoveMetadata(entry.action.moveName, state.generation || 8).category; } catch (error) { /* unknown */ }
			if (!actor || category === 'Status' || (actor.volatile && actor.volatile.charge)) return {entry, facts: entry.facts, turns: 1};
			const released = structuredClone(state);
			const mon = findMon(released, actor.id);
			mon.volatile = Object.assign({}, mon.volatile, {charge: {moveName: entry.action.moveName, targetIds: entry.action.targetIds}});
			let facts = entry.facts;
			try { facts = ai.calculateActionFacts(released, entry.action); } catch (error) { return {entry, facts: entry.facts, turns: 1}; }
			if (!ai.isDamagingFacts(facts)) return {entry, facts: entry.facts, turns: 1};
			chargePriced += 1;
			return {entry, facts, turns: 2};
		});
}

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
/**
 * WHO THE ENEMY SENDS OUT AFTER A KNOCKOUT.
 *
 * Off by default. What we do without it is take the first legal replacement
 * the engine enumerates, which is not a choice at all — ai.enumerateForced
 * SwitchActions says so itself ("post-KO replacement preference is
 * intentionally left to the battle/policy layer") and nothing supplied one.
 * Measured over every logged fight on disk: of 1,328 with a foe send-out,
 * 1,240 followed the fight data's party order and 88 did not, all singles.
 * (ledger: enemy-post-ko-replacement-is-enumeration-order.)
 *
 * The rule, from the Run & Bun documentation — the hack scores each living
 * candidate against our active and sends the highest:
 *
 *   +5  faster than us and OHKOs us
 *   +4  slower but OHKOs us and is not OHKOd
 *   +3  faster and deals more percent damage than it takes
 *   +2  slower and deals more percent damage than it takes
 *   +1  faster
 *    0  default
 *   -1  slower and is OHKOd
 *
 * and on a tie, the earliest in party order.
 *
 * PROVENANCE: the hack's own documentation, ported doc-literal. It is NOT
 * ROM-verified. The move-scoring tiers were confirmed by reading the AI's
 * score array out of memory; this array is a separate probe that has not
 * been done, and the tie rule is unprobed too. pokemon-mono implements the
 * same table but breaks ties by damage percent BEFORE party order, which its
 * own header contradicts — so a tie is the one place the two disagree, and
 * the place to look first when the probe happens.
 *
 * Every policy lever this repository has measured was measured against the
 * enumeration order, so turning this on re-opens all of them. It stays off
 * until it is measured on its own bar.
 */
let enemySwitchScoringOn = false;
function setEnemySwitchScoring(on) { enemySwitchScoringOn = !!on; }
function enemySwitchScoring() { return enemySwitchScoringOn; }

/** Their best damage on our active, and ours on them, as a share of the target's current HP. */
function bestHit(state, sideId, target) {
	let top = 0;
	for (const move of raceMoves(state, sideId)) {
		if (!ai.isDamagingFacts(move.facts)) continue;
		const damage = ai.scoringDamageFacts(move.facts);
		const hit = (damage.max || 0) / move.turns;
		if (hit > top) top = hit;
	}
	return {damage: top, share: top / Math.max(1, (target && target.hp && target.hp.current) || 1)};
}

/**
 * The documented score for one candidate coming in against our active.
 * Seated in a clone, because the score is about the candidate on the field.
 */
function enemySwitchScore(state, replacementId) {
	let seated;
	try {
		seated = structuredClone(state);
	} catch (error) { return 0; }
	seated.sides.ai.activeIds = [replacementId];
	const theirs = findMon(seated, replacementId);
	const ours = findMon(seated, activeOf(seated, 'player'));
	if (!theirs || !ours) return 0;
	const faster = speedOf(seated, theirs) > speedOf(seated, ours);
	const onUs = bestHit(seated, 'ai', ours);
	const onThem = bestHit(seated, 'player', theirs);
	const killsUs = onUs.damage >= ours.hp.current;
	const diesToUs = onThem.damage >= theirs.hp.current;
	if (faster && killsUs) return 5;
	if (!faster && killsUs && !diesToUs) return 4;
	if (faster && onUs.share > onThem.share) return 3;
	if (!faster && onUs.share > onThem.share) return 2;
	if (faster) return 1;
	if (!faster && diesToUs) return -1;
	return 0;
}

/** The replacement the documented rule sends: highest score, ties to the earliest in party order. */
function chooseEnemyReplacement(state, actions) {
	const order = new Map(state.sides.ai.party.map((mon, index) => [mon.id, index]));
	let best = null;
	for (const action of actions) {
		const score = enemySwitchScore(state, action.replacementId);
		const at = order.has(action.replacementId) ? order.get(action.replacementId) : Number.MAX_SAFE_INTEGER;
		if (best === null || score > best.score || (score === best.score && at < best.at)) {
			best = {action, score, at};
		}
	}
	return best ? best.action : actions[0];
}

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
			state = ai.applyAction(state, enemySwitchScoringOn && actions.length > 1 ?
				chooseEnemyReplacement(state, actions) : actions[0]);
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
				// The killer's battle id as well as its species: when OUR
				// body is the killer, that id is what names the individual
				// who took the knock, and a run's story is mostly who took
				// what down before it fell.
				ofId: ofMonId || null,
			});
		}
	}
}

/** The box id behind a battle id, read off the bundle's own party map. */
function monIdOfBattleId(bundle, battleId) {
	if (!battleId) return null;
	const row = (bundle.party || []).find(member => member.battleId === battleId);
	return row ? row.monId : null;
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
/**
 * THE ODDS OF A RACE: both outcomes priced, not one of them.
 *
 * The race's verdict is pessimal on purpose — their crit ceiling lands every
 * turn, our floor is all we count — which is the right fold for a player who
 * cannot afford to be wrong once, and the wrong one for choosing who comes
 * in. At Aqua Admin Matt, Scarf Dracovish is locked into Fishious Rend;
 * Kingdra takes 30% of it, then 14%, and kills it, and was priced "dies the
 * turn after it comes in". So Throh stayed in and died, Turtonator came in
 * and died without acting, and only then did Kingdra enter, two bodies late:
 * Dracovish cost 1.9 bodies a facing over 80 attempts. A FAIR single number
 * is no better (operator: "we have to price both crit and non-crit
 * outcomes") — it calls the same switch a tie, and says nothing about risk.
 *
 * So beside the verdict a race says: how it goes with no crit (mean rolls
 * both ways), how it goes if every hit of theirs crits, and the probability
 * of winning in between — their hits land one at a time, each a crit at
 * CRIT_ODDS, and we win if we are still standing when our last hit is due.
 * `owed` is the hits they get for free first: one for a voluntary switch.
 */
const CRIT_ODDS = 1 / 24;
function raceOdds(us, them, ours, theirs, faster, owed) {
	if (!ours || !ours.mean || !theirs || !theirs.mean) return null;
	const turns = Math.ceil(them.hp.current / ours.mean);
	// Their hits before our last one lands: every turn but the last if we move first.
	const hits = owed + (faster ? turns - 1 : turns);
	const dies = hit => (hit > 0 ? Math.ceil(us.hp.current / hit) : Infinity);
	const plain = dies(theirs.mean) > hits;
	const allCrit = dies(theirs.crit) > hits;
	// P(standing after `hits` of their hits), c of them crits: binomial.
	let win = 0;
	for (let crits = 0; crits <= hits; crits++) {
		if ((hits - crits) * theirs.mean + crits * theirs.crit >= us.hp.current) continue;
		let ways = 1;
		for (let k = 0; k < crits; k++) ways = ways * (hits - k) / (k + 1);
		win += ways * Math.pow(CRIT_ODDS, crits) * Math.pow(1 - CRIT_ODDS, hits - crits);
	}
	return {turns, hits, noCrit: plain ? 'win' : 'lose', allCrit: allCrit ? 'win' : 'lose', win: Number(win.toFixed(3))};
}

function benchRace(state, id, owed) {
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
	let theirs = null;
	for (const move of raceMoves(seated, 'ai')) {
		if (!ai.isDamagingFacts(move.facts)) continue;
		const damage = ai.scoringDamageFacts(move.facts);
		const top = (damage.critMax !== undefined ? damage.critMax : damage.max) / move.turns;
		if (top > ceiling) ceiling = top;
		const mean = ((damage.min === undefined ? damage.max : damage.min) + damage.max) / 2 / move.turns;
		if (!theirs || mean > theirs.mean) {
			theirs = {mean, crit: damage.critMax !== undefined ? mean * damage.critMax / Math.max(1, damage.max) : mean * 1.5};
		}
	}
	if (!ceiling) return null;
	return attritionRace(seated, us, them, ceiling, {theirs, owed: owed || 0});
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
	// One hit owed: the one a voluntary switch concedes on the way in.
	const race = benchRace(state, id, 1);
	if (!race) return null;
	const turnsToDie = race.turnsToDie - 1;
	let outcome;
	if (race.turnsToKill === null) outcome = 'cannot-win';
	else if (turnsToDie <= 0) outcome = 'lose';
	else if (race.turnsToKill < turnsToDie) outcome = 'win';
	else if (race.turnsToKill > turnsToDie) outcome = 'lose';
	else outcome = race.faster ? 'win' : 'lose';
	return Object.assign({turnsToKill: race.turnsToKill, turnsToDie, faster: race.faster, outcome}, race.odds ? {odds: race.odds} : {});
}

function incomingThreat(state) {
	const us = findMon(state, activeOf(state, 'player'));
	const them = findMon(state, activeOf(state, 'ai'));
	if (!us || !them || !us.hp.max) return null;
	let worst = null;
	let pursuit = null;
	for (const move of raceMoves(state, 'ai')) {
		const entry = move.entry;
		if (!ai.isDamagingFacts(move.facts)) continue;
		const damage = ai.scoringDamageFacts(move.facts);
		const ceiling = damage.critMax !== undefined ? damage.critMax : damage.max;
		if (!worst || ceiling / move.turns > worst.ceiling / worst.turns) {
			worst = {move: entry.action.moveName, ceiling, max: damage.max, turns: move.turns};
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
		race: attritionRace(state, us, them, worst.ceiling / worst.turns),
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
function attritionRace(state, us, them, theirCeiling, pricing) {
	if (!theirCeiling || !them.hp || !them.hp.current) return null;
	let ourFloor = 0;
	let ourMean = 0;
	// A priority move that KOs on its worst roll moves first whatever the
	// speeds. The race read Speed only, so a Quick Attack Manectric facing a
	// sashed Mienshao at 1% read as a lost race and was never sent in, while
	// five slower bodies came in one by one to "KO" it and were Reversed
	// first (Aqua Admin Shelly, 0 of 80 attempts).
	let priorityKO = false;
	for (const move of raceMoves(state, 'player')) {
		const entry = move.entry;
		if (!ai.isDamagingFacts(move.facts)) continue;
		const damage = ai.scoringDamageFacts(move.facts);
		if (damage && damage.min / move.turns > ourFloor) ourFloor = damage.min / move.turns;
		if (damage && (damage.min + damage.max) / 2 / move.turns > ourMean) ourMean = (damage.min + damage.max) / 2 / move.turns;
		if (damage && move.turns === 1 && damage.min >= them.hp.current && movePriority(state, entry.action.moveName) > 0) {
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
	const odds = pricing && pricing.theirs ? raceOdds(us, them, {mean: ourMean}, pricing.theirs, faster, pricing.owed) : null;
	return Object.assign({turnsToKill, turnsToDie, faster, outcome}, odds ? {odds} : {});
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
 * Whether races read the engine's effective Speed. speedOf called
 * ai.buildStats, which the engine has never exported, and the state's mons
 * carry no stat block, so every Speed read 0 from 3b9f53e (2026-08-21) on:
 * race.faster was always false, every tied race read lost, and the threat
 * line said "they act first" every turn. ON by default since 2026-09-19:
 * held-out 154 fights, real PP, +92 -60 (net +32, p = 0.012). `false`
 * restores the zero for arms that measure against it.
 */
let realSpeedOn = true;
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
	const knockouts = (bundle.knockouts || []).slice();
	for (const fallen of faints) {
		if (fallen.side !== 'ai') continue;
		if (knockouts.some(existing => existing.battleId === fallen.battleId)) continue;
		knockouts.push({battleId: fallen.battleId, species: fallen.species,
			by: fallen.by || null, byMonId: monIdOfBattleId(bundle, fallen.ofId)});
	}
	// The tape: every chosen action, in order, riding the bundle. With the
	// per-(seed, step) streams above, (seed, tape) replays the whole fight
	// exactly — against the engine revision that played it, which is why
	// battle.ended binds the engine identity beside the tape.
	const tape = (bundle.tape || []).concat([Object.assign({step: bundle.step},
		chosen.kind === 'move' ? {kind: 'move', move: chosen.move} :
			chosen.kind === 'switch' ? {kind: 'switch', replacementId: chosen.replacementId} :
				{kind: 'ball', ball: chosen.ball || 'Poke Ball'})]);
	const next = Object.assign({}, bundle, {state, step: bundle.step + 1, phase, deaths: carried, knockouts,
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
		// The other half of the record: every enemy that fell, and which of
		// ours took it down. Without this a body only ever appears in the
		// ledger on the day it dies.
		knockouts: result ? (bundle.knockouts || []).slice() : [],
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
/**
 * The value of one rollout of a chosen turn: a win is 1, anything else is
 * credit for the enemy health taken off. Shared by both doubles searches.
 */
function doublesRolloutValue(machine, state, overrides, seed, dice) {
	const sim = doublesMachine(structuredClone(state),
		streamFor(((seed * 7919) ^ (dice * 104729) ^ state.turn) | 0, 0), machine.ourPolicy);
	let result = null;
	try {
		result = sim.turn(overrides);
		for (let depth = 0; depth < 30 && !result; depth++) result = sim.turn(null);
	} catch (error) {
		return 0;
	}
	if (result === 'win') return 1;
	const foes = sim.state.sides.ai.party;
	const left = foes.reduce((sum, mon) => sum + Math.max(0, mon.hp.current) / (mon.hp.max || 1), 0);
	return 0.3 * (1 - left / foes.length);
}

/**
 * Both actives searched as ONE choice: every pair of their best moves is
 * rolled out together. searchDoubles scores each active on its own while the
 * partner plays the engine's hand, so no pair of moves is ever valued as a
 * pair — which is most of doubles (Fake Out into a set-up, Wide Guard over a
 * spread, a double focus). Off by default until the battery measures it.
 */
function searchDoublesJointly(machine, seed, rollouts, width) {
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
	const actors = state.sides.player.activeIds.filter(id => alive(state, id));
	const top = actors.map(actorId => scored.filter(entry => entry.action.actorId === actorId)
		.sort((a, b) => expected(b) - expected(a)).slice(0, width).map(entry => entry.action));
	if (!top.length || top.some(list => !list.length)) return null;
	const pairs = top.length === 1 ? top[0].map(action => [action]) :
		top[0].flatMap(first => top[1].map(second => [first, second]));
	if (pairs.length < 2) return null;
	let best = null;
	let bestValue = -1;
	let dice = 0;
	for (const pair of pairs) {
		const overrides = {};
		for (const action of pair) overrides[action.actorId] = action;
		let total = 0;
		for (let k = 0; k < rollouts; k++) total += doublesRolloutValue(machine, state, overrides, seed, ++dice);
		if (total / rollouts > bestValue) {
			bestValue = total / rollouts;
			best = overrides;
		}
	}
	return best;
}

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
	// --doubles-joint searches the two actives as one choice; the battery and
	// the harness read the flag, and options.joint overrides it.
	const joint = options && options.joint !== undefined ? options.joint : doublesJointOn;
	const searcher = joint ? searchDoublesJointly : searchDoubles;
	for (; turns < 300 && !result; turns++) {
		const overrides = search ? searcher(machine, (Number.isInteger(seed) ? seed : 1) + turns, search, 3) : null;
		result = machine.turn(overrides);
	}
	const counts = machine.counts();
	const events = machine.events;
	const ours = machine.faints.filter(entry => entry.side === 'player');
	// A death names the individual, not the species: the same species is
	// caught and buried a dozen times in a sweep. The slot maps back to the
	// box the way the singles bundle maps it, and the species is checked
	// before the id is believed — a crossed order scale must fail closed,
	// not quietly bury the wrong body.
	const boxIdOf = battleId => {
		const slot = /^player-(\d+)$/.exec(String(battleId));
		if (!slot) return null;
		const index = Number(slot[1]) - 1;
		const spec = specs[index];
		return spec && doc.party[index] ? doc.party[index] : null;
	};
	const named = entry => {
		const monId = boxIdOf(entry.battleId);
		const mon = monId ? (doc.box || []).find(member => member.id === monId) : null;
		// A Mega fights under its evolved name and is boxed under its base one.
		const matched = mon && (mon.species === entry.species ||
			String(entry.species).startsWith(mon.species + '-Mega')) ? mon : null;
		return {monId: matched ? matched.id : null,
			name: matched ? (matched.nickname || matched.species) : null,
			species: entry.species, by: entry.by, of: entry.of};
	};
	const theirs = machine.faints.filter(entry => entry.side === 'ai');
	return {result: result || 'stuck', turns, deaths: ours.length, engineRefusals: counts.refusals, actions: counts.applied,
		killers: ours.map(named),
		knockouts: theirs.map(entry => ({battleId: entry.battleId, species: entry.species,
			by: entry.by || null, byMonId: boxIdOf(entry.ofId)})),
		events};
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

/**
 * Whether a won rollout is valued by what it KEPT. The harness and the battery
 * turn it ON (ruling a-win-is-valued-by-what-it-kept, 2026-09-21: held-out,
 * 20 paired fights, bodies lost per win 4.56 -> 2.00, fewer in 15 of 16, wins
 * 17 -> 18); the bare driver stays off so a caller asks for it.
 *
 * A win was worth 1 whether it ended with six standing or one, so nothing in
 * the search had ever preferred a cheaper win: eleven replayed boss wins each
 * gave up four to six bodies, and with the parts recorded (2026-09-21) the
 * spread in "ours left standing" across a turn's options averaged a quarter
 * of a body — the objective could not tell a clean win from a ruinous one
 * because it never looked. With this on a win is worth 0.5 for winning plus
 * up to 0.5 for the share of our party still standing, so a win always beats
 * any loss (at most 0.3) and a cheaper win beats a dearer one.
 */
let searchKeepOn = false;
function setSearchKeep(on) { searchKeepOn = !!on; }
function searchKeep() { return searchKeepOn; }

/** What a finished or cut-off rollout is worth: a win is 1 (or, keeping, 0.5
 * plus half the share of ours still standing); otherwise the share of the
 * foe's HP taken, discounted, so near misses rank above wipes. */
function rolloutValue(bundle, reply, meanLead) {
	if (reply && reply.result === 'win') {
		if (!searchKeepOn) return 1;
		const ours = bundle.state.sides.player.party;
		return 0.5 + 0.5 * ours.filter(mon => mon.hp.current > 0).length / Math.max(1, ours.length);
	}
	const foes = bundle.state.sides.ai.party;
	const left = foes.reduce((sum, mon) => sum + Math.max(0, mon.hp.current) / (mon.hp.max || 1), 0);
	const removed = 1 - left / foes.length;
	if (!searchPathOn || meanLead === undefined) return 0.3 * removed;
	// A LOST playout, valued by its path. At the end of a loss we have lost
	// everyone by definition, so the end state says nothing about our side —
	// which is why the keep term never applies where nearly every playout
	// loses. The path does: a line that stays ahead on material and is ground
	// down is nearer a win than one that falls behind on turn one (the search
	// chose Self-Destruct on the first turn at Norman, a one-for-one trade, by
	// 0.206 to 0.204). Half for what we finally removed, half for the average
	// lead mapped to [0, 1]; still inside the 0.3 a loss may be worth.
	return 0.3 * (0.5 * removed + 0.5 * (meanLead + 1) / 2);
}

/**
 * Whether a LOST rollout is valued by its path as well as its end. OFF until
 * measured. See rolloutValue.
 */
let searchPathOn = false;
function setSearchPath(on) { searchPathOn = !!on; }
function searchPath() { return searchPathOn; }

/** One decision by search: every distinct legal action, `rollouts` playouts
 * each, the best mean played. `dice` numbers the rollouts so no two share
 * a stream; the updated count comes back with the choice. */
/**
 * How wide the search stays after the first look. 0 keeps the flat search,
 * which rolls every candidate out the full `rollouts` times. OFF by default
 * until the battery measures it.
 *
 * Why not simply drop candidates: a first attempt did (2026-09-20). It kept
 * the best damaging move of each type and, when anything damaged, only the
 * switches that WIN their race. At Brawly it cut nine candidates to three and
 * ran 2.1x faster — and took the fight from 5 wins in 8 paired seeds to 1.
 * The switches it deleted are the pivots that win boss fights: a body that
 * loses its race is often exactly the body worth sending, to eat a hit or to
 * force the foe off a set-up. No a-priori rule prices that; only a rollout
 * does. So nothing is removed here. The budget is spent unevenly instead: a
 * scouting rollout for every candidate, then the rest for the few that led.
 */
let searchWidenTop = 0;
function setSearchWiden(top) { searchWidenTop = Math.max(0, Number(top) || 0); }
function searchWiden() { return searchWidenTop; }

/** One playout of `candidate`, the foe on its AI and us on greedyChoice. */
function rolloutOnce(bundle, candidate, seed, dice) {
	let sim = Object.assign({}, bundle, {seed: ((seed * 7919) ^ (dice * 104729)) | 0, step: 0, lean: true});
	let simReply = null;
	// The material lead after every step: their HP share removed minus ours.
	let leadSum = 0;
	let steps = 0;
	const note = () => {
		leadSum += materialLead(sim.state);
		steps += 1;
	};
	try {
		simReply = act(sim, candidate);
		sim = simReply.battle;
		note();
		let simActions = simReply.actions;
		for (let depth = 0; depth < 60 && !simReply.result && simActions.length; depth++) {
			const next = greedyChoice(simActions);
			if (!next) break;
			simReply = act(sim, next);
			sim = simReply.battle;
			note();
			simActions = simReply.actions;
		}
	} catch (error) {
		simReply = null;
	}
	const meanLead = steps ? leadSum / steps : 0;
	const parts = Object.assign(rolloutParts(sim, simReply), {meanLead});
	return {value: rolloutValue(sim, simReply, meanLead), parts};
}

/** Their HP share removed minus ours, in [-1, 1]: who is ahead on material. */
function materialLead(state) {
	const gone = party => 1 - party.reduce((sum, mon) => sum + Math.max(0, mon.hp.current) / (mon.hp.max || 1), 0) /
		Math.max(1, party.length);
	return gone(state.sides.ai.party) - gone(state.sides.player.party);
}

/**
 * What a rollout's value is MADE of, kept beside it. The value is one number
 * — 1 for a win, else 0.3 x the share of their HP removed — and on a wall
 * where nearly every playout loses it is almost entirely the second term, so
 * a card reading 0.283 against 0.281 says nothing about why. These are the
 * parts: did it win, how much of theirs came off, and how many of OURS were
 * still standing — which the value itself has never counted at all.
 */
function rolloutParts(bundle, reply) {
	const share = party => party.reduce((sum, mon) => sum + Math.max(0, mon.hp.current) / (mon.hp.max || 1), 0) / Math.max(1, party.length);
	const ours = bundle.state.sides.player.party;
	return {won: !!(reply && reply.result === 'win'),
		removed: 1 - share(bundle.state.sides.ai.party),
		oursAlive: ours.filter(mon => mon.hp.current > 0).length,
		oursHp: share(ours)};
}

/**
 * What the search thought of EVERY candidate, not only the one it played: a
 * fight log that shows the choice without the alternatives cannot say whether
 * a line was found or stumbled into. Each value carries its parts — playouts
 * won, the share of their HP removed, how many of ours were left standing.
 */
function scoresOf(scored) {
	return scored.map(entry => ({
		choice: entry.candidate.kind === 'move' ? entry.candidate.move : 'switch:' + entry.candidate.replacementId,
		value: Number((entry.total / Math.max(1, entry.runs)).toFixed(3)), runs: entry.runs,
		wins: entry.wins,
		removed: Number((entry.removed / Math.max(1, entry.runs)).toFixed(3)),
		oursAlive: Number((entry.oursAlive / Math.max(1, entry.runs)).toFixed(2)),
		// The average material lead over the playouts: above 0, ahead for most of the fight.
		lead: Number((entry.lead / Math.max(1, entry.runs)).toFixed(3))}));
}

/**
 * Whether the search spends its playouts by sequential halving. OFF:
 * measured 2026-09-21 on 32 paired fights and no stronger — held-out wins
 * 18 v 18, Brawly 10 v 9, bodies lost per win 2.00 v 2.00 and 3.10 v 2.89,
 * 5-9% faster. The bar was a net of two wins or 0.3 fewer bodies; it met
 * neither (docs/measurements/search-halving-heldout-2026-09-21.jsonl).
 */
let searchHalvingOn = false;
function setSearchHalving(on) { searchHalvingOn = !!on; }
function searchHalving() { return searchHalvingOn; }

function searchChoice(bundle, actions, seed, rollouts, dice) {
	const candidates = actions.map(entry => entry.kind === 'move' ?
		{kind: 'move', move: entry.move} : {kind: 'switch', replacementId: entry.action.replacementId})
		.filter((choice, index, list) => list.findIndex(other =>
			JSON.stringify(other) === JSON.stringify(choice)) === index);
	let chosen = candidates[0];
	if (candidates.length > 1) {
		// A scored candidate carries its running total and the rollouts that
		// made it, so a widened second pass keeps the scouting rollout rather
		// than throwing it away.
		const scored = candidates.map(candidate => ({candidate, total: 0, runs: 0, wins: 0, removed: 0, oursAlive: 0, lead: 0}));
		const tally = (entry, played) => {
			entry.total += played.value;
			entry.runs += 1;
			entry.wins += played.parts.won ? 1 : 0;
			entry.removed += played.parts.removed;
			entry.oursAlive += played.parts.oursAlive;
			entry.lead += played.parts.meanLead || 0;
		};
		if (searchHalvingOn && scored.length > 2 && rollouts >= 4) {
			// SEQUENTIAL HALVING: the same total playouts as the flat search
			// (options x rollouts), spent where the answer is still open. Each
			// round shares an equal slice among the options still in, then the
			// weaker half is dropped. Nobody is dropped on less than two
			// playouts, and the last two are decided on about a third of the
			// whole budget each — against a flat search that, with nine
			// options, chose "switch to Grotle" because ONE playout in eight won.
			let remaining = scored.length * rollouts;
			const rounds = Math.ceil(Math.log2(scored.length));
			let alive = scored.slice();
			for (let round = 0; round < rounds && alive.length > 1 && remaining > 0; round++) {
				const last = round === rounds - 1 || alive.length === 2;
				// An equal slice of what is LEFT for each round still to come,
				// never less than two a head while the budget allows it, and
				// never more than is left: the total stays the flat search's.
				const slice = last ? remaining : Math.floor(remaining / (rounds - round));
				const each = Math.min(Math.floor(remaining / alive.length),
					Math.max(2, Math.floor(slice / alive.length)));
				for (const entry of alive) {
					for (let k = 0; k < each; k++) {
						dice += 1;
						tally(entry, rolloutOnce(bundle, entry.candidate, seed, dice));
						remaining -= 1;
					}
				}
				alive.sort((a, b) => b.total / Math.max(1, b.runs) - a.total / Math.max(1, a.runs));
				if (last || each === 0) break;
				alive = alive.slice(0, Math.max(2, Math.ceil(alive.length / 2)));
			}
			chosen = alive[0].candidate;
			return {chosen, dice, scores: scoresOf(scored)};
		}
		const widening = searchWidenTop > 0 && searchWidenTop < scored.length && rollouts > 1;
		const first = widening ? 1 : rollouts;
		for (const entry of scored) {
			for (let k = 0; k < first; k++) {
				dice += 1;
				tally(entry, rolloutOnce(bundle, entry.candidate, seed, dice));
			}
		}
		let deciding = scored;
		if (widening) {
			// The scouting pass only shortlists. The winner is chosen among
			// the shortlist, on its full budget — otherwise one lucky single
			// rollout outranks a candidate that was measured eight times.
			deciding = scored.slice().sort((a, b) => b.total - a.total).slice(0, searchWidenTop);
			for (const entry of deciding) {
				for (let k = first; k < rollouts; k++) {
					dice += 1;
					tally(entry, rolloutOnce(bundle, entry.candidate, seed, dice));
				}
			}
		}
		let bestValue = -1;
		for (const entry of deciding) {
			const value = entry.total / entry.runs;
			if (value > bestValue) {
				bestValue = value;
				chosen = entry.candidate;
			}
		}
		return {chosen, dice, scores: scoresOf(scored)};
	}
	return {chosen, dice, scores: []};
}

/**
 * The LOOKAHEAD: how many of our own decisions deep the search looks, exactly,
 * instead of playing whole fights out. 0 is off (playouts, as above).
 *
 * Measured on 7,603 searched turns of five runs (2026-09-21): the best option
 * beat the second by a median of 0.010, under 0.02 on two turns in three —
 * values that are each the mean of 8 playouts. In 63% of turns no option won
 * a single playout, so a value is 0.3 x their HP removed at the end of a
 * sixty-turn fight whose every turn after the first is played for us by
 * greedyChoice (the biggest hit, never a switch, never a status move). The
 * first move washes out, and the search mostly chooses on noise: Archie's
 * opening, the turn that decided the fight, read 0.174 against 0.172.
 *
 * And the foe's move is not a mystery. Asked forty times with different dice
 * at each of 162 positions across three late walls, the hack's trainer AI
 * chose the same move all forty times at every one. The engine already plays
 * that AI inside act(), so a short exact search gets their real reply for
 * free, and what is left to chance in a turn is small: the damage roll, the
 * crit, the miss.
 *
 * So: depth D of OUR decisions. At the root every legal action is tried on
 * LOOKAHEAD_ROOT sets of dice; below it the LOOKAHEAD_WIDTH most promising
 * (moves by forecast, switches by race) on LOOKAHEAD_INNER. A forced
 * replacement is a decision that costs no depth — who comes in is the point
 * of a sacrifice. A finished fight is worth what search-keep says (a loss 0,
 * a win 0.95 plus a little for every body kept); an unfinished one the
 * material lead, their HP share removed minus ours, mapped into 0.05-0.95,
 * so that no lead however large outranks a win and none however bad is a
 * loss. It is short-sighted by construction: a plan longer than D turns is
 * invisible to it, which is what --plan-after and the playouts are for.
 */
let searchLookaheadDepth = 0;
function setSearchLookahead(depth) {
	const value = Number(depth) || 0;
	if (!Number.isInteger(value) || value < 0 || value > 4) throw new Error('--search-lookahead is a depth from 0 to 4, not ' + JSON.stringify(depth));
	searchLookaheadDepth = value;
}
function searchLookahead() { return searchLookaheadDepth; }
const LOOKAHEAD_ROOT = 4;
const LOOKAHEAD_INNER = 2;
const LOOKAHEAD_WIDTH = 4;

/** Legal actions as the choices act() takes, deduplicated, most promising first. */
function promising(actions) {
	const rank = {win: 3, lose: 1, 'cannot-win': 0};
	const worth = entry => (entry.kind === 'move' ?
		1000 + (entry.damage ? (entry.damage.guaranteedKO ? 1000 : 0) + entry.damage.max : 0) :
		(rank[(entry.race || {}).outcome] === undefined ? 2 : rank[(entry.race || {}).outcome]));
	return actions.slice().sort((a, b) => worth(b) - worth(a))
		.map(entry => (entry.kind === 'move' ? {kind: 'move', move: entry.move} :
			{kind: 'switch', replacementId: entry.action.replacementId}))
		.filter((choice, index, list) => list.findIndex(other =>
			JSON.stringify(other) === JSON.stringify(choice)) === index);
}

function lookaheadLeaf(bundle, reply) {
	const state = (reply && reply.battle ? reply.battle : bundle).state;
	if (reply && reply.result) {
		if (reply.result !== 'win') return 0;
		const party = state.sides.player.party;
		return 0.95 + 0.05 * party.filter(mon => mon.hp.current > 0).length / Math.max(1, party.length);
	}
	return 0.5 + 0.45 * materialLead(state);
}

/** Dice for one simulated step: the same for every sibling at a ply, so options are compared on EQUAL luck. */
function lookaheadSeed(seed, dice, ply, sample) {
	return ((seed * 7919) ^ ((dice + 1) * 104729) ^ ((ply + 1) * 15485863) ^ ((sample + 1) * 32452843)) | 0;
}

/**
 * The best we can do from here, `depth` of our decisions deep.
 *
 * Siblings share their dice (lookaheadSeed): the first cut gave every
 * candidate its own, so "the best of the next turn" was the best of four
 * lucky draws and lifted every option alike — depth 2 read 0.534, 0.536,
 * 0.532 where depth 1 had read 0.525 against 0.489.
 */
function lookaheadValue(reply, depth, clock, ply) {
	if (reply.result || !reply.actions || !reply.actions.length) return lookaheadLeaf(null, reply);
	const replacing = !reply.actions.some(entry => entry.kind === 'move');
	if (depth <= 0 && !replacing) return lookaheadLeaf(null, reply);
	// Who comes in after a faint is a real choice, but a narrow one: two, on one set of dice.
	const width = replacing ? 2 : LOOKAHEAD_WIDTH;
	const samples = replacing ? 1 : LOOKAHEAD_INNER;
	let best = null;
	for (const candidate of promising(reply.actions).slice(0, width)) {
		let total = 0;
		let runs = 0;
		for (let sample = 0; sample < samples; sample++) {
			clock.acts += 1;
			const sim = Object.assign({}, reply.battle, {seed: lookaheadSeed(clock.seed, clock.dice, ply, sample), step: 0, lean: true});
			let next;
			try {
				next = act(sim, candidate);
			} catch (error) { continue; }
			total += lookaheadValue(next, replacing ? depth : depth - 1, clock, ply + 1);
			runs += 1;
		}
		if (runs && (best === null || total / runs > best)) best = total / runs;
	}
	return best === null ? lookaheadLeaf(null, reply) : best;
}

/** How close to the best an option must be to be looked at one turn deeper. */
const LOOKAHEAD_CONTEND = 0.05;

function lookaheadChoice(bundle, actions, seed, depth, dice) {
	const candidates = promising(actions);
	if (candidates.length < 2) return {chosen: candidates[0], dice, scores: []};
	const clock = {seed, dice, acts: 0};
	const score = (candidate, deep) => {
		let total = 0;
		let runs = 0;
		let lead = 0;
		for (let sample = 0; sample < LOOKAHEAD_ROOT; sample++) {
			clock.acts += 1;
			const sim = Object.assign({}, bundle, {seed: lookaheadSeed(seed, dice, 0, sample), step: 0, lean: true});
			let next;
			try {
				next = act(sim, candidate);
			} catch (error) { continue; }
			total += lookaheadValue(next, deep - 1, clock, 1);
			lead += materialLead(next.battle.state);
			runs += 1;
		}
		return {candidate, value: runs ? total / runs : -1, runs, lead: runs ? lead / runs : 0, depth: deep};
	};
	// Every option one turn deep — 0.2 s for nine of them — and only those
	// still in contention a turn deeper, each time. Looking two deep at all
	// nine cost 5 s a decision and said less.
	let scored = candidates.map(candidate => score(candidate, 1));
	for (let deep = 2; deep <= depth; deep++) {
		const best = Math.max.apply(null, scored.map(entry => entry.value));
		const close = scored.filter(entry => entry.value >= best - LOOKAHEAD_CONTEND)
			.sort((a, b) => b.value - a.value).slice(0, 3);
		if (close.length < 2) break;
		const deeper = new Map(close.map(entry => [entry.candidate, score(entry.candidate, deep)]));
		// An option not looked at deeper keeps its value but can no longer win on it:
		// it is capped just under the weakest contender, so depths are never compared.
		const floor = Math.min.apply(null, [...deeper.values()].map(entry => entry.value));
		scored = scored.map(entry => deeper.get(entry.candidate) ||
			Object.assign({}, entry, {value: Math.min(entry.value, floor - 0.001)}));
	}
	// Ties go to the more promising, which `promising` put first.
	const top = scored.reduce((best, entry) => (entry.value > best.value + 1e-9 ? entry : best));
	return {chosen: top.candidate, dice: dice + 1, acts: clock.acts,
		scores: scored.map(entry => ({
			choice: entry.candidate.kind === 'move' ? entry.candidate.move : 'switch:' + entry.candidate.replacementId,
			value: Number(entry.value.toFixed(3)), runs: entry.runs,
			// The material lead right after this action and their reply: what one turn buys.
			lead: Number(entry.lead.toFixed(3)), depth: entry.depth}))};
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
/** What the screen offered on a turn: each move's forecast, each switch's race. */
function optionsOf(seen) {
	return {moves: (seen.moves || []).filter(entry => !entry.ball).map(entry => ({move: entry.move, damage: entry.damage || null})),
		switches: (seen.switches || []).map(entry => ({label: entry.label, race: entry.race || null,
			raceDetail: entry.raceDetail || null})),
		bench: seen.bench || []};
}

function playSearch(doc, trainerName, seed, options) {
	const opts = options || {};
	const rollouts = opts.rollouts || 6;
	const opened = start(doc, trainerName, seed);
	let bundle = opened.battle;
	let actions = opened.actions;
	let reply = null;
	let refusals = 0;
	let dice = 0;
	const viewOf = require('./battle-view').viewOf;
	let seen = opts.tape ? viewOf(opened) : null;
	for (let guard = 0; guard < 150 && actions.length; guard++) {
		const searched = searchLookaheadDepth > 0 ? lookaheadChoice(bundle, actions, seed, searchLookaheadDepth, dice) :
			searchChoice(bundle, actions, seed, rollouts, dice);
		const chosen = searched.chosen;
		dice = searched.dice;
		const offered = actions;
		reply = act(bundle, chosen);
		if (opts.tape) {
			// The fight, kept: the run used to keep a ledger ROW per attempt
			// and throw the fight away, so how a wall fell — or did not —
			// could only be recovered by replaying it.
			const name = id => (offered.find(entry => entry.kind === 'switch' &&
				entry.action.replacementId === id) || {}).species || id;
			opts.tape.push({turn: bundle.state.turn, phase: /Choose the next/.test(seen.prompt || '') ? 'replace' : 'choose',
				us: seen.us, usHp: seen.usHp, foe: seen.foe, foeHp: seen.foeHp, threat: seen.threat || '',
				chose: chosen.kind === 'move' ? chosen.move : 'switch to ' + name(chosen.replacementId),
				why: /Choose the next/.test(seen.prompt || '') ? 'forced replacement' :
					searchLookaheadDepth > 0 ? 'lookahead-' + searchLookaheadDepth : 'search-' + rollouts,
				options: optionsOf(seen),
				scores: searched.scores.map(entry => Object.assign({}, entry,
					{choice: /^switch:/.test(entry.choice) ? 'switch to ' + name(entry.choice.slice(7)) : entry.choice})),
				events: (reply.events || []).map(event => event.text).filter(Boolean)});
			seen = viewOf(reply);
		}
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
		killers: reply && reply.deaths ? reply.deaths.map(death => ({monId: death.monId, species: death.species, by: death.by, of: death.of})) : [],
		knockouts: reply && reply.knockouts ? reply.knockouts.slice() : []};
}

module.exports = {start, startWild, act, legalActions, view, streamFor, adjudicate, playbook, catchMath, catchOddsAtFullHp, incomingThreat, setPPModel, setSwitchPricing, switchPricing, setHidingForecast, hidingForecasts, setRealSpeed, realSpeedReads, setChargeThreat, chargeThreats, setDoublesJoint, doublesJoint, searchDoublesJointly, setSearchWiden, searchWiden, setSearchKeep, searchKeep, setSearchHalving, searchHalving, setSearchPath, searchPath, setSearchLookahead, searchLookahead, lookaheadChoice, raceOdds, setEnemySwitchScoring, enemySwitchScoring, enemySwitchScore, chooseEnemyReplacement, benchRace, refusalEvent, playDoubles, lockedOut, settleAiSide, phaseOf, playSearch, searchChoice, optionsOf, BALLS};
