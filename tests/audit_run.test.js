/* eslint-env node, es6 */
'use strict';

/**
 * Gate for scripts/audit-run.js: a clean run passes, and each way a result
 * can be invalid is caught by the check that names it. Each tamper below is
 * a real failure found by hand on 2026-09-19 or a rule the run relies on.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const auditRun = require('../scripts/audit-run.js').auditRun;

const policy = () => require('../scripts/ui-playthrough.js');

const DOC = path.join(__dirname, '..', 'fixtures', 'banked-runs', 'br-21.run.json');

// The banked documents were recorded before the run charged for a TM or for
// the nurse's "Remember a move": the gate grants each TM the log spends and a
// Heart Scale per teach, so "a clean run" still means a run the rules accept.
function withTms(doc) {
	const oracle = require('../profiles').getProfile(doc.profileId).oracle;
	const bought = [];
	for (const entry of doc.log) {
		if ((entry.command || {}).kind !== 'teach') continue;
		const tm = oracle.tmFor(entry.command.move);
		if (tm) bought.push({at: 't0', command: {kind: 'acquire', item: tm.name, where: tm.name + ', granted for the gate'}});
		bought.push({at: 't0', command: {kind: 'acquire', item: 'Heart Scale', where: 'granted for the gate'}});
	}
	return Object.assign({}, doc, {log: bought.concat(doc.log)});
}

function cleanRow() {
	return {doc: withTms(JSON.parse(fs.readFileSync(DOC, 'utf8'))),
		ledger: [{n: 1, trainer: 'Youngster Calvin', seed: 2, result: 'win', refusals: 0}],
		provenance: {revision: '0123456789abcdef', dirty: false, flags: ['--pp-model=1']}};
}

const statusOf = (result, name) => result.checks.find(entry => entry.name === name).status;

test('a clean run passes every check but the unfinished road', () => {
	const result = auditRun(cleanRow());
	assert.equal(result.ok, true, JSON.stringify(result.checks.filter(entry => entry.status === 'FAIL')));
	assert.equal(result.beatTheGame, false, 'an unfinished road never beats the game');
	for (const name of ['provenance', 'replay', 'one catch per area', 'removed species', 'prizes', 'level-ups',
		'moves', 'wins']) {
		assert.equal(statusOf(result, name), 'PASS', name);
	}
});

test('each invalid result is caught by the check that names it', () => {
	const tampered = (edit, name) => {
		const row = cleanRow();
		edit(row);
		const result = auditRun(row);
		assert.equal(statusOf(result, name), 'FAIL', name + ': ' + JSON.stringify(result.checks));
		assert.equal(result.ok, false);
	};
	// A second catch on a route already caught on.
	tampered(row => {
		const first = row.doc.log.find(entry => entry.command.kind === 'catch' && entry.command.map);
		row.doc.log.push({at: 't', command: Object.assign({}, first.command, {species: 'Zigzagoon'})});
	}, 'one catch per area');
	// A species the hack removed (the official Unavailable Pokemon sheet).
	tampered(row => {
		row.doc.log.push({at: 't', command: {kind: 'catch', species: 'Smeargle', level: 30,
			map: 'AlteringCave', method: 'walk', ivs: {hp: 1, atk: 1, def: 1, spa: 1, spd: 1, spe: 1},
			nature: 'Hardy', ability: 'Own Tempo'}});
	}, 'removed species');
	// A win the driver bought with a refused engine transition.
	tampered(row => {
		row.ledger.push({n: 2, trainer: 'Cool Trainer Jennifer & Callie', seed: 7, result: 'win', refusals: 1});
	}, 'wins');
	// Played from a tree with uncommitted changes.
	tampered(row => { row.provenance.dirty = true; }, 'provenance');
	// A box edited outside the log.
	tampered(row => { row.doc.box[0].level += 1; }, 'replay');
});

test('an engine crash is a lost fight, not a lost run, and the audit names it', () => {
	// Sweep 14's deepest run died at fight #271 after beating 410 of them
	// (a stat stage the calculator could not index), and its document went
	// with it, so the state could not be replayed.
	const headless = require('../scripts/headless-run.js');
	const battery = require('../scripts/scenario-battery.js');
	const policy = require('../scripts/ui-playthrough.js');
	const real = battery.playScenario;
	const crashes = [];
	let calls = 0;
	battery.playScenario = function crashOnceThenPlay() {
		calls += 1;
		if (calls === 3) throw new Error('Cannot read properties of undefined (reading \'0\')');
		return real.apply(this, arguments);
	};
	let row;
	try {
		// The budget is a per-run knob (16ca259). This test used to push
		// --budget=6 onto argv, which the harness no longer reads after load —
		// so it silently played the default 110 fights and took eleven minutes
		// instead of two. --probe=0 because the third engine call would
		// otherwise be a probe fight, not the fight this test crashes.
		row = headless.playRun(policy, {species: 'Chimchar', rival: 'Blaziken'}, 41,
			headless.armFlags('--budget=6 --probe=0'),
			{keepDoc: true, onCrash: (crash, doc) => crashes.push([crash, doc])});
	} finally {
		battery.playScenario = real;
	}
	assert.equal(row.knobs.budget, 6, 'the run played the budget it was given');
	assert.equal(row.crashes, 1, 'the crash is counted');
	assert.equal(row.crashed.length, 1);
	assert.match(row.crashed[0].message, /Cannot read properties/);
	assert.ok(row.crashed[0].trainer && row.crashed[0].seed, 'the fight and its seed are named');
	assert.equal(crashes.length, 1, 'the document that met it is handed out');
	assert.ok(crashes[0][1].log.length > 0, 'and it is a real document');
	assert.ok(row.fights > 3, 'the run kept going: ' + row.fights);
	const audited = auditRun(row);
	const crashCheck = audited.checks.find(entry => entry.name === 'engine crashes');
	assert.equal(crashCheck.status, 'WARN');
	assert.match(crashCheck.detail, /Cannot read properties/);
});

test('a double gets a boss\'s attempts, not a dozen', () => {
	// Sweep 15's deepest run reached fight #290 of 358 and walked past four
	// doubles owing the debt: they are not bosses by name, so they got twelve
	// attempts each. The bridge rival fell on the ninth of sixty.
	const headless = require('../scripts/headless-run.js');
	assert.equal(headless.retryCap('Leader Norman', false), 20, 'a boss keeps its budget');
	assert.equal(headless.retryCap('Psychic Hannah & Sylvia', false), 12, 'an ordinary fight keeps its dozen');
	assert.equal(headless.retryCap('Psychic Hannah & Sylvia', true), 20, 'a double is given the boss budget');
	assert.equal(headless.retryCap('Trainer Rival Bridge Blaziken', true), 20);
});

test('a route is rolled on the method that can answer a fight ahead', () => {
	// A run walks by default, so an answer that lives in the water is one it
	// cannot have: sweep 16's deepest run met Archie's rain team with no
	// Water Absorb body among 59 caught, and lost 60 attempts.
	const headless = require('../scripts/headless-run.js');
	const battery = require('../scripts/scenario-battery.js');
	const doc = battery.loadDocument(path.join(__dirname, '..', 'fixtures', 'banked-runs', 'sv-14.run.json'));
	const wanted = headless.answersAhead(doc, 60);
	assert.ok(wanted.size > 10, 'the dossiers name answers for the road ahead: ' + wanted.size);
	// Nothing wanted, no preference: the roll keeps its own dice.
	assert.equal(headless.methodFor(doc, 'Route119', new Set()), undefined);
	// A species only the water holds pulls the roll into the water.
	const fished = headless.methodFor(doc, 'Route119', new Set(['Feebas', 'Frillish', 'Milotic']));
	assert.equal(fished, 'fish', 'Route 119 answers by rod');
	// A grass answer keeps the roll on land — Route 119's own grass, or the
	// assertion passes on a method the route does not even offer.
	const walked = headless.methodFor(doc, 'Route119', new Set(['Seismitoad', 'Gastrodon', 'Heracross']));
	assert.equal(walked, 'walk', 'a grass answer keeps the roll on land');
	// And the odds decide, not the slot count: one wanted body in the water
	// outweighs a dozen unwanted ones in the grass.
	assert.equal(headless.methodFor(doc, 'Route119', new Set(['Feebas'])), 'fish');
});

test('the ledger says what fell and to what, not only how many', () => {
	// The driver reports every death with the body, the move and the enemy
	// that used it; the row kept the count alone, so no run could say which
	// types die or what kills them.
	const headless = require('../scripts/headless-run.js');
	// A per-run knob since 16ca259; pushed onto argv it was silently ignored
	// and this gate played the default 110 fights.
	const row = headless.playRun(policy(), {species: 'Chimchar', rival: 'Blaziken'}, 41,
		headless.armFlags('--budget=10'), {keepDoc: true});
	assert.equal(row.knobs.budget, 10);
	assert.ok(row.ledger.length > 0);
	for (const entry of row.ledger) {
		assert.ok(Array.isArray(entry.killers), 'every fight carries a killers list');
		assert.equal(entry.killers.length, entry.deaths || 0, 'one killer row per death: ' + entry.trainer);
		for (const death of entry.killers) assert.ok(death.species, 'the body that fell is named');
	}
	const withDeaths = row.ledger.filter(entry => (entry.deaths || 0) > 0);
	if (withDeaths.length) {
		assert.ok(withDeaths[0].killers[0].by, 'the move that killed it is named');
	}
	assert.ok(row.ledger.some(entry => entry.foeOf > 0), 'and what was left of the trainer');
});

test('a TM the run cannot hold is reported', () => {
	// A TM is one-time in this fork (the author's FAQ and the release thread)
	// except the ten re-sold at Lilycove, and HMs are reusable. The harness
	// charges nothing for any of them, so banked runs taught Earthquake from
	// a TM that lies in Victory Road while still fighting in the Brawly era,
	// and one taught Rock Blast 42 times from a TM it never owned.
	const items = require('../profiles/run-and-bun/oracle/item-locations.json').entries;
	const moveOf = row => String(row.name).replace(/^(?:TM|HM)\d+\s+/, '');
	const oracle = require('../profiles').getProfile('run-and-bun').oracle;
	// A late TM and a body that can only get that move from it: a move the
	// body also learns by level-up at or below its level is not a teach the
	// rules charge for, so it is not this check's business.
	const box = cleanRow().doc.box;
	let pick = null;
	for (const row of items) {
		if (row.kind !== 'tm' || !(row.opensAt > 1000) || /^HM/.test(row.name)) continue;
		const move = String(row.name).replace(/^TM\d+\s+/, '');
		for (const mon of box) {
			const verdict = oracle.canLearn(mon.species, move);
			if (!verdict.legal) continue;
			const chargeable = verdict.sources.every(source =>
				source.source === 'teachable' || (source.level !== undefined && source.level > mon.level));
			if (chargeable) { pick = {tm: row, move, mon}; break; }
		}
		if (pick) break;
	}
	assert.ok(pick, 'some body needs a late TM for a move it cannot otherwise have');
	const late = pick.tm;
	const detailOf = moves => {
		const row = cleanRow();
		for (const move of moves) {
			row.doc.log.push({at: 't', command: {kind: 'teach', id: pick.mon.id, move, replace: pick.mon.moves[0]}});
		}
		return auditRun(row).checks.find(entry => entry.name === 'TMs');
	};
	const base = detailOf([]);
	const flagged = detailOf([pick.move]);
	assert.equal(flagged.status, 'WARN');
	// The detail names only the first few, so the count is what the gate reads.
	const countOf = detail => Number((/^(\d+) taught before/.exec(detail) || [])[1] || 0);
	assert.equal(countOf(flagged.detail), countOf(base.detail) + 1,
		'the unreachable TM is counted: ' + flagged.detail);
});

test('Heart Scales are spent, all but the reserve, on what the body uses', () => {
	// Runs once spent every scale on egg-move teaches and maxed no IV at all,
	// though 26 are reachable by Archie. This gate then asserted "the WORST
	// four IVs are the ones maxed", which is the rule that bought Sp. Atk on
	// physical attackers and drained the bag before a priority move had to be
	// remembered. What it holds now: the scales ARE spent, a reserve stays,
	// and every scale bought something the body uses.
	const headless = require('../scripts/headless-run.js');
	const run = require('../lib/run.js');
	const battery = require('../scripts/scenario-battery.js');
	const ai = require('../ai');
	let doc = battery.loadDocument(path.join(__dirname, '..', 'fixtures', 'banked-runs', 'br-21.run.json'));
	for (let n = 0; n < 6; n++) doc = run.apply(doc, {kind: 'acquire', item: 'Heart Scale', where: 'granted'});
	const tally = {};
	const after = headless.spendScales(doc, tally);
	assert.equal(after.bag['Heart Scale'], 2, 'the reserve stays in the bag');
	assert.equal(tally.scaleSpends, 4, 'and the rest is spent');
	for (const id of doc.party) {
		const was = doc.box.find(mon => mon.id === id);
		const now = after.box.find(mon => mon.id === id);
		const kinds = new Set(now.moves.map(move => (ai.getMoveMetadata(move, 8) || {}).category));
		if (!kinds.has('Special')) assert.equal(now.ivs.spa, was.ivs.spa, now.species + ': no special move, no Sp. Atk bought');
		if (!kinds.has('Physical')) assert.equal(now.ivs.atk, was.ivs.atk, now.species + ': no physical move, no Attack bought');
	}
});

test('the profiler reports where a run spends its time', () => {
	// Every guess about what to make faster costs hours to test twice, so the
	// instrument is committed and its numbers live in docs/PERFORMANCE.md.
	const profiler = require('../scripts/profile-run.js');
	assert.equal(typeof profiler.profileRun, 'function');
	assert.equal(typeof profiler.profileFight, 'function');
	assert.equal(typeof profiler.summariseProfile, 'function');
	// The timer wraps in place and counts both calls and milliseconds.
	const into = {};
	const target = {work: n => n * 2};
	profiler.instrument(target, ['work', 'missing'], into);
	assert.equal(target.work(21), 42, 'the wrapped function still answers');
	target.work(1);
	assert.equal(into.work.calls, 2);
	assert.ok(into.work.ms >= 0);
	assert.equal(into.missing, undefined, 'a name the target does not have is skipped');
	// And the doc quotes the instrument, so the two cannot drift silently.
	const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'PERFORMANCE.md'), 'utf8');
	assert.match(doc, /node scripts\/profile-run\.js --budget=30/);
	assert.match(doc, /search-8/);
});

test('a run that took two Game Corner prizes fails the audit', () => {
	// The harness claimed one prize per badge until the 2026-09-20 ruling.
	// The document now refuses a second, so a REPLAY can never show one; the
	// check reads the raw log, because the runs it must catch predate the rule.
	const row = cleanRow();
	const prize = (species, badge) => ({at: 't0',
		command: {kind: 'catch', species, level: 20, prize: badge}});
	row.doc = Object.assign({}, row.doc, {log: row.doc.log.concat([
		prize('Elekid', 'Knuckle Badge'), prize('Tauros', 'Stone Badge')])});
	const result = auditRun(row);
	const check = result.checks.find(entry => entry.name === 'prizes');
	assert.equal(check.status, 'FAIL');
	assert.match(check.detail, /2 prizes taken, one is allowed: Elekid \(Knuckle Badge\), Tauros \(Stone Badge\)/);
});

test('over the cap is legal by candy, and only by candy', () => {
	// Operator ruling 2026-09-21: "an over cap party legal if rare candies got
	// us there". A body CAUGHT over the cap has paid for nothing — Route 118's
	// level-50 grass at cap 35 put a Kangaskhan at the head of four banked
	// boxes, and they were the only battery wins at Norman.
	const runtime = require('../lib/run.js');
	const row = cleanRow();
	const next = runtime.upcoming(row.doc, 1)[0].trainer;
	const cap = runtime.levelCap(row.doc).cap;
	const lead = row.doc.party[0];
	const at = command => ({at: 't0', command});

	const candied = Object.assign({}, row, {doc: Object.assign({}, row.doc, {log: row.doc.log.concat([
		at({kind: 'acquire', item: 'Rare Candy', count: 2}),
		at({kind: 'levelUp', id: lead, to: cap}),
		at({kind: 'levelUp', id: lead, to: cap + 2}),
		at({kind: 'beat', trainer: next})])})});
	const paid = auditRun(candied);
	assert.equal(statusOf(paid, 'over-cap party'), 'PASS', JSON.stringify(paid.checks.find(c => c.name === 'over-cap party')));
	assert.equal(statusOf(paid, 'level-ups'), 'PASS');
	assert.match(paid.checks.find(c => c.name === 'level-ups').detail, /past the cap, each paid with a Rare Candy/);

	const caught = Object.assign({}, row, {doc: Object.assign({}, row.doc, {log: row.doc.log.concat([
		at({kind: 'catch', species: 'Absol', level: cap + 12}),
		at({kind: 'party', ids: ['mon-' + row.doc.nextId].concat(row.doc.party.slice(0, 5))}),
		at({kind: 'beat', trainer: next})])})});
	const unpaid = auditRun(caught);
	assert.equal(statusOf(unpaid, 'over-cap party'), 'FAIL');
	assert.match(unpaid.checks.find(c => c.name === 'over-cap party').detail, /Absol L\d+ over cap/);
});
