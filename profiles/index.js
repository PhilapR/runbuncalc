/* eslint-env node, es6 */
'use strict';

/**
 * Registry of known game profiles.
 *
 * Adding a game means adding a directory and a line here — no change to
 * `calc/`, `ai/`, or `server.js`. See `profiles/README.md`.
 */

const runAndBun = require('./run-and-bun');

const PROFILES = {
	[runAndBun.id]: runAndBun,
};

/** The profile this build targets when a caller does not name one. */
const DEFAULT_PROFILE_ID = runAndBun.id;

function getProfile(id) {
	const profile = PROFILES[id || DEFAULT_PROFILE_ID];
	if (!profile) {
		throw new Error(`unknown profile '${id}'; known: ${Object.keys(PROFILES).join(', ')}`);
	}
	return profile;
}

function listProfiles() {
	return Object.keys(PROFILES).map(id => ({
		id,
		name: PROFILES[id].name,
		baseGeneration: PROFILES[id].baseGeneration,
		layers: ['data', 'mechanics', 'policy', 'encounters'].filter(l => PROFILES[id][l]),
	}));
}

module.exports = {getProfile, listProfiles, DEFAULT_PROFILE_ID};
