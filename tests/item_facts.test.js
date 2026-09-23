/* eslint-env node, es6 */
'use strict';

/**
 * Gate for what the run believes about a held item's durability.
 *
 * Philip's observation started this: an Eviolite is reusable and a resist
 * berry is not, so an advisor cannot price the two the same. The run modelled
 * scarcity — the bag decrements on `give` and refuses a second one — and not
 * consumption, so a Chople Berry that fired against a Fighting leader was
 * still held afterwards and still being priced.
 *
 * The catalogue disagreed with the engine and nothing noticed. Focus Sash was
 * tagged `held` while move-engine.ts consumes it, so a one-shot item was
 * described as permanent by the run's own data. That is the class of error
 * this file exists to catch, and catching it by hand does not scale — so the
 * disagreement is computed against the engine rather than asserted item by
 * item.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const facts = require('../lib/item-facts');
const availability = require('../profiles/run-and-bun/oracle/availability.json');

test('a berry is single use, on the dex\'s authority rather than a list I typed', () => {
	// Every berry is eaten on use, and the dex knows which items are berries,
	// so this needs no maintenance as berries are added to the run.
	for (const berry of ['Oran Berry', 'Sitrus Berry', 'Chople Berry', 'Lum Berry']) {
		const row = facts.itemFacts(berry);
		assert.equal(row.singleUse, true, berry + ' is a berry and berries are eaten');
		assert.equal(row.source, 'dex', 'and the dex is what said so');
	}
});

test('a permanent item is permanent because the engine never takes it away', () => {
	for (const item of ['Eviolite', 'Leftovers', 'Silk Scarf', 'Choice Band']) {
		assert.equal(facts.itemFacts(item).singleUse, false,
			item + ' keeps working every turn');
	}
});

test('a non-berry the engine consumes is single use too', () => {
	// The case the catalogue got wrong. Focus Sash survives nothing: it keeps
	// the holder at 1 HP once and move-engine.ts consumes it on the spot.
	assert.equal(facts.itemFacts('Focus Sash').singleUse, true);
	assert.equal(facts.itemFacts('Focus Sash').source, 'engine');
	assert.equal(facts.itemFacts('Air Balloon').singleUse, true);
	assert.equal(facts.itemFacts('Power Herb').singleUse, true);
});

test('an item nobody can classify answers null, and never a convenient false', () => {
	// Null is a real answer. A caller that treats unknown as permanent is
	// making an assumption, and it should have to make it out loud rather
	// than be handed a false that looks like knowledge.
	assert.equal(facts.itemFacts('Definitely Not An Item').singleUse, null);
	assert.equal(facts.itemFacts('').singleUse, null);
	assert.equal(facts.itemFacts(null).singleUse, null);
	assert.equal(facts.isSingleUse('Definitely Not An Item'), false,
		'the convenience wrapper answers only "known single use"');
});

test('the run map agrees with the engine about what survives being used', () => {
	// The gate that earns the file. Every catalogued item whose durability the
	// engine can answer must be tagged to match it — so the next Focus Sash is
	// found by a test rather than by someone noticing.
	const rows = facts.kindDisagreements(availability.items);
	assert.deepEqual(rows, [], rows.length ?
		'availability.json disagrees with the battle engine about: ' +
			rows.map(r => r.name + ' (tagged "' + r.kind + '", engine says singleUse=' +
				r.singleUse + ' — ' + r.why + ')').join('; ') :
		'');
});

test('what the run map cannot classify is named, not silently assumed', () => {
	// Not an error — Potion and Super Potion are bag items rather than held
	// ones, so the held-item dex has nothing to say about them. Pinned so the
	// list cannot grow without someone deciding it should.
	assert.deepEqual(facts.unknownHeldItems(availability.items).sort(),
		['Potion', 'Super Potion']);
});

test('no item is offered before the map it stands on opens', () => {
	// availability.json holds two records of the same fact and only one of them
	// receives corrections. `scripts/adopt-availability.js` rewrites
	// `entries` — the map table — and the strings `items` and `moveItems` do
	// not appear in that script at all. So when Route 109 was corrected from
	// play (29 -> 42, "the transcribed 29 put it BEFORE Route 107's own
	// trainers, which run to 37"), the map row moved and the Soft Sand row on
	// that map did not.
	//
	// The advisor reads the ITEM row, so between orders 29 and 41 it offered a
	// pickup on a route the same file says is not open. That is the too-early
	// direction, which costs a player a wasted trip rather than an option.
	const maps = new Map();
	for (const entry of availability.entries || []) {
		const name = String(entry.name).replace(/([A-Za-z])(\d)/g, '$1 $2').trim().toLowerCase();
		if (typeof entry.opensAt === 'number') maps.set(name, entry);
	}
	const early = [];
	for (const field of ['items', 'moveItems']) {
		for (const row of availability[field] || []) {
			if (typeof row.opensAt !== 'number') continue;
			const place = maps.get(String(row.location || row.place || '').trim().toLowerCase());
			if (!place) continue;
			if (row.opensAt < place.opensAt) {
				early.push(`${field}: ${row.name} at ${row.opensAt} stands on ` +
					`${place.name}, which opens at ${place.opensAt}` +
					(place.provenance ? ` (${place.provenance})` : ''));
			}
		}
	}
	assert.deepEqual(early, [],
		'these are offered before the run can walk the map they sit on');
});

test('no TM or item is dated before an HM its own prose names', () => {
	// `scripts/import-availability.js` found the gate with one `exec` over an
	// alternation, so "requires Surf and Waterfall" matched Surf and stopped.
	// TM15 Body Press shipped at 589 against a Waterfall at 1178 — and its
	// `dating` field read "unlock+hm-gate", so the row asserted that a gate had
	// been applied. One had. The wrong one.
	//
	// Body Press is teachable by 154 species, so from order 589 the advisor
	// would offer it to any of them whenever it helped.
	const gates = availability.hmMoves;
	const early = [];
	for (const field of ['items', 'moveItems']) {
		for (const row of availability[field] || []) {
			if (typeof row.opensAt !== 'number') continue;
			const prose = String(row.location || '');
			const named = Object.keys(gates)
				.filter(move => new RegExp('\\b' + move + '\\b', 'i').test(prose));
			if (!named.length) continue;
			const floor = Math.max.apply(null, named.map(move => gates[move]));
			if (row.opensAt < floor) {
				early.push(`${field}: ${row.name} at ${row.opensAt} names ` +
					`${named.join('+')}, the latest of which opens at ${floor}`);
			}
		}
	}
	assert.deepEqual(early, [],
		'these are offered before the run has the HM their own prose requires');
});

test('the Focus Sash correction survives a re-import', () => {
	// The correction lived only in the committed file. import-availability.js
	// reads `kind` straight from upstream's `type:` field, so the next import
	// would put Focus Sash back to `held` and drop the provenance with it —
	// loud, because the gate above fails by name, but not durable.
	const adopt = require('../scripts/adopt-availability.js');

	const reimported = {items: [{name: 'Focus Sash', kind: 'held', location: 'x'}]};
	assert.deepEqual(adopt.applyItemOverrides(reimported), ['Focus Sash']);
	assert.equal(reimported.items[0].kind, 'consumable');
	assert.equal(reimported.items[0].transcribedKind, 'held',
		'the upstream value stays visible, as transcribedOpensAt does for a map');
	assert.equal(reimported.items[0].provenance, 'derived');
	assert.match(reimported.items[0].basis, /move-engine\.ts calls consumeItem/,
		'and the basis names the code that settles it');

	// Re-running is free, so adopt can be run after every import without
	// accumulating corrections.
	assert.deepEqual(adopt.applyItemOverrides(reimported), []);

	// If upstream carries a third value it has changed its mind, and this table
	// must not quietly overrule a new answer.
	assert.throws(() => adopt.applyItemOverrides({items: [{name: 'Focus Sash', kind: 'type-boost'}]}),
		/neither the correction .* nor the .* it corrected/);

	// And the committed file already agrees, so adopt is a no-op against it today.
	assert.deepEqual(adopt.applyItemOverrides(availability), []);

	// apply() must actually CALL it. Testing the function alone left this open:
	// deleting the call from apply passed every assertion above, which is the
	// same hole a gate on the advise splice had — the unit works and the wiring
	// is gone.
	const state = {
		availability: {
			entries: [],
			items: [{name: 'Focus Sash', kind: 'held', location: 'x'}],
			moveItems: [],
		},
		added: [],
		changed: [],
	};
	adopt.apply(state);
	assert.equal(state.availability.items[0].kind, 'consumable',
		'apply must run the item overrides, not merely export them');
});
