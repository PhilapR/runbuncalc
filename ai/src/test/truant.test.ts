import assert from 'node:assert/strict';
import {enumerateMoveActions} from '../actions';
import {deriveMoveResolution} from '../move-engine';
import {BattleState, MoveAction} from '../model';
import {applyAction} from '../transition';
import {validateBattleState} from '../validation';

function state(generation: BattleState['generation'] = 9): BattleState {
  return {
    generation,
    mode: 'Singles',
    turn: 1,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Slaking', level: 100,
        hp: {current: 100, max: 100}, ability: 'Truant',
        moves: [{name: 'Tackle'}, {name: 'Protect'}],
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Rattata', level: 100,
        hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}],
      }]},
    },
  };
}

function action(battle: BattleState): MoveAction {
  return enumerateMoveActions(battle, 'ai').find(candidate => candidate.moveName === 'Tackle')!;
}

const initial = state();
validateBattleState(initial);
const firstAction = action(initial);
const firstResolution = deriveMoveResolution(initial, firstAction, {hit: true});
assert.equal(firstResolution.actionFailure, undefined);
assert.deepEqual(firstResolution.volatileByPokemon?.['ai-1']?.truant, {});
const firstTurn = applyAction(initial, firstAction, firstResolution);
assert.deepEqual(firstTurn.sides.ai.party[0].volatile?.truant, {});

const loafAction = action(firstTurn);
const loafResolution = deriveMoveResolution(firstTurn, loafAction, {hit: true});
assert.equal(loafResolution.actionFailure, 'truant');
assert.equal(loafResolution.hit, false);
assert.deepEqual(loafResolution.volatileByPokemon?.['ai-1']?.truant, null);
const afterLoaf = applyAction(firstTurn, loafAction, loafResolution);
assert.equal(afterLoaf.sides.ai.party[0].volatile?.truant, undefined);
assert.equal(afterLoaf.sides.player.party[0].hp.current, 100);

const thirdResolution = deriveMoveResolution(afterLoaf, action(afterLoaf), {hit: true});
assert.equal(thirdResolution.actionFailure, undefined);
assert.deepEqual(thirdResolution.volatileByPokemon?.['ai-1']?.truant, {});

const suppressed = state();
suppressed.sides.ai.party[0].abilitySuppressed = true;
assert.equal(deriveMoveResolution(suppressed, action(suppressed), {hit: true}).actionFailure, undefined);

const preIntroduction = state(2);
preIntroduction.sides.ai.party[0].volatile = {truant: {}};
const preIntroductionResolution = deriveMoveResolution(preIntroduction, action(preIntroduction), {hit: true});
assert.equal(preIntroductionResolution.actionFailure, undefined);
assert.equal(preIntroductionResolution.volatileByPokemon, undefined);

console.log('Truant fixtures passed');
