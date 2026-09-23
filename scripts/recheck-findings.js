#!/usr/bin/env node
/* eslint-env node, es6 */
'use strict';

/**
 * Re-derive the findings whose claims are numbers, and say which no longer hold.
 *
 * Two failures on one day started this, and they point opposite ways.
 *
 * rank-enumerates-every-six-with-no-bound said "nothing gates it because the
 * existing test passes rollouts:0". True when written; false from the commit
 * that added tests/adjudication_cost.test.js. It sat open for three days
 * describing a repo that had moved.
 *
 * provider-cannot-resolve-42-percent-of-the-run-map had the whole diagnosis
 * already — the same 152-of-362 count, and the cause named as a naming
 * convention rather than missing content. It was re-derived from scratch by
 * someone who did not look, and the second finding raised from that work
 * contradicted the first and was wrong.
 *
 * Neither is a reasoning failure. Nothing re-checks a finding once it is
 * written, so a fix can land without closing the record and an investigation
 * can re-derive what is already on file. This closes that loop for the claims
 * that carry a number.
 *
 * Two directions matter, and the second is the one worth having:
 *
 *   - an OPEN finding that no longer reproduces was probably fixed by
 *     something that never mentioned it. Worth a look, not an automatic close:
 *     a probe measures one number and a claim usually says more.
 *   - a FIXED finding that reproduces again is a REGRESSION, and that is a
 *     failure rather than a note. `--gate` exits non-zero on one.
 *
 * A probe is not a substitute for the finding. It re-derives the single number
 * the claim leans on, so a probe that passes proves the number and never the
 * whole claim.
 */

const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const findings = require(path.join(ROOT, 'ledger', 'findings.json'));

/**
 * The trainer resolver as the browser gets it.
 *
 * It is built into dist/js/pokemon_provider.js and installed on globalThis, so
 * there is nothing to require. Evaluating the built bundle is the point rather
 * than a workaround: the claim is about what the product can ask the engine,
 * and reimplementing the lookup here would test this file instead of the
 * artifact that ships.
 */
function loadShippedResolver() {
	const fs = require('node:fs');
	const vm = require('node:vm');
	const bundle = path.join(ROOT, 'dist', 'js', 'pokemon_provider.js');
	const sandbox = {globalThis: null, console: console};
	sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(fs.readFileSync(bundle, 'utf8'), sandbox, {filename: bundle});
	const provider = sandbox.RunBunPokemonProvider;
	if (!provider || typeof provider.resolveTrainerOrder !== 'function') {
		throw new Error('the built bundle exposes no resolveTrainerOrder');
	}
	return (trainer, party) => {
		try {
			return provider.resolveTrainerOrder(trainer, party);
		} catch (error) {
			return null;
		}
	};
}

/**
 * Each probe re-derives ONE number the claim rests on.
 *
 * `reproduces` answers "is the defect still here", so it is true when the
 * finding still describes the repo. `detail` carries the measurement, because
 * a bare boolean is not evidence and the next reader needs the number.
 */
const PROBES = {
	'provider-cannot-resolve-42-percent-of-the-run-map': {
		checks: '152 of 362 fights unresolvable in the planning engine',
		probe() {
			const planner = require(path.join(ROOT, 'lib', 'planner'));
			// Through the SHIPPED bundle, because the claim is about what the
			// product can ask, not about a helper. The resolver lives in the
			// browser entry point and reaches the page as a global, so the
			// honest probe loads the artifact the browser loads.
			const resolve = loadShippedResolver();
			const fights = planner.loadRunMap('run-and-bun');
			let unresolved = 0;
			for (const fight of fights) {
				if (resolve(fight.trainer, fight.party) === null) unresolved += 1;
			}
			return {
				// The finding is about the run being mostly unaskable. A handful
				// of fights the engine simply does not carry is a different and
				// much smaller thing, recorded separately.
				reproduces: unresolved > fights.length * 0.2,
				detail: unresolved + ' of ' + fights.length + ' unresolvable (' +
					(100 * unresolved / fights.length).toFixed(0) + '%)',
			};
		},
	},

	'provider-ability-table-is-vanilla-not-run-and-bun': {
		checks: 'catchable species whose fork ability the engine refuses',
		probe() {
			const runtime = require(path.join(ROOT, 'vendor', 'pokemon-run-runtime'));
			const make = runtime.createRabRunRuntimeProvider({}).options.createPlayerPokemon;
			const Calc = require(path.join(ROOT, 'calc'));
			const gen = Calc.Generations.get(8);
			const profile = require(path.join(ROOT, 'profiles', 'run-and-bun'));
			const species = new Set();
			for (const map of profile.oracle.maps()) {
				// encountersOn answers {map, name, mons}, not a list.
				const found = profile.oracle.encountersOn(map.map);
				for (const row of (found && found.mons) || []) {
					if (row && row.species) species.add(row.species);
				}
			}
			let refused = 0;
			let checked = 0;
			for (const name of species) {
				const found = gen.species.get(Calc.toID(name));
				if (!found || !found.abilities) continue;
				const ability = Object.values(found.abilities).filter(Boolean)[0];
				if (!ability) continue;
				checked += 1;
				try {
					make({
						species: name, level: 20, moves: ['Tackle'], ability: ability,
						nature: 'Hardy', ivs: {hp: 20, atk: 20, def: 20, spa: 20, spd: 20, spe: 20},
					});
				} catch (error) {
					refused += 1;
				}
			}
			return {
				reproduces: refused > 0,
				detail: refused + ' of ' + checked + ' catchable species refused (' +
					(checked ? (100 * refused / checked).toFixed(0) : '0') + '%)',
			};
		},
	},

	'a-consumed-item-is-never-consumed': {
		checks: 'a single-use held item survives the fight that spends it',
		probe() {
			const run = require(path.join(ROOT, 'lib', 'run'));
			const IVS = {hp: 20, atk: 18, def: 19, spa: 22, spd: 17, spe: 21};
			let doc = run.applyAll(run.createRun({
				name: 'recheck', now: 't0', levelCap: 'none',
				permadeath: false, onePerRoute: false,
			}), ['Aron', 'Rockruff', 'Timburr', 'Nidorina', 'Lombre', 'Poochyena']
				.map(species => ({kind: 'catch', species: species, level: 24, ivs: IVS})));
			doc = run.apply(doc, {kind: 'party', ids: doc.box.map(mon => mon.id)});
			doc = run.apply(doc, {kind: 'acquire', item: 'Chople Berry', note: 'recheck'});
			doc = run.apply(doc, {kind: 'give', id: doc.box[0].id, item: 'Chople Berry'});
			// Brawly's team is more than half Fighting, which is exactly what
			// makes a Chople Berry fire on an Aron.
			doc = run.apply(doc, {kind: 'beat', trainer: 'Leader Brawly'});
			const held = doc.box[0].item;
			return {
				reproduces: held === 'Chople Berry',
				detail: held ? 'still holding ' + held + ' after the fight that eats it' :
					'the item is gone after the fight',
			};
		},
	},

	'every-gendered-pokemon-is-male': {
		checks: 'a caught Pokemon carries no gender at all',
		probe() {
			const run = require(path.join(ROOT, 'lib', 'run'));
			let doc = run.createRun({
				name: 'recheck', now: 't0', levelCap: 'none',
				permadeath: false, onePerRoute: false,
			});
			// Nidoran-F is female only, so a run that models gender cannot
			// record this one without one.
			doc = run.apply(doc, {
				kind: 'catch', species: 'Nidoran-F', level: 10,
				ivs: {hp: 20, atk: 18, def: 19, spa: 22, spd: 17, spe: 21},
			});
			const mon = doc.box[0];
			return {
				reproduces: !mon.gender,
				detail: mon.gender ? 'gender recorded as ' + mon.gender :
					'no gender field on a female-only species',
			};
		},
	},

	'engine-debits-currencies-it-cannot-source': {
		checks: 'Rare Candy and Heart Scale are spent but not on the item map',
		probe() {
			const availability = require(
				path.join(ROOT, 'profiles', 'run-and-bun', 'oracle', 'availability.json'));
			const known = new Set((availability.items || []).map(row => row.name));
			const missing = ['Rare Candy', 'Heart Scale'].filter(name => !known.has(name));
			return {
				reproduces: missing.length > 0,
				detail: missing.length ? missing.join(' and ') + ' absent from the ' +
					known.size + ' catalogued items' : 'both are on the item map',
			};
		},
	},
};

function main() {
	const gate = process.argv.includes('--gate');
	const rows = [];
	for (const finding of findings.findings) {
		const entry = PROBES[finding.id];
		if (!entry) continue;
		let result;
		try {
			result = entry.probe();
		} catch (error) {
			result = {reproduces: null, detail: 'probe threw: ' + error.message.slice(0, 80)};
		}
		rows.push({
			id: finding.id, status: finding.status,
			checks: entry.checks, ...result,
		});
	}

	const stale = rows.filter(row => row.status === 'open' && row.reproduces === false);
	const regressed = rows.filter(row => row.status === 'fixed' && row.reproduces === true);
	const broken = rows.filter(row => row.reproduces === null);

	console.log('re-derived ' + rows.length + ' of ' + findings.findings.length + ' findings\n');
	for (const row of rows) {
		const mark = row.reproduces === null ? '??' :
			row.reproduces ? (row.status === 'fixed' ? 'REGRESSED' : 'still true') :
				(row.status === 'open' ? 'NO LONGER' : 'stays fixed');
		console.log('  ' + mark.padEnd(12) + row.id);
		console.log('    ' + row.checks);
		console.log('    -> ' + row.detail);
	}

	if (stale.length) {
		console.log('\nOPEN findings that no longer reproduce — a fix may have landed ' +
			'without closing them:');
		stale.forEach(row => console.log('  - ' + row.id + ': ' + row.detail));
		console.log('  A probe measures one number and a claim usually says more, so read ' +
			'before closing.');
	}
	if (broken.length) {
		console.log('\nprobes that could not run:');
		broken.forEach(row => console.log('  - ' + row.id + ': ' + row.detail));
	}
	if (regressed.length) {
		console.log('\nREGRESSION — these are recorded as fixed and reproduce again:');
		regressed.forEach(row => console.log('  - ' + row.id + ': ' + row.detail));
		if (gate) process.exit(1);
	}
	if (gate && broken.length) process.exit(1);
}

if (require.main === module) main();

module.exports = {PROBES: PROBES};
