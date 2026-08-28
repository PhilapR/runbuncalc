/* eslint-env node, es6 */
'use strict';

/**
 * Gates for the headless battle view (lib/battle-view.js).
 *
 * The bridge exists so decide() can play fights the browser never reaches —
 * everything past Brawly's door. Its whole contract is parity: the text it
 * renders from an engine reply must be the text the panel renders, and it
 * must satisfy the driver's parsers. Both directions are pinned here; the
 * literal strings are copied from src/js/run_panel.js's paintBattle, so a
 * wording change there that forgets the bridge fails HERE, not silently in
 * a battery result.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const bridge = require('../lib/battle-view.js');
const policy = require('../scripts/ui-playthrough.js');
const driver = require('../lib/battle-driver.js');
const battery = require('../scripts/scenario-battery.js');
const run = require('../lib/run.js');

test('the threat sentence matches the panel and feeds the driver parsers', () => {
	const threat = {
		move: 'Mach Punch', max: 47, crit: 69,
		survivesCrit: false, survivesTwoCrits: false,
		race: {turnsToKill: 3, turnsToDie: 1, faster: false, outcome: 'lose'},
		pursuit: {max: 30, kills: true},
	};
	const text = bridge.threatText(threat);
	assert.equal(text,
		'Their hardest hit: Mach Punch 47% — 69% on a crit · a crit KOs you' +
		' · you need 3 turns to KO, they need 1 — YOU LOSE THIS RACE' +
		' · they act first · Pursuit KOs anything that switches out');

	// The drivers parse it back, whole.
	const race = policy.raceOf({threat: text});
	assert.deepEqual(race, {ours: 3, theirs: 1, lost: true, margin: -2});
	assert.match(text, / they act first/);
	assert.match(text, /Pursuit KOs anything that switches out/);
	assert.equal(bridge.riskOf(threat), 'lethal');

	// A winnable spot reads safe, says who acts, and carries no Pursuit line
	// when the catch does not kill.
	const safe = bridge.threatText({
		move: 'Tackle', max: 12, crit: 18,
		survivesCrit: true, survivesTwoCrits: true,
		race: {turnsToKill: 1, turnsToDie: 6, faster: true, outcome: 'win'},
		pursuit: {max: 10, kills: false},
	});
	assert.equal(safe,
		'Their hardest hit: Tackle 12% — 18% on a crit · survives a crit' +
		' · you need 1 turn to KO, they need 6 — you win it');
	assert.equal(policy.raceOf({threat: safe}).margin, 5);
});

test('move text round-trips through scoreMove exactly', () => {
	const entry = {move: 'Bubble Beam',
		damage: {min: 34, max: 41, crit: 61, floorKO: false, guaranteedKO: false}};
	const view = {move: entry.move, ball: null,
		title: bridge.moveTitle(entry),
		damage: bridge.moveDamageText(entry.damage), label: entry.move};
	const scored = policy.scoreMove(view);
	assert.equal(scored.min, 34);
	assert.equal(scored.max, 41);
	assert.equal(scored.damaging, true);
	assert.equal(scored.floorKO, false);

	const killer = bridge.moveDamageText(
		{min: 110, max: 120, floorKO: true, guaranteedKO: true});
	assert.match(killer, /KOs on any roll/);
	assert.ok(policy.scoreMove({move: 'Surf', damage: killer, title: ''}).floorKO);
});

test('a banked deep run plays a whole fight headless, deterministically', () => {
	// The point of the bridge: a real archived run document, a trainer the
	// browser never reached, the real policy — no page anywhere.
	const report = JSON.parse(require('node:fs').readFileSync(
		'ui-playthrough-out/report-flannery-3.json', 'utf8'));
	assert.ok(report.run.position > 77, 'the fixture must live past Brawly');
	const ahead = run.upcoming(report.run, 2);
	const fight = (Array.isArray(ahead) ? ahead : ahead.fights)[0];
	assert.ok(fight, 'the archive run must still have a road');

	const first = battery.playScenario(policy, report.run, fight.trainer, 7);
	assert.ok(['win', 'loss'].includes(first.result),
		'the fight must END, got ' + first.result);
	assert.ok(first.turns > 0);

	const again = battery.playScenario(policy, report.run, fight.trainer, 7);
	assert.deepEqual(again, first, 'same seed, same fight, same tape');

	const other = battery.playScenario(policy, report.run, fight.trainer, 8);
	assert.ok(other.result, 'a different seed still ends');
});

test('the bridge view carries what decide() reads, from a live reply', () => {
	const opened = driver.start(JSON.parse(require('node:fs').readFileSync(
		'ui-playthrough-out/report-flannery-3.json', 'utf8')).run,
	'Pokéfan Miguel', 3);
	const view = bridge.viewOf(Object.assign({}, opened, {phase: 'choose'}));
	assert.match(view.prompt, /^What will /);
	assert.match(view.us, / L\d+/);
	assert.match(view.foe, / L\d+/);
	assert.ok(view.usHp > 0 && view.usHp <= 100);
	assert.ok(view.moves.length, 'the bar has moves');
	assert.ok(view.moves.every(entry => entry.move && typeof entry.damage === 'string'));
	assert.ok(view.switches.every(entry => entry.id && / \d+%$/.test(entry.label)),
		'switch labels end in the health the driver parses');
	assert.match(view.threat, /Their hardest hit: /);
});
