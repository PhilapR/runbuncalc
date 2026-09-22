/* eslint-env node, es6 */
'use strict';

/**
 * Every fight on the road, opened, and checked against what the game does as
 * a battle begins.
 *
 * Until 8cc3ece no lead's entry ability had ever fired: a battle state is
 * built with its leads standing, and entry effects ran only on a switch. So
 * Drizzle Kyogre opened in a dry sky, Primal Kyogre too, no Intimidate lead
 * ever cut an Attack, and — found by this sweep — Download was not modelled
 * at all. Every tally before that commit was measured on an easier game, and
 * nothing would have said so: each fight's own tests fed the engine a state
 * that was already right.
 *
 * So this opens all of them, the way a run does, and counts what it checked:
 * a sweep that checked nothing would pass.
 *
 * The rules asserted are Run & Bun's, not a mainline game's: weather and
 * terrain from an ability are PERMANENT (docs/AI_DATA_MODEL.md).
 */
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const planner = require('../lib/planner');
const runtime = require('../lib/run.js');
const getProfile = require('../profiles').getProfile;

const WEATHER = {drought: 'Sun', drizzle: 'Rain', sandstream: 'Sand', snowwarning: 'Hail',
	primordialsea: 'Heavy Rain', desolateland: 'Harsh Sunshine', deltastream: 'Strong Winds'};
const TERRAIN = {electricsurge: 'Electric', grassysurge: 'Grassy', psychicsurge: 'Psychic', mistysurge: 'Misty'};
const id = name => String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');

test('every fight opens as the game opens it: weather, terrain, Intimidate, Download', () => {
	const saved = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'banked-runs',
		'clear1-418957-sidney.run.json'), 'utf8'));
	const specs = runtime.partySpecs(saved, {});
	const profile = getProfile(saved.profileId);
	const checked = {weather: 0, terrain: 0, intimidate: 0, download: 0, still: 0};
	const wrong = [];
	for (const fight of planner.listFights(saved.profileId).fights) {
		const state = planner.buildFightState({trainer: fight.trainer, playerParty: specs,
			profileId: saved.profileId, doubles: fight.isDouble}).state;
		const actives = side => state.sides[side].activeIds.map(pid => state.sides[side].party.find(mon => mon.id === pid));
		const ours = actives('player');
		const theirs = actives('ai');
		// Our leads carry no entry ability of their own, so every effect here is theirs.
		for (const mon of ours) assert.ok(!WEATHER[id(mon.ability)] && !TERRAIN[id(mon.ability)] && id(mon.ability) !== 'intimidate');

		const weathers = theirs.map(mon => WEATHER[id(mon.ability)]).filter(Boolean);
		const terrains = theirs.map(mon => TERRAIN[id(mon.ability)]).filter(Boolean);
		const declared = (profile.oracle.fightFieldOf && profile.oracle.fightFieldOf(fight.trainer)) || {};
		if (weathers.length) {
			checked.weather += 1;
			if (!weathers.includes(state.field.weather)) wrong.push(fight.trainer + ': weather ' + state.field.weather + ', a lead sets ' + weathers);
			if (state.field.durations && state.field.durations.weather) wrong.push(fight.trainer + ': ability weather is timed, and Run & Bun makes it permanent');
		} else if (state.field.weather !== declared.weather) {
			wrong.push(fight.trainer + ': weather ' + state.field.weather + ' with no setter; the fight declares ' + declared.weather);
		}
		if (terrains.length) {
			checked.terrain += 1;
			if (!terrains.includes(state.field.terrain)) wrong.push(fight.trainer + ': terrain ' + state.field.terrain + ', a lead sets ' + terrains);
		}
		const intimidators = theirs.filter(mon => id(mon.ability) === 'intimidate').length;
		if (intimidators) {
			checked.intimidate += 1;
			for (const mon of ours) {
				const atk = (mon.boosts || {}).atk || 0;
				if (atk !== -intimidators) wrong.push(fight.trainer + ': ' + mon.species + ' Attack ' + atk + ' under ' + intimidators + ' Intimidate');
			}
		} else {
			checked.still += 1;
			for (const mon of ours) if ((mon.boosts || {}).atk) wrong.push(fight.trainer + ': ' + mon.species + ' Attack moved with no Intimidate');
		}
		for (const mon of theirs.filter(entry => id(entry.ability) === 'download')) {
			checked.download += 1;
			const raised = ((mon.boosts || {}).atk || 0) + ((mon.boosts || {}).spa || 0);
			if (raised !== 1) wrong.push(fight.trainer + ': Download raised ' + raised + ' stages');
		}
	}
	if (process.env.SHOW_COUNTS) console.log(JSON.stringify(checked));
	assert.deepEqual(wrong, [], wrong.length + ' fights open wrong');
	// Floors under the counts from the road as it stands (2026-09-22: 25
	// weather, 15 terrain, 22 Intimidate, 4 Download openings), so a sweep
	// that stopped seeing them fails rather than passing on nothing.
	assert.ok(checked.weather >= 20, 'weather openings checked: ' + checked.weather);
	assert.ok(checked.terrain >= 10, 'terrain openings checked: ' + checked.terrain);
	assert.ok(checked.intimidate >= 15, 'Intimidate openings checked: ' + checked.intimidate);
	assert.ok(checked.download >= 3, 'Download openings checked: ' + checked.download);
	assert.ok(checked.still >= 200, 'fights with no Intimidate checked: ' + checked.still);
});
