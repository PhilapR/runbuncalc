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
