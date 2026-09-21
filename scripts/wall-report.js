#!/usr/bin/env node
/* eslint-env node, es6 */
'use strict';

/**
 * A trouble fight, broken down the same way every time.
 *
 *   node scripts/wall-report.js --report=RUN.json --trainer="Leader Norman" [--seeds=20] [--json=OUT]
 *   node scripts/wall-report.js --report=RUN.json --at="Leader Winona"   # as the run walked up to her
 *
 * Every wall so far was understood by a throwaway script, and each one asked
 * the same five questions in a different order. They are the questions a
 * player asks before a boss, so they are asked here once, in order:
 *
 *   1. WHAT IS IT   their six — level, item, ability, moves.
 *   2. CAN THE BOX  the matchup board: per foe, how much of the box outspeeds
 *                   it, and who wins the one-on-one from full health — in the
 *                   box, and in the six actually fielded. A foe with no winner
 *                   is a hole no line of play closes.
 *   3. WHAT HAPPENS the fight played N times by the hand the run uses: wins,
 *                   and per foe what it COSTS (our bodies lost per facing, the
 *                   turns it takes) and whether we ever knock it out. This is
 *                   what found that Norman is decided at Diggersby (1.64
 *                   bodies) and Meloetta (1.34), not at the Pidgeot nobody
 *                   reaches.
 *   4. WHAT IS LEFT ON THE TABLE  empty held slots, stones in the bag a body
 *                   could use, unspent Heart Scales and Rare Candies, bodies
 *                   under the cap. Each of these was a real defect once.
 *   5. CONSIDERATIONS  their kit read for what it demands: a Focus Sash wants
 *                   a multi-hit or chip, Recover wants burst, a status move
 *                   wants its cure berry, a speed tier nobody meets wants
 *                   priority or speed control.
 *
 * It reports; it decides nothing. The document is fought AS GIVEN — levelled,
 * equipped and picked however it arrived — because a report on a box the run
 * never fields is a report on nothing.
 */

const fs = require('node:fs');
const run = require('../lib/run.js');
const planner = require('../lib/planner');
const driver = require('../lib/battle-driver.js');

function own(name, fallback) {
	const hit = process.argv.find(arg => arg.startsWith('--' + name + '='));
	return hit === undefined ? fallback : hit.slice(name.length + 3);
}

const MULTI_HIT = /^(Rock Blast|Bullet Seed|Icicle Spear|Pin Missile|Tail Slap|Arm Thrust|Fury Swipes|Double Kick|Dual Wingbeat|Bonemerang|Triple Axel|Water Shuriken|Scale Shot|Double Hit|Twineedle|Dual Chop|Gear Grind|Surging Strikes)$/;
const RECOVERY = /^(Recover|Roost|Soft-Boiled|Slack Off|Synthesis|Moonlight|Morning Sun|Milk Drink|Shore Up|Rest|Wish|Heal Order|Strength Sap)$/;
const SETUP = /^(Swords Dance|Dragon Dance|Calm Mind|Nasty Plot|Bulk Up|Quiver Dance|Shell Smash|Work Up|Coil|Agility|Rock Polish|Growth|Curse|Belly Drum|Shift Gear|Tail Glow)$/;
// What an ability makes untrue about the board. The board prices a race from
// turn one: Brawly's Combusken showed three "one-on-one winners" in a box it
// took 2.10 bodies from per facing, because Speed Boost outruns them by turn two.
const ABILITIES = {
	'Speed Boost': 'the board\'s speed read is true on turn one only — it outspeeds the box within two turns',
	'Huge Power': 'its Attack is doubled; a physical wall or Intimidate is worth more than the board shows',
	'Pure Power': 'its Attack is doubled; a physical wall or Intimidate is worth more than the board shows',
	Sturdy: 'it survives any one hit from full health — the first hit never finishes it',
	Intimidate: 'our physical attackers hit a stage lower on entry than the board assumes',
	Moody: 'its stats drift every turn; a long fight is a lottery',
	'Skill Link': 'its multi-hit moves always hit five times and break a Focus Sash or Sturdy',
	'No Guard': 'nothing it uses misses, and nothing used on it misses',
	Download: 'it takes a free boost on entry from whichever of our defences is lower',
	Unburden: 'its Speed doubles once its item is used',
};
const CURES = {par: 'Cheri Berry', slp: 'Chesto Berry', psn: 'Pecha Berry', tox: 'Pecha Berry',
	brn: 'Rawst Berry', frz: 'Aspear Berry'};

/** Who wins the one-on-one from full health, by the board's own numbers. */
function boardOf(doc, trainer) {
	const board = run.boxMatrix(doc, trainer);
	const six = new Set(doc.party.map(id => (doc.box.find(mon => mon.id === id) || {}).species));
	return board.grid.map(column => {
		const winners = [];
		let faster = 0;
		for (const cell of column.versus) {
			const kill = Math.ceil(1 / Math.max(cell.us.min, 0.0001));
			const die = Math.ceil(1 / Math.max(cell.them.max, 0.0001));
			if (cell.speed === 'faster') faster += 1;
			if (kill < die || (kill === die && cell.speed === 'faster')) winners.push(cell.species);
		}
		return {foe: column.enemy.species, level: column.enemy.level, box: column.versus.length,
			outspedBy: faster, winners, winnersInSix: winners.filter(name => six.has(name))};
	});
}

/** The fight, played: what each of theirs costs us and whether it ever falls. */
function playedOf(doc, trainer, seeds, policy, battery) {
	const cost = {};
	const of = name => (cost[name] = cost[name] || {faced: 0, lost: 0, turns: 0, fell: 0});
	const killers = {};
	let wins = 0;
	let left = 0;
	for (let seed = 1; seed <= seeds; seed++) {
		const tape = [];
		const played = battery.playScenario(policy, doc, trainer, seed, tape);
		if (played.result === 'win') wins += 1;
		left += (played.foe && played.foe.alive) || 0;
		const seen = new Set();
		for (const turn of tape) {
			const foe = String(turn.foe).replace(/\s+L\d+.*$/, '');
			if (!seen.has(foe)) { seen.add(foe); of(foe).faced += 1; }
			if (turn.why === 'forced replacement') of(foe).lost += 1;
			else of(foe).turns += 1;
		}
		for (const kill of played.knockouts || []) of(kill.species).fell += 1;
		for (const death of played.killers || []) {
			const key = death.of + ' / ' + death.by;
			killers[key] = (killers[key] || 0) + 1;
		}
	}
	return {wins, of: seeds, foeLeft: Number((left / seeds).toFixed(2)), cost,
		killers: Object.entries(killers).sort((a, b) => b[1] - a[1]).slice(0, 8)};
}

/** What the run holds and is not using. Each line was a real defect once. */
function unusedOf(doc) {
	const evolutions = require('../profiles/run-and-bun/oracle/evolutions.json');
	const cap = run.levelCap(doc).cap;
	const six = doc.party.map(id => doc.box.find(mon => mon.id === id)).filter(Boolean);
	const notes = [];
	const empty = six.filter(mon => !mon.item).map(mon => mon.species);
	if (empty.length) notes.push('holding nothing: ' + empty.join(', '));
	for (const mon of doc.box) {
		const step = (evolutions[mon.species] || []).find(path => path.method === 'item' && doc.bag[path.item]);
		if (step && mon.status !== 'dead') notes.push(mon.species + ' could evolve with the ' + step.item + ' in the bag');
	}
	if (doc.bag['Heart Scale']) notes.push(doc.bag['Heart Scale'] + ' Heart Scale(s) unspent');
	if (doc.bag['Rare Candy']) notes.push(doc.bag['Rare Candy'] + ' Rare Candy unspent (over the cap is legal by candy)');
	const under = cap === null ? [] : six.filter(mon => mon.level < cap).map(mon => mon.species + ' L' + mon.level);
	if (under.length) notes.push('under the cap of ' + cap + ': ' + under.join(', '));
	const berries = Object.keys(doc.bag).filter(name => /Berry$/.test(name));
	if (!berries.includes('Sitrus Berry')) notes.push('no Sitrus Berry in the bag');
	return notes;
}

/** Their kit, read for what it demands of us. */
function considerationsOf(doc, fight, board) {
	const ai = require('../ai');
	const notes = [];
	const ourMoves = new Set(doc.party.map(id => doc.box.find(mon => mon.id === id)).filter(Boolean)
		.reduce((all, mon) => all.concat(mon.moves || []), []));
	const bag = doc.bag || {};
	for (const foe of fight.party || fight.mons || []) {
		const moves = foe.moves || [];
		if (foe.item === 'Focus Sash' && ![...ourMoves].some(move => MULTI_HIT.test(move))) {
			notes.push(foe.species + ' holds a Focus Sash and the six has no multi-hit move to break it');
		}
		const heals = moves.filter(move => RECOVERY.test(move));
		if (heals.length) notes.push(foe.species + ' has ' + heals.join('/') + ': chip loses to it, it needs burst over half its health');
		const trait = ABILITIES[foe.ability];
		if (trait) notes.push(foe.species + ' has ' + foe.ability + ': ' + trait);
		const sets = moves.filter(move => SETUP.test(move));
		if (sets.length) notes.push(foe.species + ' sets up with ' + sets.join('/') + ': a free turn is a lost fight');
		for (const move of moves) {
			const meta = ai.getMoveMetadata(move, 8) || {};
			const status = meta.status || (meta.secondary && meta.secondary.status) || null;
			const cure = status && CURES[status];
			if (cure) notes.push(foe.species + '\'s ' + move + ' inflicts ' + status + ': ' + cure +
				(bag[cure] ? ' is in the bag (' + bag[cure] + ')' : ' is NOT in the bag'));
		}
	}
	for (const row of board) {
		if (!row.winners.length) notes.push('NOBODY in the box of ' + row.box + ' beats ' + row.foe + ' one-on-one');
		else if (!row.winnersInSix.length) notes.push(row.foe + ' has an answer in the box (' + row.winners.slice(0, 3).join(', ') + ') that the six does not field');
		if (row.outspedBy === 0) notes.push(row.foe + ' outspeeds the whole box: priority or speed control, or it moves first every turn');
	}
	return notes;
}

/**
 * The document as it stood when the run walked up to `trainer`: the saved log
 * replayed through a fresh run, under the run's own rules, stopping just
 * before that fight was beaten. A saved run ends where it stopped, but the
 * fight worth reading is usually one it got PAST on the twentieth attempt —
 * and the box that finally won it is the box to learn from.
 */
function docAt(doc, trainer) {
	const rules = doc.rules || {};
	let replay = run.createRun({name: doc.name || 'replay', now: 't0', levelCap: rules.levelCap,
		permadeath: rules.permadeath, onePerRoute: rules.onePerRoute, dupesClause: rules.dupesClause,
		rival: rules.rival});
	for (const entry of doc.log || []) {
		if (entry.command.kind === 'beat' && entry.command.trainer === trainer) return replay;
		try {
			replay = run.apply(replay, entry.command, {now: entry.at});
		} catch (error) { /* a command the rules now refuse is skipped, as the audit reports it */ }
	}
	throw new Error('this run never beat ' + trainer + '; leave --at off to read where it stopped');
}

function report(doc, trainer, seeds) {
	const policy = require('./ui-playthrough.js');
	const battery = require('./scenario-battery.js');
	driver.setPPModel(true);
	const fight = planner.getFight(trainer, doc.profileId);
	const board = boardOf(doc, trainer);
	return {trainer: fight.trainer, order: fight.order, position: doc.position, cap: run.levelCap(doc).cap,
		theirs: (fight.party || fight.mons || []).map(foe => ({species: foe.species, level: foe.level,
			item: foe.item || null, ability: foe.ability || null, moves: foe.moves || []})),
		six: doc.party.map(id => doc.box.find(mon => mon.id === id)).filter(Boolean)
			.map(mon => ({name: mon.nickname || mon.species, species: mon.species, level: mon.level,
				item: mon.item || null, moves: mon.moves})),
		board, played: playedOf(doc, trainer, seeds, policy, battery),
		unused: unusedOf(doc), considerations: considerationsOf(doc, fight, board)};
}

function render(out) {
	const lines = [];
	lines.push(`# ${out.trainer} — order ${out.order}, met at position ${out.position}, cap ${out.cap}`);
	lines.push('', '## Their six');
	for (const foe of out.theirs) {
		lines.push(`- L${foe.level} **${foe.species}** @ ${foe.item || 'nothing'} [${foe.ability || '?'}]: ${foe.moves.join(', ')}`);
	}
	lines.push('', '## Our six');
	for (const mon of out.six) lines.push(`- L${mon.level} **${mon.name}** the ${mon.species} @ ${mon.item || 'NOTHING'}: ${mon.moves.join(', ')}`);
	lines.push('', '## Can the box do it', '', '| Foe | Box outspeeds | 1v1 winners in the box | …of those, in the six |', '|---|---|---|---|');
	for (const row of out.board) {
		lines.push(`| ${row.foe} L${row.level} | ${row.outspedBy}/${row.box} | ${row.winners.join(', ') || '**none**'} | ${row.winnersInSix.join(', ') || '**none**'} |`);
	}
	lines.push('', `## What happens: ${out.played.wins} of ${out.played.of} won, ${out.played.foeLeft} of theirs left standing`, '',
		'| Foe | Faced | We knock it out | Our bodies lost per facing | Turns per facing |', '|---|---|---|---|---|');
	for (const foe of out.theirs) {
		const cost = out.played.cost[foe.species] || {faced: 0, lost: 0, turns: 0, fell: 0};
		const per = value => cost.faced ? (value / cost.faced).toFixed(2) : '—';
		lines.push(`| ${foe.species} | ${cost.faced} | ${cost.fell} | ${per(cost.lost)} | ${per(cost.turns)} |`);
	}
	lines.push('', 'What kills us: ' + (out.played.killers.map(entry => entry[0] + ' ×' + entry[1]).join(', ') || 'nothing'));
	lines.push('', '## Left on the table');
	for (const note of out.unused.length ? out.unused : ['nothing found']) lines.push('- ' + note);
	lines.push('', '## Considerations');
	for (const note of out.considerations.length ? out.considerations : ['none read from their kit']) lines.push('- ' + note);
	return lines.join('\n') + '\n';
}

function main() {
	const file = own('report', '');
	const trainer = own('trainer', '');
	if (!file) {
		process.stderr.write('usage: node scripts/wall-report.js --report=RUN.json [--trainer=NAME] [--seeds=20] [--json=OUT]\n');
		process.exit(2);
	}
	const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
	const doc = loaded.doc || loaded;
	const at = own('at', '');
	if (at) {
		process.stdout.write(render(report(docAt(doc, at), at, Number(own('seeds', '20')))));
		return;
	}
	const name = trainer || (run.upcoming(doc, 1)[0] || {}).trainer;
	const out = report(doc, name, Number(own('seeds', '20')));
	if (own('json', '')) fs.writeFileSync(own('json', ''), JSON.stringify(out, null, 1) + '\n');
	process.stdout.write(render(out));
}

if (require.main === module) main();

module.exports = {report, render, docAt, boardOf, unusedOf, considerationsOf};
