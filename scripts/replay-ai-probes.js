/* eslint-env node, es6 */
'use strict';

/**
 * Grade the enemy AI's move choice against the ROM's.
 *
 * `profiles/run-and-bun/fidelity/ai-probes/` carries 85 probes captured from
 * the running Run & Bun ROM by the pykemon harness (provenance in that
 * directory's README). Each probe is one singles position, injected into the
 * ROM, and the real trainer AI's turn-2 choice over 20 pinned seeds. Most rows
 * also carry the AI's live score array, read out of RAM at 0x02000360
 * (u8[4], based at 100).
 *
 * This script rebuilds each position as a BattleState, asks the same policy
 * the battle driver plays for the enemy (`ai.evaluateActions(state,
 * ai.calculateActionFacts, 'ai', {includeSwitches: false})`, then
 * `ai.chooseAction`), and compares:
 *
 *   - top-1   rab's `top1Credit`: the share of OUR argmax set that lies in the
 *             ROM's modal set (a tie on our side splits the credit).
 *   - TVD     total-variation distance between our exact choice distribution
 *             and the ROM's empirical one (counts / 20).
 *   - scores  per move, whether the set of scores we can roll (+100) equals the
 *             set of scores the ROM showed over its 20 rows.
 *
 * The metrics are rab's (engines/rab/backend/scripts/jev-bench/bench-util.ts
 * in pokemon-mono), so the pooled numbers read side by side with rab's
 * benchmark 1 (commit 1ecc0e3: held-out top-1 0.972, TVD 0.053).
 *
 * Our distribution is EXACT, not sampled: every evaluation's outcome list is
 * independent (so is the ROM's roll, per SPIKE-GROUND-TRUTH.md phase 5), and
 * `chooseAction` breaks equal top scores uniformly, so the joint product is
 * enumerable. `sampledDistribution` replays `chooseAction` itself over seeded draws
 * so the enumeration cannot drift from the chooser the fights use.
 *
 * Harness rules:
 *
 *   - Stats are the probe's, through `statOverrides`, HP included. The ROM ran
 *     those numbers, not ones derived from base stats.
 *   - The ability is the probe's (Run Away, Insomnia, Effect Spore, Blaze).
 *     Leaving it unset would let the calculator restore the species ability.
 *   - Types are the injected ones. When they differ from the species' typing
 *     the state carries a `typeOverride`.
 *   - The probe measures TURN 2 after a double Splash, so no one is on their
 *     first turn out (Fake Out is off) and nothing else has changed.
 *
 *   node scripts/replay-ai-probes.js           # tables
 *   node scripts/replay-ai-probes.js --json    # machine-readable report
 */

const fs = require('fs');
const path = require('path');

const ai = require('../ai');
const Dex = require('@pkmn/dex').Dex;

const root = path.join(__dirname, '..');
const PROBE_DIR = path.join(root, 'profiles', 'run-and-bun', 'fidelity', 'ai-probes');

/** Run & Bun is a Gen 8-mechanics hack (src/js/sets_to_battle_state.js). */
const GENERATION = 8;

/**
 * Probes that are not an AI decision. Counted and named in every report,
 * never dropped in silence.
 */
const EXCLUDED = {
	'p6-slot1-artifact-check': 'single-turn protocol: it executed slot 1 of the patched moveset, ' +
		'which May\'s real mon had pre-chosen before injection (SPIKE-GROUND-TRUTH.md, phase 3 §1)',
};

/** Ability ids the probes use (tools/probe_suite.py and the Gen 3 ability table). */
const ABILITIES = {15: 'Insomnia', 27: 'Effect Spore', 50: 'Run Away', 66: 'Blaze'};

/** Type ids, from TYPE in tools/probe_suite.py. */
const TYPES = {
	0: 'Normal', 1: 'Fighting', 2: 'Flying', 3: 'Poison', 4: 'Ground', 5: 'Rock', 6: 'Bug', 7: 'Ghost',
	8: 'Steel', 10: 'Fire', 11: 'Water', 12: 'Grass', 13: 'Electric', 14: 'Psychic', 15: 'Ice',
	16: 'Dragon', 17: 'Dark',
};

/**
 * The phase-3/4 probes do not record types. Their fixtures are Combusken
 * (10, 1) and Breloom (12, 1), which is the species typing, except k3's
 * player: `variant(COMBUSKEN, ..., types=(10, 2))` in probe_suite.py.
 */
const PLAYER_TYPE_OVERRIDES = {'k3-only-weak-move-kills': [10, 2]};

/** The value the ROM's AI score array is based at (AI_SCORE_DEFAULT). */
const ROM_BASE = 100;

const SPECIES_BY_NUM = (() => {
	const out = {};
	for (const species of Dex.species.all()) {
		if (species.num > 0 && !species.forme) out[species.num] = species.name;
	}
	return out;
})();

/**
 * The held-out probes are all `h`. Each re-asks one phase-5 rule, so each is
 * reported under that rule's family (the "Rule" column of the held-out table
 * in SPIKE-GROUND-TRUTH.md).
 */
const HELDOUT_RULE_FAMILY = {
	h1: 's', h2: 's', h3: 's', h4: 'i', h5: 'i', h6: 's',
	h7: 'r', h8: 'r', h9: 'u', h10: 'u', h11: 'k', h12: 'k',
};

function familyOf(probeId) {
	const match = /^([a-z]+)(\d+)/.exec(probeId);
	if (!match) throw new Error(`${probeId}: no family prefix`);
	if (match[1] === 'h') {
		const rule = HELDOUT_RULE_FAMILY['h' + match[2]];
		if (!rule) throw new Error(`${probeId}: held-out probe with no rule family`);
		return rule;
	}
	return match[1];
}

function cohortOf(doc) {
	return doc.seed_cohort === 'heldout' ? 'heldout' : 'reference';
}

function speciesName(num, probe) {
	const name = SPECIES_BY_NUM[num];
	if (!name) throw new Error(`${probe}: no species for national dex ${num}`);
	return name;
}

function typeNames(ids, probe) {
	return [...new Set(ids.map(id => {
		if (!TYPES[id]) throw new Error(`${probe}: unknown type id ${id}`);
		return TYPES[id];
	}))];
}

function buildMon(side, id, probe, typeIds) {
	const species = speciesName(side.species, probe);
	const ability = ABILITIES[side.ability];
	if (!ability) throw new Error(`${probe}: unknown ability id ${side.ability}`);
	const mon = {
		id,
		species,
		level: side.level,
		hp: {current: side.hp_now === undefined ? side.stats.hp : side.hp_now, max: side.stats.hp},
		moves: side.moves.map(name => ({name})),
		ability,
		statOverrides: {...side.stats},
		boosts: {},
		status: '',
	};
	const ids = typeIds || side.types;
	if (ids) {
		const injected = typeNames(ids, probe);
		const natural = Dex.species.get(species).types;
		const same = injected.length === natural.length && injected.every((t, i) => t === natural[i]);
		if (!same) mon.typeOverride = injected;
	}
	return mon;
}

function buildState(doc) {
	const enemy = buildMon(doc.enemy, 'ai-1', doc.probe);
	const player = buildMon(doc.player, 'player-1', doc.probe, PLAYER_TYPE_OVERRIDES[doc.probe]);
	const bench = (doc.player_bench ? [doc.player_bench] : [])
		.map((side, i) => buildMon(side, `player-${i + 2}`, doc.probe));
	return {
		generation: GENERATION,
		mode: 'Singles',
		turn: 2,
		field: {},
		sides: {
			ai: {activeIds: ['ai-1'], party: [enemy]},
			player: {activeIds: ['player-1'], party: [player, ...bench]},
		},
		firstTurnOutIds: [],
	};
}

function moveOf(evaluation) {
	return evaluation.action.kind === 'move' ? evaluation.action.moveName : `switch:${evaluation.action.replacementId}`;
}

/** Merge equal scores so the product below stays small. */
function outcomeTable(evaluation) {
	const byScore = new Map();
	for (const outcome of evaluation.outcomes) {
		if (outcome.probability > 0) {
			byScore.set(outcome.score, (byScore.get(outcome.score) || 0) + outcome.probability);
		}
	}
	return [...byScore.keys()].map(score => ({score, probability: byScore.get(score)}));
}

/** The exact distribution `chooseAction` samples from. */
function exactDistribution(evaluations) {
	const tables = evaluations.map(outcomeTable);
	const dist = {};
	const walk = (index, probability, scores) => {
		if (index === tables.length) {
			const top = Math.max(...scores);
			const tied = scores.map((s, i) => (s === top ? i : -1)).filter(i => i >= 0);
			for (const i of tied) {
				const move = moveOf(evaluations[i]);
				dist[move] = (dist[move] || 0) + probability / tied.length;
			}
			return;
		}
		for (const outcome of tables[index]) {
			walk(index + 1, probability * outcome.probability, [...scores, outcome.score]);
		}
	};
	walk(0, 1, []);
	return dist;
}

function mulberry32(seed) {
	return function () {
		seed |= 0; seed = seed + 0x6D2B79F5 | 0;
		let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
		t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
		return ((t ^ t >>> 14) >>> 0) / 4294967296;
	};
}

/** `chooseAction` itself, over seeded draws: the enumeration's witness. */
function sampledDistribution(evaluations, draws, seed) {
	const rng = mulberry32(seed);
	const counts = {};
	for (let i = 0; i < draws; i++) {
		const move = moveOf({action: ai.chooseAction(evaluations, rng).action});
		counts[move] = (counts[move] || 0) + 1;
	}
	return Object.fromEntries(Object.keys(counts).map(k => [k, counts[k] / draws]));
}

function argmaxSet(dist) {
	const top = Math.max(...Object.values(dist));
	return Object.keys(dist).filter(k => dist[k] === top);
}

/** rab bench-util.ts `top1Credit`. */
function top1Credit(pred, label) {
	const predTop = argmaxSet(pred);
	const labelTop = new Set(argmaxSet(label));
	return predTop.filter(k => labelTop.has(k)).length / predTop.length;
}

/** rab bench-util.ts `tvd`. */
function tvd(p, q) {
	const keys = new Set([...Object.keys(p), ...Object.keys(q)]);
	let s = 0;
	for (const k of keys) s += Math.abs((p[k] || 0) - (q[k] || 0));
	return s / 2;
}

/** The ROM's per-move score values, read from the rows (slot → move by the probe's moveset). */
function romScores(doc) {
	const rows = doc.rows.filter(row => Array.isArray(row.ai_scores));
	if (!rows.length) return null;
	const byMove = {};
	for (const row of rows) {
		if (doc.enemy.moves[row.enemy_slot] !== row.enemy_move) {
			throw new Error(`${doc.probe}: row ${row.seed} slot ${row.enemy_slot} is not ${row.enemy_move}`);
		}
		row.ai_scores.forEach((score, slot) => {
			const move = doc.enemy.moves[slot];
			byMove[move] = byMove[move] || {};
			byMove[move][score] = (byMove[move][score] || 0) + 1;
		});
	}
	return byMove;
}

function ourScores(evaluations) {
	const byMove = {};
	for (const evaluation of evaluations) {
		const table = outcomeTable(evaluation);
		byMove[moveOf(evaluation)] = Object.fromEntries(
			table.map(outcome => [outcome.score + ROM_BASE, outcome.probability]));
	}
	return byMove;
}

function sameSet(a, b) {
	return a.length === b.length && a.every(x => b.includes(x));
}

function gradeProbe(doc, options = {}) {
	const state = buildState(doc);
	ai.validateBattleState(state);
	const evaluations = ai.evaluateActions(state, ai.calculateActionFacts, 'ai', {includeSwitches: false});
	if (!evaluations.length) throw new Error(`${doc.probe}: the policy returned no actions`);
	const exact = exactDistribution(evaluations);
	const n = Object.values(doc.distribution).reduce((a, b) => a + b, 0);
	const label = Object.fromEntries(doc.enemy.moves.map(m => [m, (doc.distribution[m] || 0) / n]));
	const pred = Object.fromEntries(doc.enemy.moves.map(m => [m, exact[m] || 0]));
	for (const move of Object.keys(exact)) {
		if (!(move in pred)) throw new Error(`${doc.probe}: the policy chose ${move}, which is not in the moveset`);
	}
	const rom = romScores(doc);
	const ours = ourScores(evaluations);
	const scoreRows = rom ? doc.enemy.moves.map(move => {
		const romSet = Object.keys(rom[move] || {}).map(Number).sort((a, b) => a - b);
		const ourSet = Object.keys(ours[move] || {}).map(Number).sort((a, b) => a - b);
		// A move with no evaluation was removed by the legality filter before
		// scoring: we never score it, where the ROM gives it a number.
		return {move, rom: rom[move] || {}, ours: ours[move] || {}, enumerated: move in ours,
			match: sameSet(romSet, ourSet)};
	}) : null;
	const sample = options.sampleDraws ?
		tvd(sampledDistribution(evaluations, options.sampleDraws, 0x5eed ^ n), pred) :
		undefined;
	return {
		probe: doc.probe,
		family: familyOf(doc.probe),
		cohort: cohortOf(doc),
		label,
		pred,
		top1: top1Credit(pred, label),
		tvd: tvd(pred, label),
		scoreRows,
		...(sample === undefined ? {} : {sampleTvd: sample}),
	};
}

function mean(xs) {
	return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

function summarize(graded) {
	const scoreRows = graded.flatMap(g => g.scoreRows || []);
	return {
		n: graded.length,
		top1: mean(graded.map(g => g.top1)),
		tvd: mean(graded.map(g => g.tvd)),
		scoredProbes: graded.filter(g => g.scoreRows).length,
		scoreMoves: scoreRows.length,
		scoreMatch: scoreRows.length ? scoreRows.filter(r => r.match).length / scoreRows.length : NaN,
		notEnumerated: scoreRows.filter(r => !r.enumerated).length,
	};
}

function loadProbes(dir) {
	return fs.readdirSync(dir || PROBE_DIR)
		.filter(f => f.endsWith('.json'))
		.sort()
		.map(f => JSON.parse(fs.readFileSync(path.join(dir || PROBE_DIR, f), 'utf8')));
}

function gradeAll(options = {}) {
	const docs = loadProbes(options.dir);
	const graded = [];
	const excluded = [];
	const unsupported = [];
	for (const doc of docs) {
		if (EXCLUDED[doc.probe]) {
			excluded.push({probe: doc.probe, reason: EXCLUDED[doc.probe]});
			continue;
		}
		try {
			graded.push(gradeProbe(doc, options));
		} catch (error) {
			unsupported.push({probe: doc.probe, reason: error.message});
		}
	}
	const by = key => {
		const groups = {};
		for (const g of graded) (groups[key(g)] = groups[key(g)] || []).push(g);
		return Object.fromEntries(Object.keys(groups).sort().map(k => [k, summarize(groups[k])]));
	};
	return {
		files: docs.length,
		graded,
		excluded,
		unsupported,
		pooled: {
			reference: summarize(graded.filter(g => g.cohort === 'reference')),
			heldout: summarize(graded.filter(g => g.cohort === 'heldout')),
			all: summarize(graded),
		},
		byFamily: by(g => `${g.cohort}:${g.family}`),
	};
}

function fmt(x, digits = 3) {
	return Number.isFinite(x) ? x.toFixed(digits) : '-';
}

function distText(dist) {
	return Object.keys(dist).filter(k => dist[k] > 0.0005)
		.sort((a, b) => dist[b] - dist[a]).map(k => `${k} ${dist[k].toFixed(2)}`).join(', ');
}

/** ROM values carry row counts; ours carry probabilities. */
function scoreText(scores, isRom) {
	return Object.keys(scores).map(Number).sort((a, b) => a - b)
		.map(k => `${k}:${isRom ? scores[k] : scores[k].toFixed(2)}`).join(' ') || '(not enumerated)';
}

function report(result) {
	const lines = [];
	lines.push(`${result.files} probe files; ${result.graded.length} graded, ` +
		`${result.excluded.length} excluded, ${result.unsupported.length} unsupported`);
	for (const e of result.excluded) lines.push(`  excluded ${e.probe}: ${e.reason}`);
	for (const u of result.unsupported) lines.push(`  UNSUPPORTED ${u.probe}: ${u.reason}`);
	lines.push('');
	lines.push('| set | n | top-1 | mean TVD | score-set match (moves) | not enumerated |');
	lines.push('|---|---|---|---|---|---|');
	for (const set of Object.keys(result.pooled)) {
		const s = result.pooled[set];
		lines.push(`| ${set} | ${s.n} | ${fmt(s.top1)} | ${fmt(s.tvd)} | ${fmt(s.scoreMatch)} (${s.scoreMoves}) | ` +
			`${s.notEnumerated} |`);
	}
	lines.push('');
	lines.push('| cohort:family | n | top-1 | mean TVD | score-set match (moves) |');
	lines.push('|---|---|---|---|---|');
	for (const key of Object.keys(result.byFamily)) {
		const s = result.byFamily[key];
		lines.push(`| ${key} | ${s.n} | ${fmt(s.top1)} | ${fmt(s.tvd)} | ${fmt(s.scoreMatch)} (${s.scoreMoves}) |`);
	}
	lines.push('');
	lines.push('Per probe (ROM label vs ours; score rows that disagree):');
	for (const g of result.graded) {
		const bad = (g.scoreRows || []).filter(r => !r.match);
		const flag = g.top1 < 1 || g.tvd > 0.25 ? 'WRONG' : 'ok';
		lines.push(`${flag.padEnd(5)} ${g.probe} [${g.cohort}] top1 ${fmt(g.top1, 2)} tvd ${fmt(g.tvd, 2)}` +
			(g.sampleTvd === undefined ? '' : ` sample-vs-exact ${fmt(g.sampleTvd, 3)}`));
		lines.push(`      rom:  ${distText(g.label)}`);
		lines.push(`      ours: ${distText(g.pred)}`);
		for (const r of bad) lines.push(`      score ${r.move}: rom ${scoreText(r.rom, true)} | ours ${scoreText(r.ours, false)}`);
	}
	return lines.join('\n');
}

if (require.main === module) {
	const json = process.argv.includes('--json');
	const draws = process.argv.includes('--sample') ? 4000 : 0;
	const result = gradeAll({sampleDraws: draws});
	if (json) {
		process.stdout.write(JSON.stringify(result, null, 2) + '\n');
	} else {
		process.stdout.write(report(result) + '\n');
	}
}

module.exports = {
	PROBE_DIR,
	EXCLUDED,
	buildState,
	exactDistribution,
	sampledDistribution,
	gradeProbe,
	gradeAll,
	loadProbes,
	top1Credit,
	tvd,
	report,
};
