#!/usr/bin/env node
/* eslint-env node, es6 */
'use strict';

/**
 * Headless full-run harness: whole playthroughs on the engine, no browser.
 *
 * Born of necessity — the brkeys outcome batch was starved four times by a
 * full disk (a browser run's Chromium transient is ~400MB; this is ~2MB) —
 * but kept because it buys something the browser harness cannot: SEED
 * PAIRING. Both arms of a pair replay the same dice, so every divergence is
 * the treatment's, and a run-level comparison stops paying the box-luck tax
 * that swamped n=8 browser batches all week.
 *
 * PARITY, stated rather than implied: this is a SECOND INSTRUMENT, not the
 * browser driver headless. Fights are the battery's engine loop with the
 * real decide() reading panel-parity text (lib/battle-view.js, gated).
 * Rolls, catches, skips, beats, teaching and scale-spending go through the
 * same lib/run commands the panel posts. What it does NOT replicate: the
 * driver's journal pacing, hold/give item advice, box re-rolling on stall,
 * or wall retry heuristics beyond the caps. An A/B on this instrument is
 * internally valid (same loop both arms); its absolute reach numbers are
 * not comparable to browser batches and are never pooled with them.
 *
 *   node scripts/headless-run.js --pairs=12 --label=hrkeys1 \
 *     --a="--key-catches=0 --key-scales=0" --b="--key-catches=1 --key-scales=1"
 *
 * Arm flags are read by this harness itself (key-catches, key-scales); the
 * policy flags of decide() come from this process's argv as usual.
 */

const fs = require('node:fs');
const run = require('../lib/run.js');
const battery = require('./scenario-battery.js');
const driver = require('../lib/battle-driver.js');
const nicknames = require('../lib/nicknames.js');

function flag(name, fallback) {
	const hit = process.argv.find(arg => arg.startsWith('--' + name + '='));
	return hit ? hit.split('=').slice(1).join('=') : fallback;
}

/** Deterministic dice: one stream per run, seeded, no Math.random anywhere. */
function dice(seed, at) {
	let state = seed % 2147483647;
	if (state <= 0) state += 2147483646;
	// A checkpoint carries the stream's position, so a run that is stopped and
	// carried on rolls what it would have rolled.
	if (Number.isInteger(at)) state = at;
	const roll = () => (state = (state * 48271) % 2147483647) / 2147483647;
	roll.at = () => state;
	return roll;
}

const STARTERS = [
	{species: 'Turtwig', rival: 'Blaziken'},
	{species: 'Chimchar', rival: 'Swampert'},
	{species: 'Piplup', rival: 'Sceptile'},
];
// Attempts at one fight before a delayable fight is skipped or the run
// stops. Retrying is allowed on this rung (no permadeath); the cost is
// counted in fights, the efficiency measure.
/**
 * The run's knobs: read from argv once, and OVERRIDABLE PER RUN.
 *
 * These were module constants, so an arm played in-process through
 * playRun(…, armFlags('--budget=45 --boss-retries=6')) silently played the
 * defaults: armFlags parsed three treatment flags and dropped the rest, and
 * the row's provenance listed no flags at all. Five "marginal body" runs were
 * measured that way on 2026-09-20 before a review caught it. A knob named in
 * an arm's spec now reaches the run, and the row records what it played.
 */
const KNOB_FLAGS = {
	retries: ['retries', '12', Number],
	// PERMADEATH (docs/ENCOUNTER-ARCHITECTURE.md, "nuzlocke" mode): the run is
	// created with permadeath, every body that faints in a kept attempt, won or
	// lost, is written dead with a faint command, and a lost fight is retried
	// with whoever is left. The run ends when no body is left. Scouting fights
	// (probes, plans, search) are played in the run's head and cost nothing.
	nuzlocke: ['nuzlocke', '0', value => value === '1'],
	// With --nuzlocke: the first lost fight ends the run (a blackout), the
	// strict reading. Off, the run retries the wall with its survivors.
	blackoutEnds: ['blackout-ends', '0', value => value === '1'],
	// Under permadeath the first attempt is the one that costs bodies, so the
	// strong hand belongs there, not after losses: --search-first plays every
	// singles fight by rollout search from its first attempt, and --plan-first
	// plans each boss by play before its first attempt. Off until measured.
	searchFirst: ['search-first', '0', value => value === '1'],
	planFirst: ['plan-first', '0', value => value === '1'],
	// A DELAYABLE fight (the profile's delayableFights: Camper Gavi) is scouted
	// before each first attempt — decide() fights in the run's head, costing no
	// body — and put off to the next cap while the scouted win rate is under this
	// share, instead of being learned by losing it. Under permadeath a loss is the
	// box. 0 is off. A fight still unsafe when the caps run out is left owed,
	// and the run stops there as it always has ("owed fights wait on a higher cap").
	delayUntil: ['delay-until', '0', Number],
	// A singles fight that is not a boss is PLANNED by play before its first
	// attempt when eight scouting fights in the run's head win under this share:
	// under permadeath a fight nobody is confident in is not walked into
	// unprepared. Bosses have --plan-first. 0 is off.
	planUnsafe: ['plan-when-unsafe', '0', Number],
	// What a plan is chosen for. Off: most wins, then fewest of theirs left.
	// On: most of OUR bodies kept per scouting fight (a win keeps whoever is
	// standing, a loss keeps none), then wins, then theirs left — under
	// permadeath a win bought with three bodies is not the plan to take.
	planKeep: ['plan-keep', '0', value => value === '1'],
	bossRetries: ['boss-retries', '20', Number],
	budget: ['budget', '110', Number],
	skipDoubles: ['skip-doubles', '0', value => value === '1'],
	doubleRetries: ['double-retries', null, Number],
	prizeAt: ['prize-at', 'stuck', String],
	prizeStuck: ['prize-stuck', '6', Number],
	evolveItems: ['evolve-items', '1', value => value === '1'],
	// The story gifts (the Lavaridge egg, Castform, Kubfu), claimed when the road reaches them.
	gifts: ['gifts', '1', Number],
	// Which body gets the run's one Mega: the board's best against the fight in front, not party order.
	megaByBoard: ['mega-by-board', '1', Number],
	fillSlots: ['fill-slots', '1', value => value === '1'],
	// A run that only needs to answer "does it pass this wall" stops once the
	// road is past that order, instead of playing on for hours.
	stopAt: ['stop-at', null, Number],
	// What a sweep passes on argv, and what an in-process baseline therefore
	// silently lacked: six runs on 2026-09-21 played all sixty of their Brawly
	// attempts with decide(), because --search-after lived only on argv.
	scaleIvs: ['scale-ivs', '0', value => value === '1'],
	repickAfter: ['repick-after', '0', Number],
	// A wall lost this many times is PLANNED by play: who leads, who is held back, who comes in from the box.
	// ON at 5 since 2026-09-21, on the bar declared before the data (docs/PERFORMANCE.md): three held-out walls
	// from clear1, four arms each from the same document. It cleared Aqua Admin Matt in 6 attempts and Aqua
	// Admin Shelly in 7 where the control went 0 for 40 on both, lost none, and took the same 7 on the wall
	// every arm cleared. --plan-after=0 restores the run without it.
	planAfter: ['plan-after', '5', Number],
	// An OPERATOR's lead for one fight, "TRAINER:SPECIES@ITEM" (spaces as +): that body leads,
	// holding that item, whatever the six and the plan chose. Not a policy — a
	// hand on the run, recorded in its knobs so a leg played with it reads as
	// assisted. Added 2026-09-22 for Champion Wallace: a Focus Sash Dhelmise
	// takes Primal Kyogre with Power Whip before Ice Beam can.
	leadFor: ['lead-for', null, String],
	planSeeds: ['plan-seeds', '12', Number],
	// The plan proposes HELD ITEMS as well as bodies and order (docs/PLAN.md 2.1): a Focus Sash,
	// Choice Scarf or Choice item onto the lead, a gem or a resist berry onto the body the board
	// reads as one hit short. A policy change, so OFF until it passes the held-out wall bar.
	planItems: ['plan-items', '0', value => value === '1'],
	searchAfter: ['search-after', '0', Number],
	searchRollouts: ['search-rollouts', '4', Number],
	doublesPrep: ['doubles-prep', '1', value => value === '1'],
	catchMethod: ['catch-method', '0', value => value === '1'],
	// Quick decide() fights played before a boss's first attempt, RECORDED and
	// not acted on: see probeWall.
	probe: ['probe', '12', Number],
	// Heart Scales the IV spender must leave in the bag: see spendScales.
	scaleReserve: ['scale-reserve', '2', Number],
	// Which fights keep their turn-by-turn log on the ledger row: 'bosses'
	// (bosses and doubles — the walls), 'all', or 'none'. See docs/HOW-WE-WIN.md.
	fightLogs: ['fight-logs', 'bosses', String],
	// The player's one Mega a fight, from Flannery on: see giveMegaStone.
	mega: ['mega', '1', value => value === '1'],
	// A won rollout valued by the bodies it kept (driver.setSearchKeep).
	searchKeep: ['search-keep', '1', value => value === '1'],
	// What winning is worth apart from the bodies it kept (driver.setSearchKeepWeight).
	searchKeepWeight: ['search-keep-weight', '0.5', Number],
	// The same playouts spent by sequential halving (driver.setSearchHalving).
	searchHalving: ['search-halving', '0', value => value === '1'],
	// A lost playout valued by its path too (driver.setSearchPath).
	searchPath: ['search-path', '0', value => value === '1'],
	// How many of our own decisions deep the search looks exactly, the foe on its own AI, instead of playing fights out.
	searchLookahead: ['search-lookahead', '0', Number],
	// A lost-race attack is played out against every switch before it is made (scenario-battery playedSwitch).
	switchPlayed: ['switch-played', '0', Number],
	// The enemy's post-KO replacement, by the hack's documented switch-in scoring rather than enumeration order.
	enemySwitchScoring: ['enemy-switch-scoring', '1', Number],
	// The probe picks the hand: a six decide() wins with is played by decide(), not handed to search for good.
	handByProbe: ['hand-by-probe', '0', Number],
};

function knobsFrom(read) {
	const out = {};
	for (const name of Object.keys(KNOB_FLAGS)) {
		const spec = KNOB_FLAGS[name];
		const raw = read(spec[0]);
		if (raw !== undefined && raw !== null) out[name] = spec[2](raw);
	}
	return out;
}

function withDefaults(given) {
	const out = Object.assign(knobsFrom(name => KNOB_FLAGS[Object.keys(KNOB_FLAGS)
		.find(key => KNOB_FLAGS[key][0] === name)][1]), given);
	// A double gets the boss budget unless it is given its own.
	if (out.doubleRetries === undefined || Number.isNaN(out.doubleRetries)) out.doubleRetries = out.bossRetries;
	return out;
}

let knobs = withDefaults(knobsFrom(name => {
	const hit = process.argv.find(arg => arg.startsWith('--' + name + '='));
	return hit ? hit.slice(name.length + 3) : undefined;
}));
const BOSS = /Leader|Elite|Champion|Rival|Admin|Chelle|Wally|Soupercell/i;
// A double is not a boss by name and was getting a dozen attempts, so a run
// walked past four of them owing the debt (sweep 15's deepest run, which
// reached fight #290 of 358). They are the road's hardest class: the bridge
// rival fell on the ninth attempt of sixty.
/** The attempts a fight gets before the run walks past it. */
function retryCap(trainer, isDouble) {
	if (BOSS.test(trainer)) return knobs.bossRetries;
	return isDouble ? knobs.doubleRetries : knobs.retries;
}

function armFlags(spec) {
	const flags = {};
	for (const arg of spec.split(/\s+/).filter(Boolean)) {
		const hit = /^--([^=]+)=(.*)$/.exec(arg);
		if (hit) flags[hit[1]] = hit[2];
	}
	return {
		keyCatches: flags['key-catches'] !== '0',
		keyScales: flags['key-scales'] !== '0',
		keyEvolve: flags['key-evolve'] !== '0',
		// The run knobs this arm names; playRun applies them for its run only.
		knobs: knobsFrom(name => flags[name]),
	};
}

/**
 * The species the road ahead is won with: every named answer the fight
 * dossiers give for the next fights, and the lines that reach them.
 */
function answersAhead(doc, howMany) {
	const oracle = require('../profiles').getProfile(doc.profileId).oracle;
	const wanted = new Set();
	if (!oracle.fightDossierOf) return wanted;
	for (const fight of run.upcoming(doc, howMany || 40)) {
		let dossier = null;
		try { dossier = oracle.fightDossierOf(fight.trainer); } catch (error) { continue; }
		if (!dossier) continue;
		for (const species of dossier.keyBox || []) wanted.add(species);
		for (const mon of dossier.mons || []) for (const species of mon.topAnswers || []) wanted.add(species);
	}
	return wanted;
}

/**
 * Which method to roll on a route whose tables differ: the one that can
 * produce an answer to a fight ahead. A run walks by default and never
 * fishes or surfs for a named body, so an answer that lives in the water is
 * one a run cannot have — Archie's rain team at Seafloor Cavern stopped
 * sweep 16's deepest run 0 of 60, with no Water Absorb body in 59 caught.
 * Off unless --catch-method=1.
 */
function methodFor(doc, map, wanted) {
	if (!wanted.size) return undefined;
	let table;
	try { table = run.encountersOn(doc, map); } catch (error) { return undefined; }
	const oracle = require('../profiles').getProfile(doc.profileId).oracle;
	const weight = {};
	for (const mon of (table && table.mons) || []) {
		if (mon.methodGated !== undefined || mon.dupe) continue;
		const line = (oracle.lineageOf && oracle.lineageOf(mon.species)) || [mon.species];
		const answers = line.some(species => wanted.has(species)) || wanted.has(mon.species);
		if (!answers) continue;
		weight[mon.method] = (weight[mon.method] || 0) + (mon.odds !== undefined ? mon.odds : mon.chance || 1);
	}
	const best = Object.keys(weight).sort((a, b) => weight[b] - weight[a])[0];
	return best;
}

/**
 * The nickname this catch gets: stable for the run (the catch order is the
 * key), never repeated. A run's losses are its story, and a story needs a
 * name rather than the species the sweep has buried a dozen times.
 */
function nameFor(doc, species) {
	return nicknames.nicknameFor(species, doc.box.length,
		new Set(doc.box.map(mon => mon.nickname).filter(Boolean)));
}

function catchRolled(doc, map, random, wanted) {
	const method = wanted ? methodFor(doc, map, wanted) : undefined;
	const rolled = run.rollEncounter(doc, Object.assign({map, random}, method ? {method} : {}));
	return run.apply(doc, {kind: 'catch', map, species: rolled.species,
		nickname: nameFor(doc, rolled.species),
		level: rolled.level, ivs: rolled.ivs, nature: rolled.nature,
		ability: rolled.ability});
}

/**
 * One catching sweep: at most one roll per still-open area, new ground
 * first. The treatment reorders by the SAME data the browser scout renders
 * — adviseCatches' keyAnswer areas for the split boss.
 */
function sweepCatches(doc, caughtFrom, random, treatment, tally) {
	const wanted = knobs.catchMethod ? answersAhead(doc, 60) : null;
	let routes;
	try {
		routes = run.unusedRoutes(doc, {allProspects: true}).routes
			.filter(route => route.open && !route.held && !route.undated)
			.filter(route => !caughtFrom.has(route.name));
	} catch (error) {
		return doc;
	}
	if (treatment.keyCatches && routes.length > 1) {
		try {
			const advice = run.adviseCatches(doc);
			const keyAreas = new Set(advice.catches
				.filter(row => row.keyAnswer).map(row => row.area));
			if (keyAreas.size) {
				tally.keyRolls += 1;
				routes = routes.slice().sort((a, b) =>
					(keyAreas.has(b.name) ? 1 : 0) - (keyAreas.has(a.name) ? 1 : 0));
			}
		} catch (error) { /* no advice, no reordering */ }
	}
	// No box cap: a player's PC holds everything. The harness stopped at 24,
	// which a run reaches by mid-game (the Shelly box, at #697), so it never
	// caught on one late route — Victory Road's Metagross and Tyranitar,
	// Meteor Falls' Dragonite, Salamence, Hydreigon — and met the Elite Four
	// with a mid-game box.
	for (const route of routes) {
		caughtFrom.add(route.name);
		try {
			doc = catchRolled(doc, route.name, random, wanted);
			tally.catches += 1;
		} catch (error) {
			// A multi-floor AREA has no table of its own ("no map named
			// Granite Cave"), and the refusal was swallowed: no headless run
			// ever caught in Granite Cave, Mirage Tower, Victory Road or
			// Meteor Falls — Norman's Steel answers and the late game's
			// Metagross, Tyranitar and dragons. The one encounter is rolled
			// on one of the area's floors instead, picked on the run's dice.
			const floors = (route.maps || []).slice();
			while (floors.length) {
				const floor = floors.splice(Math.floor(random() * floors.length), 1)[0];
				try {
					doc = catchRolled(doc, floor, random);
					tally.catches += 1;
					break;
				} catch (floorError) { /* this floor refuses; try another */ }
			}
		}
	}
	return doc;
}

/**
 * The Game Corner's ONE prize, and when to take it.
 *
 * Ruling 2026-09-20 (the-game-corner-pays-once): one Pokemon a run, from any
 * tier whose gym is beaten, random within the tier. Until then this claimed
 * one per badge — up to eight extra bodies and a mythical — so every sweep
 * past Roxanne was over-supplied.
 *
 * One pull makes it an option with an exercise date: after Brawly it is a
 * Smoochum, held to the Rain Badge it is a Jirachi, and a run that dies at
 * Norman holding it has wasted it. --prize-at says when:
 *
 *   stuck (default)  hold it, and pull the highest open tier the first time
 *                    a wall has been lost --prize-stuck times — the option is
 *                    exercised when the run needs a body, not before. It is
 *                    also pulled the moment the last tier opens, since
 *                    nothing better is coming.
 *   N (1-8)          pull as soon as tier N is open.
 *   asap             tier 1, the moment Brawly falls.
 *   never            a control: the run plays without it.
 *
 * "Highest open tier" assumes the tiers ascend in worth, which their species
 * suggest and nothing here has measured. The dupes clause re-rolls within
 * the tier, as a player re-rolls a dupe.
 */

/**
 * THE STORY GIFTS, claimed when the road reaches them.
 *
 * A gift is a scripted event, not an encounter-table roll: the run rolled
 * wild routes and nothing else, so the egg at Lavaridge (571), Castform at
 * the Weather Institute (701) and KUBFU at Mossdeep (1125) were never owned
 * by any run there has ever been — checked across every record on disk:
 * zero. Kubfu arrives 24 fights before Leader Tate and evolves at level 50
 * into an Urshifu, and no run has ever held one.
 *
 * Claimed once each, at the earliest position the workbook can be dated to,
 * at LEVEL 1: levelling to the cap is free, so the arrival level only
 * matters if it is above the cap, and 1 is the one number that cannot
 * overstate what a run was given. The dupes clause applies as it does to a
 * catch. A gift does NOT consume its area's wild encounter — it is not an
 * encounter — which is a ruling Philip has not made; it is raised as an open
 * question and --gifts=0 plays without them.
 */
function claimGifts(doc, random, tally) {
	const profile = require('../profiles').getProfile(doc.profileId);
	if (!knobs.gifts || !profile.oracle.gifts) return doc;
	const taken = new Set((doc.log || []).map(entry => entry.command.gift).filter(Boolean));
	const rules = run.encounterRules(doc);
	for (const gift of profile.oracle.gifts()) {
		if (gift.opensAt === null || doc.position < gift.opensAt) continue;
		const at = gift.where + '@' + gift.opensAt;
		if (taken.has(at)) continue;
		// One of a set (the starter egg) is rolled as the game rolls it.
		const lines = new Set(doc.box.map(mon => run.dupeKey(rules.dupes, profile, mon.species)));
		const options = (gift.options || [gift.species]).filter(Boolean).filter(species => {
			const key = run.dupeKey(rules.dupes, profile, species);
			return key === null || !lines.has(key);
		});
		if (!options.length) continue;
		const species = options[Math.floor(random() * options.length)];
		try {
			doc = run.apply(doc, Object.assign({kind: 'catch', species, level: 1, gift: at,
				nickname: nameFor(doc, species)}, run.rollIdentity(species, random)));
			tally.gifts = (tally.gifts || 0) + 1;
			tally.gifted = (tally.gifted || []).concat([{species, where: gift.where, at: doc.position}]);
		} catch (error) { /* refused: the run goes on without it */ }
	}
	return doc;
}

function claimPrizes(doc, random, tally, attempts) {
	const profile = require('../profiles').getProfile(doc.profileId);
	if (knobs.prizeAt === 'never' || !profile.oracle.prizeTiers) return doc;
	if ((doc.log || []).some(entry => entry.command.kind === 'catch' && entry.command.prize)) return doc;
	const tiers = profile.oracle.prizeTiers();
	const open = tiers.filter(tier => tier.opensAt !== null && doc.position >= tier.opensAt);
	if (!open.length) return doc;
	const top = open[open.length - 1];
	let tier = null;
	if (knobs.prizeAt === 'asap') tier = open[0];
	else if (/^[1-8]$/.test(knobs.prizeAt)) tier = open.length >= Number(knobs.prizeAt) ? tiers[Number(knobs.prizeAt) - 1] : null;
	else if (open.length === tiers.length || (attempts || 0) >= knobs.prizeStuck) tier = top;
	if (!tier) return doc;

	const rules = run.encounterRules(doc);
	const lines = new Set(doc.box.map(mon => run.dupeKey(rules.dupes, profile, mon.species)));
	// With the clause off every key is null; only a real key can match.
	const options = tier.options.filter(species => {
		const key = run.dupeKey(rules.dupes, profile, species);
		return key === null || !lines.has(key);
	});
	if (!options.length) return doc;
	const species = options[Math.floor(random() * options.length)];
	const cap = run.levelCap(doc).cap || 50;
	try {
		doc = run.apply(doc, Object.assign({kind: 'catch', species, level: cap, prize: tier.badge,
			nickname: nameFor(doc, species)},
		run.rollIdentity(species, random)));
		tally.prizes = (tally.prizes || 0) + 1;
		tally.prize = {species, tier: tier.badge, at: doc.position,
			why: knobs.prizeAt === 'stuck' ? (open.length === tiers.length ? 'the last tier opened' :
				'a wall was lost ' + attempts + ' times') : '--prize-at=' + knobs.prizeAt};
	} catch (error) { /* refused: the run keeps what it had */ }
	return doc;
}

/**
 * Collect every open field item the overworld has handed out — the Heart
 * Scales included, which is what lets the key-scales treatment exist at
 * all. `collected` is the run's own memory, so a sweep never double-takes.
 */
function sweepItems(doc, tally) {
	let areas;
	try {
		areas = run.unusedRoutes(doc, {allProspects: true}).routes;
	} catch (error) {
		return doc;
	}
	for (const route of areas) {
		let rows;
		try {
			rows = run.fieldItems(doc, route.name);
		} catch (error) {
			continue;
		}
		for (const row of rows) {
			if (!row.open || row.collected) continue;
			try {
				doc = run.apply(doc, {kind: 'acquire', item: row.name, where: row.location});
				tally.pickups = (tally.pickups || 0) + 1;
			} catch (error) { /* a refused acquire takes nothing */ }
		}
	}
	return pickBerries(doc, tally);
}

/**
 * What the pass above can never match: rows with no route at their head.
 *
 * It finds an item by ONE route's name at the start of its place. Two kinds of
 * row have none. A tree row reads "Berry Trees at Routes 110, 111, 112, …" —
 * so no headless run had ever held a Sitrus Berry. And a HANDED-OVER row reads
 * "Given by Leader Wattson after you defeat him" or "Given by an NPC in
 * Rusturf Tunnel" — 23 dated rows, among them every gym leader's TM
 * (Seismic Toss, Shock Wave, Thunderbolt, Facade), HM06 Rock Smash, and TM46
 * Rock Tomb, a speed-control move dated at order 148 that a survey of saved
 * boxes found teachable 35 times and owned never.
 *
 * A row is taken once its date has passed, and once: a party's worth (six) of
 * a tree's berries, though the sheet says 12 to 36 and they regrow; one of
 * anything handed over. Undated rows are left alone.
 */
const BERRY_TAKE = 6;
const NO_ROUTE_AT_ITS_HEAD = /^(Berry Trees? at |Given by )/i;
function pickBerries(doc, tally) {
	const profile = require('../profiles').getProfile(doc.profileId);
	if (!profile.oracle.fieldItems) return doc;
	const taken = new Set((doc.log || []).filter(entry => entry.command && entry.command.kind === 'acquire' &&
		entry.command.where).map(entry => entry.command.item + '|' + entry.command.where));
	for (const row of profile.oracle.fieldItems()) {
		if (!Number.isInteger(row.opensAt) || row.opensAt > doc.position) continue;
		if (!NO_ROUTE_AT_ITS_HEAD.test(row.location || '')) continue;
		const tree = row.kind === 'berry';
		const where = String(row.location).slice(0, 120);
		if (taken.has(row.name + '|' + where)) continue;
		try {
			doc = run.apply(doc, Object.assign({kind: 'acquire', item: row.name, where}, tree ? {count: BERRY_TAKE} : {}));
			tally.pickups = (tally.pickups || 0) + 1;
			if (tree) tally.berries = (tally.berries || 0) + 1;
			else tally.handedOver = (tally.handedOver || 0) + 1;
			taken.add(row.name + '|' + where);
		} catch (error) { /* a refused acquire takes nothing */ }
	}
	return doc;
}

/**
 * Every living Pokemon to the level cap, as a player grinds before a fight.
 * Levels up to the cap are free (levelUp charges Rare Candy only above it),
 * and levelling fills free move slots. The harness never did this: stored
 * levels stayed at catch levels (a Turtwig at 5 fighting Gavi at 17 by
 * projection), so every advice row that needed the real level — a level-up
 * move, a level evolution — was refused by the command it became.
 */
function levelToCap(doc, tally) {
	let cap;
	try {
		cap = run.levelCap(doc).cap;
	} catch (error) {
		return doc;
	}
	if (cap === null) return doc;
	const evolutions = require('../profiles/run-and-bun/oracle/evolutions.json');
	for (const mon of doc.box) {
		if (mon.status === 'dead' || mon.level >= cap) continue;
		// IN STAGES, across each level evolution on the way. One jump to the
		// cap levelled the pre-evolution the whole way and evolved it after,
		// so the evolved form never learned its own level-up moves: the Kubfu
		// gift, claimed at level 1 at the Elite Four, became a level-99
		// Urshifu that knew Rock Smash, Leer, Focus Energy and Aerial Ace —
		// never Close Combat (50), Sucker Punch (60) or Wicked Blow (90) — and
		// the ranker rightly never fielded it. The game evolves on the level
		// and learns the rest as the evolved form. The Lavaridge egg's Mudkip
		// had the same defect twice over (16 and 36).
		// A body ALREADY at or past its evolution level (a Magikarp caught at
		// 40) evolves first: the stages below only look above its level, so it
		// was levelled to the cap as a Magikarp and became a Gyarados knowing
		// Splash, Tackle and Flail.
		doc = evolveByLevel(doc, tally, mon.id);
		for (let stage = 0; stage < 4; stage++) {
			const current = doc.box.find(entry => entry.id === mon.id);
			const step = (evolutions[current.species] || []).filter(path => path.method === 'level' &&
				path.level > current.level && path.level < cap).sort((a, b) => a.level - b.level)[0];
			if (!step) break;
			try {
				doc = run.apply(doc, {kind: 'levelUp', id: mon.id, to: step.level});
				tally.levelUps = (tally.levelUps || 0) + 1;
			} catch (error) {
				break;
			}
			const before = doc.box.find(entry => entry.id === mon.id).species;
			doc = evolveByLevel(doc, tally, mon.id);
			if (doc.box.find(entry => entry.id === mon.id).species === before) break;
		}
		try {
			doc = run.apply(doc, {kind: 'levelUp', id: mon.id, to: 'cap'});
			tally.levelUps = (tally.levelUps || 0) + 1;
		} catch (error) { /* a refused level-up changes nothing */ }
	}
	return evolveByLevel(doc, tally);
}

/**
 * Level evolutions happen, as the game makes them happen on the level-up —
 * not only when the upgrade advisor prices one as a gain. The harness used
 * to wait for an evolve row, so boxes fought Brawly with a level-21 Tyrogue
 * and a Kakuna. A stat-conditioned branch goes the way this Pokemon's stats
 * send it (dossier.evolveMon); an unconditioned choice (Wurmple) takes the
 * first path the data lists. Chains run on (Weedle, Kakuna, Beedrill).
 */
function evolveByLevel(doc, tally, only) {
	const dossier = require('../lib/dossier');
	const evolutions = require('../profiles/run-and-bun/oracle/evolutions.json');
	for (const mon of doc.box) {
		if (mon.status === 'dead' || (only && mon.id !== only)) continue;
		for (let hops = 0; hops < 3; hops++) {
			const current = doc.box.find(entry => entry.id === mon.id);
			const into = dossier.evolveMon(current, current.level);
			if (into === current.species) break;
			const step = (evolutions[current.species] || []).find(path => path.method === 'level' &&
				path.level <= current.level && dossier.meetsRequirement(path, current.species, current.level,
				current.ivs, current.nature));
			if (!step) break;
			try {
				doc = run.apply(doc, {kind: 'evolve', id: mon.id, into: step.into});
				tally.evolves = (tally.evolves || 0) + 1;
			} catch (error) {
				break;
			}
		}
	}
	return doc;
}

/**
 * A stone the bag holds is used, on the whole box and not only the six.
 *
 * The harness buys one of every evolution stone (followAdvice) precisely so
 * the evolution can happen — and then left it to adviseUpgrades, which prices
 * rows for the PARTY AT THAT MOMENT, best sixteen first. The six is re-picked
 * later and a re-pick does not re-run the advice, so a body that joined the
 * six afterwards never met its stone: every legal Norman box (2026-09-20)
 * fielded a level-42 Eelektrik with a Thunder Stone in the bag. Worse, the
 * ranker was choosing among the unevolved bodies.
 *
 * Party first, then box order, because a stone is bought once and two bodies
 * can want it. A body holding an Eviolite keeps its form. --evolve-items=0
 * restores the advice-only behaviour for arms that measure against it.
 */
function evolveByItem(doc, tally) {
	if (!knobs.evolveItems) return doc;
	const dossier = require('../lib/dossier');
	const evolutions = require('../profiles/run-and-bun/oracle/evolutions.json');
	const order = doc.party.concat(doc.box.map(mon => mon.id).filter(id => !doc.party.includes(id)));
	for (const id of order) {
		const mon = doc.box.find(entry => entry.id === id);
		if (!mon || mon.status === 'dead' || mon.item === 'Eviolite') continue;
		const step = (evolutions[mon.species] || []).find(path => path.method === 'item' &&
			doc.bag[path.item] && dossier.meetsRequirement(path, mon.species, mon.level, mon.ivs, mon.nature));
		if (!step) continue;
		try {
			doc = run.apply(doc, {kind: 'evolve', id: mon.id, into: step.into});
			tally.evolves = (tally.evolves || 0) + 1;
			tally.itemEvolves = (tally.itemEvolves || 0) + 1;
		} catch (error) { /* refused: the body keeps its form */ }
	}
	return doc;
}

/**
 * The level-up moves a player keeps up with. A levelled Pokemon with a full
 * moveset leaves its new moves pending — only the player knows what to
 * forget — and the browser driver answers every prompt. The harness never
 * did, so a Cufant caught at 8 became a level-42 Copperajah knowing Tackle,
 * Growl, Rock Throw and Rock Smash. A level-up move of the current species
 * at or below its level (free to relearn) is learned when it is a clear
 * upgrade: stronger than a known attack of its own type, a real attack over
 * weak filler, or a strong STAB move over weak off-type coverage. Status moves, multi-hit moves, speed control and a type's
 * only attack are never the ones forgotten: raw power misreads all three (Triple Axel
 * reads as one 20-power hit; Fake Out is not better than it).
 */
/**
 * A body never relearns what it gave up.
 *
 * The rule offers every level-up move at or below the body's level and drops
 * its weakest attack for one, so the two swap places for ever: banked runs
 * spent 33-66% of their teaches re-teaching a move that body had already had,
 * one of them 970 times of 1,474 (Poison Jab over Drill Run, Drill Run over
 * Poison Jab, all game). `forgotten` is the memory that stops it.
 */
const INERT_MOVES = new Set(['Leer', 'Growl', 'Tail Whip', 'Focus Energy', 'Sand Attack', 'Smokescreen', 'Harden',
	'Defense Curl', 'Withdraw', 'Odor Sleuth', 'Foresight', 'Splash', 'Celebrate', 'Baby-Doll Eyes', 'Kinesis', 'Flash']);

function relearn(doc, policy, tally, forgotten) {
	const ai = require('../ai');
	const oracle = require('../profiles').getProfile(doc.profileId).oracle;
	const meta = name => {
		try {
			return ai.getMoveMetadata(name, 8);
		} catch (error) {
			return null;
		}
	};
	const power = name => {
		const found = meta(name);
		if (!found || found.category === 'Status') return 0;
		return (found.basePower || 0) * (found.accuracy === true ? 1 : Math.min(1, (found.accuracy || 100) / 100));
	};
	const multiHit = name => {
		const found = meta(name);
		return !!found && (found.multihit !== undefined || /^(Triple|Double|Dual|Bullet Seed|Rock Blast|Icicle Spear|Pin Missile|Arm Thrust|Fury|Bone Rush|Tail Slap|Water Shuriken|Scale Shot)/.test(name));
	};
	const typeOf = name => (meta(name) || {}).type || null;
	for (const mon of doc.box) {
		if (mon.status === 'dead') continue;
		// The level-up's own prompt is free and stands only until the next
		// one; remembering anything else costs a Heart Scale at the nurse, and
		// the whole game holds thirty. So the prompt is taken first, and the
		// rest only while a scale is spare (operator, 2026-09-20).
		const prompted = new Set(mon.prompted || []);
		const offered = (oracle.levelUpMoves(mon.species) || [])
			.filter(pair => pair[0] <= mon.level).map(pair => pair[1])
			.filter((move, index, list) => list.indexOf(move) === index).reverse()
			.sort((a, b) => (prompted.has(b) ? 1 : 0) - (prompted.has(a) ? 1 : 0));
		for (const move of offered) {
			const current = doc.box.find(entry => entry.id === mon.id);
			if (current.moves.includes(move) || power(move) <= 0 || multiHit(move)) continue;
			const gaveUp = forgotten && forgotten.get(mon.id);
			if (gaveUp && gaveUp.has(move)) continue;
			// A remembered move costs a Heart Scale and the game holds thirty, so
			// only a body that FIGHTS is worth one; the level-up's own prompt is
			// free for anyone.
			if (!prompted.has(move)) {
				if (!(doc.bag['Heart Scale'] > 0)) continue;
				if (!(doc.party || []).includes(mon.id)) continue;
			}
			let replace = null;
			if (current.moves.length >= 4) {
				// Speed control is worth more than its number (the policy presses
				// it), so it is never the one forgotten either.
				const attacks = current.moves.filter(known => power(known) > 0 && !multiHit(known) &&
					!(policy.isSlowControl && policy.isSlowControl(known)));
				const sameType = attacks.filter(known => typeOf(known) === typeOf(move) && power(known) < power(move))
					.sort((x, y) => power(x) - power(y));
				const alone = known => current.moves.filter(other => power(other) > 0 && typeOf(other) === typeOf(known)).length === 1;
				const filler = attacks.filter(known => power(known) <= 40 && power(move) >= 45 && !alone(known))
					.sort((x, y) => power(x) - power(y));
				// A strong move of its own type (STAB) is worth more than weak
				// off-type coverage: Copperajah's Iron Head over Rock Smash.
				const calc = require('../calc');
				const found = calc.Generations.get(8).species.get(calc.toID(current.species));
				const stab = found && found.types.includes(typeOf(move)) && power(move) >= 60;
				const offType = stab ? attacks.filter(known => !found.types.includes(typeOf(known)) &&
					power(known) < power(move) * 2 / 3).sort((x, y) => power(x) - power(y)) : [];
				// A move that does nothing the fight model or the policy uses —
				// Leer, Growl, Focus Energy — is the first to go for a FREE prompt.
				// The rules above only ever forgot attacks, so a body whose four
				// were two of these and two weak hits kept them for ever: the
				// Kubfu gift reached L99 as an Urshifu with Leer and Focus Energy,
				// and was offered Wicked Blow and Sucker Punch and took neither.
				// Only for the prompt, so the Heart Scale spend is unchanged.
				const inert = prompted.has(move) ? current.moves.filter(known => INERT_MOVES.has(known)) : [];
				replace = inert[0] || sameType[0] || filler[0] || offType[0] || null;
				if (!replace) continue;
			}
			try {
				doc = run.apply(doc, Object.assign({kind: 'teach', id: mon.id, move}, replace ? {replace} : {}));
				if (forgotten && replace) {
					if (!forgotten.has(mon.id)) forgotten.set(mon.id, new Set());
					forgotten.get(mon.id).add(replace);
				}
				tally.relearned = (tally.relearned || 0) + 1;
			} catch (error) { /* not learnable here; the next move is tried */ }
		}
	}
	return doc;
}

/**
 * The moves a double is fought with, in the order a player reaches for them:
 * the lead pressure, the guard, the speed control, the support. The advisor
 * ranks moves for a single battle, so a run reached Trainer Rival Bridge (a
 * double) with none of these and went 0 of 120 attempts, while its own box
 * could learn Fake Out, Wide Guard, Icy Wind and Tailwind.
 */
const DOUBLES_TOOLS = ['Fake Out', 'Wide Guard', 'Icy Wind', 'Protect', 'Helping Hand', 'Tailwind'];

/**
 * Teach the party its doubles tools before a double, at most TOOLS_PER_FIGHT
 * bodies changed, each giving up its weakest attack. Off unless
 * --doubles-prep=1; the run document charges the teach as always (a TM it
 * does not own, an egg move without a Heart Scale, are refused).
 */
function doublesPrep(doc, tally) {
	const TOOLS_PER_FIGHT = 2;
	const ai = require('../ai');
	const oracle = require('../profiles').getProfile(doc.profileId).oracle;
	const meta = name => {
		try { return ai.getMoveMetadata(name, 8); } catch (error) { return null; }
	};
	const power = name => {
		const found = meta(name);
		return !found || found.category === 'Status' ? 0 : (found.basePower || 0);
	};
	let taught = 0;
	// One of each tool is a team's worth: two Tailwinds are one Tailwind and a
	// lost attack.
	const already = new Set((doc.party || []).flatMap(id =>
		((doc.box.find(entry => entry.id === id) || {}).moves || []).filter(move => DOUBLES_TOOLS.includes(move))));
	for (const id of doc.party || []) {
		if (taught >= TOOLS_PER_FIGHT) break;
		const mon = doc.box.find(entry => entry.id === id);
		if (!mon || (mon.moves || []).some(move => DOUBLES_TOOLS.includes(move))) continue;
		const wanted = DOUBLES_TOOLS.find(move => {
			if (already.has(move)) return false;
			const verdict = oracle.canLearn(mon.species, move);
			return verdict && verdict.legal;
		});
		if (!wanted) continue;
		// The weakest attack goes, and never a priority move: Quick Attack is
		// worth more in a double than its 40 power says.
		const attacks = (mon.moves || []).filter(move => power(move) > 0 && !((meta(move) || {}).priority > 0))
			.sort((a, b) => power(a) - power(b));
		const replace = mon.moves.length >= 4 ? attacks[0] : null;
		if (mon.moves.length >= 4 && !replace) continue;
		try {
			doc = run.apply(doc, Object.assign({kind: 'teach', id: mon.id, move: wanted}, replace ? {replace} : {}));
			already.add(wanted);
			taught += 1;
			if (tally) tally.doublesTaught = (tally.doublesTaught || 0) + 1;
		} catch (error) { /* the run refuses what it cannot afford */ }
	}
	return doc;
}

/**
 * Spend Heart Scales on the party's worst IVs.
 *
 * One scale maxes one IV and three change a nature — the author's FAQ says so,
 * and the scales cannot be farmed. Runs spent every scale they found on
 * egg-move teaches instead (3 of 3 in the run traced) and maxed no IV at all,
 * though 26 scales are reachable by Archie at Seafloor Cavern, where the road
 * ends. Spending them there took his team from 5.42 survivors of six to 4.67.
 * Off unless --scale-ivs=1.
 */
/** Which stat each nature raises and lowers; a neutral nature is absent. */
const NATURE_EFFECT = {
	Lonely: ['atk', 'def'], Brave: ['atk', 'spe'], Adamant: ['atk', 'spa'], Naughty: ['atk', 'spd'],
	Bold: ['def', 'atk'], Relaxed: ['def', 'spe'], Impish: ['def', 'spa'], Lax: ['def', 'spd'],
	Timid: ['spe', 'atk'], Hasty: ['spe', 'def'], Jolly: ['spe', 'spa'], Naive: ['spe', 'spd'],
	Modest: ['spa', 'atk'], Mild: ['spa', 'def'], Quiet: ['spa', 'spe'], Rash: ['spa', 'spd'],
	Calm: ['spd', 'atk'], Gentle: ['spd', 'def'], Sassy: ['spd', 'spe'], Careful: ['spd', 'spa'],
};

/**
 * What a Heart Scale is worth on this body, in stat points it will USE.
 *
 * The nurse sells two things: one stat's IV to 31 for one scale, and a nature
 * for three (lib/run.js heartScale). The spender knew only the first and
 * bought the WORST iv in the six, so it could not tell a Sp. Atk IV on a
 * physical attacker from a Speed IV, and had never changed a nature — a Rash
 * Kingdra with a Sp. Def IV of 6 took 77% from a Tri Attack at Norman.
 *
 * A purchase is priced as the stat points it adds, weighted by whether the
 * body uses the stat: its attacking stat and Speed count in full, HP and the
 * two defences at half, an attacking stat no move uses at nothing. A nature
 * is priced against the nature it replaces, so undoing a harmful one counts
 * twice. Points per scale decide; the reserve stays in the bag. This is a
 * sizing rule, not a measured policy: nothing here has been shown to move a
 * wall, and the ceiling test at Norman says the whole lever is small.
 */
function scaleOptions(mon) {
	const calc = require('../calc');
	const ai = require('../ai');
	const found = calc.Generations.get(8).species.get(calc.toID(mon.species));
	if (!found || !mon.ivs) return [];
	const base = found.baseStats;
	const kinds = new Set((mon.moves || []).map(move => (ai.getMoveMetadata(move, 8) || {}).category));
	const weight = {hp: 0.5, def: 0.5, spd: 0.5, spe: 1,
		atk: kinds.has('Physical') ? 1 : 0, spa: kinds.has('Special') ? 1 : 0};
	const raw = (stat, iv) => stat === 'hp' ?
		Math.floor((2 * base.hp + iv) * mon.level / 100) + mon.level + 10 :
		Math.floor((2 * base[stat] + iv) * mon.level / 100) + 5;
	const effect = NATURE_EFFECT[mon.nature] || [null, null];
	const natured = (stat, points, pair) => stat === pair[0] ? points * 1.1 : stat === pair[1] ? points * 0.9 : points;
	const options = [];
	for (const stat of Object.keys(weight)) {
		const iv = mon.ivs[stat];
		if (typeof iv !== 'number' || iv >= 31 || !weight[stat]) continue;
		const gain = natured(stat, raw(stat, 31), effect) - natured(stat, raw(stat, iv), effect);
		options.push({kind: 'iv', stat, cost: 1, points: gain * weight[stat]});
	}
	for (const nature of Object.keys(NATURE_EFFECT)) {
		const pair = NATURE_EFFECT[nature];
		// Only a nature that lowers a stat the body does not use is a candidate.
		if (nature === mon.nature || weight[pair[1]] !== 0) continue;
		let gain = 0;
		for (const stat of ['atk', 'def', 'spa', 'spd', 'spe']) {
			const points = raw(stat, typeof mon.ivs[stat] === 'number' ? mon.ivs[stat] : 31);
			gain += (natured(stat, points, pair) - natured(stat, points, effect)) * weight[stat];
		}
		if (gain > 0) options.push({kind: 'nature', nature, cost: 3, points: gain});
	}
	return options.sort((a, b) => b.points / b.cost - a.points / a.cost);
}

function spendScales(doc, tally) {
	const SCALE = 'Heart Scale';
	let spent = 0;
	// A reserve stays in the bag. Remembering a move costs a scale at the
	// nurse, and the threshold prep's answer to a Focus Sash + Reversal lead is
	// a priority move the body usually has to REMEMBER. Seed 104770 reached
	// Aqua Admin Shelly with Accelerock, Sucker Punch and Quick Attack all one
	// scale away and none in the bag — every scale had gone to IVs — and her
	// Mienshao took exactly one body in each of twenty fights.
	for (let guard = 0; guard < 60; guard++) {
		const free = (doc.bag[SCALE] || 0) - knobs.scaleReserve;
		if (free <= 0) break;
		let best = null;
		for (const id of doc.party || []) {
			const mon = doc.box.find(entry => entry.id === id);
			if (!mon) continue;
			const option = scaleOptions(mon).find(entry => entry.cost <= free);
			if (option && (!best || option.points / option.cost > best.option.points / best.option.cost)) {
				best = {id: mon.id, option};
			}
		}
		if (!best) break;
		try {
			doc = run.apply(doc, best.option.kind === 'nature' ?
				{kind: 'heartScale', id: best.id, nature: best.option.nature} :
				{kind: 'heartScale', id: best.id, stat: best.option.stat});
			spent += best.option.cost;
			if (best.option.kind === 'nature' && tally) tally.natureChanges = (tally.natureChanges || 0) + 1;
		} catch (error) { break; }
	}
	if (tally && spent) tally.scaleSpends = (tally.scaleSpends || 0) + spent;
	return doc;
}

/**
 * The bodies whose held item a HELD plan placed (its record's `held`, as
 * Species@Item), so advice between attempts cannot hand them another:
 * planHolds kept the plan's six, and followAdvice still ran whenever the box
 * or bag changed, and its "Colbur Berry over Focus Sash" undid the Focus Sash
 * lead the planner had just taken by play at Champion Wallace.
 */
function plannedHolders(doc, tally) {
	const plans = (tally && tally.plans) || [];
	const last = plans[plans.length - 1];
	const keep = new Set();
	for (const label of (last && last.held) || []) {
		const at = label.lastIndexOf('@');
		const mon = doc.party.map(id => run.findMon(doc, id)).find(entry => entry && !keep.has(entry.id) &&
			entry.species === label.slice(0, at) && entry.item === label.slice(at + 1));
		if (mon) keep.add(mon.id);
	}
	return keep;
}

/**
 * Teach and (treatment) scale-spend from the same advice the panel shows.
 * `keep` (plannedHolders) names bodies whose item is not the advice's to change.
 */
function followAdvice(doc, treatment, tally, forgotten, keep) {
	// The marts first: a stone the bag holds is an evolve row the advisor
	// can price. One buy per row, receipts in the log.
	if (treatment.keyEvolve) {
		try {
			for (const item of run.shopItems(doc)) {
				if (item.bought || item.kind !== 'evolution') continue;
				doc = run.apply(doc, {kind: 'acquire', item: item.name, where: item.location});
				tally.stoneBuys = (tally.stoneBuys || 0) + 1;
			}
		} catch (error) { /* a refused buy is a skipped buy */ }
		doc = evolveByItem(doc, tally);
	}
	// Advice rows are applied best first; one the run refuses is remembered
	// and passed over, never allowed to end the sweep. The harness used to
	// parse a teach row as "learn X" — a format the advisor never wrote (its
	// rows read "Razor Leaf over Growl") — so no headless run ever taught a
	// move, and the first unparseable row abandoned the rest of the advice.
	const refused = new Set();
	for (let round = 0; round < 16; round++) {
		let advice;
		try {
			advice = run.adviseUpgrades(doc);
		} catch (error) {
			return doc;
		}
		const row = advice.upgrades.find(entry => !refused.has(entry.kind + '|' + entry.id + '|' + entry.detail) && (
			entry.kind === 'teach' ||
			(entry.kind === 'heartScale' && treatment.keyScales) ||
			(entry.kind === 'evolve' && treatment.keyEvolve) ||
			(entry.kind === 'give' && !(keep && keep.has(entry.id)))));
		if (!row) return doc;
		refused.add(row.kind + '|' + row.id + '|' + row.detail);
		try {
			doc = applyAdvice(doc, row, tally, forgotten);
		} catch (error) { /* refused: remembered, and the sweep moves on */ }
	}
	return fillEmptySlots(doc, tally);
}

/**
 * An empty held slot is waste, and the advisor cannot see it.
 *
 * adviseUpgrades prices a Give row by what it does to the damage board, so a
 * Sitrus Berry — worth a quarter of a body's health — never earns a row and
 * the slot stays empty. Every one of Norman's six holds an item; the legal
 * boxes that met him fielded two to six bodies holding nothing. After the
 * advice is spent, each member of the six still holding nothing takes the
 * best berry the bag has: Sitrus, then a cure for a status the next fight's
 * moves inflict, then Oran. --fill-slots=0 restores the empty slots.
 */
const CURES = {par: 'Cheri Berry', slp: 'Chesto Berry', psn: 'Pecha Berry', tox: 'Pecha Berry',
	brn: 'Rawst Berry', frz: 'Aspear Berry'};

/**
 * The run's one Mega, handed its stone.
 *
 * Ruling the-player-megas (operator, 2026-09-21): the Mega Ring comes with
 * beating Flannery, a fight holds ONE Mega, and the stone TAKES THE ITEM SLOT.
 * The harness had never used one — a run reached the Elite Four with about
 * twenty stones loose in the bag, thirteen of them for bodies in its box,
 * against bosses that have fielded a Mega since the third gym. The ranker now
 * rates a body whose stone is in the bag as the Mega it would become (holding
 * the stone, not its old item); this is the other half: once the six is
 * picked, the first member whose stone the bag holds is given it, over
 * whatever it held. Nobody is given a second. --mega=0 plays without.
 */
/**
 * WHICH body gets the run's one Mega, reconsidered for the fight in front.
 *
 * Two rules were wrong here. The stone went to the first member of the six in
 * PARTY ORDER, which asks nothing about the fight; and the whole step was
 * skipped the moment ANY member already held a stone, so the first assignment
 * a run ever made stuck for the rest of it — seed 418957 met Elite Four
 * Sidney fielding Mega Houndoom with a Lopunnite in the bag, because Houndoom
 * had been handed its stone hundreds of fights earlier. Four of twenty-one
 * records fielded a six with two or more Mega-capable bodies.
 *
 * The board already rates each body as the Mega it would become (boxMatrix
 * with megas:'each'), so: the candidate whose Mega form is worth most against
 * THIS six holds the stone. Worth is the sum of its positive margins on mean
 * rolls — the measure planByPlay ranks bodies by, so the two agree. A stone on
 * the wrong body is moved by giving that body a filler berry, which returns
 * the stone to the bag (run.js `give` swaps rather than destroys); with no
 * filler to hand the stone cannot be taken off, and the holder keeps it.
 *
 * Party order is the tiebreak and the fallback when the board cannot be read.
 * --mega-by-board=0 restores the old rule: party order, never reconsidered.
 */
function megaWorth(doc, trainer) {
	const board = run.boxMatrix(doc, trainer);
	const worth = new Map();
	for (const column of board.grid) {
		for (const cell of column.versus) {
			const kill = Math.ceil(1 / Math.max((cell.us.min + cell.us.max) / 2, 0.0001));
			const die = Math.ceil(1 / Math.max((cell.them.min + cell.them.max) / 2, 0.0001));
			const margin = die - kill + (cell.speed === 'faster' ? 0.5 : 0);
			worth.set(cell.species, (worth.get(cell.species) || 0) + Math.max(0, margin));
		}
	}
	return worth;
}

const MEGA_FILLERS = ['Oran Berry', 'Sitrus Berry', 'Lum Berry', 'Pecha Berry', 'Chesto Berry'];

/**
 * The operator's lead (--lead-for=TRAINER:SPECIES@ITEM), applied last before
 * the fight so no later step undoes it. The item is taken from whoever holds
 * it; a body not in the six replaces the last member that does not hold a
 * Mega Stone, so the run's one Mega is kept.
 *
 * A pin that cannot apply (the body is dead or absent, the item is nowhere
 * to be had) is MISSED, not thrown: it ran inside the fight's try, so a throw
 * was recorded as a crashed loss, spent an attempt, and burned every retry
 * until the run stopped at a "wall" it never fought. The policy's own lead
 * plays instead, and tally.leadPinMissed says why.
 */
function pinLead(doc, tally, next) {
	// A spec is a space-separated flag string, so a space in the value is written '+'.
	const pin = /^(.+):([^@]+)@(.+)$/.exec(String(knobs.leadFor || '').replace(/\+/g, ' '));
	if (!pin || pin[1] !== next.trainer) return doc;
	try {
		return applyPin(doc, tally, next.trainer, pin[2], pin[3]);
	} catch (error) {
		const reason = String(error && error.message).slice(0, 200);
		const missed = tally.leadPinMissed = tally.leadPinMissed || [];
		const same = missed.find(entry => entry.trainer === next.trainer && entry.reason === reason);
		if (same) same.times += 1;
		else missed.push({trainer: next.trainer, species: pin[2], item: pin[3], reason, times: 1});
		return doc;
	}
}

function applyPin(doc, tally, trainer, species, item) {
	const megaIn = at => at.party.map(id => run.findMon(at, id)).find(entry => entry && run.megaFormOf(entry.species, entry.item)) || null;
	const megaBefore = megaIn(doc);
	const mon = doc.box.find(entry => entry.status !== 'dead' && entry.species === species);
	if (!mon) throw new Error('the box has no living ' + species);
	if (mon.item !== item) {
		const holder = doc.box.find(entry => entry.item === item);
		if (!(doc.bag[item] > 0) && !holder) throw new Error('no ' + item + ' in the bag or on any body');
		if (holder && !doc.bag[item]) doc = run.apply(doc, {kind: 'take', id: holder.id});
		doc = run.apply(doc, {kind: 'give', id: mon.id, item});
	}
	let ids = doc.party.slice();
	if (!ids.includes(mon.id)) {
		// A Mega Stone by the dex, not by its spelling: /ite$/ also read an Eviolite as one.
		const megaStone = id => { const entry = run.findMon(doc, id); return !!(entry && run.megaFormOf(entry.species, entry.item)); };
		const out = ids.slice().reverse().find(id => !megaStone(id)) || ids[ids.length - 1];
		ids = ids.map(id => id === out ? mon.id : id);
	}
	ids = [mon.id].concat(ids.filter(id => id !== mon.id));
	if (ids.join() !== doc.party.join()) doc = run.apply(doc, {kind: 'party', ids});
	// The operator's hand wins over the run's one Mega, but not silently: pinning
	// the stone's holder to another item puts the stone back in the bag.
	if (megaBefore && !megaIn(doc)) {
		tally.leadPinDroppedMega = (tally.leadPinDroppedMega || []).concat([{trainer, species: megaBefore.species,
			stone: megaBefore.item, pinned: species + '@' + item}]);
	}
	tally.leadsPinned = (tally.leadsPinned || 0) + 1;
	return doc;
}

function giveMegaStone(doc, tally, next, wanted) {
	if (!knobs.mega || !run.megaRingHeld(doc)) return doc;
	const six = doc.party.map(id => doc.box.find(mon => mon.id === id)).filter(Boolean);
	const stoneOf = mon => (run.megaFormOf(mon.species, mon.item) ? mon.item : run.stoneInBag(doc, mon.species));
	const able = six.filter(mon => mon.status !== 'dead' && stoneOf(mon));
	if (!able.length) return doc;
	const holder = six.find(mon => run.megaFormOf(mon.species, mon.item)) || null;
	// The ranker chose this six AND the Mega it should field; that choice knows
	// what the rest of the six covers, which a body rated alone does not.
	const asked = wanted ? able.find(mon => mon.id === wanted) : null;
	if (knobs.megaByBoard && asked) {
		if (holder && holder.id === asked.id) return doc;
		tally.megaPicks = (tally.megaPicks || 0) + 1;
		return moveStoneTo(doc, tally, holder, asked);
	}
	// The old rule: the first in party order, and never touched once one holds a stone.
	if (!knobs.megaByBoard || able.length < 2 || !next || !next.trainer) {
		if (holder) return doc;
		return handStone(doc, tally, able);
	}
	let order = able;
	try {
		const worth = megaWorth(doc, next.trainer);
		const formOf = mon => {
			const mega = run.megaFormOf(mon.species, stoneOf(mon));
			return mega ? mega.species : mon.species;
		};
		const scored = able.map((mon, index) => ({mon, index, worth: worth.get(formOf(mon))}));
		if (scored.some(entry => entry.worth !== undefined)) {
			order = scored.sort((a, b) => (b.worth === undefined ? -1 : b.worth) - (a.worth === undefined ? -1 : a.worth) ||
				a.index - b.index).map(entry => entry.mon);
			tally.megaPicks = (tally.megaPicks || 0) + 1;
		}
	} catch (error) {
		if (holder) return doc;
		return handStone(doc, tally, able);
	}
	const want = order[0];
	if (holder && holder.id === want.id) return doc;
	return moveStoneTo(doc, tally, holder, want);
}

/** Put the stone on `want`, taking it off `holder` first — a filler frees it back to the bag. */
function moveStoneTo(doc, tally, holder, want) {
	if (holder && holder.id !== want.id) {
		const filler = MEGA_FILLERS.find(item => (doc.bag[item] || 0) > 0);
		if (!filler) return doc;
		try {
			doc = run.apply(doc, {kind: 'give', id: holder.id, item: filler});
			tally.gives = (tally.gives || 0) + 1;
			tally.megaMoved = (tally.megaMoved || 0) + 1;
		} catch (error) { return doc; }
	}
	const fresh = doc.box.find(mon => mon.id === want.id);
	return handStone(doc, tally, [fresh].filter(Boolean));
}

/** Give the first of these bodies the stone its species needs. */
function handStone(doc, tally, candidates) {
	for (const mon of candidates) {
		const stone = run.stoneInBag(doc, mon.species);
		if (!stone) continue;
		try {
			const kept = run.apply(doc, {kind: 'give', id: mon.id, item: stone});
			tally.gives = (tally.gives || 0) + 1;
			tally.megaStones = (tally.megaStones || 0) + 1;
			return kept;
		} catch (error) { /* refused: try the next body */ }
	}
	return doc;
}

function fillEmptySlots(doc, tally) {
	if (!knobs.fillSlots) return doc;
	const inflicted = new Set();
	try {
		const next = run.upcoming(doc, 1)[0];
		const fight = next ? require('../lib/planner').getFight(next.trainer, doc.profileId) : null;
		const ai = require('../ai');
		for (const foe of (fight && (fight.party || fight.mons)) || []) {
			for (const move of foe.moves || []) {
				const meta = ai.getMoveMetadata(move, 8) || {};
				const status = meta.status || (meta.secondary && meta.secondary.status) || null;
				if (status && CURES[status]) inflicted.add(CURES[status]);
			}
		}
	} catch (error) { /* an unreadable fight names no cure; Sitrus still goes on */ }
	const wanted = ['Sitrus Berry'].concat([...inflicted], ['Lum Berry', 'Oran Berry']);
	// A filler berry is a placeholder, not a choice: the first baseline under
	// this rule reached Norman with six Sitrus Berries in the bag and nobody
	// holding one, because every slot had been filled with a Chesto or a
	// Pecha before the Sitrus trees opened at 235, and a filled slot was
	// never looked at again. A body holding a berry from this list trades up
	// when a better one is in the bag; anything else it holds is left alone.
	const fillers = new Set(Object.values(CURES).concat(['Oran Berry', 'Lum Berry', 'Sitrus Berry']));
	for (const id of doc.party) {
		const mon = doc.box.find(entry => entry.id === id);
		if (!mon || mon.status === 'dead') continue;
		if (mon.item && !fillers.has(mon.item)) continue;
		const held = mon.item ? wanted.indexOf(mon.item) : wanted.length;
		const item = wanted.find((name, index) => (doc.bag[name] || 0) > 0 &&
			index < (held === -1 ? wanted.length : held));
		if (!item) continue;
		try {
			doc = run.apply(doc, {kind: 'give', id, item});
			tally.gives = (tally.gives || 0) + 1;
			tally.slotsFilled = (tally.slotsFilled || 0) + 1;
		} catch (error) { /* refused: the slot stays empty */ }
	}
	return doc;
}

/**
 * The threshold demand, acted on as the browser driver acts on it: when the
 * next fight holds a sash or pinch-berry Reversal/Flail/Endeavor set and the
 * party has no priority attack, teach the one preFightOpportunities names,
 * over the weakest attack. The harness never did — Aqua Admin Shelly's
 * sashed Mienshao Reversed a priority-less party 80 times out of 80.
 */
function thresholdPrep(doc, tally) {
	let prep;
	try {
		prep = run.preFightOpportunities(doc).thresholdPrep;
	} catch (error) {
		return doc;
	}
	if (!prep || !prep.threats.length || prep.covered) return doc;
	const ai = require('../ai');
	const power = name => {
		try {
			return ai.getMoveMetadata(name, 8).basePower || 0;
		} catch (error) {
			return 0;
		}
	};
	for (const row of prep.teachable) {
		const mon = doc.box.find(entry => entry.id === row.id);
		if (!mon) continue;
		const weakest = mon.moves.length >= 4 ? mon.moves.slice().sort((a, b) => power(a) - power(b))[0] : null;
		try {
			const next = run.apply(doc, Object.assign({kind: 'teach', id: row.id, move: row.move},
				weakest ? {replace: weakest} : {}));
			tally.thresholdTeaches = (tally.thresholdTeaches || 0) + 1;
			return next;
		} catch (error) { /* this one cannot; try the next body */ }
	}
	return doc;
}

/** One advice row as the run command the panel would post. */
function applyAdvice(doc, row, tally, forgotten) {
	if (row.kind === 'teach') {
		const pair = /^(.+?)(?: over (.+?))?(?: \(|$)/.exec(row.detail || '');
		if (!pair) throw new Error('teach row not understood: ' + row.detail);
		const move = pair[1].trim();
		const replace = pair[2] ? pair[2].trim() : null;
		// The advisor and the relearn rule were fighting each other all game:
		// Icy Wind over Air Cutter, then Air Cutter over Icy Wind, for ever.
		// One memory, consulted by both.
		const gaveUp = forgotten && forgotten.get(row.id);
		if (gaveUp && gaveUp.has(move)) throw new Error('teach: ' + move + ' is a move this body gave up');
		const next = run.apply(doc, Object.assign({kind: 'teach', id: row.id, move},
			replace ? {replace} : {}));
		if (forgotten && replace) {
			if (!forgotten.has(row.id)) forgotten.set(row.id, new Set());
			forgotten.get(row.id).add(replace);
		}
		tally.teaches = (tally.teaches || 0) + 1;
		return next;
	}
	if (row.kind === 'evolve') {
		tally.evolves = (tally.evolves || 0) + 1;
		return run.apply(doc, {kind: 'evolve', id: row.id});
	}
	if (row.kind === 'give') {
		// The published row names the item only in its detail ("Miracle Seed",
		// "Soft Sand over Oran Berry"); the harness required an `item` field
		// the row never carries, so no headless run ever held an item.
		const item = row.item || (/^(.+?)(?: over .+)?$/.exec(row.detail || '') || [])[1];
		if (!item) throw new Error('give row not understood: ' + row.detail);
		const next = run.apply(doc, {kind: 'give', id: row.id, item: item.trim()});
		tally.gives = (tally.gives || 0) + 1;
		return next;
	}
	const stat = /^(HP|Attack|Defense|Sp\. Atk|Sp\. Def|Speed) IV/.exec(row.detail);
	if (!stat) throw new Error('scale row not understood: ' + row.detail);
	const statKeys = {HP: 'hp', Attack: 'atk', Defense: 'def', 'Sp. Atk': 'spa', 'Sp. Def': 'spd', Speed: 'spe'};
	tally.scaleSpends += 1;
	return run.apply(doc, {kind: 'heartScale', id: row.id, stat: statKeys[stat[1]]});
}

/**
 * The six the ranker picks, and the ONE body it wants to field as a Mega.
 *
 * The ranker chooses that with the six (lib/run.js scoreSix): it knows what
 * the rest of the six already covers, which a body rated alone cannot. The
 * two disagree in practice — at Elite Four Sidney the standalone board rates
 * Houndoom-Mega above Lopunny-Mega, and the set score wants Lopunny, because
 * what the six lacks is what Lopunny covers. So the ranker's choice is the
 * authority when there is one, and `wants` carries it to giveMegaStone
 * rather than paying eight seconds to ask the ranker again every fight.
 */
function bestParty(doc, wants) {
	// The board-ranked six against the actual next fight — the same ranker
	// the browser driver plays with (--party=matrix class), with a
	// level-sorted fallback when the ranker refuses (tiny box, over-large
	// combination count).
	try {
		const ranked = run.rankParties(doc);
		const top = (ranked.parties || [])[0];
		if (top && top.members.length) {
			if (wants) wants.mega = top.mega ? top.mega.id : null;
			const ids = top.members.map(member => member.id);
			if (top.lead) {
				ids.splice(ids.indexOf(top.lead), 1);
				ids.unshift(top.lead);
			}
			return run.apply(doc, {kind: 'party', ids});
		}
	} catch (error) { /* fall through to the level sort */ }
	const alive = doc.box.filter(mon => mon.status !== 'dead')
		.slice().sort((a, b) => b.level - a.level);
	const picks = alive.slice(0, 6).map(mon => mon.id);
	try {
		return run.apply(doc, {kind: 'party', ids: picks});
	} catch (error) {
		return doc;
	}
}

/** Wins in N decide() fights in the run's head on probe seeds: no body is spent. */
function scoutWins(policy, doc, trainer, n, tally) {
	let wins = 0;
	for (let offset = 1; offset <= n; offset++) {
		try {
			if (battery.playScenario(policy, doc, trainer, PROBE_SEED_BASE + offset).result === 'win') wins++;
		} catch (error) { /* a crashed scout is not a win */ }
	}
	if (tally) scouted(tally, 'probe', n);
	return wins;
}

/**
 * What the preparation between attempts keys on: the box, the living, the bag
 * and the position. The living count is in it because under permadeath a death
 * changes who can be fielded and nothing else here. One definition: the plan
 * writes it too, and a second copy of the formula had drifted from the first.
 */
function shapeOf(doc) {
	return doc.box.length + '|' + doc.box.filter(mon => mon.status !== 'dead').length + '|' +
		JSON.stringify(doc.bag) + '|' + doc.position;
}

/** A fresh run under the project's rules, the starter caught and fielded. */
function startRun(starter, random) {
	// The project's own rules: 153 of the 155 banked runs play one encounter
	// per route, the dupes clause by line, level caps, no permadeath. The
	// harness had the dupes clause off, spending encounters on lines the box
	// already held.
	let doc = run.createRun({name: 'headless', now: 't0',
		levelCap: 'next-milestone-ace', permadeath: knobs.nuzlocke, onePerRoute: true,
		dupesClause: 'line', rival: starter.rival});
	const identity = run.rollIdentity(starter.species, random, {perfectIvs: 3});
	doc = run.apply(doc, Object.assign(
		{kind: 'catch', species: starter.species, level: 5,
			nickname: nicknames.nicknameFor(starter.species, 0, [])}, identity));
	doc = run.apply(doc, {kind: 'party', ids: [doc.box[0].id]});
	return doc;
}

/** The fight to play: the road's first, less an owed fight still waiting
 * at the cap it was put off under. */
function nextFight(doc, waiting, aside) {
	const capNow = run.levelCap(doc).cap;
	return run.upcoming(doc, 1000).find(fight => waiting.get(fight.order) !== capNow &&
		!(aside && aside.has(fight.order))) || null;
}

/**
 * THE OTHER DOOR. A run walled at one format of an Elite Four member takes the
 * other format instead of stopping.
 *
 * The road offers both formats of a member until one is beaten (lib/run.js
 * eliteFourClosed), but the run fights the first one offered, and at the retry
 * cap it tried to SKIP it — which the rules refuse, the Four being required —
 * and stopped. Seed 418957, the deepest run there has been, did that twice at
 * Elite Four Sidney: 0 of 40 at his single both times, and never once tried
 * his double, a different team entirely (Darkrai, Galarian Articuno and
 * Incineroar in place of Yveltal and Nidoking). Played against the same box,
 * the single went 0 of 20 more and the double 1 of 20: at 5% an attempt forty
 * retries clear a wall 87% of the time, at 0% never.
 *
 * So at the cap, if the member's other format is still on the road — its
 * format's quota not spent — this format is set aside and the other is fought.
 * The document is not touched: the Four are chosen by fighting, and a format
 * set aside is simply never beaten, which `upcoming` retires once its member
 * falls the other way. Both formats walled is a wall, and the run stops.
 */
function otherDoor(doc, next, aside) {
	const counterpart = run.eliteFourCounterpart(next.trainer);
	if (!counterpart) return null;
	return run.upcoming(doc, 1000).find(fight => fight.trainer === counterpart && !aside.has(fight.order)) || null;
}

/**
 * What a result was produced by: the revision, whether the tree was clean,
 * and every --flag on argv. A run that cannot say which code played it
 * cannot be reviewed, replayed, or repaired (scripts/audit-run.js).
 */
function provenance() {
	const git = args => {
		const out = require('node:child_process').spawnSync('git', args, {cwd: process.cwd(), encoding: 'utf8'});
		return out.status === 0 ? out.stdout.trim() : null;
	};
	const status = git(['status', '--porcelain', '--untracked-files=no']);
	return {revision: git(['rev-parse', 'HEAD']), dirty: status === null ? null : status.length > 0,
		flags: process.argv.filter(arg => arg.startsWith('--')), date: new Date().toISOString(),
		// The engine that played it (lib/provenance.js): run-one.js stamps its rows,
		// and a row made by playRun anywhere else went unstamped.
		engine: require('../lib/provenance.js').currentStamp()};
}

/**
 * Where an attempt's fight goes. With a sidecar (options.fightLog, from
 * lib/fight-log.js) the fight is written to disk the moment it ends and the
 * ledger row keeps only the line it landed on: constant memory, and a killed
 * run keeps every fight it finished. Without one — a test, a short probe —
 * the fight rides inline on the row as before.
 */
function keptFight(keptLog, played, doc, sink, header) {
	if (!keptLog) return {};
	const six = doc.party.map(id => doc.box.find(mon => mon.id === id)).filter(Boolean)
		.map(mon => ({name: mon.nickname || mon.species, species: mon.species, level: mon.level,
			item: mon.item || null, ability: mon.ability || null, nature: mon.nature || null,
			moves: mon.moves.slice()}));
	const fight = Object.assign({}, keptLog.length ? {log: keptLog} : {},
		played.events ? {events: played.events} : {}, {six});
	if (!sink) return fight;
	return {logLine: sink.append(Object.assign({}, header, fight))};
}

/**
 * A cheap read of a wall before the run pays for it.
 *
 * Across 259 ledgers a boss either fell within about 25 attempts or never
 * fell in 60, and a wall that never falls costs about 45 minutes of search to
 * find that out. Where it was looked at (Brawly, Norman) the doomed box had
 * no one-on-one answer to most of the six and outsped almost nothing — which
 * a dozen hand-played fights show in a few seconds. This plays them on seeds
 * the run never uses and RECORDS the result on the first attempt's ledger
 * row. Nothing acts on it yet: whether it predicts a doomed wall is a claim
 * to be measured on the next baseline, not assumed. Singles only.
 */
const PROBE_SEED_BASE = 900000;
/** Offsets from the fight seeds and the probe's: a plan is chosen on seeds no attempt is played on. */
const PLAN_SEED_BASE = 700000;

/**
 * HELD ITEMS, proposed by the board and chosen by play (--plan-items, off).
 *
 * The item is half of what a body is, and the planner varied only the other
 * half. At Champion Wallace a Focus Sash on the lead Dhelmise let Power Whip
 * take Primal Kyogre before Ice Beam could, and halved Kyogre's cost — but an
 * operator pinned it (--lead-for). These are the questions that hand asked,
 * put as plan candidates: each one is a single `give` on the plan in hand, and
 * play decides as it does for a body.
 *
 * The board only proposes, and few: every proposal costs planSeeds fights.
 *   - the lead, into their first: a Focus Sash when it kills in two or fewer
 *     and dies in two or fewer (one hit survived is the race); a Choice Scarf
 *     when it would win the race if it were faster; a Choice Band or Specs
 *     when half again the damage wins the race it loses.
 *   - the best of the six into their first and their last two: a gem of its
 *     hitting move's type, or the berry that halves their super-effective
 *     hit, when that one hit wins a race it loses.
 * An item comes from the bag, or from a body on the bench; `give` swaps and
 * `take` returns, so nothing is created or lost. A body holding a Mega Stone,
 * or whose stone is in the bag, is never touched: the run's one Mega stays
 * where giveMegaStone put it.
 */
const ITEM_PROPOSALS = 4;
const RESIST_BERRIES = {Normal: 'Chilan Berry', Fire: 'Occa Berry', Water: 'Passho Berry', Electric: 'Wacan Berry',
	Grass: 'Rindo Berry', Ice: 'Yache Berry', Fighting: 'Chople Berry', Poison: 'Kebia Berry', Ground: 'Shuca Berry',
	Flying: 'Coba Berry', Psychic: 'Payapa Berry', Bug: 'Tanga Berry', Rock: 'Charti Berry', Ghost: 'Kasib Berry',
	Dragon: 'Haban Berry', Dark: 'Colbur Berry', Steel: 'Babiri Berry', Fairy: 'Roseli Berry'};

/** Hits to take a whole bar at this share a hit. */
function hitsFor(share) {
	return Math.ceil(1 / Math.max(share, 0.0001));
}

/** Who wins a one-on-one: fewer hits needed, or as many and moving first. */
function winsRace(kill, die, faster) {
	return kill < die || (kill === die && faster);
}

/** Where a held item can come from: the bag (under the bag's own spelling), else a body on the bench. */
function itemSource(doc, item) {
	const lower = item.toLowerCase();
	const inBag = Object.keys(doc.bag || {}).find(name => name.toLowerCase() === lower && doc.bag[name] > 0);
	if (inBag) return {item: inBag};
	const holder = doc.box.find(mon => !doc.party.includes(mon.id) && mon.item && mon.item.toLowerCase() === lower);
	return holder ? {item: holder.item, from: holder.id} : null;
}

/** A body the item planner leaves alone: it holds a Mega Stone, or its stone is in the bag. */
function megaBound(doc, mon) {
	const stones = require('../calc').MEGA_STONES || {};
	return !!(mon.item && stones[mon.item]) || !!(knobs.mega && run.stoneInBag(doc, mon.species));
}

/**
 * The item changes worth playing on the plan in hand. `cells` is the board by
 * body id and foe index; `into` the planner's own margin.
 */
function itemProposals(planned, cells, into, foes) {
	const calc = require('../calc');
	const gen = calc.Generations.get(8);
	const out = [];
	const propose = (id, item, why) => {
		const mon = run.findMon(planned, id);
		if (!mon || megaBound(planned, mon)) return;
		if (mon.item && mon.item.toLowerCase() === item.toLowerCase()) return;
		if (out.some(entry => entry.id === id && entry.item === item)) return;
		if (!itemSource(planned, item)) return;
		out.push({kind: 'item', id, item, why});
	};
	const race = cell => ({kill: hitsFor((cell.us.min + cell.us.max) / 2), die: hitsFor((cell.them.min + cell.them.max) / 2),
		faster: cell.speed === 'faster'});
	const lead = planned.party[0];
	const leadCell = (cells.get(lead) || [])[0];
	if (leadCell) {
		const raced = race(leadCell);
		const kill = raced.kill;
		const die = raced.die;
		const faster = raced.faster;
		if (kill <= 2 && die <= 2) propose(lead, 'Focus Sash', 'lead survives one hit');
		if (!winsRace(kill, die, faster) && winsRace(kill, die, true)) propose(lead, 'Choice Scarf', 'lead wins the race moving first');
		const move = leadCell.us.move ? gen.moves.get(calc.toID(leadCell.us.move)) : null;
		if (move && move.category !== 'Status' && !winsRace(kill, die, faster) &&
			winsRace(hitsFor(1.5 * (leadCell.us.min + leadCell.us.max) / 2), die, faster)) {
			propose(lead, move.category === 'Special' ? 'Choice Specs' : 'Choice Band', 'lead one hit short');
		}
	}
	const targets = [...new Set([0, foes - 1, foes - 2].filter(index => index >= 0))];
	for (const index of targets) {
		const best = planned.party.slice().sort((a, b) => into(b, index) - into(a, index))[0];
		const cell = best !== undefined ? (cells.get(best) || [])[index] : null;
		if (!cell) continue;
		const raced = race(cell);
		const kill = raced.kill;
		const die = raced.die;
		const faster = raced.faster;
		if (winsRace(kill, die, faster)) continue;
		const ours = cell.us.move ? gen.moves.get(calc.toID(cell.us.move)) : null;
		if (ours && ours.category !== 'Status' && ours.type &&
			winsRace(hitsFor(1.5 * (cell.us.min + cell.us.max) / 2), die, faster)) {
			propose(best, ours.type + ' Gem', 'one hit short into foe ' + (index + 1));
		}
		const theirs = cell.them.move ? gen.moves.get(calc.toID(cell.them.move)) : null;
		const body = gen.species.get(calc.toID(cell.species));
		if (theirs && theirs.type && RESIST_BERRIES[theirs.type] && body) {
			const chart = gen.types.get(calc.toID(theirs.type));
			const factor = body.types.reduce((product, type) => product * ((chart && chart.effectiveness[type]) ?? 1), 1);
			const share = (cell.them.min + cell.them.max) / 2;
			// The berry halves the first hit only.
			const survived = Math.ceil(Math.max(1 - share / 2, 0) / Math.max(share, 0.0001)) + 1;
			if (factor > 1 && winsRace(kill, survived, faster)) {
				propose(best, RESIST_BERRIES[theirs.type], 'survives foe ' + (index + 1) + "'s hit");
			}
		}
	}
	return out.slice(0, ITEM_PROPOSALS);
}

/** The plan in hand with one body holding one more item; the item comes from the bag or the bench. */
function withItem(planned, change) {
	const mon = run.findMon(planned, change.id);
	if (!mon || !planned.party.includes(change.id) || megaBound(planned, mon)) return null;
	const source = itemSource(planned, change.item);
	if (!source) return null;
	try {
		let out = planned;
		if (source.from) out = run.apply(out, {kind: 'take', id: source.from});
		return run.apply(out, {kind: 'give', id: change.id, item: source.item});
	} catch (error) {
		return null;
	}
}

/**
 * A wall, PLANNED by play: who leads, who is held for the end, and who comes
 * in from the box to do it.
 *
 * The re-pick (--repick-after) chooses among the ranker's own sixes in the
 * ranker's own order, by wins alone — so at a wall, where every one of them
 * wins none, it is blind, and it never asks the questions a player asks.
 * Seed 842113 lost Norman 40 times, and 0 of 170 in every replay, with a six
 * that led its Mega Pidgeot answer into his first Pokemon. From the SAME box,
 * Infernape > Victreebel > Krookodile > Kingdra > Throh > Eelektross wins 13
 * of 40 on fresh seeds: a lead that breaks his first, a Storm Throw held for
 * Meloetta and Cinccino, the Electric type held for the Mega. Seed 731001
 * found that shape by luck of a re-pick and won; nothing looked for it.
 *
 * The board cannot find it alone. Its winner rule is our MINIMUM roll against
 * their MAXIMUM, so Throh into Cinccino (93-112% a hit, taking 42-52%) reads
 * as no answer; and each part measured nothing by itself (Infernape in: 0 of
 * 30; the closers held back: 0 of 30). So the board only PROPOSES, generously
 * — mean rolls, the three best into their first, the two best into each of
 * their last two — and play decides, greedily: every single change to the
 * plan in hand (a new lead; a closer put last or second to last; whoever is
 * weakest making room, the newcomer taught what the advisor would teach it)
 * plays `planSeeds` fights on decide(), the best one that beats the plan in
 * hand is taken, and that repeats up to three times. Most wins, then fewest
 * of theirs left standing — at a wall usually the only signal there is. The
 * six the run has is where it starts, so a plan is only ever taken when play
 * says it is better.
 */
function planByPlay(policy, doc, next, tally, options) {
	// A watched caller (lib/watch.js: rab-workspace's plan request, a run)
	// passes its job: each scouting fight goes on the job's live tape, and a
	// stop ends the scouting — the plans not yet played score as losses
	// without a fight, so the best plan found so far stands.
	const job = options && options.job;
	let scoutingStopped = false;
	let board;
	try {
		board = run.boxMatrix(doc, next.trainer);
	} catch (error) {
		return doc;
	}
	const foes = board.grid.length;
	if (!foes) return doc;
	const alive = doc.box.filter(mon => mon.status !== 'dead');
	// The board names a body by the form it would FIGHT in: a stone holder, or
	// a body whose stone is in the bag, is 'Camerupt-Mega'. The first cut looked
	// that name up in the box, found nothing, and gave every Mega no margin at
	// all — so no plan ever proposed one, on runs holding nine stones and dying
	// at Matt to a foe a Mega answers (418957 fielded a Mega in 36 of 88 wins;
	// the three seeds dead at Matt in 0, 1 and 2).
	const byBoardName = new Map();
	for (const mon of alive) {
		byBoardName.set(mon.species, mon.id);
		const stone = run.megaFormOf(mon.species, mon.item) ? mon.item : (knobs.mega ? run.stoneInBag(doc, mon.species) : null);
		const mega = stone ? run.megaFormOf(mon.species, stone) : null;
		if (mega) byBoardName.set(mega.species, mon.id);
	}
	const idOf = species => byBoardName.get(species);
	// How a body fares into each of theirs on MEAN rolls: turns it lives minus turns it needs.
	const margin = new Map();
	// The cells themselves, for the item proposals (--plan-items).
	const cells = new Map();
	board.grid.forEach((column, index) => {
		for (const cell of column.versus) {
			const id = idOf(cell.species);
			if (!id) continue;
			const cellRow = cells.get(id) || [];
			cellRow[index] = cell;
			cells.set(id, cellRow);
			const kill = Math.ceil(1 / Math.max((cell.us.min + cell.us.max) / 2, 0.0001));
			const die = Math.ceil(1 / Math.max((cell.them.min + cell.them.max) / 2, 0.0001));
			const row = margin.get(id) || [];
			row[index] = die - kill + (cell.speed === 'faster' ? 0.5 : 0);
			margin.set(id, row);
		}
	});
	const into = (id, index) => ((margin.get(id) || [])[index] === undefined ? -9 : margin.get(id)[index]);
	const worth = id => (margin.get(id) || []).reduce((sum, value) => sum + Math.max(0, value), 0);
	const bestInto = (index, count) => [...margin.keys()].sort((a, b) => into(b, index) - into(a, index)).slice(0, count);
	const changes = [];
	for (const id of bestInto(0, 3)) changes.push({id, slot: 0});
	for (const id of bestInto(foes - 1, 2)) changes.push({id, slot: 5});
	if (foes > 1) for (const id of bestInto(foes - 2, 2)) changes.push({id, slot: 4});
	const score = planned => {
		let wins = 0;
		let left = 0;
		let kept = 0;
		if (scoutingStopped) return {wins: -1, left: Infinity, kept: -1};
		for (let offset = 1; offset <= knobs.planSeeds; offset++) {
			let played;
			const watched = job ? job.fight({trainer: next.trainer, order: next.order, position: planned.position,
				seed: PLAN_SEED_BASE + offset, six: planned.party.map(id => planned.box.find(mon => mon.id === id)).filter(Boolean)
					.map(mon => ({name: mon.nickname || mon.species, species: mon.species, level: mon.level, item: mon.item || null}))}) : null;
			try {
				played = battery.playScenario(policy, planned, next.trainer, PLAN_SEED_BASE + offset, undefined, {search: 0});
			} catch (error) {
				// Still a loss for the plan, but counted: a planner whose every fight throws
				// looks exactly like one that found nothing better (the fpi arms, 2026-09-22).
				played = {result: 'loss', foe: {alive: foes}};
				tally.scoutErrors = (tally.scoutErrors || 0) + 1;
				tally.scoutError = tally.scoutError || String(error && error.message).slice(0, 200);
			}
			if (watched) {
				watched.end(played.result);
				job.progress({fights: job.scouted = (job.scouted || 0) + 1});
				if (job.stopRequested()) {
					scoutingStopped = true;
					tally.planStopped = true;
					return {wins: -1, left: Infinity, kept: -1};
				}
			}
			if (played.result === 'win') {
				wins += 1;
				kept += Math.max(0, planned.party.length - (played.deaths || 0));
			}
			left += (played.foe && played.foe.alive) || 0;
		}
		return {wins, left: left / knobs.planSeeds, kept: kept / knobs.planSeeds};
	};
	const better = (a, b) => knobs.planKeep ?
		a.kept > b.kept + 1e-9 || (Math.abs(a.kept - b.kept) <= 1e-9 &&
			(a.wins > b.wins || (a.wins === b.wins && a.left < b.left - 1e-9))) :
		a.wins > b.wins || (a.wins === b.wins && a.left < b.left - 1e-9);
	/** The plan in hand with one body put at one slot; someone makes room if it comes from the box. */
	const changed = (planned, change) => {
		if (change.kind === 'item') return withItem(planned, change);
		let ids = planned.party.slice();
		let out = planned;
		if (ids.indexOf(change.id) === change.slot) return null;
		if (!ids.includes(change.id)) {
			// The weakest on the board makes room — but never the body holding the slot being filled around.
			const weakest = ids.filter((id, at) => at !== 0 && at < 4).sort((x, y) => worth(x) - worth(y))[0];
			if (!weakest) return null;
			ids = ids.filter(id => id !== weakest);
			// A newcomer whose stone is in the bag comes in AS its Mega, if the six has
			// none: its margin was read that way, and the play must be too.
			const newcomer = run.findMon(planned, change.id);
			const stone = knobs.mega && run.megaRingHeld(planned) ? run.stoneInBag(planned, newcomer.species) : null;
			if (stone && !ids.some(id => { const mon = run.findMon(planned, id); return run.megaFormOf(mon.species, mon.item); })) {
				try { out = run.apply(out, {kind: 'give', id: change.id, item: stone}); } catch (error) { /* keeps what it holds */ }
			}
			try {
				out = battery.teachSwapped(Object.assign({}, out, {party: [change.id].concat(ids)}), next.trainer, change.id).doc;
			} catch (error) { return null; }
		} else {
			ids = ids.filter(id => id !== change.id);
		}
		ids.splice(Math.min(change.slot, ids.length), 0, change.id);
		try {
			return run.apply(out, {kind: 'party', ids});
		} catch (error) { return null; }
	};
	const name = planned => planned.party.map(id => run.findMon(planned, id).species).join(' > ');
	// With items planned, a plan is its six AND what they hold; without, the key is what it always was.
	const key = planned => JSON.stringify(knobs.planItems ?
		planned.party.map(id => id + '@' + (run.findMon(planned, id).item || '')) : planned.party);
	let hand = {doc, score: score(doc)};
	const stood = hand.score;
	const seen = new Set([key(doc)]);
	let tried = 1;
	const itemsProposed = [];
	for (let round = 0; round < 3; round++) {
		let best = null;
		// Item proposals are read off the plan in hand: its lead and its six change between rounds.
		const items = knobs.planItems ? itemProposals(hand.doc, cells, into, foes) : [];
		for (const change of items) {
			const label = run.findMon(hand.doc, change.id).species + '@' + change.item;
			if (!itemsProposed.includes(label)) itemsProposed.push(label);
		}
		for (const change of changes.concat(items)) {
			const planned = changed(hand.doc, change);
			if (!planned || seen.has(key(planned))) continue;
			seen.add(key(planned));
			tried += 1;
			const result = score(planned);
			if (better(result, hand.score) && (!best || better(result, best.score))) best = {doc: planned, score: result};
		}
		if (!best) break;
		hand = best;
	}
	scouted(tally, 'plan', tried * knobs.planSeeds);
	tally.plans = (tally.plans || []).concat([Object.assign({trainer: next.trainer, of: tried, took: name(hand.doc),
		// Who the board proposed, in the form it would fight in: what the plan chose among.
		proposed: [...new Set(changes.map(change => { const mon = run.findMon(doc, change.id); const mega = run.megaFormOf(mon.species, mon.item) || (knobs.mega && run.stoneInBag(doc, mon.species) ? run.megaFormOf(mon.species, run.stoneInBag(doc, mon.species)) : null); return mega ? mega.species : mon.species; }))],
		wins: hand.score.wins, left: Number(hand.score.left.toFixed(2)), kept: Number((hand.score.kept || 0).toFixed(2)),
		stood: {wins: stood.wins, left: Number(stood.left.toFixed(2)), kept: Number((stood.kept || 0).toFixed(2))}},
	// What the item planner proposed, and what the plan taken holds that the six did not.
	knobs.planItems ? {items: itemsProposed, held: hand.doc.party.map(id => {
		const now = run.findMon(hand.doc, id).item || null;
		const before = run.findMon(doc, id).item || null;
		return now !== before ? run.findMon(hand.doc, id).species + '@' + now : null;
	}).filter(Boolean)} : {})]);
	return hand.doc;
}

/**
 * AN ATTEMPT is a fight played for keeps: on the run's own dice, one ledger
 * row, counted in `fights` and against the retry cap. SCOUTING is a fight
 * played in the run's head — a probe, a re-pick, a plan — on dice the real
 * attempt will never get (PROBE_SEED_BASE, SELECTION_SEED_BASE,
 * PLAN_SEED_BASE), so it is thinking, not peeking. But it is not free, and
 * "cleared Matt in 6 attempts" was standing on some 230 of them that no
 * record showed. They are counted here, by kind, and carried on the row.
 */
function scouted(tally, kind, fights) {
	tally.scouted = tally.scouted || {probe: 0, repick: 0, plan: 0};
	tally.scouted[kind] = (tally.scouted[kind] || 0) + fights;
}

function probeWall(policy, doc, next, tally) {
	if (!knobs.probe || next.isDouble || !BOSS.test(next.trainer)) return null;
	if (tally) scouted(tally, 'probe', knobs.probe);
	let wins = 0;
	let left = 0;
	for (let offset = 1; offset <= knobs.probe; offset++) {
		let played;
		try {
			played = battery.playScenario(policy, doc, next.trainer, PROBE_SEED_BASE + offset);
		} catch (error) {
			// A probe that crashes has found an engine defect, and must say so:
			// swallowing it hid an injected crash from the suite's own gate.
			return {crashed: String(error && error.message).slice(0, 200), of: knobs.probe};
		}
		if (played.result === 'win') wins += 1;
		left += (played.foe && played.foe.alive) || 0;
	}
	return {wins, of: knobs.probe, foeLeft: Number((left / knobs.probe).toFixed(2))};
}

/**
 * The hand a run plays with: its knobs and treatment, less the ones that only
 * say how long it plays or what it keeps. A carry-on that only raises the
 * budget or the stop is the same hand; one with another --spec is not.
 */
const NOT_THE_HAND = ['budget', 'stopAt', 'fightLogs'];
function handOf(treatment) {
	const played = Object.fromEntries(Object.keys(knobs).filter(name => !NOT_THE_HAND.includes(name)).sort()
		.map(name => [name, knobs[name] === undefined ? null : knobs[name]]));
	const given = treatment || {};
	return JSON.stringify({knobs: played, keyCatches: given.keyCatches !== false, keyScales: given.keyScales !== false,
		keyEvolve: given.keyEvolve !== false});
}

/** Run fn under these knobs (armFlags(spec).knobs), and restore the run's own after. */
function withKnobs(given, fn) {
	const before = knobs;
	knobs = withDefaults(Object.assign({}, before, given));
	try {
		return fn();
	} finally {
		knobs = before;
	}
}

function playRun(policy, starter, seed, treatment, options) {
	// An arm's knobs hold for its run and no longer: two arms in one process
	// must not inherit each other's budget.
	const before = knobs;
	knobs = withDefaults(Object.assign({}, before, (treatment && treatment.knobs) || {}));
	if (treatment && treatment.knobs && treatment.knobs.bossRetries !== undefined &&
		treatment.knobs.doubleRetries === undefined) knobs.doubleRetries = knobs.bossRetries;
	try {
		const row = playRunWith(policy, starter, seed, treatment, options);
		row.knobs = Object.assign({}, knobs);
		if (options && options.resume) {
			row.resumedAt = options.resume.position;
			// Where the inherited log ends, so an audit can tell this run's own commands from the ones it was handed.
			row.resumedLog = (options.resume.log || []).length;
		}
		return row;
	} finally {
		knobs = before;
	}
}

function playRunWith(policy, starter, seed, treatment, options) {
	// A run is judged against the game, so moves spend PP (--pp-model=0 plays
	// on infinite fuel, as every run before 2026-09-19 did). Infinite PP let
	// a Moody Smeargle stall Protect and Dark Void for 300 turns at Young
	// Couple Dez And Luke; with PP it runs dry and the fight ends.
	driver.setPPModel(flag('pp-model', '1') === '1');
	driver.setHidingForecast(flag('hiding-forecast', '0') === '1');
	driver.setRealSpeed(flag('real-speed', '1') === '1');
	driver.setChargeThreat(flag('charge-threat', '0') === '1');
	driver.setDoublesJoint(flag('doubles-joint', '1') === '1');
	// How wide the boss search stays after its first look.
	driver.setSearchWiden(Number(flag('search-widen', '0')));
	driver.setSearchKeep(knobs.searchKeep);
	driver.setSearchKeepWeight(knobs.searchKeepWeight);
	driver.setSearchHalving(knobs.searchHalving);
	driver.setSearchPath(knobs.searchPath);
	driver.setSearchLookahead(knobs.searchLookahead);
	driver.setEnemySwitchScoring(!!knobs.enemySwitchScoring);
	battery.setSwitchPlayed(!!knobs.switchPlayed);
	// options.restore is a CHECKPOINT (options.checkpoint wrote it): the
	// document and everything else the run holds — the dice's position, the
	// fight seed, the attempts at the wall in front of it, what was caught
	// where, the ledger so far. options.resume is only a document, and starts
	// all of that again: seed 731001 resumed at Brawly came back with the
	// ranker's six, not the one the run had re-picked. A restored run plays
	// what the uninterrupted one would have.
	const kept = options && options.restore ? options.restore.state : null;
	const random = dice(seed, kept ? kept.dice : undefined);
	// options.resume carries a run on from a saved document, so a run that
	// passed a wall an hour in does not replay that hour to find the next one.
	// The document's own log is what the audit replays, so a resumed run is
	// as auditable as a whole one; the row says where it picked up.
	let doc = kept ? structuredClone(options.restore.doc) :
		options && options.resume ? structuredClone(options.resume) : startRun(starter, random);
	// A document's rules are its own and travel verbatim: --nuzlocke on a document
	// played without permadeath would write faints that change nothing.
	if (knobs.nuzlocke && !doc.rules.permadeath) {
		throw new Error('--nuzlocke needs a document with permadeath; this one was played without it');
	}

	const tally = kept ? structuredClone(kept.tally) : {catches: 0, keyRolls: 0, scaleSpends: 0, pickups: 0,
		stoneBuys: 0, evolves: 0, gives: 0,
		trainers: {}, fights: 0, skipped: [], engineRefusals: 0,
		// Every attempt, in order: enough to find a fight and replay it on its
		// seed (battery.playScenario on the document at that position).
		ledger: []};
	const made = provenance();
	// Stat stages the calculator could not have indexed, repaired on the way
	// in: the clamp keeps the run alive, the count keeps the defect findable.
	const repairsAt = require('../ai').boostRepairs();
	const started = Date.now() - (kept ? kept.elapsedMs || 0 : 0);
	const caughtFrom = new Set(kept ? kept.caughtFrom : []);
	// An owed fight (a skipped double, Gavi) whose retries are spent waits
	// for the level cap to rise, as a player comes back to it with a stronger
	// box; the road goes on meanwhile. It stopped runs instead: the debt sorts
	// first once passed, and a second skip of it is refused (sweep 10: three
	// of the five deepest runs ended "already being skipped").
	const waiting = new Map(kept ? kept.waiting : []);
	// Elite Four formats set aside after walling a run: the other format of that member is fought instead.
	// Each is set aside UNDER A HAND (the knobs it walled with). A carry-on
	// under another hand is the point of carrying on with --spec, and it got
	// one attempt: the checkpoint held the single aside and the double at its
	// cap, so both formats read as walled. An entry set aside under another
	// hand, or under an unrecorded one (a checkpoint from before this), is
	// dropped, and the wall in front starts its attempts again.
	const hand = handOf(treatment);
	const asideUnder = new Map();
	const aside = new Set();
	let handChanged = !!(kept && kept.hand !== undefined && kept.hand !== hand);
	for (const entry of kept ? kept.aside || [] : []) {
		const order = typeof entry === 'number' ? entry : entry.order;
		const under = typeof entry === 'number' ? null : entry.hand;
		if (under === hand) {
			aside.add(order);
			asideUnder.set(order, under);
		} else {
			handChanged = true;
			tally.asideDropped = (tally.asideDropped || []).concat([{order, at: doc.position,
				why: under === null ? 'set aside under an unrecorded hand' : 'set aside under another hand'}]);
		}
	}
	// What each body has given up, so the relearn rule cannot swap two moves
	// back and forth for the whole run.
	const forgotten = new Map(kept ? kept.forgotten.map(entry => [entry[0], new Set(entry[1])]) : []);
	let attempts = kept && !handChanged ? kept.attempts : 0;
	let fightSeed = kept ? kept.fightSeed : seed;
	// Advice and party ranking are board-rebuild expensive; the browser
	// driver pays them occasionally, not per turn of the loop. They re-run
	// only when the box or bag actually changed — the first cut ran them
	// every cycle and a single run stretched toward twenty minutes.
	let lastShape = kept ? kept.lastShape : '';
	// The six the probe last judged, and what decide() won with it (--hand-by-probe).
	let handProbe = kept && !handChanged ? kept.handProbe : {six: null, wins: 0};
	// What the ranker last said this six should field as its Mega: its choice, not a body rated alone.
	const ranked = {mega: null};
	// A plan, once taken, holds until the wall falls: the ranker and the re-pick would only undo it.
	let planHolds = kept && !handChanged ? !!kept.planHolds : false;
	if (kept) tally.restoredAt = (tally.restoredAt || []).concat([doc.position]);
	// Everything above, as data: what options.checkpoint is handed at the top
	// of every turn of the loop, the one place where none of it is half-done.
	const snapshot = () => ({version: 1, seed, starter, position: doc.position, doc,
		state: {dice: random.at(), fightSeed, attempts, lastShape, handProbe, planHolds, hand,
			caughtFrom: [...caughtFrom], waiting: [...waiting], aside: [...aside].map(order => ({order, hand: asideUnder.get(order)})),
			forgotten: [...forgotten].map(entry => [entry[0], [...entry[1]]]),
			tally, elapsedMs: Date.now() - started}});

	while (tally.fights < knobs.budget) {
		// A run can be asked to stop (options.control) and is then left exactly
		// here, checkpointed, to be carried on later — with other knobs if wanted.
		const asked = options && options.control ? options.control() : null;
		if (options && options.checkpoint) options.checkpoint(snapshot, asked === 'stop');
		if (asked === 'stop') {
			tally.stopped = 'stopped by request';
			break;
		}
		if (Number.isFinite(knobs.stopAt) && doc.position >= knobs.stopAt) {
			tally.stopped = 'reached --stop-at=' + knobs.stopAt;
			break;
		}
		doc = sweepCatches(doc, caughtFrom, random, treatment, tally);
		doc = claimGifts(doc, random, tally);
		doc = claimPrizes(doc, random, tally, attempts);
		doc = sweepItems(doc, tally);
		const shape = shapeOf(doc);
		if (shape !== lastShape) {
			lastShape = shape;
			doc = levelToCap(doc, tally);
			doc = relearn(doc, policy, tally, forgotten);
			doc = followAdvice(doc, treatment, tally, forgotten, planHolds ? plannedHolders(doc, tally) : null);
			if (knobs.scaleIvs) doc = spendScales(doc, tally);
			doc = thresholdPrep(doc, tally);
			// A plan holds until its wall falls: a catch made between attempts re-ran
			// the ranker here and put its six back (842113's first Norman plan was
			// undone this way, and the second started again from nothing).
			if (!planHolds) doc = bestParty(doc, ranked);
		}
		const ahead = run.upcoming(doc, 1000);
		if (!ahead.length) break;
		const capNow = run.levelCap(doc).cap;
		const next = nextFight(doc, waiting, aside);
		if (!next) {
			tally.stopped = 'owed fights wait on a higher cap that never comes: ' +
				ahead.map(fight => fight.trainer).join(', ');
			break;
		}
		if (knobs.delayUntil > 0 && attempts === 0 &&
			(require('../profiles').getProfile(doc.profileId).delayableFights || []).includes(next.trainer)) {
			const scouts = 8;
			const wins = scoutWins(policy, doc, next.trainer, scouts, tally);
			tally.delayScouts = (tally.delayScouts || []).concat([{trainer: next.trainer, cap: capNow, wins, of: scouts}]);
			if (wins / scouts < knobs.delayUntil) {
				try {
					if (!(doc.skipped || []).includes(next.order)) doc = run.apply(doc, {kind: 'skip', trainer: next.trainer, for: 'a higher cap'});
					waiting.set(next.order, capNow);
					tally.skipped.push({trainer: next.trainer, why: 'scouted ' + wins + '/' + scouts + ' at cap ' + capNow + ': put off'});
					continue;
				} catch (error) { /* not skippable here: fight it */ }
			}
		}
		// Doubles are played (driver.playDoubles, both sides on the engine's
		// trainer AI) unless --skip-doubles=1 asks for the old behaviour.
		if (next.isDouble && knobs.skipDoubles) {
			try {
				doc = run.apply(doc, {kind: 'skip', trainer: next.trainer,
					for: 'doubles play is not modeled'});
				tally.skipped.push({trainer: next.trainer, why: 'double'});
				continue;
			} catch (error) { break; }
		}
		// A fight lost --repick-after times (default off) has its six chosen
		// by play (the battery's pick-by-play on decide(), ~10 s), and again
		// every six losses after: the ranker's first six may be the one six in
		// the box that cannot win it.
		const repickAfter = knobs.repickAfter;
		if (repickAfter > 0 && attempts >= repickAfter && (attempts - repickAfter) % 6 === 0 && !next.isDouble && !planHolds) {
			try {
				const picked = battery.prepareDocument(doc, next.trainer, policy);
				doc = picked.doc;
				tally.repicks = (tally.repicks || 0) + 1;
				const byPlay = (picked.repick || {}).byPlay;
				if (byPlay) scouted(tally, 'repick', byPlay.k * byPlay.seeds);
			} catch (error) { /* keep the six it has */ }
		}
		// A wall is PLANNED by play (--plan-after, default off): once, when it has
		// been lost that many times, and again every ten losses after.
		const planNow = knobs.planAfter > 0 && attempts >= knobs.planAfter && (attempts - knobs.planAfter) % 10 === 0;
		const planFirst = knobs.planFirst && attempts === 0 && BOSS.test(next.trainer);
		let planUnsafe = false;
		if (knobs.planUnsafe > 0 && attempts === 0 && !next.isDouble && !BOSS.test(next.trainer)) {
			const wins = scoutWins(policy, doc, next.trainer, 8, tally);
			planUnsafe = wins / 8 < knobs.planUnsafe;
			tally.unsafeScouts = (tally.unsafeScouts || []).concat([{trainer: next.trainer, wins, of: 8, planned: planUnsafe}]);
		}
		if ((planNow || planFirst || planUnsafe) && !next.isDouble) {
			doc = planByPlay(policy, doc, next, tally);
			planHolds = true;
			lastShape = shapeOf(doc);
		}
		// A fight lost twice is played by search from then on (--search-after,
		// default off): decide() has shown it cannot, and search costs about a
		// minute a fight, so it is spent only where it is needed.
		const searchAfter = knobs.searchAfter;
		let searching = (knobs.searchFirst && !next.isDouble) || (searchAfter > 0 && attempts >= searchAfter) ?
			{search: knobs.searchRollouts} : undefined;
		// Search is not the stronger hand on every box. Seed 731001 (clear1,
		// 2026-09-21) re-picked its six on Brawly's third attempt, and with it
		// decide() wins 12 of 30 — but the run had already gone over to search,
		// which lost 38 of 38 (and 0 of 16 replayed). So whenever the six
		// changes under a fight being searched, the probe is asked again, and a
		// six decide() can win with is played by decide().
		let reprobed = null;
		if (knobs.handByProbe && searching && !next.isDouble && knobs.probe) {
			const six = doc.party.join(',');
			if (handProbe.six !== six) {
				reprobed = probeWall(policy, doc, next, tally);
				handProbe = {six, wins: reprobed && reprobed.wins ? reprobed.wins : 0};
				if (reprobed) tally.reprobes = (tally.reprobes || 0) + 1;
			}
			if (handProbe.wins > 0) searching = undefined;
		}
		if (next.isDouble && knobs.doublesPrep) doc = doublesPrep(doc, tally);
		const probed = attempts === 0 ? probeWall(policy, doc, next, tally) : reprobed;
		// An engine crash is a lost fight, not a lost run. Sweep 14's deepest
		// run died at fight #271 after beating 410 of them, and its document
		// went with it: the state that crashed could not be replayed, so the
		// defect could not be found. The run now retries the fight and keeps
		// going, and the crash is written out with the document that met it.
		let played;
		let keptLog;
		let unkeptLive = null;
		let liveEnd = null;
		try {
			// The six may have been re-picked since the advice ran, and a body
			// that joined it afterwards arrives holding nothing.
			doc = giveMegaStone(doc, tally, next, ranked.mega);
			doc = fillEmptySlots(doc, tally);
			doc = pinLead(doc, tally, next);
			keptLog = knobs.fightLogs === 'all' || (knobs.fightLogs === 'bosses' &&
				(next.isDouble || BOSS.test(next.trainer))) ? [] : undefined;
			// A watched run reports EVERY fight as it happens, kept or not: the
			// tape is the hook both hands already push each turn onto.
			if (options && options.live) {
				const six = doc.party.map(id => doc.box.find(mon => mon.id === id)).filter(Boolean);
				const watched = require('../lib/fight-log.js').liveTape(options.live, {n: tally.fights + 1,
					trainer: next.trainer, order: next.order, attempt: attempts + 1, position: doc.position,
					// Where on the road this is, as a player counts it: the Nth trainer of how many.
					road: run.trainerIndexOf(doc, next.order), roadOf: run.trainerIndexOf(doc, ahead[ahead.length - 1].order),
					hand: !searching ? 'decide' : knobs.searchLookahead > 0 ? 'lookahead-' + knobs.searchLookahead : 'search-' + searching.search, runSeed: seed,
					six: six.map(mon => ({name: mon.nickname || mon.species, species: mon.species, level: mon.level, item: mon.item || null}))});
				liveEnd = watched.end;
				if (keptLog) { keptLog = watched; } else { unkeptLive = watched; }
			}
			played = battery.playScenario(policy, doc, next.trainer, ++fightSeed, keptLog || unkeptLive, searching);
			if (liveEnd) liveEnd(played.result);
			if (unkeptLive) keptLog = undefined;
		} catch (error) {
			tally.crashes = (tally.crashes || 0) + 1;
			const crash = {trainer: next.trainer, order: next.order, seed: fightSeed,
				message: String(error && error.message).slice(0, 300), stack: String(error && error.stack).slice(0, 2000)};
			tally.crashed = (tally.crashed || []).concat([crash]);
			if (options && options.onCrash) options.onCrash(crash, doc);
			played = {result: 'loss', turns: 0, deaths: 0, engineRefusals: 0, policy: 'crashed'};
		}
		tally.fights += 1;
		tally.engineRefusals += played.engineRefusals || 0;
		tally.ledger.push({n: tally.fights, order: next.order, trainer: next.trainer, seed: fightSeed,
			position: doc.position, result: played.result, policy: played.policy || (searching ? 'search' : 'decide'),
			refusals: played.engineRefusals || 0, turns: played.turns, deaths: played.deaths,
			...(probed ? {probe: probed} : {}),
			// The fight itself, not only its row: every turn, what was offered,
			// what the search thought of each option, and what happened.
			...keptFight(keptLog, played, doc, options && options.fightLog, {n: tally.fights, order: next.order,
				trainer: next.trainer, seed: fightSeed, result: played.result,
				policy: played.policy || (searching ? 'search' : 'decide'), runSeed: seed}),
			// What fell and to what: the driver knows the body, the move and
			// the enemy that used it, and the row kept only the count — so no
			// run could say which types die, or what kills them.
			killers: (played.killers || []).map(death => {
				const mon = death.monId ? doc.box.find(member => member.id === death.monId) : null;
				return {monId: death.monId || null,
					name: death.name || (mon ? (mon.nickname || mon.species) : null),
					species: death.species, by: death.by, of: death.of, ofSide: death.ofSide || null};
			}),
			// Who took what down. A body that only appears in the record on the
			// day it dies has no story; this is the rest of it.
			kos: (played.knockouts || []).map(kill => {
				const mine = kill.byMonId ? doc.box.find(member => member.id === kill.byMonId) : null;
				return {foe: kill.species, by: kill.by || null,
					monId: kill.byMonId || null,
					name: mine ? (mine.nickname || mine.species) : null};
			}),
			foeLeft: played.foe ? played.foe.alive : null, foeOf: played.foe ? played.foe.of : null});
		const t = tally.trainers[next.trainer] =
			tally.trainers[next.trainer] || {attempts: 0, wins: 0};
		t.attempts += 1;
		// What each win cost in bodies, in either mode: the least a permadeath run
		// would have paid for the same wins, had it won every fight first time.
		if (played.result === 'win') tally.winCost = (tally.winCost || 0) + (played.deaths || 0);
		if (knobs.nuzlocke && played.policy !== 'crashed') {
			const killers = played.killers || [];
			// A death with no body named would spare that body: the silent failure
			// permadeath exists to prevent. The run stops rather than play on.
			if (killers.length !== (played.deaths || 0) || killers.some(death => !death.monId)) {
				tally.stopped = next.trainer + ': a death the driver could not name to a body (' +
					killers.length + ' named, ' + (played.deaths || 0) + ' died)';
				break;
			}
			for (const death of killers) {
				const mon = doc.box.find(member => member.id === death.monId);
				doc = run.apply(doc, Object.assign({kind: 'faint', id: death.monId, to: next.trainer},
					death.by ? {move: death.by} : {}));
				tally.lost = (tally.lost || []).concat([{species: mon ? mon.species : death.species,
					name: mon ? (mon.nickname || mon.species) : null, to: next.trainer, order: next.order,
					move: death.by || null, result: played.result}]);
			}
			if (killers.length) planHolds = false;
			if (!doc.box.some(mon => mon.status !== 'dead')) {
				if (played.result === 'win') doc = run.apply(doc, {kind: 'beat', trainer: next.trainer});
				tally.stopped = 'every body is lost: the last fell to ' + next.trainer;
				break;
			}
			if (knobs.blackoutEnds && played.result !== 'win') {
				tally.stopped = 'blacked out at ' + next.trainer;
				break;
			}
		}
		if (options && options.log) {
			options.log(tally.fights + ' #' + (run.trainerIndexOf(doc, next.order) || '?') + ' ' + next.trainer +
				' ' + played.result + (played.policy ? ' (' + played.policy + ')' : '') +
				(played.engineRefusals ? ' REFUSALS ' + played.engineRefusals : ''));
		}
		if (played.result === 'win') {
			t.wins += 1;
			attempts = 0;
			handProbe = {six: null, wins: 0};
			planHolds = false;
			doc = run.apply(doc, {kind: 'beat', trainer: next.trainer});
			continue;
		}
		attempts += 1;
		// The browser driver's recovery: every third failed attempt reopens
		// the routes for more Pokemon — the box is what loses these fights,
		// not the dice.
		if (attempts % 3 === 0) caughtFrom.clear();
		const cap = retryCap(next.trainer, next.isDouble);
		if (attempts >= cap && (doc.skipped || []).includes(next.order)) {
			waiting.set(next.order, capNow);
			tally.skipped.push({trainer: next.trainer, why: 'owed, waits for the next cap'});
			attempts = 0;
		} else if (attempts >= cap && otherDoor(doc, next, aside)) {
			const door = otherDoor(doc, next, aside);
			aside.add(next.order);
			asideUnder.set(next.order, hand);
			tally.formatsSwitched = (tally.formatsSwitched || []).concat([{from: next.trainer, to: door.trainer, after: attempts}]);
			attempts = 0;
			handProbe = {six: null, wins: 0};
			planHolds = false;
		} else if (attempts >= cap) {
			try {
				doc = run.apply(doc, {kind: 'skip', trainer: next.trainer,
					for: 'a box that can afford them'});
				tally.skipped.push({trainer: next.trainer, why: 'retries spent'});
				waiting.set(next.order, capNow);
				attempts = 0;
			} catch (error) {
				tally.stopped = next.trainer + ': ' + error.message;
				break;
			}
		}
	}
	const gavi = tally.trainers['Camper Gavi'] || {attempts: 0, wins: 0};
	const brawly = tally.trainers['Leader Brawly'] || {attempts: 0, wins: 0};
	const row = {
		starter: starter.species, seed,
		position: doc.position,
		fight: doc.position > 0 ? (run.trainerIndexOf(doc, doc.position) || 0) : 0,
		gavi, brawly,
		catches: tally.catches, keyRolls: tally.keyRolls,
		scaleSpends: tally.scaleSpends, pickups: tally.pickups, fights: tally.fights,
		stoneBuys: tally.stoneBuys, evolves: tally.evolves, gives: tally.gives, teaches: tally.teaches || 0, doublesTaught: tally.doublesTaught || 0, levelUps: tally.levelUps || 0, relearned: tally.relearned || 0, repicks: tally.repicks || 0, reprobes: tally.reprobes || 0, plans: tally.plans || [],
		gifts: tally.gifts || 0, gifted: tally.gifted || [],
		...(tally.delayScouts ? {delayScouts: tally.delayScouts} : {}),
		...(tally.unsafeScouts ? {unsafeScouts: tally.unsafeScouts} : {}),
		// Elite Four formats given up on for the member's other format: {from, to, after}.
		formatsSwitched: tally.formatsSwitched || [],
		megaPicks: tally.megaPicks || 0, megaMoved: tally.megaMoved || 0,
		// An operator's --lead-for that could not apply, and why: the policy's lead played instead.
		...(tally.leadPinMissed ? {leadPinMissed: tally.leadPinMissed} : {}),
		...(tally.leadPinDroppedMega ? {leadPinDroppedMega: tally.leadPinDroppedMega} : {}),
		// Fights played in the run's head, by kind: never attempts, never free.
		scouted: tally.scouted || {probe: 0, repick: 0, plan: 0}, prizes: tally.prizes || 0,
		// What "beat the game" is judged on: the road finished, nothing skipped,
		// no win bought by an engine refusal.
		finished: run.upcoming(doc, 1).length === 0,
		skipped: tally.skipped, engineRefusals: tally.engineRefusals, stopped: tally.stopped || null,
		// Bodies: winCost in either mode (deaths in the winning attempts), and under
		// --nuzlocke every body written dead, in order, with what took it.
		winCost: tally.winCost || 0,
		// Read off the document, not the tally: a run carried on from its checkpoint
		// keeps every epitaph there, and only there.
		...(knobs.nuzlocke ? (() => {
			const dead = doc.box.filter(mon => mon.status === 'dead');
			return {permadeath: true, bodiesLost: dead.length, lost: dead.map(mon => Object.assign(
				{id: mon.id, species: mon.species, name: mon.nickname || mon.species}, mon.died || {}))};
		})() : {}),
		// Where a stopped run was carried on from its checkpoint, if it ever was.
		...(tally.restoredAt ? {restoredAt: tally.restoredAt} : {}),
		provenance: made, ledger: tally.ledger,
		crashes: tally.crashes || 0, crashed: tally.crashed || [],
		boostRepairs: require('../ai').boostRepairs() - repairsAt,
		seconds: Math.round((Date.now() - started) / 1000),
		// The document where the run ended, when asked for: a stall is a
		// battery scenario waiting to be written.
		...(options && options.keepDoc ? {doc} : {}),
		stalls: Object.keys(tally.trainers).filter(name => tally.trainers[name].attempts > 1)
			.map(name => ({trainer: name, attempts: tally.trainers[name].attempts,
				wins: tally.trainers[name].wins})),
	};
	// Every result that keeps its document arrives audited: the rules replayed,
	// one catch per area, removed species, the cap, and how each win was
	// bought (scripts/audit-run.js). A run beats the game only if this says so.
	if (options && options.keepDoc) row.audit = require('./audit-run.js').auditRun(row);
	return row;
}

function summarise(rows) {
	const n = rows.length;
	const sum = f => rows.reduce((a, r) => a + f(r), 0);
	return {
		runs: n,
		meanFight: n ? sum(r => r.fight) / n : 0,
		passedGavi: rows.filter(r => r.gavi.wins > 0).length,
		beatBrawly: rows.filter(r => r.brawly.wins > 0).length,
		gaviWon: sum(r => r.gavi.wins), gaviAttempts: sum(r => r.gavi.attempts),
		brawlyWon: sum(r => r.brawly.wins), brawlyAttempts: sum(r => r.brawly.attempts),
		keyRolls: sum(r => r.keyRolls), scaleSpends: sum(r => r.scaleSpends),
		stoneBuys: sum(r => r.stoneBuys || 0), evolves: sum(r => r.evolves || 0),
		gives: sum(r => r.gives || 0),
	};
}

function main() {
	const policy = require('./ui-playthrough.js');
	const pairs = Number(flag('pairs', '12'));
	const label = flag('label', 'headless');
	const arms = {A: armFlags(flag('a', '')), B: armFlags(flag('b', ''))};
	const rows = [];
	for (let k = 0; k < pairs; k++) {
		const starter = STARTERS[k % STARTERS.length];
		const seed = 1000 + k * 7919;
		// SEED-PAIRED: both arms replay the same dice; the treatment is the
		// only thing that can diverge them.
		for (const arm of ['A', 'B']) {
			const row = Object.assign({arm, index: k + 1},
				playRun(policy, starter, seed, arms[arm]));
			rows.push(row);
			console.log('  ' + arm + ' ' + (k + 1) + ' (' + row.starter + '): fight=' +
				row.fight + ' gavi=' + row.gavi.wins + '/' + row.gavi.attempts +
				' brawly=' + row.brawly.wins + '/' + row.brawly.attempts +
				' keyRolls=' + row.keyRolls + ' scales=' + row.scaleSpends +
				' stones=' + (row.stoneBuys || 0) + ' evolves=' + (row.evolves || 0) +
				' gives=' + (row.gives || 0));
		}
	}
	const a = summarise(rows.filter(r => r.arm === 'A'));
	const b = summarise(rows.filter(r => r.arm === 'B'));
	console.log('\n=== ' + label + ' (headless, seed-paired) ===');
	for (const pair of [['A', a], ['B', b]]) {
		const name = pair[0];
		const s = pair[1];
		console.log(name + '  runs=' + s.runs + '  meanFight=' + s.meanFight.toFixed(1) +
			'  passedGavi=' + s.passedGavi + '/' + s.runs +
			'  beatBrawly=' + s.beatBrawly + '/' + s.runs +
			'  gavi=' + s.gaviWon + '/' + s.gaviAttempts +
			'  brawly=' + s.brawlyWon + '/' + s.brawlyAttempts +
			'  keyRolls=' + s.keyRolls + '  scales=' + s.scaleSpends +
			'  stones=' + s.stoneBuys + '  evolves=' + s.evolves + '  gives=' + s.gives);
	}
	// Paired wins: per seed, which arm reached further.
	let bFurther = 0, aFurther = 0, even = 0;
	for (let k = 0; k < pairs; k++) {
		const pa = rows.find(r => r.arm === 'A' && r.index === k + 1);
		const pb = rows.find(r => r.arm === 'B' && r.index === k + 1);
		if (pb.fight > pa.fight) bFurther++;
		else if (pa.fight > pb.fight) aFurther++;
		else even++;
	}
	console.log('paired reach: B further ' + bFurther + ', A further ' + aFurther +
		', even ' + even);
	fs.writeFileSync('ui-playthrough-out/' + label + '-headless.json',
		JSON.stringify({label, instrument: 'headless-run', seedPaired: true,
			arms: {A: flag('a', ''), B: flag('b', '')}, rows,
			summary: {A: a, B: b},
			paired: {bFurther, aFurther, even}}, null, '\t'));
	console.log('wrote ui-playthrough-out/' + label + '-headless.json');
}

if (require.main === module) main();

module.exports = {plannedHolders, pinLead, withKnobs, planByPlay, withItem, claimGifts, playRun, startRun, nextFight, otherDoor, provenance, doublesPrep, retryCap, methodFor, answersAhead, spendScales, dice, armFlags, followAdvice, levelToCap, thresholdPrep, claimPrizes, sweepCatches, sweepItems, pickBerries, fillEmptySlots, giveMegaStone, relearn, evolveByItem, scaleOptions};
