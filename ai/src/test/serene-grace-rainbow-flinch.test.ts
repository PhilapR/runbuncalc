import assert from 'node:assert/strict';
import {calculateActionFacts} from '../calc-adapter';
import {BattleState} from '../model';
import {deriveMoveResolution} from '../move-engine';

// Serene Grace and a Rainbow (Water + Fire Pledge) each double a secondary
// chance, and they stack — except on a flinch. Showdown's Water Pledge side
// condition skips its doubling for a flinch secondary when the user has
// Serene Grace (data/moves.ts, waterpledge.condition.onModifyMove). A Serene
// Grace Iron Head (30% flinch) behind a Rainbow flinches 60%, not 100%.
function state(ability: string, rainbow: boolean): BattleState {
  return {
    generation: 8,
    mode: 'Singles',
    turn: 1,
    field: {},
    sides: {
      ai: {
        activeIds: ['ai-1'],
        effects: rainbow ? {pledgeRainbow: true} : {},
        effectDurations: rainbow ? {pledgeRainbow: 4} : {},
        party: [{
          id: 'ai-1', species: 'Togekiss', level: 100, ability, abilityOn: true,
          hp: {current: 300, max: 300}, moves: [{name: 'Iron Head'}, {name: 'Air Slash'}],
        }],
      },
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Blissey', level: 100,
        hp: {current: 600, max: 600}, moves: [{name: 'Tackle'}],
      }]},
    },
  };
}

// Every draw defaults to 0.7: the accuracy check passes, and the flinch
// secondary lands only if its effective chance is above 70%.
function flinched(ability: string, rainbow: boolean, moveName: string, draw = 0.7): boolean {
  const fixture = state(ability, rainbow);
  const action = {kind: 'move' as const, actorId: 'ai-1', moveName, targetIds: ['player-1']};
  const resolution = deriveMoveResolution(fixture, action, {
    facts: calculateActionFacts(fixture, action),
    random: () => draw,
  });
  assert.equal(resolution.hit, true, `${moveName} must connect for the secondary to matter`);
  return !!resolution.volatileByPokemon?.['player-1']?.flinch;
}

// The rule under test: Serene Grace + Rainbow does NOT reach 100% on a flinch.
assert.equal(flinched('Serene Grace', true, 'Iron Head'), false,
  'a Serene Grace flinch is not doubled again by the Rainbow (60%, not 100%)');
// The other halves of the rule still hold, so the test is not hollow.
assert.equal(flinched('Serene Grace', false, 'Iron Head'), false, 'Serene Grace alone: 60%');
assert.equal(flinched('Inner Focus', true, 'Iron Head'), false, 'Rainbow alone: 60%');
// A 0.5 draw is under 60%: the flinch does land, so the path is live.
assert.equal(flinched('Serene Grace', true, 'Iron Head', 0.5), true, 'Serene Grace + Rainbow flinch is 60%');
assert.equal(flinched('Inner Focus', false, 'Iron Head', 0.5), false, 'no modifier: 30%');
// Air Slash (30% flinch) — same 60% under Serene Grace + Rainbow.
assert.equal(flinched('Serene Grace', true, 'Air Slash'), false);

// Non-flinch secondaries still stack x4. Serene Grace Thunderbolt (10% par)
// behind a Rainbow is 40%: a 0.35 draw paralyzes, and does not without the
// Rainbow (20%).
function paralyzed(rainbow: boolean): boolean {
  const fixture = state('Serene Grace', rainbow);
  fixture.sides.ai.party[0].moves = [{name: 'Thunderbolt'}];
  const action = {kind: 'move' as const, actorId: 'ai-1', moveName: 'Thunderbolt', targetIds: ['player-1']};
  const resolution = deriveMoveResolution(fixture, action, {
    facts: calculateActionFacts(fixture, action),
    random: () => 0.35,
  });
  return resolution.statusByPokemon?.['player-1'] === 'par';
}
assert.equal(paralyzed(true), true, 'Serene Grace x Rainbow still stacks on a non-flinch secondary');
assert.equal(paralyzed(false), false);

console.log('serene-grace-rainbow-flinch: ok');
