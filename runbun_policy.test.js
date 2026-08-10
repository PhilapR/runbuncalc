/* eslint-env node, es6 */
'use strict';

/**
 * Profile conformance gate for the Run & Bun policy layer.
 *
 * `profiles/run-and-bun/policy.js` declares the game-specific tuning inside the
 * AI scoring model. `ai/src/scoring.ts` implements it. The engine does not read
 * from the profile yet, so this gate is what stops the two from drifting apart
 * — change one without the other and the build fails.
 *
 * Worth being precise about what this proves. It proves the declaration matches
 * the implementation. It does NOT prove either matches the game: these values
 * were transcribed from community documentation nobody here has read, and no
 * external source can corroborate opponent BEHAVIOUR the way dekzeh's data
 * corroborates content values. The profile tags them `transcribed` for that
 * reason, and this test asserts the tag has not been quietly promoted.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const scoring = require('./ai/dist/scoring.js');
const profile = require('./profiles').getProfile('run-and-bun');

test('the profile declares a policy layer', () => {
	assert.ok(profile.policy, 'run-and-bun profile has no policy layer');
	assert.ok(profile.policy.SCORE_ROLL, 'policy declares no score-roll weights');
	assert.ok(profile.policy.SETUP, 'policy declares no setup baselines');
});

test('score-roll probabilities match the scoring engine', () => {
	const roll = profile.policy.SCORE_ROLL;
	assert.equal(scoring.HIGH_SCORE_PROBABILITY, roll.highScoreProbability, 'high score probability');
	assert.equal(scoring.LOW_SCORE_PROBABILITY, roll.lowScoreProbability, 'low score probability');
	assert.equal(scoring.CRIT_BONUS_PROBABILITY, roll.critBonusProbability, 'crit bonus probability');
});

test('the score-roll weights form a distribution', () => {
	const roll = profile.policy.SCORE_ROLL;
	assert.equal(
		roll.highScoreProbability + roll.lowScoreProbability,
		1,
		'high and low score probabilities must sum to 1; they are the two outcomes of one roll'
	);
	for (const key of Object.keys(roll)) {
		assert.ok(roll[key] >= 0 && roll[key] <= 1, `${key} must be a probability, got ${roll[key]}`);
	}
});

test('setup baselines match the scoring engine', () => {
	const setup = profile.policy.SETUP;
	assert.equal(scoring.SETUP_BASE_SCORE, setup.baseScore, 'setup base score');
	assert.equal(scoring.SETUP_INCAPACITATED_BONUS, setup.incapacitatedBonus, 'setup incapacitated bonus');
});

test('policy provenance is not overstated', () => {
	// There is no published Run & Bun AI simulator, so nothing external can
	// corroborate these values. If this ever reads `source-of-truth`, either a
	// real authority appeared — in which case cite it in the profile's `sources`
	// — or someone promoted a guess.
	assert.equal(
		profile.provenanceOf('policy.SCORE_ROLL'),
		'transcribed',
		'policy values cannot be source-of-truth: no published AI simulator exists to check them against'
	);
	assert.equal(profile.provenanceOf('policy.SETUP'), 'transcribed');
});
