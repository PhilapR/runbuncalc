/* eslint-env node, es6 */
'use strict';

/**
 * Import species catch rates into the oracle.
 *
 * The decomp import (`import-oracle.js`) covers what Run & Bun changed;
 * catch rates it does not touch, so they come from the mainline dex —
 * the PokeAPI CSV dump (`pokemon_species.csv`, the `capture_rate` column) —
 * one file, one number per species, maintained past the veekun era so the
 * Hisui lines are in it. Usage:
 *
 *   node scripts/import-catch-rates.js path/to/pokemon_species.csv
 *
 * Keys are normalized the way the calculator normalizes names (lowercase,
 * alphanumerics only), so 'mr-mime' and 'Mr. Mime' meet in the middle. The
 * import FAILS if any species on a wild table has no rate — a wild fight
 * with an unknown ball math would be an invented mechanic.
 */

const fs = require('node:fs');
const path = require('node:path');

const norm = name => String(name).toLowerCase().replace(/[^a-z0-9]/g, '');

function main() {
	const csvPath = process.argv[2];
	if (!csvPath) throw new Error('usage: node scripts/import-catch-rates.js <pokemon_species.csv>');
	const rows = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
	const header = rows[0].split(',');
	const idCol = header.indexOf('identifier');
	const rateCol = header.indexOf('capture_rate');
	if (idCol < 0 || rateCol < 0) {
		throw new Error('that is not pokemon_species.csv: no identifier/capture_rate columns');
	}
	const rates = {};
	for (const row of rows.slice(1)) {
		const cells = row.split(',');
		const rate = Number(cells[rateCol]);
		if (!Number.isInteger(rate) || rate < 1) continue;
		rates[norm(cells[idCol])] = rate;
	}

	// The gate: every species a route can roll must resolve to a number the
	// same way the oracle resolves it — exact key, or the base species for a
	// regional form. The sweep is recursive so it cannot be defeated by the
	// encounter file's shape.
	const resolves = species => {
		if (rates[norm(species)]) return true;
		return !!rates[norm(String(species).split('-')[0])];
	};
	const encounters = JSON.parse(fs.readFileSync(
		path.join(__dirname, '..', 'profiles', 'run-and-bun', 'oracle', 'encounters.json'), 'utf8'));
	const missing = new Set();
	let seen = 0;
	const sweep = node => {
		if (Array.isArray(node)) return node.forEach(sweep);
		if (!node || typeof node !== 'object') return;
		if (typeof node.species === 'string') {
			seen += 1;
			if (!resolves(node.species)) missing.add(node.species);
		}
		Object.keys(node).forEach(key => sweep(node[key]));
	};
	sweep(encounters);
	if (!seen) throw new Error('the sweep found no species at all — the encounter file moved');
	if (missing.size) {
		throw new Error(`no catch rate for: ${[...missing].sort().join(', ')}`);
	}
	console.log(`${seen} wild slots checked, every species resolves`);

	const out = path.join(__dirname, '..', 'profiles', 'run-and-bun', 'oracle', 'catch-rates.json');
	fs.writeFileSync(out, JSON.stringify({
		source: 'PokeAPI/pokeapi data/v2/csv/pokemon_species.csv (capture_rate)',
		rates,
	}, null, '\t') + '\n');
	console.log(`${Object.keys(rates).length} catch rates written to ${out}`);
}

main();
