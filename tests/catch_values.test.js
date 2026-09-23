/* eslint-env node, es6 */
'use strict';

/**
 * Gate for the early-catch key and planner v2: values built from receipts,
 * refused across engines, and priced by encounter odds.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const builder = require('../scripts/build-catch-values.js');
const planner = require('../scripts/catch-planner.js');
const battery = require('../scripts/scenario-battery.js');
const dossier = require('../lib/dossier');

const committed = () => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'scenarios', 'catch-values',
	'leader-brawly.json'), 'utf8'));

test('the Brawly key is what the committed receipts say', () => {
	const built = builder.buildValues('scenarios/brawly.json', committed().screened);
	assert.deepEqual(built.values, committed().values, 'the committed key rebuilds from the committed receipts');
	assert.equal(built.control.wins, 30);
	assert.deepEqual(built.values.MAP_ROUTE104.Combee, {wins: 75, gain: 45 / 380, gained: 60, lost: 15, p: 1.59e-7});
	assert.equal(built.values.MAP_DEWFORD_TOWN['Tyrogue>Hitmontop'].wins, 79);
	assert.equal(built.values.MAP_DEWFORD_TOWN['Tyrogue>Hitmonchan'].wins, 17, 'the named answer is the worst branch');
	assert.equal(builder.mcnemar(0, 0), 1);
});

test('controls that disagree refuse the key: a gain across engines is not a gain', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'key-'));
	const receipt = (label, result, argv) => ({label, manifest: 'scenarios/x.json', argv: argv || [],
		provenance: {revision: label}, results: [{name: 'Fight', rows: [{seed: 1, result, turns: 9, deaths: 1}]}]});
	fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify(receipt('a-ctl-pp', 'win')));
	fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify(receipt('b-ctl-pp', 'loss')));
	assert.throws(() => builder.buildValues('scenarios/x.json', {}, dir), /controls on scenarios\/x.json disagree/);
	fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify(receipt('b-ctl-pp', 'win')));
	fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify(receipt('c-swap-pp', 'loss',
		['--swap-catch=MAP_ROUTE104:Paras'])));
	assert.deepEqual(builder.buildValues('scenarios/x.json', {}, dir).values.MAP_ROUTE104.Paras,
		{wins: 0, gain: -1, gained: 0, lost: 1, p: 1});
});

test('planner v2 prices a method by odds, and a stat-branching line by its forms', () => {
	const values = committed();
	const doc = battery.loadDocument('fixtures/banked-runs/brkeys3-A-5.run.json');
	const plan = planner.planFromValues(doc, values, {fresh: true});
	const route = map => plan.routes.find(entry => entry.map === map);
	const fish = route('MAP_ROUTE104').methods.find(method => method.method === 'fish');
	const odds = {Horsea: 30, Remoraid: 20, Buizel: 20, Krabby: 20, Clauncher: 10};
	const expected = Object.keys(odds).reduce((sum, species) =>
		sum + odds[species] / 100 * values.values.MAP_ROUTE104[species].gain, 0);
	assert.ok(Math.abs(fish.expectedGain - expected) < 1e-12, fish.expectedGain + ' vs ' + expected);
	const tyrogue = route('MAP_DEWFORD_TOWN').methods.find(method => method.method === 'walk')
		.species.find(entry => entry.species === 'Tyrogue');
	const branch = dossier.branchOdds('Tyrogue', 20);
	const dewford = values.values.MAP_DEWFORD_TOWN;
	assert.ok(Math.abs(tyrogue.gain - Object.keys(branch).reduce((sum, form) =>
		sum + branch[form] * dewford['Tyrogue>' + form].gain, 0)) < 1e-12);
	assert.ok(tyrogue.gain > 0 && tyrogue.gain < dewford['Tyrogue>Hitmontop'].gain,
		'a Tyrogue is worth its roll, not its best form');
	assert.equal(route('MAP_ROUTE103').best.target, null, 'a route the key never moved names no target');
});

test('planner v2 rolls without the run\'s own lines, and skips a route the run has spent', () => {
	const values = committed();
	const doc = structuredClone(battery.loadDocument('fixtures/banked-runs/brkeys3-A-5.run.json'));
	const fresh = planner.planFromValues(doc, values, {fresh: true});
	assert.ok(fresh.routes.some(route => route.map === 'MAP_ROUTE104'));
	const spent = planner.planFromValues(doc, values, {});
	assert.ok(!spent.routes.some(route => route.map === 'MAP_ROUTE104'), 'the box already caught on Route 104');
	// Free Route 104, and put a Seadra in the box: under the line clause no
	// Horsea can be rolled there, and fishing re-weighs without it.
	for (const mon of doc.box) if (mon.origin && mon.origin.map === 'MAP_ROUTE104') mon.origin.map = 'MAP_NOWHERE';
	doc.box[0].species = 'Seadra';
	doc.rules = Object.assign({}, doc.rules, {dupesClause: 'line'});
	const fish = planner.planFromValues(doc, values, {}).routes.find(route => route.map === 'MAP_ROUTE104')
		.methods.find(method => method.method === 'fish');
	assert.ok(!fish.species.some(entry => entry.species === 'Horsea'), 'a dupe is never rolled');
	assert.ok(Math.abs(fish.species.reduce((sum, entry) => sum + entry.chance, 0) - 1) < 1e-12);
});
