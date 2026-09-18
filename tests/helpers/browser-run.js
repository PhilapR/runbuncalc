/* eslint-env node, es6 */
'use strict';

/**
 * The browser harness the browser_run*.test.js shards share.
 *
 * These tests were one 2781-line file, and Node runs test files in parallel
 * but the tests inside one file in series — so the whole server gate waited
 * on that one file (~118s of ~118s). Split four ways, each shard starts its
 * own server on port 0 and its own Chromium, so they cannot collide, and the
 * gate waits on the slowest shard instead of the sum.
 *
 * What lives here is exactly what the file shared before the split: the
 * Chromium lookup, the skip, the server/browser lifecycle, and the page
 * helpers. A shard calls useBrowser() once at top level, which registers the
 * before/after hooks on that file's own root test.
 */

const test = require('node:test');

const startServer = require('../../lib/server').startServer;

let chromium = null;
try {
	chromium = require('playwright-core').chromium;
} catch (error) {
	chromium = null;
}

const EXECUTABLE = process.env.PLAYWRIGHT_CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const skip = chromium ? false : 'playwright-core is not installed';

/** Filled by the before hook; read through the object, never copied out early. */
const harness = {server: null, browser: null, baseUrl: null};

function useBrowser() {
	test.before(async () => {
		if (skip) return;
		harness.server = startServer(0);
		await new Promise(resolve => harness.server.once('listening', resolve));
		harness.baseUrl = `http://127.0.0.1:${harness.server.address().port}`;
		const fs = require('node:fs');
		const path = require('node:path');
		let executablePath = EXECUTABLE;
		if (!fs.existsSync(executablePath)) {
			const root = '/opt/pw-browsers';
			const dir = fs.existsSync(root) ?
				fs.readdirSync(root).find(name => /^chromium-\d+$/.test(name)) :
				undefined;
			executablePath = dir ? path.join(root, dir, 'chrome-linux', 'chrome') : undefined;
		}
		harness.browser = await chromium.launch({executablePath, args: ['--no-sandbox']});
	});

	test.after(async () => {
		if (harness.browser) await harness.browser.close();
		if (harness.server) await new Promise((resolve, reject) =>
			harness.server.close(error => error ? reject(error) : resolve()));
	});
}

/** A fresh context each time, so one test's saved run cannot leak into another. */
async function open() {
	const context = await harness.browser.newContext();
	// The Google Fonts stylesheet is render-blocking, and in a proxied sandbox
	// the request can hang for many seconds before failing — stalling every
	// classic script (and DOMContentLoaded) behind it. No test asserts on the
	// font, so fail it instantly. Scoped to the font hosts only, so a genuinely
	// new external dependency still fails loudly instead of being masked.
	await context.route(/fonts\.(googleapis|gstatic)\.com/, route => route.abort());
	const page = await context.newPage();
	const errors = [];
	page.on('pageerror', error => errors.push(String(error)));
	await page.goto(`${harness.baseUrl}/index.html#runbun-run`, {waitUntil: 'domcontentloaded'});
	await page.waitForSelector('#runbun-run');
	// The map list is fetched on load; nothing else works until it lands.
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-run-map option').length > 100,
		null, {timeout: 15000});
	return {context, page, errors};
}


/** Sections fold by default (the drill-down grammar); a test that reaches
 * inside them opens everything once, like a player who wants the full desk. */
async function openAllSections(page) {
	await page.$$eval('.rb-disclose .rb-disclose-btn[aria-expanded="false"]',
		els => els.forEach(el => el.click()));
	// The manual disclosures (location chooser, scripted-catch form) fold by
	// design; tests that drive the whole panel open them the same way. The
	// transfer details is deliberately excluded — tests toggle it by summary.
	await page.$$eval('#runbun-run details.runbun-run-manual-map',
		els => els.forEach(el => { el.open = true; }));
}

/**
 * Wait for a route handler to say the request is genuinely out.
 *
 * Interception happens on Playwright's side of the wire, asynchronously with
 * the click that caused it, so reading a request counter straight after the
 * click races the handler — it fails under load rather than when the product
 * is wrong. Awaiting the handler's own promise removes the race; the bound
 * keeps a genuine "no request at all" a loud failure rather than a hung suite.
 */
function sentWithin(promise, why, ms) {
	let timer;
	return Promise.race([
		promise.then(() => clearTimeout(timer)),
		new Promise((resolve, reject) => {
			timer = setTimeout(() => reject(new Error(why)), ms || 10000);
		}),
	]);
}

async function savedRun(page) {
	const raw = await page.evaluate(() => window.localStorage.getItem('runbun.run.v1'));
	return raw ? JSON.parse(raw) : null;
}

async function durableHead(page) {
	return page.evaluate(() => window.RunBunAttemptStore.getDefault().loadActive());
}

async function driveVisibleBattleToReceipt(page, maxTurns) {
	for (let turn = 0; turn < (maxTurns || 40); turn++) {
		const done = await page.evaluate(() =>
			/recorded|Wiped/.test(document.querySelector('#runbun-run-status').textContent));
		if (done) break;
		const button = await page.$('#runbun-run-battle-moves .runbun-run-battle-move') ||
			await page.$('#runbun-run-battle-switches .runbun-run-battle-switch');
		if (!button) {
			await page.waitForTimeout(250);
			continue;
		}
		await button.click();
		await page.waitForTimeout(150);
	}
	await page.waitForFunction(
		() => /recorded/.test(document.querySelector('#runbun-run-status').textContent),
		null, {timeout: 15000});
	return page.evaluate(async () => {
		const store = window.RunBunAttemptStore.getDefault();
		const head = await store.loadActive();
		const inspected = await store.inspectAttempt(head.attemptId);
		return inspected.events.filter(event => event.kind === 'battle.ended').at(-1);
	});
}

async function selectManualMap(page, map) {
	// Both manual disclosures share the class: the location chooser this
	// helper selects in, and the scripted-catch form the same flows fill next.
	await page.$$eval('.runbun-run-manual-map',
		els => els.forEach(el => { el.open = true; }));
	await page.selectOption('#runbun-run-map', map);
}

module.exports = {skip, harness, useBrowser, open, openAllSections, sentWithin,
	savedRun, durableHead, driveVisibleBattleToReceipt, selectManualMap};
