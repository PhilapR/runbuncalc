/* eslint-env node, es6 */
'use strict';

/**
 * Generate INVENTORY.md from the code itself.
 *
 * This exists because manual capability docs fall behind — the Heart Scale
 * mechanic was rediscovered from a sibling repo that nothing here referenced.
 * So the inventory is DERIVED, not written: endpoints are read out of
 * server.js, commands out of run.js, subcommands out of play.js, datasets by
 * counting the oracle's own files. What cannot be derived (prior art in other
 * repositories) lives in ECOSYSTEM.json as claims with paths, and this script
 * re-verifies those paths whenever the named clone is present.
 *
 * `inventory.test.js` regenerates this and fails on any diff, so the checked-in
 * INVENTORY.md cannot drift from the code without turning the gate red.
 *
 *   node scripts/inventory.js          # rewrite INVENTORY.md
 *   node scripts/inventory.js --print  # print to stdout instead
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function endpoints() {
	// The route table, read from the server source. A regex rather than
	// requiring the app keeps this runnable without binding a port.
	const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
	const found = [];
	const pattern = /app\.(get|post)\(\s*["']([^"']+)["']/g;
	for (let match; (match = pattern.exec(source));) {
		found.push({method: match[1].toUpperCase(), path: match[2]});
	}
	return found;
}

/** Everything above this heading is gated byte-for-byte; the doc stamps
 * below it are advisory (see the section's own note for why). */
const DOCS_MARKER = '## Hand-written docs, dated';

function inventory() {
	const run = require(path.join(root, 'run.js'));
	const play = require(path.join(root, 'play.js'));
	const planner = require(path.join(root, 'planner.js'));
	const simulate = require(path.join(root, 'simulate.js'));
	const team = require(path.join(root, 'team.js'));
	const profile = require(path.join(root, 'profiles')).getProfile('run-and-bun');

	const oracleDir = path.join(root, 'profiles', 'run-and-bun', 'oracle');
	const oracleCounts = {};
	for (const file of fs.readdirSync(oracleDir).filter(f => f.endsWith('.json')).sort()) {
		const data = JSON.parse(fs.readFileSync(path.join(oracleDir, file), 'utf8'));
		oracleCounts[file] = data.maps ? `${data.maps.length} maps` :
			data.entries ? `${data.entries.length} entries` :
				data.fields ? `${Object.keys(data.fields).length} fights` :
					`${Object.keys(data.levelUp || data).length} species`;
	}

	// The knowledge map: every claim the profile registers, grouped by how it
	// is known. This is the answer to "where does game knowledge live" — a
	// claim that is not in this list defaults to `inferred`, the weakest tag,
	// and the ratchet test fails when the verified share falls.
	const knowledge = {};
	for (const key of Object.keys(profile.provenance)) {
		const tag = profile.provenance[key];
		(knowledge[tag] = knowledge[tag] || []).push(key);
	}

	// The rulings ledger and its open questions — the decisions that used to
	// live only in chat transcripts and commit messages.
	const decisions = JSON.parse(fs.readFileSync(path.join(root, 'DECISIONS.json'), 'utf8'));

	// Hand-written root docs, dated by git: a doc's last-touched date is the
	// reader's staleness warning. (Date and hash only — both are stable at any
	// given commit, unlike "commits ago", which would drift the gate on every
	// commit that touches nothing.)
	const {execSync} = require('child_process');
	const GENERATED_DOCS = new Set(['INVENTORY.md']);
	const docs = [];
	for (const file of fs.readdirSync(root).filter(f => f.endsWith('.md')).sort()) {
		if (GENERATED_DOCS.has(file)) continue;
		let stamp = 'untracked';
		try {
			stamp = execSync(`git log -1 --format='%h %as' -- ${JSON.stringify(file)}`,
				{cwd: root}).toString().trim().replace(/'/g, '') || 'untracked';
		} catch (error) { /* not a git checkout — reported as untracked */ }
		docs.push({file, stamp});
	}

	const template = fs.readFileSync(path.join(root, 'src', 'index.template.html'), 'utf8');
	const panels = [];
	const panelPattern = /<section id="(runbun-[a-z-]+)"[^>]*aria-label="([^"]*)"/g;
	for (let match; (match = panelPattern.exec(template));) {
		panels.push({id: match[1], label: match[2]});
	}

	const tests = fs.readdirSync(root).filter(f => f.endsWith('.test.js')).sort();

	const ecosystem = JSON.parse(fs.readFileSync(path.join(root, 'ECOSYSTEM.json'), 'utf8'));
	for (const source of ecosystem.sources) {
		if (!source.localPath) continue;
		// Claims are re-verified against the clone when it is present; absent
		// clones are reported as unverifiable HERE, which is not the same as
		// wrong. A claim whose path has vanished from a present clone is.
		source.verification = !fs.existsSync(source.localPath) ? 'clone not present on this machine' :
			source.capabilities.every(cap =>
				cap.paths.every(p => fs.existsSync(path.join(source.localPath, p)))) ?
				'all claim paths verified' : 'CLAIM PATH MISSING — fix ECOSYSTEM.json';
	}

	return {
		commands: Object.keys(run.COMMANDS).sort(),
		runExports: Object.keys(run).filter(k => typeof run[k] === 'function').sort(),
		subcommands: Object.keys(play.SUBCOMMANDS).sort(),
		readOnly: [...play.READ_ONLY].sort(),
		plannerExports: Object.keys(planner).sort(),
		simulateExports: Object.keys(simulate).sort(),
		teamExports: Object.keys(team).sort(),
		profileLayers: ['data', 'mechanics', 'policy', 'encounters', 'oracle', 'provenance']
			.filter(layer => profile[layer]),
		trainerFights: planner.listFights('run-and-bun').fights.length,
		oracleCounts,
		knowledge,
		decisions,
		docs,
		endpoints: endpoints(),
		panels,
		tests,
		ecosystem,
	};
}

function render(inv) {
	const lines = [];
	const push = (...args) => lines.push(...args, '');
	push('# Inventory', '',
		'GENERATED by `node scripts/inventory.js` — do not edit by hand.',
		'`inventory.test.js` fails when this file drifts from the code.');

	push('## Run commands (L6 verbs)', inv.commands.map(c => '`' + c + '`').join(' · '));
	push('## CLI subcommands (`play.js`)',
		inv.subcommands.map(c => '`' + c + '`' + (inv.readOnly.includes(c) ? '' : '*')).join(' · '),
		'', '\\* mutates the save; unmarked are read-only.');
	push('## HTTP endpoints',
		...inv.endpoints.map(e => `- \`${e.method} ${e.path}\``));
	push('## Browser panels',
		...inv.panels.map(p => `- \`#${p.id}\` — ${p.label}`));
	push('## Solver layer exports',
		`- \`run.js\`: ${inv.runExports.map(x => '`' + x + '`').join(', ')}`,
		`- \`planner.js\`: ${inv.plannerExports.map(x => '`' + x + '`').join(', ')}`,
		`- \`simulate.js\`: ${inv.simulateExports.map(x => '`' + x + '`').join(', ')}`,
		`- \`team.js\`: ${inv.teamExports.map(x => '`' + x + '`').join(', ')}`);
	push('## Profile: run-and-bun',
		`Layers declared: ${inv.profileLayers.map(x => '`' + x + '`').join(', ')}`,
		`Trainer fights in the run map: ${inv.trainerFights}`,
		'', 'Oracle datasets:',
		...Object.keys(inv.oracleCounts).map(f => `- \`${f}\`: ${inv.oracleCounts[f]}`));

	push('## Where game knowledge lives (the provenance registry)',
		'Every registered claim, by how it is known. A claim missing from this list',
		'defaults to `inferred` — the weakest tag — and the ratchet test in',
		'`runbun_species.test.js` fails if the verified share ever falls.',
		...['source-of-truth', 'emulator-observed', 'observed', 'transcribed', 'inferred']
			.filter(tag => inv.knowledge[tag])
			.map(tag => `- **${tag}** (${inv.knowledge[tag].length}): ` +
				inv.knowledge[tag].sort().map(k => '`' + k + '`').join(' · ')));
	push('## Standing rulings (from DECISIONS.json)',
		'The law of the tool: each ruling names the files that enforce it, and the',
		'gate fails if an enforcing file disappears. A ruling is changed by a new',
		'ruling, never by quiet drift.',
		...inv.decisions.decisions.map(d =>
			`- **${d.id}** (${d.date}): ${d.ruling}`));

	push('## Open questions (from DECISIONS.json)',
		'Ruled on by nobody yet — each names what would settle it. An answered',
		'question moves up into rulings; it is never silently deleted.',
		...inv.decisions.open.map(q =>
			`- **${q.id}** (${q.raised}): ${q.question} _Settled by: ${q.settledBy}._`));

	push(DOCS_MARKER,
		'Last-touched stamps from git, refreshed whenever the inventory is',
		'regenerated. Advisory, and deliberately BELOW the drift gate\'s waterline:',
		'a stamp changes at the very commit that touches its doc, so gating it',
		'byte-for-byte would demand a follow-up commit forever. An old stamp is',
		'the reader\'s warning to verify before trusting.',
		...inv.docs.map(d => `- \`${d.file}\` — ${d.stamp}`));

	push('## Test files', inv.tests.map(t => '`' + t + '`').join(' · '));

	push('## Prior art elsewhere (from ECOSYSTEM.json)');
	for (const source of inv.ecosystem.sources) {
		push(`### ${source.repo}`,
			source.role,
			`Verification: ${source.verification || source.verifiedAt}`);
		for (const cap of source.capabilities) {
			push(`- **${cap.name}** — ${cap.paths.map(p => '`' + p + '`').join(', ')}` +
				(cap.notes ? `<br>${cap.notes}` : ''));
		}
	}
	return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

const output = render(inventory());
if (process.argv.includes('--print')) {
	process.stdout.write(output);
} else {
	fs.writeFileSync(path.join(root, 'INVENTORY.md'), output);
	console.log(`INVENTORY.md written (${output.length} bytes)`);
}

module.exports = {inventory, render, DOCS_MARKER};
