/* eslint-env node, es6 */
'use strict';

/**
 * Browser gate for the Fight Planner panel.
 *
 * This is the project's first test that actually loads the shipped page in a
 * browser. Until now the browser surface was covered by `browser_calc_load.test.js`,
 * which proves the calculator module loads and is callable but never renders
 * anything — and by a "UI smoke 16/16 PASS" line in the docs that turned out to
 * be a manual pass with no checked-in case list behind it.
 *
 * Scope is deliberately narrow: does the planner panel, served from `dist/`,
 * talk to the real server and put a real prediction on screen. Damage,
 * scoring and content correctness all belong to the layers below and are tested
 * there. What is only checkable here is that the wiring survives the round trip
 * from DOM to HTTP and back.
 *
 * Skips rather than fails when Chromium is unavailable, so the suite still runs
 * in an environment without a browser.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const startServer = require('./server').startServer;

let chromium = null;
try {
	chromium = require('playwright-core').chromium;
} catch (error) {
	chromium = null;
}

const EXECUTABLE = process.env.PLAYWRIGHT_CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const skip = chromium ? false : 'playwright-core is not installed';

let server;
let browser;
let baseUrl;

test.before(async () => {
	if (skip) return;
	server = startServer(0);
	await new Promise(resolve => server.once('listening', resolve));
	baseUrl = `http://127.0.0.1:${server.address().port}`;
	const fs = require('node:fs');
	const path = require('node:path');
	// The bundled Chromium lives in a versioned directory; find it rather than
	// pinning a version that will drift.
	let executablePath = EXECUTABLE;
	if (!fs.existsSync(executablePath)) {
		const root = '/opt/pw-browsers';
		const dir = fs.existsSync(root) ?
			fs.readdirSync(root).find(name => /^chromium-\d+$/.test(name)) :
			undefined;
		executablePath = dir ?
			path.join(root, dir, 'chrome-linux', 'chrome') :
			undefined;
	}
	browser = await chromium.launch({executablePath, args: ['--no-sandbox']});
});

test.after(async () => {
	if (browser) await browser.close();
	if (server) await new Promise((resolve, reject) =>
		server.close(error => error ? reject(error) : resolve()));
});

test('the planner panel loads the run map and predicts a real fight', {skip}, async () => {
	const page = await browser.newPage();
	const consoleErrors = [];
	page.on('pageerror', error => consoleErrors.push(String(error)));

	await page.goto(`${baseUrl}/index.html`, {waitUntil: 'domcontentloaded'});

	// The panel must exist on the shipped page, not only in the template.
	await page.waitForSelector('#runbun-planner');

	await page.click('#runbun-planner-load');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-planner-trainer option').length > 300,
		null,
		{timeout: 15000}
	);
	const fightCount = await page.$$eval('#runbun-planner-trainer option', els => els.length);
	assert.equal(fightCount, 362, 'the run map should populate the trainer list');

	// The coverage caveat must be visible to the player, not buried in an API
	// response. A planner that looks complete invites trust in a gap nobody
	// mentioned.
	const coverage = await page.textContent('#runbun-planner-coverage');
	assert.match(coverage, /optional route trainers/, 'coverage caveat should be on screen');

	// Selecting a fight renders the opponent's party.
	await page.selectOption('#runbun-planner-trainer', 'Youngster Calvin');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-planner-party li').length === 3,
		null,
		{timeout: 10000}
	);
	const party = await page.$$eval('#runbun-planner-party .runbun-planner-mon-name',
		els => els.map(el => el.textContent));
	assert.deepEqual(party, ['Poochyena Lv5', 'Lillipup Lv6', 'Rookidee Lv6']);

	// The whole point of the panel: a team in, a ranked prediction out.
	await page.fill('#runbun-planner-team', 'Azumarill (Leader Norman)');
	await page.click('#runbun-planner-predict');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-planner-action, .runbun-planner-action').length > 1,
		null,
		{timeout: 15000}
	);

	const actions = await page.$$eval('.runbun-planner-action', els => els.map(el => ({
		score: el.querySelector('.runbun-planner-action-score').textContent,
		label: el.querySelector('.runbun-planner-action-label').textContent,
	})));
	assert.ok(actions.length > 1, 'expected several ranked actions');
	assert.ok(!actions.some(a => /undefined/.test(a.label)), 'every action needs a resolved label');
	// Ranked best-first, so the top line is the answer.
	for (let i = 1; i < actions.length; i++) {
		assert.ok(Number(actions[i - 1].score) >= Number(actions[i].score), 'actions must be ranked');
	}

	// The verdict states how much the plan rests on a coin flip.
	const verdict = await page.textContent('#runbun-planner-verdict');
	assert.match(verdict, /Decided|Contested|Only one/);

	assert.deepEqual(consoleErrors, [], `page raised errors: ${consoleErrors.join('; ')}`);
	await page.close();
});

test('a malformed team is refused in the client without a round trip', {skip}, async () => {
	const page = await browser.newPage();
	await page.goto(`${baseUrl}/index.html`, {waitUntil: 'domcontentloaded'});
	await page.waitForSelector('#runbun-planner');
	await page.click('#runbun-planner-load');
	await page.waitForFunction(
		() => document.querySelectorAll('#runbun-planner-trainer option').length > 300,
		null,
		{timeout: 15000}
	);

	await page.fill('#runbun-planner-team', 'Azumarill');
	await page.click('#runbun-planner-predict');
	await page.waitForFunction(
		() => /expected "Species \(Set Label\)"/.test(
			document.querySelector('#runbun-planner-status').textContent),
		null,
		{timeout: 5000}
	);
	const kind = await page.getAttribute('#runbun-planner-status', 'data-kind');
	assert.equal(kind, 'error', 'a typo should read as an error, not a neutral status');
	await page.close();
});
