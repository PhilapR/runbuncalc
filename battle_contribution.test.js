/* eslint-env node, es6 */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const run = require('./run');
const driver = require('./battle-driver');

const TEST_IVS = {hp: 17, atk: 18, def: 19, spa: 20, spd: 21, spe: 22};

function docWith(party) {
	let doc = run.createRun({name: 'Contribution test', now: 't0', permadeath: true});
	doc = run.applyAll(doc, party.map(entry => ({
		kind: 'catch',
		species: entry.species,
		map: entry.map,
		level: entry.level,
		ivs: Object.assign({}, TEST_IVS),
	})));
	return run.apply(doc, {kind: 'party',
		ids: party.map((entry, index) => `mon-${index + 1}`)});
}

function playOut(doc, seed, trainer) {
	let opened = driver.start(doc, trainer, seed);
	let battle = opened.battle;
	let actions = opened.actions;
	let reply = null;
	for (let guard = 0; guard < 80; guard++) {
		const pick = actions[0];
		assert.ok(pick, 'the driver must offer a legal action while the fight runs');
		reply = driver.act(battle, pick.kind === 'move' ?
			{kind: 'move', move: pick.move} :
			{kind: 'switch', replacementId: pick.action.replacementId});
		battle = reply.battle;
		actions = reply.actions;
		if (reply.result) return reply;
	}
	assert.fail('the fight must end inside the guard');
}

function row(battle, monId) {
	return battle.contributions.find(entry => entry.monId === monId);
}

test('battle bundles report entry, attempted moves, direct damage, and KOs', () => {
	const doc = docWith([{species: 'Mudkip', level: 5}]);
	const opened = driver.start(doc, 'Youngster Calvin', 0);
	assert.deepEqual(row(opened.battle, 'mon-1'), {
		monId: 'mon-1', battleId: 'player-1', species: 'Mudkip',
		entered: 1, switchIns: 0, actions: 0, moveActions: 0,
		damageDealt: 0, kos: 0,
	});

	const first = driver.act(opened.battle, {kind: 'move', move: 'Water Gun'});
	const afterHit = row(first.battle, 'mon-1');
	assert.equal(afterHit.actions, 1);
	assert.equal(afterHit.moveActions, 1);
	assert.ok(afterHit.damageDealt > 0, 'direct opposing HP loss is recorded as damage');
	assert.equal(afterHit.kos, 0);

	const second = driver.act(first.battle, {kind: 'move', move: 'Water Gun'});
	const afterMiss = row(second.battle, 'mon-1');
	assert.equal(afterMiss.actions, 2, 'an attempted move counts as an action');
	assert.equal(afterMiss.moveActions, 2, 'an attempted move counts as a move action');
	assert.equal(afterMiss.damageDealt, afterHit.damageDealt,
		'a miss does not invent damage');

	const played = playOut(docWith([
		{species: 'Poochyena', map: 'Route101', level: 3},
		{species: 'Pidgey', map: 'Route102', level: 5},
	]), 42);
	assert.equal(played.result, 'win');
	assert.ok(played.battle.contributions.some(entry => entry.kos > 0),
		'a successful direct KO increments the acting mon contribution');
});

test('voluntary and forced replacements count the incoming mon entry and switch-in', () => {
	const voluntary = driver.start(docWith([
		{species: 'Poochyena', map: 'Route101', level: 3},
		{species: 'Pidgey', map: 'Route102', level: 5},
	]), undefined, 42);
	const switched = driver.act(voluntary.battle, {
		kind: 'switch', replacementId: 'player-2',
	});
	assert.deepEqual(row(switched.battle, 'mon-2'), {
		monId: 'mon-2', battleId: 'player-2', species: 'Pidgey',
		entered: 1, switchIns: 1, actions: 0, moveActions: 0,
		damageDealt: 0, kos: 0,
	});

	const forced = playOut(docWith([
		{species: 'Skitty', map: 'Route101', level: 2},
		{species: 'Starly', map: 'Route102', level: 5},
	]), 7, 'Leader Brawly');
	assert.ok(forced.deaths.length > 0);
	assert.ok(forced.battle.contributions.some(entry =>
		entry.monId === 'mon-2' && entry.entered > 0 && entry.switchIns > 0),
	'a forced replacement counts the incoming mon entry and switch-in');
});

test('same seed and action policy produce identical contribution arrays', () => {
	const doc = docWith([
		{species: 'Poochyena', map: 'Route101', level: 3},
		{species: 'Pidgey', map: 'Route102', level: 5},
	]);
	const first = playOut(doc, 42);
	const second = playOut(doc, 42);
	assert.deepEqual(first.battle.contributions, second.battle.contributions);
});

test('invalid actions do not mutate prior bundle telemetry', () => {
	const opened = driver.start(docWith([{species: 'Poochyena', map: 'Route101', level: 3}]), undefined, 1);
	const before = structuredClone(opened.battle.contributions);
	assert.throws(() => driver.act(opened.battle, {kind: 'move', move: 'Earthquake'}),
		/battle: "Earthquake" is not usable right now/);
	assert.deepEqual(opened.battle.contributions, before);
	assert.throws(() => driver.act(opened.battle, {
		kind: 'switch', replacementId: 'player-9',
	}), /battle: "player-9" is not a legal switch/);
	assert.deepEqual(opened.battle.contributions, before);
});

test('malformed resumed telemetry is rebuilt and remains explicitly partial', () => {
	const opened = driver.start(docWith([{species: 'Poochyena', map: 'Route101', level: 3}]),
		undefined, 1);
	const malformed = structuredClone(opened.battle);
	malformed.contributions[0].damageDealt = -1;
	const resumed = driver.act(malformed, {kind: 'move', move: 'Tackle'});

	assert.equal(resumed.battle.contributionComplete, false);
	assert.equal(row(resumed.battle, 'mon-1').moveActions, 1);
	assert.ok(row(resumed.battle, 'mon-1').damageDealt >= 0);
});
