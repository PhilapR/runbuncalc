/* eslint-env node, es6 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const estimate = require('../scripts/estimate-availability.js');
const availability = require('../profiles/run-and-bun/oracle/availability.json');
const profiles = require('../profiles');

const maps = profiles.getProfile('run-and-bun').oracle.maps();
const dateOf = new Map(availability.entries.map(entry => [entry.map, entry.opensAt]));
const trainingRows = maps
	.filter(map => dateOf.has(map.map))
	.map(map => ({name: map.name, order: dateOf.get(map.map), levels: estimate.walkLevels(map)}))
	.filter(row => row.levels);

function levelsFor(name) {
	return estimate.walkLevels(maps.find(map => map.name === name));
}

test('the wild-level signal is measured before it is believed', () => {
	// Philip's idea: a location's wild levels say roughly when it opens. It
	// does — but only for the right statistic. MINIMUM level rank-correlates
	// at 0.57 because Kaizo tables put a low slot almost everywhere; maximum
	// and median reach 0.87. Picking min would have looked entirely
	// reasonable and been close to useless, which is why this is pinned.
	const validation = estimate.crossValidate();
	assert.ok(validation.n >= 60, 'enough dated locations to validate against');
	assert.ok(validation.median <= 40,
		`leave-one-out median error must stay small — got ${validation.median} orders`);
	assert.ok(validation.within(200) > 0.8,
		'four in five predictions must land within 200 orders');

	// And the tail must stay visible. The method is off by more than a
	// thousand roughly one time in eight; a version of this test that
	// asserted only the median would call that a success.
	const wild = validation.errors.filter(row => row.error > 800).length;
	assert.ok(wild > 0,
		'the known bad tail must still be present — if it vanished, the test is measuring the wrong thing');
	assert.ok(wild / validation.n < 0.25,
		`the tail must stay a minority — ${wild} of ${validation.n} badly wrong`);
});

test('neighbour disagreement separates the trustworthy estimates from the rest', () => {
	// The aggregate error is unusable on its own: excellent median, brutal
	// tail. What makes it actionable is that the failures announce
	// themselves — the neighbours a bad estimate is drawn from disagree with
	// each other BEFORE the answer is used.
	const oldale = levelsFor('Oldale Town');
	assert.ok(oldale, 'Oldale Town has a walk table');
	assert.equal(estimate.predictFromLevel(oldale, trainingRows), 0,
		'Oldale Town estimates to the very start of the run');
	assert.ok(estimate.neighbourSpread(oldale, trainingRows) <= 100,
		'and its neighbours agree, so the estimate is worth something');

	// A location the method should NOT be trusted on says so.
	const mirage = levelsFor('Mirage Tower 1f');
	assert.ok(mirage, 'Mirage Tower has a walk table');
	assert.ok(estimate.neighbourSpread(mirage, trainingRows) > 400,
		'Mirage Tower neighbours disagree wildly — the estimate must not read as confident');

	// The separation has to be real, not an artefact of two hand-picked rows.
	const spreads = maps
		.filter(map => !dateOf.has(map.map))
		.map(map => estimate.neighbourSpread(estimate.walkLevels(map), trainingRows))
		.filter(spread => spread !== null);
	const tight = spreads.filter(spread => spread <= 100).length;
	assert.ok(tight > 0 && tight < spreads.length,
		`the banding must actually split the undated set — ${tight} tight of ${spreads.length}`);
});

test('geography only reaches numbered routes, and says nothing about the rest', () => {
	// The second signal Philip named. It works where the name carries the
	// ordinal, and nowhere else: no map graph exists in this repo, so nothing
	// here knows where Fiery Path is. Pinning the limit stops a later reader
	// assuming the estimator understands the map.
	assert.equal(typeof estimate.predictFromRouteNumber('Route122'), 'number',
		'a numbered route interpolates from its dated neighbours');
	assert.equal(estimate.predictFromRouteNumber('Fiery Path'), null,
		'a named location has no geographic signal available');
	assert.equal(estimate.predictFromRouteNumber('Oldale Town'), null,
		'and neither does a town');
});

test('the R&B tracker order is validated against the dates, not assumed', () => {
	// Philip pointed at the community tracker as the likely-correct route
	// order, and it is. But its location HEADERS survive only as orphaned
	// strings in sharedStrings.xml — no cell references them — so "the order
	// they appear in is the column order" is an INFERENCE. This is what
	// makes it safe to act on: across every dated location the tracker
	// covers, its position ranks with opensAt at 0.85. A wrong order could
	// not do that.
	//
	// 0.85, not the 0.96 the exact-name subset shows. The gap is five Meteor
	// Falls rooms, which the tracker places right after Route 114 and
	// availability.json dates at 1526 — you walk past Meteor Falls early and
	// nobody stands there to fight until very late. Quoting the 0.96 would
	// mean quoting a number measured on the subset that excludes the one
	// place the two orderings genuinely disagree.
	const tracker = require('../profiles/run-and-bun/oracle/tracker-order.json');
	assert.equal(tracker.provenance, 'derived',
		'this file is inferred, and must never claim to be transcribed');
	assert.ok(tracker.order.length > 80, 'the tracker covers the whole map');
	assert.equal(tracker.order[0], 'Littleroot Town', 'it starts where the run starts');

	const dated = maps.filter(map => dateOf.has(map.map));
	const pairs = dated
		.map(map => ({
			pos: estimate.trackerPosition.get(estimate.normalizeName(map.name)),
			order: dateOf.get(map.map),
		}))
		.filter(row => row.pos !== undefined);
	assert.ok(pairs.length >= 50, `enough overlap to measure — got ${pairs.length}`);

	const rank = values => {
		const indexed = values.map((value, index) => [value, index]).sort((a, b) => a[0] - b[0]);
		const ranks = new Array(values.length);
		indexed.forEach((entry, position) => { ranks[entry[1]] = position; });
		return ranks;
	};
	const rx = rank(pairs.map(row => row.pos));
	const ry = rank(pairs.map(row => row.order));
	const mean = (pairs.length - 1) / 2;
	let numerator = 0;
	let dx = 0;
	let dy = 0;
	for (let i = 0; i < pairs.length; i += 1) {
		numerator += (rx[i] - mean) * (ry[i] - mean);
		dx += (rx[i] - mean) ** 2;
		dy += (ry[i] - mean) ** 2;
	}
	const rho = numerator / Math.sqrt(dx * dy);
	assert.ok(rho > 0.8,
		`tracker position must track the known dates — rank correlation ${rho.toFixed(3)}`);
});

test('the tracker reaches locations no other signal can, and admits where it stops', () => {
	// The point of the tracker: it names trainerless places, which is exactly
	// the set availability.json is blind to. Littleroot has no walk table at
	// all, so the wild-level signal cannot see it either — the tracker can.
	assert.equal(estimate.predictFromTracker('Littleroot Town'), 0,
		'Littleroot is where the run begins');
	assert.equal(estimate.walkLevels(maps.find(map => map.name === 'Littleroot Town')), null,
		'and the level signal has nothing to work with there');

	// Mirage Tower used to collapse to one number for all four floors under
	// the level signal. The tracker separates them.
	const floors = ['Mirage Tower 1f', 'Mirage Tower 2f', 'Mirage Tower 3f', 'Mirage Tower 4f']
		.map(name => estimate.predictFromTracker(name));
	assert.ok(floors.every(order => order !== null), 'every floor is placed');
	assert.ok(new Set(floors).size > 1,
		'the floors must not all collapse to one order the way the level signal made them');

	// And it must stay silent about what it genuinely does not list. Artisan
	// Cave is post-game content the tracker never mentions; inventing a
	// position for it would be the same error as the original bug.
	assert.equal(estimate.predictFromTracker('Artisan Cave 1f'), null,
		'a location the tracker does not list gets no tracker answer');
});
