import assert from 'node:assert/strict';
import {getEffectiveMoveAccuracy} from '../accuracy';
import {calculateActionFacts} from '../calc-adapter';
import {deriveMoveResolution} from '../move-engine';
import {deriveSwitchEntryResolution} from '../entry-hazards';
import {BattleState, MoveAction} from '../model';
import {getActionOrderFacts} from '../order';
import {scoreStatusAction} from '../status';

function makeState(weather: BattleState['field']['weather'] = 'Sand'): BattleState {
  return {
    generation: 8,
    mode: 'Singles',
    turn: 1,
    field: {weather},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Pikachu', level: 100, hp: {current: 100, max: 100},
        moves: [{name: 'Tackle'}],
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Pikachu', level: 100, hp: {current: 100, max: 100},
        moves: [{name: 'Tackle'}],
      }]},
    },
  };
}

function action(): MoveAction {
  return {kind: 'move', actorId: 'ai-1', moveName: 'Tackle', targetIds: ['player-1']};
}

function withGeneration(state: BattleState, generation: BattleState['generation']): BattleState {
  return {...state, generation};
}

const lens = makeState();
lens.sides.ai.party[0].item = 'Wide Lens';
assert.equal(getEffectiveMoveAccuracy(lens, action(), 80).accuracy, 88);
lens.field.magicRoom = true;
assert.equal(getEffectiveMoveAccuracy(lens, action(), 80).accuracy, 80);

const klutzLens = makeState();
klutzLens.sides.ai.party[0].item = 'Wide Lens';
klutzLens.sides.ai.party[0].ability = 'Klutz';
assert.equal(getEffectiveMoveAccuracy(klutzLens, action(), 80).accuracy, 80);

const embargoLens = makeState();
embargoLens.sides.ai.party[0].item = 'Wide Lens';
embargoLens.sides.ai.party[0].volatile = {embargo: {turns: 3}};
assert.equal(getEffectiveMoveAccuracy(embargoLens, action(), 80).accuracy, 80);

const noGuardGen3 = makeState();
noGuardGen3.generation = 3;
noGuardGen3.sides.ai.party[0].ability = 'No Guard';
assert.equal(getEffectiveMoveAccuracy(noGuardGen3, action(), 80).accuracy, 80);
const noGuardGen4 = withGeneration(noGuardGen3, 4);
assert.equal(getEffectiveMoveAccuracy(noGuardGen4, action(), 80).accuracy, true);

const lightClay = makeState();
lightClay.sides.ai.party[0].item = 'Light Clay';
const lightClayScreen = deriveMoveResolution(lightClay, {
  kind: 'move', actorId: 'ai-1', moveName: 'Reflect', targetIds: ['ai-1'],
}, {hit: true});
assert.equal(lightClayScreen.sideEffectDurationsBySide?.ai?.reflect, 8);
const lightClayGen3 = withGeneration(lightClay, 3);
assert.equal(deriveMoveResolution(lightClayGen3, {
  kind: 'move', actorId: 'ai-1', moveName: 'Reflect', targetIds: ['ai-1'],
}, {hit: true}).sideEffectDurationsBySide?.ai?.reflect, 5);

const heatRock = makeState();
heatRock.sides.ai.party[0].item = 'Heat Rock';
const heatRockWeather = deriveMoveResolution(heatRock, {
  kind: 'move', actorId: 'ai-1', moveName: 'Sunny Day', targetIds: ['ai-1'],
}, {hit: true});
assert.equal(heatRockWeather.fieldDurations?.weather, 8);

const terrainExtender = makeState();
terrainExtender.sides.ai.party[0].item = 'Terrain Extender';
const terrainExtenderField = deriveMoveResolution(terrainExtender, {
  kind: 'move', actorId: 'ai-1', moveName: 'Electric Terrain', targetIds: ['ai-1'],
}, {hit: true});
assert.equal(terrainExtenderField.fieldDurations?.terrain, 8);

const repeatedTerrain = makeState();
repeatedTerrain.field.terrain = 'Electric';
const repeatedTerrainResolution = deriveMoveResolution(repeatedTerrain, {
  kind: 'move', actorId: 'ai-1', moveName: 'Electric Terrain', targetIds: ['ai-1'],
}, {hit: true});
assert.equal(repeatedTerrainResolution.hit, false);
assert.equal(repeatedTerrainResolution.field, undefined);
assert.deepEqual(scoreStatusAction(repeatedTerrain, {
  action: {kind: 'move', actorId: 'ai-1', moveName: 'Electric Terrain', targetIds: ['ai-1']},
  facts: {moveCategory: 'Status'}, outcomes: [], reasons: [],
}).outcomes, [{score: -20, probability: 1}]);

const repeatedRain = makeState('Rain');
const repeatedRainResolution = deriveMoveResolution(repeatedRain, {
  kind: 'move', actorId: 'ai-1', moveName: 'Rain Dance', targetIds: ['ai-1'],
}, {hit: true});
assert.equal(repeatedRainResolution.hit, false);
assert.equal(repeatedRainResolution.field, undefined);

for (const strongWeather of ['Harsh Sunshine', 'Heavy Rain', 'Strong Winds'] as const) {
  const strongWeatherState = makeState(strongWeather);
  const setter = strongWeather === 'Harsh Sunshine' ? 'Sunny Day' : 'Rain Dance';
  const strongWeatherResolution = deriveMoveResolution(strongWeatherState, {
    kind: 'move', actorId: 'ai-1', moveName: setter, targetIds: ['ai-1'],
  }, {hit: true});
  assert.equal(strongWeatherResolution.hit, false);
  assert.equal(strongWeatherResolution.field, undefined);
}

const strongWeatherEntry = makeState('Harsh Sunshine');
strongWeatherEntry.sides.ai.party.push({
  id: 'ai-2', species: 'Pikachu', level: 100, hp: {current: 100, max: 100}, moves: [], ability: 'Drought',
});
const strongWeatherEntryResolution = deriveSwitchEntryResolution(strongWeatherEntry, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2',
});
assert.equal(strongWeatherEntryResolution.field, undefined);

const repeatedRainGen2 = withGeneration(repeatedRain, 2);
const repeatedRainGen2Resolution = deriveMoveResolution(repeatedRainGen2, {
  kind: 'move', actorId: 'ai-1', moveName: 'Rain Dance', targetIds: ['ai-1'],
}, {hit: true});
assert.equal(repeatedRainGen2Resolution.hit, true);
assert.equal(repeatedRainGen2Resolution.fieldDurations?.weather, 5);

const repeatedSandGen2 = makeState('Sand');
repeatedSandGen2.generation = 2;
assert.equal(deriveMoveResolution(repeatedSandGen2, {
  kind: 'move', actorId: 'ai-1', moveName: 'Sandstorm', targetIds: ['ai-1'],
}, {hit: true}).hit, false);

const strongSunOrder = makeState('Harsh Sunshine');
strongSunOrder.sides.ai.party[0].ability = 'Chlorophyll';
assert.equal(getActionOrderFacts(strongSunOrder, action()).speed,
  getActionOrderFacts(makeState('Sun'), action()).speed * 2);
const strongRainOrder = makeState('Heavy Rain');
strongRainOrder.sides.ai.party[0].ability = 'Swift Swim';
assert.equal(getActionOrderFacts(strongRainOrder, action()).speed,
  getActionOrderFacts(makeState('Rain'), action()).speed * 2);

const seedSowerTerrainExtender = makeState();
seedSowerTerrainExtender.generation = 9;
seedSowerTerrainExtender.sides.player.party[0].ability = 'Seed Sower';
seedSowerTerrainExtender.sides.player.party[0].item = 'Terrain Extender';
const seedSowerAction: MoveAction = {
  kind: 'move', actorId: 'ai-1', moveName: 'Tackle', targetIds: ['player-1'],
};
const seedSowerFacts = calculateActionFacts(seedSowerTerrainExtender, seedSowerAction);
const seedSowerTerrain = deriveMoveResolution(seedSowerTerrainExtender, seedSowerAction, {
  hit: true, facts: seedSowerFacts,
});
assert.equal(seedSowerTerrain.fieldDurations?.terrain, 8);

const seedSowerAttackerExtender = makeState();
seedSowerAttackerExtender.generation = 9;
seedSowerAttackerExtender.sides.ai.party[0].item = 'Terrain Extender';
seedSowerAttackerExtender.sides.player.party[0].ability = 'Seed Sower';
const seedSowerAttackerFacts = calculateActionFacts(seedSowerAttackerExtender, seedSowerAction);
assert.equal(deriveMoveResolution(seedSowerAttackerExtender, seedSowerAction, {
  hit: true, facts: seedSowerAttackerFacts,
}).fieldDurations?.terrain, 5);

const seedSowerMagicRoom = makeState();
seedSowerMagicRoom.generation = 9;
seedSowerMagicRoom.field.magicRoom = true;
seedSowerMagicRoom.sides.player.party[0].ability = 'Seed Sower';
seedSowerMagicRoom.sides.player.party[0].item = 'Terrain Extender';
const seedSowerMagicRoomFacts = calculateActionFacts(seedSowerMagicRoom, seedSowerAction);
assert.equal(deriveMoveResolution(seedSowerMagicRoom, seedSowerAction, {
  hit: true, facts: seedSowerMagicRoomFacts,
}).fieldDurations?.terrain, 5);

const repeatedSeedSower = makeState();
repeatedSeedSower.generation = 9;
repeatedSeedSower.field.terrain = 'Grassy';
repeatedSeedSower.field.durations = {terrain: 2};
repeatedSeedSower.sides.player.party[0].ability = 'Seed Sower';
const repeatedSeedSowerFacts = calculateActionFacts(repeatedSeedSower, seedSowerAction);
const repeatedSeedSowerResolution = deriveMoveResolution(repeatedSeedSower, seedSowerAction, {
  hit: true, facts: repeatedSeedSowerFacts,
});
assert.equal(repeatedSeedSowerResolution.field, undefined);
assert.equal(repeatedSeedSowerResolution.fieldDurations, undefined);

const compoundEyesGen2 = makeState();
compoundEyesGen2.generation = 2;
compoundEyesGen2.sides.ai.party[0].ability = 'Compound Eyes';
assert.equal(getEffectiveMoveAccuracy(compoundEyesGen2, action(), 80).accuracy, 80);
const compoundEyesGen3 = withGeneration(compoundEyesGen2, 3);
assert.equal(getEffectiveMoveAccuracy(compoundEyesGen3, action(), 80).accuracy, 100);

const victoryStarGen4 = makeState();
victoryStarGen4.generation = 4;
victoryStarGen4.sides.ai.party[0].ability = 'Victory Star';
assert.equal(getEffectiveMoveAccuracy(victoryStarGen4, action(), 80).accuracy, 80);
const victoryStarGen5 = withGeneration(victoryStarGen4, 5);
assert.equal(getEffectiveMoveAccuracy(victoryStarGen5, action(), 80).accuracy, 88);

const sandVeilGen2 = makeState();
sandVeilGen2.generation = 2;
sandVeilGen2.sides.player.party[0].ability = 'Sand Veil';
assert.equal(getEffectiveMoveAccuracy(sandVeilGen2, action(), 80).accuracy, 80);
const sandVeilGen3 = withGeneration(sandVeilGen2, 3);
assert.equal(getEffectiveMoveAccuracy(sandVeilGen3, action(), 80).accuracy, 64);

const brightPowderGen1 = makeState();
brightPowderGen1.generation = 1;
brightPowderGen1.sides.player.party[0].item = 'Bright Powder';
assert.equal(getEffectiveMoveAccuracy(brightPowderGen1, action(), 80).accuracy, 80);
const brightPowderGen2 = withGeneration(brightPowderGen1, 2);
assert.equal(getEffectiveMoveAccuracy(brightPowderGen2, action(), 80).accuracy, 72);

const veil = makeState();
veil.sides.player.party[0].ability = 'Sand Veil';
assert.equal(getEffectiveMoveAccuracy(veil, action(), 80).accuracy, 64);
veil.sides.ai.party[0].ability = 'Cloud Nine';
assert.equal(getEffectiveMoveAccuracy(veil, action(), 80).accuracy, 80);
const keenEyeAccuracy = makeState();
keenEyeAccuracy.sides.ai.party[0].ability = 'Keen Eye';
keenEyeAccuracy.sides.player.party[0].boosts = {eva: 2};
keenEyeAccuracy.sides.player.party[0].item = 'Bright Powder';
assert.equal(getEffectiveMoveAccuracy(keenEyeAccuracy, action(), 80).accuracy, 80);
const keenEyeGen2 = withGeneration(keenEyeAccuracy, 2);
assert.equal(getEffectiveMoveAccuracy(keenEyeGen2, action(), 80).accuracy, 80 * (3 / 5) * 0.9);
const mindsEyeGen8 = makeState();
mindsEyeGen8.sides.ai.party[0].ability = "Mind's Eye";
mindsEyeGen8.sides.player.party[0].boosts = {eva: 2};
assert.equal(getEffectiveMoveAccuracy(mindsEyeGen8, action(), 80).accuracy, 80 * (3 / 5));
const mindsEyeGen9 = withGeneration(mindsEyeGen8, 9);
assert.equal(getEffectiveMoveAccuracy(mindsEyeGen9, action(), 80).accuracy, 80);

function statusAction(): MoveAction {
  return {kind: 'move', actorId: 'ai-1', moveName: 'Thunder Wave', targetIds: ['player-1']};
}

const wonderSkin = makeState();
wonderSkin.generation = 5;
wonderSkin.sides.ai.party[0].moves = [{name: 'Thunder Wave'}];
wonderSkin.sides.player.party[0].ability = 'Wonder Skin';
assert.equal(getEffectiveMoveAccuracy(wonderSkin, statusAction(), 100, 'Status').accuracy, 50);
assert.ok(getEffectiveMoveAccuracy(wonderSkin, statusAction(), 100, 'Status').modifiers.includes('Wonder Skin'));
assert.equal(getEffectiveMoveAccuracy(wonderSkin, statusAction(), 40, 'Status').accuracy, 40);
assert.equal(getEffectiveMoveAccuracy(wonderSkin, action(), 100, 'Physical').accuracy, 100);
const wonderSkinGen4 = withGeneration(wonderSkin, 4);
assert.equal(getEffectiveMoveAccuracy(wonderSkinGen4, statusAction(), 100, 'Status').accuracy, 100);
const wonderSkinMoldBreaker = {...wonderSkin, sides: {...wonderSkin.sides,
  ai: {...wonderSkin.sides.ai, party: wonderSkin.sides.ai.party.map(pokemon => ({
    ...pokemon, ability: 'Mold Breaker',
  }))},
}};
assert.equal(
  getEffectiveMoveAccuracy(wonderSkinMoldBreaker, statusAction(), 100, 'Status').accuracy,
  100,
);

const illuminateGen8 = makeState();
illuminateGen8.generation = 8;
illuminateGen8.sides.ai.party[0].ability = 'Illuminate';
illuminateGen8.sides.player.party[0].boosts = {eva: 2};
assert.equal(getEffectiveMoveAccuracy(illuminateGen8, action(), 80).accuracy, 80 * (3 / 5));
const illuminateGen9 = withGeneration(illuminateGen8, 9);
assert.equal(getEffectiveMoveAccuracy(illuminateGen9, action(), 80).accuracy, 80);

const sandVeilMoldBreaker = makeState('Sand');
sandVeilMoldBreaker.sides.player.party[0].ability = 'Sand Veil';
assert.equal(getEffectiveMoveAccuracy(sandVeilMoldBreaker, action(), 80).accuracy, 64);
sandVeilMoldBreaker.sides.ai.party[0].ability = 'Mold Breaker';
assert.equal(getEffectiveMoveAccuracy(sandVeilMoldBreaker, action(), 80).accuracy, 80);

const swimmer = makeState('Rain');
swimmer.sides.ai.party[0].ability = 'Swift Swim';
const normalSpeed = getActionOrderFacts(makeState('Rain'), action()).speed;
assert.equal(getActionOrderFacts(swimmer, action()).speed, normalSpeed * 2);
swimmer.sides.player.party[0].ability = 'Air Lock';
assert.equal(getActionOrderFacts(swimmer, action()).speed, normalSpeed);

function makeFlowerState(cloudNine: boolean): BattleState {
  const state = makeState('Sun');
  state.mode = 'Doubles';
  state.sides.ai.activeIds = ['ai-1', 'ai-2'];
  state.sides.ai.party.push({
    id: 'ai-2', species: 'Pikachu', level: 100, hp: {current: 100, max: 100},
    moves: [], ability: 'Flower Gift',
  });
  state.sides.player.activeIds = ['player-1', 'player-2'];
  state.sides.player.party.push({
    id: 'player-2', species: 'Pikachu', level: 100, hp: {current: 100, max: 100},
    moves: [], ability: cloudNine ? 'Cloud Nine' : undefined,
  });
  return state;
}

const flowerBase = makeState('Sun');
flowerBase.mode = 'Doubles';
flowerBase.sides.ai.activeIds = ['ai-1', 'ai-2'];
flowerBase.sides.ai.party.push({
  id: 'ai-2', species: 'Pikachu', level: 100, hp: {current: 100, max: 100}, moves: [],
});
flowerBase.sides.player.activeIds = ['player-1', 'player-2'];
flowerBase.sides.player.party.push({
  id: 'player-2', species: 'Pikachu', level: 100, hp: {current: 100, max: 100}, moves: [],
});
const flowerAction = {...action(), targetIds: ['player-1']};
const baseDamage = calculateActionFacts(flowerBase, flowerAction).damage!.max;
const flowerDamage = calculateActionFacts(makeFlowerState(false), flowerAction).damage!.max;
const suppressedFlowerDamage = calculateActionFacts(makeFlowerState(true), flowerAction).damage!.max;
assert.ok(flowerDamage > baseDamage);
assert.equal(suppressedFlowerDamage, baseDamage);
console.log('Weather fixtures passed');
