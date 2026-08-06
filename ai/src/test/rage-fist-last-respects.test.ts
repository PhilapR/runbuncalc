import assert from 'node:assert/strict';
import {calculateActionFacts} from '../calc-adapter';
import {enumerateMoveActions} from '../actions';
import {deriveMoveResolution} from '../move-engine';
import {BattleState} from '../model';
import {applyAction, applyDamageAction, applySwitchAction} from '../transition';

function state(aiMove: string): BattleState {
  return {
    generation: 9,
    mode: 'Singles',
    turn: 1,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Pikachu', level: 100,
        hp: {current: 100, max: 100}, moves: [{name: aiMove}],
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Mewtwo', level: 100,
        hp: {current: 100000, max: 100000}, moves: [{name: 'Tackle'}],
      }]},
    },
  };
}

function action(fixture: BattleState, side: 'ai' | 'player', moveName: string) {
  const selected = enumerateMoveActions(fixture, side).find(candidate => candidate.moveName === moveName);
  assert.ok(selected);
  return selected;
}

const rageFist = state('Rage Fist');
const rageAction = action(rageFist, 'ai', 'Rage Fist');
const rageBaseFacts = calculateActionFacts(rageFist, rageAction);
const enraged = {...rageFist, sides: {
  ...rageFist.sides,
  ai: {...rageFist.sides.ai, party: rageFist.sides.ai.party.map(pokemon => ({...pokemon, rageFistHits: 2}))},
}};
const enragedFacts = calculateActionFacts(enraged, action(enraged, 'ai', 'Rage Fist'));
assert.ok((enragedFacts.damage?.max || 0) > (rageBaseFacts.damage?.max || 0));

const lastRespects = state('Last Respects');
const lastRespectsBase = calculateActionFacts(lastRespects, action(lastRespects, 'ai', 'Last Respects'));
const lastRespectsBoosted = {...lastRespects, sides: {
  ...lastRespects.sides,
  ai: {...lastRespects.sides.ai, party: lastRespects.sides.ai.party.map(pokemon => ({...pokemon, alliesFainted: 3}))},
}};
const lastRespectsBoostedFacts = calculateActionFacts(
  lastRespectsBoosted, action(lastRespectsBoosted, 'ai', 'Last Respects'),
);
assert.ok((lastRespectsBoostedFacts.damage?.max || 0) > (lastRespectsBase.damage?.max || 0));

const incoming = action(rageFist, 'player', 'Tackle');
const directHit = applyDamageAction(rageFist, incoming, {'ai-1': 10});
assert.equal(directHit.sides.ai.party[0].rageFistHits, 1);
const resolvedHit = applyAction(rageFist, incoming, {hit: true, damageByTarget: {'ai-1': 10}});
assert.equal(resolvedHit.sides.ai.party[0].rageFistHits, 1);

const switchFixture: BattleState = {
  ...rageFist,
  sides: {
    ...rageFist.sides,
    ai: {
      activeIds: ['ai-1'],
      party: [
        {...rageFist.sides.ai.party[0], rageFistHits: 4},
        {id: 'ai-2', species: 'Eevee', level: 100, hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}]},
      ],
    },
  },
};
const switched = applySwitchAction(switchFixture, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2',
});
assert.equal(switched.sides.ai.party.find(pokemon => pokemon.id === 'ai-1')?.rageFistHits, undefined);
assert.equal(switched.sides.ai.party.find(pokemon => pokemon.id === 'ai-2')?.rageFistHits, undefined);

const preGen9 = state('Rage Fist');
preGen9.generation = 8;
assert.equal(enumerateMoveActions(preGen9, 'ai').some(candidate => candidate.moveName === 'Rage Fist'), false);
assert.equal(deriveMoveResolution(preGen9, {
  kind: 'move', actorId: 'ai-1', moveName: 'Rage Fist', targetIds: ['player-1'],
}, {hit: true}).hit, false);

console.log('Rage Fist and Last Respects fixtures passed');
