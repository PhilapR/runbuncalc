/* eslint-env node, es6 */
'use strict';

/** The one scoring rule for the permadeath bars: paired by seed, ties out, a one-sided sign test. */
const assert = require('node:assert/strict');
const test = require('node:test');

const nuz = require('../scripts/nuz-compare.js');

const side = won => ({won, lost: won, audit: true});

test('the sign test and the rule: ties are left out, a voided seed is not paired', () => {
	assert.equal(nuz.signTest(11, 12).toFixed(4), '0.0032');
	assert.equal(nuz.signTest(8, 9).toFixed(4), '0.0195');
	const control = {a: side(10), b: side(10), c: side(10), d: side(10), e: side(10), f: side(10), g: side(10)};
	const treatment = {a: side(12), b: side(11), c: side(13), d: side(12), e: side(14), f: side(10), g: Object.assign(side(20), {audit: false})};
	const result = nuz.compare(control, treatment);
	assert.equal(result.paired, 6);
	assert.equal(result.voided, 1, 'a failed audit voids its seed');
	assert.equal(result.tied, 1);
	assert.equal(result.better, 5);
	assert.equal(result.p.toFixed(4), nuz.signTest(5, 5).toFixed(4), 'the tie is left out of the test');
	assert.ok(result.p < 0.05);
});
