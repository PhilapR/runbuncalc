/* eslint-env node, es6 */
'use strict';

/**
 * Run simulation (L5, batch).
 *
 * `planner.predict` answers one fight. A player is not planning one fight —
 * they are asking whether a team survives a stretch of the run, and where it
 * stops surviving. That question is the same call made repeatedly, but the
 * answer only becomes useful once the results sit next to each other: a fight
 * whose top two actions are 0.15 apart reads as a coin flip only when the
 * fights around it are decided by 6.
 *
 * So this module owns exactly two things the planner does not:
 *
 *   1. a walk over the run map (milestones, or a window, or everything), and
 *   2. an aggregate — how many fights are actually decided, which ones are not,
 *      and how far under-levelled the team is at each stop.
 *
 * It adds no rules and no scores. Every number here came out of `predict`.
 *
 * Level deltas matter more than they look. A single team walked from Brawly to
 * Wallace is 5 to 100, so a simulation that reports only confidence would read
 * as a clean plan while the team is fifty levels short. The delta is printed on
 * every row for that reason: a contested fight against a team twenty levels
 * down is not a coin flip, it is a loss.
 *
 * The team is the player's, declared as a Showdown paste (`team.js`). It used to
 * be `Species (Set Label)` — a lookup into the trainer table — which put a
 * TRAINER'S build on the player's side and quietly changed the answer: Norman's
 * Porygon2 reads `contested by 1.1` across from Steven's level 89 Metagross and
 * `decided by 6.4` across from a level 45 Swampert a player could actually own.
 * That path survives as `--borrow`, flagged on every row that uses it.
 *
 * A team can also be a RUN (`--run`, the L6 document). Then the walk is not a
 * hypothetical stretch of map but the rest of THIS playthrough: it starts after
 * the run's position, skips the rival variants the starter choice ruled out, and
 * plans every stop with the party the run will legally have AT that stop —
 * because the free candy levels the box to the cap of the fight being fought, so
 * a walk built from today's levels reports a team the player never fields. That
 * is `run.planNext`'s projection, once per row instead of once.
 *
 * Reading the save and knowing the cap rules both stay in `run.js`: this file
 * asks it for fights and for party specs and stays a tool that takes explicit
 * inputs, which is what keeps it usable for a team nobody owns.
 *
 * CLI:
 *   node simulate.js --team-file team.txt --milestones
 *   node simulate.js --team-file team.txt --from 0 --count 10 --json
 *   node simulate.js --borrow "Azumarill (Leader Norman)" --from 0 --count 5
 *   node simulate.js --run run.json --milestones
 */

const fs = require('node:fs');

const planner = require('./planner');
const playerTeam = require('./team');
const runtime = require('./run');
const getProfile = require('./profiles').getProfile;

/**
 * `Species (Set Label)` — the BORROWED form. Kept for the question it genuinely
 * answers ("what does this trainer do into that trainer's Pokemon") and for
 * reaching any build in the run map without typing it out. Not a player team;
 * see `team.js`.
 *
 * Parsed here rather than shared with `planner_panel.js` because that file is a
 * classic browser script with no module boundary to import across; the grammar
 * is one line and duplicating it beats bridging two loaders.
 */
function parseBorrowedTeam(text) {
	const party = [];
	// Scanned rather than split on commas: set labels are trainer names, and a
	// trainer name is free to contain a comma. Consuming `Species (Label)` groups
	// and then insisting the whole string was consumed catches a typo instead of
	// silently planning with a party the caller did not write.
	const pattern = /\s*([^(),]+?)\s*\(([^)]*)\)\s*(?:,|$)/gy;
	const source = String(text || '').trim();
	// A sticky regex resets `lastIndex` to 0 the moment `exec` fails, so how far
	// the scan actually got has to be recorded while it is still succeeding.
	let consumed = 0;
	let match;
	while ((match = pattern.exec(source)) !== null) {
		party.push({species: match[1].trim(), setLabel: match[2].trim()});
		consumed = pattern.lastIndex;
	}
	if (consumed !== source.length) {
		throw new Error(
			'expected "Species (Set Label), Species (Set Label)"; could not read ' +
			JSON.stringify(source.slice(consumed))
		);
	}
	if (!party.length) throw new Error('a simulation needs at least one Pokemon');
	return party;
}

/**
 * The fights to walk.
 *
 * `milestones` uses the pattern the profile declares, so the notion of "story
 * fight" stays with the game rather than with this tool. A profile that
 * declares none falls back to the whole run map — wrong-looking output beats a
 * silent empty walk.
 *
 * A run walks its OWN map: the fights ahead of where it has got to, minus the
 * rival variants its declared starter rules out. Both come from `run.upcoming`
 * rather than being re-derived here — a second copy of the variant filter is a
 * second place to offer a player a fight they can never stand in front of.
 */
function selectFights(options) {
	const opts = options || {};
	const source = opts.run || null;
	// A run names the game it is being played in; --profile cannot overrule the
	// document it would be reading against.
	const profile = getProfile(source ? source.profileId : opts.profileId);
	if (source && typeof opts.from === 'number') {
		throw new Error('--from does not compose with --run: the run knows where it is, ' +
			'and the walk starts at the fight after its position');
	}
	// Everything, not a page: `--to` and `--count` below are what narrow the walk,
	// and `upcoming`'s own default of five would silently truncate it first.
	let fights = source ?
		runtime.upcoming(source, Infinity) :
		planner.loadRunMap(opts.profileId);

	if (opts.milestones) {
		const pattern = profile.encounters.MILESTONE_PATTERN;
		if (pattern) fights = fights.filter(f => pattern.test(f.trainer));
	}
	if (typeof opts.from === 'number') fights = fights.filter(f => f.order >= opts.from);
	if (typeof opts.to === 'number') fights = fights.filter(f => f.order <= opts.to);
	if (typeof opts.count === 'number') fights = fights.slice(0, opts.count);
	return fights;
}

/**
 * Walk a team through a stretch of the run.
 *
 * A fight that cannot be built is recorded as an error row rather than aborting
 * the walk: one unbuildable position should not hide the twenty that worked.
 */
function simulate(options) {
	const opts = options || {};
	const source = opts.run || null;
	const profileId = source ? source.profileId : opts.profileId;
	// The run's party as it stands today. It is the header, not the plan: what
	// each row is actually planned with is projected per fight below.
	const party = source ? runtime.partySpecs(source) : opts.party;
	if (!party || !party.length) {
		throw new Error(source ?
			'the run\'s party is empty: put Pokemon in the party before simulating' :
			'party is required');
	}
	const fights = selectFights(opts);

	const steps = [];
	for (const fight of fights) {
		const lead = fight.party[0];
		const step = {
			order: fight.order,
			trainer: fight.trainer,
			isDouble: fight.isDouble,
			partySize: fight.party.length,
			lead: {species: lead.species, level: lead.level, ability: lead.ability},
			// Highest level in the opposing party, not the lead's: a player is
			// levelled against the fight, not against whatever leads it.
			opponentLevel: Math.max(...fight.party.map(m => m.level)),
		};
		try {
			// A run plans every stop at the levels it would legally have THERE. The
			// cap is a stretch of map, so Norman's row is fought at Norman's cap while
			// the filler before him is fought at the last boss's — one party reused
			// across the walk gets both wrong.
			const playing = source ? runtime.partySpecs(source, {atOrder: fight.order}) : party;
			const result = planner.predict({
				trainer: fight.trainer,
				playerParty: playing,
				profileId,
			});
			step.confidence = result.confidence;
			step.margin = result.margin;
			step.actions = result.actions.slice(0, opts.actions || 3)
				.map(a => ({label: a.label, score: Number(a.score.toFixed(2))}));
			step.playerLevel = result.state.sides.player.party[0].level;
			step.levelDelta = step.playerLevel - step.opponentLevel;
			step.borrowedPlayerBuild = result.borrowedPlayerBuild;
		} catch (error) {
			step.error = error.message;
		}
		steps.push(step);
	}

	const planned = steps.filter(s => !s.error);
	return {
		party,
		// Which run this walk is of, or null for a declared team. Carried on the
		// result rather than left to the CLI so a JSON consumer cannot present
		// projected levels as the box the player is looking at right now.
		run: source ? {
			name: source.name,
			position: source.position,
			capProjected: source.rules.levelCap !== 'none',
		} : null,
		notes: opts.notes || [],
		steps,
		summary: {
			// A run planned against a trainer's build is not a plan for a team the
			// player owns. Carried on the result rather than left to the CLI, so a
			// JSON consumer cannot present it as one either.
			borrowedPlayerBuild: planned.some(s => s.borrowedPlayerBuild),
			fights: steps.length,
			planned: planned.length,
			failed: steps.length - planned.length,
			decided: planned.filter(s => s.confidence === 'decided').length,
			contested: planned.filter(s => s.confidence === 'contested').length,
			onlyOption: planned.filter(s => s.confidence === 'only-option').length,
			// The fights where the plan rests on which of two actions the AI rolls.
			// Listed rather than counted: a count says "seven coin flips", the list
			// says which seven, and only the list is actionable.
			coinFlips: planned
				.filter(s => s.confidence === 'contested')
				.map(s => ({order: s.order, trainer: s.trainer, margin: s.margin})),
			// Under-levelled stops, worst first. A simulation that reports only
			// confidence looks clean while the team is unplayably short.
			underLevelled: planned
				.filter(s => s.levelDelta < 0)
				.sort((a, b) => a.levelDelta - b.levelDelta)
				.map(s => ({order: s.order, trainer: s.trainer, levelDelta: s.levelDelta})),
		},
	};
}

/**
 * Human-readable rendering. `--json` skips this entirely.
 *
 * The argument is a walk, not a run: with `--run` in the picture, `run` is the
 * document, and `sim.run` is which document this walk was of.
 */
function format(sim) {
	const lines = [];
	if (sim.run) {
		// The levels on the rows below are not the levels in the box, and a reader
		// who assumes they are will read the whole page as a report on their team
		// today. Said once, at the top, before any row can mislead.
		lines.push(`run: ${sim.run.name} — the map from #${sim.run.position + 1} onward, ` +
			(sim.run.capProjected ?
				'each row planned at the level cap of that fight' :
				'at the levels the box holds (this run declines caps)'));
	}
	lines.push('team: ' + sim.party
		.map(m => m.setLabel ?
			`${m.species} (${m.setLabel})` :
			`${m.species} L${m.level}${m.item ? ` @ ${m.item}` : ''}`)
		.join(', '));
	if (sim.summary.borrowedPlayerBuild) {
		lines.push('WARNING: this team is built from trainer sets. Those are not player-' +
			'obtainable builds — levels, items, natures and IVs are the trainer\'s, and ' +
			'the AI scores against them, so the ranking below is not a plan for a real box.');
	}
	for (const note of sim.notes) lines.push(`note: ${note}`);
	lines.push('');
	for (const step of sim.steps) {
		const head = `#${String(step.order).padStart(4)}  ${step.trainer}`;
		if (step.error) {
			lines.push(`${head}\n        could not plan: ${step.error}`);
			continue;
		}
		const delta = step.levelDelta === 0 ? 'level' :
			step.levelDelta > 0 ? `+${step.levelDelta}` : String(step.levelDelta);
		lines.push(
			`${head}  (${step.partySize})\n` +
			`        lead ${step.lead.species} L${step.lead.level} · ${step.lead.ability}` +
			`   you L${step.playerLevel} (${delta})\n` +
			`        ${step.confidence}${step.margin === undefined ? '' : ` by ${step.margin}`}: ` +
			step.actions.map(a => `${a.label} ${a.score.toFixed(2)}`).join('  |  ')
		);
	}
	const s = sim.summary;
	lines.push('');
	lines.push(`${s.planned}/${s.fights} fights planned — ` +
		`${s.decided} decided, ${s.contested} contested, ${s.onlyOption} forced` +
		(s.failed ? `, ${s.failed} unbuildable` : ''));
	if (s.coinFlips.length) {
		lines.push('coin flips: ' + s.coinFlips
			.map(c => `${c.trainer} (${c.margin})`).join(', '));
	}
	if (s.underLevelled.length) {
		const worst = s.underLevelled.slice(0, 5);
		lines.push(`under-levelled at ${s.underLevelled.length} stops, worst: ` +
			worst.map(u => `${u.trainer} ${u.levelDelta}`).join(', '));
	}
	return lines.join('\n');
}

function parseArgs(argv) {
	const opts = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--milestones') opts.milestones = true;
		else if (arg === '--json') opts.json = true;
		else if (arg === '--team-file') opts.teamFile = argv[++i];
		else if (arg === '--team') opts.teamPaste = argv[++i];
		else if (arg === '--borrow') opts.borrow = argv[++i];
		else if (arg === '--run') opts.runFile = argv[++i];
		else if (arg === '--profile') opts.profileId = argv[++i];
		else if (arg === '--from') opts.from = Number(argv[++i]);
		else if (arg === '--to') opts.to = Number(argv[++i]);
		else if (arg === '--count') opts.count = Number(argv[++i]);
		else if (arg === '--actions') opts.actions = Number(argv[++i]);
		else throw new Error(`unknown argument ${JSON.stringify(arg)}`);
	}
	return opts;
}

/**
 * Load a run document.
 *
 * Version-checked the way `play.js` checks it: a document written by another
 * build may not mean what this one would read into it, and a walk over a misread
 * box is worse than a refusal, because it looks like a plan.
 */
function loadRun(file) {
	const state = JSON.parse(fs.readFileSync(file, 'utf8'));
	if (state.version !== runtime.VERSION) {
		throw new Error(
			`${file} is a version ${state.version} run; this build reads version ${runtime.VERSION}`);
	}
	return state;
}

/**
 * Resolve whichever form the caller used into what the walk needs: `{party,
 * notes}` for a declared team, or `{run}` for a document that produces its own
 * party at every stop.
 *
 * Exactly one form, always. Accepting two and silently preferring one would
 * mean a caller who passes both plans with a team they did not intend, and the
 * forms are precisely the ones whose difference changes the answer — a pasted
 * team is a hypothetical, a run is the box that actually exists.
 */
function resolveParty(opts) {
	const given = ['teamFile', 'teamPaste', 'borrow', 'runFile']
		.filter(key => opts[key] !== undefined);
	if (given.length > 1) {
		throw new Error(`pass one of --team-file, --team, --borrow, --run — got ${given.length}`);
	}
	if (opts.runFile !== undefined) return {run: loadRun(opts.runFile)};
	if (opts.borrow !== undefined) return {party: parseBorrowedTeam(opts.borrow), notes: []};
	if (opts.teamFile !== undefined) {
		return playerTeam.parseTeam(fs.readFileSync(opts.teamFile, 'utf8'));
	}
	if (opts.teamPaste !== undefined) return playerTeam.parseTeam(opts.teamPaste);
	throw new Error(
		'a team is required:\n' +
		'  --team-file team.txt      a Showdown paste — the player\'s own box\n' +
		'  --team "Swampert @ …"     the same paste, inline\n' +
		'  --borrow "Species (Set)"  a trainer\'s build, for asking about that build\n' +
		'  --run run.json            a saved run: its own party, from its own position'
	);
}

if (require.main === module) {
	try {
		const opts = parseArgs(process.argv.slice(2));
		const resolved = resolveParty(opts);
		opts.run = resolved.run;
		opts.party = resolved.party;
		opts.notes = resolved.notes;
		const sim = simulate(opts);
		console.log(opts.json ? JSON.stringify(sim, null, 2) : format(sim));
	} catch (error) {
		console.error(`simulate: ${error.message}`);
		process.exitCode = 1;
	}
}

module.exports = {parseBorrowedTeam, loadRun, resolveParty, selectFights, simulate, format};
