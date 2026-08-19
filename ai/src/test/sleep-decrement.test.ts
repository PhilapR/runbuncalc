import assert from 'node:assert/strict';
import {calculateActionFacts} from '../calc-adapter';
import {deriveMoveResolution} from '../move-engine';
import {BattleState} from '../model';

// Gen 8 sleep decrements on each ACTION ATTEMPT, not at the turn boundary:
// a 2-4 counter always yields 1-3 missed turns, regardless of whether the
// victim was slept before or after acting. The old boundary decrement gave
// a faster sleeper's target 2-4 missed turns — one free turn too many in
// every plan built on it.
function state(turns: number, ability?: string): BattleState {
  return {
    generation: 8,
    mode: 'Singles',
    turn: 1,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Pikachu', level: 100,
        hp: {current: 100, max: 100}, moves: [{name: 'Tackle', pp: 35, maxPP: 35}],
        status: 'slp', statusTurns: turns,
        ...(ability ? {ability, abilityOn: true} : {}),
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Blissey', level: 100,
        hp: {current: 300, max: 300}, moves: [{name: 'Tackle'}],
      }]},
    },
  };
}

const action = {kind: 'move' as const, actorId: 'ai-1', moveName: 'Tackle', targetIds: ['player-1']};

// A 3-counter attempt: still asleep, counter ticks to 2 on the attempt.
{
  const fixture = state(3);
  const resolution = deriveMoveResolution(fixture, action, {
    facts: calculateActionFacts(fixture, action), random: () => 0.5,
  });
  assert.equal(resolution.actionFailure, 'sleep');
  assert.equal(resolution.statusTurnsByPokemon?.['ai-1'], 2,
    'the counter decrements on the attempt itself');
}

// A 1-counter attempt: the mon wakes and ACTS this turn.
{
  const fixture = state(1);
  const resolution = deriveMoveResolution(fixture, action, {
    facts: calculateActionFacts(fixture, action), random: () => 0.5,
  });
  assert.equal(resolution.actionFailure, undefined, 'waking is acting');
  assert.equal(resolution.statusByPokemon?.['ai-1'], '', 'sleep clears on wake');
  assert.equal(resolution.hit, true);
}

// Early Bird burns two counter points per attempt: 3 -> 1, still asleep.
{
  const fixture = state(3, 'Early Bird');
  const resolution = deriveMoveResolution(fixture, action, {
    facts: calculateActionFacts(fixture, action), random: () => 0.5,
  });
  assert.equal(resolution.actionFailure, 'sleep');
  assert.equal(resolution.statusTurnsByPokemon?.['ai-1'], 1,
    'Early Bird decrements twice per attempt');
}

// Early Bird at 2: wakes immediately and acts.
{
  const fixture = state(2, 'Early Bird');
  const resolution = deriveMoveResolution(fixture, action, {
    facts: calculateActionFacts(fixture, action), random: () => 0.5,
  });
  assert.equal(resolution.actionFailure, undefined);
  assert.equal(resolution.statusByPokemon?.['ai-1'], '');
}

console.log('sleep-decrement: ok');
