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
 *   oracle     — wild encounters, evolutions and learnsets, straight from the ROM
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
const oracle = require('./oracle.js');

module.exports = defineProfile({
	id: 'run-and-bun',
	name: 'Run & Bun',

	// Run & Bun is a Gen 8-mechanics game. It ports in Hisuian forms and
	// Legends: Arceus species, which are also Gen 8 content — earlier
	// investigation confirmed it ports no Generation 9 content.
	baseGeneration: 8,

	/**
	 * The game release this profile describes.
	 *
	 * 1.07 is the final version — the hack is finished, and any further release
	 * would be small bug fixes rather than content. That makes the ROM-verified
	 * layers durable rather than a snapshot: species, ability slots, and the move
	 * overlay were checked against the author's own data and will not silently
	 * fall out of date.
	 *
	 * Pinned anyway, because "verified against the author's data" is only a
	 * meaningful claim if the version that data describes is named.
	 */
	gameVersion: '1.07',
	gameVersionIsFinal: true,

	data,
	encounters,
	policy,

	/**
	 * Wild encounters, evolutions and learnsets, imported from the author's ROM
	 * decomp by `scripts/import-oracle.js`.
	 *
	 * This is the layer that turns the project from a calculator into a
	 * companion: it is what lets a catch be checked against the route it was
	 * claimed on, an evolution against the table, and a move against the
	 * learnset. Everything in it is the decomp's own data, transformed only by
	 * name mapping.
	 */
	oracle,

	/**
   * Rule deltas against stock Generation 8.
   *
   * Declarative here, implemented in `calc/src/mechanics/` and gated by
   * `calc/src/test/fork.test.ts`. This block is the readable statement of what
   * the game does differently; it is not yet what the engine branches on.
   */
	mechanics: {
		criticalHitMultiplier: 1.5,
		criticalHitChance: 1 / 16,
		magmaArmorBlocksCriticalHits: true,
		galeWingsRequiresFullHp: false,
		attractIsGenderIndependent: true,
		psychicTerrainUsesModernScaling: true,
		superFangType: 'Dark',
		covetType: 'Fairy',
		soulDewGrantsStages: true,
		// Audited against the game's own Mechanic Changes doc 2026-08-12; each
		// of these is implemented (ai/ or calc/) and was verified against that
		// doc rather than assumed from its base generation.
		evsRemoved: true,
		paralysisSpeedMultiplier: 0.25,
		terrainDamageBoost: 1.5,
		defogRemovesTerrain: false,
		sleepTurnsResetOnEntry: true,
		disguiseBreaksWithoutChipDamage: true,
		confusionBerriesRestoreHalfHpAtQuarter: true,
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
		// The move overlay (accuracy / base power / PP) was verified entry by entry
		// against the author's own ROM data dump: 166 checked, 166 in agreement.
		'data.MOVE_OVERLAY': 'source-of-truth',
		'data.ABILITY_SLOT_CHANGES': 'source-of-truth',
		// Generated from the decomp itself rather than read off it by hand, so the
		// mapping from ROM constant to calculator name is reviewable and the import
		// fails rather than dropping a row it cannot resolve.
		'oracle.encounters': 'source-of-truth',
		'oracle.evolutions': 'source-of-truth',
		'oracle.learnsets': 'source-of-truth',
		// What the oracle does not cover. A declared limit, not a claim about game
		// content: gifts, statics and trades are scripted and have no wild table.
		'oracle.LIMITS': 'observed',
		// The trainer parties are authored Run & Bun content with no upstream
		// equivalent, so no external source can corroborate them. They came from
		// the community-maintained calculator lineage this fork descends from.
		'encounters.INVARIANTS': 'transcribed',
		'encounters.KNOWN_GAPS': 'transcribed',
		'encounters.COVERAGE': 'transcribed',
		// The community AI document (Croven, crediting Dekzeh) is the best available
		// authority on opponent behaviour, and the transcription has been audited
		// against it rather than assumed faithful. SCORE_ROLL has since been
		// raised above that: the operator's pykemon harness read the AI's live
		// score array out of emulator RAM (0x02000360, u8[4], base 100; chosen
		// slot 0x02000391) across seeded cohorts and reproduced the 80/20 roll —
		// see ECOSYSTEM.json, pokemon-mono groundtruth/pykemon, traces/emu/probes.
		// SETUP remains transcription: no probe has exercised it yet.
		'policy.SCORE_ROLL': 'emulator-observed',
		'policy.SETUP': 'transcribed',
		// DOCUMENTED_SCORES and DOCUMENTED_SWITCH are deliberately not tagged.
		// They are the document's own text, quoted as the evidence for the two
		// claims above — not further claims about the game. Tagging them would
		// count one belief twice and make the project look less verified than it
		// is for the act of citing its sources.

		// Raised from transcription by the operator's emulator fidelity sweep:
		// 1,727 damage observations reproduce at 1727/1727 only with the crit
		// x1.5 applied before the roll — the Gen 6+ multiplier in the ROM's own
		// rounding order. See ECOSYSTEM.json: pokemon-mono contracts/cross-engine
		// fidelity corpus and groundtruth/pykemon.
		'mechanics.criticalHitMultiplier': 'emulator-observed',
		// Corroborated by the author's own in-ROM ability text. Vanilla Magma Armor
		// reads "Prevents freezing."; Run & Bun's reads "Blocks criticals and
		// freeze." Vanilla Gale Wings gives Flying priority only at full HP; Run &
		// Bun's reads "Flying moves go first." with no HP condition.
		'mechanics.magmaArmorBlocksCriticalHits': 'source-of-truth',
		'mechanics.galeWingsRequiresFullHp': 'source-of-truth',
		// Named outright by the official doc ("Status condition not limited by
		// gender"); the engine omits the gender gate deliberately and the
		// legality fixtures pin same-gender Attract working.
		'mechanics.attractIsGenderIndependent': 'source-of-truth',
		'mechanics.psychicTerrainUsesModernScaling': 'transcribed',
		'mechanics.superFangType': 'source-of-truth',
		'mechanics.covetType': 'source-of-truth',
		// The game's own documentation dump (official-docs source below) states
		// each of these outright; the implementations were audited against it.
		'mechanics.criticalHitChance': 'emulator-observed',
		'mechanics.evsRemoved': 'source-of-truth',
		'mechanics.paralysisSpeedMultiplier': 'source-of-truth',
		'mechanics.terrainDamageBoost': 'source-of-truth',
		'mechanics.defogRemovesTerrain': 'source-of-truth',
		'mechanics.sleepTurnsResetOnEntry': 'source-of-truth',
		'mechanics.disguiseBreaksWithoutChipDamage': 'source-of-truth',
		'mechanics.confusionBerriesRestoreHalfHpAtQuarter': 'source-of-truth',
		// "Soul Dew: Boosts Latias and Latios SpA/SpD by one stage" — and the
		// calc fork implements it as literal stages (clamped, clone-safe,
		// composing with Calm Mind and ignored by crits like any stage).
		'mechanics.soulDewGrantsStages': 'source-of-truth',
		// Growth rates ride the same decomp import as the other oracle layers —
		// this row was simply missing, which the registry's own rules call
		// 'inferred' by default and which it never was.
		'oracle.growth': 'source-of-truth',
		// Route availability, encounter-method gates and the HM teach gates:
		// the operator's rab curation, translated through name-matched anchors
		// (late-biased, never early — see scripts/import-availability.js).
		'oracle.availability': 'transcribed',
		// Per-fight permanent fields, from rab's location annotations plus the
		// official doc's overworld weather rules.
		'oracle.fightFields': 'transcribed',
		// The 23-row level-cap ladder, row for row from the official doc.
		'encounters.LEVEL_CAPS': 'source-of-truth',
	},

	sources: {
		'source-of-truth': 'https://github.com/dekzeh/calc',
		// The author's pokeemerald-format data dump. Unlike the calculator, it
		// carries per-move accuracy and PP, which is what made the move overlay
		// verifiable at all.
		'source-of-truth-rom-data': 'https://github.com/dekzeh/runandbundex',
		// `abilities/abilities.h` in that dump carries the in-game ability text,
		// which the author edited where he changed an ability's behaviour.
		'source-of-truth-ability-text': 'https://github.com/dekzeh/runandbundex/blob/main/abilities/abilities.h',
		corroboration: 'https://github.com/SylmarDev/syl-rnb-calc',
		// The AI document the policy layer transcribes, mirrored byte-identically
		// in two independent repositories.
		'ai-document': 'https://github.com/beninburley/run_and_bun_calc — ai_logic.txt',
		// The game's own documentation dump: Mechanic Changes.txt (the level-cap
		// ladder and every mechanics delta above), Pokémon/Item Locations, the
		// AI document. One copy, in the operator's monorepo.
		'official-docs': 'PhilapR/pokemon-mono — docs/official/ (Run & Bun 1.07 documentation dump)',
		// The operator's own trainer/progression curation, source of the
		// availability, HM-gate and fight-field transcriptions. Claims about it
		// are registered with paths in ECOSYSTEM.json.
		'rab-curation': 'PhilapR/pokemon-mono — engines/rab/backend/src/data/',
	},
});
