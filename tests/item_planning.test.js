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
const crypto = require('node:crypto');
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
	for (const [name, count] of Object.entries(doc.bag || {})) all[name] = (all[name] || 0) + count;
	for (const mon of doc.box) if (mon.item) all[mon.item] = (all[mon.item] || 0) + 1;
	return Object.fromEntries(Object.entries(all).filter(([, count]) => count > 0).sort());
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
	// The hash is of the plan taken, every body's item, the bag, the plan record
	// and the scouting count, recorded from the planner at 6d12a46 (before this
	// change) on the same document, trainer and seeds.
	const {out, tally, plan: taken} = plan(wallaceDoc(), 'Champion Wallace', {});
	const view = {party: out.party, items: out.box.map(mon => [mon.id, mon.item || null]), bag: out.bag,
		plans: tally.plans, scouted: tally.scouted};
	assert.equal(taken.items, undefined, 'no item record when the knob is off');
	assert.equal(taken.took, 'Dhelmise > Donphan > Florges > Ampharos > Lopunny > Togekiss');
	assert.equal(crypto.createHash('sha256').update(JSON.stringify(view)).digest('hex'),
		'73a1c100e3af4094cde8b1f66d7b2482ba4215f78ea4b657691ffeedebffa291', JSON.stringify(tally.plans));
});

test('knob on, at Champion Wallace: the planner proposes the Focus Sash lead and takes it by play', () => {
	const doc = wallaceDoc();
	const {out, plan: taken} = plan(doc, 'Champion Wallace', {planItems: true});
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
	const {out, plan: taken} = plan(doc, 'Leader Brawly', {planItems: true});
	assert.ok(Array.isArray(taken.items) && Array.isArray(taken.held), JSON.stringify(taken));
	assert.deepEqual(holdings(out), holdings(doc), 'items conserved');
	assert.deepEqual(megaHolders(out), megaHolders(doc));
	for (const label of taken.held) {
		const [species, item] = label.split('@');
		assert.ok(out.party.some(id => { const mon = run.findMon(out, id); return mon.species === species && mon.item === item; }), label);
	}
});
