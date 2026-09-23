import assert from 'node:assert/strict';
import {calculateActionFacts} from '../calc-adapter';
import {deriveMoveResolution} from '../move-engine';
import {enumerateMoveActions} from '../actions';
import {BattleState} from '../model';

// Two defects an independent mechanics review proved, both about a guard
// that was written for a world the engine no longer lives in.

function mon(id: string, species: string, extra: object = {}) {
  return {
    id, species, level: 50, hp: {current: 200, max: 200},
    moves: [{name: 'Tackle', pp: 10, maxPP: 10}], ...extra,
  };
}
function state(ai: object, player: object): BattleState {
  return {
    generation: 8, mode: 'Singles', turn: 1, field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [ai]},
      player: {activeIds: ['player-1'], party: [player]},
    },
  } as BattleState;
}
function resolve(fixture: BattleState, moveName: string, random: () => number) {
  const action = {kind: 'move' as const, actorId: 'ai-1', moveName, targetIds: ['player-1']};
  return deriveMoveResolution(fixture, action, {
    facts: calculateActionFacts(fixture, action), hit: true, random,
  });
}

// D-sleep: the sleep counter now burns on the ATTEMPT, so statusTurns === 1
// means "this attempt is the one that wakes you" and statusTurns === 0 is
// unreachable. Three legality gates still tested for 0, so Sleep Talk and
// Snore executed on the way out of sleep — one free turn per sleep cycle for
// every Rest/Sleep Talk staller in every prediction.
function sleeper(moveName: string, statusTurns: number): BattleState {
  return state(
    mon('ai-1', 'Snorlax', {
      status: 'slp', statusTurns,
      moves: [{name: moveName, pp: 10, maxPP: 10}, {name: 'Tackle', pp: 10, maxPP: 10}],
    }),
    mon('player-1', 'Blissey'));
}
for (const moveName of ['Sleep Talk', 'Snore']) {
  const waking = resolve(sleeper(moveName, 1), moveName, () => 0.5);
  assert.equal(waking.hit, false,
    `${moveName} must fail on the attempt that ends the sleep`);
  assert.ok(!waking.damageByTarget?.['player-1'],
    `${moveName} must deal nothing on the turn its user wakes`);

  // Still asleep with turns to spare: it works, exactly as before.
  const asleep = resolve(sleeper(moveName, 3), moveName, () => 0.5);
  assert.equal(asleep.hit, true, `${moveName} still works while genuinely asleep`);

  // And the action enumerator agrees with the resolver — a move the engine
  // will refuse must not be offered to policy as a choice.
  assert.equal(
    enumerateMoveActions(sleeper(moveName, 1), 'ai').some(a => a.moveName === moveName), false,
    `${moveName} must not be enumerated on the waking attempt`);
  assert.equal(
    enumerateMoveActions(sleeper(moveName, 3), 'ai').some(a => a.moveName === moveName), true,
    `${moveName} is still a legal choice while asleep`);
}

// D-flinch: a held King's Rock adds a 10% flinch, but the block never asked
// whether the target BLOCKS secondary effects, and gated on total damage
// rather than direct damage — so it flinched through Shield Dust and through
// a Substitute, both of which stop the move's own flinch secondary.
function flinched(target: object): boolean {
  const fixture = state(mon('ai-1', 'Machamp', {item: "King's Rock"}), target);
  return !!resolve(fixture, 'Tackle', () => 0.05).volatileByPokemon?.['player-1']?.flinch;
}
assert.equal(flinched(mon('player-1', 'Blissey')), true,
  'the control still flinches — the item works');
assert.equal(flinched(mon('player-1', 'Vivillon', {ability: 'Shield Dust', abilityOn: true})), false,
  'Shield Dust stops a held-item flinch exactly as it stops a move secondary');
assert.equal(flinched(mon('player-1', 'Blissey', {substituteHp: 100})), false,
  'a Substitute eats the hit, so there is no direct damage to flinch through');
// Inner Focus was already handled and must stay handled.
assert.equal(flinched(mon('player-1', 'Crobat', {ability: 'Inner Focus', abilityOn: true})), false,
  'Inner Focus still refuses the flinch');

console.log('wake-turn-and-item-flinch: ok');
