/**
 * A run, read for how its fights went.
 *
 * Pure functions over a decoded record. A WALL is every attempt at one fight;
 * its summary sets the winning attempt beside the losing ones, because "what
 * did the win do that the losses did not" is the only question that says how
 * a fight is actually beaten.
 */
import type {Attempt, RunRecord, Turn} from './schema.js';
import {speciesOf, tagsOf, type Tag} from './tags.js';

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

export function summariseAttempt(attempt: Attempt): AttemptSummary {
	const log = attempt.log ?? [];
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
