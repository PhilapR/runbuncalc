/* eslint-env node, es6 */
'use strict';

const assert = require('node:assert/strict');
const webcrypto = require('node:crypto').webcrypto;
const test = require('node:test');

if (!global.crypto) global.crypto = webcrypto;

const worker = require('./worker');

function authorization(password) {
	return 'Basic ' + Buffer.from('reviewer:' + password).toString('base64');
}

function environment(password) {
	return {
		SITE_AUTH_PASSWORD: password,
		ASSETS: {fetch: async () => new Response('private asset')},
	};
}

test('private Worker fails closed when its password secret is absent', async () => {
	const response = await worker.fetch(new Request('https://runbun.test/'), {
		ASSETS: {fetch: async () => new Response('must not be reached')},
	});
	assert.equal(response.status, 503);
});

test('private Worker refuses anonymous, malformed, and incorrect credentials', async () => {
	const env = environment('correct horse battery staple');
	for (const header of [null, 'Basic not-base64!', authorization('wrong')]) {
		const headers = header ? {Authorization: header} : {};
		const response = await worker.fetch(new Request('https://runbun.test/', {headers}), env);
		assert.equal(response.status, 401);
		assert.match(response.headers.get('www-authenticate'), /^Basic /);
	}
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
	assert.equal(await response.text(), 'private asset');
});
