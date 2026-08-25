/* eslint-env node, es6 */
'use strict';

/**
 * Whether a held item survives being used, and where that answer comes from.
 *
 * Philip's point, which the engine only half agreed with: an Eviolite is
 * reusable and a resist berry is not, so an advisor cannot price them the
 * same. The bag already models scarcity — it decrements on `give` and refuses
 * a second one — but nothing modelled the EATING, so a Chople Berry that fired
 * against a Fighting leader was still held afterwards and still being priced.
 *
 * Two sources answer the question, and neither of them is me:
 *
 *   - the dex, for berries. `Generations.get(8).items.get(id).isBerry` is
 *     complete and authoritative, and every berry is consumed on use.
 *   - the battle engine, for the rest. A non-berry is single-use exactly when
 *     the engine calls `consumeItem` on it, so each entry below cites the file
 *     that does it. That list is what the ENGINE implements, which is the
 *     honest bound — an item Run & Bun grants but the engine never consumes
 *     would be modelled as permanent no matter what this file claimed.
 *
 * Anything else answers `unknown` rather than guessing. An advisor that treats
 * unknown as permanent is making an assumption; it should at least be able to
 * see that it is making one.
 */

const Calc = require('../ai/node_modules/@smogon/calc');

/** Dex id: lowercase, alphanumerics only. The form the engine compares on. */
function itemId(name) {
	return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Non-berry items the battle engine consumes, each with the file that does it.
 * Collected by reading the `consumeItem` call sites rather than from memory.
 */
const ENGINE_CONSUMES = Object.freeze({
	focussash: 'move-engine.ts — kept the holder at 1 HP, then consumed',
	airballoon: 'entry-hazards.ts — popped when hit',
	powerherb: 'move-engine.ts — spent to skip a charge turn',
	whiteherb: 'end-turn.ts, move-engine.ts — spent restoring lowered stats',
	mentalherb: 'end-turn.ts, move-engine.ts — spent curing infatuation',
	ejectbutton: 'move-engine.ts — spent switching the holder out',
	redcard: 'move-engine.ts — spent dragging the attacker out',
	weaknesspolicy: 'move-engine.ts — spent on the boost',
	throatspray: 'move-engine.ts — spent on the boost',
	blunderpolicy: 'move-engine.ts — spent on the boost',
	ejectpack: 'move-engine.ts — spent switching the holder out',
	berryjuice: 'end-turn.ts, move-engine.ts — spent healing',
});

/**
 * `{singleUse, source, why}` for an item name.
 *
 * `singleUse` is true, false, or null for "nobody here knows". Null is a real
 * answer and callers are expected to handle it — see `unknownHeldItems`.
 */
function itemFacts(name) {
	const id = itemId(name);
	if (!id) return {name: name, singleUse: null, source: 'none', why: 'no item'};

	const dex = Calc.Generations.get(8).items.get(id);
	if (dex && dex.isBerry) {
		return {
			name: dex.name, singleUse: true, source: 'dex',
			why: 'a berry, and every berry is eaten on use',
		};
	}
	if (ENGINE_CONSUMES[id]) {
		return {
			name: dex ? dex.name : name, singleUse: true, source: 'engine',
			why: ENGINE_CONSUMES[id],
		};
	}
	if (!dex) {
		return {name: name, singleUse: null, source: 'none', why: 'not in the generation 8 dex'};
	}
	// In the dex, not a berry, and the engine never takes it away.
	return {
		name: dex.name, singleUse: false, source: 'engine',
		why: 'the engine never consumes it, so it keeps working every turn',
	};
}

/** Convenience: true only when we KNOW it is single use. */
function isSingleUse(name) {
	return itemFacts(name).singleUse === true;
}

/**
 * Where the profile's own `kind` disagrees with what the engine does.
 *
 * This is the part that earns the module. The availability data called Focus
 * Sash `held`, and the engine consumes it — so the run was told a one-shot
 * item was permanent by its own catalogue. Rather than correct that by hand
 * and hope, the disagreement is computed, so the next one is found the same
 * way.
 */
function kindDisagreements(items) {
	const rows = [];
	for (const entry of items || []) {
		const facts = itemFacts(entry.name);
		if (facts.singleUse === null) continue;
		const saysSingleUse = entry.kind === 'consumable';
		if (saysSingleUse === facts.singleUse) continue;
		rows.push({
			name: entry.name, kind: entry.kind,
			singleUse: facts.singleUse, source: facts.source, why: facts.why,
		});
	}
	return rows;
}

/** Catalogued items whose durability nothing can answer. */
function unknownHeldItems(items) {
	return (items || [])
		.filter(entry => itemFacts(entry.name).singleUse === null)
		.map(entry => entry.name);
}

module.exports = {
	itemId: itemId,
	itemFacts: itemFacts,
	isSingleUse: isSingleUse,
	kindDisagreements: kindDisagreements,
	unknownHeldItems: unknownHeldItems,
	ENGINE_CONSUMES: ENGINE_CONSUMES,
};
