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
