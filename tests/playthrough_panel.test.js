/* eslint-env node, es6 */
'use strict';

/**
 * Gates for the parts of scripts/ui-playthrough.js that drive the panel.
 *
 * They run against a fake panel, not a browser: the page functions the driver
 * passes to `page.evaluate` run here against a small `document` and
 * `window.localStorage`, and a scripted server answers each button. That is
 * enough to ask the questions these gates ask — what the driver does when the
 * server REFUSES a command — without Chromium. The server's answer is the
 * panel's contract: a refusal leaves the save as it was and puts the reason
 * on the status line; an accepted command changes the save.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const policy = require('../scripts/ui-playthrough.js');

/**
 * A fake panel. `answer(button, state)` returns {ok, status} for a pressed
 * button; ok changes the save. `options` fills the replace select.
 */
function fakePanel(answer, extra) {
	const state = Object.assign({run: 'save-0', status: '', inputs: {}, pressed: [],
		upcoming: [], options: []}, extra || {});
	const button = selector => ({
		click() {
			state.pressed.push({selector, inputs: Object.assign({}, state.inputs)});
			const reply = answer(selector, state);
			if (reply.ok) state.run = 'save-' + state.pressed.length;
			state.status = reply.status;
		},
	});
	const beat = name => Object.assign(button('beat ' + name), {
		getAttribute: attribute => attribute === 'data-trainer' ? name : null,
	});
	const document = {
		querySelector(selector) {
			if (selector === '#runbun-run-status') return {textContent: state.status};
			if (selector === '#runbun-run-upcoming .runbun-run-up-beat') {
				return state.upcoming.length ? beat(state.upcoming[0]) : null;
			}
			const trainer = /\.runbun-run-up-beat\[data-trainer="(.*)"\]$/.exec(selector);
			if (trainer) return state.upcoming.includes(trainer[1]) ? beat(trainer[1]) : null;
			if (/^#runbun-run-(teach|evolve)$/.test(selector)) return button(selector);
			return null;
		},
	};
	const window = {localStorage: {getItem: key => key === 'runbun.run.v1' ? state.run : null}};
	const inPage = (fn, arg) => {
		const saved = [global.document, global.window];
		global.document = document;
		global.window = window;
		try {
			return fn(arg);
		} finally {
			global.document = saved[0];
			global.window = saved[1];
		}
	};
	const page = {
		evaluate: async (fn, arg) => inPage(fn, arg),
		// Checked once: a false predicate is the timeout, without the wait.
		waitForFunction: async (fn, arg) => {
			if (!inPage(fn, arg)) throw new Error('timeout (fake)');
		},
		waitForTimeout: async () => {},
		fill: async (selector, value) => { state.inputs[selector] = value; },
		selectOption: async (selector, value) => { state.inputs[selector] = value; },
		$$eval: async (selector, fn) => fn(selector === '#runbun-run-replace option' ?
			state.options.map(value => ({value})) : []),
	};
	return {page, state};
}

/** The journal entries written since `from`. */
function since(from) {
	return policy.journal().slice(from);
}

test('markBeaten calls a refused mark a refusal, not a beaten fight', async () => {
	// act() ends in an object literal, so `clicked ? next : null` was always
	// next: a refused mark logged "beaten unfought" for a fight never marked,
	// and the anti-loop guard in the caller could not fire.
	const refused = fakePanel(() => ({ok: false, status: 'Camper Gavi is not next on the route'}),
		{upcoming: ['Camper Gavi']});
	const from = policy.journal().length;
	assert.equal(await policy.markBeaten(refused.page), null, 'a refusal is not a mark');
	assert.equal(refused.state.pressed.length, 1, 'the button was pressed');
	assert.ok(since(from).some(entry => /Camper Gavi refused — Camper Gavi is not next/.test(entry.message)),
		'the refusal is noted with its reason');

	const accepted = fakePanel(() => ({ok: true, status: 'Marked Camper Gavi beaten'}),
		{upcoming: ['Camper Gavi']});
	assert.equal(await policy.markBeaten(accepted.page), 'Camper Gavi');

	const none = fakePanel(() => ({ok: true, status: ''}));
	assert.equal(await policy.markBeaten(none.page), null, 'no button, no mark');
});

test('a refused TM teach and a refused evolve are journalled with the panel\'s reason', async () => {
	// 9,700 refusal entries across 350 playthroughs carried only the network
	// hook's constant string. The reason was on the status line the whole
	// time; these two sites read it and dropped it.
	const refusing = fakePanel(selector => ({ok: false,
		status: selector === '#runbun-run-teach' ? 'Drain Punch is an egg move and the bag holds no Heart Scale' :
			'Machoke evolves by trade, which this run has not allowed'}));
	const from = policy.journal().length;
	const taught = await policy.assumeTeach(refusing.page, 'Makuhita', 'Drain Punch', 'Tackle');
	assert.equal(taught.changed, false);
	assert.deepEqual(refusing.state.pressed[0].inputs,
		{'#runbun-run-move': 'Drain Punch', '#runbun-run-replace': 'Tackle'}, 'the teach names its move and slot');
	const evolved = await policy.pressEvolve(refusing.page, 'Machoke');
	assert.equal(evolved.changed, false);
	const said = since(from).map(entry => entry.kind + ': ' + entry.message);
	assert.ok(said.includes('tm: Makuhita could not learn Drain Punch — Drain Punch is an egg move and the bag holds no Heart Scale'), said.join('\n'));
	assert.ok(said.includes('evolve: Machoke did not evolve — Machoke evolves by trade, which this run has not allowed'), said.join('\n'));

	const accepting = fakePanel(() => ({ok: true, status: 'Machoke evolved into Machamp'}));
	const before = policy.journal().length;
	assert.equal((await policy.assumeTeach(accepting.page, 'Makuhita', 'Drain Punch', '')).changed, true);
	assert.equal((await policy.pressEvolve(accepting.page, 'Machoke')).changed, true);
	assert.deepEqual(since(before).map(entry => entry.message), ['Machoke — Machoke evolved into Machamp'],
		'an accepted teach is noted by the caller, an accepted evolve here');
});

test('a level-up teach replaces the move pickReplace chooses, not the first in the select', async () => {
	// pickReplace is gated in playthrough_policy.test.js, but nothing there
	// sees teachPending, so reverting its call to options[0] — the Spheal
	// "Charm over Ice Ball" churn — passed every gate.
	const panel = fakePanel(() => ({ok: true, status: 'Marill learned Ice Beam'}),
		{options: ['Charm', 'Bubble Beam', 'Water Gun', 'Growl']});
	const from = policy.journal().length;
	await policy.teachPending(panel.page, {species: 'Marill'},
		'Marill reached L30, so Ice Beam must be taught over something');
	assert.equal(panel.state.pressed.length, 1);
	assert.deepEqual(panel.state.pressed[0].inputs,
		{'#runbun-run-move': 'Ice Beam', '#runbun-run-replace': 'Water Gun'},
		'the weakest attack goes, not the first-listed Charm');
	assert.ok(since(from).some(entry => entry.message === 'Marill learned Ice Beam over Water Gun'));
});
