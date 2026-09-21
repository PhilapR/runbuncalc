#!/usr/bin/env node
/* eslint-env node, es6 */
'use strict';

/**
 * How a fight was actually won.
 *
 *   node scripts/how-it-won.js --report=RUN.json --trainer="Aqua Admin Shelly Weather Institute"
 *
 * The wall report reads a fight as a board of one-on-ones, and the operator's
 * correction to it was exact: "we often won't be able to solve fights with
 * one-on-one solutions — we need to take control of fights and get favorable
 * situations." A board says what the raw material is. It cannot say how a
 * fight is WON, and a run that beat Shelly on its twentieth attempt did win
 * it — with a lead, a sequence of sends, some free turns, some luck — and
 * then threw the line away, because the ledger keeps a row and not a fight.
 *
 * This replays the WINNING attempt: the document as the run walked up to the
 * fight (wall-report's docAt), the attempt's own seed from the ledger, and
 * the same hand that played it (decide, or search-K move by move). The replay
 * must reproduce the ledger's result and turn count or it refuses, because a
 * line nobody played is worse than no line. It then tells the fight turn by
 * turn and sums up what CONTROL the win was made of: who led, every voluntary
 * switch and what it bought, set-up and status turns, priority, bodies given
 * up and what for, the dice that mattered (crits, misses, secondary effects),
 * and how the losing attempts before it ended.
 *
 * Singles only; a double is reported as not replayable here.
 */

const fs = require('node:fs');
const driver = require('../lib/battle-driver.js');
const view = require('../lib/battle-view.js');
const wall = require('./wall-report.js');

function own(name, fallback) {
	const hit = process.argv.find(arg => arg.startsWith('--' + name + '='));
	return hit === undefined ? fallback : hit.slice(name.length + 3);
}

const SETUP = /(Swords Dance|Dragon Dance|Calm Mind|Nasty Plot|Bulk Up|Quiver Dance|Shell Smash|Work Up|Coil|Agility|Rock Polish|Growth|Curse|Belly Drum|Shift Gear|Tail Glow|Hone Claws|Iron Defense|Amnesia|Cosmic Power)/;
const CONTROL = /(Thunder Wave|Icy Wind|Rock Tomb|Bulldoze|Electroweb|Tailwind|Trick Room|Sticky Web|Stealth Rock|Spikes|Toxic Spikes|Will-O-Wisp|Toxic|Spore|Sleep Powder|Hypnosis|Yawn|Glare|Stun Spore|Nuzzle|Fake Out|Taunt|Encore|Reflect|Light Screen|Aurora Veil|Intimidate|Parting Shot|U-turn|Volt Switch|Flip Turn|Baton Pass|Protect|Detect|Substitute|Leech Seed)/;
const PRIORITY = /(Quick Attack|Mach Punch|Bullet Punch|Ice Shard|Aqua Jet|Sucker Punch|Shadow Sneak|Extreme Speed|Vacuum Wave|Accelerock|Water Shuriken|First Impression|Fake Out|Feint)/;

/** Play the attempt again with the hand that played it, keeping every turn. */
function replay(doc, trainer, seed, hand) {
	driver.setPPModel(true);
	const policy = require('./ui-playthrough.js');
	const battery = require('./scenario-battery.js');
	const searching = /^search-(\d+)$/.exec(hand || '');
	if (!searching) {
		const tape = [];
		const played = battery.playScenario(policy, doc, trainer, seed, tape);
		return {result: played.result, turns: played.turns,
			steps: tape.map(turn => ({turn: turn.turn, us: turn.us, usHp: turn.usHp, foe: turn.foe,
				foeHp: turn.foeHp, chose: turn.chose, why: turn.why, events: turn.events || []}))};
	}
	const rollouts = Number(searching[1]);
	let reply = driver.start(doc, trainer, seed);
	let bundle = reply.battle;
	let actions = reply.actions;
	let dice = 0;
	const steps = [];
	for (let guard = 0; guard < 150 && actions.length; guard++) {
		const seen = view.viewOf(reply);
		const searched = driver.searchChoice(bundle, actions, seed, rollouts, dice);
		dice = searched.dice;
		const chosen = searched.chosen;
		let label = chosen.move;
		if (chosen.kind === 'switch') {
			const entry = actions.find(action => action.kind === 'switch' &&
				action.action.replacementId === chosen.replacementId);
			label = 'switch to ' + (entry ? entry.species : chosen.replacementId);
		}
		reply = driver.act(bundle, chosen);
		steps.push({turn: bundle.state.turn, us: seen.us, usHp: seen.usHp, foe: seen.foe, foeHp: seen.foeHp,
			chose: label, why: seen.prompt && /Choose the next/.test(seen.prompt) ? 'forced replacement' : 'searched',
			events: (reply.events || []).map(event => event.text).filter(Boolean)});
		bundle = reply.battle;
		actions = reply.actions;
		if (reply.result) break;
	}
	return {result: reply.result || 'stuck', turns: bundle.state.turn, steps};
}

/** What the win was made of, read off the turns. */
function controlOf(steps) {
	const out = {lead: steps.length ? steps[0].us : null, pivots: [], setups: [], control: [], priority: [],
		given: [], crits: {ours: 0, theirs: 0}, misses: {ours: 0, theirs: 0}, order: []};
	for (const step of steps) {
		const mine = String(step.us).replace(/\s+L\d+.*$/, '');
		if (mine && !out.order.includes(mine)) out.order.push(mine);
		if (/^switch to /.test(step.chose) && step.why !== 'forced replacement') {
			out.pivots.push(`T${step.turn}: ${mine} out for ${step.chose.replace('switch to ', '')} in front of ${step.foe} (${step.foeHp}%)`);
		}
		if (step.why === 'forced replacement') out.given.push(`T${step.turn}: ${mine} fell to ${step.foe}`);
		if (SETUP.test(step.chose)) out.setups.push(`T${step.turn}: ${mine} used ${step.chose} in front of ${step.foe}`);
		else if (CONTROL.test(step.chose)) out.control.push(`T${step.turn}: ${mine} used ${step.chose} on ${step.foe}`);
		if (PRIORITY.test(step.chose)) out.priority.push(`T${step.turn}: ${mine} ${step.chose} into ${step.foe} (${step.foeHp}%)`);
		for (const text of step.events) {
			const foes = /^Foe /.test(text);
			if (/critical hit/i.test(text)) out.crits[foes ? 'theirs' : 'ours'] += 1;
			if (/missed|avoided/i.test(text)) out.misses[foes ? 'theirs' : 'ours'] += 1;
		}
	}
	return out;
}

function tell(record, trainer) {
	const doc = record.doc || record;
	const attempts = (record.ledger || []).filter(row => row.trainer === trainer);
	if (!attempts.length) throw new Error('this run never fought ' + trainer);
	const won = attempts.find(row => row.result === 'win');
	if (!won) throw new Error('this run never beat ' + trainer + ' (' + attempts.length + ' attempts)');
	const lines = [`# How ${trainer} was won — attempt ${attempts.indexOf(won) + 1} of ${attempts.length}, ` +
		`seed ${won.seed}, played by ${won.policy}`];
	const lost = attempts.filter(row => row.result !== 'win');
	if (lost.length) {
		const left = lost.map(row => row.foeLeft).filter(value => typeof value === 'number');
		const hist = {};
		for (const value of left) hist[value] = (hist[value] || 0) + 1;
		lines.push('', `The ${lost.length} lost attempts left ` +
			Object.keys(hist).sort().map(key => `${key} standing ×${hist[key]}`).join(', ') + '.');
	}
	if (/^joint|doubles/.test(won.policy || '')) {
		lines.push('', 'A double battle: not replayable here yet. The ledger row: ' + JSON.stringify(won.kos || []));
		return lines.join('\n') + '\n';
	}
	const at = wall.docAt(doc, trainer);
	const played = replay(at, trainer, won.seed, won.policy);
	if (played.result !== 'win' || (won.turns !== undefined && played.turns !== won.turns)) {
		lines.push('', `REFUSING to tell it: the replay ended ${played.result} in ${played.turns} turns and the ` +
			`ledger says win in ${won.turns}. The document or the code has moved since the fight, ` +
			'and a line nobody played is worse than none.');
		return lines.join('\n') + '\n';
	}
	const made = controlOf(played.steps);
	lines.push('', `Won in ${played.turns} turns. Led with **${String(made.lead).replace(/\s+L\d+.*$/, '')}**; ` +
		`bodies used in order: ${made.order.join(' → ')}.`);
	const section = (title, rows, none) => {
		lines.push('', '## ' + title);
		for (const row of rows.length ? rows : [none]) lines.push('- ' + row);
	};
	section('Voluntary switches (the pivots)', made.pivots, 'none — every change of body was forced');
	section('Set-up turns taken', made.setups, 'none');
	section('Speed control, status, screens, hazards, pivoting moves', made.control, 'none');
	section('Priority used', made.priority, 'none');
	section('Bodies given up', made.given, 'none — a clean win');
	lines.push('', `## The dice`, `- crits: ours ${made.crits.ours}, theirs ${made.crits.theirs}; ` +
		`misses: ours ${made.misses.ours}, theirs ${made.misses.theirs}`);
	lines.push('', '## Turn by turn');
	for (const step of played.steps) {
		lines.push(`- T${step.turn} ${step.us} ${step.usHp}% vs ${step.foe} ${step.foeHp}% → **${step.chose}**` +
			(step.why && step.why !== 'searched' ? ` _(${step.why})_` : ''));
		if (step.events.length) lines.push('  - ' + step.events.join(' | '));
	}
	return lines.join('\n') + '\n';
}

function main() {
	const file = own('report', '');
	const trainer = own('trainer', '');
	if (!file || !trainer) {
		process.stderr.write('usage: node scripts/how-it-won.js --report=RUN.json --trainer=NAME\n');
		process.exit(2);
	}
	process.stdout.write(tell(JSON.parse(fs.readFileSync(file, 'utf8')), trainer));
}

if (require.main === module) main();

module.exports = {tell, replay, controlOf};
