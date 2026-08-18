/* eslint-env node, es6 */
'use strict';

/**
 * Acceptance tests against workerd through Wrangler, not a Node mock.
 * This is the gate that catches runtime-only incompatibilities such as eval,
 * unsupported Node shims, and binding/config drift.
 */

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const test = require('node:test');

const PASSWORD = 'worker-runtime-smoke';
let baseUrl;
let workerProcess;
let output = '';

function availablePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const port = server.address().port;
			server.close(error => error ? reject(error) : resolve(port));
		});
	});
}

function authorization(password) {
	return 'Basic ' + Buffer.from('runbun:' + password).toString('base64');
}

function cookiePair(response) {
	return response.headers.get('set-cookie').split(';', 1)[0];
}

async function startWorker() {
	const port = await availablePort();
	const inspectorPort = await availablePort();
	const wrangler = path.join(__dirname, '..', 'node_modules', '.bin', 'wrangler');
	workerProcess = childProcess.spawn(wrangler, [
		'dev', '--local', '--ip', '127.0.0.1', '--port', String(port),
		'--inspector-port', String(inspectorPort),
	], {
		cwd: require('node:path').join(__dirname, '..'),
		env: Object.assign({}, process.env, {SITE_AUTH_PASSWORD: PASSWORD}),
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	baseUrl = `http://127.0.0.1:${port}`;

	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(
			`Wrangler did not become ready\n${output}`)), 30000);
		function onData(chunk) {
			output += chunk.toString();
			if (!/Ready on http:\/\/127\.0\.0\.1:/.test(output)) return;
			clearTimeout(timer);
			resolve();
		}
		workerProcess.stdout.on('data', onData);
		workerProcess.stderr.on('data', onData);
		workerProcess.once('error', error => {
			clearTimeout(timer);
			reject(error);
		});
		workerProcess.once('exit', code => {
			if (/Ready on http:\/\/127\.0\.0\.1:/.test(output)) return;
			clearTimeout(timer);
			reject(new Error(`Wrangler exited ${code}\n${output}`));
		});
	});
}

async function stopWorker() {
	if (!workerProcess || workerProcess.exitCode !== null) return;
	const exited = new Promise(resolve => workerProcess.once('exit', resolve));
	workerProcess.kill('SIGTERM');
	await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
	if (workerProcess.exitCode === null) workerProcess.kill('SIGKILL');
}

async function request(pathname, options) {
	return fetch(baseUrl + pathname, options);
}

async function post(pathname, body) {
	return request(pathname, {
		method: 'POST',
		headers: {
			Authorization: authorization(PASSWORD),
			'content-type': 'application/json',
		},
		body: JSON.stringify(body),
	});
}

function battleState() {
	return {
		generation: 8, mode: 'Singles', turn: 1, field: {},
		sides: {
			ai: {activeIds: ['ai-1'], party: [{
				id: 'ai-1', species: 'Poochyena', level: 5,
				hp: {current: 20, max: 20}, moves: [{name: 'Tackle'}],
			}]},
			player: {activeIds: ['player-1'], party: [{
				id: 'player-1', species: 'Treecko', level: 5,
				hp: {current: 21, max: 21}, moves: [{name: 'Pound'}],
			}]},
		},
	};
}

test.before(startWorker);
test.after(stopWorker);

test('workerd keeps the private boundary closed', async () => {
	const loginPage = await request('/', {headers: {Accept: 'text/html'}});
	assert.equal(loginPage.status, 200);
	assert.match(await loginPage.text(), /Private playtest/);
	assert.equal((await request('/__runbun/meta')).status, 401);
	assert.equal((await request('/', {
		headers: {Authorization: authorization('wrong')},
	})).status, 401);
	assert.equal((await request('/__runbun/meta', {
		headers: {Authorization: authorization(PASSWORD)},
	})).status, 200);
	const manifest = await request('/fixtures/ui/manifest.json', {
		headers: {Authorization: authorization(PASSWORD)},
	});
	assert.equal(manifest.status, 200);
	assert.ok((await manifest.json()).scenarios.length >= 8);
});

test('workerd browser login reaches the private app and logout clears its cookie', async () => {
	const wrong = await request('/__runbun/login', {
		method: 'POST',
		headers: {
			'content-type': 'application/x-www-form-urlencoded',
			Origin: baseUrl,
		},
		body: new URLSearchParams({password: 'wrong'}),
		redirect: 'manual',
	});
	assert.equal(wrong.status, 401);
	assert.equal(wrong.headers.get('set-cookie'), null);

	const login = await request('/__runbun/login', {
		method: 'POST',
		headers: {
			'content-type': 'application/x-www-form-urlencoded',
			Origin: baseUrl,
		},
		body: new URLSearchParams({password: PASSWORD}),
		redirect: 'manual',
	});
	assert.equal(login.status, 303);
	assert.doesNotMatch(login.headers.get('set-cookie'), /; Secure/i);
	const cookie = cookiePair(login);
	assert.match(cookie, /^runbun_session=v1\./);
	assert.equal((await request('/__runbun/meta', {
		headers: {Cookie: cookie},
	})).status, 200);
	assert.equal((await request('/index.html', {
		headers: {Cookie: cookie},
	})).status, 200);

	const logout = await request('/__runbun/logout', {
		method: 'POST', headers: {Cookie: cookie, Origin: baseUrl},
		redirect: 'manual',
	});
	assert.equal(logout.status, 303);
	assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
});

test('workerd completes the first run transaction and reports the road ahead', async () => {
	const created = await post('/run/new', {
		name: 'workerd smoke', rival: 'Swampert', levelCap: 'next-milestone-ace',
	});
	assert.equal(created.status, 200);
	const createdBody = await created.json();

	const caught = await post('/run/apply', {
		run: createdBody.run,
		command: {kind: 'catch', species: 'Treecko', level: 5},
	});
	assert.equal(caught.status, 200);
	const caughtBody = await caught.json();
	assert.match(caughtBody.summary, /caught Treecko/);

	const status = await post('/run/status', {run: caughtBody.run, upcomingCount: 8});
	assert.equal(status.status, 200);
	const statusBody = await status.json();
	assert.equal(statusBody.status.next.trainer, 'Youngster Calvin');
});

test('workerd exposes validation with explicit client errors', async () => {
	const valid = await post('/ai/validate-battle-state', {state: battleState()});
	assert.equal(valid.status, 200);
	assert.deepEqual(await valid.json(), {ok: true});

	const invalid = await post('/ai/validate-battle-state', {});
	assert.equal(invalid.status, 400);
	assert.deepEqual(await invalid.json(), {
		error: 'BattleState with sides is required', code: 'InvalidBattleState',
	});

	const malformed = await request('/run/new', {
		method: 'POST',
		headers: {
			Authorization: authorization(PASSWORD),
			'content-type': 'application/json',
		},
		body: '{',
	});
	assert.equal(malformed.status, 400);
	assert.deepEqual(await malformed.json(), {error: 'request body must contain valid JSON'});
});
