/* eslint-env node, es6 */
'use strict';

/**
 * Gate for the two order scales, which are easy to mistake for each other and
 * were mistaken for each other in prose and in output.
 *
 * `order` counts cumulative enemy POKEMON. A player counts TRAINERS. Leader
 * Brawly is order 80 and the 29th fight of 366, so the two numbers differ by
 * enough to send a reader most of a badge past whatever they were looking for
 * — `lib/play.js` printed "opens at fight #77" for a TM that unlocked at what
 * was then fight 26, and `oracle.js` documented the availability ledger's `opensAt` as a
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
const estimate = require('../scripts/estimate-availability.js');
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
	assert.equal(map.fights.length, 366, 'the run map is 366 trainers long');

	const brawly = map.fights.findIndex(fight => /Leader Brawly/.test(fight.trainer));
	assert.equal(brawly + 1, 29, 'Brawly is the 29th trainer');
	assert.equal(map.fights[brawly].order, 80, 'and sits at order 80');

	// The two are not merely different, they are different BY CONSTRUCTION:
	// order is the running total of enemy Pokemon before the fight.
	let pokemon = 0;
	for (let i = 0; i < brawly; i++) pokemon += (map.fights[i].party || []).length;
	assert.equal(pokemon, 80,
		'order is the cumulative count of enemy Pokemon, which is what makes it not a fight number');
});

test('the converter maps an order to the fight a player would count', () => {
	const map = road();
	assert.equal(run.trainerIndexOf(map.doc, 80), 29, 'Brawly');
	assert.equal(run.trainerIndexOf(map.doc, 142), 48, 'Roxanne');
	assert.equal(run.trainerIndexOf(map.doc, 229), 69, 'Wattson');
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
	assert.equal(tm16.opensAt, 80);
	assert.match(String(tm16.place), /Brawly/);
	assert.match(String(byOrder.get(tm16.opensAt)), /Brawly/,
		'opensAt must resolve to the fight the location names');

	// And a dated row can only ever land on a real fight's order.
	//
	// This used to ask `trainerIndexOf(doc, opensAt) !== null`, which reads like
	// membership and is not. lib/run.js:687 SNAPS FORWARD — it returns the first
	// fight at or after the value — so the question it answers is only "is this
	// at most 1620". Every trainer number 1-362 passed it, and so did every
	// engine row index 0-434, which are the two scales this file exists to keep
	// apart. Rewriting all 56 dated rows to their own trainer number left the
	// old assertion green.
	//
	// Set membership is the real question. It is not perfect either — 97 of the
	// 362 trainer numbers happen to also be real orders — so it is paired with
	// the named anchors above, which pin a row to the fight its place names.
	const orders = new Set(estimate.fightOrders());
	const dated = (availability.moveItems || []).filter(row => typeof row.opensAt === 'number');
	assert.ok(dated.length >= 50, 'the ledger is mostly dated: ' + dated.length + ' rows');
	for (const row of dated) {
		assert.ok(orders.has(row.opensAt),
			row.name + ' (' + row.move + ') is dated at order ' + row.opensAt +
			', which is not any fight of the run map — that is a trainer number ' +
			'or an engine row index, not an order');
	}
});

test('the A/B harness reports reach in trainers, not in Pokemon', () => {
	// skipwall3 printed "meanOrder=73.0" for a run whose player would say
	// "27 trainers beaten" — order scale on a human-facing summary. The
	// harness must convert at the edge like every other surface.
	const ab = require('../scripts/ab.js');
	const map = road();

	// A finished run document at Brawly's order reads as the 26th fight.
	assert.equal(ab.reachOf(map.doc, 80, []), 29, 'position converts to a trainer number');
	// No run document (a crashed run): the journal scrape already speaks
	// trainer numbers, so the max passes through unconverted.
	assert.equal(ab.reachOf(null, null, [4, 26, 12]), 26);
	assert.equal(ab.reachOf(map.doc, 0, []), 0, 'an unstarted run has beaten nobody');

	const rows = [
		{arm: 'A', fight: 20, gavi: {won: 0, attempts: 0}, brawly: {won: 0, attempts: 0}},
		{arm: 'A', fight: 30, gavi: {won: 1, attempts: 2}, brawly: {won: 0, attempts: 5}},
	];
	const s = ab.summarise(rows, 'A');
	assert.equal(s.meanFight, 25, 'the summary means the trainer numbers');
	assert.equal(s.meanOrder, undefined, 'and no longer carries the order-scale name');
});
