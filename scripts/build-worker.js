/* eslint-env node, es6 */
'use strict';

/**
 * Bundle the Cloudflare Worker: `worker.js` + the whole engine, browser-flat.
 *
 * Same three Node shims as the demo build (Workers' nodejs_compat has no real
 * filesystem): fs answers from files embedded at build time, path joins
 * strings, vm is indirect eval for the trainer setdex. Output is an ES module
 * with a default export, which is what wrangler's `main` expects.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist-worker', 'worker.js');

function embeddedFiles() {
	const files = {};
	const oracleDir = path.join(ROOT, 'profiles', 'run-and-bun', 'oracle');
	for (const name of fs.readdirSync(oracleDir).filter(f => f.endsWith('.json'))) {
		files[`oracle/${name}`] = fs.readFileSync(path.join(oracleDir, name), 'utf8');
	}
	const encounters = require(path.join(ROOT, 'profiles', 'run-and-bun', 'encounters.js'));
	files[encounters.SOURCE] = fs.readFileSync(path.join(ROOT, encounters.SOURCE), 'utf8');
	return files;
}

function loadEsbuild() {
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

async function main() {
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
					throw new Error('worker fs: ' + p + ' is not embedded in this build');
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
	await esbuild.build({
		stdin: {
			contents: 'export default require(\'./worker.js\');\n',
			resolveDir: ROOT,
			sourcefile: 'worker-entry.js',
		},
		bundle: true,
		outfile: OUT,
		minify: true,
		format: 'esm',
		platform: 'browser',
		conditions: ['workerd', 'worker'],
		define: {
			global: 'globalThis',
			'process.env.NODE_ENV': '"production"',
			__dirname: '"/app"',
			__filename: '"/app/worker.js"',
		},
		plugins: [{
			name: 'node-shims',
			setup(build) {
				build.onResolve({filter: /^(node:)?(fs|path|vm|os)$/}, args => ({
					path: args.path.replace(/^node:/, ''),
					namespace: 'worker-shim',
				}));
				build.onLoad({filter: /.*/, namespace: 'worker-shim'}, args => ({
					contents: shims[args.path] || 'module.exports = {};',
					loader: 'js',
				}));
			},
		}],
	});
	const size = fs.statSync(OUT).size;
	console.log(`worker bundled: ${OUT} (${(size / 1024 / 1024).toFixed(1)} MB)`);
}

main().catch(error => {
	console.error(error);
	process.exit(1);
});
