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

test('the policy cites the document it transcribes', () => {
	// "The AI doc" is an unresolvable reference. Naming the document, its author
	// and a checksum tells a later reader exactly which text to compare against.
	const doc = profile.policy.SOURCE_DOCUMENT;
	assert.match(doc.title, /Run and Bun/);
	assert.equal(doc.author, 'Croven');
	assert.ok(doc.mirrors.length >= 2, 'a single mirror is a single point of failure');
	assert.match(doc.md5AfterNewlineNormalisation, /^[0-9a-f]{32}$/);
});

test('the score roll matches the documented +6/+8 spread', () => {
	// Document: "Highest damaging move: +6 (80%), +8 (20%)". The engine expresses
	// this as a base score plus a +2 raise on the high roll, so the spread must
	// be exactly two points and the weights must match.
	const doc = profile.policy.DOCUMENTED_SCORES.highestDamagingMove;
	assert.equal(doc.high - doc.low, 2, 'the documented raise is +2');
	assert.equal(scoring.LOW_SCORE_PROBABILITY, 0.8);
	assert.equal(scoring.HIGH_SCORE_PROBABILITY, 0.2);
	// The base a non-damaging move starts from is the same +6 the document gives
	// the highest damaging move — it says they are tied.
	assert.equal(scoring.SETUP_BASE_SCORE, doc.low);
});

test('kill bonuses derive from the documented slow and fast kill scores', () => {
	// Document: slow kill +9, fast kill +12, against a +6 highest-damage base.
	// So the engine's speed bonuses must be exactly +3 and +6. These are the
	// numbers a player uses to decide whether they get KO'd first.
	const docs = profile.policy.DOCUMENTED_SCORES;
	const base = docs.highestDamagingMove.low;
	assert.equal(docs.slowKill.low - base, 3, 'slow kill is +3 over base');
	assert.equal(docs.fastKill.low - base, 6, 'fast kill is +6 over base');
	// Both roll the same +2 as everything else.
	assert.equal(docs.slowKill.high - docs.slowKill.low, 2);
	assert.equal(docs.fastKill.high - docs.fastKill.low, 2);
});

test('the documented switch routine matches the engine', () => {
	// Document: switching needs every move ineffective (score <= -5), the active
	// above 50% health, and then a 50% roll — Singles only.
	const fs = require('node:fs');
	const source = fs.readFileSync(
		require('node:path').join(__dirname, 'ai', 'src', 'switch.ts'), 'utf8');
	const doc = profile.policy.DOCUMENTED_SWITCH;

	assert.match(
		source,
		new RegExp(`<=\\s*${doc.ineffectiveThreshold}`),
		`switch.ts should gate on score <= ${doc.ineffectiveThreshold}`
	);
	assert.match(
		source,
		/SWITCH_PROBABILITY\s*=\s*0\.5/,
		'the documented switch roll is 50%'
	);
	// "not below 50% health" is expressed as hp*2 >= max to stay integer-exact.
	assert.match(source, /hp\.current \* 2 >= .*hp\.max/, 'the 50% health floor');
	assert.match(source, /mode === 'Singles'/, 'the routine is Singles-only');
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
