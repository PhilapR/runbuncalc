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
const RETRIES = 12;
const BOSS_RETRIES = 20;
const FIGHT_BUDGET = Number(flag('budget', '110'));
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

/** Teach and (treatment) scale-spend from the same advice the panel shows. */
function followAdvice(doc, treatment, tally) {
	for (let round = 0; round < 3; round++) {
		let advice;
		try {
			advice = run.adviseUpgrades(doc);
		} catch (error) {
			return doc;
		}
		const row = advice.upgrades.find(entry =>
			entry.kind === 'teach' || (entry.kind === 'heartScale' && treatment.keyScales));
		if (!row) return doc;
		try {
			if (row.kind === 'teach') {
				const move = /learn (.+?)(?:\s+\(|$)/.exec(row.detail);
				if (!move) return doc;
				doc = run.apply(doc, {kind: 'teach', id: row.id, move: move[1].trim()});
			} else {
				const stat = /^(HP|Attack|Defense|Sp\. Atk|Sp\. Def|Speed) IV/.exec(row.detail);
				if (!stat) return doc;
				const statKeys = {HP: 'hp', Attack: 'atk', Defense: 'def',
					'Sp. Atk': 'spa', 'Sp. Def': 'spd', Speed: 'spe'};
				doc = run.apply(doc, {kind: 'heartScale', id: row.id, stat: statKeys[stat[1]]});
				tally.scaleSpends += 1;
			}
		} catch (error) {
			return doc;
		}
	}
	return doc;
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

function playRun(policy, starter, seed, treatment) {
	const random = dice(seed);
	let doc = run.createRun({name: 'headless', now: 't0',
		levelCap: 'next-milestone-ace', permadeath: false, onePerRoute: true,
		rival: starter.rival});
	const identity = run.rollIdentity(starter.species, random, {perfectIvs: 3});
	doc = run.apply(doc, Object.assign(
		{kind: 'catch', species: starter.species, level: 5}, identity));
	doc = run.apply(doc, {kind: 'party', ids: [doc.box[0].id]});

	const tally = {catches: 0, keyRolls: 0, scaleSpends: 0, pickups: 0,
		trainers: {}, fights: 0};
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
			doc = followAdvice(doc, treatment, tally);
			doc = bestParty(doc);
		}
		const ahead = run.upcoming(doc, 1);
		if (!ahead.length) break;
		const next = ahead[0];
		if (next.isDouble) {
			try {
				doc = run.apply(doc, {kind: 'skip', trainer: next.trainer,
					for: 'doubles play is not modeled'});
				continue;
			} catch (error) { break; }
		}
		const played = battery.playScenario(policy, doc, next.trainer, ++fightSeed);
		tally.fights += 1;
		const t = tally.trainers[next.trainer] =
			tally.trainers[next.trainer] || {attempts: 0, wins: 0};
		t.attempts += 1;
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
				attempts = 0;
			} catch (error) {
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
				' keyRolls=' + row.keyRolls + ' scales=' + row.scaleSpends);
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
			'  keyRolls=' + s.keyRolls + '  scales=' + s.scaleSpends);
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

module.exports = {playRun, dice, armFlags};
