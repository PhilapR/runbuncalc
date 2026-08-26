/* eslint-env node, es6 */
'use strict';

/**
 * Gate for the two order scales, which are easy to mistake for each other and
 * were mistaken for each other in prose and in output.
 *
 * `order` counts cumulative enemy POKEMON. A player counts TRAINERS. Leader
 * Brawly is order 77 and the 26th fight of 362, so the two numbers differ by
 * enough to send a reader most of a badge past whatever they were looking for
 * — `lib/play.js` printed "opens at fight #77" for a TM that unlocks at fight
 * 26, and `oracle.js` documented the availability ledger's `opensAt` as a
 * "trainer order" when it is not one.
 *
 * Every dated source in the profile is in ORDER: LEVEL_CAPS, availability's
 * items and moveItems, the HM gates. Only presentation wants trainers, which
 * is why the conversion belongs at the edge and this file pins the anchors it
 * converts between.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const run = require('../lib/run');
const availability = require('../profiles/run-and-bun/oracle/availability.json');

function road() {
	const doc = run.createRun({
		name: 'scales', now: 't0', levelCap: 'next-milestone-ace',
		permadeath: false, onePerRoute: false,
	});
	const out = run.upcoming(doc, 4000);
	return {doc: doc, fights: Array.isArray(out) ? out : (out.fights || [])};
}

test('order counts Pokemon, and the road counts trainers', () => {
	const map = road();
	assert.equal(map.fights.length, 362, 'the run map is 362 trainers long');

	const brawly = map.fights.findIndex(fight => /Leader Brawly/.test(fight.trainer));
	assert.equal(brawly + 1, 26, 'Brawly is the 26th trainer');
	assert.equal(map.fights[brawly].order, 77, 'and sits at order 77');

	// The two are not merely different, they are different BY CONSTRUCTION:
	// order is the running total of enemy Pokemon before the fight.
	let pokemon = 0;
	for (let i = 0; i < brawly; i++) pokemon += (map.fights[i].party || []).length;
	assert.equal(pokemon, 77,
		'order is the cumulative count of enemy Pokemon, which is what makes it not a fight number');
});

test('the converter maps an order to the fight a player would count', () => {
	const map = road();
	assert.equal(run.trainerIndexOf(map.doc, 77), 26, 'Brawly');
	assert.equal(run.trainerIndexOf(map.doc, 139), 45, 'Roxanne');
	assert.equal(run.trainerIndexOf(map.doc, 224), 65, 'Wattson');
	// Past the end of the road there is no fight to name, and inventing one
	// would be worse than saying so.
	assert.equal(run.trainerIndexOf(map.doc, 999999), null);
	assert.equal(run.trainerIndexOf(map.doc, null), null);
});

test('the availability ledger is dated in order, not in trainers', () => {
	const map = road();
	const byOrder = new Map(map.fights.map(fight => [fight.order, fight.trainer]));

	// TM16 is Brawly's own gym reward and carries opensAt 77 — his ORDER. If
	// the ledger were in trainer numbers it would carry 26, and 26 is a Team
	// Aqua grunt in Petalburg Woods, three badges away from this TM.
	const tm16 = (availability.moveItems || []).find(row => row.name === 'TM16');
	assert.ok(tm16, 'TM16 must be in the ledger');
	assert.equal(tm16.opensAt, 77);
	assert.match(String(tm16.place), /Brawly/);
	assert.match(String(byOrder.get(tm16.opensAt)), /Brawly/,
		'opensAt must resolve to the fight the location names');

	// And a dated row can only ever land on a real fight's order.
	const dated = (availability.moveItems || []).filter(row => typeof row.opensAt === 'number');
	assert.ok(dated.length >= 50, 'the ledger is mostly dated: ' + dated.length + ' rows');
	for (const row of dated) {
		assert.ok(run.trainerIndexOf(map.doc, row.opensAt) !== null,
			row.name + ' (' + row.move + ') is dated at order ' + row.opensAt +
			', which is past the end of the road — that is a trainer number, not an order');
	}
});
