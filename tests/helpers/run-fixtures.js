/* eslint-env node, es6 */
'use strict';

/**
 * Fixtures the run.test.js family shares: real game coordinates and the
 * owned-Pokemon and fresh-run builders. They lived at the top of one file;
 * run.test.js was split so Node can run its slow ranker and advisor gates in
 * parallel with the rest, and all three files read the same fixtures from
 * here rather than three copies that drift.
 */

const run = require('../../lib/run');

/**
 * Real coordinates from the game, used throughout.
 *
 * Marill is fished out of Route 114 with the Super Rod at level 40 — chosen
 * because it exercises method, rod and an exact level range at once, and because
 * getting it wrong (Route 102, Route 117) is what the refusal cases assert.
 */
const MARILL = {kind: 'catch', species: 'Marill', map: 'Route114', level: 40, method: 'fish'};
const TEST_IVS = {hp: 17, atk: 18, def: 19, spa: 20, spd: 21, spe: 22};
const PERFECT_IVS = {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31};

/** Complete owned-Pokemon fixture; supplied stats override the stable test roll. */
function owned(command) {
	return Object.assign({}, command, {
		ivs: Object.assign({}, TEST_IVS, command.ivs || {}),
	});
}

function fresh(options) {
	return run.createRun(Object.assign({name: 'Gate', now: 't0'}, options));
}

module.exports = {MARILL, TEST_IVS, PERFECT_IVS, owned, fresh};
