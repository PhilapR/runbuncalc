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
/**
 * The stamp's format. 2 (2026-09-22): the engine digest leaves out the
 * TypeScript sources and the calc's browser bundles, which never play, and
 * hashes only the data files the code loads. A stamp of another format
 * hashes other files, so its engine is not comparable: compareStamps says
 * "different stamp format" rather than match or differ by accident.
 */
const STAMP_VERSION = 2;
const UNKNOWN = 'engine unknown (before stamps)';
const TESTS = /(^|\/)test(s)?\//;

/**
 * What decides play, by part. A tree walk takes the extensions listed and
 * skips test directories and the names in `exclude`; a file list is taken as
 * it stands; `derive` adds the files the code names (see dataFiles). A path
 * that is absent hashes as absent, so a tree with no build says so in its
 * stamp.
 *
 * A `source` part is hashed for information and kept in `parts`, but is not
 * in the `engine` digest: only the built dist plays, and a comment in a .ts
 * that nobody rebuilt did not change a fight.
 */
const PARTS = {
	'ai-src': {dir: 'ai/src', ext: ['.ts'], source: true},
	'ai-dist': {dir: 'ai/dist', ext: ['.js']},
	'calc-src': {dir: 'calc/src', ext: ['.ts'], source: true},
	// production*.js is the browser bundle; Node loads dist/index.js and its requires.
	// Named relative to the dist dir, as calc-linked is, so equal hashes mean
	// "the linked calc is this tree's calc".
	'calc-dist': {dir: 'calc/dist', ext: ['.js'], exclude: /^production.*\.js$/, relative: true},
	// The profile's code, the set file the planner reads, and the JSON the code
	// names. Not every file under profiles/: tracker-order.json, learnset-doc.json
	// and the other build inputs are read by scripts/build-*.js, never in play,
	// and c831f98 moved `data` by touching only one of them. The profile's
	// policy.js is code that chooses play, so it is in `policy`.
	'data': {dir: 'profiles', ext: ['.js'], skip: /(^|\/)fidelity\/|^profiles\/run-and-bun\/policy\.js\/$/,
		files: ['src/js/data/sets/gen8.js'], derive: dataFiles},
	'driver': {files: ['lib/battle-driver.js', 'lib/planner.js', 'lib/run.js', 'lib/battle-view.js',
		'lib/team.js', 'lib/item-facts.js', 'lib/dossier.js', 'lib/setdex-loader.js',
		'src/js/sets_to_battle_state.js']},
	'policy': {files: ['scripts/ui-playthrough.js', 'profiles/run-and-bun/policy.js']},
	'battery': {files: ['scripts/scenario-battery.js']},
	'harness': {files: ['scripts/headless-run.js']},
};

/**
 * The files under rel. A directory that exists but cannot be read, and a
 * symlinked directory (not followed: a link can loop, or leave the tree), are
 * skipped and named in `notes`, so a stamp says what it did not see.
 */
/**
 * The installed packages that decide play, each resolved from where the code
 * that loads it lives. Resolution matters: ai/dist resolves @pkmn/dex to
 * ai/node_modules (0.7.59 on 2026-09-22) while the root and calc have 0.7.13,
 * so the version is read where the engine finds it. @smogon/calc is not here:
 * it is this repository's calc, hashed by bytes as calc-linked.
 * tests/provenance.test.js checks this list against every package a played
 * process loads.
 */
const RUNTIME = [
	{name: '@pkmn/dex', from: 'ai/dist'},
];

/** The package.json of a package as `from` resolves it, or null. */
function packageJson(root, name, from) {
	const paths = [path.join(root, from)];
	try {
		return JSON.parse(fs.readFileSync(require.resolve(name + '/package.json', {paths}), 'utf8'));
	} catch (error) {
		// A package whose exports hide package.json: walk up from its entry point.
	}
	let dir;
	try {
		dir = path.dirname(require.resolve(name, {paths}));
	} catch (error) {
		return null;
	}
	for (; dir !== path.dirname(dir); dir = path.dirname(dir)) {
		const doc = readText(path.join(dir, 'package.json'));
		if (doc && JSON.parse(doc).name === name) return JSON.parse(doc);
	}
	return null;
}

/** {node, packages: {name: version | 'absent'}}: the runtime the engine plays on. */
function runtimeOf(root) {
	const packages = {};
	for (const entry of RUNTIME) {
		const doc = packageJson(root, entry.name, entry.from);
		packages[entry.name] = doc ? String(doc.version) : 'absent';
	}
	return {node: process.version, packages};
}

function walk(root, rel, spec, out, notes) {
	let entries;
	try {
		entries = fs.readdirSync(path.join(root, rel), {withFileTypes: true});
	} catch (error) {
		if (notes && error.code !== 'ENOENT') notes.push(rel + ' (unreadable: ' + error.code + ')');
		return out;
	}
	for (const entry of entries) {
		const child = rel + '/' + entry.name;
		if (TESTS.test(child + '/') || (spec.skip && spec.skip.test(child + '/'))) continue;
		if (entry.isSymbolicLink() && isDirectory(path.join(root, child))) {
			if (notes) notes.push(child + ' (symlinked directory, not followed)');
			continue;
		}
		if (entry.isDirectory()) walk(root, child, spec, out, notes);
		else if (spec.exclude && spec.exclude.test(entry.name)) continue;
		else if (spec.ext.some(ext => entry.name.endsWith(ext)) && !entry.name.endsWith('.d.ts')) out.push(child);
	}
	return out;
}

function isDirectory(file) {
	try {
		return fs.statSync(file).isDirectory();
	} catch (error) {
		return false;
	}
}

/** The files of one part, sorted, relative to root. */
function filesOf(root, spec, notes) {
	const files = (spec.dir ? walk(root, spec.dir, spec, [], notes) : []).concat(spec.files || [],
		spec.derive ? spec.derive(root) : []);
	return [...new Set(files)].sort();
}

function readText(file) {
	try {
		return fs.readFileSync(file, 'utf8');
	} catch (error) {
		return null;
	}
}

/**
 * The JSON files the played code names: every relative `*.json` literal in a
 * played .js file (lib/dossier.js requires four oracle files by path), and
 * every oracle table the profile's oracle loads by name (`load('growth')`,
 * read lazily, hours into a run). Only files that exist are listed.
 */
function dataFiles(root) {
	const sources = [];
	for (const name of Object.keys(PARTS)) {
		const spec = PARTS[name];
		if (spec.derive || spec.source || /-dist$/.test(name)) continue;
		sources.push(...filesOf(root, spec).filter(rel => rel.endsWith('.js')));
	}
	sources.push(...walk(root, 'profiles', {ext: ['.js'], skip: /(^|\/)fidelity\//}, []));
	const found = new Set();
	for (const rel of new Set(sources)) {
		const text = readText(path.join(root, rel));
		if (!text) continue;
		for (const hit of text.matchAll(/['"`]((?:\.\.?\/)+[\w./-]+\.json)['"`]/g)) {
			found.add(path.posix.normalize(path.posix.join(path.posix.dirname(rel), hit[1])));
		}
		if (/(^|\/)oracle\.js$/.test(rel)) {
			for (const hit of text.matchAll(/\bload\('([\w-]+)'\)/g)) {
				found.add(path.posix.join(path.posix.dirname(rel), 'oracle', hit[1] + '.json'));
			}
		}
	}
	return [...found].filter(rel => fs.existsSync(path.join(root, rel)));
}

function hashPart(root, spec, notes) {
	const hash = crypto.createHash('sha256');
	let found = 0;
	for (const rel of filesOf(root, spec, notes)) {
		let bytes;
		try {
			bytes = fs.readFileSync(path.join(root, rel));
		} catch (error) {
			bytes = null;
		}
		const name = spec.relative ? path.posix.relative(spec.dir, rel) : rel;
		hash.update(name + '\0' + (bytes ? bytes.length : -1) + '\0');
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
 * {version, engine, parts, revision, dirty, runtime, skipped}. `engine` is one short
 * hash over every part but the sources; `parts` holds each part's own;
 * `skipped` names the directories a walk could not or would not enter.
 */
function engineStamp(root) {
	const at = root || ROOT;
	const parts = {};
	const skipped = [];
	for (const name of Object.keys(PARTS)) parts[name] = hashPart(at, PARTS[name], skipped);
	// The calc the planner loads by package name. A pinned worktree links
	// node_modules from the main checkout, so this is the MAIN checkout's
	// calc/dist, not the tree's own copy: hashed where it resolves, by the
	// same rules and names as calc-dist.
	const resolved = resolvedCalc(at);
	parts['calc-linked'] = resolved ? hashPart(path.dirname(resolved),
		Object.assign({}, PARTS['calc-dist'], {dir: '.'}), skipped) : 'absent';
	// Node itself and the installed packages, by version.
	const runtime = runtimeOf(at);
	parts.runtime = crypto.createHash('sha256').update(JSON.stringify(runtime)).digest('hex').slice(0, 12);
	const engine = 'e-' + crypto.createHash('sha256').update(Object.keys(parts)
		.filter(name => !(PARTS[name] && PARTS[name].source))
		.map(name => name + '=' + parts[name]).join('\n')).digest('hex').slice(0, 12);
	const status = git(at, ['status', '--porcelain', '--untracked-files=no']);
	return {version: STAMP_VERSION, engine, parts, revision: git(at, ['rev-parse', 'HEAD']),
		dirty: status === null ? null : status.length > 0, runtime, skipped};
}

/**
 * Every file the stamp of root covers, as real paths: {files, dirs}. `files`
 * are the hashed files of every part (the linked calc's included); `dirs` are
 * the installed packages of RUNTIME, covered whole by their version.
 * tests/provenance.test.js checks a played process's modules against it.
 */
function coverage(root) {
	const at = root || ROOT;
	const real = file => {
		try {
			return fs.realpathSync(file);
		} catch (error) {
			return null;
		}
	};
	const files = new Set();
	for (const name of Object.keys(PARTS)) {
		for (const rel of filesOf(at, PARTS[name])) files.add(real(path.join(at, rel)));
	}
	const resolved = resolvedCalc(at);
	if (resolved) {
		const dist = path.dirname(resolved);
		for (const rel of filesOf(dist, Object.assign({}, PARTS['calc-dist'], {dir: '.'}))) files.add(real(path.join(dist, rel)));
	}
	const dirs = [];
	for (const entry of RUNTIME) {
		try {
			dirs.push(real(path.dirname(require.resolve(entry.name + '/package.json', {paths: [path.join(at, entry.from)]}))));
		} catch (error) {
			// Not installed: the stamp says 'absent', and nothing is covered.
		}
	}
	files.delete(null);
	return {files, dirs: dirs.filter(Boolean)};
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
		(stamp.dirty ? ' (dirty)' : '') + (stamp.moved ? ' (MOVED to ' + stamp.moved.engine + ')' : '');
}

/**
 * A stamp taken at process start, checked against the tree as it is now.
 * The stamp is taken once, but the oracle loads its JSON lazily, hours into a
 * run: a data file edited, or a dist rebuilt, in between plays under a stamp
 * that does not name it. Returns `taken` when nothing moved; otherwise a copy
 * carrying `moved: {engine, parts, differs}`, which compareStamps never
 * matches. Call it when the record (a receipt, a leg) is written.
 */
function settle(taken, root) {
	if (!taken || !taken.engine) return taken;
	const now = module.exports.engineStamp(root || ROOT);
	const compared = compareStamps(taken, now);
	if (compared.same === true) return taken;
	return Object.assign({}, taken, {moved: {engine: now.engine, parts: now.parts, differs: compared.differs,
		at: new Date().toISOString()}});
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
	const moved = [a, b].find(stamp => stamp.moved);
	if (moved) {
		// The bytes changed while it played: neither stamp names what played.
		return {same: false, differs: moved.moved.differs || [], moved: true, text: 'the engine moved while ' +
			describe(moved) + ' played (to ' + moved.moved.engine + '; ' + (moved.moved.differs || []).join(', ') +
			' differ): ' + describe(a) + ' against ' + describe(b)};
	}
	if ((a.version || 1) !== (b.version || 1)) {
		// Different files were hashed, so equal or unequal engines mean nothing.
		return {same: false, differs: [], format: true, text: 'different stamp format (v' + (a.version || 1) +
			' against v' + (b.version || 1) + '): ' + describe(a) + ' against ' + describe(b) +
			'; cannot tell whether the engines match'};
	}
	if (a.engine === b.engine) return {same: true, differs: [], text: 'same engine ' + a.engine};
	const names = [...new Set(Object.keys(a.parts || {}).concat(Object.keys(b.parts || {})))];
	const differs = names.filter(name => !(PARTS[name] && PARTS[name].source) &&
		(a.parts || {})[name] !== (b.parts || {})[name]);
	return {same: false, differs, text: 'different engines: ' + describe(a) + ' against ' + describe(b) +
		(differs.length ? '; ' + differs.join(', ') + ' differ' : '')};
}

/** The distinct engines a run's legs were played on, in the order first met. */
function enginesOfLegs(legs) {
	const seen = new Map();
	for (const leg of legs || []) {
		const key = leg.engine && leg.engine.engine ? leg.engine.engine +
			(leg.engine.moved ? ' (moved to ' + leg.engine.moved.engine + ')' : '') : UNKNOWN;
		if (!seen.has(key)) seen.set(key, {key, stamp: leg.engine || null, legs: []});
		seen.get(key).legs.push(leg.leg);
	}
	return [...seen.values()];
}

module.exports = {PARTS, RUNTIME, UNKNOWN, STAMP_VERSION, engineStamp, currentStamp, stampOf, describe,
	compareStamps, enginesOfLegs, filesOf, dataFiles, coverage, settle};
