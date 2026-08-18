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

test('action buttons keep readable ink and visible keyboard focus in both themes', () => {
	const tokens = fs.readFileSync(path.join(__dirname, '..', 'src/css/runbun-tokens.css'), 'utf8');
	const shell = fs.readFileSync(path.join(__dirname, '..', 'src/css/runbun-shell.css'), 'utf8');
	const mainCss = fs.readFileSync(path.join(__dirname, '..', 'src/css/main.css'), 'utf8');
	// One ink token per theme: white on the dark-teal light action, dark ink
	// on the light-teal dark action. Hardcoded #fff on the fill was 2.52:1.
	assert.equal((tokens.match(/--rb-action-ink:/g) || []).length, 2,
		'both themes must define --rb-action-ink');
	assert.match(shell, /\.rb-btn-primary\.btn\s*\{[^}]*color:\s*var\(--rb-action-ink\)/,
		'primary buttons must take their ink from the theme token');
	assert.doesNotMatch(shell, /\.rb-btn-primary\.btn\s*\{[^}]*color:\s*#fff/,
		'primary buttons must not hardcode white ink');
	// Upstream removed .button outlines; the fork restores :focus-visible.
	assert.match(mainCss, /\.button:focus-visible,\s*\n\.btn:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--rb-focus\)/,
		'keyboard focus ring on .button/.btn must survive the upstream outline reset');
});

test('small screens keep the 16px input floor and 44px checkbox targets', () => {
	const mainCss = fs.readFileSync(path.join(__dirname, '..', 'src/css/main.css'), 'utf8');
	const floor = mainCss.slice(mainCss.indexOf('/* Mobile floors'));
	assert.ok(floor.length > 100, 'the mobile floors block must stay last in main.css');
	assert.match(floor, /font-size:\s*16px\s*!important/,
		'text-entry controls must hold 16px on small screens or iOS zooms the page');
	assert.match(floor, /\.runbun-run-check\s*\{[^}]*min-height:\s*44px/,
		'checkbox rows must stay 44px touch targets');
});

test('starter cards carry type identity and the rival answer', () => {
	const html = fs.readFileSync(path.join(__dirname, '..', 'src/index.template.html'), 'utf8');
	const tokens = fs.readFileSync(path.join(__dirname, '..', 'src/css/runbun-tokens.css'), 'utf8');
	['grass', 'fire', 'water'].forEach(kind => {
		assert.match(html, new RegExp('class="btn runbun-run-starter" data-species="[A-Za-z]+" data-type="' + kind + '"'),
			'each starter names its type for the accent');
		assert.equal((tokens.match(new RegExp('--rb-type-' + kind + ':', 'g')) || []).length, 2,
			'--rb-type-' + kind + ' must exist in both themes');
	});
	assert.equal((html.match(/runbun-run-starter-rival/g) || []).length, 3,
		'every starter card states which starter the rival answers with');
});

test('the game surface types from the four-step scale, never raw small rems', () => {
	const tokens = fs.readFileSync(path.join(__dirname, '..', 'src/css/runbun-tokens.css'), 'utf8');
	['label', 'section', 'body', 'note'].forEach(step => {
		assert.match(tokens, new RegExp('--rb-text-' + step + ':'),
			'--rb-text-' + step + ' must exist');
	});
	const mainCss = fs.readFileSync(path.join(__dirname, '..', 'src/css/main.css'), 'utf8');
	// Every runbun rule takes its size from the scale: a raw rem below 1
	// is exactly how the nine-size label drift happened the first time.
	const offenders = [];
	for (const match of mainCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
		if (!/runbun/.test(match[1])) continue;
		for (const size of match[2].matchAll(/font-size:\s*([0-9.]+)rem/g)) {
			if (parseFloat(size[1]) < 1) offenders.push(match[1].trim().slice(0, 60) + ' → ' + size[1] + 'rem');
		}
	}
	assert.deepEqual(offenders, [],
		'sub-1rem font sizes in game rules must use var(--rb-text-*)');
	// Upstream th{font-size:0.8em} compounds sizes below the floor.
	assert.match(mainCss, /#runbun-run th\s*\{\s*font-size:\s*inherit;/,
		'game tables must reset the upstream th shrink');
});
