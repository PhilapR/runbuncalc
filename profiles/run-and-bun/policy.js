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

/**
 * The document this policy transcribes.
 *
 * "Pokemon Run and Bun (1.07) AI document", by Croven, crediting Dekzeh among
 * others. Two independent GitHub mirrors carry it byte-identically after
 * newline normalisation, which is why the checksum is recorded: it identifies
 * *which* document a later reader should compare against, rather than leaving
 * "the AI doc" as an unresolvable reference.
 *
 * It stays `transcribed`, not `source-of-truth`. It is a community document —
 * careful, credited, and the best available, but not the author's own
 * publication the way the ROM dump is. What changed is that the transcription
 * has now been audited against it rather than merely assumed faithful.
 *
 * `runbun_policy.test.js` pins the values below to the document's stated
 * numbers so the implementation cannot drift from the text it claims to encode.
 */
const SOURCE_DOCUMENT = {
	title: 'Pokemon Run and Bun (1.07) AI document',
	author: 'Croven',
	mirrors: [
		'github.com/beninburley/run_and_bun_calc — ai_logic.txt',
		'github.com/beninburley/nuzlocke_finder — public/run&bunAI.txt',
	],
	md5AfterNewlineNormalisation: '4e1bbd283d8189c58e049753d7a9d96f',
};

/**
 * Documented score outcomes, quoted so the gate can assert against the text.
 *
 * Straight from the document's "Common scores to be aware of" table. The AI
 * rolls: mostly the low score, sometimes two points higher.
 */
const DOCUMENTED_SCORES = {
	/** "Highest damaging move: +6 (80%), +8 (20%)" */
	highestDamagingMove: {low: 6, high: 8},
	/** "Slow kill (AI kills but is slower than target): +9 (80%), +11 (20%)" */
	slowKill: {low: 9, high: 11},
	/** "Fast kill (AI kills and is faster than target): +12 (80%), +14 (20%)" */
	fastKill: {low: 12, high: 14},
	/** "AI sees speed ties as them being faster than the player" */
	speedTiesCountAsFaster: true,
	/** Moxie / Beast Boost / Chilling Neigh / Grim Neigh: "Additional +1" */
	koBoostAbilityBonus: 1,
};

/** The documented hard-switch routine, Singles only. */
const DOCUMENTED_SWITCH = {
	/** "the AI must only be able to use ineffective moves (score <= -5)" */
	ineffectiveThreshold: -5,
	/** "the AI mon must not be below 50% health already" */
	minimumHealthFraction: 0.5,
	/** "then the AI has a 50% chance to switch" */
	switchProbability: 0.5,
	/** "In Double Battles, the AI never switches unless in niche situations" */
	singlesOnly: true,
};

module.exports = {KIND, SCORE_ROLL, SETUP, SOURCE_DOCUMENT, DOCUMENTED_SCORES, DOCUMENTED_SWITCH};
