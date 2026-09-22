/* eslint-env node, es6 */
'use strict';

/**
 * The decomp import against the author's own learnset document.
 *
 * learnsets.json has 498 species with an empty level-up list, eight of them on
 * wild tables (Geodude, Goldeen, Sunkern, Wooper, Quagsire, Pineco, Shuckle,
 * Smeargle). import-oracle.js could store a zero-move parse without complaint,
 * so an empty list the author wrote and one a parse lost looked the same, and
 * the decomp is not on this machine to re-check
 * (ledger: eight-catchable-species-have-no-level-up-movepool).
 *
 * The author's "Learnset, Evolution Methods and Abilities.txt" is a second,
 * independent statement of the same lists, transcribed verbatim into
 * learnset-doc.json by scripts/build-learnset-doc.js. It has a block for each
 * species he kept and none for a species he removed. So the two questions
 * have answers from his own words:
 *
 *   - every list he documents is the list the decomp import carries, and
 *   - every empty list in the import is a species he does not document.
 *
 * A lost parse would be a documented species with an empty import. There are
 * none.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const builder = require('../scripts/build-learnset-doc.js');
const doc = require('../profiles/run-and-bun/oracle/learnset-doc.json');
const levelUp = require('../profiles/run-and-bun/oracle/learnsets.json').levelUp;
const unavailable = require('../profiles/run-and-bun/oracle/unavailable.json');

const norm = name => String(name).toLowerCase().replace(/[^a-z0-9]/g, '');

/** The document writes a regional form as one word: "GeodudeAlolan". */
const REGIONS = {Alolan: 'Alola', Galarian: 'Galar', Hisuian: 'Hisui'};
/** The one species name the suffix rule does not reach. */
const NAMES = {UrshifuRapidStrikeStyle: 'Urshifu-Rapid-Strike'};
/** Move spellings beyond spaces and hyphens: the document's older one. */
const MOVES = {vicegrip: 'visegrip'};

const byNorm = {};
for (const species of Object.keys(levelUp)) byNorm[norm(species)] = species;

function importName(docName) {
	if (NAMES[docName]) return NAMES[docName];
	const regional = docName.match(/^(.+)(Alolan|Galarian|Hisuian)$/);
	const name = regional ? `${regional[1]}-${REGIONS[regional[2]]}` : docName;
	return byNorm[norm(name)];
}

const moveKey = move => MOVES[norm(move)] || norm(move);
const listKey = list => list.map(entry => `${entry[0]}:${moveKey(entry[1])}`).join(',');

test('every learnset the author documents is the one the decomp import carries', () => {
	const names = Object.keys(doc.species);
	assert.equal(names.length, doc.count);
	assert.ok(names.length > 500, `the transcription holds ${names.length} species`);

	const unjoined = names.filter(name => !importName(name));
	assert.deepEqual(unjoined, [], 'these documented species have no row in learnsets.json');

	const differ = names.filter(name => listKey(doc.species[name]) !== listKey(levelUp[importName(name)]));
	assert.deepEqual(differ, [], 'the document and the decomp import disagree on these level-up lists');
});

test('every empty level-up list is a species the author does not document', () => {
	const documented = new Set(Object.keys(doc.species).map(importName));
	const lost = Object.keys(levelUp).filter(species => !levelUp[species].length && documented.has(species));
	assert.deepEqual(lost, [], 'the author lists moves for these and the import has none: a lost parse');
});

test('the eight wild-table species with no movepool are ones the author removed', () => {
	const eight = ['Geodude', 'Goldeen', 'Sunkern', 'Wooper', 'Quagsire', 'Pineco', 'Shuckle', 'Smeargle'];
	const documented = new Set(Object.keys(doc.species).map(importName));
	const removed = new Set();
	for (const generation of Object.values(unavailable.generations)) {
		for (const species of generation.species || []) removed.add(species);
	}
	for (const species of eight) {
		assert.deepEqual(levelUp[species], [], `${species} has an empty level-up list in the import`);
		assert.ok(!documented.has(species), `${species} has no block in the author's learnset document`);
		assert.ok(removed.has(species), `${species} is on the author's Unavailable Pokemon sheet`);
	}
	// Geodude-Alola is the one the game keeps, and the document lists it.
	assert.ok(documented.has('Geodude-Alola'));
	assert.ok(levelUp['Geodude-Alola'].length);
});

test('the transcription refuses a block it cannot read', () => {
	const good = builder.parse('Bulbasaur\r\nLv.  1     Tackle\r\nLv. 14     Stun Spore\r\nAbility 1: Overgrow\r\n\r\n');
	assert.deepEqual(good.problems, []);
	assert.deepEqual(good.species, {Bulbasaur: [[1, 'Tackle'], [14, 'Stun Spore']]});

	assert.throws(() => builder.build('Bulbasaur\nAbility 1: Overgrow\n'), /no level-up line/);
	assert.throws(() => builder.build('Bulbasaur\nLv. 1 Tackle\n\nBulbasaur\nLv. 1 Growl\n'), /two blocks/);
});
