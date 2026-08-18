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

const generator = require('../scripts/inventory.js');
const inventory = generator.inventory;
const render = generator.render;
const DOCS_MARKER = generator.DOCS_MARKER;

test('INVENTORY.md matches what the code generates', () => {
	const committed = fs.readFileSync(path.join(__dirname, '..', 'docs', 'INVENTORY.md'), 'utf8');
	const generated = render(inventory());
	// Everything above the doc-stamps marker is gated byte-for-byte. The
	// stamps below it are advisory: a stamp changes at the very commit that
	// touches its doc, so gating it would demand a follow-up commit forever.
	assert.equal(committed.split(DOCS_MARKER)[0], generated.split(DOCS_MARKER)[0],
		'INVENTORY.md is stale — run `node scripts/inventory.js` and commit the result');
	assert.ok(committed.includes(DOCS_MARKER),
		'INVENTORY.md lost its doc-stamps section — regenerate it');
});

test('every ruling in DECISIONS.json is enforced by files that exist', () => {
	// A ruling whose enforcing file vanished is a law with no police — it reads
	// as still in force while nothing implements it. Open questions must say
	// what would settle them, or they are complaints rather than questions.
	const ledger = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'DECISIONS.json'), 'utf8'));
	const ids = new Set();
	for (const decision of ledger.decisions) {
		assert.ok(decision.id && decision.date && decision.ruling && decision.why,
			`ruling ${decision.id || '(unnamed)'} is missing a field`);
		assert.ok(!ids.has(decision.id), `duplicate ruling id ${decision.id}`);
		ids.add(decision.id);
		assert.ok(Array.isArray(decision.enforcedBy) && decision.enforcedBy.length,
			`ruling ${decision.id} names nothing that enforces it`);
		for (const file of decision.enforcedBy) {
			assert.ok(fs.existsSync(path.join(__dirname, '..', file)),
				`ruling ${decision.id} cites ${file}, which does not exist`);
		}
	}
	for (const question of ledger.open) {
		assert.ok(question.id && question.question && question.raised && question.settledBy,
			`open question ${question.id || '(unnamed)'} is missing a field`);
		assert.ok(!ids.has(question.id), `open question ${question.id} collides with a ruling`);
		ids.add(question.id);
	}
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
