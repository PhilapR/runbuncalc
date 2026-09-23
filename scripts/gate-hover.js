/* eslint-env node, es6 */
'use strict';

/**
 * Put every :hover rule behind `@media (hover: hover)`.
 *
 * On a touch screen `:hover` sticks after a tap: the button you just pressed
 * keeps its hover background and reads as still-selected. This app is
 * responsive down to 640px and is a companion you hold while playing, so
 * that is the common case, not the edge case.
 *
 * This is a one-shot codemod kept in the repo because `ui_style.test.js`
 * enforces the result — the gate needs something to point at when it fails,
 * and "run this" is a better answer than "hand-edit 48 blocks".
 *
 *   node scripts/gate-hover.js --check    # list what is not yet wrapped
 *   node scripts/gate-hover.js --write    # wrap it
 *
 * It counts braces rather than matching a regex. A selector list that mixes
 * hover with something else — in this codebase always `:focus-visible` — is
 * SPLIT rather than wrapped whole: wrapping it would put the keyboard focus
 * ring behind the hover guard and delete it on every touch device, trading a
 * cosmetic bug for an accessibility one.
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
// Every AUTHORED stylesheet. dark-theme.css was missed on the first pass —
// the source gate went green while the dark theme still stuck on touch, and
// only a CSSOM count in a real browser showed it. Vendor sheets
// (css/vendor/**) are deliberately out of scope: they are upstream copies
// and rewriting them would make every future vendor bump a merge conflict.
const FILES = [
	'src/css/main.css',
	'src/css/runbun-shell.css',
	'src/css/dark-theme.css',
	'src/css/runbun-tokens.css',
];
const GUARD = '@media (hover: hover)';

/**
 * Split a stylesheet into top-level chunks, tracking at-rule nesting so a
 * rule inside `@media (max-width: 720px)` is still seen as its own rule.
 */
function rules(css) {
	const found = [];
	let depth = 0;
	let selectorStart = 0;
	for (let index = 0; index < css.length; index += 1) {
		const character = css[index];
		if (character === '{') {
			if (depth === 0) {
				const selector = css.slice(selectorStart, index);
				// An at-rule opens a nested context rather than a rule body.
				const isAtRule = selector.trimStart().startsWith('@');
				const bodyStart = index + 1;
				let inner = 1;
				let scan = bodyStart;
				while (scan < css.length && inner > 0) {
					if (css[scan] === '{') inner += 1;
					if (css[scan] === '}') inner -= 1;
					scan += 1;
				}
				if (isAtRule) {
					// Recurse into the at-rule body, offsetting positions.
					for (const nested of rules(css.slice(bodyStart, scan - 1))) {
						found.push({
							selector: nested.selector,
							start: bodyStart + nested.start,
							end: bodyStart + nested.end,
							insideAtRule: selector.trim(),
						});
					}
				} else {
					found.push({selector, start: selectorStart, end: scan, insideAtRule: null});
				}
				selectorStart = scan;
				index = scan - 1;
			}
		}
	}
	return found;
}

function classify(css) {
	const wrap = [];
	const mixed = [];
	for (const rule of rules(css)) {
		const selectors = rule.selector.split(',').map(part => part.trim()).filter(Boolean);
		if (!selectors.some(part => part.includes(':hover'))) continue;
		// Already guarded by an enclosing @media (hover: ...).
		if (rule.insideAtRule && rule.insideAtRule.includes('hover:')) continue;
		if (selectors.every(part => part.includes(':hover'))) wrap.push(rule);
		else mixed.push({...rule, selectors});
	}
	return {wrap, mixed};
}

/**
 * A selector list that mixes hover with something else — almost always
 * `:focus-visible` — must be SPLIT, never wrapped whole. Wrapping it would
 * put the keyboard focus ring behind `@media (hover: hover)` and delete it
 * on every touch device, trading a cosmetic bug for an accessibility one.
 * The declarations are duplicated, which is exact: an element matching both
 * halves gets the same values either way.
 */
function splitMixed(rule, css) {
	const block = css.slice(rule.start, rule.end);
	const leading = /^\s*/.exec(block)[0];
	const body = block.slice(block.indexOf('{'));
	const hover = rule.selectors.filter(part => part.includes(':hover'));
	const rest = rule.selectors.filter(part => !part.includes(':hover'));
	return `${leading}${rest.join(',\n')} ${body}\n\n` +
		`${GUARD} {\n\t${hover.join(',\n\t')} ${indent(body)}\n}`;
}

/** Indent a rule body one level, leaving its opening brace on the selector line. */
function indent(body) {
	return body.split('\n')
		.map((line, index) => (index && line.trim() ? '\t' + line : line))
		.join('\n');
}

function apply(css) {
	const work = classify(css);
	// Rewrite back-to-front so earlier offsets stay valid.
	const edits = [
		...work.wrap.map(rule => ({rule, split: false})),
		...work.mixed.map(rule => ({rule, split: true})),
	].sort((a, b) => b.rule.start - a.rule.start);
	let out = css;
	for (const edit of edits) {
		const rule = edit.rule;
		let replacement;
		if (edit.split) {
			replacement = splitMixed(rule, css);
		} else {
			const block = css.slice(rule.start, rule.end);
			const leading = /^\s*/.exec(block)[0];
			const body = block.slice(leading.length);
			replacement = `${leading}${GUARD} {\n\t${indent(body)}\n}`;
		}
		out = out.slice(0, rule.start) + replacement + out.slice(rule.end);
	}
	return {css: out, wrapped: work.wrap.length, split: work.mixed.length, mixed: work.mixed};
}

function main() {
	const write = process.argv.includes('--write');
	let outstanding = 0;
	let refused = 0;
	for (const relative of FILES) {
		const file = path.join(root, relative);
		const css = fs.readFileSync(file, 'utf8');
		const result = apply(css);
		outstanding += result.wrapped + result.split;
		refused += result.split;
		if (write && (result.wrapped || result.split)) {
			fs.writeFileSync(file, result.css);
			console.log(`${relative}: wrapped ${result.wrapped}, split ${result.split}`);
		} else if (result.wrapped || result.split) {
			console.log(`${relative}: ${result.wrapped} unguarded :hover rule(s), ` +
				`${result.split} mixed list(s) needing a split`);
			for (const rule of result.mixed) {
				console.log(`    mixed: ${rule.selector.trim().replace(/\s+/g, ' ')}`);
			}
		}
	}
	if (!write) {
		let summary = `\nEvery :hover rule is behind ${GUARD}.`;
		if (outstanding) {
			summary = `\n${outstanding} rule(s) not behind ${GUARD} (${refused} need splitting).`;
		}
		console.log(summary);
		process.exitCode = outstanding ? 1 : 0;
	}
}

if (require.main === module) main();

module.exports = {classify, apply, FILES, GUARD};
