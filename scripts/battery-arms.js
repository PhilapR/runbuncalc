#!/usr/bin/env node
/* eslint-env node, es6 */
'use strict';

/**
 * Run several battery arms at once, each from its own clean worktree.
 *
 * Arms used to run one after another from a single worktree: sixteen of
 * them took about forty minutes on an eleven-core machine, and the operator
 * stopped the batch. Run side by side they finish in the time of the
 * slowest arm (five baselines: 5.5 minutes). Each arm gets its own detached
 * worktree at one committed revision, so no arm's receipt can make another
 * arm's tree dirty — the battery stamps `dirty` from `git status` when it
 * writes, and a shared tree read every receipt but the first as dirty.
 *
 * Each package in node_modules is symlinked (workspace links point at the
 * worktree's own calc) and ai/dist + calc/dist are copied, the same way
 * ab.js prepares its worktree and for the same reasons: the modules are the
 * same versions, and a linked build would let a mid-batch rebuild leak in. Receipts, logs and worktrees live under gitignored
 * ui-playthrough-out/; which receipts to commit is a separate decision.
 *
 *   node scripts/battery-arms.js --rev=HEAD \
 *     --arm=battery9:battery: \
 *     --arm=battery9-pp:battery:--pp-model=1 \
 *     --arm=ko1-pp:heldout2:--ko-respects-order=1,--pp-model=1
 *   node scripts/battery-arms.js --arms=arms.json   # [{label, manifest, flags: []}]
 *
 * An arm is LABEL:MANIFEST:FLAGS. MANIFEST names scenarios/<MANIFEST>.json;
 * empty means the battery's single-scenario mode, so FLAGS carries
 * --report, --trainer and --seeds. FLAGS are comma-separated and each one is
 * passed as its own argument — never a shell string, which is how
 * koorder1-pp once ran with two flags glued into one.
 */

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const provenance = require('../lib/provenance.js');

const ROOT = path.join(__dirname, '..');

function own(name, fallback) {
	const hit = process.argv.find(arg => arg.startsWith('--' + name + '='));
	return hit === undefined ? fallback : hit.slice(name.length + 3);
}

function git(args, cwd) {
	return childProcess.spawnSync('git', args, {cwd: cwd || ROOT, encoding: 'utf8'});
}

/** The arms, from --arm=LABEL:MANIFEST:FLAGS entries or an --arms JSON file. */
function parseArms(argv) {
	const listed = argv.find(arg => arg.startsWith('--arms='));
	const file = listed ? listed.slice('--arms='.length) : null;
	const arms = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : argv
		.filter(arg => arg.startsWith('--arm='))
		.map(arg => {
			const spec = arg.slice('--arm='.length);
			const first = spec.indexOf(':');
			const second = first === -1 ? -1 : spec.indexOf(':', first + 1);
			if (second === -1) throw new Error('an arm is LABEL:MANIFEST:FLAGS, not ' + JSON.stringify(spec));
			const rest = spec.slice(second + 1);
			return {label: spec.slice(0, first), manifest: spec.slice(first + 1, second),
				flags: rest ? rest.split(',') : []};
		});
	if (!arms.length) throw new Error('no arms: pass --arm=LABEL:MANIFEST:FLAGS or --arms=FILE');
	const seen = new Set();
	for (const arm of arms) {
		// The manifest stamp convention: a receipt labelled otherwise can be
		// run and committed but never stamped (heldout1-A had to be renamed).
		if (!/^[a-z0-9][a-z0-9-]*$/.test(arm.label || '')) {
			throw new Error('arm label ' + JSON.stringify(arm.label) + ' is not a receipt name ' +
				'(lowercase letters, digits and dashes)');
		}
		if (seen.has(arm.label)) throw new Error('two arms share the label ' + arm.label);
		seen.add(arm.label);
		if (!Array.isArray(arm.flags) || arm.flags.some(flag => !/^--[a-z-]+=/.test(flag) ||
			/\s--[a-z]/.test(flag))) {
			throw new Error(arm.label + ': every flag is one --name=value argument, ' +
				'not two glued into one');
		}
		// The runner sets these itself; a second copy in the flags would
		// leave the battery reading whichever came first.
		const owned = arm.flags.find(flag => /^--(label|manifest)=/.test(flag));
		if (owned) throw new Error(arm.label + ': ' + owned + ' is set by the runner, not the arm');
	}
	return arms;
}

const MODULE_DIRS = ['node_modules', 'calc/node_modules', 'ai/node_modules'];

/**
 * Give a worktree this checkout's modules, but its OWN workspace packages.
 *
 * Linking a whole node_modules directory is not enough: @smogon/calc in it is
 * a workspace link, `../../calc`, and it resolves from where the directory
 * really is, which is the main checkout. A worktree pinned to one revision
 * then played the main checkout's calc/dist, and a rebuild there mid-batch
 * changed play under a pinned revision. So each module directory is a real
 * directory here: every package is linked to this checkout's copy, and a
 * relative (workspace) link is recreated as it is written, so it names the
 * worktree's own calc and vendor packages.
 */
function linkModules(dir) {
	for (const rel of MODULE_DIRS) {
		if (fs.existsSync(path.join(ROOT, rel))) mirrorModules(path.join(ROOT, rel), path.join(dir, rel), true);
	}
}

function mirrorModules(from, to, top) {
	fs.mkdirSync(to, {recursive: true});
	for (const name of fs.readdirSync(from)) {
		const source = path.join(from, name);
		const link = path.join(to, name);
		const stat = fs.lstatSync(source);
		const written = stat.isSymbolicLink() ? fs.readlinkSync(source) : null;
		if (written !== null && !path.isAbsolute(written)) {
			fs.symlinkSync(written, link);
			// A relative link that names nothing in this tree (it left the
			// checkout) keeps pointing where it pointed before.
			if (fs.existsSync(link)) continue;
			fs.unlinkSync(link);
			fs.symlinkSync(source, link);
		} else if (top && name.startsWith('@') && stat.isDirectory()) {
			mirrorModules(source, link, false);
		} else {
			fs.symlinkSync(source, link);
		}
	}
}

/** A detached, clean worktree at rev, with the modules and build the battery needs. */
function makeWorktree(dir, rev) {
	git(['worktree', 'remove', '--force', dir]);
	const added = git(['worktree', 'add', '--detach', dir, rev]);
	if (added.status !== 0) throw new Error('worktree add failed: ' + added.stderr.trim());
	linkModules(dir);
	for (const rel of ['ai/dist', 'calc/dist']) {
		if (fs.existsSync(path.join(ROOT, rel))) {
			fs.cpSync(path.join(ROOT, rel), path.join(dir, rel), {recursive: true});
		}
	}
	fs.mkdirSync(path.join(dir, 'ui-playthrough-out'), {recursive: true});
	const dirty = git(['status', '--porcelain'], dir).stdout.trim();
	if (dirty) throw new Error('fresh worktree at ' + dir + ' is dirty:\n' + dirty);
}

function runArms(options) {
	const rev = git(['rev-parse', '--verify', options.rev + '^{commit}']);
	if (rev.status !== 0) return Promise.reject(new Error('no commit named ' + options.rev));
	const sha = rev.stdout.trim();
	fs.mkdirSync(options.out, {recursive: true});
	fs.mkdirSync(options.worktrees, {recursive: true});
	const queue = options.arms.slice();
	const results = [];
	const started = Date.now();
	const log = options.log || (() => {});
	return new Promise(resolve => {
		let running = 0;
		const next = () => {
			if (!queue.length && !running) return resolve({sha, results});
			while (running < options.concurrency && queue.length) {
				const arm = queue.shift();
				const dir = path.join(options.worktrees, arm.label);
				try {
					makeWorktree(dir, sha);
				} catch (error) {
					results.push({label: arm.label, status: null, error: error.message});
					log('FAILED ' + arm.label + ': ' + error.message);
					continue;
				}
				running += 1;
				const args = [path.join('scripts', 'scenario-battery.js'),
					'--label=' + arm.label].concat(
					arm.manifest ? ['--manifest=scenarios/' + arm.manifest + '.json'] : [], arm.flags);
				// Through the machine's slot pool, from this tree: the arm's may predate it.
				const child = childProcess.spawn(process.execPath, [path.join(__dirname, 'submit.js'),
					'--label=arm/' + arm.label, '--', process.execPath].concat(args), {cwd: dir,
					// The arm's watch job (lib/watch.js) writes beside the MAIN checkout's
					// runs, where the watch page and runs.js look — not inside its worktree.
					env: Object.assign({}, process.env, {RUNBUN_RUNS_DIR: process.env.RUNBUN_RUNS_DIR ||
						path.join(ROOT, 'ui-playthrough-out', 'runs')})});
				let text = '';
				child.stdout.on('data', chunk => { text += chunk; });
				child.stderr.on('data', chunk => { text += chunk; });
				child.on('close', status => {
					fs.writeFileSync(path.join(options.out, arm.label + '.log'), text);
					const receipt = path.join(dir, 'scenarios', 'receipts', arm.label + '.json');
					const landed = fs.existsSync(receipt);
					if (landed) fs.copyFileSync(receipt, path.join(options.out, arm.label + '.json'));
					// Which engine the arm played on, from its own receipt: the build is
					// copied per arm, so a rebuild mid-batch splits the arms silently.
					const stamp = landed ? provenance.stampOf(JSON.parse(fs.readFileSync(receipt, 'utf8'))) : null;
					git(['worktree', 'remove', '--force', dir]);
					const seconds = Math.round((Date.now() - started) / 1000);
					results.push({label: arm.label, status, receipt: landed, seconds,
						engine: stamp ? stamp.engine : null, stamp});
					log((status === 0 ? 'done ' : 'FAILED ') + arm.label + ' (exit ' + status + ', ' +
						seconds + 's)' + (landed ? '' : ' — no receipt'));
					running -= 1;
					next();
				});
			}
			if (!queue.length && !running) resolve({sha, results});
		};
		next();
	});
}

function main() {
	let arms;
	try {
		arms = parseArms(process.argv.slice(2));
	} catch (error) {
		console.error('REFUSING: ' + error.message);
		process.exit(1);
	}
	const concurrency = Number(own('concurrency', String(Math.max(1, os.cpus().length - 2))));
	const options = {
		arms, rev: own('rev', 'HEAD'), concurrency,
		out: path.resolve(own('out', path.join(ROOT, 'ui-playthrough-out', 'arms'))),
		worktrees: path.resolve(own('worktrees', path.join(ROOT, 'ui-playthrough-out', '.worktrees'))),
		log: line => console.log(line),
	};
	console.log(arms.length + ' arm(s), ' + concurrency + ' at a time, receipts to ' + options.out);
	runArms(options).then(outcome => {
		const sha = outcome.sha;
		const results = outcome.results;
		const failed = results.filter(result => result.status !== 0 || !result.receipt);
		const engines = enginesOfResults(results);
		console.log('\nrevision ' + sha.slice(0, 10) + ': ' + (results.length - failed.length) + ' of ' +
			results.length + ' arm(s) wrote a receipt' + (failed.length ?
			'; FAILED: ' + failed.map(result => result.label).join(', ') : '') + '; ' + engines.text);
		if (engines.split) console.error('REFUSING the batch: ' + engines.text + ' — they cannot be compared');
		process.exitCode = failed.length || engines.split ? 1 : 0;
	}, error => {
		console.error('REFUSING: ' + error.message);
		process.exitCode = 1;
	});
}

if (require.main === module) main();

/**
 * The engines a batch's receipts were played on. Arms are compared with one
 * another, so a batch on more than one engine is refused as a batch.
 */
function enginesOfResults(results) {
	const landed = results.filter(result => result.receipt);
	const keys = [...new Set(landed.map(result => result.engine || provenance.UNKNOWN))];
	return {keys, split: keys.length > 1, text: keys.length > 1 ?
		'the arms played on ' + keys.length + ' engines: ' + keys.map(key => key + ' (' +
			landed.filter(result => (result.engine || provenance.UNKNOWN) === key).map(result => result.label).join(', ') + ')').join('; ') :
		keys.length ? 'one engine: ' + keys[0] : 'no receipts'};
}

module.exports = {parseArms, runArms, makeWorktree, linkModules, enginesOfResults};
