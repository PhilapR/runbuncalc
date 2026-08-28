/* eslint-env node, es6 */
'use strict';

/**
 * Cross-store gates for the id scales, from the 2026-08-28 audit.
 *
 * The repository dates everything on the run-map ORDER scale, and the same
 * number lives in many stores that can only drift apart by hand-editing.
 * The Route 103 / Mauville Wally insertion measured the cost of that
 * directly: fourteen files needed the same +3/+5 shift, and the copies that
 * were missed — availability's `methods` block (surf 589 vs the shifted 594
 * beside it), the `hmMoves` Cut gate, sources.json's badge tiers — each
 * produced a silent too-early or not-a-fight date rather than a failure.
 *
 * These gates make the copies check each other and the spine, so the NEXT
 * insertion fails loudly in one place per store instead of silently in play.
 * They deliberately derive expectations from labels and the live map — the
 * one representation an insertion cannot break.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const planner = require('../lib/planner');
const encounters = require('../profiles/run-and-bun/encounters.js');
const availability = require('../profiles/run-and-bun/oracle/availability.json');
const sources = require('../profiles/run-and-bun/oracle/sources.json');
const trainerOrders = require('../profiles/run-and-bun/oracle/trainer-orders.json');

const fights = planner.loadRunMap('run-and-bun');
const orders = new Set(fights.map(fight => fight.order));
const orderOf = new Map(fights.map(fight => [fight.trainer, fight.order]));

test('every dated order in availability.json is a fight the run can be at', () => {
	// The Miracle-Seed shape: Cut's gate sat at 103 — a number between
	// fights — for a whole migration pass, and nothing said so until an item
	// three layers downstream failed. Membership is checked at the source.
	const probe = (value, where) => {
		if (!Number.isInteger(value) || value <= 0) return;
		assert.ok(orders.has(value),
			`${where} is dated ${value}, which is not any fight of the run map`);
	};
	for (const key of ['items', 'moveItems', 'entries']) {
		for (const row of availability[key] || []) {
			probe(row.opensAt, `${key}/${row.name || row.map}`);
		}
	}
	for (const [move, value] of Object.entries(availability.hmMoves)) {
		probe(value, `hmMoves/${move}`);
	}
	for (const [method, value] of Object.entries(availability.methods)) {
		probe(value, `methods/${method}`);
	}
});

test('the HM gate is stored twice in availability.json and the copies agree', () => {
	// methods gates the encounter SLOT, hmMoves gates the TEACH; both are the
	// same story event. They disagreed for half a day after the insertion —
	// surf slots opened five fights before the file said Surf existed.
	assert.equal(availability.methods.surf, availability.hmMoves.Surf,
		'the surf slot and HM03 open at the same fight');
	assert.equal(availability.methods['rock-smash'], availability.hmMoves['Rock Smash'],
		'the rock-smash slot and its HM open at the same fight');
});

test('every LEVEL_CAPS row derives its order from its own trainer label', () => {
	// The cap is real game knowledge (Mechanic Changes.txt); the order is a
	// copy of what the label already names. If the copy cannot be derived,
	// either the label rotted or the order was hand-shifted wrong.
	for (const row of encounters.LEVEL_CAPS) {
		const matches = fights.filter(fight => fight.trainer.startsWith(row.trainer));
		assert.ok(matches.length, `${row.trainer} names no fight of the run map`);
		assert.ok(matches.some(fight => fight.order === row.order),
			`${row.trainer} is capped at order ${row.order}, but its label resolves to ` +
			matches.map(fight => fight.order).join('/'));
	}
});

test('every badge tier in sources.json opens at the fight its leader label names', () => {
	// The tier stores the leader's NAME and the leader's ORDER side by side;
	// the number is a copy the name can check. This replaces raw-order pins
	// in two other test files that were checking one copy against another.
	for (const tier of sources.gameCorner.tiers) {
		assert.equal(tier.opensAt, orderOf.get(tier.leader),
			`${tier.badge} opens with ${tier.leader}, whose fight is order ` +
			`${orderOf.get(tier.leader)}, not ${tier.opensAt}`);
	}
});

test('the engine bridge resolves the zero row', () => {
	// build-trainer-order-map.js scanned engine orders from 1 for as long as
	// the game's first fight was missing from our map; the day the fight came
	// back, its by-team match answered "candidates: 0". The engine database
	// is 0-based and this pins it.
	const rows = Object.values(trainerOrders).find(value =>
		Array.isArray(value) && value.length > 50);
	const sceptile = rows.find(row => row.trainer === 'Trainer Rival Route 103 Sceptile');
	assert.ok(sceptile, 'the Route 103 Sceptile variant must be bridged');
	assert.equal(sceptile.order, 0, 'and it is the engine database\'s row zero');
});
