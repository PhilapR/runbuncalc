/* eslint-env node, es6 */
'use strict';

/**
 * Transport-neutral AI endpoints shared by Express and the Cloudflare Worker.
 * Start with the validation boundary used by every browser lab surface; move
 * the remaining AI routes here as they graduate from local lab to deployed
 * capability.
 */

const ai = require('../ai');

function refusal(message, code) {
	const error = new Error(message);
	error.statusCode = 400;
	error.code = code;
	return error;
}

function validateBattleState(payload) {
	payload = payload || {};
	const state = payload.state || payload;
	if (!state || !state.sides) {
		throw refusal('BattleState with sides is required', 'InvalidBattleState');
	}
	try {
		ai.validateBattleState(state);
	} catch (error) {
		if (!Number.isInteger(error.statusCode)) error.statusCode = 400;
		if (!error.code) error.code = 'InvalidBattleState';
		throw error;
	}
	return {ok: true};
}

const api = {validateBattleState};
const ROUTES = {'/ai/validate-battle-state': validateBattleState};

module.exports = {api, ROUTES};
