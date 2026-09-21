#!/usr/bin/env node
/* eslint-env node, es6 */
'use strict';

/**
 * One headless run, written where it can be found again.
 *
 *   node scripts/run-one.js --seed=104770 --out=DIR [--starter=Chimchar --rival=Blaziken]
 *                           [--spec=boss-retries=40,stop-at=343] [--resume=RUN.json]
 *
 * --spec is comma-separated key=value, WITHOUT dashes: the policy refuses any
 * argv value with a second flag glued inside it (an arm once ran with two
 * flags in one string and measured nothing), and that guard is right.
 *
 * Writes DIR/run-SEED.json, DIR/run-SEED.fights.ndjson.gz (every boss and
 * double attempt, streamed as it ends) and DIR/run-SEED.log. scripts/
 * run-batch.js runs several of these from a pinned clean worktree; this file
 * is the part that plays, and it requires the harness RELATIVE TO ITSELF, so
 * the code that plays is the code of the tree it was started from.
 *
 * Every baseline before this was launched from a throwaway script. One batch
 * failed its provenance audit for running from a tree being edited, another
 * silently played without search because its flags lived on argv, and none
 * kept a fight. Each of those is closed here rather than remembered.
 */

const fs = require('node:fs');
const path = require('node:path');

function own(name, fallback) {
	const hit = process.argv.find(arg => arg.startsWith('--' + name + '='));
	return hit === undefined ? fallback : hit.slice(name.length + 3);
}

/** "boss-retries=40,stop-at=343" as the flag string armFlags reads. */
function specOf(text) {
	return String(text || '').split(',').map(part => part.trim()).filter(Boolean)
		.map(part => '--' + part.replace(/^-+/, '')).join(' ');
}

function main() {
	const seed = Number(own('seed', ''));
	const out = own('out', '');
	if (!Number.isInteger(seed) || !out) {
		process.stderr.write('usage: node scripts/run-one.js --seed=N --out=DIR [--starter= --rival= --spec= --resume=]\n');
		process.exit(2);
	}
	fs.mkdirSync(out, {recursive: true});
	const base = path.join(out, 'run-' + seed);
	const headless = require('./headless-run.js');
	const policy = require('./ui-playthrough.js');
	const fightLog = require('../lib/fight-log.js');
	const log = fs.openSync(base + '.log', 'w');
	const say = line => fs.writeSync(log, line + '\n');
	const resume = own('resume', '');
	const from = resume ? JSON.parse(fs.readFileSync(resume, 'utf8')) : null;
	const started = Date.now();
	const row = headless.playRun(policy, {species: own('starter', 'Chimchar'), rival: own('rival', 'Blaziken')},
		seed, headless.armFlags(specOf(own('spec', ''))), {
			keepDoc: true, log: say, fightLog: fightLog.openFightLog(base + '.fights.ndjson.gz'),
			live: base + '.live.ndjson',
			...(from ? {resume: from.doc || from} : {}),
			onCrash: (crash, doc) => {
				try { fs.writeFileSync(base + '.crash-' + crash.order + '.json', JSON.stringify({crash, doc})); } catch (error) { /* a crash dump that cannot be written must not end the run */ }
			}});
	row.seconds = Math.round((Date.now() - started) / 1000);
	fs.writeFileSync(base + '.json', JSON.stringify(row));
	say('DONE position ' + row.position + ' fights ' + row.fights + ' finished ' + !!row.finished +
		' stopped ' + String(row.stopped || '').slice(0, 80));
	fs.closeSync(log);
}

if (require.main === module) main();

module.exports = {specOf};
