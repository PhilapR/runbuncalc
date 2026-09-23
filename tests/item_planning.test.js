/* eslint-env node, es6 */
'use strict';

/**
 * Gate for the planner's HELD ITEMS (--plan-items, docs/PLAN.md 2.1).
 *
 * planByPlay proposed leads, closers and who makes room, and never an item:
 * at Champion Wallace the Focus Sash on the lead Dhelmise that halved Primal
 * Kyogre's cost was an operator's hand (--lead-for). These tests play the real
 * planner on a banked document — the board, the scouting fights, the run's own
 * give and take — not hand-made battle facts.
 *
 * A policy change ships off: with the knob off the planner must be exactly
 * what it was, and with it on an item may move but never be made or lost, and
 * the run's one Mega stays where it is.
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const run = require('../lib/run.js');
const headless = require('../scripts/headless-run.js');
const battery = require('../scripts/scenario-battery.js');
const policy = require('../scripts/ui-playthrough.js');

const SIDNEY = path.join(__dirname, '..', 'fixtures', 'banked-runs', 'clear1-418957-sidney.run.json');
const BRAWLY = path.join(__dirname, '..', 'fixtures', 'banked-runs', 'clear1-731001-brawly.run.json');

/**
 * Seed 418957's box at the Elite Four, fielding the six the planner itself
 * takes against Champion Wallace from there (Dhelmise leading), with both
 * Focus Sashes on the bench: Diggersby and Gengar hold them.
 */
function wallaceDoc() {
	let doc = battery.loadDocument(SIDNEY);
	const id = species => doc.box.find(mon => mon.species === species && mon.status !== 'dead').id;
	doc = run.apply(doc, {kind: 'party', ids: ['Dhelmise', 'Donphan', 'Florges', 'Ampharos', 'Lopunny', 'Togekiss'].map(id)});
	return doc;
}

function plan(doc, trainer, knobs) {
	const tally = {};
	const out = headless.withKnobs(Object.assign({planSeeds: 2}, knobs),
		() => headless.planByPlay(policy, structuredClone(doc), {trainer}, tally));
	return {out, tally, plan: tally.plans[0]};
}

/** Every item the run owns, bag and bodies, as name -> count. */
function holdings(doc) {
	const all = {};
	for (const name of Object.keys(doc.bag || {})) all[name] = (all[name] || 0) + doc.bag[name];
	for (const mon of doc.box) if (mon.item) all[mon.item] = (all[mon.item] || 0) + 1;
	return Object.fromEntries(Object.entries(all).filter(entry => entry[1] > 0).sort());
}

function megaHolders(doc) {
	const stones = require('../calc').MEGA_STONES;
	return doc.box.filter(mon => mon.item && stones[mon.item]).map(mon => mon.id + '@' + mon.item).sort();
}

test('the knob is read from an arm and recorded as a knob, off unless named', () => {
	assert.equal(headless.armFlags('--plan-items=1').knobs.planItems, true);
	assert.equal(headless.armFlags('--plan-items=0').knobs.planItems, false);
	assert.equal(headless.armFlags('--plan-seeds=2').knobs.planItems, undefined, 'an arm that does not name it inherits the default');
});

test('knob off: the planner is exactly what it was before items were planned', () => {
	// When the knob landed (ad01a5f), a hash of the whole output matched the
	// planner at 6d12a46 byte for byte. That pin could not outlive the engine:
	// every fidelity fix since moves the fights it scores. What holds on any
	// engine: no item record, the same six, and no item moved, made or lost.
	const doc = wallaceDoc();
	const planned = plan(doc, 'Champion Wallace', {});
	const out = planned.out;
	const taken = planned.plan;
	assert.equal(taken.items, undefined, 'no item record when the knob is off');
	assert.equal(taken.took, 'Dhelmise > Donphan > Florges > Ampharos > Lopunny > Togekiss');
	assert.deepEqual(out.box.map(mon => [mon.id, mon.item || null]), doc.box.map(mon => [mon.id, mon.item || null]),
		'every body holds what it held');
	assert.deepEqual(out.bag, doc.bag, 'the bag is untouched');
});

/** The knob-on plan at Champion Wallace, played once and shared: it costs about a minute and a half. */
let wallacePlanned = null;
function wallacePlan() {
	if (!wallacePlanned) {
		const doc = wallaceDoc();
		wallacePlanned = Object.assign({doc}, plan(doc, 'Champion Wallace', {planItems: true}));
	}
	return wallacePlanned;
}

test('knob on, at Champion Wallace: the planner proposes the Focus Sash lead and takes it by play', () => {
	const planned = wallacePlan();
	const doc = planned.doc;
	const out = planned.out;
	const taken = planned.plan;
	assert.ok(taken.items.includes('Dhelmise@Focus Sash'), 'proposed: ' + JSON.stringify(taken));
	// Deterministic on these seeds: the sash wins its scouting fights.
	assert.deepEqual(taken.held, ['Dhelmise@Focus Sash'], JSON.stringify(taken));
	assert.ok(taken.wins > taken.stood.wins || (taken.wins === taken.stood.wins && taken.left < taken.stood.left),
		'taken only because play said it was better: ' + JSON.stringify(taken));
	const lead = run.findMon(out, out.party[0]);
	assert.equal(lead.species + '@' + lead.item, 'Dhelmise@Focus Sash', 'the document fights with it');
	// No sash was in the bag: one came off a benched body, and nothing was made or lost.
	assert.deepEqual(holdings(out), holdings(doc), 'items conserved');
	assert.equal(out.box.filter(mon => mon.item === 'Focus Sash').length, 2);
	assert.deepEqual(megaHolders(out), megaHolders(doc), 'every Mega Stone stays on its body');
	assert.ok(out.log.length > doc.log.length && out.log.slice(doc.log.length).some(entry => entry.command.kind === 'take'),
		'the move is on the run\'s own log, where the audit replays it');
});

test('knob on, on a small box: whatever the planner moves, items are conserved and the Mega untouched', () => {
	const doc = battery.loadDocument(BRAWLY);
	const planned = plan(doc, 'Leader Brawly', {planItems: true});
	const out = planned.out;
	const taken = planned.plan;
	assert.ok(Array.isArray(taken.items) && Array.isArray(taken.held), JSON.stringify(taken));
	assert.deepEqual(holdings(out), holdings(doc), 'items conserved');
	assert.deepEqual(megaHolders(out), megaHolders(doc));
	for (const label of taken.held) {
		const species = label.split('@')[0];
		const item = label.split('@')[1];
		assert.ok(out.party.some(id => { const mon = run.findMon(out, id); return mon.species === species && mon.item === item; }), label);
	}
});

test('an item change never touches a Mega body: a stone holder keeps its stone, and one whose stone is in the bag is left for giveMegaStone', () => {
	const doc = wallaceDoc();
	const lopunny = doc.box.find(mon => mon.species === 'Lopunny');
	assert.ok(doc.party.includes(lopunny.id) && run.stoneInBag(doc, 'Lopunny'), 'the fixture: Lopunny in the six, Lopunnite in the bag');
	assert.equal(headless.withKnobs({}, () => headless.withItem(doc, {kind: 'item', id: lopunny.id, item: 'Focus Sash'})), null,
		'its stone in the bag: the stone is giveMegaStone\'s to hand');
	const holding = run.apply(doc, {kind: 'give', id: lopunny.id, item: 'Lopunnite'});
	assert.equal(headless.withKnobs({}, () => headless.withItem(holding, {kind: 'item', id: lopunny.id, item: 'Focus Sash'})), null,
		'holding its stone: a give would swap the run\'s one Mega back into the bag');
	const dhelmise = doc.party[0];
	const moved = headless.withKnobs({}, () => headless.withItem(doc, {kind: 'item', id: dhelmise, item: 'Focus Sash'}));
	assert.equal(run.findMon(moved, dhelmise).item, 'Focus Sash', 'a body with no Mega takes it — off the bench, no sash being in the bag');
	assert.deepEqual(holdings(moved), holdings(doc), 'items conserved');
});

test('a held plan keeps its items: advice between attempts does not replace the planned Focus Sash', () => {
	// planHolds kept the plan's six but not what it held: followAdvice ran again
	// whenever the box or bag changed, and its "Colbur Berry over Focus Sash"
	// undid the lead the planner had just taken by play.
	const out = wallacePlan().out;
	const tally = wallacePlan().tally;
	const lead = out.party[0];
	assert.equal(run.findMon(out, lead).item, 'Focus Sash', 'the fixture: the plan put the sash on the lead');
	const keep = headless.plannedHolders(out, tally);
	assert.deepEqual([...keep], [lead], 'the plan\'s held item names its holder');
	const advised = headless.withKnobs({}, () => headless.followAdvice(out, headless.armFlags(''), {}, new Map(), keep));
	assert.equal(run.findMon(advised, lead).species + '@' + run.findMon(advised, lead).item, 'Dhelmise@Focus Sash',
		'the advice passed over the planned holder');
	assert.deepEqual(headless.plannedHolders(out, {}), new Set(), 'no plan, nothing kept');
});

test('the battery plans a scenario the way a run does, and --plan-items reaches the planner', () => {
	const withArgv = (extra, fn) => {
		const saved = process.argv;
		process.argv = ['node', 'battery'].concat(extra);
		try {
			return fn();
		} finally {
			process.argv = saved;
		}
	};
	const scenario = {name: 'Brawly', trainer: 'Leader Brawly', report: BRAWLY, seeds: 1};
	const base = ['--repick-party=0', '--plan-seeds=1'];
	assert.throws(() => withArgv(['--repick-party=0', '--plan-items=1'], () => battery.runScenario(policy, scenario)),
		/--plan-items is a planner knob; it needs --plan-by-play=1/);
	const off = withArgv(base.concat(['--plan-by-play=1']), () => battery.runScenario(policy, scenario));
	assert.equal(off.counters.planned, 1, JSON.stringify(off.plan));
	assert.equal(off.plan.trainer, 'Leader Brawly');
	assert.equal(off.plan.items, undefined, 'no item record with the knob off');
	const on = withArgv(base.concat(['--plan-by-play=1', '--plan-items=1']), () => battery.runScenario(policy, scenario));
	assert.ok(Array.isArray(on.plan.items), 'the knob reached the planner: ' + JSON.stringify(on.plan));
	assert.equal(on.counters.itemsHeld, on.plan.held.length ? 1 : 0);
	const control = withArgv(['--repick-party=0'], () => battery.runScenario(policy, scenario));
	assert.equal(control.plan, undefined, 'a receipt without the flag carries no plan');
});
