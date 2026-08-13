/* eslint-env node, es6 */
'use strict';

/**
 * Gate for player teams.
 *
 * The thing being defended here is a correctness hole rather than a parser: a
 * player team used to be a lookup into the trainer table, which put a trainer's
 * build on the player's side of the field and changed the AI's ranking. These
 * cases pin the declared form — that what the player typed is what reaches the
 * BattleState, and that a typo fails loudly instead of producing a plausible
 * plan for a Pokemon that does not exist.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const team = require('./team');

const SWAMPERT = [
	'Swampert @ Leftovers',
	'Ability: Torrent',
	'Level: 45',
	'Adamant Nature',
	'- Earthquake',
	'- Waterfall',
].join('\n');

test('a Showdown paste becomes a player spec', () => {
	const parsed = team.parseTeam(SWAMPERT);
	const party = parsed.party;
	const notes = parsed.notes;
	assert.equal(notes.length, 0);
	assert.deepEqual(party, [{
		species: 'Swampert',
		item: 'Leftovers',
		ability: 'Torrent',
		level: 45,
		nature: 'Adamant',
		ivs: {},
		moves: ['Earthquake', 'Waterfall'],
	}]);
});

test('the header line survives nicknames, gender and items at once', () => {
	const parsed = team.parseTeam('Muddy (Swampert) (M) @ Choice Band\n- Earthquake');
	const party = parsed.party;
	assert.equal(party[0].species, 'Swampert');
	assert.equal(party[0].nickname, 'Muddy');
	assert.equal(party[0].gender, 'M');
	assert.equal(party[0].item, 'Choice Band');
	// A bare species is still the common case and must not be mangled.
	assert.equal(team.parseTeam('Swampert\n- Earthquake').party[0].species, 'Swampert');
	// An item containing a hyphen must not be read as a move line.
	assert.equal(
		team.parseTeam('Porygon2 @ Eviolite\n- Tri Attack').party[0].item,
		'Eviolite'
	);
});

test('IVs are read; EVs are accepted and reported as ignored', () => {
	const parsed = team.parseTeam([
		'Metagross',
		'IVs: 0 Spe / 30 Atk',
		'EVs: 252 Atk / 252 Spe',
		'- Meteor Mash',
	].join('\n'));
	const party = parsed.party;
	const notes = parsed.notes;
	assert.deepEqual(party[0].ivs, {spe: 0, atk: 30});
	// Run & Bun removes EVs. Dropping the line silently would let a player think
	// their competitive spread applied.
	assert.equal(party[0].declaredEvs, undefined);
	assert.ok(notes.some(n => /EVs ignored/.test(n)), `expected an EV note, got ${notes}`);
});

test('a missing level is assumed, and said out loud', () => {
	const parsed = team.parseTeam('Swampert\n- Earthquake');
	const party = parsed.party;
	const notes = parsed.notes;
	assert.equal(party[0].level, 100);
	assert.ok(notes.some(n => /assuming 100/.test(n)));
});

test('a typo fails loudly instead of planning with a Pokemon that does not exist', () => {
	assert.throws(() => team.parseTeam('Swampertt\n- Earthquake'), /unknown species/);
	assert.throws(() => team.parseTeam('Swampert\n- Earthquak'), /unknown move/);
	assert.throws(() => team.parseTeam('Swampert\nAbility: Torrnt\n- Earthquake'), /unknown ability/);
	assert.throws(() => team.parseTeam('Swampert @ Leftover\n- Earthquake'), /unknown item/);
	assert.throws(() => team.parseTeam('Swampert\nAdamnt Nature\n- Earthquake'), /unknown nature/);
	assert.throws(() => team.parseTeam('Swampert\nLevel: 0\n- Earthquake'), /level must be/);
	assert.throws(() => team.parseTeam('Swampert\nIVs: 32 Atk\n- Earthquake'), /IV atk must be/);
	assert.throws(() => team.parseTeam('Swampert\nIVs: 31 Spd Atk\n- Earthquake'), /expected "31 Atk/);
	assert.throws(() => team.parseTeam('Swampert\nIVs: 31 Wat\n- Earthquake'), /unknown stat/);
	assert.throws(() => team.parseTeam('Swampert\nnonsense line\n- Earthquake'), /could not read/);
});

test('structural limits are enforced, not trimmed to fit', () => {
	assert.throws(() => team.parseTeam(''), /empty team/);
	assert.throws(() => team.parseTeam('Swampert'), /at least one move/);
	assert.throws(
		() => team.parseTeam('Swampert\n- Earthquake\n- Waterfall\n- Ice Punch\n- Rock Slide\n- Surf'),
		/more than four moves/
	);
	const seven = Array.from({length: 7}, () => 'Swampert\n- Earthquake').join('\n\n');
	assert.throws(() => team.parseTeam(seven), /a party holds six/);
});

test('a team file may carry a header comment', () => {
	const parsed = team.parseTeam('# what this team is for\nSwampert\n- Earthquake');
	const party = parsed.party;
	assert.equal(party.length, 1);
	assert.equal(party[0].species, 'Swampert');
});

test('a parsed team round-trips back to a paste', () => {
	const parsed = team.parseTeam(SWAMPERT);
	const party = parsed.party;
	const text = team.formatTeam(party);
	assert.match(text, /^Swampert @ Leftovers$/m);
	assert.match(text, /^Ability: Torrent$/m);
	assert.match(text, /^Level: 45$/m);
	assert.match(text, /^Adamant Nature$/m);
	assert.deepEqual(team.parseTeam(text).party, party);
});

test('the shipped example team parses', () => {
	const source = require('node:fs').readFileSync(
		require('node:path').join(__dirname, 'examples', 'team.txt'), 'utf8');
	const parsed = team.parseTeam(source);
	const party = parsed.party;
	assert.equal(party.length, 6, 'the example should show a full party');
	for (const mon of party) {
		assert.ok(mon.moves.length >= 1);
		assert.ok(mon.level >= 1 && mon.level <= 100);
	}
});
