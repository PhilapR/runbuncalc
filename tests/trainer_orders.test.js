/* eslint-env node, es6 */
'use strict';

/**
 * Gate for the fight-label to engine-trainer-order map.
 *
 * The run and the planning engine are independent transcriptions of the same
 * game and they disagree about names, so 152 of 362 fights could not be looked
 * up and lost their survival forecast. profiles/run-and-bun/oracle/
 * trainer-orders.json reconciles them: the engine's own answer where it has
 * one, and a match on the TEAM where it does not.
 *
 * Team matching is only safe because it is checkable. On the 210 fights the
 * engine resolves by name, the team gives the same order 191 times and a
 * different one never. That agreement is asserted here rather than assumed,
 * because the failure mode is not a gap — a wrong order names a DIFFERENT
 * trainer, and the forecast would be confidently wrong instead of absent.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const builder = require('../scripts/build-trainer-order-map.js');
const map = require('../profiles/run-and-bun/oracle/trainer-orders.json');
const runtime = require('@philapr/pokemon-run-runtime');
const planner = require('../lib/planner');

test('the committed map is what the builder produces', () => {
	// Both databases are pinned, so this is data and not a heuristic: it must
	// regenerate byte for byte or something under it moved.
	const built = builder.build('run-and-bun');
	assert.equal(built.counts.byName, map.resolvedByName);
	assert.equal(built.counts.byTeam, map.resolvedByTeam);
	assert.equal(built.counts.unmatched, map.unmatchedCount);
	assert.deepEqual(built.entries, map.entries, 'the map has drifted from its source');
	assert.deepEqual(built.unmatched, map.unmatched);
});

test('a name and a team never disagree about which trainer this is', () => {
	// The property that licenses team matching at all. If this ever fails the
	// map must not ship, and the builder refuses to write one.
	const check = builder.crossCheck('run-and-bun');
	assert.deepEqual(check.disagreed, [],
		'team matching contradicts the engine, so it cannot be trusted for the rest');
	assert.ok(check.agreed > 150,
		'the cross-check is only worth anything over a large sample; got ' + check.agreed);
	assert.equal(check.agreed, map.crossChecked);
});

test('every team-matched fight really does have the engine team', () => {
	// The entries found by team are the ones nothing else vouches for, so the
	// match is re-derived here from the engine rather than read back out of the
	// file that recorded it.
	const byOrder = runtime.createRabRunRuntimeProvider({}).options.resolveTrainer;
	const fights = new Map(planner.loadRunMap('run-and-bun').map(f => [f.trainer, f]));
	const teamed = map.entries.filter(entry => entry.by === 'team');
	assert.ok(teamed.length > 100, 'expected the team match to carry most of the gap');
	for (const entry of teamed) {
		const ours = fights.get(entry.trainer);
		assert.ok(ours, entry.trainer + ' is in the map but not in the run map');
		const theirs = byOrder(entry.order);
		assert.equal(builder.teamKey(ours.party), builder.teamKey(theirs.pokemon),
			entry.trainer + ' was matched to ' + theirs.name + ' at order ' + entry.order +
			', which has a different team');
	}
});

test('a double is why most of them differ, and the engine says so itself', () => {
	// The mechanism, pinned so a future reader knows why the map exists. The
	// engine keeps a double under the lead and names the other half; we write
	// both into one label.
	const jerry = map.entries.find(entry => entry.trainer === 'School Kid Jerry & Johnson');
	assert.ok(jerry, 'the worked example must stay in the map');
	assert.equal(jerry.by, 'team');
	assert.equal(jerry.engineName, 'School Kid Jerry');
	assert.equal(jerry.isDouble, true);
	assert.equal(jerry.doublePartner, 'Youngster Johnson');

	// And it is not one case: doubles are the bulk of what team matching bought.
	const doubles = map.entries.filter(entry => entry.by === 'team' && entry.isDouble);
	assert.ok(doubles.length >= 40,
		'expected doubles to dominate the team-matched entries; got ' + doubles.length);
});

test('a fight the map cannot place gets nothing, never a neighbour', () => {
	// The refusal is the safety property. An order that is off by one is a
	// different trainer's team, so an unplaced fight must stay unplaced.
	//
	// Honest limit: this cannot falsify the AMBIGUITY half of that refusal.
	// Relaxing the builder's `hits.length === 1` to `>= 1` leaves these gates
	// green, because all 28 unmatched fights have ZERO candidates rather than
	// several.
	//
	// A team collision does exist, which is worth stating precisely rather
	// than claiming teams are unique: the engine's Swimmer Tony at order 169
	// and Beauty Thalia at 179 both field Kingdra L50 and Wailord L50, so 431
	// trainers hold 430 distinct teams. Neither is in this run's map, so the
	// branch is unreached rather than unnecessary — and the day a third
	// collision lands on a fight we do have is not the day anyone rereads
	// this.
	assert.ok(map.unmatched.length > 0, 'the fixture is only meaningful while some remain');
	const placed = new Set(map.entries.map(entry => entry.trainer));
	for (const row of map.unmatched) {
		assert.ok(!placed.has(row.trainer),
			row.trainer + ' is listed as unmatched and also given an order');
	}
	// Leader Flannery is among them, which is worth knowing: a boss with no
	// counterpart in the engine's database is a data gap, not a naming one.
	assert.ok(map.unmatched.some(row => /Flannery/.test(row.trainer)),
		'Flannery is the loudest of the unmatched and should stay visible here');
});

test('the map covers far more than the engine does alone', () => {
	// The before and after, kept as a number so a regression is obvious.
	const coverage = (map.resolvedByName + map.resolvedByTeam) / map.fights;
	assert.equal(map.resolvedByName, 210, 'the engine alone resolves 210 of 362');
	assert.ok(coverage > 0.9,
		'coverage fell to ' + (100 * coverage).toFixed(1) + '%, from a measured 92.3%');
});
