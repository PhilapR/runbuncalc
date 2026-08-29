/* eslint-env node, es6 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const root = path.join(__dirname, '..');

// The ledger's fixed_in discipline, extended to the experiment manifests.
// A manifest in scenarios/ is a claim: "these scenarios were measured, by
// these batches, and the numbers can be believed". Before 2026-08-29 the
// claim rested on batch labels alone — skipwall1 and skipwall2 are void,
// brkeys1 and brkeys2 are void, and nothing but session memory says which
// tallies still count. A `measured` entry names the batch label and the
// commit that carries the batch, and this gate verifies the commit the same
// way tests/ledger.test.js verifies a fix: it is on this branch, and it
// touched the file it claims to have measured.

const VERDICTS = new Set(['recorded', 'reconstructed', 'void']);

function manifests() {
	const dir = path.join(root, 'scenarios');
	return fs.readdirSync(dir).filter(name => name.endsWith('.json'))
		.map(name => ({
			file: path.join('scenarios', name),
			doc: JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')),
		}));
}

test('every manifest is a recipe someone can rerun', () => {
	const all = manifests();
	assert.ok(all.length, 'scenarios/ holds manifests');
	for (const entry of all) {
		const file = entry.file;
		const doc = entry.doc;
		assert.ok(doc.comment, `${file} explains itself`);
		assert.ok(Array.isArray(doc.scenarios) && doc.scenarios.length,
			`${file} lists scenarios`);
		for (const row of doc.scenarios) {
			assert.ok(row.name && row.report && row.trainer,
				`${file}: a scenario names itself, its report, and its trainer`);
		}
		// `generator` is the script that rewrites this manifest's derived
		// documents; null means curated by hand (battery.json banks real run
		// docs, nothing regenerates them). A named generator must exist —
		// a manifest pointing at a renamed script is a recipe nobody can rerun.
		assert.ok('generator' in doc, `${file} declares its generator, even as null`);
		if (doc.generator !== null) {
			assert.ok(fs.existsSync(path.join(root, doc.generator)),
				`${file} names generator ${doc.generator}, which does not exist`);
		}
	}
});

test('a measured stamp names a batch and the commit that carries it', () => {
	// Same shallow-clone refusal as the ledger gate: ancestry cannot be
	// answered from a depth-1 checkout, and the failure is indistinguishable
	// from a real breach.
	const shallow = childProcess.execFileSync('git',
		['rev-parse', '--is-shallow-repository'],
		{cwd: root, encoding: 'utf8'}).trim() === 'true';
	assert.equal(shallow, false,
		'this is a shallow clone, so no commit can be shown to be an ancestor — ' +
		'the checkout needs fetch-depth: 0 before this gate means anything');

	const seen = new Map();
	let stamps = 0;
	for (const manifest of manifests()) {
		const file = manifest.file;
		for (const entry of manifest.doc.measured || []) {
			stamps += 1;
			assert.match(entry.label || '', /^[a-z0-9][a-z0-9-]*$/,
				`${file}: a measured entry needs a batch label`);
			// One label, one batch, one manifest. A label stamped twice is
			// two claims sharing one identity, and the void-batch history is
			// exactly why that ambiguity cannot be allowed to accrete.
			assert.ok(!seen.has(entry.label),
				`label ${entry.label} is stamped on both ${seen.get(entry.label)} and ${file}`);
			seen.set(entry.label, file);
			assert.match(entry.date || '', /^\d{4}-\d{2}-\d{2}$/,
				`${file}/${entry.label}: the date is a day, not prose`);
			// recorded: the battery wrote its own revision (post-2026-08-29).
			// reconstructed: the carrying commit was established after the
			// fact from mtimes and the log — believable, but weaker.
			// void: the batch is disowned; the entry stays because deleting
			// a void stamp re-opens the door to re-counting the batch.
			assert.ok(VERDICTS.has(entry.verdict),
				`${file}/${entry.label}: verdict ${entry.verdict} is not in the vocabulary`);

			// ANCESTRY, then CONTAINMENT — the ledger gate's two teeth, for
			// the reasons learned there: a dangling SHA survives `cat-file -e`
			// until gc, and an ancestor that did not do the work stays green
			// unless the touched files are checked.
			assert.doesNotThrow(
				() => childProcess.execFileSync('git',
					['merge-base', '--is-ancestor', entry.measured_in, 'HEAD'],
					{cwd: root, stdio: 'ignore'}),
				`${file}/${entry.label} names commit ${entry.measured_in}, ` +
				'which is not an ancestor of HEAD');
			const touched = childProcess.execFileSync('git',
				['show', '--name-only', '--format=', entry.measured_in],
				{cwd: root, encoding: 'utf8'})
				.split('\n').map(line => line.trim()).filter(Boolean);
			assert.ok(touched.includes(file),
				`${file}/${entry.label} says commit ${entry.measured_in} carries ` +
				`the batch, but that commit does not touch ${file}`);
		}
	}
	assert.ok(stamps > 0, 'at least one manifest records a measurement — ' +
		'a gate that checks an empty set proves nothing');
});
