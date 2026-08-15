/* eslint-env node, es6 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const FLAT_COLOR_SOURCES = [
	'src/css/dark-theme.css',
	'src/css/main.css',
	'src/css/runbun-shell.css',
	'src/css/runbun-tokens.css',
	'src/js/shared_controls.js',
];

test('authored UI uses flat color unless a gradient is explicitly approved', () => {
	FLAT_COLOR_SOURCES.forEach(relativePath => {
		const source = fs.readFileSync(path.join(__dirname, relativePath), 'utf8');
		assert.doesNotMatch(
			source,
			/gradient\s*\(/i,
			relativePath + ' contains an unapproved gradient',
		);
	});
});
