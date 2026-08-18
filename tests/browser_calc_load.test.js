/* eslint-env node, es6 */
'use strict';

/**
 * Browser calculator load gate.
 *
 * The browser page is the product's primary surface, and it does not load the
 * calculator the way Node does. It loads `dist/calc/*.js` as classic scripts
 * sharing one global `exports` object, with `require()` stubbed to return it —
 * so the modules are not truly isolated. `prepareBrowserCalcModule` in `build`
 * rewrites the TypeScript CommonJS emit to survive that.
 *
 * That rewrite is fork-owned, load-bearing, and was exercised by nothing: the
 * root gate builds `dist/` and then never loads it. Its most dangerous failure
 * is silent rather than loud. `build` strips `exports.calculate` and
 * `exports.calcStat` unconditionally, then re-adds them only if a regex
 * anchored to a single source line (`const Acalculate = A.calculate;` at
 * `calc/src/index.ts:58`) matches. Rename or reformat that line and the output
 * is still valid JavaScript, still loads without error, and leaves
 * `calc.calculate` undefined — every calculate button on every page dead, with
 * a green build.
 *
 * This test reproduces the page's loader exactly and asserts the calculator is
 * actually callable at the end of it.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = require('node:path').join(__dirname, '..');
const distDir = path.join(root, 'dist');
const template = path.join(root, 'src', 'index.template.html');

/**
 * The calculator scripts the shipped page loads, in page order.
 *
 * Read from the template rather than hardcoded, so adding or reordering a
 * script tag is covered automatically instead of drifting away from this test.
 */
function calcScriptsFromTemplate() {
	const html = fs.readFileSync(template, 'utf8');
	const sources = [];
	const tag = /<script[^>]*\ssrc="\.\/(calc\/[^"?]+\.js)\??"/g;
	let match;
	while ((match = tag.exec(html)) !== null) sources.push(match[1]);
	return sources;
}

/**
 * Rebuild the page's script environment: one shared `exports`, a `require()`
 * stub returning it, and the `__createBinding` shim. Mirrors the inline script
 * in `src/index.template.html` immediately before the calc script tags.
 */
function loadCalcLikeTheBrowser(scripts) {
	const context = {};
	context.exports = {};
	context.calc = context.exports;
	context.require = function () { return context.exports; };
	context.__createBinding = function (o, m, k) { o[k] = m[k]; };
	vm.createContext(context);

	for (const rel of scripts) {
		const file = path.join(distDir, rel);
		assert.ok(fs.existsSync(file), `${rel} is referenced by the page but missing from dist/`);
		const code = fs.readFileSync(file, 'utf8');
		try {
			vm.runInContext(code, context, {filename: rel});
		} catch (err) {
			assert.fail(`${rel} threw while loading in the page's script environment: ${err.message}`);
		}
	}
	return context.calc;
}

test('every calculator script the page loads exists and evaluates', () => {
	const scripts = calcScriptsFromTemplate();
	assert.ok(scripts.length > 15, `expected the page to load the calculator modules, found ${scripts.length}`);
	const calc = loadCalcLikeTheBrowser(scripts);
	assert.ok(calc && typeof calc === 'object', 'the shared exports object was replaced or lost');
});

test('the browser build exposes a callable calculator', () => {
	const calc = loadCalcLikeTheBrowser(calcScriptsFromTemplate());
	// These two are the assignments `build` strips and conditionally re-adds.
	// If its anchor regex ever misses, they are silently absent and the page
	// loads clean with dead buttons.
	assert.equal(typeof calc.calculate, 'function', 'calc.calculate is not callable in the browser build');
	assert.equal(typeof calc.calcStat, 'function', 'calc.calcStat is not callable in the browser build');
	assert.equal(typeof calc.Generations, 'object', 'calc.Generations is missing from the browser build');
	assert.equal(typeof calc.Pokemon, 'function', 'calc.Pokemon is missing from the browser build');
	assert.equal(typeof calc.Move, 'function', 'calc.Move is missing from the browser build');
});

test('the browser build exposes the index wrapper, not the raw adaptable calculate', () => {
	const calc = loadCalcLikeTheBrowser(calcScriptsFromTemplate());
	const gen = calc.Generations.get(8);
	// The browser shim shares one `exports` object, so `dist/calc/calc.js` also
	// assigns `exports.calculate`. If `build`'s anchor regex misses, the index
	// wrapper's assignment never lands and `calc.calculate` silently resolves to
	// that raw function instead of being undefined — the page keeps loading and
	// calls the wrong implementation.
	//
	// The wrapper's distinguishing behavior is accepting a generation NUMBER and
	// resolving it via `Generations.get`; the raw adaptable calculate cannot.
	// This is the assertion that separates them.
	assert.doesNotThrow(
		() => calc.calculate(
			8,
			new calc.Pokemon(gen, 'Azumarill', {level: 50}),
			new calc.Pokemon(gen, 'Rattata', {level: 50}),
			new calc.Move(gen, 'Waterfall')
		),
		'calc.calculate does not accept a numeric generation — the browser build is exposing ' +
		'the raw adaptable calculate instead of the index wrapper'
	);
});

test('the browser build computes Run & Bun damage', () => {
	const calc = loadCalcLikeTheBrowser(calcScriptsFromTemplate());
	const gen = calc.Generations.get(8);
	const result = calc.calculate(
		gen,
		new calc.Pokemon(gen, 'Azumarill', {level: 50}),
		new calc.Pokemon(gen, 'Rattata', {level: 50}),
		new calc.Move(gen, 'Waterfall')
	);
	const damage = result.damage;
	assert.ok(Array.isArray(damage) && damage.length > 0, 'no damage rolls returned');
	assert.ok(Math.max.apply(null, damage) > 0, 'the calculator returned zero damage');

	// Exercises the fork's own data through the browser path: Azumarill's Run &
	// Bun base Attack (65, upstream 50) must be what the page calculates with,
	// so a data regression cannot hide behind the Node-only tests.
	assert.equal(gen.species.get(calc.toID('Azumarill')).baseStats.atk, 65);
});
