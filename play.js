/* eslint-env node, es6 */
'use strict';

/**
 * Play a run from the terminal.
 *
 * `run.js` is the document and the rules; this is the save file and the verbs.
 * Every subcommand loads a run from JSON, applies one command, and writes it
 * back — so the file on disk is always a complete, readable record of the
 * playthrough, and nothing lives in memory between invocations.
 *
 *   node play.js new --file run.json --name "Nuzlocke" --cap
 *   node play.js where Route114
 *   node play.js catch Marill --map Route114 --level 40
 *   node play.js evolve mon-1
 *   node play.js teach mon-1 "Play Rough" --replace "Aqua Tail"
 *   node play.js party mon-1 mon-2
 *   node play.js plan
 *   node play.js beat "Youngster Calvin"
 *   node play.js status
 *   node play.js undo
 *
 * The file defaults to `run.json` in the working directory, so the common case
 * needs no `--file` at all.
 *
 * Read-only subcommands (`status`, `box`, `where`, `find`, `learn`, `next`,
 * `plan`, `matrix`, `log`, `milestones`) do not write, so they are safe to run
 * mid-thought without perturbing the save. `READ_ONLY` below is the list that
 * enforces it.
 */

const fs = require('node:fs');
const path = require('node:path');

const runtime = require('./run');
const getProfile = require('./profiles').getProfile;

const DEFAULT_FILE = 'run.json';

function load(file) {
	if (!fs.existsSync(file)) {
		throw new Error(`no run at ${file}; start one with: node play.js new --file ${file}`);
	}
	const state = JSON.parse(fs.readFileSync(file, 'utf8'));
	if (state.version !== runtime.VERSION) {
		throw new Error(
			`${file} is a version ${state.version} run; this build reads version ${runtime.VERSION}`);
	}
	return state;
}

function save(file, state) {
	fs.writeFileSync(file, `${JSON.stringify(state, null, '\t')}\n`);
}

/** ISO to the second. Passed into `run.js` rather than read there — see run.js. */
function now() {
	return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

// ------------------------------------------------------------------- rendering

function renderMon(mon, party) {
	const slot = party.indexOf(mon.id);
	const where = mon.status === 'dead' ? 'lost' :
		slot === -1 ? 'box' : `party ${slot + 1}`;
	const name = mon.nickname ? `${mon.nickname} the ${mon.species}` : mon.species;
	const origin = mon.origin && mon.origin.mapName ?
		`${mon.origin.method} · ${mon.origin.mapName}` :
		'declared';
	return `  ${mon.id.padEnd(7)} ${name} L${mon.level}`.padEnd(46) +
		`${where.padEnd(9)} ${(mon.item || '—').padEnd(14)} ${origin}\n` +
		`          ${mon.moves.join(', ') || '(no moves)'}`;
}

function renderStatus(state) {
	const summary = runtime.summarize(state);
	const lines = [];
	lines.push(`${summary.name} — ${summary.profileId}`);
	if (summary.split) {
		lines.push(`split ${summary.split.index} / ${summary.split.of} — ${summary.split.boss}`);
	}
	lines.push(summary.next ?
		`next: #${summary.next.order} ${summary.next.trainer}` :
		'next: the run map is finished');
	if (summary.levelCap.cap !== null) {
		lines.push(`level cap: ${summary.levelCap.cap} ` +
			`(${summary.levelCap.trainer}'s ${summary.levelCap.ace})`);
	}
	lines.push(`box: ${summary.boxed}` + (summary.lost ? `, lost: ${summary.lost}` : '') +
		`  ·  ${summary.commands} commands`);
	lines.push('');
	if (!state.box.length) {
		lines.push('  (nothing caught yet)');
	} else {
		// Party first and in order: the party is what the player is looking at.
		const ordered = state.party
			.map(id => runtime.findMon(state, id))
			.concat(state.box.filter(mon => !state.party.includes(mon.id)));
		for (const mon of ordered) lines.push(renderMon(mon, state.party));
	}
	const bag = Object.keys(summary.bag);
	if (bag.length) {
		lines.push('');
		lines.push(`bag: ${bag.map(item => `${item} x${summary.bag[item]}`).join(', ')}`);
	}
	return lines.join('\n');
}

function renderEncounters(found) {
	const lines = [`${found.name} (${found.map})`];
	if (found.used) {
		lines.push(`  route used — its encounter was ${found.used.species} L${found.used.level}`);
	}
	const byMethod = {};
	for (const mon of found.mons) (byMethod[mon.method] = byMethod[mon.method] || []).push(mon);
	for (const method of Object.keys(byMethod)) {
		lines.push(`  ${method}:`);
		for (const mon of byMethod[method]) {
			// Under the nuzlocke rules the odds column is the one that matters:
			// chance renormalized over the rows a re-roll can actually keep.
			const odds = mon.dupe ? 'dupe' :
				typeof mon.odds === 'number' ? `${mon.odds}%` :
					typeof mon.chance === 'number' ? `${mon.chance}%` : '';
			lines.push(`    ${mon.owned ? '✓' : ' '} ${mon.species.padEnd(22)} ` +
				`L${mon.minLevel}${mon.maxLevel === mon.minLevel ? '' : `-${mon.maxLevel}`}`.padEnd(8) +
				`${odds.padStart(6)}${mon.rod ? `  ${mon.rod}` : ''}`);
		}
	}
	return lines.join('\n');
}

function renderPlan(plan) {
	const lines = [`${plan.trainer} (#${plan.order})`];
	lines.push(plan.confidence === 'contested' ?
		`  contested by ${plan.margin} — plan for both` :
		plan.confidence === 'only-option' ? '  only one action available' :
			`  decided by ${plan.margin}`);
	for (const action of plan.actions.slice(0, 5)) {
		lines.push(`    ${action.score.toFixed(2).padStart(6)}  ${action.label}`);
	}
	return lines.join('\n');
}

/** How the arrows read: we move first, they move first, or it is a coin flip. */
const SPEED_ARROW = {faster: '>', slower: '<', tie: '='};

/**
 * One side of a cell: what it leads with and how much of the other's bar goes.
 *
 * Percentages, because the fractions are only comparable across a grid and a
 * player reads a bar in percent. `KO` is the guaranteed one and `KO?` the roll
 * — the difference between a plan and a gamble, so they must not render alike.
 */
function renderMatchupSide(side) {
	if (!side.move) return '—';
	const marks = side.guaranteedKO ? ' KO' : side.possibleKO ? ' KO?' : '';
	return `${side.move} ${Math.round(side.max * 100)}%${marks}`;
}

/**
 * The box grid, one block per opposing Pokemon.
 *
 * Blocked by THEIR Pokemon rather than ours because that is the order the
 * question comes in: a player is looking at a boss's lead and asking who in the
 * box answers it, and a block per enemy puts all six answers under one heading.
 */
function renderMatrix(matrix) {
	const lines = [`${matrix.trainer} (#${matrix.order})`];
	if (matrix.projection && matrix.projection.applied) {
		lines.push(`  box at the cap it is fought under: L${matrix.projection.cap}` +
			(matrix.projection.from === 'projected' ? ' (projected)' : ''));
	}
	for (const cell of matrix.grid) {
		lines.push('');
		lines.push(`  ${cell.enemy.species} L${cell.enemy.level}`);
		cell.versus.forEach((row, i) => {
			const entry = matrix.box[i];
			const name = entry.nickname ? `${entry.nickname} the ${row.species}` : row.species;
			// The id leads: the next thing a player does with this grid is put one
			// of these in the party, and that command takes ids, not species.
			lines.push(`    ${SPEED_ARROW[row.speed] || '?'} ${entry.id.padEnd(7)} ` +
				`${`${name} L${row.level}`.padEnd(28)}` +
				`${renderMatchupSide(row.us).padEnd(26)}${renderMatchupSide(row.them)}`);
		});
	}
	return lines.join('\n');
}

// ------------------------------------------------------------------ subcommands

/**
 * Flags are parsed generically so a subcommand can take what it needs without
 * each one re-implementing an argument loop. Bare words become positional.
 */
function parseArgs(argv) {
	const positional = [];
	const flags = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith('--')) {
			positional.push(arg);
			continue;
		}
		const name = arg.slice(2);
		const next = argv[i + 1];
		if (next === undefined || next.startsWith('--')) {
			flags[name] = true;
		} else {
			flags[name] = next;
			i++;
		}
	}
	return {positional, flags};
}

const SUBCOMMANDS = {
	new(state, args, file) {
		if (fs.existsSync(file) && !args.flags.force) {
			throw new Error(`${file} already exists; pass --force to start over`);
		}
		const created = runtime.createRun({
			name: args.flags.name || path.basename(file, '.json'),
			// The caps are the game's own (hardcoded, candy-gated), so they are on
			// by default; --no-cap is the escape hatch for free editing.
			levelCap: args.flags['no-cap'] ? 'none' : 'next-milestone-ace',
			permadeath: !!args.flags.nuzlocke,
			// Named for the rival's ace, which the starter choice fixes. Without it
			// all three variants of each rival fight stay visible.
			rival: args.flags.rival || null,
			now: now(),
		});
		return {state: created, message: `started ${created.name} at ${file}`};
	},

	status(state) {
		return {message: renderStatus(state)};
	},

	box(state) {
		return {message: renderStatus(state)};
	},

	/** What lives on a map, and what this run already has from it. */
	where(state, args) {
		const map = args.positional.join(' ');
		if (!map) throw new Error('where: name a map, e.g. `where Route114`');
		const found = runtime.encountersOn(state, map);
		if (!found) {
			// A wrong map name is the most likely mistake, so suggest rather than
			// just refusing.
			const oracle = getProfile(state.profileId).oracle;
			const needle = map.toLowerCase().replace(/[^a-z0-9]/g, '');
			const near = oracle.maps()
				.filter(m => m.name.toLowerCase().replace(/[^a-z0-9]/g, '').includes(needle))
				.slice(0, 8)
				.map(m => m.name);
			throw new Error(`no map named ${JSON.stringify(map)}` +
				(near.length ? `; did you mean: ${near.join(', ')}` : ''));
		}
		return {message: renderEncounters(found)};
	},

	/** Every place a species can be caught. The inverse of `where`. */
	find(state, args) {
		const species = args.positional.join(' ');
		if (!species) throw new Error('find: name a species, e.g. `find Feebas`');
		const spots = getProfile(state.profileId).oracle.whereToFind(species);
		if (!spots.length) {
			return {message: `${species} is in no wild encounter table. ` +
				'Gifts, statics, trades and starters are scripted — catch it with no --map.'};
		}
		return {message: spots.map(spot =>
			`  ${spot.name.padEnd(30)} ${spot.method.padEnd(11)} ` +
			`L${spot.minLevel}-${spot.maxLevel}${spot.rod ? `  ${spot.rod}` : ''}`).join('\n')};
	},

	catch(state, args) {
		const species = args.positional.join(' ');
		if (!species) throw new Error('catch: name a species');
		return {
			command: {
				kind: 'catch',
				species,
				map: args.flags.map,
				method: args.flags.method,
				level: Number(args.flags.level),
				nickname: args.flags.name,
				nature: args.flags.nature,
				ability: args.flags.ability,
				item: args.flags.item,
				moves: args.flags.moves ? String(args.flags.moves).split(',').map(m => m.trim()) : undefined,
			},
		};
	},

	level(state, args) {
		const to = args.positional[1] === 'cap' ? 'cap' : Number(args.positional[1]);
		return {command: {kind: 'levelUp', id: args.positional[0], to}};
	},

	evolve(state, args) {
		return {command: {kind: 'evolve', id: args.positional[0], into: args.flags.into}};
	},

	teach(state, args) {
		const id = args.positional[0];
		const move = args.positional.slice(1).join(' ');
		return {command: {kind: 'teach', id, move, replace: args.flags.replace}};
	},

	/** What a box entry could learn, split by whether it can learn it yet. */
	learn(state, args) {
		const detail = runtime.learnable(state, args.positional[0]);
		const lines = [];
		lines.push(`now (${detail.now.length}):`);
		lines.push(`  ${detail.now.map(entry => entry.move).join(', ') || '(nothing)'}`);
		if (detail.later.length) {
			lines.push(`later (${detail.later.length}):`);
			lines.push(`  ${detail.later.map(e => `${e.move} @${e.level}`).join(', ')}`);
		}
		return {message: lines.join('\n')};
	},

	give(state, args) {
		return {command: {kind: 'give', id: args.positional[0], item: args.positional.slice(1).join(' ')}};
	},

	take(state, args) {
		return {command: {kind: 'take', id: args.positional[0]}};
	},

	acquire(state, args) {
		return {
			command: {
				kind: 'acquire',
				item: args.positional.join(' '),
				count: args.flags.count === undefined ? 1 : Number(args.flags.count),
			},
		};
	},

	party(state, args) {
		return {command: {kind: 'party', ids: args.positional}};
	},

	nickname(state, args) {
		return {
			command: {
				kind: 'nickname',
				id: args.positional[0],
				nickname: args.positional.slice(1).join(' '),
			},
		};
	},

	faint(state, args) {
		return {command: {
			kind: 'faint',
			id: args.positional[0],
			// The epitaph: who did it, and with what. `--to` is checked against
			// the run map; `--move` is free text.
			...(args.flags.to ? {to: args.flags.to} : {}),
			...(args.flags.move ? {move: args.flags.move} : {}),
		}};
	},

	/** The graveyard: every loss, with its epitaph. */
	graveyard(state) {
		const lost = state.box.filter(mon => mon.status === 'dead');
		if (!lost.length) return {message: 'nobody lost yet'};
		const lines = [`${lost.length} lost`];
		for (const mon of lost) {
			const name = mon.nickname ? `${mon.nickname} the ${mon.species}` : mon.species;
			const from = mon.origin && mon.origin.mapName ? ` — from ${mon.origin.mapName}` : '';
			const died = mon.died && mon.died.to ?
				`  killed by ${mon.died.to}${mon.died.move ? `'s ${mon.died.move}` : ''} (#${mon.died.order})` :
				'  cause unrecorded';
			lines.push(`  ${name} L${mon.level}${from}`);
			lines.push(died);
		}
		return {message: lines.join('\n')};
	},

	release(state, args) {
		return {command: {kind: 'release', id: args.positional[0]}};
	},

	beat(state, args) {
		return {command: {kind: 'beat', trainer: args.positional.join(' ')}};
	},

	/**
	 * The routes still holding an unspent encounter, best prospects first.
	 * `--all` includes the spent ones. Order is the decomp's declaration order —
	 * roughly geography, NOT unlock order, which is not data this profile has.
	 */
	routes(state, args) {
		const all = runtime.unusedRoutes(state);
		const unused = all.routes.filter(route => !route.used);
		const used = all.routes.filter(route => route.used);
		const lines = [`${unused.length} routes still hold an encounter (${used.length} used)` +
			' — declaration order, not unlock order'];
		for (const route of unused) {
			const best = route.best
				.map(mon => `${mon.species} ${mon.chance}%${mon.method === 'walk' ? '' : ` ${mon.method}`}`)
				.join(', ');
			lines.push(`  ${route.name.padEnd(34)} ${best || '(everything here is a dupe)'}`);
		}
		if (args.flags.all && used.length) {
			lines.push('  used:');
			for (const route of used) {
				lines.push(`    ${route.name.padEnd(32)} gave ${route.used.species} L${route.used.level}`);
			}
		}
		return {message: lines.join('\n')};
	},

	/** The split as one sheet: boss, cap, remaining gauntlet, filler count. */
	split(state) {
		const prep = runtime.splitPrep(state);
		if (!prep) return {message: 'this profile declares no splits'};
		if (prep.split.finished) return {message: 'the run map is finished — no split ahead'};
		const lines = [
			`${prep.split.boss.replace(/^Leader /, '')} split (${prep.split.index}/${prep.split.of})` +
				` — boss #${prep.split.order} ${prep.split.boss}`,
			prep.cap.cap === null ? '  no level cap' :
				`  cap now ${prep.cap.cap} (${prep.cap.trainer}'s ${prep.cap.ace})`,
			`  ${prep.fightsAhead} fights left in the split, ${prep.filler} of them filler`,
			'  gauntlet:',
		];
		for (const fight of prep.gauntlet) {
			lines.push(`    #${String(fight.order).padStart(4)}  ${fight.trainer.padEnd(34)}` +
				`${fight.tier.padEnd(6)} ${fight.partySize} mons` +
				(fight.cap !== undefined ? `  cap ${fight.cap}` : ''));
		}
		return {message: lines.join('\n')};
	},

	/** The story spine: milestones beaten and ahead. Where "where am I" lives. */
	milestones(state) {
		const spine = runtime.milestones(state);
		const done = spine.filter(m => m.beaten).length;
		const lines = [`${done} / ${spine.length} milestones`];
		for (const m of spine) {
			lines.push(`  ${m.beaten ? '\u2713' : '\u00b7'} #${String(m.order).padStart(4)}  ${m.trainer}`);
		}
		return {message: lines.join('\n')};
	},

	/** The fights ahead of where the run has got to. */
	next(state, args) {
		const count = args.flags.count ? Number(args.flags.count) : 5;
		const ahead = runtime.upcoming(state, count);
		const profile = getProfile(state.profileId);
		return {message: ahead.map(fight => {
			const tier = runtime.fightTier(profile, fight.trainer);
			return `  #${String(fight.order).padStart(4)}  ${fight.trainer.padEnd(38)} ` +
				`${fight.party.length} mons, up to L${Math.max(...fight.party.map(m => m.level))}` +
				(tier ? `  [${tier}]` : '');
		}).join('\n')};
	},

	/** The whole stack: this box, this position, what the next trainer does. */
	plan(state, args) {
		return {message: renderPlan(runtime.planNext(state,
			args.positional.length ? {trainer: args.positional.join(' ')} : {}))};
	},

	/** The whole box against one trainer, both directions. Which six, answered. */
	matrix(state, args) {
		return {message: renderMatrix(runtime.boxMatrix(state,
			args.positional.length ? args.positional.join(' ') : undefined))};
	},

	undo(state) {
		const undone = runtime.undo(state);
		const dropped = state.log[state.log.length - 1];
		return {state: undone, message: `undid: ${dropped.summary}`};
	},

	log(state, args) {
		const count = args.flags.count ? Number(args.flags.count) : 20;
		return {message: state.log.slice(-count)
			.map((entry, i) => `  ${String(state.log.length - Math.min(count, state.log.length) + i + 1)
				.padStart(4)}  ${entry.summary}`).join('\n')};
	},
};

/** Subcommands that never write, so they can run against a save freely. */
const READ_ONLY = new Set(['status', 'box', 'where', 'find', 'learn', 'next', 'plan', 'matrix',
	'log', 'milestones', 'split', 'routes', 'graveyard']);

const USAGE = `node play.js <command> [args] [--file run.json]

  new [--name N] [--no-cap] [--nuzlocke] [--rival Swampert] [--force]   start a run (game caps on by default)
  status / box                                    the box, party, bag and position
  where <map>                                     what can be caught there
  find <species>                                  everywhere it can be caught
  catch <species> --level N [--map M] [--name N]  add to the box
  level <id> <n|cap>                              raise a level; 'cap' is free, over-cap spends Rare Candy
  evolve <id> [--into S]                          evolve
  learn <id>                                      what it can learn, now and later
  teach <id> <move> [--replace M]                 teach a move
  give <id> <item> / take <id>                    hold items
  acquire <item> [--count N]                      add to the bag
  party <id> [<id>...]                            set the party, in order
  nickname <id> <name>                            rename
  faint <id> [--to Trainer] [--move M]            lose one, with its epitaph
  release <id>                                    let one go
  graveyard                                       the lost, and what did it
  beat <trainer>                                  move the run forward
  next [--count N] / plan [trainer]               what is ahead, and what it does
  matrix [trainer]                                the whole box against theirs, both ways
  routes [--all]                                  routes still holding an encounter
  split                                           this split: boss, cap, gauntlet, filler
  milestones                                      the story spine, beaten and ahead
  log [--count N] / undo                          history`;

function main(argv) {
	const name = argv[0];
	if (!name || name === '--help' || name === 'help') {
		console.log(USAGE);
		return;
	}
	const subcommand = SUBCOMMANDS[name];
	if (!subcommand) {
		throw new Error(`unknown command ${JSON.stringify(name)}\n\n${USAGE}`);
	}
	const args = parseArgs(argv.slice(1));
	const file = args.flags.file || DEFAULT_FILE;

	const state = name === 'new' ? null : load(file);
	const result = subcommand(state, args, file);

	if (result.command) {
		const next = runtime.apply(state, result.command, {now: now()});
		save(file, next);
		console.log(next.log[next.log.length - 1].summary);
		return;
	}
	if (result.state) {
		save(file, result.state);
		if (result.message) console.log(result.message);
		return;
	}
	if (!READ_ONLY.has(name)) {
		throw new Error(`${name} produced neither a command nor a state`);
	}
	console.log(result.message);
}

if (require.main === module) {
	try {
		main(process.argv.slice(2));
	} catch (error) {
		console.error(`play: ${error.message}`);
		process.exitCode = 1;
	}
}

module.exports = {
	main, parseArgs, renderStatus, renderEncounters, renderPlan, renderMatrix,
	SUBCOMMANDS, USAGE,
};
