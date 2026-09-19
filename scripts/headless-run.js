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

function flag(name, fallback) {
	const hit = process.argv.find(arg => arg.startsWith('--' + name + '='));
	return hit ? hit.split('=').slice(1).join('=') : fallback;
}

/** Deterministic dice: one stream per run, seeded, no Math.random anywhere. */
function dice(seed) {
	let state = seed % 2147483647;
	if (state <= 0) state += 2147483646;
	return () => (state = (state * 48271) % 2147483647) / 2147483647;
}

const STARTERS = [
	{species: 'Turtwig', rival: 'Blaziken'},
	{species: 'Chimchar', rival: 'Swampert'},
	{species: 'Piplup', rival: 'Sceptile'},
];
// Attempts at one fight before a delayable fight is skipped or the run
// stops. Retrying is allowed on this rung (no permadeath); the cost is
// counted in fights, the efficiency measure.
const RETRIES = Number(flag('retries', '12'));
const BOSS_RETRIES = Number(flag('boss-retries', '20'));
const FIGHT_BUDGET = Number(flag('budget', '110'));
const SKIP_DOUBLES = flag('skip-doubles', '0') === '1';
const BOSS = /Leader|Elite|Champion|Rival|Admin|Chelle|Wally|Soupercell/i;

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
	};
}

function catchRolled(doc, map, random) {
	const rolled = run.rollEncounter(doc, {map, random});
	return run.apply(doc, {kind: 'catch', map, species: rolled.species,
		level: rolled.level, ivs: rolled.ivs, nature: rolled.nature,
		ability: rolled.ability});
}

/**
 * One catching sweep: at most one roll per still-open area, new ground
 * first. The treatment reorders by the SAME data the browser scout renders
 * — adviseCatches' keyAnswer areas for the split boss.
 */
function sweepCatches(doc, caughtFrom, random, treatment, tally) {
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
	for (const route of routes) {
		if (doc.box.length >= 24) break;
		caughtFrom.add(route.name);
		try {
			doc = catchRolled(doc, route.name, random);
			tally.catches += 1;
		} catch (error) { /* a refused roll spends nothing */ }
	}
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
				tally.pickups += 1;
			} catch (error) { /* a refused acquire takes nothing */ }
		}
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
	for (const mon of doc.box) {
		if (mon.status === 'dead' || mon.level >= cap) continue;
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
function evolveByLevel(doc, tally) {
	const dossier = require('../lib/dossier');
	const evolutions = require('../profiles/run-and-bun/oracle/evolutions.json');
	for (const mon of doc.box) {
		if (mon.status === 'dead') continue;
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

/** Teach and (treatment) scale-spend from the same advice the panel shows. */
function followAdvice(doc, treatment, tally) {
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
			entry.kind === 'give'));
		if (!row) return doc;
		refused.add(row.kind + '|' + row.id + '|' + row.detail);
		try {
			doc = applyAdvice(doc, row, tally);
		} catch (error) { /* refused: remembered, and the sweep moves on */ }
	}
	return doc;
}

/** One advice row as the run command the panel would post. */
function applyAdvice(doc, row, tally) {
	if (row.kind === 'teach') {
		const pair = /^(.+?)(?: over (.+?))?(?: \(|$)/.exec(row.detail || '');
		if (!pair) throw new Error('teach row not understood: ' + row.detail);
		const next = run.apply(doc, Object.assign({kind: 'teach', id: row.id, move: pair[1].trim()},
			pair[2] ? {replace: pair[2].trim()} : {}));
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

function bestParty(doc) {
	// The board-ranked six against the actual next fight — the same ranker
	// the browser driver plays with (--party=matrix class), with a
	// level-sorted fallback when the ranker refuses (tiny box, over-large
	// combination count).
	try {
		const ranked = run.rankParties(doc);
		const top = (ranked.parties || [])[0];
		if (top && top.members.length) {
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

/** A fresh run under the project's rules, the starter caught and fielded. */
function startRun(starter, random) {
	// The project's own rules: 153 of the 155 banked runs play one encounter
	// per route, the dupes clause by line, level caps, no permadeath. The
	// harness had the dupes clause off, spending encounters on lines the box
	// already held.
	let doc = run.createRun({name: 'headless', now: 't0',
		levelCap: 'next-milestone-ace', permadeath: false, onePerRoute: true,
		dupesClause: 'line', rival: starter.rival});
	const identity = run.rollIdentity(starter.species, random, {perfectIvs: 3});
	doc = run.apply(doc, Object.assign(
		{kind: 'catch', species: starter.species, level: 5}, identity));
	doc = run.apply(doc, {kind: 'party', ids: [doc.box[0].id]});
	return doc;
}

function playRun(policy, starter, seed, treatment, options) {
	const random = dice(seed);
	let doc = startRun(starter, random);

	const tally = {catches: 0, keyRolls: 0, scaleSpends: 0, pickups: 0,
		stoneBuys: 0, evolves: 0, gives: 0,
		trainers: {}, fights: 0, skipped: [], engineRefusals: 0};
	const started = Date.now();
	const caughtFrom = new Set();
	let attempts = 0;
	let fightSeed = seed;
	// Advice and party ranking are board-rebuild expensive; the browser
	// driver pays them occasionally, not per turn of the loop. They re-run
	// only when the box or bag actually changed — the first cut ran them
	// every cycle and a single run stretched toward twenty minutes.
	let lastShape = '';

	while (tally.fights < FIGHT_BUDGET) {
		doc = sweepCatches(doc, caughtFrom, random, treatment, tally);
		doc = sweepItems(doc, tally);
		const shape = doc.box.length + '|' + JSON.stringify(doc.bag) + '|' + doc.position;
		if (shape !== lastShape) {
			lastShape = shape;
			doc = levelToCap(doc, tally);
			doc = followAdvice(doc, treatment, tally);
			doc = bestParty(doc);
		}
		const ahead = run.upcoming(doc, 1);
		if (!ahead.length) break;
		const next = ahead[0];
		// Doubles are played (driver.playDoubles, both sides on the engine's
		// trainer AI) unless --skip-doubles=1 asks for the old behaviour.
		if (next.isDouble && SKIP_DOUBLES) {
			try {
				doc = run.apply(doc, {kind: 'skip', trainer: next.trainer,
					for: 'doubles play is not modeled'});
				tally.skipped.push({trainer: next.trainer, why: 'double'});
				continue;
			} catch (error) { break; }
		}
		const played = battery.playScenario(policy, doc, next.trainer, ++fightSeed);
		tally.fights += 1;
		tally.engineRefusals += played.engineRefusals || 0;
		const t = tally.trainers[next.trainer] =
			tally.trainers[next.trainer] || {attempts: 0, wins: 0};
		t.attempts += 1;
		if (options && options.log) {
			options.log(tally.fights + ' #' + (run.trainerIndexOf(doc, next.order) || '?') + ' ' + next.trainer +
				' ' + played.result + (played.policy ? ' (' + played.policy + ')' : '') +
				(played.engineRefusals ? ' REFUSALS ' + played.engineRefusals : ''));
		}
		if (played.result === 'win') {
			t.wins += 1;
			attempts = 0;
			doc = run.apply(doc, {kind: 'beat', trainer: next.trainer});
			continue;
		}
		attempts += 1;
		// The browser driver's recovery: every third failed attempt reopens
		// the routes for more Pokemon — the box is what loses these fights,
		// not the dice.
		if (attempts % 3 === 0) caughtFrom.clear();
		const cap = BOSS.test(next.trainer) ? BOSS_RETRIES : RETRIES;
		if (attempts >= cap) {
			try {
				doc = run.apply(doc, {kind: 'skip', trainer: next.trainer,
					for: 'a box that can afford them'});
				tally.skipped.push({trainer: next.trainer, why: 'retries spent'});
				attempts = 0;
			} catch (error) {
				tally.stopped = next.trainer + ': ' + error.message;
				break;
			}
		}
	}
	const gavi = tally.trainers['Camper Gavi'] || {attempts: 0, wins: 0};
	const brawly = tally.trainers['Leader Brawly'] || {attempts: 0, wins: 0};
	return {
		starter: starter.species, seed,
		position: doc.position,
		fight: doc.position > 0 ? (run.trainerIndexOf(doc, doc.position) || 0) : 0,
		gavi, brawly,
		catches: tally.catches, keyRolls: tally.keyRolls,
		scaleSpends: tally.scaleSpends, pickups: tally.pickups, fights: tally.fights,
		stoneBuys: tally.stoneBuys, evolves: tally.evolves, gives: tally.gives, teaches: tally.teaches || 0, levelUps: tally.levelUps || 0,
		// What "beat the game" is judged on: the road finished, nothing skipped,
		// no win bought by an engine refusal.
		finished: run.upcoming(doc, 1).length === 0,
		skipped: tally.skipped, engineRefusals: tally.engineRefusals, stopped: tally.stopped || null,
		seconds: Math.round((Date.now() - started) / 1000),
		// The document where the run ended, when asked for: a stall is a
		// battery scenario waiting to be written.
		...(options && options.keepDoc ? {doc} : {}),
		stalls: Object.keys(tally.trainers).filter(name => tally.trainers[name].attempts > 1)
			.map(name => ({trainer: name, attempts: tally.trainers[name].attempts,
				wins: tally.trainers[name].wins})),
	};
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

module.exports = {playRun, startRun, dice, armFlags, followAdvice, levelToCap};
