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
 * CLI:
 *   node simulate.js --team "Metagross (Trainer Steven Space Center)" --milestones
 *   node simulate.js --team "Azumarill (Leader Norman)" --from 0 --count 10
 *   node simulate.js --team "..." --milestones --json
 */

const planner = require('./planner');
const getProfile = require('./profiles').getProfile;

/**
 * `Species (Set Label)`, the same shape the browser panel and the set dropdowns
 * use. Parsed here rather than shared with `planner_panel.js` because that file
 * is a classic browser script with no module boundary to import across; the
 * grammar is one line and duplicating it beats bridging two loaders.
 */
function parseTeam(text) {
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
 */
function selectFights(options) {
	const opts = options || {};
	const profile = getProfile(opts.profileId);
	let fights = planner.loadRunMap(opts.profileId);

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
	const party = opts.party;
	if (!party || !party.length) throw new Error('party is required');
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
			const result = planner.predict({
				trainer: fight.trainer,
				playerParty: party,
				profileId: opts.profileId,
			});
			step.confidence = result.confidence;
			step.margin = result.margin;
			step.actions = result.actions.slice(0, opts.actions || 3)
				.map(a => ({label: a.label, score: Number(a.score.toFixed(2))}));
			step.playerLevel = result.state.sides.player.party[0].level;
			step.levelDelta = step.playerLevel - step.opponentLevel;
		} catch (error) {
			step.error = error.message;
		}
		steps.push(step);
	}

	const planned = steps.filter(s => !s.error);
	return {
		party,
		steps,
		summary: {
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

/** Human-readable rendering. `--json` skips this entirely. */
function format(run) {
	const lines = [];
	lines.push(`team: ${run.party.map(m => `${m.species} (${m.setLabel})`).join(', ')}`);
	lines.push('');
	for (const step of run.steps) {
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
	const s = run.summary;
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
		else if (arg === '--team') opts.team = argv[++i];
		else if (arg === '--profile') opts.profileId = argv[++i];
		else if (arg === '--from') opts.from = Number(argv[++i]);
		else if (arg === '--to') opts.to = Number(argv[++i]);
		else if (arg === '--count') opts.count = Number(argv[++i]);
		else if (arg === '--actions') opts.actions = Number(argv[++i]);
		else throw new Error(`unknown argument ${JSON.stringify(arg)}`);
	}
	return opts;
}

if (require.main === module) {
	try {
		const opts = parseArgs(process.argv.slice(2));
		if (!opts.team) {
			throw new Error('--team "Species (Set Label), Species (Set Label)" is required');
		}
		opts.party = parseTeam(opts.team);
		const run = simulate(opts);
		console.log(opts.json ? JSON.stringify(run, null, 2) : format(run));
	} catch (error) {
		console.error(`simulate: ${error.message}`);
		process.exitCode = 1;
	}
}

module.exports = {parseTeam, selectFights, simulate, format};
