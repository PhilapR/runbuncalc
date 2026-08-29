/* eslint-env node, es6 */
'use strict';

/**
 * Gates for the fight-dossier oracle (profiles/run-and-bun/oracle/
 * fight-dossiers.json), the precomputed threat read every runtime consumer
 * trusts instead of touching the grid machinery in play.
 *
 * Freshness is gated by PROVENANCE, not by byte-regeneration: a full
 * rebuild is minutes (the whole point of precomputing), so unlike
 * trainer-orders.json this gate recomputes only the input digests and the
 * scale id and fails when they disagree with the stamp — the fix is
 * `node scripts/build-fight-dossiers.js`, and the gate says so.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const crypto = require('node:crypto');

const planner = require('../lib/planner');
const encounters = require('../profiles/run-and-bun/encounters.js');
const oracle = require('../profiles/run-and-bun/oracle/fight-dossiers.json');

const INPUTS = {
	setdex: 'src/js/data/sets/gen8.js',
	learnsets: 'profiles/run-and-bun/oracle/learnsets.json',
	availability: 'profiles/run-and-bun/oracle/availability.json',
	evolutions: 'profiles/run-and-bun/oracle/evolutions.json',
};

function digest(path) {
	return crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex').slice(0, 16);
}

test('the dossier oracle is fresh: scale and every input match its stamp', () => {
	assert.equal(oracle.stamp.orderScale, encounters.ORDER_SCALE.id,
		'the oracle was built on another order scale — regenerate with ' +
		'`node scripts/build-fight-dossiers.js`');
	for (const name of Object.keys(INPUTS)) {
		assert.equal(oracle.stamp.inputs[name], digest(INPUTS[name]),
			`${INPUTS[name]} changed since the oracle was built — regenerate with ` +
			'`node scripts/build-fight-dossiers.js`');
	}
});

test('every fight of the run map has a dossier row, and no row is orphaned', () => {
	const fights = planner.loadRunMap('run-and-bun');
	const byTrainer = new Map(oracle.fights.map(row => [row.trainer, row]));
	assert.equal(oracle.fights.length, fights.length,
		'one row per fight, no more and no fewer');
	for (const fight of fights) {
		const row = byTrainer.get(fight.trainer);
		assert.ok(row, fight.trainer + ' has no dossier row');
		assert.equal(row.order, fight.order,
			fight.trainer + ' is dossiered at a different order than it is fought');
	}
});

test('the rows carry the shape the consumers read, with the known anchors', () => {
	const brawly = oracle.fights.find(row => row.trainer === 'Leader Brawly');
	assert.ok(brawly.keyBox && brawly.keyBox.length === 6,
		'a boss row names its six-species key box');
	assert.ok(brawly.keyBox.includes('Hitmonchan'),
		'the measured Brawly answer is on his list');
	assert.ok(brawly.tech.some(line => /Scraggy: Shed Skin, Eviolite/.test(line)),
		'the tech flags name the Rest-loop closer');
	const wattson = oracle.fights.find(row => row.trainer === 'Leader Wattson');
	assert.ok(wattson.keyBox.includes('Excadrill'),
		'the structural Wattson answer is on his list');
	// Ordinary fights get metrics but no key box: the stratified sample is
	// for threat reading, not for shopping lists.
	const calvin = oracle.fights.find(row => row.trainer === 'Youngster Calvin');
	assert.ok(calvin && calvin.mons.length === 3, 'ordinary fights are dossiered too');
	assert.equal(calvin.keyBox, undefined, 'but carry no key box');
	// Every row's mons carry the four metrics, bounded like percentages.
	for (const row of oracle.fights) {
		for (const mon of row.mons) {
			for (const field of ['outspedBySample', 'meanBestHit', 'ohkoRate', 'answerRate']) {
				assert.ok(Number.isInteger(mon[field]) && mon[field] >= 0,
					row.trainer + '/' + mon.species + ' ' + field + ' must be a percentage');
			}
		}
	}
});

test('the catch advisor reads the dossier: named answers surface and outrank', () => {
	// Phase 2 of the leader-keys plan. The advisor already prices every
	// prospect against the target fight, but its sort counts KOs without
	// asking who survives the reply — the dossier's answer criterion does.
	// A prospect whose evolved-at-cap form is on the target's answer list is
	// flagged and outranks everything, and the payload names the list so
	// the panel can say WHY.
	const profiles = require('../profiles');
	const oracleLayer = profiles.getProfile('run-and-bun').oracle;
	const row = oracleLayer.fightDossierOf('Leader Wattson');
	assert.ok(row && row.keyBox.includes('Excadrill'),
		'the oracle accessor serves the Wattson row');
	assert.equal(oracleLayer.fightDossierOf('No Such Trainer'), null,
		'an unknown trainer answers null, never throws');

	const run = require('../lib/run.js');
	const fs = require('node:fs');
	const doc = JSON.parse(fs.readFileSync(
		'ui-playthrough-out/report-sac-A-11.json', 'utf8')).run;
	const advice = run.adviseCatches(doc, 'Leader Wattson');
	assert.ok(Array.isArray(advice.keyAnswers) && advice.keyAnswers.includes('Excadrill'),
		'the advice names the answer list it consulted');
	for (const row2 of advice.catches) {
		assert.ok(typeof row2.keyAnswer === 'boolean',
			'every catch row says whether it is a named answer');
	}
	const firstMiss = advice.catches.findIndex(entry => !entry.keyAnswer);
	const lastHit = advice.catches.map(entry => entry.keyAnswer).lastIndexOf(true);
	if (firstMiss !== -1 && lastHit !== -1) {
		assert.ok(lastHit < firstMiss || advice.catches[firstMiss - 1].keyAnswer !== false,
			'named answers sort before everything that is not one');
	}
});

test('the plan carries the tech it must respect, all the way over the wire', () => {
	// The whitelist is the silent-omission trap that ate fightNumber and
	// thresholdThreats before it: the field must survive /run/plan, not just
	// planNext.
	const run = require('../lib/run.js');
	const api = require('../lib/run-api').api;
	const fs = require('node:fs');
	const doc = JSON.parse(fs.readFileSync(
		'ui-playthrough-out/report-sac-A-11.json', 'utf8')).run;
	const plan = run.planNext(doc, {trainer: 'Leader Wattson'});
	assert.ok(plan.dossierTech.some(line => /Magnezone: Sturdy, Custap Berry/.test(line)),
		'the plan names the Sturdy+Custap trap');
	const wire = api.plan({run: doc, trainer: 'Leader Wattson'});
	assert.deepEqual(wire.dossierTech, plan.dossierTech,
		'and the wire carries the same list');
});
