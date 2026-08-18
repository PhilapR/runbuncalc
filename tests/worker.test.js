/* eslint-env node, es6 */
'use strict';

const assert = require('node:assert/strict');
const webcrypto = require('node:crypto').webcrypto;
const test = require('node:test');

if (!global.crypto) global.crypto = webcrypto;

const worker = require('../worker');

function authorization(password) {
	return 'Basic ' + Buffer.from('reviewer:' + password).toString('base64');
}

function environment(password) {
	return {
		SITE_AUTH_PASSWORD: password,
		ASSETS: {fetch: async () => new Response('private app asset')},
	};
}

function loginRequest(password, options) {
	return new Request('https://runbun.test/__runbun/login', {
		method: 'POST',
		headers: Object.assign({
			'content-type': 'application/x-www-form-urlencoded',
			Origin: 'https://runbun.test',
		}, options && options.headers),
		body: new URLSearchParams({password}),
	});
}

function cookiePair(response) {
	return response.headers.get('set-cookie').split(';', 1)[0];
}

async function signedSessionCookie(password, expiry) {
	const payload = `runbun-private-session-v1:${expiry}`;
	const key = await crypto.subtle.importKey(
		'raw', new TextEncoder().encode(password),
		{name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
	const signature = new Uint8Array(await crypto.subtle.sign(
		'HMAC', key, new TextEncoder().encode(payload)));
	const encoded = Buffer.from(signature).toString('base64url');
	return `runbun_session=v1.${expiry}.${encoded}`;
}

function battleState() {
	return {
		generation: 8,
		mode: 'Singles',
		turn: 1,
		field: {},
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

test('private Worker fails closed when its password secret is absent', async () => {
	const response = await worker.fetch(new Request('https://runbun.test/'), {
		ASSETS: {fetch: async () => new Response('must not be reached')},
	});
	assert.equal(response.status, 503);
});

test('private Worker serves only a flat login shell to anonymous browser navigation', async () => {
	const response = await worker.fetch(new Request('https://runbun.test/', {
		headers: {Accept: 'text/html'},
	}), environment('correct horse battery staple'));
	assert.equal(response.status, 200);
	assert.equal(response.headers.get('www-authenticate'), null);
	assert.equal(response.headers.get('cache-control'), 'no-store');
	assert.match(response.headers.get('content-security-policy'), /form-action 'self'/);
	const html = await response.text();
	assert.match(html, /<form[^>]+action="\/__runbun\/login"/);
	assert.match(html, /autocomplete="current-password"/);
	assert.doesNotMatch(html, /(?:linear|radial|conic)-gradient/i);
	assert.doesNotMatch(html, /private app asset/);
});

test('private Worker still challenges anonymous APIs, assets, and bad Basic credentials', async () => {
	const env = environment('correct horse battery staple');
	for (const header of [null, 'Basic not-base64!', authorization('wrong')]) {
		const headers = header ? {Authorization: header} : {};
		const response = await worker.fetch(new Request(
			'https://runbun.test/__runbun/meta', {headers}), env);
		assert.equal(response.status, 401);
		assert.match(response.headers.get('www-authenticate'), /^Basic /);
	}
	const asset = await worker.fetch(new Request(
		'https://runbun.test/fixtures/ui/manifest.json'), env);
	assert.equal(asset.status, 401);
	assert.match(asset.headers.get('www-authenticate'), /^Basic /);
});

test('login creates a bounded signed cookie that authenticates browser requests', async () => {
	const password = 'correct horse battery staple';
	const env = environment(password);
	const login = await worker.fetch(loginRequest(password), env);
	assert.equal(login.status, 303);
	assert.equal(login.headers.get('location'), '/');
	const setCookie = login.headers.get('set-cookie');
	assert.match(setCookie, /^runbun_session=v1\./);
	assert.match(setCookie, /HttpOnly/i);
	assert.match(setCookie, /Secure/i);
	assert.match(setCookie, /SameSite=Strict/i);
	assert.match(setCookie, /Path=\//i);
	assert.match(setCookie, /Max-Age=43200/i);

	const metadata = await worker.fetch(new Request('https://runbun.test/__runbun/meta', {
		headers: {Cookie: cookiePair(login)},
	}), env);
	assert.equal(metadata.status, 200);
	const app = await worker.fetch(new Request('https://runbun.test/', {
		headers: {Accept: 'text/html', Cookie: cookiePair(login)},
	}), env);
	assert.equal(app.status, 200);
	assert.equal(await app.text(), 'private app asset');
});

test('login rejects wrong credentials and cross-site form submission without a session', async () => {
	const env = environment('correct horse battery staple');
	const wrong = await worker.fetch(loginRequest('wrong'), env);
	assert.equal(wrong.status, 401);
	assert.equal(wrong.headers.get('set-cookie'), null);
	assert.match(await wrong.text(), /Password did not match/);

	const crossSite = await worker.fetch(loginRequest('correct horse battery staple', {
		headers: {Origin: 'https://example.test'},
	}), env);
	assert.equal(crossSite.status, 403);
	assert.equal(crossSite.headers.get('set-cookie'), null);

	const loopbackAlias = await worker.fetch(new Request(
		'http://127.0.0.1:8787/__runbun/login', {
			method: 'POST',
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				Origin: 'http://localhost:8787',
			},
			body: new URLSearchParams({password: 'correct horse battery staple'}),
		}), env);
	assert.equal(loopbackAlias.status, 303);

	const opaqueSameOrigin = await worker.fetch(loginRequest(
		'correct horse battery staple', {headers: {
			Origin: 'null', 'Sec-Fetch-Site': 'same-origin',
		}}), env);
	assert.equal(opaqueSameOrigin.status, 303);
	const opaqueCrossSite = await worker.fetch(loginRequest(
		'correct horse battery staple', {headers: {
			Origin: 'null', 'Sec-Fetch-Site': 'cross-site',
		}}), env);
	assert.equal(opaqueCrossSite.status, 403);
});

test('tampered, expired, and implausibly long browser sessions are refused', async () => {
	const password = 'correct horse battery staple';
	const env = environment(password);
	const login = await worker.fetch(loginRequest(password), env);
	const valid = cookiePair(login);
	const tampered = valid.slice(0, -1) + (valid.endsWith('a') ? 'b' : 'a');
	for (const cookie of [
		tampered,
		await signedSessionCookie(password, Math.floor(Date.now() / 1000) - 1),
		await signedSessionCookie(password, Math.floor(Date.now() / 1000) + 86400),
	]) {
		const response = await worker.fetch(new Request(
			'https://runbun.test/__runbun/meta', {headers: {Cookie: cookie}}), env);
		assert.equal(response.status, 401);
	}
});

test('logout clears the browser session cookie', async () => {
	const password = 'correct horse battery staple';
	const env = environment(password);
	const login = await worker.fetch(loginRequest(password), env);
	const logout = await worker.fetch(new Request('https://runbun.test/__runbun/logout', {
		method: 'POST',
		headers: {Cookie: cookiePair(login), Origin: 'https://runbun.test'},
	}), env);
	assert.equal(logout.status, 303);
	assert.equal(logout.headers.get('location'), '/');
	assert.match(logout.headers.get('set-cookie'), /^runbun_session=;/);
	assert.match(logout.headers.get('set-cookie'), /Max-Age=0/i);
});

test('authenticated metadata proves the built revision and Model version', async () => {
	const password = 'correct horse battery staple';
	const response = await worker.fetch(new Request('https://runbun.test/__runbun/meta', {
		headers: {Authorization: authorization(password)},
	}), environment(password));
	assert.equal(response.status, 200);
	assert.equal(response.headers.get('cache-control'), 'no-store');
	assert.deepEqual(await response.json(), {
		service: 'runbun', revision: 'development', modelVersion: '2.0.0',
	});
});

test('authenticated requests can reach private static assets', async () => {
	const password = 'correct horse battery staple';
	const response = await worker.fetch(new Request('https://runbun.test/index.html', {
		headers: {Authorization: authorization(password)},
	}), environment(password));
	assert.equal(response.status, 200);
	assert.equal(await response.text(), 'private app asset');
});

test('authenticated browser tools can validate BattleState through the Worker', async () => {
	const password = 'correct horse battery staple';
	const headers = {
		Authorization: authorization(password),
		'content-type': 'application/json',
	};
	const ok = await worker.fetch(new Request('https://runbun.test/ai/validate-battle-state', {
		method: 'POST', headers, body: JSON.stringify({state: battleState()}),
	}), environment(password));
	assert.equal(ok.status, 200);
	assert.deepEqual(await ok.json(), {ok: true});

	const bad = await worker.fetch(new Request('https://runbun.test/ai/validate-battle-state', {
		method: 'POST', headers, body: '{}',
	}), environment(password));
	assert.equal(bad.status, 400);
	assert.deepEqual(await bad.json(), {
		error: 'BattleState with sides is required', code: 'InvalidBattleState',
	});
});
