/* eslint-env node, es6 */
'use strict';

/**
 * Game profile contract.
 *
 * A profile declares one game as deltas against a base generation. See
 * `profiles/README.md` for the layering model and how to add a game.
 *
 * `defineProfile` validates shape at load time rather than letting a malformed
 * profile fail later inside a calculation, where the cause would be much harder
 * to see.
 */

/** How a claim in a profile is known, weakest last. */
const PROVENANCE_TAGS = [
	'source-of-truth', // the game author's own published data
	'emulator-observed', // reproduced against the live ROM by an instrumented emulator probe; the claim's comment cites the probe corpus
	'observed', // confirmed in-game by a maintainer
	'transcribed', // copied from community docs, unverified
	'inferred', // derived by us, unchecked
];

/** Claims with no explicit tag are treated as the weakest kind. */
const DEFAULT_PROVENANCE = 'inferred';

function fail(id, message) {
	throw new Error(`profile '${id || '(no id)'}': ${message}`);
}

function defineProfile(profile) {
	const id = profile && profile.id;
	if (!id || typeof id !== 'string') fail(id, 'must declare a string id');
	if (!profile.name) fail(id, 'must declare a display name');

	// A profile that names no game version cannot make a meaningful
	// "verified against the author's data" claim: the claim is only as precise
	// as the release it refers to.
	if (profile.gameVersion !== undefined && typeof profile.gameVersion !== 'string') {
		fail(id, 'gameVersion must be a string when present');
	}

	const base = profile.baseGeneration;
	if (!Number.isInteger(base) || base < 1 || base > 9) {
		fail(id, `baseGeneration must be a generation number, got ${JSON.stringify(base)}`);
	}

	// Every optional layer must be an object if present. A profile that fills no
	// layer at all is almost certainly a mistake rather than a deliberate stub.
	const layers = ['data', 'mechanics', 'policy', 'encounters'];
	for (const layer of layers) {
		if (profile[layer] !== undefined && typeof profile[layer] !== 'object') {
			fail(id, `${layer} must be an object when present`);
		}
	}
	if (!layers.some(layer => profile[layer])) {
		fail(id, 'declares no layers; a profile must fill at least one of ' + layers.join(', '));
	}

	// A policy must say how it decides. The planner ranks actions by asking the
	// policy, and a consumer that assumes scoring will silently misread a game
	// whose AI is a decision tree or stock vanilla.
	if (profile.policy && !profile.policy.KIND) {
		fail(id, 'policy must declare a KIND (e.g. scoring, decision-tree, vanilla)');
	}

	const provenance = profile.provenance || {};
	for (const key of Object.keys(provenance)) {
		if (!PROVENANCE_TAGS.includes(provenance[key])) {
			fail(id, `provenance for '${key}' is '${provenance[key]}', expected one of ${PROVENANCE_TAGS.join(', ')}`);
		}
	}

	return Object.freeze(Object.assign({}, profile, {
		provenance: Object.freeze(Object.assign({}, provenance)),
		/** Provenance for a claim, defaulting to the weakest tag. */
		provenanceOf(key) {
			return provenance[key] || DEFAULT_PROVENANCE;
		},
	}));
}

module.exports = {defineProfile, PROVENANCE_TAGS, DEFAULT_PROVENANCE};
