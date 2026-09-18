import assert from 'node:assert/strict';
import {calculateActionFacts} from '../calc-adapter';
import {enumerateMoveActions} from '../actions';
import {getEffectiveTypes} from '../eligibility';
import {deriveMoveResolution} from '../move-engine';
import {BattleState} from '../model';
import {applyAction, applySwitchAction} from '../transition';

function state(moveName: string, species: string, generation = 9): BattleState {
  return {
    generation: generation as BattleState['generation'],
    mode: 'Singles',
    turn: 1,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [
        {
          id: 'ai-1', species, level: 100,
          hp: {current: 100, max: 100}, moves: [{name: moveName, pp: 5, maxPP: 5}, {name: 'Tackle'}],
        },
        {id: 'ai-2', species: 'Bulbasaur', level: 100, hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}]},
      ]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Mewtwo', level: 100,
        hp: {current: 1000, max: 1000}, moves: [{name: 'Tackle'}],
      }]},
    },
  };
}

function selected(fixture: BattleState, moveName: string) {
  const action = enumerateMoveActions(fixture, 'ai').find(candidate => candidate.moveName === moveName);
  assert.ok(action);
  return action;
}

const burnUp = state('Burn Up', 'Charizard');
assert.ok(getEffectiveTypes(burnUp, 'ai-1').some(type => type === 'Fire'));
const burnUpAction = selected(burnUp, 'Burn Up');
const burnUpFacts = calculateActionFacts(burnUp, burnUpAction);
const burnUpResolution = deriveMoveResolution(burnUp, burnUpAction, {facts: burnUpFacts, hit: true, random: () => 0});
// Burn Up burns off the FIRE type, not every type: Fire/Flying Charizard is
// Flying afterwards. This fixture used to assert [] here, which pinned the
// defect that made every dual-type Burn Up user typeless and, through a null
// damage calc, unhittable (Centiskorch soloed Roxanne, 2026-09-18).
assert.deepEqual(burnUpResolution.typeOverrideByPokemon?.['ai-1'], ['Flying']);
const burnedUp = applyAction(burnUp, burnUpAction, burnUpResolution);
assert.deepEqual(getEffectiveTypes(burnedUp, 'ai-1'), ['Flying']);
assert.equal(enumerateMoveActions(burnedUp, 'ai').some(action => action.moveName === 'Burn Up'), false);
assert.equal(deriveMoveResolution(burnedUp, burnUpAction, {hit: true}).hit, false);
const switchedOut = applySwitchAction(burnedUp, {kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2'});
const switchedBack = applySwitchAction(switchedOut, {kind: 'switch', actorId: 'ai-2', replacementId: 'ai-1'});
assert.ok(getEffectiveTypes(switchedBack, 'ai-1').some(type => type === 'Fire'));

// A pure Fire user is left genuinely typeless — and must still be hittable.
// Damage into a typeless body is neutral; it came back null, the transition
// refused it, and the attacker lost every turn.
const pureFire = state('Burn Up', 'Charmander');
const pureFireAction = selected(pureFire, 'Burn Up');
const typelessFire = applyAction(pureFire, pureFireAction, deriveMoveResolution(pureFire, pureFireAction, {
  facts: calculateActionFacts(pureFire, pureFireAction), hit: true, random: () => 0,
}));
assert.deepEqual(getEffectiveTypes(typelessFire, 'ai-1'), []);
const tackle = enumerateMoveActions(typelessFire, 'player').find(action => action.moveName === 'Tackle');
assert.ok(tackle);
const intoTypeless = calculateActionFacts(typelessFire, tackle);
const hit = intoTypeless.damage as {min: number; max: number} | undefined;
assert.ok(hit && Number.isFinite(hit.min) && Number.isFinite(hit.max) && hit.max > 0,
  'a typeless target takes finite, positive damage');
const tackled = applyAction(typelessFire, tackle, deriveMoveResolution(typelessFire, tackle, {
  facts: intoTypeless, hit: true, random: () => 0,
}));
assert.ok(tackled.sides.ai.party[0].hp.current < typelessFire.sides.ai.party[0].hp.current,
  'and the hit lands: the transition accepts it');

const doubleShock = state('Double Shock', 'Pikachu');
assert.ok(getEffectiveTypes(doubleShock, 'ai-1').some(type => type === 'Electric'));
const doubleShockAction = selected(doubleShock, 'Double Shock');
const doubleShockResolution = deriveMoveResolution(doubleShock, doubleShockAction, {
  facts: calculateActionFacts(doubleShock, doubleShockAction),
  hit: true,
  random: () => 0,
});
assert.deepEqual(doubleShockResolution.typeOverrideByPokemon?.['ai-1'], []);
assert.deepEqual(getEffectiveTypes(applyAction(doubleShock, doubleShockAction, doubleShockResolution), 'ai-1'), []);

const wrongType = state('Burn Up', 'Rattata');
assert.equal(enumerateMoveActions(wrongType, 'ai').some(action => action.moveName === 'Burn Up'), false);
assert.equal(deriveMoveResolution(wrongType, {
  kind: 'move', actorId: 'ai-1', moveName: 'Burn Up', targetIds: ['player-1'],
}, {hit: true}).hit, false);

const preGen7 = state('Burn Up', 'Charizard', 6);
assert.equal(enumerateMoveActions(preGen7, 'ai').some(action => action.moveName === 'Burn Up'), false);
assert.equal(deriveMoveResolution(preGen7, burnUpAction, {hit: true}).hit, false);
const preGen9 = state('Double Shock', 'Pikachu', 8);
assert.equal(enumerateMoveActions(preGen9, 'ai').some(action => action.moveName === 'Double Shock'), false);
assert.equal(deriveMoveResolution(preGen9, doubleShockAction, {hit: true}).hit, false);

console.log('Typeless move fixtures passed');
