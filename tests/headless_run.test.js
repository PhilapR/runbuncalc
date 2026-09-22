/* eslint-env node, es6 */
'use strict';

/**
 * Gate for the headless run harness's preparation between fights.
 *
 * It parsed a teach row as "learn X" when the advisor writes "X over Y", so
 * no headless run ever taught a move, and it never levelled the box, so the
 * advice that did parse was refused at the stored catch level. A run that
 * prepares like that measures a player who never grinds and never learns.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const run = require('../lib/run.js');
const headless = require('../scripts/headless-run.js');

function freshBox() {
	let doc = run.createRun({name: 'gate', now: 't0', levelCap: 'next-milestone-ace',
		permadeath: false, onePerRoute: true, rival: 'Blaziken'});
	const random = headless.dice(1000);
	doc = run.apply(doc, Object.assign({kind: 'catch', species: 'Turtwig', level: 5},
		run.rollIdentity('Turtwig', random, {perfectIvs: 3})));
	for (const map of ['MAP_ROUTE101', 'MAP_ROUTE102', 'MAP_ROUTE103']) {
		const rolled = run.rollEncounter(doc, {map, random});
		doc = run.apply(doc, {kind: 'catch', map, species: rolled.species, level: rolled.level,
			ivs: rolled.ivs, nature: rolled.nature, ability: rolled.ability});
	}
	return run.apply(doc, {kind: 'party', ids: doc.box.map(mon => mon.id)});
}

test('the harness levels the box to the cap before a fight', () => {
	const doc = freshBox();
	const cap = run.levelCap(doc).cap;
	assert.ok(doc.box.every(mon => mon.level < cap), 'caught below the cap');
	const tally = {scaleSpends: 0};
	const levelled = headless.levelToCap(doc, tally);
	assert.ok(levelled.box.every(mon => mon.level === cap), levelled.box.map(mon => mon.level).join(','));
	assert.equal(tally.levelUps, doc.box.length);
	const turtwig = levelled.box.find(mon => mon.species === 'Turtwig');
	assert.ok(turtwig.moves.length === 4, 'levelling fills free slots: ' + turtwig.moves.join('/'));
});

test('the harness applies the advisor\'s teach rows as the advisor writes them', () => {
	// A headless run as it stopped at Camper Gavi before this was fixed (seed
	// 1000, Turtwig): stored levels 2-14, never taught.
	const stalled = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..',
		'fixtures', 'banked-runs', 'headless-stall-1000.run.json'), 'utf8'));
	assert.ok(!stalled.log.some(entry => entry.command.kind === 'teach'), 'the stalled run never taught');
	const tally = {scaleSpends: 0};
	const levelled = headless.levelToCap(stalled, tally);
	const rows = run.adviseUpgrades(levelled).upgrades.filter(row => row.kind === 'teach');
	assert.ok(rows.some(row => / over /.test(row.detail)), 'the advisor writes "X over Y": ' +
		rows.map(row => row.detail).join('; '));
	const taught = headless.followAdvice(levelled, headless.armFlags(''), tally);
	assert.ok(tally.teaches > 0, 'at least one teach row became a teach');
	const first = rows.find(row => / over /.test(row.detail));
	const move = /^(.+?) over /.exec(first.detail)[1];
	assert.ok(taught.box.some(mon => mon.moves.includes(move)) ||
		taught.log.some(entry => entry.command.kind === 'teach'), 'the moves changed in the document');
});

test('the harness hands out the held items the advisor names', () => {
	const stalled = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..',
		'fixtures', 'banked-runs', 'headless-stall-1000.run.json'), 'utf8'));
	assert.ok(stalled.box.every(mon => !mon.item), 'the stalled run held nothing');
	const tally = {scaleSpends: 0};
	const prepared = headless.followAdvice(headless.levelToCap(stalled, tally), headless.armFlags(''), tally);
	assert.ok(tally.gives > 0, 'a give row became a give');
	assert.ok(prepared.box.some(mon => mon.item), 'and a Pokemon holds it');
});

test('levelling evolves as the game does, not only when the advisor asks', () => {
	const stalled = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..',
		'fixtures', 'banked-runs', 'headless-stall-1000.run.json'), 'utf8'));
	const tally = {scaleSpends: 0};
	const levelled = headless.levelToCap(stalled, tally);
	const dossier = require('../lib/dossier');
	for (const mon of levelled.box.filter(entry => entry.status !== 'dead')) {
		assert.equal(dossier.evolveMon(mon, mon.level), mon.species,
			mon.species + ' at ' + mon.level + ' should already have evolved');
	}
	assert.ok(tally.evolves > 0);
	assert.ok(!levelled.box.some(mon => mon.species === 'Turtwig'), 'Turtwig is a Grotle by the cap');
});

test('a headless run plays the project\'s rules: one per route, the dupes clause by line, caps', () => {
	const doc = headless.startRun({species: 'Turtwig', rival: 'Blaziken'}, headless.dice(1000));
	assert.deepEqual([doc.rules.onePerRoute, doc.rules.permadeath, doc.rules.dupesClause, doc.rules.levelCap],
		[true, false, 'line', 'next-milestone-ace']);
	assert.deepEqual(doc.party, [doc.box[0].id], 'the starter is caught and fielded');
});

test('the harness teaches the priority answer a threshold fight demands', () => {
	// Sweep-3 run 5 (seed 523658) as it stalled at Aqua Admin Shelly: her
	// Mienshao holds a Focus Sash with Reversal and the party had no
	// priority attack; the library names Manectric's Quick Attack.
	const run = require('../lib/run.js');
	const doc = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..',
		'fixtures', 'banked-runs', 'headless-shelly-523658.run.json'), 'utf8'));
	const prep = run.preFightOpportunities(doc).thresholdPrep;
	assert.deepEqual(prep.threats.map(threat => threat.species + ' ' + threat.move + ' ' + threat.holds),
		['Mienshao Reversal Focus Sash']);
	assert.equal(prep.covered, false);
	// The named answer may be a remembered move, and the nurse charges a Heart
	// Scale for one, so the gate funds it.
	let funded = doc;
	for (let n = 0; n < 3; n++) funded = run.apply(funded, {kind: 'acquire', item: 'Heart Scale', where: 'granted for the gate'});
	const tally = {scaleSpends: 0};
	const taught = headless.thresholdPrep(funded, tally);
	assert.equal(tally.thresholdTeaches, 1);
	const row = prep.teachable[0];
	assert.ok(taught.box.find(mon => mon.id === row.id).moves.includes(row.move), row.species + ' learned ' + row.move);
	assert.ok(run.preFightOpportunities(taught).thresholdPrep.covered, 'and the demand is met');
	assert.equal(headless.thresholdPrep(taught, tally), taught, 'a met demand teaches nothing more');
});

test('the harness holds its one Game Corner prize until a wall needs it', () => {
	// Ruling the-game-corner-pays-once (operator, from play, 2026-09-20): ONE
	// prize a run, from any tier whose gym is beaten. This gate used to
	// assert one prize PER BADGE, which is how every sweep past Roxanne came
	// to hold up to eight bodies a real run cannot.
	const doc = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..',
		'fixtures', 'banked-runs', 'headless-shelly-523658.run.json'), 'utf8'));
	const tiers = require('../profiles/run-and-bun/oracle/sources.json').gameCorner.tiers;
	const open = tiers.filter(tier => tier.opensAt !== null && tier.opensAt <= doc.position);
	assert.ok(open.length >= 2 && open.length < tiers.length, 'several tiers open, not the last: ' + open.length);

	// Not stuck: the option is held, because a better tier may yet open.
	const held = headless.claimPrizes(doc, headless.dice(5), {}, 0);
	assert.equal(held.box.length, doc.box.length, 'a run that is not stuck keeps its pull');

	// Stuck at a wall: the pull is spent, on the HIGHEST tier open.
	const tally = {};
	const claimed = headless.claimPrizes(doc, headless.dice(5), tally, 6);
	assert.equal(tally.prizes, 1, 'one prize, however many badges');
	const prizes = claimed.log.filter(entry => entry.command.kind === 'catch' && entry.command.prize);
	assert.equal(prizes.length, 1);
	const top = open[open.length - 1];
	assert.equal(prizes[0].command.prize, top.badge, 'the highest tier whose gym is beaten');
	assert.ok(top.options.includes(prizes[0].command.species));
	assert.match(tally.prize.why, /a wall was lost 6 times/, 'and the record says why it was spent');

	assert.equal(headless.claimPrizes(claimed, headless.dice(6), {}, 60).box.length, claimed.box.length,
		'never twice, however stuck');
	const fresh = headless.startRun({species: 'Turtwig', rival: 'Blaziken'}, headless.dice(1));
	assert.equal(headless.claimPrizes(fresh, headless.dice(2), {}, 60).box.length, fresh.box.length,
		'no badge, no prize');
});

test('the harness keeps catching past 24: a PC has no cap', () => {
	const doc = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..',
		'fixtures', 'banked-runs', 'headless-shelly-523658.run.json'), 'utf8'));
	assert.ok(doc.box.length >= 24, 'the stalled box is at the old cap: ' + doc.box.length);
	const tally = {catches: 0, keyRolls: 0};
	const swept = headless.sweepCatches(doc, new Set(), headless.dice(3), headless.armFlags(''), tally);
	assert.ok(swept.box.length > doc.box.length, 'open routes are still caught on: ' + swept.box.length);
});

test('the harness relearns clear level-up upgrades and keeps what raw power misreads', () => {
	// Remembering a move costs a Heart Scale at the nurse (the level-up's own
	// prompt is free and stands only until the next one), so the gate funds it.
	// The Norman stall box with one Cufant from Granite Cave B1F, levelled to
	// 42 as a Copperajah still knowing Tackle, Growl, Rock Throw, Rock Smash.
	const doc = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..',
		'fixtures', 'banked-runs', 'headless-norman-cufant.run.json'), 'utf8'));
	const policy = require('../scripts/ui-playthrough.js');
	// The nurse charges a Heart Scale to remember a move, and the harness
	// spends one only on a body that fights — so the gate fields the Cufant
	// and funds the nurse.
	const runtime = require('../lib/run.js');
	const cufant = doc.box.find(mon => mon.species === 'Copperajah');
	let funded = runtime.apply(doc, {kind: 'party',
		ids: [cufant.id].concat((doc.party || []).filter(id => id !== cufant.id)).slice(0, 6)});
	for (let n = 0; n < 6; n++) funded = runtime.apply(funded, {kind: 'acquire', item: 'Heart Scale', where: 'granted for the gate'});
	const tally = {};
	const after = headless.relearn(funded, policy, tally);
	const copperajah = after.box.find(mon => mon.species === 'Copperajah');
	assert.ok(copperajah.moves.includes('Iron Head'), 'a STAB upgrade: ' + copperajah.moves.join('/'));
	assert.ok(tally.relearned > 0);
	for (const mon of doc.box) {
		const now = after.box.find(entry => entry.id === mon.id);
		for (const move of mon.moves) {
			if (policy.isSlowControl(move)) assert.ok(now.moves.includes(move), mon.species + ' keeps ' + move);
		}
	}
});

test('the policy never presses Focus Punch into an attack, and breaks a sash with a multi-hit move', () => {
	const policy = require('../scripts/ui-playthrough.js');
	const move = (name, low, high) => ({move: name, ball: null, label: name, title: name,
		damage: low + '%+ up to ' + high + '%'});
	const attacked = {threat: 'Their hardest hit: Tri Attack 89%', foeHp: 13, foeItem: null, foeAbility: null,
		moves: [move('Focus Punch', 87, 104), move('Flare Blitz', 40, 48)]};
	assert.equal(policy.bestMove(attacked).move, 'Flare Blitz', 'Focus Punch moves last and is hit first');
	assert.equal(policy.bestMove(Object.assign({}, attacked, {threat: ''})).move, 'Focus Punch',
		'against a foe with no attack it lands');
	const sashed = {threat: 'Their hardest hit: Earthquake 90%', foeHp: 100, foeItem: 'Focus Sash', foeAbility: null,
		moves: [move('Ice Beam', 80, 95), move('Bullet Seed', 20, 60)]};
	assert.equal(policy.bestMove(sashed).move, 'Bullet Seed', 'the sash breaks to a multi-hit move');
	assert.equal(policy.bestMove(Object.assign({}, sashed, {foeHp: 60})).move, 'Ice Beam', 'a broken sash is no reason');
	assert.equal(policy.bestMove(Object.assign({}, sashed, {foeItem: null, foeAbility: 'Sturdy'})).move, 'Bullet Seed');
});

test('a multi-floor area is caught on one of its floors, not skipped', () => {
	// The Norman stall box (seed 1000 + 13 in sweep 3's numbering) held no
	// Granite Cave catch: the area has no table of its own and the roll's
	// refusal was swallowed.
	const doc = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..',
		'fixtures', 'banked-runs', 'headless-norman-cufant.run.json'), 'utf8'));
	const withoutCave = structuredClone(doc);
	withoutCave.box = withoutCave.box.filter(mon => !/GRANITE_CAVE/.test((mon.origin || {}).map || ''));
	withoutCave.log = withoutCave.log.filter(entry => !(entry.command.kind === 'catch' &&
		/GRANITE_CAVE/.test(entry.command.map || '')));
	const tally = {catches: 0, keyRolls: 0};
	const swept = headless.sweepCatches(withoutCave, new Set(), headless.dice(4), headless.armFlags(''), tally);
	const cave = swept.box.filter(mon => /GRANITE_CAVE/.test((mon.origin || {}).map || ''));
	assert.equal(cave.length, 1, 'one Granite Cave encounter: ' + cave.map(mon => mon.species).join(','));
});

test('a roll never turns up a species the hack removed', () => {
	// The author's Unavailable Pokemon sheet lists Sunkern, Wooper, Quagsire,
	// Goldeen, Shuckle, Smeargle and Pineco; the tables that still carry them
	// are content the tracker never lists.
	const run = require('../lib/run.js');
	const oracle = require('../profiles').getProfile('run-and-bun').oracle;
	let doc = run.createRun({name: 'gate', now: 't0', levelCap: 'next-milestone-ace', permadeath: false,
		onePerRoute: true, dupesClause: 'line', rival: 'Blaziken'});
	doc = Object.assign({}, doc, {position: 1620});
	assert.throws(() => run.rollEncounter(doc, {map: 'Safari Zone Southeast', random: Math.random}),
		/a species this hack removed/);
	const random = headless.dice(1234);
	for (let k = 0; k < 60; k++) random();
	for (let k = 0; k < 40; k++) {
		const rolled = run.rollEncounter(doc, {map: 'Altering Cave', random});
		assert.notEqual(oracle.availabilityOfSpecies(rolled.species).status, 'unavailable', rolled.species);
		assert.notEqual(oracle.availabilityOfSpecies(rolled.species).status, 'unreachable', rolled.species);
	}
});

test('an owed fight whose retries are spent waits for the next cap, and the road goes on', () => {
	// Sweep 10: a skipped double sorts first again once passed, a second skip
	// of it is refused, and three of the five deepest runs stopped there.
	const run = require('../lib/run.js');
	const battery = require('../scripts/scenario-battery.js');
	let doc = battery.loadDocument(require('node:path').join(__dirname, '..', 'fixtures', 'banked-runs', 'br-21.run.json'));
	const owed = run.upcoming(doc, 1000).find(fight => fight.isDouble);
	doc = run.apply(doc, {kind: 'skip', trainer: owed.trainer});
	while (doc.position < owed.order) doc = run.apply(doc, {kind: 'beat', trainer: run.upcoming(doc, 1)[0].trainer});
	assert.equal(run.upcoming(doc, 1)[0].trainer, owed.trainer, 'the debt sorts first once passed');
	const cap = run.levelCap(doc).cap;
	assert.equal(headless.nextFight(doc, new Map()).trainer, owed.trainer);
	const forward = headless.nextFight(doc, new Map([[owed.order, cap]]));
	assert.ok(forward.order > doc.position && forward.trainer !== owed.trainer, 'the road goes on: ' + forward.trainer);
	assert.equal(headless.nextFight(doc, new Map([[owed.order, cap - 1]])).trainer, owed.trainer,
		'a higher cap brings the debt back');
});

test('a body never relearns what it gave up', () => {
	// The advisor and the relearn rule were fighting each other all game: Icy
	// Wind over Air Cutter, then Air Cutter over Icy Wind, for ever. Banked
	// runs spent 33-66% of their teaches re-teaching a move that body had
	// already had, one of them 970 times of 1,474. The defect only appears in
	// a RUN, where the two passes meet and the box changes between them.
	const policy = require('../scripts/ui-playthrough.js');
	// A per-run knob since 16ca259; pushed onto argv it was silently ignored
	// and this gate played the default 110 fights instead of the 40 it needs.
	const row = headless.playRun(policy, {species: 'Chimchar', rival: 'Blaziken'}, 104770,
		headless.armFlags('--budget=40 --key-catches=1 --key-scales=1 --key-evolve=1'), {keepDoc: true});
	assert.equal(row.knobs.budget, 40);
	const taught = row.doc.log.filter(entry => entry.command.kind === 'teach')
		.map(entry => entry.command.id + '|' + entry.command.move);
	assert.ok(taught.length > 10, 'the run teaches: ' + taught.length);
	const repeats = taught.filter((key, index) => taught.indexOf(key) !== index);
	assert.deepEqual(repeats, [], 'no body is taught a move it already had: ' + repeats.slice(0, 4).join(', '));
});

test('an arm\'s knobs reach its run, and leave with it', () => {
	// playRun(…, armFlags('--budget=45 --boss-retries=6')) used to play the
	// defaults: armFlags dropped every flag but three, the harness read its
	// knobs from argv once, and the row's provenance listed no flags. Five
	// runs were measured that way before a review caught it.
	const policy = require('../scripts/ui-playthrough.js');
	const starter = {species: 'Chimchar', rival: 'Blaziken'};
	const short = headless.playRun(policy, starter, 104770, headless.armFlags('--budget=3 --boss-retries=2'));
	assert.equal(short.knobs.budget, 3, 'the row records the budget it played');
	assert.equal(short.knobs.bossRetries, 2);
	assert.equal(short.knobs.doubleRetries, 2, 'a double follows the boss budget it was given');
	assert.ok(short.fights <= 3, 'and the run obeyed it: ' + short.fights + ' fights');

	const longer = headless.playRun(policy, starter, 104770, headless.armFlags('--budget=6'));
	assert.equal(longer.knobs.budget, 6);
	assert.equal(longer.knobs.bossRetries, 20, 'the first arm\'s retries did not leak into the second');
	assert.ok(longer.fights > short.fights, 'two arms in one process diverge: ' +
		short.fights + ' then ' + longer.fights);
});

test('a stone the bag holds is used, on a body outside the six too', () => {
	// Every legal Norman box fielded a level-42 Eelektrik with a Thunder Stone
	// in the bag: the advisor prices evolve rows for the party of the moment,
	// the six is re-picked later, and a re-pick does not re-run the advice.
	const runtime = require('../lib/run.js');
	let doc = headless.startRun({species: 'Chimchar', rival: 'Blaziken'}, headless.dice(1));
	doc = runtime.apply(doc, {kind: 'catch', species: 'Eelektrik', level: 20, map: 'Route110', method: 'fish'});
	doc = runtime.apply(doc, {kind: 'acquire', item: 'Thunder Stone', where: 'a mart, for the gate'});
	const eel = doc.box.find(mon => mon.species === 'Eelektrik');
	assert.ok(!doc.party.includes(eel.id), 'the Eelektrik is boxed, not in the six');

	const tally = {};
	const evolved = headless.evolveByItem(doc, tally);
	assert.equal(evolved.box.find(mon => mon.id === eel.id).species, 'Eelektross');
	assert.equal(tally.itemEvolves, 1);
	assert.ok(!evolved.bag['Thunder Stone'], 'and the stone is spent');
	assert.equal(headless.evolveByItem(evolved, {}).box.length, evolved.box.length, 'once');
});

test('a run picks the berry trees, and nobody in the six holds nothing', () => {
	// The collector matched an item by ONE route's name, and a tree row reads
	// "Berry Trees at Routes 110, 111, 112, …" — so no headless run had ever
	// held a Sitrus Berry. And the advisor prices a Give row by damage, so a
	// berry never earned one: the legal boxes that met Norman, whose six all
	// hold items, fielded two to six bodies holding nothing.
	const doc = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..',
		'fixtures', 'banked-runs', 'headless-norman-cufant.run.json'), 'utf8'));
	assert.ok(!doc.bag['Sitrus Berry'], 'the banked run never picked one');
	const tally = {};
	const picked = headless.pickBerries(doc, tally);
	assert.equal(picked.bag['Sitrus Berry'], 6, 'a party\'s worth, from trees dated 235');
	assert.ok(tally.berries >= 3);
	assert.equal(headless.pickBerries(picked, {}).bag['Sitrus Berry'], 6, 'and only once');
	assert.ok(!picked.bag['Lum Berry'], 'a tree dated after this position (392) is left alone');

	const bare = Object.assign({}, picked, {box: picked.box.map(mon =>
		picked.party.includes(mon.id) ? Object.assign({}, mon, {item: null}) : mon)});
	const fills = {};
	const filled = headless.fillEmptySlots(bare, fills);
	const held = filled.party.map(id => filled.box.find(mon => mon.id === id).item);
	assert.ok(held.every(Boolean), 'every member of the six holds something: ' + held.join(', '));
	assert.ok(held.includes('Sitrus Berry'));
	assert.equal(fills.slotsFilled, filled.party.length);
});

test('a run told where to stop, stops there', () => {
	// A baseline that asks "does a run pass this wall" should not play on for
	// hours past it: sweep-16 runs took one to four hours each.
	const policy = require('../scripts/ui-playthrough.js');
	const row = headless.playRun(policy, {species: 'Chimchar', rival: 'Blaziken'}, 104770,
		headless.armFlags('--budget=40 --stop-at=5'));
	assert.match(String(row.stopped), /reached --stop-at=5/);
	assert.ok(row.position >= 5 && row.position < 20, 'it stopped just past order 5: ' + row.position);
});

test('an arm that asks for search gets it', () => {
	// Six baseline runs played all sixty of their Brawly attempts with
	// decide(): --search-after lived only on argv, which an in-process arm
	// never sets, and nothing in the row said so.
	const policy = require('../scripts/ui-playthrough.js');
	// Turtwig, seed 4 loses its ninth fight, which is what makes the retry visible.
	const row = headless.playRun(policy, {species: 'Turtwig', rival: 'Blaziken'}, 4,
		headless.armFlags('--budget=14 --retries=6 --search-after=1 --search-rollouts=1'));
	assert.equal(row.knobs.searchAfter, 1);
	assert.equal(row.knobs.searchRollouts, 1);
	const lostAt = row.ledger.findIndex(fight => fight.result === 'loss');
	assert.ok(lostAt >= 0, 'the fixture seed loses a fight');
	assert.equal(row.ledger[lostAt].policy, 'decide', 'the first attempt is played by hand');
	const hands = [row.ledger[lostAt + 1].policy];
	assert.equal(hands[0], 'search-1',
		'a fight retried after a loss is searched: ' + [...hands].join(', '));
});

test('a filler berry trades up when a better one reaches the bag', () => {
	// The first baseline under the fill rule met Norman with six Sitrus
	// Berries in the bag and nobody holding one: every slot had been filled
	// with a Chesto or a Pecha before the Sitrus trees opened, and a filled
	// slot was never looked at again. (Oran stands in for the filler here.)
	const runtime = require('../lib/run.js');
	const base = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..',
		'fixtures', 'banked-runs', 'headless-norman-cufant.run.json'), 'utf8'));
	let doc = Object.assign({}, base, {box: base.box.map(mon =>
		base.party.includes(mon.id) ? Object.assign({}, mon, {item: null}) : mon)});
	doc = runtime.apply(doc, {kind: 'acquire', item: 'Oran Berry', count: 6});
	const early = headless.fillEmptySlots(doc, {});
	const first = early.party.map(id => early.box.find(mon => mon.id === id).item);
	assert.ok(first.every(item => item === 'Oran Berry'), 'before the trees open, the filler: ' + first.join(', '));

	const later = headless.fillEmptySlots(headless.pickBerries(early, {}), {});
	const held = later.party.map(id => later.box.find(mon => mon.id === id).item);
	assert.ok(held.every(item => item === 'Sitrus Berry'), 'once Sitrus is in the bag everyone trades up: ' + held.join(', '));

	// A real item is a choice and is never taken away for a berry.
	const armed = Object.assign({}, later, {box: later.box.map(mon =>
		mon.id === later.party[0] ? Object.assign({}, mon, {item: 'Muscle Band'}) : mon)});
	const kept = headless.fillEmptySlots(armed, {});
	assert.equal(kept.box.find(mon => mon.id === kept.party[0]).item, 'Muscle Band');
});

test('a run carries on from a saved document instead of replaying the road to it', () => {
	// A run that passes Norman has spent an hour getting there. Finding the
	// NEXT wall should not cost that hour again.
	const policy = require('../scripts/ui-playthrough.js');
	const saved = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..',
		'fixtures', 'banked-runs', 'headless-norman-cufant.run.json'), 'utf8'));
	const handed = saved.log.length;
	const row = headless.playRun(policy, {species: 'Chimchar', rival: 'Blaziken'}, 7,
		headless.armFlags('--budget=2 --retries=1 --boss-retries=1'), {resume: saved, keepDoc: true});
	assert.equal(row.resumedAt, saved.position, 'the row says where it picked up');
	// ...and where the log it was HANDED ends, read before the run wrote a line:
	// the audit excuses refusals before that mark and no others.
	assert.equal(row.resumedLog, handed, 'the mark is the saved log\'s length, not the finished one\'s');
	assert.ok(row.position >= saved.position, 'and it never goes back: ' + row.position);
	assert.ok(row.fights <= 2);
	assert.equal(row.ledger[0].trainer, 'Leader Norman', 'the first fight is the one the document was facing');
	assert.ok(row.doc.log.length >= saved.log.length, 'the saved log is kept, so the whole run stays auditable');
	assert.equal(saved.position, 337, 'and the saved document is not mutated');
});

test('a boss is probed before its first attempt, and the probe changes nothing', () => {
	// Recorded, not acted on: whether a dozen quick fights predict a wall
	// that sixty searched attempts cannot move is a claim for the next
	// baseline to measure. So the probe must leave the run exactly as it was.
	const policy = require('../scripts/ui-playthrough.js');
	const saved = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..',
		'fixtures', 'banked-runs', 'clear1-731001-brawly.run.json'), 'utf8'));
	const play = spec => headless.playRun(policy, {species: 'Chimchar', rival: 'Blaziken'}, 731001,
		headless.armFlags(spec), {resume: saved});
	const probed = play('--budget=2 --retries=1 --boss-retries=2 --probe=4');
	assert.deepEqual(Object.keys(probed.ledger[0].probe).sort(), ['foeLeft', 'of', 'wins']);
	assert.equal(probed.ledger[0].probe.of, 4);
	// This box loses its first attempt at Brawly, so the second row is a
	// RETRY of the same boss — the only row that can show the probe repeating.
	// (The first fixture tried here won on attempt one, its second row was a
	// trainer nobody probes, and the assertion passed with the rule broken. The
	// second lost twice until the TM ledger was dated, 2026-09-21, and then won
	// first time with Dewford's Sludge Bomb. The assertion below is what tells.)
	assert.equal(probed.ledger[0].result, 'loss');
	assert.equal(probed.ledger[1].trainer, 'Leader Brawly');
	assert.equal(probed.ledger[1].probe, undefined, 'only the first attempt at a wall is probed');

	const plain = play('--budget=2 --retries=1 --boss-retries=2 --probe=0');
	assert.equal(plain.ledger[0].probe, undefined);
	const playOf = row => row.ledger.map(fight => [fight.trainer, fight.seed, fight.result, fight.turns, fight.foeLeft]);
	assert.deepEqual(playOf(probed), playOf(plain), 'the probe spends none of the run\'s dice');
});

test('the IV spender leaves a reserve, and never buys a stat the body does not use', () => {
	// Seed 104770 reached Aqua Admin Shelly with Accelerock, Sucker Punch and
	// Quick Attack each one Heart Scale away and none in the bag: every scale
	// had gone to IVs, and her Focus Sash + Reversal Mienshao took exactly one
	// body in each of twenty fights.
	const runtime = require('../lib/run.js');
	let doc = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..',
		'fixtures', 'banked-runs', 'headless-norman-cufant.run.json'), 'utf8'));
	doc = runtime.apply(doc, {kind: 'acquire', item: 'Heart Scale', count: 7});
	// Make the trap explicit: a body with no special move holds the WORST iv
	// in the six, and it is Sp. Atk. The old spender bought exactly that.
	const meta = require('../ai');
	const physical = doc.party.map(id => doc.box.find(mon => mon.id === id)).find(mon =>
		!mon.moves.some(move => (meta.getMoveMetadata(move, 8) || {}).category === 'Special'));
	assert.ok(physical, 'the fixture fields a body with no special move');
	doc = Object.assign({}, doc, {box: doc.box.map(mon => {
		if (!doc.party.includes(mon.id)) return mon;
		const ivs = Object.assign({}, mon.ivs);
		for (const stat of Object.keys(ivs)) if (ivs[stat] < 1) ivs[stat] = 1;
		if (mon.id === physical.id) ivs.spa = 0;
		return Object.assign({}, mon, {ivs});
	})});
	const before = doc.bag['Heart Scale'];
	const tally = {};
	const spent = headless.spendScales(doc, tally);
	assert.equal(spent.bag['Heart Scale'], 2, 'two stay in the bag for a move that has to be remembered');
	assert.equal(tally.scaleSpends, before - 2);

	const ai = require('../ai');
	for (const id of spent.party) {
		const now = spent.box.find(mon => mon.id === id);
		const was = doc.box.find(mon => mon.id === id);
		const kinds = new Set(now.moves.map(move => (ai.getMoveMetadata(move, 8) || {}).category));
		if (!kinds.has('Special')) assert.equal(now.ivs.spa, was.ivs.spa, now.species + ' has no special move: Sp. Atk is not bought');
		if (!kinds.has('Physical')) assert.equal(now.ivs.atk, was.ivs.atk, now.species + ' has no physical move: Attack is not bought');
	}
});

test('a Heart Scale goes where the body will use it: an IV or a nature, by points a scale', () => {
	// The nurse sells one IV for one scale and a nature for three. The spender
	// knew only the first, bought the WORST iv in the six, and had never
	// changed a nature — a Rash Kingdra with a Sp. Def IV of 6 took 77% from
	// a Tri Attack at Norman.
	const physical = {species: 'Staraptor', level: 42, nature: 'Modest',
		moves: ['Close Combat', 'Brave Bird', 'Quick Attack', 'U-turn'],
		ivs: {hp: 31, atk: 31, def: 31, spa: 0, spd: 31, spe: 31}};
	const options = headless.scaleOptions(physical);
	assert.ok(!options.some(entry => entry.kind === 'iv' && entry.stat === 'spa'),
		'a Sp. Atk IV is worth nothing to a body with no special move');
	const top = options[0];
	assert.equal(top.kind, 'nature', 'a Modest physical attacker is fixed by its nature first');
	assert.ok(['Adamant', 'Jolly'].includes(top.nature), top.nature);
	assert.ok(options.every(entry => entry.kind !== 'nature' ||
		['Adamant', 'Jolly', 'Impish', 'Careful'].includes(entry.nature)),
	'only natures that lower the stat it does not use are offered');

	// The same body with the right nature and one bad Speed IV: the IV wins.
	const tuned = Object.assign({}, physical, {nature: 'Adamant',
		ivs: Object.assign({}, physical.ivs, {spe: 2})});
	assert.deepEqual([headless.scaleOptions(tuned)[0].kind, headless.scaleOptions(tuned)[0].stat], ['iv', 'spe']);

	// A nature is three scales, so with one free scale it cannot be bought.
	const runtime = require('../lib/run.js');
	let doc = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..',
		'fixtures', 'banked-runs', 'headless-norman-cufant.run.json'), 'utf8'));
	// Make a nature the BEST buy in the six, so only its price can stop it:
	// the lead is a physical attacker made Modest, with nothing else to fix.
	const lead = doc.party[0];
	doc = Object.assign({}, doc, {box: doc.box.map(mon => !doc.party.includes(mon.id) ? mon :
		Object.assign({}, mon, {ivs: {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31},
			nature: mon.id === lead ? 'Modest' : 'Hardy',
			moves: mon.id === lead ? ['Close Combat', 'Brave Bird', 'Quick Attack', 'U-turn'] : mon.moves}))});
	assert.equal(headless.scaleOptions(doc.box.find(mon => mon.id === lead))[0].kind, 'nature');
	doc = runtime.apply(doc, {kind: 'acquire', item: 'Heart Scale', count: 3});
	const tally = {};
	const spent = headless.spendScales(doc, tally);
	assert.equal(tally.natureChanges || 0, 0, 'one free scale never buys a third of a nature');
	assert.ok(spent.bag['Heart Scale'] >= 2, 'and the reserve stands: ' + spent.bag['Heart Scale']);

	const rich = headless.spendScales(runtime.apply(doc, {kind: 'acquire', item: 'Heart Scale', count: 2}), {});
	assert.notEqual(rich.box.find(mon => mon.id === lead).nature, 'Modest', 'with three free, the nature is fixed');
	assert.equal(rich.bag['Heart Scale'], 2);
});

test('what a leader or an NPC hands over is taken, and a re-sold TM is one copy until Lilycove', () => {
	// The collector matched an item by a route's name at the HEAD of its place,
	// so 23 dated rows reading "Given by …" were never taken: every gym
	// leader's TM, HM06 Rock Smash, and TM46 Rock Tomb — speed control dated at
	// order 148, teachable 35 times across saved boxes and owned never.
	const runtime = require('../lib/run.js');
	const doc = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..',
		'fixtures', 'banked-runs', 'headless-norman-cufant.run.json'), 'utf8'));
	assert.ok(!doc.bag['TM46 Rock Tomb'] && !doc.bag['TM10 Thunderbolt'], 'the banked run holds neither');
	const tally = {};
	const picked = headless.pickBerries(doc, tally);
	assert.equal(picked.bag['TM46 Rock Tomb'], 1, 'one copy, handed over in Rusturf Tunnel at 148');
	assert.equal(picked.bag['TM10 Thunderbolt'], 1, 'Wattson\'s, at 229');
	assert.ok(!picked.bag['TM35 Facade'], 'Norman\'s is dated 342 and this run is at ' + doc.position);
	assert.ok(tally.handedOver >= 3);
	assert.equal(headless.pickBerries(picked, {}).bag['TM46 Rock Tomb'], 1, 'and only once');

	// Rock Tomb is re-sold at Lilycove (order 871). Before that the copy in
	// the bag is the only one: it was being taught without limit from 148.
	const tm = require('../profiles').getProfile(doc.profileId).oracle.tmFor('Rock Tomb');
	assert.deepEqual([tm.repeatable, tm.unlimitedFrom], [true, 871]);
	const learner = picked.box.find(mon => runtime.learnable(picked, mon.id).now.some(entry => entry.move === 'Rock Tomb'));
	assert.ok(learner, 'somebody in the box can learn it');
	const taught = runtime.apply(picked, {kind: 'teach', id: learner.id, move: 'Rock Tomb',
		replace: learner.moves.length >= 4 ? learner.moves[0] : undefined});
	assert.ok(!taught.bag['TM46 Rock Tomb'], 'before Lilycove the teach SPENDS the one copy');
});

test('once the six is picked, its one Mega is handed its stone — over whatever it held', () => {
	// The ranker rates a body whose stone is in the bag as the Mega it would
	// become; this is the other half. A run reached the Elite Four with
	// thirteen such bodies in its box and every stone still in the bag.
	const runtime = require('../lib/run.js');
	const stones = require('../calc').MEGA_STONES;
	const base = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..',
		'fixtures', 'banked-runs', 'headless-norman-cufant.run.json'), 'utf8'));
	const pairs = Object.keys(stones).map(stone => [stone, base.box.find(mon => mon.species === stones[stone])])
		.filter(pair => pair[1]).slice(0, 2);
	assert.equal(pairs.length, 2, 'the fixture box holds two Mega-capable bodies');
	const ids = pairs.map(pair => pair[1].id);
	let doc = Object.assign({}, base, {party: ids.concat(base.party.filter(id => !ids.includes(id))).slice(0, 6)});
	for (const pair of pairs) doc = runtime.apply(doc, {kind: 'acquire', item: pair[0]});

	assert.equal(headless.giveMegaStone(doc, {}).box.find(mon => mon.id === ids[0]).item, pairs[0][1].item,
		'before Flannery there is no ring, and nothing is handed over');

	const ringed = Object.assign({}, doc, {position: 600});
	const tally = {};
	const given = headless.giveMegaStone(ringed, tally);
	assert.equal(given.box.find(mon => mon.id === ids[0]).item, pairs[0][0], 'the first of the six whose stone is in the bag');
	assert.notEqual(given.box.find(mon => mon.id === ids[1]).item, pairs[1][0], 'and nobody is given a second');
	assert.equal(tally.megaStones, 1);
	assert.ok(!given.bag[pairs[0][0]], 'the stone left the bag');
	assert.equal(runtime.partySpecs(given, {})[0].species, pairs[0][1].species + '-Mega');
	assert.equal(headless.giveMegaStone(given, {}).bag[pairs[1][0]], 1, 'a six that has its Mega is left alone');
});

test('when the six changes under a searched fight, the probe is asked again', () => {
	// clear1's seed 731001 lost Brawly 40 times: two by decide(), then 38 by
	// search, with a six (re-picked on attempt 3) that decide() then won 12 of
	// 30 with — and the run never went back. --hand-by-probe re-probes when the
	// six changes and plays decide() with a six the probe wins with.
	//
	// The rescue itself no longer reproduces on this fixture: since the foe's
	// post-KO replacement became the documented rule (2026-09-22) Brawly is
	// harder, and the re-picked six now probes 0 of 12 where it probed 6. So
	// this gates the MECHANISM — a fresh probe when the six changes — and not
	// that one outcome. The switch is off by default and measured no better
	// than the control on three held-out walls; it is kept, not relied on.
	const policy = require('../scripts/ui-playthrough.js');
	const saved = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..',
		'fixtures', 'banked-runs', 'clear1-731001-brawly.run.json'), 'utf8'));
	const play = hand => headless.playRun(policy, {species: 'Chimchar', rival: 'Blaziken'}, 731001,
		headless.armFlags('--stop-at=77 --budget=3 --boss-retries=40 --search-after=1 --search-rollouts=1 ' +
			'--repick-after=1 --probe=12 --plan-after=0 --hand-by-probe=' + hand), {resume: saved});
	const brawly = row => row.ledger.filter(entry => entry.trainer === 'Leader Brawly');
	const on = brawly(play(1));
	assert.ok(on.length >= 3 && on[0].result === 'loss', 'the fixture loses and retries: ' + on.map(row => row.result));
	assert.ok(on[0].probe && on[0].probe.of === 12, 'the first attempt at a wall is probed');
	assert.ok(on[1].probe, 'and the six changed under it, so the probe is asked again');
	assert.equal(brawly(play(0)).filter((row, at) => at > 0 && row.probe).length, 0,
		'off, only the first attempt is ever probed');
});

test('a run stopped and carried on from its checkpoint plays what the uninterrupted run plays', () => {
	// A resume from a DOCUMENT restarts the dice, the fight seed, the attempts
	// at the wall and what was caught where. A checkpoint carries them, so
	// stopping a run costs nothing and changes nothing.
	const policy = require('../scripts/ui-playthrough.js');
	const flags = () => headless.armFlags('--budget=33 --retries=3 --boss-retries=3 --probe=0 --fight-logs=none');
	const starter = {species: 'Chimchar', rival: 'Swampert'};
	const line = row => [row.n, row.trainer, row.seed, row.position, row.result, row.turns, row.deaths].join(' ');
	// Seed 11 loses fights 18, 19 and 20 to one wall and is still rolling catches
	// at fight 39. One checkpoint is taken BEFORE the streak, with dice still to
	// roll, so the dice's position is part of what it must carry; one INSIDE
	// it, so the attempts already spent are. Each was found the hard way: a
	// checkpoint the dice had stopped moving after let their position be
	// dropped unnoticed, and one whose wall fell next try did the same for the
	// attempts. (The fights moved when the TM ledger was dated, 2026-09-21:
	// runs pick up more and lose elsewhere. The assertions below say so.)
	const taken = {};
	let lastDice = null;
	const whole = headless.playRun(policy, starter, 11, flags(), {keepDoc: true,
		checkpoint: snapshot => {
			const now = snapshot();
			lastDice = now.state.dice;
			// Through JSON, as a file would carry it.
			for (const at of [16, 19]) if (!taken[at] && now.state.tally.fights === at) taken[at] = JSON.parse(JSON.stringify(now));
		}});
	assert.ok(taken[16] && taken[19], 'the run reached both checkpoints');
	assert.equal(taken[16].state.attempts, 0);
	assert.ok(taken[19].state.attempts > 1, 'the second is mid-wall, with attempts already spent');
	assert.notEqual(taken[16].state.dice, lastDice, 'and the dice are still rolled after the first');

	for (const at of [16, 19]) {
		const carried = headless.playRun(policy, starter, 11, flags(), {keepDoc: true, restore: taken[at]});
		assert.deepEqual(carried.ledger.map(line), whole.ledger.map(line), at + ': the same fights, seeds and results, from the first to the last');
		assert.deepEqual(carried.doc.log.map(entry => entry.command), whole.doc.log.map(entry => entry.command),
			at + ': and the same commands — every catch, teach and level-up');
		assert.deepEqual(carried.restoredAt, [taken[at].position], 'the row says it was carried on, and from where');
	}

	// Asked to stop, it stops at once, checkpointed, and says so.
	let last = null;
	const stopped = headless.playRun(policy, starter, 11, flags(), {
		control: () => (last && last.state.tally.fights >= 5 ? 'stop' : null),
		checkpoint: snapshot => { last = snapshot(); }});
	assert.equal(stopped.stopped, 'stopped by request');
	assert.equal(stopped.fights, 5);
	assert.deepEqual(stopped.ledger.map(line), whole.ledger.slice(0, 5).map(line));
});

test('a wall lost often enough is planned by play, and the plan holds until the wall falls', () => {
	// Seed 842113 lost Norman 40 times with a six the ranker liked, holding in
	// its box a plan that wins a third of the time. --plan-after looks for one:
	// leads, closers and who makes room, proposed by the board and chosen by
	// play. Here on the Brawly box, small, to gate the wiring rather than the
	// strength (which is measured, not asserted: docs/LEADER-KEYS.md).
	const policy = require('../scripts/ui-playthrough.js');
	const saved = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..',
		'fixtures', 'banked-runs', 'clear1-731001-brawly.run.json'), 'utf8'));
	const holds = [];
	const sixes = [];
	const row = headless.playRun(policy, {species: 'Chimchar', rival: 'Blaziken'}, 731001,
		headless.armFlags('--stop-at=77 --budget=5 --boss-retries=40 --probe=0 --repick-after=0 ' +
			'--plan-after=1 --plan-seeds=3 --fight-logs=none'), {resume: saved,
			checkpoint: snapshot => {
				const now = snapshot();
				holds[now.state.tally.fights] = now.state.planHolds;
				sixes[now.state.tally.fights] = now.doc.party.map(id => now.doc.box.find(mon => mon.id === id).species).join(' > ');
				// Something changes between attempts (a catch, an item picked up): that is
				// what re-runs the run's preparation, ranker included. Here, a Potion.
				if (now.state.planHolds) now.doc.bag.Potion = (now.doc.bag.Potion || 0) + 1;
			}});
	assert.equal(row.ledger[0].trainer, 'Leader Brawly');
	assert.equal(row.ledger[0].result, 'loss', 'the fixture loses its first attempt, so there is a wall to plan');
	assert.equal(row.plans.length, 1, 'planned once, when the first loss came');
	const plan = row.plans[0];
	assert.equal(plan.trainer, 'Leader Brawly');
	assert.ok(plan.of >= 2 && plan.took.split(' > ').length === 6, 'plans were tried, and a six came back: ' + JSON.stringify(plan));
	assert.ok(plan.wins > plan.stood.wins || (plan.wins === plan.stood.wins && plan.left <= plan.stood.left),
		'a plan is only ever taken when play says it is no worse: ' + JSON.stringify(plan));
	// The six that fights next IS the plan, and stays it while the wall stands:
	// a catch between attempts used to re-run the ranker and put its six back.
	for (let fight = 2; fight < sixes.length && holds[fight]; fight++) {
		assert.equal(sixes[fight], plan.took, 'attempt ' + (fight + 1) + ' fights with the plan');
	}
	// The plan's fights are SCOUTING, not attempts: played in the run's head on
	// dice no attempt gets, counted apart, and never in `fights`.
	assert.equal(row.scouted.plan, plan.of * 3, 'every plan tried, on each of its three seeds');
	assert.equal(row.fights, row.ledger.length, 'and an attempt is a ledger row, nothing else');
	assert.equal(holds[1], false, 'nothing holds before the plan');
	assert.equal(holds[2], true, 'and once taken it holds — the ranker and the re-pick would only undo it — and is carried in a checkpoint');
});

test('the planner sees a Mega: a stone holder, or a body whose stone is in the bag, is proposed in its Mega form', () => {
	// The board names such a body 'Camerupt-Mega'; the planner looked that name
	// up in the box, found nothing, and never proposed a Mega — on runs holding
	// nine stones and dying at Aqua Admin Matt, whom a Mega answers.
	const policy = require('../scripts/ui-playthrough.js');
	const saved = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..',
		'fixtures', 'banked-runs', 'clear1b-731001-matt.run.json'), 'utf8'));
	const runtime = require('../lib/run.js');
	const camerupt = saved.box.find(mon => mon.species === 'Camerupt');
	assert.ok(runtime.stoneInBag(saved, 'Camerupt') && !saved.party.includes(camerupt.id), 'the fixture: Camerupt boxed, Cameruptite in the bag');
	const row = headless.playRun(policy, {species: 'Chimchar', rival: 'Blaziken'}, 731001,
		headless.armFlags('--budget=2 --boss-retries=40 --probe=0 --repick-after=0 --search-after=0 --plan-after=1 --plan-seeds=1 --fight-logs=none'),
		{resume: saved, keepDoc: true});
	const plan = row.plans && row.plans[0];
	assert.ok(plan, 'a plan was made: ' + JSON.stringify(row.ledger.map(entry => entry.result)));
	assert.ok(plan.proposed.some(name => /-Mega$/.test(name)), 'a Mega form is among what the board proposed: ' + plan.proposed.join(', '));
});

test('the story gifts are claimed when the road reaches them — the egg, Castform, and Kubfu', () => {
	// A gift is a scripted event, not an encounter roll, so a run that only
	// rolled wild routes never owned one: across every record on disk, zero
	// Kubfu, zero Castform, zero starter egg. Kubfu arrives 24 fights before
	// Leader Tate and evolves into an Urshifu.
	const runtime = require('../lib/run.js');
	const saved = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..',
		'fixtures', 'banked-runs', 'clear1b-731001-matt.run.json'), 'utf8'));
	const dice = headless.dice(9);
	const early = headless.claimGifts(Object.assign(structuredClone(saved), {position: 600}), dice, {});
	assert.deepEqual(early.box.filter(mon => /Castform|Kubfu/.test(mon.species)), [], 'at 600 only the egg is open');
	assert.ok(early.box.some(mon => /Treecko|Torchic|Mudkip/.test(mon.species)), 'and the egg is one of the three Hoenn starters');

	const tally = {};
	const late = headless.claimGifts(Object.assign(structuredClone(saved), {position: 1200}), headless.dice(9), tally);
	assert.deepEqual(tally.gifted.map(gift => gift.where),
		['Lavaridge Town', 'Weather Institute (Route 119)', 'Mossdeep City']);
	const kubfu = late.box.find(mon => mon.species === 'Kubfu');
	assert.ok(kubfu && kubfu.level === 1, 'it arrives at level 1: levelling to the cap is free, so 1 cannot overstate the gift');
	assert.equal(late.log[late.log.length - 1].command.gift, 'Mossdeep City@1125', 'the log marks it a gift, so it is taken once');
	// Claimed twice is claimed once.
	const again = headless.claimGifts(late, headless.dice(9), {});
	assert.equal(again.box.filter(mon => mon.species === 'Kubfu').length, 1);
	// And levelled to the cap it becomes an Urshifu.
	const grown = runtime.apply(late, {kind: 'levelUp', id: kubfu.id, to: 'cap'});
	assert.equal(require('../lib/dossier').evolveMon(runtime.findMon(grown, kubfu.id), runtime.levelCap(grown).cap), 'Urshifu');

	// And the switch is real, through the run that reads it: this document
	// stands at 1055, past the egg (571) and Castform (701).
	const policy = require('../scripts/ui-playthrough.js');
	const play = flags => headless.playRun(policy, {species: 'Chimchar', rival: 'Blaziken'}, 731001,
		headless.armFlags('--budget=1 --boss-retries=1 --probe=0 --search-after=0 --plan-after=0 --repick-after=0 --fight-logs=none ' + flags),
		{resume: saved, keepDoc: true});
	const on = play('');
	assert.ok(on.gifted.length >= 2 && on.doc.log.some(entry => entry.command.gift), 'by default a run takes them: ' + JSON.stringify(on.gifted));
	const off = play('--gifts=0');
	assert.deepEqual(off.gifted, [], '--gifts=0 plays without them');
	assert.ok(!off.doc.log.some(entry => entry.command.gift));
});

test('the run\'s one Mega is reconsidered for the fight in front, and the stone is moved to it', () => {
	// Two rules were wrong: the stone went to the first member in PARTY ORDER,
	// and the step was skipped once any member held one — so a run's first
	// assignment stuck for the rest of it. Seed 418957 met Elite Four Sidney
	// fielding Mega Houndoom with a Lopunnite in the bag.
	const runtime = require('../lib/run.js');
	const saved = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..',
		'fixtures', 'banked-runs', 'clear1-418957-sidney.run.json'), 'utf8'));
	const next = {trainer: 'Elite Four Sidney', order: 1580};
	const houndoom = saved.box.find(mon => mon.species === 'Houndoom');
	const lopunny = saved.box.find(mon => mon.species === 'Lopunny');
	assert.ok(saved.party.includes(houndoom.id) && saved.party.includes(lopunny.id), 'both are in the six');
	assert.equal(houndoom.item, 'Houndoominite');

	// Put the stone on the WRONG body: Lopunny holds Lopunnite, Houndoominite
	// goes back to the bag. The board prefers Houndoom-Mega here (4.5 to 3.5).
	let wrong = runtime.apply(saved, {kind: 'give', id: houndoom.id, item: 'Oran Berry'});
	wrong = runtime.apply(wrong, {kind: 'give', id: lopunny.id, item: 'Lopunnite'});
	assert.equal(runtime.findMon(wrong, lopunny.id).item, 'Lopunnite');
	assert.ok((wrong.bag.Houndoominite || 0) > 0, 'the stone went back to the bag, it was not destroyed');

	const tally = {};
	const fixed = headless.giveMegaStone(wrong, tally, next);
	assert.equal(runtime.findMon(fixed, houndoom.id).item, 'Houndoominite', 'the stone moved to the body the board rates highest');
	assert.ok(!runtime.megaFormOf('Lopunny', runtime.findMon(fixed, lopunny.id).item), 'and off the one it rates lower');
	assert.equal(tally.megaMoved, 1);
	assert.ok((fixed.bag.Lopunnite || 0) > 0, 'the displaced stone is back in the bag');

	// Asked again it changes nothing: the right body already holds it.
	const settled = {};
	const again = headless.giveMegaStone(fixed, settled, next);
	assert.equal(settled.megaMoved, undefined);
	assert.equal(runtime.findMon(again, houndoom.id).item, 'Houndoominite');

	// It is the BOARD deciding, not party order: at Elite Four Glacia the same
	// six prefers Lopunny-Mega (4) to Houndoom-Mega (1.5), and Lopunny stands
	// LATER in the party, so party order could never reach it. Houndoom holds
	// the stone here, exactly as the run arrived.
	const glacia = {};
	const iced = headless.giveMegaStone(saved, glacia, {trainer: 'Elite Four Glacia', order: 1600});
	assert.equal(runtime.findMon(iced, lopunny.id).item, 'Lopunnite', 'the stone crossed the party to the body the board rates highest');
	assert.equal(runtime.findMon(iced, houndoom.id).item, 'Oran Berry', 'and the old holder took the filler that freed its stone');
	assert.equal(glacia.megaMoved, 1);

	// And the switch that restores the old rule is real.
	assert.equal(headless.armFlags('--mega-by-board=0').knobs.megaByBoard, 0);
});

test('the six is scored for the ONE Mega it can field, and the stone follows that choice', () => {
	// The board rates every Mega-capable body as the Mega it would become —
	// right for "should this body be in the six", wrong for scoring the six.
	// Seed 418957's box holds ELEVEN such bodies, so a six of them was priced
	// as a team of Megas and played as one Mega and five base forms.
	const runtime = require('../lib/run.js');
	const saved = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..',
		'fixtures', 'banked-runs', 'clear1-418957-sidney.run.json'), 'utf8'));
	const each = runtime.boxMatrix(saved, 'Elite Four Sidney');
	assert.ok(each.box.filter(row => row.mega).length >= 5, 'the board rates many bodies as Megas at once');
	assert.equal(runtime.boxMatrix(saved, 'Elite Four Sidney', {megas: 'none'}).box.filter(row => row.mega).length, 0,
		'and can be asked for the same box in base form');

	const ranked = runtime.rankParties(saved, 'Elite Four Sidney');
	const top = ranked.parties[0];
	const capable = top.members.filter(member => each.box.find(row => row.id === member.id && row.mega));
	assert.ok(capable.length >= 2, 'the top six holds more than one Mega-capable body: ' + capable.map(m => m.species).join(', '));
	assert.ok(top.mega && top.mega.id, 'and it names the ONE it fields: ' + JSON.stringify(top.mega));
	assert.ok(top.members.some(member => member.id === top.mega.id), 'which is a member of that six');
	assert.match(top.mega.species, /-Mega/);

	// The set score is the authority, not a body rated alone: here they differ.
	// Standalone the board rates Houndoom-Mega (4.5) over Lopunny-Mega (3.5).
	assert.equal(top.mega.species, 'Lopunny-Mega', 'the six lacks what Lopunny covers, which rating it alone cannot see');

	// And the stone follows that choice, off whoever holds it.
	const houndoom = saved.box.find(mon => mon.species === 'Houndoom');
	assert.equal(houndoom.item, 'Houndoominite', 'the run arrived with the stone on the other body');
	const tally = {};
	const fixed = headless.giveMegaStone(saved, tally, {trainer: 'Elite Four Sidney'}, top.mega.id);
	assert.equal(runtime.findMon(fixed, top.mega.id).item, 'Lopunnite', 'the ranker asked for Lopunny and Lopunny holds it');
	assert.ok(!runtime.megaFormOf('Houndoom', runtime.findMon(fixed, houndoom.id).item));
	assert.equal(tally.megaMoved, 1);
});

test('a walled Elite Four format hands the run the member\'s other format, not a stop', () => {
	// Seed 418957 went 0 of 40 at Sidney's single twice and stopped both times
	// ("a required fight"), with his double — a different team — never tried.
	const runtime = require('../lib/run.js');
	const saved = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..',
		'fixtures', 'banked-runs', 'clear1-418957-sidney.run.json'), 'utf8'));
	const road = runtime.upcoming(saved, 50);
	const single = road.find(fight => fight.trainer === 'Elite Four Sidney');
	const double = road.find(fight => fight.trainer === 'Elite Four SidneyDouble');
	assert.equal(runtime.eliteFourCounterpart('Elite Four Sidney'), 'Elite Four SidneyDouble');
	assert.equal(runtime.eliteFourCounterpart('Elite Four SidneyDouble'), 'Elite Four Sidney');
	assert.equal(runtime.eliteFourCounterpart('Champion Wallace'), null, 'only the Four have a second door');

	const aside = new Set();
	assert.equal(headless.otherDoor(saved, single, aside).trainer, 'Elite Four SidneyDouble');
	assert.equal(headless.otherDoor(saved, double, aside).trainer, 'Elite Four Sidney', 'either way round');
	// Set aside, the walled format is passed over and the other is next.
	aside.add(single.order);
	assert.equal(headless.nextFight(saved, new Map(), aside).trainer, 'Elite Four SidneyDouble');
	// Both walled is a wall: there is no third door.
	assert.equal(headless.otherDoor(saved, double, aside), null);
	// A format whose quota is spent is not a door: two singles taken leave Glacia only her double.
	const spent = runtime.applyAll(saved, [{kind: 'beat', trainer: 'Elite Four Sidney'},
		{kind: 'beat', trainer: 'Elite Four Phoebe'}]);
	const glacia = runtime.upcoming(spent, 50).find(fight => fight.trainer === 'Elite Four GlaciaDouble');
	assert.equal(headless.otherDoor(spent, glacia, new Set()), null);
});
