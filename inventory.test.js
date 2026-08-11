/* eslint-env node, es6 */
'use strict';

/**
 * The inventory gate: INVENTORY.md must be exactly what the code generates.
 *
 * Manual capability docs fall behind — this repo learned that when a mechanic
 * it needed had already been built in a sibling repo nothing here referenced.
 * The inventory is therefore derived from the code, and this test makes drift
 * a red gate instead of a quiet lie: add an endpoint, a command, a subcommand
 * or a panel and forget to regenerate, and this fails with the instruction.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const generator = require('./scripts/inventory.js');
const inventory = generator.inventory;
const render = generator.render;

test('INVENTORY.md matches what the code generates', () => {
	const committed = fs.readFileSync(path.join(__dirname, 'INVENTORY.md'), 'utf8');
	const generated = render(inventory());
	assert.equal(committed, generated,
		'INVENTORY.md is stale — run `node scripts/inventory.js` and commit the result');
});

test('every ecosystem claim that can be checked on this machine holds', () => {
	// A clone that is absent is honestly unverifiable here; a clone that is
	// present must contain every path its claims cite.
	const inv = inventory();
	for (const source of inv.ecosystem.sources) {
		assert.ok(source.verification !== 'CLAIM PATH MISSING — fix ECOSYSTEM.json',
			`${source.repo}: a capability cites a path the clone does not contain`);
	}
});
