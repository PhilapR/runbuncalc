/* eslint-env node, es6 */
'use strict';

/**
 * A name for a caught Pokemon, so a run reads like a nuzlocke and not a
 * spreadsheet.
 *
 * The harness catches about eighteen Pokemon a run and loses two in every
 * three fights it plays. Those losses are the run's story, but a ledger that
 * says "Staravia fell to Hitmontop's Pursuit" says it about a SPECIES — and
 * the same species is caught, evolved and buried a dozen times across a
 * sweep, so nothing in the record belongs to anybody. A nickname makes the
 * body an individual: the Staravia that carried the run from Route 104 to
 * Norman is not the one that died on Route 116 an hour earlier.
 *
 * Deterministic, because a run must be re-tellable: the same seed and the
 * same catch order give the same names, so a chronicle can be regenerated
 * from a replay rather than stored. Unique within a run, because two bodies
 * with one name is exactly the confusion this removes.
 *
 * The pool is short, plain and human — the names a player actually types at
 * the nickname prompt, not generated syllables.
 */

const POOL = [
	'Ash', 'Bram', 'Cass', 'Dell', 'Edda', 'Finn', 'Gale', 'Hob',
	'Ivo', 'Jute', 'Kell', 'Lark', 'Mott', 'Nix', 'Orla', 'Pike',
	'Quill', 'Rook', 'Sable', 'Tuck', 'Ulla', 'Vex', 'Wren', 'Yarrow',
	'Bell', 'Cinder', 'Dusk', 'Ember', 'Flint', 'Grit', 'Haze', 'Iron',
	'Juno', 'Kestrel', 'Lumen', 'Moss', 'Nettle', 'Onyx', 'Pitch', 'Quarry',
	'Reed', 'Slate', 'Thorn', 'Umber', 'Vale', 'Whim', 'Yew', 'Zeal',
	'Anvil', 'Bracken', 'Clay', 'Drift', 'Elm', 'Fen', 'Gorse', 'Heath',
	'Ink', 'Jet', 'Kiln', 'Loam', 'Marl', 'Nock', 'Osier', 'Peat',
];

/** A small, stable hash: the same string always lands on the same number. */
function hashOf(text) {
	let hash = 2166136261;
	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

/**
 * The name for this catch. `taken` is every nickname the run has already
 * spent; the first free name from the hashed starting point is used, so a
 * collision walks forward rather than falling back to a number.
 */
function nicknameFor(species, key, taken) {
	const used = taken instanceof Set ? taken : new Set(taken || []);
	const start = hashOf(String(species) + '/' + String(key)) % POOL.length;
	for (let step = 0; step < POOL.length; step++) {
		const name = POOL[(start + step) % POOL.length];
		if (!used.has(name)) return name;
	}
	// More catches than names: a run that reaches here is already past every
	// level cap, but a numbered fallback beats a duplicate.
	return POOL[start] + '-' + (used.size + 1);
}

module.exports = {nicknameFor, POOL};
