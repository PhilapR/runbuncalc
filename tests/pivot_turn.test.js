/* eslint-env node, es6 */
'use strict';

/**
 * Gate for the pivot turn: a U-turn that sends our body out mid-turn brings
 * the replacement in at once, and the slower foe move lands on it.
 *
 * The driver deferred our replacement to the next action, so the foe's
 * move — aimed at a body already leaving — was refused as illegal (ledger:
 * pivot-leaves-foe-move-without-target). The headless run of seed 104740
 * (Chimchar) met it at Lady Cindy: a Beedrill lead U-turned and Minccino's
 * Thunder Wave was refused.
 */

process.argv.push('--budget=12');

const assert = require('node:assert/strict');
const test = require('node:test');

const battery = require('../scripts/scenario-battery.js');
const headless = require('../scripts/headless-run.js');
const policy = require('../scripts/ui-playthrough.js');

test('a pivot pauses the turn: the replacement takes the slower move, nothing is refused', () => {
	const play = battery.playScenario;
	const refused = [];
	const fought = [];
	battery.playScenario = function playAndWatch(policyIn, doc, trainer) {
		const played = play.apply(this, arguments);
		fought.push(trainer);
		for (const entry of played.refused || []) refused.push(trainer + ': ' + entry.text);
		return played;
	};
	try {
		headless.playRun(policy, {species: 'Chimchar', rival: 'Blaziken'}, 104740, headless.armFlags(''));
	} finally {
		battery.playScenario = play;
	}
	assert.ok(fought.includes('Lady Cindy'), 'the run reaches the fight that met it: ' + fought.join(', '));
	assert.deepEqual(refused, []);
});

test('a move the turn made fail is used and fails, not refused', () => {
	// Headless seed 2199322 (Turtwig), Ruin Maniac Georgie: Munchlax queued
	// Belly Drum, a faster hit took it under half HP, and the engine refused
	// the move instead of letting it fail — canUseMove filtered it as if it
	// were illegal. It is offered only above half HP, and used at any.
	const play = battery.playScenario;
	const refused = [];
	const fought = [];
	battery.playScenario = function playAndWatch(policyIn, doc, trainer) {
		const played = play.apply(this, arguments);
		fought.push(trainer);
		for (const entry of played.refused || []) refused.push(trainer + ': ' + entry.text);
		return played;
	};
	try {
		headless.playRun(policy, {species: 'Turtwig', rival: 'Blaziken'}, 2199322, headless.armFlags(''));
	} finally {
		battery.playScenario = play;
	}
	assert.ok(fought.includes('Ruin Maniac Georgie'), fought.join(', '));
	assert.deepEqual(refused, []);
});

test('a Baton Pass brings its replacement in, on either side', () => {
	// Battle Girl Vivian's Prankster Volbeat passed and stayed listed active,
	// because the driver read only pendingForcedSwitchIds; our Double-Edge at
	// it was refused.
	const driver = require('../lib/battle-driver.js');
	const doc = battery.loadDocument(require('node:path').join(__dirname, '..', 'fixtures', 'banked-runs',
		'sv-14.run.json'));
	const state = driver.start(doc, 'Leader Wattson', 1).battle.state;
	const foe = state.sides.ai.activeIds[0];
	// The engine checks the passer knows the move, so the foe is taught it.
	const passed = Object.assign(structuredClone(state), {pendingBatonPassIds: [foe]});
	const passer = passed.sides.ai.party.find(mon => mon.id === foe);
	passer.moves[passer.moves.length - 1] = Object.assign({}, passer.moves[0], {name: 'Baton Pass'});
	const settled = driver.settleAiSide(passed, []);
	assert.notEqual(settled.sides.ai.activeIds[0], foe, 'the foe\'s replacement came in');
	assert.ok(!(settled.pendingBatonPassIds || []).includes(foe));
	const ours = state.sides.player.activeIds[0];
	assert.equal(driver.phaseOf(Object.assign({}, state, {pendingBatonPassIds: [ours]})), 'replace',
		'our pass asks us for the replacement');
	assert.equal(driver.phaseOf(state), 'choose');
});

test('a priority move that finishes the foe wins the race, whatever the speeds', () => {
	// Aqua Admin Shelly's sashed Mienshao sat at 1% and outsped the bench;
	// the race read Speed only, so the Quick Attack body was never sent.
	const driver = require('../lib/battle-driver.js');
	const doc = battery.loadDocument(require('node:path').join(__dirname, '..', 'fixtures', 'banked-runs',
		'sv-14.run.json'));
	const state = structuredClone(driver.start(doc, 'Leader Wattson', 1).battle.state);
	const foe = state.sides.ai.party.find(mon => mon.id === state.sides.ai.activeIds[0]);
	foe.hp.current = 1;
	const bench = state.sides.player.party.find(mon => !state.sides.player.activeIds.includes(mon.id));
	const plain = driver.benchRace(state, bench.id);
	assert.ok(!plain || !plain.priority, 'no priority move, no priority win');
	bench.moves[bench.moves.length - 1] = Object.assign({}, bench.moves[0], {name: 'Quick Attack'});
	const quick = driver.benchRace(state, bench.id);
	assert.equal(quick.outcome, 'win');
	assert.equal(quick.priority, true);
});
