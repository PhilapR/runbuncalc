/* eslint-env node, es6 */
'use strict';

/**
 * Gate for the run simulation.
 *
 * `planner.test.js` already covers one fight at a time. What is only checkable
 * here is the walk: that a stretch of the run produces one row per fight, that
 * the aggregate actually describes those rows rather than being computed
 * separately and drifting, and that a single unbuildable position does not take
 * the rest of the walk down with it.
 *
 * Scores and parties are not re-asserted here — they belong to the layers below
 * and are gated there. The one prediction this file pins is the run's first
 * fight, because a simulation whose first row is wrong is not worth reading
 * further.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const simulate = require('./simulate');
const getProfile = require('./profiles').getProfile;

test('a team is read as Species (Set Label), commas and all', () => {
	assert.deepEqual(
		simulate.parseTeam('Gyarados (Rich Boy Dawson), Breloom (Black Belt Takao)'),
		[
			{species: 'Gyarados', setLabel: 'Rich Boy Dawson'},
			{species: 'Breloom', setLabel: 'Black Belt Takao'},
		]
	);
	// Labels are trainer names, and trainer names carry punctuation the naive
	// "split on comma" reading would break on.
	assert.deepEqual(
		simulate.parseTeam('Milotic (Cool Trainer Carolina & Cory)'),
		[{species: 'Milotic', setLabel: 'Cool Trainer Carolina & Cory'}]
	);
});

test('a team missing its set label is refused, not guessed at', () => {
	assert.throws(() => simulate.parseTeam('Azumarill'), /Species \(Set Label\)/);
	assert.throws(() => simulate.parseTeam(''), /at least one Pokemon/);
	// Trailing junk after a valid entry must not be silently dropped.
	assert.throws(
		() => simulate.parseTeam('Azumarill (Leader Norman) and also Gyarados'),
		/could not read/
	);
});

test('milestones are the profile\'s notion of a story fight, not this tool\'s', () => {
	const all = simulate.selectFights({});
	const milestones = simulate.selectFights({milestones: true});
	assert.equal(all.length, 362, 'the unfiltered walk is the whole run map');
	assert.equal(milestones.length, 34);

	const pattern = getProfile().encounters.MILESTONE_PATTERN;
	assert.ok(pattern, 'the profile must declare the pattern the walk filters on');
	for (const fight of milestones) {
		assert.match(fight.trainer, pattern);
	}
	// The spine has to start and end where a playthrough does.
	assert.equal(milestones[0].trainer, 'Leader Brawly');
	assert.equal(milestones[milestones.length - 1].trainer, 'Champion Wallace');
});

test('a window selects by progression index, not by position in the list', () => {
	const window = simulate.selectFights({from: 77, to: 340});
	assert.ok(window.length > 1);
	assert.equal(window[0].order, 77);
	assert.ok(window.every(f => f.order >= 77 && f.order <= 340));
	assert.equal(simulate.selectFights({from: 0, count: 3}).length, 3);
});

test('a walk yields one row per fight, and the summary describes those rows', () => {
	const run = simulate.simulate({
		party: [{species: 'Gyarados', setLabel: 'Rich Boy Dawson'}],
		from: 0,
		count: 8,
	});

	assert.equal(run.steps.length, 8);
	assert.equal(run.summary.fights, 8);
	assert.equal(run.summary.failed, 0);
	assert.equal(
		run.summary.decided + run.summary.contested + run.summary.onlyOption,
		run.summary.planned,
		'every planned fight must land in exactly one confidence bucket'
	);
	// The coin-flip list is the actionable half of the summary; it must be the
	// contested rows themselves, not a separately derived count.
	assert.equal(run.summary.coinFlips.length, run.summary.contested);
	for (const flip of run.summary.coinFlips) {
		const step = run.steps.find(s => s.order === flip.order);
		assert.equal(step.confidence, 'contested');
		assert.equal(step.margin, flip.margin);
	}

	for (const step of run.steps) {
		assert.ok(step.actions.length >= 1, `${step.trainer} produced no actions`);
		assert.ok(step.actions.every(a => typeof a.label === 'string' && a.label));
		for (let i = 1; i < step.actions.length; i++) {
			assert.ok(step.actions[i - 1].score >= step.actions[i].score, 'actions must be ranked');
		}
		assert.equal(step.levelDelta, step.playerLevel - step.opponentLevel);
		// The level a player is measured against is the fight's, not the lead's.
		assert.ok(step.opponentLevel >= step.lead.level);
	}
});

test('the first fight of the run predicts what it predicted before', () => {
	const run = simulate.simulate({
		party: [{species: 'Gyarados', setLabel: 'Rich Boy Dawson'}],
		from: 0,
		count: 1,
	});
	const step = run.steps[0];
	assert.equal(step.trainer, 'Youngster Calvin');
	assert.equal(step.lead.species, 'Poochyena');
	assert.equal(step.lead.level, 5);
	assert.equal(step.actions[0].label, 'Quick Attack');
	assert.equal(step.confidence, 'decided');
});

test('one unbuildable fight does not take the rest of the walk with it', () => {
	// A set label that exists for no species: the position cannot be built, so the
	// row records why and the walk continues.
	const run = simulate.simulate({
		party: [{species: 'Gyarados', setLabel: 'No Such Trainer'}],
		from: 0,
		count: 3,
	});
	assert.equal(run.steps.length, 3);
	assert.equal(run.summary.planned, 0);
	assert.equal(run.summary.failed, 3);
	for (const step of run.steps) {
		assert.ok(step.error, 'an unbuildable fight must say so');
		assert.equal(step.actions, undefined);
	}
});

test('a party is required — a run cannot be simulated with no team', () => {
	assert.throws(() => simulate.simulate({from: 0, count: 1}), /party is required/);
});

test('the rendering carries the numbers a reader plans against', () => {
	const run = simulate.simulate({
		party: [{species: 'Gyarados', setLabel: 'Rich Boy Dawson'}],
		from: 0,
		count: 8,
	});
	const text = simulate.format(run);
	assert.match(text, /Youngster Calvin/);
	assert.match(text, /Quick Attack/);
	assert.match(text, /fights planned/);
	// A confidence report with no level context reads as a clean plan while the
	// team is unplayably short, so the delta has to survive rendering.
	assert.match(text, /you L\d+ \((\+\d+|-\d+|level)\)/);
});
