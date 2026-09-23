/* eslint-env node, es6 */
'use strict';

/**
 * Every test in a Chromium-driven file carries the file's skip guard.
 *
 * Those files declare `const skip = ...` ("playwright-core is not installed")
 * and pass `{skip}` to each test, so a machine without Chromium skips them
 * instead of throwing. A race test added to browser_run.test.js on
 * 2026-08-20 was the one of 28 without it (fixed in 3df343c); nothing
 * stopped the next one. This reads each such file and names any top-level
 * test whose options leave the guard out.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const TESTS = __dirname;

/** Top-level test names in `source` whose options do not name `skip`. */
function unguarded(source) {
	const out = [];
	const starts = [...source.matchAll(/^test\(/gm)].map(match => match.index);
	for (const start of starts) {
		// The options sit between the name and the body.
		const head = source.slice(start, start + 600);
		const body = /(async\s*)?\(\s*(t\s*)?\)\s*=>/.exec(head);
		const options = body ? head.slice(0, body.index) : head;
		if (!/\bskip\b/.test(options)) out.push(/^test\(\s*(['"`])(.*?)\1/s.exec(head)[2]);
	}
	return out;
}

test('every test in a Chromium-driven file carries the skip guard', () => {
	const files = fs.readdirSync(TESTS).filter(name => /^browser_.*\.test\.js$/.test(name))
		.filter(name => /^const skip = /m.test(fs.readFileSync(path.join(TESTS, name), 'utf8')));
	assert.ok(files.includes('browser_run.test.js'), 'the guarded files are found: ' + files.join(', '));
	const missing = [];
	for (const name of files) {
		for (const title of unguarded(fs.readFileSync(path.join(TESTS, name), 'utf8'))) {
			missing.push(name + ': ' + title);
		}
	}
	assert.deepEqual(missing, [], 'these tests throw without Chromium instead of skipping');
});

test('the reader sees the guard on either line, and its absence', () => {
	assert.deepEqual(unguarded("test('a', {skip}, async () => {});\n" +
		"test('b',\n\t{skip, timeout: 1}, async () => {});\n" +
		"test('c', async () => {});\n"), ['c']);
});
