/* eslint-env node, es6 */
'use strict';

/**
 * Grade this calculator against the ROM.
 *
 * `profiles/run-and-bun/fidelity/` carries 1,727 damage observations captured
 * from the real Run & Bun ROM by an instrumented emulator (see the README
 * there). This script rebuilds both sides of each fixture with the exact stats
 * the sweep injected, asks `calc.calculate()` for the 16-roll array of the move
 * that was actually clicked, and checks the observed damage is one of those 16
 * values. Not "inside [min,max]" — a member of the discrete set, which is the
 * stronger claim and the one that catches a wrong rounding ORDER rather than
 * only a wrong magnitude.
 *
 * The point is that the evidence is external. An engine graded by its own
 * expectations cannot catch a value that is wrong in both places; these
 * observations were produced by a program that has never read this code.
 *
 * Three things must stay true of the harness itself:
 *
 *   - Stats are the event's, not ours. `statOverrides` makes the injected
 *     battle stats authoritative; recomputing them from base stats + IVs would
 *     silently grade a different Pokémon than the ROM ran.
 *   - No ability. The sweep injected Run Away on both sides, so the bands carry
 *     no ability effect. Suppression must go through `overrides.abilities`:
 *     assigning `mon.ability = undefined` after construction does NOT work,
 *     because `calculate()` clones its inputs and the clone re-derives the
 *     ability from the species (verified: Thick Fat came back and halved a
 *     Fire move by 2×).
 *   - Crits are asked for as crits. The corpus flags every detected crit, and a
 *     crit is checked against the crit band only — folding the two bands into
 *     one union would let a wrong crit multiplier pass as a normal roll.
 *
 *   node scripts/rom-band-check.js          # report, exit 1 on any miss
 *   node scripts/rom-band-check.js --json   # machine-readable report
 */

const fs = require('fs');
const path = require('path');

const calc = require('@smogon/calc');

const root = path.join(__dirname, '..');

/** The vendored corpus. Vendored so this gate runs in CI without the monorepo. */
const FIDELITY_DIR = path.join(root, 'profiles', 'run-and-bun', 'fidelity');

/**
 * Falsification pins, copied from rab's own harness.
 *
 * An empty directory used to produce zero assertions and exit 0 — "checked 0
 * observations" reads as green. Pinning the file count and the observation
 * floor makes a vanished or truncated corpus fail loudly instead.
 */
const EXPECTED_EVENT_FILES = 3;
const EXPECTED_MIN_OBSERVATIONS = 1727;

/** Run & Bun is a Gen 8-mechanics hack; see `profiles/run-and-bun/index.js`. */
const GENERATION = 8;

const gen = calc.Generations.get(GENERATION);

function eventFiles(dir) {
	return fs.readdirSync(dir).filter(f => f.startsWith('events-') && f.endsWith('.json')).sort();
}

/**
 * Build one side exactly as the sweep configured it: the event's stats verbatim,
 * no ability, no item, no boosts, full HP. Full HP matters — the fixtures inflate
 * HP so battles last, and a lower `curHP` would read as a pinch state and switch
 * on the very abilities this band convention excludes.
 */
function buildMon(spec, status) {
	return new calc.Pokemon(gen, spec.species, {
		level: spec.level,
		statOverrides: {...spec.stats},
		curHP: spec.stats.hp,
		status: status || '',
		// The sweep injected Run Away on both sides. 'None' is not an ability
		// any rule names, and unlike a post-construction assignment it survives
		// the clone `calculate()` takes of its inputs.
		overrides: {abilities: {0: 'None'}},
	});
}

/** Only one status can be on a Pokémon at a time; the arrays are events, not sets. */
function statusOf(list) {
	return (list && list[0]) || '';
}

function rollsFor(gen8, attacker, defender, moveName, isCrit) {
	const result = calc.calculate(gen8, attacker, defender, new calc.Move(gen8, moveName, {isCrit}));
	const damage = result.damage;
	if (typeof damage === 'number') return [damage];
	if (damage.some(d => Array.isArray(d))) {
		// Multi-hit and Parental Bond return per-hit roll arrays. The corpus has
		// no such move; refusing is better than inventing a summation rule that
		// nothing here validates.
		throw new Error(`${moveName}: multi-hit damage shape is not gradeable by this harness`);
	}
	return damage;
}

/**
 * Check every non-censored observation in the corpus.
 *
 * Censored observations are the ones where the defender fainted: the ROM only
 * shows the HP that was left, so the number is a lower bound, not a roll.
 */
function checkBands(dir) {
	const files = eventFiles(dir || FIDELITY_DIR);
	const fixtures = [];
	const misses = [];
	let checked = 0;
	let censored = 0;
	let inBand = 0;

	for (const file of files) {
		const data = JSON.parse(fs.readFileSync(path.join(dir || FIDELITY_DIR, file), 'utf8'));
		const sides = {A: data.sides.A, B: data.sides.B};
		const monCache = new Map();
		const rollCache = new Map();

		const monFor = (side, status) => {
			const key = `${side}|${status}`;
			if (!monCache.has(key)) monCache.set(key, buildMon(sides[side], status));
			return monCache.get(key);
		};
		const bandFor = (side, moveName, isCrit, attackerStatus, defenderStatus) => {
			const key = `${side}|${moveName}|${isCrit}|${attackerStatus}|${defenderStatus}`;
			if (!rollCache.has(key)) {
				const foe = side === 'A' ? 'B' : 'A';
				rollCache.set(key, rollsFor(
					gen, monFor(side, attackerStatus), monFor(foe, defenderStatus), moveName, isCrit
				));
			}
			return rollCache.get(key);
		};

		const fixture = {
			fixture: data.fixture,
			file,
			observations: data.observations.length,
			checked: 0,
			censored: 0,
			inBand: 0,
			typeDrift: [],
		};

		// The event names each side's types. If the fork's species table disagrees,
		// every band for that side is computed off the wrong STAB and the in-band
		// number would be measuring the wrong thing.
		for (const side of ['A', 'B']) {
			const ours = monFor(side, '').types.join('/');
			const theirs = sides[side].types.join('/');
			if (ours !== theirs) {
				fixture.typeDrift.push(`${side} ${sides[side].species}: fork says ${ours}, ROM says ${theirs}`);
			}
		}

		for (const obs of data.observations) {
			if (obs.censored) {
				fixture.censored++;
				censored++;
				continue;
			}
			const band = bandFor(
				obs.attacker, obs.move, !!obs.crit_detected,
				statusOf(obs.attacker_status), statusOf(obs.defender_status)
			);
			fixture.checked++;
			checked++;
			if (band.includes(obs.damage)) {
				fixture.inBand++;
				inBand++;
			} else {
				misses.push({
					fixture: data.fixture,
					seed: obs.seed,
					turn: obs.turn,
					attacker: obs.attacker,
					move: obs.move,
					crit: !!obs.crit_detected,
					attackerStatus: statusOf(obs.attacker_status),
					damage: obs.damage,
					band: [...new Set(band)].sort((a, b) => a - b),
				});
			}
		}
		fixtures.push(fixture);
	}

	return {
		dir: dir || FIDELITY_DIR,
		files,
		fixtures,
		checked,
		censored,
		inBand,
		misses,
		percent: checked ? (100 * inBand) / checked : 0,
	};
}

/** The worst offenders, grouped: 400 misses of one move is one bug, not 400. */
function groupMisses(misses) {
	const groups = new Map();
	for (const miss of misses) {
		const key = [miss.fixture, miss.attacker, miss.move, miss.crit ? 'crit' : 'normal', miss.attackerStatus].join('|');
		if (!groups.has(key)) groups.set(key, {key, count: 0, observed: new Set(), band: miss.band});
		const group = groups.get(key);
		group.count++;
		group.observed.add(miss.damage);
	}
	return [...groups.values()].sort((a, b) => b.count - a.count).map(g => ({
		key: g.key,
		count: g.count,
		observed: [...g.observed].sort((a, b) => a - b),
		band: g.band,
	}));
}

function report(result) {
	const lines = [];
	lines.push(`ROM band check — ${result.files.length} event files, ${result.dir}`);
	for (const fixture of result.fixtures) {
		const pct = fixture.checked ? ((100 * fixture.inBand) / fixture.checked).toFixed(2) : '0.00';
		lines.push(`  ${fixture.fixture}: ${fixture.inBand}/${fixture.checked} in band (${pct}%), ${fixture.censored} censored`);
		for (const drift of fixture.typeDrift) lines.push(`    TYPE DRIFT ${drift}`);
	}
	lines.push(`total: ${result.inBand}/${result.checked} in band (${result.percent.toFixed(2)}%), ${result.censored} censored`);
	if (result.misses.length) {
		lines.push('worst offenders:');
		for (const group of groupMisses(result.misses).slice(0, 10)) {
			lines.push(`  ${group.count}x ${group.key}`);
			lines.push(`    observed {${group.observed.join(',')}} not in {${group.band.join(',')}}`);
		}
	}
	return lines.join('\n');
}

module.exports = {
	FIDELITY_DIR,
	EXPECTED_EVENT_FILES,
	EXPECTED_MIN_OBSERVATIONS,
	GENERATION,
	buildMon,
	checkBands,
	groupMisses,
	report,
};

if (require.main === module) {
	const result = checkBands();
	if (process.argv.includes('--json')) {
		process.stdout.write(JSON.stringify({...result, grouped: groupMisses(result.misses)}, null, '\t') + '\n');
	} else {
		process.stdout.write(report(result) + '\n');
	}
	if (result.files.length !== EXPECTED_EVENT_FILES || result.checked < EXPECTED_MIN_OBSERVATIONS) {
		process.stdout.write(
			`corpus incomplete: expected ${EXPECTED_EVENT_FILES} event files and at least ` +
			`${EXPECTED_MIN_OBSERVATIONS} scored observations, got ${result.files.length} and ${result.checked}\n`
		);
		process.exitCode = 1;
	} else if (result.misses.length) {
		process.exitCode = 1;
	}
}
