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
