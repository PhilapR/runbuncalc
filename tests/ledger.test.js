/* eslint-env node, es6 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const sqlite = require('node:sqlite');

const ledger = require('../scripts/ledger.js');

const root = path.join(__dirname, '..');

function memoryDb() {
	const db = new sqlite.DatabaseSync(':memory:');
	ledger.load(db);
	return db;
}

test('the ledger loads, and its vocabularies are enforced by the schema', () => {
	const db = memoryDb();
	const counts = db.prepare('SELECT COUNT(*) AS n FROM findings').get();
	assert.ok(counts.n > 0, 'the ledger holds findings');

	// The CHECK constraints are the point: a severity or a status nobody
	// recognises is how a ledger quietly stops being queryable. `list
	// --severity=hgih` returning nothing must mean nothing matches, never
	// that a row was filed under a typo.
	const insert = () => db.prepare(`INSERT INTO findings
		(id, source, raised_on, severity, area, claim, verdict, status)
		VALUES ('x', 's', '2026-01-01', ?, 'a', 'c', ?, ?)`);
	assert.throws(() => insert().run('showstopper', 'confirmed', 'open'),
		/CHECK|constraint/i, 'an unknown severity is refused');
	assert.throws(() => insert().run('high', 'probably', 'open'),
		/CHECK|constraint/i, 'an unknown verdict is refused');
	assert.throws(() => insert().run('high', 'confirmed', 'sorted'),
		/CHECK|constraint/i, 'an unknown status is refused');
});

test('a fix names a commit that exists, and an open finding names none', () => {
	// This is the gate that matters. The defect that cost this branch the most
	// was a commit message claiming an edit that never reached disk — the
	// supersedes wiring in run_history.js. A ledger that records "fixed in
	// abc1234" without checking abc1234 exists reproduces exactly that error
	// at the project level, and reads as progress while being fiction.
	const db = memoryDb();
	const fixed = db.prepare("SELECT id, fixed_in FROM findings WHERE status = 'fixed'").all();
	assert.ok(fixed.length, 'the ledger records at least one fix to check');
	for (const row of fixed) {
		assert.ok(row.fixed_in, `${row.id} is fixed but names no commit`);
		assert.doesNotThrow(
			() => childProcess.execFileSync('git', ['cat-file', '-e', row.fixed_in + '^{commit}'],
				{cwd: root, stdio: 'ignore'}),
			`${row.id} names commit ${row.fixed_in}, which is not in this repository`);
	}
	for (const row of db.prepare("SELECT id, fixed_in FROM findings WHERE status = 'open'").all()) {
		assert.equal(row.fixed_in, null, `${row.id} is open but names a fixing commit`);
	}
});

test('every finding points at a file that is really there', () => {
	// A finding whose path has moved is worse than no finding: it sends the
	// next reader to a file that cannot show the defect, and they conclude it
	// was already fixed.
	const db = memoryDb();
	const rows = db.prepare('SELECT id, file FROM findings WHERE file IS NOT NULL').all();
	assert.ok(rows.length, 'findings carry file paths');
	for (const row of rows) {
		assert.ok(fs.existsSync(path.join(root, row.file)),
			`${row.id} points at ${row.file}, which does not exist`);
	}
});

test('a fix is only called falsified when the guard was made to fail', () => {
	// Not a claim that every fix IS falsified — several honestly are not, and
	// `ledger.js stats` reports that count on purpose. What this pins is that
	// the flag cannot be set on a finding that records no fix at all, which
	// would let "falsified" drift into meaning "we feel good about it".
	const db = memoryDb();
	for (const row of db.prepare('SELECT id, status, falsified FROM findings').all()) {
		if (row.falsified) {
			assert.equal(row.status, 'fixed',
				`${row.id} is marked falsified but is not fixed`);
		}
	}
});

test('the emitted D1 SQL rebuilds the same ledger, byte for byte in row terms', () => {
	// The deployed surface must answer from identical data. Emitting SQL that
	// silently drops or mangles a row would give the worker a different
	// ledger from the one in git, and the git one is the record.
	const emitted = childProcess.execFileSync(process.execPath,
		[path.join(root, 'scripts', 'ledger.js'), 'sql'], {cwd: root, encoding: 'utf8'});
	const rebuilt = new sqlite.DatabaseSync(':memory:');
	rebuilt.exec(emitted);

	const direct = memoryDb();
	for (const table of ['decisions', 'open_questions', 'findings']) {
		assert.deepEqual(
			rebuilt.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
			direct.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
			`${table} must survive the round trip through D1 SQL`);
	}
});
