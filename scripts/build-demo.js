/* eslint-env node, es6 */
'use strict';

/**
 * Build the DEMO: the whole recreation as one self-contained HTML file.
 *
 * The panel is a thin client over `/run/*`; `run-api.js` is that surface with
 * the transport peeled off. This script bundles the engine — run rules,
 * planner, AI policy, oracle data, trainer sets — for the browser, shims
 * `fetch` so the panel's own requests are answered in-page, and inlines the
 * panel's markup and styles. The result opens anywhere a file opens: no
 * server, no install, a phone tapping a link.
 *
 * The three Node seams are shimmed, not forked:
 *   node:fs    readFileSync answers from files embedded at build time
 *   node:path  join is string glue
 *   node:vm    runInThisContext is indirect eval (the trainer setdex IS a
 *              classic browser script; evaluating it globally is how the
 *              real page loads it too)
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = process.argv[2] || path.join(ROOT, 'dist', 'demo.html');

function read(rel) {
	return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** Everything `readFileSync` may be asked for in the browser, keyed by the
 * path suffix the caller builds. Embedded as literals at build time. */
function embeddedFiles() {
	const files = {};
	const oracleDir = path.join(ROOT, 'profiles', 'run-and-bun', 'oracle');
	for (const name of fs.readdirSync(oracleDir).filter(f => f.endsWith('.json'))) {
		files[`oracle/${name}`] = fs.readFileSync(path.join(oracleDir, name), 'utf8');
	}
	const encounters = require(path.join(ROOT, 'profiles', 'run-and-bun', 'encounters.js'));
	files[encounters.SOURCE] = read(encounters.SOURCE);
	return files;
}

function loadEsbuild() {
	// Wherever it lives: the repo's own install, or the npx cache the build
	// machine already warmed. `npm i -D esbuild` makes the first path real.
	const candidates = ['esbuild'];
	try {
		const execSync = require('node:child_process').execSync;
		const cache = execSync('find /root/.npm/_npx -maxdepth 3 -name esbuild -type d 2>/dev/null | head -1',
			{encoding: 'utf8'}).trim();
		if (cache) candidates.push(cache);
	} catch (error) { /* no npx cache to fall back to */ }
	for (const candidate of candidates) {
		try {
			return require(candidate);
		} catch (error) { /* try the next */ }
	}
	throw new Error('esbuild is required: npm install --no-save esbuild');
}

async function bundleEngine() {
	const esbuild = loadEsbuild();
	const files = embeddedFiles();
	const shims = {
		fs: `
			var FILES = ${JSON.stringify(files)};
			module.exports = {
				readFileSync: function (p) {
					var wanted = String(p).replace(/\\\\/g, '/');
					for (var key in FILES) {
						if (wanted.slice(-key.length) === key) return FILES[key];
					}
					throw new Error('demo fs: ' + p + ' is not embedded in this build');
				},
			};
		`,
		path: `
			module.exports = {join: function () {
				return Array.prototype.join.call(arguments, '/');
			}};
		`,
		vm: `
			module.exports = {runInThisContext: function (source) {
				return (0, eval)(source);
			}};
		`,
	};
	const result = await esbuild.build({
		stdin: {
			contents: `
				window.RunBunLocalApi = require('./run-api.js');
			`,
			resolveDir: ROOT,
			sourcefile: 'demo-entry.js',
		},
		bundle: true,
		write: false,
		minify: true,
		format: 'iife',
		platform: 'browser',
		define: {
			global: 'globalThis',
			'process.env.NODE_ENV': '"production"',
			// The fs shim answers by path SUFFIX, so the prefix only has to exist.
			__dirname: '"/app"',
			__filename: '"/app/bundle.js"',
		},
		plugins: [{
			name: 'node-shims',
			setup(build) {
				build.onResolve({filter: /^(node:)?(fs|path|vm|os)$/}, args => ({
					path: args.path.replace(/^node:/, ''),
					namespace: 'demo-shim',
				}));
				build.onLoad({filter: /.*/, namespace: 'demo-shim'}, args => ({
					contents: shims[args.path] || 'module.exports = {};',
					loader: 'js',
				}));
			},
		}],
	});
	return result.outputFiles[0].text;
}

/** The panel's own section, cut whole from the shipped template. */
function panelMarkup() {
	const html = read('src/index.template.html');
	const start = html.indexOf('<section id="runbun-run"');
	const end = html.indexOf('</section>', start) + '</section>'.length;
	if (start < 0 || end < start) throw new Error('the run panel section moved; update build-demo');
	// There is no shell here to mark the active mode, and below the responsive
	// breakpoint an inactive region collapses — so the panel IS active, always.
	return html.slice(start, end)
		.replace('class="runbun-run rb-mode-region rb-panel"',
			'class="runbun-run rb-mode-region rb-mode-active rb-panel"');
}

/**
 * The fetch shim: the panel keeps asking the network, the page keeps
 * answering. Refusals carry the same statuses the server sends, so every
 * panel behavior — including how it renders a refusal — stays identical.
 */
const FETCH_SHIM = `
(function () {
	var real = window.fetch ? window.fetch.bind(window) : null;
	window.fetch = function (url, options) {
		var path = String(url).split('?')[0];
		var routes = window.RunBunLocalApi.ROUTES;
		if (!routes[path]) {
			if (real) return real(url, options);
			return Promise.reject(new Error('no route for ' + url));
		}
		return new Promise(function (resolve) {
			// A macrotask, so a heavy answer (advise, rank) cannot wedge the
			// click handler that asked for it.
			setTimeout(function () {
				var body;
				var status = 200;
				try {
					var payload = options && options.body ? JSON.parse(options.body) : {};
					body = routes[path](payload);
				} catch (error) {
					status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
					body = {error: status >= 500 ? 'Internal server error' : error.message};
					if (error.code) body.code = error.code;
					if (status >= 500) console.error(error);
				}
				resolve({
					ok: status < 400,
					status: status,
					json: function () { return Promise.resolve(body); },
				});
			}, 0);
		});
	};
})();
`;

async function main() {
	const engine = await bundleEngine();
	const page = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Run &amp; Bun Recreation</title>
<style>
${read('src/css/main.css')}
${read('src/css/runbun-tokens.css')}
${read('src/css/runbun-shell.css')}
/* Demo-only: no shell tabs, the panel is the page. */
body { background: var(--rb-surface, #fff); }
.demo-shell { max-width: 80rem; margin: 0 auto; padding: var(--rb-space-sm) var(--rb-space-lg) 0; font-family: var(--rb-font-body, sans-serif); }
.demo-shell h1 { font-family: var(--rb-font-brand, sans-serif); color: var(--rb-brand, #b34700); margin: 0; font-size: 1.4rem; }
.demo-shell p { color: var(--rb-ink-muted, #555); font-size: 0.82rem; margin: 0.25em 0 0; }
#runbun-run { display: block; }
</style>
</head>
<body>
<div class="demo-shell">
	<h1>Run &amp; Bun — the recreation</h1>
	<p>The whole engine runs in this page: roll encounters off the real tables, fight the
	trainers turn by turn against the game's own AI. The run saves in this browser only —
	use Export to keep a copy. Built from the same modules the server serves.</p>
</div>
${panelMarkup()}
<script>${read('src/js/vendor/jquery-1.9.1.min.js')}</script>
<script>${engine}</script>
<script>${FETCH_SHIM}</script>
<script>${read('src/js/run_panel.js')}</script>
</body>
</html>
`;
	fs.mkdirSync(path.dirname(OUT), {recursive: true});
	fs.writeFileSync(OUT, page);
	console.log(`demo written: ${OUT} (${(page.length / 1024 / 1024).toFixed(1)} MB)`);
}

main().catch(error => {
	console.error(error);
	process.exit(1);
});
