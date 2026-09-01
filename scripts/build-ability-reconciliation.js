#!/usr/bin/env node
/* eslint-env node, es6 */
'use strict';

/**
 * Report where the pinned engine's ability table contradicts this fork's.
 *
 * IT NO LONGER CONTRADICTS IT ANYWHERE, AND THAT IS THE POINT. The vendored
 * artifact was rebuilt from a pokemon-mono revision carrying the fork's own
 * ABILITY_SLOT_CHANGES, so the two tables now agree on all 1,244 comparable
 * species and this report is empty. Everything below in the past tense
 * describes the state that motivated the rebuild; the pinned bundle gives
 * Ponyta `Flame Body` today. A non-empty report means the pin has regressed to
 * a vanilla table and 24.3% of catches are about to lose their forecast again.
 *
 * This is NOT a reconciliation, and calling it one was the first mistake. A
 * reconciliation implies two defensible readings to be met in the middle. There
 * are not. `profiles/run-and-bun/index.js` marks data.ABILITY_SLOT_CHANGES
 * `source-of-truth`, it is verified against the romhack's own
 * species/base_stats.h at github.com/dekzeh/runandbundex, and
 * tests/runbun_species.test.js gates its count. The fork is right. The engine
 * ships a VANILLA table — Ponyta "Run Away" where Run & Bun gives Flame Body —
 * and is simply wrong for this game.
 *
 * So the output is evidence for an upstream fix, not an input to a runtime
 * swap. Its provider refuses outright:
 *
 *     getPokemonAbilities(species);
 *     if (!list || ability && !list.includes(ability))
 *       throw Error(`Ability ${ability} is not legal for ${species}`);
 *
 * A refusal is not a degraded forecast, it is no forecast — and not only for
 * that Pokemon. One unbuildable party member kills the fair-dice sample for
 * every fight while it is in the box, which is why the outlook block hides
 * itself and the recommended lead disappears.
 *
 * Measured: 124 of 1,244 comparable species share no ability at all between
 * the two tables. That is 10% of the dex and 24.3% of the catches these logs
 * record — 2,212 of 9,089 — because the overlap is worst exactly where a
 * nuzlocke shops. Croagunk, Ponyta, Phanpy, Fletchling and Bunnelby are all
 * early-route staples and all refused.
 *
 * Swapping in the engine's ability would restore all 124 forecasts, and it is
 * deliberately not done. For 72 of them the engine's ability changes a damage
 * calculation — Aron's Heavy Metal becomes Sturdy, which survives any hit from
 * full HP — so the forecast would stop being absent and start being wrong.
 * build-trainer-order-map.js already states the rule for exactly this
 * situation: a guess is worse than a gap.
 *
 * The real fix is one table, not two. The engine exposes no injection point —
 * its species data is closure-scoped, and createPlayerPokemon is installed
 * AFTER the caller's options are spread, so nothing passed to
 * createRabRunRuntimeProvider can reach it. Correcting it means rebuilding the
 * vendored artifact from a pokemon-mono build that carries Run & Bun's
 * abilities. This file is the exact diff that work needs.
 *
 * Both sides are pinned, so this is computed once and committed.
 * `tests/ability_reconciliation.test.js` rebuilds it and fails on any drift.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor', 'pokemon-run-runtime');
const OUT = path.join(ROOT, 'profiles', 'run-and-bun', 'oracle', 'ability-reconciliation.json');

/** The engine's species table, read out of the bundle the same way
 * scripts/diff-provider-data.js reads it — the shape is regular. */
function engineAbilities() {
	const provenance = JSON.parse(fs.readFileSync(path.join(VENDOR, 'PROVENANCE.json'), 'utf8'));
	const artifact = path.join(VENDOR, provenance.artifact);
	const bytes = fs.readFileSync(artifact);
	const hash = crypto.createHash('sha256').update(bytes).digest('hex');
	if (hash !== provenance.artifactSha256) {
		throw new Error('pokemon-mono runtime artifact does not match PROVENANCE.json');
	}
	const pattern = /name:"([^"]+)",types:\[([^\]]*)\],baseStats:\{hp:(\d+),atk:(\d+),def:(\d+),spa:(\d+),spd:(\d+),spe:(\d+)\},abilities:\[([^\]]*)\]/g;
	const table = new Map();
	const source = bytes.toString('utf8');
	let match;
	while ((match = pattern.exec(source)) !== null) {
		table.set(match[1], match[9] ? match[9].split(',').map(entry => JSON.parse(entry)) : []);
	}
	if (table.size < 1000) throw new Error(`engine table looks wrong: ${table.size} species`);
	return {table: table, revision: provenance.revision};
}

function build() {
	const engine = engineAbilities();
	const Calc = require(path.join(ROOT, 'calc', 'dist', 'data', 'index.js'));
	const gen = Calc.Generations.get(8);

	const entries = [];
	let comparable = 0;
	let agreed = 0;
	for (const row of engine.table) {
		const name = row[0];
		const theirs = row[1];
		let species;
		try {
			species = gen.species.get(name.toLowerCase().replace(/[^a-z0-9]/g, ''));
		} catch (error) {
			continue;
		}
		if (!species || !species.abilities) continue;
		const ours = Object.keys(species.abilities)
			.map(slot => species.abilities[slot]).filter(Boolean);
		if (!ours.length || !theirs.length) continue;
		comparable += 1;
		if (ours.some(ability => theirs.includes(ability))) {
			agreed += 1;
			continue;
		}
		// No overlap: the engine will refuse every one of ours. It lists exactly
		// one ability, so the substitute is forced.
		entries.push({
			species: name,
			fork: ours.slice().sort(),
			engine: theirs.slice().sort(),
			engineWouldForce: theirs[0],
		});
	}
	entries.sort((a, b) => a.species.localeCompare(b.species));
	return {
		schemaVersion: 'runbun.ability.reconciliation/1.0.0',
		engineRevision: engine.revision,
		provenance: 'derived',
		// Derived, not typed. This sentence used to end "...for 72 of these" and
		// went on saying it over an empty `entries` list once the upstream
		// rebuild landed — a shipped dataset describing rows it does not have.
		note: entries.length ?
			'Species where the pinned engine contradicts the fork. `fork` is ' +
				'source-of-truth, verified against the romhack. `engineWouldForce` is what ' +
				'the engine accepts instead, recorded as evidence for an upstream rebuild ' +
				'and NOT applied at runtime: for many of these it changes a damage ' +
				'calculation, so the forecast would stop being absent and start being wrong.' :
			'Empty, which is the fixed state. The vendored engine was rebuilt from a ' +
				'pokemon-mono revision carrying the fork\'s own ABILITY_SLOT_CHANGES, so ' +
				'both tables agree on every comparable species. A non-empty report means ' +
				'the pin regressed to a vanilla table.',
		comparable: comparable,
		agreed: agreed,
		contradicted: entries.length,
		entries: entries,
	};
}

if (require.main === module) {
	const out = build();
	fs.writeFileSync(OUT, JSON.stringify(out, null, '\t') + '\n');
	console.log(`${out.contradicted} contradicted of ${out.comparable} comparable species ` +
		`(${out.agreed} agree) -> ${path.relative(ROOT, OUT)}`);
}

module.exports = {build: build};
