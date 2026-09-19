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
 */

const fs = require('node:fs');
const path = require('node:path');
const run = require('../lib/run.js');
const getProfile = require('../profiles').getProfile;
const PRIZE_TIERS = require('../profiles/run-and-bun/oracle/sources.json').gameCorner.tiers;

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

	// Replay: the whole log through a fresh run, under the run's own rules.
	const rules = doc.rules || {};
	let replay = run.createRun({name: 'audit', now: 't0', levelCap: rules.levelCap, permadeath: rules.permadeath,
		onePerRoute: rules.onePerRoute, dupesClause: rules.dupesClause, rival: rules.rival});
	const refusedCommands = [];
	const areas = {};
	const twice = [];
	const removed = [];
	const prizes = [];
	const overCapLevel = [];
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
			const cap = run.levelCap(replay).cap;
			const to = command.to === 'cap' ? cap : command.to;
			if (cap !== null && to > cap) overCapLevel.push('#' + (index + 1) + ' to ' + to + ' over cap ' + cap);
		}
		if (command.kind === 'beat') {
			const cap = run.levelCap(replay).cap;
			const over = (replay.party || []).map(id => replay.box.find(mon => mon.id === id))
				.filter(mon => mon && cap !== null && mon.level > cap);
			if (over.length) overCapFight.push(command.trainer + ': ' + over.map(mon => mon.species + ' L' + mon.level).join(', ') + ' over cap ' + cap);
		}
		try {
			replay = run.apply(replay, command, {now: entry.at});
		} catch (error) {
			refusedCommands.push('#' + (index + 1) + ' ' + command.kind + ': ' + error.message.slice(0, 100));
		}
	});
	const shape = box => JSON.stringify((box || []).map(mon => [mon.id, mon.species, mon.level, mon.moves]));
	if (refusedCommands.length) {
		check('replay', 'FAIL', refusedCommands.length + ' command(s) the rules refuse: ' + refusedCommands.slice(0, 3).join(' | '),
			'find the code path that wrote them past run.apply');
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
	check('prizes', prizes.length ? 'FAIL' : 'PASS',
		prizes.length ? prizes.join(', ') : 'none before their badge');
	check('level-ups', overCapLevel.length ? 'FAIL' : 'PASS',
		overCapLevel.slice(0, 4).join(' | ') || 'none past the cap', 'a level past the cap costs a Rare Candy');
	// Route 118's grass is Level 50 in the official tables and opens at cap
	// 35, so a caught body can fight far over the cap without a level-up.
	// The rulings assumed method gates made that unreachable
	// (delayed-encounters-are-holds); whether it may fight is unruled.
	check('over-cap party', overCapFight.length ? 'WARN' : 'PASS',
		overCapFight.length ? overCapFight.length + ' fight(s): ' + overCapFight.slice(0, 3).join(' | ') :
			'every fight within the cap',
		'NEEDS A RULING: may a Pokemon caught over the cap fight before the cap reaches it?');

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
	return verdict(row, checks);
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

module.exports = {auditRun};
