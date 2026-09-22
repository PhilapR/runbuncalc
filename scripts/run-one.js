#!/usr/bin/env node
/* eslint-env node, es6 */
'use strict';

/**
 * One headless run, written where it can be found again.
 *
 *   node scripts/run-one.js --seed=104770 --out=DIR [--starter=Chimchar --rival=Blaziken]
 *                           [--spec=boss-retries=40,stop-at=343] [--resume=RUN.json]
 *                           [--carry-on=1]
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
 * While it plays it keeps three small files beside those, which are how a run
 * is watched and handled from outside (scripts/runs.js, the watch page):
 *
 *   run-SEED.status.json      pid, position, fights, pace, memory — every fight
 *   run-SEED.checkpoint.json  the document AND the run's own state, written
 *                             atomically every CHECKPOINT_MS and on a stop
 *   run-SEED.control.json     {"action":"stop"}, written by whoever wants it
 *                             stopped; read between fights
 *
 * --carry-on=1 takes the run up again from its checkpoint: the same dice, the
 * same attempts at the wall in front of it, the same ledger, the fight log cut
 * back to where the checkpoint was. A --spec given with it replaces the
 * knobs, so a run stuck at a wall can be carried on with another hand.
 *
 * Each LEG (the first start, then each carry-on) is recorded in the status,
 * the checkpoint and the row as {leg, revision, dirty, engine, spec, from,
 * to}: `engine` is the content stamp of lib/provenance.js, and from/to are
 * {position, fights}. A carry-on can be pinned to another revision, so a run
 * can span engines; the row's `provenance` names only the last leg, and
 * `legs` is where the others are. A checkpoint from before legs were kept
 * gives one leg of engine unknown (before stamps).
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

const CHECKPOINT_MS = 20000;

/** A file that is whole or absent, never half-written: a run can be killed at any byte. */
function writeAtomic(file, text) {
	fs.writeFileSync(file + '.tmp', text);
	fs.renameSync(file + '.tmp', file);
}

function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch (error) {
		return null;
	}
}

/** The legs before this one: the checkpoint's, or one unknown leg for a checkpoint from before them. */
function priorLegs(restore) {
	if (!restore) return [];
	if (Array.isArray(restore.legs)) return restore.legs;
	return [{leg: 1, revision: null, dirty: null, engine: null, spec: restore.spec || '',
		from: null, to: {position: restore.position, fights: restore.state.tally.fights}}];
}

/** This leg, at its start. */
function openLeg(prior, stamp, spec, restore, from) {
	const start = {position: restore ? restore.position : from ? (from.doc || from).position || 0 : 0,
		fights: restore ? restore.state.tally.fights : 0};
	return {leg: prior.length + 1, revision: stamp.revision, dirty: stamp.dirty, engine: stamp, spec,
		from: start, to: Object.assign({}, start), startedAt: new Date().toISOString()};
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
	const restore = own('carry-on', '0') === '1' ? readJson(base + '.checkpoint.json') : null;
	if (own('carry-on', '0') === '1' && !restore) {
		process.stderr.write('no checkpoint to carry on from: ' + base + '.checkpoint.json\n');
		process.exit(2);
	}
	const log = fs.openSync(base + '.log', restore ? 'a' : 'w');
	const say = line => fs.writeSync(log, line + '\n');
	const resume = own('resume', '');
	const from = resume ? JSON.parse(fs.readFileSync(resume, 'utf8')) : null;
	const started = Date.now();
	// A carried-on run keeps its knobs unless it is given others.
	const spec = own('spec', restore ? restore.spec || '' : '');
	const provenance = require('../lib/provenance.js');
	const leg = openLeg(priorLegs(restore), provenance.currentStamp(), spec, restore, from);
	const legs = priorLegs(restore).concat([leg]);
	const reach = now => { leg.to = {position: now.position, fights: now.state.tally.fights}; };
	const starter = restore ? restore.starter : {species: own('starter', 'Chimchar'), rival: own('rival', 'Blaziken')};
	const sidecar = fightLog.openFightLog(base + '.fights.ndjson.gz', restore ? restore.fightLog : undefined);
	if (restore) say('CARRIED ON from position ' + restore.position + ', fight ' + restore.state.tally.fights);
	say('LEG ' + leg.leg + ' on ' + provenance.describe(leg.engine));
	const engines = provenance.enginesOfLegs(legs);
	if (engines.length > 1) say('this run now spans ' + engines.length + ' engines: ' + engines.map(entry => entry.key).join(', '));
	try { fs.unlinkSync(base + '.control.json'); } catch (error) { /* none waiting */ }
	let checkpointed = 0;
	let state = 'running';
	const status = now => writeAtomic(base + '.status.json', JSON.stringify({pid: process.pid, seed, state,
		position: now ? now.position : null, fights: now ? now.state.tally.fights : 0,
		attempts: now ? now.state.attempts : 0,
		startedAt: started, updatedAt: Date.now(), spec, legs,
		secondsPerFight: now && now.state.tally.fights ? Number((now.state.elapsedMs / 1000 / now.state.tally.fights).toFixed(1)) : null,
		rssMb: Math.round(process.memoryUsage().rss / 1048576)}));
	const row = headless.playRun(policy, starter,
		seed, headless.armFlags(specOf(spec)), {
			keepDoc: true, log: say, fightLog: sidecar,
			live: base + '.live.ndjson',
			...(restore ? {restore} : from ? {resume: from.doc || from} : {}),
			control: () => {
				const asked = readJson(base + '.control.json');
				return asked && asked.action === 'stop' ? 'stop' : null;
			},
			checkpoint: (snapshot, force) => {
				const now = snapshot();
				reach(now);
				if (force) {
					state = 'stopping';
					leg.endedAt = new Date().toISOString();
				}
				status(now);
				if (!force && Date.now() - checkpointed < CHECKPOINT_MS) return;
				checkpointed = Date.now();
				writeAtomic(base + '.checkpoint.json', JSON.stringify(Object.assign({spec, legs,
					fightLog: {bytes: sidecar.bytes, lines: sidecar.lines}}, now)));
			},
			onCrash: (crash, doc) => {
				try { fs.writeFileSync(base + '.crash-' + crash.order + '.json', JSON.stringify({crash, doc})); } catch (error) { /* a crash dump that cannot be written must not end the run */ }
			}});
	row.seconds = Math.round((Date.now() - started) / 1000);
	leg.to = {position: row.position, fights: row.fights};
	leg.endedAt = new Date().toISOString();
	row.provenance = Object.assign({}, row.provenance, {engine: leg.engine});
	row.legs = legs;
	writeAtomic(base + '.json', JSON.stringify(row));
	state = row.stopped === 'stopped by request' ? 'stopped' : row.finished ? 'finished' : 'ended';
	const last = readJson(base + '.status.json') || {};
	writeAtomic(base + '.status.json', JSON.stringify(Object.assign(last, {state, position: row.position,
		fights: row.fights, updatedAt: Date.now(), stopped: row.stopped || null, legs})));
	try { fs.unlinkSync(base + '.control.json'); } catch (error) { /* none */ }
	say('DONE position ' + row.position + ' fights ' + row.fights + ' finished ' + !!row.finished +
		' stopped ' + String(row.stopped || '').slice(0, 80));
	fs.closeSync(log);
}

if (require.main === module) main();

module.exports = {specOf, writeAtomic, readJson, priorLegs, openLeg};
