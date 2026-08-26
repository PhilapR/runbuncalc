/* eslint-env node, es6 */
'use strict';

/**
 * Gate for the declared rule deltas.
 *
 * `profiles/run-and-bun/index.js` carries a `mechanics` block: the readable
 * statement of what this hack does differently from stock Generation 8, twelve
 * of whose entries are tagged `source-of-truth` — the highest provenance tier
 * the profile has. Its own docblock is honest about the gap: "it is not yet
 * what the engine branches on."
 *
 * That gap has a cost, and the cost was paid. `attractIsGenderIndependent` is
 * a declared, sourced, audited rule; the engine implements it; and an agent
 * read the missing gender check in `ai/src/eligibility.ts` as an oversight and
 * "fixed" it. Two fixtures went red, which is the system working — but they
 * read as fixtures that had locked in a bug, because nothing on that code path
 * or in those fixtures pointed back at the declaration. The change was made,
 * committed, and reverted (`dedb4d0`).
 *
 * So this file exists to make the declaration load-bearing: for every flag it
 * can drive, it asks the ENGINE and compares against the PROFILE, and names
 * the flag when it disagrees. A deviation from mainline stops being something
 * you have to already know about and becomes something a test says out loud.
 *
 * Two rules keep it honest as it grows:
 *
 *   - a flag is either CHECKED here or listed in PENDING with a reason. The
 *     last assertion is that those two sets together are exactly the declared
 *     block, so a new mechanic cannot be added without deciding which it is,
 *     and the unchecked set can never quietly grow.
 *   - PENDING is not a to-do list of things nobody got to. Several of these
 *     are already gated elsewhere — the calculator overlays in
 *     `calc/src/test/fork.test.ts`, infatuation in
 *     `ai/src/test/volatile-legality.test.ts` — and what is missing is the
 *     link from the FLAG to that gate, not the gate.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const ai = require('../ai');
const planner = require('../lib/planner');
const profile = require('../profiles').getProfile('run-and-bun');

const IVS = {hp: 17, atk: 18, def: 19, spa: 20, spd: 21, spe: 22};

/** A real fight state, so the assertions run through the same construction the
 * product uses rather than a hand-built object that could drift from it. */
function stateWith(species, level) {
	return planner.buildFightState({
		trainer: 'Youngster Calvin',
		profileId: 'run-and-bun',
		playerParty: [{
			species: species || 'Piplup', level: level || 50, nature: 'Hardy',
			moves: ['Pound'], ivs: Object.assign({}, IVS),
		}],
	}).state;
}

/**
 * Flags whose implementation is driven directly below. The key is the profile
 * key; the value is what the engine has to agree with.
 */
const CHECKED = [
	'attractIsGenderIndependent',
	'evsRemoved',
	'superFangType',
	'covetType',
	'paralysisSpeedMultiplier',
];

/**
 * Flags this file does not yet drive, each with the reason. Splitting these by
 * WHY they are absent matters: a rule gated in the calculator needs a link,
 * and a rule gated nowhere needs a test.
 */
const PENDING = {
	criticalHitMultiplier: 'calculator overlay; gated by calc/src/test/fork.test.ts',
	criticalHitChance: 'calculator overlay; gated by calc/src/test/fork.test.ts',
	magmaArmorBlocksCriticalHits: 'calculator overlay; gated by calc/src/test/fork.test.ts',
	soulDewGrantsStages: 'calculator overlay; gated by calc/src/test/fork.test.ts',
	psychicTerrainUsesModernScaling: 'calculator overlay; gated by calc/src/test/fork.test.ts',
	terrainDamageBoost: 'calculator overlay; gated by calc/src/test/fork.test.ts',
	galeWingsRequiresFullHp: 'priority path; no flag-linked gate yet',
	defogRemovesTerrain: 'field cleanup path; no flag-linked gate yet',
	sleepTurnsResetOnEntry: 'switch-in path; no flag-linked gate yet',
	disguiseBreaksWithoutChipDamage: 'ability path; no flag-linked gate yet',
	confusionBerriesRestoreHalfHpAtQuarter: 'item path; no flag-linked gate yet',
};

test('Attract ignores gender here, because the profile says it does', () => {
	// The rule that was "fixed" and should not have been. Run & Bun makes
	// Attract gender-independent: docs/AI_DATA_MODEL.md states it twice, the
	// DECISIONS ruling `soul-dew-and-infatuation-verified` closed it on
	// 2026-08-12 without changing code, and the flag below is source-of-truth.
	assert.equal(profile.mechanics.attractIsGenderIndependent, true,
		'this gate is written for the gender-independent rule');

	const state = stateWith();
	const attacker = state.sides.ai.party[0];
	const target = state.sides.player.party[0];
	attacker.moves = [{name: 'Attract'}];

	for (const pair of [['M', 'M'], ['F', 'F'], ['M', undefined], ['N', 'F']]) {
		attacker.gender = pair[0];
		target.gender = pair[1];
		const why = `${pair[0]} -> ${pair[1] || 'unknown'}`;
		assert.equal(
			ai.enumerateMoveActions(state, 'ai').some(action => action.moveName === 'Attract'),
			true, `mechanics.attractIsGenderIndependent: Attract must enumerate for ${why}`);
		assert.equal(
			ai.canApplyVolatile(state, target.id, 'infatuated', attacker.id, true, 'Status'),
			true, `mechanics.attractIsGenderIndependent: infatuation must apply for ${why}`);
	}

	// Gender-independent is not immunity-independent: the ordinary blockers
	// still hold, which is the half of the rule that is easy to lose while
	// "fixing" the other half.
	target.gender = 'F';
	attacker.gender = 'M';
	target.volatile = {infatuated: {}};
	assert.equal(ai.canApplyVolatile(state, target.id, 'infatuated', attacker.id, true, 'Status'),
		false, 'an already-infatuated target is still refused');
	target.volatile = {};
	target.ability = 'Oblivious';
	assert.equal(ai.canApplyVolatile(state, target.id, 'infatuated', attacker.id, true, 'Status'),
		false, 'Oblivious still blocks');
});

test('the gender nobody authors is inert, and a tripwire for the day it is not', () => {
	// Nothing in this project authors a gender. `rollIdentity` rolls six IVs, a
	// nature and an ability and stops there; `partySpecs` forwards those and no
	// gender; and the vendored calculator fills the hole at `calc/src/pokemon.ts`
	// with `options.gender || this.species.gender || 'M'`. In the web UI that
	// 'M' is a default a user overrides in the form. Nothing overrides it here,
	// so every Pokemon on both sides is male, female-only species included.
	//
	// That is survivable only because no rule this run can reach reads a gender.
	// Infatuation is gender-independent by declared rule — the test above — which
	// accounts for Attract and for Cute Charm, whose engine path defers to
	// `canApplyVolatile` and inherits the same ruling. That leaves Rivalry and
	// Captivate, and neither appears anywhere in the run map.
	//
	// So this gate does not assert that the gender is right. It asserts that
	// nothing consumes it, which is the only reason a fabricated one is safe.
	// Content that adds a Rivalry holder or a Captivate user would be priced
	// against a fabrication: Rivalry would read same-gender every time and take
	// its 1.25x unconditionally, and Captivate, which needs opposing genders,
	// would never fire at all. Both fail silently and in a direction a forecast
	// cannot see. If this test goes red, author a real gender before the content
	// lands — do not relax the assertion.
	const fights = planner.listFights('run-and-bun').fights;
	const rivalry = [];
	const captivate = [];
	let scanned = 0;
	for (const fight of fights) {
		for (const mon of fight.party || []) {
			scanned += 1;
			if (/^rivalry$/i.test((mon.ability || '').replace(/\s+/g, ''))) {
				rivalry.push(`${fight.trainer} / ${mon.species}`);
			}
			if ((mon.moves || []).some(move => /^captivate$/i.test(String(move).replace(/\s+/g, '')))) {
				captivate.push(`${fight.trainer} / ${mon.species}`);
			}
		}
	}

	// A scan that reaches nothing would pass both assertions below while proving
	// nothing, which is the exact shape of gate this repo has been bitten by.
	assert.ok(scanned > 1500,
		`the scan must actually reach the run map; it saw ${scanned} Pokemon`);
	assert.deepEqual(rivalry, [],
		'Rivalry reads gender, and every gender here is fabricated M');
	assert.deepEqual(captivate, [],
		'Captivate needs opposing genders, and every gender here is fabricated M');

	// The premise itself: a female-only species still builds male. When this
	// stops being true somebody has authored a gender, and the reasoning above
	// needs revisiting rather than the assertion loosening.
	const built = planner.buildFightState({
		profileId: 'run-and-bun',
		trainer: fights[0].trainer,
		playerParty: [{species: 'Miltank', level: 20, moves: ['Tackle'], ivs: IVS}]
	});
	assert.equal(built.state.sides.player.party[0].gender, 'M',
		'Miltank is female-only and still builds male: nothing authors a gender');
});

test('EVs are removed, so every build is a zero-EV build', () => {
	assert.equal(profile.mechanics.evsRemoved, true);
	for (const stat of Object.keys(ai.RUN_AND_BUN_EVS)) {
		assert.equal(ai.RUN_AND_BUN_EVS[stat], 0,
			`mechanics.evsRemoved: ${stat} EVs must be zero`);
	}
});

test('the retyped moves are actually retyped', () => {
	assert.equal(ai.getMoveMetadata('Super Fang', 8).type, profile.mechanics.superFangType,
		'mechanics.superFangType');
	assert.equal(ai.getMoveMetadata('Covet', 8).type, profile.mechanics.covetType,
		'mechanics.covetType');
});

test('paralysis takes three quarters of the speed, not half', () => {
	// Stock Generation 7+ halves it. This hack quarters it, which changes who
	// moves first in most of the early game.
	const state = stateWith();
	const mon = state.sides.player.party[0];
	const healthy = ai.getEffectivePokemonSpeed(state, mon.id);
	mon.status = 'par';
	const paralysed = ai.getEffectivePokemonSpeed(state, mon.id);
	assert.ok(healthy > 0, 'the fixture needs a real speed to scale');
	assert.equal(paralysed, Math.floor(healthy * profile.mechanics.paralysisSpeedMultiplier),
		'mechanics.paralysisSpeedMultiplier');
});

test('every declared mechanic is either driven here or listed as not driven', () => {
	// The point of the file. Without this, a new rule delta can be declared,
	// tagged source-of-truth, and never connected to anything — which is the
	// state that let a declared rule read as an oversight.
	const declared = Object.keys(profile.mechanics).sort();
	const accounted = CHECKED.concat(Object.keys(PENDING)).sort();
	assert.deepEqual(accounted, declared,
		'a mechanic was added or renamed without deciding whether this file drives it');
	for (const key of CHECKED) {
		assert.ok(!(key in PENDING), `${key} cannot be both checked and pending`);
	}
	for (const key of Object.keys(PENDING)) {
		assert.ok(PENDING[key] && PENDING[key].length > 10,
			`${key} needs a reason, not an empty excuse`);
	}
});
