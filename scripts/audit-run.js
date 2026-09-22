#!/usr/bin/env node
/* eslint-env node, es6 */
'use strict';

/**
 * Audit a finished headless run before anyone believes it.
 *
 *   node scripts/audit-run.js RUN.json [RUN.json ...]
 *
 * RUN.json is a playRun row written with keepDoc (the sweep runners write
 * these). Every check prints PASS, WARN or FAIL with what to repair; the
 * exit code is 1 when any run has a FAIL. A run "beats the game" only when
 * the road is finished and nothing FAILs.
 *
 * The run document enforces most rules as commands are applied, so the
 * first check replays the whole log through a fresh run: a document edited
 * by hand, or produced by code that bypassed a rule, does not replay. The
 * rest check what apply() does not see: the rules across commands (one
 * catch per area, levels at each fight), the hack's removed species, and
 * how each win was bought (an engine refusal is a turn the driver made up).
 *
 * Found by hand before this existed (2026-09-19): removed species in the
 * wild tables, wins bought by a refused Coaching, a skipped double that
 * stopped the run, and Speed read as 0 in every race.
 *
 * What this audit CANNOT see, by ruling rather than by omission
 * (money-and-balls-are-not-modelled): a mart purchase costs nothing and a
 * catch consumes no ball, because money is not a restriction in this game.
 * A PASS here is a claim about the rules the document keeps, not about what
 * the run could afford.
 */

const fs = require('node:fs');
const path = require('node:path');
const run = require('../lib/run.js');
const stamps = require('../lib/provenance.js');
const getProfile = require('../profiles').getProfile;
const PRIZE_TIERS = require('../profiles/run-and-bun/oracle/sources.json').gameCorner.tiers;
const ITEM_ROWS = require('../profiles/run-and-bun/oracle/item-locations.json').entries;

/**
 * The move each TM teaches, and whether a mart sells it again.
 *
 * A TM is a ONE-TIME item in Run & Bun — the author's FAQ and the release
 * thread both say so — except the ten sold at the Lilycove Department Store.
 * The harness has always taught a TM move for free, so a run could teach Icy
 * Wind ten times from a TM it never owned.
 */
function tmIndex() {
	const moves = new Map();
	for (const row of ITEM_ROWS) {
		if (row.kind !== 'tm') continue;
		const move = String(row.name).replace(/^(?:TM|HM)\d+\s+/, '');
		// An HM is reusable wherever it is used; only a TM is one-time.
		const oracle = getProfile('run-and-bun').oracle;
		const found = oracle.tmFor ? oracle.tmFor(move) : null;
		moves.set(move, {repeatable: /^HM/.test(row.name) || /Sold at /.test(row.location || ''),
			unlimitedFrom: found ? found.unlimitedFrom : null,
			tm: row.name, opensAt: row.opensAt});
	}
	return moves;
}

// A fight retried this often was won by the dice as much as by the play.
const EFFORT_WARN = 20;

function auditRun(row) {
	const checks = [];
	const check = (name, status, detail, repair) => checks.push({name, status, detail, repair: repair || null});
	const doc = row && row.doc;
	if (!doc || !Array.isArray(doc.log)) {
		check('document', 'FAIL', 'the row carries no run document', 'write the run with keepDoc');
		return verdict(row, checks);
	}
	const profile = getProfile(doc.profileId);
	const oracle = profile.oracle;

	// Provenance: which code played it.
	const made = row.provenance;
	if (!made || !made.revision) {
		check('provenance', 'WARN', 'no revision recorded (a run from before 2026-09-19)',
			're-run it on a committed revision to review it');
	} else if (made.dirty) {
		check('provenance', 'FAIL', 'played from a dirty tree at ' + made.revision.slice(0, 10),
			'play from a clean worktree pinned to a commit');
	} else {
		check('provenance', 'PASS', made.revision.slice(0, 10) + ' clean, flags ' + (made.flags || []).join(' '));
	}

	// Engines: a carried-on run can be played on more than one, and a result
	// on two engines is a result on neither. A WARN, not a FAIL: the run's
	// rules held either way; what it says about the engine is what is split.
	const engines = enginesCheck(row);
	check('engines', engines.status, engines.detail, engines.repair);

	// Replay: the whole log through a fresh run, under the run's own rules.
	const rules = doc.rules || {};
	let replay = run.createRun({name: 'audit', now: 't0', levelCap: rules.levelCap, permadeath: rules.permadeath,
		onePerRoute: rules.onePerRoute, dupesClause: rules.dupesClause, rival: rules.rival});
	const refusedCommands = [];
	const ownRefusals = [];
	const refusedTeaches = new Set();
	const refusedKinds = {inherited: 0, cascade: 0, own: 0};
	// Where the log this run resumed from ends, when it resumed from one.
	const resumedLog = Number.isInteger(row.resumedLog) ? row.resumedLog : null;
	const areas = {};
	const twice = [];
	const removed = [];
	const prizes = [];
	const overCapLevel = [];
	const candied = {};
	const overCapFight = [];
	const illegalMoves = [];
	doc.log.forEach((entry, index) => {
		const command = entry.command || {};
		if (command.kind === 'catch' && command.map && !command.prize) {
			const area = (oracle.areaOf && oracle.areaOf(command.map)) || command.map;
			areas[area] = (areas[area] || 0) + 1;
			if (rules.onePerRoute && areas[area] === 2) twice.push(area);
		}
		if (command.kind === 'catch' && command.species && oracle.availabilityOfSpecies) {
			const status = oracle.availabilityOfSpecies(command.species).status;
			if (status === 'unavailable' || status === 'unreachable') removed.push(command.species + ' @ ' + (command.map || command.prize));
		}
		if (command.kind === 'catch' && command.prize) {
			const tier = PRIZE_TIERS.find(t => t.badge === command.prize);
			if (!tier || replay.position < tier.opensAt || !tier.options.includes(command.species)) {
				prizes.push(command.species + ' (' + command.prize + ') at position ' + replay.position);
			}
		}
		if (command.kind === 'levelUp') {
			// Ruling over-cap-is-legal-when-candied (operator, 2026-09-21): a
			// level past the cap is legal when a Rare Candy paid for it. The
			// document debits one a level and refuses without it, so a replayed
			// over-cap level-up IS a paid one; what is kept here is how many
			// levels each body bought, which the party check below needs.
			const cap = run.levelCap(replay).cap;
			const to = command.to === 'cap' ? cap : command.to;
			const before = (replay.box.find(mon => mon.id === command.id) || {}).level;
			if (cap !== null && to > cap && before !== undefined) {
				candied[command.id] = (candied[command.id] || 0) + (to - Math.max(cap, before));
				overCapLevel.push('#' + (index + 1) + ' to ' + to + ' over cap ' + cap);
			}
		}
		if (command.kind === 'beat') {
			// Over the cap is legal ONLY by candy. A body CAUGHT over the cap
			// (Route 118's level-50 grass at cap 35) has bought nothing, so it
			// may not fight until the cap reaches it.
			const cap = run.levelCap(replay).cap;
			const over = (replay.party || []).map(id => replay.box.find(mon => mon.id === id))
				.filter(mon => mon && cap !== null && mon.level - (candied[mon.id] || 0) > cap);
			if (over.length) overCapFight.push(command.trainer + ': ' + over.map(mon => mon.species + ' L' + mon.level).join(', ') + ' over cap ' + cap);
		}
		try {
			replay = run.apply(replay, command, {now: entry.at});
		} catch (error) {
			// Three kinds, and only one is this run's own doing. INHERITED: the
			// command is in the part of the log the run RESUMED from — an old
			// banked document written under older rules. CASCADE: it replaces a
			// move whose own teach was refused earlier, so it fails only because
			// that one did. OWN: neither — the harness wrote a command the rules
			// refuse, which is the defect this check exists to find.
			const inherited = resumedLog !== null && index < resumedLog;
			const missing = /does not know (.+)$/.exec(error.message);
			const cascade = !!missing && refusedTeaches.has(command.id + '|' + missing[1].trim());
			if (command.kind === 'teach') refusedTeaches.add(command.id + '|' + command.move);
			refusedKinds[inherited ? 'inherited' : cascade ? 'cascade' : 'own'] += 1;
			if (!inherited && !cascade) ownRefusals.push('#' + (index + 1) + ' ' + command.kind + ': ' + error.message.slice(0, 100));
			refusedCommands.push('#' + (index + 1) + ' ' + command.kind + ': ' + error.message.slice(0, 100));
		}
	});
	const shape = box => JSON.stringify((box || []).map(mon => [mon.id, mon.species, mon.level, mon.moves]));
	if (ownRefusals.length) {
		check('replay', 'FAIL', ownRefusals.length + ' command(s) of this run\'s own the rules refuse: ' + ownRefusals.slice(0, 3).join(' | ') +
			(refusedKinds.inherited ? ' (plus ' + refusedKinds.inherited + ' inherited, ' + refusedKinds.cascade + ' cascading)' : ''),
		'find the code path that wrote them past run.apply');
	} else if (refusedCommands.length) {
		check('replay', 'WARN', refusedKinds.inherited + ' refused command(s) inherited from the document this run resumed from, ' +
			refusedKinds.cascade + ' cascading from them, none of this run\'s own',
		'the run resumed from a document written under older rules; resume from one written under today\'s for a clean replay');
	} else if (shape(replay.box) !== shape(doc.box)) {
		check('replay', 'FAIL', 'the log replays, but not to the box the document holds',
			'the box was edited outside the log');
	} else {
		check('replay', 'PASS', doc.log.length + ' commands replay to the same box');
	}

	check('one catch per area', twice.length ? 'FAIL' : 'PASS',
		twice.length ? 'two catches in: ' + twice.join(', ') : Object.keys(areas).length + ' areas, one each',
		'drop the second catch; find what rolled it');
	check('removed species', removed.length ? 'FAIL' : 'PASS',
		removed.length ? removed.join(', ') : 'none caught',
		'the encounter roll must filter unavailable.json (lib/run.js rollEncounter)');
	// The Game Corner pays out once a run (ruling the-game-corner-pays-once,
	// 2026-09-20). Counted from the raw log, not the replay: the document now
	// refuses a second prize, so a replay could never show one — and the runs
	// this must catch are the ones written before the rule existed.
	const prizeCatches = (doc.log || []).filter(entry => entry.command.kind === 'catch' &&
		entry.command.prize).map(entry => entry.command.species + ' (' + entry.command.prize + ')');
	if (prizeCatches.length > 1) {
		prizes.push(prizeCatches.length + ' prizes taken, one is allowed: ' + prizeCatches.join(', '));
	}
	check('prizes', prizes.length ? 'FAIL' : 'PASS',
		prizes.length ? prizes.join(', ') :
			(prizeCatches.length ? 'one, after its badge: ' + prizeCatches[0] : 'none taken'),
		'one Game Corner prize a run, from a tier whose gym is beaten');
	check('level-ups', 'PASS',
		overCapLevel.length ? overCapLevel.length + ' level-up(s) past the cap, each paid with a Rare Candy' :
			'none past the cap', 'a level past the cap costs a Rare Candy, and is legal when paid');
	check('over-cap party', overCapFight.length ? 'FAIL' : 'PASS',
		overCapFight.length ? overCapFight.length + ' fight(s): ' + overCapFight.slice(0, 3).join(' | ') :
			'every body within the cap, or over it by candy',
		'over the cap is legal only by Rare Candy; a body CAUGHT over the cap waits for the cap');

	// Moves: every move in the final box is one its species can have.
	for (const mon of doc.box) {
		for (const move of mon.moves || []) {
			const verdictOf = oracle.canLearn(mon.species, move);
			if (verdictOf && verdictOf.legal === false) illegalMoves.push(mon.species + ': ' + move);
		}
	}
	check('moves', illegalMoves.length ? 'FAIL' : 'PASS',
		illegalMoves.length ? illegalMoves.slice(0, 6).join(', ') : 'every move known is learnable');

	// The road: finished, skipped, owed.
	const beaten = new Set(doc.log.filter(entry => (entry.command || {}).kind === 'beat')
		.map(entry => entry.command.trainer));
	const road = run.upcoming(Object.assign({}, doc, {position: 0, skipped: [], log: []}), 1000);
	const owed = (doc.skipped || []).map(order => {
		const fight = road.find(entry => entry.order === order);
		return fight ? fight.trainer : '#' + order;
	}).filter(name => !beaten.has(name));
	const left = run.upcoming(doc, 1000).length;
	check('road', left === 0 && !owed.length ? 'PASS' : 'WARN',
		left === 0 ? 'finished' + (owed.length ? ', owing ' + owed.join(', ') : '') :
			left + ' fights left; stopped: ' + (row.stopped || '(budget)') + (owed.length ? '; owing ' + owed.join(', ') : ''));

	// How each win was bought.
	const ledger = row.ledger || null;
	if (!ledger) {
		check('wins', 'WARN', 'no fight ledger (a run from before 2026-09-19); engine refusals total ' +
			(row.engineRefusals || 0), 're-run to get per-fight records');
	} else {
		const tainted = ledger.filter(entry => entry.result === 'win' && entry.refusals > 0);
		check('wins', tainted.length ? 'FAIL' : 'PASS',
			tainted.length ? tainted.map(entry => entry.trainer + ' (seed ' + entry.seed + ', ' + entry.refusals +
				' refused)').join(', ') : ledger.filter(entry => entry.result === 'win').length + ' wins, none bought by a refusal',
			'fix the refusal, then replay each listed fight on its seed from its position');
		const attempts = {};
		for (const entry of ledger) attempts[entry.trainer] = (attempts[entry.trainer] || 0) + 1;
		const heavy = Object.entries(attempts).filter(pair => pair[1] >= EFFORT_WARN).sort((a, b) => b[1] - a[1]);
		check('effort', heavy.length ? 'WARN' : 'PASS',
			ledger.length + ' attempts for ' + beaten.size + ' wins' +
			(heavy.length ? '; ' + heavy.length + ' fight(s) took ' + EFFORT_WARN + '+: ' +
				heavy.slice(0, 5).map(pair => pair[0] + ' ' + pair[1]).join(', ') : ''));
	}
	// Teaches the run could not pay for: a TM is one-time unless a mart sells
	// it again, and the harness charges nothing for either.
	const tms = tmIndex();
	const taughtTm = {};
	const tooEarly = [];
	let where = 0;
	for (const entry of doc.log) {
		const command = entry.command || {};
		if (command.kind === 'beat' || command.kind === 'skip') where = replayPosition(doc, command, where);
		if (command.kind !== 'teach') continue;
		const known = tms.get(command.move);
		if (!known) continue;
		// A move with a TM is not always FROM the TM: Rock Tomb is a level-up
		// move for Aron at 13 and a TM for everyone else. Only a teach the
		// rules would charge for counts here, which is what run.apply asks.
		const mon = doc.box.find(entry => entry.id === command.id);
		const verdict = mon ? oracle.canLearn(mon.species, command.move) : null;
		const chargeable = verdict && verdict.legal && verdict.sources.every(source =>
			source.source === 'teachable' || (source.level !== undefined && source.level > (mon.level || 0)));
		if (!chargeable) continue;
		// A TM the run has not reached yet is one it cannot hold, whatever the
		// one-time question: br-21 taught Earthquake from TM31, which lies in
		// Victory Road, while it was still fighting in the Brawly era.
		if (known.opensAt !== null && known.opensAt !== undefined && known.opensAt > where) {
			tooEarly.push(command.move + ' (' + known.tm + ' opens at ' + known.opensAt + ')');
		}
		// Unlimited only once the store that re-sells it is open.
		if (known.repeatable && (known.unlimitedFrom === undefined ||
			(known.unlimitedFrom !== null && where >= known.unlimitedFrom))) continue;
		taughtTm[command.move] = (taughtTm[command.move] || 0) + 1;
	}
	const overspent = Object.keys(taughtTm).filter(move => taughtTm[move] > 1)
		.map(move => move + ' x' + taughtTm[move] + ' (' + tms.get(move).tm + ')');
	const unique = [...new Set(tooEarly)];
	check('TMs', overspent.length || unique.length ? 'WARN' : 'PASS',
		[unique.length ? unique.length + ' taught before the TM is reachable: ' + unique.slice(0, 3).join(', ') : '',
			overspent.length ? 'one-time TMs spent twice: ' + overspent.slice(0, 4).join(', ') : '']
			.filter(Boolean).join(' | ') || 'every TM move was one the run could hold, once',
		'NEEDS A RULING: a TM is one-time in this fork (ten are re-sold at Lilycove) and the run charges nothing for one');

	// A repaired stat stage is a defect the clamp hid to keep the run alive.
	const repairs = row.boostRepairs || 0;
	check('stat stages', repairs ? 'WARN' : 'PASS',
		repairs ? repairs + ' stage(s) past +/-6 or not a number, clamped on the way into the calculator' :
			'every stage the calculator saw was one it could index',
		'find what writes the stage: unclamped, this crashes the run (sweep 14, fight #271)');

	// An engine crash is a defect with a name: the fight, the seed, and the
	// document that met it (playRun writes them out when a run keeps going).
	const crashes = row.crashes || 0;
	check('engine crashes', crashes ? 'WARN' : 'PASS',
		crashes ? crashes + ': ' + (row.crashed || []).slice(0, 2)
			.map(entry => entry.trainer + ' (seed ' + entry.seed + ') ' + entry.message.slice(0, 80)).join(' | ') :
			'none',
		'replay the saved document against the fight and seed named here');

	return verdict(row, checks);
}

/** The engines a row's legs were played on, as {status, detail, repair}. */
function enginesCheck(row) {
	const legs = Array.isArray(row.legs) && row.legs.length ? row.legs :
		stamps.stampOf(row) ? [{leg: 1, engine: stamps.stampOf(row)}] : null;
	if (!legs) {
		const carried = (row.restoredAt || []).length;
		return {status: 'WARN', detail: stamps.UNKNOWN + (carried ? '; carried on ' + carried +
			' time(s), so it may span engines' : ''), repair: 're-run it on a stamped runner to name its engine'};
	}
	const engines = stamps.enginesOfLegs(legs);
	const moved = legs.filter(leg => leg.engine && leg.engine.moved);
	if (moved.length) {
		return {status: 'WARN', detail: 'the engine moved while leg' + (moved.length > 1 ? 's ' : ' ') +
			moved.map(leg => leg.leg).join(',') + ' played: ' + moved.map(leg => stamps.describe(leg.engine) + ' (' +
			leg.engine.moved.differs.join(', ') + ' differ)').join('; '),
		repair: 'a file that decides play changed mid-leg; replay it on a tree nobody edits'};
	}
	const named = engines.map(entry => entry.key + ' (leg' + (entry.legs.length > 1 ? 's ' : ' ') +
		entry.legs.join(',') + (entry.stamp && entry.stamp.revision ? ' at ' + entry.stamp.revision.slice(0, 10) : '') + ')');
	if (engines.length > 1) {
		return {status: 'WARN', detail: 'played on ' + engines.length + ' engines: ' + named.join(', '),
			repair: 'a result across engines measures the change between them too; replay it on one engine to compare'};
	}
	if (engines[0].key === stamps.UNKNOWN) {
		return {status: 'WARN', detail: 'played on 1 engine: ' + named[0], repair: 're-run it on a stamped runner to name its engine'};
	}
	// A --resume run (not a carry-on) starts from another run's log and plays
	// on from it; the fights in that log were played by a process that left no
	// stamp here, so one engine for this run's own legs is not one engine.
	const resumedLog = Number(row.resumedLog) || 0;
	if (resumedLog > 0 || Number(row.resumedAt) > 0) {
		return {status: 'WARN', detail: 'played on 1 engine: ' + named[0] + '; resumed from position ' +
			(row.resumedAt || 0) + ' with ' + resumedLog + ' inherited log entries played on ' + stamps.UNKNOWN,
		repair: 'the inherited fights may be another engine; replay from the start on one engine to name it'};
	}
	return {status: 'PASS', detail: 'played on 1 engine: ' + named[0], repair: null};
}

/** Where the run stands after a fight command, in run-map orders. */
function replayPosition(doc, command, previous) {
	const road = run.upcoming(Object.assign({}, doc, {position: 0, skipped: [], log: []}), 1000);
	const fight = road.find(entry => entry.trainer === command.trainer);
	return fight && fight.order > previous ? fight.order : previous;
}

function verdict(row, checks) {
	const failed = checks.filter(entry => entry.status === 'FAIL');
	const doc = row && row.doc;
	const finished = !!(doc && run.upcoming(doc, 1).length === 0);
	return {ok: failed.length === 0, beatTheGame: finished && failed.length === 0 &&
		!checks.some(entry => entry.name === 'road' && entry.status !== 'PASS'), checks};
}

function main() {
	let bad = 0;
	for (const file of process.argv.slice(2).filter(arg => !arg.startsWith('--'))) {
		const row = JSON.parse(fs.readFileSync(file, 'utf8'));
		const result = auditRun(row);
		console.log('\n' + path.basename(file) + ': ' + (result.beatTheGame ? 'BEAT THE GAME' :
			result.ok ? 'valid so far' : 'NOT VALID'));
		for (const entry of result.checks) {
			console.log('  ' + entry.status.padEnd(4) + ' ' + entry.name.padEnd(18) + ' ' + entry.detail +
				(entry.status !== 'PASS' && entry.repair ? '\n       repair: ' + entry.repair : ''));
		}
		if (!result.ok) bad++;
	}
	process.exitCode = bad ? 1 : 0;
}

if (require.main === module) main();

module.exports = {auditRun, enginesCheck};
