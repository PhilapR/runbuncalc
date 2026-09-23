#!/usr/bin/env node
/* eslint-env node, es6 */
'use strict';

/**
 * The battle engine as an MCP server: fight-by-fight planning by reasoning.
 *
 * Brute force (search plus retries) clears a wall where the box has a chance
 * and never where it has none — Norman held five headless runs 0 for 41, and
 * a relaxed-rules ceiling box beat every late wall that random boxes could
 * not. The hard fights need a plan: who to bring, what to teach and hold,
 * how to lead, which line to play. These tools let an agent work one out
 * the way a player does and test it against the same engine the battery
 * grades with.
 *
 * Stdio, newline-delimited JSON-RPC 2.0 (initialize, tools/list,
 * tools/call, ping), written without a dependency: the project carries no
 * MCP SDK and the protocol surface used here is small. State (boxes, live
 * fights) lives in this process and is addressed by id.
 *
 *   claude mcp add runbun-engine -- node /path/to/runbuncalc-rescue/scripts/engine-mcp.js
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const ROOT = path.join(__dirname, '..');
process.chdir(ROOT);

const run = require('../lib/run.js');
const planner = require('../lib/planner');
const driver = require('../lib/battle-driver.js');
const dossier = require('../lib/dossier');
const battery = require('./scenario-battery.js');

driver.setPPModel(true);

const boxes = new Map();
const fights = new Map();
let nextId = 1;

function oracle() {
	return require('../profiles').getProfile('run-and-bun').oracle;
}

function box(id) {
	const doc = boxes.get(id);
	if (!doc) throw new Error('no box ' + JSON.stringify(id) + ' — load_box or new_box first');
	return doc;
}

function summarise(doc) {
	return {position: doc.position, rules: doc.rules, party: doc.party,
		box: doc.box.filter(mon => mon.status !== 'dead').map(mon => ({id: mon.id, species: mon.species,
			level: mon.level, ability: mon.ability, item: mon.item, nature: mon.nature, moves: mon.moves,
			ivs: mon.ivs, status: mon.status}))};
}

function fightView(bundle, reply) {
	const state = bundle.state;
	const mon = sideId => state.sides[sideId].party.map(entry => ({id: entry.id, species: entry.species,
		level: entry.level, hp: entry.hp.current + '/' + entry.hp.max, status: entry.status || null,
		boosts: entry.boosts, item: entry.item || null, active: state.sides[sideId].activeIds.includes(entry.id)}));
	return {turn: state.turn, phase: reply.phase || bundle.phase, result: reply.result || null,
		events: (reply.events || []).map(event => event.text),
		ours: mon('player'), theirs: mon('ai'), threat: reply.threat || null,
		actions: (reply.actions || []).map(entry => entry.kind === 'move' ?
			{kind: 'move', move: entry.move, damage: entry.damage || null} :
			{kind: 'switch', replacementId: entry.action.replacementId, species: entry.species,
				race: entry.race ? entry.race.outcome : null})};
}

const TOOLS = {
	list_walls: {
		description: 'Bosses on the road in order: trainer, fight order, level cap, and whether it is a double.',
		schema: {type: 'object', properties: {from: {type: 'number', description: 'lowest fight order'}}},
		run: args => {
			const fresh = run.createRun({name: 'mcp', now: 't0', levelCap: 'next-milestone-ace',
				permadeath: false, onePerRoute: true, rival: 'Blaziken'});
			return run.upcoming(fresh, 400)
				.filter(fight => fight.order >= (args.from || 0) &&
					/Leader|Elite|Champion|Rival|Admin|Wally|Maxie|Archie|Chelle/.test(fight.trainer))
				.map(fight => ({trainer: fight.trainer, order: fight.order, cap: run.capAt(fresh, fight.order),
					double: !!fight.isDouble}));
		},
	},
	fight_info: {
		description: 'A trainer\'s team as the game fields it (species, level, ability, item, moves) and the ' +
			'dossier\'s named answers and tech warnings.',
		schema: {type: 'object', properties: {trainer: {type: 'string'}}, required: ['trainer']},
		run: args => {
			const fight = planner.getFight(args.trainer, 'run-and-bun');
			const row = oracle().fightDossierOf(fight.trainer) || {};
			return {trainer: fight.trainer, order: fight.order, double: !!fight.isDouble, cap: row.cap,
				team: fight.party.map(mon => ({species: mon.species, level: mon.level, ability: mon.ability,
					item: mon.item, nature: mon.nature, moves: mon.moves})),
				namedAnswers: {keyBox: row.keyBox || [],
					perEnemy: (row.mons || []).map(mon => ({enemy: mon.species, answers: mon.topAnswers || []}))},
				tech: row.tech || null};
		},
	},
	availability: {
		description: 'Where a species (or its line) can be obtained: wild routes with method, odds within the ' +
			'method and the fight order the route opens at; non-wild sources (Game Corner, trades). With ' +
			'`before`, marks what is open before that trainer.',
		schema: {type: 'object', properties: {species: {type: 'string'}, before: {type: 'string'}},
			required: ['species']},
		run: args => {
			const o = oracle();
			const limit = args.before ? planner.getFight(args.before, 'run-and-bun').order : null;
			const found = o.availabilityOfSpecies(args.species);
			const routes = (found.reachable || found.wild || []).map(entry => {
				const table = o.encountersOn(entry.map);
				const total = table ? table.mons.filter(mon => mon.method === entry.method)
					.reduce((sum, mon) => sum + mon.chance, 0) : 0;
				const chance = table ? table.mons.filter(mon => mon.method === entry.method &&
					mon.species === args.species).reduce((sum, mon) => sum + mon.chance, 0) : 0;
				const dated = o.availabilityOf(entry.map);
				const opensAt = dated ? dated.opensAt : null;
				return {map: entry.map, name: entry.name, method: entry.method,
					odds: total ? Math.round(1000 * chance / total) / 10 + '%' : null,
					levels: entry.minLevel + '-' + entry.maxLevel, opensAt,
					openBefore: limit === null ? null : opensAt !== null && opensAt <= limit};
			});
			return {species: args.species, status: found.status, routes,
				nonWild: o.nonWildSources(args.species) || []};
		},
	},
	load_box: {
		description: 'Load a run document (a banked run or report JSON) as a box; returns its id and contents.',
		schema: {type: 'object', properties: {path: {type: 'string'}}, required: ['path']},
		run: args => {
			const doc = battery.requireScale(battery.loadDocument(path.resolve(ROOT, args.path)));
			const id = 'box-' + nextId++;
			boxes.set(id, doc);
			return Object.assign({id}, summarise(doc));
		},
	},
	new_box: {
		description: 'Build a hypothetical box for a fight: members at the fight\'s cap unless a level is given, ' +
			'last four level-up moves unless moves are given, the species\' first ability, 20 IVs unless given. ' +
			'The first six are the party, lead first. Legality warnings come back for moves the species ' +
			'cannot learn.',
		schema: {type: 'object', properties: {trainer: {type: 'string'},
			members: {type: 'array', items: {type: 'object', properties: {species: {type: 'string'},
				level: {type: 'number'}, moves: {type: 'array', items: {type: 'string'}}, item: {type: 'string'},
				ability: {type: 'string'}, nature: {type: 'string'}, ivs: {type: 'object'}},
			required: ['species']}}}, required: ['trainer', 'members']},
		run: args => {
			const calc = require('../calc');
			const gen = calc.Generations.get(8);
			const fight = planner.getFight(args.trainer, 'run-and-bun');
			const base = battery.loadDocument(path.join(ROOT, 'fixtures', 'banked-runs', 'headless-shelly-523658.run.json'));
			const doc = structuredClone(base);
			const cap = run.capAt(doc, fight.order);
			const warnings = [];
			doc.box = args.members.map((member, index) => {
				const found = gen.species.get(calc.toID(member.species));
				if (!found) throw new Error('unknown species ' + member.species);
				const level = member.level || cap;
				const moves = member.moves || dossier.lastFourMoves(member.species, level);
				for (const move of moves) {
					const verdict = oracle().canLearn(member.species, move);
					if (!verdict.legal) warnings.push(member.species + ' cannot learn ' + move);
				}
				const iv = 20;
				return {id: 'mon-' + (index + 1), species: member.species, nickname: null, level,
					nature: member.nature || 'Hardy', ability: member.ability || Object.values(found.abilities)[0],
					item: member.item || null, moves,
					ivs: Object.assign({hp: iv, atk: iv, def: iv, spa: iv, spd: iv, spe: iv}, member.ivs || {}),
					status: index < 6 ? 'party' : 'boxed', origin: {kind: 'counterfactual'}};
			});
			doc.party = doc.box.slice(0, 6).map(mon => mon.id);
			const id = 'box-' + nextId++;
			boxes.set(id, doc);
			return Object.assign({id, cap, warnings}, summarise(doc));
		},
	},
	apply_command: {
		description: 'Apply a run command to a box, with every rule the run layer enforces: ' +
			'{kind:"party", ids:[lead first]}, {kind:"teach", id, move, replace}, {kind:"give", id, item}, ' +
			'{kind:"evolve", id, into?}, {kind:"levelUp", id, to}, {kind:"heartScale", id, stat}.',
		schema: {type: 'object', properties: {box: {type: 'string'}, command: {type: 'object'}},
			required: ['box', 'command']},
		run: args => {
			const next = run.apply(box(args.box), args.command);
			boxes.set(args.box, next);
			return Object.assign({summary: next.log[next.log.length - 1].summary}, summarise(next));
		},
	},
	matchup: {
		description: 'Every box member against every enemy of a fight at the fight\'s cap: our best move and ' +
			'its damage % (min-max), theirs back, KO flags and who is faster.',
		schema: {type: 'object', properties: {box: {type: 'string'}, trainer: {type: 'string'}},
			required: ['box', 'trainer']},
		run: args => {
			const matrix = run.boxMatrix(box(args.box), args.trainer);
			const pct = value => Math.round((value || 0) * 100);
			return matrix.grid.map(column => ({enemy: column.enemy.species,
				versus: column.versus.map((cell, m) => ({mon: matrix.box[m].species + ' (' + matrix.box[m].id + ')',
					us: (cell.us.move || '-') + ' ' + pct(cell.us.min) + '-' + pct(cell.us.max) + '%' +
						(cell.us.guaranteedKO ? ' KO' : cell.us.possibleKO ? ' maybe-KO' : ''),
					them: (cell.them.move || '-') + ' ' + pct(cell.them.min) + '-' + pct(cell.them.max) + '%' +
						(cell.them.guaranteedKO ? ' KO' : cell.them.possibleKO ? ' maybe-KO' : ''),
					speed: cell.speed}))}));
		},
	},
	rank: {
		description: 'The ranker\'s best sixes for a fight: members, lead, score, who answers each enemy, and the ' +
			'rollout-adjudicated win chance for the top candidates.',
		schema: {type: 'object', properties: {box: {type: 'string'}, trainer: {type: 'string'},
			top: {type: 'number'}}, required: ['box', 'trainer']},
		run: args => run.rankParties(box(args.box), args.trainer, {top: args.top || 5}).parties.slice(0, args.top || 5)
			.map(party => ({members: party.members.map(member => member.species + ' (' + member.id + ')'),
				lead: party.lead, score: party.score, perEnemy: party.perEnemy,
				pWin: party.adjudication ? party.adjudication.pWin : null})),
	},
	start_fight: {
		description: 'Start a singles fight with the box\'s party (lead first) against a trainer; returns a fight ' +
			'id, both sides, the priced actions (damage for moves, race for switches) and the threat line.',
		schema: {type: 'object', properties: {box: {type: 'string'}, trainer: {type: 'string'}, seed: {type: 'number'}},
			required: ['box', 'trainer']},
		run: args => {
			const opened = driver.start(box(args.box), args.trainer, args.seed || 1);
			const id = 'fight-' + nextId++;
			fights.set(id, opened.battle);
			return Object.assign({id}, fightView(opened.battle, opened));
		},
	},
	act: {
		description: 'Play one action in a live fight: {kind:"move", move} or {kind:"switch", replacementId}.',
		schema: {type: 'object', properties: {fight: {type: 'string'}, action: {type: 'object'}},
			required: ['fight', 'action']},
		run: args => {
			const bundle = fights.get(args.fight);
			if (!bundle) throw new Error('no fight ' + JSON.stringify(args.fight));
			const reply = driver.act(bundle, args.action);
			fights.set(args.fight, reply.battle);
			return fightView(reply.battle, reply);
		},
	},
	evaluate: {
		description: 'Play a fight over many seeds with the box as it stands: policy "decide" (the playthrough ' +
			'policy) or "search" (rollouts, slower). repick:true lets the ranker choose the six first. Returns ' +
			'wins, and per seed the result, turns and foes left.',
		schema: {type: 'object', properties: {box: {type: 'string'}, trainer: {type: 'string'},
			seeds: {type: 'number'}, policy: {type: 'string', enum: ['decide', 'search']},
			rollouts: {type: 'number'}, repick: {type: 'boolean'}}, required: ['box', 'trainer']},
		run: args => {
			const policy = require('./ui-playthrough.js');
			const saved = process.argv;
			process.argv = ['node', 'engine-mcp', '--pick-by-play=0', '--repick-party=' + (args.repick ? '1' : '0')];
			try {
				const doc = battery.prepareDocument(box(args.box), args.trainer, policy).doc;
				const rows = [];
				for (let seed = 1; seed <= (args.seeds || 10); seed++) {
					const played = battery.playScenario(policy, doc, args.trainer, seed, undefined,
						{search: args.policy === 'search' ? (args.rollouts || 8) : 0});
					rows.push({seed, result: played.result, turns: played.turns,
						foesLeft: played.foe ? played.foe.alive : null, refusals: played.engineRefusals});
				}
				return {wins: rows.filter(row => row.result === 'win').length, of: rows.length,
					party: doc.party, rows};
			} finally {
				process.argv = saved;
			}
		},
	},
};

function reply(id, result) {
	process.stdout.write(JSON.stringify({jsonrpc: '2.0', id, result}) + '\n');
}

function fail(id, code, message) {
	process.stdout.write(JSON.stringify({jsonrpc: '2.0', id, error: {code, message}}) + '\n');
}

function handle(message) {
	const id = message.id;
	if (message.method === 'initialize') {
		return reply(id, {protocolVersion: (message.params && message.params.protocolVersion) || '2024-11-05',
			capabilities: {tools: {}}, serverInfo: {name: 'runbun-engine', version: '0.1.0'}});
	}
	if (message.method === 'ping') return reply(id, {});
	if (message.method === 'tools/list') {
		return reply(id, {tools: Object.keys(TOOLS).map(name => ({name, description: TOOLS[name].description,
			inputSchema: TOOLS[name].schema}))});
	}
	if (message.method === 'tools/call') {
		const tool = TOOLS[message.params && message.params.name];
		if (!tool) return fail(id, -32602, 'unknown tool ' + JSON.stringify(message.params && message.params.name));
		try {
			const result = tool.run((message.params && message.params.arguments) || {});
			return reply(id, {content: [{type: 'text', text: JSON.stringify(result)}]});
		} catch (error) {
			return reply(id, {content: [{type: 'text', text: 'error: ' + error.message}], isError: true});
		}
	}
	if (id === undefined) return null;
	return fail(id, -32601, 'method not found: ' + message.method);
}

if (require.main === module) {
	// Anything a library prints would corrupt the protocol stream.
	console.log = (...parts) => process.stderr.write(parts.join(' ') + '\n');
	const lines = readline.createInterface({input: process.stdin});
	lines.on('line', line => {
		if (!line.trim()) return;
		let message;
		try {
			message = JSON.parse(line);
		} catch (error) {
			fail(null, -32700, 'parse error');
			return;
		}
		handle(message);
	});
}

module.exports = {handle, TOOLS};
