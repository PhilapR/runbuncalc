/* eslint-env node, es6 */
'use strict';

/**
 * Gate for headless doubles (driver.playDoubles): 62 fights on the road are
 * double battles, Juan and three of the Elite Four among them, and a run
 * that skips them has not beaten the game.
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

// The joint search is the default for a double (a-double-is-searched-jointly)
// and costs about 20 seconds a fight: this file plays dozens, and the suite is
// the dev loop. The cheap hand is pinned here, and the one test that checks
// the default asks for it by name.
process.argv.push('--doubles-search=0');

const driver = require('../lib/battle-driver.js');
const planner = require('../lib/planner');
const run = require('../lib/run');
const battery = require('../scripts/scenario-battery.js');

const doc = () => battery.loadDocument(path.join(__dirname, '..', 'fixtures', 'banked-runs', 'sv-14.run.json'));
const DOUBLES = ['Pokéfan Isabel & Kaleb', 'Black Belt Rhett & Marcos', 'Twins Amy And Liv'];

test('a double battle is fought two against two, every active acting', () => {
	const box = doc();
	const fight = planner.getFight(DOUBLES[0], box.profileId);
	const state = planner.buildFightState({trainer: fight.trainer, profileId: box.profileId,
		playerParty: run.partySpecs(box, {atOrder: fight.order}), doubles: true}).state;
	assert.equal(state.mode, 'Doubles');
	assert.equal(state.sides.player.activeIds.length, 2);
	assert.equal(state.sides.ai.activeIds.length, 2);
	let actions = 0;
	let turns = 0;
	for (const trainer of DOUBLES) {
		for (let seed = 1; seed <= 3; seed++) {
			const played = driver.playDoubles(box, trainer, seed);
			assert.ok(['win', 'loss'].includes(played.result), trainer + ' #' + seed + ' ended ' + played.result);
			assert.equal(played.engineRefusals, 0, trainer + ' #' + seed + ': ' +
				played.events.filter(event => event.engineRefusal).map(event => event.text).join(' | '));
			actions += played.actions;
			turns += played.turns;
		}
	}
	assert.ok(actions / turns > 3, 'four actives act each turn, less those that fell: ' + (actions / turns).toFixed(2));
});

test('a double is the same fight on the same seed, and a single is refused', () => {
	const box = doc();
	const a = driver.playDoubles(box, DOUBLES[2], 7);
	const b = driver.playDoubles(box, DOUBLES[2], 7);
	assert.deepEqual([a.result, a.turns, a.deaths, a.actions], [b.result, b.turns, b.deaths, b.actions]);
	assert.throws(() => driver.playDoubles(box, 'Leader Wattson', 1), /is a single battle/);
});

test('a double\'s tape says whose move and whose faint each line was', () => {
	// The text is species names only, so a reader guessed the side from the
	// six — which a mirror cannot survive (Urshifu on both sides at Sidney).
	const box = doc();
	const played = driver.playDoubles(box, DOUBLES[2], 7);
	const ours = new Set(box.party.map(id => box.box.find(mon => mon.id === id).species));
	const lines = played.events.filter(event => / used |fainted!/.test(event.text || ''));
	assert.ok(lines.length > 4);
	for (const event of lines) assert.ok(event.side === 'ours' || event.side === 'theirs', event.text);
	const mine = lines.filter(event => event.side === 'ours' && / used /.test(event.text));
	assert.ok(mine.length > 0 && mine.every(event => ours.has(event.text.split(' used ')[0].replace(/-Mega.*$/, ''))),
		'our lines are our six');
	assert.ok(lines.some(event => event.side === 'theirs' && / used /.test(event.text)));
});

test('the battery plays a double through the two-slot loop and says which policy fought', () => {
	// The default searches our two actives jointly: the measured hand (67 real
	// run states x 6 seeds, net +37, p < 0.0001), which the battery has to
	// actually pass to the driver — playDoubles took no options at all, so
	// every arm before this ran on the engine's own hand.
	const box = doc();
	const argv = process.argv;
	process.argv = argv.filter(arg => arg !== '--doubles-search=0');
	let played;
	try {
		played = battery.playScenario(require('../scripts/ui-playthrough.js'), box, DOUBLES[0], 3);
	} finally {
		process.argv = argv;
	}
	assert.equal(played.policy, 'joint-4');
	assert.deepEqual([played.result, played.turns], (() => {
		const direct = driver.playDoubles(box, DOUBLES[0], 3, {search: 4, joint: true});
		return [direct.result, direct.turns];
	})());
});

test('the doubles that were refused are played through', () => {
	// Each once produced a refusal: a spread move whose foe fell, a status
	// move whose targets an effect filtered out, a Dancer ally copying a
	// dance, White Herb restoring an ally, and an Encore that landed before
	// the encored Pokemon acted.
	const cases = [
		['sv-14', 'Old Couple John And Jay', 1], ['sv-14', 'Hiker Eric & Autumn', 1],
		['sv-14', 'Young Couple Dez And Luke', 2], ['sv-14', 'Camper Flint & Edwardo', 1],
		['sv-14', 'Lass Andrea & Connie', 2], ['sv-14', 'Twins Miu And Yuki', 1],
		['acc-11', 'Magma Grunt Mt Chimney #2 & Grunt One', 1],
	];
	for (const entry of cases) {
		const box = battery.loadDocument(path.join(__dirname, '..', 'fixtures', 'banked-runs', entry[0] + '.run.json'));
		const played = driver.playDoubles(box, entry[1], entry[2]);
		assert.equal(played.engineRefusals, 0, entry.join(' ') + ': ' + played.events.filter(event => event.engineRefusal)
			.map(event => event.text + ' ' + JSON.stringify(event.action)).join(' | '));
	}
});

test('a move locked out before it acts: Encore substitutes, Taunt makes a status move fail', () => {
	const box = doc();
	const fight = planner.getFight(DOUBLES[0], box.profileId);
	const state = planner.buildFightState({trainer: fight.trainer, profileId: box.profileId,
		playerParty: run.partySpecs(box, {atOrder: fight.order}), doubles: true}).state;
	const actor = state.sides.player.party[0];
	const moves = actor.moves.map(move => move.name);
	const action = {kind: 'move', actorId: actor.id, moveName: moves[0], targetIds: [state.sides.ai.activeIds[0]]};
	const events = [];
	const encored = structuredClone(state);
	encored.sides.player.party[0].volatile = {encore: {moveName: moves[1], turns: 3}};
	assert.equal(driver.lockedOut(encored, action, events).moveName, moves[1], 'the encored move is used instead');
	const disabled = structuredClone(state);
	disabled.sides.player.party[0].volatile = {disable: {moveName: moves[0], turns: 3}};
	assert.equal(driver.lockedOut(disabled, action, events), null, 'a disabled move fails');
	assert.match(events[events.length - 1].text, /can't use/);
	assert.equal(driver.lockedOut(state, action, events), action, 'nothing locked, nothing changed');
});

test('a double is taped action by action, and the optional hands play it through', () => {
	const box = doc();
	const played = driver.playDoubles(box, DOUBLES[2], 2);
	const used = played.events.filter(event => / used /.test(event.text));
	assert.ok(used.length >= played.actions, 'every applied action is on the tape');
	assert.ok(used.every(event => typeof event.turn === 'number'));
	const greedy = driver.playDoubles(box, DOUBLES[2], 2, {ourPolicy: 'greedy'});
	assert.ok(['win', 'loss'].includes(greedy.result));
	const searched = driver.playDoubles(box, DOUBLES[0], 1, {search: 1});
	assert.ok(['win', 'loss'].includes(searched.result));
	assert.equal(searched.engineRefusals, 0);
});

test('a double battle is ranked by the grid, and the battery can re-pick for one', () => {
	// The ranker adjudicated its top sixes with singles rollouts, which
	// refuse a double: ranking one threw, the battery crashed on a double
	// scenario, and the headless run fell back to a level sort unannounced.
	const box = doc();
	const ranked = run.rankParties(box, DOUBLES[0]);
	assert.ok(ranked.parties.length > 0);
	assert.ok(ranked.parties.every(party => !party.adjudication), 'no singles adjudication of a double');
	const prepared = battery.prepareDocument(box, DOUBLES[0], require('../scripts/ui-playthrough.js'));
	assert.ok(prepared.doc.party.length >= 2, 'the battery re-picks a six for a double');
});

test('a move for the ally alone, whose ally fell earlier in the turn, is used and fails', () => {
	// Surf took Sawk, then Poliwrath's queued Coaching had no ally to coach:
	// the engine refused it, the one refusal family left in sweep 10.
	const box = battery.loadDocument(path.join(__dirname, '..', 'fixtures', 'banked-runs', 'br-21.run.json'));
	const played = driver.playDoubles(box, 'Cool Trainer Jennifer & Callie', 1);
	assert.equal(played.engineRefusals, 0, played.events.filter(event => event.engineRefusal)
		.map(event => event.text).join(' | '));
	assert.ok(played.events.some(event => event.turn === 6 && /^Poliwrath used Coaching/.test(event.text)));
});

test('the refusals the doubles audit found are played through', () => {
	// Every double against every fourth banked box (2,480 fights, 2026-09-19):
	// 19 raised a refusal. Life Dew whose ally fell and Encore's Synthesis had
	// no aim at the user itself; a body Whirlwind dragged out, or Emergency
	// Exit took, still used the move it had queued.
	const cases = [
		{file: 'br-9.run.json', trainer: 'Twins Amy And Liv', move: 'Life Dew'},
		{file: 'br-14.run.json', trainer: 'Old Couple John And Jay', move: 'Synthesis'},
		{file: 'choice-roxanne-max.run.json', trainer: 'Psychic Blake & Samantha', move: 'Trick Room'},
		{file: 'brheal1-B-2.run.json', trainer: 'Cool Trainer Julie & Dianne', move: 'Leech Life'},
	];
	for (const entry of cases) {
		const box = battery.loadDocument(path.join(__dirname, '..', 'fixtures', 'banked-runs', entry.file));
		const played = driver.playDoubles(box, entry.trainer, 1);
		assert.equal(played.engineRefusals, 0, entry.trainer + ' (' + entry.move + '): ' + played.events
			.filter(event => event.engineRefusal).map(event => event.text).join(' | '));
	}
});

test('a stall on infinite fuel ends once moves spend PP', () => {
	// Moody Smeargle's Protect, Substitute and Dark Void held Seadra and
	// Lumineon for 300 turns at Young Couple Dez And Luke: legal in this fork
	// (Moody still raises evasion), and over once the PP runs out.
	const box = battery.loadDocument(path.join(__dirname, '..', 'fixtures', 'banked-runs', 'rank5-A-1.run.json'));
	try {
		driver.setPPModel(true);
		const played = driver.playDoubles(box, 'Young Couple Dez And Luke', 1);
		assert.ok(['win', 'loss'].includes(played.result), 'ended ' + played.result + ' at turn ' + played.turns);
	} finally {
		driver.setPPModel(false);
	}
});

test('a joint search values the two actives as one choice, behind a switch', () => {
	// searchDoubles scores each active alone while its partner plays the
	// engine's hand, so no PAIR of moves is ever valued (Fake Out into a
	// set-up, Wide Guard over a spread). Trainer Rival Bridge — a double, six
	// at Level 65-66 led by a Speed Boost Mega Blaziken — was 0 of 120
	// attempts in a full run.
	const box = doc();
	const jointly = driver.playDoubles(box, DOUBLES[1], 1, {search: 2, joint: true});
	assert.ok(['win', 'loss'].includes(jointly.result));
	assert.equal(jointly.engineRefusals, 0, jointly.events.filter(event => event.engineRefusal)
		.map(event => event.text).join(' | '));
	// joint: false explicitly — the driver's default is the joint search now.
	const apart = driver.playDoubles(box, DOUBLES[1], 1, {search: 2, joint: false});
	const tape = played => played.events.filter(event => / used /.test(event.text)).map(event => event.text).join('|');
	assert.notEqual(tape(jointly), tape(apart), 'the two searches play the fight differently');
	// The switch, not only the option: the joint search is the default since
	// the doubles arms were measured (a-double-is-searched-jointly).
	assert.equal(driver.doublesJoint(), true);
	assert.equal(tape(driver.playDoubles(box, DOUBLES[1], 1, {search: 2})), tape(jointly), 'the default is the joint search');
	try {
		driver.setDoublesJoint(false);
		assert.equal(tape(driver.playDoubles(box, DOUBLES[1], 1, {search: 2})), tape(apart), 'switched off, the per-actor search');
	} finally {
		driver.setDoublesJoint(true);
	}
});

test('a double is prepared with the tools a double is fought with', () => {
	// Trainer Rival Bridge (a double) took 120 attempts and no wins in sweep
	// 13's deepest run, with a party that had no Fake Out, Wide Guard, Icy
	// Wind or Tailwind — all of which its own box could learn.
	const headless = require('../scripts/headless-run.js');
	// Wide Guard and friends are egg or previous-learnset moves for some
	// bodies, and the nurse charges a Heart Scale to remember one.
	let before = doc();
	for (let n = 0; n < 4; n++) before = require('../lib/run.js').apply(before,
		{kind: 'acquire', item: 'Heart Scale', where: 'granted for the gate'});
	const tally = {};
	const after = headless.doublesPrep(before, tally);
	assert.equal(tally.doublesTaught, 2, 'at most two bodies change, and here both could');
	const TOOLS = ['Fake Out', 'Wide Guard', 'Icy Wind', 'Protect', 'Helping Hand', 'Tailwind'];
	const toolsOf = document => document.party.map(id => (document.box.find(mon => mon.id === id) || {}).moves || [])
		.flat().filter(move => TOOLS.includes(move));
	assert.equal(toolsOf(before).length, 0, 'the banked six carries none');
	const taught = toolsOf(after);
	assert.equal(taught.length, 2);
	assert.equal(new Set(taught).size, 2, 'one of each: two Tailwinds are one Tailwind and a lost attack');
	// A priority move is never the one given up.
	for (const id of after.party) {
		const was = before.box.find(mon => mon.id === id);
		const now = after.box.find(mon => mon.id === id);
		const lost = (was.moves || []).filter(move => !(now.moves || []).includes(move));
		assert.deepEqual(lost.filter(move => move === 'Quick Attack' || move === 'Aqua Jet'), [],
			now.species + ' gave up priority: ' + lost.join(','));
	}
});
