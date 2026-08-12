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

module.exports = {
	async fetch(request, env) {
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
