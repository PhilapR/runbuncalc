import assert from 'node:assert/strict';
import {calculateActionFacts} from '../calc-adapter';
import {deriveMoveResolution} from '../move-engine';
import {BattleState} from '../model';
import {applyAction} from '../transition';
import {validateMoveEngineOptions} from '../validation';

function state(): BattleState {
  return {
    generation: 9,
    mode: 'Singles',
    turn: 1,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Pikachu', level: 100,
        hp: {current: 100, max: 100}, moves: [{name: 'Tackle', pp: 35, maxPP: 35}],
        volatile: {confusion: {turns: 2}},
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Blissey', level: 100,
        hp: {current: 300, max: 300}, moves: [{name: 'Tackle'}],
      }]},
    },
  };
}

const fixture = state();
const action = {kind: 'move' as const, actorId: 'ai-1', moveName: 'Tackle', targetIds: ['player-1']};
const facts = calculateActionFacts(fixture, action);
assert.ok(facts.confusionDamage);
assert.ok(facts.confusionDamage.min >= 1);
assert.ok(facts.confusionDamage.max >= facts.confusionDamage.min);
validateMoveEngineOptions(fixture, action, {facts});

const resolution = deriveMoveResolution(fixture, action, {
  facts,
  random: () => 0.9,
});
assert.equal(resolution.hit, false);
assert.equal(resolution.actionFailure, 'confusion');
assert.equal(resolution.damageByTarget, undefined);
const expectedDamage = facts.confusionDamage.rolls[Math.floor(0.9 * facts.confusionDamage.rolls.length)];
assert.equal(resolution.hpDeltaByPokemon?.['ai-1'], -expectedDamage);
assert.equal(resolution.trace?.damageRollsByTarget?.['ai-1'], expectedDamage);

const next = applyAction(fixture, action, resolution);
assert.equal(next.sides.ai.party[0].hp.current, fixture.sides.ai.party[0].hp.current - expectedDamage);
assert.equal(next.sides.player.party[0].hp.current, 300);
assert.equal(next.lastResolution?.actionFailure, 'confusion');

const callerSuppliedNoFacts = deriveMoveResolution(fixture, action, {random: () => 0.9});
assert.equal(callerSuppliedNoFacts.hpDeltaByPokemon, undefined);

console.log('Confusion self-damage fixtures passed');
