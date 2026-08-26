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
 * The report was evidence for rebuilding the vendored artifact, not an input to
 * a runtime swap, and this gate holds that line. Forcing the engine's ability
 * would have restored 124 forecasts and made 72 of them wrong — Aron's Heavy
 * Metal becomes Sturdy, which survives any hit from full HP.
 * build-trainer-order-map already states the rule: a guess is worse than a gap.
 *
 * THE REPORT IS NOW EMPTY, AND THAT IS THE POINT. The vendored artifact was
 * rebuilt from a pokemon-mono revision carrying the fork's own
 * ABILITY_SLOT_CHANGES, so the two tables agree on all 1,244 comparable
 * species. So the assertion below is inverted from the one it replaced: this
 * file asserted `entries.length > 0` back when 124 species contradicted, and
 * kept asserting it after the fix, which is why it failed the moment it was
 * wired into the suite. An empty report is the fixed state; a non-empty one
 * means the pin regressed to a vanilla table and 24.3% of catches are about to
 * lose their forecast again.
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

test('the engine and the fork agree about every ability they can both name', () => {
	// What the upstream rebuild bought. Before it, 124 of 1,244 species shared
	// no ability at all, and the engine refuses any Pokemon whose ability it
	// does not recognise — 24.3% of the catches these logs record, each one
	// killing the fair-dice sample for every fight while it sat in the box.
	assert.equal(committed.contradicted, 0,
		'the vendored engine contradicts the fork again, so those species lose their forecast');
	assert.equal(committed.agreed, committed.comparable);
	assert.ok(committed.comparable > 1200,
		'far fewer species compared than expected — the engine table did not load');
});

test('an entry, if one ever appears, is a real contradiction with one answer', () => {
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
