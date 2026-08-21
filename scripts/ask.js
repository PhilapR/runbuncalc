/* eslint-env node, es6 */
'use strict';

/**
 * Ask the game a question, from a player's point of view.
 *
 * The profile oracle already holds every fact this project knows about Run &
 * Bun — encounters, availability, learnsets, evolutions, catch rates, trainer
 * teams. What it did NOT have was a way to ask it something without first
 * reading its source to recover a signature. That cost real time in this
 * session: `levelUpMoves` returns [level, move] PAIRS, not objects, so a
 * perfectly reasonable `.filter(m => m.level <= 5)` returned nothing and
 * looked like missing data rather than a misuse.
 *
 * This is the answer to that. One command per question a player actually
 * asks, with the shapes handled here so no caller has to know them.
 *
 *   node scripts/ask.js where Ponyta                # where can I catch it
 *   node scripts/ask.js encounters "Oldale Town"    # what is on this route
 *   node scripts/ask.js opens "Mirage Tower"        # when does it open
 *   node scripts/ask.js moves Mudkip 12             # what does it know by L12
 *   node scripts/ask.js learn Mudkip Surf           # can it learn this
 *   node scripts/ask.js evolve Mudkip               # the whole line
 *   node scripts/ask.js catch Poochyena             # catch rate and odds
 *   node scripts/ask.js fight "Leader Brawly"       # their team
 *   node scripts/ask.js order                       # the route order
 *   node scripts/ask.js starters                    # what the game starts with
 *   node scripts/ask.js coverage                    # what the oracle knows
 *
 * Add --json to any command for the raw answer.
 *
 * The API this wraps is documented in docs/DATA-ACCESS.md, including the
 * return shape of every oracle method and the ones whose names mislead.
 */

const path = require('path');

const root = path.join(__dirname, '..');
const profiles = require(path.join(root, 'profiles'));

const PROFILE_ID = process.env.RUNBUN_PROFILE || 'run-and-bun';
const profile = profiles.getProfile(PROFILE_ID);
const oracle = profile.oracle;

function asJson(value) {
	console.log(JSON.stringify(value, null, 2));
}

/** Resolve a location the way a player names it, not the way the ROM does. */
function findMap(name) {
	const wanted = String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
	return oracle.maps().find(map =>
		map.name.toLowerCase().replace(/[^a-z0-9]/g, '') === wanted ||
		map.map.toLowerCase().replace(/[^a-z0-9]/g, '') === wanted) || null;
}

const COMMANDS = {
	/** Every location a species appears, with method and level band. */
	where(argv, json) {
		const species = argv[0];
		if (!species) throw new Error('where needs a species');
		const found = oracle.whereToFind(species) || [];
		if (json) return asJson(found);
		if (!found.length) return console.log(`${species} is not on any wild table.`);
		console.log(`${species} appears on ${found.length} table(s):`);
		for (const row of found) {
			const when = oracle.availabilityOf(row.name);
			console.log(`  ${row.name.padEnd(24)} ${row.method.padEnd(6)} ` +
				`L${row.minLevel}-${row.maxLevel}` +
				(when ? `  (opens at fight ${when.opensAt})` : '  (undated)'));
		}
	},

	/** What a location holds, split into what is reachable now and what waits. */
	encounters(argv, json) {
		const map = findMap(argv[0]);
		if (!map) throw new Error(`no location named ${JSON.stringify(argv[0])}`);
		const table = oracle.encountersOn(map.name);
		if (json) return asJson(table);
		const when = oracle.availabilityOf(map.name);
		console.log(`${map.name} — ${when ? 'opens at fight ' + when.opensAt +
			(when.provenance ? ' (' + when.provenance + ')' : '') : 'undated'}`);
		const gates = {};
		for (const mon of table.mons || []) {
			const at = oracle.methodOpensAt(mon.method);
			const label = at ? `needs ${mon.method} (fight ${at})` : 'available now';
			if (!gates[label]) gates[label] = [];
			gates[label].push(mon);
		}
		for (const label of Object.keys(gates)) {
			console.log(`  ${label}:`);
			for (const mon of gates[label]) {
				console.log(`    ${mon.species.padEnd(20)} L${mon.minLevel}-${mon.maxLevel}` +
					`  ${String(mon.chance) + '%'}${mon.rod ? '  ' + mon.rod : ''}`);
			}
		}
	},

	/** When a location opens, and on what evidence. */
	opens(argv, json) {
		const map = findMap(argv[0]);
		if (!map) throw new Error(`no location named ${JSON.stringify(argv[0])}`);
		const when = oracle.availabilityOf(map.name);
		if (json) return asJson(when);
		if (!when) return console.log(`${map.name}: undated — nothing in the data places it.`);
		console.log(`${map.name}: opens at fight ${when.opensAt}`);
		console.log(`  method: ${when.method}`);
		console.log(`  provenance: ${when.provenance || 'transcribed'}`);
		if (when.basis) console.log(`  basis: ${when.basis}`);
		if (when.transcribedOpensAt !== undefined) {
			console.log(`  was: ${when.transcribedOpensAt} before correction`);
		}
	},

	/**
	 * What a species knows by a level. levelUpMoves returns [level, move]
	 * PAIRS — the single most misusable shape in the oracle.
	 */
	moves(argv, json) {
		const species = argv[0];
		const level = argv[1] === undefined ? 100 : Number(argv[1]);
		if (!species) throw new Error('moves needs a species');
		const pairs = oracle.levelUpMoves(species) || [];
		const known = pairs.filter(pair => pair[0] <= level);
		if (json) return asJson({level, known, all: pairs});
		console.log(`${species} by level ${level} — ${known.length} level-up move(s):`);
		for (const pair of known) console.log(`  L${String(pair[0]).padStart(3)}  ${pair[1]}`);
		const later = pairs.filter(pair => pair[0] > level).slice(0, 4);
		if (later.length) {
			console.log('  still to come: ' +
				later.map(pair => `${pair[1]} (L${pair[0]})`).join(', '));
		}
	},

	/** Whether a species can hold a move, and by what route. */
	learn(argv, json) {
		const species = argv[0];
		const move = argv.slice(1).join(' ');
		if (!species || !move) throw new Error('learn needs a species and a move');
		const answer = oracle.canLearn(species, move);
		if (json) return asJson(answer);
		if (!answer || !answer.legal) return console.log(`${species} cannot learn ${move}.`);
		const how = (answer.sources || []).map(source =>
			source.source + (source.level ? ` at L${source.level}` : '')).join(', ');
		console.log(`${species} can learn ${move} — ${how || 'legal'}`);
	},

	/** The whole evolution line, both directions. */
	evolve(argv, json) {
		const species = argv[0];
		if (!species) throw new Error('evolve needs a species');
		const answer = {
			from: oracle.preEvolutionOf(species) || null,
			into: oracle.evolutionsOf(species) || [],
			line: oracle.lineageOf(species) || [],
		};
		if (json) return asJson(answer);
		console.log(`${species}`);
		if (answer.from) console.log(`  evolves from: ${answer.from}`);
		for (const step of answer.into) {
			console.log(`  evolves into: ${step.into} — ${step.method}` +
				(step.level ? ` at L${step.level}` : '') + (step.item ? ` with ${step.item}` : ''));
		}
		if (!answer.from && !answer.into.length) console.log('  does not evolve');
	},

	/** Catch rate, and what that means at full HP with each ball. */
	catch(argv, json) {
		const species = argv[0];
		if (!species) throw new Error('catch needs a species');
		const rate = oracle.catchRateOf(species);
		if (rate === null || rate === undefined) {
			throw new Error(`no catch rate on file for ${species}`);
		}
		const driver = require(path.join(root, 'lib', 'battle-driver.js'));
		const full = {hp: {max: 3, current: 3}, status: ''};
		const odds = Object.keys(driver.BALLS).map(ball => ({
			ball,
			chance: Math.round(driver.catchMath(full, rate, driver.BALLS[ball]).chance * 100),
		}));
		if (json) return asJson({species, rate, odds});
		console.log(`${species} — catch rate ${rate}`);
		for (const row of odds) console.log(`  ${row.ball.padEnd(12)} ${row.chance}% at full HP`);
	},

	/** A trainer's team, at the levels the run map records. */
	fight(argv, json) {
		const trainer = argv.join(' ');
		if (!trainer) throw new Error('fight needs a trainer name');
		const planner = require(path.join(root, 'lib', 'planner.js'));
		const found = planner.getFight(trainer, PROFILE_ID);
		if (json) return asJson(found);
		console.log(`${found.trainer} — fight order ${found.order}` +
			(found.isDouble ? ' (double)' : ''));
		for (const mon of found.party) {
			console.log(`  ${mon.species.padEnd(20)} L${mon.level}` +
				(mon.ability ? `  ${mon.ability}` : '') +
				(mon.item ? `  @${mon.item}` : ''));
		}
	},

	/** The tracker's route order — the sequence a player actually walks. */
	order(argv, json) {
		const tracker = require(path.join(root, 'profiles/run-and-bun/oracle/tracker-order.json'));
		if (json) return asJson(tracker);
		console.log(`${tracker.order.length} locations, in playthrough order:`);
		tracker.order.forEach((name, index) => {
			const map = findMap(name);
			const when = map ? oracle.availabilityOf(map.name) : null;
			console.log(`  ${String(index).padStart(3)}  ${name.padEnd(28)} ` +
				(when ? `fight ${when.opensAt}` : ''));
		});
	},

	/** What the game starts you with. */
	starters(argv, json) {
		const encounters = profile.encounters || {};
		const aces = encounters.RIVAL_ACES || null;
		const answer = {
			declaredStarters: encounters.STARTERS || null,
			rivalAces: aces,
			note: encounters.STARTERS ? null :
				'This profile does not model starters as data. The choice is hardcoded ' +
				'in src/index.template.html, and the rival is identified by ace only.',
		};
		if (json) return asJson(answer);
		console.log(`starters: ${answer.declaredStarters ?
			answer.declaredStarters.join(', ') : 'NOT MODELLED'}`);
		console.log(`rival aces: ${aces ? aces.join(', ') : 'none declared'}`);
		if (answer.note) console.log(`\n  ${answer.note}`);
	},

	/** How much of the game the oracle actually covers. */
	coverage(argv, json) {
		const answer = oracle.coverage();
		if (json) return asJson(answer);
		for (const key of Object.keys(answer)) {
			console.log(`  ${key.padEnd(20)} ${answer[key]}`);
		}
	},
};

function main(argv) {
	const json = argv.includes('--json');
	const rest = argv.filter(arg => arg !== '--json');
	const command = rest[0];
	const run = COMMANDS[command];
	if (!run) {
		console.error(`Unknown question '${command || ''}'.`);
		console.error(`Ask one of: ${Object.keys(COMMANDS).join(', ')}`);
		console.error('See docs/DATA-ACCESS.md for the shapes behind each one.');
		process.exit(1);
	}
	run(rest.slice(1), json);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {COMMANDS, oracle, findMap};
