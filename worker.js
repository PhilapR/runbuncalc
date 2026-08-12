/* eslint-env node, browser, es6 */
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

function answer(work) {
	try {
		return Response.json(work());
	} catch (error) {
		if (Number.isInteger(error.statusCode)) {
			const body = {error: error.message};
			if (error.code) body.code = error.code;
			return Response.json(body, {status: error.statusCode});
		}
		console.error(error);
		return Response.json({error: 'Internal server error'}, {status: 500});
	}
}

/**
 * Private-preview gate, the fleet's pattern with the default FLIPPED: dev
 * work is never displayed publicly, so an unconfigured gate refuses (503)
 * instead of silently opening. The original skip-when-unset convenience was
 * exactly the production failure mode — a forgotten `secret put` shipped a
 * public site with nothing saying so.
 *
 *   deployed:   npx wrangler secret put SITE_AUTH_PASSWORD   (Basic auth)
 *   local dev:  SITE_AUTH_PASSWORD or PREVIEW_OPEN=true in .dev.vars
 *   public day: PREVIEW_OPEN=true as a real var, set on purpose
 *
 * Username ignored, password compared whole — as SHA-256 digests through
 * timingSafeEqual, so the comparison cost says nothing about the prefix.
 */
async function gate(request, env) {
	if (env.PREVIEW_OPEN === 'true') return null;
	const password = env.SITE_AUTH_PASSWORD;
	if (!password) {
		// Fail CLOSED: an unconfigured gate is a refusal, never an open door.
		return new Response(
			'Preview gate not configured. Set the SITE_AUTH_PASSWORD secret, ' +
			'or PREVIEW_OPEN=true to serve publicly on purpose.',
			{status: 503});
	}
	const auth = request.headers.get('authorization');
	if (auth && auth.indexOf('Basic ') === 0) {
		const decoded = atob(auth.slice('Basic '.length));
		const separator = decoded.indexOf(':');
		const supplied = separator === -1 ? decoded : decoded.slice(separator + 1);
		// Constant-time equality over SHA-256 digests (fixed length, XOR
		// accumulate) — portable, unlike workerd's timingSafeEqual extension.
		const digest = async value => new Uint8Array(await crypto.subtle.digest(
			'SHA-256', new TextEncoder().encode(value)));
		const pair = await Promise.all([digest(supplied), digest(password)]);
		let difference = 0;
		for (let i = 0; i < pair[0].length; i++) {
			difference |= pair[0][i] ^ pair[1][i];
		}
		if (difference === 0) return null;
	}
	return new Response('Authentication required.', {
		status: 401,
		headers: {'WWW-Authenticate': 'Basic realm="Run & Bun - private preview"'},
	});
}

module.exports = {
	async fetch(request, env) {
		const refused = await gate(request, env);
		if (refused) return refused;
		const url = new URL(request.url);
		const route = runApi.ROUTES[url.pathname];
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
