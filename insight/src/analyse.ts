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

/** One foe of a wall, read over every attempt that met it. */
export interface FoeRow {
	readonly foe: string;
	/** Attempts in which it was seen: on the tape, or named by the ledger as a killer or a knockout. */
	readonly facedIn: number;
	/** Of those, attempts whose tape was kept: turns are counted over these only. */
	readonly loggedIn: number;
	/** Bodies of ours it took, over every attempt: the ledger's `killers[].of`, or the tape's last hitter without one. */
	readonly bodiesLost: number;
	readonly bodiesPerFacing: number;
	/** Attempts in which we knocked it out. */
	readonly fell: number;
	readonly fellShare: number;
	readonly turnsPerFacing: number | null;
	/** What it killed us with, most first. */
	readonly killers: ReadonlyArray<readonly [string, number]>;
	/** Which of ours it killed, most first. */
	readonly victims: ReadonlyArray<readonly [string, number]>;
	/** The same three readings in the winning attempt, and averaged over the losses that met it. */
	readonly win: {readonly bodiesLost: number; readonly fell: boolean; readonly turns: number | null} | null;
	readonly losses: {readonly facedIn: number; readonly bodiesPerFacing: number; readonly fellShare: number;
		readonly turnsPerFacing: number | null};
}

export interface WallView {
	readonly trainer: string;
	readonly order: number;
	readonly attempts: number;
	readonly wonOn: number | null;
	/** The winning attempt's ledger number. */
	readonly winN: number | null;
	readonly logged: number;
	/** Most costly first: one row a foe, every number on one scale across the rows. */
	readonly foes: ReadonlyArray<FoeRow>;
	/** Bodies of ours that fell on our own move — recoil, Self-Destruct, a partner's spread move — which no foe is charged with. */
	readonly selfInflicted: number;
	/** Bodies of ours that fell on our own switch: hazards on the way in. Charged to no foe. */
	readonly hazards: number;
	/**
	 * Bodies of ours whose ledger row names no actor (`of: null`). The driver
	 * records none for end-of-turn damage — weather, status, seeds — so these
	 * are charged to no foe; on the sidney1 Sidney wall they were 40 of 240 bodies lost.
	 */
	readonly unattributed: number;
	/**
	 * True when some attempt's ledger has no `ofSide` (written before 2026-09-22):
	 * our side is then told from theirs by species, which a mirror can fool.
	 */
	readonly approximate: boolean;
	readonly tagLift: WallSummary['tagLift'];
	/** Every attempt, in order: what the strip of attempts draws, and what the fight view opens. */
	readonly runs: ReadonlyArray<{readonly n: number; readonly result: string; readonly policy: string;
		readonly bodiesLost: number; readonly knockouts: number | null; readonly foeLeft: number | null; readonly turns: number | null;
		readonly hasLog: boolean}>;
}

const bump = (counts: Map<string, number>, key: string | null | undefined): void => {
	if (key === null || key === undefined || key === '') return;
	counts.set(key, (counts.get(key) ?? 0) + 1);
};

const ranked = (counts: Map<string, number>): ReadonlyArray<readonly [string, number]> =>
	[...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

/** A species without its Mega form: the six boxes Lopunny, the ledger names Lopunny-Mega. */
const baseOf = (species: string): string => species.replace(/-Mega(-[XY])?$/, '');

const ratio = (top: number, bottom: number): number => bottom === 0 ? 0 : Number((top / bottom).toFixed(2));

/**
 * One wall, per FOE: what each of theirs cost us a facing, how often it fell,
 * what it killed us with, how long it stayed — and the win beside the losses.
 *
 * This is the table the operator kept building by hand (Champion Wallace:
 * which of six costs the bodies). A body is charged from the ledger, where
 * the harness names the body that was ACTING when ours fell (`killers[].of`);
 * that row exists for every attempt, logged or not, singles or doubles. Only
 * an actor on THEIR side is a foe. An actor on ours is our own switch (the
 * body fell to hazards on the way in) or our own move (recoil, Self-Destruct),
 * and each is counted apart. Until 2026-09-22 this charged every actor to a
 * foe, and on the Sidney wall five of eleven foe rows were our own team.
 * The side is the ledger's `ofSide`; an older ledger has none, and the side
 * is read by species — ours if the six (or the fallen) hold it and the tape
 * never saw it on their side — which is approximate, and the view says so.
 * Only an attempt without killers falls back to the tape's reading
 * (summariseAttempt's foeCosts).
 */
export function wallView(run: RunRecord, trainer: string): WallView | null {
	const wall = walls(run).find(entry => entry.trainer === trainer);
	return wall === undefined ? null : viewOf(run, wall);
}

/** Every fight of a run that took at least `minAttempts` attempts, each as its wall view. */
export function wallViews(run: RunRecord, minAttempts: number): ReadonlyArray<WallView> {
	return walls(run).filter(wall => wall.attempts >= minAttempts).map(wall => viewOf(run, wall));
}

function viewOf(run: RunRecord, wall: WallSummary): WallView {
	const trainer = wall.trainer;
	const attempts = run.ledger.filter(attempt => attempt.order === wall.order && attempt.trainer === trainer);
	const rows = new Map<string, {faced: number; logged: number; bodies: number; fell: number; turns: number;
		killers: Map<string, number>; victims: Map<string, number>;
		lossFaced: number; lossLogged: number; lossBodies: number; lossFell: number; lossTurns: number;
		win: {bodiesLost: number; fell: boolean; turns: number | null} | null}>();
	const rowOf = (foe: string) => {
		let row = rows.get(foe);
		if (row === undefined) {
			row = {faced: 0, logged: 0, bodies: 0, fell: 0, turns: 0, killers: new Map(), victims: new Map(),
				lossFaced: 0, lossLogged: 0, lossBodies: 0, lossFell: 0, lossTurns: 0, win: null};
			rows.set(foe, row);
		}
		return row;
	};
	let selfInflicted = 0;
	let hazards = 0;
	let unattributed = 0;
	let approximate = false;
	for (const [index, attempt] of attempts.entries()) {
		const summary = wall.summaries[index];
		if (summary === undefined) continue;
		const won = attempt.result === 'win';
		const bodies = new Map<string, number>();
		const fell = new Set<string>();
		const turns = new Map<string, number>();
		for (const cost of summary.hasLog ? summary.foeCosts : []) {
			turns.set(cost.foe, cost.turns);
			if (cost.fell) fell.add(cost.foe);
			if (attempt.killers === undefined) bodies.set(cost.foe, (bodies.get(cost.foe) ?? 0) + cost.bodiesLost);
		}
		for (const ko of attempt.kos ?? []) fell.add(ko.foe);
		const ours = new Set([...(attempt.six ?? []).map(member => baseOf(member.species)),
			...(attempt.killers ?? []).flatMap(fall => fall.species === null ? [] : [baseOf(fall.species)])]);
		for (const fall of attempt.killers ?? []) {
			if (fall.of === null) { unattributed += 1; continue; }
			if (fall.ofSide === undefined) approximate = true;
			// An old ledger: ours if our side holds the species and the tape never saw it on theirs (a mirror).
			const side = fall.ofSide ?? (ours.has(baseOf(fall.of)) && !turns.has(fall.of) ? 'ours' : 'theirs');
			if (side === 'ours') {
				// Our own switch carries no move: the body fell to hazards on the way in.
				if (fall.by === null) hazards += 1;
				else selfInflicted += 1;
				continue;
			}
			bodies.set(fall.of, (bodies.get(fall.of) ?? 0) + 1);
			const row = rowOf(fall.of);
			bump(row.killers, fall.by);
			bump(row.victims, fall.species);
		}
		const met = new Set([...turns.keys(), ...bodies.keys(), ...fell]);
		for (const foe of met) {
			const row = rowOf(foe);
			const lost = bodies.get(foe) ?? 0;
			const spent = turns.get(foe);
			row.faced += 1;
			row.bodies += lost;
			if (fell.has(foe)) row.fell += 1;
			if (spent !== undefined) { row.logged += 1; row.turns += spent; }
			if (won) row.win = {bodiesLost: lost, fell: fell.has(foe), turns: spent ?? null};
			else {
				row.lossFaced += 1;
				row.lossBodies += lost;
				if (fell.has(foe)) row.lossFell += 1;
				if (spent !== undefined) { row.lossLogged += 1; row.lossTurns += spent; }
			}
		}
	}
	const foes: FoeRow[] = [...rows.entries()].filter(([, row]) => row.faced > 0).map(([foe, row]) => ({
		foe, facedIn: row.faced, loggedIn: row.logged, bodiesLost: row.bodies, bodiesPerFacing: ratio(row.bodies, row.faced),
		fell: row.fell, fellShare: ratio(row.fell, row.faced), turnsPerFacing: row.logged === 0 ? null : ratio(row.turns, row.logged),
		killers: ranked(row.killers), victims: ranked(row.victims), win: row.win,
		losses: {facedIn: row.lossFaced, bodiesPerFacing: ratio(row.lossBodies, row.lossFaced), fellShare: ratio(row.lossFell, row.lossFaced),
			turnsPerFacing: row.lossLogged === 0 ? null : ratio(row.lossTurns, row.lossLogged)},
	})).sort((a, b) => b.bodiesPerFacing - a.bodiesPerFacing || a.foe.localeCompare(b.foe));
	const win = wall.wonOn === null ? undefined : wall.summaries[wall.wonOn - 1];
	return {trainer: wall.trainer, order: wall.order, attempts: wall.attempts, wonOn: wall.wonOn, winN: win?.n ?? null,
		logged: wall.logged, foes, selfInflicted, hazards, unattributed, approximate, tagLift: wall.tagLift,
		runs: wall.summaries.map((entry, index) => ({n: entry.n, result: entry.result, policy: entry.policy, bodiesLost: entry.bodiesLost,
			knockouts: attempts[index]?.kos?.length ?? null, foeLeft: entry.foeLeft, turns: entry.turns, hasLog: entry.hasLog}))};
}
