/* eslint-env node, es6 */
'use strict';

/**
 * The ROM band gate.
 *
 * `profiles/run-and-bun/fidelity/` carries 1,727 damage observations captured
 * from the running Run & Bun ROM by an emulator that has never read this code
 * (provenance in that directory's README). This gate rebuilds each fixture with
 * the stats the sweep injected and asserts every observed damage value is one
 * of the 16 rolls this calculator predicts — a membership test in the discrete
 * value set, not a range check, so a wrong rounding ORDER fails it too.
 *
 * That external-ness is the whole point. Every other conformance gate here
 * compares this repository against itself, and a value that is wrong in both
 * places passes all of them. This one cannot be satisfied by agreeing with
 * ourselves.
 *
 * Measured 2026-08-11: 1,727/1,727 = 100.00%. The synthesis predicted a
 * residual from pokeRound-vs-floor on the STAB stage; there is none — this
 * fork's Gen 8 path already floors in the ROM's order, including the ×1.5 crit
 * applied BEFORE the roll rather than to the finished roll. So the assertion
 * below is zero misses, not a measured floor. If a change makes it 99.9%, that
 * is a regression to fix, not a threshold to lower.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const band = require('../scripts/rom-band-check.js');

const result = band.checkBands();

test('the corpus is present and whole', () => {
	// Pinned counts, copied from rab's harness. An empty directory produces zero
	// assertions and every other test in this file passes vacuously — "checked 0
	// observations" reads as green. These two lines are what make a vanished or
	// truncated corpus fail instead.
	assert.equal(result.files.length, band.EXPECTED_EVENT_FILES, 'event files in the fidelity corpus');
	assert.ok(
		result.checked >= band.EXPECTED_MIN_OBSERVATIONS,
		`scored observations: expected at least ${band.EXPECTED_MIN_OBSERVATIONS}, checked ${result.checked}`
	);
	assert.equal(result.censored, 67, 'censored observations, skipped because the defender fainted');
});

test('the fork types every fixture side the way the ROM does', () => {
	// STAB and effectiveness come off these. If they drift, the in-band number
	// is measuring a different Pokémon and means nothing.
	const drift = result.fixtures.flatMap(f => f.typeDrift);
	assert.deepEqual(drift, [], 'species type drift against the ROM');
});

test('every observed damage value is a roll this calculator predicts', () => {
	if (result.misses.length) {
		// Grouped: 400 misses of one move is one bug, not 400.
		console.log(band.report(result));
	}
	assert.equal(
		result.misses.length, 0,
		`${result.inBand}/${result.checked} in band (${result.percent.toFixed(2)}%)`
	);
	assert.equal(result.percent, 100);
});

test('each fixture is graded, not just the corpus as a whole', () => {
	// A single fixture carrying every observation would satisfy the totals above
	// while two thirds of the evidence sat unread.
	assert.equal(result.fixtures.length, 3);
	for (const fixture of result.fixtures) {
		assert.ok(fixture.checked > 100, `${fixture.fixture}: only ${fixture.checked} observations checked`);
		assert.equal(fixture.inBand, fixture.checked, `${fixture.fixture}: out-of-band observations`);
	}
});

test('the crit band is a claim of its own', () => {
	// 94 crits, and not one of them lands in the non-crit band. So folding the
	// two bands into a union — which is how a harness accidentally stops testing
	// the crit multiplier — would be caught here rather than passing silently.
	// The corpus's stated convention, floor(roll × 1.5), only accounts for 59 of
	// the 94; the ROM applies the multiplier before the roll, and so do we.
	const calc = require('@smogon/calc');
	const gen = calc.Generations.get(band.GENERATION);
	const fs = require('node:fs');
	const path = require('node:path');

	let crits = 0;
	let passingAsNormal = 0;
	for (const file of result.files) {
		const data = JSON.parse(fs.readFileSync(path.join(band.FIDELITY_DIR, file), 'utf8'));
		for (const obs of data.observations) {
			if (obs.censored || !obs.crit_detected) continue;
			crits++;
			const attacker = band.buildMon(data.sides[obs.attacker], (obs.attacker_status || [])[0] || '');
			const defender = band.buildMon(data.sides[obs.attacker === 'A' ? 'B' : 'A'], (obs.defender_status || [])[0] || '');
			const rolls = calc.calculate(gen, attacker, defender, new calc.Move(gen, obs.move)).damage;
			if (rolls.includes(obs.damage)) passingAsNormal++;
		}
	}
	assert.equal(crits, 94, 'detected crits in the corpus');
	assert.equal(passingAsNormal, 0, 'crit observations that would also pass as non-crit rolls');
});
