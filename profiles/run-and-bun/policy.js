/* eslint-env node, es6 */
'use strict';

/**
 * Run & Bun — policy layer (L3).
 *
 * The opponent-decision model: what the in-game AI does with a turn. This is
 * the layer that makes the project more than a damage calculator, and it is the
 * one with no external authority to check against — dekzeh publishes a
 * calculator, not an AI simulator.
 *
 * That has a consequence worth stating rather than burying. For content values,
 * the source of truth is the hack author's own data, and the reconciliation is
 * complete. For BEHAVIOUR there is no equivalent: these numbers were transcribed
 * from community documentation (`run_and_bun_ai.MD`) that is not in this
 * repository. They are implemented and covered by ~60 fixtures, but those
 * fixtures assert the engine does what the engine says — not that either matches
 * the game. Only observation can raise these above `transcribed`.
 *
 * The scoring logic lives in `ai/src/scoring.ts`. This module declares the
 * game-specific tuning inside it; `runbun_policy.test.js` asserts the two agree.
 * The engine does not yet read from here — that inversion is the next step, and
 * until it happens the gate is what keeps them from drifting apart.
 */

/**
 * Score-roll probabilities.
 *
 * The Run & Bun AI does not pick deterministically: a candidate move's score is
 * rolled, most often low and sometimes high. Those weights decide how often the
 * AI takes its second-best option, which is exactly the behaviour a player is
 * trying to predict when planning a fight.
 */
const SCORE_ROLL = {
	/** Chance of the raised score outcome. */
	highScoreProbability: 0.2,
	/** Chance of the base score outcome. */
	lowScoreProbability: 0.8,
	/** Chance the AI counts a critical hit when weighing a move. */
	critBonusProbability: 0.5,
};

/** Baseline scores a setup move starts from, before situational modifiers. */
const SETUP = {
	baseScore: 6,
	/** Added when the defender cannot act — asleep, frozen, or otherwise stuck. */
	incapacitatedBonus: 3,
};

/**
 * How this policy decides, not just what it decides with.
 *
 * Run & Bun scores candidate moves and rolls. Other games script decision trees,
 * and some use the vanilla AI unchanged — so a consumer must be able to ask what
 * kind of policy it was handed rather than assuming scoring. Declaring it now
 * costs a line; retrofitting it once a second game exists means changing every
 * caller that guessed.
 */
const KIND = 'scoring';

module.exports = {KIND, SCORE_ROLL, SETUP};
