/* eslint-env node, es6 */
'use strict';

/**
 * The battle driver's gate: the run played turn by turn, without the game.
 *
 * `run.test.js` covers the document and `planner.test.js` the predictions;
 * what only this layer can promise is the LOOP — a player decision in, a
 * resolved turn out, the same fight every time under the same seed, the
 * replacement pause where the game pauses, and epitaphs that survive the
 * stateless round-trips so a loss can be written into the run truthfully.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const run = require('../lib/run');
const driver = require('../lib/battle-driver');

const TEST_IVS = {hp: 17, atk: 18, def: 19, spa: 20, spd: 21, spe: 22};

function docWith(party) {
	let doc = run.createRun({name: 'Recreation', now: 't0', permadeath: true});
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

/** Play a whole fight on one policy: always the first offered action. */
function playOut(doc, seed, trainer) {
	let opened = driver.start(doc, trainer, seed);
	let battle = opened.battle;
	let actions = opened.actions;
	const phases = [];
	let guard = 0;
	while (guard++ < 80) {
		const pick = actions[0];
		assert.ok(pick, 'the driver must always offer a legal action while the fight runs');
		const reply = driver.act(battle, pick.kind === 'move' ?
			{kind: 'move', move: pick.move} :
			{kind: 'switch', replacementId: pick.action.replacementId});
		phases.push(reply.phase);
		battle = reply.battle;
		actions = reply.actions;
		if (reply.result) return {reply, phases, battle};
	}
	assert.fail('the fight must end inside the guard');
	return null;
}

test('a fight opens at the cap, offers priced moves, and the same seed replays the same fight', () => {
	const doc = docWith([
		{species: 'Poochyena', map: 'Route101', level: 3},
		{species: 'Pidgey', map: 'Route102', level: 5},
	]);
	const opened = driver.start(doc, undefined, 42);
	// The next unbeaten fight, unasked: the recreation's "next" is the run's.
	assert.equal(opened.battle.trainer, 'Youngster Calvin');
	// The party enters at the projected cap — the infinite candy IS the XP
	// system, so a level 3 catch fights at what it will be leveled to.
	assert.equal(opened.viewState.player.active.level, 12);
	assert.ok(opened.viewState.player.active.types.length > 0,
		'the battle surface needs the active Pokemon typing');
	assert.equal(typeof opened.viewState.player.active.ability, 'string');
	// Moves come priced: the button can say what the calculator knows.
	const move = opened.actions.find(action => action.kind === 'move');
	assert.ok(move && move.damage && move.damage.max > 0,
		'a damaging move must carry its forecast');
	// The battle id ↔ box id map is what lets a faint in here be written out
	// there. Slot order is party order.
	assert.deepEqual(opened.battle.party.map(row => row.monId), ['mon-1', 'mon-2']);

	const first = playOut(doc, 42);
	const second = playOut(doc, 42);
	assert.equal(first.reply.result, second.reply.result);
	assert.equal(first.battle.step, second.battle.step,
		'the same seed must replay the same fight to the turn');
	// And this seed is a recorded win: a capped Poochyena runs over the
	// route-one birds. If the fixture drifts, the assertion below names it.
	assert.equal(first.reply.result, 'win');
	assert.deepEqual(first.reply.deaths, []);
});

test('move forecasts stay on max HP and a miss says that it missed', () => {
	const doc = docWith([{species: 'Mudkip', map: undefined, level: 5}]);
	// Seed 1 scripts hit-then-miss now; seed 0 did before the engine started
	// sampling critical hits (constants audit D1) and reshaped every stream.
	const opened = driver.start(doc, 'Youngster Calvin', 1);
	const firstWaterGun = opened.actions.find(action => action.move === 'Water Gun');
	assert.ok(firstWaterGun && firstWaterGun.damage,
		'Water Gun should carry a damage forecast');

	const first = driver.act(opened.battle, {kind: 'move', move: 'Water Gun'});
	const secondWaterGun = first.actions.find(action => action.move === 'Water Gun');
	assert.deepEqual(
		{min: secondWaterGun.damage.min, max: secondWaterGun.damage.max},
		{min: firstWaterGun.damage.min, max: firstWaterGun.damage.max},
		'the forecast is a share of max HP, not a growing share of what remains');
	assert.equal(secondWaterGun.damage.guaranteedKO, true,
		'the separate KO reading should still reflect the HP remaining');

	const second = driver.act(first.battle, {kind: 'move', move: 'Water Gun'});
	assert.ok(second.events.some(event => /Mudkip's Water Gun missed!/.test(event.text)),
		'a failed accuracy roll must not be narrated as an unexplained move use');
});

test('a mid-turn faint pauses for the replacement, and the epitaph survives to the end', () => {
	// One hopeless lead, one bystander: the lead falls, the driver must pause
	// on phase "replace" (never auto-picking the player's next), and when the
	// fight is lost both deaths carry who did it and with what.
	const doc = docWith([
		{species: 'Skitty', map: 'Route101', level: 2},
		{species: 'Starly', map: 'Route102', level: 5},
	]);
	// Two frail mons into Leader Brawly: at cap 21 this is a certain wipe,
	// which is exactly what the test needs — a mid-fight faint and a loss.
	const played = playOut(doc, 7, 'Leader Brawly');
	assert.ok(played.phases.includes('replace'),
		'losing a mon mid-fight must pause for the player to choose the next');
	assert.equal(played.reply.result, 'loss');
	assert.equal(played.reply.deaths.length, 2, 'a wipe reports every death');
	for (const death of played.reply.deaths) {
		assert.ok(death.monId, 'every death maps back to a box id');
		assert.ok(death.by, `${death.species} died to a named move, got ${death.by}`);
		assert.ok(death.of, `${death.species} died to a named killer, got ${death.of}`);
	}
});

test('the driver refuses what the fight cannot do, by name', () => {
	const doc = docWith([{species: 'Poochyena', map: 'Route101', level: 3}]);
	const opened = driver.start(doc, undefined, 1);
	// A move it does not know right now.
	assert.throws(() => driver.act(opened.battle, {kind: 'move', move: 'Earthquake'}),
		/battle: "Earthquake" is not usable right now/);
	// A switch to nobody.
	assert.throws(() => driver.act(opened.battle, {kind: 'switch', replacementId: 'player-9'}),
		/battle: "player-9" is not a legal switch/);
	// No action at all.
	assert.throws(() => driver.act(opened.battle, null), /battle: an action is required/);
	// And an empty party cannot open a fight.
	assert.throws(() => driver.start(run.createRun({name: 'x', now: 't0'})),
		/battle: the party is empty/);
});

test('a finished fight is over: acting on it is refused, not resolved', () => {
	const doc = docWith([
		{species: 'Poochyena', map: 'Route101', level: 3},
		{species: 'Pidgey', map: 'Route102', level: 5},
	]);
	const played = playOut(doc, 42);
	assert.throws(() => driver.act(played.battle, {kind: 'move', move: 'Tackle'}),
		/battle: this fight is over/);
});

test('a wild fight: the ball is priced, the throw is seeded, the ending settles the roll', () => {
	const doc = docWith([{species: 'Starly', map: 'Route102', level: 5}]);
	const rolled = run.rollEncounter(doc, {map: 'Route101', random: () => 0.01});

	const opened = driver.startWild(doc, rolled, 7);
	assert.equal(opened.battle.trainer, `Wild ${rolled.species}`);
	assert.equal(opened.viewState.foe.active.level, rolled.level,
		'the wild mon fights at its rolled level, uncapped');
	assert.deepEqual(opened.battle.wild.ivs, rolled.ivs,
		'the player IV roll waits in the bundle for a successful capture');
	assert.deepEqual(opened.battle.state.sides.ai.party[0].ivs, rolled.ivs,
		'the wild opponent fights with the same random IVs the player may catch');
	// The server's die authors the whole identity, and that identity is what
	// fights the battle AND waits in the bundle for a successful capture.
	assert.ok(rolled.nature, 'the roll authors a nature');
	assert.ok(rolled.ability, 'the roll authors an ability');
	assert.equal(opened.battle.wild.nature, rolled.nature,
		'the rolled nature waits in the bundle for a successful capture');
	assert.equal(opened.battle.wild.ability, rolled.ability,
		'the rolled ability waits in the bundle for a successful capture');
	assert.equal(opened.battle.state.sides.ai.party[0].ability, rolled.ability,
		'the wild opponent fights with the ability the player would catch');
	assert.equal(opened.battle.state.sides.ai.party[0].nature, rolled.nature,
		'the wild opponent fights with the nature the player would catch');
	const ball = opened.actions.find(action => action.kind === 'ball');
	assert.ok(ball, 'a wild fight offers the ball');
	assert.ok(ball.chance > 0 && ball.chance <= 100, 'the throw wears its odds');

	// Throw until it ends: same seed, same fight, to the shake.
	const playBalls = () => {
		let battle = opened.battle;
		let reply = null;
		for (let guard = 0; guard < 30; guard++) {
			reply = driver.act(battle, {kind: 'ball'});
			battle = reply.battle;
			if (reply.result) return reply;
		}
		return reply;
	};
	const first = playBalls();
	const second = playBalls();
	assert.equal(first.result, second.result);
	assert.equal(first.battle.step, second.battle.step,
		'the same seed shakes the same shakes');
	assert.ok(['catch', 'win', 'loss'].includes(first.result));
	if (first.result === 'catch') {
		assert.match(first.events.map(event => event.text).join(' '), /Gotcha/);
	}
	// A finished wild fight is over even though nobody fainted.
	assert.throws(() => driver.act(first.battle, {kind: 'ball'}),
		/battle: this fight is over/);

	// The ball is the wild fight's action alone, and the roll must be real.
	const trainerFight = driver.start(doc, undefined, 1);
	assert.throws(() => driver.act(trainerFight.battle, {kind: 'ball'}),
		/battle: only a wild encounter takes a ball/);
	assert.throws(() => driver.startWild(doc, {map: 'Route101', species: 'Rayquaza', level: 5}, 1),
		/is not on Route101's table/);

	// The math itself, at the two ends the formula promises: a full-HP catch
	// rate 255 species is a fair throw, and status closes the gap.
	const full = driver.catchMath({hp: {current: 30, max: 30}, status: ''}, 255);
	assert.ok(Math.abs(full.chance - Math.pow(49931 / 65536, 4)) < 1e-9,
		'full HP at rate 255 rolls the book number');
	const asleep = driver.catchMath({hp: {current: 1, max: 30}, status: 'slp'}, 255);
	assert.equal(asleep.chance, 1, 'a sleeping mon at 1 HP is a guaranteed catch');
});

test('ball tiers are bag-backed: better odds, counted throws, refusals when out', () => {
	// Two Great Balls in the bag; the Ultra Ball shelf is empty.
	let doc = docWith([{species: 'Starly', map: 'Route102', level: 5}]);
	doc = run.apply(doc, {kind: 'acquire', item: 'Great Ball', count: 2});
	const rolled = run.rollEncounter(doc, {map: 'Route101', random: () => 0.01});
	const opened = driver.startWild(doc, rolled, 7);

	// Offered: the free Poke Ball plus the two Great Balls, nothing more —
	// and the tier really pays (Emerald's 1.5x on the a-value).
	const balls = opened.actions.filter(action => action.kind === 'ball');
	assert.deepEqual(balls.map(action => action.ball), ['Poke Ball', 'Great Ball']);
	assert.equal(balls[1].left, 2);
	assert.equal(balls[0].left, undefined, 'the free baseline is not counted');
	assert.ok(balls[1].chance > balls[0].chance, 'a Great Ball beats a plain one');

	// Throw both Great Balls (on this seed neither connects); the third is
	// refused with the count, and the button is off the list.
	let battle = opened.battle;
	let reply = null;
	for (let thrown = 0; thrown < 2; thrown++) {
		reply = driver.act(battle, {kind: 'ball', ball: 'Great Ball'});
		battle = reply.battle;
		assert.ok(!reply.result, 'this seed does not connect in two Great throws');
	}
	assert.equal(battle.wild.thrown['Great Ball'], 2, 'the bundle counts the throws');
	assert.ok(!reply.actions.some(action => action.ball === 'Great Ball'),
		'an empty shelf offers no button');
	assert.throws(() => driver.act(battle, {kind: 'ball', ball: 'Great Ball'}),
		/no Great Ball left — this fight has thrown 2 and the bag held 2/);
	assert.throws(() => driver.act(battle, {kind: 'ball', ball: 'Master Ball'}),
		/not a ball this recreation throws/);
	// The free baseline still throws.
	const plain = driver.act(battle, {kind: 'ball'});
	assert.match(plain.events[0].text, /You threw a Poke Ball!/);

	// And the document's half: `use` spends what the fight threw, refusing
	// honestly when the bag cannot cover the claim.
	let settled = run.apply(doc, {kind: 'use', item: 'Great Ball', count: 2});
	assert.equal(settled.bag['Great Ball'], undefined, 'an emptied slot leaves the bag');
	assert.throws(() => run.apply(settled, {kind: 'use', item: 'Great Ball'}),
		/use: need 1 Great Ball, the bag has 0/);
});

test('adjudication reports what happened, deterministically, and calibrates the ranker', () => {
	const doc = docWith([
		{species: 'Poochyena', map: 'Route101', level: 3},
		{species: 'Pidgey', map: 'Route102', level: 5},
	]);
	// Same seeds, same answer: an adjudication is a measurement, not a mood.
	const first = driver.adjudicate(doc, 'Youngster Calvin', {rollouts: 6});
	const second = driver.adjudicate(doc, 'Youngster Calvin', {rollouts: 6});
	assert.deepEqual(first, second);
	assert.equal(first.rollouts, 6);
	assert.ok(first.pWin > 0.5, 'capped mons run over the first Youngster');

	// Two frail mons into Brawly: the floor policy reports the wipe honestly.
	const doomed = docWith([
		{species: 'Skitty', map: 'Route101', level: 2},
		{species: 'Starly', map: 'Route102', level: 5},
	]);
	const wiped = driver.adjudicate(doomed, 'Leader Brawly', {rollouts: 4});
	assert.equal(wiped.pWin, 0);
	assert.equal(wiped.eDeaths, 2);

	// And the ranker carries the measurement: adjudicated parties come back
	// with the played numbers attached and sorted ahead by them.
	const ranked = run.rankParties(doc, 'Youngster Calvin', {rollouts: 4, adjudicate: 2});
	assert.ok(ranked.parties[0].adjudication, 'the top candidates are played');
	assert.equal(ranked.parties[0].adjudication.rollouts, 4);
	assert.match(ranked.adjudication.policy, /lower bound/);
	const played = ranked.parties.filter(party => party.adjudication);
	for (let i = 1; i < played.length; i++) {
		const above = played[i - 1].adjudication;
		const below = played[i].adjudication;
		assert.ok(above.pWin > below.pWin ||
			(above.pWin === below.pWin && above.eDeaths <= below.eDeaths),
		'played results outrank the grid, wins first, then deaths');
	}
	// rollouts: 0 is the off switch — the old grid-only answer, unchanged.
	const gridOnly = run.rankParties(doc, 'Youngster Calvin', {rollouts: 0});
	assert.equal(gridOnly.adjudication, null);
	assert.ok(gridOnly.parties.every(party => !party.adjudication));
});

test('the playbook: same seeds same tape, honest spread, a line that replays the majority', () => {
	const doc = docWith([
		{species: 'Poochyena', map: 'Route101', level: 3},
		{species: 'Pidgey', map: 'Route102', level: 5},
	]);
	const first = driver.playbook(doc, 'Youngster Calvin', {rollouts: 6});
	const second = driver.playbook(doc, 'Youngster Calvin', {rollouts: 6});
	assert.deepEqual(first, second, 'a playbook is a measurement, not a mood');
	assert.equal(first.odds.rollouts, 6);
	assert.equal(first.outcomes.reduce((sum, outcome) => sum + outcome.count, 0), 6,
		'every rollout lands in exactly one outcome bucket');
	assert.ok(first.line, 'the expected line exists');
	assert.ok(first.line.events.length > 2, 'the line narrates the fight');
	assert.match(first.line.events[0], /wants to battle!/);
	// The line replays the MAJORITY result at its most common death count.
	const majority = first.odds.pWin >= 0.5 ? 'win' : 'loss';
	assert.equal(first.line.result, majority);
	// Odds must agree with adjudicate — one tape deck, two readouts.
	const adjudicated = driver.adjudicate(doc, 'Youngster Calvin', {rollouts: 6});
	assert.deepEqual(first.odds, adjudicated);
});

test('pre-fight catch odds quote the free ball always and tiered balls only when held', () => {
	const driver = require('../lib/battle-driver');
	const bare = driver.catchOddsAtFullHp({profileId: 'run-and-bun'}, 'Poochyena');
	assert.deepEqual(bare.map(entry => entry.ball), ['Poke Ball'],
		'an empty bag still quotes the free baseline');
	assert.equal(bare[0].held, null, 'the free ball is uncounted');
	const stocked = driver.catchOddsAtFullHp(
		{profileId: 'run-and-bun', bag: {'Great Ball': 2, 'Ultra Ball': 1}}, 'Poochyena');
	assert.deepEqual(stocked.map(entry => [entry.ball, entry.held]),
		[['Poke Ball', null], ['Great Ball', 2], ['Ultra Ball', 1]]);
	// The quote must be the same number the fight's ball buttons compute at
	// full HP — one formula, two surfaces.
	//
	// This read `assert.equal(entry.chance, recomputed && entry.chance)`, and
	// `X && entry.chance` IS entry.chance whenever X is non-zero — so it
	// compared a value to itself and threw the recomputed number away. Shifting
	// the real quote by -5% left it green.
	//
	// It also hardcoded 255, which is Poochyena's own rate, so it could not
	// tell "reads the species rate" from "hardcodes 255". The rate now comes
	// from the oracle, and a SECOND species with a different rate proves the
	// formula actually varies with it.
	const oracle = require('../profiles').getProfile('run-and-bun').oracle;
	const fullHp = {hp: {max: 3, current: 3}, status: ''};
	const poochyenaRate = oracle.catchRateOf('Poochyena');
	for (const entry of stocked) {
		assert.equal(entry.chance,
			Math.round(driver.catchMath(fullHp, poochyenaRate, driver.BALLS[entry.ball]).chance * 100),
			entry.ball + ' must quote exactly what the fight computes');
	}

	// A harder species must quote strictly worse odds with the same ball.
	// Abra at 200 against Poochyena's 255, NOT Ralts at 235: the quote rounds
	// to a whole percent, and 235 and 255 both land on 34%, so Ralts would
	// have proved nothing. A discriminator has to survive the rounding.
	const harder = driver.catchOddsAtFullHp({profileId: 'run-and-bun'}, 'Abra');
	assert.ok(oracle.catchRateOf('Abra') < poochyenaRate,
		'the fixture only means something if Abra is genuinely harder');
	assert.ok(harder[0].chance < stocked[0].chance,
		`a lower catch rate must quote lower odds — saw ${harder[0].chance}% for Abra ` +
		`against ${stocked[0].chance}% for Poochyena, so the rate is being read`);
	assert.ok(stocked[1].chance > stocked[0].chance,
		'a better ball must quote better odds');
	assert.throws(() => driver.catchOddsAtFullHp({profileId: 'run-and-bun'}, 'Mewthree'),
		/no catch rate/, 'an unknown species is refused, not quoted at 0');
});

test('a seeded fight never touches Math.random, even through random end-turn effects', () => {
	// Starf Berry under 25% HP is the deterministic trigger: the end-turn
	// resolver samples a random stat to boost. Before the fix the driver's
	// three advanceTurn calls passed no rng, so this fell through to
	// Math.random — invisible to every fixture fight that never reached a
	// random branch (the exact green-on-broken shape AGENTS rule 5 names).
	// A L20 holder that knows only Growl: it can never KO the wild (a
	// finished fight skips end-of-turn), and the L3 wild cannot KO it.
	let doc = run.createRun({name: 'Recreation', now: 't0', permadeath: true});
	doc = run.apply(doc, {kind: 'catch', species: 'Starly', level: 20,
		moves: ['Growl'], ivs: Object.assign({}, TEST_IVS)});
	doc = run.apply(doc, {kind: 'party', ids: ['mon-1']});
	doc = run.apply(doc, {kind: 'acquire', item: 'Starf Berry'});
	doc = run.apply(doc, {kind: 'give', id: 'mon-1', item: 'Starf Berry'});
	const rolled = run.rollEncounter(doc, {map: 'Route101', random: () => 0.01});
	function lowHpBundle() {
		const opened = driver.startWild(doc, rolled, 7);
		// Test-only surgery: the driver has no command that starts a fight
		// wounded, and the berry only wakes at a quarter health.
		const holder = opened.battle.state.sides.player.party[0];
		holder.hp.current = Math.floor(holder.hp.max / 4);
		return opened.battle;
	}
	const realRandom = Math.random;
	Math.random = () => { throw new Error('Math.random leaked into a seeded battle'); };
	try {
		const first = driver.act(lowHpBundle(), {kind: 'move', move: 'Growl'});
		const second = driver.act(lowHpBundle(), {kind: 'move', move: 'Growl'});
		assert.deepEqual(first.viewState, second.viewState,
			'the same seed and step must resolve the random berry identically');
		const boosts = first.battle.state.sides.player.party[0].boosts || {};
		assert.ok(Object.values(boosts).some(value => value >= 2),
			'the Starf Berry must actually have fired for this test to mean anything');

		// The ordinary-move path is only ONE of the driver's three advanceTurn
		// calls. The fix repaired all three; removing the rng from either of
		// the other two left this green, so each is now driven under the same
		// poisoned Math.random.
		//
		// The ball throw closes its own turn on a break-out.
		const thrown = driver.act(lowHpBundle(), {kind: 'ball', ball: 'Poke Ball'});
		assert.ok(thrown.battle, 'a ball throw resolves without reaching Math.random');
		const thrownAgain = driver.act(lowHpBundle(), {kind: 'ball', ball: 'Poke Ball'});
		assert.deepEqual(thrown.viewState, thrownAgain.viewState,
			'and the same seed throws the same ball twice');
	} finally {
		Math.random = realRandom;
	}
});

test('a forced replacement closes its turn without reaching Math.random', () => {
	// The third advanceTurn site: when the player's active falls mid-turn the
	// end-of-turn is HELD until a replacement is chosen, then runs. Removing
	// the rng from that call left the seeded-fight test above green, because
	// nothing there ever fainted.
	let doc = run.createRun({name: 'Replace', now: 't0', permadeath: true});
	// Two party members, the lead paper-thin so it falls on the first hit.
	doc = run.apply(doc, {kind: 'catch', species: 'Starly', level: 5,
		moves: ['Growl'], ivs: Object.assign({}, TEST_IVS)});
	doc = run.apply(doc, {kind: 'catch', species: 'Lillipup', level: 20,
		moves: ['Tackle'], ivs: Object.assign({}, TEST_IVS)});
	doc = run.apply(doc, {kind: 'party', ids: ['mon-1', 'mon-2']});
	// The REPLACEMENT carries the berry. Without it the held end-of-turn has
	// nothing random to resolve, so removing the rng from that call changes
	// nothing and the gate cannot see it — which is exactly what happened on
	// the first attempt at this test.
	doc = run.apply(doc, {kind: 'acquire', item: 'Starf Berry'});
	doc = run.apply(doc, {kind: 'give', id: 'mon-2', item: 'Starf Berry'});
	const rolled = run.rollEncounter(doc, {map: 'Route101', random: () => 0.01});
	const opened = driver.startWild(doc, rolled, 11);
	// Test-only surgery, the same shape the berry fixture uses: the driver has
	// no command that starts a fight one hit from a faint, nor one that starts
	// the bench wounded.
	opened.battle.state.sides.player.party[0].hp.current = 1;
	const bench = opened.battle.state.sides.player.party[1];
	bench.hp.current = Math.floor(bench.hp.max / 4);

	const realRandom = Math.random;
	Math.random = () => { throw new Error('Math.random leaked into a seeded battle'); };
	try {
		let bundle = opened.battle;
		let reply = driver.act(bundle, {kind: 'move', move: 'Growl'});
		// If the lead fell, the fight is waiting on a replacement — take it,
		// which is the path that runs the held end-of-turn.
		const replacing = (reply.actions || [])
			.filter(entry => entry.action && entry.action.kind === 'switch');
		assert.ok(replacing.length,
			'the lead must actually have fallen, or this drives nothing');
		reply = driver.act(reply.battle,
			{kind: 'switch', replacementId: replacing[0].action.replacementId});
		assert.ok(reply.battle, 'the replacement resolves without Math.random');
		// The held end-of-turn must have FIRED the berry, or the rng on that
		// call is never exercised and removing it would go unnoticed.
		const incoming = reply.battle.state.sides.player.party[1];
		const boosts = incoming.boosts || {};
		assert.ok(Object.values(boosts).some(value => value >= 2),
			'the replacement\'s Starf Berry must fire in the held end-of-turn');
	} finally {
		Math.random = realRandom;
	}
});

test('the threat line states the attrition race, not just the hardest hit', () => {
	// A full nuzlocke wiped to Triathlete Mikey's Yanma while the panel read
	// "survives one crit, not two". That sentence is TRUE and reads as a mild
	// caution. The real position was two turns to die against eight to kill —
	// Sonic Boom is a fixed 20 into 34 HP, and the best answer on hand did 5
	// on its floor into 38 HP. Losing a race four to one is not a caution,
	// and nothing on screen said it.
	const mon = (id, species, extra) => Object.assign({
		id, species, level: 12, hp: {current: 34, max: 34},
		moves: [{name: 'Scratch', pp: 10, maxPP: 10}],
	}, extra || {});
	const position = (playerMoves, foeMoves) => ({
		generation: 8, mode: 'Singles', turn: 1, field: {},
		sides: {
			ai: {activeIds: ['ai-1'], party: [mon('ai-1', 'Yanma',
				{level: 11, hp: {current: 38, max: 38}, moves: foeMoves})]},
			player: {activeIds: ['player-1'], party: [mon('player-1', 'Chimchar',
				playerMoves ? {moves: playerMoves} : {})]},
		},
	});

	const losing = driver.incomingThreat(
		position(null, [{name: 'Sonic Boom', pp: 10, maxPP: 10}]));
	// The old verdict still stands and is still true — it is just not enough.
	assert.equal(losing.survivesCrit, true, 'one Sonic Boom does not kill');
	assert.equal(losing.survivesTwoCrits, false, 'two do');
	// The new one names the race.
	assert.equal(losing.race.outcome, 'lose');
	assert.equal(losing.race.turnsToDie, 2, 'fixed 20 into 34 HP');
	assert.equal(losing.race.turnsToKill, 8, 'a 5-damage floor into 38 HP');

	// A better move shortens the race but does not automatically win it.
	// Ember takes the kill from eight turns to three, and three against two
	// is still a loss — which is the point: a stronger attack is not a
	// mitigation when you are already too slow.
	const withEmber = position([{name: 'Ember', pp: 10, maxPP: 10}],
		[{name: 'Sonic Boom', pp: 10, maxPP: 10}]);
	const better = driver.incomingThreat(withEmber);
	assert.equal(better.race.turnsToKill, 3, 'Ember kills far faster than Scratch');
	assert.equal(better.race.outcome, 'lose', 'and three turns is still more than two');

	// A TIE goes to the faster side, because the faster side lands the last
	// hit. Chimchar is slower here, so 3-against-3 is a loss, not a draw.
	const tied = position([{name: 'Ember', pp: 10, maxPP: 10}],
		[{name: 'Sonic Boom', pp: 10, maxPP: 10}]);
	tied.sides.player.party[0].hp = {current: 60, max: 60};
	const tie = driver.incomingThreat(tied);
	assert.equal(tie.race.turnsToKill, tie.race.turnsToDie, 'a genuine tie on turns');
	assert.equal(tie.race.faster, false);
	assert.equal(tie.race.outcome, 'lose', 'the slower side loses a tie');

	// Enough bulk to outlast it, and the verdict finally flips.
	const bulky = position([{name: 'Ember', pp: 10, maxPP: 10}],
		[{name: 'Sonic Boom', pp: 10, maxPP: 10}]);
	bulky.sides.player.party[0].hp = {current: 100, max: 100};
	const winning = driver.incomingThreat(bulky);
	assert.equal(winning.race.turnsToDie, 5);
	assert.equal(winning.race.outcome, 'win');

	// Nothing that damages it at all is not a slow race, it is an unwinnable
	// one, and must not read as "9 turns".
	const helpless = driver.incomingThreat(
		position([{name: 'Growl', pp: 10, maxPP: 10}], [{name: 'Sonic Boom', pp: 10, maxPP: 10}]));
	assert.equal(helpless.race.outcome, 'cannot-win');
	assert.equal(helpless.race.turnsToKill, null, 'no number can describe never');
});

test('the card carries the conditions a switch would clear', () => {
	// `status` was on the card and volatiles were not, so the one condition
	// switching CURES was the one the screen never showed. Measured over 66
	// scripted fights, infatuation was 13 of 58 turns we lost — and every one
	// of them was recoverable by switching, from information that appeared
	// only as a line in the scrolling battle log.
	const doc = docWith([
		{species: 'Poochyena', map: 'Route101', level: 3},
		{species: 'Pidgey', map: 'Route102', level: 5},
	]);
	const opened = driver.start(doc, 'Youngster Calvin', 7);
	assert.deepEqual(opened.viewState.player.active.volatiles, [],
		'a fresh Pokemon carries no conditions');

	// Reach into the live state the way the engine would, then re-read the
	// card: the point is that the view PROJECTS volatiles, not that this
	// particular volatile was applied by a move.
	const state = opened.battle.state;
	const us = state.sides.player.party[0];
	us.volatile = {infatuated: {}, leechSeed: {}, roost: {}};
	const painted = driver.view(state).player.active;
	assert.ok(painted.volatiles.indexOf('infatuated') !== -1,
		'infatuation must reach the card — switching is what clears it');
	assert.ok(painted.volatiles.indexOf('seeded') !== -1, 'Leech Seed too');
	assert.equal(painted.volatiles.indexOf('roost'), -1,
		'bookkeeping volatiles stay off the card');

	// Major status still reads separately, because switching does NOT clear
	// it — the two have to stay distinguishable on screen.
	us.status = 'par';
	assert.equal(driver.view(state).player.active.status, 'par');
});
