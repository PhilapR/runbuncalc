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

test('calculator composes both combatants in an explicit responsive grid', () => {
	const html = fs.readFileSync(path.join(__dirname, 'src/index.template.html'), 'utf8');
	const mainCss = fs.readFileSync(path.join(__dirname, 'src/css/main.css'), 'utf8');
	const css = fs.readFileSync(path.join(__dirname, 'src/css/runbun-shell.css'), 'utf8');
	assert.match(html, /class="panel calc-column calc-player-column"/);
	assert.match(html, /class="panel calc-column calc-opponent-column"/);
	assert.match(css, /#calc\.rb-mode-active\s*\{[\s\S]*?display:\s*grid;/);
	assert.match(css, /#calc > \.calc-player-column\s*\{[^}]*grid-column:\s*1;/);
	assert.match(css, /#calc > \.calc-opponent-column\s*\{[^}]*grid-column:\s*3;/);
	assert.match(css, /@media \(max-width:\s*900px\)[\s\S]*?#calc > \.calc-opponent-column\s*\{\s*grid-row:\s*5;/);
	assert.match(css, /#calc \.move-result-group\[hidden\],[\s\S]*?display:\s*none;/);
	assert.doesNotMatch(css, /#calc > \*\s*\{\s*min-width:\s*100em;/);
	assert.match(mainCss, /\.visually-hidden\s*\{[^}]*width:\s*1px;/);
});

test('secondary engineering surface is presented as a lab', () => {
	const html = fs.readFileSync(path.join(__dirname, 'src/index.template.html'), 'utf8');
	assert.match(html, /id="rb-nav-tools"[^>]*>Lab<\/a>/);
	assert.match(html, /id="sets-bridge-heading">Battle-state lab<\/h2>/);
	assert.match(html, /This development surface does not change your run\./);
});
