/* eslint-env node, es6 */
'use strict';

/**
 * The frontier set (scripts/frontier-set.js): every scenario is the document a
 * stored run fielded at a fight it stalled on, cut from a banked source. The
 * banked sources are what the manifest says they are, and each cut stands
 * before its wall: the fight is still ahead of it.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');

const battery = require('../scripts/scenario-battery.js');
const frontier = require('../scripts/frontier-set.js');
const run = require('../lib/run.js');

const ROOT = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'scenarios', 'frontier.json'), 'utf8'));

test('each banked source is the document the manifest names, byte for byte', () => {
	assert.ok(manifest.sources.length > 0);
	for (const source of manifest.sources) {
		const body = zlib.gunzipSync(fs.readFileSync(path.join(ROOT, source.file))).toString('utf8');
		assert.equal(crypto.createHash('sha256').update(body).digest('hex'), source.sha256, source.file);
	}
	const named = new Set(manifest.sources.map(source => source.file));
	for (const scenario of manifest.scenarios) assert.ok(named.has(scenario.report), scenario.name + ' names a banked source');
});

test('every frontier scenario is cut before its wall, on the map\'s scale, and reaches past Norman', () => {
	// One replay per source, a snapshot at each cut: a replay per scenario costs minutes.
	const bySource = new Map();
	for (const scenario of manifest.scenarios) {
		bySource.set(scenario.report, (bySource.get(scenario.report) || []).concat([scenario]));
	}
	for (const entry of bySource) {
		const file = entry[0];
		const scenarios = entry[1];
		const source = battery.loadDocument(path.join(ROOT, file));
		const cuts = new Map(scenarios.map(scenario => [scenario.at, []]));
		for (const scenario of scenarios) cuts.get(scenario.at).push(scenario);
		let doc = run.createRun({profileId: source.profileId, attemptId: source.attemptId, name: source.name,
			now: source.createdAt, levelCap: source.rules.levelCap});
		doc.rules = JSON.parse(JSON.stringify(source.rules));
		for (let at = 0; at <= source.log.length; at++) {
			for (const scenario of cuts.get(at) || []) {
				battery.requireScale(doc);
				assert.ok(!doc.log.some(entry => entry.command.kind === 'beat' && entry.command.trainer === scenario.trainer),
					scenario.name + ': the cut has not beaten its wall');
				assert.ok(doc.party.length > 0, scenario.name + ': a six to field');
			}
			if (at < source.log.length) doc = run.apply(doc, source.log[at].command, {now: source.log[at].at});
		}
	}
	const orders = manifest.scenarios.map(scenario => Number(scenario.name.match(/ @(\d+) /)[1]));
	assert.ok(orders.filter(order => order > 342).length > manifest.scenarios.length / 2,
		'most of the set is past Norman (run-map order 342), where the runs stall');
	assert.ok(manifest.scenarios.some(scenario => /Champion Wallace/.test(scenario.trainer)));
	assert.ok(manifest.scenarios.some(scenario => require('../lib/planner').getFight(scenario.trainer, 'run-and-bun').isDouble),
		'doubles are in the set');
});

test('the battery loads a scenario at its cut, and refuses a cut past the log', () => {
	// A wall the run won: the next command after the cut is its beat.
	const scenario = manifest.scenarios.find(entry => entry.beaten && /Elite Four Drake/.test(entry.trainer));
	const whole = battery.loadDocument(path.join(ROOT, scenario.report));
	assert.equal(whole.log[scenario.at].command.kind, 'beat');
	const cut = battery.loadDocument(path.join(ROOT, scenario.report), scenario.at);
	assert.equal(cut.log.length, scenario.at);
	assert.deepEqual(cut.log, whole.log.slice(0, scenario.at), 'the cut is the log\'s own prefix');
	assert.ok(!cut.log.some(entry => entry.command.kind === 'beat' && entry.command.trainer === scenario.trainer),
		'and it has not beaten its wall');
	assert.throws(() => battery.replayTo(whole, whole.log.length + 1), /cannot cut a log/);
});

test('the rule: a wall the run won is cut before its beat, one it stopped at is the whole log, one it skipped is after the last win', () => {
	const beat = trainer => ({command: {kind: 'beat', trainer}});
	const report = {
		ledger: [
			{trainer: 'A', order: 1, result: 'win'},
			{trainer: 'B', order: 2, result: 'loss'}, {trainer: 'B', order: 2, result: 'loss'},
			{trainer: 'B', order: 2, result: 'loss'}, {trainer: 'B', order: 2, result: 'win'},
			{trainer: 'C', order: 3, result: 'loss'}, {trainer: 'C', order: 3, result: 'loss'}, {trainer: 'C', order: 3, result: 'loss'},
			{trainer: 'D', order: 4, result: 'win'},
			{trainer: 'E', order: 5, result: 'loss'}, {trainer: 'E', order: 5, result: 'loss'}, {trainer: 'E', order: 5, result: 'loss'},
		],
		doc: {log: [beat('A'), {command: {kind: 'give'}}, beat('B'), {command: {kind: 'teach'}}, beat('D'), {command: {kind: 'give'}}]},
	};
	const walls = frontier.wallsOf(report, 3);
	assert.deepEqual(walls.map(wall => [wall.trainer, wall.at, Boolean(wall.skipped)]),
		[['B', 2, false], ['C', 3, true], ['E', 6, false]]);
	assert.deepEqual(frontier.wallsOf(report, 4), [], 'fewer losses than the bar is not a wall');
	const capped = frontier.capPerTrainer([{trainer: 'X', lost: 3, name: 'a'}, {trainer: 'X', lost: 9, name: 'b'},
		{trainer: 'X', lost: 5, name: 'c'}, {trainer: 'Y', lost: 1, name: 'd'}], 2);
	assert.deepEqual(capped.map(entry => entry.name), ['b', 'c', 'd'], 'the runs that lost it most');
});
