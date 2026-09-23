import assert from 'node:assert/strict';
import {calculateActionFacts} from '../calc-adapter';
import {deriveMoveResolution} from '../move-engine';
import {BattleState, MoveAction} from '../model';
import {applyAction} from '../transition';

// Composed-pipeline coverage: calculator facts feed deriveMoveResolution the
// way lib/battle-driver.js wires them, so the adapter's guarded (zeroed)
// forecast and the resolution's break bookkeeping are exercised together.

function fixture(defender: {species: string, ability: string}, attackerAbility?: string): BattleState {
  return {
    generation: 9,
    mode: 'Singles',
    turn: 1,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: defender.species, ability: defender.ability, level: 50,
        hp: {current: 130, max: 130}, moves: [{name: 'Splash', pp: 40, maxPP: 40}],
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Gengar', level: 50,
        ...(attackerAbility ? {ability: attackerAbility} : {}),
        hp: {current: 135, max: 135},
        moves: [{name: 'Shadow Ball', pp: 15, maxPP: 15}, {name: 'Shadow Claw', pp: 15, maxPP: 15}, {name: 'Tackle', pp: 35, maxPP: 35}],
      }]},
    },
  };
}

function attack(moveName: string): Extract<MoveAction, {kind: 'move'}> {
  return {kind: 'move', actorId: 'player-1', moveName, targetIds: ['ai-1']};
}

const rng = () => 0.5;

// Intact Disguise: hit 1 lands for zero damage and breaks the Disguise.
const mimikyu = fixture({species: 'Mimikyu', ability: 'Disguise'});
const shadowBall = attack('Shadow Ball');
const guardedFacts = calculateActionFacts(mimikyu, shadowBall);
assert.ok(guardedFacts.damage);
assert.equal(guardedFacts.damage.max, 0);
const breakResolution = deriveMoveResolution(mimikyu, shadowBall, {facts: guardedFacts, random: rng});
assert.equal(breakResolution.damageByTarget?.['ai-1'], 0);
assert.equal(breakResolution.disguiseBrokenByPokemon?.['ai-1'], true);

// Hit 2 against the busted form deals real damage.
const busted = applyAction(mimikyu, shadowBall, breakResolution);
assert.equal(busted.sides.ai.party[0].disguiseBroken, true);
const bustedFacts = calculateActionFacts(busted, shadowBall);
assert.ok(bustedFacts.damage);
assert.ok(bustedFacts.damage.min > 0);
const bustedResolution = deriveMoveResolution(busted, shadowBall, {facts: bustedFacts, random: rng});
assert.ok((bustedResolution.damageByTarget?.['ai-1'] || 0) > 0);
assert.equal(bustedResolution.disguiseBrokenByPokemon, undefined);

// A move Mimikyu is immune to must not break the Disguise.
const tackle = attack('Tackle');
const immuneFacts = calculateActionFacts(mimikyu, tackle);
assert.equal(immuneFacts.damage?.max ?? 0, 0);
const immuneResolution = deriveMoveResolution(mimikyu, tackle, {facts: immuneFacts, random: rng});
assert.equal(immuneResolution.disguiseBrokenByPokemon, undefined);

// Mold Breaker ignores Disguise: full damage on hit 1, nothing breaks.
const bypass = fixture({species: 'Mimikyu', ability: 'Disguise'}, 'Mold Breaker');
const bypassFacts = calculateActionFacts(bypass, shadowBall);
assert.ok(bypassFacts.damage);
assert.ok(bypassFacts.damage.min > 0);
const bypassResolution = deriveMoveResolution(bypass, shadowBall, {facts: bypassFacts, random: rng});
assert.ok((bypassResolution.damageByTarget?.['ai-1'] || 0) > 0);
assert.equal(bypassResolution.disguiseBrokenByPokemon, undefined);

// Ice Face shares the guard shape: a physical hit lands for zero damage and
// changes Eiscue to Noice Face; the next physical hit deals real damage.
const eiscue = fixture({species: 'Eiscue', ability: 'Ice Face'});
const shadowClaw = attack('Shadow Claw');
const iceFacts = calculateActionFacts(eiscue, shadowClaw);
assert.ok(iceFacts.damage);
assert.equal(iceFacts.damage.max, 0);
const iceResolution = deriveMoveResolution(eiscue, shadowClaw, {facts: iceFacts, random: rng});
assert.equal(iceResolution.damageByTarget?.['ai-1'], 0);
assert.equal(iceResolution.speciesOverrideByPokemon?.['ai-1'], 'Eiscue-Noice');
const noice = applyAction(eiscue, shadowClaw, iceResolution);
assert.equal(noice.sides.ai.party[0].speciesOverride, 'Eiscue-Noice');
const noiceFacts = calculateActionFacts(noice, shadowClaw);
assert.ok(noiceFacts.damage);
assert.ok(noiceFacts.damage.min > 0);

// Special moves pass through an intact Ice Face untouched.
const specialFacts = calculateActionFacts(eiscue, shadowBall);
assert.ok(specialFacts.damage);
assert.ok(specialFacts.damage.min > 0);
const specialResolution = deriveMoveResolution(eiscue, shadowBall, {facts: specialFacts, random: rng});
assert.equal(specialResolution.speciesOverrideByPokemon, undefined);

console.log('Disguise/Ice Face composed pipeline fixtures passed');
