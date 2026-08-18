/* eslint-env node, es6 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const pathToFileURL = require('node:url').pathToFileURL;
const test = require('node:test');
const app = require('../lib/server').app;

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
	server = app.listen(0, '127.0.0.1');
	await new Promise(resolve => server.once('listening', resolve));
	baseUrl = `http://127.0.0.1:${server.address().port}`;
	let executablePath = EXECUTABLE;
	if (!fs.existsSync(executablePath)) executablePath = undefined;
	browser = await chromium.launch({executablePath, args: ['--no-sandbox']});
});

test.after(async () => {
	if (browser) await browser.close();
	if (server) await new Promise((resolve, reject) =>
		server.close(error => error ? reject(error) : resolve()));
});

async function pageWithOfflineFonts() {
	const context = await browser.newContext();
	await context.route(/fonts\.(googleapis|gstatic)\.com/, route => route.abort());
	return {context, page: await context.newPage()};
}

test('served calculator is runnable without an active run', {skip}, async () => {
	const session = await pageWithOfflineFonts();
	const context = session.context;
	const page = session.page;
	const errors = [];
	page.on('pageerror', error => errors.push(String(error)));
	await page.goto(`${baseUrl}/index.html#calc`, {waitUntil: 'domcontentloaded'});
	await page.waitForFunction(() => window.calc && typeof window.calc.calculate === 'function');
	assert.equal(await page.isVisible('#calc'), true);
	assert.equal(await page.evaluate(() => window.localStorage.getItem('runbun.run.v1')), null);
	assert.deepEqual(errors, []);
	await context.close();
});

test('opening the source template redirects to the materialized page', {skip}, async () => {
	const session = await pageWithOfflineFonts();
	const context = session.context;
	const page = session.page;
	const source = pathToFileURL(path.join(__dirname, '..', 'src', 'index.template.html'));
	source.hash = 'calc';
	await page.goto(source.href, {waitUntil: 'domcontentloaded'});
	await page.waitForURL(/\/dist\/index\.html#calc$/);
	await page.waitForFunction(() => window.calc && typeof window.calc.calculate === 'function');
	assert.match(page.url(), /\/dist\/index\.html#calc$/);
	await context.close();
});
