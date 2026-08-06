import assert from 'node:assert/strict';
import {deriveSwitchEntryResolution} from '../entry-hazards';
import {BattleState, SwitchAction} from '../model';
import {applySwitchAction} from '../transition';

function state(ability: string, generation: BattleState['generation'] = 9): BattleState {
  return {
    generation,
    mode: 'Singles',
    turn: 1,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [
        {id: 'ai-1', species: 'Pikachu', level: 100, hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}]},
        {id: 'ai-2', species: 'Ditto', level: 100, ability, hp: {current: 100, max: 100}, moves: [{name: 'Transform'}]},
      ]},
      player: {activeIds: ['player-1'], party: [
        {
          id: 'player-1', species: 'Charizard', level: 100, ability: 'Blaze',
          hp: {current: 100, max: 100}, moves: [{name: 'Flamethrower'}, {name: 'Protect'}],
          boosts: {spa: 2, spe: -1},
        },
      ]},
    },
  };
}

const action: SwitchAction = {kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2'};
const imposter = state('Imposter');
const imposterResolution = deriveSwitchEntryResolution(imposter, action);
assert.deepEqual(imposterResolution.speciesOverrideByPokemon?.['ai-2'], 'Charizard');
assert.deepEqual(imposterResolution.typeOverrideByPokemon?.['ai-2'], ['Fire', 'Flying']);
assert.equal(imposterResolution.abilityOverrideByPokemon?.['ai-2'], 'Blaze');
assert.deepEqual(imposterResolution.setBoostsByPokemon?.['ai-2'], {spa: 2, spe: -1});
assert.deepEqual(imposterResolution.movesByPokemon?.['ai-2']?.map(move => [move.name, move.pp, move.maxPP]), [
  ['Flamethrower', 5, 5], ['Protect', 5, 5],
]);
assert.ok(imposterResolution.statOverridesByPokemon?.['ai-2']?.atk);
const imposterApplied = applySwitchAction(imposter, action);
assert.equal(imposterApplied.sides.ai.activeIds[0], 'ai-2');
assert.equal(imposterApplied.sides.ai.party[1].speciesOverride, 'Charizard');
assert.equal(imposterApplied.sides.ai.party[1].abilityOverride, 'Blaze');
assert.equal(imposterApplied.sides.ai.party[1].moves[0].name, 'Flamethrower');

const imposterAbilityShield = state('Imposter');
imposterAbilityShield.sides.ai.party[1].item = 'Ability Shield';
const shieldResolution = deriveSwitchEntryResolution(imposterAbilityShield, action);
assert.equal(shieldResolution.speciesOverrideByPokemon?.['ai-2'], 'Charizard');
assert.equal(shieldResolution.abilityOverrideByPokemon?.['ai-2'], undefined);

const imposterNoAbility = state('Imposter');
delete imposterNoAbility.sides.player.party[0].ability;
const noAbilityResolution = deriveSwitchEntryResolution(imposterNoAbility, action);
assert.equal(noAbilityResolution.noAbilityByPokemon?.['ai-2'], true);
assert.equal(applySwitchAction(imposterNoAbility, action).sides.ai.party[1].abilityOverride, null);

const imposterGen4 = deriveSwitchEntryResolution(state('Imposter', 4), action);
assert.equal(imposterGen4.speciesOverrideByPokemon, undefined);

const trace = state('Trace');
const traceResolution = deriveSwitchEntryResolution(trace, action, {random: () => 0});
assert.equal(traceResolution.abilityOverrideByPokemon?.['ai-2'], 'Blaze');
assert.equal(traceResolution.speciesOverrideByPokemon, undefined);
const traceSlowStart = state('Trace');
traceSlowStart.sides.player.party[0].ability = 'Slow Start';
const traceSlowStartResolution = deriveSwitchEntryResolution(traceSlowStart, action, {random: () => 0});
assert.equal(traceSlowStartResolution.abilityOverrideByPokemon?.['ai-2'], 'Slow Start');
assert.deepEqual(traceSlowStartResolution.volatileByPokemon?.['ai-2']?.slowStart, {turns: 5});
const traceSuppressed = state('Trace');
traceSuppressed.sides.player.party[0].abilitySuppressed = true;
assert.equal(deriveSwitchEntryResolution(traceSuppressed, action, {random: () => 0})
  .abilityOverrideByPokemon, undefined);
const traceAbilityShield = state('Trace');
traceAbilityShield.sides.ai.party[1].item = 'Ability Shield';
assert.equal(deriveSwitchEntryResolution(traceAbilityShield, action, {random: () => 0})
  .abilityOverrideByPokemon, undefined);

const traceBlocked = state('Trace');
traceBlocked.sides.player.party[0].ability = 'As One (Glastrier)';
assert.equal(deriveSwitchEntryResolution(traceBlocked, action, {random: () => 0})
  .abilityOverrideByPokemon, undefined);

assert.throws(
  () => deriveSwitchEntryResolution(trace, action, {random: () => Number.NaN}),
  /Trace ability sampler/,
);

console.log('Copy-entry ability fixtures passed');
