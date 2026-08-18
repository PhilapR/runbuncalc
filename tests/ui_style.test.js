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
		const source = fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
		assert.doesNotMatch(
			source,
			/gradient\s*\(/i,
			relativePath + ' contains an unapproved gradient',
		);
	});
});

test('calculator composes both combatants in an explicit responsive grid', () => {
	const html = fs.readFileSync(path.join(__dirname, '..', 'src/index.template.html'), 'utf8');
	const mainCss = fs.readFileSync(path.join(__dirname, '..', 'src/css/main.css'), 'utf8');
	const css = fs.readFileSync(path.join(__dirname, '..', 'src/css/runbun-shell.css'), 'utf8');
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
	const html = fs.readFileSync(path.join(__dirname, '..', 'src/index.template.html'), 'utf8');
	assert.match(html, /id="rb-nav-tools"[^>]*>Lab<\/a>/);
	assert.match(html, /id="sets-bridge-heading">Battle-state lab<\/h2>/);
	assert.match(html, /This development surface does not change your run\./);
});

test('the game surface names outcomes instead of tracker-era tools', () => {
	const html = fs.readFileSync(path.join(__dirname, '..', 'src/index.template.html'), 'utf8');
	const panel = fs.readFileSync(path.join(__dirname, '..', 'src/js/run_panel.js'), 'utf8');
	const shell = fs.readFileSync(path.join(__dirname, '..', 'src/js/runbun_shell.js'), 'utf8');
	const start = html.indexOf('<section id="runbun-run"');
	const end = html.indexOf('<section id="runbun-replay"');
	const game = html.slice(start, end);

	assert.match(game, />Check matchup</);
	assert.match(game, />Improve party</);
	assert.match(game, />Rank parties</);
	assert.match(game, />Find encounters</);
	assert.match(game, />Use this party</);
	assert.match(game, />Leave fight without saving</);
	assert.match(game, />Show all encounter areas</);
	assert.match(game, />Compare wild encounters</);
	assert.match(game, /id="runbun-run-catch-level"[^>]*aria-label="Encounter level"/);
	assert.match(game, /type="hidden" id="runbun-run-selected"/);
	assert.match(panel, /\.text\('Return to run'\)/);
	assert.match(panel, /replace\(\/\\bRoute\\s\*\(\\d\+\)\\b\/g, 'Route \$1'\)/);
	assert.doesNotMatch(game, />Matchup<|>Prep<|>Team<|>Explore<|>Journal<|>Set party</);
	assert.doesNotMatch(game, /saved on this device|Show open routes|Compare encounters|No party ranking yet/);
	assert.doesNotMatch(panel, /\.text\('Plan'\)|\.text\('Board'\)|\.text\('Beaten'\)/);
	assert.doesNotMatch(shell, /Local save|ROM-checked|Encounters · roster · fights · history/);
});

test('inactive product surfaces leave both the layout and accessibility tree', () => {
	const shell = fs.readFileSync(path.join(__dirname, '..', 'src/js/runbun_shell.js'), 'utf8');
	assert.match(shell, /region\.setAttribute\('aria-hidden', 'true'\)/);
	assert.match(shell, /region\.setAttribute\('inert', ''\)/);
	assert.match(shell, /region\.removeAttribute\('aria-hidden'\)/);
	assert.match(shell, /region\.removeAttribute\('inert'\)/);
});
