/* eslint-env node, es6 */
'use strict';

/**
 * Where a run's fights go: a compressed sidecar, one attempt a line, written
 * as each attempt ends.
 *
 * The first cut kept every attempt's turn-by-turn log INLINE on its ledger
 * row. Measured on a logged run (2026-09-21): 243 KB of log for seven
 * attempts, 48% of it the options table repeated every turn — about 36 KB an
 * attempt, so a full run with forty tries at a dozen walls is ~17 MB of JSON
 * held in memory and written once, at the end. A crashed or killed run lost
 * every fight it had played, which are exactly the runs worth reading.
 *
 * So: `<run>.fights.ndjson.gz`. NDJSON because one attempt is one record and
 * a line is the unit a crash can lose; gzip because the text is redundant
 * (13x on that run) and because EVERYTHING reads it without a dependency —
 * zcat, Python, Node's zlib, a browser's DecompressionStream, and DuckDB,
 * which turns it into Parquet in one statement when the question is across
 * runs rather than inside one:
 *
 *   COPY (SELECT * FROM read_ndjson('runs/*.fights.ndjson.gz'))
 *     TO 'fights.parquet' (FORMAT parquet, COMPRESSION zstd);
 *
 * Parquet is deliberately NOT the write format: it wants a native dependency
 * in the harness's hot loop, and it cannot be appended to a line at a time.
 *
 * Each attempt is its own gzip member, appended synchronously. The harness is
 * synchronous end to end, so a stream would buffer the whole run in memory
 * until the event loop turned — the problem this file exists to remove. A
 * file of concatenated members is a valid gzip file, and a run killed mid-
 * fight leaves every finished attempt readable.
 */

const fs = require('node:fs');
const zlib = require('node:zlib');

/** Open (truncating) a sidecar; returns {append, lines, path}. */
function openFightLog(file) {
	fs.writeFileSync(file, '');
	let lines = 0;
	return {
		path: file,
		/** Write one attempt; returns the line it landed on, for the ledger row. */
		append(record) {
			const member = zlib.gzipSync(JSON.stringify(record) + '\n', {level: 6});
			fs.appendFileSync(file, member);
			lines += 1;
			return lines - 1;
		},
		get lines() { return lines; },
	};
}

/** Every attempt in a sidecar, in order. A truncated last member is dropped, not fatal. */
function readFightLog(file) {
	const raw = fs.readFileSync(file);
	let text;
	let torn = false;
	try {
		text = zlib.gunzipSync(raw).toString('utf8');
	} catch (error) {
		// A run killed mid-write leaves a torn last member. Z_SYNC_FLUSH is
		// zlib's own answer to truncated input: it returns everything that
		// decompressed before the tear instead of refusing the whole file.
		text = zlib.gunzipSync(raw, {finishFlush: zlib.constants.Z_SYNC_FLUSH}).toString('utf8');
		torn = true;
	}
	const lines = text.split('\n').filter(Boolean);
	const out = [];
	for (let index = 0; index < lines.length; index++) {
		try {
			out.push(JSON.parse(lines[index]));
		} catch (error) {
			// Only the LAST line of a torn file may be partial; anything else
			// is corruption and must not be skipped past quietly.
			if (torn && index === lines.length - 1) break;
			throw new Error(file + ': line ' + index + ' is not JSON');
		}
	}
	return out;
}

module.exports = {openFightLog, readFightLog};
