/* eslint-env node, es6 */
'use strict';

/**
 * Dossier machinery: a fight's threat structure, priced against a sample of
 * what the game has actually offered the player by that point.
 *
 * One implementation for two consumers — scripts/leader-dossier.js (the
 * human-readable boss report) and scripts/build-fight-dossiers.js (the
 * all-fights oracle) — because the id-scale audit's costliest lesson was
 * two copies of one truth drifting apart by hand.
 *
 * The sample is every species catchable from wild tables whose map and
 * method are open at a given order, levelled to the cap in force there,
 * evolved through plain level evolutions (understating rather than
 * inventing: no stones, no trades), and armed with its last four level-up
 * moves at 15 IVs. That is a fair sketch of a period box — deliberately a
 * WEAK instantiation (no items, no TMs, neutral spread), so its answer
 * rates read as floors, not promises.
 */

const planner = require('./planner');
const encountersProfile = require('../profiles/run-and-bun/encounters.js');
const availability = require('../profiles/run-and-bun/oracle/availability.json');
const wildTables = require('../profiles/run-and-bun/oracle/encounters.json');
const evolutions = require('../profiles/run-and-bun/oracle/evolutions.json');
const learnsets = require('../profiles/run-and-bun/oracle/learnsets.json');

/** Tech a plan must respect, named from the kit rather than discovered in play. */
const PUNISH_ABILITIES = new Set(['Defiant', 'Competitive', 'Volt Absorb', 'Water Absorb',
	'Flash Fire', 'Sap Sipper', 'Lightning Rod', 'Storm Drain', 'Levitate', 'Sturdy',
	'Motor Drive', 'Dry Skin', 'Mold Breaker', 'Magic Bounce', 'Contrary', 'Unburden',
	'Speed Boost', 'Refrigerate', 'Technician', 'Solid Rock', 'Shed Skin', 'Filter',
	'Arena Trap', 'Shadow Tag', 'Huge Power', 'Beast Boost', 'Illusion']);
const TECH_ITEMS = new Set(['Focus Sash', 'Weakness Policy', 'Eviolite', 'Custap Berry',
	'Eject Button', 'Lum Berry', 'Leftovers', 'Air Balloon', 'Quick Claw', 'Bright Powder',
	'Assault Vest', 'Choice Scarf', 'Choice Band', 'Choice Specs', 'Life Orb', 'Shuca Berry',
	'Rindo Berry', 'Iapapa Berry', 'White Herb', 'Expert Belt', 'Focus Band']);
const SETUP_MOVES = new Set(['Swords Dance', 'Nasty Plot', 'Dragon Dance', 'Calm Mind',
	'Coil', 'Bulk Up', 'Work Up', 'Curse', 'Shell Smash', 'Quiver Dance', 'Iron Defense',
	'Autotomize', 'Rock Polish', 'Agility', 'Hone Claws', 'Power-Up Punch']);
const RECOVERY_MOVES = new Set(['Rest', 'Recover', 'Synthesis', 'Morning Sun', 'Moonlight',
	'Roost', 'Slack Off', 'Soft-Boiled', 'Milk Drink', 'Strength Sap', 'Leech Seed',
	'Drain Punch', 'Giga Drain', 'Leech Life', 'Draining Kiss']);
const SLEEP_STATUS = new Set(['Hypnosis', 'Sleep Powder', 'Spore', 'Grass Whistle', 'Sing',
	'Yawn', 'Will-O-Wisp', 'Thunder Wave', 'Toxic', 'Stun Spore', 'Sand Attack', 'Attract']);
const PRIORITY_MOVES = new Set(['Mach Punch', 'Extreme Speed', 'Aqua Jet', 'Sucker Punch',
	'Bullet Punch', 'Ice Shard', 'Quick Attack', 'Shadow Sneak', 'Fake Out', 'Vacuum Wave',
	'Accelerock', 'First Impression']);
const HAZARD_MOVES = new Set(['Stealth Rock', 'Spikes', 'Toxic Spikes', 'Sticky Web']);

/** Wild species from every table whose map and method are open at `order`. */
function periodPool(order) {
	const byMap = new Map((availability.entries || []).map(row => [row.map, row]));
	const methodGate = method => {
		const gate = availability.methods[method];
		return gate === undefined || gate <= 0 || gate <= order;
	};
	const species = new Set();
	for (const entry of wildTables.maps) {
		const dated = byMap.get(entry.map);
		if (!dated || dated.opensAt === null || dated.opensAt === undefined) continue;
		if (dated.opensAt > 0 && dated.opensAt > order) continue;
		for (const table of entry.tables || []) {
			if (!methodGate(table.method)) continue;
			for (const mon of table.mons || []) species.add(mon.species);
		}
	}
	return [...species];
}

/**
 * Level evolutions always; ITEM evolutions only when the caller names the
 * stones the road has actually handed over (all eight basic stones open at
 * order 209, twenty fights before Wattson — nothing before Roxanne).
 * Friendship, trade, location and move methods stay excluded: undatable,
 * and the sample under-claims rather than invents.
 */
function evolveTo(species, level, stones) {
	let current = species;
	for (let hops = 0; hops < 3; hops++) {
		const paths = evolutions[current] || [];
		const step = paths.find(p =>
			(p.method === 'level' && p.level <= level) ||
			(p.method === 'item' && stones && stones.has(p.item)));
		if (!step) break;
		current = step.into;
	}
	return current;
}

function lastFourMoves(species, level) {
	const rows = (learnsets.levelUp && learnsets.levelUp[species]) || [];
	const known = rows.filter(row => row[0] <= level).map(row => row[1]);
	return [...new Set(known)].slice(-4);
}

function capOf(order) {
	let cap = null;
	for (const row of encountersProfile.LEVEL_CAPS) {
		if (row.order >= order) { cap = row.cap; break; }
	}
	return cap || 100;
}

function buildSample(order) {
	const cap = capOf(order);
	const seen = new Set();
	const sample = [];
	for (const raw of periodPool(order)) {
		const species = evolveTo(raw, cap);
		if (seen.has(species)) continue;
		seen.add(species);
		const moves = lastFourMoves(species, cap);
		if (!moves.length) continue;
		sample.push({species, level: cap,
			moves, ivs: {hp: 15, atk: 15, def: 15, spa: 15, spd: 15, spe: 15}});
	}
	return {cap, sample};
}

/**
 * A deterministic stratified cut: round-robin across primary types so 48
 * species still cover the type chart, without a die anywhere.
 */
function stratify(sample, size) {
	if (sample.length <= size) return sample;
	const calc = require('../calc');
	const byType = new Map();
	for (const spec of sample) {
		let type = '?';
		try {
			const found = calc.Generations.get(8).species.get(calc.toID(spec.species));
			type = (found && found.types && found.types[0]) || '?';
		} catch (error) { /* unknown species stratify under '?' */ }
		if (!byType.has(type)) byType.set(type, []);
		byType.get(type).push(spec);
	}
	const buckets = [...byType.values()];
	const cut = [];
	for (let round = 0; cut.length < size; round++) {
		let took = false;
		for (const bucket of buckets) {
			if (bucket[round]) {
				cut.push(bucket[round]);
				took = true;
				if (cut.length === size) break;
			}
		}
		if (!took) break;
	}
	return cut;
}

/** The engine's grid, chunked so any sample size fits a party. */
function gridAgainst(trainer, sample) {
	const blocks = new Map();
	for (let i = 0; i < sample.length; i += 6) {
		const chunk = sample.slice(i, i + 6);
		let matchup;
		try {
			matchup = planner.matchup({trainer, playerParty: chunk});
		} catch (error) {
			continue;
		}
		for (const block of matchup.grid) {
			const key = block.enemy.species + '#' + (block.enemy.index || 0);
			if (!blocks.has(key)) blocks.set(key, {enemy: block.enemy, versus: []});
			blocks.get(key).versus.push(...block.versus);
		}
	}
	return [...blocks.values()];
}

function techFlags(fight) {
	const flags = [];
	for (const mon of fight.party) {
		const marks = [];
		if (PUNISH_ABILITIES.has(mon.ability)) marks.push(mon.ability);
		if (TECH_ITEMS.has(mon.item)) marks.push(mon.item);
		for (const move of mon.moves || []) {
			if (SETUP_MOVES.has(move)) marks.push('setup:' + move);
			if (RECOVERY_MOVES.has(move)) marks.push('recovery:' + move);
			if (SLEEP_STATUS.has(move)) marks.push('status:' + move);
			if (PRIORITY_MOVES.has(move)) marks.push('priority:' + move);
			if (HAZARD_MOVES.has(move)) marks.push('hazard:' + move);
		}
		if (marks.length) flags.push(mon.species + ': ' + marks.join(', '));
	}
	return flags;
}

/**
 * The dossier for one fight against a prepared sample. `withKeyBox` also
 * names the six sample species that do best across the whole enemy team.
 */
function dossierFor(fight, cap, sample, withKeyBox) {
	const grid = gridAgainst(fight.trainer, sample);
	const mons = [];
	const scores = new Map();
	for (const block of grid) {
		const rows = block.versus.filter(row => row.us && row.them);
		if (!rows.length) continue;
		const n = rows.length;
		const faster = rows.filter(row => row.speed === 'faster').length;
		// An ANSWER 2HKOs on its floor while their crit ceiling stays under
		// half — the strict read, so answer rates are floors.
		const answers = rows.filter(row =>
			row.us.min >= 0.5 && (row.them.critMax || row.them.max) < 0.5);
		for (const row of rows) {
			const answered = row.us.min >= 0.5 && (row.them.critMax || row.them.max) < 0.5;
			const prior = scores.get(row.species) || 0;
			scores.set(row.species, prior + (answered ? 2 : 0) + (row.us.min || 0) / 6);
		}
		const hits = rows.map(row => row.them.max);
		mons.push({
			species: block.enemy.species,
			level: block.enemy.level,
			outspedBySample: Math.round(100 * faster / n),
			meanBestHit: Math.round(100 * hits.reduce((a, b) => a + b, 0) / n),
			ohkoRate: Math.round(100 * rows.filter(row => row.them.guaranteedKO).length / n),
			answerRate: Math.round(100 * answers.length / n),
			topAnswers: answers.sort((a, b) => b.us.min - a.us.min)
				.slice(0, 4).map(row => row.species),
		});
	}
	const out = {
		trainer: fight.trainer, order: fight.order, cap,
		isDouble: !!fight.isDouble, sampleSize: sample.length,
		tech: techFlags(fight), mons,
	};
	if (withKeyBox) {
		out.keyBox = [...scores.entries()].sort((a, b) => b[1] - a[1])
			.slice(0, 6).map(entry => entry[0]);
	}
	return out;
}

module.exports = {
	periodPool, evolveTo, lastFourMoves, capOf, buildSample, stratify,
	gridAgainst, techFlags, dossierFor,
	PUNISH_ABILITIES, TECH_ITEMS, SETUP_MOVES, RECOVERY_MOVES,
	SLEEP_STATUS, PRIORITY_MOVES, HAZARD_MOVES,
};
