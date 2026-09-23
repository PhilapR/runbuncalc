/* eslint-env node, es6 */
'use strict';

/**
 * Gate for how the run models a Mega Evolution.
 *
 * Neither engine performs the evolution. Grep both sides for megaEvolve,
 * megaStone, canMegaEvo or Mega Evolution and nothing comes back, so the
 * starting state in the data IS the whole fight. The two sides then chose
 * opposite states: the planning engine keeps the base form holding its stone,
 * and this run keeps the evolved form holding it.
 *
 * Ours is the better approximation and it is closer to right than a first
 * reading suggests. Mega Evolution resolves BEFORE any move, so the evolved
 * Pokemon's Speed is what orders turn one — the pre-applied form gives the
 * correct Speed from the very first turn, including for the Megas that are
 * slower than their base form.
 *
 * What the pre-applied form does get wrong is narrower and is about a
 * DECISION, not a stat: on the turn it evolves, the enemy chooses its move as
 * the base form, because the choice is made before the evolution resolves. It
 * then executes that move with the evolved stats and ability. Modelling the
 * Mega from the start means the enemy's turn-one CHOICE is computed from a
 * Pokemon it does not yet know it is.
 *
 * These tests pin the representation and the shape of what it costs, so a
 * later reader can see the trade rather than rediscover it.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const planner = require('../lib/planner');
const Calc = require('../calc');

const GEN = Calc.Generations.get(8);
const TRAINER_IVS = {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31};
const NO_EVS = {hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0};

function speed(species, level, nature) {
	return new Calc.Pokemon(GEN, species, {
		level: level, nature: nature || 'Hardy', ivs: TRAINER_IVS, evs: NO_EVS,
	}).stats.spe;
}

function isMega(species) {
	return /-Mega|-Primal/.test(species);
}

function baseFormOf(species) {
	return species.replace(/-(Mega|Primal).*$/, '');
}

test('every Mega in the run map is stored evolved, holding the stone that evolves it', () => {
	// The representation, pinned. A base form holding a stone would be the
	// engine's shape and would silently halve the ace of several bosses; a Mega
	// holding nothing would lose the item slot the game actually spends.
	const fights = planner.loadRunMap('run-and-bun');
	let withStone = 0;
	const problems = [];
	for (const fight of fights) {
		for (const mon of fight.party) {
			const item = mon.item ? GEN.items.get(Calc.toID(mon.item)) : null;
			const evolves = item && item.megaEvolves;
			if (isMega(mon.species)) {
				// Kyogre-Primal holds the Blue Orb, which reverts rather than
				// mega-evolves and carries no megaEvolves field.
				if (evolves || /Orb$/.test(mon.item || '')) withStone += 1;
				else problems.push(fight.trainer + ': ' + mon.species + ' holds ' + (mon.item || 'nothing'));
			} else if (evolves) {
				problems.push(fight.trainer + ': base ' + mon.species + ' holds ' + mon.item +
					', which is the engine\'s shape and models the ace as unevolved');
			}
		}
	}
	assert.deepEqual(problems, []);
	assert.ok(withStone > 60, 'expected the run to hold the Megas it has; got ' + withStone);
});

test('holding the stone does not stack on top of being the Mega', () => {
	// The obvious way for a pre-applied form to go wrong twice. It does not:
	// the calculator reads the Mega's own stats, ability and types from the
	// species, and the stone in the item slot adds nothing.
	const withStone = new Calc.Pokemon(GEN, 'Ampharos-Mega', {
		level: 35, nature: 'Hardy', ivs: TRAINER_IVS, evs: NO_EVS, item: 'Ampharosite',
	});
	const without = new Calc.Pokemon(GEN, 'Ampharos-Mega', {
		level: 35, nature: 'Hardy', ivs: TRAINER_IVS, evs: NO_EVS,
	});
	assert.deepEqual(withStone.stats, without.stats);
	assert.equal(withStone.ability, 'Mold Breaker');
	assert.deepEqual(withStone.types, ['Electric', 'Dragon']);
});

test('the Megas that are slower than their base form, which is where timing matters', () => {
	// Not an error list. Mega Evolution resolves before any move, so these get
	// the correct Speed on turn one too — the pre-applied form is right about
	// order from the start.
	//
	// They are recorded because they are where the DECISION error is visible:
	// the enemy chose its turn-one move while it was still the faster base
	// form, and then moves at the slower evolved Speed. A model that never
	// evolves has both wrong; ours has the Speed right and the choice early.
	const fights = planner.loadRunMap('run-and-bun');
	const seen = new Set();
	const slower = [];
	for (const fight of fights) {
		for (const mon of fight.party) {
			if (!isMega(mon.species) || seen.has(mon.species)) continue;
			seen.add(mon.species);
			const base = GEN.species.get(Calc.toID(baseFormOf(mon.species)));
			const mega = GEN.species.get(Calc.toID(mon.species));
			if (!base || !mega) continue;
			if (mega.baseStats.spe < base.baseStats.spe) slower.push(mon.species);
		}
	}
	assert.deepEqual(slower.sort(), [
		'Abomasnow-Mega', 'Ampharos-Mega', 'Camerupt-Mega',
		'Garchomp-Mega', 'Heracross-Mega', 'Sableye-Mega',
	], 'the set changed — re-read where the turn-one decision gap shows');
});

test('Wattson\'s ace: the pre-applied Mega is what orders turn one, and that is correct', () => {
	// The worked case, corrected. Mega Evolution happens before any move, so
	// the evolved Speed is the one that orders the first turn — the panel
	// reading 47 against our 47 and calling it a tie is RIGHT, and a model
	// that used the base form's 54 would be wrong from the opening turn.
	const fights = planner.loadRunMap('run-and-bun');
	const wattson = fights.find(fight => /Leader Wattson/.test(fight.trainer));
	assert.ok(wattson, 'the fixture needs Wattson');
	const ace = wattson.party.find(mon => /Ampharos/.test(mon.species));
	assert.equal(ace.species, 'Ampharos-Mega', 'the run stores the evolved form');

	const evolved = speed('Ampharos-Mega', ace.level, ace.nature);
	const unevolved = speed('Ampharos', ace.level, ace.nature);
	assert.ok(unevolved > evolved, 'this ace is the slower form once it evolves');

	const board = planner.matchup({
		trainer: 'Leader Wattson', profileId: 'run-and-bun',
		playerParty: [{
			species: 'Prinplup', level: 35,
			moves: ['Bubble Beam', 'Metal Claw', 'Growl', 'Peck'],
			ivs: {hp: 20, atk: 18, def: 19, spa: 22, spd: 17, spe: 21},
		}],
	});
	const cell = board.grid.find(row => /Ampharos/.test(row.enemy.species));
	assert.ok(cell, 'the ace must be on the board');
	assert.equal(cell.versus[0].speed, 'tie',
		'the evolved Speed is what orders turn one, so a tie here is the right answer');
});
