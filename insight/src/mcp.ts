/**
 * insight as MCP tools: the same typed core an agent can ask questions of.
 *
 *   node dist/src/mcp.js            # stdio, JSON-RPC 2.0, one message a line
 *
 * The page is for a person digging; these are for an agent digging. Both are
 * thin faces over analyse.ts and tags.ts, so they cannot disagree. Arguments
 * are decoded with Effect Schema, which means a tool's input schema and the
 * check that enforces it are one declaration — the signature an agent is shown
 * is the one that is applied.
 *
 * Hand-rolled JSON-RPC, as scripts/engine-mcp.js is: eight tools do not earn a
 * dependency.
 */
import {Effect, JSONSchema, ParseResult, Schema} from 'effect';
import * as path from 'node:path';
import * as readline from 'node:readline';
import {strategyOf, wallView, wallViews, walls} from './analyse.js';
import {loadRunWithFights} from './cli.js';
import {WALL_ATTEMPTS} from './profile.js';
import {control, listRuns, readLive, readMachine, readStatus} from './serve.js';
import {readDoublesLine, tagsOf} from './tags.js';

const Report = Schema.String.annotations({description: 'Path to a headless run record (JSON) written by scripts/headless-run.js.'});

const ListWalls = Schema.Struct({report: Report,
	minAttempts: Schema.optional(Schema.Number.annotations({description: 'Only fights that took at least this many attempts. Default 2.'}))});
const CompareAttempts = Schema.Struct({report: Report,
	trainer: Schema.String.annotations({description: 'The trainer exactly as the ledger names it, e.g. "Leader Norman".'})});
const WallViewArgs = Schema.Struct({report: Report,
	trainer: Schema.optional(Schema.String.annotations({description: 'One wall, the trainer exactly as the ledger names it, e.g. "Champion Wallace". Omit for every wall.'})),
	minAttempts: Schema.optional(Schema.Number.annotations({description: 'Without a trainer: only fights that took at least this many attempts. Default ' + WALL_ATTEMPTS + '.'}))});
const GetAttempt = Schema.Struct({report: Report,
	n: Schema.Number.annotations({description: 'The attempt\'s ledger number (the `n` a wall\'s summaries list).'})});
const GetTurns = Schema.Struct({report: Report, n: Schema.Number,
	tag: Schema.optional(Schema.String.annotations({description: 'Only turns carrying this tag, e.g. sack, pivot, speed-control, set-up, search-overrode, we-fall.'})),
	detail: Schema.optional(Schema.Boolean.annotations({description: 'Include what the screen offered and what the search scored each option. Default false.'}))});

/** A tool with its argument type erased: what it is called, what it takes, and how to call it with anything. */
export interface AnyTool {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: unknown;
	readonly call: (args: unknown) => Effect.Effect<unknown, string>;
}

/**
 * The one place a tool's argument TYPE exists. `run` is written against the
 * decoded arguments; what leaves here decodes first, so no caller can reach
 * `run` with anything the schema did not accept — and nothing downstream
 * needs a cast to hold tools of different shapes in one list.
 */
const tool = <A, I>(definition: {readonly name: string; readonly description: string;
	readonly input: Schema.Schema<A, I>; readonly run: (args: A) => Effect.Effect<unknown, string>}): AnyTool => ({
	name: definition.name,
	description: definition.description,
	inputSchema: JSONSchema.make(definition.input),
	call: args => Schema.decodeUnknown(definition.input)(args).pipe(
		Effect.mapError(error => 'bad arguments for ' + definition.name + ':\n' + ParseResult.TreeFormatter.formatErrorSync(error)),
		Effect.flatMap(definition.run)),
});

/** A failure to load a record, as the sentence an agent should read. */
const loaded = (report: string) => loadRunWithFights(report).pipe(Effect.mapError(error =>
	error._tag === 'NotARun' ? report + ' is not a run record:\n' + error.issue :
	error._tag === 'NotJson' ? report + ' is not JSON' : 'cannot read ' + report));

export const TOOLS: ReadonlyArray<AnyTool> = [
	tool({name: 'run_strategy', input: Schema.Struct({report: Report}),
		description: 'What a run\'s WINS are made of against its losses, pooled over every logged wall: per kind of turn (speed-control, pivot, sack, set-up, status, …) the mean per winning attempt against the mean per losing attempt; what a win costs in bodies and how many were clean; the crit edge in wins and in losses (how much of winning is dice); and which leads win. Use this for "which strategies are beating the game".',
		run: args => loaded(args.report).pipe(Effect.map(strategyOf))}),
	tool({name: 'list_walls', input: ListWalls,
		description: 'The fights of a run that took more than one attempt: how many attempts, which one won (or none), how many kept a turn-by-turn log. Start here.',
		run: args => loaded(args.report).pipe(Effect.map(run => walls(run)
			.filter(wall => wall.attempts >= (args.minAttempts ?? 2))
			.map(wall => ({trainer: wall.trainer, order: wall.order, attempts: wall.attempts, wonOn: wall.wonOn,
				logged: wall.logged, attemptNumbers: wall.summaries.map(entry => entry.n)}))))}),
	tool({name: 'compare_attempts', input: CompareAttempts,
		description: 'One fight: every attempt\'s outcome, lead, bodies lost and what each of theirs cost — and, per kind of turn (speed-control, pivot, sack, set-up, …), how many the WIN took against the mean of the losses. This is the "what did the win do differently" question.',
		run: args => loaded(args.report).pipe(Effect.flatMap(run => {
			const wall = walls(run).find(entry => entry.trainer === args.trainer);
			return wall === undefined ?
				Effect.fail('this run never fought ' + args.trainer + '; list_walls names the fights it did') :
				Effect.succeed({trainer: wall.trainer, wonOn: wall.wonOn, tagLift: wall.tagLift,
					attempts: wall.summaries.map(entry => ({n: entry.n, result: entry.result, policy: entry.policy,
						turns: entry.turns, foeLeft: entry.foeLeft, bodiesLost: entry.bodiesLost, lead: entry.lead,
						order: entry.order, foeCosts: entry.foeCosts, hasLog: entry.hasLog}))});
		}))}),
	tool({name: 'wall_view', input: WallViewArgs,
		description: 'A wall read PER FOE: for each of theirs, the attempts it was met in, the bodies of ours it took a facing (charged to the foe that was acting when the body fell, off the ledger; a body that fell on our own switch or move is charged to no foe), how often it fell, the turns it stayed a facing, what it killed us with and whom — and the same readings in the winning attempt beside the mean of the losses. Most costly foe in the losses first. Also the bodies whose ledger names no actor (unattributed: end-of-turn damage), those lost to hazards on our own switch (hazards) and to our own move (selfInflicted), whether our side was read by species on an old record (approximate), the tag lift (win against losses), and every attempt\'s ledger number, which get_turns opens. Works for doubles. This is the "which of theirs is the wall" question.',
		run: args => loaded(args.report).pipe(Effect.flatMap(run => {
			if (args.trainer === undefined) return Effect.succeed<unknown>(wallViews(run, args.minAttempts ?? WALL_ATTEMPTS));
			const view = wallView(run, args.trainer);
			return view === null ? Effect.fail('this run never fought ' + args.trainer + '; list_walls names the fights it did') :
				Effect.succeed<unknown>(view);
		}))}),
	tool({name: 'get_attempt', input: GetAttempt,
		description: 'One attempt: the six that fought it (items, abilities, natures, moves), who fell to what, who knocked out what, and the pre-fight probe.',
		run: args => loaded(args.report).pipe(Effect.flatMap(run => {
			const attempt = run.ledger.find(entry => entry.n === args.n);
			return attempt === undefined ? Effect.fail('no attempt numbered ' + args.n) :
				Effect.succeed({trainer: attempt.trainer, seed: attempt.seed, result: attempt.result, policy: attempt.policy,
					turns: attempt.turns, foeLeft: attempt.foeLeft, six: attempt.six ?? [], fell: attempt.killers ?? [],
					knockouts: attempt.kos ?? [], probe: attempt.probe ?? null, loggedTurns: (attempt.log ?? []).length});
		}))}),
	tool({name: 'get_turns', input: GetTurns,
		description: 'An attempt turn by turn: who faced whom at what health, what was chosen and why, the tags on the turn, and what happened. With detail=true, also every option on the screen with its forecast or priced race, and the rollout value the search gave each one.',
		run: args => loaded(args.report).pipe(Effect.flatMap(run => {
			const attempt = run.ledger.find(entry => entry.n === args.n);
			if (attempt === undefined) return Effect.fail('no attempt numbered ' + args.n);
			// A double's tape is events, not turns: each line read for whose it was and what it did.
			if ((attempt.log === undefined || attempt.log.length === 0) && attempt.events !== undefined) {
				const ours = new Set((attempt.six ?? []).map(member => member.species));
				const lines: unknown = {double: true, lines: attempt.events.map(event => ({...event,
					read: readDoublesLine(event, ours)}))
					.filter(line => args.tag === undefined || (line.read?.tags ?? []).some(tag => tag === args.tag))};
				return Effect.succeed(lines);
			}
			if (attempt.log === undefined) return Effect.fail('attempt ' + args.n + ' kept no log (played before fight logs, or --fight-logs excluded it)');
			return Effect.succeed<unknown>(attempt.log.map(turn => ({...turn, tags: tagsOf(turn)}))
				.filter(turn => args.tag === undefined || turn.tags.some(tag => tag === args.tag))
				.map(turn => args.detail === true ? turn : {turn: turn.turn, us: turn.us, usHp: turn.usHp, foe: turn.foe,
					foeHp: turn.foeHp, chose: turn.chose, why: turn.why, tags: turn.tags, events: turn.events}));
		}))}),
	tool({name: 'list_live_runs', input: Schema.Struct({dir: Schema.String}),
		description: 'Every run under a runs directory (ui-playthrough-out/runs), most recently written first: its state (running, paused, stopping, stopped, ended, finished, or dead — running over a process that is gone), position, fights played, seconds per fight, memory, its knobs, and the fight it is in. Also the machine: slots held of how many, and the load.',
		run: args => Effect.tryPromise({try: async () => {
			const dir = path.resolve(args.dir);
			const runs = await Promise.all((await listRuns(dir)).map(async name => {
				const status = await Effect.runPromise(readStatus(path.join(dir, name + '.status.json')));
				const live = await Effect.runPromise(readLive(path.join(dir, name + '.live.ndjson')));
				return {run: name, state: status?.state ?? 'unknown (no status file: started before run control)',
					position: status?.position ?? live.header?.position ?? null, fights: status?.fights ?? null,
					secondsPerFight: status?.secondsPerFight ?? null, rssMb: status?.rssMb ?? null, spec: status?.spec ?? null,
					facing: live.header?.trainer ?? null, attempt: live.header?.attempt ?? null, hand: live.header?.hand ?? null};
			}));
			return {machine: await readMachine(), runs};
		}, catch: cause => 'cannot read ' + args.dir + ': ' + String(cause)})}),
	tool({name: 'control_run', input: Schema.Struct({dir: Schema.String, run: Schema.String,
		action: Schema.Literal('stop', 'pause', 'cont')}),
		description: 'Stop, pause or continue ONE run, named as list_live_runs names it. stop asks: the run checkpoints and exits after the fight it is in, and can be carried on later (node scripts/runs.js carry-on RUN [--spec=...]). pause and cont signal its process at once. Goes by the pid in the run\'s own status file; never starts a process.',
		run: args => /^([A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+$/.test(args.run) && !args.run.includes('..') ?
			Effect.tryPromise({try: () => control(path.resolve(args.dir), args.run, args.action), catch: cause => String(cause)}) :
			Effect.fail('a run is named LABEL/run-SEED')}),
];

/** Run a tool by name and shape an MCP result; a failure is a result too, never a throw. */
export const callTool = (name: string, args: unknown): Effect.Effect<unknown, never> => {
	const found = TOOLS.find(entry => entry.name === name);
	if (found === undefined) return Effect.succeed({isError: true, content: [{type: 'text', text: 'unknown tool: ' + name}]});
	return found.call(args).pipe(
		Effect.map(value => ({content: [{type: 'text', text: JSON.stringify(value, null, 1)}]})),
		Effect.catchAll(message => Effect.succeed({isError: true, content: [{type: 'text', text: message}]})),
	);
};

interface Rpc {readonly id?: unknown; readonly method?: string; readonly params?: {readonly name?: string; readonly arguments?: unknown}}

export const handle = (message: Rpc): Effect.Effect<unknown | null, never> => {
	const reply = (result: unknown): unknown => ({jsonrpc: '2.0', id: message.id ?? null, result});
	switch (message.method) {
	case 'initialize':
		return Effect.succeed(reply({protocolVersion: '2024-11-05', capabilities: {tools: {}},
			serverInfo: {name: 'runbun-insight', version: '0.1.0'}}));
	case 'tools/list':
		return Effect.succeed(reply({tools: TOOLS.map(entry => ({name: entry.name, description: entry.description, inputSchema: entry.inputSchema}))}));
	case 'tools/call':
		return callTool(message.params?.name ?? '', message.params?.arguments ?? {}).pipe(Effect.map(reply));
	default:
		return Effect.succeed(message.id === undefined ? null :
			{jsonrpc: '2.0', id: message.id, error: {code: -32601, message: 'method not found: ' + String(message.method)}});
	}
};

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
	const lines = readline.createInterface({input: process.stdin});
	lines.on('line', line => {
		if (line.trim() === '') return;
		let message: Rpc;
		try { message = JSON.parse(line) as Rpc; } catch { return; }
		void Effect.runPromise(handle(message)).then(out => {
			if (out !== null) process.stdout.write(JSON.stringify(out) + '\n');
		});
	});
}
