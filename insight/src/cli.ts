/**
 * insight: a run record in, one HTML page out.
 *
 *   node dist/src/cli.js --report=RUN.json [--out=fight-log.html] [--title=...]
 *
 * An Effect program so that every way this can fail is in its type: the file
 * is not there, it is not JSON, or it is not a run record (and then WHICH
 * field moved). None of them is an exception three calls deep.
 */
import {Data, Effect, ParseResult} from 'effect';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {decodeRun, type RunRecord} from './schema.js';
import {renderPage} from './viewer.js';

export class ReadFailed extends Data.TaggedError('ReadFailed')<{readonly file: string; readonly cause: unknown}> {}
export class NotJson extends Data.TaggedError('NotJson')<{readonly file: string; readonly cause: unknown}> {}
export class NotARun extends Data.TaggedError('NotARun')<{readonly file: string; readonly issue: string}> {}
export class WriteFailed extends Data.TaggedError('WriteFailed')<{readonly file: string; readonly cause: unknown}> {}
export class BadArguments extends Data.TaggedError('BadArguments')<{readonly usage: string}> {}

const flag = (argv: ReadonlyArray<string>, name: string): string | undefined => {
	const hit = argv.find(arg => arg.startsWith('--' + name + '='));
	return hit === undefined ? undefined : hit.slice(name.length + 3);
};

/** A run record off disk, decoded — or the reason it is not one. */
export const loadRun = (file: string): Effect.Effect<RunRecord, ReadFailed | NotJson | NotARun> =>
	Effect.gen(function* () {
		const text = yield* Effect.tryPromise({
			try: () => fs.readFile(file, 'utf8'),
			catch: cause => new ReadFailed({file, cause}),
		});
		const json: unknown = yield* Effect.try({
			try: () => JSON.parse(text) as unknown,
			catch: cause => new NotJson({file, cause}),
		});
		return yield* decodeRun(json).pipe(
			Effect.mapError(error => new NotARun({file, issue: ParseResult.TreeFormatter.formatErrorSync(error)})),
		);
	});

export const buildPage = (argv: ReadonlyArray<string>): Effect.Effect<string, ReadFailed | NotJson | NotARun | WriteFailed | BadArguments> =>
	Effect.gen(function* () {
		const report = flag(argv, 'report');
		if (report === undefined) {
			return yield* new BadArguments({usage: 'node dist/src/cli.js --report=RUN.json [--out=fight-log.html] [--title=TEXT]'});
		}
		const run = yield* loadRun(report);
		const out = flag(argv, 'out') ?? path.join(path.dirname(report), path.basename(report, '.json') + '.fight-log.html');
		const title = flag(argv, 'title') ?? `${run.starter ?? 'run'}, seed ${run.seed}`;
		const html = renderPage(run, title);
		yield* Effect.tryPromise({
			try: () => fs.writeFile(out, html, 'utf8'),
			catch: cause => new WriteFailed({file: out, cause}),
		});
		return out;
	});

const main = buildPage(process.argv.slice(2)).pipe(
	Effect.tap(out => Effect.sync(() => process.stdout.write('wrote ' + out + '\n'))),
	Effect.catchTags({
		BadArguments: error => Effect.sync(() => { process.stderr.write('usage: ' + error.usage + '\n'); process.exitCode = 2; }),
		ReadFailed: error => Effect.sync(() => { process.stderr.write('cannot read ' + error.file + '\n'); process.exitCode = 1; }),
		NotJson: error => Effect.sync(() => { process.stderr.write(error.file + ' is not JSON\n'); process.exitCode = 1; }),
		NotARun: error => Effect.sync(() => { process.stderr.write(error.file + ' is not a run record:\n' + error.issue + '\n'); process.exitCode = 1; }),
		WriteFailed: error => Effect.sync(() => { process.stderr.write('cannot write ' + error.file + '\n'); process.exitCode = 1; }),
	}),
);

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
	void Effect.runPromise(main);
}
