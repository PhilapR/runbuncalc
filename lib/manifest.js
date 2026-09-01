/* eslint-env node, es6 */
'use strict';

const fs = require('node:fs');

/**
 * The one writer for scenario manifests, because every generator that owns
 * one rewrites it wholesale — and a wholesale rewrite erases the manifest's
 * measurement history.
 *
 * A manifest is two things at once: a recipe (comment, generator, scenarios)
 * that its script regenerates freely, and a record (`measured`) of which
 * battery batches graded it and which commit carries each batch. The recipe
 * belongs to the generator; the record belongs to the ledger discipline —
 * stamped by hand in the commit after the batch lands, verified by
 * tests/manifest_provenance.test.js the same way a ledger `fixed_in` is:
 * ancestry on the branch, and the commit touches the file it claims.
 *
 * So this writer carries `measured` forward from the file on disk. A
 * generator cannot un-measure a manifest by regenerating it.
 */
function writeManifest(file, doc) {
	let measured = [];
	try {
		const prior = JSON.parse(fs.readFileSync(file, 'utf8'));
		if (Array.isArray(prior.measured)) measured = prior.measured;
	} catch (error) { /* first write: no history to carry */ }
	fs.writeFileSync(file, JSON.stringify({
		comment: doc.comment,
		generator: doc.generator || null,
		measured,
		scenarios: doc.scenarios,
	}, null, '\t') + '\n');
	return measured;
}

module.exports = {writeManifest};
