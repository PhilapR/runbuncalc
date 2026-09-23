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

/**
 * Open a sidecar; returns {append, lines, bytes, path}. It starts empty,
 * unless `carryOn` ({bytes, lines}, from a run's checkpoint) says where a
 * stopped run had got to: the file is then cut back to exactly there —
 * attempts written after the checkpoint will be played and written again —
 * and appended to.
 */
function openFightLog(file, carryOn) {
	let lines = 0;
	if (carryOn && fs.existsSync(file) && fs.statSync(file).size >= carryOn.bytes) {
		fs.truncateSync(file, carryOn.bytes);
		lines = carryOn.lines;
	} else {
		fs.writeFileSync(file, '');
	}
	return {
		path: file,
		get bytes() { return fs.statSync(file).size; },
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

/**
 * A tape that can be WATCHED: an array whose push also appends the turn to a
 * plain NDJSON file, synchronously, the moment it is decided.
 *
 * The sidecar is for afterwards — an attempt lands when it ends. Watching a
 * run needs the fight as it happens, and both hands (decide's loop and
 * playSearch) already report each turn by pushing it onto a `tape` array, so
 * the tape itself is the hook and neither of them changes. The file holds ONE
 * attempt: `begin` truncates it and writes a header line (which fight, which
 * attempt, the six), so a reader never needs more than the current fight, and
 * the file never grows past one. Uncompressed on purpose — it is small,
 * short-lived, and must be readable mid-write.
 */
function liveTape(file, header) {
	fs.writeFileSync(file, JSON.stringify(Object.assign({kind: 'attempt', at: Date.now()}, header)) + '\n');
	const tape = [];
	const push = Array.prototype.push;
	tape.push = function watched() {
		for (const row of arguments) {
			try { fs.appendFileSync(file, JSON.stringify(Object.assign({kind: 'turn'}, row)) + '\n'); } catch (error) { /* watching must never stop a run */ }
		}
		return push.apply(this, arguments);
	};
	tape.end = result => {
		try { fs.appendFileSync(file, JSON.stringify({kind: 'end', at: Date.now(), result}) + '\n'); } catch (error) { /* as above */ }
	};
	return tape;
}

module.exports = {openFightLog, readFightLog, liveTape};
