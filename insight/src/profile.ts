/**
 * A run read for what it IS, not for one fight of it: its aggregates, and a
 * profile of every Pokemon it owns — and the same rolled up across runs.
 *
 * The watch page showed a fight; the fight log page showed a wall. Neither
 * answered "how is this run doing, and who is carrying it", and nothing
 * answered it across runs. Both are here, as pure functions over what a run
 * already writes: its record when it has ended (run-SEED.json), its
 * checkpoint while it plays (run-SEED.checkpoint.json: the document and the
 * ledger so far). Every ledger row names who knocked out what and who fell
 * to what, by the body's id, so a profile needs no fight log.
 */
import {Schema} from 'effect';

const Mon = Schema.Struct({
	id: Schema.String,
	species: Schema.String,
	nickname: Schema.optional(Schema.NullOr(Schema.String)),
	level: Schema.Number,
	nature: Schema.optional(Schema.NullOr(Schema.String)),
	ability: Schema.optional(Schema.NullOr(Schema.String)),
	item: Schema.optional(Schema.NullOr(Schema.String)),
	moves: Schema.optional(Schema.Array(Schema.String)),
	ivs: Schema.optional(Schema.Record({key: Schema.String, value: Schema.Number})),
	status: Schema.optional(Schema.NullOr(Schema.String)),
	origin: Schema.optional(Schema.Struct({mapName: Schema.optional(Schema.NullOr(Schema.String)),
		method: Schema.optional(Schema.NullOr(Schema.String)), at: Schema.optional(Schema.NullOr(Schema.Number))})),
});

const Row = Schema.Struct({
	n: Schema.Number,
	order: Schema.Number,
	trainer: Schema.String,
	position: Schema.optional(Schema.Number),
	result: Schema.String,
	policy: Schema.optional(Schema.String),
	turns: Schema.optional(Schema.NullOr(Schema.Number)),
	deaths: Schema.optional(Schema.NullOr(Schema.Number)),
	foeLeft: Schema.optional(Schema.NullOr(Schema.Number)),
	kos: Schema.optional(Schema.Array(Schema.Struct({foe: Schema.String, by: Schema.NullOr(Schema.String),
		monId: Schema.optional(Schema.NullOr(Schema.String))}))),
	killers: Schema.optional(Schema.Array(Schema.Struct({monId: Schema.optional(Schema.NullOr(Schema.String)),
		species: Schema.NullOr(Schema.String), by: Schema.NullOr(Schema.String), of: Schema.NullOr(Schema.String)}))),
});

const Doc = Schema.Struct({position: Schema.Number, party: Schema.Array(Schema.String), box: Schema.Array(Mon),
	bag: Schema.optional(Schema.Record({key: Schema.String, value: Schema.Number}))});

/** A run that has ended. */
const Ended = Schema.Struct({seed: Schema.Number, starter: Schema.optional(Schema.String), position: Schema.Number,
	fights: Schema.Number, seconds: Schema.optional(Schema.Number), finished: Schema.optional(Schema.Boolean),
	stopped: Schema.optional(Schema.NullOr(Schema.String)), ledger: Schema.Array(Row), doc: Schema.optional(Doc),
	plans: Schema.optional(Schema.Array(Schema.Unknown)), reprobes: Schema.optional(Schema.Number),
	audit: Schema.optional(Schema.Struct({ok: Schema.Boolean}))});

/** A run still playing, as its checkpoint holds it. */
const Playing = Schema.Struct({seed: Schema.Number, position: Schema.Number, doc: Doc,
	starter: Schema.optional(Schema.Struct({species: Schema.String})),
	state: Schema.Struct({tally: Schema.Struct({fights: Schema.Number, ledger: Schema.Array(Row),
		plans: Schema.optional(Schema.Array(Schema.Unknown)), reprobes: Schema.optional(Schema.Number)}),
	elapsedMs: Schema.optional(Schema.Number)})});

export const decodeEnded = Schema.decodeUnknown(Ended);
export const decodePlaying = Schema.decodeUnknown(Playing);

/** Either kind of run, as one shape. */
export interface RunSource {
	readonly seed: number;
	readonly starter: string | null;
	readonly position: number;
	readonly seconds: number | null;
	readonly state: 'playing' | 'finished' | 'ended';
	readonly stopped: string | null;
	readonly auditOk: boolean | null;
	readonly plans: number;
	readonly reprobes: number;
	readonly ledger: ReadonlyArray<typeof Row.Type>;
	readonly doc: typeof Doc.Type | null;
}

export const fromEnded = (run: typeof Ended.Type): RunSource => ({seed: run.seed, starter: run.starter ?? null,
	position: run.position, seconds: run.seconds ?? null, state: run.finished === true ? 'finished' : 'ended',
	stopped: run.stopped ?? null, auditOk: run.audit?.ok ?? null, plans: (run.plans ?? []).length,
	reprobes: run.reprobes ?? 0, ledger: run.ledger, doc: run.doc ?? null});

export const fromPlaying = (run: typeof Playing.Type): RunSource => ({seed: run.seed, starter: run.starter?.species ?? null,
	position: run.position, seconds: run.state.elapsedMs === undefined ? null : Math.round(run.state.elapsedMs / 1000),
	state: 'playing', stopped: null, auditOk: null, plans: (run.state.tally.plans ?? []).length,
	reprobes: run.state.tally.reprobes ?? 0, ledger: run.state.tally.ledger, doc: run.doc});

export interface Wall {
	readonly trainer: string;
	readonly order: number;
	readonly attempts: number;
	readonly cleared: boolean;
	readonly wonBy: string | null;
	readonly bodiesLostInWin: number | null;
}

export interface Profile {
	readonly id: string;
	readonly name: string;
	readonly species: string;
	readonly level: number;
	readonly nature: string | null;
	readonly ability: string | null;
	readonly item: string | null;
	readonly moves: ReadonlyArray<string>;
	readonly ivTotal: number | null;
	readonly caught: string | null;
	readonly inParty: boolean;
	readonly alive: boolean;
	readonly knockouts: number;
	readonly falls: number;
	/** Knockouts scored in the fights that CLEARED a wall: who carried the hard ones. */
	readonly wallKnockouts: number;
	readonly victims: ReadonlyArray<readonly [string, number]>;
	readonly fellTo: ReadonlyArray<readonly [string, number]>;
	readonly bestMoves: ReadonlyArray<readonly [string, number]>;
}

export interface RunSummary {
	readonly seed: number;
	readonly starter: string | null;
	readonly state: RunSource['state'];
	readonly stopped: string | null;
	readonly auditOk: boolean | null;
	readonly position: number;
	/** Where this leg began: a run carried on, resumed or measured from a wall begins where that one stood. */
	readonly startedAt: number;
	readonly minutes: number | null;
	readonly attempts: number;
	readonly trainersBeaten: number;
	readonly firstTry: number;
	readonly attemptsPerTrainer: number | null;
	readonly byHand: ReadonlyArray<{readonly hand: string; readonly attempts: number; readonly wins: number}>;
	readonly walls: ReadonlyArray<Wall>;
	readonly bodiesLostPerWallWin: number | null;
	readonly plans: number;
	readonly reprobes: number;
	readonly boxSize: number;
	readonly roster: ReadonlyArray<Profile>;
}

/** A fight counts as a wall from this many attempts: below it, it is dice. */
export const WALL_ATTEMPTS = 5;

const top = (counts: Map<string, number>, keep: number): ReadonlyArray<readonly [string, number]> =>
	[...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, keep);

const bump = (counts: Map<string, number>, key: string | null | undefined): void => {
	if (key === null || key === undefined || key === '') return;
	counts.set(key, (counts.get(key) ?? 0) + 1);
};

/** `search-8` and `search-4` are one hand; so are the depths of a lookahead. */
const handOf = (policy: string | undefined): string => (policy ?? 'decide').replace(/-\d+$/, '');

export function summariseRun(run: RunSource): RunSummary {
	const byTrainer = new Map<string, Array<typeof Row.Type>>();
	for (const row of run.ledger) {
		const key = row.order + '|' + row.trainer;
		byTrainer.set(key, [...(byTrainer.get(key) ?? []), row]);
	}
	const fights = [...byTrainer.values()];
	const walls: Wall[] = fights.filter(rows => rows.length >= WALL_ATTEMPTS).map(rows => {
		const win = rows.find(row => row.result === 'win');
		const first = rows[0];
		return {trainer: first?.trainer ?? '', order: first?.order ?? 0, attempts: rows.length, cleared: win !== undefined,
			wonBy: win === undefined ? null : handOf(win.policy), bodiesLostInWin: win?.deaths ?? null};
	}).sort((a, b) => a.order - b.order);
	const wallWinRows = new Set(fights.filter(rows => rows.length >= WALL_ATTEMPTS)
		.map(rows => rows.find(row => row.result === 'win')?.n).filter((n): n is number => n !== undefined));

	const hands = new Map<string, {attempts: number; wins: number}>();
	for (const row of run.ledger) {
		const entry = hands.get(handOf(row.policy)) ?? {attempts: 0, wins: 0};
		entry.attempts += 1;
		if (row.result === 'win') entry.wins += 1;
		hands.set(handOf(row.policy), entry);
	}

	// Who did what, by the body's id: every row names its knockouts and its falls.
	const stats = new Map<string, {kos: number; falls: number; wallKos: number; victims: Map<string, number>;
		fellTo: Map<string, number>; moves: Map<string, number>}>();
	const of = (id: string) => {
		let entry = stats.get(id);
		if (entry === undefined) {
			entry = {kos: 0, falls: 0, wallKos: 0, victims: new Map(), fellTo: new Map(), moves: new Map()};
			stats.set(id, entry);
		}
		return entry;
	};
	for (const row of run.ledger) {
		for (const ko of row.kos ?? []) {
			if (ko.monId === null || ko.monId === undefined) continue;
			const entry = of(ko.monId);
			entry.kos += 1;
			if (wallWinRows.has(row.n)) entry.wallKos += 1;
			bump(entry.victims, ko.foe);
			bump(entry.moves, ko.by);
		}
		for (const fall of row.killers ?? []) {
			if (fall.monId === null || fall.monId === undefined) continue;
			const entry = of(fall.monId);
			entry.falls += 1;
			bump(entry.fellTo, fall.of === null ? null : fall.of + (fall.by === null ? '' : ' · ' + fall.by));
		}
	}
	const party = new Set(run.doc?.party ?? []);
	const roster: Profile[] = (run.doc?.box ?? []).map(mon => {
		const entry = stats.get(mon.id);
		const ivs = mon.ivs === undefined ? null : Object.values(mon.ivs).reduce((sum, value) => sum + value, 0);
		return {id: mon.id, name: mon.nickname ?? mon.species, species: mon.species, level: mon.level,
			nature: mon.nature ?? null, ability: mon.ability ?? null, item: mon.item ?? null, moves: mon.moves ?? [],
			ivTotal: ivs, caught: mon.origin?.mapName ?? null, inParty: party.has(mon.id), alive: mon.status !== 'dead',
			knockouts: entry?.kos ?? 0, falls: entry?.falls ?? 0, wallKnockouts: entry?.wallKos ?? 0,
			victims: top(entry?.victims ?? new Map(), 3), fellTo: top(entry?.fellTo ?? new Map(), 3),
			bestMoves: top(entry?.moves ?? new Map(), 3)};
	}).sort((a, b) => b.knockouts - a.knockouts || a.falls - b.falls || a.name.localeCompare(b.name));

	const beaten = fights.filter(rows => rows.some(row => row.result === 'win'));
	const wallWins = walls.filter(wall => wall.cleared && wall.bodiesLostInWin !== null);
	return {seed: run.seed, starter: run.starter, state: run.state, stopped: run.stopped, auditOk: run.auditOk,
		position: run.position, startedAt: run.ledger[0]?.position ?? run.position, minutes: run.seconds === null ? null : Math.round(run.seconds / 60),
		attempts: run.ledger.length, trainersBeaten: beaten.length,
		firstTry: beaten.filter(rows => rows[0]?.result === 'win').length,
		attemptsPerTrainer: beaten.length === 0 ? null : Number((run.ledger.length / beaten.length).toFixed(2)),
		byHand: [...hands.entries()].map(([hand, entry]) => ({hand, ...entry})).sort((a, b) => b.attempts - a.attempts),
		walls, plans: run.plans, reprobes: run.reprobes, boxSize: run.doc?.box.length ?? 0, roster,
		bodiesLostPerWallWin: wallWins.length === 0 ? null :
			Number((wallWins.reduce((sum, wall) => sum + (wall.bodiesLostInWin ?? 0), 0) / wallWins.length).toFixed(2))};
}

export interface FleetWall {
	readonly trainer: string;
	readonly order: number;
	readonly runsMet: number;
	readonly runsCleared: number;
	readonly attempts: number;
	readonly medianAttempts: number;
}

export interface FleetSpecies {
	readonly species: string;
	readonly runs: number;
	readonly knockouts: number;
	readonly falls: number;
	readonly wallKnockouts: number;
}

export interface FleetLeg {
	readonly run: string;
	readonly summary: Omit<RunSummary, 'roster'>;
	/** False for a leg that began where another of this seed began and got less far: a measurement arm, a retry. */
	readonly counted: boolean;
}

export interface FleetSeed {
	readonly seed: number;
	readonly starter: string | null;
	readonly position: number;
	readonly playing: boolean;
	readonly finished: boolean;
	readonly attempts: number;
	readonly stoppedAt: ReadonlyArray<string>;
	readonly legs: ReadonlyArray<FleetLeg>;
}

export interface Fleet {
	readonly seeds: ReadonlyArray<FleetSeed>;
	readonly walls: ReadonlyArray<FleetWall>;
	readonly species: ReadonlyArray<FleetSpecies>;
}

/**
 * Every run together, BY SEED. One seed is one journey, however many
 * directories it was played in: a run that stopped at Brawly, the leg that
 * carried it on to Matt, and four measurement arms restarted from one wall are
 * all seed 731001. Counted run by run, that one box at Matt was "eight runs".
 *
 * So: legs are grouped by seed. Of the legs that began at the SAME position —
 * arms of a measurement, a retry — only the one that got furthest is counted,
 * so a body's knockouts are not tallied four times over. A wall is counted
 * once per seed that met it: cleared if any leg cleared it, at the most
 * attempts any one leg spent there.
 */
export function fleetOf(named: ReadonlyArray<{readonly run: string; readonly summary: RunSummary}>): Fleet {
	const bySeed = new Map<number, Array<{run: string; summary: RunSummary}>>();
	for (const entry of named) bySeed.set(entry.summary.seed, [...(bySeed.get(entry.summary.seed) ?? []), entry]);

	const walls = new Map<string, {trainer: string; order: number; attempts: number[]; cleared: number}>();
	const species = new Map<string, {seeds: Set<number>; kos: number; falls: number; wallKos: number}>();
	const seeds: FleetSeed[] = [];
	for (const [seed, legs] of bySeed) {
		const further = (a: RunSummary, b: RunSummary): number => b.position - a.position || b.attempts - a.attempts;
		const counted = new Set<string>();
		const byStart = new Map<number, Array<{run: string; summary: RunSummary}>>();
		for (const leg of legs) byStart.set(leg.summary.startedAt, [...(byStart.get(leg.summary.startedAt) ?? []), leg]);
		for (const same of byStart.values()) {
			const best = same.slice().sort((a, b) => further(a.summary, b.summary))[0];
			if (best !== undefined) counted.add(best.run);
		}
		// A wall, once for this seed: any leg may have met it, counted or not — an arm that cleared it cleared it.
		const mine = new Map<string, {trainer: string; order: number; attempts: number; cleared: boolean}>();
		for (const leg of legs) {
			for (const wall of leg.summary.walls) {
				const entry = mine.get(wall.trainer) ?? {trainer: wall.trainer, order: wall.order, attempts: 0, cleared: false};
				entry.attempts = Math.max(entry.attempts, wall.attempts);
				entry.cleared = entry.cleared || wall.cleared;
				mine.set(wall.trainer, entry);
			}
		}
		for (const wall of mine.values()) {
			const entry = walls.get(wall.trainer) ?? {trainer: wall.trainer, order: wall.order, attempts: [], cleared: 0};
			entry.attempts.push(wall.attempts);
			if (wall.cleared) entry.cleared += 1;
			walls.set(wall.trainer, entry);
		}
		for (const leg of legs.filter(entry => counted.has(entry.run))) {
			for (const mon of leg.summary.roster) {
				const entry = species.get(mon.species) ?? {seeds: new Set<number>(), kos: 0, falls: 0, wallKos: 0};
				entry.seeds.add(seed);
				entry.kos += mon.knockouts;
				entry.falls += mon.falls;
				entry.wallKos += mon.wallKnockouts;
				species.set(mon.species, entry);
			}
		}
		const ordered = legs.slice().sort((a, b) => a.summary.startedAt - b.summary.startedAt || further(a.summary, b.summary));
		const furthest = legs.slice().sort((a, b) => further(a.summary, b.summary))[0];
		seeds.push({seed, starter: furthest?.summary.starter ?? null, position: furthest?.summary.position ?? 0,
			playing: legs.some(leg => leg.summary.state === 'playing'), finished: legs.some(leg => leg.summary.state === 'finished'),
			attempts: legs.filter(leg => counted.has(leg.run)).reduce((sum, leg) => sum + leg.summary.attempts, 0),
			stoppedAt: [...mine.values()].filter(wall => !wall.cleared).sort((a, b) => a.order - b.order).map(wall => wall.trainer),
			legs: ordered.map(({run, summary}) => {
				const {roster: _roster, ...rest} = summary;
				return {run, summary: rest, counted: counted.has(run)};
			})});
	}
	const median = (values: number[]): number => {
		const sorted = values.slice().sort((a, b) => a - b);
		return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0;
	};
	return {
		seeds: seeds.sort((a, b) => b.position - a.position),
		walls: [...walls.values()].map(entry => ({trainer: entry.trainer, order: entry.order, runsMet: entry.attempts.length,
			runsCleared: entry.cleared, attempts: entry.attempts.reduce((sum, value) => sum + value, 0),
			medianAttempts: median(entry.attempts)})).sort((a, b) => a.order - b.order),
		species: [...species.entries()].map(([name, entry]) => ({species: name, runs: entry.seeds.size, knockouts: entry.kos,
			falls: entry.falls, wallKnockouts: entry.wallKos}))
			.filter(entry => entry.knockouts + entry.falls > 0)
			.sort((a, b) => b.wallKnockouts - a.wallKnockouts || b.knockouts - a.knockouts).slice(0, 40),
	};
}
