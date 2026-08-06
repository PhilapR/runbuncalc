import assert from 'node:assert/strict';
import {applyEndTurnResolution, deriveEndTurnResolution} from '../end-turn';
import {getEffectiveTypes} from '../eligibility';
import {BattleState} from '../model';
import {applySwitchAction, beginNextTurn} from '../transition';
import {deriveSwitchEntryResolution} from '../entry-hazards';

function makeState(weather: BattleState['field']['weather']): BattleState {
  return {
    generation: 8,
    mode: 'Singles',
    turn: 1,
    field: {weather},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Pikachu', level: 100, hp: {current: 100, max: 100}, moves: [],
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Pikachu', level: 100, hp: {current: 100, max: 100}, moves: [],
      }]},
    },
  };
}

const cloudNine = makeState('Sand');
cloudNine.sides.ai.party[0].ability = 'Cloud Nine';
assert.equal(deriveEndTurnResolution(cloudNine).hpDeltaByPokemon, undefined);

const airLock = makeState('Sand');
airLock.sides.ai.party[0].ability = 'Air Lock';
assert.equal(deriveEndTurnResolution(airLock).hpDeltaByPokemon, undefined);
const cloudNineGen2 = {...cloudNine, generation: 2 as BattleState['generation']};
assert.equal(deriveEndTurnResolution(cloudNineGen2).hpDeltaByPokemon?.['ai-1'], -12);
const cloudNineGen3 = {...cloudNine, generation: 3 as BattleState['generation']};
assert.equal(deriveEndTurnResolution(cloudNineGen3).hpDeltaByPokemon, undefined);

const goggles = makeState('Sand');
goggles.sides.player.party[0].item = 'Safety Goggles';
assert.equal(deriveEndTurnResolution(goggles).hpDeltaByPokemon?.['player-1'], undefined);
assert.equal(deriveEndTurnResolution(goggles).hpDeltaByPokemon?.['ai-1'], -6);

const sandGen1 = {...goggles, generation: 1 as BattleState['generation'], sides: {...goggles.sides,
  player: {...goggles.sides.player, party: goggles.sides.player.party.map(pokemon => ({
    ...pokemon, item: undefined,
  }))},
}};
assert.equal(deriveEndTurnResolution(sandGen1).hpDeltaByPokemon?.['player-1'], undefined);
const sandGen2 = {...sandGen1, generation: 2 as BattleState['generation']};
assert.equal(deriveEndTurnResolution(sandGen2).hpDeltaByPokemon?.['player-1'], -12);
const sandGen3 = {...sandGen1, generation: 3 as BattleState['generation']};
assert.equal(deriveEndTurnResolution(sandGen3).hpDeltaByPokemon?.['player-1'], -6);
const hailGen2 = {...sandGen1, generation: 2 as BattleState['generation'], field: {weather: 'Hail' as const}};
assert.equal(deriveEndTurnResolution(hailGen2).hpDeltaByPokemon?.['player-1'], undefined);
const hailGen3 = {...hailGen2, generation: 3 as BattleState['generation']};
assert.equal(deriveEndTurnResolution(hailGen3).hpDeltaByPokemon?.['player-1'], -6);
const forecastRain = makeState('Rain');
forecastRain.sides.player.party[0] = {
  ...forecastRain.sides.player.party[0], species: 'Castform', ability: 'Forecast',
};
assert.deepEqual(getEffectiveTypes(forecastRain, 'player-1'), ['Water']);
assert.equal(deriveEndTurnResolution(forecastRain).speciesOverrideByPokemon?.['player-1'], 'Castform-Rainy');
const forecastRainApplied = applyEndTurnResolution(forecastRain, deriveEndTurnResolution(forecastRain));
assert.equal(forecastRainApplied.sides.player.party[0].speciesOverride, 'Castform-Rainy');
const forecastClear = {...forecastRainApplied, field: {weather: undefined}};
assert.deepEqual(getEffectiveTypes(forecastClear, 'player-1'), ['Normal']);
assert.equal(deriveEndTurnResolution(forecastClear).speciesOverrideByPokemon?.['player-1'], null);
const forecastExpiry = {...forecastRainApplied, field: {weather: 'Rain' as const, durations: {weather: 1}}};
assert.equal(beginNextTurn(forecastExpiry).field.weather, undefined);
assert.equal(beginNextTurn(forecastExpiry).sides.player.party[0].speciesOverride, undefined);
const forecastAfterSuppressionSwitch = makeState('Rain');
forecastAfterSuppressionSwitch.sides.player.party[0].ability = 'Cloud Nine';
forecastAfterSuppressionSwitch.sides.player.party.push({
  id: 'player-2', species: 'Castform', level: 100, hp: {current: 100, max: 100}, moves: [], ability: 'Forecast',
});
const forecastAfterSuppressionEntry = deriveSwitchEntryResolution(forecastAfterSuppressionSwitch, {
  kind: 'switch', actorId: 'player-1', replacementId: 'player-2',
});
assert.equal(forecastAfterSuppressionEntry.speciesOverrideByPokemon?.['player-2'], 'Castform-Rainy');
const flowerGift = makeState('Sun');
flowerGift.sides.player.party[0] = {
  ...flowerGift.sides.player.party[0], species: 'Cherrim', ability: 'Flower Gift',
};
assert.equal(deriveEndTurnResolution(flowerGift).speciesOverrideByPokemon?.['player-1'], 'Cherrim-Sunshine');
const flowerGiftClear = {...flowerGift, sides: {...flowerGift.sides,
  player: {...flowerGift.sides.player, party: flowerGift.sides.player.party.map(pokemon => ({
    ...pokemon, speciesOverride: 'Cherrim-Sunshine',
  }))},
}, field: {weather: 'Rain' as const}};
assert.equal(deriveEndTurnResolution(flowerGiftClear).speciesOverrideByPokemon?.['player-1'], null);
const iceFaceRestore = makeState('Hail');
iceFaceRestore.sides.player.party[0].species = 'Eiscue';
iceFaceRestore.sides.player.party[0].ability = 'Ice Face';
iceFaceRestore.sides.player.party[0].speciesOverride = 'Eiscue-Noice';
const iceFaceRestoreResolution = deriveEndTurnResolution(iceFaceRestore);
assert.equal(iceFaceRestoreResolution.speciesOverrideByPokemon?.['player-1'], null);
assert.equal(applyEndTurnResolution(iceFaceRestore, iceFaceRestoreResolution)
  .sides.player.party[0].speciesOverride, undefined);
const iceFaceRestoreGen9 = {...iceFaceRestore, generation: 9 as const, field: {weather: 'Snow' as const}};
assert.equal(deriveEndTurnResolution(iceFaceRestoreGen9).speciesOverrideByPokemon?.['player-1'], null);
const iceFaceNoRestore = {...iceFaceRestore, field: {weather: 'Sun' as const}};
assert.equal(deriveEndTurnResolution(iceFaceNoRestore).speciesOverrideByPokemon, undefined);

const schooling = makeState(undefined);
schooling.generation = 7;
schooling.sides.player.party[0] = {
  ...schooling.sides.player.party[0], species: 'Wishiwashi', level: 100,
  ability: 'Schooling', hp: {current: 25, max: 100},
};
assert.equal(deriveEndTurnResolution(schooling).speciesOverrideByPokemon, undefined);
schooling.sides.player.party[0].hp = {current: 26, max: 100};
assert.equal(deriveEndTurnResolution(schooling).speciesOverrideByPokemon?.['player-1'], 'Wishiwashi-School');
const schoolingSolo = {...schooling, sides: {...schooling.sides,
  player: {...schooling.sides.player, party: schooling.sides.player.party.map(pokemon => ({
    ...pokemon, hp: {current: 25, max: 100}, speciesOverride: 'Wishiwashi-School',
  }))},
}};
assert.equal(deriveEndTurnResolution(schoolingSolo).speciesOverrideByPokemon?.['player-1'], null);

const shieldsDown = makeState(undefined);
shieldsDown.generation = 7;
shieldsDown.sides.player.party[0] = {
  ...shieldsDown.sides.player.party[0], species: 'Minior', ability: 'Shields Down',
  hp: {current: 51, max: 100},
};
assert.equal(deriveEndTurnResolution(shieldsDown).speciesOverrideByPokemon?.['player-1'], 'Minior-Meteor');
const shieldsDownCore = {...shieldsDown, sides: {...shieldsDown.sides,
  player: {...shieldsDown.sides.player, party: shieldsDown.sides.player.party.map(pokemon => ({
    ...pokemon, hp: {current: 50, max: 100}, speciesOverride: 'Minior-Meteor',
  }))},
}};
assert.equal(deriveEndTurnResolution(shieldsDownCore).speciesOverrideByPokemon?.['player-1'], null);

const zenMode = makeState(undefined);
zenMode.generation = 8;
zenMode.sides.player.party[0] = {
  ...zenMode.sides.player.party[0], species: 'Darmanitan-Galar', ability: 'Zen Mode',
  hp: {current: 50, max: 100},
};
assert.equal(deriveEndTurnResolution(zenMode).speciesOverrideByPokemon?.['player-1'], 'Darmanitan-Galar-Zen');

const powerConstruct = makeState(undefined);
powerConstruct.generation = 7;
powerConstruct.sides.player.party[0] = {
  ...powerConstruct.sides.player.party[0], species: 'Zygarde-10%', ability: 'Power Construct',
  hp: {current: 50, max: 100},
};
assert.equal(deriveEndTurnResolution(powerConstruct).speciesOverrideByPokemon?.['player-1'], 'Zygarde-Complete');
const hungerSwitch = makeState(undefined);
hungerSwitch.generation = 8;
hungerSwitch.sides.player.party[0] = {
  ...hungerSwitch.sides.player.party[0], species: 'Morpeko', ability: 'Hunger Switch',
};
assert.equal(deriveEndTurnResolution(hungerSwitch).speciesOverrideByPokemon?.['player-1'], 'Morpeko-Hangry');
const hungerSwitchBack = {...hungerSwitch, sides: {...hungerSwitch.sides,
  player: {...hungerSwitch.sides.player, party: hungerSwitch.sides.player.party.map(pokemon => ({
    ...pokemon, speciesOverride: 'Morpeko-Hangry',
  }))},
}};
assert.equal(deriveEndTurnResolution(hungerSwitchBack).speciesOverrideByPokemon?.['player-1'], 'Morpeko');
const overcoatGen4 = {...sandGen3, generation: 4 as BattleState['generation'], sides: {...sandGen3.sides,
  player: {...sandGen3.sides.player, party: sandGen3.sides.player.party.map(pokemon => ({
    ...pokemon, ability: 'Overcoat',
  }))},
}};
assert.equal(deriveEndTurnResolution(overcoatGen4).hpDeltaByPokemon?.['player-1'], -6);
const overcoatGen5 = {...overcoatGen4, generation: 5 as BattleState['generation']};
assert.equal(deriveEndTurnResolution(overcoatGen5).hpDeltaByPokemon?.['player-1'], undefined);

const magicRoomGoggles = makeState('Sand');
magicRoomGoggles.field.magicRoom = true;
magicRoomGoggles.sides.player.party[0].item = 'Safety Goggles';
assert.equal(deriveEndTurnResolution(magicRoomGoggles).hpDeltaByPokemon?.['player-1'], -6);

const delayedWish = makeState(undefined);
delayedWish.sides.player.party[0].hp = {current: 50, max: 100};
delayedWish.delayedMoves = [{
  id: 'delayed-wish', moveName: 'Wish', sourceId: 'ai-1', targetIds: ['player-1'], turns: 1,
  targetSlotsByTarget: {'player-1': 0}, damageByTarget: {},
  healingByTarget: {'player-1': {numerator: 1, denominator: 2}},
}];
assert.equal(deriveEndTurnResolution(delayedWish).hpDeltaByPokemon?.['player-1'], 50);
const delayedWishBlocked = {...delayedWish, sides: {
  ...delayedWish.sides,
  player: {...delayedWish.sides.player, party: delayedWish.sides.player.party.map(pokemon => ({
    ...pokemon, volatile: {healBlock: {turns: 2}},
  }))},
}};
assert.equal(deriveEndTurnResolution(delayedWishBlocked).hpDeltaByPokemon, undefined);

const klutzGoggles = makeState('Sand');
klutzGoggles.sides.player.party[0].item = 'Safety Goggles';
klutzGoggles.sides.player.party[0].ability = 'Klutz';
assert.equal(deriveEndTurnResolution(klutzGoggles).hpDeltaByPokemon?.['player-1'], -6);

const stickyBarb = makeState(undefined);
stickyBarb.sides.player.party[0].item = 'Sticky Barb';
assert.equal(deriveEndTurnResolution(stickyBarb).hpDeltaByPokemon?.['player-1'], -12);
const stickyBarbMagicGuard = {...stickyBarb, sides: {...stickyBarb.sides,
  player: {...stickyBarb.sides.player, party: stickyBarb.sides.player.party.map(pokemon => ({
    ...pokemon, ability: 'Magic Guard',
  }))},
}};
assert.equal(deriveEndTurnResolution(stickyBarbMagicGuard).hpDeltaByPokemon, undefined);
const stickyBarbMagicRoom = {...stickyBarb, field: {magicRoom: true}};
assert.equal(deriveEndTurnResolution(stickyBarbMagicRoom).hpDeltaByPokemon, undefined);
const stickyBarbGen3 = {...stickyBarb, generation: 3 as BattleState['generation']};
assert.equal(deriveEndTurnResolution(stickyBarbGen3).hpDeltaByPokemon, undefined);
for (const [item, status] of [
  ['Cheri Berry', 'par'], ['Pecha Berry', 'tox'], ['Rawst Berry', 'brn'],
] as const) {
  const statusBerry = makeState(undefined);
  statusBerry.sides.player.party[0].item = item;
  statusBerry.sides.player.party[0].status = status;
  if (status === 'tox') statusBerry.sides.player.party[0].toxicCounter = 4;
  const statusBerryResolution = deriveEndTurnResolution(statusBerry);
  assert.equal(statusBerryResolution.statusByPokemon?.['player-1'], '');
  assert.equal(statusBerryResolution.consumedItemByPokemon?.['player-1'], item);
  assert.equal(statusBerryResolution.toxicCounterByPokemon?.['player-1'], 0);
  assert.equal(statusBerryResolution.hpDeltaByPokemon?.['player-1'], undefined);
}

const persimBerry = makeState(undefined);
persimBerry.sides.player.party[0].item = 'Persim Berry';
persimBerry.sides.player.party[0].volatile = {confusion: {turns: 2}};
assert.equal(deriveEndTurnResolution(persimBerry).volatileByPokemon?.['player-1']?.confusion, null);

const cudChewPersim = makeState(undefined);
cudChewPersim.generation = 9;
cudChewPersim.sides.player.party[0].ability = 'Cud Chew';
cudChewPersim.sides.player.party[0].volatile = {
  cudChew: {turns: 1, item: 'Persim Berry'}, confusion: {turns: 2},
};
assert.equal(deriveEndTurnResolution(cudChewPersim).volatileByPokemon?.['player-1']?.confusion, null);

const rainDish = makeState('Rain');
rainDish.sides.player.party[0].ability = 'Rain Dish';
rainDish.sides.player.party[0].hp.current = 50;
assert.equal(deriveEndTurnResolution(rainDish).hpDeltaByPokemon?.['player-1'], 6);
const rainDishGen3 = {...rainDish, generation: 3 as BattleState['generation']};
assert.equal(deriveEndTurnResolution(rainDishGen3).hpDeltaByPokemon?.['player-1'], 6);
const heavyRainDish = {...rainDish, field: {weather: 'Heavy Rain' as const}};
assert.equal(deriveEndTurnResolution(heavyRainDish).hpDeltaByPokemon?.['player-1'], 6);
const rainDishGen2 = {...rainDish, generation: 2 as BattleState['generation']};
assert.equal(deriveEndTurnResolution(rainDishGen2).hpDeltaByPokemon?.['player-1'], undefined);
rainDish.sides.ai.party[0].ability = 'Cloud Nine';
assert.equal(deriveEndTurnResolution(rainDish).hpDeltaByPokemon, undefined);

const hydration = makeState('Rain');
hydration.sides.player.party[0].ability = 'Hydration';
hydration.sides.player.party[0].status = 'brn';
assert.equal(deriveEndTurnResolution(hydration).statusByPokemon?.['player-1'], '');
const hydrationGen3 = {...hydration, generation: 3 as BattleState['generation']};
assert.equal(deriveEndTurnResolution(hydrationGen3).statusByPokemon, undefined);
const hydrationGen4 = {...hydration, generation: 4 as BattleState['generation']};
assert.equal(deriveEndTurnResolution(hydrationGen4).statusByPokemon?.['player-1'], '');
const heavyRainHydration = {...hydration, field: {weather: 'Heavy Rain' as const}};
assert.equal(deriveEndTurnResolution(heavyRainHydration).statusByPokemon?.['player-1'], '');
hydration.sides.ai.party[0].ability = 'Air Lock';
assert.equal(deriveEndTurnResolution(hydration).statusByPokemon, undefined);

const modernBurn = makeState(undefined);
modernBurn.sides.player.party[0].status = 'brn';
assert.equal(deriveEndTurnResolution(modernBurn).hpDeltaByPokemon?.['player-1'], -6);
const gen6Burn = {...modernBurn, generation: 6 as BattleState['generation']};
assert.equal(deriveEndTurnResolution(gen6Burn).hpDeltaByPokemon?.['player-1'], -12);
const gen1Burn = {...modernBurn, generation: 1 as BattleState['generation']};
assert.equal(deriveEndTurnResolution(gen1Burn).hpDeltaByPokemon?.['player-1'], -6);
const heatproofBurn = {...modernBurn, sides: {...modernBurn.sides,
  player: {...modernBurn.sides.player, party: modernBurn.sides.player.party.map(pokemon => ({
    ...pokemon, ability: 'Heatproof',
  }))},
}};
assert.equal(deriveEndTurnResolution(heatproofBurn).hpDeltaByPokemon?.['player-1'], -3);
const magicGuardGen3 = {...modernBurn, generation: 3 as BattleState['generation'], sides: {...modernBurn.sides,
  player: {...modernBurn.sides.player, party: modernBurn.sides.player.party.map(pokemon => ({
    ...pokemon, ability: 'Magic Guard',
  }))},
}};
assert.equal(deriveEndTurnResolution(magicGuardGen3).hpDeltaByPokemon?.['player-1'], -12);
const magicGuardGen4 = {...magicGuardGen3, generation: 4 as BattleState['generation']};
assert.equal(deriveEndTurnResolution(magicGuardGen4).hpDeltaByPokemon?.['player-1'], undefined);

const shedSkinGen2 = makeState(undefined);
shedSkinGen2.generation = 2;
shedSkinGen2.sides.player.party[0].ability = 'Shed Skin';
shedSkinGen2.sides.player.party[0].status = 'brn';
assert.equal(deriveEndTurnResolution(shedSkinGen2, {random: () => 0}).statusByPokemon, undefined);

const shedSkinBurn = makeState(undefined);
shedSkinBurn.sides.player.party[0].ability = 'Shed Skin';
shedSkinBurn.sides.player.party[0].status = 'brn';
assert.equal(deriveEndTurnResolution(shedSkinBurn, {random: () => 0}).statusByPokemon?.['player-1'], '');
assert.equal(deriveEndTurnResolution(shedSkinBurn, {random: () => 0}).statusTurnsByPokemon?.['player-1'], null);

const shedSkinToxic = makeState(undefined);
shedSkinToxic.sides.player.party[0].ability = 'Shed Skin';
shedSkinToxic.sides.player.party[0].status = 'tox';
shedSkinToxic.sides.player.party[0].toxicCounter = 3;
assert.equal(deriveEndTurnResolution(shedSkinToxic, {random: () => 0.5}).statusByPokemon, undefined);
const shedSkinToxicResolution = deriveEndTurnResolution(shedSkinToxic, {random: () => 0});
assert.equal(shedSkinToxicResolution.statusByPokemon?.['player-1'], '');
assert.equal(shedSkinToxicResolution.toxicCounterByPokemon?.['player-1'], 0);

const shedSkinFaint = makeState(undefined);
shedSkinFaint.sides.player.party[0].ability = 'Shed Skin';
shedSkinFaint.sides.player.party[0].status = 'brn';
shedSkinFaint.sides.player.party[0].hp.current = 1;
assert.equal(deriveEndTurnResolution(shedSkinFaint, {random: () => 0}).statusByPokemon, undefined);

const healerGen4 = makeState(undefined);
healerGen4.generation = 4;
healerGen4.mode = 'Doubles';
healerGen4.sides.ai.activeIds = ['ai-1', 'ai-2'];
healerGen4.sides.ai.party.push({
  id: 'ai-2', species: 'Pikachu', level: 100, hp: {current: 100, max: 100}, moves: [], ability: 'Healer',
});
healerGen4.sides.ai.party[0].status = 'par';
assert.equal(deriveEndTurnResolution(healerGen4, {random: () => 0}).statusByPokemon, undefined);

const healerState = {...healerGen4, generation: 5 as BattleState['generation']};
const healerResolution = deriveEndTurnResolution(healerState, {random: () => 0});
assert.equal(healerResolution.statusByPokemon?.['ai-1'], '');
assert.equal(healerResolution.statusTurnsByPokemon?.['ai-1'], null);
assert.equal(healerResolution.toxicCounterByPokemon?.['ai-1'], 0);

const healerFailed = deriveEndTurnResolution(healerState, {random: () => 0.3});
assert.equal(healerFailed.statusByPokemon, undefined);

const harvestState = makeState('Sun');
harvestState.generation = 5;
harvestState.sides.player.party[0].ability = 'Harvest';
harvestState.sides.player.party[0].lastConsumedItem = 'Sitrus Berry';
const harvestResolution = deriveEndTurnResolution(harvestState, {random: () => 0.99});
assert.equal(harvestResolution.itemByPokemon?.['player-1'], 'Sitrus Berry');
const harvested = applyEndTurnResolution(harvestState, harvestResolution);
assert.equal(harvested.sides.player.party[0].item, 'Sitrus Berry');
assert.equal(harvested.sides.player.party[0].lastConsumedItem, undefined);

const harvestCloudNine = makeState('Sun');
harvestCloudNine.generation = 5;
harvestCloudNine.sides.player.party[0].ability = 'Harvest';
harvestCloudNine.sides.player.party[0].lastConsumedItem = 'Sitrus Berry';
harvestCloudNine.sides.ai.party[0].ability = 'Cloud Nine';
assert.equal(deriveEndTurnResolution(harvestCloudNine, {random: () => 0.75}).itemByPokemon, undefined);
const harvestStrongSun = {...harvestState, field: {weather: 'Harsh Sunshine' as const}};
assert.equal(deriveEndTurnResolution(harvestStrongSun, {random: () => 0.99}).itemByPokemon?.['player-1'], 'Sitrus Berry');

const harvestFaint = {...harvestState, sides: {...harvestState.sides,
  player: {...harvestState.sides.player, party: harvestState.sides.player.party.map(pokemon => ({
    ...pokemon, hp: {...pokemon.hp, current: 1},
  }))},
}};
harvestFaint.field.weather = 'Sand';
assert.equal(deriveEndTurnResolution(harvestFaint, {random: () => 0}).itemByPokemon, undefined);

const emergencyExitResidual = makeState(undefined);
emergencyExitResidual.sides.player.party[0].ability = 'Emergency Exit';
emergencyExitResidual.sides.player.party[0].hp.current = 60;
emergencyExitResidual.sides.player.party[0].status = 'psn';
emergencyExitResidual.sides.player.party.push({
  id: 'player-2', species: 'Bulbasaur', level: 100, hp: {current: 100, max: 100}, moves: [],
});
const emergencyExitResidualResolution = deriveEndTurnResolution(emergencyExitResidual);
assert.deepEqual(emergencyExitResidualResolution.forcedSwitchByPokemon, {'player-1': true});
const emergencyExitResidualApplied = applyEndTurnResolution(emergencyExitResidual, emergencyExitResidualResolution);
assert.deepEqual(emergencyExitResidualApplied.pendingForcedSwitchIds, ['player-1']);
const emergencyExitResidualCleared = applyEndTurnResolution(emergencyExitResidualApplied, {
  forcedSwitchByPokemon: {'player-1': false},
});
assert.equal(emergencyExitResidualCleared.pendingForcedSwitchIds, undefined);
assert.throws(() => applyEndTurnResolution(emergencyExitResidual, {
  forcedSwitchByPokemon: {'player-2': true},
}), /living active/);
const emergencyExitResidualBerry = {...emergencyExitResidual, sides: {...emergencyExitResidual.sides,
  player: {...emergencyExitResidual.sides.player, party: emergencyExitResidual.sides.player.party.map(pokemon => ({
    ...pokemon, item: pokemon.id === 'player-1' ? 'Sitrus Berry' : pokemon.item,
  }))},
}};
assert.equal(deriveEndTurnResolution(emergencyExitResidualBerry).forcedSwitchByPokemon, undefined);
const emergencyExitResidualNoReplacement = {...emergencyExitResidual, sides: {...emergencyExitResidual.sides,
  player: {...emergencyExitResidual.sides.player, party: emergencyExitResidual.sides.player.party.filter(pokemon => pokemon.id !== 'player-2')},
}};
assert.equal(deriveEndTurnResolution(emergencyExitResidualNoReplacement).forcedSwitchByPokemon, undefined);
const emergencyExitResidualGen6 = {...emergencyExitResidual, generation: 6 as const};
assert.equal(deriveEndTurnResolution(emergencyExitResidualGen6).forcedSwitchByPokemon, undefined);
const emergencyExitActiveTrap = {...emergencyExitResidual, sides: {...emergencyExitResidual.sides,
  player: {...emergencyExitResidual.sides.player, party: emergencyExitResidual.sides.player.party.map(pokemon =>
    pokemon.id === 'player-1' ? {...pokemon, volatile: {trapped: {sourceId: 'ai-1'}}} : pokemon)},
}};
assert.equal(deriveEndTurnResolution(emergencyExitActiveTrap).forcedSwitchByPokemon, undefined);
const emergencyExitReleasedTrap = {...emergencyExitActiveTrap, sides: {...emergencyExitActiveTrap.sides,
  ai: {...emergencyExitActiveTrap.sides.ai, party: emergencyExitActiveTrap.sides.ai.party.map(pokemon =>
    pokemon.id === 'ai-1' ? {...pokemon, hp: {...pokemon.hp, current: 0}} : pokemon)},
}};
assert.deepEqual(deriveEndTurnResolution(emergencyExitReleasedTrap).forcedSwitchByPokemon, {'player-1': true});

const grassyGen5 = makeState(undefined);
grassyGen5.generation = 5;
grassyGen5.field.terrain = 'Grassy';
grassyGen5.sides.player.party[0].hp.current = 50;
assert.equal(deriveEndTurnResolution(grassyGen5).hpDeltaByPokemon?.['player-1'], undefined);

const grassy = makeState(undefined);
grassy.generation = 6;
grassy.field.terrain = 'Grassy';
grassy.sides.player.party[0].hp.current = 50;
assert.equal(deriveEndTurnResolution(grassy).hpDeltaByPokemon?.['player-1'], 6);

const grassyFlying = makeState(undefined);
grassyFlying.generation = 6;
grassyFlying.field.terrain = 'Grassy';
grassyFlying.sides.player.party[0].species = 'Pidgey';
grassyFlying.sides.player.party[0].hp.current = 50;
assert.equal(deriveEndTurnResolution(grassyFlying).hpDeltaByPokemon?.['player-1'], undefined);

const grassyBalloon = makeState(undefined);
grassyBalloon.generation = 6;
grassyBalloon.field.terrain = 'Grassy';
grassyBalloon.sides.player.party[0].item = 'Air Balloon';
grassyBalloon.sides.player.party[0].hp.current = 50;
assert.equal(deriveEndTurnResolution(grassyBalloon).hpDeltaByPokemon?.['player-1'], undefined);
grassyBalloon.field.magicRoom = true;
assert.equal(deriveEndTurnResolution(grassyBalloon).hpDeltaByPokemon?.['player-1'], 6);

const aquaRing = makeState(undefined);
aquaRing.sides.player.party[0].hp.current = 50;
aquaRing.sides.player.party[0].volatile = {aquaRing: {}};
assert.equal(deriveEndTurnResolution(aquaRing).hpDeltaByPokemon?.['player-1'], 6);

const ingrain = makeState(undefined);
ingrain.sides.player.party[0].hp.current = 50;
ingrain.sides.player.party[0].volatile = {ingrain: {}};
assert.equal(deriveEndTurnResolution(ingrain).hpDeltaByPokemon?.['player-1'], 6);

const leftovers = makeState(undefined);
leftovers.sides.player.party[0].item = 'Leftovers';
leftovers.sides.player.party[0].hp.current = 50;
assert.equal(deriveEndTurnResolution(leftovers).hpDeltaByPokemon?.['player-1'], 6);
leftovers.field.magicRoom = true;
assert.equal(deriveEndTurnResolution(leftovers).hpDeltaByPokemon, undefined);

const klutzLeftovers = makeState(undefined);
klutzLeftovers.sides.player.party[0].item = 'Leftovers';
klutzLeftovers.sides.player.party[0].ability = 'Klutz';
klutzLeftovers.sides.player.party[0].hp.current = 50;
assert.equal(deriveEndTurnResolution(klutzLeftovers).hpDeltaByPokemon, undefined);

const flameOrb = makeState(undefined);
flameOrb.sides.player.party[0].item = 'Flame Orb';
assert.equal(deriveEndTurnResolution(flameOrb).statusByPokemon?.['player-1'], 'brn');
flameOrb.field.magicRoom = true;
assert.equal(deriveEndTurnResolution(flameOrb).statusByPokemon, undefined);

const confusionBerry = makeState(undefined);
confusionBerry.sides.player.party[0].item = 'Aguav Berry';
confusionBerry.sides.player.party[0].hp.current = 20;
assert.equal(deriveEndTurnResolution(confusionBerry).itemByPokemon?.['player-1'], null);
confusionBerry.sides.player.party[0].ability = 'Cheek Pouch';
assert.equal(deriveEndTurnResolution(confusionBerry).hpDeltaByPokemon?.['player-1'], 83);
confusionBerry.field.magicRoom = true;
assert.equal(deriveEndTurnResolution(confusionBerry).itemByPokemon, undefined);

const dislikedConfusionBerry = makeState(undefined);
dislikedConfusionBerry.sides.player.party[0].item = 'Figy Berry';
dislikedConfusionBerry.sides.player.party[0].nature = 'Bold';
dislikedConfusionBerry.sides.player.party[0].hp.current = 20;
assert.equal(deriveEndTurnResolution(dislikedConfusionBerry, {random: () => 0})
  .volatileByPokemon?.['player-1']?.confusion?.turns, 2);
const ownTempoConfusionBerry = {...dislikedConfusionBerry, sides: {...dislikedConfusionBerry.sides,
  player: {...dislikedConfusionBerry.sides.player, party: dislikedConfusionBerry.sides.player.party.map(pokemon => ({
    ...pokemon, ability: 'Own Tempo',
  }))},
}};
assert.equal(deriveEndTurnResolution(ownTempoConfusionBerry, {random: () => 0})
  .volatileByPokemon?.['player-1']?.confusion, undefined);
const cudChewDislikedBerry = makeState(undefined);
cudChewDislikedBerry.generation = 9;
cudChewDislikedBerry.sides.player.party[0].ability = 'Cud Chew';
cudChewDislikedBerry.sides.player.party[0].nature = 'Bold';
cudChewDislikedBerry.sides.player.party[0].hp.current = 20;
cudChewDislikedBerry.sides.player.party[0].volatile = {
  cudChew: {turns: 1, item: 'Figy Berry'},
};
assert.equal(deriveEndTurnResolution(cudChewDislikedBerry, {random: () => 0})
  .volatileByPokemon?.['player-1']?.confusion?.turns, 2);

const sitrusBerry = makeState(undefined);
sitrusBerry.sides.player.party[0].item = 'Sitrus Berry';
sitrusBerry.sides.player.party[0].hp.current = 40;
const sitrusResolution = deriveEndTurnResolution(sitrusBerry);
assert.equal(sitrusResolution.hpDeltaByPokemon?.['player-1'], 25);
assert.equal(sitrusResolution.itemByPokemon?.['player-1'], null);
assert.equal(sitrusResolution.consumedItemByPokemon?.['player-1'], 'Sitrus Berry');
const sitrusNext = applyEndTurnResolution(sitrusBerry, sitrusResolution);
assert.equal(sitrusNext.sides.player.party[0].hp.current, 65);
assert.equal(sitrusNext.sides.player.party[0].lastConsumedItem, 'Sitrus Berry');
const ripenSitrus = {...sitrusBerry, sides: {...sitrusBerry.sides,
  player: {...sitrusBerry.sides.player, party: sitrusBerry.sides.player.party.map(pokemon => ({
    ...pokemon, ability: 'Ripen',
  }))},
}};
assert.equal(deriveEndTurnResolution(ripenSitrus).hpDeltaByPokemon?.['player-1'], 50);
const sitrusGen3 = {...sitrusBerry, generation: 3 as const};
assert.equal(deriveEndTurnResolution(sitrusGen3).hpDeltaByPokemon?.['player-1'], 30);
const sitrusFullEnough = {...sitrusBerry, sides: {...sitrusBerry.sides,
  player: {...sitrusBerry.sides.player, party: sitrusBerry.sides.player.party.map(pokemon => ({
    ...pokemon, hp: {...pokemon.hp, current: 51},
  }))},
}};
assert.equal(deriveEndTurnResolution(sitrusFullEnough).itemByPokemon, undefined);
const sitrusCheekPouch = {...sitrusBerry, sides: {...sitrusBerry.sides,
  player: {...sitrusBerry.sides.player, party: sitrusBerry.sides.player.party.map(pokemon => ({
    ...pokemon, ability: 'Cheek Pouch',
  }))},
}};
assert.equal(deriveEndTurnResolution(sitrusCheekPouch).hpDeltaByPokemon?.['player-1'], 58);
const healBlockedSitrus = {...sitrusCheekPouch, sides: {...sitrusCheekPouch.sides,
  player: {...sitrusCheekPouch.sides.player, party: sitrusCheekPouch.sides.player.party.map(pokemon => ({
    ...pokemon, volatile: {healBlock: {turns: 2}},
  }))},
}};
const healBlockedSitrusResolution = deriveEndTurnResolution(healBlockedSitrus);
assert.equal(healBlockedSitrusResolution.hpDeltaByPokemon, undefined);
assert.equal(healBlockedSitrusResolution.itemByPokemon?.['player-1'], null);
const healBlockedSitrusNext = applyEndTurnResolution(healBlockedSitrus, healBlockedSitrusResolution);
assert.equal(healBlockedSitrusNext.sides.player.party[0].item, undefined);
const oranBerry = makeState(undefined);
oranBerry.sides.player.party[0].item = 'Oran Berry';
oranBerry.sides.player.party[0].hp.current = 40;
assert.equal(deriveEndTurnResolution(oranBerry).hpDeltaByPokemon?.['player-1'], 10);
const ripenOran = {...oranBerry, sides: {...oranBerry.sides,
  player: {...oranBerry.sides.player, party: oranBerry.sides.player.party.map(pokemon => ({
    ...pokemon, ability: 'Ripen',
  }))},
}};
assert.equal(deriveEndTurnResolution(ripenOran).hpDeltaByPokemon?.['player-1'], 20);
const oranGen2 = {...oranBerry, generation: 2 as const};
assert.equal(deriveEndTurnResolution(oranGen2).itemByPokemon, undefined);
const berryJuice = makeState(undefined);
berryJuice.sides.player.party[0].item = 'Berry Juice';
berryJuice.sides.player.party[0].hp.current = 40;
const berryJuiceResolution = deriveEndTurnResolution(berryJuice);
assert.equal(berryJuiceResolution.hpDeltaByPokemon?.['player-1'], 20);
assert.equal(berryJuiceResolution.itemByPokemon?.['player-1'], null);
assert.equal(berryJuiceResolution.consumedItemByPokemon?.['player-1'], 'Berry Juice');
const berryJuiceGen2 = {...berryJuice, generation: 2 as const};
assert.equal(deriveEndTurnResolution(berryJuiceGen2).hpDeltaByPokemon?.['player-1'], 20);
const berryJuiceGen1 = {...berryJuice, generation: 1 as const};
assert.equal(deriveEndTurnResolution(berryJuiceGen1).itemByPokemon, undefined);
const berryJuiceMagicRoom = {...berryJuice, field: {magicRoom: true}};
assert.equal(deriveEndTurnResolution(berryJuiceMagicRoom).itemByPokemon, undefined);
const berryJuiceKlutz = {...berryJuice, sides: {...berryJuice.sides,
  player: {...berryJuice.sides.player, party: berryJuice.sides.player.party.map(pokemon => ({
    ...pokemon, ability: 'Klutz',
  }))},
}};
assert.equal(deriveEndTurnResolution(berryJuiceKlutz).itemByPokemon, undefined);
const sitrusMagicRoom = {...sitrusBerry, field: {magicRoom: true}};
assert.equal(deriveEndTurnResolution(sitrusMagicRoom).itemByPokemon, undefined);
const sitrusKlutz = {...sitrusBerry, sides: {...sitrusBerry.sides,
  player: {...sitrusBerry.sides.player, party: sitrusBerry.sides.player.party.map(pokemon => ({
    ...pokemon, ability: 'Klutz',
  }))},
}};
assert.equal(deriveEndTurnResolution(sitrusKlutz).itemByPokemon, undefined);

const cudChew = makeState(undefined);
cudChew.generation = 9;
cudChew.sides.player.party[0].ability = 'Cud Chew';
cudChew.sides.player.party[0].item = 'Sitrus Berry';
cudChew.sides.player.party[0].hp.current = 40;
const cudChewFirstResolution = deriveEndTurnResolution(cudChew);
assert.deepEqual(cudChewFirstResolution.volatileByPokemon?.['player-1']?.cudChew, {
  turns: 2, item: 'Sitrus Berry',
});
const healBlockedCudChewCapture = {...cudChew, sides: {...cudChew.sides,
  player: {...cudChew.sides.player, party: cudChew.sides.player.party.map(pokemon => ({
    ...pokemon, volatile: {healBlock: {turns: 2}},
  }))},
}};
const healBlockedCudChewCaptureResolution = deriveEndTurnResolution(healBlockedCudChewCapture);
assert.equal(healBlockedCudChewCaptureResolution.hpDeltaByPokemon, undefined);
assert.deepEqual(healBlockedCudChewCaptureResolution.volatileByPokemon?.['player-1']?.cudChew, {
  turns: 2, item: 'Sitrus Berry',
});
const cudChewAfterEating = applyEndTurnResolution(cudChew, cudChewFirstResolution);
assert.equal(cudChewAfterEating.sides.player.party[0].hp.current, 65);
assert.equal(cudChewAfterEating.sides.player.party[0].item, undefined);
const cudChewAfterFirstTimer = beginNextTurn(cudChewAfterEating);
assert.deepEqual(cudChewAfterFirstTimer.sides.player.party[0].volatile?.cudChew, {
  turns: 1, item: 'Sitrus Berry',
});
const cudChewSecondResolution = deriveEndTurnResolution(cudChewAfterFirstTimer);
assert.equal(cudChewSecondResolution.hpDeltaByPokemon?.['player-1'], 25);
assert.deepEqual(cudChewSecondResolution.volatileByPokemon?.['player-1']?.cudChew, null);
const cudChewReeaten = applyEndTurnResolution(cudChewAfterFirstTimer, cudChewSecondResolution);
assert.equal(cudChewReeaten.sides.player.party[0].hp.current, 90);
assert.equal(cudChewReeaten.sides.player.party[0].lastConsumedItem, 'Sitrus Berry');
const healBlockedCudChew = {...cudChewAfterFirstTimer, sides: {...cudChewAfterFirstTimer.sides,
  player: {...cudChewAfterFirstTimer.sides.player, party: cudChewAfterFirstTimer.sides.player.party.map(pokemon => ({
    ...pokemon, volatile: {
      healBlock: {turns: 2}, cudChew: {turns: 1, item: 'Sitrus Berry'},
    },
  }))},
}};
const healBlockedCudChewResolution = deriveEndTurnResolution(healBlockedCudChew);
assert.equal(healBlockedCudChewResolution.hpDeltaByPokemon, undefined);
assert.equal(healBlockedCudChewResolution.volatileByPokemon?.['player-1']?.cudChew, null);
const cudChewLansat = makeState(undefined);
cudChewLansat.generation = 9;
cudChewLansat.sides.player.party[0].ability = 'Cud Chew';
cudChewLansat.sides.player.party[0].volatile = {
  cudChew: {turns: 1, item: 'Lansat Berry'},
};
assert.ok(deriveEndTurnResolution(cudChewLansat).volatileByPokemon?.['player-1']?.focusEnergy);
const cudChewCheri = makeState(undefined);
cudChewCheri.generation = 9;
cudChewCheri.sides.player.party[0].ability = 'Cud Chew';
cudChewCheri.sides.player.party[0].status = 'par';
cudChewCheri.sides.player.party[0].volatile = {
  cudChew: {turns: 1, item: 'Cheri Berry'},
};
assert.equal(deriveEndTurnResolution(cudChewCheri).statusByPokemon?.['player-1'], '');

const cudChewSuppressed = {...cudChewAfterEating, sides: {...cudChewAfterEating.sides,
  player: {...cudChewAfterEating.sides.player, party: cudChewAfterEating.sides.player.party.map(pokemon => ({
    ...pokemon, abilitySuppressed: true,
  }))},
}};
const cudChewSuppressedNext = beginNextTurn(applyEndTurnResolution(
  cudChewSuppressed,
  deriveEndTurnResolution(cudChewSuppressed),
));
assert.deepEqual(cudChewSuppressedNext.sides.player.party[0].volatile?.cudChew, {
  turns: 2, item: 'Sitrus Berry',
});
const cudChewSwitchState = {...cudChewAfterEating, sides: {...cudChewAfterEating.sides,
  player: {...cudChewAfterEating.sides.player, party: [
    ...cudChewAfterEating.sides.player.party,
    {id: 'player-2', species: 'Rattata', level: 100, hp: {current: 100, max: 100}, moves: []},
  ]},
}};
const cudChewSwitched = applySwitchAction(cudChewSwitchState, {
  kind: 'switch', actorId: 'player-1', replacementId: 'player-2',
});
assert.equal(cudChewSwitched.sides.player.party[0].volatile, undefined);

const statBerryCases: Array<[string, 'atk' | 'def' | 'spa' | 'spd' | 'spe']> = [
  ['Liechi Berry', 'atk'],
  ['Ganlon Berry', 'def'],
  ['Petaya Berry', 'spa'],
  ['Apicot Berry', 'spd'],
  ['Salac Berry', 'spe'],
];
for (const [item, stat] of statBerryCases) {
  const state = makeState(undefined);
  state.sides.player.party[0].item = item;
  state.sides.player.party[0].hp.current = 25;
  const resolution = deriveEndTurnResolution(state);
  assert.deepEqual(resolution.boostsByPokemon?.['player-1'], {[stat]: 1});
  assert.equal(resolution.consumedItemByPokemon?.['player-1'], item);
  const next = applyEndTurnResolution(state, resolution);
  assert.equal(next.sides.player.party[0].item, undefined);
  assert.equal(next.sides.player.party[0].lastConsumedItem, item);
}
const statBerryAboveThreshold = makeState(undefined);
statBerryAboveThreshold.sides.player.party[0].item = 'Liechi Berry';
statBerryAboveThreshold.sides.player.party[0].hp.current = 26;
assert.equal(deriveEndTurnResolution(statBerryAboveThreshold).boostsByPokemon, undefined);
const statBerryGen2 = {...statBerryAboveThreshold, generation: 2 as const};
statBerryGen2.sides.player.party[0].hp.current = 25;
assert.equal(deriveEndTurnResolution(statBerryGen2).itemByPokemon, undefined);
const gluttonyStatBerry = makeState(undefined);
gluttonyStatBerry.sides.player.party[0].item = 'Liechi Berry';
gluttonyStatBerry.sides.player.party[0].ability = 'Gluttony';
gluttonyStatBerry.sides.player.party[0].hp.current = 50;
assert.equal(deriveEndTurnResolution(gluttonyStatBerry).boostsByPokemon?.['player-1']?.atk, 1);
const gluttonyGen3 = {...gluttonyStatBerry, generation: 3 as const};
assert.equal(deriveEndTurnResolution(gluttonyGen3).boostsByPokemon, undefined);
const simpleStatBerry = makeState(undefined);
simpleStatBerry.sides.player.party[0].item = 'Ganlon Berry';
simpleStatBerry.sides.player.party[0].ability = 'Simple';
simpleStatBerry.sides.player.party[0].hp.current = 25;
assert.equal(deriveEndTurnResolution(simpleStatBerry).boostsByPokemon?.['player-1']?.def, 2);
const ripenStatBerry = {...simpleStatBerry, sides: {...simpleStatBerry.sides,
  player: {...simpleStatBerry.sides.player, party: simpleStatBerry.sides.player.party.map(pokemon => ({
    ...pokemon, ability: 'Ripen',
  }))},
}};
assert.equal(deriveEndTurnResolution(ripenStatBerry).boostsByPokemon?.['player-1']?.def, 2);
const contraryStatBerry = {...simpleStatBerry, sides: {...simpleStatBerry.sides,
  player: {...simpleStatBerry.sides.player, party: simpleStatBerry.sides.player.party.map(pokemon => ({
    ...pokemon, ability: 'Contrary',
  }))},
}};
assert.equal(deriveEndTurnResolution(contraryStatBerry).boostsByPokemon?.['player-1']?.def, -1);
const statBerrySpeedBoost = makeState(undefined);
statBerrySpeedBoost.sides.player.party[0].item = 'Salac Berry';
statBerrySpeedBoost.sides.player.party[0].ability = 'Speed Boost';
statBerrySpeedBoost.sides.player.party[0].hp.current = 25;
assert.equal(deriveEndTurnResolution(statBerrySpeedBoost).boostsByPokemon?.['player-1']?.spe, 2);
const statBerryCheekPouch = {...statBerrySpeedBoost, sides: {...statBerrySpeedBoost.sides,
  player: {...statBerrySpeedBoost.sides.player, party: statBerrySpeedBoost.sides.player.party.map(pokemon => ({
    ...pokemon, ability: 'Cheek Pouch',
  }))},
}};
assert.equal(deriveEndTurnResolution(statBerryCheekPouch).hpDeltaByPokemon?.['player-1'], 33);
const statBerryMaxed = {...statBerryAboveThreshold, sides: {...statBerryAboveThreshold.sides,
  player: {...statBerryAboveThreshold.sides.player, party: statBerryAboveThreshold.sides.player.party.map(pokemon => ({
    ...pokemon, hp: {...pokemon.hp, current: 25}, boosts: {atk: 6},
  }))},
}};
assert.equal(deriveEndTurnResolution(statBerryMaxed).boostsByPokemon, undefined);
assert.equal(deriveEndTurnResolution(statBerryMaxed).consumedItemByPokemon?.['player-1'], 'Liechi Berry');
const statBerryMagicRoom = {...statBerryAboveThreshold, field: {magicRoom: true}};
statBerryMagicRoom.sides.player.party[0].hp.current = 25;
assert.equal(deriveEndTurnResolution(statBerryMagicRoom).itemByPokemon, undefined);
const statBerryKlutz = {...statBerryMagicRoom, field: {}, sides: {...statBerryMagicRoom.sides,
  player: {...statBerryMagicRoom.sides.player, party: statBerryMagicRoom.sides.player.party.map(pokemon => ({
    ...pokemon, ability: 'Klutz',
  }))},
}};
assert.equal(deriveEndTurnResolution(statBerryKlutz).itemByPokemon, undefined);

const speedBoost = makeState(undefined);
speedBoost.sides.player.party[0].ability = 'Speed Boost';
assert.equal(deriveEndTurnResolution(speedBoost).boostsByPokemon?.['player-1']?.spe, 1);
const speedBoostGen2 = {...speedBoost, generation: 2 as BattleState['generation']};
assert.equal(deriveEndTurnResolution(speedBoostGen2).boostsByPokemon, undefined);
const speedBoostSuppressed = {...speedBoost, sides: {...speedBoost.sides,
  player: {...speedBoost.sides.player, party: speedBoost.sides.player.party.map(pokemon => ({
    ...pokemon, abilitySuppressed: true,
  }))},
}};
assert.equal(deriveEndTurnResolution(speedBoostSuppressed).boostsByPokemon, undefined);

const badDreams = makeState(undefined);
badDreams.sides.ai.party[0].ability = 'Bad Dreams';
badDreams.sides.player.party[0].status = 'slp';
assert.equal(deriveEndTurnResolution(badDreams).hpDeltaByPokemon?.['player-1'], -12);
const badDreamsMagicGuard = {...badDreams, sides: {...badDreams.sides,
  player: {...badDreams.sides.player, party: badDreams.sides.player.party.map(pokemon => ({
    ...pokemon, ability: 'Magic Guard',
  }))},
}};
assert.equal(deriveEndTurnResolution(badDreamsMagicGuard).hpDeltaByPokemon, undefined);
const badDreamsGen3 = {...badDreams, generation: 3 as BattleState['generation']};
assert.equal(deriveEndTurnResolution(badDreamsGen3).hpDeltaByPokemon, undefined);

const nightmareResidual = makeState(undefined);
nightmareResidual.sides.player.party[0].status = 'slp';
nightmareResidual.sides.player.party[0].volatile = {nightmare: {}};
const nightmareResidualGen7 = {...nightmareResidual, generation: 7 as BattleState['generation']};
assert.equal(deriveEndTurnResolution(nightmareResidualGen7).hpDeltaByPokemon?.['player-1'], -25);
assert.equal(deriveEndTurnResolution(nightmareResidual).hpDeltaByPokemon?.['player-1'], undefined);
const nightmareResidualGen1 = {...nightmareResidual, generation: 1 as BattleState['generation']};
assert.equal(deriveEndTurnResolution(nightmareResidualGen1).hpDeltaByPokemon?.['player-1'], undefined);

const curseResidual = makeState(undefined);
curseResidual.sides.player.party[0].volatile = {curse: {sourceId: 'ai-1'}};
const curseResidualGen2 = {...curseResidual, generation: 2 as BattleState['generation']};
assert.equal(deriveEndTurnResolution(curseResidualGen2).hpDeltaByPokemon?.['player-1'], -25);
const curseResidualGen1 = {...curseResidual, generation: 1 as BattleState['generation']};
assert.equal(deriveEndTurnResolution(curseResidualGen1).hpDeltaByPokemon?.['player-1'], undefined);

const saltCureResidual = makeState(undefined);
saltCureResidual.sides.player.party[0].isSaltCure = true;
assert.equal(deriveEndTurnResolution(saltCureResidual).hpDeltaByPokemon?.['player-1'], undefined);
const saltCureResidualGen9 = {...saltCureResidual, generation: 9 as BattleState['generation']};
assert.equal(deriveEndTurnResolution(saltCureResidualGen9).hpDeltaByPokemon?.['player-1'], -12);

const poisonHeal = makeState(undefined);
poisonHeal.sides.player.party[0].ability = 'Poison Heal';
poisonHeal.sides.player.party[0].status = 'psn';
poisonHeal.sides.player.party[0].hp.current = 50;
assert.equal(deriveEndTurnResolution(poisonHeal).hpDeltaByPokemon?.['player-1'], 12);
const poisonHealGen3 = {...poisonHeal, generation: 3 as BattleState['generation']};
assert.equal(deriveEndTurnResolution(poisonHealGen3).hpDeltaByPokemon?.['player-1'], -12);
const poisonHealSuppressed = {...poisonHeal, sides: {...poisonHeal.sides,
  player: {...poisonHeal.sides.player, party: poisonHeal.sides.player.party.map(pokemon => ({
    ...pokemon, abilitySuppressed: true,
  }))},
}};
assert.equal(deriveEndTurnResolution(poisonHealSuppressed).hpDeltaByPokemon?.['player-1'], -12);

const moody = makeState(undefined);
moody.sides.player.party[0].ability = 'Moody';
const moodyResolution = deriveEndTurnResolution(moody, {random: () => 0});
assert.equal(moodyResolution.boostsByPokemon?.['player-1']?.atk, 2);
assert.equal(moodyResolution.boostsByPokemon?.['player-1']?.def, -1);
const moodyGen4 = {...moody, generation: 4 as BattleState['generation']};
assert.equal(deriveEndTurnResolution(moodyGen4, {random: () => 0}).boostsByPokemon, undefined);
const moodyGen7 = {...moody, generation: 7 as BattleState['generation'], sides: {...moody.sides,
  player: {...moody.sides.player, party: moody.sides.player.party.map(pokemon => ({
    ...pokemon, boosts: {atk: 6, def: 6, spa: 6, spd: 6, spe: 6},
  }))},
}};
assert.equal(deriveEndTurnResolution(moodyGen7, {random: () => 0}).boostsByPokemon?.['player-1']?.acc, 2);
const moodyGen8 = {...moodyGen7, generation: 8 as BattleState['generation']};
assert.equal(deriveEndTurnResolution(moodyGen8, {random: () => 0}).boostsByPokemon?.['player-1']?.acc, 2);
assert.equal(deriveEndTurnResolution(moodyGen8, {random: () => 0}).boostsByPokemon?.['player-1']?.atk, -1);
const moodySuppressed = {...moody, sides: {...moody.sides,
  player: {...moody.sides.player, party: moody.sides.player.party.map(pokemon => ({
    ...pokemon, abilitySuppressed: true,
  }))},
}};
assert.equal(deriveEndTurnResolution(moodySuppressed, {random: () => 0}).boostsByPokemon, undefined);

const leechSeed = makeState(undefined);
leechSeed.sides.ai.party[0].hp.current = 50;
leechSeed.sides.player.party[0].volatile = {leechSeed: {sourceId: 'ai-1'}};
const leechSeedResolution = deriveEndTurnResolution(leechSeed);
assert.equal(leechSeedResolution.hpDeltaByPokemon?.['player-1'], -12);
assert.equal(leechSeedResolution.hpDeltaByPokemon?.['ai-1'], 12);
const liquidOozeSeed = {...leechSeed, sides: {...leechSeed.sides,
  player: {...leechSeed.sides.player, party: leechSeed.sides.player.party.map(pokemon => ({
    ...pokemon, ability: 'Liquid Ooze',
  }))},
}};
const liquidOozeSeedResolution = deriveEndTurnResolution(liquidOozeSeed);
assert.equal(liquidOozeSeedResolution.hpDeltaByPokemon?.['player-1'], -12);
assert.equal(liquidOozeSeedResolution.hpDeltaByPokemon?.['ai-1'], -12);
leechSeed.sides.ai.party[0].item = 'Big Root';
assert.equal(deriveEndTurnResolution(leechSeed).hpDeltaByPokemon?.['ai-1'], 15);
console.log('Residual fixtures passed');
