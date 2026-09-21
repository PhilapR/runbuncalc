/* eslint-env node, es6 */
'use strict';

/**
 * Gate for the advisor (run.adviseUpgrades) and the fight playbook.
 *
 * The recommendation surfaces: what the advisor offers, what it refuses and
 * why, what it charges, and when it may skip half the board. Rulings in
 * DECISIONS.json that bind the advisor name this file; run.test.js keeps the
 * recording half of each. Split from run.test.js so Node runs it in
 * parallel with the rest.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const run = require('../lib/run');
const fixtures = require('./helpers/run-fixtures.js');
const PERFECT_IVS = fixtures.PERFECT_IVS;
const owned = fixtures.owned;
const fresh = fixtures.fresh;

test('the playbook says how many fights its assignment search played', () => {
	// The assignment search is the most expensive thing this library does —
	// profiled at 81% of a plan-then-rank-then-playbook sequence, because every
	// variant it explores is a PLAYED fight, not a table read. `explored` alone
	// reads as a count of cheap things, so the rollouts behind each one are
	// reported beside it.
	//
	// It is also the accurate half, and the budget was the one knob a caller
	// could not reach: `rollouts` sized the final line while the search stayed
	// pinned at four. Measured over eight real mid-run states, four and twelve
	// chose a different variant in half of them and twelve was never worse.
	let state = fresh({levelCap: 'none'});
	for (const species of ['Poochyena', 'Zigzagoon-Galar', 'Ralts', 'Surskit',
		'Shroomish', 'Makuhita']) {
		state = run.apply(state, owned({kind: 'catch', species, level: 24}));
	}
	state = run.apply(state, {kind: 'party', ids: state.box.map(mon => mon.id)});

	const standard = run.fightPlaybook(state, 'Youngster Calvin');
	assert.equal(standard.variantRollouts, 4,
		'four is what the tool has always paid and must stay the default');
	assert.ok(standard.explored > 0, 'the search must actually run');
	assert.ok(standard.explored <= 16,
		`explored ${standard.explored} variants; the power set is bounded at 2^4`);

	// The knob reaches the search rather than only the final line.
	const careful = run.fightPlaybook(state, 'Youngster Calvin', {variantRollouts: 8});
	assert.equal(careful.variantRollouts, 8);

	// And it can never ask for more per variant than the whole call allows,
	// which would price a search above the line it exists to choose.
	const clamped = run.fightPlaybook(state, 'Youngster Calvin',
		{rollouts: 3, variantRollouts: 12});
	assert.equal(clamped.variantRollouts, 3,
		'variantRollouts is capped by rollouts, not independent of it');

	// A search that did not run reports no per-variant cost, rather than a
	// budget it never spent.
	const off = run.fightPlaybook(state, 'Youngster Calvin', {optimize: false});
	assert.equal(off.explored, 0);
	assert.equal(off.variantRollouts, 0);
});

test('an item upgrade says whether it survives being used', () => {
	// Philip: an Eviolite is reusable and a resist berry is not, and an advisor
	// cannot price the two the same way. It still cannot — the grid credits a
	// held item in every enemy column, so a berry that fires once is scored as
	// though it fired in all of them, and fixing that needs the run to know
	// when an item was eaten, which it does not. What it CAN do is say which
	// kind of item it is offering, and that is the half a player acts on:
	// swapping a berry for an Eviolite reads as a smaller gain than it is,
	// because the berry it replaces was overcredited in the baseline.
	//
	// `lib/item-facts` derives the answer from the engine's own consumeItem
	// call sites rather than a hand list, so this moves when the engine does.
	// Before this it was a module nothing imported.
	//
	// TWO fixtures, because one could not exercise both halves. A lone Aron is
	// the only party where a Chople Berry survives the improvement filter — it
	// blunts a gym full of Fighting — and it draws no teach offers at all, so
	// an assertion about teach rows made against it guarded nothing.
	let berries = fresh({levelCap: 'none'});
	berries = run.apply(berries, owned({kind: 'catch', species: 'Aron', level: 24}));
	berries = run.apply(berries, {kind: 'party', ids: [berries.box[0].id]});
	berries = run.apply(berries, {kind: 'acquire', item: 'Chople Berry'});
	berries = run.apply(berries, {kind: 'acquire', item: 'Eviolite'});
	const offered = run.adviseUpgrades(berries, 'Leader Brawly').upgrades
		.filter(row => row.singleUse !== undefined);

	const berry = offered.find(row => /Chople Berry/.test(row.detail));
	const eviolite = offered.find(row => /Eviolite/.test(row.detail));
	assert.ok(berry, 'the fixture must offer the berry, or the true case is unguarded');
	assert.ok(eviolite, 'and the Eviolite, or the false case is unguarded');
	assert.equal(berry.singleUse, true, 'a Chople Berry is eaten and gone');
	assert.equal(eviolite.singleUse, false, 'an Eviolite is worn, not spent');

	// A six-strong party standing at Brawly draws teach offers, which the lone
	// Aron does not. Only an item may carry the field: a one-shot MOVE is not a
	// thing, and every consumer would have to decide what it meant.
	let party = fresh({levelCap: 'next-milestone-ace'});
	for (const species of ['Prinplup', 'Staravia', 'Lombre', 'Flaaffy', 'Bayleef', 'Lumineon']) {
		party = run.apply(party, owned({kind: 'catch', species, level: 21}));
	}
	party = run.apply(party, {kind: 'party', ids: party.box.map(mon => mon.id)});
	for (const fight of run.upcoming(party, 4000)) {
		if (/Leader Brawly/.test(fight.trainer)) break;
		try {
			party = run.apply(party, {kind: 'beat', trainer: fight.trainer});
		} catch (error) { /* an optional or variant fight the road skips */ }
	}
	const mixed = run.adviseUpgrades(party, 'Leader Brawly').upgrades;
	assert.ok(mixed.some(row => row.kind === 'teach'),
		'the fixture must draw a teach offer, or the leak assertion guards nothing');
	for (const row of mixed) {
		if (row.singleUse === undefined) continue;
		assert.ok(row.kind === 'give' || row.kind === 'pickup',
			`${row.kind} carries singleUse, and only an item may`);
	}
});

test('the advisor never teaches suicide: self-KO moves price as trades', () => {
	// A lone Seedot vs Calvin: its learnset holds Misty Explosion and
	// Explosion, both guaranteed KOs on paper, both fatal to Seedot. The
	// optimizer used to lead with "Misty Explosion, +3 KO"; the board now
	// refuses to call a sacrifice an answer, so the whole family prices at
	// no gain and drops off the list — and the top teach is a real move.
	let state = run.apply(fresh({permadeath: true}),
		owned({kind: 'catch', species: 'Seedot', map: 'Route103', level: 2}));
	state = run.apply(state, {kind: 'party', ids: ['mon-1']});
	state = run.apply(state, {kind: 'levelUp', id: 'mon-1', to: 'cap'});
	const advice = run.adviseUpgrades(state, 'Youngster Calvin');
	assert.equal(advice.upgrades.length, 0,
		'a bare Seedot has no confirmed, currently obtainable improvement here');
	// Every move a Seedot can be taught is dated now, so nothing of ITS is
	// withheld for want of a date — the withholding itself is gated below, on
	// the one move that is still undated.
	assert.equal(advice.availability.undatedMovesExcluded, 0);
	let tympole = run.apply(fresh({permadeath: true}),
		owned({kind: 'catch', species: 'Tympole', map: 'Littleroot Town', level: 2, method: 'fish'}));
	tympole = run.apply(tympole, {kind: 'party', ids: ['mon-1']});
	tympole = run.apply(tympole, {kind: 'levelUp', id: 'mon-1', to: 'cap'});
	const withheld = run.adviseUpgrades(tympole, 'Youngster Calvin');
	assert.ok(withheld.availability.undatedMovesExcluded > 0,
		'a legal but undated TM idea (Earth Power) is withheld instead of sold as current prep');
	assert.ok(withheld.upgrades.every(u => !/Earth Power/.test(u.detail)));
	assert.ok(advice.upgrades.every(u => !/Explosion|Self-Destruct|Final Gambit/.test(u.detail)),
		'no self-KO move may be sold as an upgrade');

	// Bullet Seed is Seedot's best answer here — and an EGG move, reachable
	// only through the relearner, which charges one Heart Scale. With an
	// empty bag it may not be offered; with a scale it returns, price named.
	assert.ok(advice.upgrades.every(u => !/Bullet Seed|Take Down/.test(u.detail)),
		'an egg move without a Heart Scale is not a change the player can make');
	const funded = run.apply(state, {kind: 'acquire', item: 'Heart Scale'});
	const paid = run.adviseUpgrades(funded, 'Youngster Calvin');
	assert.equal(paid.upgrades[0].detail, 'Bullet Seed (one Heart Scale)');
	// koGained is 0, not 1. Bullet Seed hits 2-5 times, and 35% of the time it
	// hits twice. A KO that needs three hits is not one the board may promise,
	// so the credit is damage, not a KO. This assertion read 1 while the
	// damage facts were built on the calculator's fixed pin of three hits —
	// it was pricing a KO the game misses better than a third of the time.
	assert.equal(paid.upgrades[0].delta.koGained, 0,
		'a 2-5 hit move never guarantees a KO on its floor of two hits');
	assert.ok(paid.upgrades[0].delta.damage > paid.upgrades[1].delta.damage * 2,
		'it still leads, and by a wide margin — on damage it can actually promise');

	// The teach command charges the same price: refused broke, paid funded.
	// Nothing is free by merely HAVING another route any more — a TM route
	// costs that TM, which is a one-time item in this fork.
	assert.throws(() => run.apply(state, {kind: 'teach', id: 'mon-1', move: 'Bullet Seed'}),
		/Seedot must REMEMBER Bullet Seed — an egg move or one from a previous learnset, and the nurse charges one Heart Scale/);
	const taught = run.apply(funded, {kind: 'teach', id: 'mon-1', move: 'Bullet Seed'});
	assert.ok(taught.log[taught.log.length - 1].summary.includes('for one Heart Scale'));
	assert.equal(taught.bag['Heart Scale'], undefined, 'the scale is spent');
	let pooch = run.apply(fresh({permadeath: true}),
		{kind: 'catch', species: 'Poochyena', map: 'Route101', level: 3});
	// Play Rough is a previous-learnset move for this Poochyena, so the nurse
	// charges for it; with a scale it is remembered, and the scale is gone.
	assert.throws(() => run.apply(pooch, {kind: 'teach', id: 'mon-1', move: 'Play Rough'}),
		/must REMEMBER Play Rough/);
	pooch = run.apply(pooch, {kind: 'acquire', item: 'Heart Scale', where: 'granted for the gate'});
	pooch = run.apply(pooch, {kind: 'teach', id: 'mon-1', move: 'Play Rough'});
	assert.ok(pooch.log[pooch.log.length - 1].summary.includes('for one Heart Scale'));
	assert.equal(pooch.bag['Heart Scale'], undefined, 'the scale is spent');

	// And never an HM the story has not handed over: Lotad's Surf gates at
	// order 594, so an advisor at order 3 may not offer it. TMs carry no dates
	// in the source, so only the HM spine is gated.
	const oracle = require('../profiles').getProfile('run-and-bun').oracle;
	assert.equal(oracle.moveObtainableAt('Surf'), 594);
	assert.equal(oracle.moveObtainableAt('Rock Smash'), 142);
	assert.equal(oracle.moveObtainableAt('Tackle'), null);
	let wet = run.apply(fresh({permadeath: true}),
		owned({kind: 'catch', species: 'Lotad', map: 'Petalburg City', level: 5,
			method: 'fish'}));
	wet = run.apply(wet, {kind: 'party', ids: ['mon-1']});
	wet = run.apply(wet, {kind: 'levelUp', id: 'mon-1', to: 'cap'});
	const early = run.adviseUpgrades(wet, 'Bug Catcher Rick');
	assert.ok(early.upgrades.every(u => !/^Surf\b|\bSurf$/.test(u.detail) &&
		!/Waterfall|\bDive\b|\bFly\b|Strength/.test(u.detail)),
	'no undelivered HM may be offered as a teach');
});

test('the advisor recommends field pickups, with where to go get them', () => {
	// A player who never records pickups has an empty bag, and the bag-only
	// advisor priced no items at all. The overworld hands out a Miracle Seed
	// on Route 104 (#11) — a Grass Treecko fighting a fisherman's water mons
	// at #22 should be told to go get it.
	let state = run.apply(fresh({permadeath: true}),
		owned({kind: 'catch', species: 'Treecko', level: 5}));
	state = run.apply(state, {kind: 'party', ids: ['mon-1']});
	state = run.apply(state, {kind: 'levelUp', id: 'mon-1', to: 'cap'});
	const advice = run.adviseUpgrades(state, 'Fisherman Elliot');
	const seed = advice.upgrades.find(u => u.kind === 'pickup' && /Miracle Seed/.test(u.detail));
	assert.ok(seed, 'the Miracle Seed pickup must be offered against water');
	assert.match(seed.detail, /Miracle Seed \(pickup @ Route 104\)/);
	assert.ok(seed.delta.damage > 0);

	// Not before the overworld has handed it out: order 0 predates every
	// type-boost pickup, so none may be offered there.
	const early = run.adviseUpgrades(state, 'Youngster Calvin');
	assert.ok(early.upgrades.every(u => !/Miracle Seed|Silk Scarf|Soft Sand/.test(u.detail)),
		'no pickup that the overworld has not handed out yet');

	// Once the bag records the pickup, the same item is a GIVE, not a trip.
	const bagged = run.apply(state, {kind: 'acquire', item: 'Miracle Seed'});
	const again = run.adviseUpgrades(bagged, 'Fisherman Elliot');
	assert.ok(again.upgrades.some(u => u.kind === 'give' && u.detail === 'Miracle Seed'));
	assert.ok(again.upgrades.every(u => !/pickup @ Route 104/.test(u.detail)));

	// The split sheet lists the same items as prep: names, places, and
	// whether the run can reach them yet.
	const prep = run.splitPrep(state);
	const sheet = prep.pickups.map(p => p.name);
	assert.ok(sheet.includes('Miracle Seed') && sheet.includes('Silk Scarf') &&
		sheet.includes('Soft Sand'), `Brawly-split pickups missing from ${sheet}`);
	const scarf = prep.pickups.find(p => p.name === 'Silk Scarf');
	assert.equal(scarf.location, 'Route 106');
	assert.equal(scarf.reachable, false, 'not reachable at position -1');
	// Collected items drop off the sheet.
	assert.ok(!run.splitPrep(bagged).pickups.some(p => p.name === 'Miracle Seed'));
});

test('the advisor can price a turn, not only a bar of HP', () => {
	// Lady Cindy is three Cute Charm users holding Oran Berries whose movepool
	// is Attract and Thunder Wave. The fight is not a damage race and never
	// was: measured over six scripted playthroughs we out-hit her side 43.8%
	// to 25.2% per hit and KO'd 96 to 46, and lost anyway, because 8.1% of our
	// turns went to status against 0.6% of theirs.
	//
	// The counter is a Cheri Berry, and the upgrade list could not show one.
	// Every candidate was scored through a damage matrix and then dropped
	// unless it gained a KO or added damage, so an item whose whole value is
	// a turn scored 0.00 and was deleted before the player saw it.
	let state = run.apply(fresh({permadeath: true}),
		owned({kind: 'catch', species: 'Lillipup', map: 'Route101', level: 3}));
	state = run.apply(state, {kind: 'party', ids: ['mon-1']});
	state = run.apply(state, {kind: 'levelUp', id: 'mon-1', to: 'cap'});
	const bare = run.adviseUpgrades(state, 'Lady Cindy');
	assert.ok(bare.upgrades.every(u => !/Cheri Berry/.test(u.detail)),
		'nothing to offer while the bag holds no cure');

	const cured = run.apply(state, {kind: 'acquire', item: 'Cheri Berry'});
	const advice = run.adviseUpgrades(cured, 'Lady Cindy');
	const cheri = advice.upgrades.find(u => u.detail === 'Cheri Berry');
	assert.ok(cheri, 'a Cheri Berry must be offered against a team built on Thunder Wave');
	assert.equal(cheri.delta.damage, 0, 'it adds no damage — that is the whole point');
	assert.equal(cheri.delta.koGained, 0);
	assert.equal(cheri.delta.statusAnswered, 2,
		'two of Cindy\'s three carry Thunder Wave, and the count is per Pokemon');

	// The count is what the fight actually threatens, not a property of the
	// item: the same berry against a fight with no paralysis answers nothing,
	// and so is not offered.
	const elsewhere = run.adviseUpgrades(cured, 'Youngster Calvin');
	assert.ok(elsewhere.upgrades.every(u => !/Cheri Berry/.test(u.detail)),
		'a cure for a status this fight cannot inflict is not an upgrade');

	// A cure for the wrong status is not an answer either, even against Cindy.
	const wrong = run.apply(state, {kind: 'acquire', item: 'Rawst Berry'});
	assert.ok(run.adviseUpgrades(wrong, 'Lady Cindy').upgrades
		.every(u => !/Rawst Berry/.test(u.detail)),
	'nothing on this team burns, so a burn cure answers nothing');

	// Lum covers paralysis among everything else, so it answers the same two.
	const lum = run.apply(state, {kind: 'acquire', item: 'Lum Berry'});
	const lumAdvice = run.adviseUpgrades(lum, 'Lady Cindy').upgrades
		.find(u => u.detail === 'Lum Berry');
	assert.ok(lumAdvice && lumAdvice.delta.statusAnswered >= 2);
});

test('the advisor prices single changes by what they do to the board', () => {
	const state = run.applyAll(fresh(), [
		owned({kind: 'catch', species: 'Poochyena', map: 'Route101', level: 3,
			ivs: Object.assign({}, PERFECT_IVS, {spe: 5})}),
		{kind: 'party', ids: ['mon-1']},
		{kind: 'acquire', item: 'Heart Scale'},
		{kind: 'acquire', item: 'Rare Candy', count: 3},
		{kind: 'acquire', item: 'Choice Band'},
		// Clear the Route 103 rival trio so the advice is still priced against
		// Youngster Calvin, the matchup this fixture's deltas were derived on.
		{kind: 'beat', trainer: 'Trainer Rival Route 103 Swampert'},
	]);
	const before = JSON.stringify(state);
	const advice = run.adviseUpgrades(state);
	assert.equal(JSON.stringify(state), before, 'asking a question must not move the run');
	assert.equal(advice.trainer, 'Youngster Calvin');
	assert.equal(advice.order, 3);
	// The board's projection, because it is the board's numbers: a level 3 catch
	// stands in front of that grunt at 12.
	assert.deepEqual(advice.projection, {applied: true, cap: 12, from: 'projected'});
	assert.deepEqual(advice.party, [{id: 'mon-1', species: 'Poochyena', nickname: null,
		level: 12, from: 3}]);

	// The candidate set is every move with a confirmed route NOW, every HOLDABLE bag item,
	// and one scale per recorded sub-31 IV. Rare Candy and the Heart Scale are
	// both in the bag and in neither list: the calculator cannot hold them, so a
	// build made of them is not a build.
	// Derived at the PROJECTED cap, because that is where the advisor draws
	// candidates: the free candy guarantees the levels between — minus any HM
	// the story has not handed over by this fight, which the advisor may not
	// offer (learnable itself stays a capability list).
	const oracle = require('../profiles').getProfile('run-and-bun').oracle;
	// A move the projected Pokemon ALREADY KNOWS is not a candidate. Levelling
	// teaches now, so by the cap Poochyena has picked several of these up on
	// its own, and offering to teach one would be advice to spend a slot on
	// something the cap hands over for free.
	const alreadyKnown = new Set(run.partySpecs(state, {atOrder: 0})[0].moves);
	const teachable = run.learnable(state, 'mon-1', {atLevel: 12}).now
		.filter(entry => {
			if (alreadyKnown.has(entry.move)) return false;
			const gate = oracle.moveObtainableAt(entry.move);
			const level = entry.sources.some(source =>
				source.level !== undefined && source.level <= 12);
			const egg = entry.sources.some(source => /^egg(?:\s|$|\()/.test(source.source));
			const datedTeach = entry.sources.some(source => source.source === 'teachable') &&
				gate !== null && gate <= 0;
			return level || datedTeach || egg;
		}).length;
	// ...plus every holdable field pickup the overworld has handed out by
	// THIS FIGHT's order that the run has not collected (the advisor's fourth
	// kind). This read "by order 0", which agreed only while the advisor saw
	// the 28 curated rows: the dated ledger puts a Pecha Berry at order 3.
	const pickups = oracle.itemsObtainableBy(advice.order)
		.filter(p => require('../lib/planner').holdableItem(p.name)).length;
	assert.equal(advice.considered, teachable + 1 + 1 + pickups);

	// The deterministic case. This read "Poochyena knows only Tackle", which
	// stopped being true when levelling started teaching: by the cap it has
	// Tackle, Sand Attack, Odor Sleuth and Bite. With a real attacking move
	// already in hand, the Choice Band flips TWO cells where the paid Play
	// Rough flips one, so the ranking changed — and it changed for a reason
	// the old model could not see.
	const top = advice.upgrades[0];
	assert.deepEqual({kind: top.kind, id: top.id, detail: top.detail},
		{kind: 'give', id: 'mon-1', detail: 'Choice Band'});
	assert.equal(top.delta.koGained, 2);
	assert.equal(top.delta.koConceded, 0);
	assert.ok(top.delta.damage > 0, 'a flipped cell also moves the damage');

	// The priced teach is still offered and still names its price — it just
	// is not the best change any more.
	const priced = advice.upgrades.find(upgrade => /^Play Rough/.test(upgrade.detail));
	assert.ok(priced, 'the relearner route is still weighed');
	assert.match(priced.detail, /\(one Heart Scale\)$/, 'and still names what it costs');
	assert.equal(priced.delta.koGained, 1);

	// And the claim is the BOARD's claim, cell for cell — the advisor scores by
	// rebuilding the row through the planner, so an upgrade can never disagree
	// with the grid a player reads next to it.
	const planner = require('../lib/planner');
	const specs = run.partySpecs(state, {atOrder: 0});
	const ko = payload => payload.grid.filter(cell => cell.versus[0].us.guaranteedKO).length;
	assert.equal(ko(planner.matchup({trainer: 'Youngster Calvin', playerParty: specs,
		profileId: state.profileId})), 0);
	assert.equal(ko(planner.matchup({trainer: 'Youngster Calvin', profileId: state.profileId,
		playerParty: [Object.assign({}, specs[0],
			{moves: specs[0].moves.concat(['Play Rough'])})]})), 1);

	// Best first, capped at ten, and nothing in it that changes nothing: a
	// shortlist padded with moves worth zero has told the player nothing.
	assert.ok(advice.upgrades.length <= 10);
	const net = advice.upgrades.map(e => e.delta.koGained - e.delta.koConceded);
	assert.deepEqual(net.slice().sort((a, b) => b - a), net);
	for (const entry of advice.upgrades) {
		assert.ok(net[advice.upgrades.indexOf(entry)] > 0 || entry.delta.damage > 0,
			`${entry.detail} improves nothing and should not be listed`);
	}
	// Deterministic: the same run must produce the same shortlist twice.
	assert.deepEqual(run.adviseUpgrades(state).upgrades, advice.upgrades);
});

test('the advisor draws teach candidates at the projected cap, not today\'s level', () => {
	// A level 3 Poochyena stands in front of the first grunt at 12, and the free
	// candy guarantees the levels between — so Bite (level 10) is a candidate
	// even though the box holds a level 3. Gating on today's level hid every
	// level-up move between here and the cap while scoring the board at the cap.
	const state = run.applyAll(fresh(), [
		owned({kind: 'catch', species: 'Poochyena', map: 'Route101', level: 3}),
		{kind: 'party', ids: ['mon-1']},
	]);
	assert.ok(run.learnable(state, 'mon-1', {atLevel: 12}).now.some(e => e.move === 'Bite'));
	assert.ok(!run.learnable(state, 'mon-1').now.some(e => e.move === 'Bite'),
		'without atLevel the line stays at the box level — other callers keep their meaning');

	// Bite is no longer a TEACH candidate, and that is the point: Poochyena
	// learns it by level 12 on its own, so proposing it would be advice to
	// spend a move slot on something the cap hands over for free. This test
	// asserted the opposite until levelling started teaching.
	const details = run.adviseUpgrades(state).upgrades
		.filter(u => u.kind === 'teach').map(u => u.detail);
	assert.ok(!details.some(d => /^Bite/.test(d)),
		`Bite is learned by L12, so it must not be offered as a teach: ${details.join(', ')}`);
	// The projection genuinely knows it at the cap, which is why it drops out.
	assert.ok(run.partySpecs(state, {atOrder: 0})[0].moves.includes('Bite'),
		'because the projected Poochyena already has Bite');
});

test('the advisor only offers a Heart Scale it can pay for and price', () => {
	const box = owned({kind: 'catch', species: 'Poochyena', map: 'Route101', level: 3,
		ivs: Object.assign({}, PERFECT_IVS, {spe: 5})});
	const oracle = require('../profiles').getProfile('run-and-bun').oracle;
	// Same derivation the advisor uses: the capability list minus HMs the
	// story has not handed over by order 0, minus egg moves when no Heart
	// Scale is in the bag to pay the relearner with.
	// ...and minus anything the projected Pokemon has already LEARNED. Levelling
	// teaches now, so by the cap several of these are in hand and offering to
	// teach one would be advice to pay for something the cap gives free.
	const teachableAt = (state, hasScale) => {
		const known = new Set(run.partySpecs(state, {atOrder: 0})[0].moves);
		return run.learnable(state, 'mon-1', {atLevel: 12}).now
			.filter(entry => {
				if (known.has(entry.move)) return false;
				const gate = oracle.moveObtainableAt(entry.move);
				const level = entry.sources.some(source =>
					source.level !== undefined && source.level <= 12);
				const egg = entry.sources.some(source => /^egg(?:\s|$|\()/.test(source.source));
				const datedTeach = entry.sources.some(source => source.source === 'teachable') &&
					gate !== null && gate <= 0;
				return level || datedTeach || (egg && hasScale);
			}).length;
	};
	const teachable = teachableAt(
		run.applyAll(fresh(), [box, {kind: 'party', ids: ['mon-1']}]), false);
	const pickupsAt0 = oracle.itemsObtainableBy(0)
		.filter(p => require('../lib/planner').holdableItem(p.name)).length;

	// No scale in the bag, no scale candidate: the advisor ranks changes a
	// player can make today, not ones they could make after finding an item.
	assert.equal(run.adviseUpgrades(
		run.applyAll(fresh(), [box, {kind: 'party', ids: ['mon-1']}])).considered,
	teachable + pickupsAt0);

	// A fully perfect roll has no IV candidate. The scale in the bag still
	// unlocks egg-move teaches, and the count grows by exactly those.
	const funded = run.applyAll(fresh(), [
		owned({kind: 'catch', species: 'Poochyena', map: 'Route101', level: 3,
			ivs: PERFECT_IVS}),
		{kind: 'party', ids: ['mon-1']},
		{kind: 'acquire', item: 'Heart Scale'},
	]);
	assert.equal(run.adviseUpgrades(funded).considered, teachableAt(funded, true) + pickupsAt0);
	// (Evolutions are the advisor's fifth kind, but a Poochyena projected to 12
	// is short of Mightyena's 18 — it contributes no candidate here, which is
	// itself the claim: eligibility is judged at the projected cap.)
});

test('the advisor weighs an evolution the run has already earned', () => {
	// A box full of level-16+ Treeckos graded as Treeckos called Brawly
	// unwinnable when Grovyle wins it: the sim that first ran this split wiped
	// 30/30 unevolved and won 26/30 evolved, with no other change. The advisor
	// must surface the free upgrade, judged at the projected cap like teaches.
	const state = run.applyAll(fresh(), [
		owned({kind: 'catch', species: 'Poochyena', map: 'Route101', level: 3}),
		{kind: 'party', ids: ['mon-1']},
	]);
	// Against Brawly the cap is 21 and Mightyena's 18 is inside it.
	const advice = run.adviseUpgrades(state, 'Leader Brawly');
	const evolve = advice.upgrades.find(u => u.kind === 'evolve');
	assert.ok(evolve, 'an earned evolution must be on the shortlist');
	assert.equal(evolve.detail, 'evolve into Mightyena');
	assert.ok(evolve.delta.damage > 0 || evolve.delta.koGained > 0,
		'the evolved row must beat the unevolved one somewhere');
	// Against the first grunt the cap is 12: not earned yet, not offered.
	assert.ok(!run.adviseUpgrades(state).upgrades.some(u => u.kind === 'evolve'),
		'an evolution the cap has not reached is not a change the player can make');
});

test('the advisor refuses what it cannot answer, with the reason', () => {
	// The party, not the box: six mons times their learnsets is already hundreds
	// of policy evaluations, and which six is the board's question, not this one.
	assert.throws(() => run.adviseUpgrades(fresh()),
		/the party is empty: add Pokemon to the party/);
	const state = run.applyAll(fresh(), [
		{kind: 'catch', species: 'Poochyena', map: 'Route101', level: 3},
		{kind: 'party', ids: ['mon-1']},
	]);
	assert.throws(() => run.adviseUpgrades(state, 'Leader Brawley'), /no fight named/);
});

test('skipping the enemy half for a teach candidate changes no answer', () => {
	// adviseUpgrades stops recomputing how hard the enemy hits us when the only
	// thing a candidate changes is which moves we know. That is safe because
	// nothing about our Pokemon's defence moved, and because upgradeDelta
	// subtracts that half from itself in any case — but "safe because I
	// reasoned it" is how a wrong optimisation ships, so this compares the
	// whole advise output with the shortcut on and off.
	//
	// It is deliberately NOT taken for a pickup: Eviolite, Focus Sash and the
	// resist berries are all in the dex, and a resist berry answers one type,
	// so a single-cell probe would read "unchanged" against an enemy without
	// that type and be wrong about the next one.
	const planner = require('../lib/planner');
	const real = planner.matchup;
	const IVS = {hp: 20, atk: 18, def: 19, spa: 22, spd: 17, spe: 21};
	const parties = [
		['Prinplup', 'Staravia', 'Lombre', 'Flaaffy', 'Bayleef', 'Lumineon'],
		['Grotle', 'Luxio', 'Gastrodon', 'Beedrill', 'Donphan', 'Ampharos'],
	];
	try {
		for (const species of parties) {
			let doc = run.applyAll(run.createRun({
				name: 'splice', now: 't0', levelCap: 'none',
				permadeath: false, onePerRoute: false,
			}), species.map(name => ({
				kind: 'catch', species: name, level: 24, ivs: Object.assign({}, IVS),
			})));
			doc = run.apply(doc, {kind: 'party', ids: doc.box.map(mon => mon.id)});
			for (const fight of ['Camper Gavi', 'Leader Brawly']) {
				planner.matchup = function (options) {
					const copy = Object.assign({}, options);
					delete copy.skipThem;
					return real.call(this, copy);
				};
				const full = JSON.stringify(run.adviseUpgrades(doc, fight));
				planner.matchup = real;
				const spliced = JSON.stringify(run.adviseUpgrades(doc, fight));
				assert.equal(spliced, full,
					species[0] + ' vs ' + fight + ': the shortcut must not move any number');
			}
		}
	} finally {
		planner.matchup = real;
	}
});

test('a held item can move the enemy half, which is why only teach skips it', () => {
	// The reason adviseUpgrades takes the shortcut for `teach` and not for
	// `pickup`. Without this, someone widens the condition to "anything that is
	// not an evolution", the advise fixtures still pass — their bag happens to
	// hold only Miracle Seed, Silk Scarf, Soft Sand and Poison Barb, which are
	// all offensive — and the shortcut is silently wrong the first time a
	// resist berry or an Eviolite reaches the bag.
	//
	// Aron is Steel/Rock, so Brawly's Fighting hits it for 4x. That matters:
	// a Chople Berry only acts on a move that is already super-effective, so
	// the same probe on a Pokemon that merely takes Fighting neutrally shows
	// no change at all and would "prove" the opposite.
	const planner = require('../lib/planner');
	const aron = {
		species: 'Aron', level: 24,
		moves: ['Headbutt', 'Metal Claw', 'Rock Tomb', 'Harden'],
		ivs: {hp: 20, atk: 18, def: 19, spa: 22, spd: 17, spe: 21},
	};
	const board = item => planner.matchup({
		trainer: 'Leader Brawly',
		playerParty: [item ? Object.assign({}, aron, {item: item}) : aron],
		profileId: 'run-and-bun',
	}).grid.map(cell => cell.versus[0].them.max);

	const bare = board(null);
	const movedBy = item => board(item).filter((max, i) => Math.abs(max - bare[i]) > 1e-9).length;

	assert.ok(movedBy('Chople Berry') > 0,
		'a resist berry changes what the enemy does to us, so a pickup cannot reuse the baseline');
	assert.ok(movedBy('Eviolite') > 0, 'and so does Eviolite');
	assert.equal(movedBy('Silk Scarf'), 0,
		'while a type-boosting item touches only our own damage — which is what makes ' +
		'the wider shortcut look safe on a bag that happens to hold nothing else');
});
