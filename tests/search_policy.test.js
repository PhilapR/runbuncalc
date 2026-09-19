/* eslint-env node, es6 */
'use strict';

/**
 * Gate for the search policy (driver.playSearch): every decision tries
 * each legal action in rollouts on the engine and plays the best mean.
 *
 * Probed 2026-09-19 on the 19 Brawly boxes, 4 seeds each: decide() won 2
 * of 76, search with 4 rollouts an action won 12 of 76 (+11 -1 seed-paired).
 * A full fight costs about a minute, so these gates use one rollout and an
 * early fight.
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const driver = require('../lib/battle-driver.js');
const battery = require('../scripts/scenario-battery.js');

const box = () => battery.loadDocument(path.join(__dirname, '..', 'fixtures', 'banked-runs', 'brkeys3-A-5.run.json'));

test('a searched fight ends, refuses nothing, and is the same fight on the same seed', () => {
	const doc = box();
	const trainer = 'Bug Catcher Lyle';
	const a = driver.playSearch(doc, trainer, 3, {rollouts: 1});
	const b = driver.playSearch(doc, trainer, 3, {rollouts: 1});
	assert.ok(['win', 'loss'].includes(a.result), a.result);
	assert.equal(a.engineRefusals, 0);
	assert.deepEqual([a.result, a.turns, a.deaths], [b.result, b.turns, b.deaths]);
});

test('the battery plays a fight by search when asked, and says so', () => {
	const saved = process.argv;
	process.argv = ['node', 'battery', '--search=1'];
	try {
		const played = battery.playScenario(require('../scripts/ui-playthrough.js'), box(), 'Bug Catcher Lyle', 3);
		assert.equal(played.policy, 'search-1');
		process.argv = ['node', 'battery', '--search=1', '--search-bosses=1'];
		const plain = battery.playScenario(require('../scripts/ui-playthrough.js'), box(), 'Bug Catcher Lyle', 3);
		assert.equal(plain.policy, undefined, 'not a boss: decide() plays it');
	} finally {
		process.argv = saved;
	}
});

test('search finishes a foe at 1 HP with an attack, not a switch or a status move', () => {
	const doc = box();
	const opened = driver.start(doc, 'Leader Brawly', 1);
	const bundle = structuredClone(opened.battle);
	const foe = bundle.state.sides.ai.party.find(mon => mon.id === bundle.state.sides.ai.activeIds[0]);
	foe.hp.current = 1;
	const actions = driver.legalActions(bundle.state);
	assert.ok(actions.some(entry => entry.kind === 'switch'), 'a switch is on offer');
	const chosen = driver.searchChoice(bundle, actions, 1, 2, 0).chosen;
	assert.equal(chosen.kind, 'move', JSON.stringify(chosen));
	const picked = actions.find(entry => entry.kind === 'move' && entry.move === chosen.move);
	assert.ok(picked.damage && picked.damage.max > 0, chosen.move + ' does damage');
});
