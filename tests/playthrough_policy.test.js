/* eslint-env node, es6 */
'use strict';

/**
 * Gate for the playthrough driver's decision core.
 *
 * The driver is 2,300 lines that plays the game unattended, and until now
 * nothing pinned any of it. That mattered once its policy stopped being a
 * guess: ranking moves by turns-to-KO with accuracy beat ranking them by raw
 * damage across thirty interleaved runs, 8.9% of Camper Gavi attempts won
 * against 2.7%. That per-attempt p of 0.03 was OVERSTATED and is corrected
 * here: attempts inside a run share a box, a party and a policy, so they are
 * not the 251 independent trials the test assumed — there were 30. The
 * run-level test on the same data gives p = 0.07. The change still ships,
 * because it leads on every metric and the mechanism is sound, but it is not
 * significant at the conventional bar. A measured result that nothing pins is a
 * result that regresses quietly, and the next person to "simplify" the
 * comparator has no way to know what it cost to find.
 *
 * These are the pure parts — a view or a scored entry in, a number or an
 * object out. The parts that drive a page are not testable here and are not
 * pretended to be.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const policy = require('../scripts/ui-playthrough.js');

/** A scored move as `scoreMove` produces one. */
function move(name, min, max, extra) {
	return Object.assign({
		move: name, label: name, min: min, max: max,
		acc: policy.accuracyOf(name),
		floorKO: false, guaranteedKO: false, damaging: true,
	}, extra || {});
}

/**
 * The driver reads its flags from argv at load, so a gate for a flagged
 * behaviour has to load its own copy with that flag set. This exists because
 * --status-value now defaults to 0: the pricing it controls was measured and
 * did NOT improve outcomes, so it ships off. The mechanism is still gated,
 * because a thing that is off must still be correct when switched on.
 */
function loadWith(argv) {
	const key = require.resolve('../scripts/ui-playthrough.js');
	const saved = process.argv;
	delete require.cache[key];
	try {
		process.argv = ['node', 'ui-playthrough.js'].concat(argv);
		return require('../scripts/ui-playthrough.js');
	} finally {
		process.argv = saved;
		delete require.cache[key];
	}
}

test('the race is read as numbers, not as a mood', () => {
	// The panel ends every threat line with this sentence and the driver used
	// to keep only the verdict. The two numbers in front of it are the whole
	// of the reasoning: whether the race is lost by one turn or by four.
	const lost = policy.raceOf({threat: 'Rookidee L6 — Their hardest hit: Wing Attack 38% ' +
		'— 54% on a crit · survives one crit, not two · you need 3 turns to KO, ' +
		'they need 2 — YOU LOSE THIS RACE'});
	assert.deepEqual(lost, {ours: 3, theirs: 2, lost: true, margin: -1});

	const won = policy.raceOf({threat: 'Poochyena L5 — Their hardest hit: Bite 19% · ' +
		'survives a crit · you need 1 turn to KO, they need 4 — you win it'});
	assert.deepEqual(won, {ours: 1, theirs: 4, lost: false, margin: 3});

	// Singular "1 turn" has to parse too, and it is the one a regex written
	// against the plural silently misses.
	assert.equal(policy.raceOf({threat: 'you need 1 turn to KO, they need 2'}).ours, 1);

	// A forced switch has no threat line. Nulls, never guesses — a guessed
	// margin would let the Speed-drop rule fire on a race nobody measured.
	assert.deepEqual(policy.raceOf({threat: ''}),
		{ours: null, theirs: null, lost: false, margin: null});
	assert.deepEqual(policy.raceOf({}), {ours: null, theirs: null, lost: false, margin: null});
});

test('accuracy reads `true` as never-miss and an unknown move as reliable', () => {
	assert.equal(policy.accuracyOf('Surf'), 1);
	assert.equal(policy.accuracyOf('Thunder'), 0.8);
	// Shock Wave and Aerial Ace carry `true` rather than a number. Treating
	// that as 0 would rank the only moves that cannot miss below everything.
	assert.equal(policy.accuracyOf('Shock Wave'), 1);
	assert.equal(policy.accuracyOf('Aerial Ace'), 1);
	// A move the dex does not know must not be punished for being unknown.
	assert.equal(policy.accuracyOf('Not A Real Move'), 1);
});

test('turns to KO counts the floor, and prices a miss as the lost turn it is', () => {
	assert.equal(policy.turnsToKO(move('Surf', 50, 60)), 2);
	assert.equal(policy.turnsToKO(move('Surf', 34, 40)), 3);
	assert.equal(policy.turnsToKO(move('Surf', 100, 100)), 1);
	// 50% at 85% accuracy needs more than the two turns the damage implies.
	assert.ok(policy.turnsToKO(move('Hydro Pump', 50, 60)) > 2);
	// Nothing that cannot damage can ever reach a KO.
	assert.equal(policy.turnsToKO(move('Surf', 0, 0)), Infinity);
});

test('a move that saves a turn beats a move that only adds damage', () => {
	// The disagreement the whole change is about: identical floors, and the
	// one that cannot miss reaches the KO first.
	const ranked = policy.rankMoves([
		move('Hydro Pump', 50, 60),
		move('Flash Cannon', 50, 57),
		move('Waterfall', 34, 40),
	]);
	assert.equal(ranked[0].move, 'Flash Cannon');
	assert.equal(ranked[2].move, 'Waterfall', 'three turns is last however hard it hits');

	// Damage that does not change the turn count changes nothing: both need
	// two turns, so the tie falls to the bigger floor.
	const tie = policy.rankMoves([move('Surf', 51, 60), move('Bubble Beam', 60, 70)]);
	assert.equal(tie[0].move, 'Bubble Beam');

	// The case that actually isolates the turns term, and the reason it is
	// spelled out: two earlier versions of this assertion passed with the
	// turns comparison DELETED, because expected damage happened to agree
	// with it on both fixtures. Agreement proves nothing. These disagree:
	//
	//   sure   50% floor at 100%  ->  2.000 turns, 50.00 expected damage
	//   swing  55% floor at  95%  ->  2.105 turns, 52.25 expected damage
	//
	// The bigger move hits harder on average and still takes longer to finish
	// the job. Turns take `sure`; expected damage alone takes `swing`. The
	// accuracies are set here rather than looked up, so the fixture cannot
	// stop disagreeing because a dex entry changed.
	const sure = move('Surf', 50, 60, {acc: 1});
	const swing = move('Hydro Pump', 55, 65, {acc: 0.95});
	assert.ok(policy.turnsToKO(sure) < policy.turnsToKO(swing),
		'fixture invalid: turns must prefer `sure`');
	assert.ok(swing.min * swing.acc > sure.min * sure.acc,
		'fixture invalid: expected damage must prefer `swing`');
	assert.equal(policy.rankMoves([swing, sure])[0].move, 'Surf',
		'the move that reaches the KO sooner wins even when the other hits harder');
});

test('a KO outranks everything, and a KO that can miss is not the equal of one that cannot', () => {
	// This one is over-determined, and saying so is more useful than pretending
	// otherwise: three separate terms of the comparator each pick the reliable
	// KO on their own — the KO tier carries accuracy, turnsToKO divides by it,
	// and expected damage multiplies by it. Breaking any one, or even two, of
	// them leaves this passing. Only removing accuracy from the model entirely
	// fails it, which is the regression actually worth guarding: the belt and
	// the braces are deliberate, and a single-line edit should not be able to
	// quietly undress the policy.
	const ranked = policy.rankMoves([
		move('Surf', 40, 48),
		move('Thunder', 99, 99, {floorKO: true}),
		move('Shock Wave', 99, 99, {floorKO: true}),
	]);
	assert.equal(ranked[0].move, 'Shock Wave', 'the KO that cannot miss leads');
	assert.equal(ranked[2].move, 'Surf', 'and a non-KO never outranks a KO');
});

test('an unread flag is reported rather than ignored', () => {
	// The failure this exists for: --legacy-rank was passed to an entire A/B
	// arm before it existed, and the driver ignored it in silence, so the
	// control would have run the treatment with one term switched off.
	const argv = process.argv;
	try {
		process.argv = ['node', 'x', '--rules=encounters', '--typo-flag=1', '--headed'];
		const unread = policy.unreadFlags();
		assert.ok(unread.includes('typo-flag'), 'a flag nothing reads must be named');
		assert.ok(!unread.includes('rules'), 'a flag that was read must not be');
		assert.ok(!unread.includes('headed'),
			'a bare flag read through argv.includes must not read as unused');
	} finally {
		process.argv = argv;
	}
});

test('an IV note reports a floor when the roll is only partly known', () => {
	assert.equal(policy.ivNote({ivs: {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31}}),
		' · IV 186/186');
	// Three unrecorded stats are not three zeroes, and saying "84/186" would
	// read as a bad roll rather than a partial record.
	const partial = policy.ivNote({ivs: {hp: 28, atk: 28, def: 28}});
	assert.match(partial, /IV 84\+ \(3 not recorded\)/);
	assert.doesNotMatch(partial, /\/186/);
	assert.equal(policy.ivNote({}), '');
	assert.equal(policy.ivNote(null), '');
});

test('the level cap is read off the panel, and its absence is not a zero', () => {
	assert.equal(policy.capOf({cap: 'Level cap 42 — Leader Norman\'s Cinccino'}), 42);
	// An uncapped run has no cap to read. Null sends levelling to the
	// strongest-foe fallback; 0 would stop it levelling at all.
	assert.equal(policy.capOf({cap: ''}), null);
	assert.equal(policy.capOf({}), null);
});

test('a status move is priced by what it takes away, not by its zero base power', () => {
	const priced = loadWith(['--status-value=24']);
	const grass = ['Grass'];
	const worth = name => priced.moveValue(name, grass, []);

	// Off by default, and that is the measured answer rather than an oversight:
	// fifteen runs an arm said pricing status did not beat leaving it at zero.
	assert.equal(policy.moveValue('Sleep Powder', grass, []), 0,
		'the default ships the pricing off, as the A/B decided');

	// The defect this pins: every sleep, paralysis and confusion move has no
	// base power, fell through to zero, and was therefore always the weakest
	// thing on the bar and the first taught over. 344 went that way across the
	// recorded runs — 34 Sleep Powders, 28 Sings, 26 Thunder Waves.
	assert.ok(worth('Sleep Powder') > 0, 'a sleep move is not worth nothing');
	assert.ok(worth('Sleep Powder') > worth('Tackle'),
		'and it is worth more than a 40 base power attack');

	// Ordered by the same table the driver trusts when it decides which status
	// to press: sleep 5, paralysis 4, confusion 3, toxic 2, poison 1.
	assert.ok(worth('Sleep Powder') > worth('Thunder Wave'));
	assert.ok(worth('Thunder Wave') > worth('Confuse Ray'));
	assert.ok(worth('Confuse Ray') > worth('Toxic'));
	assert.ok(worth('Toxic') > worth('Poison Powder'));

	// Paralysis is a Speed drop plus a chance to skip the turn, so it must not
	// price below one. That anchoring is what fixes the scale to the others.
	assert.ok(worth('Thunder Wave') >= worth('Cotton Spore'),
		'paralysis is a Speed drop and more, so it cannot be worth less');
});

test('a guaranteed status counts even when the move also does damage', () => {
	const policy = loadWith(['--status-value=24']);
	const electric = ['Electric'];
	// Nuzzle is a guaranteed paralysis carrying 20 base power. Priced as an
	// attack it is worth 20 and was taught over 41 times.
	assert.ok(policy.moveValue('Nuzzle', electric, []) >
		policy.basePowerOf('Nuzzle') * 1.5,
	'Nuzzle is worth more than its base power, STAB included');
	assert.equal(policy.moveValue('Nuzzle', electric, []),
		policy.moveValue('Thunder Wave', electric, []),
		'because it is worth the paralysis it guarantees');

	// Both branches: moveValue returns early when no upcoming enemies are
	// known and takes the effectiveness path when they are. The first
	// falsification of this test only broke the second branch and the test
	// stayed green, because the fixture never reached it.
	const foes = [['Water'], ['Flying']];
	assert.equal(policy.moveValue('Nuzzle', electric, foes),
		policy.moveValue('Thunder Wave', electric, foes),
		'the paralysis floor holds on the effectiveness path too');

	// And the floor must not inflate an ordinary attack that merely has a
	// secondary chance: STATUS_BY_MOVE answers only for guaranteed status, so
	// these stay priced as the attacks they are.
	for (const attack of ['Thunderbolt', 'Body Slam', 'Lava Plume']) {
		assert.equal(policy.moveValue(attack, [], []), policy.basePowerOf(attack),
			attack + ' has only a secondary chance and must price as an attack');
	}
});
