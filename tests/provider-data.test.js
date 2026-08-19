/* eslint-env node, es6 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {computeDiff, vendorSpecies} = require('../scripts/diff-provider-data.js');

const LEDGER = path.join(__dirname, '..', 'vendor', 'pokemon-run-runtime', 'DATA-DIVERGENCES.json');

test('the provider data divergence ledger matches what the pinned bundle actually embeds', () => {
	const committed = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
	const computed = computeDiff();
	// The Policy-B valve: a re-pin or a fork data change that shifts this set
	// must rewrite the ledger in the same change — silence is impossible,
	// honesty costs one --write.
	assert.equal(committed.providerRevision, computed.providerRevision,
		'the ledger must be regenerated when the provider is re-pinned');
	assert.deepEqual(committed.entries, computed.entries,
		'divergences drifted — rerun scripts/diff-provider-data.js --write and commit the ledger');
	// The known worst case stays visible until mono curates it away: the
	// provider plans Azumarill lines with vanilla attacking stats.
	assert.ok(computed.entries.some(entry =>
		entry.species === 'Marill' && entry.field === 'baseStats.atk' &&
		entry.vendor === 20 && entry.fork === 35),
	'the Marill divergence is the documented sentinel; its absence means the data was fixed — retire this assertion WITH the re-pin');
});

test('the vendor extraction reads a plausible species table, not a lucky regex', () => {
	const found = vendorSpecies();
	const names = Object.keys(found);
	assert.ok(names.length > 800, 'the bundle embeds the full dex, found ' + names.length);
	const marill = found.Marill;
	assert.deepEqual(marill.baseStats,
		{hp: 70, atk: 20, def: 50, spa: 20, spd: 50, spe: 40},
		'extraction must read exact embedded values');
	assert.deepEqual(marill.abilities, ['Thick Fat']);
});
