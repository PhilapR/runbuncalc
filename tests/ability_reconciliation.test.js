/* eslint-env node, es6 */
'use strict';

/**
 * Gate for the fork-versus-engine ability divergence report.
 *
 * Both sides are pinned — the fork's calc data and the vendored engine bundle,
 * whose artifact hash PROVENANCE.json checks — so the map is computed once and
 * committed, and this rebuilds it and fails on drift. The same shape as
 * `tests/trainer_orders.test.js`, for the same reason: a committed derivation
 * that nothing recomputes is a number nobody can check.
 *
 * There is no reconciling to do and the report does not pretend otherwise. The
 * fork's data is marked `source-of-truth` in profiles/run-and-bun/index.js and
 * verified against the romhack's own species/base_stats.h; the engine ships a
 * vanilla table. One side is right.
 *
 * The report is evidence for rebuilding the vendored artifact, not an input to
 * a runtime swap, and this gate holds that line. Forcing the engine's ability
 * would restore 124 forecasts and make 72 of them wrong — Aron's Heavy Metal
 * becomes Sturdy, which survives any hit from full HP. build-trainer-order-map
 * already states the rule: a guess is worse than a gap.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const builder = require('../scripts/build-ability-reconciliation.js');
const committed = require('../profiles/run-and-bun/oracle/ability-reconciliation.json');

test('the committed map matches a fresh build of both pinned sides', () => {
	const fresh = builder.build();
	assert.equal(fresh.contradicted, committed.contradicted);
	assert.equal(fresh.comparable, committed.comparable);
	assert.equal(fresh.agreed, committed.agreed);
	assert.deepEqual(fresh.entries, committed.entries,
		'the map drifted from its sources — rebuild it and read the diff before committing');
});

test('every entry is a real contradiction, and the engine offers one answer', () => {
	assert.ok(committed.entries.length > 0);
	for (const entry of committed.entries) {
		assert.ok(entry.fork.length && entry.engine.length, entry.species);
		// An entry exists only when NOTHING overlaps. One shared ability and the
		// engine would accept ours, so there would be nothing to reconcile.
		for (const ability of entry.fork) {
			assert.ok(!entry.engine.includes(ability),
				entry.species + ' shares ' + ability + ' — it does not belong in this map');
		}
		// The engine lists exactly one, which is what makes the substitute
		// forced rather than chosen. If that ever stops being true the map has
		// a decision in it and needs a rule for making it.
		assert.equal(entry.engine.length, 1,
			entry.species + ' has ' + entry.engine.length + ' engine abilities — the ' +
			'report assumes the engine offers exactly one');
		assert.equal(entry.engineWouldForce, entry.engine[0]);
	}
});

test('the report is evidence only — nothing swaps an ability behind a forecast', () => {
	// The measurement that makes this a decision rather than an oversight: 42%
	// of the engine's answers cannot move a damage number, and the rest can.
	// Wiring it in would trade a missing forecast for a wrong one on the 72.
	// The fix is one table, upstream, not a swap here.
	const entry = path.join(__dirname, '..', 'scripts', 'entries', 'pokemon-provider-entry.mjs');
	const source = fs.readFileSync(entry, 'utf8');
	assert.doesNotMatch(source, /ability-reconciliation/,
		'the provider entry must not silently swap abilities: for 72 of the 124 the ' +
		'engine\'s answer changes a damage calculation, and a confidently wrong ' +
		'forecast is worse than an absent one');
});
