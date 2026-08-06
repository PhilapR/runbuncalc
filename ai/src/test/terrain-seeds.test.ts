import assert from 'node:assert/strict';
import {deriveSwitchEntryResolution} from '../entry-hazards';
import {deriveMoveResolution} from '../move-engine';
import {BattleState, MoveAction, SwitchAction} from '../model';
import {applyAction, applySwitchAction} from '../transition';

function state(): BattleState {
  return {
    generation: 9,
    mode: 'Singles',
    turn: 1,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [
        {id: 'ai-1', species: 'Pikachu', level: 100, hp: {current: 100, max: 100}, moves: [{name: 'Electric Terrain'}]},
        {id: 'ai-2', species: 'Bulbasaur', level: 100, hp: {current: 100, max: 100}, moves: []},
      ]},
      player: {activeIds: ['player-1'], party: [
        {id: 'player-1', species: 'Rattata', level: 100, hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}]},
      ]},
    },
  };
}

const terrainMove: MoveAction = {
  kind: 'move', actorId: 'ai-1', moveName: 'Electric Terrain', targetIds: ['player-1'],
};

const moveSeed = state();
moveSeed.sides.ai.party[0].item = 'Electric Seed';
const moveSeedResolution = deriveMoveResolution(moveSeed, terrainMove, {hit: true});
assert.equal(moveSeedResolution.field?.terrain, 'Electric');
assert.equal(moveSeedResolution.boostsByPokemon?.['ai-1']?.def, 1);
assert.equal(moveSeedResolution.itemByPokemon?.['ai-1'], null);
assert.equal(moveSeedResolution.consumedItemByPokemon?.['ai-1'], 'Electric Seed');
const moveSeedApplied = applyAction(moveSeed, terrainMove, moveSeedResolution);
assert.equal(moveSeedApplied.sides.ai.party[0].boosts?.def, 1);
assert.equal(moveSeedApplied.sides.ai.party[0].item, undefined);
assert.equal(moveSeedApplied.sides.ai.party[0].lastConsumedItem, 'Electric Seed');

const existingTerrain = state();
existingTerrain.field.terrain = 'Psychic';
existingTerrain.sides.ai.party[1].item = 'Psychic Seed';
const existingTerrainAction: SwitchAction = {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2',
};
const existingTerrainResolution = deriveSwitchEntryResolution(existingTerrain, existingTerrainAction);
assert.equal(existingTerrainResolution.boostsByPokemon?.['ai-2']?.spd, 1);
assert.equal(existingTerrainResolution.itemByPokemon?.['ai-2'], null);
assert.equal(existingTerrainResolution.consumedItemByPokemon?.['ai-2'], 'Psychic Seed');
const existingTerrainApplied = applySwitchAction(existingTerrain, existingTerrainAction);
assert.equal(existingTerrainApplied.sides.ai.party[1].boosts?.spd, 1);
assert.equal(existingTerrainApplied.sides.ai.party[1].item, undefined);
assert.equal(existingTerrainApplied.sides.ai.party[1].lastConsumedItem, 'Psychic Seed');

const surgeEntry = state();
surgeEntry.sides.ai.party[1].ability = 'Electric Surge';
surgeEntry.sides.ai.party[1].item = 'Electric Seed';
const surgeEntryResolution = deriveSwitchEntryResolution(surgeEntry, existingTerrainAction);
assert.equal(surgeEntryResolution.field?.terrain, 'Electric');
assert.equal(surgeEntryResolution.boostsByPokemon?.['ai-2']?.def, 1);
assert.equal(surgeEntryResolution.itemByPokemon?.['ai-2'], null);

const simpleSeed = state();
simpleSeed.sides.ai.party[0].item = 'Grassy Seed';
simpleSeed.sides.ai.party[0].ability = 'Simple';
const simpleTerrainResolution = deriveMoveResolution(simpleSeed, {
  ...terrainMove, moveName: 'Grassy Terrain',
}, {hit: true});
assert.equal(simpleTerrainResolution.boostsByPokemon?.['ai-1']?.def, 2);

const contrarySeed = state();
contrarySeed.sides.ai.party[0].item = 'Misty Seed';
contrarySeed.sides.ai.party[0].ability = 'Contrary';
const contraryTerrainResolution = deriveMoveResolution(contrarySeed, {
  ...terrainMove, moveName: 'Misty Terrain',
}, {hit: true});
assert.equal(contraryTerrainResolution.boostsByPokemon?.['ai-1']?.spd, -1);

const oldGeneration = state();
oldGeneration.generation = 6;
oldGeneration.sides.ai.party[0].item = 'Electric Seed';
assert.equal(deriveMoveResolution(oldGeneration, terrainMove, {hit: true}).itemByPokemon, undefined);

const magicRoom = state();
magicRoom.field.magicRoom = true;
magicRoom.sides.ai.party[0].item = 'Electric Seed';
assert.equal(deriveMoveResolution(magicRoom, terrainMove, {hit: true}).itemByPokemon, undefined);

console.log('Terrain Seed fixtures passed');
