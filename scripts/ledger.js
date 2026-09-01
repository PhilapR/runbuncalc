/* eslint-env node, es6 */
'use strict';

/**
 * The project ledger: query rulings, open questions and review findings.
 *
 * This exists because four independent reviews produced ~50 findings that
 * lived only in a session transcript and in commit messages. Neither can be
 * asked "which HIGH findings are still open, and which fixes were never
 * falsified?" — which is the question that actually governs what to do next.
 *
 * The files under ledger/ and DECISIONS.json stay the system of record: a
 * record that cannot be read in a diff cannot be reviewed. This script loads
 * them into SQLite so they can be queried, and emits the same rows as SQL for
 * Cloudflare D1 so the deployed surface answers from identical data.
 *
 *   node scripts/ledger.js build          # (re)build ledger/ledger.db
 *   node scripts/ledger.js list           # open findings, worst first
 *   node scripts/ledger.js list --all     # including fixed
 *   node scripts/ledger.js list --severity=high --area=engine
 *   node scripts/ledger.js stats          # counts by status and severity
 *   node scripts/ledger.js decisions      # the standing rulings
 *   node scripts/ledger.js open           # the unsettled questions
 *   node scripts/ledger.js query "SELECT ..."
 *   node scripts/ledger.js sql            # emit D1 import SQL on stdout
 *
 * The local database is derived and gitignored. `build` drops and reloads
 * rather than merging: an incremental sync would let the database and the
 * files disagree, and then neither is the record.
 */

const fs = require('fs');
const path = require('path');
const sqlite = require('node:sqlite');

const root = path.join(__dirname, '..');
const ledgerDirectory = path.join(root, 'ledger');
const databasePath = path.join(ledgerDirectory, 'ledger.db');
const schemaPath = path.join(ledgerDirectory, 'schema.sql');

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'warning'];

function readJson(file) {
	return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Every row the ledger holds, read from the files that are the record. */
function sources() {
	const decisions = readJson(path.join(root, 'DECISIONS.json'));
	const findings = readJson(path.join(ledgerDirectory, 'findings.json'));
	return {
		decisions: decisions.decisions || [],
		open: decisions.open || [],
		findings: findings.findings || [],
	};
}

function load(db) {
	db.exec(fs.readFileSync(schemaPath, 'utf8'));
	const data = sources();

	const decision = db.prepare(
		'INSERT INTO decisions (id, decided_on, ruling, why, enforced_by) VALUES (?, ?, ?, ?, ?)');
	for (const row of data.decisions) {
		decision.run(row.id, row.date, row.ruling, row.why || null,
			JSON.stringify(row.enforcedBy || []));
	}

	const question = db.prepare(
		'INSERT INTO open_questions (id, question, raised_on, settled_by) VALUES (?, ?, ?, ?)');
	for (const row of data.open) {
		question.run(row.id, row.question, row.raised || null, row.settledBy || null);
	}

	const finding = db.prepare(`INSERT INTO findings
		(id, source, raised_on, severity, area, file, line, claim, verdict, status, fixed_in, falsified, evidence)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
	for (const row of data.findings) {
		finding.run(row.id, row.source, row.raised_on, row.severity, row.area,
			row.file || null, row.line === undefined ? null : row.line, row.claim,
			row.verdict, row.status, row.fixed_in || null,
			row.falsified ? 1 : 0, row.evidence || null);
	}

	return {
		decisions: data.decisions.length,
		open: data.open.length,
		findings: data.findings.length,
	};
}

function build() {
	fs.rmSync(databasePath, {force: true});
	const db = new sqlite.DatabaseSync(databasePath);
	const counts = load(db);
	db.close();
	return counts;
}

/** Open the derived database, building it first if it is missing or stale. */
function open() {
	const inputs = [schemaPath, path.join(root, 'DECISIONS.json'),
		path.join(ledgerDirectory, 'findings.json')];
	const stale = !fs.existsSync(databasePath) ||
		inputs.some(file => fs.statSync(file).mtimeMs > fs.statSync(databasePath).mtimeMs);
	if (stale) build();
	return new sqlite.DatabaseSync(databasePath);
}

function parseFlags(argv) {
	const flags = {};
	for (const argument of argv) {
		const match = /^--([^=]+)(?:=(.*))?$/.exec(argument);
		if (match) flags[match[1]] = match[2] === undefined ? true : match[2];
	}
	return flags;
}

const SEVERITY_MARKS = {critical: 'CRIT', high: 'HIGH', medium: 'MED ', low: 'LOW ', warning: 'WARN'};

function severityMark(severity) {
	return SEVERITY_MARKS[severity] || severity.toUpperCase();
}

function listFindings(flags) {
	const db = open();
	const where = [];
	const parameters = [];
	if (!flags.all) where.push("status = 'open'");
	if (flags.severity) { where.push('severity = ?'); parameters.push(flags.severity); }
	if (flags.area) { where.push('area = ?'); parameters.push(flags.area); }
	if (flags.source) { where.push('source = ?'); parameters.push(flags.source); }
	if (flags.status) { where.push('status = ?'); parameters.push(flags.status); }

	const rows = db.prepare(`SELECT * FROM findings
		${where.length ? 'WHERE ' + where.join(' AND ') : ''}
		ORDER BY CASE severity ${SEVERITY_ORDER.map((s, i) => `WHEN '${s}' THEN ${i}`).join(' ')} END,
			CASE verdict WHEN 'confirmed' THEN 0 ELSE 1 END, id`).all(...parameters);

	if (!rows.length) {
		console.log('No findings match.');
		return;
	}
	for (const row of rows) {
		const site = row.file ? `${row.file}${row.line ? ':' + row.line : ''}` : row.area;
		const proof = row.falsified ? ' (falsified)' : ' (NOT falsified)';
		const state = row.status === 'fixed' ? `fixed ${row.fixed_in}${proof}` : row.verdict;
		console.log(`${severityMark(row.severity)}  ${row.id}`);
		console.log(`      ${site}  —  ${state}  —  ${row.source}`);
		console.log(`      ${row.claim}`);
		if (flags.evidence && row.evidence) console.log(`      evidence: ${row.evidence}`);
		console.log('');
	}
	console.log(`${rows.length} finding${rows.length === 1 ? '' : 's'}.`);
}

function stats() {
	const db = open();
	console.log('Findings by status and severity');
	for (const row of db.prepare(`SELECT status, severity, COUNT(*) AS n FROM findings
		GROUP BY status, severity
		ORDER BY status, CASE severity ${SEVERITY_ORDER.map((s, i) => `WHEN '${s}' THEN ${i}`).join(' ')} END`).all()) {
		console.log(`  ${row.status.padEnd(8)} ${severityMark(row.severity)}  ${row.n}`);
	}
	// The number that matters: a fix nobody proved is load-bearing.
	const unproven = db.prepare(
		"SELECT COUNT(*) AS n FROM findings WHERE status = 'fixed' AND falsified = 0").get().n;
	console.log(`\nFixed but never falsified: ${unproven}`);
	const unverified = db.prepare(
		"SELECT COUNT(*) AS n FROM findings WHERE status = 'open' AND verdict = 'reported'").get().n;
	console.log(`Open and not yet reproduced here: ${unverified}`);
	console.log(`\nRulings: ${db.prepare('SELECT COUNT(*) AS n FROM decisions').get().n}`);
	console.log(`Open questions: ${db.prepare('SELECT COUNT(*) AS n FROM open_questions').get().n}`);
}

function decisions() {
	const db = open();
	for (const row of db.prepare('SELECT * FROM decisions ORDER BY decided_on, id').all()) {
		console.log(`${row.decided_on}  ${row.id}`);
		console.log(`   ${row.ruling}`);
		if (row.why) console.log(`   why: ${row.why}`);
		const enforced = JSON.parse(row.enforced_by);
		if (enforced.length) console.log(`   enforced by: ${enforced.join(', ')}`);
		console.log('');
	}
}

function openQuestions() {
	const db = open();
	for (const row of db.prepare('SELECT * FROM open_questions ORDER BY raised_on, id').all()) {
		console.log(`${row.raised_on || '(undated)'}  ${row.id}`);
		console.log(`   ${row.question}`);
		if (row.settled_by) console.log(`   settled by: ${row.settled_by}`);
		console.log('');
	}
}

function query(sql) {
	if (!sql) throw new Error('query needs a SQL statement');
	console.log(JSON.stringify(open().prepare(sql).all(), null, 2));
}

function quote(value) {
	if (value === null || value === undefined) return 'NULL';
	if (typeof value === 'number') return String(value);
	return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * The same rows as SQL, for `wrangler d1 execute`. Emitting rather than
 * pushing keeps this script offline and keeps the deploy an explicit act.
 */
function sql() {
	const data = sources();
	const out = [fs.readFileSync(schemaPath, 'utf8')];
	for (const row of data.decisions) {
		out.push(`INSERT INTO decisions (id, decided_on, ruling, why, enforced_by) VALUES (${
			[row.id, row.date, row.ruling, row.why || null, JSON.stringify(row.enforcedBy || [])]
				.map(quote).join(', ')});`);
	}
	for (const row of data.open) {
		out.push(`INSERT INTO open_questions (id, question, raised_on, settled_by) VALUES (${
			[row.id, row.question, row.raised || null, row.settledBy || null]
				.map(quote).join(', ')});`);
	}
	for (const row of data.findings) {
		out.push(`INSERT INTO findings (id, source, raised_on, severity, area, file, line, claim, verdict, status, fixed_in, falsified, evidence) VALUES (${
			[row.id, row.source, row.raised_on, row.severity, row.area, row.file || null,
				row.line === undefined ? null : row.line, row.claim, row.verdict, row.status,
				row.fixed_in || null, row.falsified ? 1 : 0, row.evidence || null]
				.map(quote).join(', ')});`);
	}
	console.log(out.join('\n'));
}

const COMMANDS = {
	build: () => {
		const counts = build();
		console.log(`Built ${path.relative(root, databasePath)}: ` +
			`${counts.decisions} rulings, ${counts.open} open questions, ${counts.findings} findings.`);
	},
	list: argv => listFindings(parseFlags(argv)),
	stats,
	decisions,
	open: openQuestions,
	query: argv => query(argv[0]),
	sql,
};

function main(argv) {
	const command = argv[0] || 'list';
	const run = COMMANDS[command];
	if (!run) {
		console.error(`Unknown command '${command}'. Try: ${Object.keys(COMMANDS).join(', ')}`);
		process.exit(1);
	}
	run(argv.slice(1));
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {build, load, sources, databasePath};
