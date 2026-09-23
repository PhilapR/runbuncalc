/* eslint-env node, es6 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const falsify = require('../scripts/falsify.js');

const ROOT = path.join(__dirname, '..');

/** This process's environment without the runner's marker, which stops a nested `node --test`. */
function cleanEnv() {
	const env = Object.assign({}, process.env);
	delete env.NODE_TEST_CONTEXT;
	return env;
}

/** The TAP a real `node --test` prints for one fixture file, as falsify runs it. */
function tapOf(source, name) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'falsify-'));
	fs.writeFileSync(path.join(dir, 'guard.test.js'), source);
	const run = childProcess.spawnSync(process.execPath, ['--test', '--test-reporter=tap']
		.concat(name ? ['--test-name-pattern=' + name] : [], ['guard.test.js']), {cwd: dir, encoding: 'utf8', env: cleanEnv()});
	return (run.stdout || '') + (run.stderr || '');
}

const GUARDS = `const test = require('node:test');
const assert = require('node:assert/strict');
test('the guard holds', () => { assert.equal(1, 1); });
test('the guard asserts', () => { assert.equal(1, 2); });
test('the guard crashes', () => { const none = undefined; none.field(); });
test('the guard nests', async t => { await t.test('an inner check', () => { assert.equal(1, 2); }); });
`;

test('falsify reads a pattern that matches no test as BROKEN, not HOLLOW', () => {
	// Node prints "tests 1, pass 1" here: the file itself is the one test.
	const output = tapOf(GUARDS, 'no test is called this');
	assert.match(output, /# pass 1/);
	const verdict = falsify.classify(output, 'guard.test.js', 'no test is called this');
	assert.equal(verdict.code, 2);
	assert.match(verdict.text, /^BROKEN, not falsified: the pattern "no test is called this" matched no test/);
});

test('falsify tells an assertion, a crash inside the test, a pass and a load failure apart', () => {
	const read = name => falsify.classify(tapOf(GUARDS, name), 'guard.test.js', name);
	assert.equal(read('the guard holds').code, 1);
	assert.match(read('the guard holds').text, /^HOLLOW/);
	assert.equal(read('the guard asserts').code, 0);
	assert.match(read('the guard asserts').text, /^FALSIFIED: /);
	assert.equal(read('the guard nests').code, 0, 'an assertion in a subtest falsifies its parent');
	const crashed = read('the guard crashes');
	assert.equal(crashed.code, 4);
	assert.match(crashed.text, /^FALSIFIED-BY-ERROR: .*\n.*the guard crashes \(TypeError\)/);

	const unloadable = "const test = require('node:test');\nconst none = undefined; none.field();\n" +
		"test('the guard holds', () => {});\n";
	const broken = falsify.classify(tapOf(unloadable, 'the guard holds'), 'guard.test.js', 'the guard holds');
	assert.equal(broken.code, 2);
	assert.match(broken.text, /^BROKEN, not falsified: guard\.test\.js did not load/);
	assert.match(broken.text, /TypeError/);
});

test('falsify refuses a mutation of TypeScript source, which never plays unbuilt', () => {
	const run = childProcess.spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'falsify.js'),
		'--file=ai/src/abilities.ts', '--test=tests/provenance.test.js', '--from=x'], {cwd: ROOT, encoding: 'utf8'});
	assert.equal(run.status, 2, run.stdout + run.stderr);
	assert.match(run.stdout, /^BROKEN, not falsified: ai\/src\/abilities\.ts is TypeScript source.*ai\/dist instead/);
});

test('a plain-script guard (--runner=script) is judged by its exit and its assertion, four ways', () => {
	// The engine's ai/src/test fixtures are plain scripts: under node --test
	// they print no named test, so falsify called every one of them BROKEN and
	// each had to be falsified by hand in a throwaway worktree (2026-09-22).
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'falsify-script-'));
	const run = (name, source) => {
		fs.writeFileSync(path.join(dir, name), source);
		return falsify.classifyScript(childProcess.spawnSync(process.execPath, [name], {cwd: dir, encoding: 'utf8'}), name);
	};
	const header = "const assert = require('node:assert/strict');\n";
	assert.equal(run('holds.js', header + 'assert.equal(1, 1);\n').code, 1, 'exit 0 under a mutation is HOLLOW');
	const asserted = run('asserts.js', header + "assert.equal(1, 2, 'the guard');\n");
	assert.equal(asserted.code, 0, 'an AssertionError is FALSIFIED');
	assert.match(asserted.text, /^FALSIFIED/);
	assert.equal(run('broken.js', header + 'this is not javascript\n').code, 2, 'a SyntaxError is BROKEN');
	assert.equal(run('missing.js', "require('./no-such-module');\n").code, 2, 'a missing module is BROKEN');
	assert.equal(run('throws.js', 'const none = undefined; none.field();\n').code, 4, 'another throw is FALSIFIED-BY-ERROR');
});
