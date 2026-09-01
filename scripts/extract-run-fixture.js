/* eslint-env node, es6 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const shelf = path.join(root, 'fixtures', 'banked-runs');
const MANIFEST = path.join(shelf, 'MANIFEST.json');

/**
 * Bank a run document out of a report, into the tree.
 *
 * `ui-playthrough-out/` is gitignored, and five tests read banked reports
 * out of it directly. On this machine they pass; in CI they had never once
 * run — five ENOENTs on every workflow since the fixtures were adopted, a
 * red PR nobody could make green locally because locally the files are
 * there. A test that can only pass on one laptop is the same species as a
 * test no script names: it gates nothing and reports that it does.
 *
 * The reports are 1.4-1.9MB and every one of those tests reads only
 * `report.run`, so the shelf carries the run document alone — a fifth of
 * the bytes, all of the evidence those tests use. This is not a
 * constructed box: it is the same banked document, byte for byte, and the
 * manifest names the report it came from so the extraction can be redone.
 *
 *   node scripts/extract-run-fixture.js ui-playthrough-out/report-X.json
 */

function shelveOne(reportPath) {
	const relative = path.relative(root, path.resolve(root, reportPath));
	const report = JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
	if (!report.run) throw new Error(`${relative} carries no run document`);
	const name = path.basename(relative, '.json').replace(/^report-/, '') + '.run.json';
	const body = JSON.stringify(report.run, null, '\t') + '\n';
	fs.mkdirSync(shelf, {recursive: true});
	fs.writeFileSync(path.join(shelf, name), body);
	return {
		file: name,
		source: relative,
		position: report.run.position,
		orderScale: report.run.orderScale || null,
		box: (report.run.box || []).length,
		sha256: crypto.createHash('sha256').update(body).digest('hex'),
	};
}

function main() {
	const reports = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
	if (!reports.length) {
		console.error('need at least one ui-playthrough-out/report-*.json');
		process.exit(1);
	}
	const manifest = fs.existsSync(MANIFEST) ?
		JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : {runs: []};
	for (const report of reports) {
		const entry = shelveOne(report);
		const at = manifest.runs.findIndex(row => row.file === entry.file);
		// Re-extraction is idempotent by design: the source report is
		// immutable archive, so a changed hash means the report changed and
		// the reader should know which claim moved.
		if (at !== -1) {
			if (manifest.runs[at].sha256 !== entry.sha256) {
				console.log(`${entry.file}: hash moved ${manifest.runs[at].sha256.slice(0, 12)} -> ` +
					entry.sha256.slice(0, 12));
			}
			manifest.runs[at] = Object.assign({}, manifest.runs[at], entry);
		} else {
			manifest.runs.push(entry);
		}
		console.log(`banked ${entry.file} (#${entry.position}, box ${entry.box})`);
	}
	manifest.runs.sort((a, b) => a.file.localeCompare(b.file));
	fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, '\t') + '\n');
}

if (require.main === module) main();

module.exports = {shelveOne};
