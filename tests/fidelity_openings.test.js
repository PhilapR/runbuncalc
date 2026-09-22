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
const engine = require('../ai');
const getProfile = require('../profiles').getProfile;

const WEATHER = {drought: 'Sun', drizzle: 'Rain', sandstream: 'Sand', snowwarning: 'Hail',
	primordialsea: 'Heavy Rain', desolateland: 'Harsh Sunshine', deltastream: 'Strong Winds'};
const TERRAIN = {electricsurge: 'Electric', grassysurge: 'Grassy', psychicsurge: 'Psychic', mistysurge: 'Misty'};
const id = name => String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The weather an opening leaves, worked from the Gen 8 rule rather than read
 * off the engine: lead entry abilities fire fastest first, so each setter
 * overwrites the last, except that an ordinary setter cannot replace a strong
 * weather. Returns null on a speed tie between setters (the order is a draw).
 * Speeds are read with the opening's own weather and Speed stages removed —
 * the order is decided before any lead's entry fires.
 */
function openingWeather(ai, state, weatherOf) {
	const actives = ['player', 'ai'].flatMap(side => state.sides[side].activeIds.map(pid =>
		state.sides[side].party.find(mon => mon.id === pid)));
	const setters = actives.filter(mon => mon.hp.current > 0 && weatherOf(mon));
	const before = Object.assign({}, state, {field: Object.assign({}, state.field, {weather: undefined}),
		sides: Object.fromEntries(['player', 'ai'].map(side => [side, Object.assign({}, state.sides[side], {
			party: state.sides[side].party.map(mon => Object.assign({}, mon,
				{boosts: Object.assign({}, mon.boosts, {spe: 0})})),
		})]))});
	const speeds = setters.map(mon => ai.getEffectivePokemonSpeed(before, mon.id));
	if (new Set(speeds).size !== speeds.length) return null;
	const strong = new Set(['Heavy Rain', 'Harsh Sunshine', 'Strong Winds']);
	return setters.map((mon, i) => ({weather: weatherOf(mon), speed: speeds[i]}))
		.sort((a, b) => b.speed - a.speed)
		.reduce((sky, next) => (!strong.has(sky) || strong.has(next.weather) ? next.weather : sky), undefined);
}

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
			// Not "any lead's weather": the one the Gen 8 order leaves standing.
			const want = openingWeather(engine, state, mon => WEATHER[id(mon.ability)]);
			if (want !== null && state.field.weather !== want) wrong.push(fight.trainer + ': weather ' + state.field.weather + ', the opening leaves ' + want);
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

// ---------------------------------------------------------------------------
// The rest of what happens as a battle opens or a Pokémon enters.
//
// Run & Bun's own rule for everything below: "For any mechanic that's not
// described in here, assume Generation 8 mechanics" (the hack's Mechanic
// Changes.txt, pokemon-mono docs/official). None of these is described there,
// so each is Generation 8's.
// ---------------------------------------------------------------------------

const ai = require('../ai');
const calc = require('../calc');

const SAVED = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'banked-runs',
	'clear1-418957-sidney.run.json'), 'utf8'));
const FIGHTS = planner.listFights(SAVED.profileId).fights;

/** The banked box's party with these bodies in front, as the planner gets it. */
function ledBy(...speciesNames) {
	const ids = speciesNames.map(name => {
		const mon = SAVED.box.find(entry => entry.species === name);
		assert.ok(mon, name + ' is in the banked box');
		return mon.id;
	});
	return runtime.partySpecs(Object.assign({}, SAVED,
		{party: ids.concat(SAVED.party.filter(entry => ids.indexOf(entry) === -1)).slice(0, 6)}), {});
}

function open(fight, specs) {
	return planner.buildFightState({trainer: fight.trainer, playerParty: specs,
		profileId: SAVED.profileId, doubles: fight.isDouble}).state;
}

const activesOf = (state, side) => state.sides[side].activeIds.map(pid =>
	state.sides[side].party.find(mon => mon.id === pid));
const stage = (mon, stat) => (mon.boosts || {})[stat] || 0;

// Gen 8 Intimidate: Inner Focus, Oblivious, Own Tempo and Scrappy joined the
// Clear Body family in blocking it (Sword/Shield), and Rattled gained a Speed
// stage from it.
const INTIMIDATE_BLOCKERS = new Set(['clearbody', 'hypercutter', 'whitesmoke', 'fullmetalbody',
	'innerfocus', 'oblivious', 'owntempo', 'scrappy']);

/**
 * What `intimidators` Intimidates do to one foe, worked forward from the
 * Gen 8 rules independently of the engine: each is blocked, or drops Attack
 * (Contrary raises it, Simple doubles it), then Defiant, Competitive and
 * Rattled answer the drop and a White Herb clears it once.
 */
function afterIntimidate(mon, intimidators, grassGuarded) {
	const ability = id(mon.ability);
	const boosts = {atk: 0, spa: 0, spe: 0};
	// The herb as the fight began: a spent one is only in lastConsumedItem.
	let herb = id(mon.item) === 'whiteherb' || id(mon.lastConsumedItem) === 'whiteherb';
	for (let i = 0; i < intimidators; i++) {
		if (INTIMIDATE_BLOCKERS.has(ability) || grassGuarded) continue;
		if (ability === 'mirrorarmor') continue;
		boosts.atk += ability === 'contrary' ? 1 : ability === 'simple' ? -2 : -1;
		if (ability === 'defiant') boosts.atk += 2;
		if (ability === 'competitive') boosts.spa += 2;
		if (ability === 'rattled') boosts.spe += 1;
		if (herb && (boosts.atk < 0 || boosts.spa < 0 || boosts.spe < 0)) {
			for (const stat of Object.keys(boosts)) if (boosts[stat] < 0) boosts[stat] = 0;
			herb = false;
		}
	}
	return {boosts, herb};
}

const isGrass = (state, mon) => ai.getEffectiveTypes(state, mon.id).includes('Grass');

test('where two weather setters lead, the slower setter\'s weather stands', () => {
	// No fight on the road leads two foe setters, so our lead brings the
	// second: a slow Torkoal (Drought) that should outlast most foes, and a
	// fast Politoed (Drizzle) that should be outlasted. Each opening is
	// checked against the Gen 8 order worked out independently.
	const bench = runtime.partySpecs(SAVED, {});
	const leads = [
		{species: 'Torkoal', ability: 'Drought', level: 5, moves: ['Ember']},
		{species: 'Politoed', ability: 'Drizzle', level: 100, nature: 'Timid', moves: ['Surf']},
	];
	const checked = {ours: 0, theirs: 0, blocked: 0, ties: 0};
	const wrong = [];
	for (const lead of leads) {
		for (const fight of FIGHTS) {
			const state = open(fight, [lead].concat(bench).slice(0, 6));
			const theirs = activesOf(state, 'ai').filter(mon => WEATHER[id(mon.ability)]);
			if (!theirs.length || theirs.every(mon => WEATHER[id(mon.ability)] === WEATHER[id(lead.ability)])) continue;
			const want = openingWeather(ai, state, mon => WEATHER[id(mon.ability)]);
			if (want === null) {
				checked.ties += 1;
				continue;
			}
			const ourSpeed = ai.getEffectivePokemonSpeed(state, 'player-1');
			const slowest = theirs.every(mon => ai.getEffectivePokemonSpeed(state, mon.id) > ourSpeed);
			if (want === WEATHER[id(lead.ability)]) checked.ours += 1;
			else if (slowest) checked.blocked += 1;
			else checked.theirs += 1;
			if (state.field.weather !== want) {
				wrong.push(fight.trainer + ': our ' + lead.species + ' vs ' + theirs.map(mon => mon.species) +
					': weather ' + state.field.weather + ', the slower setter leaves ' + want);
			}
		}
	}
	if (process.env.SHOW_COUNTS) console.log(JSON.stringify(checked));
	assert.deepEqual(wrong, [], wrong.length + ' two-setter openings wrong');
	assert.ok(checked.ours >= 5, 'openings where our slower setter\'s weather stands: ' + checked.ours);
	assert.ok(checked.theirs >= 5, 'openings where their slower setter\'s weather stands: ' + checked.theirs);
});

test('our Intimidate lead meets their leads as Gen 8 does: blockers, reactors, White Herb', () => {
	const checked = {blocked: 0, dropped: 0, defiant: 0, competitive: 0, rattled: 0, whiteHerb: 0, fights: 0};
	const wrong = [];
	// Two Intimidate bodies from the banked box, so a doubles lead meets both.
	const specs = ledBy('Arcanine', 'Staraptor');
	for (const fight of FIGHTS) {
		const state = open(fight, specs);
		const ours = activesOf(state, 'player');
		const intimidators = ours.filter(mon => id(mon.ability) === 'intimidate').length;
		assert.ok(intimidators >= 1);
		checked.fights += 1;
		const theirs = activesOf(state, 'ai');
		for (const mon of theirs) {
			const ability = id(mon.ability);
			// Download's own raise depends on our leads' defences; its sweep is above.
			if (ability === 'download') continue;
			const guarded = theirs.some(ally => id(ally.ability) === 'flowerveil') && isGrass(state, mon);
			const want = afterIntimidate(mon, intimidators, guarded);
			const got = {atk: stage(mon, 'atk'), spa: stage(mon, 'spa'), spe: stage(mon, 'spe')};
			if (JSON.stringify(got) !== JSON.stringify(want.boosts)) {
				wrong.push(fight.trainer + ': ' + mon.species + ' (' + mon.ability + ', ' + mon.item + ') ' +
					JSON.stringify(got) + ' under ' + intimidators + ' Intimidate; Gen 8 gives ' + JSON.stringify(want.boosts));
			}
			if (id(mon.item) === 'whiteherb' || id(mon.lastConsumedItem) === 'whiteherb') {
				checked.whiteHerb += 1;
				const kept = id(mon.item) === 'whiteherb';
				if (kept !== want.herb) wrong.push(fight.trainer + ': ' + mon.species + ' White Herb ' + (kept ? 'kept' : 'spent'));
			}
			if (INTIMIDATE_BLOCKERS.has(ability)) checked.blocked += 1;
			else if (ability === 'defiant') checked.defiant += 1;
			else if (ability === 'competitive') checked.competitive += 1;
			else if (ability === 'rattled') checked.rattled += 1;
			else checked.dropped += 1;
		}
	}
	if (process.env.SHOW_COUNTS) console.log(JSON.stringify(checked));
	assert.deepEqual(wrong, [], wrong.length + ' foe leads meet our Intimidate wrong');
	// 2026-09-22 with Arcanine and Staraptor leading: 43 blocked, 5 Defiant,
	// 3 Competitive, 2 Rattled, 5 White Herb, 375 plain drops.
	assert.ok(checked.fights >= 360, 'fights opened: ' + checked.fights);
	assert.ok(checked.blocked >= 40, 'blocking leads checked: ' + checked.blocked);
	assert.ok(checked.defiant >= 4, 'Defiant leads checked: ' + checked.defiant);
	assert.ok(checked.competitive >= 2, 'Competitive leads checked: ' + checked.competitive);
	assert.ok(checked.rattled >= 2, 'Rattled leads checked: ' + checked.rattled);
	assert.ok(checked.whiteHerb >= 4, 'White Herb leads checked: ' + checked.whiteHerb);
	assert.ok(checked.dropped >= 300, 'plain drops checked: ' + checked.dropped);
});

test('their Intimidate meets our blockers as Gen 8 does', () => {
	// Real sets from the banked box, each leading in turn.
	const bodies = {Metagross: 'clearbody', Crawdaunt: 'hypercutter', Weavile: 'innerfocus', Mamoswine: 'oblivious'};
	const checked = {};
	const wrong = [];
	for (const [species, ability] of Object.entries(bodies)) {
		const specs = ledBy(species);
		assert.equal(id(specs[0].ability), ability, species + ' carries ' + ability);
		checked[ability] = 0;
		for (const fight of FIGHTS) {
			const state = open(fight, specs);
			if (!activesOf(state, 'ai').some(mon => id(mon.ability) === 'intimidate')) continue;
			const lead = activesOf(state, 'player').find(mon => mon.species === species);
			checked[ability] += 1;
			if (stage(lead, 'atk') !== 0) wrong.push(fight.trainer + ': our ' + species + ' (' + ability + ') Attack ' + stage(lead, 'atk'));
		}
	}
	if (process.env.SHOW_COUNTS) console.log(JSON.stringify(checked));
	assert.deepEqual(wrong, [], wrong.length + ' of our blockers were Intimidated');
	for (const [ability, count] of Object.entries(checked)) {
		assert.ok(count >= 15, ability + ' openings under Intimidate checked: ' + count);
	}
});

test('a lead holding its Mega Stone or orb opens as its Mega or Primal form, with that form\'s ability', () => {
	const dex = calc.Generations.get(8).species;
	const checked = {ai: 0, player: 0};
	const wrong = [];
	// Our Houndoom holds Houndoominite, so it leads as the run's one Mega.
	const specs = ledBy('Houndoom');
	for (const fight of FIGHTS) {
		const state = open(fight, specs);
		for (const side of ['ai', 'player']) {
			for (const mon of activesOf(state, side)) {
				const item = String(mon.item || '');
				const base = (calc.MEGA_STONES || {})[item];
				const primal = {'Blue Orb': 'Kyogre-Primal', 'Red Orb': 'Groudon-Primal'}[item];
				if (!base && !primal) continue;
				checked[side] += 1;
				const form = dex.get(id(mon.species));
				const isForm = primal ? mon.species === primal : /-Mega(-[XY])?$/.test(mon.species) &&
					mon.species.indexOf(base) === 0;
				if (!isForm || !form) {
					wrong.push(fight.trainer + ': ' + side + ' ' + mon.species + ' holds ' + item + ' and opens unevolved');
					continue;
				}
				if (id(mon.ability) !== id(form.abilities[0])) {
					wrong.push(fight.trainer + ': ' + mon.species + ' carries ' + mon.ability + ', the form has ' + form.abilities[0]);
				}
			}
		}
	}
	if (process.env.SHOW_COUNTS) console.log(JSON.stringify(checked));
	assert.deepEqual(wrong, [], wrong.length + ' stone-holding leads open wrong');
	// 2026-09-22: 12 foe leads hold a stone or orb; our Houndoom holds its stone.
	assert.ok(checked.ai >= 11, 'foe stone leads checked: ' + checked.ai);
	assert.ok(checked.player >= 300, 'our Mega lead checked: ' + checked.player);
});

const TERRAIN_SEED = {electricseed: ['Electric', 'def'], grassyseed: ['Grassy', 'def'],
	mistyseed: ['Misty', 'spd'], psychicseed: ['Psychic', 'spd']};
const STRONG = new Set(['Heavy Rain', 'Harsh Sunshine', 'Strong Winds']);
const STRONG_HOLDER = {'Heavy Rain': 'primordialsea', 'Harsh Sunshine': 'desolateland', 'Strong Winds': 'deltastream'};

test('every foe that can enter mid-fight enters as the game has it: weather, terrain, Intimidate, Download, Trace, seeds', () => {
	// Each fight opened, then each of the foe's bench bodies switched in for
	// its first lead through the engine's own switch — the composed path a
	// replacement takes in play, not a hand-built entry.
	const checked = {entries: 0, weather: 0, blockedByStrong: 0, strongEnded: 0, terrain: 0, intimidate: 0,
		download: 0, trace: 0, seed: 0, imposter: 0, balloon: 0};
	const wrong = [];
	const specs = runtime.partySpecs(SAVED, {});
	for (const fight of FIGHTS) {
		const state = open(fight, specs);
		const outgoing = state.sides.ai.activeIds[0];
		const outMon = state.sides.ai.party.find(mon => mon.id === outgoing);
		const bench = state.sides.ai.party.filter(mon =>
			state.sides.ai.activeIds.indexOf(mon.id) === -1 && mon.hp.current > 0);
		for (const mon of bench) {
			const next = ai.applyAction(state, {kind: 'switch', actorId: outgoing, replacementId: mon.id});
			checked.entries += 1;
			const tag = fight.trainer + ': ' + mon.species + ' (' + mon.ability + ', ' + mon.item + ')';
			const entered = next.sides.ai.party.find(entry => entry.id === mon.id);
			const ability = id(mon.ability);
			const before = state.field.weather;
			// Does anyone left standing still hold the strong weather?
			const standing = next.sides.ai.activeIds.concat(next.sides.player.activeIds).map(pid =>
				next.sides.ai.party.concat(next.sides.player.party).find(entry => entry.id === pid));
			const strongHeld = STRONG.has(before) &&
				standing.some(entry => id(entry.ability) === STRONG_HOLDER[before]);
			if (STRONG.has(before) && id(outMon.ability) === STRONG_HOLDER[before] && !strongHeld) {
				checked.strongEnded += 1;
				if (next.field.weather === before) wrong.push(tag + ': ' + before + ' outlived its holder switching out');
			}
			if (WEATHER[ability]) {
				const blocked = strongHeld && !STRONG.has(WEATHER[ability]);
				if (blocked) {
					checked.blockedByStrong += 1;
					if (next.field.weather !== before) wrong.push(tag + ': set ' + next.field.weather + ' through ' + before);
				} else {
					checked.weather += 1;
					if (next.field.weather !== WEATHER[ability]) wrong.push(tag + ': weather ' + next.field.weather);
					if (next.field.durations && next.field.durations.weather) wrong.push(tag + ': ability weather is timed');
				}
			}
			if (TERRAIN[ability]) {
				checked.terrain += 1;
				if (next.field.terrain !== TERRAIN[ability]) wrong.push(tag + ': terrain ' + next.field.terrain);
				if (next.field.durations && next.field.durations.terrain) wrong.push(tag + ': ability terrain is timed');
			}
			if (ability === 'intimidate') {
				checked.intimidate += 1;
				for (const foe of activesOf(state, 'player')) {
					const after = next.sides.player.party.find(entry => entry.id === foe.id);
					const guarded = activesOf(state, 'player').some(ally => id(ally.ability) === 'flowerveil') && isGrass(state, foe);
					const want = afterIntimidate(foe, 1, guarded).boosts;
					for (const stat of Object.keys(want)) {
						const moved = stage(after, stat) - stage(foe, stat);
						if (moved !== want[stat]) wrong.push(tag + ': our ' + foe.species + ' ' + stat + ' moved ' + moved + ', Gen 8 gives ' + want[stat]);
					}
				}
			}
			if (ability === 'download') {
				checked.download += 1;
				const raised = stage(entered, 'atk') + stage(entered, 'spa') - stage(mon, 'atk') - stage(mon, 'spa');
				if (raised !== 1) wrong.push(tag + ': Download raised ' + raised);
			}
			if (ability === 'trace') {
				checked.trace += 1;
				const copies = activesOf(state, 'player').map(foe => id(foe.ability));
				if (copies.indexOf(id(entered.abilityOverride)) === -1) {
					wrong.push(tag + ': traced ' + entered.abilityOverride + ', ours are ' + copies);
				}
			}
			if (ability === 'imposter') {
				checked.imposter += 1;
				const target = activesOf(state, 'player')[0];
				if (entered.speciesOverride !== target.species) wrong.push(tag + ': transformed into ' + entered.speciesOverride);
			}
			const seed = TERRAIN_SEED[id(mon.item)];
			if (seed && next.field.terrain === seed[0]) {
				checked.seed += 1;
				if (entered.item || stage(entered, seed[1]) - stage(mon, seed[1]) !== 1) {
					wrong.push(tag + ': seed in ' + seed[0] + ' Terrain left ' + entered.item + ', ' + seed[1] + ' ' + stage(entered, seed[1]));
				}
			}
			if (id(mon.item) === 'airballoon') {
				checked.balloon += 1;
				if (id(entered.item) !== 'airballoon' || ai.isGrounded(next, mon.id)) wrong.push(tag + ': balloon lost or grounded on entry');
			}
		}
	}
	if (process.env.SHOW_COUNTS) console.log(JSON.stringify(checked));
	assert.deepEqual(wrong, [], wrong.length + ' entries wrong');
	// 2026-09-22: 1197 entries — 5 weather, 5 terrain, 43 Intimidate, 4
	// Download, 1 Trace, 3 Imposter, 11 seeds, 6 balloons, and Primal Kyogre
	// switched out 5 times — floored so a sweep that stops seeing them fails.
	assert.ok(checked.entries >= 1100, 'bench entries checked: ' + checked.entries);
	assert.ok(checked.weather >= 5, 'entry weather checked: ' + checked.weather);
	assert.ok(checked.terrain >= 3, 'entry terrain checked: ' + checked.terrain);
	assert.ok(checked.intimidate >= 35, 'entry Intimidate checked: ' + checked.intimidate);
	assert.ok(checked.download >= 3, 'entry Download checked: ' + checked.download);
	assert.ok(checked.trace >= 1, 'entry Trace checked: ' + checked.trace);
	assert.ok(checked.imposter >= 2, 'entry Imposter checked: ' + checked.imposter);
	assert.ok(checked.seed >= 8, 'terrain seeds checked: ' + checked.seed);
	assert.ok(checked.balloon >= 5, 'Air Balloon entries checked: ' + checked.balloon);
	assert.ok(checked.strongEnded >= 1, 'strong weather holders switched out: ' + checked.strongEnded);
});

test('in a played fight, Primal Kyogre\'s heavy rain stands while it does and ends when it falls', () => {
	// The composed pipeline: the battle driver opens Champion Wallace and plays
	// real turns, so the rain is set by the opening and ended by a faint that
	// the engine resolved — no hand-built state. Our six are Electric and Grass
	// bodies from the banked box; the policy is plain (first super-effective-
	// looking move), and seeds are fixed so the fight replays.
	const driver = require('../lib/battle-driver');
	const by = species => SAVED.box.find(mon => mon.species === species).id;
	const doc = runtime.apply(SAVED, {kind: 'party',
		ids: ['Lanturn', 'Raichu', 'Ampharos', 'Victreebel', 'Eldegoss', 'Seismitoad'].map(by)});
	const counted = {rainTurns: 0, falls: 0};
	const wrong = [];
	for (let seed = 1; seed <= 12; seed++) {
		const opened = driver.start(doc, 'Champion Wallace', seed);
		let battle = opened.battle;
		let actions = opened.actions;
		const kyogreId = battle.state.sides.ai.activeIds[0];
		const kyogre = () => battle.state.sides.ai.party.find(mon => mon.id === kyogreId);
		assert.equal(kyogre().species, 'Kyogre-Primal');
		if (battle.state.field.weather !== 'Heavy Rain') wrong.push('seed ' + seed + ': opened in ' + battle.state.field.weather);
		for (let turn = 0; turn < 40; turn++) {
			const pick = actions.find(entry => entry.kind === 'move' &&
				/Thunder|Volt|Discharge|Zap|Leaf|Solar|Giant|Energy|Grass|Wild/.test(entry.move)) ||
				actions.find(entry => entry.kind === 'move') || actions[0];
			const reply = driver.act(battle, pick.kind === 'move' ? {kind: 'move', move: pick.move} :
				{kind: 'switch', replacementId: pick.action.replacementId});
			battle = reply.battle;
			actions = reply.actions;
			if (kyogre().hp.current > 0) {
				counted.rainTurns += 1;
				if (battle.state.field.weather !== 'Heavy Rain') wrong.push('seed ' + seed + ' turn ' + turn + ': ' + battle.state.field.weather + ' with Kyogre standing');
			} else {
				counted.falls += 1;
				// Wallace's bench has no weather setter, and the fight declares none.
				if (battle.state.field.weather !== undefined) wrong.push('seed ' + seed + ': ' + battle.state.field.weather + ' after Kyogre fell');
				break;
			}
			if (reply.result) break;
		}
	}
	if (process.env.SHOW_COUNTS) console.log(JSON.stringify(counted));
	assert.deepEqual(wrong, []);
	// 2026-09-22: Kyogre fell in 3 of seeds 1-10 (seeds 4, 6, 9).
	assert.ok(counted.falls >= 2, 'played Kyogre faints: ' + counted.falls);
	assert.ok(counted.rainTurns >= 20, 'turns played under Kyogre\'s rain: ' + counted.rainTurns);
});

test('a strong weather whose holder leaves or falls blocks nothing: Primal Kyogre out, Drizzle Pelipper in is rain', () => {
	// Gen 8: Primordial Sea's rain ends the moment its holder leaves the field
	// (Showdown clears it on the holder's End event, before the replacement
	// enters), so the replacement's Drizzle meets a clear sky and sets rain.
	// Two defects composed here: the entry judged the setter against the
	// pre-switch weather and blocked it, and a holder that fainted to a
	// residual left its heavy rain standing into the next turn.
	const party = [
		{species: 'Kyogre-Primal', item: 'Blue Orb', ability: 'Primordial Sea', level: 70, moves: ['Surf'],
			hpRatio: 0.05, status: 'psn'},
		{species: 'Pelipper', ability: 'Drizzle', level: 70, moves: ['Surf']},
	];
	const opened = planner.buildFightState({trainer: 'Youngster Allen', playerParty: party,
		profileId: SAVED.profileId}).state;
	assert.ok(activesOf(opened, 'ai').every(mon => !WEATHER[id(mon.ability)]), 'their lead sets no weather');
	assert.equal(opened.field.weather, 'Heavy Rain', 'our Primal Kyogre opens the heavy rain');

	// Switched out for Pelipper on one action.
	const switched = ai.applyAction(opened, {kind: 'switch', actorId: 'player-1', replacementId: 'player-2'});
	assert.equal(switched.field.weather, 'Rain', 'Drizzle sets rain as Kyogre leaves');

	// Fainted to poison at the end of the turn, then replaced.
	const residual = ai.advanceTurn(opened, {random: () => 0.5});
	assert.equal(residual.sides.player.party[0].hp.current, 0, 'poison felled Kyogre');
	assert.equal(residual.field.weather, undefined, 'the heavy rain fell with its holder');
	const replaced = ai.applyAction(residual, {kind: 'switch', actorId: 'player-1', replacementId: 'player-2', forced: true});
	assert.equal(replaced.field.weather, 'Rain', 'Drizzle sets rain behind the fallen Kyogre');
});
