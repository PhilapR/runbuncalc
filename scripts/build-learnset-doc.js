#!/usr/bin/env node
/* eslint-env node, es6 */
'use strict';

/**
 * Transcribe the level-up lists from the author's own learnset document.
 *
 *   node scripts/build-learnset-doc.js [path/to/Learnset, Evolution Methods and Abilities.txt]
 *
 * learnsets.json comes from the decomp through import-oracle.js, and 498 of
 * its 1114 species have an empty level-up list. The decomp is not on this
 * machine, and the importer had a path that stores a zero-move parse without
 * complaint, so from inside the repository an empty list the author wrote and
 * an empty list a parse lost looked the same
 * (ledger: eight-catchable-species-have-no-level-up-movepool).
 *
 * The author published a second, independent statement of the same data:
 * "Learnset, Evolution Methods and Abilities.txt" in the Run & Bun 1.07
 * documentation dump (pokemon-mono docs/official/). It lists one block per
 * species he kept — a name line, then "Lv. N  Move" lines — and no block at
 * all for a species he removed. This file pins those lists, verbatim, so a
 * test can hold the decomp import against them.
 *
 * Verbatim means the document's own spellings: "GeodudeAlolan", "Vice Grip",
 * "X Scissor". Joining them to calculator names is the reader's job, not the
 * transcription's. Abilities and evolution lines are in the same blocks and
 * are not transcribed here; nothing reads them yet.
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_DOC = path.join(process.env.HOME || '', 'Projects', 'pokemon-mono', 'docs', 'official',
	'Learnset, Evolution Methods and Abilities.txt');
const OUT = path.join(__dirname, '..', 'profiles', 'run-and-bun', 'oracle', 'learnset-doc.json');

/**
 * Blocks are separated by blank lines. A block's first line is the species;
 * its "Lv." lines are the level-up list in the document's order. A block with
 * no "Lv." line is not a learnset and is refused, not dropped.
 */
function parse(text) {
	const species = {};
	const problems = [];
	const blocks = text.replace(/\r/g, '').split(/\n\s*\n/).map(block => block.trim()).filter(Boolean);
	for (const block of blocks) {
		const lines = block.split('\n').map(line => line.trim());
		const name = lines[0];
		const moves = [];
		for (const line of lines.slice(1)) {
			if (!/^Lv\./.test(line)) continue;
			const match = line.match(/^Lv\.\s*(\d+)\s+(\S.*)$/);
			if (!match) {
				problems.push(`${name}: unreadable line ${JSON.stringify(line)}`);
				continue;
			}
			moves.push([Number(match[1]), match[2].trim()]);
		}
		if (!moves.length) problems.push(`${name}: a block with no level-up line`);
		else if (species[name]) problems.push(`${name}: two blocks`);
		else species[name] = moves;
	}
	return {species, problems};
}

function build(text) {
	const parsed = parse(text);
	if (parsed.problems.length) {
		throw new Error(`the document did not parse cleanly:\n  ${parsed.problems.join('\n  ')}`);
	}
	return {
		schemaVersion: 'runbun.learnset.doc/1.0.0',
		source: 'pokemon-mono docs/official/Learnset, Evolution Methods and Abilities.txt ' +
			'(Run & Bun 1.07 documentation dump, the author\'s own)',
		provenance: 'transcribed',
		note: 'Level-up lists only, verbatim: species names and move spellings are the ' +
			'document\'s. A species the author removed has no block. Built by ' +
			'scripts/build-learnset-doc.js; do not edit by hand.',
		count: Object.keys(parsed.species).length,
		species: parsed.species,
	};
}

/** One species per line: diffable, and a third of the size of indent 1. */
function serialise(doc) {
	const head = Object.assign({}, doc);
	delete head.species;
	const lines = Object.keys(doc.species).map(name =>
		`\t\t${JSON.stringify(name)}: ${JSON.stringify(doc.species[name])}`);
	const top = JSON.stringify(head, null, '\t').replace(/\n}$/, '');
	return `${top},\n\t"species": {\n${lines.join(',\n')}\n\t}\n}\n`;
}

function main() {
	const source = process.argv[2] || DEFAULT_DOC;
	const doc = build(fs.readFileSync(source, 'utf8'));
	fs.writeFileSync(OUT, serialise(doc));
	console.log(`learnset-doc.json: ${doc.count} species from ${source}`);
}

if (require.main === module) {
	try {
		main();
	} catch (error) {
		console.error(`build-learnset-doc: ${error.message}`);
		process.exitCode = 1;
	}
}

module.exports = {parse, build, serialise};
