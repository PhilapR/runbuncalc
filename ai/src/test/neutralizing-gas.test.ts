import assert from 'node:assert/strict';
import {calculateActionFacts} from '../calc-adapter';
import {isAbilityActive} from '../abilities';
import {deriveSwitchEntryResolution} from '../entry-hazards';
import {deriveMoveResolution} from '../move-engine';
import {BattleState, MoveAction} from '../model';

function state(attackerAbility: string, defenderAbility: string, defenderItem?: string): BattleState {
  return {
    generation: 9,
    mode: 'Singles',
    turn: 1,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Pikachu', level: 100, ability: attackerAbility,
        hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}],
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Rattata', level: 100, ability: defenderAbility,
        item: defenderItem,
        hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}],
      }]},
    },
  };
}

const action: MoveAction = {kind: 'move', actorId: 'ai-1', moveName: 'Tackle', targetIds: ['player-1']};

const gasSuppressesAttacker = state('Compound Eyes', 'Neutralizing Gas');
const suppressedFacts = calculateActionFacts(gasSuppressesAttacker, action);
assert.equal(suppressedFacts.attackerAbility, undefined);
assert.equal(suppressedFacts.defenderAbility, 'Neutralizing Gas');

const gasSuppressesDefender = state('Neutralizing Gas', 'Sturdy');
const defenderFacts = calculateActionFacts(gasSuppressesDefender, action);
assert.equal(defenderFacts.attackerAbility, 'Neutralizing Gas');
assert.equal(defenderFacts.defenderAbility, undefined);
assert.equal(isAbilityActive(gasSuppressesDefender.sides.player.party[0], gasSuppressesDefender), false);
assert.equal(isAbilityActive(gasSuppressesDefender.sides.ai.party[0], gasSuppressesDefender), true);

const abilityShield = state('Neutralizing Gas', 'Sturdy', 'Ability Shield');
const shieldFacts = calculateActionFacts(abilityShield, action);
assert.equal(shieldFacts.defenderAbility, 'Sturdy');
assert.equal(isAbilityActive(abilityShield.sides.player.party[0], abilityShield), true);

const staticState = state('Neutralizing Gas', 'Static');
const staticResolution = deriveMoveResolution(staticState, action, {
  hit: true,
  facts: calculateActionFacts(staticState, action),
  random: () => 0,
});
assert.equal(staticResolution.statusByPokemon, undefined);

const outgoingGas = state('Neutralizing Gas', 'Static');
outgoingGas.sides.ai.party.push({
  id: 'ai-2', species: 'Rattata', level: 100, ability: 'Intimidate',
  hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}],
});
const entryResolution = deriveSwitchEntryResolution(outgoingGas, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2',
});
assert.equal(entryResolution.boostsByPokemon?.['player-1']?.atk, -1);

console.log('Neutralizing Gas fixtures passed');
