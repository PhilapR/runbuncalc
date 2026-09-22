/* eslint-env node, es6 */
'use strict';

/**
 * Which engine played a result: a content hash of the files that decide play.
 *
 * A git revision is not enough. On 2026-09-22 no lead's entry ability had
 * ever fired (8cc3ece) and Download did not exist (e6399d2): every receipt
 * and run before those was played on an easier game, and nothing in them
 * said so. Two more gaps hide behind a revision: ai/dist and calc/dist are
 * BUILT, untracked, and copied into each pinned worktree from the main
 * checkout, so a stale build plays under a clean revision; and a dirty tree
 * names a commit whose bytes did not play.
 *
 * So the stamp hashes the bytes. Each part is hashed alone, so a difference
 * can be named ("ai-dist, driver differ"), not only detected. A record
 * without a stamp is read as "engine unknown (before stamps)", never as a
 * match and never as an error.
 */

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const STAMP_VERSION = 1;
const UNKNOWN = 'engine unknown (before stamps)';
const TESTS = /(^|\/)test(s)?\//;

/**
 * What decides play, by part. A tree walk takes the extensions listed and
 * skips test directories; a file list is taken as it stands. A path that is
 * absent hashes as absent, so a tree with no build says so in its stamp.
 */
const PARTS = {
	'ai-src': {dir: 'ai/src', ext: ['.ts']},
	'ai-dist': {dir: 'ai/dist', ext: ['.js']},
	'calc-src': {dir: 'calc/src', ext: ['.ts']},
	'calc-dist': {dir: 'calc/dist', ext: ['.js']},
	'data': {dir: 'profiles', ext: ['.js', '.json'], skip: /(^|\/)fidelity\//,
		files: ['src/js/data/sets/gen8.js']},
	'driver': {files: ['lib/battle-driver.js', 'lib/planner.js', 'lib/run.js', 'lib/battle-view.js',
		'lib/team.js', 'lib/item-facts.js', 'lib/dossier.js', 'lib/setdex-loader.js',
		'src/js/sets_to_battle_state.js']},
	'policy': {files: ['scripts/ui-playthrough.js']},
	'battery': {files: ['scripts/scenario-battery.js']},
	'harness': {files: ['scripts/headless-run.js']},
};

function walk(root, rel, spec, out) {
	let entries;
	try {
		entries = fs.readdirSync(path.join(root, rel), {withFileTypes: true});
	} catch (error) {
		return out;
	}
	for (const entry of entries) {
		const child = rel + '/' + entry.name;
		if (TESTS.test(child + '/') || (spec.skip && spec.skip.test(child + '/'))) continue;
		if (entry.isDirectory()) walk(root, child, spec, out);
		else if (spec.ext.some(ext => entry.name.endsWith(ext)) && !entry.name.endsWith('.d.ts')) out.push(child);
	}
	return out;
}

/** The files of one part, sorted, relative to root. */
function filesOf(root, spec) {
	const files = (spec.dir ? walk(root, spec.dir, spec, []) : []).concat(spec.files || []);
	return [...new Set(files)].sort();
}

function hashPart(root, spec) {
	const hash = crypto.createHash('sha256');
	let found = 0;
	for (const rel of filesOf(root, spec)) {
		let bytes;
		try {
			bytes = fs.readFileSync(path.join(root, rel));
		} catch (error) {
			bytes = null;
		}
		hash.update(rel + '\0' + (bytes ? bytes.length : -1) + '\0');
		if (bytes) {
			hash.update(bytes);
			found += 1;
		}
	}
	return found ? hash.digest('hex').slice(0, 12) : 'absent';
}

function resolvedCalc(root) {
	try {
		return fs.realpathSync(require.resolve('@smogon/calc', {paths: [root]}));
	} catch (error) {
		return null;
	}
}

function git(root, args) {
	const out = childProcess.spawnSync('git', args, {cwd: root, encoding: 'utf8'});
	return out.status === 0 ? out.stdout.trim() : null;
}

/**
 * The engine stamp of the tree at root (this checkout by default):
 * {version, engine, parts, revision, dirty}. `engine` is one short hash over
 * every part; `parts` holds each part's own.
 */
function engineStamp(root) {
	const at = root || ROOT;
	const parts = {};
	for (const name of Object.keys(PARTS)) parts[name] = hashPart(at, PARTS[name]);
	// The calc the planner loads by package name. A pinned worktree links
	// node_modules from the main checkout, so this is the MAIN checkout's
	// calc/dist, not the tree's own copy: hashed where it resolves.
	const resolved = resolvedCalc(at);
	parts['calc-linked'] = resolved ? hashPart(path.dirname(resolved), {dir: '.', ext: ['.js']}) : 'absent';
	const engine = 'e-' + crypto.createHash('sha256')
		.update(Object.keys(parts).map(name => name + '=' + parts[name]).join('\n')).digest('hex').slice(0, 12);
	const status = git(at, ['status', '--porcelain', '--untracked-files=no']);
	return {version: STAMP_VERSION, engine, parts, revision: git(at, ['rev-parse', 'HEAD']),
		dirty: status === null ? null : status.length > 0};
}

let cached = null;
/** This process's stamp, taken once: the code a process plays with does not change under it. */
function currentStamp() {
	if (!cached) cached = engineStamp(ROOT);
	return cached;
}

/** The stamp a record carries, wherever it keeps it, or null. */
function stampOf(record) {
	if (!record) return null;
	if (typeof record.engine === 'string' && record.parts) return record;
	const made = record.provenance || {};
	if (made.engine && typeof made.engine === 'object') return made.engine;
	if (record.engine && typeof record.engine === 'object') return record.engine;
	return null;
}

/** One line for a stamp: "e-1a2b3c4d5e6f at 6d12a46a01 (dirty)", or the unknown text. */
function describe(stamp) {
	if (!stamp || !stamp.engine) return UNKNOWN;
	return stamp.engine + ' at ' + String(stamp.revision || 'no revision').slice(0, 10) +
		(stamp.dirty ? ' (dirty)' : '');
}

/**
 * Two stamps, compared. `same` is true or false when both are known and null
 * when either is not; `differs` names the parts whose bytes differ.
 */
function compareStamps(a, b) {
	if (!a || !a.engine || !b || !b.engine) {
		return {same: null, differs: [], text: 'cannot compare: ' + (a && a.engine ? 'second' : 'first') +
			' is ' + UNKNOWN};
	}
	if (a.engine === b.engine) return {same: true, differs: [], text: 'same engine ' + a.engine};
	const names = [...new Set(Object.keys(a.parts || {}).concat(Object.keys(b.parts || {})))];
	const differs = names.filter(name => (a.parts || {})[name] !== (b.parts || {})[name]);
	return {same: false, differs, text: 'different engines: ' + describe(a) + ' against ' + describe(b) +
		(differs.length ? '; ' + differs.join(', ') + ' differ' : '')};
}

/** The distinct engines a run's legs were played on, in the order first met. */
function enginesOfLegs(legs) {
	const seen = new Map();
	for (const leg of legs || []) {
		const key = leg.engine && leg.engine.engine ? leg.engine.engine : UNKNOWN;
		if (!seen.has(key)) seen.set(key, {key, stamp: leg.engine || null, legs: []});
		seen.get(key).legs.push(leg.leg);
	}
	return [...seen.values()];
}

module.exports = {PARTS, UNKNOWN, STAMP_VERSION, engineStamp, currentStamp, stampOf, describe,
	compareStamps, enginesOfLegs, filesOf};
