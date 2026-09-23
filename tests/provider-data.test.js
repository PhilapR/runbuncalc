/* eslint-env node, es6 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const providerDiff = require('../scripts/diff-provider-data.js');
const computeDiff = providerDiff.computeDiff;
const vendorSpecies = providerDiff.vendorSpecies;

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
	// The Marill sentinel is retired, as its own message instructed, because
	// the re-pin fixed it: the provider embedded vanilla 20/20 attacking stats
	// where BASE_STAT_CHANGES declares 35/35, and bf28a069 corrects that.
	//
	// A sentinel is still wanted — a ledger that silently emptied would pass
	// the two assertions above without proving anything — so it moves to a
	// divergence that legitimately REMAINS. Zoroark-Hisui is generation drift
	// rather than a Run & Bun change, which is exactly why it was not
	// corrected: this fork is not the authority on it. If it ever disappears,
	// that is either a real upstream fix or a broken extraction, and both
	// deserve a reader.
	assert.ok(computed.entries.some(entry =>
		entry.species === 'Zoroark-Hisui' && entry.field === 'baseStats.hp' &&
		entry.vendor === 60 && entry.fork === 55),
	'the Zoroark-Hisui divergence is the current sentinel; its absence means the ' +
	'data changed — check whether that was intended and move this assertion WITH the re-pin');
	assert.ok(!computed.entries.some(entry => entry.species === 'Marill'),
		'Marill was corrected by the bf28a069 re-pin and must not diverge again');
});

test('the vendor extraction reads a plausible species table, not a lucky regex', () => {
	const found = vendorSpecies();
	const names = Object.keys(found);
	assert.ok(names.length > 800, 'the bundle embeds the full dex, found ' + names.length);
	const marill = found.Marill;
	// 35/35, not the vanilla 20/20 this read before the re-pin: the fixture
	// tracks what the bundle EMBEDS, which is the point of the assertion.
	assert.deepEqual(marill.baseStats,
		{hp: 70, atk: 35, def: 50, spa: 35, spd: 50, spe: 40},
		'extraction must read exact embedded values');
	assert.deepEqual(marill.abilities, ['Thick Fat']);
});

test('the worst-case planning design names the provider revision the repository pins', () => {
	// data-integrity audit (worst-case-planning-cites-a-stale-revision): the
	// design named head 2ae1b7e and "scripts/check-sdlc.js:63" after 5a255c0
	// re-pinned to bf28a069 and moved the assertion. It now names the pin, its
	// branch and the line that asserts it, and this holds all three to the
	// files that own them, so the next re-pin fails here until the doc moves.
	const root = path.join(__dirname, '..');
	const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
	const pin = JSON.parse(read('vendor/pokemon-run-runtime/PROVENANCE.json'));
	const status = read('docs/WORST-CASE-PLANNING.md').split('\n').find(line => line.startsWith('**Status:**'));
	const named = status.match(/The pin is now `([0-9a-f]{7,})…` \(branch `([^`]+)`\)/);
	assert.ok(named, 'the status line names the current pin and its branch');
	assert.ok(pin.revision.startsWith(named[1]), `the doc names ${named[1]}, PROVENANCE.json pins ${pin.revision}`);
	assert.match(pin.note, new RegExp('Built from branch ' + named[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b'));
	const at = status.match(/asserted by `scripts\/check-sdlc\.js:(\d+)`/);
	assert.ok(at, 'the status line names the line that asserts the pin');
	const line = read('scripts/check-sdlc.js').split('\n')[Number(at[1]) - 1];
	assert.equal(line, `assert.equal(providerProvenance.revision, '${pin.revision}');`);
});

test('the divergence ledger reads the trainer records, where the Megas are', () => {
	// the-forecast-fights-a-pokemon-that-never-mega-evolves: the ledger read
	// only the species table, where the bundle is right, and held no Mega. Its
	// trainer records hold Wattson's ace as a plain Ampharos with Static and
	// an Ampharosite, and neither engine evolves it. Every Mega or Primal this
	// run fields in a fight the engine is joined to must now be an entry.
	const committed = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
	const computed = providerDiff.trainerDivergences();
	assert.deepEqual(committed.trainerEntries, computed.entries,
		'trainer divergences drifted — rerun scripts/diff-provider-data.js --write and commit the ledger');
	assert.ok(computed.entries.some(entry => entry.trainer === 'Leader Wattson' && entry.field === 'species' &&
		entry.fork === 'Ampharos-Mega' && entry.vendor === 'Ampharos'), 'Wattson\'s ace is the sentinel');
	const planner = require('../lib/planner');
	const joined = new Set(require('../profiles/run-and-bun/oracle/trainer-orders.json').entries.map(entry => entry.trainer));
	const megas = [];
	for (const fight of planner.loadRunMap('run-and-bun')) {
		if (!joined.has(fight.trainer)) continue;
		fight.party.forEach((mon, slot) => {
			if (/-(?:Mega|Primal)\b/.test(mon.species)) megas.push(fight.trainer + '#' + slot);
		});
	}
	const recorded = new Set(computed.entries.filter(entry => entry.field === 'species')
		.map(entry => entry.trainer + '#' + entry.slot));
	assert.ok(megas.length > 50, 'the run fields its Megas where the engine is joined, found ' + megas.length);
	assert.deepEqual(megas.filter(key => !recorded.has(key)), [], 'every joined Mega is a recorded divergence');
});
