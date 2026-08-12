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
const ai = require('./ai');

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

const activeOf = (state, sideId) => state.sides[sideId].activeIds[0];
const findMon = (state, id) =>
	[...state.sides.ai.party, ...state.sides.player.party].find(mon => mon.id === id);
const sideOut = (state, sideId) => state.sides[sideId].party.every(mon => mon.hp.current <= 0);
const alive = (state, id) => {
	const mon = findMon(state, id);
	return !!mon && mon.hp.current > 0;
};

function pendingOn(state, sideId) {
	return (state.pendingForcedSwitchIds || [])
		.some(id => state.sides[sideId].party.some(mon => mon.id === id));
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
			state = Object.assign({}, state, {pendingForcedSwitchIds:
				state.pendingForcedSwitchIds.filter(id =>
					!state.sides.ai.party.some(mon => mon.id === id))});
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
	return Object.assign({}, state, {pendingForcedSwitchIds:
		state.pendingForcedSwitchIds.filter(id =>
			!state.sides.player.party.some(mon => mon.id === id))});
}

/** Singles retarget: whatever the enumeration aimed at, the move lands on the
 * CURRENT foe active — the one that switched in mid-turn included. */
function retarget(state, action) {
	if (action.kind !== 'move') return action;
	const foeSide = state.sides.ai.party.some(mon => mon.id === action.actorId) ? 'player' : 'ai';
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
function legalActions(state) {
	const playerActive = findMon(state, activeOf(state, 'player'));
	const mustReplace = (playerActive && playerActive.hp.current <= 0) || pendingOn(state, 'player');
	if (mustReplace) {
		return ai.enumerateForcedSwitchActions(state, 'player').map(action => ({
			kind: 'switch',
			action,
			species: findMon(state, action.replacementId).species,
			hp: findMon(state, action.replacementId).hp,
		}));
	}
	const moves = ai.evaluateActions(state, ai.calculateActionFacts, 'player')
		.filter(entry => entry.action.kind === 'move')
		.map(entry => {
			const damage = entry.facts && entry.facts.damage;
			return {
				kind: 'move',
				action: entry.action,
				move: entry.action.moveName,
				damage: damage && damage.targetHp ? {
					min: Math.round(damage.min / damage.targetHp * 100),
					max: Math.round(damage.max / damage.targetHp * 100),
					guaranteedKO: !!damage.guaranteedKO,
				} : null,
			};
		});
	const switches = ai.enumerateSwitchActions(state, 'player').map(action => ({
		kind: 'switch',
		action,
		species: findMon(state, action.replacementId).species,
		hp: findMon(state, action.replacementId).hp,
	}));
	return moves.concat(switches);
}

/** The compact view the panel draws: actives with HP, benches as chips. */
function view(state) {
	const card = mon => ({
		id: mon.id,
		species: mon.species,
		level: mon.level,
		hp: {current: Math.max(0, mon.hp.current), max: mon.hp.max},
		status: mon.status || null,
		item: mon.item || null,
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

function finished(state) {
	if (sideOut(state, 'ai')) return 'win';
	if (sideOut(state, 'player')) return 'loss';
	return null;
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
	const specs = runtime.partySpecs(doc, {atOrder: fight.order});
	const built = planner.buildFightState({
		trainer: fight.trainer,
		playerParty: specs,
		profileId: doc.profileId,
	});
	const state = built.state;
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
	return {
		battle: bundle,
		viewState: view(state),
		actions: legalActions(state),
		events: [{text: `${fight.trainer} wants to battle!`}],
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
	const rng = streamFor(bundle.seed, bundle.step);
	const already = finished(state);
	if (already) throw new Error('battle: this fight is over — start another');

	const applyOne = (action, label) => {
		const before = state;
		if (action.kind === 'move') {
			const facts = ai.calculateActionFacts(state, action);
			state = ai.applyAction(state, action,
				ai.deriveMoveResolution(state, action, {facts, random: rng}));
			const actor = findMon(before, action.actorId);
			const target = action.targetIds && action.targetIds[0] ?
				findMon(state, action.targetIds[0]) : null;
			const was = target && findMon(before, target.id);
			const dealt = target && was ? Math.max(0, was.hp.current - target.hp.current) : 0;
			events.push({text: `${label}${actor.species} used ${action.moveName}.` +
				(target && dealt ? ` (${Math.round(dealt / target.hp.max * 100)}% to ${target.species})` : '')});
		} else {
			state = ai.applyAction(state, action);
			const incoming = findMon(state, action.replacementId);
			events.push({text: `${label}${incoming.species} was sent out.`});
		}
		recordFaints(before, state, action.kind === 'move' ? action.moveName : null,
			action.actorId, events, faints);
	};

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
		// The held end-of-turn now runs — the same order the engine's own
		// rollouts resolve (replacement first, then the turn boundary).
		if (!finished(state)) state = ai.advanceTurn(state);
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
		try {
			aiPick = ai.chooseStateAction(state, ai.calculateActionFacts, 'ai', rng,
				{includeSwitches: false});
		} catch (error) {
			aiPick = null; // a policy with nothing to say forfeits its action, never the fight
		}
		const entries = ai.orderActions(state,
			[aiPick && aiPick.action, playerAction].filter(Boolean), {random: rng});
		for (const entry of entries) {
			const action = entry.action || entry;
			if (!alive(state, action.actorId)) continue;
			const isPlayers = action.actorId.indexOf('player') === 0;
			const aimed = retarget(state, action);
			if (!aimed) continue;
			try {
				applyOne(aimed, isPlayers ? '' : 'Foe ');
			} catch (error) {
				// One illegal transition must not eat the fight: the actor simply
				// loses the beat (the engine refused it), and the turn goes on.
				events.push({text: `${findMon(state, action.actorId).species} flinched at ` +
					`the engine: ${error.message}`});
			}
			state = settleAiSide(state, events);
			state = clearDeadPlayerPending(state);
			if (finished(state)) break;
		}
		// End-of-turn effects wait for the player's replacement when their
		// active fell mid-turn; otherwise the turn closes now.
		if (!finished(state) && phaseOf(state) !== 'replace') {
			state = ai.advanceTurn(state);
		}
	}

	state = settleAiSide(state, events);
	const result = finished(state);
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
	const next = Object.assign({}, bundle, {state, step: bundle.step + 1, phase, deaths: carried});
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
		actions: result ? [] : legalActions(state),
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
function adjudicate(doc, trainerName, options) {
	options = options || {};
	const rollouts = options.rollouts === undefined ? 12 : options.rollouts;
	const seedBase = options.seedBase === undefined ? 1000 : options.seedBase;
	const answerFor = options.answerFor || {};

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

	let wins = 0;
	let deaths = 0;
	let deathless = 0;
	for (let i = 0; i < rollouts; i++) {
		let opened = start(doc, trainerName, seedBase + i);
		let bundle = opened.battle;
		let actions = opened.actions;
		let viewState = opened.viewState;
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
			if (reply.result) break;
		}
		const lost = bundle.state.sides.player.party.filter(mon => mon.hp.current <= 0).length;
		if (reply && reply.result === 'win') wins += 1;
		deaths += lost;
		if (lost === 0) deathless += 1;
	}
	return {
		pWin: rollouts ? Math.round(wins / rollouts * 100) / 100 : null,
		eDeaths: rollouts ? Math.round(deaths / rollouts * 100) / 100 : null,
		pDeathless: rollouts ? Math.round(deathless / rollouts * 100) / 100 : null,
		rollouts,
	};
}

module.exports = {start, act, legalActions, view, streamFor, adjudicate};
