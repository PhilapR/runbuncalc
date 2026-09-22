/* eslint-env node, es6 */
'use strict';

/**
 * The ROM AI-probe gate.
 *
 * `profiles/run-and-bun/fidelity/ai-probes/` carries 85 positions in which the
 * real Run & Bun trainer AI chose a move over 20 pinned seeds, read out of the
 * running ROM by the pykemon harness (provenance in that directory's README).
 * `scripts/replay-ai-probes.js` rebuilds each position and asks the enemy
 * policy the battle driver plays for its exact choice distribution.
 *
 * THE FLOORS BELOW ARE A REGRESSION FLOOR, NOT A QUALITY BAR. They are the
 * values measured on 2026-09-22, when this engine was graded against the ROM
 * for the first time, and they are far from the ROM: Splash and Celebrate
 * score the +6 status default where the ROM reads 81, setup moves are off by
 * 3 to 27 points, and an all-immune moveset picks Splash. rab's probe-fitted
 * scoring reaches held-out top-1 0.972 and TVD 0.053 on the same 12 held-out
 * probes (pokemon-mono 1ecc0e3); here it is 0.833 and 0.428. A change that
 * makes the numbers better passes and should raise the floors. A change that
 * makes them worse fails.
 *
 * Reference and held-out are gated apart: the reference probes include the
 * set rab's rules were fitted to, the held-out ones are out of sample for both
 * engines.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const replay = require('../scripts/replay-ai-probes.js');

/**
 * First measured 2026-09-22 (0.8449 / 0.3324 / 0.6119 and 0.8333 / 0.4278 / 0.5417),
 * raised after each ROM rule landed on fix/ai-scoring. Rounded toward passing.
 * Now: recovery penalties add to +5 (0.9259 / 0.0466 / 0.9216 and 0.9722 / 0.0194 / 0.9167).
 */
const FLOORS = {
	reference: {n: 72, top1: 0.925, tvd: 0.047, scoreMatch: 0.921},
	heldout: {n: 12, top1: 0.972, tvd: 0.02, scoreMatch: 0.916},
};

const result = replay.gradeAll();

test('every vendored probe is graded or named, none skipped in silence', () => {
	assert.equal(result.files, 85);
	assert.deepEqual(result.excluded.map(e => e.probe), ['p6-slot1-artifact-check']);
	assert.deepEqual(result.unsupported, []);
	assert.equal(result.graded.length, 84);
});

for (const cohort of Object.keys(FLOORS)) {
	test(`${cohort} probes: choice agreement with the ROM does not regress`, () => {
		const floor = FLOORS[cohort];
		const got = result.pooled[cohort];
		assert.equal(got.n, floor.n, `${cohort} probe count`);
		assert.ok(got.top1 >= floor.top1, `${cohort} top-1 ${got.top1} fell below ${floor.top1}`);
		assert.ok(got.tvd <= floor.tvd, `${cohort} mean TVD ${got.tvd} rose above ${floor.tvd}`);
		assert.ok(got.scoreMatch >= floor.scoreMatch,
			`${cohort} score-set match ${got.scoreMatch} fell below ${floor.scoreMatch}`);
	});
}

test('the exact distribution is the one chooseAction samples', () => {
	// The replay enumerates the joint roll product instead of sampling. This
	// replays the chooser itself so the enumeration cannot drift from it.
	for (const doc of replay.loadProbes()) {
		if (replay.EXCLUDED[doc.probe]) continue;
		const graded = replay.gradeProbe(doc, {sampleDraws: 4000});
		assert.ok(graded.sampleTvd < 0.04, `${doc.probe}: sampled vs exact TVD ${graded.sampleTvd}`);
	}
});

test('every vendored trace matches the sha256 its README records', () => {
	const readme = fs.readFileSync(path.join(replay.PROBE_DIR, 'README.md'), 'utf8');
	const recorded = new Map();
	for (const line of readme.split('\n')) {
		const hit = line.match(/^([0-9a-f]{64}) {2}(\S+\.json)$/);
		if (hit) recorded.set(hit[2], hit[1]);
	}
	const files = fs.readdirSync(replay.PROBE_DIR).filter(f => f.endsWith('.json')).sort();
	assert.equal(files.length, 85);
	assert.deepEqual([...recorded.keys()].sort(), files);
	for (const file of files) {
		const digest = crypto.createHash('sha256')
			.update(fs.readFileSync(path.join(replay.PROBE_DIR, file))).digest('hex');
		assert.equal(digest, recorded.get(file), `${file} differs from the recorded sha256`);
	}
});
