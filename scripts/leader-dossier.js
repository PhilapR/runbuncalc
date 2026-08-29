#!/usr/bin/env node
/* eslint-env node, es6 */
'use strict';

/**
 * A dossier per boss-tier leader: the kit's declared tech, and its threat
 * structure measured against a REPRESENTATIVE SAMPLE of what the game has
 * actually offered the player by that point.
 *
 * The reachable gyms get empirical batteries; everything past the corridor
 * only gets this abstract read — which is the point. The sample is every
 * species catchable from tables open at the leader's order (methods gated
 * the same way the game gates them), levelled to the leader's cap, evolved
 * through plain level evolutions, and armed with its last four level-up
 * moves. That is a fair sketch of a period box, and the engine's own
 * matchup grid prices every pair of it against every leader mon.
 *
 * Per leader mon, the dossier reports: how much of the period sample it
 * outspeeds, how much its best hit removes, how much of the sample can
 * answer it (2HKO on the floor while surviving the reply), and the top
 * named answers. Per leader, it flags the tech a plan must respect —
 * punish abilities, absorbers, sashes, setup, recovery, sleep, priority.
 *
 *   node scripts/leader-dossier.js                 # every boss leader
 *   node scripts/leader-dossier.js --only=Wattson  # substring filter
 */

const fs = require('node:fs');
const planner = require('../lib/planner');
const encountersProfile = require('../profiles/run-and-bun/encounters.js');
const availability = require('../profiles/run-and-bun/oracle/availability.json');
const wildTables = require('../profiles/run-and-bun/oracle/encounters.json');
const evolutions = require('../profiles/run-and-bun/oracle/evolutions.json');
const learnsets = require('../profiles/run-and-bun/oracle/learnsets.json');

const FLAG = name => {
	const hit = process.argv.find(arg => arg.startsWith('--' + name + '='));
	return hit ? hit.split('=').slice(1).join('=') : '';
};

/** Tech a plan must respect, named from the kit rather than discovered in play. */
const PUNISH_ABILITIES = new Set(['Defiant', 'Competitive', 'Volt Absorb', 'Water Absorb',
	'Flash Fire', 'Sap Sipper', 'Lightning Rod', 'Storm Drain', 'Levitate', 'Sturdy',
	'Motor Drive', 'Dry Skin', 'Mold Breaker', 'Magic Bounce', 'Contrary', 'Unburden',
	'Speed Boost', 'Refrigerate', 'Technician', 'Solid Rock', 'Shed Skin', 'Filter',
	'Arena Trap', 'Shadow Tag', 'Huge Power', 'Beast Boost']);
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

/** Plain level evolutions only: the sample under-claims rather than invents. */
function evolveTo(species, level) {
	let current = species;
	for (let hops = 0; hops < 3; hops++) {
		const paths = evolutions[current] || [];
		const step = paths.find(p => p.method === 'level' && p.level <= level);
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

function dossier(fight) {
	const built = buildSample(fight.order);
	const cap = built.cap;
	const sample = built.sample;
	const grid = gridAgainst(fight.trainer, sample);
	const mons = [];
	for (const block of grid) {
		const rows = block.versus.filter(row => row.us && row.them);
		if (!rows.length) continue;
		const n = rows.length;
		const faster = rows.filter(row => row.speed === 'faster').length;
		// An ANSWER survives their crit ceiling twice and 2HKOs on its floor.
		const answers = rows.filter(row =>
			row.us.min >= 0.5 && (row.them.critMax || row.them.max) < 0.5);
		const named = answers
			.sort((a, b) => b.us.min - a.us.min)
			.slice(0, 4).map(row => row.species);
		const hits = rows.map(row => row.them.max);
		mons.push({
			species: block.enemy.species,
			level: block.enemy.level,
			outspedBySample: Math.round(100 * faster / n),
			meanBestHit: Math.round(100 * hits.reduce((a, b) => a + b, 0) / n),
			ohkoRate: Math.round(100 * rows.filter(row => row.them.guaranteedKO).length / n),
			answerRate: Math.round(100 * answers.length / n),
			topAnswers: named,
		});
	}
	// The six sample species that do best across the WHOLE team: two points
	// per mon they outright answer, plus their floor damage — a box you could
	// actually go catch, which the battery can then grade against baseline.
	const scores = new Map();
	for (const block of grid) {
		for (const row of block.versus) {
			if (!row.us || !row.them) continue;
			const answered = row.us.min >= 0.5 && (row.them.critMax || row.them.max) < 0.5;
			const prior = scores.get(row.species) || 0;
			scores.set(row.species, prior + (answered ? 2 : 0) + (row.us.min || 0) / 6);
		}
	}
	const keyBox = [...scores.entries()].sort((a, b) => b[1] - a[1])
		.slice(0, 6).map(entry => entry[0]);
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
	return {
		trainer: fight.trainer, order: fight.order, cap,
		isDouble: !!fight.isDouble, sampleSize: sample.length,
		tech: flags, keyBox, mons,
	};
}

function main() {
	const only = FLAG('only');
	const fights = planner.loadRunMap('run-and-bun')
		.filter(fight => /^Leader |^Elite Four |^Champion /.test(fight.trainer))
		.filter(fight => !only || fight.trainer.includes(only));
	const out = [];
	for (const fight of fights) {
		const entry = dossier(fight);
		out.push(entry);
		console.log('=== ' + entry.trainer + ' (order ' + entry.order + ', cap ' +
			entry.cap + ', sample ' + entry.sampleSize + ' species' +
			(entry.isDouble ? ', DOUBLES' : '') + ') ===');
		for (const line of entry.tech) console.log('  tech  ' + line);
		for (const mon of entry.mons) {
			console.log('  ' + (mon.species + ' L' + mon.level).padEnd(22) +
				'outsped-by ' + String(mon.outspedBySample + '%').padEnd(5) +
				' hit ' + String(mon.meanBestHit + '%').padEnd(5) +
				' ohko ' + String(mon.ohkoRate + '%').padEnd(5) +
				' answered-by ' + String(mon.answerRate + '%').padEnd(5) +
				(mon.topAnswers.length ? ' best: ' + mon.topAnswers.join(', ') : ''));
		}
	}
	fs.writeFileSync('ui-playthrough-out/leader-dossiers.json',
		JSON.stringify(out, null, '\t'));
	console.log('\nwrote ui-playthrough-out/leader-dossiers.json');
}

main();
