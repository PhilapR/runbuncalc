/* eslint-env node, es6 */
'use strict';

/**
 * Gate for the playthrough driver's decision core.
 *
 * The driver is 2,300 lines that plays the game unattended and nothing pinned
 * any of it. These gates exist for that reason alone, and NOT because the
 * policy they pin was shown to be better — it was not.
 *
 * The ranking they cover was reported three times and the number shrank each
 * time. First as p = 0.03 from 251 pooled Camper Gavi attempts, which was
 * wrong: attempts inside a run share a box, a party and a policy, so there
 * were 30 independent observations and not 251. Then as p = 0.07, the
 * run-level test on the same batch — which was only ever RECONSTRUCTED, since
 * that harness recorded no revision. Then twice on frozen code with the
 * validity gates clean:
 *
 *   rank2, sacrifices on:   7/15 legacy vs 8/15 new past Camper Gavi
 *   rank3, sacrifices off:  9/15 legacy vs 9/15 new — and 5 vs 4 past Brawly
 *
 * Dead even, thirty pairs, twice. Turns-and-accuracy is the better MODEL —
 * turns are the unit the panel decides fights in, and a move that misses deals
 * nothing — and it buys no measurable wins. It ships because it is not worse
 * and the reasoning is sound, which is a much weaker claim than the one made
 * for it originally.
 *
 * The gates stay regardless. What they protect is a deliberate comparator that
 * a later reader would otherwise be free to "simplify" without knowing what it
 * was, and the fixtures below document its disagreements precisely.
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

test('a lost race reaches for speed control, lethal turn or not', () => {
	// Icy Wind was taught 36 times in one batch and pressed ZERO times in 118
	// Brawly attempts. Two separate causes, both pinned here: it is a DAMAGING
	// speed drop, and the race rule read only the pure-status set; and the
	// rule refused to fire on any turn a crit could kill us, which at a wall
	// is nearly every turn — the same over-caution the status rule had already
	// been cured of, one rule up.
	const memory = () => ({switchedFor: new Set(), statusedFoes: new Set(),
		cleared: 0, disarmed: 0, sacked: 0, screens: new Set(), boosts: 0,
		slowed: new Set(), healed: 0});
	// A lost-on-order race: two turns each way, they move first, a crit kills.
	const view = {
		foe: 'Makuhita L18',
		usHp: 62,
		risk: 'lethal',
		threat: 'Makuhita L18 — Their hardest hit: Arm Thrust 55% — 83% on a crit ' +
			'· you need 2 turns to KO, they need 2 — YOU LOSE THIS RACE',
		// The shapes the panel really renders: a floor as "48%+" in the damage
		// cell and the roll range in the tooltip, en dash and all.
		moves: [
			{move: 'Bubble Beam', damage: '48%+', title: '48–57%'},
			{move: 'Icy Wind', damage: '21%+', title: '21–25%'},
		],
		switches: [],
	};
	const chosen = policy.decide(view, memory(), []);
	assert.equal(chosen.kind, 'move');
	assert.equal(chosen.pick.move, 'Icy Wind',
		'a damaging Speed drop is speed control, and a lethal turn on a lost ' +
		'race is exactly when order is the only line left');

	// Once per foe: the same fight must not loop the drop.
	const remembered = memory();
	remembered.slowed.add('Makuhita L18');
	const second = policy.decide(view, remembered, []);
	assert.notEqual(second.pick && second.pick.move, 'Icy Wind',
		'the drop is spent once per opposing Pokemon');

	// A race lost on DAMAGE is not rescued by order: at "you need 6, they
	// need 2" the drop cannot reach the deficit and must not be pressed.
	const hopeless = Object.assign({}, view, {
		threat: 'Makuhita L18 — Their hardest hit: Arm Thrust 55% ' +
			'· you need 6 turns to KO, they need 2 — YOU LOSE THIS RACE',
	});
	const chosen2 = policy.decide(hopeless, memory(), []);
	assert.notEqual(chosen2.pick && chosen2.pick.move, 'Icy Wind',
		'order cannot rescue a four-turn deficit');

	// The membership itself, so a rename in either set is caught: every
	// guaranteed damaging drop counts, pure-status drops still count, and an
	// ordinary attack does not.
	for (const move of ['Icy Wind', 'Electroweb', 'Rock Tomb', 'Low Sweep',
		'Cotton Spore', 'String Shot']) {
		assert.ok(policy.isSlowControl(move), move + ' is speed control');
	}
	assert.ok(!policy.isSlowControl('Bubble Beam'));
	assert.ok(!policy.isSlowControl('Tackle'));

	// And the advisor economy is untouched: Icy Wind still prices as the
	// attack it is, not at the pure-status SLOW_VALUE — repricing it would
	// shuffle every teach decision as a side effect of a play-policy fix.
	assert.ok(policy.moveValue('Icy Wind', ['Ice'], []) < 90,
		'Icy Wind teaches at its damage price, not the status-drop price');

	// --speed-control=0 restores the OLD policy exactly — pure-status drops
	// only, lethal turns refused — because that is the control arm of the A/B
	// that isolates this. A control that is not the old behaviour proves
	// nothing about the change.
	const legacy = loadWith(['--speed-control=0']);
	const legacyChoice = legacy.decide(view, memory(), []);
	assert.notEqual(legacyChoice.pick && legacyChoice.pick.move, 'Icy Wind',
		'the control arm must not reach for a damaging drop');
	// And the OLD rule survives in it: a pure-status drop still fires on a
	// lost-on-order race when the turn is not lethal. A control arm that
	// dropped the old rule too would compare the change against a third
	// policy nobody ever ran.
	const calmView = Object.assign({}, view, {
		risk: '',
		moves: [
			{move: 'Bubble Beam', damage: '48%+', title: '48–57%'},
			{move: 'Cotton Spore', damage: '', title: ''},
		],
	});
	const legacySlow = legacy.decide(calmView, memory(), []);
	assert.equal(legacySlow.pick.move, 'Cotton Spore',
		'the legacy arm still plays a pure-status drop off a lethal turn');
});

test('a lost race on a lethal turn still sets the screen', () => {
	// The third instance of one over-caution: status moves, then speed drops,
	// now screens. Reflect was taught once and pressed never across 118 Brawly
	// attempts, because at a wall every turn reads lethal and the screen rule
	// refused lethal turns — while Brawly's team is almost entirely physical
	// and a screen halves all of it for five turns.
	const memory = () => ({switchedFor: new Set(), statusedFoes: new Set(),
		cleared: 0, disarmed: 0, sacked: 0, screens: new Set(), boosts: 0,
		slowed: new Set(), healed: 0});
	const view = {
		foe: 'Makuhita L18',
		usHp: 70,
		risk: 'lethal',
		threat: 'Makuhita L18 — Their hardest hit: Brick Break 61% — 92% on a crit ' +
			'· you need 3 turns to KO, they need 2 — YOU LOSE THIS RACE',
		moves: [
			{move: 'Bubble Beam', damage: '34%+', title: '34–41%'},
			{move: 'Reflect', damage: '', title: ''},
		],
		switches: [],
	};
	const chosen = policy.decide(view, memory(), []);
	assert.equal(chosen.pick.move, 'Reflect',
		'a lost race on a lethal turn is exactly when halving their side pays');

	// A WINNING race on a lethal turn attacks instead: the exception is for
	// races already lost, not a licence to set up while ahead under fire.
	const winning = Object.assign({}, view, {
		threat: 'Makuhita L18 — Their hardest hit: Brick Break 61% ' +
			'· you need 1 turn to KO, they need 2 — you win it',
	});
	assert.notEqual(policy.decide(winning, memory(), []).pick.move, 'Reflect',
		'ahead under fire, the answer is the attack');

	// The control arm refuses the lethal turn, exactly as the old policy did.
	const legacy = loadWith(['--screen-control=0']);
	assert.notEqual(legacy.decide(view, memory(), []).pick.move, 'Reflect',
		'the control arm must refuse the lethal turn');

	// And BOTH arms still set screens off a lethal turn — the old rule is the
	// old rule, not a casualty of the flag.
	const calm = Object.assign({}, view, {risk: ''});
	assert.equal(policy.decide(calm, memory(), []).pick.move, 'Reflect');
	assert.equal(legacy.decide(calm, memory(), []).pick.move, 'Reflect',
		'the control arm still screens when no crit threatens');
});

test('a lost race into a physical hitter halves the hit', () => {
	// Third instance of a drop nobody pressed: zero presses in 801 wall
	// fights. The teach counts (Charm x41 and kin) turned out to be LEVEL-UP
	// arrivals rather than advisor picks — traced through the journals, 48 of
	// 48 attributable teaches came from level-up prompts, and 72 of 85 were
	// churned out again before the walls — so the pressed-zero has two causes:
	// no play rule knew the drops existed, and most bars no longer carried
	// them. Free Growl-class arrivals DO survive to the walls, which is what
	// this rule reaches for. A -2 Attack drop halves a physical attacker's
	// damage and so DOUBLES their turns-to-KO — it rescues races a Speed drop
	// cannot, because reordering never changes the counts.
	const memory = () => ({switchedFor: new Set(), statusedFoes: new Set(),
		cleared: 0, disarmed: 0, sacked: 0, screens: new Set(), boosts: 0,
		slowed: new Set(), healed: 0});
	// Lost by two: order cannot fix this (the slow rule refuses at margin -2),
	// but halving Brick Break turns "they need 2" into "they need 4".
	const view = {
		foe: 'Makuhita L18',
		usHp: 80,
		risk: 'lethal',
		threat: 'Makuhita L18 — Their hardest hit: Brick Break 55% — 83% on a crit ' +
			'· you need 4 turns to KO, they need 2 — YOU LOSE THIS RACE',
		moves: [
			{move: 'Bubble Beam', damage: '26%+', title: '26–31%'},
			{move: 'Charm', damage: '', title: ''},
		],
		switches: [],
	};
	const chosen = policy.decide(view, memory(), []);
	assert.equal(chosen.pick.move, 'Charm',
		'a lost race into a physical hit reaches for the Attack drop');
	assert.match(chosen.why, /halving Brick Break/);

	// Against a SPECIAL hitter the drop does nothing and must not be pressed.
	const special = Object.assign({}, view, {
		threat: 'Makuhita L18 — Their hardest hit: Shock Wave 55% ' +
			'· you need 4 turns to KO, they need 2 — YOU LOSE THIS RACE',
	});
	assert.notEqual(policy.decide(special, memory(), []).pick.move, 'Charm',
		'-2 Attack does not touch a special move');

	// Once per foe.
	const spent = memory();
	spent.slowed.add('atk:Makuhita L18');
	assert.notEqual(policy.decide(view, spent, []).pick.move, 'Charm');

	// A WON race attacks: the drop is a rescue, not an opener.
	const winning = Object.assign({}, view, {
		threat: 'Makuhita L18 — Their hardest hit: Brick Break 55% ' +
			'· you need 1 turn to KO, they need 3 — you win it',
	});
	assert.notEqual(policy.decide(winning, memory(), []).pick.move, 'Charm');

	// The control arm has no rule at all.
	const legacy = loadWith(['--attack-drop=0']);
	assert.notEqual(legacy.decide(view, memory(), []).pick.move, 'Charm',
		'the control arm never presses an Attack drop');
});

test('a level-up teach replaces the right move, not the first-listed one', () => {
	// Spheal learned Charm over Ice Ball 27 times because teachPending took
	// options[0], and the advisor then bought the slot back 27 times with
	// Brine. Traced through the journals: 48 of 48 attributable drop teaches
	// were level-up arrivals, 72 of 85 churned out again before the walls.
	// The choice is value-ordered now, with two guards.

	// An incoming ATTACK takes the weakest attack — never the first-listed.
	assert.equal(policy.pickReplace(
		['Charm', 'Bubble Beam', 'Water Gun', 'Growl'], 'Ice Beam', 'Marill'),
	'Water Gun', 'the weakest attack goes, not whatever sat first');

	// A STATUS arrival never takes the last attack: an all-status mon is how
	// a L12 Abra pressed Kinesis seven turns into a L9 Clobbopus and died.
	assert.equal(policy.pickReplace(
		['Tackle', 'Charm', 'Growl', 'Baby-Doll Eyes'], 'Sing', 'Marill'),
	'Charm', 'the last attack survives a status arrival');

	// An incoming attack MAY take the last attack — the bar keeps one either
	// way.
	assert.equal(policy.pickReplace(
		['Tackle', 'Charm', 'Growl', 'Baby-Doll Eyes'], 'Bubble Beam', 'Marill'),
	'Tackle');

	// Control moves the play rules press are spent only when nothing better
	// is on the bar: with two attacks up, the drop survives even listed first.
	assert.equal(policy.pickReplace(
		['Icy Wind', 'Charm', 'Bubble Beam', 'Tackle'], 'Surf', 'Marill'),
	'Tackle', 'the drop and the slow move outlive the weakest attack');

	// Empty options is a null, not a throw — the caller skips the teach.
	assert.equal(policy.pickReplace([], 'Surf', 'Marill'), null);

	// DOMINANCE, which is Philip's Spheal example: Water Pulse next to Bubble
	// Beam is a worse Water button — same type, less expected power — so it
	// goes before Mud Shot does, even though Mud Shot's raw number is lower.
	// Coverage survives; redundancy pays.
	// Rock Throw is the WEAKEST attack on this bar (50 against Water Pulse's
	// 60) and it still survives, because it is the only Rock button while
	// Water Pulse is a worse copy of Bubble Beam. The first version of this
	// fixture used a bar where the dominated move was also the weakest plain
	// attack, and removing the dominance step passed it — the two paths gave
	// one answer.
	assert.equal(policy.pickReplace(
		['Bubble Beam', 'Water Pulse', 'Rock Throw', 'Growl'], 'Ice Beam', 'Marill'),
	'Water Pulse', 'the dominated same-type attack goes before the coverage move');

	// Priority is worth more than its number: Aqua Jet is 40 next to Bubble
	// Beam's 65 and same-typed, and it still stays — it collects the 1-HP
	// survivors the threshold work exists for. (The first version of this
	// fixture used Mud Shot and failed correctly: Mud Shot is a guaranteed
	// speed drop, so the rule spares it too.)
	assert.equal(policy.pickReplace(
		['Aqua Jet', 'Bubble Beam', 'Rock Throw', 'Growl'], 'Surf', 'Marill'),
	'Rock Throw', 'priority is never counted dominated; the plain attack goes');

	// Multi-hit base power is per HIT: Rock Blast reads 25 and its real work
	// is 2-5 hits and a broken sash. It is not dominated by Rock Throw.
	assert.equal(policy.pickReplace(
		['Rock Blast', 'Rock Throw', 'Bubble Beam', 'Growl'], 'Surf', 'Marill'),
	'Rock Throw', 'multi-hit is spared; the plain same-type attack goes');

	// CONSISTENCY: expected power is BP discounted by accuracy, so Zap Cannon
	// (120 at 50%, expecting 60) goes before Spark (65 at 100%). Raw base
	// power reads Spark as the weaker move and gets this exactly backwards.
	assert.equal(policy.pickReplace(
		['Zap Cannon', 'Spark', 'Growl'], 'Thunderbolt', 'Marill'),
	'Zap Cannon', 'a coin-flip cannon is worth less than a reliable 65');

	// The control arm restores options[0] exactly.
	const legacy = loadWith(['--smart-replace=0']);
	assert.equal(legacy.pickReplace(
		['Charm', 'Bubble Beam', 'Water Gun', 'Growl'], 'Ice Beam', 'Marill'),
	'Charm', 'the control arm takes whatever sits first');
});

test('a pinned box parses exactly or refuses at startup', () => {
	// The screens A/B measured p=0.05 on an INERT treatment because no rolled
	// box kept a screen learner. A pinned box exists to make that class of
	// experiment possible — so a malformed pin must refuse at startup, not
	// run a 480-second batch on an empty box.
	assert.deepEqual(policy.parsePinBox('Blipbug:5,Poochyena:5'),
		[{species: 'Blipbug', level: 5}, {species: 'Poochyena', level: 5}]);
	// Names with the characters real species use.
	assert.deepEqual(policy.parsePinBox("Farfetch'd:10, Mr. Mime:12, Ho-Oh:70"),
		[{species: "Farfetch'd", level: 10}, {species: 'Mr. Mime', level: 12},
			{species: 'Ho-Oh', level: 70}]);
	// Empty means no pin, silently — the ordinary un-pinned run.
	assert.deepEqual(policy.parsePinBox(''), []);
	// Malformed REFUSES, naming the entry.
	assert.throws(() => policy.parsePinBox('Blipbug'), /cannot read "Blipbug"/);
	assert.throws(() => policy.parsePinBox('Blipbug:five'), /cannot read/);
	assert.throws(() => policy.parsePinBox('Blipbug:5,,'), /cannot read/);
});

test('the A/B harness forwards `--` args and refuses its own typos', () => {
	// The harness docblock promised "everything after `--` is passed to both
	// arms" and nothing implemented it: a pinned-box experiment ran six runs
	// with no pin, the treatment was inert, and the batch printed VALID — the
	// exact bug class the harness exists to refuse, committed by the harness.
	const ab = require('../scripts/ab.js');
	assert.deepEqual(
		ab.parseAbArgv(['node', 'ab.js', '--pairs=6', '--', '--pin-box=Blipbug:5', '--x=1']),
		{own: ['--pairs=6'], passthrough: ['--pin-box=Blipbug:5', '--x=1']});
	assert.deepEqual(ab.parseAbArgv(['node', 'ab.js', '--pairs=6']),
		{own: ['--pairs=6'], passthrough: []});
	// A bare `--` forwards nothing and owns nothing extra.
	assert.deepEqual(ab.parseAbArgv(['node', 'ab.js', '--']),
		{own: [], passthrough: []});
});
