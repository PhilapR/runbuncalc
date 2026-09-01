#!/usr/bin/env node
/* eslint-env node, es6 */
'use strict';

/**
 * Build the map from this run's fight labels to the pinned engine's trainer
 * orders.
 *
 * The two are independent transcriptions of the same game and they disagree
 * about names. Ours come from the setdex — planner.loadRunMap groups
 * profiles/run-and-bun/encounters.js by trainer label — and the engine carries
 * its own canonical database. resolveRabTrainerOrder wants exactly one exact
 * name match, so 152 of our 362 fights could not be looked up at all, and every
 * one of them lost its survival forecast.
 *
 * Almost all of that disagreement is about how a DOUBLE is written down. The
 * engine keeps a double under the lead's name and records the other half in
 * `doublePartner`; we concatenate both into one label. So "School Kid Jerry &
 * Johnson" is the engine's "School Kid Jerry", isDouble true, partner
 * "Youngster Johnson" — the same four Pokemon on both sides. The Team Aqua and
 * Magma grunts diverge the same way for a different reason: we disambiguate 24
 * identically-named grunts by location and ordinal, and the engine does not.
 *
 * The key that survives both is the TEAM. A party of four to six species with
 * levels is a fingerprint: matching every unresolvable fight on it produced 124
 * unique matches and ZERO ambiguous ones. It is also checkable against the
 * answer we already trust — on the 210 fights that do resolve by name, team
 * matching agreed 191 times and disagreed never.
 *
 * So: name first, because a name that resolves is already canonical; team
 * second; and nothing at all when the team is not unique. A guess here is worse
 * than a gap — an order maps to a DIFFERENT trainer's team, and the forecast
 * would be confidently wrong rather than absent.
 *
 * Both sides are pinned, so this is computed once and committed.
 * `tests/trainer_orders.test.js` rebuilds it and fails on any drift.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'profiles', 'run-and-bun', 'oracle', 'trainer-orders.json');

const planner = require('../lib/planner');
const runtime = require('@philapr/pokemon-run-runtime');

/**
 * A species name both databases agree on.
 *
 * They spell the same Pokemon two ways, neither of which is a disagreement
 * about the game: a Mega carries the suffix on one side only, and a regional
 * form is "hisui" here against "hisuian" there. Normalising those is what took
 * the team match from 26 to 124.
 */
function speciesKey(name) {
	return String(name).toLowerCase().replace(/[^a-z0-9]/g, '')
		.replace(/mega$/, '')
		.replace(/hisuian$/, 'hisui')
		.replace(/galarian$/, 'galar')
		.replace(/alolan$/, 'alola')
		.replace(/paldean$/, 'paldea');
}

/** Sorted, so a difference in party ORDER is not a difference in team. */
function teamKey(party) {
	return party.map(mon => speciesKey(mon.species) + '@' + mon.level).sort().join('|');
}

function build(profileId) {
	const fights = planner.loadRunMap(profileId);
	const byOrder = runtime.createRabRunRuntimeProvider({}).options.resolveTrainer;

	// The engine's whole list, indexed by team. resolveTrainer takes an order,
	// which is how a database that only exports name lookup can still be read
	// end to end.
	const teams = new Map();
	let highest = 0;
	// From ZERO: the engine database is 0-based and its row 0 is the Route 103
	// rival's Treecko. This loop started at 1 for as long as that fight was
	// missing from our own map, which kept the off-by-one latent — the day the
	// fight was restored, its by-team match came back "candidates: 0".
	for (let order = 0; order <= 2000; order++) {
		let trainer = null;
		try {
			trainer = byOrder(order);
		} catch (error) {
			continue;
		}
		if (!trainer || !trainer.pokemon || !trainer.pokemon.length) continue;
		highest = order;
		const key = teamKey(trainer.pokemon);
		if (!teams.has(key)) teams.set(key, []);
		teams.get(key).push(order);
	}

	const entries = [];
	const unmatched = [];
	const counts = {byName: 0, byTeam: 0, unmatched: 0};
	for (const fight of fights) {
		let named = null;
		try {
			named = runtime.resolveRabTrainerOrder(fight.trainer);
		} catch (error) {
			named = null;
		}
		if (named !== null) {
			counts.byName += 1;
			entries.push({trainer: fight.trainer, order: named, by: 'name'});
			continue;
		}
		const hits = teams.get(teamKey(fight.party)) || [];
		if (hits.length === 1) {
			counts.byTeam += 1;
			const engine = byOrder(hits[0]);
			entries.push({
				trainer: fight.trainer,
				order: hits[0],
				by: 'team',
				engineName: engine.name,
				isDouble: !!engine.isDouble,
				doublePartner: engine.doublePartner || null,
			});
			continue;
		}
		counts.unmatched += 1;
		unmatched.push({
			trainer: fight.trainer,
			party: fight.party.length,
			candidates: hits.length,
		});
	}
	return {entries, unmatched, counts, fights: fights.length, engineTrainers: highest};
}

/**
 * The engine's answer and the team's answer must never disagree where both
 * exist. If they ever do, team matching is unsafe and this map must not ship.
 */
function crossCheck(profileId) {
	const fights = planner.loadRunMap(profileId);
	const byOrder = runtime.createRabRunRuntimeProvider({}).options.resolveTrainer;
	const teams = new Map();
	for (let order = 1; order <= 2000; order++) {
		let trainer = null;
		try {
			trainer = byOrder(order);
		} catch (error) {
			continue;
		}
		if (!trainer || !trainer.pokemon || !trainer.pokemon.length) continue;
		const key = teamKey(trainer.pokemon);
		if (!teams.has(key)) teams.set(key, []);
		teams.get(key).push(order);
	}
	let agreed = 0;
	const disagreed = [];
	for (const fight of fights) {
		let named = null;
		try {
			named = runtime.resolveRabTrainerOrder(fight.trainer);
		} catch (error) {
			continue;
		}
		const hits = teams.get(teamKey(fight.party)) || [];
		if (hits.length !== 1) continue;
		if (hits[0] === named) agreed += 1;
		else disagreed.push({trainer: fight.trainer, name: named, team: hits[0]});
	}
	return {agreed, disagreed};
}

function main() {
	const profileId = 'run-and-bun';
	const built = build(profileId);
	const check = crossCheck(profileId);
	if (check.disagreed.length) {
		console.error('REFUSING: team matching contradicts the engine on ' +
			check.disagreed.length + ' fights it should agree on:');
		check.disagreed.slice(0, 5).forEach(row => console.error('  ' + row.trainer +
			': name says ' + row.name + ', team says ' + row.team));
		process.exit(1);
	}
	const doc = {
		comment: [
			'Fight label -> pinned engine trainer order, for run-and-bun.',
			'',
			'Generated by scripts/build-trainer-order-map.js. Do not edit by hand;',
			'tests/trainer_orders.test.js rebuilds this and fails on drift.',
			'',
			'`by` records how each entry was found. "name" means the engine resolved',
			'the label directly and is authoritative. "team" means it did not, and the',
			'fight was matched on its party instead — species and levels, with Mega and',
			'regional-form spellings normalised. Those carry the engine\'s own name so a',
			'reader can see what was matched, and isDouble/doublePartner because a',
			'double is the reason most of them differ at all.',
			'',
			'A fight appears in `unmatched` when the engine has no trainer with that',
			'team, or more than one. Neither gets a guess: an order that is off by one',
			'names a different trainer, and the forecast would be confidently wrong',
			'instead of absent.',
		],
		profileId: profileId,
		fights: built.fights,
		engineTrainers: built.engineTrainers,
		resolvedByName: built.counts.byName,
		resolvedByTeam: built.counts.byTeam,
		unmatchedCount: built.counts.unmatched,
		crossChecked: check.agreed,
		entries: built.entries,
		unmatched: built.unmatched,
	};
	fs.writeFileSync(OUT, JSON.stringify(doc, null, '\t') + '\n');
	console.log('fights: ' + built.fights + '  engine trainers: ' + built.engineTrainers);
	console.log('  by name: ' + built.counts.byName);
	console.log('  by team: ' + built.counts.byTeam);
	console.log('  unmatched: ' + built.counts.unmatched);
	console.log('  cross-checked (name and team agree): ' + check.agreed +
		', disagreements: ' + check.disagreed.length);
	console.log('coverage: ' + (built.counts.byName + built.counts.byTeam) + '/' +
		built.fights + ' = ' +
		(100 * (built.counts.byName + built.counts.byTeam) / built.fights).toFixed(1) + '%');
	console.log('written: ' + path.relative(ROOT, OUT));
}

if (require.main === module) main();

module.exports = {build: build, crossCheck: crossCheck, teamKey: teamKey, speciesKey: speciesKey};
