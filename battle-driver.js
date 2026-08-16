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
	const base = legalActions(state);
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
	bundle.contributionVersion = 1;
	bundle.contributionComplete = true;
	bundle.contributions = contributionRoster(bundle.party, activeOf(state, 'player'));
	return {
		battle: bundle,
		viewState: view(state),
		actions: legalActions(state),
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
	const profile = require('./profiles').getProfile(doc.profileId);
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
		},
		profileId: doc.profileId,
	});
	const bundle = {
		state: built.state,
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
				events.push({text: `${label}${actor.species} used ${action.moveName}.` +
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
					events.push({text: `${findMon(state, aimed.actorId).species} flinched at ` +
						`the engine: ${error.message}`});
				}
			}
			state = settleAiSide(state, events);
			state = clearDeadPlayerPending(state);
			if (!finished(state) && phaseOf(state) !== 'replace') {
				state = ai.advanceTurn(state);
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
		for (const entry of entries) {
			const action = entry.action || entry;
			if (!alive(state, action.actorId)) continue;
			const isPlayers = action.actorId.indexOf('player') === 0;
			const aimed = retarget(state, action);
			if (!aimed) continue;
			try {
				applyOne(aimed, isPlayers ? '' : bundle.wild ? 'Wild ' : 'Foe ');
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
	const next = Object.assign({}, bundle, {state, step: bundle.step + 1, phase, deaths: carried,
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
function playRollout(doc, trainerName, seed, answerFor) {
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

module.exports = {start, startWild, act, legalActions, view, streamFor, adjudicate, playbook, catchMath, BALLS};
