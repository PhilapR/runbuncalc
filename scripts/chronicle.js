#!/usr/bin/env node
/* eslint-env node, es6 */
'use strict';

/**
 * A run, told as a run.
 *
 *   node scripts/chronicle.js RUN.json
 *
 * The sweep record is a tally: 18 catches, 146 fights, 2924 deaths across a
 * sweep, stopped at Leader Norman. True, and unreadable. The same record
 * holds who was caught where, what each of them took down, and what killed
 * them — the driver has always known it, and the ledger now keeps it with
 * the individual's name attached rather than its species (lib/nicknames.js).
 *
 * This renders that: the roster in the order it was caught, each body's
 * record, and the fight the run died on. A body that only ever appears in
 * the record on the day it dies has no story; one that appears with four
 * knockouts behind it does.
 *
 * It reads a record written by scripts/headless-run.js with `keepDoc`, so
 * the document is beside the ledger. Without the document it still tells the
 * fights, because the ledger carries the names.
 */

const fs = require('node:fs');

/**
 * The line that stuck.
 *
 * The harness retries a lost boss up to sixty times, and the run does not
 * carry death between attempts, so the raw ledger buries the same body
 * twenty-eight times at one Leader. Those are rehearsals, not the run. For
 * each fight on the road only the LAST attempt counted — it is the one that
 * was won, or the one the run ended on — so the story is told from those,
 * and the rehearsals are counted separately as what the wall cost.
 */
function theLine(ledger) {
	const last = new Map();
	for (const fight of ledger || []) last.set(fight.order + '|' + fight.trainer, fight);
	return [...last.values()].sort((a, b) => a.n - b.n);
}

/** "Route102" is how the maps are keyed; it is not how a name is read. */
function placeName(name) {
	return String(name).replace(/([A-Za-z])(\d)/g, '$1 $2');
}

/** Every name the ledger ever mentions, with what it did and what it met. */
function recordsOf(ledger, box) {
	const rows = new Map();
	const of = key => {
		if (!rows.has(key)) {
			rows.set(key, {name: key, species: null, kos: 0, falls: 0,
				first: null, last: null, tookDown: [], fellTo: null});
		}
		return rows.get(key);
	};
	for (const mon of box || []) {
		const row = of(mon.nickname || mon.species);
		row.species = mon.species;
		row.caught = mon.origin && mon.origin.mapName ? placeName(mon.origin.mapName) : null;
		row.caughtAt = mon.origin ? mon.origin.at : null;
		row.level = mon.level;
	}
	for (const fight of ledger || []) {
		for (const kill of fight.kos || []) {
			if (!kill.name) continue;
			const row = of(kill.name);
			row.kos += 1;
			row.first = row.first === null ? fight.n : row.first;
			row.last = fight.n;
			row.tookDown.push(kill.foe);
		}
		for (const death of fight.killers || []) {
			if (!death.name) continue;
			const row = of(death.name);
			row.falls += 1;
			row.species = row.species || death.species;
			row.fellTo = {trainer: fight.trainer, at: fight.n,
				to: death.of, by: death.by, as: death.species};
		}
	}
	return rows;
}

/** The fights that cost the most, worst first. */
function bloodiest(ledger, count) {
	return (ledger || []).filter(fight => (fight.killers || []).length)
		.sort((a, b) => b.killers.length - a.killers.length || a.n - b.n)
		.slice(0, count);
}

function chronicle(record) {
	const box = (record.doc && record.doc.box) || record.box || [];
	const ledger = theLine(record.ledger);
	const rehearsals = (record.ledger || []).length - ledger.length;
	const rows = [...recordsOf(ledger, box).values()];
	const lines = [];
	const wins = ledger.filter(fight => fight.result === 'win').length;
	lines.push(`# ${record.starter || 'a run'}, seed ${record.seed}`);
	lines.push('');
	lines.push(`${wins} fights won of ${ledger.length} on the road, ` +
		`${record.catches || box.length} caught, reached #${record.position || 0}` +
		(record.finished ? ' and finished.' : '.'));
	if (rehearsals > 0) {
		lines.push('');
		lines.push(rehearsals === 1 ?
			'1 attempt was spent and lost on walls before the line below; ' +
				'the dead in it are not counted here.' :
			`${rehearsals} attempts were spent and lost on walls before the line below; ` +
				'the dead in them are not counted here.');
	}
	if (record.stopped) lines.push('');
	if (record.stopped) lines.push('It ended: ' + String(record.stopped).split(':')[0] + '.');

	lines.push('');
	lines.push('## The roster');
	lines.push('');
	const order = rows.slice().sort((a, b) =>
		(a.caughtAt === null ? 1e9 : a.caughtAt) - (b.caughtAt === null ? 1e9 : b.caughtAt));
	for (const row of order) {
		const who = row.species ? `**${row.name}** the ${row.species}` : `**${row.name}**`;
		const where = row.caught ? `, caught on ${row.caught}` : '';
		const took = row.kos ? `${row.kos} knockout${row.kos === 1 ? '' : 's'}` : 'no knockouts';
		const how = row.fellTo && row.fellTo.to && row.fellTo.by ?
			`to ${row.fellTo.to}'s ${row.fellTo.by}` : 'with no killer recorded';
		const fell = row.fellTo ?
			` — fell at ${row.fellTo.trainer} (fight ${row.fellTo.at}) ${how}` :
			(row.kos ? ' — still standing' : '');
		lines.push(`- ${who}${where}: ${took}${fell}`);
	}

	const worst = bloodiest(ledger, 5);
	if (worst.length) {
		lines.push('');
		lines.push('## The worst days');
		lines.push('');
		for (const fight of worst) {
			lines.push(`- **${fight.trainer}** (fight ${fight.n}, ${fight.result}, ` +
				`${fight.policy}): ` + fight.killers.map(death =>
				(death.name || death.species) +
				(death.of && death.by ? ` to ${death.of}'s ${death.by}` : ' to nothing named'))
				.join('; '));
		}
	}
	return lines.join('\n') + '\n';
}

function main() {
	const file = process.argv[2];
	if (!file) {
		process.stderr.write('usage: node scripts/chronicle.js RUN.json\n');
		process.exit(2);
	}
	process.stdout.write(chronicle(JSON.parse(fs.readFileSync(file, 'utf8'))));
}

if (require.main === module) main();

module.exports = {chronicle, recordsOf, bloodiest, theLine, placeName};
