// TypeScript 7's control-flow analyzer declines this intentionally exhaustive
// regression fixture; the test still runs as emitted JavaScript.
// @ts-nocheck
import assert from 'node:assert/strict';
import * as Calc from '@smogon/calc';
import {enumerateForcedSwitchActions, enumerateMoveActions, enumerateSwitchActions, getPokemon} from '../actions';
import {getEffectiveMoveAccuracy} from '../accuracy';
import {getCalculatorAbility, getGenerationAbility, isAbilityAvailable} from '../abilities';
import {calculateActionFacts} from '../calc-adapter';
import {deriveEndTurnResolution} from '../end-turn';
import {canApplyMajorStatus, getEffectiveTypes, isGrounded} from '../eligibility';
import {deriveSwitchEntryResolution} from '../entry-hazards';
import {isItemAvailable, isItemEffectActive} from '../items';
import {deriveMoveResolution} from '../move-engine';
import {BattleState, MoveAction, MoveCategory, PokemonState} from '../model';
import {getEffectivePokemonSpeed} from '../order';
import {getEffectiveSpecies, getRawStats} from '../stat-transforms';
import {scoreDamagingAction} from '../scoring';
import {scoreStatusAction} from '../status';
import {
  applyAction,
  applyDamageAction,
  applySwitchAction,
  advanceTurn,
  beginNextTurn,
  recordMoveAction,
  resolveMoveAction,
} from '../transition';
import {validateBattleState, validateEndTurnResolution, validateMoveResolution, validateSwitchEntryResolution} from '../validation';

function state(): BattleState {
  return {
    generation: 9,
    mode: 'Singles',
    turn: 1,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Pikachu', level: 100,
        hp: {current: 100, max: 100},
        moves: [{name: 'Tackle'}, {name: 'Protect'}],
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Rattata', level: 100,
        hp: {current: 100, max: 100},
        moves: [{name: 'Tackle'}, {name: 'Thunderbolt'}],
      }]},
    },
  };
}

const slowStartDamageState = state();
slowStartDamageState.generation = 4;
slowStartDamageState.sides.ai.party[0].ability = 'Slow Start';
slowStartDamageState.sides.ai.party[0].abilityOn = true;
slowStartDamageState.sides.ai.party[0].volatile = {slowStart: {turns: 5}};
const slowStartDamage = calculateActionFacts(slowStartDamageState, {
  kind: 'move', actorId: 'ai-1', moveName: 'Tackle', targetIds: ['player-1'],
});
const normalDamage = calculateActionFacts({
  ...slowStartDamageState,
  sides: {...slowStartDamageState.sides, ai: {...slowStartDamageState.sides.ai, party: [{
    ...slowStartDamageState.sides.ai.party[0], abilityOn: false, volatile: undefined,
  }]}},
}, {kind: 'move', actorId: 'ai-1', moveName: 'Tackle', targetIds: ['player-1']});
assert.ok((slowStartDamage.damage?.max || 0) < (normalDamage.damage?.max || 0));

const levitateGen2 = {...state(), generation: 2 as const};
levitateGen2.sides.ai.party[0].ability = 'Levitate';
assert.equal(isGrounded(levitateGen2, 'ai-1'), true);
const levitateGen3 = {...levitateGen2, generation: 3 as const};
assert.equal(isGrounded(levitateGen3, 'ai-1'), false);
assert.equal(getCalculatorAbility(levitateGen3, levitateGen3.sides.ai.party[0]), 'Levitate');
const levitateSuppressed = {...levitateGen3, sides: {...levitateGen3.sides,
  ai: {...levitateGen3.sides.ai, party: levitateGen3.sides.ai.party.map(pokemon => ({
    ...pokemon, abilityOn: false,
  }))},
}};
assert.equal(isGrounded(levitateSuppressed, 'ai-1'), true);
assert.equal(getCalculatorAbility(levitateSuppressed, levitateSuppressed.sides.ai.party[0]), undefined);

const insomniaGen2 = {...state(), generation: 2 as const};
insomniaGen2.sides.player.party[0].ability = 'Insomnia';
assert.equal(canApplyMajorStatus(insomniaGen2, 'ai-1', 'player-1', 'slp', undefined, true), true);
const insomniaGen3 = {...insomniaGen2, generation: 3 as const};
assert.equal(canApplyMajorStatus(insomniaGen3, 'ai-1', 'player-1', 'slp', undefined, true), false);

const goodAsGoldGen8 = {...state(), generation: 8 as const};
goodAsGoldGen8.sides.player.party[0].ability = 'Good as Gold';
assert.equal(canApplyMajorStatus(goodAsGoldGen8, 'ai-1', 'player-1', 'par', undefined, true), true);
const goodAsGoldGen9 = {...goodAsGoldGen8, generation: 9 as const};
assert.equal(canApplyMajorStatus(goodAsGoldGen9, 'ai-1', 'player-1', 'par', undefined, true), false);
const myceliumMightGen9 = state();
myceliumMightGen9.sides.ai.party[0].ability = 'Mycelium Might';
myceliumMightGen9.sides.player.party[0].ability = 'Good as Gold';
assert.equal(canApplyMajorStatus(myceliumMightGen9, 'ai-1', 'player-1', 'par', undefined, true), true);
const myceliumMightGen8 = {...myceliumMightGen9, generation: 8 as const};
myceliumMightGen8.sides.player.party[0].ability = 'Insomnia';
assert.equal(canApplyMajorStatus(myceliumMightGen8, 'ai-1', 'player-1', 'slp', undefined, true), false);
const moldBreakerGen4 = state();
moldBreakerGen4.generation = 4;
moldBreakerGen4.sides.ai.party[0].ability = 'Mold Breaker';
moldBreakerGen4.sides.player.party[0].ability = 'Insomnia';
assert.equal(canApplyMajorStatus(moldBreakerGen4, 'ai-1', 'player-1', 'slp', undefined, true), true);
const moldBreakerSleep = deriveMoveResolution(moldBreakerGen4, {
  kind: 'move', actorId: 'ai-1', moveName: 'Spore', targetIds: ['player-1'],
}, {hit: true, random: () => 0});
assert.equal(moldBreakerSleep.statusByPokemon?.['player-1'], 'slp');
for (const [moveName, targetAbility, status] of [
  ['Will-O-Wisp', 'Water Veil', 'brn'],
  ['Toxic', 'Immunity', 'tox'],
  ['Thunder Wave', 'Limber', 'par'],
] as const) {
  const moldBreakerStatus = {...moldBreakerGen4, sides: {
    ...moldBreakerGen4.sides,
    ai: {...moldBreakerGen4.sides.ai, party: moldBreakerGen4.sides.ai.party.map(pokemon => ({
      ...pokemon, moves: [{name: moveName}],
    }))},
    player: {...moldBreakerGen4.sides.player, party: moldBreakerGen4.sides.player.party.map(pokemon => ({
      ...pokemon, ability: targetAbility,
    }))},
  }};
  const bypassedStatus = deriveMoveResolution(moldBreakerStatus, {
    kind: 'move', actorId: 'ai-1', moveName, targetIds: ['player-1'],
  }, {hit: true, random: () => 0});
  assert.equal(bypassedStatus.statusByPokemon?.['player-1'], status);
}
const suctionCupsState = state();
suctionCupsState.sides.ai.party[0].moves = [{name: 'Roar'}];
suctionCupsState.sides.player.party[0].ability = 'Suction Cups';
const suctionCupsResolution = deriveMoveResolution(suctionCupsState, {
  kind: 'move', actorId: 'ai-1', moveName: 'Roar', targetIds: ['player-1'],
}, {hit: true});
assert.equal(suctionCupsResolution.forcedSwitchByPokemon, undefined);
const suctionCupsBypassState = {...suctionCupsState, sides: {
  ...suctionCupsState.sides,
  ai: {...suctionCupsState.sides.ai, party: suctionCupsState.sides.ai.party.map(pokemon => ({
    ...pokemon, ability: 'Mold Breaker',
  }))},
}};
const suctionCupsBypassResolution = deriveMoveResolution(suctionCupsBypassState, {
  kind: 'move', actorId: 'ai-1', moveName: 'Roar', targetIds: ['player-1'],
}, {hit: true});
assert.deepEqual(suctionCupsBypassResolution.forcedSwitchByPokemon, {'player-1': true});
const myceliumPolicyAction = {kind: 'move' as const, actorId: 'ai-1', moveName: 'Toxic', targetIds: ['player-1']};
myceliumMightGen9.sides.ai.party[0].moves = [{name: 'Toxic'}];
const myceliumPolicy = scoreStatusAction(myceliumMightGen9, {
  action: myceliumPolicyAction,
  facts: {attackerAbility: 'Mycelium Might', defenderAbility: 'Good as Gold'},
  outcomes: [], reasons: [],
});
assert.notDeepEqual(myceliumPolicy.outcomes, [{score: -20, probability: 1}]);
const secondaryState = state();
secondaryState.sides.ai.party[0].moves = [{name: 'Thunderbolt'}];
secondaryState.sides.player.party[0].ability = 'Shield Dust';
const shieldDustResolution = deriveMoveResolution(secondaryState, move(secondaryState, 'Thunderbolt'), {
  hit: true,
  facts: {
    moveCategory: 'Special',
    secondaryEffects: [{chance: 100, status: 'par'}],
  },
  random: () => 0,
});
assert.equal(shieldDustResolution.statusByPokemon, undefined);

const sereneGraceState = state();
sereneGraceState.sides.ai.party[0].ability = 'Serene Grace';
sereneGraceState.sides.ai.party[0].moves = [{name: 'Thunderbolt'}];
const sereneGraceResolution = deriveMoveResolution(sereneGraceState, move(sereneGraceState, 'Thunderbolt'), {
  hit: true,
  facts: {
    moveCategory: 'Special',
    secondaryEffects: [{chance: 40, status: 'par'}],
  },
  random: () => 0.5,
});
assert.deepEqual(sereneGraceResolution.statusByPokemon, {'player-1': 'par'});
assert.equal(sereneGraceResolution.trace?.secondaryRolls?.['player-1:0'], 0.5);
assert.doesNotThrow(() => validateMoveResolution(
  sereneGraceState, move(sereneGraceState, 'Thunderbolt'), sereneGraceResolution,
));

const sheerForceState = state();
sheerForceState.sides.ai.party[0].ability = 'Sheer Force';
sheerForceState.sides.ai.party[0].moves = [{name: 'Thunderbolt'}];
const sheerForceResolution = deriveMoveResolution(sheerForceState, move(sheerForceState, 'Thunderbolt'), {
  hit: true,
  facts: {
    moveCategory: 'Special',
    secondaryEffects: [{chance: 100, status: 'par'}],
  },
  random: () => 0,
});
assert.equal(sheerForceResolution.statusByPokemon, undefined);

const covertCloakState = state();
covertCloakState.sides.player.party[0].item = 'Covert Cloak';
const covertCloakResolution = deriveMoveResolution(covertCloakState, move(covertCloakState, 'Thunderbolt'), {
  hit: true,
  facts: {
    moveCategory: 'Special',
    secondaryEffects: [{chance: 100, status: 'par'}],
  },
  random: () => 0,
});
assert.equal(covertCloakResolution.statusByPokemon, undefined);

const selfSecondaryState = state();
selfSecondaryState.sides.ai.party[0].ability = 'Shield Dust';
selfSecondaryState.sides.ai.party[0].moves = [{name: 'Charge Beam'}];
const selfSecondaryResolution = deriveMoveResolution(selfSecondaryState, {
  kind: 'move', actorId: 'ai-1', moveName: 'Charge Beam', targetIds: ['player-1'],
}, {
  hit: true,
  facts: {
    moveCategory: 'Special',
    secondaryEffects: [{chance: 100, target: 'self', boosts: {spa: 1}}],
  },
  random: () => 0,
});
assert.deepEqual(selfSecondaryResolution.boostsByPokemon?.['ai-1'], {spa: 1});

const lumBerryState = state();
lumBerryState.sides.player.party[0].item = 'Lum Berry';
lumBerryState.sides.ai.party[0].moves = [{name: 'Toxic'}];
const lumBerryResolution = deriveMoveResolution(lumBerryState, move(lumBerryState, 'Toxic'), {hit: true});
assert.equal(lumBerryResolution.statusByPokemon?.['player-1'], '');
assert.equal(lumBerryResolution.itemByPokemon?.['player-1'], null);
assert.equal(lumBerryResolution.consumedItemByPokemon?.['player-1'], 'Lum Berry');
const lumBerryNext = applyAction(lumBerryState, move(lumBerryState, 'Toxic'), lumBerryResolution);
assert.equal(lumBerryNext.sides.player.party[0].status, '');
assert.equal(lumBerryNext.sides.player.party[0].item, undefined);
assert.equal(lumBerryNext.sides.player.party[0].lastConsumedItem, 'Lum Berry');

const lumBerryConfusion = {...lumBerryState, sides: {...lumBerryState.sides,
  player: {...lumBerryState.sides.player, party: lumBerryState.sides.player.party.map(pokemon => ({
    ...pokemon, volatile: {confusion: {turns: 2}},
  }))},
}};
const lumBerryConfusionResolution = deriveMoveResolution(
  lumBerryConfusion, move(lumBerryConfusion, 'Toxic'), {hit: true},
);
assert.equal(lumBerryConfusionResolution.volatileByPokemon?.['player-1']?.confusion, null);

const chestoBerryState = state();
chestoBerryState.sides.player.party[0].item = 'Chesto Berry';
chestoBerryState.sides.ai.party[0].moves = [{name: 'Spore'}];
const chestoBerryResolution = deriveMoveResolution(chestoBerryState, move(chestoBerryState, 'Spore'), {hit: true});
assert.equal(chestoBerryResolution.statusByPokemon?.['player-1'], '');
assert.equal(chestoBerryResolution.statusTurnsByPokemon?.['player-1'], null);
assert.equal(chestoBerryResolution.itemByPokemon?.['player-1'], null);
assert.equal(chestoBerryResolution.consumedItemByPokemon?.['player-1'], 'Chesto Berry');

const chestoBurnState = {...chestoBerryState, sides: {...chestoBerryState.sides,
  ai: {...chestoBerryState.sides.ai, party: chestoBerryState.sides.ai.party.map(pokemon => ({
    ...pokemon, moves: [{name: 'Will-O-Wisp'}],
  }))},
}};
const chestoBurnResolution = deriveMoveResolution(chestoBurnState, move(chestoBurnState, 'Will-O-Wisp'), {hit: true});
assert.equal(chestoBurnResolution.statusByPokemon?.['player-1'], 'brn');
assert.equal(chestoBurnResolution.itemByPokemon, undefined);
for (const [item, moveName] of [
  ['Cheri Berry', 'Thunder Wave'],
  ['Pecha Berry', 'Toxic'],
  ['Rawst Berry', 'Will-O-Wisp'],
] as const) {
  const statusBerryState = state();
  statusBerryState.sides.player.party[0].item = item;
  statusBerryState.sides.ai.party[0].moves = [{name: moveName}];
  const statusBerryResolution = deriveMoveResolution(statusBerryState, move(statusBerryState, moveName), {hit: true});
  assert.equal(statusBerryResolution.statusByPokemon?.['player-1'], '');
  assert.equal(statusBerryResolution.consumedItemByPokemon?.['player-1'], item);
}

const synchronizeState = state();
synchronizeState.sides.ai.party[0].moves = [{name: 'Will-O-Wisp'}];
synchronizeState.sides.player.party[0].ability = 'Synchronize';
const synchronizeResolution = deriveMoveResolution(
  synchronizeState, move(synchronizeState, 'Will-O-Wisp'), {hit: true},
);
assert.equal(synchronizeResolution.statusByPokemon?.['player-1'], 'brn');
assert.equal(synchronizeResolution.statusByPokemon?.['ai-1'], 'brn');
const synchronizeGen2 = {...synchronizeState, generation: 2 as const};
assert.equal(deriveMoveResolution(synchronizeGen2, move(synchronizeGen2, 'Will-O-Wisp'), {hit: true})
  .statusByPokemon?.['ai-1'], undefined);
const synchronizeMoldBreaker = {...synchronizeState, sides: {...synchronizeState.sides,
  ai: {...synchronizeState.sides.ai, party: synchronizeState.sides.ai.party.map(pokemon => ({
    ...pokemon, ability: 'Mold Breaker',
  }))},
}};
assert.equal(deriveMoveResolution(
  synchronizeMoldBreaker, move(synchronizeMoldBreaker, 'Will-O-Wisp'), {hit: true},
).statusByPokemon?.['ai-1'], undefined);
const synchronizeFireSource = {...synchronizeState, sides: {...synchronizeState.sides,
  ai: {...synchronizeState.sides.ai, party: synchronizeState.sides.ai.party.map(pokemon => ({
    ...pokemon, species: 'Charmander',
  }))},
}};
assert.equal(deriveMoveResolution(
  synchronizeFireSource, move(synchronizeFireSource, 'Will-O-Wisp'), {hit: true},
).statusByPokemon?.['ai-1'], undefined);

const lumBerryCheekPouch = {...lumBerryState, sides: {...lumBerryState.sides,
  player: {...lumBerryState.sides.player, party: lumBerryState.sides.player.party.map(pokemon => ({
    ...pokemon, ability: 'Cheek Pouch',
  }))},
}};
assert.equal(deriveMoveResolution(lumBerryCheekPouch, move(lumBerryCheekPouch, 'Toxic'), {hit: true})
  .hpDeltaByPokemon?.['player-1'], 33);

const suppressedLumBerry = {...lumBerryState, field: {magicRoom: true}};
const suppressedLumResolution = deriveMoveResolution(suppressedLumBerry, move(suppressedLumBerry, 'Toxic'), {hit: true});
assert.equal(suppressedLumResolution.statusByPokemon?.['player-1'], 'tox');
assert.equal(suppressedLumResolution.itemByPokemon, undefined);
const embargoLumBerry = {...lumBerryState, sides: {...lumBerryState.sides,
  player: {...lumBerryState.sides.player, party: lumBerryState.sides.player.party.map(pokemon => ({
    ...pokemon, volatile: {embargo: {turns: 2}},
  }))},
}};
assert.equal(deriveMoveResolution(embargoLumBerry, move(embargoLumBerry, 'Toxic'), {hit: true})
  .statusByPokemon?.['player-1'], 'tox');
const klutzLumBerry = {...lumBerryState, sides: {...lumBerryState.sides,
  player: {...lumBerryState.sides.player, party: lumBerryState.sides.player.party.map(pokemon => ({
    ...pokemon, ability: 'Klutz',
  }))},
}};
assert.equal(deriveMoveResolution(klutzLumBerry, move(klutzLumBerry, 'Toxic'), {hit: true})
  .statusByPokemon?.['player-1'], 'tox');
const gen2LumBerry = {...lumBerryState, generation: 2 as const};
assert.equal(deriveMoveResolution(gen2LumBerry, move(gen2LumBerry, 'Toxic'), {hit: true})
  .statusByPokemon?.['player-1'], 'tox');

const lifeOrbState = state();
lifeOrbState.sides.ai.party[0].item = 'Life Orb';
lifeOrbState.sides.ai.party[0].moves = [{name: 'Tackle'}];
const lifeOrbResolution = deriveMoveResolution(lifeOrbState, move(lifeOrbState, 'Tackle'), {
  hit: true,
  facts: {
    moveCategory: 'Physical',
    damage: {rolls: [20], min: 20, max: 20, targetHp: 100, possibleKO: false, guaranteedKO: false},
  },
});
assert.equal(lifeOrbResolution.hpDeltaByPokemon?.['ai-1'], -10);

const lifeOrbSheerForceState = state();
lifeOrbSheerForceState.sides.ai.party[0].ability = 'Sheer Force';
lifeOrbSheerForceState.sides.ai.party[0].item = 'Life Orb';
lifeOrbSheerForceState.sides.ai.party[0].moves = [{name: 'Thunderbolt'}];
const lifeOrbSheerForceResolution = deriveMoveResolution(
  lifeOrbSheerForceState,
  move(lifeOrbSheerForceState, 'Thunderbolt'),
  {
    hit: true,
    facts: {
      moveCategory: 'Special',
      secondaryEffects: [{chance: 100, status: 'par'}],
      damage: {rolls: [20], min: 20, max: 20, targetHp: 100, possibleKO: false, guaranteedKO: false},
    },
  },
);
assert.equal(lifeOrbSheerForceResolution.hpDeltaByPokemon, undefined);
assert.equal(lifeOrbSheerForceResolution.statusByPokemon, undefined);

const lifeOrbSheerForceNoSecondary = {...lifeOrbSheerForceState, sides: {
  ...lifeOrbSheerForceState.sides,
  ai: {...lifeOrbSheerForceState.sides.ai, party: lifeOrbSheerForceState.sides.ai.party.map(pokemon => ({
    ...pokemon, moves: [{name: 'Tackle'}],
  }))},
}};
const lifeOrbSheerForceNoSecondaryResolution = deriveMoveResolution(
  lifeOrbSheerForceNoSecondary,
  move(lifeOrbSheerForceNoSecondary, 'Tackle'),
  {
    hit: true,
    facts: {
      moveCategory: 'Physical',
      damage: {rolls: [20], min: 20, max: 20, targetHp: 100, possibleKO: false, guaranteedKO: false},
    },
  },
);
assert.equal(lifeOrbSheerForceNoSecondaryResolution.hpDeltaByPokemon?.['ai-1'], -10);

const lifeOrbMagicGuardState = {...lifeOrbState, sides: {
  ...lifeOrbState.sides,
  ai: {...lifeOrbState.sides.ai, party: lifeOrbState.sides.ai.party.map(pokemon => ({
    ...pokemon, ability: 'Magic Guard', moves: [{name: 'Tackle'}],
  }))},
}};
const lifeOrbMagicGuardResolution = deriveMoveResolution(
  lifeOrbMagicGuardState,
  move(lifeOrbMagicGuardState, 'Tackle'),
  {
    hit: true,
    facts: {
      moveCategory: 'Physical',
      damage: {rolls: [20], min: 20, max: 20, targetHp: 100, possibleKO: false, guaranteedKO: false},
    },
  },
);
assert.equal(lifeOrbMagicGuardResolution.hpDeltaByPokemon, undefined);
assert.equal(isAbilityAvailable(2, 'Mountaineer'), false);
assert.equal(isAbilityAvailable(3, 'Mountaineer'), false);
assert.equal(isAbilityAvailable(4, 'Mountaineer'), true);
const rolePlayFutureAbility = {...goodAsGoldGen8};
rolePlayFutureAbility.sides.ai.party[0].moves = [{name: 'Role Play'}];
rolePlayFutureAbility.sides.player.party[0].ability = 'Good as Gold';
const rolePlayFutureAbilityResolution = deriveMoveResolution(
  rolePlayFutureAbility,
  move(rolePlayFutureAbility, 'Role Play'),
  {hit: true},
);
assert.equal(rolePlayFutureAbilityResolution.abilityOverrideByPokemon, undefined);
const transformFutureAbility = {...goodAsGoldGen8};
transformFutureAbility.sides.ai.party[0].moves = [{name: 'Transform'}];
const transformFutureAbilityResolution = deriveMoveResolution(
  transformFutureAbility,
  move(transformFutureAbility, 'Transform'),
  {hit: true},
);
assert.equal(transformFutureAbilityResolution.abilityOverrideByPokemon, undefined);

function move(stateValue: BattleState, moveName: string, targetIds: string[] = ['player-1']): MoveAction {
  return {kind: 'move', actorId: 'ai-1', moveName, targetIds};
}

function addReplacement(stateValue: BattleState, sideId: 'ai' | 'player', pokemon: PokemonState) {
  stateValue.sides[sideId].party.push(pokemon);
}

function doublesState(): BattleState {
  const next = state();
  next.mode = 'Doubles';
  next.sides.ai.activeIds = ['ai-1', 'ai-2'];
  next.sides.player.activeIds = ['player-1', 'player-2'];
  addReplacement(next, 'ai', {
    id: 'ai-2', species: 'Bulbasaur', level: 100, hp: {current: 100, max: 100}, moves: [],
  });
  addReplacement(next, 'player', {
    id: 'player-2', species: 'Bulbasaur', level: 100, hp: {current: 100, max: 100}, moves: [],
  });
  return next;
}

const struggleState = state();
struggleState.sides.ai.party[0].moves = [
  {name: 'Tackle', pp: 0, maxPP: 35},
  {name: 'Protect', disabled: true},
];
const struggleAction = enumerateMoveActions(struggleState, 'ai')[0];
assert.deepEqual(struggleAction, {
  kind: 'move', actorId: 'ai-1', moveName: 'Struggle', targetIds: ['player-1'],
});
const struggleFacts = calculateActionFacts(struggleState, struggleAction);
assert.ok((struggleFacts.damage?.max || 0) > 0);
const struggleResolution = deriveMoveResolution(struggleState, struggleAction, {
  facts: struggleFacts, hit: true, random: () => 0,
});
assert.ok((struggleResolution.damageByTarget?.['player-1'] || 0) > 0);
const struggleApplied = resolveMoveAction(struggleState, struggleAction, struggleResolution);
assert.equal(struggleApplied.sides.ai.party[0].hp.current, 75);
assert.equal(struggleApplied.sides.player.party[0].hp.current,
  100 - (struggleResolution.damageByTarget?.['player-1'] || 0));
assert.equal(struggleApplied.sides.ai.party[0].moves[0].pp, 0);

const shellTrapState = {...state(), generation: 7 as const};
shellTrapState.sides.ai.party[0].moves = [{name: 'Shell Trap'}];
const shellTrapAction = enumerateMoveActions(shellTrapState, 'ai').find(action =>
  action.moveName === 'Shell Trap');
assert.ok(shellTrapAction);
const shellTrapFacts = calculateActionFacts(shellTrapState, shellTrapAction!);
assert.equal(shellTrapFacts.moveCategory, 'Status');
assert.equal(shellTrapFacts.damage, undefined);
const shellTrapArmed = applyAction(
  shellTrapState,
  shellTrapAction!,
  deriveMoveResolution(shellTrapState, shellTrapAction!, {hit: true}),
);
assert.deepEqual(shellTrapArmed.sides.ai.party[0].volatile?.shellTrap, {turns: 1});
const incomingContact: MoveAction = {
  kind: 'move', actorId: 'player-1', moveName: 'Tackle', targetIds: ['ai-1'],
};
const triggeredShellTrap = applyAction(
  shellTrapArmed,
  incomingContact,
  deriveMoveResolution(shellTrapArmed, incomingContact, {
    facts: calculateActionFacts(shellTrapArmed, incomingContact), hit: true, random: () => 0,
  }),
);
assert.equal(triggeredShellTrap.sides.ai.party[0].volatile?.shellTrap, undefined);
assert.ok(triggeredShellTrap.sides.player.party[0].hp.current < 100);

const nonContactAction: MoveAction = {
  kind: 'move', actorId: 'player-1', moveName: 'Thunderbolt', targetIds: ['ai-1'],
};
const shellTrapNonContact = applyAction(
  shellTrapArmed,
  nonContactAction,
  deriveMoveResolution(shellTrapArmed, nonContactAction, {
    facts: calculateActionFacts(shellTrapArmed, nonContactAction), hit: true, random: () => 0,
  }),
);
assert.deepEqual(shellTrapNonContact.sides.ai.party[0].volatile?.shellTrap, {turns: 1});
assert.equal(beginNextTurn(shellTrapNonContact).sides.ai.party[0].volatile?.shellTrap, undefined);

const belchState = state();
belchState.sides.ai.party[0].moves = [{name: 'Belch'}];
assert.equal(enumerateMoveActions(belchState, 'ai').some(action => action.moveName === 'Belch'), false);
const belchUnavailable = deriveMoveResolution(belchState, move(belchState, 'Belch'), {hit: true});
assert.equal(belchUnavailable.hit, false);
assert.ok(belchUnavailable.trace?.notes?.some(note => note.includes('consumed a Berry')));
belchState.sides.ai.party[0].lastConsumedItem = 'Lum Berry';
assert.equal(enumerateMoveActions(belchState, 'ai').some(action => action.moveName === 'Belch'), true);
belchState.sides.ai.party[0].lastConsumedItem = 'Life Orb';
assert.equal(enumerateMoveActions(belchState, 'ai').some(action => action.moveName === 'Belch'), false);

const sleepMoveState = state();
sleepMoveState.sides.ai.party[0].moves = [{name: 'Snore'}, {name: 'Sleep Talk'}];
assert.equal(enumerateMoveActions(sleepMoveState, 'ai').some(action =>
  ['Snore', 'Sleep Talk'].includes(action.moveName)), false);
assert.equal(deriveMoveResolution(sleepMoveState, move(sleepMoveState, 'Snore'), {hit: true}).hit, false);
sleepMoveState.sides.ai.party[0].status = 'slp';
sleepMoveState.sides.ai.party[0].statusTurns = 2;
assert.equal(enumerateMoveActions(sleepMoveState, 'ai').some(action => action.moveName === 'Snore'), true);
assert.equal(enumerateMoveActions(sleepMoveState, 'ai').some(action => action.moveName === 'Sleep Talk'), true);
sleepMoveState.sides.ai.party[0].statusTurns = 0;
assert.equal(enumerateMoveActions(sleepMoveState, 'ai').some(action =>
  ['Snore', 'Sleep Talk'].includes(action.moveName)), false);

const stockpileState = state();
stockpileState.sides.ai.party[0].moves = [{name: 'Stockpile'}, {name: 'Swallow'}, {name: 'Spit Up'}];
assert.deepEqual(enumerateMoveActions(stockpileState, 'ai').map(action => action.moveName), ['Stockpile']);
stockpileState.sides.ai.party[0].volatile = {stockpile: {stacks: 1}};
assert.deepEqual(enumerateMoveActions(stockpileState, 'ai').map(action => action.moveName), [
  'Stockpile', 'Spit Up',
]);
stockpileState.sides.ai.party[0].volatile = {stockpile: {stacks: 3}};
assert.deepEqual(enumerateMoveActions(stockpileState, 'ai').map(action => action.moveName), ['Spit Up']);

const callerDefinedMoveState = state();
callerDefinedMoveState.sides.ai.party[0].moves = [{
  name: 'Caller Defined Move', basePower: 80, type: 'Fire', category: 'Special', target: 'normal',
}];
const callerDefinedMoveActions = enumerateMoveActions(callerDefinedMoveState, 'ai');
assert.equal(callerDefinedMoveActions.length, 1);
assert.deepEqual(callerDefinedMoveActions[0].targetIds, ['player-1']);

const dreamEaterState = state();
dreamEaterState.sides.ai.party[0].moves = [{name: 'Dream Eater'}];
assert.equal(enumerateMoveActions(dreamEaterState, 'ai').some(action => action.moveName === 'Dream Eater'), false);
const awakeDreamEater = deriveMoveResolution(dreamEaterState, move(dreamEaterState, 'Dream Eater'), {hit: true});
assert.equal(awakeDreamEater.hit, false);
assert.ok(awakeDreamEater.trace?.notes?.some(note => note.includes('not asleep')));
dreamEaterState.sides.player.party[0].status = 'slp';
assert.equal(enumerateMoveActions(dreamEaterState, 'ai').some(action => action.moveName === 'Dream Eater'), true);

const lastResortState = state();
lastResortState.sides.ai.party[0].moves = [{name: 'Last Resort'}, {name: 'Tackle'}];
assert.equal(enumerateMoveActions(lastResortState, 'ai').some(action => action.moveName === 'Last Resort'), false);
assert.equal(deriveMoveResolution(lastResortState, move(lastResortState, 'Last Resort'), {hit: true}).hit, false);
const usedTackle = recordMoveAction(lastResortState, move(lastResortState, 'Tackle'));
assert.equal(usedTackle.sides.ai.party[0].moves[1].timesUsed, 1);
assert.equal(enumerateMoveActions(usedTackle, 'ai').some(action => action.moveName === 'Last Resort'), true);

const healingWishState = {...state(), generation: 4 as const};
healingWishState.sides.ai.party[0].hp = {current: 50, max: 100};
healingWishState.sides.ai.party[0].moves = [{name: 'Healing Wish'}];
addReplacement(healingWishState, 'ai', {
  id: 'ai-2', species: 'Bulbasaur', level: 100, hp: {current: 50, max: 100}, moves: [],
});
const healingWishResolution = deriveMoveResolution(
  healingWishState,
  move(healingWishState, 'Healing Wish', ['ai-1']),
  {hit: true},
);
assert.equal(healingWishResolution.forcedSwitchByPokemon?.['ai-1'], true);
assert.equal(healingWishResolution.pendingFullHealBySide?.ai, true);
assert.equal(healingWishResolution.hpDeltaByPokemon?.['ai-1'], -50);
const healingWishStarted = applyAction(healingWishState, move(healingWishState, 'Healing Wish', ['ai-1']), healingWishResolution);
const healingWishSwitch = enumerateForcedSwitchActions(healingWishStarted, 'ai').find(action => action.actorId === 'ai-1');
assert.ok(healingWishSwitch);
const healingWishSwitched = applySwitchAction(healingWishStarted, healingWishSwitch!);
assert.equal(healingWishSwitched.sides.ai.party.find(pokemon => pokemon.id === 'ai-2')?.hp.current, 100);
assert.equal(healingWishSwitched.sides.ai.pendingFullHealOnSwitch, undefined);

const healingWishNoReplacement = {...state(), generation: 4 as const};
healingWishNoReplacement.sides.ai.party[0].hp = {current: 50, max: 100};
healingWishNoReplacement.sides.ai.party[0].moves = [{name: 'Healing Wish'}];
const healingWishNoReplacementResolution = deriveMoveResolution(
  healingWishNoReplacement,
  move(healingWishNoReplacement, 'Healing Wish', ['ai-1']),
  {hit: true},
);
assert.equal(healingWishNoReplacementResolution.hit, false);
assert.equal(healingWishNoReplacementResolution.hpDeltaByPokemon, undefined);
assert.equal(healingWishNoReplacementResolution.pendingFullHealBySide, undefined);
assert.deepEqual(scoreStatusAction(healingWishNoReplacement, {
  action: move(healingWishNoReplacement, 'Healing Wish', ['ai-1']),
  facts: {}, outcomes: [], reasons: [],
}).outcomes, [{score: -20, probability: 1}]);

const healingWishHazardState = {...healingWishStarted, sides: {
  ...healingWishStarted.sides,
  ai: {...healingWishStarted.sides.ai, effects: {spikes: 3}},
}};
const healingWishHazardSwitch = enumerateForcedSwitchActions(healingWishHazardState, 'ai').find(action => action.actorId === 'ai-1');
assert.ok(healingWishHazardSwitch);
const healingWishHazardSwitched = applySwitchAction(healingWishHazardState, healingWishHazardSwitch!);
assert.equal(healingWishHazardSwitched.sides.ai.party.find(pokemon => pokemon.id === 'ai-2')?.hp.current, 100);

const healingWishLethalHazardState = {...healingWishStarted, sides: {
  ...healingWishStarted.sides,
  ai: {...healingWishStarted.sides.ai, effects: {stealthRock: true}},
}};
healingWishLethalHazardState.sides.ai.party[1].hp = {current: 1, max: 100};
const healingWishLethalHazardSwitch = enumerateForcedSwitchActions(healingWishLethalHazardState, 'ai').find(action => action.actorId === 'ai-1');
assert.ok(healingWishLethalHazardSwitch);
const healingWishLethalHazardSwitched = applySwitchAction(healingWishLethalHazardState, healingWishLethalHazardSwitch!);
assert.equal(healingWishLethalHazardSwitched.sides.ai.party.find(pokemon => pokemon.id === 'ai-2')?.hp.current, 0);

const shedTailState = state();
shedTailState.sides.ai.party[0].moves = [{name: 'Shed Tail'}];
addReplacement(shedTailState, 'ai', {
  id: 'ai-2', species: 'Bulbasaur', level: 100, hp: {current: 100, max: 100}, moves: [],
});
const shedTailResolution = deriveMoveResolution(shedTailState, move(shedTailState, 'Shed Tail', ['ai-1']), {hit: true});
assert.equal(shedTailResolution.forcedSwitchByPokemon?.['ai-1'], true);
assert.equal(shedTailResolution.substitutePassByPokemon?.['ai-1'], true);
assert.equal(shedTailResolution.hpDeltaByPokemon?.['ai-1'], -50);
assert.equal(shedTailResolution.substituteHpByPokemon?.['ai-1'], 25);
const shedTailStarted = applyAction(shedTailState, move(shedTailState, 'Shed Tail', ['ai-1']), shedTailResolution);
const shedTailSwitch = enumerateForcedSwitchActions(shedTailStarted, 'ai').find(action => action.actorId === 'ai-1');
assert.ok(shedTailSwitch);
assert.equal(shedTailSwitch?.preserveSubstitute, true);
const shedTailSwitched = applySwitchAction(shedTailStarted, shedTailSwitch!);
assert.equal(shedTailSwitched.sides.ai.party.find(pokemon => pokemon.id === 'ai-2')?.substituteHp, 25);
assert.equal(shedTailSwitched.pendingSubstitutePassIds, undefined);
const shedTailForgedSwitchState = {...shedTailStarted, pendingSubstitutePassIds: undefined};
assert.throws(() => applySwitchAction(shedTailForgedSwitchState, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2', preserveSubstitute: true,
}), /pending Shed Tail/);
const overlappingReplacementQueues = {...shedTailStarted, pendingBatonPassIds: ['ai-1']};
assert.throws(() => validateBattleState(overlappingReplacementQueues), /replacement queues cannot overlap/);
assert.throws(() => applySwitchAction(overlappingReplacementQueues, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2', batonPass: true,
}), /overlap a pending Shed Tail/);

const shedTailNoReplacement = {...state()};
shedTailNoReplacement.sides.ai.party[0].moves = [{name: 'Shed Tail'}];
const shedTailNoReplacementResolution = deriveMoveResolution(
  shedTailNoReplacement, move(shedTailNoReplacement, 'Shed Tail', ['ai-1']), {hit: true},
);
assert.equal(shedTailNoReplacementResolution.hit, false);
assert.equal(shedTailNoReplacementResolution.hpDeltaByPokemon, undefined);
assert.equal(shedTailNoReplacementResolution.substitutePassByPokemon, undefined);
assert.deepEqual(scoreStatusAction(shedTailNoReplacement, {
  action: move(shedTailNoReplacement, 'Shed Tail', ['ai-1']), facts: {}, outcomes: [], reasons: [],
}).outcomes, [{score: -20, probability: 1}]);

const sweetVeilAlly = doublesState();
sweetVeilAlly.sides.ai.party[0].moves = [{name: 'Spore'}];
sweetVeilAlly.sides.player.party[1].ability = 'Sweet Veil';
assert.equal(deriveMoveResolution(sweetVeilAlly, move(sweetVeilAlly, 'Spore'), {hit: true})
  .statusByPokemon, undefined);
const sweetVeilFaintedAlly = {...sweetVeilAlly, sides: {...sweetVeilAlly.sides,
  player: {...sweetVeilAlly.sides.player, party: sweetVeilAlly.sides.player.party.map(pokemon =>
    pokemon.id === 'player-2' ? {...pokemon, hp: {...pokemon.hp, current: 0}} : pokemon)},
}};
assert.equal(deriveMoveResolution(sweetVeilFaintedAlly, move(sweetVeilFaintedAlly, 'Spore'), {hit: true})
  .statusByPokemon?.['player-1'], 'slp');
const sweetVeilGen5 = {...sweetVeilAlly, generation: 5 as const};
assert.equal(deriveMoveResolution(sweetVeilGen5, move(sweetVeilGen5, 'Spore'), {hit: true})
  .statusByPokemon?.['player-1'], 'slp');
const aromaVeilAlly = doublesState();
aromaVeilAlly.sides.ai.party[0].moves = [{name: 'Taunt'}];
aromaVeilAlly.sides.player.party[1].ability = 'Aroma Veil';
assert.equal(deriveMoveResolution(aromaVeilAlly, move(aromaVeilAlly, 'Taunt'), {hit: true})
  .volatileByPokemon, undefined);
const aromaVeilSuppressed = {...aromaVeilAlly, sides: {...aromaVeilAlly.sides,
  player: {...aromaVeilAlly.sides.player, party: aromaVeilAlly.sides.player.party.map(pokemon =>
    pokemon.id === 'player-2' ? {...pokemon, abilitySuppressed: true} : pokemon)},
}};
assert.equal(deriveMoveResolution(aromaVeilSuppressed, move(aromaVeilSuppressed, 'Taunt'), {hit: true})
  .volatileByPokemon?.['player-1']?.taunt?.turns, 3);
const pastelVeilAlly = doublesState();
pastelVeilAlly.sides.ai.party[0].moves = [{name: 'Toxic'}];
pastelVeilAlly.sides.player.party[1].ability = 'Pastel Veil';
assert.equal(deriveMoveResolution(pastelVeilAlly, move(pastelVeilAlly, 'Toxic'), {hit: true})
  .statusByPokemon, undefined);
const pastelVeilFaintedAlly = {...pastelVeilAlly, sides: {...pastelVeilAlly.sides,
  player: {...pastelVeilAlly.sides.player, party: pastelVeilAlly.sides.player.party.map(pokemon =>
    pokemon.id === 'player-2' ? {...pokemon, hp: {...pokemon.hp, current: 0}} : pokemon)},
}};
assert.equal(deriveMoveResolution(pastelVeilFaintedAlly, move(pastelVeilFaintedAlly, 'Toxic'), {hit: true})
  .statusByPokemon?.['player-1'], 'tox');
const pastelVeilGen7 = {...pastelVeilAlly, generation: 7 as const};
assert.equal(deriveMoveResolution(pastelVeilGen7, move(pastelVeilGen7, 'Toxic'), {hit: true})
  .statusByPokemon?.['player-1'], 'tox');
const pastelVeilSuppressed = {...pastelVeilAlly, sides: {...pastelVeilAlly.sides,
  player: {...pastelVeilAlly.sides.player, party: pastelVeilAlly.sides.player.party.map(pokemon =>
    pokemon.id === 'player-2' ? {...pokemon, abilitySuppressed: true} : pokemon)},
}};
assert.equal(deriveMoveResolution(pastelVeilSuppressed, move(pastelVeilSuppressed, 'Toxic'), {hit: true})
  .statusByPokemon?.['player-1'], 'tox');
const pastelVeilEntry = doublesState();
pastelVeilEntry.sides.ai.party[1].ability = 'Pastel Veil';
pastelVeilEntry.sides.ai.party[1].status = 'tox';
pastelVeilEntry.sides.ai.party[1].toxicCounter = 2;
pastelVeilEntry.sides.ai.party.push({
  id: 'ai-3', species: 'Pikachu', level: 100,
  hp: {current: 100, max: 100}, moves: [], status: 'psn',
});
const pastelVeilEntryAction = {kind: 'switch' as const, actorId: 'ai-1', replacementId: 'ai-3'};
const pastelVeilEntryResolution = deriveSwitchEntryResolution(pastelVeilEntry, pastelVeilEntryAction);
assert.equal(pastelVeilEntryResolution.statusByPokemon?.['ai-2'], '');
assert.equal(pastelVeilEntryResolution.statusByPokemon?.['ai-3'], '');
assert.equal(pastelVeilEntryResolution.toxicCounterByPokemon?.['ai-2'], 0);
const pastelVeilEntryApplied = applySwitchAction(pastelVeilEntry, pastelVeilEntryAction);
assert.equal(pastelVeilEntryApplied.sides.ai.party[1].status, '');
assert.equal(pastelVeilEntryApplied.sides.ai.party[1].toxicCounter, undefined);
assert.equal(deriveSwitchEntryResolution({...pastelVeilEntry, generation: 7 as const}, pastelVeilEntryAction)
  .statusByPokemon, undefined);
const flowerVeilState = doublesState();
flowerVeilState.sides.player.party[0].species = 'Bulbasaur';
flowerVeilState.sides.player.party[1].ability = 'Flower Veil';
flowerVeilState.sides.ai.party[0].moves = [{name: 'Spore'}];
assert.equal(deriveMoveResolution(flowerVeilState, move(flowerVeilState, 'Spore'), {hit: true})
  .statusByPokemon, undefined);
flowerVeilState.sides.ai.party[0].moves = [{name: 'Growl'}];
assert.equal(deriveMoveResolution(flowerVeilState, move(flowerVeilState, 'Growl'), {hit: true})
  .boostsByPokemon, undefined);
const flowerVeilFainted = {...flowerVeilState, sides: {...flowerVeilState.sides,
  player: {...flowerVeilState.sides.player, party: flowerVeilState.sides.player.party.map(pokemon =>
    pokemon.id === 'player-2' ? {...pokemon, hp: {...pokemon.hp, current: 0}} : pokemon)},
}};
flowerVeilFainted.sides.ai.party[0].moves = [{name: 'Spore'}];
assert.equal(deriveMoveResolution(flowerVeilFainted, move(flowerVeilFainted, 'Spore'), {hit: true})
  .statusByPokemon?.['player-1'], 'slp');
const flowerVeilGen5 = {...flowerVeilState, generation: 5 as const};
assert.equal(deriveMoveResolution(flowerVeilGen5, move(flowerVeilGen5, 'Spore'), {hit: true})
  .statusByPokemon?.['player-1'], 'slp');
const flowerVeilSuppressed = {...flowerVeilState, sides: {...flowerVeilState.sides,
  player: {...flowerVeilState.sides.player, party: flowerVeilState.sides.player.party.map(pokemon =>
    pokemon.id === 'player-2' ? {...pokemon, abilitySuppressed: true} : pokemon)},
}};
assert.equal(deriveMoveResolution(flowerVeilSuppressed, move(flowerVeilSuppressed, 'Spore'), {hit: true})
  .statusByPokemon?.['player-1'], 'slp');
const flowerVeilEntry = doublesState();
flowerVeilEntry.sides.player.party[0].species = 'Bulbasaur';
flowerVeilEntry.sides.player.party[1].ability = 'Flower Veil';
flowerVeilEntry.sides.player.party[0].boosts = {atk: 0};
flowerVeilEntry.sides.player.party[1].boosts = {atk: 0};
flowerVeilEntry.sides.ai.party.push({
  id: 'ai-3', species: 'Pikachu', level: 100,
  hp: {current: 100, max: 100}, moves: [], ability: 'Intimidate',
});
const flowerVeilEntryResolution = deriveSwitchEntryResolution(flowerVeilEntry, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-3',
});
assert.equal(flowerVeilEntryResolution.boostsByPokemon?.['player-1'], undefined);
assert.equal(flowerVeilEntryResolution.boostsByPokemon?.['player-2']?.atk, -1);
const keenEyeDrop = state();
keenEyeDrop.sides.ai.party[0].moves = [{name: 'Sand Attack'}];
keenEyeDrop.sides.player.party[0].ability = 'Keen Eye';
assert.equal(deriveMoveResolution(keenEyeDrop, move(keenEyeDrop, 'Sand Attack'), {hit: true})
  .boostsByPokemon, undefined);
const keenEyeSuppressed = {...keenEyeDrop, sides: {...keenEyeDrop.sides,
  player: {...keenEyeDrop.sides.player, party: keenEyeDrop.sides.player.party.map(pokemon => ({
    ...pokemon, abilitySuppressed: true,
  }))},
}};
assert.equal(deriveMoveResolution(keenEyeSuppressed, move(keenEyeSuppressed, 'Sand Attack'), {hit: true})
  .boostsByPokemon?.['player-1']?.acc, -1);

const base = state();
const tackleAction = move(base, 'Tackle');
assert.equal(enumerateMoveActions(base)[0].actorId, tackleAction.actorId);
assert.equal(enumerateMoveActions(base)[0].moveName, tackleAction.moveName);
assert.deepEqual(enumerateMoveActions(base)[0].targetIds, tackleAction.targetIds);
assert.equal(getPokemon(base, 'ai-1')?.species, 'Pikachu');

const recorded = recordMoveAction(base, tackleAction);
assert.equal(base.sides.ai.party[0].moves[0].pp, undefined);
assert.equal(recorded.lastMoveByPokemon?.['ai-1'], 'Tackle');
assert.equal(recorded.lastMoveUsedByPokemon?.['ai-1'], 'Tackle');
assert.equal(recorded.lastMoveUsed, 'Tackle');
assert.deepEqual(recorded.moveStreakByPokemon?.['ai-1'], {moveName: 'Tackle', count: 1});

const metronomeItemState = state();
metronomeItemState.sides.ai.party[0].item = 'Metronome';
const metronomeItemAction = move(metronomeItemState, 'Tackle');
const metronomeFirstFacts = calculateActionFacts(metronomeItemState, metronomeItemAction);
const metronomeFirstResolution = deriveMoveResolution(metronomeItemState, metronomeItemAction, {
  hit: true, facts: metronomeFirstFacts,
});
const metronomeSecondState = applyAction(
  metronomeItemState, metronomeItemAction, metronomeFirstResolution,
);
const metronomeSecondFacts = calculateActionFacts(metronomeSecondState, metronomeItemAction);
assert.equal(metronomeSecondState.moveStreakByPokemon?.['ai-1']?.count, 1);
assert.ok((metronomeSecondFacts.damage?.max || 0) > (metronomeFirstFacts.damage?.max || 0));
const metronomeSuppressed = {...metronomeSecondState, field: {magicRoom: true}};
assert.equal(calculateActionFacts(metronomeSuppressed, metronomeItemAction).attackerItem, undefined);
const metronomeFailed = applyAction(metronomeSecondState, metronomeItemAction, {
  hit: false, actionFailure: 'paralysis',
});
assert.equal(metronomeFailed.moveStreakByPokemon, undefined);

const mentalHerbState = state();
mentalHerbState.sides.player.party[0].item = 'Mental Herb';
mentalHerbState.sides.ai.party[0].moves = [{name: 'Taunt'}];
const mentalHerbResolution = deriveMoveResolution(mentalHerbState, move(mentalHerbState, 'Taunt'), {hit: true});
assert.equal(mentalHerbResolution.volatileByPokemon?.['player-1']?.taunt, null);
assert.equal(mentalHerbResolution.volatileByPokemon?.['player-1']?.encore, null);
assert.equal(mentalHerbResolution.itemByPokemon?.['player-1'], null);
assert.equal(mentalHerbResolution.consumedItemByPokemon?.['player-1'], 'Mental Herb');
const mentalHerbMagicRoom = {...mentalHerbState, field: {magicRoom: true}};
assert.equal(deriveMoveResolution(mentalHerbMagicRoom, move(mentalHerbMagicRoom, 'Taunt'), {hit: true})
  .volatileByPokemon?.['player-1']?.taunt?.turns, 3);
const mentalHerbKlutz = {...mentalHerbState, sides: {...mentalHerbState.sides,
  player: {...mentalHerbState.sides.player, party: mentalHerbState.sides.player.party.map(pokemon => ({
    ...pokemon, ability: 'Klutz',
  }))},
}};
assert.equal(deriveMoveResolution(mentalHerbKlutz, move(mentalHerbKlutz, 'Taunt'), {hit: true})
  .itemByPokemon, undefined);
const mentalHerbGen2 = {...mentalHerbState, generation: 2 as const};
assert.equal(deriveMoveResolution(mentalHerbGen2, move(mentalHerbGen2, 'Taunt'), {hit: true})
  .itemByPokemon, undefined);

const choiceState = state();
choiceState.sides.ai.party[0].item = 'Choice Scarf';
choiceState.sides.ai.party[0].moves = [{name: 'Tackle'}, {name: 'Thunderbolt'}];
const choiceRecorded = recordMoveAction(choiceState, move(choiceState, 'Tackle'));
assert.equal(enumerateMoveActions(choiceRecorded).some(action => action.moveName === 'Thunderbolt'), false);
choiceRecorded.field.magicRoom = true;
assert.equal(enumerateMoveActions(choiceRecorded).some(action => action.moveName === 'Thunderbolt'), true);

const assaultVestState = state();
assaultVestState.sides.ai.party[0].item = 'Assault Vest';
assaultVestState.sides.ai.party[0].moves = [{name: 'Toxic'}, {name: 'Tackle'}];
assert.equal(enumerateMoveActions(assaultVestState).some(action => action.moveName === 'Toxic'), false);
assert.equal(enumerateMoveActions(assaultVestState).some(action => action.moveName === 'Tackle'), true);
const assaultVestResolution = deriveMoveResolution(assaultVestState, {
  kind: 'move', actorId: 'ai-1', moveName: 'Toxic', targetIds: ['player-1'],
}, {hit: true});
assert.equal(assaultVestResolution.hit, false);
assert.ok(assaultVestResolution.trace?.notes?.some(note => note.includes('Assault Vest')));
const assaultVestGateGen5 = {...assaultVestState, generation: 5 as const};
assert.equal(enumerateMoveActions(assaultVestGateGen5).some(action => action.moveName === 'Toxic'), true);
const assaultVestMagicRoom = {...assaultVestState, field: {magicRoom: true}};
assert.equal(enumerateMoveActions(assaultVestMagicRoom).some(action => action.moveName === 'Toxic'), true);
const assaultVestEmbargo = {...assaultVestState, sides: {
  ...assaultVestState.sides,
  ai: {...assaultVestState.sides.ai, party: assaultVestState.sides.ai.party.map(pokemon => ({
    ...pokemon, volatile: {embargo: {turns: 2}},
  }))},
}};
assert.equal(enumerateMoveActions(assaultVestEmbargo).some(action => action.moveName === 'Toxic'), true);
const assaultVestKlutz = {...assaultVestState, sides: {
  ...assaultVestState.sides,
  ai: {...assaultVestState.sides.ai, party: assaultVestState.sides.ai.party.map(pokemon => ({
    ...pokemon, ability: 'Klutz', volatile: undefined,
  }))},
}};
assert.equal(enumerateMoveActions(assaultVestKlutz).some(action => action.moveName === 'Toxic'), true);

const ppState = state();
ppState.sides.ai.party[0].moves = [{name: 'Tackle', pp: 2, maxPP: 35}];
const ppNext = recordMoveAction(ppState, move(ppState, 'Tackle'));
assert.equal(ppNext.sides.ai.party[0].moves[0].pp, 1);
const damageNext = applyDamageAction(ppState, move(ppState, 'Tackle'), {'player-1': 25});
assert.equal(damageNext.sides.player.party[0].hp.current, 75);
assert.equal(damageNext.lastDamagingMoveByPokemon?.['player-1'], 'Tackle');

const hpEffectsState = state();
hpEffectsState.sides.ai.party[0].moves = [{name: 'Light of Ruin'}];
const lightOfRuinResolution = deriveMoveResolution(
  hpEffectsState,
  move(hpEffectsState, 'Light of Ruin'),
  {
    hit: true,
    facts: {
      damage: {
        rolls: [100], min: 100, max: 100, targetHp: 100,
        possibleKO: true, guaranteedKO: true,
      },
    },
  },
);
assert.equal(lightOfRuinResolution.hpDeltaByPokemon?.['ai-1'], -50);

hpEffectsState.sides.ai.party[0].moves = [{name: 'Parabolic Charge'}];
const parabolicChargeResolution = deriveMoveResolution(
  hpEffectsState,
  move(hpEffectsState, 'Parabolic Charge'),
  {
    hit: true,
    facts: {
      damage: {
        rolls: [100], min: 100, max: 100, targetHp: 100,
        possibleKO: true, guaranteedKO: true,
      },
    },
  },
);
assert.equal(parabolicChargeResolution.hpDeltaByPokemon?.['ai-1'], 50);

hpEffectsState.sides.player.party[0].ability = 'Liquid Ooze';
hpEffectsState.sides.ai.party[0].ability = undefined;
hpEffectsState.sides.ai.party[0].item = undefined;
hpEffectsState.sides.ai.party[0].moves = [{name: 'Giga Drain'}];
const liquidOozeResolution = deriveMoveResolution(
  hpEffectsState,
  move(hpEffectsState, 'Giga Drain'),
  {
    hit: true,
    facts: {
      damage: {
        rolls: [100], min: 100, max: 100, targetHp: 100,
        possibleKO: true, guaranteedKO: true,
      },
    },
  },
);
assert.equal(liquidOozeResolution.hpDeltaByPokemon?.['ai-1'], -50);
hpEffectsState.sides.ai.party[0].ability = 'Magic Guard';
const liquidOozeMagicGuard = deriveMoveResolution(
  hpEffectsState,
  move(hpEffectsState, 'Giga Drain'),
  {hit: true, facts: {damage: {rolls: [100], min: 100, max: 100, targetHp: 100, possibleKO: true, guaranteedKO: true}}},
);
assert.equal(liquidOozeMagicGuard.hpDeltaByPokemon, undefined);
hpEffectsState.generation = 2;
hpEffectsState.sides.ai.party[0].ability = undefined;
const liquidOozeGen2 = deriveMoveResolution(
  hpEffectsState,
  move(hpEffectsState, 'Giga Drain'),
  {hit: true, facts: {damage: {rolls: [100], min: 100, max: 100, targetHp: 100, possibleKO: true, guaranteedKO: true}}},
);
assert.equal(liquidOozeGen2.hpDeltaByPokemon?.['ai-1'], 50);
hpEffectsState.generation = 9;
hpEffectsState.sides.player.party[0].ability = undefined;
hpEffectsState.sides.ai.party[0].item = 'Big Root';
const bigRootDrain = deriveMoveResolution(
  hpEffectsState,
  move(hpEffectsState, 'Giga Drain'),
  {hit: true, facts: {damage: {rolls: [100], min: 100, max: 100, targetHp: 100, possibleKO: true, guaranteedKO: true}}},
);
assert.equal(bigRootDrain.hpDeltaByPokemon?.['ai-1'], 65);

hpEffectsState.sides.ai.party[0].item = undefined;
hpEffectsState.sides.ai.party[0].moves = [{name: 'Strength Sap'}];
hpEffectsState.sides.player.party[0].ability = 'Liquid Ooze';
const liquidOozeStrengthSap = deriveMoveResolution(
  hpEffectsState,
  move(hpEffectsState, 'Strength Sap'),
  {hit: true},
);
assert.ok((liquidOozeStrengthSap.hpDeltaByPokemon?.['ai-1'] || 0) < 0);

hpEffectsState.generation = 4;
hpEffectsState.sides.ai.party[0].moves = [{name: 'Dream Eater'}];
hpEffectsState.sides.player.party[0].status = 'slp';
const liquidOozeDreamEaterGen4 = deriveMoveResolution(
  hpEffectsState,
  move(hpEffectsState, 'Dream Eater'),
  {hit: true, facts: {damage: {rolls: [100], min: 100, max: 100, targetHp: 100, possibleKO: true, guaranteedKO: true}}},
);
assert.equal(liquidOozeDreamEaterGen4.hpDeltaByPokemon?.['ai-1'], 50);
hpEffectsState.generation = 9;

hpEffectsState.sides.ai.party[0].ability = 'Rock Head';
hpEffectsState.sides.ai.party[0].moves = [{name: 'Light of Ruin'}];
const rockHeadResolution = deriveMoveResolution(
  hpEffectsState,
  move(hpEffectsState, 'Light of Ruin'),
  {
    hit: true,
    facts: {
      damage: {
        rolls: [100], min: 100, max: 100, targetHp: 100,
        possibleKO: true, guaranteedKO: true,
      },
    },
  },
);
assert.equal(rockHeadResolution.hpDeltaByPokemon?.['ai-1'], undefined);

const rockHeadGen2State = state();
rockHeadGen2State.generation = 2;
rockHeadGen2State.sides.ai.party[0].ability = 'Rock Head';
rockHeadGen2State.sides.ai.party[0].moves = [{name: 'Double-Edge'}];
const rockHeadGen2Resolution = deriveMoveResolution(
  rockHeadGen2State,
  move(rockHeadGen2State, 'Double-Edge'),
  {hit: true, facts: {damage: {rolls: [100], min: 100, max: 100, targetHp: 100, possibleKO: true, guaranteedKO: true}}},
);
assert.equal(rockHeadGen2Resolution.hpDeltaByPokemon?.['ai-1'], -25);

hpEffectsState.sides.ai.party[0].ability = undefined;
hpEffectsState.sides.ai.party[0].moves = [{name: 'Mind Blown'}];
const mindBlownResolution = deriveMoveResolution(
  hpEffectsState,
  move(hpEffectsState, 'Mind Blown'),
  {hit: true},
);
assert.equal(mindBlownResolution.hpDeltaByPokemon?.['ai-1'], -50);

hpEffectsState.sides.ai.party[0].moves = [{name: 'High Jump Kick'}];
const crashResolution = deriveMoveResolution(
  hpEffectsState,
  move(hpEffectsState, 'High Jump Kick'),
  {hit: false},
);
assert.equal(crashResolution.hpDeltaByPokemon?.['ai-1'], -50);

hpEffectsState.sides.ai.party[0].ability = 'Rock Head';
const rockHeadCrashResolution = deriveMoveResolution(
  hpEffectsState,
  move(hpEffectsState, 'High Jump Kick'),
  {hit: false},
);
assert.equal(rockHeadCrashResolution.hpDeltaByPokemon?.['ai-1'], -50);

const gen4CrashState = state();
gen4CrashState.generation = 4;
gen4CrashState.sides.ai.party[0].ability = undefined;
gen4CrashState.sides.ai.party[0].moves = [{name: 'High Jump Kick'}];
const gen4CrashResolution = deriveMoveResolution(
  gen4CrashState,
  move(gen4CrashState, 'High Jump Kick'),
  {
    hit: false,
    facts: {
      damage: {
        rolls: [40], min: 40, max: 40, targetHp: 100,
        possibleKO: false, guaranteedKO: false,
      },
    },
    random: () => 0,
  },
);
assert.equal(gen4CrashResolution.hpDeltaByPokemon?.['ai-1'], -20);

gen4CrashState.sides.player.party[0].typeOverride = ['Ghost'];
const gen4GhostCrashResolution = deriveMoveResolution(
  gen4CrashState,
  move(gen4CrashState, 'High Jump Kick'),
  {
    hit: false,
    facts: {
      damage: {
        rolls: [40], min: 40, max: 40, targetHp: 100,
        possibleKO: false, guaranteedKO: false,
      },
    },
    random: () => 0,
  },
);
assert.equal(gen4GhostCrashResolution.hpDeltaByPokemon?.['ai-1'], undefined);

const resolved = resolveMoveAction(state(), move(state(), 'Tackle'), {
  hit: true,
  damageByTarget: {'player-1': 20},
  hpDeltaByPokemon: {'ai-1': -5},
  statusByPokemon: {'player-1': 'brn'},
  boostsByPokemon: {'ai-1': {atk: 1}},
  field: {weather: 'Rain'},
});
assert.equal(resolved.sides.player.party[0].hp.current, 80);
assert.equal(resolved.sides.ai.party[0].hp.current, 95);
assert.equal(resolved.sides.player.party[0].status, 'brn');
assert.equal(resolved.sides.ai.party[0].boosts?.atk, 1);
assert.equal(resolved.field.weather, 'Rain');
assert.equal(resolved.lastDamagingMoveByPokemon?.['player-1'], 'Tackle');
const staleStatusState = state();
staleStatusState.sides.player.party[0].status = 'slp';
staleStatusState.sides.player.party[0].statusTurns = 2;
staleStatusState.sides.player.party[0].toxicCounter = 4;
const staleStatusCleared = resolveMoveAction(staleStatusState, move(staleStatusState, 'Tackle'), {
  statusByPokemon: {'player-1': ''},
});
assert.equal(staleStatusCleared.sides.player.party[0].statusTurns, undefined);
assert.equal(staleStatusCleared.sides.player.party[0].toxicCounter, undefined);
assert.doesNotThrow(() => validateBattleState(staleStatusCleared));

const failed = resolveMoveAction(state(), move(state(), 'Tackle'), {hit: false});
assert.equal(failed.sides.player.party[0].hp.current, 100);
assert.equal(failed.lastDamagingMoveByPokemon, undefined);

const custapTransitionState = state();
custapTransitionState.sides.ai.party[0].item = 'Custap Berry';
custapTransitionState.sides.ai.party[0].hp.current = 25;
const custapTransitionNext = resolveMoveAction(custapTransitionState, move(custapTransitionState, 'Tackle'), {
  hit: true,
});
assert.equal(custapTransitionNext.sides.ai.party[0].item, undefined);
assert.equal(custapTransitionNext.sides.ai.party[0].itemLost, true);
assert.equal(custapTransitionNext.sides.ai.party[0].lastConsumedItem, 'Custap Berry');
assert.ok(custapTransitionNext.lastResolution?.notes?.some(note => note.includes('Custap Berry')));
const custapMissState = {...custapTransitionState, sides: {...custapTransitionState.sides,
  ai: {...custapTransitionState.sides.ai, party: custapTransitionState.sides.ai.party.map(pokemon => ({
    ...pokemon, item: 'Custap Berry', hp: {...pokemon.hp, current: 25},
  }))},
}};
const custapMissNext = resolveMoveAction(custapMissState, move(custapMissState, 'Tackle'), {hit: false});
assert.equal(custapMissNext.sides.ai.party[0].item, undefined);
assert.equal(custapMissNext.sides.ai.party[0].lastConsumedItem, 'Custap Berry');
const custapMagicRoom = {...custapTransitionState, field: {magicRoom: true}};
assert.equal(resolveMoveAction(custapMagicRoom, move(custapMagicRoom, 'Tackle'), {hit: true})
  .sides.ai.party[0].item, 'Custap Berry');
const custapGen3 = {...custapTransitionState, generation: 3 as const};
assert.equal(resolveMoveAction(custapGen3, move(custapGen3, 'Tackle'), {hit: true})
  .sides.ai.party[0].item, 'Custap Berry');
const custapKlutz = {...custapTransitionState, sides: {...custapTransitionState.sides,
  ai: {...custapTransitionState.sides.ai, party: custapTransitionState.sides.ai.party.map(pokemon => ({
    ...pokemon, ability: 'Klutz',
  }))},
}};
assert.equal(resolveMoveAction(custapKlutz, move(custapKlutz, 'Tackle'), {hit: true})
  .sides.ai.party[0].item, 'Custap Berry');

const switchState = state();
switchState.sides.ai.party[0].typeOverride = ['Water'];
switchState.sides.ai.party[0].abilityOverride = 'Simple';
switchState.sides.ai.party[0].speciesOverride = 'Charizard';
switchState.sides.ai.party[0].statOverrides = {spe: 100};
switchState.sides.ai.party[0].originalMoves = [{name: 'Tackle', pp: 0, maxPP: 35}];
switchState.sides.ai.party[0].moves = [{name: 'Thunderbolt', pp: 5, maxPP: 15}];
switchState.lastMoveByPokemon = {'ai-1': 'Tackle'};
switchState.lastMoveUsedByPokemon = {'ai-1': 'Thunderbolt', 'player-1': 'Tackle'};
switchState.lastMoveTargetedByPokemon = {'ai-1': 'Tackle', 'player-1': 'Thunderbolt'};
switchState.lastDamagingMoveByPokemon = {'ai-1': 'Tackle', 'player-1': 'Thunderbolt'};
switchState.selectedMoveByPokemon = {
  'ai-1': {moveName: 'Protect'},
  'player-1': {moveName: 'Tackle'},
};
switchState.moveStreakByPokemon = {
  'ai-1': {moveName: 'Protect', count: 2},
  'player-1': {moveName: 'Protect', count: 2},
};
addReplacement(switchState, 'ai', {
  id: 'ai-2', species: 'Bulbasaur', level: 100, hp: {current: 100, max: 100}, moves: [],
});
const switched = applySwitchAction(switchState, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2',
});
const switchedActor = switched.sides.ai.party[0];
assert.equal(switchedActor.typeOverride, undefined);
assert.equal(switchedActor.abilityOverride, undefined);
assert.equal(switchedActor.speciesOverride, undefined);
assert.equal(switchedActor.statOverrides, undefined);
assert.deepEqual(switchedActor.moves, [{name: 'Tackle', pp: 0, maxPP: 35}]);
assert.deepEqual(switched.lastMoveUsedByPokemon, {'player-1': 'Tackle'});
assert.deepEqual(switched.lastMoveTargetedByPokemon, {'player-1': 'Thunderbolt'});
assert.deepEqual(switched.lastDamagingMoveByPokemon, {'player-1': 'Thunderbolt'});
assert.deepEqual(switched.selectedMoveByPokemon, {'player-1': {moveName: 'Tackle'}});
assert.deepEqual(switched.moveStreakByPokemon, {'player-1': {moveName: 'Protect', count: 2}});
assert.equal(switched.lastMoveByPokemon?.['ai-1'], 'Tackle');

function switchLifecycleState(generation: BattleState['generation'], ability: string): BattleState {
  const next = {...state(), generation};
  next.sides.ai.party[0] = {
    ...next.sides.ai.party[0],
    ability,
    hp: {current: 60, max: 100},
    status: 'brn',
    statusTurns: 2,
    toxicCounter: 4,
  };
  addReplacement(next, 'ai', {
    id: 'ai-2', species: 'Bulbasaur', level: 100, hp: {current: 100, max: 100}, moves: [],
  });
  return next;
}

const naturalCureGen2 = applySwitchAction(switchLifecycleState(2, 'Natural Cure'), {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2',
});
assert.equal(naturalCureGen2.sides.ai.party[0].status, 'brn');
const naturalCureGen3 = applySwitchAction(switchLifecycleState(3, 'Natural Cure'), {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2',
});
assert.equal(naturalCureGen3.sides.ai.party[0].status, '');
assert.equal(naturalCureGen3.sides.ai.party[0].toxicCounter, undefined);

const regeneratorGen4 = applySwitchAction(switchLifecycleState(4, 'Regenerator'), {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2',
});
assert.equal(regeneratorGen4.sides.ai.party[0].hp.current, 60);
const regeneratorGen5 = applySwitchAction(switchLifecycleState(5, 'Regenerator'), {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2',
});
assert.equal(regeneratorGen5.sides.ai.party[0].hp.current, 93);

const protectState = state();
protectState.sides.ai.party[0].moves = [{name: 'Protect'}];
const protectAction = move(protectState, 'Protect', ['ai-1']);
const protectedState = applyAction(protectState, protectAction, deriveMoveResolution(protectState, protectAction));
assert.equal(protectedState.sides.ai.party[0].volatile?.protected?.turns, 1);
assert.equal(protectedState.sides.ai.party[0].volatile?.protected?.moveName, 'Protect');
assert.equal(beginNextTurn(protectedState).sides.ai.party[0].volatile, undefined);

function contactAgainstProtection(moveName: string, generation = 9) {
  const next = state();
  next.generation = generation as BattleState['generation'];
  next.sides.ai.party[0].moves = [{name: 'Tackle'}];
  next.sides.player.party[0].moves = [{name: moveName}];
  const guardAction = enumerateMoveActions(next, 'player').find(action => action.moveName === moveName);
  assert.ok(guardAction);
  const guarded = applyAction(next, guardAction!, deriveMoveResolution(next, guardAction!, {hit: true}));
  const attackAction: MoveAction = {
    kind: 'move', actorId: 'ai-1', moveName: 'Tackle', targetIds: ['player-1'],
  };
  return deriveMoveResolution(guarded, attackAction, {hit: true, facts: {moveCategory: 'Physical'}});
}

const kingsShieldContact = contactAgainstProtection("King's Shield");
assert.equal(kingsShieldContact.boostsByPokemon?.['ai-1']?.atk, -1);
const banefulBunkerContact = contactAgainstProtection('Baneful Bunker');
assert.equal(banefulBunkerContact.statusByPokemon?.['ai-1'], 'psn');
const spikyShieldContact = contactAgainstProtection('Spiky Shield');
assert.equal(spikyShieldContact.hpDeltaByPokemon?.['ai-1'], -12);
const silkTrapContact = contactAgainstProtection('Silk Trap');
assert.equal(silkTrapContact.boostsByPokemon?.['ai-1']?.spe, -1);
const obstructContact = contactAgainstProtection('Obstruct');
assert.equal(obstructContact.boostsByPokemon?.['ai-1']?.def, -2);
const burningBulwarkContact = contactAgainstProtection('Burning Bulwark');
assert.equal(burningBulwarkContact.statusByPokemon?.['ai-1'], 'brn');
const personalProtectionBreakState = state();
personalProtectionBreakState.sides.ai.party[0].moves = [{name: 'Feint'}];
personalProtectionBreakState.sides.player.party[0].moves = [{name: "King's Shield"}];
const personalProtectionAction = enumerateMoveActions(personalProtectionBreakState, 'player')
  .find(action => action.moveName === "King's Shield")!;
const personalProtected = applyAction(
  personalProtectionBreakState,
  personalProtectionAction,
  deriveMoveResolution(personalProtectionBreakState, personalProtectionAction, {hit: true}),
);
const feintAction: MoveAction = {kind: 'move', actorId: 'ai-1', moveName: 'Feint', targetIds: ['player-1']};
const feintPersonalResolution = deriveMoveResolution(personalProtected, feintAction, {hit: true});
assert.equal(feintPersonalResolution.volatileByPokemon?.['player-1']?.protected, null);
assert.equal(applyAction(personalProtected, feintAction, feintPersonalResolution)
  .sides.player.party[0].volatile?.protected, undefined);

const unseenFistState = state();
unseenFistState.sides.ai.party[0].ability = 'Unseen Fist';
unseenFistState.sides.ai.party[0].moves = [{name: 'Tackle'}];
unseenFistState.sides.player.party[0].moves = [{name: 'Protect'}];
const unseenFistProtectAction = enumerateMoveActions(unseenFistState, 'player')
  .find(action => action.moveName === 'Protect')!;
const unseenFistProtected = applyAction(
  unseenFistState,
  unseenFistProtectAction,
  deriveMoveResolution(unseenFistState, unseenFistProtectAction, {hit: true}),
);
const unseenFistResolution = deriveMoveResolution(unseenFistProtected, move(unseenFistProtected, 'Tackle'), {
  hit: true, facts: {
    moveCategory: 'Physical',
    damage: {rolls: [10], min: 10, max: 10, targetHp: 100, possibleKO: false, guaranteedKO: false},
  },
});
assert.ok((unseenFistResolution.damageByTarget?.['player-1'] || 0) > 0);
assert.equal(unseenFistResolution.trace?.notes?.some(note => note.includes('blocked by Protect')), false);

unseenFistProtected.sides.ai.party[0].moves = [{name: 'Thunderbolt'}];
const unseenFistNonContactResolution = deriveMoveResolution(
  unseenFistProtected,
  move(unseenFistProtected, 'Thunderbolt'),
  {
    hit: true,
    facts: {
      moveCategory: 'Special',
      damage: {rolls: [10], min: 10, max: 10, targetHp: 100, possibleKO: false, guaranteedKO: false},
    },
  },
);
assert.equal(unseenFistNonContactResolution.damageByTarget?.['player-1'], undefined);
assert.ok(unseenFistNonContactResolution.trace?.notes?.some(note => note.includes('blocked by Protect')));

const unseenFistQuickGuardState = doublesState();
unseenFistQuickGuardState.sides.ai.party[0].ability = 'Unseen Fist';
unseenFistQuickGuardState.sides.ai.party[0].moves = [{name: 'Mach Punch'}];
unseenFistQuickGuardState.sides.player.party[0].moves = [{name: 'Quick Guard'}];
const unseenFistQuickGuardAction = enumerateMoveActions(unseenFistQuickGuardState, 'player')
  .find(action => action.moveName === 'Quick Guard')!;
const unseenFistQuickGuardApplied = applyAction(
  unseenFistQuickGuardState,
  unseenFistQuickGuardAction,
  deriveMoveResolution(unseenFistQuickGuardState, unseenFistQuickGuardAction, {hit: true}),
);
const unseenFistQuickGuardResolution = deriveMoveResolution(unseenFistQuickGuardApplied, {
  kind: 'move', actorId: 'ai-1', moveName: 'Mach Punch', targetIds: ['player-1'],
}, {
  hit: true,
  facts: {
    moveCategory: 'Physical', priority: 1,
    damage: {rolls: [10], min: 10, max: 10, targetHp: 100, possibleKO: false, guaranteedKO: false},
  },
});
assert.ok((unseenFistQuickGuardResolution.damageByTarget?.['player-1'] || 0) > 0);
assert.equal(unseenFistQuickGuardResolution.trace?.notes?.some(note => note.includes('blocked by Protect')), false);

const unavailableUnseenFist = {...unseenFistProtected, generation: 7 as BattleState['generation']};
const unavailableUnseenFistResolution = deriveMoveResolution(
  unavailableUnseenFist,
  move(unavailableUnseenFist, 'Tackle'),
  {hit: true, facts: {moveCategory: 'Physical'}},
);
assert.equal(unavailableUnseenFistResolution.damageByTarget?.['player-1'], undefined);
assert.ok(unavailableUnseenFistResolution.trace?.notes?.some(note => note.includes('blocked by Protect')));

const unseenFistMaxGuard = {...unseenFistProtected, generation: 8 as BattleState['generation']};
unseenFistMaxGuard.sides.player.party[0].volatile = {protected: {turns: 1, moveName: 'Max Guard'}};
const unseenFistMaxGuardResolution = deriveMoveResolution(unseenFistMaxGuard, move(unseenFistMaxGuard, 'Tackle'), {
  hit: true, facts: {moveCategory: 'Physical'},
});
assert.equal(unseenFistMaxGuardResolution.damageByTarget?.['player-1'], undefined);
assert.ok(unseenFistMaxGuardResolution.trace?.notes?.some(note => note.includes('blocked by Protect')));

function contactStateAgainst(
  targetPatch: Partial<PokemonState>,
  moveName = 'Tackle',
  generation: BattleState['generation'] = 9,
  actorPatch: Partial<PokemonState> = {},
) {
  const next = state();
  next.generation = generation;
  next.sides.ai.party[0] = {...next.sides.ai.party[0], ...actorPatch, moves: [{name: moveName}]};
  next.sides.player.party[0] = {...next.sides.player.party[0], ...targetPatch};
  return next;
}

function contactResolutionAgainst(
  targetPatch: Partial<PokemonState>,
  moveName = 'Tackle',
  generation: BattleState['generation'] = 9,
  damage = 10,
  actorPatch: Partial<PokemonState> = {},
  random: () => number = Math.random,
  moveCategory: MoveCategory = 'Physical',
  moveType?: string,
  isMultiHit = false,
  hitCount = 1,
) {
  const next = contactStateAgainst(targetPatch, moveName, generation, actorPatch);
  return deriveMoveResolution(next, move(next, moveName), {
    hit: true,
    facts: {
      moveCategory,
      moveType,
      isMultiHit,
      damage: {
        rolls: [damage], min: damage, max: damage,
        hits: hitCount > 1 ? hitCount : undefined,
        targetHp: next.sides.player.party[0].hp.current,
        possibleKO: damage >= next.sides.player.party[0].hp.current,
        guaranteedKO: damage >= next.sides.player.party[0].hp.current,
      },
    },
    random,
  });
}

assert.equal(contactResolutionAgainst({ability: 'Rough Skin'}).hpDeltaByPokemon?.['ai-1'], -12);
const callerDefinedContactState = contactStateAgainst({}, 'Caller Defined Contact Move');
callerDefinedContactState.sides.ai.party[0].moves = [{
  name: 'Caller Defined Contact Move', basePower: 40, type: 'Normal', category: 'Physical', contact: true,
}];
const callerDefinedContactResolution = deriveMoveResolution(
  callerDefinedContactState,
  move(callerDefinedContactState, 'Caller Defined Contact Move'),
  {hit: true, facts: {
    moveCategory: 'Physical', damage: {rolls: [10], min: 10, max: 10,
      targetHp: 100, possibleKO: false, guaranteedKO: false},
  }},
);
assert.equal(callerDefinedContactResolution.hpDeltaByPokemon, undefined);
callerDefinedContactState.sides.player.party[0].ability = 'Rough Skin';
const callerDefinedContactWithRoughSkin = deriveMoveResolution(
  callerDefinedContactState,
  move(callerDefinedContactState, 'Caller Defined Contact Move'),
  {hit: true, facts: {
    moveCategory: 'Physical', damage: {rolls: [10], min: 10, max: 10,
      targetHp: 100, possibleKO: false, guaranteedKO: false},
  }},
);
assert.equal(callerDefinedContactWithRoughSkin.hpDeltaByPokemon?.['ai-1'], -12);
const stickyBarbContactState = state();
stickyBarbContactState.sides.player.party[0].item = 'Sticky Barb';
const stickyBarbContactAction = move(stickyBarbContactState, 'Tackle');
const stickyBarbContactResolution = deriveMoveResolution(stickyBarbContactState, stickyBarbContactAction, {
  hit: true, facts: {moveCategory: 'Physical', damage: {rolls: [10], min: 10, max: 10,
    targetHp: 100, possibleKO: false, guaranteedKO: false}},
});
assert.deepEqual(stickyBarbContactResolution.itemByPokemon, {'ai-1': 'Sticky Barb', 'player-1': null});
const stickyBarbContactApplied = applyAction(
  stickyBarbContactState, stickyBarbContactAction, stickyBarbContactResolution,
);
assert.equal(stickyBarbContactApplied.sides.ai.party[0].item, 'Sticky Barb');
assert.equal(stickyBarbContactApplied.sides.player.party[0].item, undefined);
const stickyBarbNoTransfer = contactResolutionAgainst({item: 'Sticky Barb'}, 'Thunderbolt', 9, 10, {}, Math.random, 'Special');
assert.equal(stickyBarbNoTransfer.itemByPokemon, undefined);
const stickyBarbHeld = contactResolutionAgainst({item: 'Sticky Barb'}, 'Tackle', 9, 10, {item: 'Leftovers'});
assert.equal(stickyBarbHeld.itemByPokemon, undefined);
const stickyBarbStickyHold = contactResolutionAgainst({item: 'Sticky Barb', ability: 'Sticky Hold'});
assert.equal(stickyBarbStickyHold.itemByPokemon, undefined);
const stickyBarbSubstitute = contactResolutionAgainst({item: 'Sticky Barb', substituteHp: 20}, 'Tackle', 9, 10);
assert.equal(stickyBarbSubstitute.itemByPokemon, undefined);
const shellBellResolution = contactResolutionAgainst(
  {}, 'Tackle', 9, 32, {item: 'Shell Bell', hp: {current: 50, max: 100}},
);
assert.equal(shellBellResolution.hpDeltaByPokemon?.['ai-1'], 4);
const shellBellApplied = applyAction(
  contactStateAgainst({}, 'Tackle', 9, {item: 'Shell Bell', hp: {current: 50, max: 100}}),
  {kind: 'move', actorId: 'ai-1', moveName: 'Tackle', targetIds: ['player-1']},
  shellBellResolution,
);
assert.equal(shellBellApplied.sides.ai.party[0].hp.current, 54);
const shellBellSubstitute = contactResolutionAgainst(
  {substituteHp: 10}, 'Tackle', 9, 20, {item: 'Shell Bell', hp: {current: 50, max: 100}},
);
assert.equal(shellBellSubstitute.hpDeltaByPokemon?.['ai-1'], 1);
const shellBellOnlySubstitute = contactResolutionAgainst(
  {substituteHp: 20}, 'Tackle', 9, 10, {item: 'Shell Bell', hp: {current: 50, max: 100}},
);
assert.equal(shellBellOnlySubstitute.hpDeltaByPokemon, undefined);
const shellBellSpreadState = doublesState();
shellBellSpreadState.sides.ai.party[0] = {
  ...shellBellSpreadState.sides.ai.party[0], item: 'Shell Bell', hp: {current: 50, max: 100},
};
const shellBellSpreadAction = move(shellBellSpreadState, 'Rock Slide', ['player-1', 'player-2']);
const shellBellSpread = deriveMoveResolution(shellBellSpreadState, shellBellSpreadAction, {
  hit: true,
  facts: {moveCategory: 'Physical', damageByTarget: {
    'player-1': {rolls: [32], min: 32, max: 32, targetHp: 100, possibleKO: false, guaranteedKO: false},
    'player-2': {rolls: [32], min: 32, max: 32, targetHp: 100, possibleKO: false, guaranteedKO: false},
  }},
});
assert.equal(shellBellSpread.hpDeltaByPokemon?.['ai-1'], 8);
const shellBellHealBlock = contactResolutionAgainst(
  {}, 'Tackle', 9, 32,
  {item: 'Shell Bell', hp: {current: 50, max: 100}, volatile: {healBlock: {turns: 2}}},
);
assert.equal(shellBellHealBlock.hpDeltaByPokemon, undefined);
const shellBellRedCardState = contactStateAgainst(
  {item: 'Red Card'}, 'Tackle', 9, {item: 'Shell Bell', hp: {current: 50, max: 100}},
);
addReplacement(shellBellRedCardState, 'ai', {
  id: 'ai-2', species: 'Bulbasaur', level: 100, hp: {current: 100, max: 100}, moves: [],
});
const shellBellRedCardAction = move(shellBellRedCardState, 'Tackle');
const shellBellRedCard = deriveMoveResolution(shellBellRedCardState, shellBellRedCardAction, {
  hit: true,
  facts: {moveCategory: 'Physical', damage: {rolls: [32], min: 32, max: 32,
    targetHp: 100, possibleKO: false, guaranteedKO: false}},
});
assert.equal(shellBellRedCard.forcedSwitchByPokemon?.['ai-1'], true);
assert.equal(shellBellRedCard.hpDeltaByPokemon, undefined);
const berryJuiceResolution = contactResolutionAgainst(
  {item: 'Berry Juice', hp: {current: 60, max: 100}}, 'Tackle', 9, 10,
);
assert.equal(berryJuiceResolution.hpDeltaByPokemon?.['player-1'], 20);
assert.equal(berryJuiceResolution.itemByPokemon?.['player-1'], null);
assert.equal(berryJuiceResolution.consumedItemByPokemon?.['player-1'], 'Berry Juice');
const berryJuiceApplied = applyAction(
  contactStateAgainst({item: 'Berry Juice', hp: {current: 60, max: 100}}),
  {kind: 'move', actorId: 'ai-1', moveName: 'Tackle', targetIds: ['player-1']},
  berryJuiceResolution,
);
assert.equal(berryJuiceApplied.sides.player.party[0].hp.current, 70);
const berryJuiceCheekPouch = state();
berryJuiceCheekPouch.sides.player.party[0].item = 'Berry Juice';
berryJuiceCheekPouch.sides.player.party[0].ability = 'Cheek Pouch';
berryJuiceCheekPouch.sides.player.party[0].hp.current = 20;
assert.equal(advanceTurn(berryJuiceCheekPouch).sides.player.party[0].hp.current, 40);
const endTurnStatusBerryCheekPouch = state();
endTurnStatusBerryCheekPouch.sides.player.party[0].item = 'Cheri Berry';
endTurnStatusBerryCheekPouch.sides.player.party[0].ability = 'Cheek Pouch';
endTurnStatusBerryCheekPouch.sides.player.party[0].status = 'par';
endTurnStatusBerryCheekPouch.sides.player.party[0].hp.current = 50;
const endTurnStatusBerryNext = advanceTurn(endTurnStatusBerryCheekPouch);
assert.equal(endTurnStatusBerryNext.sides.player.party[0].hp.current, 83);
assert.equal(endTurnStatusBerryNext.sides.player.party[0].status, '');
const berryJuiceOnlySubstitute = contactResolutionAgainst(
  {item: 'Berry Juice', hp: {current: 60, max: 100}, substituteHp: 20}, 'Tackle', 9, 10,
);
assert.equal(berryJuiceOnlySubstitute.hpDeltaByPokemon, undefined);
const berryJuiceMagicRoom = {...contactStateAgainst(
  {item: 'Berry Juice', hp: {current: 60, max: 100}}, 'Tackle', 9,
), field: {magicRoom: true}};
assert.equal(deriveMoveResolution(berryJuiceMagicRoom, move(berryJuiceMagicRoom, 'Tackle'), {
  hit: true, facts: {moveCategory: 'Physical', damage: {rolls: [10], min: 10, max: 10,
    targetHp: 60, possibleKO: false, guaranteedKO: false}},
}).hpDeltaByPokemon, undefined);
const berryJuiceGen1 = contactResolutionAgainst(
  {item: 'Berry Juice', hp: {current: 60, max: 100}}, 'Tackle', 1, 10,
);
assert.equal(berryJuiceGen1.hpDeltaByPokemon, undefined);
const shellBellKlutz = contactResolutionAgainst(
  {}, 'Tackle', 9, 32, {item: 'Shell Bell', ability: 'Klutz', hp: {current: 50, max: 100}},
);
assert.equal(shellBellKlutz.hpDeltaByPokemon, undefined);
const shellBellGen2 = contactResolutionAgainst(
  {}, 'Tackle', 2, 32, {item: 'Shell Bell', hp: {current: 50, max: 100}},
);
assert.equal(shellBellGen2.hpDeltaByPokemon, undefined);
assert.equal(contactResolutionAgainst({ability: 'Rough Skin'}, 'Tackle', 9, 10, {ability: 'Mold Breaker'})
  .hpDeltaByPokemon?.['ai-1'], undefined);
assert.equal(contactResolutionAgainst({ability: 'Static'}, 'Tackle', 9, 10, {ability: 'Mold Breaker'}, () => 0)
  .statusByPokemon?.['ai-1'], undefined);
assert.equal(contactResolutionAgainst({ability: 'Iron Barbs', item: 'Rocky Helmet'}).hpDeltaByPokemon?.['ai-1'], -28);
assert.equal(contactResolutionAgainst({ability: 'Aftermath', hp: {current: 10, max: 100}})
  .hpDeltaByPokemon?.['ai-1'], -25);
assert.deepEqual(contactResolutionAgainst({ability: 'Anger Shell'}, 'Tackle', 9, 60)
  .boostsByPokemon?.['player-1'], {atk: 1, spa: 1, spe: 1, def: -1, spd: -1});
assert.equal(contactResolutionAgainst({ability: 'Anger Shell'}, 'Tackle', 8, 60)
  .boostsByPokemon, undefined);
assert.deepEqual(contactResolutionAgainst({ability: 'Anger Shell'}, 'Tackle', 9, 60, {}, Math.random, 'Physical', undefined, true)
  .boostsByPokemon?.['player-1'], {atk: 1, spa: 1, spe: 1, def: -1, spd: -1});
assert.equal(contactResolutionAgainst({ability: 'Anger Shell'}, 'Rock Slide', 9, 60, {ability: 'Sheer Force'})
  .boostsByPokemon, undefined);
assert.deepEqual(contactResolutionAgainst({ability: 'Anger Shell'}, 'Rock Slide', 9, 60,
  {ability: 'Sheer Force'}, Math.random, 'Physical', undefined, true)
  .boostsByPokemon?.['player-1'], {atk: 1, spa: 1, spe: 1, def: -1, spd: -1});
assert.equal(contactResolutionAgainst({ability: 'Anger Shell', hp: {current: 40, max: 100}}, 'Tackle', 9, 10)
  .boostsByPokemon, undefined);
assert.equal(contactResolutionAgainst({ability: 'Anger Shell', substituteHp: 60}, 'Tackle', 9, 60)
  .boostsByPokemon, undefined);
assert.equal(contactResolutionAgainst({ability: 'Anger Shell'}, 'Tackle', 9, 100)
  .boostsByPokemon, undefined);
const angerPointState = state();
angerPointState.sides.player.party[0].ability = 'Anger Point';
const angerPointResolution = deriveMoveResolution(angerPointState, move(angerPointState, 'Tackle'), {
  hit: true, facts: {moveCategory: 'Physical', criticalHit: true,
    damage: {rolls: [10], min: 10, max: 10, targetHp: 100, possibleKO: false, guaranteedKO: false}},
});
assert.deepEqual(angerPointResolution.boostsByPokemon?.['player-1'], {atk: 6});
const angerPointSubstitute = {...angerPointState, sides: {...angerPointState.sides,
  player: {...angerPointState.sides.player, party: angerPointState.sides.player.party.map(pokemon => ({
    ...pokemon, substituteHp: 20,
  }))},
}};
assert.deepEqual(deriveMoveResolution(angerPointSubstitute, move(angerPointSubstitute, 'Tackle'), {
  hit: true, facts: {moveCategory: 'Physical', criticalHit: true,
    damage: {rolls: [10], min: 10, max: 10, targetHp: 100, possibleKO: false, guaranteedKO: false}},
}).boostsByPokemon?.['player-1'], {atk: 6});
const angerPointNonCritical = deriveMoveResolution(angerPointState, move(angerPointState, 'Tackle'), {
  hit: true, facts: {moveCategory: 'Physical',
    damage: {rolls: [10], min: 10, max: 10, targetHp: 100, possibleKO: false, guaranteedKO: false}},
});
assert.equal(angerPointNonCritical.boostsByPokemon, undefined);
const angerPointKO = deriveMoveResolution(angerPointState, move(angerPointState, 'Tackle'), {
  hit: true, facts: {moveCategory: 'Physical', criticalHit: true,
    damage: {rolls: [100], min: 100, max: 100, targetHp: 100, possibleKO: true, guaranteedKO: true}},
});
assert.equal(angerPointKO.boostsByPokemon, undefined);
const angerPointGen3 = {...angerPointState, generation: 3 as const};
assert.equal(deriveMoveResolution(angerPointGen3, move(angerPointGen3, 'Tackle'), {
  hit: true, facts: {moveCategory: 'Physical', criticalHit: true,
    damage: {rolls: [10], min: 10, max: 10, targetHp: 100, possibleKO: false, guaranteedKO: false}},
}).boostsByPokemon, undefined);
const angerPointMoldBreaker = {...angerPointState, sides: {...angerPointState.sides,
  ai: {...angerPointState.sides.ai, party: angerPointState.sides.ai.party.map(pokemon => ({
    ...pokemon, ability: 'Mold Breaker',
  }))},
}};
assert.equal(deriveMoveResolution(angerPointMoldBreaker, move(angerPointMoldBreaker, 'Tackle'), {
  hit: true, facts: {moveCategory: 'Physical', criticalHit: true,
    damage: {rolls: [10], min: 10, max: 10, targetHp: 100, possibleKO: false, guaranteedKO: false}},
}).boostsByPokemon, undefined);
const cottonDownState = doublesState();
cottonDownState.sides.player.party[0].ability = 'Cotton Down';
const cottonDownResolution = deriveMoveResolution(cottonDownState, move(cottonDownState, 'Tackle'), {
  hit: true, facts: {moveCategory: 'Physical',
    damage: {rolls: [10], min: 10, max: 10, targetHp: 100, possibleKO: false, guaranteedKO: false}},
});
assert.deepEqual(cottonDownResolution.boostsByPokemon, {
  'ai-1': {spe: -1}, 'ai-2': {spe: -1}, 'player-2': {spe: -1},
});
const cottonDownMultiHit = deriveMoveResolution(cottonDownState, move(cottonDownState, 'Tackle'), {
  hit: true, facts: {moveCategory: 'Physical', isMultiHit: true,
    damage: {rolls: [5, 5], min: 10, max: 10, targetHp: 100, possibleKO: false, guaranteedKO: false}},
});
assert.deepEqual(cottonDownMultiHit.boostsByPokemon, {
  'ai-1': {spe: -1}, 'ai-2': {spe: -1}, 'player-2': {spe: -1},
});
const cottonDownSubstitute = {...cottonDownState, sides: {...cottonDownState.sides,
  player: {...cottonDownState.sides.player, party: cottonDownState.sides.player.party.map(pokemon => ({
    ...pokemon, substituteHp: pokemon.id === 'player-1' ? 20 : pokemon.substituteHp,
  }))},
}};
assert.deepEqual(deriveMoveResolution(cottonDownSubstitute, move(cottonDownSubstitute, 'Tackle'), {
  hit: true, facts: {moveCategory: 'Physical',
    damage: {rolls: [10], min: 10, max: 10, targetHp: 100, possibleKO: false, guaranteedKO: false}},
}).boostsByPokemon?.['ai-1'], {spe: -1});
const cottonDownFaintedAlly = {...cottonDownState, sides: {...cottonDownState.sides,
  player: {...cottonDownState.sides.player, party: cottonDownState.sides.player.party.map(pokemon => ({
    ...pokemon, hp: pokemon.id === 'player-2' ? {current: 0, max: 100} : pokemon.hp,
  }))},
}};
assert.equal(deriveMoveResolution(cottonDownFaintedAlly, move(cottonDownFaintedAlly, 'Tackle'), {
  hit: true, facts: {moveCategory: 'Physical',
    damage: {rolls: [10], min: 10, max: 10, targetHp: 100, possibleKO: false, guaranteedKO: false}},
}).boostsByPokemon?.['player-2'], undefined);
const cottonDownStatus = deriveMoveResolution(cottonDownState, move(cottonDownState, 'Splash'), {
  hit: true, facts: {moveCategory: 'Status'},
});
assert.equal(cottonDownStatus.boostsByPokemon, undefined);
const cottonDownGen7 = {...cottonDownState, generation: 7 as const};
assert.equal(deriveMoveResolution(cottonDownGen7, move(cottonDownGen7, 'Tackle'), {
  hit: true, facts: {moveCategory: 'Physical',
    damage: {rolls: [10], min: 10, max: 10, targetHp: 100, possibleKO: false, guaranteedKO: false}},
}).boostsByPokemon, undefined);
const cottonDownMoldBreaker = {...cottonDownState, sides: {...cottonDownState.sides,
  ai: {...cottonDownState.sides.ai, party: cottonDownState.sides.ai.party.map(pokemon => ({
    ...pokemon, ability: pokemon.id === 'ai-1' ? 'Mold Breaker' : pokemon.ability,
  }))},
}};
assert.equal(deriveMoveResolution(cottonDownMoldBreaker, move(cottonDownMoldBreaker, 'Tackle'), {
  hit: true, facts: {moveCategory: 'Physical',
    damage: {rolls: [10], min: 10, max: 10, targetHp: 100, possibleKO: false, guaranteedKO: false}},
}).boostsByPokemon, undefined);
const emergencyExitState = state();
emergencyExitState.sides.player.party[0].ability = 'Emergency Exit';
addReplacement(emergencyExitState, 'player', {
  id: 'player-2', species: 'Bulbasaur', level: 100, hp: {current: 100, max: 100}, moves: [],
});
const emergencyExitResolution = deriveMoveResolution(
  emergencyExitState, move(emergencyExitState, 'Tackle'), {
    hit: true, facts: {moveCategory: 'Physical',
      damage: {rolls: [60], min: 60, max: 60, targetHp: 100, possibleKO: false, guaranteedKO: false}},
  },
);
assert.deepEqual(emergencyExitResolution.forcedSwitchByPokemon, {'player-1': true});
const emergencyExitApplied = applyAction(emergencyExitState, move(emergencyExitState, 'Tackle'), emergencyExitResolution);
assert.deepEqual(emergencyExitApplied.pendingForcedSwitchIds, ['player-1']);
const wimpOutState = {...emergencyExitState, sides: {...emergencyExitState.sides,
  player: {...emergencyExitState.sides.player, party: emergencyExitState.sides.player.party.map(pokemon => ({
    ...pokemon, ability: pokemon.id === 'player-1' ? 'Wimp Out' : pokemon.ability,
  }))},
}};
assert.deepEqual(deriveMoveResolution(wimpOutState, move(wimpOutState, 'Tackle'), {
  hit: true, facts: {moveCategory: 'Physical',
    damage: {rolls: [60], min: 60, max: 60, targetHp: 100, possibleKO: false, guaranteedKO: false}},
}).forcedSwitchByPokemon, {'player-1': true});
const emergencyExitAlreadyLow = {...emergencyExitState, sides: {...emergencyExitState.sides,
  player: {...emergencyExitState.sides.player, party: emergencyExitState.sides.player.party.map(pokemon => ({
    ...pokemon, id: pokemon.id === 'player-1' ? 'player-1' : pokemon.id,
    hp: pokemon.id === 'player-1' ? {current: 40, max: 100} : pokemon.hp,
  }))},
}};
assert.equal(deriveMoveResolution(emergencyExitAlreadyLow, move(emergencyExitAlreadyLow, 'Tackle'), {
  hit: true, facts: {moveCategory: 'Physical',
    damage: {rolls: [10], min: 10, max: 10, targetHp: 40, possibleKO: false, guaranteedKO: false}},
}).forcedSwitchByPokemon, undefined);
const emergencyExitSubstitute = {...emergencyExitState, sides: {...emergencyExitState.sides,
  player: {...emergencyExitState.sides.player, party: emergencyExitState.sides.player.party.map(pokemon => ({
    ...pokemon, substituteHp: pokemon.id === 'player-1' ? 60 : pokemon.substituteHp,
  }))},
}};
assert.equal(deriveMoveResolution(emergencyExitSubstitute, move(emergencyExitSubstitute, 'Tackle'), {
  hit: true, facts: {moveCategory: 'Physical',
    damage: {rolls: [60], min: 60, max: 60, targetHp: 100, possibleKO: false, guaranteedKO: false}},
}).forcedSwitchByPokemon, undefined);
const emergencyExitSubstituteBreak = {...emergencyExitState, sides: {...emergencyExitState.sides,
  player: {...emergencyExitState.sides.player, party: emergencyExitState.sides.player.party.map(pokemon => ({
    ...pokemon, hp: pokemon.id === 'player-1' ? {current: 60, max: 100} : pokemon.hp,
    substituteHp: pokemon.id === 'player-1' ? 50 : pokemon.substituteHp,
  }))},
}};
assert.deepEqual(deriveMoveResolution(emergencyExitSubstituteBreak, move(emergencyExitSubstituteBreak, 'Tackle'), {
  hit: true, facts: {moveCategory: 'Physical',
    damage: {rolls: [60], min: 60, max: 60, targetHp: 100, possibleKO: false, guaranteedKO: false}},
}).forcedSwitchByPokemon, {'player-1': true});
const emergencyExitNoReplacement = {...emergencyExitState, sides: {...emergencyExitState.sides,
  player: {...emergencyExitState.sides.player, party: emergencyExitState.sides.player.party.filter(pokemon => pokemon.id !== 'player-2')},
}};
assert.equal(deriveMoveResolution(emergencyExitNoReplacement, move(emergencyExitNoReplacement, 'Tackle'), {
  hit: true, facts: {moveCategory: 'Physical',
    damage: {rolls: [60], min: 60, max: 60, targetHp: 100, possibleKO: false, guaranteedKO: false}},
}).forcedSwitchByPokemon, undefined);
const emergencyExitGen6 = {...emergencyExitState, generation: 6 as const};
assert.equal(deriveMoveResolution(emergencyExitGen6, move(emergencyExitGen6, 'Tackle'), {
  hit: true, facts: {moveCategory: 'Physical',
    damage: {rolls: [60], min: 60, max: 60, targetHp: 100, possibleKO: false, guaranteedKO: false}},
}).forcedSwitchByPokemon, undefined);
const emergencyExitMoldBreaker = {...emergencyExitState, sides: {...emergencyExitState.sides,
  ai: {...emergencyExitState.sides.ai, party: emergencyExitState.sides.ai.party.map(pokemon => ({
    ...pokemon, ability: 'Mold Breaker',
  }))},
}};
assert.equal(deriveMoveResolution(emergencyExitMoldBreaker, move(emergencyExitMoldBreaker, 'Tackle'), {
  hit: true, facts: {moveCategory: 'Physical',
    damage: {rolls: [60], min: 60, max: 60, targetHp: 100, possibleKO: false, guaranteedKO: false}},
}).forcedSwitchByPokemon, undefined);
const emergencyExitEndure = {...emergencyExitState, sides: {...emergencyExitState.sides,
  player: {...emergencyExitState.sides.player, party: emergencyExitState.sides.player.party.map(pokemon => ({
    ...pokemon, volatile: pokemon.id === 'player-1' ? {endure: {turns: 1}} : pokemon.volatile,
  }))},
}};
assert.deepEqual(deriveMoveResolution(emergencyExitEndure, move(emergencyExitEndure, 'Tackle'), {
  hit: true, facts: {moveCategory: 'Physical',
    damage: {rolls: [100], min: 100, max: 100, targetHp: 100, possibleKO: true, guaranteedKO: true}},
}).forcedSwitchByPokemon, {'player-1': true});
assert.equal(contactResolutionAgainst({ability: 'Rough Skin', substituteHp: 20}).hpDeltaByPokemon?.['ai-1'], undefined);
assert.equal(contactResolutionAgainst({ability: 'Rough Skin'}, 'Thunderbolt').hpDeltaByPokemon?.['ai-1'], undefined);
assert.equal(contactResolutionAgainst({ability: 'Rough Skin'}, 'Drain Punch', 9, 10, {item: 'Punching Glove'})
  .hpDeltaByPokemon?.['ai-1'], 5);
assert.equal(contactResolutionAgainst({ability: 'Rough Skin'}, 'Tackle', 9, 10, {ability: 'Long Reach'})
  .hpDeltaByPokemon?.['ai-1'], undefined);
assert.equal(contactResolutionAgainst({ability: 'Rough Skin'}, 'Tackle', 2).hpDeltaByPokemon?.['ai-1'], undefined);
assert.equal(contactResolutionAgainst({ability: 'Rough Skin'}, 'Tackle', 3, 10, {ability: 'Magic Guard'})
  .hpDeltaByPokemon?.['ai-1'], -12);
assert.equal(contactResolutionAgainst({ability: 'Rough Skin'}, 'Tackle', 4, 10, {ability: 'Magic Guard'})
  .hpDeltaByPokemon?.['ai-1'], undefined);
assert.equal(contactResolutionAgainst({ability: 'Sturdy'}, 'Tackle', 9, 100, {ability: 'Mold Breaker'})
  .damageByTarget?.['player-1'], 100);
const disguiseBypass = contactResolutionAgainst(
  {ability: 'Disguise', species: 'Mimikyu'}, 'Tackle', 9, 10, {ability: 'Mold Breaker'}, Math.random,
);
assert.equal(disguiseBypass.damageByTarget?.['player-1'], 10);
assert.equal(disguiseBypass.disguiseBrokenByPokemon, undefined);
assert.equal(contactResolutionAgainst({ability: 'Static'}, 'Tackle', 9, 10, {species: 'Rattata'}, () => 0)
  .statusByPokemon?.['ai-1'], 'par');
assert.equal(contactResolutionAgainst({ability: 'Flame Body'}, 'Tackle', 9, 10, {}, () => 0)
  .statusByPokemon?.['ai-1'], 'brn');
assert.equal(contactResolutionAgainst({ability: 'Poison Point'}, 'Tackle', 9, 10, {}, () => 0)
  .statusByPokemon?.['ai-1'], 'psn');
assert.equal(contactResolutionAgainst({ability: 'Effect Spore'}, 'Tackle', 2, 10,
  {species: 'Rattata', gender: 'M'}, () => 0).statusByPokemon?.['ai-1'], undefined);
assert.equal(contactResolutionAgainst({ability: 'Effect Spore'}, 'Tackle', 9, 10,
  {species: 'Rattata', gender: 'M'}, () => 0).statusByPokemon?.['ai-1'], 'psn');
assert.equal(contactResolutionAgainst({ability: 'Effect Spore'}, 'Tackle', 9, 10,
  {species: 'Rattata', gender: 'M'}, () => 0.1).statusByPokemon?.['ai-1'], 'par');
const effectSporeSleep = contactResolutionAgainst({ability: 'Effect Spore'}, 'Tackle', 9, 10,
  {species: 'Rattata', gender: 'M'}, () => 0.2);
assert.equal(effectSporeSleep.statusByPokemon?.['ai-1'], 'slp');
assert.equal(effectSporeSleep.statusTurnsByPokemon?.['ai-1'], 2);
assert.equal(contactResolutionAgainst({ability: 'Effect Spore'}, 'Tackle', 9, 10,
  {species: 'Rattata', gender: 'M'}, () => 0.3).statusByPokemon, undefined);
const effectSporeMoldBreaker = contactResolutionAgainst(
  {ability: 'Effect Spore'}, 'Tackle', 9, 10,
  {ability: 'Mold Breaker', species: 'Rattata', gender: 'M'}, () => 0,
);
assert.equal(effectSporeMoldBreaker.statusByPokemon, undefined);
// Cute Charm infatuates on contact only across opposite, known sexes. The
// same-gender and genderless rows here used to assert `true`, which is the
// same hole Attract had: the rule was written for Captivate and nowhere on
// the path infatuation actually takes.
assert.equal(contactResolutionAgainst({ability: 'Cute Charm', gender: 'F'}, 'Tackle', 9, 10,
  {gender: 'M'}, () => 0).volatileByPokemon?.['ai-1']?.infatuated !== undefined, true);
assert.equal(contactResolutionAgainst({ability: 'Cute Charm', gender: 'F'}, 'Tackle', 9, 10,
  {gender: 'F'}, () => 0).volatileByPokemon?.['ai-1']?.infatuated !== undefined, false);
assert.equal(contactResolutionAgainst({ability: 'Cute Charm', gender: 'F'}, 'Tackle', 9, 10,
  {gender: 'N'}, () => 0).volatileByPokemon?.['ai-1']?.infatuated !== undefined, false);
assert.equal(contactResolutionAgainst({ability: 'Cute Charm', gender: 'F'}, 'Tackle', 9, 10,
  {gender: 'M', ability: 'Mold Breaker'}, () => 0).volatileByPokemon, undefined);
assert.equal(contactResolutionAgainst({ability: 'Gooey'}).boostsByPokemon?.['ai-1']?.spe, -1);
assert.equal(contactResolutionAgainst({ability: 'Tangling Hair'}).boostsByPokemon?.['ai-1']?.spe, -1);
assert.equal(contactResolutionAgainst({ability: 'Static'}, 'Thunderbolt', 9, 10, {}, () => 0)
  .statusByPokemon?.['ai-1'], undefined);
assert.equal(contactResolutionAgainst({ability: 'Static', substituteHp: 50}, 'Tackle', 9, 10, {}, () => 0)
  .statusByPokemon, undefined);
assert.equal(contactResolutionAgainst({ability: 'Static', substituteHp: 50}, 'Tackle', 9, 60, {species: 'Rattata'}, () => 0)
  .statusByPokemon?.['ai-1'], 'par');
assert.equal(contactResolutionAgainst({ability: 'Gooey', substituteHp: 50})
  .boostsByPokemon, undefined);
assert.equal(contactResolutionAgainst({substituteHp: 50}, 'Tackle', 9, 10, {ability: 'Poison Touch'}, () => 0)
  .statusByPokemon, undefined);
assert.equal(contactResolutionAgainst({ability: 'Poison Point'}, 'Tackle', 2, 10, {}, () => 0)
  .statusByPokemon?.['ai-1'], undefined);
assert.equal(contactResolutionAgainst({}, 'Tackle', 9, 10, {ability: 'Poison Touch'}, () => 0)
  .statusByPokemon?.['player-1'], 'psn');
assert.equal(contactResolutionAgainst({}, 'Tackle', 4, 10, {ability: 'Poison Touch'}, () => 0)
  .statusByPokemon?.['player-1'], undefined);
const cursedBodyContact = contactResolutionAgainst({ability: 'Cursed Body'}, 'Thunderbolt', 9, 10, {}, () => 0);
assert.deepEqual(cursedBodyContact.volatileByPokemon?.['ai-1']?.disable, {turns: 4, moveName: 'Thunderbolt'});
const cursedBodyNoProc = contactResolutionAgainst({ability: 'Cursed Body'}, 'Thunderbolt', 9, 10, {}, () => 0.99);
assert.equal(cursedBodyNoProc.volatileByPokemon?.['ai-1']?.disable, undefined);
const cursedBodyAlreadyDisabled = contactResolutionAgainst(
  {ability: 'Cursed Body'}, 'Thunderbolt', 9, 10,
  {volatile: {disable: {turns: 2, moveName: 'Protect'}}}, () => 0,
);
assert.equal(cursedBodyAlreadyDisabled.volatileByPokemon?.['ai-1']?.disable, undefined);
assert.equal(contactResolutionAgainst({ability: 'Weak Armor'}).boostsByPokemon?.['player-1']?.def, -1);
assert.equal(contactResolutionAgainst({ability: 'Weak Armor'}).boostsByPokemon?.['player-1']?.spe, 2);
assert.equal(contactResolutionAgainst({ability: 'Stamina'}).boostsByPokemon?.['player-1']?.def, 1);
assert.equal(contactResolutionAgainst({ability: 'Berserk', hp: {current: 60, max: 100}})
  .boostsByPokemon?.['player-1']?.spa, 1);
assert.equal(contactResolutionAgainst({ability: 'Berserk', hp: {current: 60, max: 100}},
  'Rock Slide', 9, 10, {ability: 'Sheer Force'}).boostsByPokemon, undefined);
assert.equal(contactResolutionAgainst({ability: 'Berserk', hp: {current: 60, max: 100}},
  'Rock Slide', 9, 10, {ability: 'Sheer Force'}, Math.random, 'Physical', undefined, true)
  .boostsByPokemon?.['player-1']?.spa, 1);
assert.equal(contactResolutionAgainst({ability: 'Berserk', hp: {current: 60, max: 100}, substituteHp: 20},
  'Tackle', 9, 25).boostsByPokemon, undefined);
assert.deepEqual(contactResolutionAgainst({ability: 'Anger Shell', hp: {current: 60, max: 100}, substituteHp: 20},
  'Tackle', 9, 35).boostsByPokemon?.['player-1'],
  {atk: 1, spa: 1, spe: 1, def: -1, spd: -1});
assert.equal(contactResolutionAgainst({ability: 'Steam Engine'}, 'Flamethrower', 9, 10, {}, Math.random, 'Special', 'Fire')
  .boostsByPokemon?.['player-1']?.spe, 6);
assert.equal(contactResolutionAgainst({ability: 'Motor Drive'}, 'Thunderbolt', 9, 10, {}, Math.random, 'Special', 'Electric')
  .boostsByPokemon?.['player-1']?.spe, 1);
assert.equal(contactResolutionAgainst({ability: 'Sap Sipper'}, 'Razor Leaf', 9, 10, {}, Math.random, 'Physical', 'Grass')
  .boostsByPokemon?.['player-1']?.atk, 1);
assert.equal(contactResolutionAgainst({ability: 'Justified'}, 'Bite').boostsByPokemon?.['player-1']?.atk, 1);
assert.equal(contactResolutionAgainst({ability: 'Water Compaction'}, 'Water Gun', 9, 10, {}, Math.random, 'Special', 'Water')
  .boostsByPokemon?.['player-1']?.def, 2);
assert.equal(contactResolutionAgainst({ability: 'Rattled'}, 'Bite').boostsByPokemon?.['player-1']?.spe, 1);
assert.deepEqual(contactResolutionAgainst({ability: 'Color Change'}, 'Thunderbolt', 9, 10, {}, Math.random, 'Special', 'Electric')
  .typeOverrideByPokemon?.['player-1'], ['Electric']);
assert.equal(contactResolutionAgainst({ability: 'Color Change'}, 'Thunderbolt', 4, 10, {}, Math.random, 'Special', 'Electric')
  .typeOverrideByPokemon, undefined);
assert.equal(contactResolutionAgainst({ability: 'Color Change'}, 'Thunderbolt', 9, 10,
  {ability: 'Mold Breaker'}, Math.random, 'Special', 'Electric').typeOverrideByPokemon, undefined);
assert.equal(contactResolutionAgainst({ability: 'Color Change', species: 'Pikachu'}, 'Thunderbolt', 9, 10, {}, Math.random, 'Special', 'Electric')
  .typeOverrideByPokemon, undefined);
assert.equal(contactResolutionAgainst({ability: 'Color Change'}, 'Thunderbolt', 9, 100, {}, Math.random, 'Special', 'Electric')
  .typeOverrideByPokemon, undefined);
const toxicDebrisResolution = contactResolutionAgainst({ability: 'Toxic Debris'});
assert.equal(toxicDebrisResolution.sideEffectsBySide?.player?.toxicSpikes, 1);
assert.equal(contactResolutionAgainst({ability: 'Weak Armor'}, 'Tackle', 4).boostsByPokemon?.['player-1'], undefined);
assert.equal(contactResolutionAgainst({}, 'Tackle', 9, 100, {ability: 'Moxie'})
  .boostsByPokemon?.['ai-1']?.atk, 1);
assert.equal(contactResolutionAgainst({}, 'Tackle', 7, 100, {ability: 'Chilling Neigh'})
  .boostsByPokemon?.['ai-1'], undefined);
assert.equal(contactResolutionAgainst({}, 'Tackle', 8, 100, {ability: 'Chilling Neigh'})
  .boostsByPokemon?.['ai-1']?.atk, 1);
assert.equal(contactResolutionAgainst({}, 'Tackle', 8, 100, {ability: 'Grim Neigh'})
  .boostsByPokemon?.['ai-1']?.spa, 1);
assert.equal(contactResolutionAgainst({}, 'Tackle', 9, 100, {ability: 'Beast Boost'})
  .boostsByPokemon?.['ai-1']?.spe, 1);
assert.equal(contactResolutionAgainst({}, 'Tackle', 9, 100, {ability: 'Soul-Heart'})
  .boostsByPokemon?.['ai-1']?.spa, 1);
assert.equal(contactResolutionAgainst(
  {volatile: {endure: {turns: 1}}}, 'Tackle', 9, 100, {ability: 'Moxie'},
).boostsByPokemon?.['ai-1'], undefined);
assert.equal(contactResolutionAgainst({}, 'Tackle', 4, 100, {ability: 'Moxie'})
  .boostsByPokemon?.['ai-1'], undefined);
assert.equal(contactResolutionAgainst({ability: 'Innards Out'}, 'Tackle', 9, 100)
  .hpDeltaByPokemon?.['ai-1'], -100);
assert.equal(contactResolutionAgainst({ability: 'Innards Out'}, 'Tackle', 9, 100, {ability: 'Magic Guard'})
  .hpDeltaByPokemon?.['ai-1'], undefined);
const sturdyResolution = contactResolutionAgainst({ability: 'Sturdy'}, 'Tackle', 9, 100);
assert.equal(sturdyResolution.damageByTarget?.['player-1'], 99);
const sturdyPreGen5 = contactResolutionAgainst({ability: 'Sturdy'}, 'Tackle', 4, 100);
assert.equal(sturdyPreGen5.damageByTarget?.['player-1'], 100);
const sturdySubstitute = contactResolutionAgainst({ability: 'Sturdy', substituteHp: 20}, 'Tackle', 9, 100);
assert.equal(sturdySubstitute.damageByTarget?.['player-1'], 100);
const sturdyMultiFirstHitNonFatal = contactResolutionAgainst(
  {ability: 'Sturdy'}, 'Tackle', 9, 60, {}, () => 0, 'Physical', undefined, true, 2,
);
assert.equal(sturdyMultiFirstHitNonFatal.damageByTarget?.['player-1'], 120);
assert.equal(sturdyMultiFirstHitNonFatal.trace?.notes?.some(note => note.includes('Sturdy kept')), false);
const iceFaceResolution = contactResolutionAgainst({ability: 'Ice Face', species: 'Eiscue'}, 'Tackle', 9, 100);
assert.equal(iceFaceResolution.damageByTarget?.['player-1'], 0);
assert.equal(iceFaceResolution.speciesOverrideByPokemon?.['player-1'], 'Eiscue-Noice');
const iceFaceSpecial = contactResolutionAgainst({ability: 'Ice Face', species: 'Eiscue'}, 'Thunderbolt', 9, 100, {}, Math.random, 'Special');
assert.equal(iceFaceSpecial.damageByTarget?.['player-1'], 100);
assert.equal(iceFaceSpecial.speciesOverrideByPokemon, undefined);
const iceFaceBypass = contactResolutionAgainst(
  {ability: 'Ice Face', species: 'Eiscue'}, 'Tackle', 9, 100, {ability: 'Mold Breaker'}, Math.random,
);
assert.equal(iceFaceBypass.damageByTarget?.['player-1'], 100);
assert.equal(iceFaceBypass.speciesOverrideByPokemon, undefined);
const iceFaceMultiHit = contactResolutionAgainst(
  {ability: 'Ice Face', species: 'Eiscue'}, 'Tackle', 9, 100, {}, Math.random, 'Physical', undefined, true,
);
assert.equal(iceFaceMultiHit.damageByTarget?.['player-1'], 100);
const iceFaceFactsState = state();
iceFaceFactsState.sides.player.party[0].species = 'Eiscue';
iceFaceFactsState.sides.player.party[0].ability = 'Ice Face';
const iceFaceFacts = calculateActionFacts(iceFaceFactsState, move(iceFaceFactsState, 'Explosion'));
assert.equal(iceFaceFacts.damage?.max, 0);
const iceFaceTransitionState = state();
iceFaceTransitionState.sides.player.party[0].species = 'Eiscue';
iceFaceTransitionState.sides.player.party[0].ability = 'Ice Face';
const iceFaceTransitionAction = move(iceFaceTransitionState, 'Tackle');
const iceFaceTransitionResolution = deriveMoveResolution(iceFaceTransitionState, iceFaceTransitionAction, {
  hit: true,
  facts: {moveCategory: 'Physical', damage: {rolls: [100], min: 100, max: 100, targetHp: 100, possibleKO: true, guaranteedKO: true}},
});
const iceFaceTransition = applyAction(iceFaceTransitionState, iceFaceTransitionAction, iceFaceTransitionResolution);
assert.equal(iceFaceTransition.sides.player.party[0].hp.current, 100);
assert.equal(iceFaceTransition.sides.player.party[0].speciesOverride, 'Eiscue-Noice');
const focusSashResolution = contactResolutionAgainst({item: 'Focus Sash'}, 'Tackle', 9, 100);
assert.equal(focusSashResolution.damageByTarget?.['player-1'], 99);
assert.deepEqual(focusSashResolution.itemByPokemon?.['player-1'], null);
assert.equal(focusSashResolution.consumedItemByPokemon?.['player-1'], 'Focus Sash');
const focusSashTransitionState = state();
focusSashTransitionState.sides.player.party[0].item = 'Focus Sash';
const focusSashTransitionAction = move(focusSashTransitionState, 'Tackle');
const focusSashTransitionResolution = deriveMoveResolution(focusSashTransitionState, focusSashTransitionAction, {
  hit: true,
  facts: {moveCategory: 'Physical', damage: {rolls: [100], min: 100, max: 100, targetHp: 100, possibleKO: true, guaranteedKO: true}},
});
const focusSashTransition = applyAction(focusSashTransitionState, focusSashTransitionAction, focusSashTransitionResolution);
assert.equal(focusSashTransition.sides.player.party[0].hp.current, 1);
assert.equal(focusSashTransition.sides.player.party[0].item, undefined);
assert.equal(focusSashTransition.sides.player.party[0].lastConsumedItem, 'Focus Sash');
const focusSashNotFull = contactResolutionAgainst({item: 'Focus Sash', hp: {current: 90, max: 100}}, 'Tackle', 9, 100);
assert.equal(focusSashNotFull.damageByTarget?.['player-1'], 100);
assert.equal(focusSashNotFull.consumedItemByPokemon?.['player-1'], undefined);
const focusSashSubstitute = contactResolutionAgainst({item: 'Focus Sash', substituteHp: 20}, 'Tackle', 9, 100);
assert.equal(focusSashSubstitute.damageByTarget?.['player-1'], 100);
assert.equal(focusSashSubstitute.consumedItemByPokemon?.['player-1'], undefined);
const focusSashMultiHit = contactResolutionAgainst({item: 'Focus Sash'}, 'Tackle', 9, 100, {}, Math.random, 'Physical', undefined, true);
assert.equal(focusSashMultiHit.damageByTarget?.['player-1'], 100);
const focusSashMultiFirstHitNonFatal = contactResolutionAgainst(
  {item: 'Focus Sash'}, 'Tackle', 9, 60, {}, () => 0, 'Physical', undefined, true, 2,
);
assert.equal(focusSashMultiFirstHitNonFatal.damageByTarget?.['player-1'], 120);
assert.equal(focusSashMultiFirstHitNonFatal.consumedItemByPokemon?.['player-1'], undefined);
const focusSashMagicRoomState = state();
focusSashMagicRoomState.field.magicRoom = true;
focusSashMagicRoomState.sides.player.party[0].item = 'Focus Sash';
const focusSashMagicRoom = deriveMoveResolution(focusSashMagicRoomState, move(focusSashMagicRoomState, 'Tackle'), {
  hit: true, facts: {moveCategory: 'Physical', damage: {rolls: [100], min: 100, max: 100, targetHp: 100, possibleKO: true, guaranteedKO: true}},
});
assert.equal(focusSashMagicRoom.damageByTarget?.['player-1'], 100);
const focusSashCorroded = contactResolutionAgainst({item: 'Focus Sash', itemCorroded: true}, 'Tackle', 9, 100);
assert.equal(focusSashCorroded.damageByTarget?.['player-1'], 100);
const focusBandSuccess = contactResolutionAgainst({item: 'Focus Band'}, 'Tackle', 9, 100, {}, () => 0);
assert.equal(focusBandSuccess.damageByTarget?.['player-1'], 99);
assert.equal(focusBandSuccess.itemByPokemon?.['player-1'], undefined);
assert.equal(focusBandSuccess.consumedItemByPokemon?.['player-1'], undefined);
const focusBandFailure = contactResolutionAgainst({item: 'Focus Band'}, 'Tackle', 9, 100, {}, () => 0.1);
assert.equal(focusBandFailure.damageByTarget?.['player-1'], 100);
const focusBandNotFatal = contactResolutionAgainst({item: 'Focus Band'}, 'Tackle', 9, 10, {}, () => 0);
assert.equal(focusBandNotFatal.damageByTarget?.['player-1'], 10);
const focusBandSubstitute = contactResolutionAgainst({item: 'Focus Band', substituteHp: 20}, 'Tackle', 9, 100, {}, () => 0);
assert.equal(focusBandSubstitute.damageByTarget?.['player-1'], 100);
const focusBandLaterFatalHit = contactResolutionAgainst(
  {item: 'Focus Band'}, 'Tackle', 9, 60, {}, () => 0, 'Physical', undefined, true, 2,
);
assert.equal(focusBandLaterFatalHit.damageByTarget?.['player-1'], 99);
const focusBandAfterSubstitute = contactResolutionAgainst(
  {item: 'Focus Band', substituteHp: 20}, 'Tackle', 9, 100, {}, () => 0, 'Physical', undefined, true, 2,
);
assert.equal(focusBandAfterSubstitute.damageByTarget?.['player-1'], 199);
const focusBandPreGen2 = contactResolutionAgainst({item: 'Focus Band'}, 'Tackle', 1, 100, {}, () => 0);
assert.equal(focusBandPreGen2.damageByTarget?.['player-1'], 100);
const focusBandMagicRoomState = state();
focusBandMagicRoomState.field.magicRoom = true;
focusBandMagicRoomState.sides.player.party[0].item = 'Focus Band';
const focusBandMagicRoomResolution = deriveMoveResolution(focusBandMagicRoomState, move(focusBandMagicRoomState, 'Tackle'), {
  hit: true,
  facts: {moveCategory: 'Physical', damage: {rolls: [100], min: 100, max: 100, targetHp: 100, possibleKO: true, guaranteedKO: true}},
  random: () => 0,
});
assert.equal(focusBandMagicRoomResolution.damageByTarget?.['player-1'], 100);
const airBalloonDirect = contactResolutionAgainst({item: 'Air Balloon'}, 'Tackle', 9, 0);
assert.equal(airBalloonDirect.itemByPokemon?.['player-1'], null);
assert.equal(airBalloonDirect.consumedItemByPokemon?.['player-1'], 'Air Balloon');
const airBalloonSubstitute = contactResolutionAgainst({item: 'Air Balloon', substituteHp: 20}, 'Tackle', 9, 10);
assert.equal(airBalloonSubstitute.itemByPokemon, undefined);
const airBalloonLaterDirect = contactResolutionAgainst(
  {item: 'Air Balloon', substituteHp: 10}, 'Tackle', 9, 10, {}, () => 0, 'Physical', undefined, true, 2,
);
assert.equal(airBalloonLaterDirect.itemByPokemon?.['player-1'], null);
const airBalloonGeneration = contactResolutionAgainst({item: 'Air Balloon'}, 'Tackle', 4, 0);
assert.equal(airBalloonGeneration.itemByPokemon, undefined);
const airBalloonMagicRoom = {...state(), field: {magicRoom: true}};
airBalloonMagicRoom.sides.player.party[0].item = 'Air Balloon';
const airBalloonMagicRoomResolution = deriveMoveResolution(airBalloonMagicRoom, move(airBalloonMagicRoom, 'Tackle'), {
  hit: true, facts: {moveCategory: 'Physical', damage: {rolls: [0], min: 0, max: 0, targetHp: 100, possibleKO: false, guaranteedKO: false}},
});
assert.equal(airBalloonMagicRoomResolution.itemByPokemon, undefined);
const weaknessPolicyState = state();
weaknessPolicyState.sides.player.party[0].item = 'Weakness Policy';
const weaknessPolicyAction = move(weaknessPolicyState, 'Tackle');
const weaknessPolicyResolution = deriveMoveResolution(weaknessPolicyState, weaknessPolicyAction, {
  hit: true,
  facts: {moveCategory: 'Physical', isSuperEffective: true,
    damage: {rolls: [10], min: 10, max: 10, targetHp: 100, possibleKO: false, guaranteedKO: false}},
});
assert.deepEqual(weaknessPolicyResolution.boostsByPokemon?.['player-1'], {atk: 2, spa: 2});
assert.equal(weaknessPolicyResolution.itemByPokemon?.['player-1'], null);
assert.equal(weaknessPolicyResolution.consumedItemByPokemon?.['player-1'], 'Weakness Policy');
weaknessPolicyState.sides.player.party[0].item = 'Weakness Policy';
weaknessPolicyState.sides.player.party[0].ability = 'Simple';
const weaknessPolicySimple = deriveMoveResolution(weaknessPolicyState, weaknessPolicyAction, {
  hit: true,
  facts: {moveCategory: 'Physical', isSuperEffective: true,
    damage: {rolls: [10], min: 10, max: 10, targetHp: 100, possibleKO: false, guaranteedKO: false}},
});
assert.deepEqual(weaknessPolicySimple.boostsByPokemon?.['player-1'], {atk: 4, spa: 4});
const weaknessPolicySubstitute = contactResolutionAgainst({item: 'Weakness Policy', substituteHp: 20}, 'Tackle', 9, 10);
assert.equal(weaknessPolicySubstitute.boostsByPokemon, undefined);
const weaknessPolicyKO = contactResolutionAgainst({item: 'Weakness Policy'}, 'Tackle', 9, 100);
assert.equal(weaknessPolicyKO.boostsByPokemon, undefined);
assert.equal(weaknessPolicyKO.consumedItemByPokemon, undefined);
const weaknessPolicySuppressed = state();
weaknessPolicySuppressed.field.magicRoom = true;
weaknessPolicySuppressed.sides.player.party[0].item = 'Weakness Policy';
const weaknessPolicySuppressedResolution = deriveMoveResolution(
  weaknessPolicySuppressed,
  move(weaknessPolicySuppressed, 'Tackle'),
  {hit: true, facts: {moveCategory: 'Physical', isSuperEffective: true,
    damage: {rolls: [10], min: 10, max: 10, targetHp: 100, possibleKO: false, guaranteedKO: false}}},
);
assert.equal(weaknessPolicySuppressedResolution.boostsByPokemon, undefined);
const reactiveItemCases: Array<[string, string, string]> = [
  ['Absorb Bulb', 'Water', 'spa'],
  ['Cell Battery', 'Electric', 'atk'],
  ['Snowball', 'Ice', 'atk'],
  ['Luminous Moss', 'Water', 'spd'],
];
for (const [item, type, stat] of reactiveItemCases) {
  const reactiveState = state();
  reactiveState.sides.player.party[0].item = item;
  const reactiveResolution = deriveMoveResolution(reactiveState, move(reactiveState, 'Tackle'), {
    hit: true,
    facts: {moveCategory: 'Physical', moveType: type, isSuperEffective: true,
      damage: {rolls: [10], min: 10, max: 10, targetHp: 100, possibleKO: false, guaranteedKO: false}},
  });
  assert.deepEqual(reactiveResolution.boostsByPokemon?.['player-1'], {[stat]: 1});
  assert.equal(reactiveResolution.itemByPokemon?.['player-1'], null);
  assert.equal(reactiveResolution.consumedItemByPokemon?.['player-1'], item);
}
for (const [item, type] of reactiveItemCases) {
  const reactiveKOState = state();
  reactiveKOState.sides.player.party[0].item = item;
  const reactiveKOResolution = deriveMoveResolution(reactiveKOState, move(reactiveKOState, 'Tackle'), {
    hit: true,
    facts: {moveCategory: 'Physical', moveType: type, isSuperEffective: true,
      damage: {rolls: [100], min: 100, max: 100, targetHp: 100, possibleKO: true, guaranteedKO: true}},
  });
  assert.equal(reactiveKOResolution.boostsByPokemon, undefined);
  assert.equal(reactiveKOResolution.consumedItemByPokemon, undefined);
}
const resistBerryCases: Array<[string, string]> = [
  ['Occa Berry', 'Fire'], ['Passho Berry', 'Water'], ['Wacan Berry', 'Electric'],
  ['Rindo Berry', 'Grass'], ['Yache Berry', 'Ice'], ['Chople Berry', 'Fighting'],
  ['Kebia Berry', 'Poison'], ['Shuca Berry', 'Ground'], ['Coba Berry', 'Flying'],
  ['Payapa Berry', 'Psychic'], ['Tanga Berry', 'Bug'], ['Charti Berry', 'Rock'],
  ['Kasib Berry', 'Ghost'], ['Haban Berry', 'Dragon'], ['Colbur Berry', 'Dark'],
  ['Babiri Berry', 'Steel'], ['Roseli Berry', 'Fairy'], ['Chilan Berry', 'Normal'],
];
for (const [item, type] of resistBerryCases) {
  const resistState = state();
  resistState.sides.player.party[0].item = item;
  const resistResolution = deriveMoveResolution(resistState, move(resistState, 'Tackle'), {
    hit: true,
    facts: {moveCategory: 'Physical', moveType: type, isSuperEffective: true,
      damage: {rolls: [20], min: 20, max: 20, targetHp: 100, possibleKO: false, guaranteedKO: false}},
  });
  assert.equal(resistResolution.damageByTarget?.['player-1'], 10);
  assert.equal(resistResolution.itemByPokemon?.['player-1'], null);
  assert.equal(resistResolution.consumedItemByPokemon?.['player-1'], item);
}
const resistBerryTransitionState = state();
resistBerryTransitionState.sides.player.party[0].item = 'Occa Berry';
const resistBerryTransitionAction = move(resistBerryTransitionState, 'Tackle');
const resistBerryTransitionResolution = deriveMoveResolution(resistBerryTransitionState, resistBerryTransitionAction, {
  hit: true,
  facts: {moveCategory: 'Physical', moveType: 'Fire', isSuperEffective: true,
    damage: {rolls: [20], min: 20, max: 20, targetHp: 100, possibleKO: false, guaranteedKO: false}},
});
const resistBerryTransitionNext = applyAction(
  resistBerryTransitionState, resistBerryTransitionAction, resistBerryTransitionResolution,
);
assert.equal(resistBerryTransitionNext.sides.player.party[0].item, undefined);
assert.equal(resistBerryTransitionNext.sides.player.party[0].lastConsumedItem, 'Occa Berry');
assert.equal(resistBerryTransitionNext.sides.player.party[0].hp.current, 90);
const resistBerryWrongType = state();
resistBerryWrongType.sides.player.party[0].item = 'Occa Berry';
const resistBerryWrongTypeResolution = deriveMoveResolution(
  resistBerryWrongType, move(resistBerryWrongType, 'Tackle'), {
    hit: true,
    facts: {moveCategory: 'Physical', moveType: 'Water', isSuperEffective: true,
      damage: {rolls: [20], min: 20, max: 20, targetHp: 100, possibleKO: false, guaranteedKO: false}},
  },
);
assert.equal(resistBerryWrongTypeResolution.damageByTarget?.['player-1'], 20);
assert.equal(resistBerryWrongTypeResolution.itemByPokemon, undefined);
const resistBerryNotSuperEffective = {...resistBerryWrongType, sides: {...resistBerryWrongType.sides,
  player: {...resistBerryWrongType.sides.player, party: resistBerryWrongType.sides.player.party.map(pokemon => ({
    ...pokemon, item: 'Occa Berry',
  }))},
}};
assert.equal(deriveMoveResolution(resistBerryNotSuperEffective, move(resistBerryNotSuperEffective, 'Tackle'), {
  hit: true, facts: {moveCategory: 'Physical', moveType: 'Fire', isSuperEffective: false,
    damage: {rolls: [20], min: 20, max: 20, targetHp: 100, possibleKO: false, guaranteedKO: false}},
}).damageByTarget?.['player-1'], 20);
const resistBerrySubstitute = state();
resistBerrySubstitute.sides.player.party[0].item = 'Occa Berry';
resistBerrySubstitute.sides.player.party[0].substituteHp = 20;
const resistBerrySubstituteResolution = deriveMoveResolution(resistBerrySubstitute,
  move(resistBerrySubstitute, 'Tackle'), {
    hit: true,
    facts: {moveCategory: 'Physical', moveType: 'Fire', isSuperEffective: true,
      damage: {rolls: [20], min: 20, max: 20, targetHp: 100, possibleKO: false, guaranteedKO: false}},
  });
assert.equal(resistBerrySubstituteResolution.damageByTarget?.['player-1'], 20);
const resistBerryMultiHit = {...resistBerryWrongType, sides: {...resistBerryWrongType.sides,
  player: {...resistBerryWrongType.sides.player, party: resistBerryWrongType.sides.player.party.map(pokemon => ({
    ...pokemon, item: 'Occa Berry',
  }))},
}};
assert.equal(deriveMoveResolution(resistBerryMultiHit, move(resistBerryMultiHit, 'Tackle'), {
  hit: true, facts: {moveCategory: 'Physical', moveType: 'Fire', isSuperEffective: true, isMultiHit: true,
    damage: {rolls: [20], min: 20, max: 20, targetHp: 100, possibleKO: false, guaranteedKO: false}},
}).damageByTarget?.['player-1'], 20);
const resistBerrySuppressed = {...resistBerryWrongType, field: {magicRoom: true}, sides: {...resistBerryWrongType.sides,
  player: {...resistBerryWrongType.sides.player, party: resistBerryWrongType.sides.player.party.map(pokemon => ({
    ...pokemon, item: 'Occa Berry',
  }))},
}};
assert.equal(deriveMoveResolution(resistBerrySuppressed, move(resistBerrySuppressed, 'Tackle'), {
  hit: true, facts: {moveCategory: 'Physical', moveType: 'Fire', isSuperEffective: true,
    damage: {rolls: [20], min: 20, max: 20, targetHp: 100, possibleKO: false, guaranteedKO: false}},
}).damageByTarget?.['player-1'], 20);
const resistBerryEmbargo = {...resistBerryWrongType, sides: {...resistBerryWrongType.sides,
  player: {...resistBerryWrongType.sides.player, party: resistBerryWrongType.sides.player.party.map(pokemon => ({
    ...pokemon, item: 'Occa Berry', volatile: {embargo: {turns: 2}},
  }))},
}};
assert.equal(deriveMoveResolution(resistBerryEmbargo, move(resistBerryEmbargo, 'Tackle'), {
  hit: true, facts: {moveCategory: 'Physical', moveType: 'Fire', isSuperEffective: true,
    damage: {rolls: [20], min: 20, max: 20, targetHp: 100, possibleKO: false, guaranteedKO: false}},
}).damageByTarget?.['player-1'], 20);
const resistBerryKlutz = {...resistBerryWrongType, sides: {...resistBerryWrongType.sides,
  player: {...resistBerryWrongType.sides.player, party: resistBerryWrongType.sides.player.party.map(pokemon => ({
    ...pokemon, item: 'Occa Berry', ability: 'Klutz',
  }))},
}};
assert.equal(deriveMoveResolution(resistBerryKlutz, move(resistBerryKlutz, 'Tackle'), {
  hit: true, facts: {moveCategory: 'Physical', moveType: 'Fire', isSuperEffective: true,
    damage: {rolls: [20], min: 20, max: 20, targetHp: 100, possibleKO: false, guaranteedKO: false}},
}).damageByTarget?.['player-1'], 20);
const resistBerryUnnerve = {...resistBerryWrongType, sides: {...resistBerryWrongType.sides,
  ai: {...resistBerryWrongType.sides.ai, party: resistBerryWrongType.sides.ai.party.map(pokemon => ({
    ...pokemon, ability: 'Unnerve',
  }))},
  player: {...resistBerryWrongType.sides.player, party: resistBerryWrongType.sides.player.party.map(pokemon => ({
    ...pokemon, item: 'Occa Berry',
  }))},
}};
assert.equal(deriveMoveResolution(resistBerryUnnerve, move(resistBerryUnnerve, 'Tackle'), {
  hit: true, facts: {moveCategory: 'Physical', moveType: 'Fire', isSuperEffective: true,
    damage: {rolls: [20], min: 20, max: 20, targetHp: 100, possibleKO: false, guaranteedKO: false}},
}).damageByTarget?.['player-1'], 20);
const faintedUnnerve = doublesState();
faintedUnnerve.sides.ai.party[0].moves = [{name: 'Tackle'}];
faintedUnnerve.sides.player.party[1].ability = 'Unnerve';
faintedUnnerve.sides.player.party[1].hp.current = 0;
faintedUnnerve.sides.player.party[0].item = 'Occa Berry';
const faintedUnnerveAction: MoveAction = {
  kind: 'move', actorId: 'ai-1', moveName: 'Tackle', targetIds: ['player-1'],
};
const faintedUnnerveResolution = deriveMoveResolution(faintedUnnerve, faintedUnnerveAction, {
  hit: true, facts: {moveCategory: 'Physical', moveType: 'Fire', isSuperEffective: true,
    damage: {rolls: [20], min: 20, max: 20, targetHp: 100, possibleKO: false, guaranteedKO: false}},
});
assert.equal(faintedUnnerveResolution.itemByPokemon?.['player-1'], null);
const resistBerryGen3 = {...resistBerryWrongType, generation: 3 as const, sides: {...resistBerryWrongType.sides,
  player: {...resistBerryWrongType.sides.player, party: resistBerryWrongType.sides.player.party.map(pokemon => ({
    ...pokemon, item: 'Occa Berry',
  }))},
}};
assert.equal(deriveMoveResolution(resistBerryGen3, move(resistBerryGen3, 'Tackle'), {
  hit: true, facts: {moveCategory: 'Physical', moveType: 'Fire', isSuperEffective: true,
    damage: {rolls: [20], min: 20, max: 20, targetHp: 100, possibleKO: false, guaranteedKO: false}},
}).damageByTarget?.['player-1'], 20);
const reactiveStatBerryCases: Array<[string, MoveCategory, keyof NonNullable<PokemonState['boosts']>]> = [
  ['Kee Berry', 'Physical', 'def'], ['Maranga Berry', 'Special', 'spd'],
];
for (const [item, category, stat] of reactiveStatBerryCases) {
  const berryState = state();
  berryState.sides.player.party[0].item = item;
  const berryResolution = deriveMoveResolution(berryState, move(berryState, 'Tackle'), {
    hit: true,
    facts: {moveCategory: category,
      damage: {rolls: [20], min: 20, max: 20, targetHp: 100, possibleKO: false, guaranteedKO: false}},
  });
  assert.deepEqual(berryResolution.boostsByPokemon?.['player-1'], {[stat]: 1});
  assert.equal(berryResolution.itemByPokemon?.['player-1'], null);
  assert.equal(berryResolution.consumedItemByPokemon?.['player-1'], item);
}
const reactiveStatBerryMultiHit = state();
reactiveStatBerryMultiHit.sides.player.party[0].item = 'Kee Berry';
const reactiveStatBerryMultiHitResolution = deriveMoveResolution(
  reactiveStatBerryMultiHit, move(reactiveStatBerryMultiHit, 'Tackle'), {
    hit: true, facts: {moveCategory: 'Physical', isMultiHit: true,
      damage: {rolls: [20], min: 20, max: 20, targetHp: 100, possibleKO: false, guaranteedKO: false}},
  },
);
assert.deepEqual(reactiveStatBerryMultiHitResolution.boostsByPokemon?.['player-1'], {def: 1});
const reactiveStatBerryWrongCategory = state();
reactiveStatBerryWrongCategory.sides.player.party[0].item = 'Kee Berry';
assert.equal(deriveMoveResolution(reactiveStatBerryWrongCategory, move(reactiveStatBerryWrongCategory, 'Tackle'), {
  hit: true, facts: {moveCategory: 'Special',
    damage: {rolls: [20], min: 20, max: 20, targetHp: 100, possibleKO: false, guaranteedKO: false}},
}).itemByPokemon, undefined);
const reactiveStatBerrySubstitute = state();
reactiveStatBerrySubstitute.sides.player.party[0].item = 'Kee Berry';
reactiveStatBerrySubstitute.sides.player.party[0].substituteHp = 20;
assert.equal(deriveMoveResolution(reactiveStatBerrySubstitute, move(reactiveStatBerrySubstitute, 'Tackle'), {
  hit: true, facts: {moveCategory: 'Physical',
    damage: {rolls: [20], min: 20, max: 20, targetHp: 100, possibleKO: false, guaranteedKO: false}},
}).itemByPokemon, undefined);
const reactiveStatBerryUnnerve = {...reactiveStatBerryWrongCategory, sides: {
  ...reactiveStatBerryWrongCategory.sides,
  ai: {...reactiveStatBerryWrongCategory.sides.ai, party: reactiveStatBerryWrongCategory.sides.ai.party.map(pokemon => ({
    ...pokemon, ability: 'Unnerve',
  }))},
  player: {...reactiveStatBerryWrongCategory.sides.player, party: reactiveStatBerryWrongCategory.sides.player.party.map(pokemon => ({
    ...pokemon, item: 'Kee Berry',
  }))},
}};
assert.equal(deriveMoveResolution(reactiveStatBerryUnnerve, move(reactiveStatBerryUnnerve, 'Tackle'), {
  hit: true, facts: {moveCategory: 'Physical',
    damage: {rolls: [20], min: 20, max: 20, targetHp: 100, possibleKO: false, guaranteedKO: false}},
}).boostsByPokemon, undefined);
const reactiveStatBerryGen5 = {...reactiveStatBerryWrongCategory, generation: 5 as const, sides: {
  ...reactiveStatBerryWrongCategory.sides,
  player: {...reactiveStatBerryWrongCategory.sides.player, party: reactiveStatBerryWrongCategory.sides.player.party.map(pokemon => ({
    ...pokemon, item: 'Kee Berry',
  }))},
}};
assert.equal(deriveMoveResolution(reactiveStatBerryGen5, move(reactiveStatBerryGen5, 'Tackle'), {
  hit: true, facts: {moveCategory: 'Physical',
    damage: {rolls: [20], min: 20, max: 20, targetHp: 100, possibleKO: false, guaranteedKO: false}},
}).boostsByPokemon, undefined);
const reactiveStatBerryFaint = state();
reactiveStatBerryFaint.sides.player.party[0].item = 'Kee Berry';
assert.equal(deriveMoveResolution(reactiveStatBerryFaint, move(reactiveStatBerryFaint, 'Tackle'), {
  hit: true, facts: {moveCategory: 'Physical',
    damage: {rolls: [100], min: 100, max: 100, targetHp: 100, possibleKO: true, guaranteedKO: true}},
}).boostsByPokemon, undefined);
const reactiveStatBerryMagicRoom = state();
reactiveStatBerryMagicRoom.field.magicRoom = true;
reactiveStatBerryMagicRoom.sides.player.party[0].item = 'Kee Berry';
assert.equal(deriveMoveResolution(reactiveStatBerryMagicRoom, move(reactiveStatBerryMagicRoom, 'Tackle'), {
  hit: true, facts: {moveCategory: 'Physical',
    damage: {rolls: [20], min: 20, max: 20, targetHp: 100, possibleKO: false, guaranteedKO: false}},
}).boostsByPokemon, undefined);
const reactiveStatBerryEmbargo = state();
reactiveStatBerryEmbargo.sides.player.party[0].item = 'Kee Berry';
reactiveStatBerryEmbargo.sides.player.party[0].volatile = {embargo: {turns: 2}};
assert.equal(deriveMoveResolution(reactiveStatBerryEmbargo, move(reactiveStatBerryEmbargo, 'Tackle'), {
  hit: true, facts: {moveCategory: 'Physical',
    damage: {rolls: [20], min: 20, max: 20, targetHp: 100, possibleKO: false, guaranteedKO: false}},
}).boostsByPokemon, undefined);
const reactiveStatBerryKlutz = state();
reactiveStatBerryKlutz.sides.player.party[0].item = 'Kee Berry';
reactiveStatBerryKlutz.sides.player.party[0].ability = 'Klutz';
assert.equal(deriveMoveResolution(reactiveStatBerryKlutz, move(reactiveStatBerryKlutz, 'Tackle'), {
  hit: true, facts: {moveCategory: 'Physical',
    damage: {rolls: [20], min: 20, max: 20, targetHp: 100, possibleKO: false, guaranteedKO: false}},
}).boostsByPokemon, undefined);

const reactiveDamageBerryCases: Array<[string, MoveCategory, number]> = [
  ['Jaboca Berry', 'Physical', -12], ['Rowap Berry', 'Special', -12],
];
for (const [item, category, expectedDamage] of reactiveDamageBerryCases) {
  const berryState = state();
  berryState.sides.player.party[0].item = item;
  const berryResolution = deriveMoveResolution(berryState, move(berryState, 'Tackle'), {
    hit: true,
    facts: {moveCategory: category,
      damage: {rolls: [20], min: 20, max: 20, targetHp: 100, possibleKO: false, guaranteedKO: false}},
  });
  assert.equal(berryResolution.hpDeltaByPokemon?.['ai-1'], expectedDamage);
  assert.equal(berryResolution.itemByPokemon?.['player-1'], null);
  assert.equal(berryResolution.consumedItemByPokemon?.['player-1'], item);
}
const reactiveDamageBerryRipen = state();
reactiveDamageBerryRipen.sides.player.party[0].item = 'Jaboca Berry';
reactiveDamageBerryRipen.sides.player.party[0].ability = 'Ripen';
const reactiveDamageBerryRipenResolution = deriveMoveResolution(
  reactiveDamageBerryRipen, move(reactiveDamageBerryRipen, 'Tackle'), {
    hit: true, facts: {moveCategory: 'Physical',
      damage: {rolls: [20], min: 20, max: 20, targetHp: 100, possibleKO: false, guaranteedKO: false}},
  },
);
assert.equal(reactiveDamageBerryRipenResolution.hpDeltaByPokemon?.['ai-1'], -25);
const reactiveDamageBerryMultiHit = state();
reactiveDamageBerryMultiHit.sides.player.party[0].item = 'Jaboca Berry';
const reactiveDamageBerryMultiHitResolution = deriveMoveResolution(
  reactiveDamageBerryMultiHit, move(reactiveDamageBerryMultiHit, 'Tackle'), {
    hit: true, facts: {moveCategory: 'Physical', isMultiHit: true,
      damage: {rolls: [10, 10], min: 20, max: 20, targetHp: 100, possibleKO: false, guaranteedKO: false}},
  },
);
assert.equal(reactiveDamageBerryMultiHitResolution.hpDeltaByPokemon?.['ai-1'], -12);
const reactiveDamageBerryWrongCategory = state();
reactiveDamageBerryWrongCategory.sides.player.party[0].item = 'Jaboca Berry';
const reactiveDamageBerryWrongCategoryResolution = deriveMoveResolution(
  reactiveDamageBerryWrongCategory, move(reactiveDamageBerryWrongCategory, 'Tackle'), {
    hit: true, facts: {moveCategory: 'Special',
      damage: {rolls: [20], min: 20, max: 20, targetHp: 100, possibleKO: false, guaranteedKO: false}},
  },
);
assert.equal(reactiveDamageBerryWrongCategoryResolution.hpDeltaByPokemon, undefined);
assert.equal(reactiveDamageBerryWrongCategoryResolution.itemByPokemon, undefined);
const reactiveDamageBerrySubstitute = state();
reactiveDamageBerrySubstitute.sides.player.party[0].item = 'Jaboca Berry';
reactiveDamageBerrySubstitute.sides.player.party[0].substituteHp = 20;
assert.equal(deriveMoveResolution(reactiveDamageBerrySubstitute, move(reactiveDamageBerrySubstitute, 'Tackle'), {
  hit: true, facts: {moveCategory: 'Physical',
    damage: {rolls: [20], min: 20, max: 20, targetHp: 100, possibleKO: false, guaranteedKO: false}},
}).hpDeltaByPokemon, undefined);
const reactiveDamageBerryMagicGuard = state();
reactiveDamageBerryMagicGuard.sides.player.party[0].item = 'Jaboca Berry';
reactiveDamageBerryMagicGuard.sides.ai.party[0].ability = 'Magic Guard';
assert.equal(deriveMoveResolution(reactiveDamageBerryMagicGuard, move(reactiveDamageBerryMagicGuard, 'Tackle'), {
  hit: true, facts: {moveCategory: 'Physical',
    damage: {rolls: [20], min: 20, max: 20, targetHp: 100, possibleKO: false, guaranteedKO: false}},
}).itemByPokemon, undefined);
const reactiveDamageBerryUnnerve = state();
reactiveDamageBerryUnnerve.sides.player.party[0].item = 'Jaboca Berry';
reactiveDamageBerryUnnerve.sides.ai.party[0].ability = 'Unnerve';
assert.equal(deriveMoveResolution(reactiveDamageBerryUnnerve, move(reactiveDamageBerryUnnerve, 'Tackle'), {
  hit: true, facts: {moveCategory: 'Physical',
    damage: {rolls: [20], min: 20, max: 20, targetHp: 100, possibleKO: false, guaranteedKO: false}},
}).itemByPokemon, undefined);
const reactiveDamageBerryOldGeneration = state();
reactiveDamageBerryOldGeneration.generation = 3;
reactiveDamageBerryOldGeneration.sides.player.party[0].item = 'Jaboca Berry';
assert.equal(deriveMoveResolution(reactiveDamageBerryOldGeneration,
  move(reactiveDamageBerryOldGeneration, 'Tackle'), {
    hit: true, facts: {moveCategory: 'Physical',
      damage: {rolls: [20], min: 20, max: 20, targetHp: 100, possibleKO: false, guaranteedKO: false}},
  }).hpDeltaByPokemon, undefined);
const reactiveDamageBerryLethal = state();
reactiveDamageBerryLethal.sides.player.party[0].item = 'Jaboca Berry';
const reactiveDamageBerryLethalResolution = deriveMoveResolution(
  reactiveDamageBerryLethal, move(reactiveDamageBerryLethal, 'Tackle'), {
    hit: true, facts: {moveCategory: 'Physical',
      damage: {rolls: [100], min: 100, max: 100, targetHp: 100, possibleKO: true, guaranteedKO: true}},
  },
);
assert.equal(reactiveDamageBerryLethalResolution.hpDeltaByPokemon?.['ai-1'], -12);
assert.equal(reactiveDamageBerryLethalResolution.itemByPokemon?.['player-1'], null);
const enigmaState = state();
enigmaState.sides.player.party[0].item = 'Enigma Berry';
enigmaState.sides.player.party[0].hp.current = 50;
const enigmaResolution = deriveMoveResolution(enigmaState, move(enigmaState, 'Tackle'), {
  hit: true,
  facts: {moveCategory: 'Physical', moveType: 'Fire', isSuperEffective: true,
    damage: {rolls: [20], min: 20, max: 20, targetHp: 100, possibleKO: false, guaranteedKO: false}},
});
assert.equal(enigmaResolution.hpDeltaByPokemon?.['player-1'], 25);
assert.equal(enigmaResolution.itemByPokemon?.['player-1'], null);
assert.equal(enigmaResolution.consumedItemByPokemon?.['player-1'], 'Enigma Berry');
const enigmaRipen = state();
enigmaRipen.sides.player.party[0].item = 'Enigma Berry';
enigmaRipen.sides.player.party[0].ability = 'Ripen';
enigmaRipen.sides.player.party[0].hp.current = 50;
assert.equal(deriveMoveResolution(enigmaRipen, move(enigmaRipen, 'Tackle'), {
  hit: true, facts: {moveCategory: 'Physical', isSuperEffective: true,
    damage: {rolls: [20], min: 20, max: 20, targetHp: 100, possibleKO: false, guaranteedKO: false}},
}).hpDeltaByPokemon?.['player-1'], 50);
const enigmaHealBlocked = {...enigmaState, sides: {...enigmaState.sides,
  player: {...enigmaState.sides.player, party: enigmaState.sides.player.party.map(pokemon => ({
    ...pokemon, volatile: {healBlock: {turns: 2}},
  }))},
}};
const enigmaHealBlockedResolution = deriveMoveResolution(enigmaHealBlocked, move(enigmaHealBlocked, 'Tackle'), {
  hit: true, facts: {moveCategory: 'Physical', isSuperEffective: true,
    damage: {rolls: [20], min: 20, max: 20, targetHp: 100, possibleKO: false, guaranteedKO: false}},
});
assert.equal(enigmaHealBlockedResolution.hpDeltaByPokemon, undefined);
assert.equal(enigmaHealBlockedResolution.itemByPokemon, undefined);
const enigmaFull = state();
enigmaFull.sides.player.party[0].item = 'Enigma Berry';
assert.equal(deriveMoveResolution(enigmaFull, move(enigmaFull, 'Tackle'), {
  hit: true, facts: {moveCategory: 'Physical', isSuperEffective: true,
    damage: {rolls: [20], min: 20, max: 20, targetHp: 100, possibleKO: false, guaranteedKO: false}},
}).itemByPokemon, undefined);
const enigmaLethal = state();
enigmaLethal.sides.player.party[0].item = 'Enigma Berry';
const enigmaLethalResolution = deriveMoveResolution(enigmaLethal, move(enigmaLethal, 'Tackle'), {
  hit: true, facts: {moveCategory: 'Physical', isSuperEffective: true,
    damage: {rolls: [100], min: 100, max: 100, targetHp: 100, possibleKO: true, guaranteedKO: true}},
});
assert.equal(enigmaLethalResolution.hpDeltaByPokemon, undefined);
assert.equal(enigmaLethalResolution.consumedItemByPokemon, undefined);
const enigmaUnnerve = state();
enigmaUnnerve.sides.ai.party[0].ability = 'Unnerve';
enigmaUnnerve.sides.player.party[0].item = 'Enigma Berry';
enigmaUnnerve.sides.player.party[0].hp.current = 50;
assert.equal(deriveMoveResolution(enigmaUnnerve, move(enigmaUnnerve, 'Tackle'), {
  hit: true, facts: {moveCategory: 'Physical', isSuperEffective: true,
    damage: {rolls: [20], min: 20, max: 20, targetHp: 100, possibleKO: false, guaranteedKO: false}},
}).itemByPokemon, undefined);
const enigmaCheekPouch = state();
enigmaCheekPouch.sides.player.party[0].item = 'Enigma Berry';
enigmaCheekPouch.sides.player.party[0].ability = 'Cheek Pouch';
enigmaCheekPouch.sides.player.party[0].hp.current = 50;
assert.equal(deriveMoveResolution(enigmaCheekPouch, move(enigmaCheekPouch, 'Tackle'), {
  hit: true, facts: {moveCategory: 'Physical', isSuperEffective: true,
    damage: {rolls: [20], min: 20, max: 20, targetHp: 100, possibleKO: false, guaranteedKO: false}},
}).hpDeltaByPokemon?.['player-1'], 58);
const lansatBerryState = state();
lansatBerryState.sides.player.party[0].item = 'Lansat Berry';
lansatBerryState.sides.player.party[0].hp.current = 25;
const lansatBerryNext = advanceTurn(lansatBerryState);
assert.equal(lansatBerryNext.sides.player.party[0].item, undefined);
assert.equal(lansatBerryNext.sides.player.party[0].lastConsumedItem, 'Lansat Berry');
assert.deepEqual(lansatBerryNext.sides.player.party[0].volatile?.focusEnergy, {});
const gluttonyLansat = {...lansatBerryState, sides: {...lansatBerryState.sides,
  player: {...lansatBerryState.sides.player, party: lansatBerryState.sides.player.party.map(pokemon => ({
    ...pokemon, hp: {...pokemon.hp, current: 50}, ability: 'Gluttony',
  }))},
}};
assert.equal(advanceTurn(gluttonyLansat).sides.player.party[0].item, undefined);
const starfBerryState = state();
starfBerryState.sides.player.party[0].item = 'Starf Berry';
starfBerryState.sides.player.party[0].hp.current = 25;
const starfBerryNext = advanceTurn(starfBerryState, {random: () => 0});
assert.equal(starfBerryNext.sides.player.party[0].item, undefined);
assert.equal(starfBerryNext.sides.player.party[0].boosts?.atk, 2);
const ripenStarfBerry = {...starfBerryState, sides: {...starfBerryState.sides,
  player: {...starfBerryState.sides.player, party: starfBerryState.sides.player.party.map(pokemon => ({
    ...pokemon, ability: 'Ripen', boosts: {atk: 5},
  }))},
}};
assert.equal(advanceTurn(ripenStarfBerry, {random: () => 0}).sides.player.party[0].boosts?.atk, 6);
assert.throws(
  () => advanceTurn(starfBerryState, {random: () => Number.NaN}),
  /Starf Berry stat sampler/,
);
const absorbBulbWrongType = state();
absorbBulbWrongType.sides.player.party[0].item = 'Absorb Bulb';
assert.equal(deriveMoveResolution(absorbBulbWrongType, move(absorbBulbWrongType, 'Tackle'), {
  hit: true, facts: {moveCategory: 'Physical', moveType: 'Fire', isSuperEffective: true,
    damage: {rolls: [10], min: 10, max: 10, targetHp: 100, possibleKO: false, guaranteedKO: false}},
}).boostsByPokemon, undefined);
const absorbBulbOldGeneration = {...absorbBulbWrongType, generation: 4 as BattleState['generation']};
assert.equal(deriveMoveResolution(absorbBulbOldGeneration, move(absorbBulbOldGeneration, 'Tackle'), {
  hit: true, facts: {moveCategory: 'Physical', moveType: 'Water', isSuperEffective: true,
    damage: {rolls: [10], min: 10, max: 10, targetHp: 100, possibleKO: false, guaranteedKO: false}},
}).boostsByPokemon, undefined);
const absorbBulbSubstitute = contactResolutionAgainst({item: 'Absorb Bulb', substituteHp: 20}, 'Tackle', 9, 10, {}, Math.random, 'Physical', 'Water');
assert.equal(absorbBulbSubstitute.boostsByPokemon, undefined);
const throatSprayState = state();
throatSprayState.sides.ai.party[0].item = 'Throat Spray';
throatSprayState.sides.ai.party[0].moves = [{name: 'Boomburst'}];
const throatSprayAction = move(throatSprayState, 'Boomburst');
const throatSprayResolution = deriveMoveResolution(throatSprayState, throatSprayAction, {
  hit: true,
  facts: {moveCategory: 'Special', moveType: 'Normal', damage: {rolls: [10], min: 10, max: 10, targetHp: 100, possibleKO: false, guaranteedKO: false}},
});
assert.deepEqual(throatSprayResolution.boostsByPokemon?.['ai-1'], {spa: 1});
assert.equal(throatSprayResolution.itemByPokemon?.['ai-1'], null);
assert.equal(throatSprayResolution.consumedItemByPokemon?.['ai-1'], 'Throat Spray');
const throatSprayNoSound = {...throatSprayState, sides: {
  ...throatSprayState.sides,
  ai: {...throatSprayState.sides.ai, party: throatSprayState.sides.ai.party.map(pokemon => ({
    ...pokemon, moves: [{name: 'Tackle'}],
  }))},
}};
const throatSprayNoSoundResolution = deriveMoveResolution(throatSprayNoSound, move(throatSprayNoSound, 'Tackle'), {
  hit: true, facts: {moveCategory: 'Physical', damage: {rolls: [10], min: 10, max: 10, targetHp: 100, possibleKO: false, guaranteedKO: false}},
});
assert.equal(throatSprayNoSoundResolution.boostsByPokemon, undefined);
const throatSprayGen7 = {...throatSprayState, generation: 7 as BattleState['generation']};
assert.equal(deriveMoveResolution(throatSprayGen7, move(throatSprayGen7, 'Boomburst'), {
  hit: true, facts: {moveCategory: 'Special'},
}).boostsByPokemon, undefined);
const throatSpraySuppressed = {...throatSprayState, field: {...throatSprayState.field, magicRoom: true}};
assert.equal(deriveMoveResolution(throatSpraySuppressed, move(throatSpraySuppressed, 'Boomburst'), {
  hit: true, facts: {moveCategory: 'Special'},
}).boostsByPokemon, undefined);
const sturdyFactsState = state();
sturdyFactsState.sides.player.party[0].ability = 'Sturdy';
const sturdyFacts = calculateActionFacts(sturdyFactsState, move(sturdyFactsState, 'Explosion'));
assert.equal(sturdyFacts.damage?.max, 99);
assert.equal(sturdyFacts.damage?.possibleKO, false);
assert.equal(sturdyFacts.damage?.guaranteedKO, false);
const sturdyFactsGen2State = {...sturdyFactsState, generation: 2 as const};
const sturdyFactsGen2 = calculateActionFacts(sturdyFactsGen2State, move(sturdyFactsGen2State, 'Tackle'));
assert.equal(sturdyFactsGen2.defenderAbility, undefined);
const sturdyFactsGen3State = {...sturdyFactsState, generation: 3 as const};
const sturdyFactsGen3 = calculateActionFacts(sturdyFactsGen3State, move(sturdyFactsGen3State, 'Tackle'));
assert.equal(sturdyFactsGen3.defenderAbility, 'Sturdy');
const focusSashFactsState = state();
focusSashFactsState.sides.player.party[0].item = 'Focus Sash';
const focusSashFacts = calculateActionFacts(focusSashFactsState, move(focusSashFactsState, 'Explosion'));
assert.equal(focusSashFacts.damage?.max, 99);
assert.equal(focusSashFacts.damage?.possibleKO, false);
const focusSashFactsGen3 = calculateActionFacts({...focusSashFactsState, generation: 3 as const}, move({...focusSashFactsState, generation: 3 as const}, 'Explosion'));
assert.equal(focusSashFactsGen3.defenderItem, undefined);
const generationAbilityProjectionPokemon = {...state().sides.ai.party[0], ability: 'Moxie'};
assert.equal(getGenerationAbility(4, generationAbilityProjectionPokemon), undefined);
assert.equal(getGenerationAbility(5, generationAbilityProjectionPokemon), 'Moxie');
const generationAbilityProjectionCases: Array<[string, number]> = [
  ['Friend Guard', 5], ['Power Spot', 8], ['Electromorphosis', 9], ['Seed Sower', 9],
  ['Thermal Exchange', 9], ['Wind Power', 9], ['Mimicry', 8], ['Supreme Overlord', 9], ['Zero to Hero', 9],
  ['Contrary', 5], ['Electric Surge', 7], ['Grassy Surge', 7], ['Misty Surge', 7],
  ['Psychic Surge', 7], ['Full Metal Body', 7], ['Hydration', 4], ['Poison Touch', 5], ['Sand Veil', 3],
];
for (const [ability, generation] of generationAbilityProjectionCases) {
  const pokemon = {...generationAbilityProjectionPokemon, ability};
  assert.equal(getGenerationAbility(generation - 1, pokemon), undefined);
  assert.equal(getGenerationAbility(generation, pokemon), ability);
}
const supremeOverlordState = state();
supremeOverlordState.sides.ai.party[0].species = 'Kingambit';
supremeOverlordState.sides.ai.party[0].ability = 'Supreme Overlord';
supremeOverlordState.sides.ai.party[0].moves = [{name: 'Iron Head'}];
supremeOverlordState.sides.player.party[0].species = 'Aggron';
supremeOverlordState.sides.ai.party[0].alliesFainted = 0;
const supremeOverlordBaseFacts = calculateActionFacts(
  supremeOverlordState,
  move(supremeOverlordState, 'Iron Head'),
);
const supremeOverlordMaxState = {
  ...supremeOverlordState,
  sides: {
    ...supremeOverlordState.sides,
    ai: {
      ...supremeOverlordState.sides.ai,
      party: supremeOverlordState.sides.ai.party.map(pokemon => ({
        ...pokemon,
        alliesFainted: pokemon.id === 'ai-1' ? 5 : pokemon.alliesFainted,
      })),
    },
  },
};
const supremeOverlordMaxFacts = calculateActionFacts(
  supremeOverlordMaxState,
  move(supremeOverlordMaxState, 'Iron Head'),
);
assert.equal(supremeOverlordBaseFacts.attackerAbility, 'Supreme Overlord');
assert.ok((supremeOverlordMaxFacts.damage?.max || 0) > (supremeOverlordBaseFacts.damage?.max || 0));
const supremeOverlordGen8 = {...supremeOverlordMaxState, generation: 8 as const, sides: {
  ...supremeOverlordMaxState.sides,
  ai: {...supremeOverlordMaxState.sides.ai, party: supremeOverlordMaxState.sides.ai.party.map(pokemon => ({
    ...pokemon, species: 'Bisharp',
  }))},
}};
const supremeOverlordGen8Facts = calculateActionFacts(
  supremeOverlordGen8,
  move(supremeOverlordGen8, 'Iron Head'),
);
assert.equal(supremeOverlordGen8Facts.attackerAbility, undefined);
const disguiseGen6 = contactResolutionAgainst({ability: 'Disguise'}, 'Tackle', 6, 100);
assert.equal(disguiseGen6.damageByTarget?.['player-1'], 100);
const disguiseGen7 = contactResolutionAgainst({ability: 'Disguise'}, 'Tackle', 7, 100);
assert.equal(disguiseGen7.damageByTarget?.['player-1'], 0);
const perishBodyContact = contactResolutionAgainst({ability: 'Perish Body'});
assert.deepEqual(perishBodyContact.volatileByPokemon?.['ai-1']?.perishSong,
  {turns: 3, sourceId: 'player-1'});
assert.deepEqual(perishBodyContact.volatileByPokemon?.['player-1']?.perishSong,
  {turns: 3, sourceId: 'player-1'});
assert.equal(contactResolutionAgainst({ability: 'Perish Body'}, 'Thunderbolt')
  .volatileByPokemon?.['ai-1']?.perishSong, undefined);
assert.equal(contactResolutionAgainst({ability: 'Mummy'}, 'Tackle', 9, 10, {ability: 'Overgrow'})
  .abilityOverrideByPokemon?.['ai-1'], 'Mummy');
assert.equal(contactResolutionAgainst({ability: 'Mummy'}, 'Tackle', 9, 10, {ability: 'Disguise'})
  .abilityOverrideByPokemon?.['ai-1'], undefined);
assert.equal(contactResolutionAgainst({ability: 'Mummy'}, 'Tackle', 9, 10,
  {ability: 'Overgrow', item: 'Ability Shield'}).abilityOverrideByPokemon?.['ai-1'], undefined);
assert.equal(contactResolutionAgainst({ability: 'Mummy'}, 'Tackle', 4, 10, {ability: 'Overgrow'})
  .abilityOverrideByPokemon?.['ai-1'], undefined);
const wanderingSpiritContact = contactResolutionAgainst(
  {ability: 'Wandering Spirit'}, 'Tackle', 9, 10, {ability: 'Overgrow'},
);
assert.equal(wanderingSpiritContact.abilityOverrideByPokemon?.['ai-1'], 'Wandering Spirit');
assert.equal(wanderingSpiritContact.abilityOverrideByPokemon?.['player-1'], 'Overgrow');
assert.equal(contactResolutionAgainst(
  {ability: 'Wandering Spirit', item: 'Ability Shield'}, 'Tackle', 9, 10, {ability: 'Overgrow'},
).abilityOverrideByPokemon, undefined);
assert.equal(contactResolutionAgainst(
  {ability: 'Wandering Spirit'}, 'Tackle', 9, 10, {ability: 'Overgrow', item: 'Ability Shield'},
).abilityOverrideByPokemon, undefined);
assert.equal(contactResolutionAgainst({ability: 'Lingering Aroma'}, 'Tackle', 9, 10, {ability: 'Overgrow'})
  .abilityOverrideByPokemon?.['ai-1'], 'Lingering Aroma');
assert.equal(contactResolutionAgainst({ability: 'Lingering Aroma'}, 'Tackle', 8, 10, {ability: 'Overgrow'})
  .abilityOverrideByPokemon?.['ai-1'], undefined);

const unavailableProtection = state();
unavailableProtection.generation = 5;
unavailableProtection.sides.ai.party[0].moves = [{name: "King's Shield"}];
assert.equal(enumerateMoveActions(unavailableProtection).some(action => action.moveName === "King's Shield"), false);
assert.equal(deriveMoveResolution(unavailableProtection, {
  kind: 'move', actorId: 'ai-1', moveName: "King's Shield", targetIds: ['ai-1'],
}, {hit: true}).hit, false);

const unavailableCanonicalMove = state();
unavailableCanonicalMove.generation = 5;
unavailableCanonicalMove.sides.ai.party[0].moves = [{name: 'Dazzling Gleam'}];
assert.equal(enumerateMoveActions(unavailableCanonicalMove).some(action => action.moveName === 'Dazzling Gleam'), false);
const availableCanonicalMove = {...unavailableCanonicalMove, generation: 6 as const};
assert.equal(enumerateMoveActions(availableCanonicalMove).some(action => action.moveName === 'Dazzling Gleam'), true);

const wideGuardState = doublesState();
wideGuardState.sides.ai.party[0].moves = [{name: 'Wide Guard'}];
const wideGuardAction = enumerateMoveActions(wideGuardState).find(action => action.moveName === 'Wide Guard');
assert.ok(wideGuardAction);
const wideGuardApplied = applyAction(
  wideGuardState, wideGuardAction!, deriveMoveResolution(wideGuardState, wideGuardAction!, {hit: true}),
);
assert.equal(wideGuardApplied.sides.ai.effects?.wideGuard, true);
const rockSlideAction: MoveAction = {
  kind: 'move', actorId: 'player-1', moveName: 'Rock Slide', targetIds: ['ai-1', 'ai-2'],
};
const wideGuardBlocked = deriveMoveResolution(wideGuardApplied, rockSlideAction, {
  hit: true, facts: {moveCategory: 'Physical'},
});
assert.ok(wideGuardBlocked.trace?.notes?.some(note => note.includes('blocked by Protect')));
const singleTargetThroughWideGuard = deriveMoveResolution(wideGuardApplied, {
  kind: 'move', actorId: 'player-1', moveName: 'Tackle', targetIds: ['ai-1'],
}, {hit: true, facts: {moveCategory: 'Physical'}});
assert.equal(singleTargetThroughWideGuard.trace?.notes?.some(note => note.includes('blocked by Protect')), false);
assert.equal(beginNextTurn(wideGuardApplied).sides.ai.effects?.wideGuard, false);

const quickGuardState = doublesState();
quickGuardState.sides.ai.party[0].moves = [{name: 'Quick Guard'}];
const quickGuardAction = enumerateMoveActions(quickGuardState).find(action => action.moveName === 'Quick Guard');
assert.ok(quickGuardAction);
const quickGuardApplied = applyAction(
  quickGuardState, quickGuardAction!, deriveMoveResolution(quickGuardState, quickGuardAction!, {hit: true}),
);
const quickAttackBlocked = deriveMoveResolution(quickGuardApplied, {
  kind: 'move', actorId: 'player-1', moveName: 'Quick Attack', targetIds: ['ai-1'],
}, {hit: true, facts: {moveCategory: 'Physical', priority: 1}});
assert.ok(quickAttackBlocked.trace?.notes?.some(note => note.includes('blocked by Protect')));
const ordinaryMoveThroughQuickGuard = deriveMoveResolution(quickGuardApplied, {
  kind: 'move', actorId: 'player-1', moveName: 'Tackle', targetIds: ['ai-1'],
}, {hit: true, facts: {moveCategory: 'Physical', priority: 0}});
assert.equal(ordinaryMoveThroughQuickGuard.trace?.notes?.some(note => note.includes('blocked by Protect')), false);

const psychicTerrainPriorityState = state();
psychicTerrainPriorityState.generation = 7;
psychicTerrainPriorityState.field.terrain = 'Psychic';
const psychicTerrainPriority = deriveMoveResolution(psychicTerrainPriorityState, {
  kind: 'move', actorId: 'ai-1', moveName: 'Quick Attack', targetIds: ['player-1'],
}, {hit: true, facts: {moveCategory: 'Physical', priority: 1}});
assert.ok(psychicTerrainPriority.trace?.notes?.some(note => note.includes('blocked by Psychic Terrain')));

const psychicTerrainAirborne = {...psychicTerrainPriorityState, sides: {
  ...psychicTerrainPriorityState.sides,
  player: {
    ...psychicTerrainPriorityState.sides.player,
    party: psychicTerrainPriorityState.sides.player.party.map(pokemon =>
      pokemon.id === 'player-1' ? {...pokemon, species: 'Charizard'} : pokemon),
  },
}};
const airbornePriority = deriveMoveResolution(psychicTerrainAirborne, {
  kind: 'move', actorId: 'ai-1', moveName: 'Quick Attack', targetIds: ['player-1'],
}, {hit: true, facts: {moveCategory: 'Physical', priority: 1}});
assert.equal(airbornePriority.trace?.notes?.some(note => note.includes('blocked by Psychic Terrain')), false);

const dazzlingPriorityState = state();
dazzlingPriorityState.generation = 7;
dazzlingPriorityState.sides.player.party[0].ability = 'Dazzling';
const dazzlingPriority = deriveMoveResolution(dazzlingPriorityState, {
  kind: 'move', actorId: 'ai-1', moveName: 'Quick Attack', targetIds: ['player-1'],
}, {hit: true, facts: {moveCategory: 'Physical', priority: 1}});
assert.ok(dazzlingPriority.trace?.notes?.some(note => note.includes('priority-blocking ability')));
const dazzlingGen6Priority = deriveMoveResolution({...dazzlingPriorityState, generation: 6}, {
  kind: 'move', actorId: 'ai-1', moveName: 'Quick Attack', targetIds: ['player-1'],
}, {hit: true, facts: {moveCategory: 'Physical', priority: 1}});
assert.equal(dazzlingGen6Priority.trace?.notes?.some(note => note.includes('priority-blocking ability')), false);

const armorTailGen8 = state();
armorTailGen8.generation = 8;
armorTailGen8.sides.player.party[0].ability = 'Armor Tail';
const armorTailGen8Priority = deriveMoveResolution(armorTailGen8, {
  kind: 'move', actorId: 'ai-1', moveName: 'Quick Attack', targetIds: ['player-1'],
}, {hit: true, facts: {moveCategory: 'Physical', priority: 1}});
assert.equal(armorTailGen8Priority.trace?.notes?.some(note => note.includes('priority-blocking ability')), false);
const armorTailGen9Priority = deriveMoveResolution({...armorTailGen8, generation: 9}, {
  kind: 'move', actorId: 'ai-1', moveName: 'Quick Attack', targetIds: ['player-1'],
}, {hit: true, facts: {moveCategory: 'Physical', priority: 1}});
assert.ok(armorTailGen9Priority.trace?.notes?.some(note => note.includes('priority-blocking ability')));
const armorTailAllyState = doublesState();
armorTailAllyState.sides.player.party.find(pokemon => pokemon.id === 'player-2')!.ability = 'Armor Tail';
const armorTailAllyPriority = deriveMoveResolution(armorTailAllyState, {
  kind: 'move', actorId: 'ai-1', moveName: 'Quick Attack', targetIds: ['player-1'],
}, {hit: true, facts: {moveCategory: 'Physical', priority: 1}});
assert.ok(armorTailAllyPriority.trace?.notes?.some(note => note.includes('priority-blocking ability')));
const faintedArmorTailAlly = {...armorTailAllyState, sides: {
  ...armorTailAllyState.sides,
  player: {...armorTailAllyState.sides.player, party: armorTailAllyState.sides.player.party.map(pokemon =>
    pokemon.id === 'player-2' ? {...pokemon, hp: {...pokemon.hp, current: 0}} : pokemon)},
}};
const faintedArmorTailPriority = deriveMoveResolution(faintedArmorTailAlly, {
  kind: 'move', actorId: 'ai-1', moveName: 'Quick Attack', targetIds: ['player-1'],
}, {hit: true, facts: {moveCategory: 'Physical', priority: 1}});
assert.equal(faintedArmorTailPriority.trace?.notes?.some(note => note.includes('priority-blocking ability')), false);

const pranksterDarkState = state();
pranksterDarkState.generation = 7;
pranksterDarkState.sides.ai.party[0].ability = 'Prankster';
pranksterDarkState.sides.player.party[0].typeOverride = ['Dark'];
const pranksterDarkPriority = deriveMoveResolution(pranksterDarkState, {
  kind: 'move', actorId: 'ai-1', moveName: 'Thunder Wave', targetIds: ['player-1'],
}, {hit: true, facts: {moveCategory: 'Status'}});
assert.ok(pranksterDarkPriority.trace?.notes?.some(note => note.includes('priority-blocking ability')));
assert.equal(pranksterDarkPriority.statusByPokemon, undefined);
const pranksterDarkGen6 = deriveMoveResolution({...pranksterDarkState, generation: 6}, {
  kind: 'move', actorId: 'ai-1', moveName: 'Thunder Wave', targetIds: ['player-1'],
}, {hit: true, facts: {moveCategory: 'Status'}});
assert.equal(pranksterDarkGen6.trace?.notes?.some(note => note.includes('priority-blocking ability')), false);
assert.equal(pranksterDarkGen6.statusByPokemon?.['player-1'], 'par');
const pranksterNormalTarget = {...pranksterDarkState, sides: {
  ...pranksterDarkState.sides,
  player: {...pranksterDarkState.sides.player, party: pranksterDarkState.sides.player.party.map(pokemon => ({
    ...pokemon, typeOverride: undefined,
  }))},
}};
const pranksterNormalPriority = deriveMoveResolution(pranksterNormalTarget, {
  kind: 'move', actorId: 'ai-1', moveName: 'Thunder Wave', targetIds: ['player-1'],
}, {hit: true, facts: {moveCategory: 'Status'}});
assert.equal(pranksterNormalPriority.trace?.notes?.some(note => note.includes('priority-blocking ability')), false);
assert.equal(pranksterNormalPriority.statusByPokemon?.['player-1'], 'par');
const suppressedPrankster = {...pranksterDarkState, sides: {
  ...pranksterDarkState.sides,
  ai: {...pranksterDarkState.sides.ai, party: pranksterDarkState.sides.ai.party.map(pokemon => ({
    ...pokemon, ability: 'Mold Breaker',
  }))},
}};
const suppressedPranksterPriority = deriveMoveResolution(suppressedPrankster, {
  kind: 'move', actorId: 'ai-1', moveName: 'Thunder Wave', targetIds: ['player-1'],
}, {hit: true, facts: {moveCategory: 'Status'}});
assert.equal(suppressedPranksterPriority.trace?.notes?.some(note => note.includes('priority-blocking ability')), false);
assert.equal(suppressedPranksterPriority.statusByPokemon?.['player-1'], 'par');
const pranksterDarkStatusScore = scoreStatusAction(pranksterDarkState, {
  action: {kind: 'move', actorId: 'ai-1', moveName: 'Thunder Wave', targetIds: ['player-1']},
  facts: {moveCategory: 'Status', priority: 1}, outcomes: [], reasons: [],
});
assert.deepEqual(pranksterDarkStatusScore.outcomes, [{score: -20, probability: 1}]);

const soundSubstituteState = state();
soundSubstituteState.sides.ai.party[0].moves = [{name: 'Roar'}];
soundSubstituteState.sides.player.party[0].substituteHp = 20;
const soundSubstituteResolution = deriveMoveResolution(soundSubstituteState, {
  kind: 'move', actorId: 'ai-1', moveName: 'Roar', targetIds: ['player-1'],
}, {hit: true});
assert.deepEqual(soundSubstituteResolution.forcedSwitchByPokemon, {'player-1': true});
const overriddenSoundState = state();
overriddenSoundState.sides.ai.party[0].moves = [{name: 'Roar', sound: false}];
overriddenSoundState.sides.player.party[0].substituteHp = 20;
const overriddenSoundResolution = deriveMoveResolution(overriddenSoundState, {
  kind: 'move', actorId: 'ai-1', moveName: 'Roar', targetIds: ['player-1'],
}, {hit: true});
assert.equal(overriddenSoundResolution.forcedSwitchByPokemon, undefined);
const nonSoundSubstituteState = state();
nonSoundSubstituteState.sides.ai.party[0].moves = [{name: 'Toxic'}];
nonSoundSubstituteState.sides.player.party[0].substituteHp = 20;
const nonSoundSubstituteResolution = deriveMoveResolution(nonSoundSubstituteState, {
  kind: 'move', actorId: 'ai-1', moveName: 'Toxic', targetIds: ['player-1'],
}, {hit: true});
assert.equal(nonSoundSubstituteResolution.statusByPokemon, undefined);
const soundproofState = state();
soundproofState.sides.ai.party[0].moves = [{name: 'Roar'}];
soundproofState.sides.player.party[0].ability = 'Soundproof';
const soundproofResolution = deriveMoveResolution(soundproofState, {
  kind: 'move', actorId: 'ai-1', moveName: 'Roar', targetIds: ['player-1'],
}, {hit: true});
assert.equal(soundproofResolution.forcedSwitchByPokemon, undefined);
const unusablePerishSong = state();
unusablePerishSong.sides.ai.party[0].moves = [{name: 'Perish Song'}];
unusablePerishSong.sides.ai.party[0].volatile = {perishSong: {turns: 2}};
unusablePerishSong.sides.player.party[0].ability = 'Soundproof';
const unusablePerishSongScore = scoreStatusAction(unusablePerishSong, {
  action: {kind: 'move', actorId: 'ai-1', moveName: 'Perish Song', targetIds: ['ai-1', 'player-1']},
  facts: {moveCategory: 'Status'}, outcomes: [], reasons: [],
});
assert.deepEqual(unusablePerishSongScore.outcomes, [{score: -20, probability: 1}]);
const partiallyUsablePerishSong = {...unusablePerishSong, sides: {
  ...unusablePerishSong.sides,
  player: {...unusablePerishSong.sides.player, party: unusablePerishSong.sides.player.party.map(pokemon => ({
    ...pokemon, ability: undefined,
  }))},
}};
const partiallyUsablePerishSongScore = scoreStatusAction(partiallyUsablePerishSong, {
  action: {kind: 'move', actorId: 'ai-1', moveName: 'Perish Song', targetIds: ['ai-1', 'player-1']},
  facts: {moveCategory: 'Status'}, outcomes: [], reasons: [],
});
assert.deepEqual(partiallyUsablePerishSongScore.outcomes, [{score: 6, probability: 1}]);
const repeatedForesight = state();
repeatedForesight.sides.ai.party[0].moves = [{name: 'Foresight'}];
repeatedForesight.sides.player.party[0].volatile = {foresight: {}};
const repeatedForesightScore = scoreStatusAction(repeatedForesight, {
  action: {kind: 'move', actorId: 'ai-1', moveName: 'Foresight', targetIds: ['player-1']},
  facts: {moveCategory: 'Status'}, outcomes: [], reasons: [],
});
assert.deepEqual(repeatedForesightScore.outcomes, [{score: -20, probability: 1}]);
const repeatedForesightResolution = deriveMoveResolution(repeatedForesight, {
  kind: 'move', actorId: 'ai-1', moveName: 'Foresight', targetIds: ['player-1'],
}, {hit: true});
assert.equal(repeatedForesightResolution.volatileByPokemon, undefined);
const repeatedTargetVolatiles = state();
repeatedTargetVolatiles.sides.ai.party[0].moves = [
  {name: 'Leech Seed'}, {name: 'Attract'}, {name: 'Torment'}, {name: 'Disable'}, {name: 'Yawn'},
];
repeatedTargetVolatiles.sides.player.party[0].volatile = {
  leechSeed: {sourceId: 'ai-1'},
  infatuated: {},
  torment: {},
  disable: {moveName: 'Tackle'},
  yawn: {turns: 1},
};
repeatedTargetVolatiles.lastMoveByPokemon = {'player-1': 'Tackle'};
for (const moveName of ['Leech Seed', 'Attract', 'Torment', 'Disable', 'Yawn']) {
  const repeatedScore = scoreStatusAction(repeatedTargetVolatiles, {
    action: {kind: 'move', actorId: 'ai-1', moveName, targetIds: ['player-1']},
    facts: {moveCategory: 'Status'}, outcomes: [], reasons: [],
  });
  assert.deepEqual(repeatedScore.outcomes, [{score: -20, probability: 1}], moveName);
}
const repeatedYawnResolution = deriveMoveResolution(repeatedTargetVolatiles, {
  kind: 'move', actorId: 'ai-1', moveName: 'Yawn', targetIds: ['player-1'],
}, {hit: true});
assert.equal(repeatedYawnResolution.volatileByPokemon, undefined);
const repeatedSelfVolatiles = [
  ['Aqua Ring', 'aquaRing'], ['Ingrain', 'ingrain'], ['Magnet Rise', 'magnetRise'],
] as const;
for (const [moveName, volatileName] of repeatedSelfVolatiles) {
  const repeatedSelf = state();
  repeatedSelf.sides.ai.party[0].moves = [{name: moveName}];
  repeatedSelf.sides.ai.party[0].volatile = {[volatileName]: {turns: 5}};
  const repeatedScore = scoreStatusAction(repeatedSelf, {
    action: {kind: 'move', actorId: 'ai-1', moveName, targetIds: ['ai-1']},
    facts: {moveCategory: 'Status'}, outcomes: [], reasons: [],
  });
  assert.deepEqual(repeatedScore.outcomes, [{score: -20, probability: 1}], moveName);
}
const repeatedTelekinesis = state();
repeatedTelekinesis.sides.ai.party[0].moves = [{name: 'Telekinesis'}];
repeatedTelekinesis.sides.player.party[0].volatile = {telekinesis: {turns: 3}};
const repeatedTelekinesisScore = scoreStatusAction(repeatedTelekinesis, {
  action: {kind: 'move', actorId: 'ai-1', moveName: 'Telekinesis', targetIds: ['player-1']},
  facts: {moveCategory: 'Status'}, outcomes: [], reasons: [],
});
assert.deepEqual(repeatedTelekinesisScore.outcomes, [{score: -20, probability: 1}]);
const gravityTelekinesis = {...repeatedTelekinesis, field: {gravity: true}, sides: {
  ...repeatedTelekinesis.sides,
  player: {...repeatedTelekinesis.sides.player, party: repeatedTelekinesis.sides.player.party.map(pokemon => ({
    ...pokemon, volatile: undefined,
  }))},
}};
const gravityTelekinesisScore = scoreStatusAction(gravityTelekinesis, {
  action: {kind: 'move', actorId: 'ai-1', moveName: 'Telekinesis', targetIds: ['player-1']},
  facts: {moveCategory: 'Status'}, outcomes: [], reasons: [],
});
assert.deepEqual(gravityTelekinesisScore.outcomes, [{score: -20, probability: 1}]);
const soundproofMoldBreakerState = {...soundproofState, sides: {
  ...soundproofState.sides,
  ai: {...soundproofState.sides.ai, party: soundproofState.sides.ai.party.map(pokemon => ({
    ...pokemon, ability: 'Mold Breaker',
  }))},
}};
const soundproofMoldBreakerResolution = deriveMoveResolution(soundproofMoldBreakerState, {
  kind: 'move', actorId: 'ai-1', moveName: 'Roar', targetIds: ['player-1'],
}, {hit: true});
assert.deepEqual(soundproofMoldBreakerResolution.forcedSwitchByPokemon, {'player-1': true});
const soundproofMyceliumDamageState = {...soundproofState, sides: {
  ...soundproofState.sides,
  ai: {...soundproofState.sides.ai, party: soundproofState.sides.ai.party.map(pokemon => ({
    ...pokemon, ability: 'Mycelium Might', moves: [{name: 'Boomburst'}],
  }))},
}};
const soundproofMyceliumDamageResolution = deriveMoveResolution(soundproofMyceliumDamageState, {
  kind: 'move', actorId: 'ai-1', moveName: 'Boomburst', targetIds: ['player-1'],
}, {
  hit: true,
  facts: {
    moveCategory: 'Special',
    isImmune: true,
    damage: {rolls: [20], min: 20, max: 20, targetHp: 100, possibleKO: false, guaranteedKO: false},
  },
});
assert.equal(soundproofMyceliumDamageResolution.damageByTarget?.['player-1'], undefined);

const matBlockState = doublesState();
matBlockState.firstTurnOutIds = ['ai-1'];
matBlockState.sides.ai.party[0].moves = [{name: 'Mat Block'}];
const matBlockAction = enumerateMoveActions(matBlockState).find(action => action.moveName === 'Mat Block');
assert.ok(matBlockAction);
const matBlockApplied = applyAction(
  matBlockState, matBlockAction!, deriveMoveResolution(matBlockState, matBlockAction!, {hit: true}),
);
const matBlockBlocked = deriveMoveResolution(matBlockApplied, {
  kind: 'move', actorId: 'player-1', moveName: 'Tackle', targetIds: ['ai-1'],
}, {hit: true, facts: {moveCategory: 'Physical'}});
assert.ok(matBlockBlocked.trace?.notes?.some(note => note.includes('blocked by Protect')));
const statusThroughMatBlock = deriveMoveResolution(matBlockApplied, {
  kind: 'move', actorId: 'player-1', moveName: 'Growl', targetIds: ['ai-1'],
}, {hit: true, facts: {moveCategory: 'Status'}});
assert.equal(statusThroughMatBlock.trace?.notes?.some(note => note.includes('blocked by Protect')), false);
assert.equal(beginNextTurn(matBlockApplied).sides.ai.effects?.matBlock, false);

const unavailableGuardState = doublesState();
unavailableGuardState.generation = 4;
unavailableGuardState.sides.ai.party[0].moves = [{name: 'Wide Guard'}];
assert.equal(enumerateMoveActions(unavailableGuardState).some(action => action.moveName === 'Wide Guard'), false);
assert.equal(deriveMoveResolution(unavailableGuardState, {
  kind: 'move', actorId: 'ai-1', moveName: 'Wide Guard', targetIds: ['ai-1'],
}, {hit: true}).hit, false);
const unavailableMatBlockState = doublesState();
unavailableMatBlockState.firstTurnOutIds = [];
unavailableMatBlockState.sides.ai.party[0].moves = [{name: 'Mat Block'}];
assert.equal(enumerateMoveActions(unavailableMatBlockState).some(action => action.moveName === 'Mat Block'), false);
assert.equal(deriveMoveResolution(unavailableMatBlockState, {
  kind: 'move', actorId: 'ai-1', moveName: 'Mat Block', targetIds: ['ai-1'],
}, {hit: true}).hit, false);

const firstTurnMovesState = state();
firstTurnMovesState.sides.ai.party[0].moves = [{name: 'Fake Out'}, {name: 'First Impression'}];
firstTurnMovesState.firstTurnOutIds = ['ai-1'];
assert.equal(enumerateMoveActions(firstTurnMovesState).filter(action =>
  ['Fake Out', 'First Impression'].includes(action.moveName)).length, 2);
const firstTurnMovesUsed = {...firstTurnMovesState, firstTurnOutIds: [] as string[]};
assert.equal(enumerateMoveActions(firstTurnMovesUsed).some(action =>
  ['Fake Out', 'First Impression'].includes(action.moveName)), false);
const fakeOutAfterOpening = deriveMoveResolution(firstTurnMovesUsed, {
  kind: 'move', actorId: 'ai-1', moveName: 'Fake Out', targetIds: ['player-1'],
}, {hit: true});
assert.equal(fakeOutAfterOpening.hit, false);
assert.ok(fakeOutAfterOpening.trace?.notes?.some(note => note.includes('first turn out')));
const firstImpressionGen6 = {...firstTurnMovesState, generation: 6 as const};
assert.equal(enumerateMoveActions(firstImpressionGen6).some(action => action.moveName === 'First Impression'), false);
const firstTurnReplacement = state();
firstTurnReplacement.sides.ai.party[0].moves = [{name: 'Fake Out'}];
firstTurnReplacement.sides.ai.party.push({
  id: 'ai-2', species: 'Pikachu', level: 100,
  hp: {current: 100, max: 100}, moves: [{name: 'Fake Out'}],
});
const switchedForFirstTurn = applySwitchAction(firstTurnReplacement, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2',
});
assert.ok(switchedForFirstTurn.firstTurnOutIds?.includes('ai-2'));
assert.equal(enumerateMoveActions(switchedForFirstTurn).some(action => action.moveName === 'Fake Out'), true);
assert.equal(enumerateMoveActions(beginNextTurn(switchedForFirstTurn)).some(action => action.moveName === 'Fake Out'), false);

const feintGuardState = doublesState();
feintGuardState.sides.ai.party[0].moves = [{name: 'Wide Guard'}];
feintGuardState.sides.player.party[0].moves = [{name: 'Feint'}];
const feintGuardAction = enumerateMoveActions(feintGuardState).find(action => action.moveName === 'Wide Guard')!;
const feintGuardApplied = applyAction(
  feintGuardState, feintGuardAction, deriveMoveResolution(feintGuardState, feintGuardAction, {hit: true}),
);
const feintResolution = deriveMoveResolution(feintGuardApplied, {
  kind: 'move', actorId: 'player-1', moveName: 'Feint', targetIds: ['ai-1'],
}, {hit: true, facts: {moveCategory: 'Physical'}});
assert.equal(feintResolution.sideEffectsBySide?.ai?.wideGuard, false);
assert.equal(applyAction(feintGuardApplied, {
  kind: 'move', actorId: 'player-1', moveName: 'Feint', targetIds: ['ai-1'],
}, feintResolution).sides.ai.effects?.wideGuard, false);

const allySwitchState = doublesState();
allySwitchState.sides.ai.party[0].moves = [{name: 'Ally Switch'}];
const allySwitchAction = enumerateMoveActions(allySwitchState).find(action => action.moveName === 'Ally Switch');
assert.ok(allySwitchAction);
assert.deepEqual(allySwitchAction?.targetIds, ['ai-1']);
const allySwitchResolution = deriveMoveResolution(allySwitchState, allySwitchAction!, {hit: true});
assert.deepEqual(allySwitchResolution.allySwitchByPokemon, {'ai-1': true});
const allySwitched = applyAction(allySwitchState, allySwitchAction!, allySwitchResolution);
assert.deepEqual(allySwitched.sides.ai.activeIds, ['ai-2', 'ai-1']);
assert.deepEqual(allySwitchState.sides.ai.activeIds, ['ai-1', 'ai-2']);

const allySwitchSingles = state();
allySwitchSingles.sides.ai.party[0].moves = [{name: 'Ally Switch'}];
assert.equal(enumerateMoveActions(allySwitchSingles).some(action => action.moveName === 'Ally Switch'), false);
assert.equal(deriveMoveResolution(allySwitchSingles, {
  kind: 'move', actorId: 'ai-1', moveName: 'Ally Switch', targetIds: ['ai-1'],
}, {hit: true}).hit, false);
const allySwitchOldGeneration = doublesState();
allySwitchOldGeneration.generation = 5;
allySwitchOldGeneration.sides.ai.party[0].moves = [{name: 'Ally Switch'}];
assert.equal(enumerateMoveActions(allySwitchOldGeneration).some(action => action.moveName === 'Ally Switch'), false);
const faintAllySwitch = doublesState();
faintAllySwitch.sides.ai.party[1].hp.current = 0;
faintAllySwitch.sides.ai.party[0].moves = [{name: 'Ally Switch'}];
assert.equal(enumerateMoveActions(faintAllySwitch).some(action => action.moveName === 'Ally Switch'), false);

const protectResidualState = state();
protectResidualState.sides.ai.party[0].hp = {current: 10, max: 100};
protectResidualState.sides.ai.party[0].status = 'brn';
protectResidualState.sides.ai.party[0].moves = [{name: 'Protect'}];
const protectResidualAction = move(protectResidualState, 'Protect', ['ai-1']);
assert.deepEqual(scoreStatusAction(protectResidualState, {
  action: protectResidualAction, facts: {}, outcomes: [], reasons: [],
}).outcomes, [{score: 4, probability: 1}]);

const protectContextState = state();
protectContextState.sides.ai.party[0].moves = [{name: 'Protect'}];
protectContextState.sides.ai.party[0].volatile = {leechSeed: {sourceId: 'player-1'}};
const protectContextAction = move(protectContextState, 'Protect', ['ai-1']);
assert.deepEqual(scoreStatusAction(protectContextState, {
  action: protectContextAction, facts: {}, outcomes: [], reasons: [],
}).outcomes, [{score: 4, probability: 1}]);
protectContextState.sides.ai.party[0].volatile = undefined;
protectContextState.sides.player.party[0].volatile = {curse: {sourceId: 'ai-1'}};
assert.deepEqual(scoreStatusAction(protectContextState, {
  action: protectContextAction, facts: {}, outcomes: [], reasons: [],
}).outcomes, [{score: 7, probability: 1}]);
protectContextState.sides.player.party[0].hp.current = 0;
assert.deepEqual(scoreStatusAction(protectContextState, {
  action: protectContextAction, facts: {}, outcomes: [], reasons: [],
}).outcomes, [{score: 6, probability: 1}]);

const kingsShieldPolicyState = state();
kingsShieldPolicyState.sides.ai.party[0].moves = [{name: "King's Shield"}];
kingsShieldPolicyState.sides.ai.party[0].status = 'brn';
const kingsShieldPolicyAction = move(kingsShieldPolicyState, "King's Shield", ['ai-1']);
assert.deepEqual(scoreStatusAction(kingsShieldPolicyState, {
  action: kingsShieldPolicyAction, facts: {}, outcomes: [], reasons: [],
}).outcomes, [{score: 4, probability: 1}]);
kingsShieldPolicyState.sides.ai.party[0].status = '';
kingsShieldPolicyState.lastMoveByPokemon = {'ai-1': "King's Shield"};
assert.deepEqual(scoreStatusAction(kingsShieldPolicyState, {
  action: kingsShieldPolicyAction, facts: {}, outcomes: [], reasons: [],
}).outcomes, [{score: -20, probability: 0.5}, {score: 6, probability: 0.5}]);

const conversionState = state();
conversionState.sides.ai.party[0].species = 'Eevee';
conversionState.sides.ai.party[0].moves = [{name: 'Thunderbolt'}, {name: 'Conversion'}];
const conversionAction = enumerateMoveActions(conversionState).find(candidate => candidate.moveName === 'Conversion')!;
assert.deepEqual(deriveMoveResolution(conversionState, conversionAction).typeOverrideByPokemon, {
  'ai-1': ['Electric'],
});
const conversionNoOp = {...conversionState, sides: {
  ...conversionState.sides,
  ai: {...conversionState.sides.ai, party: [{
    ...conversionState.sides.ai.party[0], typeOverride: ['Electric'],
  }]},
}};
assert.equal(enumerateMoveActions(conversionNoOp).some(candidate => candidate.moveName === 'Conversion'), false);
assert.equal(deriveMoveResolution(conversionNoOp, {
  kind: 'move', actorId: 'ai-1', moveName: 'Conversion', targetIds: ['ai-1'],
}).typeOverrideByPokemon, undefined);

const conversion2State = state();
conversion2State.sides.ai.party[0].species = 'Eevee';
conversion2State.sides.ai.party[0].moves = [{name: 'Conversion 2'}];
conversion2State.lastMoveByPokemon = {'player-1': 'Thunderbolt'};
conversion2State.lastMoveUsedByPokemon = {'player-1': 'Thunderbolt'};
const conversion2Action = enumerateMoveActions(conversion2State)[0];
assert.deepEqual(conversion2Action.targetIds, ['player-1']);
assert.deepEqual(deriveMoveResolution(conversion2State, conversion2Action, {
  hit: true, random: () => 0,
}).typeOverrideByPokemon, {'ai-1': ['Grass']});

const conversion2Legacy = state();
conversion2Legacy.generation = 4;
conversion2Legacy.sides.ai.party[0].species = 'Eevee';
conversion2Legacy.sides.ai.party[0].moves = [{name: 'Conversion 2'}];
conversion2Legacy.lastMoveTargetedByPokemon = {'ai-1': 'Tail Whip'};
conversion2Legacy.lastDamagingMoveByPokemon = {'ai-1': 'Thunderbolt'};
const conversion2LegacyAction = enumerateMoveActions(conversion2Legacy)[0];
assert.deepEqual(conversion2LegacyAction.targetIds, ['ai-1']);
assert.deepEqual(deriveMoveResolution(conversion2Legacy, conversion2LegacyAction, {
  hit: true, random: () => 0,
}).typeOverrideByPokemon, {'ai-1': ['Grass']});

const conversion2NoHistory = state();
conversion2NoHistory.sides.ai.party[0].species = 'Eevee';
conversion2NoHistory.sides.ai.party[0].moves = [{name: 'Conversion 2'}];
assert.equal(deriveMoveResolution(conversion2NoHistory, {
  kind: 'move', actorId: 'ai-1', moveName: 'Conversion 2', targetIds: ['player-1'],
}, {
  hit: true,
}).hit, false);

const conversion2Shield = state();
conversion2Shield.sides.ai.party[0].species = 'Eevee';
conversion2Shield.sides.ai.party[0].moves = [{name: 'Conversion 2'}];
conversion2Shield.sides.player.effects = {craftyShield: true};
conversion2Shield.lastMoveUsedByPokemon = {'player-1': 'Thunderbolt'};
assert.equal(deriveMoveResolution(conversion2Shield, enumerateMoveActions(conversion2Shield)[0], {
  hit: true,
}).hit, false);

const proteanState = state();
proteanState.sides.ai.party[0] = {
  ...proteanState.sides.ai.party[0], species: 'Greninja', ability: 'Protean',
  moves: [{name: 'Flamethrower'}, {name: 'Water Gun'}],
};
const proteanFireAction = enumerateMoveActions(proteanState, 'ai')
  .find(action => action.kind === 'move' && action.moveName === 'Flamethrower')!;
const proteanFireFacts = calculateActionFacts(proteanState, proteanFireAction);
assert.deepEqual(deriveMoveResolution(proteanState, proteanFireAction, {
  facts: proteanFireFacts, hit: true,
}).typeOverrideByPokemon?.['ai-1'], ['Fire']);
const proteanFireResolution = deriveMoveResolution(proteanState, proteanFireAction, {
  facts: proteanFireFacts, hit: true,
});
const proteanFireApplied = applyAction(proteanState, proteanFireAction, proteanFireResolution);
assert.deepEqual(proteanFireApplied.sides.ai.party[0].typeOverride, ['Fire']);
assert.equal(proteanFireApplied.sides.ai.party[0].typeChangeUsed, true);
const proteanWaterAction: MoveAction = {
  kind: 'move', actorId: 'ai-1', moveName: 'Water Gun', targetIds: ['player-1'],
};
assert.equal(deriveMoveResolution(proteanFireApplied, proteanWaterAction, {
  facts: calculateActionFacts(proteanFireApplied, proteanWaterAction), hit: true,
}).typeOverrideByPokemon, undefined);
const proteanGen8 = {...proteanState, generation: 8 as const};
const proteanGen8Fire = deriveMoveResolution(proteanGen8, proteanFireAction, {
  facts: calculateActionFacts(proteanGen8, proteanFireAction), hit: true,
});
const proteanGen8Applied = applyAction(proteanGen8, proteanFireAction, proteanGen8Fire);
const proteanGen8Water = deriveMoveResolution(proteanGen8Applied, proteanWaterAction, {
  facts: calculateActionFacts(proteanGen8Applied, proteanWaterAction), hit: true,
});
assert.deepEqual(proteanGen8Water.typeOverrideByPokemon?.['ai-1'], ['Water']);
const liberoState = {...proteanState, generation: 8 as const, sides: {
  ...proteanState.sides,
  ai: {...proteanState.sides.ai, party: proteanState.sides.ai.party.map(pokemon => ({
    ...pokemon, ability: 'Libero', typeOverride: undefined, typeChangeUsed: undefined,
  }))},
}};
assert.deepEqual(deriveMoveResolution(liberoState, proteanFireAction, {
  facts: calculateActionFacts(liberoState, proteanFireAction), hit: true,
}).typeOverrideByPokemon?.['ai-1'], ['Fire']);
const proteanSuppressed = {...proteanState, sides: {...proteanState.sides,
  ai: {...proteanState.sides.ai, party: proteanState.sides.ai.party.map(pokemon => ({
    ...pokemon, abilitySuppressed: true,
  }))},
}};
assert.equal(deriveMoveResolution(proteanSuppressed, proteanFireAction, {
  facts: calculateActionFacts(proteanSuppressed, proteanFireAction), hit: true,
}).typeOverrideByPokemon, undefined);

const mimicState = state();
mimicState.sides.ai.party[0].moves = [{name: 'Mimic', pp: 1, maxPP: 1}];
mimicState.lastMoveByPokemon = {'player-1': 'Thunderbolt'};
mimicState.lastMoveUsedByPokemon = {'player-1': 'Thunderbolt'};
const mimicAction = enumerateMoveActions(mimicState)[0];
const mimicResolution = deriveMoveResolution(mimicState, mimicAction, {hit: true});
assert.equal(mimicResolution.movesByPokemon?.['ai-1']?.[0].name, 'Thunderbolt');
assert.equal(mimicResolution.movesByPokemon?.['ai-1']?.[0].pp, 15);
const mimicked = applyAction(mimicState, mimicAction, mimicResolution);
assert.equal(mimicked.sides.ai.party[0].moves[0].name, 'Thunderbolt');
assert.equal(mimicked.sides.ai.party[0].originalMoves?.[0].name, 'Mimic');

const sketchState = state();
sketchState.sides.ai.party[0].moves = [{name: 'Sketch', pp: 1, maxPP: 1}];
sketchState.lastMoveUsedByPokemon = {'player-1': 'Tackle'};
assert.equal(deriveMoveResolution(sketchState, enumerateMoveActions(sketchState)[0], {
  hit: true,
}).movesByPokemon?.['ai-1']?.[0].name, 'Tackle');

const copycatState = state();
copycatState.sides.ai.party[0].moves = [{name: 'Copycat'}];
copycatState.lastMoveUsed = 'Thunderbolt';
assert.deepEqual(deriveMoveResolution(copycatState, enumerateMoveActions(copycatState)[0], {
  hit: true,
}).copyMoveByPokemon, {'ai-1': 'Thunderbolt'});

const mirrorMoveState = state();
mirrorMoveState.sides.ai.party[0].moves = [{name: 'Mirror Move'}];
mirrorMoveState.lastMoveTargetedByPokemon = {'ai-1': 'Tackle'};
assert.deepEqual(deriveMoveResolution(mirrorMoveState, enumerateMoveActions(mirrorMoveState)[0], {
  hit: true,
}).copyMoveByPokemon, {'ai-1': 'Tackle'});

const metronomeState = state();
metronomeState.sides.ai.party[0].moves = [{name: 'Metronome'}];
const metronomeResolution = deriveMoveResolution(metronomeState, enumerateMoveActions(metronomeState)[0], {
  hit: true, random: () => 0,
});
assert.ok(metronomeResolution.calledMoveByPokemon?.['ai-1']);
assert.notEqual(metronomeResolution.calledMoveByPokemon?.['ai-1'], 'Metronome');

const sleepTalkState = state();
sleepTalkState.sides.ai.party[0].status = 'slp';
sleepTalkState.sides.ai.party[0].statusTurns = 2;
sleepTalkState.sides.ai.party[0].moves = [{name: 'Sleep Talk'}, {name: 'Tackle'}];
const sleepTalkResolution = deriveMoveResolution(sleepTalkState, enumerateMoveActions(sleepTalkState)[0], {
  hit: true, random: () => 0,
});
assert.deepEqual(sleepTalkResolution.calledMoveByPokemon, {'ai-1': 'Tackle'});

const dancerState = state();
dancerState.sides.ai.party[0].moves = [{name: 'Swords Dance'}];
dancerState.sides.player.party[0].ability = 'Dancer';
const dancerAction = move(dancerState, 'Swords Dance', ['ai-1']);
const dancerResolution = deriveMoveResolution(dancerState, dancerAction, {hit: true});
assert.deepEqual(dancerResolution.calledMoveByPokemon, {'player-1': 'Swords Dance'});
assert.deepEqual(dancerResolution.calledMoveTargetIdsByPokemon, {'player-1': ['ai-1']});
assert.deepEqual(dancerResolution.calledMoveExternalByPokemon, {'player-1': true});
assert.ok(dancerResolution.trace?.notes?.some(note => note.includes('Dancer queued')));

const dancerMiss = deriveMoveResolution(dancerState, dancerAction, {hit: false});
assert.equal(dancerMiss.calledMoveByPokemon, undefined);
const dancerGen6 = {...dancerState, generation: 6 as const};
assert.equal(deriveMoveResolution(dancerGen6, dancerAction, {hit: true}).calledMoveByPokemon, undefined);

const awakeSleepTalkState = state();
awakeSleepTalkState.sides.ai.party[0].moves = [{name: 'Sleep Talk'}, {name: 'Tackle'}];
assert.equal(deriveMoveResolution(awakeSleepTalkState, {
  kind: 'move', actorId: 'ai-1', moveName: 'Sleep Talk', targetIds: ['player-1'],
}, {
  hit: true,
}).hit, false);

const emptySleepTalkState = state();
emptySleepTalkState.sides.ai.party[0].status = 'slp';
// Turns 2: still asleep after the attempt burn (turns 1 would wake and act
// under Gen 8 attempt-decremented sleep).
emptySleepTalkState.sides.ai.party[0].statusTurns = 2;
emptySleepTalkState.sides.ai.party[0].moves = [{name: 'Sleep Talk'}];
assert.equal(deriveMoveResolution(emptySleepTalkState, enumerateMoveActions(emptySleepTalkState)[0], {
  hit: true,
}).hit, false);

const normalSleepCountdown = state();
normalSleepCountdown.sides.ai.party[0].status = 'slp';
normalSleepCountdown.sides.ai.party[0].statusTurns = 3;
// The boundary leaves sleep alone now — the counter burns on the action
// attempt (see sleep-decrement.test.ts), so a mon that never attempted
// keeps its full counter.
assert.equal(beginNextTurn(normalSleepCountdown).sides.ai.party[0].statusTurns, 3);
// Sleep burns on the ACTION ATTEMPT (Gen 8), so Early Bird's double
// decrement rides the gate now, not the turn boundary. The boundary must
// leave the counter alone in every variant.
const earlyBirdSleep = state();
earlyBirdSleep.sides.ai.party[0].ability = 'Early Bird';
earlyBirdSleep.sides.ai.party[0].status = 'slp';
earlyBirdSleep.sides.ai.party[0].statusTurns = 3;
earlyBirdSleep.sides.ai.party[0].moves = [{name: 'Tackle', pp: 35, maxPP: 35}];
assert.equal(beginNextTurn(earlyBirdSleep).sides.ai.party[0].statusTurns, 3,
  'the boundary no longer decrements sleep');
const earlyBirdAttempt = deriveMoveResolution(earlyBirdSleep,
  enumerateMoveActions(earlyBirdSleep)[0], {hit: true});
assert.equal(earlyBirdAttempt.statusTurnsByPokemon?.['ai-1'], 1,
  'Early Bird burns two counter points on the attempt');
const earlyBirdGen2 = {...earlyBirdSleep, generation: 2 as BattleState['generation']};
const gen2Attempt = deriveMoveResolution(earlyBirdGen2,
  enumerateMoveActions(earlyBirdGen2)[0], {hit: true});
assert.equal(gen2Attempt.statusTurnsByPokemon?.['ai-1'], 2,
  'Early Bird is single-decrement before gen 3');
const suppressedEarlyBird = {...earlyBirdSleep, sides: {...earlyBirdSleep.sides,
  ai: {...earlyBirdSleep.sides.ai, party: earlyBirdSleep.sides.ai.party.map(pokemon => ({
    ...pokemon, abilitySuppressed: true,
  }))},
}};
const suppressedAttempt = deriveMoveResolution(suppressedEarlyBird,
  enumerateMoveActions(suppressedEarlyBird)[0], {hit: true});
assert.equal(suppressedAttempt.statusTurnsByPokemon?.['ai-1'], 2,
  'a suppressed Early Bird decrements once');

const naturePowerState = state();
naturePowerState.sides.ai.party[0].moves = [{name: 'Nature Power'}];
const naturePowerAction = enumerateMoveActions(naturePowerState)[0];
assert.deepEqual(deriveMoveResolution(naturePowerState, naturePowerAction, {hit: true}).calledMoveByPokemon, {
  'ai-1': 'Tri Attack',
});
for (const [terrain, calledMove] of [['Electric', 'Thunderbolt'], ['Grassy', 'Energy Ball'],
  ['Misty', 'Moonblast'], ['Psychic', 'Psychic']] as const) {
  const terrainState = state();
  terrainState.field.terrain = terrain;
  terrainState.sides.ai.party[0].moves = [{name: 'Nature Power'}];
  assert.deepEqual(deriveMoveResolution(terrainState, enumerateMoveActions(terrainState)[0], {hit: true})
    .calledMoveByPokemon, {'ai-1': calledMove});
}
const terrainSeedMoveState = state();
terrainSeedMoveState.sides.ai.party[0].moves = [{name: 'Electric Terrain'}];
terrainSeedMoveState.sides.player.party[0].item = 'Electric Seed';
const terrainSeedMoveAction = enumerateMoveActions(terrainSeedMoveState, 'ai')
  .find(action => action.kind === 'move' && action.moveName === 'Electric Terrain');
assert.ok(terrainSeedMoveAction);
const terrainSeedMoveResolution = deriveMoveResolution(terrainSeedMoveState, terrainSeedMoveAction!, {hit: true});
assert.deepEqual(terrainSeedMoveResolution.boostsByPokemon?.['player-1'], {def: 1});
assert.equal(terrainSeedMoveResolution.itemByPokemon?.['player-1'], null);
assert.equal(terrainSeedMoveResolution.consumedItemByPokemon?.['player-1'], 'Electric Seed');
const terrainSeedEntry = state();
terrainSeedEntry.field.terrain = 'Electric';
terrainSeedEntry.sides.ai.party.push({
  id: 'ai-2', species: 'Bulbasaur', level: 100, hp: {current: 100, max: 100},
  moves: [{name: 'Tackle'}], item: 'Electric Seed',
});
const terrainSeedEntryAction = {kind: 'switch' as const, actorId: 'ai-1', replacementId: 'ai-2'};
const terrainSeedEntryResolution = deriveSwitchEntryResolution(terrainSeedEntry, terrainSeedEntryAction);
assert.deepEqual(terrainSeedEntryResolution.boostsByPokemon?.['ai-2'], {def: 1});
assert.equal(terrainSeedEntryResolution.itemByPokemon?.['ai-2'], null);
assert.equal(terrainSeedEntryResolution.consumedItemByPokemon?.['ai-2'], 'Electric Seed');
const terrainSeedEntered = applySwitchAction(terrainSeedEntry, terrainSeedEntryAction);
assert.equal(terrainSeedEntered.sides.ai.party[1].item, undefined);
assert.equal(terrainSeedEntered.sides.ai.party[1].boosts?.def, 1);
assert.equal(terrainSeedEntered.sides.ai.party[1].lastConsumedItem, 'Electric Seed');
const mimicryState = state();
const arceusPlateIdentity = state();
arceusPlateIdentity.sides.player.party[0].species = 'Arceus';
arceusPlateIdentity.sides.player.party[0].ability = 'Multitype';
arceusPlateIdentity.sides.player.party[0].item = 'Meadow Plate';
assert.deepEqual(getEffectiveTypes(arceusPlateIdentity, 'player-1'), ['Grass']);
const silvallyMemoryIdentity = {...arceusPlateIdentity, sides: {...arceusPlateIdentity.sides,
  player: {...arceusPlateIdentity.sides.player, party: arceusPlateIdentity.sides.player.party.map(pokemon => ({
    ...pokemon, species: 'Silvally', ability: 'RKS System', item: 'Dark Memory',
  }))},
}};
assert.deepEqual(getEffectiveTypes(silvallyMemoryIdentity, 'player-1'), ['Dark']);
const suppressedItemIdentity = {...arceusPlateIdentity, field: {magicRoom: true}};
assert.deepEqual(getEffectiveTypes(suppressedItemIdentity, 'player-1'), ['Normal']);
const suppressedAbilityIdentity = {...arceusPlateIdentity, sides: {...arceusPlateIdentity.sides,
  player: {...arceusPlateIdentity.sides.player, party: arceusPlateIdentity.sides.player.party.map(pokemon => ({
    ...pokemon, abilitySuppressed: true,
  }))},
}};
assert.deepEqual(getEffectiveTypes(suppressedAbilityIdentity, 'player-1'), ['Normal']);
mimicryState.sides.player.party[0].ability = 'Mimicry';
mimicryState.sides.ai.party[0].moves = [{name: 'Electric Terrain'}];
const mimicryAction = enumerateMoveActions(mimicryState, 'ai')
  .find(action => action.kind === 'move' && action.moveName === 'Electric Terrain');
assert.ok(mimicryAction);
const mimicryResolution = deriveMoveResolution(mimicryState, mimicryAction!, {hit: true});
assert.deepEqual(mimicryResolution.typeOverrideByPokemon?.['player-1'], ['Electric']);
const mimicryApplied = applyAction(mimicryState, mimicryAction!, mimicryResolution);
assert.deepEqual(mimicryApplied.sides.player.party[0].typeOverride, ['Electric']);
mimicryApplied.sides.ai.party[0].moves = [{name: 'Grassy Terrain'}];
const grassyAction = enumerateMoveActions(mimicryApplied, 'ai')
  .find(action => action.kind === 'move' && action.moveName === 'Grassy Terrain');
assert.ok(grassyAction);
const grassyResolution = deriveMoveResolution(mimicryApplied, grassyAction!, {hit: true});
assert.deepEqual(grassyResolution.typeOverrideByPokemon?.['player-1'], ['Grass']);
const grassyApplied = applyAction(mimicryApplied, grassyAction!, grassyResolution);
assert.deepEqual(grassyApplied.sides.player.party[0].typeOverride, ['Grass']);
const mimicryExpired = beginNextTurn({...grassyApplied, field: {
  ...grassyApplied.field, durations: {terrain: 1},
}});
assert.equal(mimicryExpired.field.terrain, undefined);
assert.equal(mimicryExpired.sides.player.party[0].typeOverride, undefined);
const mimicryEntry = state();
mimicryEntry.field.terrain = 'Psychic';
mimicryEntry.sides.ai.party.push({
  id: 'ai-2', species: 'Pikachu', level: 100,
  hp: {current: 100, max: 100}, moves: [], ability: 'Mimicry',
});
const mimicryEntryAction = {kind: 'switch' as const, actorId: 'ai-1', replacementId: 'ai-2'};
const mimicryEntryResolution = deriveSwitchEntryResolution(mimicryEntry, mimicryEntryAction);
assert.deepEqual(mimicryEntryResolution.typeOverrideByPokemon?.['ai-2'], ['Psychic']);
const mimicryEntered = applySwitchAction(mimicryEntry, mimicryEntryAction);
assert.deepEqual(mimicryEntered.sides.ai.party[1].typeOverride, ['Psychic']);
assert.equal(deriveMoveResolution({...mimicryState, generation: 7 as const}, mimicryAction!, {hit: true})
  .typeOverrideByPokemon, undefined);
const mimicrySuppressed = {...mimicryState, sides: {...mimicryState.sides,
  player: {...mimicryState.sides.player, party: mimicryState.sides.player.party.map(pokemon => ({
    ...pokemon, abilitySuppressed: true,
  }))},
}};
assert.equal(deriveMoveResolution(mimicrySuppressed, mimicryAction!, {hit: true})
  .typeOverrideByPokemon, undefined);
const screenCleanerEntry = state();
screenCleanerEntry.sides.ai.effects = {reflect: true, lightScreen: true};
screenCleanerEntry.sides.player.effects = {auroraVeil: true, tailwind: true};
screenCleanerEntry.sides.ai.party.push({
  id: 'ai-2', species: 'Pikachu', level: 100,
  hp: {current: 100, max: 100}, moves: [], ability: 'Screen Cleaner',
});
const screenCleanerAction = {kind: 'switch' as const, actorId: 'ai-1', replacementId: 'ai-2'};
const screenCleanerResolution = deriveSwitchEntryResolution(screenCleanerEntry, screenCleanerAction);
assert.deepEqual(screenCleanerResolution.sideEffectsBySide, {
  ai: {reflect: false, lightScreen: false},
  player: {auroraVeil: false},
});
const screenCleanerApplied = applySwitchAction(screenCleanerEntry, screenCleanerAction);
assert.equal(screenCleanerApplied.sides.ai.effects?.reflect, false);
assert.equal(screenCleanerApplied.sides.ai.effects?.lightScreen, false);
assert.equal(screenCleanerApplied.sides.player.effects?.auroraVeil, false);
assert.equal(screenCleanerApplied.sides.player.effects?.tailwind, true);
assert.equal(deriveSwitchEntryResolution({...screenCleanerEntry, generation: 7 as const}, screenCleanerAction)
  .sideEffectsBySide, undefined);
const screenCleanerSuppressed = {...screenCleanerEntry, sides: {...screenCleanerEntry.sides,
  ai: {...screenCleanerEntry.sides.ai, party: screenCleanerEntry.sides.ai.party.map(pokemon => ({
    ...pokemon, abilitySuppressed: pokemon.id === 'ai-2' ? true : pokemon.abilitySuppressed,
  }))},
}};
assert.equal(deriveSwitchEntryResolution(screenCleanerSuppressed, screenCleanerAction)
  .sideEffectsBySide, undefined);
const entryBoostAbilities = state();
entryBoostAbilities.sides.ai.party.push({
  id: 'ai-2', species: 'Pikachu', level: 100,
  hp: {current: 100, max: 100}, moves: [], ability: 'Intrepid Sword',
});
const intrepidAction = {kind: 'switch' as const, actorId: 'ai-1', replacementId: 'ai-2'};
const intrepidResolution = deriveSwitchEntryResolution(entryBoostAbilities, intrepidAction);
assert.equal(intrepidResolution.boostsByPokemon?.['ai-2']?.atk, 1);
assert.equal(intrepidResolution.intrepidSwordTriggeredByPokemon?.['ai-2'], true);
const intrepidEntered = applySwitchAction(entryBoostAbilities, intrepidAction);
assert.equal(intrepidEntered.sides.ai.party[1].boosts?.atk, 1);
assert.equal(intrepidEntered.sides.ai.party[1].intrepidSwordTriggered, true);
const intrepidSwitchedOut = applySwitchAction(intrepidEntered, {
  kind: 'switch', actorId: 'ai-2', replacementId: 'ai-1',
});
const intrepidSwitchedBackResolution = deriveSwitchEntryResolution(intrepidSwitchedOut, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2',
});
assert.equal(intrepidSwitchedBackResolution.boostsByPokemon, undefined);
const dauntlessEntry = {...entryBoostAbilities, sides: {...entryBoostAbilities.sides,
  ai: {...entryBoostAbilities.sides.ai, party: entryBoostAbilities.sides.ai.party.map(pokemon =>
    pokemon.id === 'ai-2' ? {...pokemon, ability: 'Dauntless Shield'} : pokemon)},
}};
const dauntlessResolution = deriveSwitchEntryResolution(dauntlessEntry, intrepidAction);
assert.equal(dauntlessResolution.boostsByPokemon?.['ai-2']?.def, 1);
assert.equal(dauntlessResolution.dauntlessShieldTriggeredByPokemon?.['ai-2'], true);
assert.equal(deriveSwitchEntryResolution({...entryBoostAbilities, generation: 7 as const}, intrepidAction)
  .boostsByPokemon, undefined);
const entryBoostSuppressed = {...entryBoostAbilities, sides: {...entryBoostAbilities.sides,
  ai: {...entryBoostAbilities.sides.ai, party: entryBoostAbilities.sides.ai.party.map(pokemon =>
    pokemon.id === 'ai-2' ? {...pokemon, abilitySuppressed: true} : pokemon)},
}};
assert.equal(deriveSwitchEntryResolution(entryBoostSuppressed, intrepidAction).boostsByPokemon, undefined);
const naturePowerGen3 = state();
naturePowerGen3.generation = 3;
naturePowerGen3.sides.ai.party[0].moves = [{name: 'Nature Power'}];
assert.deepEqual(deriveMoveResolution(naturePowerGen3, enumerateMoveActions(naturePowerGen3)[0], {hit: true})
  .calledMoveByPokemon, {'ai-1': 'Swift'});

const assistState = state();
assistState.generation = 7;
assistState.sides.ai.party[0].moves = [{name: 'Assist'}];
addReplacement(assistState, 'ai', {
  id: 'ai-2', species: 'Bulbasaur', level: 100, hp: {current: 0, max: 100},
  moves: [{name: 'Tackle', pp: 0}],
});
const assistAction = enumerateMoveActions(assistState)[0];
assert.deepEqual(assistAction.targetIds, ['ai-1']);
assert.deepEqual(deriveMoveResolution(assistState, assistAction, {hit: true, random: () => 0})
  .calledMoveByPokemon, {'ai-1': 'Tackle'});

const assistGen3 = state();
assistGen3.generation = 3;
assistGen3.sides.ai.party[0].moves = [{name: 'Assist'}];
addReplacement(assistGen3, 'ai', {
  id: 'ai-2', species: 'Bulbasaur', level: 100, hp: {current: 0, max: 100},
  moves: [{name: 'Mimic'}], originalMoves: [{name: 'Thunderbolt'}],
});
assert.deepEqual(deriveMoveResolution(assistGen3, enumerateMoveActions(assistGen3)[0], {
  hit: true, random: () => 0,
}).calledMoveByPokemon, {'ai-1': 'Thunderbolt'});

const assistGen8 = state();
assistGen8.sides.ai.party[0].moves = [{name: 'Assist'}];
assert.equal(deriveMoveResolution(assistGen8, {
  kind: 'move', actorId: 'ai-1', moveName: 'Assist', targetIds: ['ai-1'],
}, {hit: true}).hit, false);

const assistFutureMove = state();
assistFutureMove.generation = 5;
assistFutureMove.sides.ai.party[0].moves = [{name: 'Assist'}];
addReplacement(assistFutureMove, 'ai', {
  id: 'ai-2', species: 'Bulbasaur', level: 100, hp: {current: 0, max: 100},
  moves: [{name: 'Dazzling Gleam'}],
});
assert.equal(deriveMoveResolution(assistFutureMove, {
  kind: 'move', actorId: 'ai-1', moveName: 'Assist', targetIds: ['ai-1'],
}, {hit: true}).hit, false);

const sleepTalkFutureMove = state();
sleepTalkFutureMove.generation = 5;
sleepTalkFutureMove.sides.ai.party[0].status = 'slp';
sleepTalkFutureMove.sides.ai.party[0].statusTurns = 2;
sleepTalkFutureMove.sides.ai.party[0].moves = [{name: 'Sleep Talk'}, {name: 'Dazzling Gleam'}];
assert.equal(deriveMoveResolution(sleepTalkFutureMove, {
  kind: 'move', actorId: 'ai-1', moveName: 'Sleep Talk', targetIds: ['ai-1'],
}, {hit: true}).hit, false);

const meFirstState = state();
meFirstState.generation = 7;
meFirstState.sides.ai.party[0].moves = [{name: 'Me First'}];
meFirstState.selectedMoveByPokemon = {'player-1': {moveName: 'Thunderbolt'}};
const meFirstAction = enumerateMoveActions(meFirstState)[0];
const meFirstResolution = deriveMoveResolution(meFirstState, meFirstAction, {hit: true});
assert.deepEqual(meFirstResolution.calledMoveByPokemon, {'ai-1': 'Thunderbolt'});
assert.deepEqual(meFirstResolution.calledMoveModifiersByPokemon, {
  'ai-1': {powerMultiplier: 1.5, bypassAccuracy: true},
});
const meFirstApplied = applyAction(meFirstState, meFirstAction, meFirstResolution);
assert.deepEqual(meFirstApplied.selectedMoveByPokemon, {'player-1': {moveName: 'Thunderbolt'}});

const meFirstNoIntent = state();
meFirstNoIntent.generation = 7;
meFirstNoIntent.sides.ai.party[0].moves = [{name: 'Me First'}];
assert.equal(deriveMoveResolution(meFirstNoIntent, {
  kind: 'move', actorId: 'ai-1', moveName: 'Me First', targetIds: ['player-1'],
}, {hit: true}).hit, false);

const instructState = state();
instructState.generation = 7;
instructState.mode = 'Doubles';
instructState.sides.ai.activeIds = ['ai-1', 'ai-2'];
addReplacement(instructState, 'ai', {
  id: 'ai-2', species: 'Charizard', level: 100, hp: {current: 100, max: 100},
  moves: [{name: 'Thunderbolt', pp: 10, maxPP: 15}],
});
instructState.sides.ai.party[0].moves = [{name: 'Instruct'}];
instructState.lastMoveUsedByPokemon = {'ai-2': 'Thunderbolt'};
instructState.lastMoveTargetIdsByPokemon = {'ai-2': ['player-1']};
const instructAction = enumerateMoveActions(instructState).find(action =>
  action.kind === 'move' && action.moveName === 'Instruct' && action.targetIds[0] === 'ai-2');
assert.ok(instructAction);
const instructResolution = deriveMoveResolution(instructState, instructAction!, {hit: true});
assert.deepEqual(instructResolution.calledMoveByPokemon, {'ai-2': 'Thunderbolt'});
assert.deepEqual(instructResolution.calledMoveTargetIdsByPokemon, {'ai-2': ['player-1']});

const supportScoreState = state();
supportScoreState.mode = 'Doubles';
supportScoreState.sides.ai.activeIds = ['ai-1', 'ai-2'];
addReplacement(supportScoreState, 'ai', {
  id: 'ai-2', species: 'Charizard', level: 100, hp: {current: 100, max: 100},
  moves: [{name: 'Tailwind'}],
});
supportScoreState.sides.ai.party[0].moves = [{name: 'Helping Hand'}];
supportScoreState.selectedMoveByPokemon = {'ai-2': {moveName: 'Tailwind'}};
const supportAction = enumerateMoveActions(supportScoreState).find(action =>
  action.kind === 'move' && action.moveName === 'Helping Hand');
assert.ok(supportAction);
const supportEvaluation = scoreStatusAction(supportScoreState, {
  action: supportAction!, facts: {}, outcomes: [], reasons: [],
});
assert.deepEqual(supportEvaluation.outcomes, [{score: -20, probability: 1}]);

const supportNoPartnerState = state();
supportNoPartnerState.sides.ai.party[0].moves = [{name: 'Follow Me'}];
const followMeSingle = enumerateMoveActions(supportNoPartnerState).find(action =>
  action.kind === 'move' && action.moveName === 'Follow Me');
assert.ok(followMeSingle);
assert.deepEqual(scoreStatusAction(supportNoPartnerState, {
  action: followMeSingle!, facts: {}, outcomes: [], reasons: [],
}).outcomes, [{score: -20, probability: 1}]);
assert.equal(deriveMoveResolution(
  supportNoPartnerState, followMeSingle!, {hit: true},
).hit, false);

const supportFaintedPartnerState = state();
supportFaintedPartnerState.mode = 'Doubles';
supportFaintedPartnerState.sides.ai.activeIds = ['ai-1', 'ai-2'];
supportFaintedPartnerState.sides.ai.party[0].moves = [{name: 'Follow Me'}];
addReplacement(supportFaintedPartnerState, 'ai', {
  id: 'ai-2', species: 'Bulbasaur', level: 100, hp: {current: 0, max: 100}, moves: [],
});
const followMeFaintedPartner = enumerateMoveActions(supportFaintedPartnerState).find(action =>
  action.kind === 'move' && action.moveName === 'Follow Me');
assert.ok(followMeFaintedPartner);
assert.deepEqual(scoreStatusAction(supportFaintedPartnerState, {
  action: followMeFaintedPartner!, facts: {}, outcomes: [], reasons: [],
}).outcomes, [{score: -20, probability: 1}]);

const followMeState = state();
followMeState.mode = 'Doubles';
followMeState.sides.ai.activeIds = ['ai-1', 'ai-2'];
followMeState.sides.player.activeIds = ['player-1', 'player-2'];
addReplacement(followMeState, 'ai', {
  id: 'ai-2', species: 'Charizard', level: 100, hp: {current: 100, max: 100}, moves: [],
});
addReplacement(followMeState, 'player', {
  id: 'player-2', species: 'Bulbasaur', level: 100, hp: {current: 100, max: 100}, moves: [],
});
followMeState.sides.ai.party[0].moves = [{name: 'Tackle'}];
followMeState.sides.player.party[0].volatile = {followMe: {turns: 1}};
const redirectedTackle = enumerateMoveActions(followMeState, 'ai').filter(action =>
  action.kind === 'move' && action.actorId === 'ai-1' && action.moveName === 'Tackle');
assert.deepEqual(redirectedTackle.map(action => action.targetIds), [['player-1']]);

const spreadAroundFollowMe = {...followMeState, sides: {
  ...followMeState.sides,
  ai: {...followMeState.sides.ai, party: followMeState.sides.ai.party.map(pokemon =>
    pokemon.id === 'ai-1' ? {...pokemon, moves: [{name: 'Rock Slide'}]} : pokemon)},
}};
const spreadAction = enumerateMoveActions(spreadAroundFollowMe, 'ai').find(action =>
  action.kind === 'move' && action.actorId === 'ai-1' && action.moveName === 'Rock Slide');
assert.deepEqual(spreadAction?.targetIds, ['player-1', 'player-2']);

const spreadLockOnState = doublesState();
spreadLockOnState.sides.ai.party[0].moves = [{name: 'Lock-On'}, {name: 'Blizzard'}];
const spreadLockOnAction: MoveAction = {kind: 'move', actorId: 'ai-1', moveName: 'Lock-On', targetIds: ['player-2']};
const lockOnApplied = applyAction(
  spreadLockOnState,
  spreadLockOnAction,
  deriveMoveResolution(spreadLockOnState, spreadLockOnAction, {hit: true}),
);
const lockedSpreadAction: MoveAction = {
  kind: 'move', actorId: 'ai-1', moveName: 'Blizzard', targetIds: ['player-1', 'player-2'],
};
const lockedSpreadResolution = deriveMoveResolution(lockOnApplied, lockedSpreadAction, {
  random: () => 0.95,
});
assert.ok(lockedSpreadResolution.trace?.notes?.some(note => note.includes('player-1')));
assert.equal(lockedSpreadResolution.trace?.notes?.some(note => note.includes('player-2')), false);
assert.deepEqual(lockedSpreadResolution.trace?.accuracyThresholdsByTarget, {
  'player-1': 0.8,
  'player-2': 1,
});

const followMeResolutionState = state();
followMeResolutionState.mode = 'Doubles';
followMeResolutionState.sides.ai.activeIds = ['ai-1', 'ai-2'];
followMeResolutionState.sides.player.activeIds = ['player-1', 'player-2'];
addReplacement(followMeResolutionState, 'ai', {
  id: 'ai-2', species: 'Charizard', level: 100, hp: {current: 100, max: 100}, moves: [],
});
addReplacement(followMeResolutionState, 'player', {
  id: 'player-2', species: 'Bulbasaur', level: 100, hp: {current: 100, max: 100}, moves: [],
});
followMeResolutionState.sides.ai.party[0].moves = [{name: 'Follow Me'}];
const followMeAction = enumerateMoveActions(followMeResolutionState, 'ai').find(action =>
  action.kind === 'move' && action.moveName === 'Follow Me');
assert.ok(followMeAction);
const followMeApplied = applyAction(
  followMeResolutionState, followMeAction!, deriveMoveResolution(followMeResolutionState, followMeAction!, {hit: true}),
);
assert.equal(followMeApplied.sides.ai.party[0].volatile?.followMe?.turns, 1);
const redirectedByFollowMe = enumerateMoveActions(followMeApplied, 'player').find(action =>
  action.kind === 'move' && action.actorId === 'player-1' && action.moveName === 'Tackle');
assert.deepEqual(redirectedByFollowMe?.targetIds, ['ai-1']);
assert.equal(beginNextTurn(followMeApplied).sides.ai.party[0].volatile, undefined);

const ragePowderState = {...followMeResolutionState};
ragePowderState.generation = 8;
ragePowderState.sides.ai.party[0].moves = [{name: 'Rage Powder'}];
ragePowderState.sides.player.party[0].volatile = undefined;
const ragePowderAction = enumerateMoveActions(ragePowderState, 'ai').find(action =>
  action.kind === 'move' && action.moveName === 'Rage Powder');
assert.ok(ragePowderAction);
const ragePowderApplied = applyAction(
  ragePowderState, ragePowderAction!, deriveMoveResolution(ragePowderState, ragePowderAction!, {hit: true}),
);
assert.equal(ragePowderApplied.sides.ai.party[0].volatile?.ragePowder?.turns, 1);
const redirectedByRagePowder = enumerateMoveActions(ragePowderApplied, 'player').find(action =>
  action.kind === 'move' && action.actorId === 'player-1' && action.moveName === 'Tackle');
assert.deepEqual(redirectedByRagePowder?.targetIds, ['ai-1']);

const spotlightState = doublesState();
spotlightState.sides.ai.party[0].moves = [{name: 'Spotlight'}];
const spotlightAction = enumerateMoveActions(spotlightState, 'ai').find(action =>
  action.kind === 'move' && action.moveName === 'Spotlight' && action.targetIds[0] === 'ai-2');
assert.ok(spotlightAction);
const spotlightApplied = applyAction(
  spotlightState, spotlightAction!, deriveMoveResolution(spotlightState, spotlightAction!, {hit: true}),
);
assert.equal(spotlightApplied.sides.ai.party[1].volatile?.spotlight?.turns, 1);
const redirectedBySpotlight = enumerateMoveActions(spotlightApplied, 'player').find(action =>
  action.kind === 'move' && action.actorId === 'player-1' && action.moveName === 'Tackle');
assert.deepEqual(redirectedBySpotlight?.targetIds, ['ai-2']);
const spreadAroundSpotlight = {...spotlightApplied, sides: {
  ...spotlightApplied.sides,
  player: {...spotlightApplied.sides.player, party: spotlightApplied.sides.player.party.map(pokemon =>
    pokemon.id === 'player-1' ? {...pokemon, moves: [{name: 'Rock Slide'}]} : pokemon)},
}};
const spotlightSpread = enumerateMoveActions(spreadAroundSpotlight, 'player').find(action =>
  action.kind === 'move' && action.actorId === 'player-1' && action.moveName === 'Rock Slide');
assert.deepEqual(spotlightSpread?.targetIds, ['ai-1', 'ai-2']);
const spotlightIgnored = {...spotlightApplied, sides: {
  ...spotlightApplied.sides,
  player: {...spotlightApplied.sides.player, party: spotlightApplied.sides.player.party.map(pokemon =>
    pokemon.id === 'player-1' ? {...pokemon, moves: [{name: 'Snipe Shot'}]} : pokemon)},
}};
const spotlightIgnoreActions = enumerateMoveActions(spotlightIgnored, 'player').filter(action =>
  action.kind === 'move' && action.actorId === 'player-1' && action.moveName === 'Snipe Shot');
assert.deepEqual(spotlightIgnoreActions.map(action => action.targetIds), [['ai-1'], ['ai-2']]);
assert.equal(beginNextTurn(spotlightApplied).sides.ai.party[1].volatile, undefined);
const spotlightOldGeneration = doublesState();
spotlightOldGeneration.generation = 6;
spotlightOldGeneration.sides.ai.party[0].moves = [{name: 'Spotlight'}];
assert.equal(enumerateMoveActions(spotlightOldGeneration).some(action => action.moveName === 'Spotlight'), false);
assert.equal(deriveMoveResolution(spotlightOldGeneration, {
  kind: 'move', actorId: 'ai-1', moveName: 'Spotlight', targetIds: ['ai-2'],
}, {hit: true}).hit, false);

const magicCoatState = state();
magicCoatState.sides.ai.party[0].moves = [{name: 'Magic Coat'}];
magicCoatState.sides.player.party[0].moves = [{name: 'Toxic'}];
const magicCoatAction = enumerateMoveActions(magicCoatState, 'ai').find(action => action.moveName === 'Magic Coat');
assert.ok(magicCoatAction);
const magicCoatApplied = applyAction(
  magicCoatState, magicCoatAction!, deriveMoveResolution(magicCoatState, magicCoatAction!, {hit: true}),
);
assert.equal(magicCoatApplied.sides.ai.party[0].volatile?.magicCoat?.turns, 1);
const reflectedToxicAction: MoveAction = {
  kind: 'move', actorId: 'player-1', moveName: 'Toxic', targetIds: ['ai-1'],
};
const reflectedToxic = deriveMoveResolution(magicCoatApplied, reflectedToxicAction, {hit: true});
assert.deepEqual(reflectedToxic.statusByPokemon, {'player-1': 'tox'});
assert.equal(reflectedToxic.volatileByPokemon?.['ai-1']?.magicCoat, null);
assert.ok(reflectedToxic.trace?.notes?.some(note => note.includes('Magic Coat reflected Toxic')));
const reflectedToxicApplied = applyAction(magicCoatApplied, reflectedToxicAction, reflectedToxic);
assert.equal(reflectedToxicApplied.sides.player.party[0].status, 'tox');
assert.equal(reflectedToxicApplied.sides.ai.party[0].status, undefined);
assert.equal(reflectedToxicApplied.sides.ai.party[0].volatile, undefined);

const coatDamageState = state();
coatDamageState.sides.ai.party[0].moves = [{name: 'Magic Coat'}];
const coatDamageApplied = applyAction(
  coatDamageState, enumerateMoveActions(coatDamageState)[0],
  deriveMoveResolution(coatDamageState, enumerateMoveActions(coatDamageState)[0], {hit: true}),
);
const coatDamageResolution = deriveMoveResolution(coatDamageApplied, {
  kind: 'move', actorId: 'player-1', moveName: 'Tackle', targetIds: ['ai-1'],
}, {hit: true, facts: {moveCategory: 'Physical'}});
assert.equal(coatDamageResolution.volatileByPokemon?.['ai-1']?.magicCoat, undefined);
assert.equal(coatDamageResolution.trace?.notes?.some(note => note.includes('Magic Coat reflected')), false);
assert.equal(coatDamageApplied.sides.ai.party[0].volatile?.magicCoat?.turns, 1);

const magicBounceState = state();
magicBounceState.sides.ai.party[0].moves = [{name: 'Toxic'}];
magicBounceState.sides.player.party[0].ability = 'Magic Bounce';
const magicBounceToxicAction = move(magicBounceState, 'Toxic');
const magicBounceToxic = deriveMoveResolution(magicBounceState, magicBounceToxicAction, {hit: true});
assert.deepEqual(magicBounceToxic.statusByPokemon, {'ai-1': 'tox'});
assert.equal(magicBounceToxic.statusByPokemon?.['player-1'], undefined);
assert.ok(magicBounceToxic.trace?.notes?.some(note => note.includes('Magic Bounce reflected Toxic')));
const magicBounceGoodAsGold = {...magicBounceState, sides: {...magicBounceState.sides,
  ai: {...magicBounceState.sides.ai, party: magicBounceState.sides.ai.party.map(pokemon => ({
    ...pokemon, ability: 'Good as Gold',
  }))},
}};
assert.equal(deriveMoveResolution(magicBounceGoodAsGold, move(magicBounceGoodAsGold, 'Toxic'), {hit: true})
  .statusByPokemon, undefined);

const magicBounceHazardState = state();
magicBounceHazardState.sides.ai.party[0].moves = [{name: 'Stealth Rock'}];
magicBounceHazardState.sides.player.party[0].ability = 'Magic Bounce';
const magicBounceHazard = deriveMoveResolution(
  magicBounceHazardState, move(magicBounceHazardState, 'Stealth Rock'), {hit: true},
);
assert.equal(magicBounceHazard.sideEffectsBySide?.ai?.stealthRock, true);
assert.equal(magicBounceHazard.sideEffectsBySide?.player, undefined);

const magicBounceSuppressed = {...magicBounceState, sides: {...magicBounceState.sides,
  player: {...magicBounceState.sides.player, party: magicBounceState.sides.player.party.map(pokemon => ({
    ...pokemon, abilitySuppressed: true,
  }))},
}};
const magicBounceSuppressedResolution = deriveMoveResolution(
  magicBounceSuppressed, move(magicBounceSuppressed, 'Toxic'), {hit: true},
);
assert.deepEqual(magicBounceSuppressedResolution.statusByPokemon, {'player-1': 'tox'});
const magicBounceMoldBreaker = {...magicBounceState, sides: {...magicBounceState.sides,
  ai: {...magicBounceState.sides.ai, party: magicBounceState.sides.ai.party.map(pokemon => ({
    ...pokemon, ability: 'Mold Breaker',
  }))},
}};
assert.deepEqual(deriveMoveResolution(magicBounceMoldBreaker, move(magicBounceMoldBreaker, 'Toxic'), {hit: true})
  .statusByPokemon, {'player-1': 'tox'});

const magicCoatOldGeneration = state();
magicCoatOldGeneration.generation = 3;
magicCoatOldGeneration.sides.ai.party[0].moves = [{name: 'Magic Coat'}];
assert.equal(enumerateMoveActions(magicCoatOldGeneration).some(action => action.moveName === 'Magic Coat'), false);
assert.equal(deriveMoveResolution(magicCoatOldGeneration, {
  kind: 'move', actorId: 'ai-1', moveName: 'Magic Coat', targetIds: ['ai-1'],
}, {hit: true}).hit, false);

const snatchState = state();
snatchState.generation = 7;
snatchState.sides.ai.party[0].moves = [{name: 'Snatch'}];
snatchState.sides.player.party[0].moves = [{name: 'Swords Dance'}];
const snatchAction = enumerateMoveActions(snatchState).find(action => action.moveName === 'Snatch');
assert.ok(snatchAction);
const snatchApplied = applyAction(
  snatchState, snatchAction!, deriveMoveResolution(snatchState, snatchAction!, {hit: true}),
);
assert.equal(snatchApplied.sides.ai.party[0].volatile?.snatch?.turns, 1);
assert.equal(beginNextTurn(snatchApplied).sides.ai.party[0].volatile?.snatch, undefined);
const stolenSwordsDance: MoveAction = {
  kind: 'move', actorId: 'player-1', moveName: 'Swords Dance', targetIds: ['player-1'],
};
const stolenSwordsDanceResolution = deriveMoveResolution(snatchApplied, stolenSwordsDance, {hit: true});
assert.deepEqual(stolenSwordsDanceResolution.boostsByPokemon?.['ai-1'], {atk: 2});
assert.equal(stolenSwordsDanceResolution.boostsByPokemon?.['player-1'], undefined);
assert.equal(stolenSwordsDanceResolution.volatileByPokemon?.['ai-1']?.snatch, null);
assert.ok(stolenSwordsDanceResolution.trace?.notes?.some(note => note.includes('Snatch stole Swords Dance')));
const stolenSwordsDanceApplied = applyAction(snatchApplied, stolenSwordsDance, stolenSwordsDanceResolution);
assert.equal(stolenSwordsDanceApplied.sides.ai.party[0].boosts?.atk, 2);
assert.equal(stolenSwordsDanceApplied.sides.player.party[0].boosts?.atk, undefined);
assert.equal(stolenSwordsDanceApplied.sides.ai.party[0].volatile?.snatch, undefined);

const snatchStatusState = state();
snatchStatusState.generation = 7;
snatchStatusState.sides.ai.party[0].moves = [{name: 'Snatch'}];
snatchStatusState.sides.player.party[0].moves = [{name: 'Toxic'}];
const snatchStatusAction = enumerateMoveActions(snatchStatusState)[0];
const snatchStatusApplied = applyAction(
  snatchStatusState, snatchStatusAction,
  deriveMoveResolution(snatchStatusState, snatchStatusAction, {hit: true}),
);
const unstealableToxic = deriveMoveResolution(snatchStatusApplied, {
  kind: 'move', actorId: 'player-1', moveName: 'Toxic', targetIds: ['ai-1'],
}, {hit: true});
assert.equal(unstealableToxic.statusByPokemon?.['ai-1'], 'tox');
assert.equal(unstealableToxic.statusByPokemon?.['player-1'], undefined);
assert.equal(unstealableToxic.volatileByPokemon?.['ai-1']?.snatch, undefined);

const snatchSideState = doublesState();
snatchSideState.generation = 7;
snatchSideState.sides.ai.party[0].moves = [{name: 'Snatch'}];
snatchSideState.sides.player.party[0].moves = [{name: 'Tailwind'}];
const snatchSideAction = enumerateMoveActions(snatchSideState).find(action => action.moveName === 'Snatch');
assert.ok(snatchSideAction);
const snatchSideApplied = applyAction(
  snatchSideState, snatchSideAction!, deriveMoveResolution(snatchSideState, snatchSideAction!, {hit: true}),
);
const stolenTailwind: MoveAction = {
  kind: 'move', actorId: 'player-1', moveName: 'Tailwind', targetIds: [],
};
const stolenTailwindResolution = deriveMoveResolution(snatchSideApplied, stolenTailwind, {hit: true});
assert.equal(stolenTailwindResolution.sideEffectsBySide?.ai?.tailwind, true);
assert.equal(stolenTailwindResolution.sideEffectsBySide?.player?.tailwind, undefined);
assert.equal(stolenTailwindResolution.volatileByPokemon?.['ai-1']?.snatch, null);
applyAction(snatchSideApplied, stolenTailwind, stolenTailwindResolution);

const chainedSnatchState = doublesState();
chainedSnatchState.generation = 3;
chainedSnatchState.sides.ai.party[0].moves = [{name: 'Snatch'}];
chainedSnatchState.sides.ai.party[1].moves = [{name: 'Snatch'}];
chainedSnatchState.sides.player.party[0].moves = [{name: 'Swords Dance'}];
const firstSnatch = enumerateMoveActions(chainedSnatchState).find(action => action.actorId === 'ai-1');
const firstSnatchState = applyAction(
  chainedSnatchState, firstSnatch!, deriveMoveResolution(chainedSnatchState, firstSnatch!, {hit: true}),
);
const secondSnatch = enumerateMoveActions(firstSnatchState).find(action => action.actorId === 'ai-2');
const bothSnatchState = applyAction(
  firstSnatchState, secondSnatch!, deriveMoveResolution(firstSnatchState, secondSnatch!, {hit: true}),
);
const chainedSwordsDance: MoveAction = {
  kind: 'move', actorId: 'player-1', moveName: 'Swords Dance', targetIds: ['player-1'],
};
const chainedSwordsDanceResolution = deriveMoveResolution(bothSnatchState, chainedSwordsDance, {hit: true});
assert.deepEqual(chainedSwordsDanceResolution.boostsByPokemon?.['ai-2'], {atk: 2});
assert.equal(chainedSwordsDanceResolution.boostsByPokemon?.['ai-1'], undefined);
assert.equal(chainedSwordsDanceResolution.volatileByPokemon?.['ai-1']?.snatch, null);
assert.equal(chainedSwordsDanceResolution.volatileByPokemon?.['ai-2']?.snatch, null);

const snatchUnavailableState = state();
snatchUnavailableState.generation = 8;
snatchUnavailableState.sides.ai.party[0].moves = [{name: 'Snatch'}];
assert.equal(enumerateMoveActions(snatchUnavailableState).some(action => action.moveName === 'Snatch'), false);
assert.equal(deriveMoveResolution(snatchUnavailableState, {
  kind: 'move', actorId: 'ai-1', moveName: 'Snatch', targetIds: ['ai-1'],
}, {hit: true}).hit, false);

const counterState = state();
counterState.sides.ai.party[0].moves = [{name: 'Counter'}];
const physicalHit: MoveAction = {
  kind: 'move', actorId: 'player-1', moveName: 'Tackle', targetIds: ['ai-1'],
};
const afterPhysicalHit = applyDamageAction(counterState, physicalHit, {'ai-1': 12});
assert.deepEqual(afterPhysicalHit.lastDamageTakenByPokemon?.['ai-1'], {
  damage: 12, category: 'Physical', sourceId: 'player-1', moveName: 'Tackle', turn: 1,
});
const counterAction = move(afterPhysicalHit, 'Counter');
const counterResolution = deriveMoveResolution(afterPhysicalHit, counterAction, {hit: true});
assert.deepEqual(counterResolution.damageByTarget, {'player-1': 24});
const counterApplied = applyAction(afterPhysicalHit, counterAction, counterResolution);
assert.equal(counterApplied.sides.player.party[0].hp.current, 76);

const mirrorCoatState = state();
mirrorCoatState.sides.ai.party[0].moves = [{name: 'Mirror Coat'}];
const specialHit: MoveAction = {
  kind: 'move', actorId: 'player-1', moveName: 'Thunderbolt', targetIds: ['ai-1'],
};
const afterSpecialHit = applyDamageAction(mirrorCoatState, specialHit, {'ai-1': 13});
const mirrorCoatResolution = deriveMoveResolution(afterSpecialHit, move(afterSpecialHit, 'Mirror Coat'), {hit: true});
assert.deepEqual(mirrorCoatResolution.damageByTarget, {'player-1': 26});

const metalBurstState = state();
metalBurstState.generation = 4;
metalBurstState.sides.ai.party[0].moves = [{name: 'Metal Burst'}];
const afterMetalHit = applyDamageAction(metalBurstState, physicalHit, {'ai-1': 11});
const metalBurstResolution = deriveMoveResolution(afterMetalHit, move(afterMetalHit, 'Metal Burst'), {hit: true});
assert.deepEqual(metalBurstResolution.damageByTarget, {'player-1': 16});

const mismatchedCounter = deriveMoveResolution(afterSpecialHit, {
  kind: 'move', actorId: 'ai-1', moveName: 'Counter', targetIds: ['player-1'],
}, {hit: true});
assert.equal(mismatchedCounter.hit, false);
assert.ok(mismatchedCounter.trace?.notes?.some(note => note.includes('no compatible damage')));

const protectedHistoryState = state();
protectedHistoryState.sides.ai.party[0].moves = [{name: 'Counter'}];
protectedHistoryState.sides.ai.party[0].substituteHp = 20;
const substituteHit = applyDamageAction(protectedHistoryState, physicalHit, {'ai-1': 12});
assert.equal(substituteHit.lastDamageTakenByPokemon, undefined);
assert.equal(deriveMoveResolution(substituteHit, move(substituteHit, 'Counter'), {hit: true}).hit, false);
const nextTurnWithHistory = beginNextTurn(afterPhysicalHit);
assert.equal(deriveMoveResolution(nextTurnWithHistory, move(nextTurnWithHistory, 'Counter'), {hit: true}).damageByTarget?.['player-1'], 24);
const expiredHistory = beginNextTurn(nextTurnWithHistory);
assert.equal(expiredHistory.lastDamageTakenByPokemon, undefined);
assert.equal(deriveMoveResolution(expiredHistory, move(expiredHistory, 'Counter'), {hit: true}).hit, false);

const focusPunchState = state();
focusPunchState.sides.ai.party[0].moves = [{name: 'Focus Punch'}];
const focusPunchResolution = deriveMoveResolution(
  focusPunchState, move(focusPunchState, 'Focus Punch'), {hit: true},
);
assert.equal(focusPunchResolution.hit, true);
const interruptedFocusPunch = applyDamageAction(focusPunchState, physicalHit, {'ai-1': 12});
const interruptedFocusPunchResolution = deriveMoveResolution(
  interruptedFocusPunch, move(interruptedFocusPunch, 'Focus Punch'), {hit: true},
);
assert.equal(interruptedFocusPunchResolution.hit, false);
assert.ok(interruptedFocusPunchResolution.trace?.notes?.some(note => note.includes('hit earlier this turn')));
const nextTurnFocusPunch = beginNextTurn(interruptedFocusPunch);
assert.equal(deriveMoveResolution(
  nextTurnFocusPunch, move(nextTurnFocusPunch, 'Focus Punch'), {hit: true},
).hit, true);
const gen2FocusPunch = {...focusPunchState, generation: 2 as const};
assert.equal(deriveMoveResolution(
  gen2FocusPunch, move(gen2FocusPunch, 'Focus Punch'), {hit: true},
).hit, false);

const bideState = state();
bideState.sides.ai.party[0].moves = [{name: 'Bide'}, {name: 'Tackle'}];
const bideAction = move(bideState, 'Bide');
const bideStarted = applyAction(
  bideState, bideAction, deriveMoveResolution(bideState, bideAction, {hit: true, random: () => 0}),
);
assert.equal(bideStarted.sides.ai.party[0].volatile?.bide?.turns, 2);
assert.equal(bideStarted.sides.ai.party[0].volatile?.bide?.damage, 0);
assert.deepEqual(enumerateMoveActions(bideStarted, 'ai').map(action => action.moveName), ['Bide']);
const bideAfterFirstHit = applyDamageAction(bideStarted, physicalHit, {'ai-1': 10});
assert.equal(bideAfterFirstHit.sides.ai.party[0].volatile?.bide?.damage, 10);
const bideSecondTurn = beginNextTurn(bideAfterFirstHit);
assert.equal(bideSecondTurn.sides.ai.party[0].volatile?.bide?.turns, 1);
const bideAfterSecondHit = applyDamageAction(bideSecondTurn, physicalHit, {'ai-1': 7});
assert.equal(bideAfterSecondHit.sides.ai.party[0].volatile?.bide?.damage, 17);
const bideRelease = move(bideAfterSecondHit, 'Bide');
const bideReleaseResolution = deriveMoveResolution(bideAfterSecondHit, bideRelease, {hit: true});
assert.deepEqual(bideReleaseResolution.damageByTarget, {'player-1': 34});
const bideReleased = applyAction(bideAfterSecondHit, bideRelease, bideReleaseResolution);
assert.equal(bideReleased.sides.ai.party[0].volatile?.bide, undefined);
assert.equal(bideReleased.sides.player.party[0].hp.current, 66);

const emptyBide = state();
emptyBide.sides.ai.party[0].moves = [{name: 'Bide'}];
const emptyBideStarted = applyAction(
  emptyBide, move(emptyBide, 'Bide'), deriveMoveResolution(emptyBide, move(emptyBide, 'Bide'), {hit: true, random: () => 0}),
);
const emptyBideReady = beginNextTurn(emptyBideStarted);
const emptyBideResolution = deriveMoveResolution(emptyBideReady, move(emptyBideReady, 'Bide'), {hit: true});
assert.equal(emptyBideResolution.hit, true);
assert.equal(emptyBideResolution.damageByTarget, undefined);
assert.equal(emptyBideResolution.volatileByPokemon?.['ai-1']?.bide, null);

const rolloutState = state();
rolloutState.sides.ai.party[0].moves = [{name: 'Rollout'}, {name: 'Tackle'}];
const rolloutAction = move(rolloutState, 'Rollout');
const rolloutStarted = applyAction(
  rolloutState, rolloutAction, deriveMoveResolution(rolloutState, rolloutAction, {hit: true}),
);
assert.deepEqual(rolloutStarted.sides.ai.party[0].volatile?.rollout, {
  turns: 5, stacks: 1, moveName: 'Rollout',
});
assert.deepEqual(enumerateMoveActions(rolloutStarted, 'ai').map(action => action.moveName), ['Rollout']);
const rolloutInitialFacts = calculateActionFacts(rolloutState, rolloutAction);
const rolloutSecondState = beginNextTurn(rolloutStarted);
const rolloutSecondAction = move(rolloutSecondState, 'Rollout');
const rolloutSecondFacts = calculateActionFacts(rolloutSecondState, rolloutSecondAction);
assert.ok((rolloutSecondFacts.damage?.max || 0) > (rolloutInitialFacts.damage?.max || 0));
const rolloutSecond = applyAction(
  rolloutSecondState, rolloutSecondAction,
  deriveMoveResolution(rolloutSecondState, rolloutSecondAction, {hit: true}),
);
assert.equal(rolloutSecond.sides.ai.party[0].volatile?.rollout?.stacks, 2);
const rolloutMiss = deriveMoveResolution(rolloutSecond, move(rolloutSecond, 'Rollout'), {hit: false});
assert.equal(rolloutMiss.hit, false);
assert.equal(rolloutMiss.volatileByPokemon?.['ai-1']?.rollout, null);
const rolloutAfterMiss = applyAction(rolloutSecond, move(rolloutSecond, 'Rollout'), rolloutMiss);
assert.equal(rolloutAfterMiss.sides.ai.party[0].volatile?.rollout, undefined);

let completedRollout = rolloutStarted;
for (let hit = 2; hit <= 5; hit++) {
  completedRollout = beginNextTurn(completedRollout);
  const continuedRollout = move(completedRollout, 'Rollout');
  completedRollout = applyAction(
    completedRollout, continuedRollout,
    deriveMoveResolution(completedRollout, continuedRollout, {hit: true}),
  );
}
assert.equal(completedRollout.sides.ai.party[0].volatile?.rollout, undefined);
const gen1Rollout = {...rolloutState, generation: 1 as const};
assert.equal(deriveMoveResolution(gen1Rollout, move(gen1Rollout, 'Rollout'), {hit: true}).hit, false);
const gen2IceBall = {...rolloutState, generation: 2 as const};
gen2IceBall.sides.ai.party[0].moves = [{name: 'Ice Ball'}];
assert.equal(deriveMoveResolution(gen2IceBall, move(gen2IceBall, 'Ice Ball'), {hit: true}).hit, false);

const rampageState = state();
rampageState.sides.ai.party[0].moves = [{name: 'Outrage'}, {name: 'Tackle'}];
const outrageAction = move(rampageState, 'Outrage');
const outrageStarted = applyAction(
  rampageState, outrageAction,
  deriveMoveResolution(rampageState, outrageAction, {hit: true, random: () => 0}),
);
assert.deepEqual(outrageStarted.sides.ai.party[0].volatile?.rampage, {
  turns: 2, moveName: 'Outrage',
});
assert.deepEqual(enumerateMoveActions(outrageStarted, 'ai').map(action => action.moveName), ['Outrage']);
const wrongRampageMove = deriveMoveResolution(
  outrageStarted, move(outrageStarted, 'Tackle'), {hit: true},
);
assert.equal(wrongRampageMove.hit, false);
const outrageFinalState = beginNextTurn(outrageStarted);
const outrageFinalAction = move(outrageFinalState, 'Outrage');
const outrageFinalResolution = deriveMoveResolution(
  outrageFinalState, outrageFinalAction, {hit: true, random: () => 0},
);
assert.equal(outrageFinalResolution.volatileByPokemon?.['ai-1']?.rampage, null);
assert.equal(outrageFinalResolution.volatileByPokemon?.['ai-1']?.confusion?.turns, 2);
const outrageFinished = applyAction(outrageFinalState, outrageFinalAction, outrageFinalResolution);
assert.equal(outrageFinished.sides.ai.party[0].volatile?.rampage, undefined);
assert.equal(outrageFinished.sides.ai.party[0].volatile?.confusion?.turns, 2);
const gen1Outrage = {...rampageState, generation: 1 as const};
assert.equal(deriveMoveResolution(gen1Outrage, move(gen1Outrage, 'Outrage'), {hit: true}).hit, false);

const rechargeState = state();
rechargeState.sides.ai.party[0].moves = [{name: 'Hyper Beam'}, {name: 'Tackle'}];
const hyperBeamAction = move(rechargeState, 'Hyper Beam');
const hyperBeamResolution = deriveMoveResolution(rechargeState, hyperBeamAction, {hit: true});
assert.equal(hyperBeamResolution.volatileByPokemon?.['ai-1']?.recharge?.moveName, 'Hyper Beam');
const rechargeStarted = applyAction(rechargeState, hyperBeamAction, hyperBeamResolution);
assert.equal(rechargeStarted.sides.ai.party[0].volatile?.recharge?.moveName, 'Hyper Beam');
const rechargeAction = enumerateMoveActions(rechargeStarted, 'ai')[0];
assert.deepEqual(rechargeAction?.targetIds, []);
assert.equal(calculateActionFacts(rechargeStarted, rechargeAction).moveCategory, 'Status');
const rechargeResolution = deriveMoveResolution(
  rechargeStarted, rechargeAction, {hit: true},
);
assert.equal(rechargeResolution.hit, false);
assert.equal(rechargeResolution.volatileByPokemon?.['ai-1']?.recharge, null);
const rechargeFinished = applyAction(rechargeStarted, rechargeAction, rechargeResolution);
assert.equal(rechargeFinished.sides.ai.party[0].volatile?.recharge, undefined);
assert.equal(rechargeFinished.sides.ai.party[0].moves[0].pp, rechargeStarted.sides.ai.party[0].moves[0].pp);
const hyperBeamMiss = deriveMoveResolution(rechargeState, hyperBeamAction, {hit: false});
assert.equal(hyperBeamMiss.volatileByPokemon, undefined);
const gen1HyperBeam = {...rechargeState, generation: 1 as const};
assert.equal(deriveMoveResolution(gen1HyperBeam, move(gen1HyperBeam, 'Hyper Beam'), {hit: true}).volatileByPokemon?.['ai-1']?.recharge?.moveName, 'Hyper Beam');

const chargeState = state();
chargeState.sides.ai.party[0].moves = [{name: 'Solar Beam'}, {name: 'Tackle'}];
const solarBeamAction = move(chargeState, 'Solar Beam');
const solarBeamFirstFacts = calculateActionFacts(chargeState, solarBeamAction);
assert.equal(solarBeamFirstFacts.moveCategory, 'Status');
assert.equal(solarBeamFirstFacts.damage, undefined);
const solarBeamFirstResolution = deriveMoveResolution(chargeState, solarBeamAction, {hit: true});
assert.deepEqual(solarBeamFirstResolution.volatileByPokemon?.['ai-1']?.charge, {
  turns: 2, moveName: 'Solar Beam', targetIds: ['player-1'],
});
const charging = applyAction(chargeState, solarBeamAction, solarBeamFirstResolution);
assert.deepEqual(enumerateMoveActions(charging, 'ai').map(action => action.targetIds), [['player-1']]);
const readyToRelease = beginNextTurn(charging);
const releaseAction = enumerateMoveActions(readyToRelease, 'ai')[0];
assert.deepEqual(releaseAction?.targetIds, ['player-1']);
const releaseFacts = calculateActionFacts(readyToRelease, releaseAction);
assert.equal(releaseFacts.moveCategory, 'Special');
assert.ok((releaseFacts.damage?.max || 0) > 0);
const releaseResolution = deriveMoveResolution(readyToRelease, releaseAction, {
  facts: releaseFacts, hit: true, random: () => 0,
});
assert.equal(releaseResolution.volatileByPokemon?.['ai-1']?.charge, null);
assert.ok((releaseResolution.damageByTarget?.['player-1'] || 0) > 0);
const released = applyAction(readyToRelease, releaseAction, releaseResolution);
assert.equal(released.sides.ai.party[0].volatile?.charge, undefined);

const powerHerbCharge = state();
powerHerbCharge.sides.ai.party[0].item = 'Power Herb';
powerHerbCharge.sides.ai.party[0].moves = [{name: 'Solar Beam'}];
assert.ok((calculateActionFacts(powerHerbCharge, move(powerHerbCharge, 'Solar Beam')).damage?.max || 0) > 0);
const powerHerbResolution = deriveMoveResolution(powerHerbCharge, move(powerHerbCharge, 'Solar Beam'), {hit: true});
assert.equal(powerHerbResolution.volatileByPokemon?.['ai-1']?.charge, undefined);
assert.equal(powerHerbResolution.consumedItemByPokemon?.['ai-1'], 'Power Herb');

const sunnyCharge = state();
sunnyCharge.field.weather = 'Sun';
sunnyCharge.sides.ai.party[0].moves = [{name: 'Solar Beam'}];
assert.ok((calculateActionFacts(sunnyCharge, move(sunnyCharge, 'Solar Beam')).damage?.max || 0) > 0);
assert.equal(deriveMoveResolution(sunnyCharge, move(sunnyCharge, 'Solar Beam'), {hit: true})
  .volatileByPokemon?.['ai-1']?.charge, undefined);

const chargeSwitchReady = {...charging, sides: {
  ...charging.sides,
  ai: {...charging.sides.ai, party: [...charging.sides.ai.party]},
}};
addReplacement(chargeSwitchReady, 'ai', {
  id: 'ai-2', species: 'Bulbasaur', level: 100, hp: {current: 100, max: 100}, moves: [],
});
const chargeSwitchState = applySwitchAction(chargeSwitchReady, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2',
});
assert.equal(chargeSwitchState.sides.ai.party.find(pokemon => pokemon.id === 'ai-1')?.volatile?.charge, undefined);
const gen2Bounce = {...chargeState, generation: 2 as const};
gen2Bounce.sides.ai.party[0].moves = [{name: 'Bounce'}];
assert.equal(deriveMoveResolution(gen2Bounce, move(gen2Bounce, 'Bounce'), {hit: true}).hit, false);

const semiInvulnerableState = state();
semiInvulnerableState.sides.ai.party[0].moves = [{name: 'Fly'}];
const flyAction = move(semiInvulnerableState, 'Fly');
const flying = applyAction(
  semiInvulnerableState, flyAction,
  deriveMoveResolution(semiInvulnerableState, flyAction, {hit: true}),
);
const incomingTackle: MoveAction = {
  kind: 'move', actorId: 'player-1', moveName: 'Tackle', targetIds: ['ai-1'],
};
const incomingTackleFacts = calculateActionFacts(flying, incomingTackle);
assert.equal(incomingTackleFacts.damage?.max, 0);
const incomingTackleResolution = deriveMoveResolution(flying, incomingTackle, {
  facts: incomingTackleFacts, hit: true,
});
assert.equal(incomingTackleResolution.damageByTarget, undefined);
assert.ok(incomingTackleResolution.trace?.notes?.some(note => note.includes('immune targets')));
const incomingThunder: MoveAction = {
  kind: 'move', actorId: 'player-1', moveName: 'Thunder', targetIds: ['ai-1'],
};
const incomingThunderFacts = calculateActionFacts(flying, incomingThunder);
assert.ok((incomingThunderFacts.damage?.max || 0) > 0);

const lockOnState = state();
lockOnState.sides.ai.party[0].moves = [{name: 'Lock-On'}, {name: 'Hypnosis'}];
const lockOnAction = move(lockOnState, 'Lock-On');
const lockOnStarted = applyAction(
  lockOnState, lockOnAction,
  deriveMoveResolution(lockOnState, lockOnAction, {hit: true}),
);
assert.deepEqual(lockOnStarted.sides.ai.party[0].volatile?.lockOn, {
  turns: 2, targetId: 'player-1',
});
const lockOnReady = beginNextTurn(lockOnStarted);
const sureHitAction = move(lockOnReady, 'Hypnosis');
const sureHitFacts = calculateActionFacts(lockOnReady, sureHitAction);
assert.equal(sureHitFacts.moveAccuracy, true);
const sureHitResolution = deriveMoveResolution(lockOnReady, sureHitAction, {random: () => 0.999});
assert.equal(sureHitResolution.hit, true);
assert.equal(sureHitResolution.volatileByPokemon?.['ai-1']?.lockOn, null);
const lockOnFinished = applyAction(lockOnReady, sureHitAction, sureHitResolution);
assert.equal(lockOnFinished.sides.ai.party[0].volatile?.lockOn, undefined);
const gen1LockOn = {...lockOnState, generation: 1 as const};
assert.equal(deriveMoveResolution(gen1LockOn, move(gen1LockOn, 'Lock-On'), {hit: true}).hit, false);

const partialTrapState = state();
partialTrapState.sides.ai.party[0].moves = [{name: 'Fire Spin'}];
const fireSpinAction = move(partialTrapState, 'Fire Spin');
const fireSpinFacts = calculateActionFacts(partialTrapState, fireSpinAction);
assert.ok((fireSpinFacts.damage?.max || 0) > 0);
const fireSpinResolution = deriveMoveResolution(partialTrapState, fireSpinAction, {
  facts: fireSpinFacts, hit: true, random: () => 0,
});
assert.deepEqual(fireSpinResolution.volatileByPokemon?.['player-1']?.partiallyTrapped, {
  turns: 4, moveName: 'Fire Spin', sourceId: 'ai-1',
});
const partiallyTrapped = applyAction(partialTrapState, fireSpinAction, fireSpinResolution);
assert.equal(enumerateSwitchActions(partiallyTrapped, 'player').length, 0);
const trapAfterResidual = advanceTurn(partiallyTrapped);
assert.equal(trapAfterResidual.sides.player.party[0].hp.current,
  partiallyTrapped.sides.player.party[0].hp.current - 12);
assert.equal(trapAfterResidual.sides.player.party[0].volatile?.partiallyTrapped?.turns, 3);
const trapSwitchState = {...partiallyTrapped, sides: {
  ...partiallyTrapped.sides,
  ai: {...partiallyTrapped.sides.ai, party: [...partiallyTrapped.sides.ai.party]},
}};
addReplacement(trapSwitchState, 'ai', {
  id: 'ai-2', species: 'Bulbasaur', level: 100, hp: {current: 100, max: 100}, moves: [],
});
const trapSourceSwitched = applySwitchAction(trapSwitchState, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2',
});
assert.equal(trapSourceSwitched.sides.player.party[0].volatile?.partiallyTrapped, undefined);
const phazingTrapState = {...partiallyTrapped, sides: {
  ...partiallyTrapped.sides,
  ai: {...partiallyTrapped.sides.ai, party: partiallyTrapped.sides.ai.party.map(pokemon =>
    pokemon.id === 'ai-1' ? {...pokemon, moves: [{name: 'Roar'}]} : pokemon)},
  player: {...partiallyTrapped.sides.player, party: [...partiallyTrapped.sides.player.party]},
}};
addReplacement(phazingTrapState, 'player', {
  id: 'player-2', species: 'Bulbasaur', level: 100, hp: {current: 100, max: 100}, moves: [],
});
const phazingTrapAction = move(phazingTrapState, 'Roar', ['player-1']);
const phazingTrapResolution = deriveMoveResolution(phazingTrapState, phazingTrapAction, {hit: true});
assert.equal(phazingTrapResolution.forcedSwitchByPokemon?.['player-1'], true);
const phazingTrapStarted = applyAction(phazingTrapState, phazingTrapAction, phazingTrapResolution);
const phazingTrapSwitch = enumerateForcedSwitchActions(phazingTrapStarted, 'player').find(
  action => action.actorId === 'player-1',
);
assert.ok(phazingTrapSwitch);
assert.doesNotThrow(() => applySwitchAction(phazingTrapStarted, phazingTrapSwitch!));

const permanentTrapState = state();
permanentTrapState.sides.ai.party[0].moves = [{name: 'Mean Look'}];
const meanLookAction = move(permanentTrapState, 'Mean Look');
const meanLookStarted = applyAction(
  permanentTrapState, meanLookAction,
  deriveMoveResolution(permanentTrapState, meanLookAction, {hit: true}),
);
assert.deepEqual(meanLookStarted.sides.player.party[0].volatile?.trapped, {sourceId: 'ai-1'});
assert.equal(enumerateSwitchActions(meanLookStarted, 'player').length, 0);
const permanentTrapSwitchState = {...meanLookStarted, sides: {
  ...meanLookStarted.sides,
  player: {...meanLookStarted.sides.player, party: [...meanLookStarted.sides.player.party]},
}};
addReplacement(permanentTrapSwitchState, 'player', {
  id: 'player-2', species: 'Bulbasaur', level: 100, hp: {current: 100, max: 100}, moves: [],
});
assert.throws(() => applySwitchAction(permanentTrapSwitchState, {
  kind: 'switch', actorId: 'player-1', replacementId: 'player-2',
}), /trapped/);
const permanentTrapSourceSwitchedState = {...meanLookStarted, sides: {
  ...meanLookStarted.sides,
  ai: {...meanLookStarted.sides.ai, party: [...meanLookStarted.sides.ai.party]},
}};
addReplacement(permanentTrapSourceSwitchedState, 'ai', {
  id: 'ai-2', species: 'Bulbasaur', level: 100, hp: {current: 100, max: 100}, moves: [],
});
const permanentTrapSourceSwitched = applySwitchAction(permanentTrapSourceSwitchedState, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2',
});
assert.equal(permanentTrapSourceSwitched.sides.player.party[0].volatile?.trapped, undefined);
const permanentTrapSourceFainted = {...meanLookStarted, sides: {
  ...meanLookStarted.sides,
  ai: {...meanLookStarted.sides.ai, party: meanLookStarted.sides.ai.party.map(pokemon =>
    pokemon.id === 'ai-1' ? {...pokemon, hp: {...pokemon.hp, current: 0}} : pokemon)},
}};
addReplacement(permanentTrapSourceFainted, 'player', {
  id: 'player-2', species: 'Bulbasaur', level: 100, hp: {current: 100, max: 100}, moves: [],
});
assert.ok(enumerateSwitchActions(permanentTrapSourceFainted, 'player').length > 0);
const permanentTrapAfterFaint = advanceTurn(permanentTrapSourceFainted);
assert.equal(permanentTrapAfterFaint.sides.player.party[0].volatile?.trapped, undefined);

const moveSwitchAfterTrapSourceFaint = {...state(), generation: 9 as const};
moveSwitchAfterTrapSourceFaint.sides.ai.party[0].moves = [{name: 'U-turn'}];
moveSwitchAfterTrapSourceFaint.sides.ai.party[0].volatile = {
  partiallyTrapped: {sourceId: 'player-1', moveName: 'Fire Spin', turns: 2},
};
moveSwitchAfterTrapSourceFaint.sides.player.party[0].hp = {current: 0, max: 100};
addReplacement(moveSwitchAfterTrapSourceFaint, 'ai', {
  id: 'ai-2', species: 'Bulbasaur', level: 100, hp: {current: 100, max: 100}, moves: [],
});
const moveSwitchAfterTrapSourceFaintResolution = deriveMoveResolution(
  moveSwitchAfterTrapSourceFaint,
  move(moveSwitchAfterTrapSourceFaint, 'U-turn'),
  {hit: true},
);
assert.equal(moveSwitchAfterTrapSourceFaintResolution.forcedSwitchByPokemon?.['ai-1'], true);

const nightmareState = {...state(), generation: 7 as const};
nightmareState.sides.ai.party[0].moves = [{name: 'Nightmare'}];
nightmareState.sides.player.party[0].status = 'slp';
nightmareState.sides.player.party[0].statusTurns = 2;
const nightmareAction = move(nightmareState, 'Nightmare');
const nightmareStartedResolution = deriveMoveResolution(nightmareState, nightmareAction, {hit: true});
assert.deepEqual(nightmareStartedResolution.volatileByPokemon?.['player-1']?.nightmare, {});
const gen2NightmareState = {...nightmareState, generation: 2 as const};
assert.equal(calculateActionFacts(gen2NightmareState, nightmareAction).moveAccuracy, true);
const nightmareStarted = applyAction(nightmareState, nightmareAction, nightmareStartedResolution);
const nightmareAfterResidual = advanceTurn(nightmareStarted);
assert.equal(nightmareAfterResidual.sides.player.party[0].hp.current, 75);
assert.deepEqual(nightmareAfterResidual.sides.player.party[0].volatile?.nightmare, {});
const nightmareAwake = {...nightmareStarted, sides: {
  ...nightmareStarted.sides,
  player: {...nightmareStarted.sides.player, party: nightmareStarted.sides.player.party.map(pokemon =>
    pokemon.id === 'player-1' ? {...pokemon, status: '' as const, statusTurns: undefined} : pokemon)},
}};
const nightmareAfterWake = advanceTurn(nightmareAwake);
assert.equal(nightmareAfterWake.sides.player.party[0].volatile?.nightmare, undefined);
const awakeNightmareResolution = deriveMoveResolution(
  {...nightmareState, sides: {
    ...nightmareState.sides,
    player: {...nightmareState.sides.player, party: nightmareState.sides.player.party.map(pokemon =>
      pokemon.id === 'player-1' ? {...pokemon, status: '' as const, statusTurns: undefined} : pokemon)},
  }},
  nightmareAction,
  {hit: true},
);
assert.equal(awakeNightmareResolution.hit, false);
const gen8Nightmare = {...nightmareState, generation: 8 as const};
assert.equal(enumerateMoveActions(gen8Nightmare, 'ai').some(action => action.moveName === 'Nightmare'), false);

const gen1CurseState = {...state(), generation: 1 as const};
gen1CurseState.sides.ai.party[0].moves = [{name: 'Curse'}];
const gen1CurseResolution = deriveMoveResolution(gen1CurseState, move(gen1CurseState, 'Curse'), {hit: true});
assert.equal(gen1CurseResolution.hit, false);

const electrifyState = {...state(), generation: 6 as const};
electrifyState.sides.ai.party[0].moves = [{name: 'Electrify'}];
const electrifyAction = move(electrifyState, 'Electrify');
const electrifyResolution = deriveMoveResolution(electrifyState, electrifyAction, {hit: true});
assert.deepEqual(electrifyResolution.volatileByPokemon?.['player-1']?.electrified, {turns: 1});
const electrified = applyAction(electrifyState, electrifyAction, electrifyResolution);
const electrifiedStatusMove: MoveAction = {
  kind: 'move', actorId: 'player-1', moveName: 'Tail Whip', targetIds: ['ai-1'],
};
assert.equal(calculateActionFacts(electrified, electrifiedStatusMove).moveType, 'Electric');
const electrifiedTackle: MoveAction = {
  kind: 'move', actorId: 'player-1', moveName: 'Tackle', targetIds: ['ai-1'],
};
assert.equal(calculateActionFacts(electrified, electrifiedTackle).moveType, 'Electric');
const electrifiedTackleResolution = deriveMoveResolution(electrified, electrifiedTackle, {hit: true});
assert.equal(electrifiedTackleResolution.volatileByPokemon?.['player-1']?.electrified, null);
const electrifiedConsumed = applyAction(electrified, electrifiedTackle, electrifiedTackleResolution);
assert.equal(electrifiedConsumed.sides.player.party[0].volatile?.electrified, undefined);
assert.equal(beginNextTurn(electrified).sides.player.party[0].volatile?.electrified, undefined);
const gen5Electrify = {...electrifyState, generation: 5 as const};
assert.equal(enumerateMoveActions(gen5Electrify, 'ai').some(action => action.moveName === 'Electrify'), false);

const octolockState = {...state(), generation: 8 as const};
octolockState.sides.ai.party[0].moves = [{name: 'Octolock'}];
addReplacement(octolockState, 'player', {
  id: 'player-2', species: 'Bulbasaur', level: 100, hp: {current: 100, max: 100}, moves: [],
});
const octolockAction = move(octolockState, 'Octolock');
const octolockResolution = deriveMoveResolution(octolockState, octolockAction, {hit: true});
assert.deepEqual(octolockResolution.volatileByPokemon?.['player-1']?.octolock, {sourceId: 'ai-1'});
assert.deepEqual(octolockResolution.volatileByPokemon?.['player-1']?.trapped, {sourceId: 'ai-1'});
const octolockStarted = applyAction(octolockState, octolockAction, octolockResolution);
assert.equal(enumerateSwitchActions(octolockStarted, 'player').length, 0);
const octolockAfterTurn = advanceTurn(octolockStarted);
assert.equal(octolockAfterTurn.sides.player.party[0].boosts?.def, -1);
assert.equal(octolockAfterTurn.sides.player.party[0].boosts?.spd, -1);
const octolockSourceSwitchState = {...octolockStarted, sides: {
  ...octolockStarted.sides,
  ai: {...octolockStarted.sides.ai, party: [...octolockStarted.sides.ai.party]},
}};
addReplacement(octolockSourceSwitchState, 'ai', {
  id: 'ai-2', species: 'Bulbasaur', level: 100, hp: {current: 100, max: 100}, moves: [],
});
const octolockSourceSwitched = applySwitchAction(octolockSourceSwitchState, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2',
});
assert.equal(octolockSourceSwitched.sides.player.party[0].volatile?.octolock, undefined);
assert.equal(octolockSourceSwitched.sides.player.party[0].volatile?.trapped, undefined);
const gen7Octolock = {...octolockState, generation: 7 as const};
assert.equal(enumerateMoveActions(gen7Octolock, 'ai').some(action => action.moveName === 'Octolock'), false);
const gen2OctolockClearBody = {
  ...octolockStarted,
  generation: 2 as const,
  sides: {
    ...octolockStarted.sides,
    player: {
      ...octolockStarted.sides.player,
      party: octolockStarted.sides.player.party.map(pokemon => pokemon.id === 'player-1'
        ? {...pokemon, ability: 'Clear Body'}
        : pokemon),
    },
  },
};
const gen2OctolockAfterTurn = advanceTurn(gen2OctolockClearBody);
assert.equal(gen2OctolockAfterTurn.sides.player.party[0].boosts?.def, -1);

const miracleEyeState = {...state(), generation: 6 as const};
miracleEyeState.sides.ai.party[0].moves = [{name: 'Miracle Eye'}, {name: 'Psychic'}];
miracleEyeState.sides.player.party[0].typeOverride = ['Dark'];
miracleEyeState.sides.player.party[0].boosts = {eva: 2};
const psychicAction = move(miracleEyeState, 'Psychic');
assert.equal(calculateActionFacts(miracleEyeState, psychicAction).damage?.max, 0);
const miracleEyeAction = move(miracleEyeState, 'Miracle Eye');
const miracleEyeResolution = deriveMoveResolution(miracleEyeState, miracleEyeAction, {hit: true});
assert.deepEqual(miracleEyeResolution.volatileByPokemon?.['player-1']?.miracleEye, {});
const miracleEyeStarted = applyAction(miracleEyeState, miracleEyeAction, miracleEyeResolution);
const miracleEyeFacts = calculateActionFacts(miracleEyeStarted, psychicAction);
assert.ok((miracleEyeFacts.damage?.max || 0) > 0);
const miracleEyeAccuracy = getEffectiveMoveAccuracy(miracleEyeStarted, psychicAction, 80, 'Special');
assert.equal(miracleEyeAccuracy.accuracy, 80);
assert.ok(miracleEyeAccuracy.modifiers.includes('Miracle Eye ignores evasion changes'));
addReplacement(miracleEyeStarted, 'player', {
  id: 'player-2', species: 'Bulbasaur', level: 100, hp: {current: 100, max: 100}, moves: [],
});
const miracleEyeSwitched = applySwitchAction(miracleEyeStarted, {
  kind: 'switch', actorId: 'player-1', replacementId: 'player-2',
});
assert.equal(miracleEyeSwitched.sides.player.party[0].volatile?.miracleEye, undefined);
const gen3MiracleEye = {...miracleEyeState, generation: 3 as const};
assert.equal(enumerateMoveActions(gen3MiracleEye, 'ai').some(action => action.moveName === 'Miracle Eye'), false);

const uproarState = state();
uproarState.sides.ai.party[0].moves = [{name: 'Uproar'}, {name: 'Tackle'}];
uproarState.sides.player.party[0].status = 'slp';
uproarState.sides.player.party[0].statusTurns = 2;
const uproarAction = move(uproarState, 'Uproar');
const uproarResolution = deriveMoveResolution(uproarState, uproarAction, {hit: true, random: () => 0});
// Gen 5+ Uproar is a fixed 3 turns; the roll-based 2-5 was the Gen 3/4
// table (constants audit D17). The state() fixture is gen 9.
assert.deepEqual(uproarResolution.volatileByPokemon?.['ai-1']?.uproar, {
  turns: 3, moveName: 'Uproar',
});
assert.equal(uproarResolution.statusByPokemon?.['player-1'], '');
const uproarStarted = applyAction(uproarState, uproarAction, uproarResolution);
assert.deepEqual(enumerateMoveActions(uproarStarted, 'ai').map(action => action.moveName), ['Uproar']);
assert.equal(uproarStarted.sides.player.party[0].status, '');
const sleepBlockedByUproar = {...uproarStarted, sides: {
  ...uproarStarted.sides,
  player: {...uproarStarted.sides.player, party: uproarStarted.sides.player.party.map(pokemon =>
    pokemon.id === 'player-1' ? {...pokemon, moves: [{name: 'Hypnosis'}]} : pokemon)},
}};
const hypnosisDuringUproar: MoveAction = {
  kind: 'move', actorId: 'player-1', moveName: 'Hypnosis', targetIds: ['ai-1'],
};
const hypnosisResolution = deriveMoveResolution(sleepBlockedByUproar, hypnosisDuringUproar, {hit: true});
assert.equal(hypnosisResolution.statusByPokemon, undefined);
const faintedUproar = doublesState();
faintedUproar.sides.ai.party[0].volatile = {uproar: {turns: 1}};
faintedUproar.sides.ai.party[0].hp.current = 0;
assert.equal(canApplyMajorStatus(faintedUproar, 'player-1', 'ai-2', 'slp', undefined, true), true);
// Two boundaries now, not one: gen 5+ Uproar runs a fixed 3 turns (D17).
const uproarFinishedState = beginNextTurn(beginNextTurn(uproarStarted));
const uproarFinalAction = enumerateMoveActions(uproarFinishedState, 'ai')[0];
const uproarFinalResolution = deriveMoveResolution(uproarFinishedState, uproarFinalAction, {hit: true});
assert.equal(uproarFinalResolution.volatileByPokemon?.['ai-1']?.uproar, null);
const uproarFinished = applyAction(uproarFinishedState, uproarFinalAction, uproarFinalResolution);
assert.equal(uproarFinished.sides.ai.party[0].volatile?.uproar, undefined);
const gen2Uproar = {...uproarState, generation: 2 as const};
assert.equal(deriveMoveResolution(gen2Uproar, move(gen2Uproar, 'Uproar'), {hit: true}).hit, false);

const faintedImprison = state();
faintedImprison.sides.ai.party[0].moves = [{name: 'Tackle'}];
faintedImprison.sides.player.party[0].volatile = {imprison: {moveNames: ['Tackle']}};
faintedImprison.sides.player.party[0].hp.current = 0;
assert.equal(enumerateMoveActions(faintedImprison).some(action => action.moveName === 'Tackle'), true);

const ragePowderGrassImmunity = {...ragePowderApplied, sides: {
  ...ragePowderApplied.sides,
  player: {...ragePowderApplied.sides.player, party: ragePowderApplied.sides.player.party.map(pokemon =>
    pokemon.id === 'player-1' ? {...pokemon, species: 'Bulbasaur'} : pokemon)},
}};
const grassAttacks = enumerateMoveActions(ragePowderGrassImmunity, 'player').filter(action =>
  action.kind === 'move' && action.actorId === 'player-1' && action.moveName === 'Tackle');
assert.deepEqual(grassAttacks.map(action => action.targetIds), [['ai-1'], ['ai-2']]);

const stalwartAttack = {...ragePowderApplied, sides: {
  ...ragePowderApplied.sides,
  player: {...ragePowderApplied.sides.player, party: ragePowderApplied.sides.player.party.map(pokemon =>
    pokemon.id === 'player-1' ? {...pokemon, ability: 'Stalwart'} : pokemon)},
}};
const stalwartActions = enumerateMoveActions(stalwartAttack, 'player').filter(action =>
  action.kind === 'move' && action.actorId === 'player-1' && action.moveName === 'Tackle');
assert.deepEqual(stalwartActions.map(action => action.targetIds), [['ai-1'], ['ai-2']]);
const stalwartGen7Actions = enumerateMoveActions({...stalwartAttack, generation: 7 as const}, 'player').filter(action =>
  action.kind === 'move' && action.actorId === 'player-1' && action.moveName === 'Tackle');
assert.deepEqual(stalwartGen7Actions.map(action => action.targetIds), [['ai-1']]);

const doublesSpeedSetup = state();
doublesSpeedSetup.mode = 'Doubles';
const tailwindEvaluation = scoreStatusAction(doublesSpeedSetup, {
  action: {kind: 'move', actorId: 'ai-1', moveName: 'Tailwind', targetIds: []},
  facts: {
    moveCategory: 'Status', battleMode: 'Doubles', attackerSpeed: 100,
    attackerPartnerSpeed: 50, opponentSpeeds: [75],
  },
  outcomes: [], reasons: [],
});
assert.equal(tailwindEvaluation.outcomes[0].score, 9);
const trickRoomEvaluation = scoreStatusAction(doublesSpeedSetup, {
  action: {kind: 'move', actorId: 'ai-1', moveName: 'Trick Room', targetIds: []},
  facts: {
    moveCategory: 'Status', battleMode: 'Doubles', attackerSpeed: 100,
    attackerPartnerSpeed: 50, opponentSpeeds: [75],
  },
  outcomes: [], reasons: [],
});
assert.equal(trickRoomEvaluation.outcomes[0].score, 10);
const activeTrickRoomState = {...doublesSpeedSetup, field: {trickRoom: true}};
const activeTrickRoomEvaluation = scoreStatusAction(activeTrickRoomState, {
  action: {kind: 'move', actorId: 'ai-1', moveName: 'Trick Room', targetIds: []},
  facts: {
    moveCategory: 'Status', battleMode: 'Doubles', attackerSpeed: 100,
    attackerPartnerSpeed: 50, opponentSpeeds: [75],
  },
  outcomes: [], reasons: [],
});
assert.deepEqual(activeTrickRoomEvaluation.outcomes, [{score: -20, probability: 1}]);

const doublesSpreadThreat = doublesState();
doublesSpreadThreat.sides.ai.party = doublesSpreadThreat.sides.ai.party.map(pokemon =>
  pokemon.id === 'ai-1' ? {...pokemon, species: 'Pidgey'} : pokemon);
doublesSpreadThreat.sides.ai.party.find(pokemon => pokemon.id === 'ai-2')!.hp = {current: 1, max: 100};
doublesSpreadThreat.sides.ai.party.find(pokemon => pokemon.id === 'ai-2')!.moves = [{name: 'Calm Mind'}];
doublesSpreadThreat.sides.player.party.find(pokemon => pokemon.id === 'player-1')!.moves = [{name: 'Earthquake'}];
const doublesSpreadSetupAction = enumerateMoveActions(doublesSpreadThreat, 'ai').find(action =>
  action.kind === 'move' && action.actorId === 'ai-2' && action.moveName === 'Calm Mind');
assert.ok(doublesSpreadSetupAction);
const doublesSpreadSetupFacts = calculateActionFacts(doublesSpreadThreat, doublesSpreadSetupAction!);
assert.equal(doublesSpreadSetupFacts.opponentCanKO, true);
assert.ok((doublesSpreadSetupFacts.opponentMaxDamage || 0) >= 1);
assert.deepEqual(scoreStatusAction(doublesSpreadThreat, {
  action: doublesSpreadSetupAction!, facts: doublesSpreadSetupFacts, outcomes: [], reasons: [],
}).outcomes, [{score: -20, probability: 1}]);

const playerPerspectiveThreat = state();
playerPerspectiveThreat.sides.player.party[0].hp = {current: 1, max: 100};
playerPerspectiveThreat.sides.player.party[0].moves = [{name: 'Calm Mind'}];
playerPerspectiveThreat.sides.ai.party[0].moves = [{name: 'Tackle'}];
const playerPerspectiveAction = enumerateMoveActions(playerPerspectiveThreat, 'player').find(action =>
  action.kind === 'move' && action.actorId === 'player-1' && action.moveName === 'Calm Mind');
assert.ok(playerPerspectiveAction);
const playerPerspectiveFacts = calculateActionFacts(playerPerspectiveThreat, playerPerspectiveAction!);
assert.equal(playerPerspectiveFacts.opponentCanKO, true);
assert.ok((playerPerspectiveFacts.opponentMaxDamage || 0) >= 1);

const magicRoomState = state();
magicRoomState.sides.ai.party[0].moves = [{name: 'Magic Room'}];
magicRoomState.sides.ai.party[0].item = 'Choice Band';
const magicRoomAction = move(magicRoomState, 'Magic Room', []);
const magicRoomResolution = deriveMoveResolution(magicRoomState, magicRoomAction, {hit: true});
assert.deepEqual(magicRoomResolution.field, {magicRoom: true});
assert.deepEqual(magicRoomResolution.fieldDurations, {magicRoom: 5});
const magicRoomStarted = applyAction(magicRoomState, magicRoomAction, magicRoomResolution);
assert.equal(magicRoomStarted.field.magicRoom, true);
assert.equal(magicRoomStarted.field.durations?.magicRoom, 5);
let magicRoomExpired = magicRoomStarted;
for (let turn = 0; turn < 5; turn++) magicRoomExpired = beginNextTurn(magicRoomExpired);
assert.equal(magicRoomExpired.field.magicRoom, undefined);
assert.equal(magicRoomExpired.field.durations, undefined);
const magicRoomToggleResolution = deriveMoveResolution(
  magicRoomStarted, magicRoomAction, {hit: true},
);
assert.deepEqual(magicRoomToggleResolution.field, {magicRoom: false});
assert.deepEqual(magicRoomToggleResolution.fieldDurations, {magicRoom: null});
const magicRoomEnded = applyAction(magicRoomStarted, magicRoomAction, magicRoomToggleResolution);
assert.equal(magicRoomEnded.field.magicRoom, false);
assert.equal(magicRoomEnded.field.durations, undefined);
assert.equal(isItemEffectActive(magicRoomStarted, magicRoomStarted.sides.ai.party[0]), false);
assert.equal(isItemEffectActive(magicRoomEnded, magicRoomEnded.sides.ai.party[0]), true);

const wonderRoomState = state();
wonderRoomState.sides.ai.party[0].moves = [{name: 'Wonder Room'}];
const wonderRoomAction = move(wonderRoomState, 'Wonder Room', []);
const wonderRoomStarted = applyAction(
  wonderRoomState, wonderRoomAction,
  deriveMoveResolution(wonderRoomState, wonderRoomAction, {hit: true}),
);
assert.equal(wonderRoomStarted.field.wonderRoom, true);
assert.equal(wonderRoomStarted.field.durations?.wonderRoom, 5);
const wonderRoomEnded = applyAction(
  wonderRoomStarted, wonderRoomAction,
  deriveMoveResolution(wonderRoomStarted, wonderRoomAction, {hit: true}),
);
assert.equal(wonderRoomEnded.field.wonderRoom, false);
assert.equal(wonderRoomEnded.field.durations, undefined);
const magicRoomGen4 = {...magicRoomState, generation: 4 as const};
assert.deepEqual(deriveMoveResolution(magicRoomGen4, magicRoomAction, {hit: true}).field, undefined);

const statusSynergyState = state();
statusSynergyState.sides.ai.party[0].moves = [{name: 'Thunder Wave'}, {name: 'Fake Out'}];
const focusEnergyGen2 = {...state(), generation: 2 as const};
focusEnergyGen2.sides.ai.party[0].moves = [{name: 'Focus Energy'}];
focusEnergyGen2.sides.player.party[0].ability = 'Battle Armor';
const focusEnergyAction = move(focusEnergyGen2, 'Focus Energy', ['ai-1']);
assert.deepEqual(scoreStatusAction(focusEnergyGen2, {
  action: focusEnergyAction, facts: {}, outcomes: [], reasons: [],
}).outcomes, [{score: 6, probability: 1}]);
const focusEnergyGen3 = {...focusEnergyGen2, generation: 3 as const};
assert.deepEqual(scoreStatusAction(focusEnergyGen3, {
  action: focusEnergyAction, facts: {}, outcomes: [], reasons: [],
}).outcomes, [{score: -20, probability: 1}]);
const preIntroductionFactState = state();
preIntroductionFactState.generation = 2;
preIntroductionFactState.sides.ai.party[0].hp = {current: 50, max: 100};
preIntroductionFactState.sides.ai.party[0].moves = [{name: 'Rest'}];
const preIntroductionFactRest = move(preIntroductionFactState, 'Rest', ['ai-1']);
const preIntroductionFactEvaluation = scoreStatusAction(preIntroductionFactState, {
  action: preIntroductionFactRest,
  facts: {
    attackerAbility: 'Early Bird', attackerHp: 50, attackerHpPercent: 50,
    attackerSpeed: 100, opponentSpeeds: [50], opponentCanKO: false, opponentMaxDamage: 10,
  }, outcomes: [], reasons: [],
});
assert.deepEqual(preIntroductionFactEvaluation.outcomes, [
  {score: 7, probability: 0.5}, {score: 5, probability: 0.5},
]);
const thunderWaveAction = enumerateMoveActions(statusSynergyState).find(action =>
  action.kind === 'move' && action.moveName === 'Thunder Wave');
assert.ok(thunderWaveAction);
const thunderWaveFacts = calculateActionFacts(statusSynergyState, thunderWaveAction!);
assert.equal(thunderWaveFacts.attackerHasFlinchMove, true);
assert.deepEqual(scoreStatusAction(statusSynergyState, {
  action: thunderWaveAction!,
  facts: {attackerSpeed: 100, defenderSpeed: 200, attackerPartnerMoves: ['Hex']},
  outcomes: [], reasons: [],
}).outcomes, [{score: 8, probability: 0.5}, {score: 7, probability: 0.5}]);
assert.deepEqual(scoreStatusAction(statusSynergyState, {
  action: thunderWaveAction!,
  facts: {attackerSpeed: 200, defenderSpeed: 100, defenderConfused: true},
  outcomes: [], reasons: [],
}).outcomes, [{score: 8, probability: 0.5}, {score: 7, probability: 0.5}]);
const willOWispAction = {kind: 'move' as const, actorId: 'ai-1', moveName: 'Will-O-Wisp', targetIds: ['player-1']};
assert.deepEqual(scoreStatusAction(statusSynergyState, {
  action: willOWispAction,
  facts: {attackerSpeed: 200, defenderSpeed: 100, opponentCanKO: false},
  outcomes: [], reasons: [],
}).outcomes, [{score: 6, probability: 1}]);

const sleepSynergyAction = {kind: 'move' as const, actorId: 'ai-1', moveName: 'Hypnosis', targetIds: ['player-1']};
assert.deepEqual(scoreStatusAction(statusSynergyState, {
  action: sleepSynergyAction,
  facts: {attackerPartnerMoves: ['Hex']},
  outcomes: [], reasons: [],
}).outcomes, [{score: 6, probability: 0.75}, {score: 8, probability: 0.25}]);
assert.deepEqual(scoreStatusAction(statusSynergyState, {
  action: sleepSynergyAction,
  facts: {attackerMoves: ['Hypnosis', 'Dream Eater'], defenderMoves: ['Sleep Talk']},
  outcomes: [], reasons: [],
}).outcomes, [{score: 6, probability: 0.75}, {score: 7, probability: 0.25}]);
assert.deepEqual(scoreStatusAction(statusSynergyState, {
  action: sleepSynergyAction,
  facts: {attackerPartnerMoves: ['Hex'], opponentCanKO: true},
  outcomes: [], reasons: [],
}).outcomes, [{score: 6, probability: 1}]);

const toxicPolicyState = state();
toxicPolicyState.sides.ai.party[0].moves = [{name: 'Toxic'}, {name: 'Hex'}];
const toxicAction = enumerateMoveActions(toxicPolicyState).find(action =>
  action.kind === 'move' && action.moveName === 'Toxic');
assert.ok(toxicAction);
const toxicEvaluation = scoreStatusAction(toxicPolicyState, {
  action: toxicAction!,
  facts: {
    defenderHpPercent: 80, defenderHasPhysicalMove: false, defenderHasSpecialMove: false,
    attackerMoves: ['Toxic', 'Hex'],
  },
  outcomes: [], reasons: [],
});
assert.deepEqual(toxicEvaluation.outcomes, [{score: 6, probability: 0.62}, {score: 8, probability: 0.38}]);
assert.deepEqual(scoreStatusAction(toxicPolicyState, {
  action: toxicAction!,
  facts: {
    defenderHpPercent: 80, defenderHasPhysicalMove: false, defenderHasSpecialMove: false,
    attackerMoves: ['Toxic'],
  },
  outcomes: [], reasons: [],
}).outcomes, [{score: 6, probability: 1}]);
assert.deepEqual(scoreStatusAction(toxicPolicyState, {
  action: toxicAction!,
  facts: {
    defenderHpPercent: 80, defenderHasPhysicalMove: true, defenderHasSpecialMove: false,
    attackerMoves: ['Toxic', 'Hex'],
  },
  outcomes: [], reasons: [],
}).outcomes, [{score: 6, probability: 1}]);

for (const poisonMoveName of ['Poison Gas', 'Toxic Thread']) {
  const poisonMoveState = state();
  poisonMoveState.sides.ai.party[0].moves = [{name: poisonMoveName}, {name: 'Hex'}];
  const poisonMoveAction = enumerateMoveActions(poisonMoveState).find(action =>
    action.kind === 'move' && action.moveName === poisonMoveName);
  assert.ok(poisonMoveAction);
  assert.deepEqual(scoreStatusAction(poisonMoveState, {
    action: poisonMoveAction!,
    facts: {
      defenderHpPercent: 80, defenderHasPhysicalMove: false, defenderHasSpecialMove: false,
      attackerMoves: [poisonMoveName, 'Hex'],
    },
    outcomes: [], reasons: [],
  }).outcomes, [{score: 6, probability: 0.62}, {score: 8, probability: 0.38}], poisonMoveName);
}

const setupPolicyState = state();
setupPolicyState.sides.ai.party[0].moves = [{name: 'Swords Dance'}];
const setupAction = enumerateMoveActions(setupPolicyState).find(action =>
  action.kind === 'move' && action.moveName === 'Swords Dance');
assert.ok(setupAction);
const setupEvaluation = scoreStatusAction(setupPolicyState, {
  action: setupAction!,
  facts: {attackerSpeed: 200, defenderSpeed: 100, opponentCanKO: false},
  outcomes: [], reasons: [],
});
assert.deepEqual(setupEvaluation.outcomes, [{score: 9, probability: 1}]);

const rechargeSetupState = state();
rechargeSetupState.sides.ai.party[0].moves = [{name: 'Swords Dance'}];
rechargeSetupState.sides.player.party[0].volatile = {recharge: {moveName: 'Hyper Beam'}};
const rechargeSetupAction = enumerateMoveActions(rechargeSetupState).find(action =>
  action.kind === 'move' && action.moveName === 'Swords Dance');
assert.ok(rechargeSetupAction);
assert.equal(calculateActionFacts(rechargeSetupState, move(rechargeSetupState, 'Tackle')).defenderIncapacitated, true);
assert.deepEqual(scoreStatusAction(rechargeSetupState, {
  action: rechargeSetupAction!,
  facts: {attackerSpeed: 200, defenderSpeed: 100, opponentCanKO: false},
  outcomes: [], reasons: [],
}).outcomes, [{score: 12, probability: 1}]);

const truantSetupState = state();
truantSetupState.sides.ai.party[0].moves = [{name: 'Swords Dance'}];
truantSetupState.sides.player.party[0].volatile = {truant: {}};
const truantSetupAction = enumerateMoveActions(truantSetupState).find(action =>
  action.kind === 'move' && action.moveName === 'Swords Dance');
assert.ok(truantSetupAction);
assert.deepEqual(scoreStatusAction(truantSetupState, {
  action: truantSetupAction!,
  facts: {attackerSpeed: 200, defenderSpeed: 100, opponentCanKO: false},
  outcomes: [], reasons: [],
}).outcomes, [{score: 12, probability: 1}]);

const specialSetupState = state();
specialSetupState.sides.ai.party[0].moves = [{name: 'Nasty Plot'}];
const specialSetupAction = enumerateMoveActions(specialSetupState).find(action =>
  action.kind === 'move' && action.moveName === 'Nasty Plot');
assert.ok(specialSetupAction);
const specialSetupFacts = {
  attackerHp: 100, attackerSpeed: 200, defenderSpeed: 100,
  opponentCanKO: false, opponentCan2HKO: false, opponentMaxDamage: 30,
};
assert.deepEqual(scoreStatusAction(specialSetupState, {
  action: specialSetupAction!, facts: specialSetupFacts, outcomes: [], reasons: [],
}).outcomes, [{score: 8, probability: 1}]);
assert.deepEqual(scoreStatusAction(specialSetupState, {
  action: specialSetupAction!,
  facts: {...specialSetupFacts, attackerBoosts: {spa: 2}},
  outcomes: [], reasons: [],
}).outcomes, [{score: 7, probability: 1}]);

const sturdySetupState = state();
sturdySetupState.sides.ai.party[0].ability = 'Sturdy';
sturdySetupState.sides.ai.party[0].moves = [{name: 'Calm Mind'}];
const sturdySetupAction = enumerateMoveActions(sturdySetupState).find(action =>
  action.kind === 'move' && action.moveName === 'Calm Mind');
assert.ok(sturdySetupAction);
assert.deepEqual(scoreStatusAction(sturdySetupState, {
  action: sturdySetupAction!,
  facts: {attackerSpeed: 100, defenderSpeed: 100, opponentCanKO: true},
  outcomes: [], reasons: [],
}).outcomes, [{score: 6, probability: 1}]);

const brokenSturdyState = {...sturdySetupState, sides: {
  ...sturdySetupState.sides,
  ai: {...sturdySetupState.sides.ai, party: [{
    ...sturdySetupState.sides.ai.party[0], hp: {current: 99, max: 100},
  }]},
}};
assert.deepEqual(scoreStatusAction(brokenSturdyState, {
  action: sturdySetupAction!,
  facts: {opponentCanKO: true},
  outcomes: [], reasons: [],
}).outcomes, [{score: -20, probability: 1}]);

const sashSetupState = state();
sashSetupState.sides.ai.party[0].item = 'Focus Sash';
sashSetupState.sides.ai.party[0].moves = [{name: 'Calm Mind'}];
const sashSetupAction = enumerateMoveActions(sashSetupState).find(action =>
  action.kind === 'move' && action.moveName === 'Calm Mind');
assert.ok(sashSetupAction);
assert.deepEqual(scoreStatusAction(sashSetupState, {
  action: sashSetupAction!,
  facts: {opponentCanKO: true},
  outcomes: [], reasons: [],
}).outcomes, [{score: 6, probability: 1}]);

const tauntPolicyState = state();
tauntPolicyState.sides.ai.party[0].moves = [{name: 'Taunt'}];
tauntPolicyState.sides.player.effects = {auroraVeil: true};
tauntPolicyState.sides.player.party[0].moves = [{name: 'Defog'}];
const tauntAction = enumerateMoveActions(tauntPolicyState).find(action =>
  action.kind === 'move' && action.moveName === 'Taunt');
assert.ok(tauntAction);
assert.deepEqual(scoreStatusAction(tauntPolicyState, {
  action: tauntAction!,
  facts: {attackerSpeed: 200, defenderSpeed: 100, defenderMoves: ['Defog']},
  outcomes: [], reasons: [],
}).outcomes, [{score: 9, probability: 1}]);

const screenTauntState = state();
screenTauntState.sides.ai.party[0].moves = [{name: 'Taunt'}];
screenTauntState.sides.player.effects = {reflect: true};
const screenTauntAction = enumerateMoveActions(screenTauntState).find(action =>
  action.kind === 'move' && action.moveName === 'Taunt');
assert.ok(screenTauntAction);
assert.deepEqual(scoreStatusAction(screenTauntState, {
  action: screenTauntAction!,
  facts: {attackerSpeed: 200, defenderSpeed: 100},
  outcomes: [], reasons: [],
}).outcomes, [{score: 5, probability: 1}]);
const slowerTrickRoomTauntState = state();
slowerTrickRoomTauntState.sides.ai.party[0].moves = [{name: 'Taunt'}];
slowerTrickRoomTauntState.sides.player.party[0].moves = [{name: 'Trick Room'}];
const slowerTrickRoomTauntAction = enumerateMoveActions(slowerTrickRoomTauntState).find(action =>
  action.kind === 'move' && action.moveName === 'Taunt');
assert.ok(slowerTrickRoomTauntAction);
assert.deepEqual(scoreStatusAction(slowerTrickRoomTauntState, {
  action: slowerTrickRoomTauntAction!,
  facts: {attackerSpeed: 100, defenderSpeed: 200, defenderMoves: ['Trick Room']},
  outcomes: [], reasons: [],
}).outcomes, [{score: 9, probability: 1}]);

const destinyState = state();
destinyState.sides.ai.party[0].moves = [{name: 'Destiny Bond'}];
const destinyAction = enumerateMoveActions(destinyState).find(action =>
  action.kind === 'move' && action.moveName === 'Destiny Bond');
assert.ok(destinyAction);
assert.deepEqual(scoreStatusAction(destinyState, {
  action: destinyAction!, facts: {attackerSpeed: 200, defenderSpeed: 100, opponentCanKO: false},
  outcomes: [], reasons: [],
}).outcomes, [{score: 6, probability: 1}]);
assert.deepEqual(scoreStatusAction(destinyState, {
  action: destinyAction!, facts: {attackerSpeed: 200, defenderSpeed: 100, opponentCanKO: true},
  outcomes: [], reasons: [],
}).outcomes, [{score: 7, probability: 0.81}, {score: 6, probability: 0.19}]);
assert.deepEqual(scoreStatusAction(destinyState, {
  action: destinyAction!, facts: {attackerSpeed: 50, defenderSpeed: 100, opponentCanKO: true},
  outcomes: [], reasons: [],
}).outcomes, [{score: 5, probability: 0.5}, {score: 6, probability: 0.5}]);

const firstTurnEncoreState = state();
firstTurnEncoreState.sides.ai.party[0].moves = [{name: 'Encore'}];
firstTurnEncoreState.firstTurnOutIds = ['player-1'];
firstTurnEncoreState.lastMoveByPokemon = {'player-1': 'Tackle'};
assert.equal(enumerateMoveActions(firstTurnEncoreState).some(action => action.moveName === 'Encore'), false);
const firstTurnEncoreAction: MoveAction = {
  kind: 'move', actorId: 'ai-1', moveName: 'Encore', targetIds: ['player-1'],
};
assert.deepEqual(scoreStatusAction(firstTurnEncoreState, {
  action: firstTurnEncoreAction, facts: {}, outcomes: [], reasons: [],
}).outcomes, [{score: -20, probability: 1}]);

const weatherRecoveryState = state();
weatherRecoveryState.sides.ai.party[0].hp = {current: 40, max: 100};
weatherRecoveryState.sides.ai.party[0].moves = [{name: 'Moonlight'}];
const moonlightAction = enumerateMoveActions(weatherRecoveryState).find(action =>
  action.kind === 'move' && action.moveName === 'Moonlight');
assert.ok(moonlightAction);
assert.deepEqual(scoreStatusAction({...weatherRecoveryState, field: {weather: 'Sun'}}, {
  action: moonlightAction!,
  facts: {
    attackerHp: 40, attackerHpPercent: 40, attackerSpeed: 200,
    opponentMaxDamage: 55, opponentCanKO: false,
  },
  outcomes: [], reasons: [],
}).outcomes, [{score: 7, probability: 0.5}, {score: 5, probability: 0.5}]);
assert.deepEqual(scoreStatusAction({...weatherRecoveryState, field: {weather: 'Harsh Sunshine'}}, {
  action: moonlightAction!,
  facts: {
    attackerHp: 40, attackerHpPercent: 40, attackerSpeed: 200,
    opponentMaxDamage: 55, opponentCanKO: false,
  },
  outcomes: [], reasons: [],
}).outcomes, [{score: 7, probability: 0.5}, {score: 5, probability: 0.5}]);
assert.deepEqual(scoreStatusAction(weatherRecoveryState, {
  action: moonlightAction!,
  facts: {
    attackerHp: 40, attackerHpPercent: 40, attackerSpeed: 200,
    opponentMaxDamage: 55, opponentCanKO: false,
  },
  outcomes: [], reasons: [],
}).outcomes, [{score: 5, probability: 1}]);

const swallowState = state();
swallowState.sides.ai.party[0].hp = {current: 40, max: 100};
swallowState.sides.ai.party[0].moves = [{name: 'Swallow'}];
swallowState.sides.ai.party[0].volatile = {stockpile: {stacks: 1}};
const swallowAction = enumerateMoveActions(swallowState).find(action =>
  action.kind === 'move' && action.moveName === 'Swallow');
assert.ok(swallowAction);
const swallowFacts = {
  attackerHp: 40, attackerHpPercent: 40, attackerSpeed: 200,
  opponentMaxDamage: 30, opponentCanKO: false,
};
assert.deepEqual(scoreStatusAction(swallowState, {
  action: swallowAction!, facts: swallowFacts, outcomes: [], reasons: [],
}).outcomes, [{score: 5, probability: 1}]);
swallowState.sides.ai.party[0].volatile = {stockpile: {stacks: 2}};
assert.deepEqual(scoreStatusAction(swallowState, {
  action: swallowAction!, facts: swallowFacts, outcomes: [], reasons: [],
}).outcomes, [{score: 7, probability: 0.5}, {score: 5, probability: 0.5}]);
swallowState.sides.ai.party[0].volatile = {stockpile: {stacks: 3}};
assert.deepEqual(scoreStatusAction(swallowState, {
  action: swallowAction!, facts: swallowFacts, outcomes: [], reasons: [],
}).outcomes, [{score: 7, probability: 0.5}, {score: 5, probability: 0.5}]);

const strengthSapFullState = state();
strengthSapFullState.sides.ai.party[0].moves = [{name: 'Strength Sap'}];
const strengthSapAction = enumerateMoveActions(strengthSapFullState).find(action =>
  action.kind === 'move' && action.moveName === 'Strength Sap');
assert.ok(strengthSapAction);
assert.deepEqual(scoreStatusAction(strengthSapFullState, {
  action: strengthSapAction!, facts: {}, outcomes: [], reasons: [],
}).outcomes, [{score: -20, probability: 1}]);
strengthSapFullState.sides.ai.party[0].hp = {current: 90, max: 100};
assert.deepEqual(scoreStatusAction(strengthSapFullState, {
  action: strengthSapAction!, facts: {}, outcomes: [], reasons: [],
}).outcomes, [{score: -6, probability: 1}]);

const healBlockedStrengthSap = state();
healBlockedStrengthSap.sides.ai.party[0].hp = {current: 50, max: 100};
healBlockedStrengthSap.sides.ai.party[0].moves = [{name: 'Strength Sap'}];
healBlockedStrengthSap.sides.ai.party[0].volatile = {healBlock: {turns: 2}};
const healBlockedStrengthSapResolution = deriveMoveResolution(healBlockedStrengthSap, {
  kind: 'move', actorId: 'ai-1', moveName: 'Strength Sap', targetIds: ['player-1'],
}, {hit: true});
assert.equal(healBlockedStrengthSapResolution.hit, false);
assert.equal(healBlockedStrengthSapResolution.hpDeltaByPokemon, undefined);
assert.equal(healBlockedStrengthSapResolution.boostsByPokemon, undefined);

const healBlockedWish = state();
healBlockedWish.sides.ai.party[0].hp = {current: 50, max: 100};
healBlockedWish.sides.ai.party[0].moves = [{name: 'Wish'}];
healBlockedWish.sides.ai.party[0].volatile = {healBlock: {turns: 2}};
const healBlockedWishResolution = deriveMoveResolution(healBlockedWish, {
  kind: 'move', actorId: 'ai-1', moveName: 'Wish', targetIds: ['ai-1'],
}, {hit: true});
assert.equal(healBlockedWishResolution.hit, false);
assert.equal(healBlockedWishResolution.delayedMoves, undefined);

const secondaryAbilityBypass = {...state(), generation: 4 as const};
secondaryAbilityBypass.sides.ai.party[0].ability = 'Mold Breaker';
secondaryAbilityBypass.sides.ai.party[0].moves = [{name: 'Tackle'}];
secondaryAbilityBypass.sides.player.party[0].ability = 'Own Tempo';
const secondaryAbilityBypassResolution = deriveMoveResolution(
  secondaryAbilityBypass,
  move(secondaryAbilityBypass, 'Tackle'),
  {
    hit: true,
    facts: {
      moveCategory: 'Physical', moveType: 'Normal',
      secondaryEffects: [{chance: 100, volatile: {name: 'confusion'}}],
    },
    random: () => 0,
  },
);
assert.equal(secondaryAbilityBypassResolution.volatileByPokemon?.['player-1']?.confusion?.turns, 2);

const secondaryStatusAbilityBypass = {...secondaryAbilityBypass, sides: {
  ...secondaryAbilityBypass.sides,
  ai: {...secondaryAbilityBypass.sides.ai, party: secondaryAbilityBypass.sides.ai.party.map(pokemon => ({
    ...pokemon, ability: 'Mold Breaker',
  }))},
  player: {...secondaryAbilityBypass.sides.player, party: secondaryAbilityBypass.sides.player.party.map(pokemon => ({
    ...pokemon, ability: 'Water Veil',
  }))},
}};
const secondaryStatusAbilityBypassResolution = deriveMoveResolution(
  secondaryStatusAbilityBypass,
  move(secondaryStatusAbilityBypass, 'Tackle'),
  {
    hit: true,
    facts: {
      moveCategory: 'Physical', moveType: 'Normal',
      secondaryEffects: [{chance: 100, status: 'brn'}],
    },
    random: () => 0,
  },
);
assert.equal(secondaryStatusAbilityBypassResolution.statusByPokemon?.['player-1'], 'brn');
const secondaryStatusBlocked = {...secondaryStatusAbilityBypass, sides: {
  ...secondaryStatusAbilityBypass.sides,
  ai: {...secondaryStatusAbilityBypass.sides.ai, party: secondaryStatusAbilityBypass.sides.ai.party.map(pokemon => ({
    ...pokemon, ability: undefined,
  }))},
}};
const secondaryStatusBlockedResolution = deriveMoveResolution(
  secondaryStatusBlocked,
  move(secondaryStatusBlocked, 'Tackle'),
  {
    hit: true,
    facts: {
      moveCategory: 'Physical', moveType: 'Normal',
      secondaryEffects: [{chance: 100, status: 'brn'}],
    },
    random: () => 0,
  },
);
assert.equal(secondaryStatusBlockedResolution.statusByPokemon?.['player-1'], undefined);

const statAbilityBypass = {...state(), generation: 4 as const};
statAbilityBypass.sides.ai.party[0].ability = 'Mold Breaker';
statAbilityBypass.sides.ai.party[0].moves = [{name: 'Tail Whip'}];
statAbilityBypass.sides.player.party[0].ability = 'Clear Body';
const statAbilityBypassResolution = deriveMoveResolution(
  statAbilityBypass,
  move(statAbilityBypass, 'Tail Whip'),
  {hit: true, random: () => 0},
);
assert.equal(statAbilityBypassResolution.boostsByPokemon?.['player-1']?.def, -1);

const statAbilityBlocked = {...statAbilityBypass, sides: {
  ...statAbilityBypass.sides,
  ai: {...statAbilityBypass.sides.ai, party: statAbilityBypass.sides.ai.party.map(pokemon => ({
    ...pokemon, ability: undefined,
  }))},
}};
const statAbilityBlockedResolution = deriveMoveResolution(
  statAbilityBlocked,
  move(statAbilityBlocked, 'Tail Whip'),
  {hit: true, random: () => 0},
);
assert.equal(statAbilityBlockedResolution.boostsByPokemon, undefined);

const contraryAbilityBypass = {...statAbilityBypass, sides: {
  ...statAbilityBypass.sides,
  player: {...statAbilityBypass.sides.player, party: statAbilityBypass.sides.player.party.map(pokemon => ({
    ...pokemon, ability: 'Contrary',
  }))},
}};
const contraryAbilityBypassResolution = deriveMoveResolution(
  contraryAbilityBypass,
  move(contraryAbilityBypass, 'Tail Whip'),
  {hit: true, random: () => 0},
);
assert.equal(contraryAbilityBypassResolution.boostsByPokemon?.['player-1']?.def, -1);

const secondaryStatAbilityBypass = {...statAbilityBypass};
const secondaryStatAbilityBypassResolution = deriveMoveResolution(
  secondaryStatAbilityBypass,
  move(secondaryStatAbilityBypass, 'Tackle'),
  {
    hit: true,
    facts: {
      moveCategory: 'Physical', moveType: 'Normal',
      secondaryEffects: [{chance: 100, boosts: {def: -1}}],
    },
    random: () => 0,
  },
);
assert.equal(secondaryStatAbilityBypassResolution.boostsByPokemon?.['player-1']?.def, -1);

const secondaryPositiveAbilityBypass = {...secondaryStatAbilityBypass, sides: {
  ...secondaryStatAbilityBypass.sides,
  player: {...secondaryStatAbilityBypass.sides.player, party: secondaryStatAbilityBypass.sides.player.party.map(pokemon => ({
    ...pokemon, ability: 'Contrary',
  }))},
}};
const secondaryPositiveAbilityBypassResolution = deriveMoveResolution(
  secondaryPositiveAbilityBypass,
  move(secondaryPositiveAbilityBypass, 'Tackle'),
  {
    hit: true,
    facts: {
      moveCategory: 'Physical', moveType: 'Normal',
      secondaryEffects: [{chance: 100, boosts: {def: 1}}],
    },
    random: () => 0,
  },
);
assert.equal(secondaryPositiveAbilityBypassResolution.boostsByPokemon?.['player-1']?.def, 1);

assert.deepEqual(scoreDamagingAction({
  damage: {rolls: [10], min: 10, max: 10, targetHp: 100, possibleKO: false, guaranteedKO: false},
  moveCategory: 'Physical', battleMode: 'Doubles', isMultiHit: true,
}, true, tackleAction), [{score: 7, probability: 0.8}, {score: 9, probability: 0.2}]);
assert.deepEqual(scoreDamagingAction({
  damage: {rolls: [0], min: 0, max: 0, targetHp: 100, possibleKO: false, guaranteedKO: false},
  moveCategory: 'Physical', isImmune: true,
}, true, tackleAction), [{score: -20, probability: 1}]);
const contraryDamageFacts = {
  damage: {rolls: [30], min: 30, max: 30, targetHp: 100, possibleKO: false, guaranteedKO: false},
  moveCategory: 'Special' as const, attackerAbility: 'Contrary', attackerHp: 100,
  attackerSpeed: 200, defenderSpeed: 100, opponentCanKO: true,
  opponentCan2HKO: false, opponentMaxDamage: 30,
};
assert.deepEqual(scoreDamagingAction(contraryDamageFacts, false, {
  kind: 'move', actorId: 'ai-1', moveName: 'Leaf Storm', targetIds: ['player-1'],
}), [{score: 8, probability: 1}]);
assert.deepEqual(scoreDamagingAction({...contraryDamageFacts, moveCategory: 'Physical', opponentCanKO: false}, false, {
  kind: 'move', actorId: 'ai-1', moveName: 'Superpower', targetIds: ['player-1'],
}), [{score: 9, probability: 1}]);
const damagingSetupFacts = {
  damage: {rolls: [20], min: 20, max: 20, targetHp: 100, possibleKO: false, guaranteedKO: false},
  moveCategory: 'Special' as const, attackerSpeed: 200, defenderSpeed: 100,
  opponentCanKO: false, opponentCan2HKO: false,
};
assert.deepEqual(scoreDamagingAction(damagingSetupFacts, false, {
  kind: 'move', actorId: 'ai-1', moveName: 'Charge Beam', targetIds: ['player-1'],
}), [{score: 6, probability: 1}]);
assert.deepEqual(scoreDamagingAction({...damagingSetupFacts, attackerSpeed: 100, defenderSpeed: 200}, false, {
  kind: 'move', actorId: 'ai-1', moveName: 'Power-Up Punch', targetIds: ['player-1'],
}), [{score: 6, probability: 1}]);
assert.deepEqual(scoreDamagingAction({...damagingSetupFacts, defenderAbility: 'Unaware'}, false, {
  kind: 'move', actorId: 'ai-1', moveName: 'Charge Beam', targetIds: ['player-1'],
}), [{score: -20, probability: 1}]);
assert.deepEqual(scoreDamagingAction({...damagingSetupFacts, opponentCanKO: true}, false, {
  kind: 'move', actorId: 'ai-1', moveName: 'Charge Beam', targetIds: ['player-1'],
}), [{score: -20, probability: 1}]);
const specialAttackDropFacts = {
  damage: {rolls: [20], min: 20, max: 20, targetHp: 100, possibleKO: false, guaranteedKO: false},
  moveCategory: 'Special' as const, defenderHasSpecialMove: true,
};
assert.deepEqual(scoreDamagingAction(specialAttackDropFacts, false, {
  kind: 'move', actorId: 'ai-1', moveName: 'Mystical Fire', targetIds: ['player-1'],
}), [{score: 6, probability: 1}]);
// Spirit Break is a physical attack whose guaranteed drop targets Special Attack.
assert.deepEqual(scoreDamagingAction({...specialAttackDropFacts, moveCategory: 'Physical'}, false, {
  kind: 'move', actorId: 'ai-1', moveName: 'Spirit Break', targetIds: ['player-1'],
}), [{score: 6, probability: 1}]);
assert.deepEqual(scoreDamagingAction({...specialAttackDropFacts, defenderHasSpecialMove: false}, false, {
  kind: 'move', actorId: 'ai-1', moveName: 'Spirit Break', targetIds: ['player-1'],
}), [{score: 5, probability: 1}]);
const guaranteedKillFacts = {
  damage: {rolls: [100], min: 100, max: 100, targetHp: 100, possibleKO: true, guaranteedKO: true},
  moveCategory: 'Special' as const, attackerSpeed: 200, defenderSpeed: 100,
  opponentCanKO: false,
};
assert.deepEqual(scoreDamagingAction(guaranteedKillFacts, false, {
  kind: 'move', actorId: 'ai-1', moveName: 'Meteor Beam', targetIds: ['player-1'],
}), [{score: -20, probability: 1}]);
assert.deepEqual(scoreDamagingAction({...guaranteedKillFacts, attackerSpecies: 'Meloetta-Pirouette'}, false, {
  kind: 'move', actorId: 'ai-1', moveName: 'Relic Song', targetIds: ['player-1'],
}), [{score: -20, probability: 1}]);
assert.deepEqual(scoreDamagingAction({...guaranteedKillFacts, attackerItem: undefined}, false, {
  kind: 'move', actorId: 'ai-1', moveName: 'Fling', targetIds: ['player-1'],
}), [{score: -20, probability: 1}]);

const blockedFling = state();
blockedFling.sides.ai.party[0].moves = [{name: 'Fling'}];
blockedFling.sides.ai.party[0].item = 'Iron Ball';
blockedFling.field.magicRoom = true;
const blockedFlingResolution = deriveMoveResolution(blockedFling, move(blockedFling, 'Fling'), {hit: true});
assert.equal(blockedFlingResolution.hit, false);
assert.equal(blockedFlingResolution.itemByPokemon, undefined);
assert.equal(applyAction(blockedFling, move(blockedFling, 'Fling'), blockedFlingResolution)
  .sides.ai.party[0].item, 'Iron Ball');

const missedFling = state();
missedFling.sides.ai.party[0].moves = [{name: 'Fling'}];
missedFling.sides.ai.party[0].item = 'Iron Ball';
const missedFlingResolution = deriveMoveResolution(missedFling, move(missedFling, 'Fling'), {hit: false});
assert.equal(missedFlingResolution.itemByPokemon?.['ai-1'], null);

const naturalGift = state();
naturalGift.generation = 7;
naturalGift.sides.ai.party[0].moves = [{name: 'Natural Gift'}];
naturalGift.sides.ai.party[0].item = 'Sitrus Berry';
const naturalGiftResolution = deriveMoveResolution(naturalGift, move(naturalGift, 'Natural Gift'), {hit: true});
assert.equal(naturalGiftResolution.itemByPokemon?.['ai-1'], null);
assert.equal(applyAction(naturalGift, move(naturalGift, 'Natural Gift'), naturalGiftResolution)
  .sides.ai.party[0].item, undefined);

const embargoNaturalGift = state();
embargoNaturalGift.sides.ai.party[0].moves = [{name: 'Natural Gift'}];
embargoNaturalGift.sides.ai.party[0].item = 'Sitrus Berry';
embargoNaturalGift.sides.ai.party[0].volatile = {embargo: {turns: 3}};
const embargoNaturalGiftResolution = deriveMoveResolution(
  embargoNaturalGift, move(embargoNaturalGift, 'Natural Gift'), {hit: true},
);
assert.equal(embargoNaturalGiftResolution.hit, false);
assert.equal(embargoNaturalGiftResolution.itemByPokemon, undefined);

const generation8NaturalGift = state();
generation8NaturalGift.sides.ai.party[0].moves = [{name: 'Natural Gift'}];
generation8NaturalGift.sides.ai.party[0].item = 'Sitrus Berry';
assert.equal(enumerateMoveActions(generation8NaturalGift).some(action => action.moveName === 'Natural Gift'), false);
const generation8NaturalGiftResolution = deriveMoveResolution(
  generation8NaturalGift, move(generation8NaturalGift, 'Natural Gift'), {hit: true},
);
assert.equal(generation8NaturalGiftResolution.hit, false);
assert.equal(generation8NaturalGiftResolution.itemByPokemon, undefined);

const redCardNaturalGift = state();
redCardNaturalGift.generation = 7;
redCardNaturalGift.sides.ai.party[0].moves = [{name: 'Natural Gift'}];
redCardNaturalGift.sides.ai.party[0].item = 'Sitrus Berry';
redCardNaturalGift.sides.ai.party.push({
  id: 'ai-2', species: 'Eevee', level: 100, hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}],
});
redCardNaturalGift.sides.player.party[0].item = 'Red Card';
const redCardNaturalGiftAction = move(redCardNaturalGift, 'Natural Gift');
const redCardNaturalGiftResolution = deriveMoveResolution(
  redCardNaturalGift,
  redCardNaturalGiftAction,
  {
    hit: true,
    facts: {
      damage: {rolls: [20], min: 20, max: 20, targetHp: 100, possibleKO: false, guaranteedKO: false},
    },
  },
);
assert.equal(redCardNaturalGiftResolution.forcedSwitchByPokemon?.['ai-1'], true);
assert.equal(redCardNaturalGiftResolution.itemByPokemon?.['ai-1'], undefined);
assert.equal(redCardNaturalGiftResolution.itemByPokemon?.['player-1'], null);

const incinerateState = state();
incinerateState.sides.ai.party[0].moves = [{name: 'Incinerate'}];
incinerateState.sides.player.party[0].item = 'Sitrus Berry';
const incinerateResolution = deriveMoveResolution(incinerateState, move(incinerateState, 'Incinerate'), {
  hit: true,
  facts: {
    damage: {rolls: [20], min: 20, max: 20, targetHp: 100, possibleKO: false, guaranteedKO: false},
  },
});
assert.equal(incinerateResolution.itemByPokemon?.['player-1'], null);
assert.equal(incinerateResolution.consumedItemByPokemon, undefined);
const incinerateAggregateSubstitute = {...incinerateState, sides: {...incinerateState.sides,
  player: {...incinerateState.sides.player, party: incinerateState.sides.player.party.map(pokemon => ({
    ...pokemon, substituteHp: 50,
  }))},
}};
assert.equal(deriveMoveResolution(incinerateAggregateSubstitute,
  move(incinerateAggregateSubstitute, 'Incinerate'), {
    hit: true,
    facts: {moveCategory: 'Special', moveType: 'Fire',
      damage: {rolls: [60], min: 60, max: 60, targetHp: 100, possibleKO: false, guaranteedKO: false}},
  }).itemByPokemon?.['player-1'], null);

const stickyIncinerateState = state();
stickyIncinerateState.sides.ai.party[0].moves = [{name: 'Incinerate'}];
stickyIncinerateState.sides.player.party[0].item = 'Sitrus Berry';
stickyIncinerateState.sides.player.party[0].ability = 'Sticky Hold';
const stickyIncinerateResolution = deriveMoveResolution(
  stickyIncinerateState, move(stickyIncinerateState, 'Incinerate'), {
    hit: true,
    facts: {
      damage: {rolls: [20], min: 20, max: 20, targetHp: 100, possibleKO: false, guaranteedKO: false},
    },
  },
);
assert.equal(stickyIncinerateResolution.itemByPokemon, undefined);

const stickyIncinerateKo = state();
stickyIncinerateKo.sides.ai.party[0].moves = [{name: 'Incinerate'}];
stickyIncinerateKo.sides.player.party[0].item = 'Sitrus Berry';
stickyIncinerateKo.sides.player.party[0].ability = 'Sticky Hold';
const stickyIncinerateKoResolution = deriveMoveResolution(stickyIncinerateKo, move(stickyIncinerateKo, 'Incinerate'), {
  hit: true,
  facts: {
    damage: {rolls: [100], min: 100, max: 100, targetHp: 100, possibleKO: true, guaranteedKO: true},
  },
});
assert.equal(stickyIncinerateKoResolution.itemByPokemon?.['player-1'], null);

const magicianState = state();
magicianState.sides.ai.party[0].moves = [{name: 'Tackle'}];
magicianState.sides.ai.party[0].ability = 'Magician';
magicianState.sides.player.party[0].item = 'Leftovers';
const magicianResolution = deriveMoveResolution(magicianState, move(magicianState, 'Tackle'), {
  hit: true,
  facts: {
    damage: {rolls: [20], min: 20, max: 20, targetHp: 100, possibleKO: false, guaranteedKO: false},
  },
});
assert.equal(magicianResolution.itemByPokemon?.['ai-1'], 'Leftovers');
assert.equal(magicianResolution.itemByPokemon?.['player-1'], null);

const pickpocketState = state();
pickpocketState.sides.ai.party[0].moves = [{name: 'Tackle'}];
pickpocketState.sides.ai.party[0].item = 'Choice Band';
pickpocketState.sides.player.party[0].ability = 'Pickpocket';
const pickpocketResolution = deriveMoveResolution(pickpocketState, move(pickpocketState, 'Tackle'), {
  hit: true,
  facts: {
    damage: {rolls: [20], min: 20, max: 20, targetHp: 100, possibleKO: false, guaranteedKO: false},
  },
});
assert.equal(pickpocketResolution.itemByPokemon?.['ai-1'], null);
assert.equal(pickpocketResolution.itemByPokemon?.['player-1'], 'Choice Band');

const corrosiveGasState = state();
corrosiveGasState.sides.ai.party[0].moves = [{name: 'Corrosive Gas'}];
corrosiveGasState.sides.player.party[0].item = 'Leftovers';
const corrosiveGasAction = move(corrosiveGasState, 'Corrosive Gas');
const corrosiveGasResolution = deriveMoveResolution(corrosiveGasState, corrosiveGasAction, {hit: true});
assert.equal(corrosiveGasResolution.itemCorrodedByPokemon?.['player-1'], true);
const corrosiveGasNext = applyAction(corrosiveGasState, corrosiveGasAction, corrosiveGasResolution);
assert.equal(corrosiveGasNext.sides.player.party[0].item, 'Leftovers');
assert.equal(corrosiveGasNext.sides.player.party[0].itemCorroded, true);
assert.equal(isItemEffectActive(corrosiveGasNext, corrosiveGasNext.sides.player.party[0]), false);

addReplacement(corrosiveGasNext, 'player', {
  id: 'player-2', species: 'Raticate', level: 100,
  hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}],
});
const corrosiveGasSwitchedOut = applySwitchAction(corrosiveGasNext, {
  kind: 'switch', actorId: 'player-1', replacementId: 'player-2',
});
const corrosiveGasSwitchedBack = applySwitchAction(corrosiveGasSwitchedOut, {
  kind: 'switch', actorId: 'player-2', replacementId: 'player-1',
});
assert.equal(corrosiveGasSwitchedBack.sides.player.party[0].item, 'Leftovers');
assert.equal(corrosiveGasSwitchedBack.sides.player.party[0].itemCorroded, true);

const stickyCorrosiveGasState = state();
stickyCorrosiveGasState.sides.ai.party[0].moves = [{name: 'Corrosive Gas'}];
stickyCorrosiveGasState.sides.player.party[0].item = 'Leftovers';
stickyCorrosiveGasState.sides.player.party[0].ability = 'Sticky Hold';
const stickyCorrosiveGasResolution = deriveMoveResolution(
  stickyCorrosiveGasState, move(stickyCorrosiveGasState, 'Corrosive Gas'), {hit: true},
);
assert.equal(stickyCorrosiveGasResolution.itemCorrodedByPokemon, undefined);

const substituteCorrosiveGasState = state();
substituteCorrosiveGasState.sides.ai.party[0].moves = [{name: 'Corrosive Gas'}];
substituteCorrosiveGasState.sides.player.party[0].item = 'Leftovers';
substituteCorrosiveGasState.sides.player.party[0].substituteHp = 20;
const substituteCorrosiveGasResolution = deriveMoveResolution(
  substituteCorrosiveGasState, move(substituteCorrosiveGasState, 'Corrosive Gas'), {hit: true},
);
assert.equal(substituteCorrosiveGasResolution.itemCorrodedByPokemon, undefined);

const corrodedPoltergeistState = state();
corrodedPoltergeistState.sides.ai.party[0].moves = [{name: 'Poltergeist'}];
corrodedPoltergeistState.sides.player.party[0].species = 'Pikachu';
corrodedPoltergeistState.sides.player.party[0].item = 'Leftovers';
corrodedPoltergeistState.sides.player.party[0].itemCorroded = true;
const corrodedPoltergeistFacts = calculateActionFacts(
  corrodedPoltergeistState, move(corrodedPoltergeistState, 'Poltergeist'),
);
assert.ok((corrodedPoltergeistFacts.damage?.min || 0) > 0);
assert.equal(corrodedPoltergeistFacts.defenderItem, undefined);

const trickGiveState = state();
trickGiveState.sides.ai.party[0].moves = [{name: 'Trick'}];
trickGiveState.sides.ai.party[0].item = 'Choice Scarf';
trickGiveState.sides.player.party[0].item = undefined;
const trickGiveResolution = deriveMoveResolution(trickGiveState, move(trickGiveState, 'Trick'), {hit: true});
const trickGiveNext = applyAction(trickGiveState, move(trickGiveState, 'Trick'), trickGiveResolution);
assert.equal(trickGiveNext.sides.ai.party[0].item, undefined);
assert.equal(trickGiveNext.sides.player.party[0].item, 'Choice Scarf');

const stickyTrickState = state();
stickyTrickState.sides.ai.party[0].moves = [{name: 'Trick'}];
stickyTrickState.sides.ai.party[0].item = 'Choice Scarf';
stickyTrickState.sides.player.party[0].item = 'Iron Ball';
stickyTrickState.sides.player.party[0].ability = 'Sticky Hold';
const stickyTrickResolution = deriveMoveResolution(stickyTrickState, move(stickyTrickState, 'Trick'), {hit: true});
assert.equal(stickyTrickResolution.hit, false);
assert.equal(stickyTrickResolution.itemByPokemon, undefined);
const stickyTrickGen2 = {...stickyTrickState, generation: 2 as const};
const stickyTrickGen2Resolution = deriveMoveResolution(stickyTrickGen2, move(stickyTrickGen2, 'Trick'), {hit: true});
assert.equal(stickyTrickGen2Resolution.hit, true);
assert.equal(stickyTrickGen2Resolution.itemByPokemon?.['ai-1'], 'Iron Ball');

const emptyTrickState = state();
emptyTrickState.sides.ai.party[0].moves = [{name: 'Trick'}];
const emptyTrickResolution = deriveMoveResolution(emptyTrickState, move(emptyTrickState, 'Trick'), {hit: true});
assert.equal(emptyTrickResolution.hit, false);

const magicRoomStuffCheeks = state();
magicRoomStuffCheeks.sides.ai.party[0].moves = [{name: 'Stuff Cheeks'}];
magicRoomStuffCheeks.sides.ai.party[0].item = 'Sitrus Berry';
magicRoomStuffCheeks.field.magicRoom = true;
const magicRoomStuffCheeksAction = move(magicRoomStuffCheeks, 'Stuff Cheeks', ['ai-1']);
const magicRoomStuffCheeksResolution = deriveMoveResolution(magicRoomStuffCheeks, magicRoomStuffCheeksAction, {hit: true});
const magicRoomStuffCheeksNext = applyAction(
  magicRoomStuffCheeks, magicRoomStuffCheeksAction, magicRoomStuffCheeksResolution,
);
assert.equal(magicRoomStuffCheeksNext.sides.ai.party[0].item, undefined);
assert.equal(magicRoomStuffCheeksNext.sides.ai.party[0].boosts?.def, 2);

const mirrorHerbState = state();
mirrorHerbState.sides.ai.party[0].moves = [{name: 'Swords Dance'}];
mirrorHerbState.sides.player.party[0].item = 'Mirror Herb';
const mirrorHerbAction = move(mirrorHerbState, 'Swords Dance', ['ai-1']);
const mirrorHerbResolution = deriveMoveResolution(mirrorHerbState, mirrorHerbAction, {hit: true});
assert.equal(mirrorHerbResolution.boostsByPokemon?.['ai-1']?.atk, 2);
assert.equal(mirrorHerbResolution.boostsByPokemon?.['player-1']?.atk, 2);
assert.equal(mirrorHerbResolution.itemByPokemon?.['player-1'], null);
assert.equal(mirrorHerbResolution.consumedItemByPokemon?.['player-1'], 'Mirror Herb');
const mirrorHerbNext = applyAction(mirrorHerbState, mirrorHerbAction, mirrorHerbResolution);
assert.equal(mirrorHerbNext.sides.player.party[0].item, undefined);
assert.equal(mirrorHerbNext.sides.player.party[0].lastConsumedItem, 'Mirror Herb');

const mirrorHerbGen8 = {...mirrorHerbState, generation: 8 as const};
const mirrorHerbGen8Resolution = deriveMoveResolution(mirrorHerbGen8, mirrorHerbAction, {hit: true});
assert.equal(mirrorHerbGen8Resolution.boostsByPokemon?.['player-1'], undefined);
assert.equal(mirrorHerbGen8Resolution.itemByPokemon, undefined);
const mirrorHerbMagicRoom = {...mirrorHerbState, field: {magicRoom: true}};
assert.equal(deriveMoveResolution(mirrorHerbMagicRoom, mirrorHerbAction, {hit: true}).itemByPokemon, undefined);
const mirrorHerbEmbargo = {...mirrorHerbState};
mirrorHerbEmbargo.sides.player.party[0].volatile = {embargo: {turns: 2}};
assert.equal(deriveMoveResolution(mirrorHerbEmbargo, mirrorHerbAction, {hit: true}).itemByPokemon, undefined);
const mirrorHerbKlutz = {...mirrorHerbState};
mirrorHerbKlutz.sides.player.party[0].ability = 'Klutz';
assert.equal(deriveMoveResolution(mirrorHerbKlutz, mirrorHerbAction, {hit: true}).itemByPokemon, undefined);
const selfMirrorHerb = state();
selfMirrorHerb.sides.ai.party[0].moves = [{name: 'Swords Dance'}];
selfMirrorHerb.sides.ai.party[0].item = 'Mirror Herb';
assert.equal(deriveMoveResolution(selfMirrorHerb, move(selfMirrorHerb, 'Swords Dance', ['ai-1']), {hit: true}).itemByPokemon, undefined);
const mirrorHerbBenched = {...mirrorHerbState, sides: {
  ...mirrorHerbState.sides,
  player: {...mirrorHerbState.sides.player, party: [...mirrorHerbState.sides.player.party, {
    id: 'player-2', species: 'Rattata', level: 100,
    hp: {current: 100, max: 100}, moves: [],
  }]},
}};
assert.throws(() => applyAction(mirrorHerbBenched, mirrorHerbAction, {
  boostsByPokemon: {'player-2': {atk: 1}},
}), /invalid Pok/);

const blunderPolicyState = state();
blunderPolicyState.sides.ai.party[0].moves = [{name: 'Tackle'}];
blunderPolicyState.sides.ai.party[0].item = 'Blunder Policy';
const blunderPolicyAction = move(blunderPolicyState, 'Tackle');
const blunderPolicyResolution = deriveMoveResolution(blunderPolicyState, blunderPolicyAction, {
  accuracy: 50,
  random: () => 0.99,
});
assert.equal(blunderPolicyResolution.hit, false);
assert.equal(blunderPolicyResolution.boostsByPokemon?.['ai-1']?.spe, 2);
assert.equal(blunderPolicyResolution.itemByPokemon?.['ai-1'], null);
assert.equal(blunderPolicyResolution.consumedItemByPokemon?.['ai-1'], 'Blunder Policy');
const blunderPolicyNext = applyAction(blunderPolicyState, blunderPolicyAction, blunderPolicyResolution);
assert.equal(blunderPolicyNext.sides.ai.party[0].item, undefined);
assert.equal(blunderPolicyNext.sides.ai.party[0].boosts?.spe, 2);
assert.equal(blunderPolicyNext.sides.ai.party[0].lastConsumedItem, 'Blunder Policy');
const blunderPolicyGenericFailure = deriveMoveResolution(blunderPolicyState, blunderPolicyAction, {hit: false});
assert.equal(blunderPolicyGenericFailure.boostsByPokemon, undefined);
assert.equal(blunderPolicyGenericFailure.itemByPokemon, undefined);
const blunderPolicyGen7 = {...blunderPolicyState, generation: 7 as const};
assert.equal(deriveMoveResolution(blunderPolicyGen7, blunderPolicyAction, {
  accuracy: 50, random: () => 0.99,
}).boostsByPokemon, undefined);
const blunderPolicyMagicRoom = {...blunderPolicyState, field: {magicRoom: true}};
assert.equal(deriveMoveResolution(blunderPolicyMagicRoom, blunderPolicyAction, {
  accuracy: 50, random: () => 0.99,
}).itemByPokemon, undefined);
const blunderPolicyEmbargo = {...blunderPolicyState};
blunderPolicyEmbargo.sides = {...blunderPolicyEmbargo.sides,
  ai: {...blunderPolicyEmbargo.sides.ai,
    party: blunderPolicyEmbargo.sides.ai.party.map(pokemon => ({...pokemon, volatile: {embargo: {turns: 2}}})),
  },
};
assert.equal(deriveMoveResolution(blunderPolicyEmbargo, blunderPolicyAction, {
  accuracy: 50, random: () => 0.99,
}).itemByPokemon, undefined);
const blunderPolicyKlutz = {...blunderPolicyState};
blunderPolicyKlutz.sides = {...blunderPolicyKlutz.sides,
  ai: {...blunderPolicyKlutz.sides.ai,
    party: blunderPolicyKlutz.sides.ai.party.map(pokemon => ({...pokemon, ability: 'Klutz'})),
  },
};
assert.equal(deriveMoveResolution(blunderPolicyKlutz, blunderPolicyAction, {
  accuracy: 50, random: () => 0.99,
}).itemByPokemon, undefined);
const blunderPolicySpread = {...blunderPolicyState, mode: 'Doubles' as const, sides: {
  ...blunderPolicyState.sides,
  ai: {...blunderPolicyState.sides.ai, activeIds: ['ai-1']},
  player: {...blunderPolicyState.sides.player, activeIds: ['player-1', 'player-2'], party: [
    ...blunderPolicyState.sides.player.party,
    {id: 'player-2', species: 'Rattata', level: 100, hp: {current: 100, max: 100}, moves: []},
  ]},
}};
const blunderPolicySpreadResolution = deriveMoveResolution(blunderPolicySpread, {
  kind: 'move', actorId: 'ai-1', moveName: 'Tackle', targetIds: ['player-1', 'player-2'],
}, {accuracy: 50, random: (() => {
  const rolls = [0, 0.99];
  return () => rolls.shift()!;
})()});
assert.equal(blunderPolicySpreadResolution.hit, true);
assert.equal(blunderPolicySpreadResolution.boostsByPokemon?.['ai-1']?.spe, 2);

const lowercaseBerryBite = state();
lowercaseBerryBite.sides.ai.party[0].moves = [{name: 'Bug Bite'}];
lowercaseBerryBite.sides.ai.party[0].lastConsumedItem = 'Oran Berry';
lowercaseBerryBite.sides.player.party[0].item = 'sitrus berry';
lowercaseBerryBite.sides.player.party[0].ability = 'Cud Chew';
const lowercaseBerryBiteAction = move(lowercaseBerryBite, 'Bug Bite');
const lowercaseBerryBiteResolution = deriveMoveResolution(lowercaseBerryBite, lowercaseBerryBiteAction, {hit: true});
assert.equal(lowercaseBerryBiteResolution.consumedItemByPokemon?.['ai-1'], null);
assert.equal(lowercaseBerryBiteResolution.volatileByPokemon?.['player-1']?.cudChew, undefined);
const lowercaseBerryBiteNext = applyAction(lowercaseBerryBite, lowercaseBerryBiteAction, lowercaseBerryBiteResolution);
assert.equal(lowercaseBerryBiteNext.sides.player.party[0].item, undefined);
assert.equal(lowercaseBerryBiteNext.sides.ai.party[0].lastConsumedItem, undefined);

const gen4BerryBite = state();
gen4BerryBite.generation = 4;
gen4BerryBite.sides.ai.party[0].moves = [{name: 'Bug Bite'}];
gen4BerryBite.sides.player.party[0].item = 'Sitrus Berry';
const gen4BerryBiteAction = move(gen4BerryBite, 'Bug Bite');
const gen4BerryBiteResolution = deriveMoveResolution(gen4BerryBite, gen4BerryBiteAction, {hit: true});
assert.equal(gen4BerryBiteResolution.consumedItemByPokemon?.['ai-1'], 'Sitrus Berry');

const berryBiteEatEffect = state();
berryBiteEatEffect.sides.ai.party[0].moves = [{name: 'Bug Bite'}];
berryBiteEatEffect.sides.ai.party[0].hp.current = 40;
berryBiteEatEffect.sides.ai.party[0].ability = 'Cud Chew';
berryBiteEatEffect.sides.player.party[0].item = 'Sitrus Berry';
const berryBiteEatEffectResolution = deriveMoveResolution(
  berryBiteEatEffect, move(berryBiteEatEffect, 'Bug Bite'), {hit: true},
);
assert.equal(berryBiteEatEffectResolution.hpDeltaByPokemon?.['ai-1'], 25);
assert.equal(berryBiteEatEffectResolution.itemByPokemon?.['player-1'], null);
assert.equal(berryBiteEatEffectResolution.volatileByPokemon?.['ai-1']?.cudChew, undefined);
const healBlockedBerryBite = {...berryBiteEatEffect, sides: {...berryBiteEatEffect.sides,
  ai: {...berryBiteEatEffect.sides.ai, party: berryBiteEatEffect.sides.ai.party.map(pokemon => ({
    ...pokemon, volatile: {healBlock: {turns: 2}},
  }))},
}};
const healBlockedBerryBiteResolution = deriveMoveResolution(
  healBlockedBerryBite, move(healBlockedBerryBite, 'Bug Bite'), {hit: true},
);
assert.equal(healBlockedBerryBiteResolution.hpDeltaByPokemon, undefined);
assert.equal(healBlockedBerryBiteResolution.itemByPokemon?.['player-1'], null);
const berryBiteStatusEffect = state();
berryBiteStatusEffect.sides.ai.party[0].moves = [{name: 'Bug Bite'}];
berryBiteStatusEffect.sides.ai.party[0].status = 'par';
berryBiteStatusEffect.sides.player.party[0].item = 'Cheri Berry';
const berryBiteStatusResolution = deriveMoveResolution(
  berryBiteStatusEffect, move(berryBiteStatusEffect, 'Bug Bite'), {hit: true, random: () => 0.99},
);
assert.equal(berryBiteStatusResolution.statusByPokemon?.['ai-1'], '');

const pluckEatEffect = state();
pluckEatEffect.sides.ai.party[0].moves = [{name: 'Pluck'}];
pluckEatEffect.sides.ai.party[0].hp.current = 40;
pluckEatEffect.sides.player.party[0].item = 'Liechi Berry';
const pluckEatEffectResolution = deriveMoveResolution(
  pluckEatEffect, move(pluckEatEffect, 'Pluck'), {hit: true},
);
assert.equal(pluckEatEffectResolution.hpDeltaByPokemon?.['ai-1'], undefined);
assert.equal(pluckEatEffectResolution.boostsByPokemon?.['ai-1']?.atk, 1);

const teatimeEatEffect = {...state(), generation: 8 as const};
teatimeEatEffect.sides.ai.party[0].moves = [{name: 'Teatime'}];
teatimeEatEffect.sides.player.party[0].item = 'Sitrus Berry';
teatimeEatEffect.sides.player.party[0].hp.current = 40;
const teatimeEatEffectResolution = deriveMoveResolution(
  teatimeEatEffect, move(teatimeEatEffect, 'Teatime'), {hit: true},
);
assert.equal(teatimeEatEffectResolution.hpDeltaByPokemon?.['player-1'], 25);
assert.equal(teatimeEatEffectResolution.itemByPokemon?.['player-1'], null);
teatimeEatEffect.sides.player.party[0].status = 'brn';
teatimeEatEffect.sides.player.party[0].item = 'Rawst Berry';
const teatimeStatusResolution = deriveMoveResolution(
  teatimeEatEffect, move(teatimeEatEffect, 'Teatime'), {hit: true},
);
assert.equal(teatimeStatusResolution.statusByPokemon?.['player-1'], '');

assert.deepEqual(scoreDamagingAction({
  damage: {rolls: [20], min: 20, max: 20, targetHp: 100, possibleKO: false, guaranteedKO: false},
  moveCategory: 'Physical', attackerHpPercent: 20,
}, false, {
  kind: 'move', actorId: 'ai-1', moveName: 'Explosion', targetIds: ['player-1'],
}), [{score: 8, probability: 0.7}, {score: 0, probability: 0.3}]);

const transformState = state();
transformState.sides.ai.party[0].moves = [{name: 'Transform', pp: 1, maxPP: 1}];
transformState.sides.player.party[0].species = 'Charizard';
transformState.sides.player.party[0].ability = 'Blaze';
transformState.sides.player.party[0].boosts = {spa: 2, spe: -1};
transformState.sides.player.party[0].moves = [{name: 'Flamethrower'}, {name: 'Protect'}];
const transformAction = enumerateMoveActions(transformState)[0];
assert.deepEqual(transformAction.targetIds, ['player-1']);
const transformResolution = deriveMoveResolution(transformState, transformAction, {hit: true});
assert.deepEqual(transformResolution.speciesOverrideByPokemon, {'ai-1': 'Charizard'});
assert.deepEqual(transformResolution.typeOverrideByPokemon, {'ai-1': ['Fire', 'Flying']});
assert.deepEqual(transformResolution.abilityOverrideByPokemon, {'ai-1': 'Blaze'});
assert.deepEqual(transformResolution.setBoostsByPokemon?.['ai-1'], {
  atk: 0, def: 0, spa: 2, spd: 0, spe: -1, acc: 0, eva: 0,
});
assert.deepEqual(transformResolution.movesByPokemon?.['ai-1']?.map(candidate => [candidate.name, candidate.pp, candidate.maxPP]), [
  ['Flamethrower', 5, 5], ['Protect', 5, 5],
]);
const transformNoAbility = state();
transformNoAbility.sides.ai.party[0].moves = [{name: 'Transform', pp: 1, maxPP: 1}];
delete transformNoAbility.sides.player.party[0].ability;
const transformNoAbilityAction = enumerateMoveActions(transformNoAbility)[0];
const transformNoAbilityResolution = deriveMoveResolution(
  transformNoAbility, transformNoAbilityAction, {hit: true},
);
assert.deepEqual(transformNoAbilityResolution.noAbilityByPokemon, {'ai-1': true});
assert.equal(applyAction(transformNoAbility, transformNoAbilityAction, transformNoAbilityResolution)
  .sides.ai.party[0].abilityOverride, null);
const goodAsGoldTransformGen8 = {...transformState, generation: 8 as const};
goodAsGoldTransformGen8.sides.player.party[0].ability = 'Good as Gold';
assert.equal(deriveMoveResolution(goodAsGoldTransformGen8, move(goodAsGoldTransformGen8, 'Transform'), {hit: true}).hit, true);
const goodAsGoldTransformGen9 = {...goodAsGoldTransformGen8, generation: 9 as const};
assert.equal(deriveMoveResolution(goodAsGoldTransformGen9, move(goodAsGoldTransformGen9, 'Transform'), {hit: true}).hit, false);
const transformed = applyAction(transformState, transformAction, transformResolution);
assert.equal(transformed.sides.ai.party[0].speciesOverride, 'Charizard');
assert.equal(transformed.sides.ai.party[0].moves[0].name, 'Flamethrower');
assert.equal(transformed.sides.ai.party[0].originalMoves?.[0].name, 'Transform');

const transformedSwitch = transformed;
addReplacement(transformedSwitch, 'ai', {
  id: 'ai-2', species: 'Bulbasaur', level: 100, hp: {current: 100, max: 100}, moves: [],
});
const restored = applySwitchAction(transformedSwitch, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2',
});
assert.equal(restored.sides.ai.party[0].speciesOverride, undefined);
assert.equal(restored.sides.ai.party[0].abilityOverride, undefined);
assert.equal(restored.sides.ai.party[0].statOverrides, undefined);
assert.deepEqual(restored.sides.ai.party[0].moves, [{name: 'Transform', pp: 0, maxPP: 1, timesUsed: 1}]);

const statState = state();
statState.sides.ai.party[0].moves = [{name: 'Power Trick'}];
const statRaw = getRawStats(Calc.Generations.get(statState.generation), statState.sides.ai.party[0]);
const statResolution = deriveMoveResolution(statState, enumerateMoveActions(statState)[0]);
assert.deepEqual(statResolution.statOverridesByPokemon, {
  'ai-1': {atk: statRaw.def, def: statRaw.atk},
});
const statNext = applyAction(statState, enumerateMoveActions(statState)[0], statResolution);
assert.equal(statNext.sides.ai.party[0].statOverrides?.atk, statRaw.def);

const accuracyState = state();
accuracyState.sides.ai.party[0].ability = 'No Guard';
assert.equal(getEffectiveMoveAccuracy(accuracyState, move(accuracyState, 'Tackle'), 70).accuracy, true);
const battleArmorGen2 = {...state(), generation: 2 as const};
battleArmorGen2.sides.player.party[0].ability = 'Battle Armor';
assert.equal(calculateActionFacts(battleArmorGen2, move(battleArmorGen2, 'Aeroblast')).isHighCrit, true);
const battleArmorGen3 = {...battleArmorGen2, generation: 3 as const};
assert.equal(calculateActionFacts(battleArmorGen3, move(battleArmorGen3, 'Aeroblast')).isHighCrit, false);
assert.ok(calculateActionFacts(state(), move(state(), 'Thunderbolt')).damage);

const typeState = state();
typeState.sides.ai.party[0].species = 'Charizard';
assert.deepEqual(getEffectiveTypes(typeState, 'ai-1'), ['Fire', 'Flying']);
assert.equal(getEffectiveSpecies(typeState.sides.ai.party[0]), 'Charizard');

const invalidType = state();
invalidType.sides.ai.party[0].typeOverride = ['Normal', 'Normal'];
assert.throws(() => validateBattleState(invalidType), /duplicate types/);
const invalidMoveCategory = state();
invalidMoveCategory.sides.ai.party[0].moves = [{name: 'Custom', category: 'Hybrid' as never}];
assert.throws(() => validateBattleState(invalidMoveCategory), /category must be/);
const invalidMoveType = state();
invalidMoveType.sides.ai.party[0].moves = [{name: 'Custom', type: ''}];
assert.throws(() => validateBattleState(invalidMoveType), /type must be/);
const invalidMoveFlag = state();
invalidMoveFlag.sides.ai.party[0].moves = [{name: 'Custom', sound: 'yes' as never}];
assert.throws(() => validateBattleState(invalidMoveFlag), /sound must be boolean/);
const invalidHistory = state();
invalidHistory.lastMoveUsedByPokemon = {'missing': 'Tackle'};
assert.throws(() => validateBattleState(invalidHistory), /lastMoveUsedByPokemon/);
const invalidDamagingHistory = state();
invalidDamagingHistory.lastDamagingMoveByPokemon = {'missing': 'Tackle'};
assert.throws(() => validateBattleState(invalidDamagingHistory), /lastDamagingMoveByPokemon/);
const invalidDamageTakenHistory = state();
invalidDamageTakenHistory.lastDamageTakenByPokemon = {
  'ai-1': {damage: 12, category: 'Physical', sourceId: 'missing', moveName: 'Tackle', turn: 1},
};
assert.throws(() => validateBattleState(invalidDamageTakenHistory), /lastDamageTakenByPokemon/);
const invalidSelectedMove = state();
invalidSelectedMove.selectedMoveByPokemon = {'missing': {moveName: 'Tackle'}};
assert.throws(() => validateBattleState(invalidSelectedMove), /selectedMoveByPokemon/);
const invalidTargetHistory = state();
invalidTargetHistory.lastMoveTargetIdsByPokemon = {'ai-1': ['missing']};
assert.throws(() => validateBattleState(invalidTargetHistory), /lastMoveTargetIdsByPokemon/);
const duplicateTargetHistory = state();
duplicateTargetHistory.lastMoveTargetIdsByPokemon = {'ai-1': ['player-1', 'player-1']};
assert.throws(() => validateBattleState(duplicateTargetHistory), /lastMoveTargetIdsByPokemon/);
const invalidFirstTurnOut = state();
invalidFirstTurnOut.sides.ai.party.push({
  id: 'ai-2', species: 'Bulbasaur', level: 100, hp: {current: 100, max: 100}, moves: [],
});
invalidFirstTurnOut.firstTurnOutIds = ['ai-2'];
assert.throws(() => validateBattleState(invalidFirstTurnOut), /firstTurnOutIds/);
const invalidBenchedHistory = state();
invalidBenchedHistory.sides.ai.party.push({
  id: 'ai-2', species: 'Bulbasaur', level: 100, hp: {current: 100, max: 100}, moves: [],
});
invalidBenchedHistory.lastMoveUsedByPokemon = {'ai-2': 'Tackle'};
assert.throws(() => validateBattleState(invalidBenchedHistory), /lastMoveUsedByPokemon/);
const invalidBenchedIntent = state();
invalidBenchedIntent.sides.ai.party.push({
  id: 'ai-2', species: 'Bulbasaur', level: 100, hp: {current: 100, max: 100}, moves: [],
});
invalidBenchedIntent.selectedMoveByPokemon = {'ai-2': {moveName: 'Tackle'}};
assert.throws(() => validateBattleState(invalidBenchedIntent), /selectedMoveByPokemon/);
const invalidSpecies = state();
invalidSpecies.sides.ai.party[0].speciesOverride = '';
assert.throws(() => validateBattleState(invalidSpecies), /speciesOverride/);
const invalidDelayedHealing = state();
invalidDelayedHealing.delayedMoves = [{
  id: 'delayed-invalid-healing', moveName: 'Wish', sourceId: 'ai-1', targetIds: ['player-1'],
  turns: 1, damageByTarget: {}, healingByTarget: {'player-1': {numerator: 0, denominator: 2}},
}];
assert.throws(() => validateBattleState(invalidDelayedHealing), /healing numerator/);
const duplicateDelayedTargets = state();
duplicateDelayedTargets.delayedMoves = [{
  id: 'delayed-duplicate-targets', moveName: 'Wish', sourceId: 'ai-1', targetIds: ['player-1', 'player-1'],
  turns: 1, damageByTarget: {},
}];
assert.throws(() => validateBattleState(duplicateDelayedTargets), /invalid targets/);
const invalidVolatileReference = state();
invalidVolatileReference.sides.ai.party[0].volatile = {
  charge: {moveName: 'Fly', targetIds: ['missing']},
};
assert.throws(() => validateBattleState(invalidVolatileReference), /Charge targets/);
const modeledVolatiles = state();
modeledVolatiles.sides.ai.party[0].volatile = {
  flashFire: {}, grudge: {}, charged: {}, protosynthesis: {}, quarkDrive: {},
  cudChew: {turns: 1, item: 'Sitrus Berry'}, glaiveRush: {turns: 1}, tarShot: {turns: 1},
  throatChop: {turns: 1}, commanding: {sourceId: 'player-1'}, commanded: {sourceId: 'player-1'},
};
assert.doesNotThrow(() => validateBattleState(modeledVolatiles));
const modeledSideProtections = state();
modeledSideProtections.sides.ai.effects = {wideGuard: true, quickGuard: true, matBlock: true};
assert.doesNotThrow(() => validateBattleState(modeledSideProtections));

const bootsEntry = state();
bootsEntry.sides.ai.party.push({
  id: 'ai-2', species: 'Charizard', level: 100,
  hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}], item: 'Heavy-Duty Boots',
});
bootsEntry.sides.ai.effects = {stealthRock: true};
const bootsEntryResolution = deriveSwitchEntryResolution(bootsEntry, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2',
});
assert.equal(bootsEntryResolution.hpDeltaByPokemon, undefined);
bootsEntry.field.magicRoom = true;
const suppressedBootsEntry = deriveSwitchEntryResolution(bootsEntry, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2',
});
assert.ok((suppressedBootsEntry.hpDeltaByPokemon?.['ai-2'] || 0) < 0);
const bootsGen7 = {...bootsEntry, generation: 7 as const};
assert.ok((deriveSwitchEntryResolution(bootsGen7, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2',
}).hpDeltaByPokemon?.['ai-2'] || 0) < 0);
assert.equal(isItemEffectActive(bootsGen7, bootsGen7.sides.ai.party[1]), false);
assert.equal(isItemEffectActive({...bootsEntry, field: {}}, bootsEntry.sides.ai.party[1]), true);

const generationItemProjectionPokemon = {...state().sides.ai.party[0], item: 'Choice Scarf'};
assert.equal(isItemEffectActive({...state(), generation: 3}, generationItemProjectionPokemon), false);
assert.equal(isItemEffectActive({...state(), generation: 4}, generationItemProjectionPokemon), true);
const choiceBandProjectionPokemon = {...generationItemProjectionPokemon, item: 'Choice Band'};
assert.equal(isItemEffectActive({...state(), generation: 2}, choiceBandProjectionPokemon), false);
assert.equal(isItemEffectActive({...state(), generation: 3}, choiceBandProjectionPokemon), true);
const bindingBandProjectionPokemon = {...generationItemProjectionPokemon, item: 'Binding Band'};
assert.equal(isItemEffectActive({...state(), generation: 4}, bindingBandProjectionPokemon), false);
assert.equal(isItemEffectActive({...state(), generation: 5}, bindingBandProjectionPokemon), true);
const leftoversGen1 = {...generationItemProjectionPokemon, item: 'Leftovers'};
assert.equal(isItemEffectActive({...state(), generation: 1}, leftoversGen1), false);
assert.equal(isItemEffectActive({...state(), generation: 2}, leftoversGen1), true);
const assaultVestGen5 = {...generationItemProjectionPokemon, item: 'Assault Vest'};
assert.equal(isItemEffectActive({...state(), generation: 5}, assaultVestGen5), false);
assert.equal(isItemEffectActive({...state(), generation: 6}, assaultVestGen5), true);
const oranBerryGen2 = {...generationItemProjectionPokemon, item: 'Oran Berry'};
assert.equal(isItemAvailable({...state(), generation: 2}, oranBerryGen2.item), false);
assert.equal(isItemAvailable({...state(), generation: 3}, oranBerryGen2.item), true);
assert.equal(isItemEffectActive({...state(), generation: 2}, oranBerryGen2), false);

const klutzState = state();
klutzState.sides.ai.party[0].ability = 'Klutz';
klutzState.sides.ai.party[0].item = 'Leftovers';
assert.equal(isItemEffectActive({...klutzState, generation: 3}, klutzState.sides.ai.party[0]), true);
assert.equal(isItemEffectActive({...klutzState, generation: 4}, klutzState.sides.ai.party[0]), false);

const hazardEntry = state();
hazardEntry.sides.ai.party.push({
  id: 'ai-2', species: 'Rattata', level: 100,
  hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}],
});
hazardEntry.sides.ai.effects = {stealthRock: true, spikes: 1, toxicSpikes: 1, stickyWeb: true};
const hazardEntryResolution = deriveSwitchEntryResolution(hazardEntry, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2',
});
assert.equal(hazardEntryResolution.hpDeltaByPokemon?.['ai-2'], -24);
assert.equal(hazardEntryResolution.statusByPokemon?.['ai-2'], 'psn');
assert.equal(hazardEntryResolution.boostsByPokemon?.['ai-2']?.spe, -1);
const hazardEntryGen3 = {...hazardEntry, generation: 3 as const};
const hazardEntryGen3Resolution = deriveSwitchEntryResolution(hazardEntryGen3, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2',
});
assert.equal(hazardEntryGen3Resolution.hpDeltaByPokemon?.['ai-2'], -12);
assert.equal(hazardEntryGen3Resolution.statusByPokemon, undefined);
assert.equal(hazardEntryGen3Resolution.boostsByPokemon, undefined);
const hazardEntryGen1 = {...hazardEntry, generation: 1 as const};
assert.equal(deriveSwitchEntryResolution(hazardEntryGen1, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2',
}).hpDeltaByPokemon, undefined);

const hospitalityEntry = doublesState();
hospitalityEntry.sides.ai.party.push({
  id: 'ai-3', species: 'Indeedee', level: 100,
  hp: {current: 100, max: 100}, moves: [], ability: 'Hospitality',
});
hospitalityEntry.sides.ai.party[1].hp.current = 40;
const hospitalityAction = {kind: 'switch' as const, actorId: 'ai-1', replacementId: 'ai-3'};
const hospitalityResolution = deriveSwitchEntryResolution(hospitalityEntry, hospitalityAction);
assert.equal(hospitalityResolution.hpDeltaByPokemon?.['ai-2'], 25);
assert.equal(hospitalityResolution.hpDeltaByPokemon?.['ai-3'], undefined);
assert.ok(hospitalityResolution.trace?.notes?.some(note => note.includes('Hospitality')));
const hospitalityNext = applySwitchAction(hospitalityEntry, hospitalityAction);
assert.equal(hospitalityNext.sides.ai.party[1].hp.current, 65);
assert.deepEqual(hospitalityNext.sides.ai.activeIds, ['ai-3', 'ai-2']);
const hospitalityFullHealth = {...hospitalityEntry, sides: {...hospitalityEntry.sides,
  ai: {...hospitalityEntry.sides.ai, party: hospitalityEntry.sides.ai.party.map(pokemon => pokemon.id === 'ai-2'
    ? {...pokemon, hp: {...pokemon.hp, current: pokemon.hp.max}}
    : pokemon)},
}};
assert.equal(deriveSwitchEntryResolution(hospitalityFullHealth, hospitalityAction).hpDeltaByPokemon, undefined);
const hospitalityFaintedAlly = {...hospitalityEntry, sides: {...hospitalityEntry.sides,
  ai: {...hospitalityEntry.sides.ai, party: hospitalityEntry.sides.ai.party.map(pokemon => pokemon.id === 'ai-2'
    ? {...pokemon, hp: {...pokemon.hp, current: 0}}
    : pokemon)},
}};
assert.equal(deriveSwitchEntryResolution(hospitalityFaintedAlly, hospitalityAction).hpDeltaByPokemon, undefined);
const hospitalitySingles = {...hospitalityEntry, mode: 'Singles' as const};
assert.equal(deriveSwitchEntryResolution(hospitalitySingles, hospitalityAction).hpDeltaByPokemon, undefined);
const hospitalityGen8 = {...hospitalityEntry, generation: 8 as const};
assert.equal(deriveSwitchEntryResolution(hospitalityGen8, hospitalityAction).hpDeltaByPokemon, undefined);
const hospitalitySuppressed = {...hospitalityEntry, sides: {...hospitalityEntry.sides,
  ai: {...hospitalityEntry.sides.ai, party: hospitalityEntry.sides.ai.party.map(pokemon => pokemon.id === 'ai-3'
    ? {...pokemon, abilitySuppressed: true}
    : pokemon)},
}};
assert.equal(deriveSwitchEntryResolution(hospitalitySuppressed, hospitalityAction).hpDeltaByPokemon, undefined);

const commanderEntry = doublesState();
commanderEntry.sides.ai.party[1].species = 'Dondozo';
commanderEntry.sides.ai.party.push({
  id: 'ai-3', species: 'Tatsugiri', level: 100,
  hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}], ability: 'Commander',
});
const commanderAction = {kind: 'switch' as const, actorId: 'ai-1', replacementId: 'ai-3'};
const commanderResolution = deriveSwitchEntryResolution(commanderEntry, commanderAction);
assert.deepEqual(commanderResolution.boostsByPokemon?.['ai-2'], {atk: 2, def: 2, spa: 2, spd: 2, spe: 2});
assert.deepEqual(commanderResolution.volatileByPokemon?.['ai-3']?.commanding, {sourceId: 'ai-2'});
assert.deepEqual(commanderResolution.volatileByPokemon?.['ai-2']?.commanded, {sourceId: 'ai-3'});
const commandedNext = applySwitchAction(commanderEntry, commanderAction);
assert.deepEqual(commandedNext.sides.ai.party[1].boosts, {atk: 2, def: 2, spa: 2, spd: 2, spe: 2});
assert.deepEqual(commandedNext.sides.ai.party[1].volatile?.commanded, {sourceId: 'ai-3'});
assert.deepEqual(commandedNext.sides.ai.party[2].volatile?.commanding, {sourceId: 'ai-2'});
assert.equal(enumerateMoveActions(commandedNext).some(action => action.actorId === 'ai-3'), false);
assert.equal(enumerateSwitchActions(commandedNext).some(action => action.actorId === 'ai-3'), false);
addReplacement(commandedNext, 'ai', {
  id: 'ai-4', species: 'Pikachu', level: 100,
  hp: {current: 100, max: 100}, moves: [],
});
assert.throws(() => applySwitchAction(commandedNext, {
  kind: 'switch', actorId: 'ai-3', replacementId: 'ai-4',
}), /Commander/);
const commanderPhazingAction = {
  kind: 'move' as const, actorId: 'player-1', moveName: 'Roar', targetIds: ['ai-2'],
};
const commanderPhazingResolution = deriveMoveResolution(commandedNext, commanderPhazingAction, {hit: true});
assert.equal(commanderPhazingResolution.forcedSwitchByPokemon?.['ai-2'], undefined);
const commanderReleased = applyDamageAction(commandedNext, {
  kind: 'move', actorId: 'player-1', moveName: 'Tackle', targetIds: ['ai-2'],
}, {'ai-2': 100});
assert.equal(commanderReleased.sides.ai.party[1].volatile?.commanded, undefined);
assert.equal(commanderReleased.sides.ai.party[2].volatile?.commanding, undefined);
const commanderReverseEntry = doublesState();
commanderReverseEntry.sides.ai.party[1].species = 'Tatsugiri';
commanderReverseEntry.sides.ai.party[1].ability = 'Commander';
commanderReverseEntry.sides.ai.party.push({
  id: 'ai-3', species: 'Dondozo', level: 100,
  hp: {current: 100, max: 100}, moves: [],
});
assert.deepEqual(deriveSwitchEntryResolution(commanderReverseEntry, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-3',
}).boostsByPokemon?.['ai-3'], {atk: 2, def: 2, spa: 2, spd: 2, spe: 2});
const commanderSingles = {...commanderEntry, mode: 'Singles' as const};
assert.equal(deriveSwitchEntryResolution(commanderSingles, commanderAction).boostsByPokemon, undefined);
const commanderGen8 = {...commanderEntry, generation: 8 as const, sides: {...commanderEntry.sides,
  ai: {...commanderEntry.sides.ai, party: commanderEntry.sides.ai.party.map(pokemon => ({
    ...pokemon, species: 'Pikachu',
  }))},
}};
assert.equal(deriveSwitchEntryResolution(commanderGen8, commanderAction).boostsByPokemon, undefined);
const commanderWrongSpecies = {...commanderEntry, sides: {...commanderEntry.sides,
  ai: {...commanderEntry.sides.ai, party: commanderEntry.sides.ai.party.map(pokemon => pokemon.id === 'ai-3'
    ? {...pokemon, species: 'Pikachu'}
    : pokemon)},
}};
assert.equal(deriveSwitchEntryResolution(commanderWrongSpecies, commanderAction).boostsByPokemon, undefined);

const costarEntry = doublesState();
costarEntry.sides.ai.party[1].boosts = {atk: 2, def: -1, acc: 1};
costarEntry.sides.ai.party[1].volatile = {focusEnergy: {}, laserFocus: {turns: 1}};
costarEntry.sides.ai.party.push({
  id: 'ai-3', species: 'Pikachu', level: 100,
  hp: {current: 100, max: 100}, moves: [], ability: 'Costar',
});
const costarAction = {kind: 'switch' as const, actorId: 'ai-1', replacementId: 'ai-3'};
const costarResolution = deriveSwitchEntryResolution(costarEntry, costarAction);
assert.deepEqual(costarResolution.setBoostsByPokemon?.['ai-3'], {atk: 2, def: -1, acc: 1});
assert.deepEqual(costarResolution.volatileByPokemon?.['ai-3'], {
  focusEnergy: {}, laserFocus: {turns: 1},
});
const costarNext = applySwitchAction(costarEntry, costarAction);
assert.deepEqual(costarNext.sides.ai.party[2].boosts, {atk: 2, def: -1, acc: 1});
assert.deepEqual(costarNext.sides.ai.party[2].volatile, {
  focusEnergy: {}, laserFocus: {turns: 1},
});
const costarSingles = {...costarEntry, mode: 'Singles' as const};
assert.equal(deriveSwitchEntryResolution(costarSingles, costarAction).setBoostsByPokemon, undefined);
const costarGen8 = {...costarEntry, generation: 8 as const};
assert.equal(deriveSwitchEntryResolution(costarGen8, costarAction).setBoostsByPokemon, undefined);
const costarSuppressed = {...costarEntry, sides: {...costarEntry.sides,
  ai: {...costarEntry.sides.ai, party: costarEntry.sides.ai.party.map(pokemon => pokemon.id === 'ai-3'
    ? {...pokemon, abilitySuppressed: true}
    : pokemon)},
}};
assert.equal(deriveSwitchEntryResolution(costarSuppressed, costarAction).setBoostsByPokemon, undefined);

const droughtEntryGen2 = state();
droughtEntryGen2.sides.ai.party[0].ability = 'Drought';
assert.equal(deriveSwitchEntryResolution({...droughtEntryGen2, generation: 2 as const}, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-1',
}).field, undefined);
assert.equal(deriveSwitchEntryResolution({...droughtEntryGen2, generation: 3 as const}, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-1',
}).field?.weather, 'Sun');
const surgeEntry = state();
surgeEntry.sides.ai.party[0].ability = 'Electric Surge';
assert.equal(deriveSwitchEntryResolution({...surgeEntry, generation: 5 as const}, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-1',
}).field, undefined);
assert.equal(deriveSwitchEntryResolution({...surgeEntry, generation: 6 as const}, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-1',
}).field, undefined);
assert.equal(deriveSwitchEntryResolution({...surgeEntry, generation: 7 as const}, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-1',
}).field?.terrain, 'Electric');
const orichalcumEntry = state();
orichalcumEntry.sides.ai.party[0].ability = 'Orichalcum Pulse';
assert.equal(deriveSwitchEntryResolution({...orichalcumEntry, generation: 8 as const}, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-1',
}).field, undefined);
assert.equal(deriveSwitchEntryResolution(orichalcumEntry, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-1',
}).field?.weather, 'Sun');
const orichalcumSuppressed = {...orichalcumEntry, sides: {...orichalcumEntry.sides,
  ai: {...orichalcumEntry.sides.ai, party: orichalcumEntry.sides.ai.party.map(pokemon => ({
    ...pokemon, abilitySuppressed: true,
  }))},
}};
assert.equal(deriveSwitchEntryResolution(orichalcumSuppressed, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-1',
}).field, undefined);
const hadronEntry = state();
hadronEntry.sides.ai.party[0].ability = 'Hadron Engine';
assert.equal(deriveSwitchEntryResolution({...hadronEntry, generation: 8 as const}, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-1',
}).field, undefined);
assert.equal(deriveSwitchEntryResolution(hadronEntry, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-1',
}).field?.terrain, 'Electric');
const hadronSuppressed = {...hadronEntry, sides: {...hadronEntry.sides,
  ai: {...hadronEntry.sides.ai, party: hadronEntry.sides.ai.party.map(pokemon => ({
    ...pokemon, abilitySuppressed: true,
  }))},
}};
assert.equal(deriveSwitchEntryResolution(hadronSuppressed, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-1',
}).field, undefined);
const windRiderState = state();
windRiderState.sides.ai.party[0].moves = [{name: 'Icy Wind'}];
windRiderState.sides.player.party[0].ability = 'Wind Rider';
const windRiderAction = move(windRiderState, 'Icy Wind');
const windRiderFacts = calculateActionFacts(windRiderState, windRiderAction);
assert.equal(windRiderFacts.damage?.max, 0);
const windRiderResolution = deriveMoveResolution(windRiderState, windRiderAction, {
  hit: true, facts: windRiderFacts,
});
assert.deepEqual(windRiderResolution.boostsByPokemon?.['player-1'], {atk: 1});
const windRiderMoldBreaker = {...windRiderState, sides: {...windRiderState.sides,
  ai: {...windRiderState.sides.ai, party: windRiderState.sides.ai.party.map(pokemon => ({
    ...pokemon, ability: 'Mold Breaker',
  }))},
}};
assert.equal(deriveMoveResolution(windRiderMoldBreaker, windRiderAction, {
  hit: true, facts: calculateActionFacts(windRiderMoldBreaker, windRiderAction),
}).boostsByPokemon?.['player-1']?.atk, undefined);
const windRiderGen8 = {...windRiderState, generation: 8 as const};
assert.equal(deriveMoveResolution(windRiderGen8, windRiderAction, {
  hit: true, facts: calculateActionFacts(windRiderGen8, windRiderAction),
}).boostsByPokemon?.['player-1']?.atk, undefined);
const wellBakedBodyState = state();
wellBakedBodyState.sides.ai.party[0].moves = [{name: 'Flamethrower'}];
wellBakedBodyState.sides.player.party[0].ability = 'Well-Baked Body';
const wellBakedBodyAction = move(wellBakedBodyState, 'Flamethrower');
const wellBakedBodyFacts = calculateActionFacts(wellBakedBodyState, wellBakedBodyAction);
assert.equal(wellBakedBodyFacts.damage?.max, 0);
assert.equal(deriveMoveResolution(wellBakedBodyState, wellBakedBodyAction, {
  hit: true, facts: wellBakedBodyFacts,
}).boostsByPokemon?.['player-1']?.def, 2);
const earthEaterState = state();
earthEaterState.sides.ai.party[0].moves = [{name: 'Earthquake'}];
earthEaterState.sides.player.party[0].ability = 'Earth Eater';
earthEaterState.sides.player.party[0].hp.current = 40;
const earthEaterAction = move(earthEaterState, 'Earthquake');
const earthEaterFacts = calculateActionFacts(earthEaterState, earthEaterAction);
assert.equal(earthEaterFacts.damage?.max, 0);
assert.equal(deriveMoveResolution(earthEaterState, earthEaterAction, {
  hit: true, facts: earthEaterFacts,
}).hpDeltaByPokemon?.['player-1'], 25);
const electromorphosisState = state();
electromorphosisState.sides.ai.party[0].moves = [{name: 'Tackle'}];
electromorphosisState.sides.player.party[0].ability = 'Electromorphosis';
const electromorphosisAction = move(electromorphosisState, 'Tackle');
const electromorphosisFacts = calculateActionFacts(electromorphosisState, electromorphosisAction);
assert.ok((electromorphosisFacts.damage?.max || 0) > 0);
const electromorphosisResolution = deriveMoveResolution(electromorphosisState, electromorphosisAction, {
  hit: true, facts: electromorphosisFacts,
});
assert.deepEqual(electromorphosisResolution.volatileByPokemon?.['player-1']?.charged, {});
const electromorphosisSubstitute = {...electromorphosisState, sides: {...electromorphosisState.sides,
  player: {...electromorphosisState.sides.player, party: electromorphosisState.sides.player.party.map(pokemon => ({
    ...pokemon, substituteHp: 1000,
  }))},
}};
const electromorphosisSubstituteAction = move(electromorphosisSubstitute, 'Tackle');
assert.equal(deriveMoveResolution(electromorphosisSubstitute, electromorphosisSubstituteAction, {
  hit: true, facts: calculateActionFacts(electromorphosisSubstitute, electromorphosisSubstituteAction),
}).volatileByPokemon, undefined);
const electromorphosisCharged = applyAction(
  electromorphosisState, electromorphosisAction, electromorphosisResolution,
);
const electromorphosisThunderbolt: MoveAction = {
  kind: 'move', actorId: 'player-1', moveName: 'Thunderbolt', targetIds: ['ai-1'],
};
const electromorphosisChargedFacts = calculateActionFacts(electromorphosisCharged, electromorphosisThunderbolt);
const electromorphosisUncharged = {...electromorphosisCharged, sides: {...electromorphosisCharged.sides,
  player: {...electromorphosisCharged.sides.player, party: electromorphosisCharged.sides.player.party.map(pokemon => ({
    ...pokemon, volatile: undefined,
  }))},
}};
const electromorphosisUnchargedFacts = calculateActionFacts(electromorphosisUncharged, electromorphosisThunderbolt);
assert.ok((electromorphosisChargedFacts.damage?.max || 0) > (electromorphosisUnchargedFacts.damage?.max || 0));
const electromorphosisConsumed = deriveMoveResolution(electromorphosisCharged, electromorphosisThunderbolt, {
  hit: true, facts: electromorphosisChargedFacts,
});
assert.equal(electromorphosisConsumed.volatileByPokemon?.['player-1']?.charged, null);
const electromorphosisGen8 = {...electromorphosisState, generation: 8 as const};
assert.equal(deriveMoveResolution(electromorphosisGen8, electromorphosisAction, {
  hit: true, facts: calculateActionFacts(electromorphosisGen8, electromorphosisAction),
}).volatileByPokemon, undefined);
const electromorphosisSuppressed = {...electromorphosisState, sides: {...electromorphosisState.sides,
  player: {...electromorphosisState.sides.player, party: electromorphosisState.sides.player.party.map(pokemon => ({
    ...pokemon, abilitySuppressed: true,
  }))},
}};
assert.equal(deriveMoveResolution(electromorphosisSuppressed, electromorphosisAction, {
  hit: true, facts: calculateActionFacts(electromorphosisSuppressed, electromorphosisAction),
}).volatileByPokemon, undefined);
const windPowerState = state();
windPowerState.sides.ai.party[0].moves = [{name: 'Icy Wind'}];
windPowerState.sides.player.party[0].ability = 'Wind Power';
const windPowerAction = move(windPowerState, 'Icy Wind');
const windPowerFacts = calculateActionFacts(windPowerState, windPowerAction);
assert.ok((windPowerFacts.damage?.max || 0) > 0);
const windPowerResolution = deriveMoveResolution(windPowerState, windPowerAction, {
  hit: true, facts: windPowerFacts,
});
assert.deepEqual(windPowerResolution.volatileByPokemon?.['player-1']?.charged, {});
const windPowerSubstitute = {...windPowerState, sides: {...windPowerState.sides,
  player: {...windPowerState.sides.player, party: windPowerState.sides.player.party.map(pokemon => ({
    ...pokemon, substituteHp: 1000,
  }))},
}};
const windPowerSubstituteAction = move(windPowerSubstitute, 'Icy Wind');
assert.equal(deriveMoveResolution(windPowerSubstitute, windPowerSubstituteAction, {
  hit: true, facts: calculateActionFacts(windPowerSubstitute, windPowerSubstituteAction),
}).volatileByPokemon, undefined);
const windPowerCharged = applyAction(windPowerState, windPowerAction, windPowerResolution);
const windPowerThunderbolt: MoveAction = {
  kind: 'move', actorId: 'player-1', moveName: 'Thunderbolt', targetIds: ['ai-1'],
};
const windPowerChargedFacts = calculateActionFacts(windPowerCharged, windPowerThunderbolt);
const windPowerUncharged = {...windPowerCharged, sides: {...windPowerCharged.sides,
  player: {...windPowerCharged.sides.player, party: windPowerCharged.sides.player.party.map(pokemon => ({
    ...pokemon, volatile: undefined,
  }))},
}};
const windPowerUnchargedFacts = calculateActionFacts(windPowerUncharged, windPowerThunderbolt);
assert.ok((windPowerChargedFacts.damage?.max || 0) > (windPowerUnchargedFacts.damage?.max || 0));
assert.equal(deriveMoveResolution(windPowerCharged, windPowerThunderbolt, {
  hit: true, facts: windPowerChargedFacts,
}).volatileByPokemon?.['player-1']?.charged, null);
const windPowerMoldBreaker = {...windPowerState, sides: {...windPowerState.sides,
  ai: {...windPowerState.sides.ai, party: windPowerState.sides.ai.party.map(pokemon => ({
    ...pokemon, ability: 'Mold Breaker',
  }))},
}};
assert.equal(deriveMoveResolution(windPowerMoldBreaker, windPowerAction, {
  hit: true, facts: calculateActionFacts(windPowerMoldBreaker, windPowerAction),
}).volatileByPokemon?.['player-1']?.charged, undefined);
const windPowerGen8 = {...windPowerState, generation: 8 as const};
assert.equal(deriveMoveResolution(windPowerGen8, windPowerAction, {
  hit: true, facts: calculateActionFacts(windPowerGen8, windPowerAction),
}).volatileByPokemon, undefined);
const windPowerTailwind = state();
windPowerTailwind.sides.ai.party[0].ability = 'Wind Power';
windPowerTailwind.sides.ai.party[0].moves = [{name: 'Tailwind'}];
const windPowerTailwindAction = move(windPowerTailwind, 'Tailwind', []);
const windPowerTailwindResolution = deriveMoveResolution(windPowerTailwind, windPowerTailwindAction, {
  hit: true, facts: calculateActionFacts(windPowerTailwind, windPowerTailwindAction),
});
assert.deepEqual(windPowerTailwindResolution.volatileByPokemon?.['ai-1']?.charged, {});
const windPowerTailwindActive = applyAction(
  windPowerTailwind, windPowerTailwindAction, windPowerTailwindResolution,
);
const windPowerTailwindRefresh = deriveMoveResolution(
  windPowerTailwindActive, windPowerTailwindAction, {
    hit: true, facts: calculateActionFacts(windPowerTailwindActive, windPowerTailwindAction),
  },
);
assert.equal(windPowerTailwindRefresh.volatileByPokemon, undefined);
const opportunistState = state();
opportunistState.sides.ai.party[0].moves = [{name: 'Swords Dance'}];
opportunistState.sides.player.party[0].ability = 'Opportunist';
const opportunistAction = move(opportunistState, 'Swords Dance', ['ai-1']);
const opportunistResolution = deriveMoveResolution(opportunistState, opportunistAction, {
  hit: true, facts: calculateActionFacts(opportunistState, opportunistAction),
});
assert.equal(opportunistResolution.boostsByPokemon?.['ai-1']?.atk, 2);
assert.equal(opportunistResolution.boostsByPokemon?.['player-1']?.atk, 2);
assert.ok(opportunistResolution.trace?.notes?.some(note => note.includes('Opportunist copied')));
const opportunistGen8 = {...opportunistState, generation: 8 as const};
const opportunistGen8Resolution = deriveMoveResolution(opportunistGen8, opportunistAction, {
  hit: true, facts: calculateActionFacts(opportunistGen8, opportunistAction),
});
assert.equal(opportunistGen8Resolution.boostsByPokemon?.['player-1'], undefined);
const opportunistSuppressed = {...opportunistState, sides: {...opportunistState.sides,
  player: {...opportunistState.sides.player, party: opportunistState.sides.player.party.map(pokemon => ({
    ...pokemon, abilitySuppressed: true,
  }))},
}};
assert.equal(deriveMoveResolution(opportunistSuppressed, opportunistAction, {
  hit: true, facts: calculateActionFacts(opportunistSuppressed, opportunistAction),
}).boostsByPokemon?.['player-1'], undefined);
const poisonPuppeteerState = state();
poisonPuppeteerState.sides.ai.party[0].species = 'Pecharunt';
poisonPuppeteerState.sides.ai.party[0].ability = 'Poison Puppeteer';
poisonPuppeteerState.sides.ai.party[0].moves = [{name: 'Toxic'}];
const poisonPuppeteerAction = move(poisonPuppeteerState, 'Toxic');
const poisonPuppeteerResolution = deriveMoveResolution(poisonPuppeteerState, poisonPuppeteerAction, {
  hit: true, random: () => 0, facts: {moveCategory: 'Status', moveType: 'Poison'},
});
assert.equal(poisonPuppeteerResolution.statusByPokemon?.['player-1'], 'tox');
assert.deepEqual(poisonPuppeteerResolution.volatileByPokemon?.['player-1']?.confusion, {turns: 2});
const poisonPuppeteerWrongSpecies = {...poisonPuppeteerState, sides: {...poisonPuppeteerState.sides,
  ai: {...poisonPuppeteerState.sides.ai, party: poisonPuppeteerState.sides.ai.party.map(pokemon => ({
    ...pokemon, species: 'Pikachu',
  }))},
}};
assert.equal(deriveMoveResolution(poisonPuppeteerWrongSpecies, poisonPuppeteerAction, {
  hit: true, random: () => 0,
  facts: {moveCategory: 'Status', moveType: 'Poison'},
}).volatileByPokemon, undefined);
const poisonPuppeteerGen8 = {...poisonPuppeteerState, generation: 8 as const};
assert.equal(deriveMoveResolution(poisonPuppeteerGen8, poisonPuppeteerAction, {
  hit: true, random: () => 0,
  facts: {moveCategory: 'Status', moveType: 'Poison'},
}).volatileByPokemon, undefined);
const poisonPuppeteerSuppressed = {...poisonPuppeteerState, sides: {...poisonPuppeteerState.sides,
  ai: {...poisonPuppeteerState.sides.ai, party: poisonPuppeteerState.sides.ai.party.map(pokemon => ({
    ...pokemon, abilitySuppressed: true,
  }))},
}};
assert.equal(deriveMoveResolution(poisonPuppeteerSuppressed, poisonPuppeteerAction, {
  hit: true, random: () => 0,
  facts: {moveCategory: 'Status', moveType: 'Poison'},
}).volatileByPokemon, undefined);
const seedSowerState = state();
seedSowerState.sides.ai.party[0].moves = [{name: 'Tackle'}];
seedSowerState.sides.player.party[0].ability = 'Seed Sower';
const seedSowerAction = move(seedSowerState, 'Tackle');
const seedSowerFacts = calculateActionFacts(seedSowerState, seedSowerAction);
const seedSowerResolution = deriveMoveResolution(seedSowerState, seedSowerAction, {
  hit: true, facts: seedSowerFacts,
});
assert.equal(seedSowerResolution.field?.terrain, 'Grassy');
assert.equal(seedSowerResolution.fieldDurations?.terrain, 5);
const seedSowerSubstitute = {...seedSowerState, sides: {...seedSowerState.sides,
  player: {...seedSowerState.sides.player, party: seedSowerState.sides.player.party.map(pokemon => ({
    ...pokemon, substituteHp: 1000,
  }))},
}};
const seedSowerSubstituteAction = move(seedSowerSubstitute, 'Tackle');
assert.equal(deriveMoveResolution(seedSowerSubstitute, seedSowerSubstituteAction, {
  hit: true, facts: calculateActionFacts(seedSowerSubstitute, seedSowerSubstituteAction),
}).field, undefined);
const seedSowerGen8 = {...seedSowerState, generation: 8 as const};
assert.equal(deriveMoveResolution(seedSowerGen8, seedSowerAction, {
  hit: true, facts: calculateActionFacts(seedSowerGen8, seedSowerAction),
}).field, undefined);
const thermalExchangeState = state();
thermalExchangeState.sides.ai.party[0].moves = [{name: 'Flamethrower'}];
thermalExchangeState.sides.player.party[0].ability = 'Thermal Exchange';
const thermalExchangeAction = move(thermalExchangeState, 'Flamethrower');
const thermalExchangeFacts = calculateActionFacts(thermalExchangeState, thermalExchangeAction);
const thermalExchangeResolution = deriveMoveResolution(thermalExchangeState, thermalExchangeAction, {
  hit: true, facts: thermalExchangeFacts,
});
assert.equal(thermalExchangeResolution.boostsByPokemon?.['player-1']?.atk, 1);
const thermalExchangeGen8 = {...thermalExchangeState, generation: 8 as const};
assert.equal(deriveMoveResolution(thermalExchangeGen8, thermalExchangeAction, {
  hit: true, facts: calculateActionFacts(thermalExchangeGen8, thermalExchangeAction),
}).boostsByPokemon, undefined);
const waterAbsorbState = state();
waterAbsorbState.sides.ai.party[0].moves = [{name: 'Water Gun'}];
waterAbsorbState.sides.player.party[0].ability = 'Water Absorb';
const waterAbsorbAction = move(waterAbsorbState, 'Water Gun');
const waterAbsorbFacts = calculateActionFacts(waterAbsorbState, waterAbsorbAction);
assert.equal(waterAbsorbFacts.damage?.max, 0);
assert.equal(deriveMoveResolution(waterAbsorbState, waterAbsorbAction, {
  hit: true, facts: waterAbsorbFacts,
}).hpDeltaByPokemon?.['player-1'], 25);
const voltAbsorbState = state();
voltAbsorbState.sides.ai.party[0].moves = [{name: 'Thunderbolt'}];
voltAbsorbState.sides.player.party[0].ability = 'Volt Absorb';
const voltAbsorbAction = move(voltAbsorbState, 'Thunderbolt');
const voltAbsorbFacts = calculateActionFacts(voltAbsorbState, voltAbsorbAction);
assert.equal(voltAbsorbFacts.damage?.max, 0);
assert.equal(deriveMoveResolution(voltAbsorbState, voltAbsorbAction, {
  hit: true, facts: voltAbsorbFacts,
}).hpDeltaByPokemon?.['player-1'], 25);
const drySkinState = state();
drySkinState.sides.ai.party[0].moves = [{name: 'Water Gun'}];
drySkinState.sides.player.party[0].ability = 'Dry Skin';
const drySkinAction = move(drySkinState, 'Water Gun');
const drySkinFacts = calculateActionFacts(drySkinState, drySkinAction);
assert.equal(drySkinFacts.damage?.max, 0);
assert.equal(deriveMoveResolution(drySkinState, drySkinAction, {
  hit: true, facts: drySkinFacts,
}).hpDeltaByPokemon?.['player-1'], 25);
const lightningRodState = {...state(), generation: 5 as const};
lightningRodState.sides.ai.party[0].moves = [{name: 'Thunderbolt'}];
lightningRodState.sides.player.party[0].ability = 'Lightning Rod';
const lightningRodAction = move(lightningRodState, 'Thunderbolt');
const lightningRodFacts = calculateActionFacts(lightningRodState, lightningRodAction);
assert.equal(lightningRodFacts.damage?.max, 0);
assert.equal(deriveMoveResolution(lightningRodState, lightningRodAction, {
  hit: true, facts: lightningRodFacts,
}).boostsByPokemon?.['player-1']?.spa, 1);
const stormDrainState = {...state(), generation: 5 as const};
stormDrainState.sides.ai.party[0].moves = [{name: 'Water Gun'}];
stormDrainState.sides.player.party[0].ability = 'Storm Drain';
const stormDrainAction = move(stormDrainState, 'Water Gun');
const stormDrainFacts = calculateActionFacts(stormDrainState, stormDrainAction);
assert.equal(stormDrainFacts.damage?.max, 0);
assert.equal(deriveMoveResolution(stormDrainState, stormDrainAction, {
  hit: true, facts: stormDrainFacts,
}).boostsByPokemon?.['player-1']?.spa, 1);
const flashFireState = state();
flashFireState.sides.ai.party[0].moves = [{name: 'Flamethrower'}];
flashFireState.sides.player.party[0].ability = 'Flash Fire';
const flashFireAction = move(flashFireState, 'Flamethrower');
const flashFireFacts = calculateActionFacts(flashFireState, flashFireAction);
assert.equal(flashFireFacts.damage?.max, 0);
const flashFireResolution = deriveMoveResolution(flashFireState, flashFireAction, {
  hit: true, facts: flashFireFacts,
});
assert.deepEqual(flashFireResolution.volatileByPokemon?.['player-1']?.flashFire, {});
const flashFireActivated = applyAction(flashFireState, flashFireAction, flashFireResolution);
const flashFireAttacker = state();
flashFireAttacker.sides.ai.party[0].ability = 'Flash Fire';
flashFireAttacker.sides.ai.party[0].moves = [{name: 'Flamethrower'}];
flashFireAttacker.sides.ai.party[0].volatile = {flashFire: {}};
const flashFireInactive = {...flashFireAttacker, sides: {...flashFireAttacker.sides,
  ai: {...flashFireAttacker.sides.ai, party: flashFireAttacker.sides.ai.party.map(pokemon => ({
    ...pokemon, volatile: undefined,
  }))},
}};
assert.ok(
  (calculateActionFacts(flashFireAttacker, move(flashFireAttacker, 'Flamethrower')).damage?.max || 0) >
  (calculateActionFacts(flashFireInactive, move(flashFireInactive, 'Flamethrower')).damage?.max || 0),
);
const flashFireMoldBreaker = {...flashFireState, sides: {...flashFireState.sides,
  ai: {...flashFireState.sides.ai, party: flashFireState.sides.ai.party.map(pokemon => ({
    ...pokemon, ability: 'Mold Breaker',
  }))},
}};
assert.equal(deriveMoveResolution(flashFireMoldBreaker, flashFireAction, {
  hit: true, facts: calculateActionFacts(flashFireMoldBreaker, flashFireAction),
}).volatileByPokemon, undefined);
const flashFireGen2 = {...flashFireState, generation: 2 as const};
assert.equal(deriveMoveResolution(flashFireGen2, flashFireAction, {
  hit: true, facts: calculateActionFacts(flashFireGen2, flashFireAction),
}).volatileByPokemon, undefined);
assert.deepEqual(flashFireActivated.sides.player.party[0].volatile?.flashFire, {});
addReplacement(flashFireActivated, 'player', {
  id: 'player-2', species: 'Rattata', level: 100,
  hp: {current: 100, max: 100}, moves: [],
});
const flashFireSwitched = applySwitchAction(flashFireActivated, {
  kind: 'switch', actorId: 'player-1', replacementId: 'player-2',
});
assert.equal(flashFireSwitched.sides.player.party.find(pokemon => pokemon.id === 'player-1')?.volatile, undefined);
const gulpingState = {...state(), generation: 8 as const};
gulpingState.sides.ai.party[0].species = 'Cramorant';
gulpingState.sides.ai.party[0].ability = 'Gulp Missile';
gulpingState.sides.ai.party[0].moves = [{name: 'Surf'}, {name: 'Dive'}];
const gulpingAction = move(gulpingState, 'Surf');
const gulpingResolution = deriveMoveResolution(gulpingState, gulpingAction, {
  hit: true, facts: calculateActionFacts(gulpingState, gulpingAction),
});
assert.equal(gulpingResolution.speciesOverrideByPokemon?.['ai-1'], 'Cramorant-Gulping');
const gulpingReady = applyAction(gulpingState, gulpingAction, gulpingResolution);
const gulpingIncoming: MoveAction = {
  kind: 'move', actorId: 'player-1', moveName: 'Tackle', targetIds: ['ai-1'],
};
const gulpingResponse = deriveMoveResolution(gulpingReady, gulpingIncoming, {
  hit: true, facts: calculateActionFacts(gulpingReady, gulpingIncoming),
});
assert.equal(gulpingResponse.hpDeltaByPokemon?.['player-1'], -25);
assert.equal(gulpingResponse.boostsByPokemon?.['player-1']?.def, -1);
assert.equal(gulpingResponse.speciesOverrideByPokemon?.['ai-1'], null);
const gulpingMoldBreaker = {...gulpingReady, sides: {...gulpingReady.sides,
  player: {...gulpingReady.sides.player, party: gulpingReady.sides.player.party.map(pokemon => ({
    ...pokemon, ability: 'Mold Breaker',
  }))},
}};
const gulpingMoldBreakerResponse = deriveMoveResolution(gulpingMoldBreaker, gulpingIncoming, {
  hit: true, facts: calculateActionFacts(gulpingMoldBreaker, gulpingIncoming),
});
assert.equal(gulpingMoldBreakerResponse.hpDeltaByPokemon?.['player-1'], -25);
assert.equal(gulpingMoldBreakerResponse.boostsByPokemon?.['player-1']?.def, -1);
const gulpingMagicGuard = {...gulpingReady, sides: {...gulpingReady.sides,
  player: {...gulpingReady.sides.player, party: gulpingReady.sides.player.party.map(pokemon => ({
    ...pokemon, ability: 'Magic Guard',
  }))},
}};
const gulpingMagicGuardResponse = deriveMoveResolution(gulpingMagicGuard, gulpingIncoming, {
  hit: true, facts: calculateActionFacts(gulpingMagicGuard, gulpingIncoming),
});
assert.equal(gulpingMagicGuardResponse.hpDeltaByPokemon, undefined);
assert.equal(gulpingMagicGuardResponse.boostsByPokemon?.['player-1']?.def, -1);
const gorgingState = {...gulpingState, sides: {...gulpingState.sides,
  ai: {...gulpingState.sides.ai, party: gulpingState.sides.ai.party.map(pokemon => ({
    ...pokemon, hp: {current: 40, max: 100},
  }))},
  player: {...gulpingState.sides.player, party: gulpingState.sides.player.party.map(pokemon => ({
    ...pokemon, hp: {current: 1000, max: 1000},
  }))},
}};
const gorgingAction = move(gorgingState, 'Surf');
const gorgingResolution = deriveMoveResolution(gorgingState, gorgingAction, {
  hit: true, facts: calculateActionFacts(gorgingState, gorgingAction),
});
assert.equal(gorgingResolution.speciesOverrideByPokemon?.['ai-1'], 'Cramorant-Gorging');
const gorgingReady = applyAction(gorgingState, gorgingAction, gorgingResolution);
gorgingReady.sides.player.party[0].hp = {current: 100, max: 100};
const gorgingResponse = deriveMoveResolution(gorgingReady, gulpingIncoming, {
  hit: true, facts: calculateActionFacts(gorgingReady, gulpingIncoming),
});
assert.equal(gorgingResponse.hpDeltaByPokemon?.['player-1'], -25);
assert.equal(gorgingResponse.statusByPokemon?.['player-1'], 'par');
assert.equal(gorgingResponse.speciesOverrideByPokemon?.['ai-1'], null);
const diveAction: MoveAction = {...gulpingAction, moveName: 'Dive'};
assert.equal(deriveMoveResolution(gulpingState, diveAction, {
  hit: true, facts: calculateActionFacts(gulpingState, diveAction),
}).speciesOverrideByPokemon?.['ai-1'], 'Cramorant-Gulping');
assert.equal(deriveMoveResolution(gulpingState, gulpingAction, {
  hit: false,
}).speciesOverrideByPokemon, undefined);
const gulpingGen7 = {...gulpingState, generation: 7 as const};
assert.equal(deriveMoveResolution(gulpingGen7, gulpingAction, {
  hit: true,
}).speciesOverrideByPokemon, undefined);
const wellBakedBodyMoldBreaker = {...wellBakedBodyState, sides: {...wellBakedBodyState.sides,
  ai: {...wellBakedBodyState.sides.ai, party: wellBakedBodyState.sides.ai.party.map(pokemon => ({
    ...pokemon, ability: 'Mold Breaker',
  }))},
}};
const wellBakedBodyMoldBreakerAction = move(wellBakedBodyMoldBreaker, 'Flamethrower');
assert.equal(deriveMoveResolution(wellBakedBodyMoldBreaker, wellBakedBodyMoldBreakerAction, {
  hit: true, facts: calculateActionFacts(wellBakedBodyMoldBreaker, wellBakedBodyMoldBreakerAction),
}).boostsByPokemon?.['player-1']?.def, undefined);

const intimidateEntry = state();
intimidateEntry.sides.ai.party.push({
  id: 'ai-2', species: 'Bulbasaur', level: 100,
  hp: {current: 100, max: 100}, moves: [], ability: 'Intimidate',
});
intimidateEntry.sides.player.party[0].boosts = {atk: 0};
intimidateEntry.sides.player.party[0].ability = 'White Smoke';
assert.equal(deriveSwitchEntryResolution({...intimidateEntry, generation: 2 as const}, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2',
}).boostsByPokemon, undefined);
assert.equal(deriveSwitchEntryResolution({...intimidateEntry, generation: 3 as const}, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2',
}).boostsByPokemon, undefined);
intimidateEntry.sides.player.party[0].ability = 'Hyper Cutter';
assert.equal(deriveSwitchEntryResolution({...intimidateEntry, generation: 3 as const}, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2',
}).boostsByPokemon, undefined);
intimidateEntry.sides.player.party[0].ability = undefined;
assert.equal(deriveSwitchEntryResolution({...intimidateEntry, generation: 3 as const}, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2',
}).boostsByPokemon?.['player-1']?.atk, -1);
intimidateEntry.sides.player.party[0].item = 'Adrenaline Orb';
const adrenalineOrbResolution = deriveSwitchEntryResolution({...intimidateEntry, generation: 7 as const}, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2',
});
assert.equal(adrenalineOrbResolution.boostsByPokemon?.['player-1']?.spe, 1);
assert.equal(adrenalineOrbResolution.itemByPokemon?.['player-1'], null);
assert.equal(adrenalineOrbResolution.consumedItemByPokemon?.['player-1'], 'Adrenaline Orb');
const adrenalineOrbGen6 = deriveSwitchEntryResolution({...intimidateEntry, generation: 6 as const}, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2',
});
assert.equal(adrenalineOrbGen6.boostsByPokemon?.['player-1']?.spe, undefined);
const adrenalineOrbMagicRoom = {...intimidateEntry, generation: 9 as const, field: {magicRoom: true}};
assert.equal(deriveSwitchEntryResolution(adrenalineOrbMagicRoom, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2',
}).boostsByPokemon?.['player-1']?.spe, undefined);
const syrupEntry = state();
syrupEntry.sides.ai.party.push({
  id: 'ai-2', species: 'Pikachu', level: 100,
  hp: {current: 100, max: 100}, moves: [], ability: 'Supersweet Syrup',
});
syrupEntry.sides.player.party[0].boosts = {eva: 0};
const syrupResolution = deriveSwitchEntryResolution(syrupEntry, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2',
});
assert.equal(syrupResolution.boostsByPokemon?.['player-1']?.eva, -1);
assert.equal(syrupResolution.syrupTriggeredByPokemon?.['ai-2'], true);
const syrupApplied = applySwitchAction(syrupEntry, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2',
});
assert.equal(syrupApplied.sides.ai.party[1].syrupTriggered, true);
const syrupAlreadyTriggered = {...syrupEntry, sides: {...syrupEntry.sides,
  ai: {...syrupEntry.sides.ai, party: syrupEntry.sides.ai.party.map(pokemon => pokemon.id === 'ai-2'
    ? {...pokemon, syrupTriggered: true}
    : pokemon)},
}};
assert.equal(deriveSwitchEntryResolution(syrupAlreadyTriggered, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2',
}).syrupTriggeredByPokemon, undefined);
const syrupSubstitute = {...syrupEntry, sides: {...syrupEntry.sides,
  player: {...syrupEntry.sides.player, party: syrupEntry.sides.player.party.map(pokemon => ({
    ...pokemon, substituteHp: 10,
  }))},
}};
const syrupSubstituteResolution = deriveSwitchEntryResolution(syrupSubstitute, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2',
});
assert.equal(syrupSubstituteResolution.boostsByPokemon, undefined);
assert.equal(syrupSubstituteResolution.syrupTriggeredByPokemon?.['ai-2'], true);
assert.equal(deriveSwitchEntryResolution({...syrupEntry, generation: 8 as const}, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2',
}).syrupTriggeredByPokemon, undefined);
const syrupSuppressed = {...syrupEntry, sides: {...syrupEntry.sides,
  ai: {...syrupEntry.sides.ai, party: syrupEntry.sides.ai.party.map(pokemon => ({
    ...pokemon, abilitySuppressed: true,
  }))},
}};
assert.equal(deriveSwitchEntryResolution(syrupSuppressed, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2',
}).syrupTriggeredByPokemon, undefined);
const curiousMedicineEntry = state();
curiousMedicineEntry.mode = 'Doubles';
curiousMedicineEntry.sides.ai.activeIds = ['ai-1', 'ai-2'];
curiousMedicineEntry.sides.ai.party.push({
  id: 'ai-2', species: 'Pikachu', level: 100,
  hp: {current: 100, max: 100}, moves: [], boosts: {atk: 2, eva: -1},
});
curiousMedicineEntry.sides.ai.party.push({
  id: 'ai-3', species: 'Pikachu', level: 100,
  hp: {current: 100, max: 100}, moves: [], ability: 'Curious Medicine',
});
const curiousMedicineResolution = deriveSwitchEntryResolution(curiousMedicineEntry, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-3',
});
assert.deepEqual(curiousMedicineResolution.setBoostsByPokemon?.['ai-2'], {});
const curiousMedicineApplied = applySwitchAction(curiousMedicineEntry, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-3',
});
assert.equal(curiousMedicineApplied.sides.ai.party[1].boosts, undefined);
assert.equal(deriveSwitchEntryResolution({...curiousMedicineEntry, mode: 'Singles'}, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-3',
}).setBoostsByPokemon, undefined);
assert.equal(deriveSwitchEntryResolution({...curiousMedicineEntry, generation: 7 as const}, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-3',
}).setBoostsByPokemon, undefined);
const curiousMedicineSuppressed = {...curiousMedicineEntry, sides: {...curiousMedicineEntry.sides,
  ai: {...curiousMedicineEntry.sides.ai, party: curiousMedicineEntry.sides.ai.party.map(pokemon =>
    pokemon.id === 'ai-3' ? {...pokemon, abilitySuppressed: true} : pokemon)},
}};
assert.equal(deriveSwitchEntryResolution(curiousMedicineSuppressed, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-3',
}).setBoostsByPokemon, undefined);

const boosterEntry = state();
boosterEntry.sides.ai.party.push({
  id: 'ai-2', species: 'Pikachu', level: 100,
  hp: {current: 100, max: 100}, moves: [], ability: 'Protosynthesis', item: 'Booster Energy',
});
const boosterEntryResolution = deriveSwitchEntryResolution(boosterEntry, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2',
});
assert.deepEqual(boosterEntryResolution.volatileByPokemon?.['ai-2'], {protosynthesis: {}});
assert.equal(boosterEntryResolution.itemByPokemon?.['ai-2'], null);
assert.equal(boosterEntryResolution.consumedItemByPokemon?.['ai-2'], 'Booster Energy');
const boosterEntryNext = applySwitchAction(boosterEntry, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2',
});
assert.equal(boosterEntryNext.sides.ai.party[1].item, undefined);
assert.deepEqual(boosterEntryNext.sides.ai.party[1].volatile, {protosynthesis: {}});
assert.equal(boosterEntryNext.sides.ai.party[1].lastConsumedItem, 'Booster Energy');
const boosterSun = {...boosterEntry, field: {weather: 'Sun' as const}};
assert.equal(deriveSwitchEntryResolution(boosterSun, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2',
}).volatileByPokemon, undefined);
assert.equal(deriveSwitchEntryResolution({...boosterEntry, generation: 8 as const}, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2',
}).volatileByPokemon, undefined);
const boosterMagicRoom = {...boosterEntry, field: {magicRoom: true}};
assert.equal(deriveSwitchEntryResolution(boosterMagicRoom, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2',
}).itemByPokemon, undefined);
const quarkEntry = state();
quarkEntry.field.terrain = 'Electric';
quarkEntry.sides.ai.party.push({
  id: 'ai-2', species: 'Pikachu', level: 100,
  hp: {current: 100, max: 100}, moves: [], ability: 'Quark Drive', item: 'Booster Energy',
});
assert.equal(deriveSwitchEntryResolution(quarkEntry, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2',
}).volatileByPokemon, undefined);
const quarkNoTerrain = {...quarkEntry, field: {}};
assert.deepEqual(deriveSwitchEntryResolution(quarkNoTerrain, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2',
}).volatileByPokemon?.['ai-2'], {quarkDrive: {}});
const boosterTerrainEntry = state();
boosterTerrainEntry.mode = 'Doubles';
boosterTerrainEntry.sides.ai.activeIds = ['ai-1', 'ai-2', 'ai-4'];
boosterTerrainEntry.sides.ai.party.push(
  {id: 'ai-2', species: 'Pikachu', level: 100, hp: {current: 100, max: 100},
    moves: [], ability: 'Quark Drive', item: 'Booster Energy'},
  {id: 'ai-3', species: 'Miraidon', level: 100, hp: {current: 100, max: 100},
    moves: [], ability: 'Hadron Engine'},
  {id: 'ai-4', species: 'Flutter Mane', level: 100, hp: {current: 100, max: 100},
    moves: [], ability: 'Protosynthesis', item: 'Booster Energy'},
);
const boosterTerrainEntryResolution = deriveSwitchEntryResolution(boosterTerrainEntry, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-3',
});
assert.deepEqual(boosterTerrainEntryResolution.field, {terrain: 'Electric'});
assert.equal(boosterTerrainEntryResolution.volatileByPokemon?.['ai-2'], undefined);
assert.equal(boosterTerrainEntryResolution.itemByPokemon?.['ai-2'], undefined);
assert.deepEqual(boosterTerrainEntryResolution.volatileByPokemon?.['ai-4'], {protosynthesis: {}});
assert.equal(boosterTerrainEntryResolution.consumedItemByPokemon?.['ai-4'], 'Booster Energy');
const boosterRainMove = state();
boosterRainMove.sides.ai.party[0].moves = [{name: 'Rain Dance'}];
boosterRainMove.sides.player.party[0].ability = 'Protosynthesis';
boosterRainMove.sides.player.party[0].item = 'Booster Energy';
const boosterRainResolution = deriveMoveResolution(boosterRainMove, move(boosterRainMove, 'Rain Dance'), {hit: true});
assert.deepEqual(boosterRainResolution.volatileByPokemon?.['player-1'], {protosynthesis: {}});
assert.equal(boosterRainResolution.itemByPokemon?.['player-1'], null);
const boosterActive = state();
boosterActive.sides.ai.party[0].ability = 'Protosynthesis';
boosterActive.sides.ai.party[0].volatile = {protosynthesis: {}};
const boosterInactive = {...boosterActive, sides: {
  ...boosterActive.sides,
  ai: {...boosterActive.sides.ai, party: [{...boosterActive.sides.ai.party[0], volatile: undefined}]},
}};
assert.ok(getEffectivePokemonSpeed(boosterActive, 'ai-1') > getEffectivePokemonSpeed(boosterInactive, 'ai-1'));
const boosterDamage = state();
boosterDamage.sides.ai.party[0].species = 'Flutter Mane';
boosterDamage.sides.ai.party[0].ability = 'Protosynthesis';
boosterDamage.sides.ai.party[0].volatile = {protosynthesis: {}};
boosterDamage.sides.ai.party[0].moves = [{name: 'Moonblast'}];
const boosterDamageInactive = {...boosterDamage, sides: {
  ...boosterDamage.sides,
  ai: {...boosterDamage.sides.ai, party: [{...boosterDamage.sides.ai.party[0], volatile: undefined}]},
}};
assert.ok(
  (calculateActionFacts(boosterDamage, move(boosterDamage, 'Moonblast')).damage?.min || 0) >
  (calculateActionFacts(boosterDamageInactive, move(boosterDamageInactive, 'Moonblast')).damage?.min || 0),
);

const clearAmuletEntry = {...intimidateEntry, generation: 8 as const};
clearAmuletEntry.sides.player.party[0].ability = undefined;
clearAmuletEntry.sides.player.party[0].item = 'Clear Amulet';
assert.equal(deriveSwitchEntryResolution(clearAmuletEntry, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2',
}).boostsByPokemon?.['player-1']?.atk, -1);
assert.equal(deriveSwitchEntryResolution({...clearAmuletEntry, generation: 9 as const}, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2',
}).boostsByPokemon, undefined);

const clearAmuletMoveState = {...clearAmuletEntry, generation: 8 as const};
clearAmuletMoveState.sides.ai.party[0].moves = [{name: 'Tail Whip'}];
const clearAmuletMoveAction = move(clearAmuletMoveState, 'Tail Whip');
assert.equal(deriveMoveResolution(clearAmuletMoveState, clearAmuletMoveAction, {hit: true, random: () => 0})
  .boostsByPokemon?.['player-1']?.def, -1);
const clearAmuletMoveGen9 = {...clearAmuletMoveState, generation: 9 as const};
assert.equal(deriveMoveResolution(clearAmuletMoveGen9, clearAmuletMoveAction, {hit: true, random: () => 0})
  .boostsByPokemon, undefined);

const contraryMoveGen3 = {...state(), generation: 3 as const};
contraryMoveGen3.sides.player.party[0].ability = 'Contrary';
contraryMoveGen3.sides.ai.party[0].moves = [{name: 'Tail Whip'}];
const contraryMoveAction = move(contraryMoveGen3, 'Tail Whip');
assert.equal(deriveMoveResolution(contraryMoveGen3, contraryMoveAction, {hit: true, random: () => 0})
  .boostsByPokemon?.['player-1']?.def, -1);
const contraryMoveGen4 = {...contraryMoveGen3, generation: 4 as const};
assert.equal(deriveMoveResolution(contraryMoveGen4, contraryMoveAction, {hit: true, random: () => 0})
  .boostsByPokemon?.['player-1']?.def, -1);
const contraryMoveGen5 = {...contraryMoveGen3, generation: 5 as const};
assert.equal(deriveMoveResolution(contraryMoveGen5, contraryMoveAction, {hit: true, random: () => 0})
  .boostsByPokemon?.['player-1']?.def, 1);

const whiteHerbDrop = state();
whiteHerbDrop.sides.ai.party[0].moves = [{name: 'Tail Whip'}];
whiteHerbDrop.sides.player.party[0].item = 'White Herb';
const whiteHerbDropResolution = deriveMoveResolution(whiteHerbDrop, move(whiteHerbDrop, 'Tail Whip'), {
  hit: true, random: () => 0,
});
assert.equal(whiteHerbDropResolution.boostsByPokemon?.['player-1']?.def, -1);
assert.equal(whiteHerbDropResolution.setBoostsByPokemon?.['player-1']?.def, 1);
assert.equal(whiteHerbDropResolution.itemByPokemon?.['player-1'], null);
assert.equal(whiteHerbDropResolution.consumedItemByPokemon?.['player-1'], 'White Herb');
assert.equal(applyAction(whiteHerbDrop, move(whiteHerbDrop, 'Tail Whip'), whiteHerbDropResolution)
  .sides.player.party[0].boosts, undefined);

const whiteHerbExistingDrop = state();
whiteHerbExistingDrop.sides.ai.party[0].moves = [{name: 'Tackle'}];
whiteHerbExistingDrop.sides.player.party[0].item = 'White Herb';
whiteHerbExistingDrop.sides.player.party[0].boosts = {atk: -2};
const whiteHerbExistingDropResolution = deriveMoveResolution(
  whiteHerbExistingDrop, move(whiteHerbExistingDrop, 'Tackle'), {hit: true},
);
assert.equal(whiteHerbExistingDropResolution.setBoostsByPokemon?.['player-1']?.atk, 0);
assert.equal(whiteHerbExistingDropResolution.consumedItemByPokemon?.['player-1'], 'White Herb');
assert.equal(applyAction(whiteHerbExistingDrop, move(whiteHerbExistingDrop, 'Tackle'), whiteHerbExistingDropResolution)
  .sides.player.party[0].boosts, undefined);

const whiteHerbContrary = state();
whiteHerbContrary.sides.ai.party[0].moves = [{name: 'Tail Whip'}];
whiteHerbContrary.sides.player.party[0].ability = 'Contrary';
whiteHerbContrary.sides.player.party[0].item = 'White Herb';
const whiteHerbContraryResolution = deriveMoveResolution(
  whiteHerbContrary, move(whiteHerbContrary, 'Tail Whip'), {hit: true, random: () => 0},
);
assert.equal(whiteHerbContraryResolution.boostsByPokemon?.['player-1']?.def, 1);
assert.equal(whiteHerbContraryResolution.itemByPokemon?.['player-1'], undefined);

const whiteHerbShellSmash = state();
whiteHerbShellSmash.sides.ai.party[0].moves = [{name: 'Shell Smash'}];
whiteHerbShellSmash.sides.ai.party[0].item = 'White Herb';
whiteHerbShellSmash.sides.ai.party[0].boosts = {atk: -6};
const whiteHerbShellSmashAction = move(whiteHerbShellSmash, 'Shell Smash', ['ai-1']);
const whiteHerbShellSmashResolution = deriveMoveResolution(
  whiteHerbShellSmash, whiteHerbShellSmashAction, {hit: true},
);
assert.equal(whiteHerbShellSmashResolution.itemByPokemon?.['ai-1'], null);
assert.equal(whiteHerbShellSmashResolution.setBoostsByPokemon?.['ai-1']?.def, 1);
assert.equal(whiteHerbShellSmashResolution.setBoostsByPokemon?.['ai-1']?.atk, -2);
assert.deepEqual(applyAction(whiteHerbShellSmash, whiteHerbShellSmashAction, whiteHerbShellSmashResolution)
  .sides.ai.party[0].boosts, {spa: 2, spe: 2});

const whiteHerbEntry = state();
addReplacement(whiteHerbEntry, 'ai', {
  id: 'ai-2', species: 'Bulbasaur', level: 100, hp: {current: 100, max: 100}, moves: [],
  item: 'White Herb', boosts: {atk: -2},
});
const whiteHerbEntryResolution = deriveSwitchEntryResolution(whiteHerbEntry, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2', batonPass: true,
});
assert.equal(whiteHerbEntryResolution.setBoostsByPokemon?.['ai-2']?.atk, 0);
assert.equal(whiteHerbEntryResolution.itemByPokemon?.['ai-2'], null);
assert.equal(whiteHerbEntryResolution.consumedItemByPokemon?.['ai-2'], 'White Herb');
const whiteHerbEntryAction = {
  kind: 'switch' as const, actorId: 'ai-1', replacementId: 'ai-2', batonPass: true,
};
assert.doesNotThrow(() => validateSwitchEntryResolution(whiteHerbEntry, whiteHerbEntryAction, whiteHerbEntryResolution));
assert.throws(() => validateSwitchEntryResolution(whiteHerbEntry, whiteHerbEntryAction, {
  unsupported: true,
}), /unsupported property/);

const emptyEndTurnResolution = deriveEndTurnResolution(state());
assert.doesNotThrow(() => validateEndTurnResolution(state(), emptyEndTurnResolution));
assert.throws(() => validateEndTurnResolution(state(), {unsupported: true}), /unsupported property/);

// Keep the runtime resolution boundary synchronized with the canonical model.
const fullMoveResolutionState = state();
const fullMoveResolutionAction = move(fullMoveResolutionState, 'Tackle');
assert.doesNotThrow(() => validateMoveResolution(fullMoveResolutionState, fullMoveResolutionAction, {
  hit: true,
  damageByTarget: {'player-1': 10},
  hitDamageByTarget: {'player-1': [10]},
  hpDeltaByPokemon: {'player-1': -10},
  itemByPokemon: {'player-1': null},
  allySwitchByPokemon: {'ai-1': true},
  itemCorrodedByPokemon: {'player-1': true},
  consumedItemByPokemon: {'player-1': 'Sitrus Berry'},
  substituteHpByPokemon: {'player-1': 1},
  statusByPokemon: {'player-1': ''},
  statusTurnsByPokemon: {'player-1': 0},
  disguiseBrokenByPokemon: {'player-1': true},
  isSaltCureByPokemon: {'player-1': true},
  toxicCounterByPokemon: {'player-1': 1},
  boostsByPokemon: {'player-1': {atk: 1}},
  resetBoostsByPokemon: {'player-1': true},
  setBoostsByPokemon: {'player-1': {def: 1}},
  volatileByPokemon: {'player-1': {confusion: {turns: 1}}},
  typeOverrideByPokemon: {'player-1': ['Fire']},
  typeChangeUsedByPokemon: {'player-1': true},
  abilityOverrideByPokemon: {'player-1': 'Levitate'},
  noAbilityByPokemon: {'player-1': true},
  abilitySuppressedByPokemon: {'player-1': true},
  speciesOverrideByPokemon: {'player-1': 'Charizard'},
  baseStatsOverrideByPokemon: {'player-1': {atk: 100}},
  statOverridesByPokemon: {'player-1': {atk: 200}},
  movesByPokemon: {'player-1': [{name: 'Tackle'}]},
  copyMoveByPokemon: {'ai-1': 'Tackle'},
  calledMoveByPokemon: {'ai-1': 'Tackle'},
  calledMoveModifiersByPokemon: {'ai-1': {powerMultiplier: 1, bypassAccuracy: true}},
  calledMoveTargetIdsByPokemon: {'ai-1': ['player-1']},
  calledMoveExternalByPokemon: {'ai-1': true},
  forcedSwitchByPokemon: {'player-1': true},
  batonPassByPokemon: {'ai-1': true},
  substitutePassByPokemon: {'ai-1': true},
  sideEffectsBySide: {ai: {wideGuard: true}},
  sideEffectDurationsBySide: {ai: {wideGuard: 1}},
  field: {terrain: 'Electric'},
  fieldDurations: {terrain: 1},
  pendingFullHealBySide: {ai: true},
  pendingPledgeBySide: {ai: {
    actorId: 'ai-1', moveName: 'Water Pledge', targetIds: ['player-1'],
  }},
  delayedMoves: [{
    id: 'delayed-1', moveName: 'Future Sight', sourceId: 'ai-1', targetIds: ['player-1'], turns: 1,
    damageByTarget: {'player-1': 10},
  }],
  trace: {source: 'test', notes: ['full resolution shape']},
}));
assert.throws(() => validateMoveResolution(fullMoveResolutionState, fullMoveResolutionAction, {
  sideEffectsBySide: {ai: {unknownProtection: true}},
}), /not a modeled side effect/);
assert.throws(() => validateMoveResolution(fullMoveResolutionState, fullMoveResolutionAction, {
  delayedMoves: [{
    id: 'delayed-invalid', moveName: 'Future Sight', sourceId: 'ai-1', targetIds: ['missing'], turns: 1,
    damageByTarget: {},
  }],
}), /targetIds must contain unique/);
assert.throws(() => validateMoveResolution(fullMoveResolutionState, fullMoveResolutionAction, {
  trace: {source: 'test', unsupported: true},
}), /unsupported property/);
assert.doesNotThrow(() => validateMoveResolution(fullMoveResolutionState, fullMoveResolutionAction, {
  hit: true,
  trace: {
    source: 'battle-engine',
    secondaryRolls: {'player-1:0': 0.42, 'player-1:0:hit1': 0.1, 'player-1:1:hit2': 0.9},
  },
}));
assert.throws(() => validateMoveResolution(fullMoveResolutionState, fullMoveResolutionAction, {
  hit: true,
  trace: {source: 'battle-engine', secondaryRolls: {'missing-1:0': 0.5}},
}), /secondaryRolls references unknown Pokémon missing-1:0/);
assert.throws(() => validateMoveResolution(fullMoveResolutionState, fullMoveResolutionAction, {
  hit: true,
  trace: {source: 'battle-engine', secondaryRolls: {'player-1': 0.5}},
}), /secondaryRolls references unknown Pokémon player-1/);
assert.throws(() => validateMoveResolution(fullMoveResolutionState, fullMoveResolutionAction, {
  typeOverrideByPokemon: {'player-1': ['Fire', 'fire']},
}), /duplicate types/);
assert.throws(() => validateMoveResolution(fullMoveResolutionState, fullMoveResolutionAction, {
  volatileByPokemon: {'player-1': {partiallyTrapped: {sourceId: 'missing', moveName: 'Wrap', turns: 2}}},
}), /sourceId must reference/);

assert.throws(() => resolveMoveAction(state(), move(state(), 'Tackle'), {
  calledMoveByPokemon: {'ai-1': ''},
}), /Called move/);
assert.throws(() => resolveMoveAction(state(), move(state(), 'Tackle'), {
  calledMoveModifiersByPokemon: {'ai-1': {powerMultiplier: 0}},
}), /power multiplier/);
assert.throws(() => resolveMoveAction(state(), move(state(), 'Tackle'), {
  calledMoveTargetIdsByPokemon: {'ai-1': ['missing']},
}), /Called move targets/);
assert.throws(() => validateMoveResolution(state(), move(state(), 'Tackle'), {
  calledMoveTargetIdsByPokemon: {'ai-1': ['missing']},
}), /must reference party Pokemon/);
assert.throws(() => validateMoveResolution(state(), move(state(), 'Tackle'), {
  calledMoveTargetIdsByPokemon: {'ai-1': ['player-1', 'player-1']},
}), /duplicate targets/);

console.log('AI model fixtures passed');
