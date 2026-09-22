/**
 * A run, read for how its fights went.
 *
 * Pure functions over a decoded record. A WALL is every attempt at one fight;
 * its summary sets the winning attempt beside the losing ones, because "what
 * did the win do that the losses did not" is the only question that says how
 * a fight is actually beaten.
 */
import type {Attempt, RunRecord, Turn} from './schema.js';
import {readDoublesLine, speciesOf, tagsOf, type Tag} from './tags.js';

export interface FoeCost {
	readonly foe: string;
	readonly faced: number;
	readonly bodiesLost: number;
	readonly turns: number;
	readonly fell: boolean;
}

export interface AttemptSummary {
	readonly n: number;
	readonly seed: number;
	readonly result: string;
	readonly policy: string;
	readonly turns: number | null;
	readonly foeLeft: number | null;
	readonly bodiesLost: number;
	readonly hasLog: boolean;
	readonly tagCounts: Readonly<Record<string, number>>;
	readonly foeCosts: ReadonlyArray<FoeCost>;
	readonly lead: string | null;
	readonly order: ReadonlyArray<string>;
}

export interface WallSummary {
	readonly trainer: string;
	readonly order: number;
	readonly attempts: number;
	readonly wonOn: number | null;
	readonly logged: number;
	/** Turns per attempt carrying each tag: in the win, and averaged over the losses. */
	readonly tagLift: ReadonlyArray<{readonly tag: Tag; readonly win: number; readonly lossMean: number}>;
	readonly summaries: ReadonlyArray<AttemptSummary>;
}

const countTags = (log: ReadonlyArray<Turn>): Record<string, number> => {
	const counts: Record<string, number> = {};
	for (const turn of log) for (const tag of tagsOf(turn)) counts[tag] = (counts[tag] ?? 0) + 1;
	return counts;
};

const foeCostsOf = (log: ReadonlyArray<Turn>): ReadonlyArray<FoeCost> => {
	const byFoe = new Map<string, {faced: number; bodiesLost: number; turns: number; fell: boolean}>();
	for (const turn of log) {
		const foe = speciesOf(turn.foe);
		const row = byFoe.get(foe) ?? {faced: 1, bodiesLost: 0, turns: 0, fell: false};
		if (turn.why === 'forced replacement' || turn.phase === 'replace') row.bodiesLost += 1;
		else row.turns += 1;
		if (turn.events.some(text => text.startsWith(foe + ' fainted'))) row.fell = true;
		byFoe.set(foe, row);
	}
	return [...byFoe.entries()].map(([foe, row]) => ({foe, ...row}));
};

/**
 * A double, read from its tape. Until 2026-09-22 every double was `hasLog:
 * false` here — the tape is events, not turns — so every wall fought in
 * doubles (the Elite Four's doubles, the rival doubles) vanished from the
 * wall view and from strategyOf, and Sidney's double was won on attempt 17
 * with none of its 17 tapes read.
 *
 * A body of ours that falls is charged to the foe that last hit it: that is
 * the question a wall asks, which foe costs us bodies.
 */
function summariseDouble(attempt: Attempt, events: NonNullable<Attempt['events']>): AttemptSummary {
	const ours = new Set((attempt.six ?? []).map(member => member.species));
	const counts: Record<string, number> = {};
	const order: string[] = [];
	const lastHitBy = new Map<string, string>();
	const byFoe = new Map<string, {faced: number; bodiesLost: number; turns: Set<number>; fell: boolean}>();
	const foeRow = (foe: string) => {
		const row = byFoe.get(foe) ?? {faced: 1, bodiesLost: 0, turns: new Set<number>(), fell: false};
		byFoe.set(foe, row);
		return row;
	};
	let turns = 0;
	let ourFalls = 0;
	for (const event of events) {
		const line = readDoublesLine(event, ours);
		if (line === null) continue;
		if (line.turn !== null) turns = Math.max(turns, line.turn);
		for (const tag of line.tags) counts[tag] = (counts[tag] ?? 0) + 1;
		if (line.side === 'ours' && !line.fainted && !order.includes(line.actor)) order.push(line.actor);
		if (line.side === 'theirs' && !line.fainted) {
			const row = foeRow(line.actor);
			if (line.turn !== null) row.turns.add(line.turn);
			for (const target of line.targets) lastHitBy.set(target, line.actor);
		}
		if (line.fainted && line.side === 'theirs') foeRow(line.actor).fell = true;
		if (line.fainted && line.side === 'ours') {
			ourFalls += 1;
			const by = lastHitBy.get(line.actor);
			if (by !== undefined) foeRow(by).bodiesLost += 1;
		}
	}
	return {
		n: attempt.n,
		seed: attempt.seed,
		result: attempt.result,
		policy: attempt.policy ?? 'decide',
		turns: attempt.turns ?? (turns || null),
		foeLeft: attempt.foeLeft ?? null,
		bodiesLost: attempt.deaths ?? ourFalls,
		hasLog: true,
		tagCounts: counts,
		foeCosts: [...byFoe.entries()].map(([foe, row]) => ({foe, faced: row.faced, bodiesLost: row.bodiesLost,
			turns: row.turns.size, fell: row.fell})),
		lead: order.length === 0 ? null : order.slice(0, 2).join(' + '),
		order,
	};
}

export function summariseAttempt(attempt: Attempt): AttemptSummary {
	const log = attempt.log ?? [];
	if (log.length === 0 && attempt.events !== undefined && attempt.events.length > 0) {
		return summariseDouble(attempt, attempt.events);
	}
	const order: string[] = [];
	for (const turn of log) {
		const mine = speciesOf(turn.us);
		if (mine !== '' && !order.includes(mine)) order.push(mine);
	}
	return {
		n: attempt.n,
		seed: attempt.seed,
		result: attempt.result,
		policy: attempt.policy ?? 'decide',
		turns: attempt.turns ?? null,
		foeLeft: attempt.foeLeft ?? null,
		bodiesLost: attempt.deaths ?? (attempt.killers ?? []).length,
		hasLog: log.length > 0,
		tagCounts: countTags(log),
		foeCosts: foeCostsOf(log),
		lead: order[0] ?? null,
		order,
	};
}

export function walls(run: RunRecord): ReadonlyArray<WallSummary> {
	const byFight = new Map<string, Attempt[]>();
	for (const attempt of run.ledger) {
		const key = attempt.order + '|' + attempt.trainer;
		byFight.set(key, [...(byFight.get(key) ?? []), attempt]);
	}
	const out: WallSummary[] = [];
	for (const attempts of byFight.values()) {
		const first = attempts[0];
		if (first === undefined) continue;
		const summaries = attempts.map(summariseAttempt);
		const winIndex = summaries.findIndex(entry => entry.result === 'win');
		const win = winIndex === -1 ? undefined : summaries[winIndex];
		const losses = summaries.filter(entry => entry.result !== 'win' && entry.hasLog);
		const tags = new Set<string>();
		for (const entry of summaries) for (const tag of Object.keys(entry.tagCounts)) tags.add(tag);
		const tagLift = [...tags].map(tag => ({
			tag: tag as Tag,
			win: win?.tagCounts[tag] ?? 0,
			lossMean: losses.length === 0 ? 0 :
				Number((losses.reduce((sum, entry) => sum + (entry.tagCounts[tag] ?? 0), 0) / losses.length).toFixed(2)),
		})).sort((a, b) => (b.win - b.lossMean) - (a.win - a.lossMean));
		out.push({trainer: first.trainer, order: first.order, attempts: attempts.length,
			wonOn: winIndex === -1 ? null : winIndex + 1,
			logged: summaries.filter(entry => entry.hasLog).length, tagLift, summaries});
	}
	return out.sort((a, b) => a.order - b.order);
}

export interface Strategy {
	readonly wallsFought: number;
	readonly wallsWon: number;
	readonly attempts: number;
	/** Mean of our bodies lost in a WINNING attempt: what a win costs. */
	readonly bodiesLostPerWin: number | null;
	readonly cleanWins: number;
	/** Per kind of turn: mean per winning attempt against mean per losing attempt, over every logged wall. */
	readonly control: ReadonlyArray<{readonly tag: Tag; readonly perWin: number; readonly perLoss: number}>;
	/** Crits for minus crits against, per winning attempt and per losing attempt: how much of winning is dice. */
	readonly critEdge: {readonly wins: number; readonly losses: number};
	/** The share of searched turns where the search played something other than the biggest forecast. */
	readonly overrodeShare: {readonly wins: number; readonly losses: number};
	readonly leads: ReadonlyArray<{readonly lead: string; readonly wins: number; readonly attempts: number}>;
}

const mean = (values: ReadonlyArray<number>): number =>
	values.length === 0 ? 0 : Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));

/**
 * What a run's wins are made of, against what its losses are made of.
 *
 * One wall's win beside its own losses is an anecdote — Brawly was once won on
 * five crits. Pooled over every logged wall it becomes a reading of which
 * kinds of control the wins had and the losses lacked, what a win costs in
 * bodies, and how much of it was dice. Only attempts that kept a log count.
 */
export function strategyOf(run: RunRecord): Strategy {
	const all = walls(run).filter(wall => wall.attempts > 1 || wall.logged > 0);
	const logged = all.flatMap(wall => wall.summaries.filter(entry => entry.hasLog));
	const wins = logged.filter(entry => entry.result === 'win');
	const losses = logged.filter(entry => entry.result !== 'win');
	const tags = new Set<string>();
	for (const entry of logged) for (const tag of Object.keys(entry.tagCounts)) tags.add(tag);
	const count = (entry: AttemptSummary, tag: string): number => entry.tagCounts[tag] ?? 0;
	const searched = (entry: AttemptSummary): number => Math.max(1, (entry.turns ?? 0));
	const leads = new Map<string, {wins: number; attempts: number}>();
	for (const entry of logged) {
		if (entry.lead === null) continue;
		const row = leads.get(entry.lead) ?? {wins: 0, attempts: 0};
		row.attempts += 1;
		if (entry.result === 'win') row.wins += 1;
		leads.set(entry.lead, row);
	}
	return {
		wallsFought: all.length,
		wallsWon: all.filter(wall => wall.wonOn !== null).length,
		attempts: all.reduce((sum, wall) => sum + wall.attempts, 0),
		bodiesLostPerWin: wins.length === 0 ? null : mean(wins.map(entry => entry.bodiesLost)),
		cleanWins: wins.filter(entry => entry.bodiesLost === 0).length,
		control: [...tags].map(tag => ({tag: tag as Tag, perWin: mean(wins.map(entry => count(entry, tag))),
			perLoss: mean(losses.map(entry => count(entry, tag)))}))
			.sort((a, b) => (b.perWin - b.perLoss) - (a.perWin - a.perLoss)),
		critEdge: {wins: mean(wins.map(entry => count(entry, 'crit-ours') - count(entry, 'crit-theirs'))),
			losses: mean(losses.map(entry => count(entry, 'crit-ours') - count(entry, 'crit-theirs')))},
		overrodeShare: {wins: mean(wins.map(entry => count(entry, 'search-overrode') / searched(entry))),
			losses: mean(losses.map(entry => count(entry, 'search-overrode') / searched(entry)))},
		leads: [...leads.entries()].map(([lead, row]) => ({lead, ...row})).sort((a, b) => b.attempts - a.attempts).slice(0, 8),
	};
}
