/* eslint-env node, es6 */
'use strict';

/**
 * Gate that a finding recorded as FIXED has not come back.
 *
 * The ledger is a record, and nothing re-read it. Two failures on one day, in
 * opposite directions: rank-enumerates-every-six-with-no-bound sat open for
 * three days saying "nothing gates it" after the gate had landed, and
 * provider-cannot-resolve-42-percent-of-the-run-map already held a diagnosis
 * that was re-derived from scratch by someone who did not look — and the second
 * finding raised from that work contradicted the first and was wrong.
 *
 * scripts/recheck-findings.js re-derives the number each machine-checkable
 * claim leans on. This runs the half of it that is a failure rather than a
 * note: a finding marked fixed whose defect reproduces again is a regression,
 * and the ledger says it is not there.
 *
 * The other half — an OPEN finding that no longer reproduces — is reported by
 * the script and deliberately NOT a failure here. A probe measures one number
 * and a claim usually says more, so closing a finding stays a reading job.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const findings = require('../ledger/findings.json');
const recheck = require('../scripts/recheck-findings.js');

test('every fixed finding with a probe stays fixed', () => {
	const regressions = [];
	for (const finding of findings.findings) {
		const entry = recheck.PROBES[finding.id];
		if (!entry || finding.status !== 'fixed') continue;
		const result = entry.probe();
		assert.notEqual(result.reproduces, null,
			finding.id + ': the probe could not run — ' + result.detail);
		if (result.reproduces) regressions.push(finding.id + ' (' + result.detail + ')');
	}
	assert.deepEqual(regressions, [], regressions.length ?
		'recorded as fixed and reproducing again: ' + regressions.join('; ') : '');
});

test('every probe runs, so a broken probe cannot read as a clean result', () => {
	// A probe that throws returns reproduces:null, and null is falsy — so a
	// broken probe would quietly look like "no longer reproduces" and invite
	// someone to close a live finding. Two of the five threw on their first
	// run: one reached for a module that lives in the browser bundle rather
	// than lib, the other treated encountersOn as a list when it answers an
	// object. Both would have passed a check that only looked for regressions.
	const broken = [];
	for (const id of Object.keys(recheck.PROBES)) {
		const result = recheck.PROBES[id].probe();
		if (result.reproduces === null) broken.push(id + ': ' + result.detail);
		assert.ok(typeof result.detail === 'string' && result.detail.length,
			id + ' must report what it measured, not just a verdict');
	}
	assert.deepEqual(broken, [], broken.length ?
		'probes that could not run: ' + broken.join('; ') : '');
});

test('a probe is attached to a finding that exists', () => {
	// A renamed or removed finding would leave a probe measuring something
	// nothing claims, which reads as coverage and is not.
	const ids = new Set(findings.findings.map(finding => finding.id));
	const orphans = Object.keys(recheck.PROBES).filter(id => !ids.has(id));
	assert.deepEqual(orphans, [], orphans.length ?
		'probes with no finding: ' + orphans.join(', ') : '');
});
