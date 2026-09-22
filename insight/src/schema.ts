/**
 * The shape of a headless run record, as far as insight reads it.
 *
 * scripts/headless-run.js writes these; this is the one place their shape is
 * stated as a type. Everything downstream takes a decoded value, so a record
 * that has drifted fails HERE, with the path of the field that moved, rather
 * than as an undefined three functions later.
 *
 * Only what is read is described. Unknown keys pass through untouched, since a
 * record grows a field most weeks and an analysis tool must not refuse one for
 * carrying more than it needs.
 */
import {Schema} from 'effect';

/** One option the screen offered on a turn. */
export const MoveOption = Schema.Struct({
	move: Schema.String,
	damage: Schema.NullOr(Schema.String),
});

export const RaceDetail = Schema.Struct({
	turnsToKill: Schema.Number,
	turnsToDie: Schema.Number,
	faster: Schema.optional(Schema.Boolean),
});

export const SwitchOption = Schema.Struct({
	label: Schema.String,
	race: Schema.NullOr(Schema.String),
	raceDetail: Schema.optional(Schema.NullOr(RaceDetail)),
});

export const TurnOptions = Schema.Struct({
	moves: Schema.Array(MoveOption),
	switches: Schema.Array(SwitchOption),
	bench: Schema.Array(Schema.String),
});

/** What the rollout search thought of one candidate on one turn. */
export const SearchScore = Schema.Struct({
	choice: Schema.String,
	/** Mean over `runs` playouts of: 1 for a win, else 0.3 x the share of their HP removed. */
	value: Schema.Number,
	runs: Schema.Number,
	/** What the value is made of. Absent on logs written before 2026-09-21. */
	wins: Schema.optional(Schema.Number),
	removed: Schema.optional(Schema.Number),
	oursAlive: Schema.optional(Schema.Number),
	/** The average material lead over the playouts (their HP share removed minus ours), in [-1, 1]. */
	lead: Schema.optional(Schema.Number),
});

/** One decision and what followed it. */
export const Turn = Schema.Struct({
	turn: Schema.Number,
	phase: Schema.optional(Schema.String),
	us: Schema.String,
	usHp: Schema.Number,
	foe: Schema.String,
	foeHp: Schema.Number,
	threat: Schema.optional(Schema.String),
	chose: Schema.String,
	why: Schema.optional(Schema.String),
	options: Schema.optional(TurnOptions),
	scores: Schema.optional(Schema.Array(SearchScore)),
	events: Schema.Array(Schema.String),
});
export type Turn = typeof Turn.Type;

export const Fallen = Schema.Struct({
	monId: Schema.optional(Schema.NullOr(Schema.String)),
	name: Schema.optional(Schema.NullOr(Schema.String)),
	species: Schema.NullOr(Schema.String),
	by: Schema.NullOr(Schema.String),
	of: Schema.NullOr(Schema.String),
	/**
	 * Whose side `of` was on. `of` is whoever was ACTING when the body fell, so a
	 * body of ours killed by hazards on its way in is "of" our outgoing body.
	 * Absent on records written before 2026-09-22.
	 */
	ofSide: Schema.optional(Schema.NullOr(Schema.Literal('ours', 'theirs'))),
});

export const Knockout = Schema.Struct({
	foe: Schema.String,
	by: Schema.NullOr(Schema.String),
	monId: Schema.optional(Schema.NullOr(Schema.String)),
	name: Schema.optional(Schema.NullOr(Schema.String)),
});

export const Member = Schema.Struct({
	name: Schema.String,
	species: Schema.String,
	level: Schema.Number,
	item: Schema.NullOr(Schema.String),
	ability: Schema.NullOr(Schema.String),
	nature: Schema.NullOr(Schema.String),
	moves: Schema.Array(Schema.String),
});

export const Probe = Schema.Struct({
	wins: Schema.optional(Schema.Number),
	of: Schema.Number,
	foeLeft: Schema.optional(Schema.Number),
	crashed: Schema.optional(Schema.String),
});

/**
 * One line of a double's tape. `side` is whose move or whose faint it was;
 * tapes written before 2026-09-22 lack it, and a reader falls back to the six.
 */
export const DoublesEvent = Schema.Struct({
	turn: Schema.optional(Schema.NullOr(Schema.Number)),
	text: Schema.String,
	side: Schema.optional(Schema.Literal('ours', 'theirs')),
});
export type DoublesEvent = typeof DoublesEvent.Type;

/** One attempt at one fight: the ledger row, with the fight itself when kept. */
export const Attempt = Schema.Struct({
	n: Schema.Number,
	order: Schema.Number,
	trainer: Schema.String,
	seed: Schema.Number,
	position: Schema.optional(Schema.Number),
	result: Schema.String,
	policy: Schema.optional(Schema.String),
	turns: Schema.optional(Schema.NullOr(Schema.Number)),
	deaths: Schema.optional(Schema.NullOr(Schema.Number)),
	killers: Schema.optional(Schema.Array(Fallen)),
	kos: Schema.optional(Schema.Array(Knockout)),
	foeLeft: Schema.optional(Schema.NullOr(Schema.Number)),
	foeOf: Schema.optional(Schema.NullOr(Schema.Number)),
	probe: Schema.optional(Probe),
	/** The line of the sidecar that holds this attempt's fight, when it was streamed there. */
	logLine: Schema.optional(Schema.Number),
	log: Schema.optional(Schema.Array(Turn)),
	/** A double has no one-active view to log turn by turn; its events are its record. */
	events: Schema.optional(Schema.Array(DoublesEvent)),
	six: Schema.optional(Schema.Array(Member)),
});
export type Attempt = typeof Attempt.Type;

export const RunRecord = Schema.Struct({
	starter: Schema.optional(Schema.String),
	seed: Schema.Number,
	position: Schema.Number,
	fights: Schema.Number,
	finished: Schema.optional(Schema.Boolean),
	stopped: Schema.optional(Schema.NullOr(Schema.String)),
	resumedAt: Schema.optional(Schema.Number),
	ledger: Schema.Array(Attempt),
});
export type RunRecord = typeof RunRecord.Type;

/**
 * One line of a run's `.fights.ndjson.gz` sidecar (lib/fight-log.js): the
 * attempt's fight, keyed by the ledger number it belongs to. The ledger row
 * keeps only `logLine`; this is where the turns live.
 */
export const FightLine = Schema.Struct({
	n: Schema.Number,
	trainer: Schema.String,
	log: Schema.optional(Schema.Array(Turn)),
	events: Schema.optional(Schema.Array(DoublesEvent)),
	six: Schema.optional(Schema.Array(Member)),
});
export type FightLine = typeof FightLine.Type;

export const decodeRun = Schema.decodeUnknown(RunRecord);
export const decodeFightLine = Schema.decodeUnknown(FightLine);
