/* eslint-env node, es6 */
'use strict';

/**
 * A won fight can be told again, turn by turn — or it is refused.
 *
 * The ledger keeps a row per attempt and the run throws the fight away. The
 * operator asked for "more insight into how we solved previous runs", and the
 * wall report could not give it: it reads a fight as one-on-ones, and fights
 * are won by control. scripts/how-it-won.js replays the winning attempt on
 * the document as the run walked up to it, with the attempt's own seed and
 * hand. What it must never do is tell a line nobody played.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const headless = require('../scripts/headless-run.js');
const how = require('../scripts/how-it-won.js');

test('the winning attempt replays to the ledger\'s own result, and is told', () => {
	const policy = require('../scripts/ui-playthrough.js');
	const row = headless.playRun(policy, {species: 'Chimchar', rival: 'Blaziken'}, 104770,
		headless.armFlags('--budget=3 --probe=0'), {keepDoc: true});
	const won = row.ledger.find(fight => fight.result === 'win');
	assert.ok(won, 'the opening fights are won');
	const text = how.tell(row, won.trainer);
	assert.doesNotMatch(text, /REFUSING/, text.slice(0, 400));
	assert.match(text, new RegExp('Won in ' + won.turns + ' turns'), 'the replay is the fight the ledger recorded');
	assert.match(text, /Led with \*\*/);
	assert.match(text, /## Turn by turn\n- T\d+ /);
	assert.match(text, /## Bodies given up/);

	// The same fight on another seed is another fight, and must not be told
	// as this one.
	const moved = Object.assign({}, row, {ledger: row.ledger.map(fight =>
		fight === won ? Object.assign({}, fight, {turns: fight.turns + 7}) : fight)});
	assert.match(how.tell(moved, won.trainer), /REFUSING to tell it/);
	assert.throws(() => how.tell(row, 'Champion Wallace'), /never fought Champion Wallace/);
});

test('control is read off the turns: pivots, sacks, set-up, priority, dice', () => {
	const made = how.controlOf([
		{turn: 1, us: 'Bewear L65', foe: 'Mienshao L65', foeHp: 100, chose: 'switch to Ursaluna', why: 'searched',
			events: ['Ursaluna was sent out.', 'Foe Mienshao used Fake Out. (10% to Ursaluna)']},
		{turn: 2, us: 'Ursaluna L65', foe: 'Mienshao L65', foeHp: 100, chose: 'Swords Dance', why: 'searched', events: []},
		{turn: 3, us: 'Ursaluna L65', foe: 'Mienshao L65', foeHp: 41, chose: 'Earthquake', why: 'searched',
			events: ['Foe Mienshao used Close Combat. A critical hit! (95% to Ursaluna)', 'Ursaluna fainted!']},
		{turn: 3, us: 'Ursaluna L65', foe: 'Mienshao L65', foeHp: 41, chose: 'switch to Lycanroc-Dusk', why: 'forced replacement', events: []},
		{turn: 4, us: 'Lycanroc-Dusk L65', foe: 'Mienshao L65', foeHp: 41, chose: 'Accelerock', why: 'searched',
			events: ['Lycanroc-Dusk used Accelerock. (41% to Mienshao)']},
	]);
	assert.equal(made.lead, 'Bewear L65');
	assert.deepEqual(made.order, ['Bewear', 'Ursaluna', 'Lycanroc-Dusk']);
	assert.equal(made.pivots.length, 1, 'a forced replacement is not a pivot');
	assert.match(made.pivots[0], /Bewear out for Ursaluna in front of Mienshao/);
	assert.equal(made.setups.length, 1);
	assert.equal(made.given.length, 1);
	assert.equal(made.priority.length, 1);
	assert.deepEqual(made.crits, {ours: 0, theirs: 1});
});
