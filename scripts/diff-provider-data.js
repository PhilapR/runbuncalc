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
 * It reads TWO tables. The species table is what a player's catch is built
 * from. The trainer records are what an enemy is built from, and they can
 * disagree where the species table agrees: the bundle's species table holds
 * "Ampharos-Mega" with Mold Breaker, correctly, while its record of Leader
 * Wattson holds a plain Ampharos with Static and an Ampharosite. Neither
 * engine performs Mega Evolution, so the planner fights the base form for the
 * whole battle while this run fights the Mega from turn one. Reading only the
 * species table, this ledger held 140 entries and not one Mega
 * (the-forecast-fights-a-pokemon-that-never-mega-evolves). So every enemy
 * Pokemon both sides hold is compared too, fight by fight through
 * trainer-orders.json, and a species or ability they disagree on is an entry.
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

/**
 * One comparable name for a species: the two sides spell forms differently
 * ("Rotom-Fan" and "Rotom_Fan", "Farfetch’d" and "Farfetchd") without
 * disagreeing about the Pokemon. A Mega suffix is NOT spelling: it is a
 * different Pokemon, so it survives here.
 */
function speciesId(name) {
	return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** The key that pairs one enemy across the two records: the base species and
 * the level, the fingerprint build-trainer-order-map.js matches teams on. */
function pairKey(mon) {
	return speciesId(mon.species).replace(/(?:mega[xy]?|primal)$/, '') + '@' + mon.level;
}

/**
 * Every enemy Pokemon the run map and the pinned engine both hold, compared on
 * species and ability. Fights are joined by trainer-orders.json (engine order
 * per run-map fight label); within a fight, Pokemon pair on base species and
 * level. A Pokemon that pairs with none is counted, not guessed.
 */
function trainerDivergences() {
	const planner = require(path.join(ROOT, 'lib', 'planner'));
	const runtime = require('@philapr/pokemon-run-runtime');
	const byOrder = runtime.createRabRunRuntimeProvider({}).options.resolveTrainer;
	const orders = JSON.parse(fs.readFileSync(path.join(ROOT, 'profiles', 'run-and-bun', 'oracle', 'trainer-orders.json'), 'utf8'));
	const fights = new Map(planner.loadRunMap('run-and-bun').map(fight => [fight.trainer, fight]));
	const entries = [];
	let compared = 0;
	let unpaired = 0;
	for (const joined of orders.entries) {
		const fight = fights.get(joined.trainer);
		const engine = byOrder(joined.order);
		if (!fight || !engine || !engine.pokemon) continue;
		const pool = engine.pokemon.slice();
		fight.party.forEach((ours, slot) => {
			const at = pool.findIndex(theirs => pairKey(theirs) === pairKey(ours));
			if (at === -1) {
				unpaired += 1;
				return;
			}
			const theirs = pool.splice(at, 1)[0];
			compared += 1;
			if (speciesId(theirs.species) !== speciesId(ours.species)) {
				entries.push({trainer: joined.trainer, order: joined.order, slot, field: 'species',
					vendor: theirs.species, fork: ours.species});
			}
			if (theirs.ability !== ours.ability) {
				entries.push({trainer: joined.trainer, order: joined.order, slot, field: 'ability',
					vendor: theirs.ability, fork: ours.ability});
			}
		});
	}
	return {compared, unpaired, entries};
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
	const trainers = trainerDivergences();
	return {
		schemaVersion: 'pokemon.provider.data-divergences/1.1.0',
		providerRevision: provenance.revision,
		providerArtifactSha256: provenance.artifactSha256,
		meaning: 'Fields where the pinned provider\'s embedded species data disagrees ' +
			'with the fork\'s decomp-verified tables. Planning receipts for teams ' +
			'holding these species are computed from the vendor values. Retired by ' +
			'curating mono\'s species table to R&B values and re-pinning.',
		speciesCompared: compared,
		divergenceCount: entries.length,
		entries,
		trainerMeaning: 'Enemy Pokemon whose species or ability the pinned provider\'s TRAINER ' +
			'records hold differently from this run map, joined fight by fight through ' +
			'trainer-orders.json. A species entry whose fork value is a Mega or Primal form is a ' +
			'Pokemon the provider fights as its base form for the whole battle: neither engine ' +
			'performs Mega Evolution. Retired by the provider holding the evolved form, or evolving it.',
		trainerPokemonCompared: trainers.compared,
		trainerPokemonUnpaired: trainers.unpaired,
		trainerDivergenceCount: trainers.entries.length,
		trainerEntries: trainers.entries,
	};
}

function main() {
	const diff = computeDiff();
	const speciesTouched = new Set(diff.entries.map(entry => entry.species));
	console.log(`compared ${diff.speciesCompared} species against provider ` +
		`${diff.providerRevision.slice(0, 8)}: ${diff.divergenceCount} divergences ` +
		`across ${speciesTouched.size} species`);
	console.log(`compared ${diff.trainerPokemonCompared} enemy Pokemon (${diff.trainerPokemonUnpaired} unpaired): ` +
		`${diff.trainerDivergenceCount} trainer-record divergences`);
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
		JSON.stringify(committed.trainerEntries) !== JSON.stringify(diff.trainerEntries) ||
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
module.exports = {computeDiff, vendorSpecies, trainerDivergences};
