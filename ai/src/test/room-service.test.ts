import assert from 'node:assert/strict';
import {deriveSwitchEntryResolution} from '../entry-hazards';
import {deriveMoveResolution} from '../move-engine';
import {BattleState, MoveAction, SwitchAction} from '../model';
import {applyAction, applySwitchAction} from '../transition';

// Room Service: -1 Speed and used up when Trick Room goes up while the holder
// stands, or when the holder enters under Trick Room. Gen 8 (Showdown
// data/items.ts roomservice); the Run & Bun doc is silent on it. Five foe
// holders carry it (Hiker Brice's Solrock and Lunatone, Garrison & Jani's
// Gallade and Gardevoir, Glacia's Kyurem-Black) and none ever slowed down.
function state(): BattleState {
  return {
    generation: 8,
    mode: 'Singles',
    turn: 1,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [
        {id: 'ai-1', species: 'Solrock', level: 100, hp: {current: 100, max: 100}, moves: [{name: 'Trick Room'}]},
        {id: 'ai-2', species: 'Lunatone', level: 100, hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}]},
      ]},
      player: {activeIds: ['player-1'], party: [
        {id: 'player-1', species: 'Rattata', level: 100, hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}]},
      ]},
    },
  };
}
const trickRoom: MoveAction = {kind: 'move', actorId: 'ai-1', moveName: 'Trick Room', targetIds: []};

// Trick Room set while the holder stands: the setter itself slows down.
{
  const fixture = state();
  fixture.sides.ai.party[0].item = 'Room Service';
  const resolution = deriveMoveResolution(fixture, trickRoom, {hit: true});
  assert.equal(resolution.field?.trickRoom, true);
  assert.equal(resolution.boostsByPokemon?.['ai-1']?.spe, -1, 'the holder takes -1 Speed');
  assert.equal(resolution.consumedItemByPokemon?.['ai-1'], 'Room Service', 'the item is used up');
  const after = applyAction(fixture, trickRoom, resolution);
  assert.equal(after.sides.ai.party[0].boosts?.spe, -1);
  assert.equal(after.sides.ai.party[0].item, undefined);
}

// An opposing holder is slowed too: the trigger is Trick Room, not its user.
{
  const fixture = state();
  fixture.sides.player.party[0].item = 'Room Service';
  const resolution = deriveMoveResolution(fixture, trickRoom, {hit: true});
  assert.equal(resolution.boostsByPokemon?.['player-1']?.spe, -1);
}

// Ending Trick Room does not trigger it.
{
  const fixture = state();
  fixture.field = {trickRoom: true, durations: {trickRoom: 3}};
  fixture.sides.ai.party[0].item = 'Room Service';
  const resolution = deriveMoveResolution(fixture, trickRoom, {hit: true});
  assert.equal(resolution.field?.trickRoom, false);
  assert.equal(resolution.boostsByPokemon?.['ai-1']?.spe, undefined, 'no trigger as the room closes');
}

// A bench holder entering under Trick Room slows down on entry.
{
  const fixture = state();
  fixture.field = {trickRoom: true, durations: {trickRoom: 3}};
  fixture.sides.ai.party[1].item = 'Room Service';
  const action: SwitchAction = {kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2'};
  const resolution = deriveSwitchEntryResolution(fixture, action);
  assert.equal(resolution.boostsByPokemon?.['ai-2']?.spe, -1, 'entry under Trick Room: -1 Speed');
  assert.equal(resolution.consumedItemByPokemon?.['ai-2'], 'Room Service');
  const after = applySwitchAction(fixture, action);
  assert.equal(after.sides.ai.party[1].boosts?.spe, -1);
  assert.equal(after.sides.ai.party[1].item, undefined);
}

// Entering with no Trick Room up: the item stays.
{
  const fixture = state();
  fixture.sides.ai.party[1].item = 'Room Service';
  const resolution = deriveSwitchEntryResolution(fixture, {kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2'});
  assert.equal(resolution.boostsByPokemon?.['ai-2']?.spe, undefined);
}

console.log('room-service: ok');
