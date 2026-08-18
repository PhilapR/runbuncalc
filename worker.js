/* eslint-env node, browser, es6 */
/* global __RUNBUN_BUILD_SHA__, __RUNBUN_MODEL_VERSION__ */
'use strict';

/**
 * The Cloudflare Worker: the whole app on one edge — static `dist/` through
 * the ASSETS binding, the run surface answered in-process from the same
 * `run-api.js` the express server and the one-file demo serve. One
 * implementation, three transports, still no storage: every request carries
 * the whole run, exactly the property that makes this deployable as a
 * stateless Worker at all.
 *
 * Built by `scripts/build-worker.js` (esbuild + the same three Node shims the
 * demo uses — fs answers from embedded files, path joins strings, vm is
 * indirect eval), because Workers' nodejs_compat has no real filesystem.
 *
 * Follows the fleet's deploy pattern (stochastic-inference.dev zone, custom
 * domain per app, observability on) — see wrangler.jsonc.
 */

const runApi = require('./run-api.js');
const aiApi = require('./ai-api.js');
const BUILD_SHA = typeof __RUNBUN_BUILD_SHA__ === 'string' ?
	__RUNBUN_BUILD_SHA__ : 'development';
const MODEL_VERSION = typeof __RUNBUN_MODEL_VERSION__ === 'string' ?
	__RUNBUN_MODEL_VERSION__ : '2.0.0';
const SESSION_COOKIE = 'runbun_session';
const SESSION_VERSION = 'v1';
const SESSION_CONTEXT = 'runbun-private-session-v1';
const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;
const SESSION_CLOCK_SKEW_SECONDS = 60;
const encoder = new TextEncoder();

function answer(work) {
	try {
		return Response.json(work());
	} catch (error) {
		if (Number.isInteger(error.statusCode)) {
			const body = {error: error.message};
			if (error.code) body.code = error.code;
			return Response.json(body, {status: error.statusCode});
		}
		console.error(JSON.stringify({message: 'runbun request failed', error: error.message}));
		return Response.json({error: 'Internal server error'}, {status: 500});
	}
}

function fixedTimeEqual(left, right) {
	if (left.length !== right.length) return false;
	let difference = 0;
	for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
	return difference === 0;
}

async function passwordMatches(supplied, password) {
	const digest = async value => new Uint8Array(await crypto.subtle.digest(
		'SHA-256', encoder.encode(value)));
	const pair = await Promise.all([digest(supplied), digest(password)]);
	return fixedTimeEqual(pair[0], pair[1]);
}

function base64UrlEncode(bytes) {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/[=]+$/, '');
}

function base64UrlDecode(value) {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
	const standard = value.replace(/-/g, '+').replace(/_/g, '/');
	const padded = standard + '='.repeat((4 - standard.length % 4) % 4);
	let bytes;
	try {
		bytes = Uint8Array.from(atob(padded), character => character.charCodeAt(0));
	} catch (ignored) {
		return null;
	}
	// atob discards the spare bits of the final character, so two different
	// strings can decode to the same bytes. A signature has exactly one
	// canonical spelling; any other spelling is tampering and is refused.
	if (base64UrlEncode(bytes) !== value) return null;
	return bytes;
}

async function sessionSignature(password, expiry) {
	const key = await crypto.subtle.importKey(
		'raw', encoder.encode(password),
		{name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
	return new Uint8Array(await crypto.subtle.sign(
		'HMAC', key, encoder.encode(`${SESSION_CONTEXT}:${expiry}`)));
}

async function createSession(password) {
	const expiry = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS;
	const signature = await sessionSignature(password, expiry);
	return `${SESSION_VERSION}.${expiry}.${base64UrlEncode(signature)}`;
}

function cookieValue(request, name) {
	const cookie = request.headers.get('cookie');
	if (!cookie) return null;
	for (const part of cookie.split(';')) {
		const separator = part.indexOf('=');
		if (separator === -1) continue;
		if (part.slice(0, separator).trim() === name) {
			return part.slice(separator + 1).trim();
		}
	}
	return null;
}

async function validSession(request, password) {
	const token = cookieValue(request, SESSION_COOKIE);
	if (!token) return false;
	const parts = token.split('.');
	if (parts.length !== 3 || parts[0] !== SESSION_VERSION ||
		!/^\d+$/.test(parts[1])) return false;
	const expiry = Number(parts[1]);
	const now = Math.floor(Date.now() / 1000);
	if (!Number.isSafeInteger(expiry) || expiry <= now ||
		expiry > now + SESSION_MAX_AGE_SECONDS + SESSION_CLOCK_SKEW_SECONDS) return false;
	const supplied = base64UrlDecode(parts[2]);
	if (!supplied) return false;
	const expected = await sessionSignature(password, expiry);
	return fixedTimeEqual(supplied, expected);
}

function securityHeaders() {
	return {
		'Cache-Control': 'no-store',
		'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; " +
			"form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
		'Content-Type': 'text/html; charset=utf-8',
		'Referrer-Policy': 'no-referrer',
		'X-Content-Type-Options': 'nosniff',
		'X-Frame-Options': 'DENY',
	};
}

function loginPage(error) {
	const message = error ?
		'<p class="error" role="alert">Password did not match. Try again.</p>' :
		'<p class="hint">Enter the shared playtest password to continue.</p>';
	return new Response(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Run &amp; Bun · Private playtest</title>
<style>
:root { color-scheme: dark; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
  color: #f5f0e8; background: #101411; }
main { width: min(100%, 440px); border: 1px solid #3d493f; background: #182019;
  box-shadow: 8px 8px 0 #090c0a; padding: clamp(24px, 7vw, 40px); }
.eyebrow { margin: 0 0 12px; color: #9ecb76; font-size: 12px; letter-spacing: .14em;
  text-transform: uppercase; }
h1 { margin: 0; font: 700 clamp(28px, 8vw, 42px)/1 ui-sans-serif, system-ui, sans-serif; }
.hint, .error { margin: 16px 0 24px; line-height: 1.5; color: #b8c1b8; }
.error { color: #ffb3a7; }
label { display: block; margin-bottom: 8px; color: #dce5dc; font-weight: 700; }
input, button { width: 100%; border: 1px solid #69776b; border-radius: 0; font: inherit; }
input { padding: 13px 14px; color: #fff; background: #0d120e; }
input:focus { outline: 3px solid #9ecb76; outline-offset: 2px; }
button { margin-top: 14px; padding: 13px 16px; color: #111611; background: #b7e08e;
  border-color: #b7e08e; cursor: pointer; font-weight: 800; }
button:hover { background: #c7eca5; }
button:focus-visible { outline: 3px solid #f5f0e8; outline-offset: 3px; }
</style>
</head>
<body><main>
<p class="eyebrow">Private playtest</p>
<h1>Run &amp; Bun</h1>
${message}
<form action="/__runbun/login" method="post">
<label for="password">Playtest password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
<button type="submit">Enter the game</button>
</form>
</main></body>
</html>`, {status: error ? 401 : 200, headers: securityHeaders()});
}

function sameOrigin(request) {
	const origin = request.headers.get('origin');
	if (!origin) return true;
	if (origin === 'null') {
		return request.headers.get('sec-fetch-site') === 'same-origin';
	}
	try {
		const supplied = new URL(origin);
		const expected = new URL(request.url);
		if (supplied.origin === expected.origin) return true;
		const loopback = hostname => hostname === '127.0.0.1' ||
			hostname === 'localhost' || hostname === '[::1]';
		const allowed = loopback(supplied.hostname) && loopback(expected.hostname) &&
			supplied.protocol === expected.protocol && supplied.port === expected.port;
		return allowed;
	} catch (ignored) {
		return false;
	}
}

function sessionCookie(request, value, maxAge) {
	const url = new URL(request.url);
	const loopbackHttp = url.protocol === 'http:' &&
		(url.hostname === '127.0.0.1' || url.hostname === 'localhost' ||
			url.hostname === '[::1]');
	const secure = loopbackHttp ? '' : ' Secure;';
	return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; ` +
		`HttpOnly;${secure} SameSite=Strict`;
}

async function handleLogin(request, password) {
	if (request.method === 'GET' || request.method === 'HEAD') return loginPage(false);
	if (request.method !== 'POST') {
		return new Response('POST is required.', {status: 405, headers: {Allow: 'GET, HEAD, POST'}});
	}
	if (!sameOrigin(request)) return new Response('Cross-site login refused.', {status: 403});
	let supplied = '';
	try {
		const form = await request.formData();
		const value = form.get('password');
		if (typeof value === 'string' && value.length <= 1024) supplied = value;
	} catch (ignored) {
		return new Response('A form-encoded password is required.', {status: 400});
	}
	if (!await passwordMatches(supplied, password)) return loginPage(true);
	const token = await createSession(password);
	return new Response(null, {
		status: 303,
		headers: {Location: '/',
			'Set-Cookie': sessionCookie(request, token, SESSION_MAX_AGE_SECONDS)},
	});
}

function handleLogout(request) {
	if (request.method !== 'POST') {
		return new Response('POST is required.', {status: 405, headers: {Allow: 'POST'}});
	}
	if (!sameOrigin(request)) return new Response('Cross-site logout refused.', {status: 403});
	return new Response(null, {
		status: 303,
		headers: {Location: '/', 'Set-Cookie': sessionCookie(request, '', 0)},
	});
}

function isBrowserNavigation(request) {
	if (request.method !== 'GET' && request.method !== 'HEAD') return false;
	const url = new URL(request.url);
	if (url.pathname !== '/' && url.pathname !== '/index.html') return false;
	return !request.headers.has('authorization') &&
		(request.headers.get('accept') || '').includes('text/html');
}

/**
 * Private-preview gate, fail-closed when the password is missing. API clients
 * retain Basic Auth; browsers can use a signed, expiring HttpOnly cookie.
 */
async function gate(request, password) {
	const auth = request.headers.get('authorization');
	// atob throws on malformed base64; a garbage header is a failed
	// authentication attempt (the 401 below), never a 500.
	let decoded = null;
	if (auth && auth.indexOf('Basic ') === 0) {
		try {
			decoded = atob(auth.slice('Basic '.length));
		} catch (ignored) {
			decoded = null;
		}
	}
	if (decoded !== null) {
		const separator = decoded.indexOf(':');
		const supplied = separator === -1 ? decoded : decoded.slice(separator + 1);
		if (await passwordMatches(supplied, password)) return null;
	}
	if (!auth && await validSession(request, password)) return null;
	if (isBrowserNavigation(request)) return loginPage(false);
	return new Response('Authentication required.', {
		status: 401,
		headers: {'WWW-Authenticate': 'Basic realm="Run & Bun - private preview"'},
	});
}

module.exports = {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (env.PREVIEW_OPEN !== 'true' && !env.SITE_AUTH_PASSWORD) {
			// Fail CLOSED: an unconfigured gate is a refusal, never an open door.
			return new Response(
				'Preview gate not configured. Set the SITE_AUTH_PASSWORD secret, ' +
				'or PREVIEW_OPEN=true to serve publicly on purpose.',
				{status: 503});
		}
		if (env.PREVIEW_OPEN !== 'true') {
			if (url.pathname === '/__runbun/login') {
				return handleLogin(request, env.SITE_AUTH_PASSWORD);
			}
			if (url.pathname === '/__runbun/logout') return handleLogout(request);
			const refused = await gate(request, env.SITE_AUTH_PASSWORD);
			if (refused) return refused;
		} else if (url.pathname === '/__runbun/login' ||
			url.pathname === '/__runbun/logout') {
			return new Response(null, {status: 303, headers: {Location: '/'}});
		}
		if (url.pathname === '/__runbun/meta') {
			if (request.method !== 'GET') {
				return Response.json({error: 'GET is required'}, {status: 405});
			}
			return Response.json({service: 'runbun', revision: BUILD_SHA,
				modelVersion: MODEL_VERSION}, {
				headers: {'Cache-Control': 'no-store'},
			});
		}
		const route = runApi.ROUTES[url.pathname] || aiApi.ROUTES[url.pathname];
		if (route) {
			// The one GET in the surface; everything else posts the run.
			if (url.pathname === '/run/maps' && request.method === 'GET') {
				return answer(() => runApi.api.maps(Object.fromEntries(url.searchParams)));
			}
			if (request.method === 'POST') {
				let body = {};
				try {
					body = await request.json();
				} catch (error) {
					return Response.json(
						{error: 'request body must contain valid JSON'}, {status: 400});
				}
				return answer(() => route(body));
			}
			return Response.json({error: `${request.method} is not how ${url.pathname} is asked`},
				{status: 405});
		}
		// Everything else is the shipped page: dist/ through the assets binding.
		return env.ASSETS.fetch(request);
	},
};
