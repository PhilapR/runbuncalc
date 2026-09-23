/* eslint-env node, es6 */
'use strict';

/**
 * The fast tier must stay honest about what it skips.
 *
 * `npm run test:fast` is the suite minus a named list of minutes-long files.
 * The danger is silent drift: rename a slow test file and its name in the
 * list matches nothing, so the file quietly rejoins the fast tier and the
 * loop is six minutes again with nobody told. This gate makes every name in
 * the list point at a real file, and makes the split a fact the suite checks.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const tier = require('../scripts/fast-tests.js');

const ROOT = path.join(__dirname, '..');

test('every file the fast tier skips is a test file that exists', () => {
	const present = new Set(fs.readdirSync(__dirname).filter(name => name.endsWith('.test.js')));
	for (const name of Object.keys(tier.SLOW)) {
		assert.ok(present.has(name),
			`scripts/fast-tests.js names ${name} as slow, but tests/${name} does not exist — ` +
			'rename it in SLOW or drop the entry, or the file rejoins the fast tier unannounced');
	}
});

test('no file in the fast tier drives a browser', () => {
	// A new Playwright test added without a SLOW entry would put a browser
	// launch — over a minute, and a download when the cache is empty — back
	// into the per-change loop. The fast tier must stay pure Node.
	for (const file of tier.fastFiles(ROOT)) {
		const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
		assert.doesNotMatch(source, /require\((['"])(playwright|\.\/helpers\/browser-run)/,
			file + ' drives a browser but is not named in scripts/fast-tests.js SLOW');
	}
});

test('npm run test:fast runs the list this module prints', () => {
	const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
	assert.match(pkg.scripts['test:fast'], /scripts\/fast-tests\.js/);
});
