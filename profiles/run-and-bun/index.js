/* eslint-env node, es6 */
'use strict';

/**
 * Run & Bun — a Pokémon Emerald difficulty hack by dekzeh, on Generation 8
 * mechanics.
 *
 * This is the reference profile: the first game described through the profile
 * contract, and the worked example for adding another. See `profiles/README.md`
 * for the layering model.
 *
 * Layers filled today:
 *   data       — species / item deltas
 *   mechanics  — declared, and cross-referenced to where each rule lives
 *   encounters — shape and invariants of the authored trainer run map
 *
 *   policy     — score-roll weights and setup baselines used by the AI
 *
 * All four layers are declared. Two are load-bearing: `data` is read by the
 * conformance gate, and `encounters` invariants are asserted against the run
 * map. `mechanics` and `policy` are declared and gated for drift, but the
 * engine does not yet read from them — that inversion is the remaining work,
 * and saying so is better than implying a seam that is not carrying weight.
 */

const defineProfile = require('../profile.js').defineProfile;
const data = require('./data.js');
const encounters = require('./encounters.js');
const policy = require('./policy.js');

module.exports = defineProfile({
	id: 'run-and-bun',
	name: 'Run & Bun',

	// Run & Bun is a Gen 8-mechanics game. It ports in Hisuian forms and
	// Legends: Arceus species, which are also Gen 8 content — earlier
	// investigation confirmed it ports no Generation 9 content.
	baseGeneration: 8,

	data,
	encounters,
	policy,

	/**
   * Rule deltas against stock Generation 8.
   *
   * Declarative here, implemented in `calc/src/mechanics/` and gated by
   * `calc/src/test/fork.test.ts`. This block is the readable statement of what
   * the game does differently; it is not yet what the engine branches on.
   */
	mechanics: {
		criticalHitMultiplier: 1.5,
		magmaArmorBlocksCriticalHits: true,
		galeWingsRequiresFullHp: false,
		attractIsGenderIndependent: true,
		psychicTerrainUsesModernScaling: true,
		superFangType: 'Dark',
		covetType: 'Fairy',
	},

	/**
   * How each claim above is known.
   *
   * Reconciled one time against `dekzeh/calc` — the hack author's own
   * calculator — and corroborated against `SylmarDev/syl-rnb-calc` where they
   * overlap. `calc/src/data/` species, items and abilities are byte-identical
   * to the author's data; moves differ only by this fork's own additions.
   *
   * The mechanics entries are weaker. They were transcribed from community
   * documentation (`MECHANICS.MD`) that is not in this repository and that
   * nobody working on the project has read. They are implemented and regression
   * tested, so they are stable — but stability is not correctness, and they are
   * tagged for what they are.
   */
	provenance: {
		'data.BASE_STAT_CHANGES': 'source-of-truth',
		'data.NOT_FULLY_EVOLVED': 'source-of-truth',
		'data.PORTED_SPECIES': 'source-of-truth',
		'data.REMOVED_ITEMS': 'source-of-truth',
		// The trainer parties are authored Run & Bun content with no upstream
		// equivalent, so no external source can corroborate them. They came from
		// the community-maintained calculator lineage this fork descends from.
		'encounters.INVARIANTS': 'transcribed',
		// No published Run & Bun AI simulator exists, so nothing external can
		// corroborate opponent behaviour. Only in-game observation can raise these.
		'policy.SCORE_ROLL': 'transcribed',
		'policy.SETUP': 'transcribed',
		'mechanics.criticalHitMultiplier': 'transcribed',
		'mechanics.magmaArmorBlocksCriticalHits': 'transcribed',
		'mechanics.galeWingsRequiresFullHp': 'transcribed',
		'mechanics.attractIsGenderIndependent': 'transcribed',
		'mechanics.psychicTerrainUsesModernScaling': 'transcribed',
		'mechanics.superFangType': 'source-of-truth',
		'mechanics.covetType': 'source-of-truth',
	},

	sources: {
		'source-of-truth': 'https://github.com/dekzeh/calc',
		corroboration: 'https://github.com/SylmarDev/syl-rnb-calc',
	},
});
