/* eslint-env node, es6 */
'use strict';

/**
 * Gate for encounter dating: no wild table opens far above the level cap.
 *
 * Route 118 was dated to position 195 (cap 35) while its grass is Level 50
 * in the official encounter sheet; a run caught Level 50 Beedrill and
 * Araquanid and fielded them 15 levels over the cap (sweep 10, found by
 * scripts/audit-run.js). The official Trainer Battles doc puts Route 118 after
 * Leader Flannery, and the item sheet splits it into a Mauville beach and a
 * Route 119 beach: the grass is the later section's. Route 115's Level 90 grass and Route 130's Level 100 grass
 * were the same defect. A table a few levels over is ordinary (Route 110's
 * Level 20 fishing at cap 17); a table most of whose odds sit more than
 * MARGIN over the cap at its opening is a mis-dated area.
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const run = require('../lib/run.js');
const battery = require('../scripts/scenario-battery.js');
const oracle = require('../profiles').getProfile('run-and-bun').oracle;
const availability = require('../profiles/run-and-bun/oracle/availability.json');

const MARGIN = 5;

test('no wild table opens far above the level cap', () => {
	const doc = battery.loadDocument(path.join(__dirname, '..', 'fixtures', 'banked-runs', 'br-21.run.json'));
	const capAt = position => run.levelCap(Object.assign({}, doc, {position})).cap;
	const misdated = [];
	let checked = 0;
	for (const entry of availability.entries) {
		if (entry.opensAt === null || entry.opensAt === undefined) continue;
		const table = oracle.encountersOn(entry.map) || oracle.encountersOn(entry.name);
		if (!table || !table.mons) continue;
		const byMethod = {};
		for (const mon of table.mons) (byMethod[mon.method] = byMethod[mon.method] || []).push(mon);
		for (const method of Object.keys(byMethod)) {
			const gate = oracle.methodOpensAt(method, entry.map);
			const opens = Math.max(entry.opensAt, gate || 0);
			const cap = capAt(opens);
			if (cap === null) continue;
			const slots = byMethod[method];
			const total = slots.reduce((sum, mon) => sum + (mon.chance || 1), 0);
			const over = slots.filter(mon => mon.minLevel > cap + MARGIN).reduce((sum, mon) => sum + (mon.chance || 1), 0);
			checked++;
			if (over / total >= 0.5) {
				misdated.push(entry.name + ' ' + method + ' opens at ' + opens + ' (cap ' + cap + '), ' +
					Math.round(100 * over / total) + '% of it above ' + (cap + MARGIN));
			}
		}
	}
	assert.ok(checked > 100, 'the check reached the tables: ' + checked);
	assert.deepEqual(misdated, []);
});

test('Route 118 grass waits for Flannery, and Route 115 grass for Juan', () => {
	// Route 118's Mauville beach (a tutor, a hidden Heart Scale) is early;
	// its grass is the later section's.
	assert.equal(oracle.availabilityOf('Route118').opensAt, 195);
	assert.equal(oracle.methodOpensAt('walk', 'Route118'), 618);
	assert.equal(oracle.methodOpensAt('fish', 'Route118'), 0);
	assert.equal(oracle.methodOpensAt('walk', 'Route115'), 1537);
	assert.equal(oracle.methodOpensAt('fish', 'Route115'), 0, 'its water is the early section\'s');
	assert.equal(oracle.methodOpensAt('walk'), 0, 'the global gate is unchanged');
});
