/* eslint-env node, es6 */
'use strict';

/**
 * Diff the pinned provider's EMBEDDED species data against the fork's own
 * decomp-verified tables.
 *
 * Why this exists: planning requests carry no stats, so the provider derives
 * them from the species database compiled INTO its bundle — and that bundle
 * was built from vanilla Gen 8 data, not Run & Bun's. Every receipt for a
 * team holding a diverging species is computed from wrong numbers, and no
 * existing gate can see it: the SDLC check pins the artifact's hash, not its
 * data, and the cross-engine diff overrides stats on both sides.
 *
 * This script makes the divergence a RECORD instead of a surprise. The
 * committed ledger (vendor/pokemon-run-runtime/DATA-DIVERGENCES.json) is the
 * Policy-B acceptance valve: the companion test recomputes the diff and
 * fails on any drift from the ledger, so a provider re-pin or a fork data
 * change must update the ledger in the same change — one honest line per
 * divergence, never silence. The real fix — curating the mono-side species
 * table to R&B values — retires ledger entries as it lands.
 *
 *   node scripts/diff-provider-data.js           # print the diff summary
 *   node scripts/diff-provider-data.js --write   # rewrite the ledger
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const LEDGER = path.join(ROOT, 'vendor', 'pokemon-run-runtime', 'DATA-DIVERGENCES.json');
const STATS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];

/** The provider bundle's embedded species table, by text extraction: the
 * module exports no data accessor, and executing it to spelunk internals
 * would couple this gate to bundler layout twice over. The serialized shape
 * is regular: Name:{name:"...",types:[...],baseStats:{...},abilities:[...]}. */
function vendorSpecies() {
	const bundle = fs.readFileSync(path.join(ROOT, 'vendor', 'pokemon-run-runtime', 'index.js'), 'utf8');
	const pattern = /name:"([^"]+)",types:\[([^\]]*)\],baseStats:\{hp:(\d+),atk:(\d+),def:(\d+),spa:(\d+),spd:(\d+),spe:(\d+)\},abilities:\[([^\]]*)\]/g;
	const found = {};
	for (let match; (match = pattern.exec(bundle));) {
		found[match[1]] = {
			types: match[2] ? match[2].split(',').map(entry => JSON.parse(entry)) : [],
			baseStats: {hp: +match[3], atk: +match[4], def: +match[5],
				spa: +match[6], spd: +match[7], spe: +match[8]},
			abilities: match[9] ? match[9].split(',').map(entry => JSON.parse(entry)) : [],
		};
	}
	if (Object.keys(found).length < 100) {
		throw new Error('vendor species extraction found only ' +
			Object.keys(found).length + ' entries — the bundle layout changed; fix the pattern');
	}
	return found;
}

function computeDiff() {
	const calc = require(path.join(ROOT, 'calc'));
	const gen = calc.Generations.get(8);
	const vendor = vendorSpecies();
	const provenance = JSON.parse(fs.readFileSync(
		path.join(ROOT, 'vendor', 'pokemon-run-runtime', 'PROVENANCE.json'), 'utf8'));
	const entries = [];
	const names = Object.keys(vendor).sort();
	let compared = 0;
	for (const name of names) {
		const fork = gen.species.get(calc.toID(name));
		if (!fork) continue;
		compared += 1;
		const theirs = vendor[name];
		for (const stat of STATS) {
			if (theirs.baseStats[stat] !== fork.baseStats[stat]) {
				entries.push({species: name, field: 'baseStats.' + stat,
					vendor: theirs.baseStats[stat], fork: fork.baseStats[stat]});
			}
		}
		const forkAbilities = Object.keys(fork.abilities || {})
			.map(slot => fork.abilities[slot]).filter(Boolean).sort();
		const vendorAbilities = theirs.abilities.slice().sort();
		if (JSON.stringify(forkAbilities) !== JSON.stringify(vendorAbilities)) {
			entries.push({species: name, field: 'abilities',
				vendor: vendorAbilities, fork: forkAbilities});
		}
		const forkTypes = (fork.types || []).slice().sort();
		const vendorTypes = theirs.types.slice().sort();
		if (JSON.stringify(forkTypes) !== JSON.stringify(vendorTypes)) {
			entries.push({species: name, field: 'types',
				vendor: vendorTypes, fork: forkTypes});
		}
	}
	return {
		schemaVersion: 'pokemon.provider.data-divergences/1.0.0',
		providerRevision: provenance.revision,
		providerArtifactSha256: provenance.artifactSha256,
		meaning: 'Fields where the pinned provider\'s embedded species data disagrees ' +
			'with the fork\'s decomp-verified tables. Planning receipts for teams ' +
			'holding these species are computed from the vendor values. Retired by ' +
			'curating mono\'s species table to R&B values and re-pinning.',
		speciesCompared: compared,
		divergenceCount: entries.length,
		entries,
	};
}

function main() {
	const diff = computeDiff();
	const speciesTouched = new Set(diff.entries.map(entry => entry.species));
	console.log(`compared ${diff.speciesCompared} species against provider ` +
		`${diff.providerRevision.slice(0, 8)}: ${diff.divergenceCount} divergences ` +
		`across ${speciesTouched.size} species`);
	if (process.argv.includes('--write')) {
		fs.writeFileSync(LEDGER, JSON.stringify(diff, null, '\t') + '\n');
		console.log('ledger written: ' + path.relative(ROOT, LEDGER));
		return;
	}
	const committed = fs.existsSync(LEDGER) ?
		JSON.parse(fs.readFileSync(LEDGER, 'utf8')) : null;
	if (!committed) {
		console.log('no committed ledger — run with --write to create it');
		process.exitCode = 1;
		return;
	}
	if (JSON.stringify(committed.entries) !== JSON.stringify(diff.entries) ||
		committed.providerRevision !== diff.providerRevision) {
		console.log('DRIFT: the computed divergences do not match the committed ledger. ' +
			'If this change is deliberate (a re-pin or a fork data fix), rerun with ' +
			'--write and commit the ledger in the same change.');
		process.exitCode = 1;
		return;
	}
	console.log('ledger matches.');
}

if (require.main === module) main();
module.exports = {computeDiff, vendorSpecies};
