/* eslint-env node, es6 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const provenance = JSON.parse(fs.readFileSync(
	path.join(root, 'vendor', 'pokemon-run-runtime', 'PROVENANCE.json'), 'utf8'));
const artifact = path.join(root, 'vendor', 'pokemon-run-runtime', provenance.artifact);
const actualHash = require('node:crypto').createHash('sha256')
	.update(fs.readFileSync(artifact)).digest('hex');
if (actualHash !== provenance.artifactSha256) {
	throw new Error('pokemon-mono runtime artifact does not match PROVENANCE.json');
}

esbuild.buildSync({
	entryPoints: [path.join(root, 'scripts', 'entries', 'pokemon-provider-entry.mjs')],
	outfile: path.join(root, 'dist', 'js', 'pokemon_provider.js'),
	bundle: true,
	format: 'iife',
	platform: 'browser',
	target: ['es2020'],
	minify: true,
	logLevel: 'info',
});
