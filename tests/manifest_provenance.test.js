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
			// The carrying commit touches the manifest OR the batch's receipt.
			// The first alone would refuse a re-measure of an unchanged
			// manifest: run the battery again, and the only new file the
			// carrying commit holds is the receipt.
			const receiptPath = path.join('scenarios', 'receipts', entry.label + '.json');
			assert.ok(touched.includes(file) || touched.includes(receiptPath),
				`${file}/${entry.label} says commit ${entry.measured_in} carries ` +
				`the batch, but that commit touches neither ${file} nor ${receiptPath}`);

			// A "recorded" verdict is the strong claim — the battery wrote its
			// own revision — so the gate demands the evidence: a tracked
			// receipt, committed with the batch, whose revision precedes the
			// carrying commit on this branch. Anything less is what
			// "reconstructed" is for.
			if (entry.verdict === 'recorded') {
				assert.ok(fs.existsSync(path.join(root, receiptPath)),
					`${file}/${entry.label} claims verdict recorded but has no ` +
					`receipt at ${receiptPath}`);
				const receipt = JSON.parse(
					fs.readFileSync(path.join(root, receiptPath), 'utf8'));
				const revision = (receipt.provenance || {}).revision;
				assert.ok(revision,
					`${receiptPath} records no revision — the verdict cannot be recorded`);
				assert.doesNotThrow(
					() => childProcess.execFileSync('git',
						['merge-base', '--is-ancestor', revision, entry.measured_in],
						{cwd: root, stdio: 'ignore'}),
					`${receiptPath} says the batch ran at ${revision}, which does not ` +
					`precede the carrying commit ${entry.measured_in} on this branch`);
				assert.ok(touched.includes(receiptPath),
					`${file}/${entry.label} is recorded, so the carrying commit ` +
					`${entry.measured_in} must be the one that landed ${receiptPath}`);
			}
		}
	}
	assert.ok(stamps > 0, 'at least one manifest records a measurement — ' +
		'a gate that checks an empty set proves nothing');
});

test('every receipt is a batch the repository can still name', () => {
	// The receipt directory is the tracked half of ui-playthrough-out: the
	// battery writes both, git keeps one. A receipt may be unstamped — a
	// batch lands one commit before its stamp, and the suite must be green
	// in between — but it may not be malformed, mislabelled, or point at a
	// revision that left the branch.
	const dir = path.join(root, 'scenarios', 'receipts');
	const files = fs.readdirSync(dir).filter(name => name.endsWith('.json'));
	assert.ok(files.length, 'scenarios/receipts holds receipts');
	for (const name of files) {
		const receipt = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
		assert.equal(receipt.label + '.json', name,
			`${name} carries the label ${receipt.label} — the filename lies`);
		assert.ok(Array.isArray(receipt.argv),
			`${name} records no argv, so nobody can rerun the batch`);
		assert.ok(Array.isArray(receipt.results) && receipt.results.length,
			`${name} carries no results`);
		const prov = receipt.provenance || {};
		assert.ok(!Number.isNaN(Date.parse(prov.date || '')),
			`${name} has no parseable date`);
		if (receipt.manifest !== null) {
			assert.ok(fs.existsSync(path.join(root, receipt.manifest)),
				`${name} names manifest ${receipt.manifest}, which does not exist`);
		}
		// null revision: a back-filled receipt for a batch that ran before
		// the battery recorded provenance (pre-2026-08-29). Its stamp says
		// "reconstructed" and this gate holds it to nothing more.
		if (prov.revision !== null) {
			assert.doesNotThrow(
				() => childProcess.execFileSync('git',
					['merge-base', '--is-ancestor', prov.revision, 'HEAD'],
					{cwd: root, stdio: 'ignore'}),
				`${name} says the batch ran at ${prov.revision}, ` +
				'which is not an ancestor of HEAD');
		}
	}
});
