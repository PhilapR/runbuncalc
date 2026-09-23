import assert from 'node:assert/strict';
import {calculateActionFacts} from '../calc-adapter';
import {deriveMoveResolution} from '../move-engine';
import {BattleState, PokemonState} from '../model';
import {applyAction} from '../transition';

// Sleep and freeze gate an action BEFORE Truant and flinch. Showdown orders
// onBeforeMove by priority: slp/frz 10, truant 9, flinch 8 (mustrecharge 11
// sits above them all). The engine returned on flinch and Truant first, so a
// flinched or loafing sleeper did not burn its counter that turn and slept
// one turn longer, and a flinched frozen mon never rolled its thaw.
function state(actor: Partial<PokemonState>): BattleState {
  return {
    generation: 8,
    mode: 'Singles',
    turn: 1,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Slaking', level: 100,
        hp: {current: 300, max: 300}, moves: [{name: 'Tackle', pp: 35, maxPP: 35}],
        ...actor,
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Blissey', level: 100,
        hp: {current: 600, max: 600}, moves: [{name: 'Tackle'}],
      }]},
    },
  };
}
const action = {kind: 'move' as const, actorId: 'ai-1', moveName: 'Tackle', targetIds: ['player-1']};
function resolve(fixture: BattleState, random = () => 0.5) {
  return deriveMoveResolution(fixture, action, {facts: calculateActionFacts(fixture, action), random});
}
// applyAction must accept the resolution: a throw here is the defect, so it
// surfaces as an assertion and not as a crash.
function apply(fixture: BattleState, resolution: ReturnType<typeof resolve>): BattleState {
  let after: BattleState | undefined;
  assert.doesNotThrow(() => { after = applyAction(fixture, action, resolution); },
    'applyAction accepts the resolution');
  return after!;
}

// A flinched sleeper still burns its counter: 3 -> 2, and the turn is lost
// to sleep.
{
  const fixture = state({status: 'slp', statusTurns: 3, volatile: {flinch: {turns: 1}}});
  const resolution = resolve(fixture);
  assert.equal(resolution.actionFailure, 'sleep', 'sleep gates before flinch');
  assert.equal(resolution.statusTurnsByPokemon?.['ai-1'], 2, 'the counter burns on a flinched turn');
  const after = applyAction(fixture, action, resolution);
  assert.equal(after.sides.ai.party[0].statusTurns, 2);
}

// A flinched sleeper on its last counter wakes, THEN flinches: it loses the
// turn but is awake afterwards.
{
  const fixture = state({status: 'slp', statusTurns: 1, volatile: {flinch: {turns: 1}}});
  const resolution = resolve(fixture);
  assert.equal(resolution.actionFailure, 'flinch');
  assert.equal(resolution.statusByPokemon?.['ai-1'], '', 'the sleeper woke before flinching');
  const after = applyAction(fixture, action, resolution);
  assert.equal(after.sides.ai.party[0].status, '');
  assert.equal(after.sides.player.party[0].hp.current, 600, 'the flinch still cost the action');
}

// A Truant sleeper on a loafing turn burns its counter and keeps the loaf
// owed: sleep stopped the action before Truant ran.
{
  const fixture = state({
    ability: 'Truant', abilityOn: true, status: 'slp', statusTurns: 3, volatile: {truant: {}},
  });
  const resolution = resolve(fixture);
  assert.equal(resolution.actionFailure, 'sleep', 'sleep gates before Truant');
  assert.equal(resolution.statusTurnsByPokemon?.['ai-1'], 2, 'the counter burns on a loafing turn');
  assert.equal(resolution.volatileByPokemon?.['ai-1']?.truant, undefined, 'Truant did not run');
  // applyAction accepts the sleep failure on a loafing turn, and the loaf
  // stays owed: the flag does not toggle while sleep blocks the action.
  const after = apply(fixture, resolution);
  assert.equal(after.sides.ai.party[0].statusTurns, 2);
  assert.deepEqual(after.sides.ai.party[0].volatile?.truant, {}, 'the loaf is still owed');
}

// A frozen Truant mon on a loafing turn stays frozen (a 0.5 draw is not
// under 20%) and keeps the loaf owed.
{
  const fixture = state({ability: 'Truant', abilityOn: true, status: 'frz', volatile: {truant: {}}});
  const resolution = resolve(fixture);
  assert.equal(resolution.actionFailure, 'freeze', 'freeze gates before Truant');
  const after = apply(fixture, resolution);
  assert.equal(after.sides.ai.party[0].status, 'frz');
  assert.deepEqual(after.sides.ai.party[0].volatile?.truant, {}, 'the loaf is still owed');
}

// A Truant sleeper on an acting turn does not arm the loaf: Truant did not
// run, so the mon acts on the turn it wakes.
{
  const fixture = state({ability: 'Truant', abilityOn: true, status: 'slp', statusTurns: 3});
  const resolution = resolve(fixture);
  assert.equal(resolution.actionFailure, 'sleep');
  const after = apply(fixture, resolution);
  assert.equal(after.sides.ai.party[0].volatile?.truant, undefined, 'the loaf is not armed');
}

// A Truant sleeper that wakes on a loafing turn wakes, then loafs.
{
  const fixture = state({
    ability: 'Truant', abilityOn: true, status: 'slp', statusTurns: 1, volatile: {truant: {}},
  });
  const resolution = resolve(fixture);
  assert.equal(resolution.actionFailure, 'truant');
  assert.equal(resolution.statusByPokemon?.['ai-1'], '', 'woke, then loafed');
  const after = applyAction(fixture, action, resolution);
  assert.equal(after.sides.ai.party[0].status, '');
  assert.equal(after.sides.ai.party[0].volatile?.truant, undefined, 'the loaf is spent');
}

// A flinched frozen mon still rolls its thaw (a 0 draw is under 20%): it
// thaws, then flinches.
{
  const fixture = state({status: 'frz', volatile: {flinch: {turns: 1}}});
  const resolution = resolve(fixture, () => 0);
  assert.equal(resolution.actionFailure, 'flinch');
  assert.equal(resolution.statusByPokemon?.['ai-1'], '', 'the thaw happened before the flinch');
}

// Recharge stays ahead of sleep: a recharging sleeper spends the turn
// recharging and does not burn its counter.
{
  const fixture = state({status: 'slp', statusTurns: 3, volatile: {recharge: {moveName: 'Tackle'}}});
  const resolution = resolve(fixture);
  assert.equal(resolution.statusTurnsByPokemon?.['ai-1'], undefined);
  assert.equal(resolution.volatileByPokemon?.['ai-1']?.recharge, null);
}

console.log('sleep-before-flinch-truant: ok');
