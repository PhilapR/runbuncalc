import * as Calc from '@smogon/calc';
import assert from 'node:assert/strict';
import {calculateActionFacts} from '../calc-adapter';
import {blocksSecondaryEffects, isGrounded} from '../eligibility';
import {getEffectiveMoveMetadata, getMoveMaxPP, getMoveMetadata, isMoveAvailable} from '../move-metadata';
import {applyAction, beginNextTurn} from '../transition';

assert.equal(isMoveAvailable('Dazzling Gleam', 5), false);
assert.equal(isMoveAvailable('Dazzling Gleam', 6), true);
assert.equal(isMoveAvailable('Custom Run and Bun Move', 5), true);
import {BattleState} from '../model';

const canonical = getMoveMetadata('Tackle', 9);
assert.equal(getMoveMetadata('Absorb', 9).basePower, 40);
assert.equal(getMoveMetadata('Absorb', 9).basePowerOverride, 40);
assert.equal(getMoveMetadata('Misty Explosion', 9).basePower, 200);
assert.equal(getMoveMetadata('Misty Explosion', 9).basePowerOverride, 200);
assert.equal(canonical.accuracy, 100);
assert.equal(canonical.category, 'Physical');
assert.equal(canonical.source, 'canonical');
assert.equal(canonical.basePowerOverride, undefined);
assert.equal(getMoveMetadata('Swords Dance', 7).snatchable, true);
assert.equal(getMoveMetadata('Swords Dance', 7).dance, true);
assert.equal(getMoveMetadata('Toxic', 7).snatchable, false);
assert.equal(getMoveMetadata('Toxic', 7).reflectable, true);
assert.equal(getMoveMetadata('Swords Dance', 7).target, 'self');
assert.equal(getMoveMetadata('Roar', 9).sound, true);
assert.equal(getMoveMetadata('Tackle', 9).sound, false);
assert.equal(getMoveMetadata('Tackle', 9).contact, true);
assert.equal(getMoveMetadata('Thunderbolt', 9).contact, false);
assert.equal(getMoveMetadata('Absorb', 9).heal, true);
assert.equal(getMoveMetadata('Tackle', 9).heal, false);
assert.equal(getMoveMetadata('Drain Punch', 9).punch, true);
assert.equal(getMoveMetadata('Bite', 9).bite, true);
assert.equal(getMoveMetadata('Aura Sphere', 9).pulse, true);
assert.equal(getMoveMetadata('Psycho Cut', 9).slicing, true);
assert.equal(getMoveMetadata('Bullet Seed', 9).bullet, true);

const accuracyOverlay = getMoveMetadata('Aqua Tail', 9);
assert.equal(accuracyOverlay.accuracy, 95);
assert.equal(accuracyOverlay.source, 'run-and-bun');

const typeOverlay = getMoveMetadata('Covet', 9);
assert.equal(typeOverlay.type, 'Fairy');
assert.equal(typeOverlay.typeOverride, 'Fairy');
assert.equal(typeOverlay.source, 'run-and-bun');

const superFangOverlay = getMoveMetadata('Super Fang', 9);
assert.equal(superFangOverlay.type, 'Dark');

assert.equal(getMoveMetadata('Roost', 9).maxPP, 5);
assert.equal(getMoveMetadata('Screech', 9).maxPP, 5);

const secondaryOverlay = getMoveMetadata('Charge Beam', 9);
assert.equal(secondaryOverlay.secondaryEffects?.[0]?.chance, 100);
assert.equal(secondaryOverlay.source, 'run-and-bun');

const unknownForkMove = getMoveMetadata('Super Fang', 9);
assert.equal(unknownForkMove.accuracy, 100);
assert.equal(unknownForkMove.type, 'Dark');
assert.equal(unknownForkMove.source, 'run-and-bun');

const explicit = getEffectiveMoveMetadata({
  name: 'Tackle',
  basePower: 1,
  type: 'Fire',
  category: 'Special',
  priority: 2,
  target: 'normal',
  contact: true,
  heal: true,
  punch: true,
  bite: true,
  pulse: true,
  slicing: true,
  bullet: true,
  snatchable: true,
  sound: true,
  wind: true,
  dance: true,
  reflectable: false,
  accuracy: 50,
  secondaryEffects: [],
}, 9);
assert.equal(explicit.basePowerOverride, 1);
assert.equal(explicit.type, 'Fire');
assert.equal(explicit.typeOverride, 'Fire');
assert.equal(explicit.category, 'Special');
assert.equal(explicit.priority, 2);
assert.equal(explicit.target, 'normal');
assert.equal(explicit.contact, true);
assert.equal(explicit.heal, true);
assert.equal(explicit.punch, true);
assert.equal(explicit.bite, true);
assert.equal(explicit.pulse, true);
assert.equal(explicit.slicing, true);
assert.equal(explicit.bullet, true);
assert.equal(explicit.snatchable, true);
assert.equal(explicit.sound, true);
assert.equal(explicit.wind, true);
assert.equal(explicit.dance, true);
assert.equal(explicit.reflectable, false);
assert.equal(explicit.accuracy, 50);
assert.deepEqual(explicit.secondaryEffects, []);
assert.equal(explicit.source, 'run-and-bun');

assert.equal(getMoveMaxPP('Tackle', 9), 35);
assert.equal(getMoveMaxPP('Roost', 9), 5);
assert.equal(getMoveMaxPP('not-a-move', 9), undefined);

const adapterState: BattleState = {
  generation: 9,
  mode: 'Singles',
  turn: 1,
  field: {},
  sides: {
    ai: {activeIds: ['ai-1'], party: [{
      id: 'ai-1', species: 'Pikachu', level: 100,
      hp: {current: 100, max: 100}, moves: [{name: 'Misty Explosion'}],
    }]},
    player: {activeIds: ['player-1'], party: [{
      id: 'player-1', species: 'Rattata', level: 100,
      hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}],
    }]},
  },
};
const mistyExplosionAction = {
  kind: 'move' as const, actorId: 'ai-1', moveName: 'Misty Explosion', targetIds: ['player-1'],
};
const mistyExplosionFacts = calculateActionFacts(adapterState, mistyExplosionAction);
const gen = Calc.Generations.get(9);
const attacker = new Calc.Pokemon(gen, 'Pikachu', {level: 100});
const defender = new Calc.Pokemon(gen, 'Rattata', {level: 100});
const calculatorMistyExplosion = Calc.calculate(
  gen, attacker, defender, new Calc.Move(gen, 'Misty Explosion'), new Calc.Field(),
);
const calculatorMaximum = Math.max(...(calculatorMistyExplosion.damage as number[]));
// This assertion used to require the AI to *exceed* the calculator, because the
// overlay carried Run & Bun's 200 base power while the inherited data still said
// 100. That gap was the bug (DATA-01): the browser calculator and the AI reported
// different damage for the same move. Now that both sides carry 200, the two
// surfaces must agree exactly. See `runbun-data.test.ts` for the general gate.
assert.ok(mistyExplosionFacts.damage);
assert.equal(mistyExplosionFacts.damage!.max, calculatorMaximum);

const callerDefinedState: BattleState = {...adapterState, sides: {
  ...adapterState.sides,
  ai: {...adapterState.sides.ai, party: adapterState.sides.ai.party.map(pokemon => ({
    ...pokemon,
    moves: [{name: 'Caller Defined Fire Move', basePower: 80, type: 'Fire', category: 'Special', target: 'normal'}],
  }))},
}};
const callerDefinedFacts = calculateActionFacts(callerDefinedState, {
  kind: 'move', actorId: 'ai-1', moveName: 'Caller Defined Fire Move', targetIds: ['player-1'],
});
assert.equal(callerDefinedFacts.moveType, 'Fire');
assert.equal(callerDefinedFacts.moveCategory, 'Special');
assert.ok((callerDefinedFacts.damage?.max || 0) > 0);

const pledgeBaseFacts = calculateActionFacts(adapterState, {
  kind: 'move', actorId: 'ai-1', moveName: 'Tackle', targetIds: ['player-1'],
});
const pledgeSwampState: BattleState = {
  ...adapterState,
  mode: 'Doubles',
  sides: {
    ...adapterState.sides,
    player: {...adapterState.sides.player, effects: {pledgeSwamp: true}},
  },
};
const pledgeSwampFacts = calculateActionFacts(pledgeSwampState, {
  kind: 'move', actorId: 'ai-1', moveName: 'Tackle', targetIds: ['player-1'],
});
assert.equal(pledgeSwampFacts.opponentSpeeds?.[0], Math.floor((pledgeBaseFacts.opponentSpeeds?.[0] || 0) / 4));
const pledgeAction = {kind: 'move' as const, actorId: 'ai-1', moveName: 'Misty Explosion', targetIds: ['player-1']};
const pledged = applyAction(adapterState, pledgeAction, {
  hit: true,
  sideEffectsBySide: {player: {pledgeSwamp: true}},
  sideEffectDurationsBySide: {player: {pledgeSwamp: 2}},
});
assert.equal(pledged.sides.player.effects?.pledgeSwamp, true);
assert.equal(beginNextTurn(pledged).sides.player.effects?.pledgeSwamp, true);
assert.equal(beginNextTurn(beginNextTurn(pledged)).sides.player.effects?.pledgeSwamp, undefined);

const generationMoveProjection = {...adapterState, generation: 5 as const};
generationMoveProjection.sides.ai.party[0].moves = [{name: 'Tackle'}];
generationMoveProjection.sides.player.party[0].moves = [{name: 'Dazzling Gleam'}];
const generationMoveFacts = calculateActionFacts(generationMoveProjection, {
  kind: 'move', actorId: 'ai-1', moveName: 'Tackle', targetIds: ['player-1'],
});
assert.deepEqual(generationMoveFacts.defenderMoves, []);
assert.equal(generationMoveFacts.defenderHasSpecialMove, false);

const pranksterPriorityState: BattleState = {...adapterState, sides: {
  ...adapterState.sides,
  ai: {...adapterState.sides.ai, party: adapterState.sides.ai.party.map(pokemon => ({
    ...pokemon, ability: 'Prankster', moves: [{name: 'Thunder Wave'}],
  }))},
}};
const pranksterPriorityFacts = calculateActionFacts(pranksterPriorityState, {
  kind: 'move', actorId: 'ai-1', moveName: 'Thunder Wave', targetIds: ['player-1'],
});
assert.equal(pranksterPriorityFacts.priority, 1);
const pranksterPriorityGen4 = calculateActionFacts({...pranksterPriorityState, generation: 4 as const}, {
  kind: 'move', actorId: 'ai-1', moveName: 'Thunder Wave', targetIds: ['player-1'],
});
assert.equal(pranksterPriorityGen4.priority, 0);

adapterState.sides.ai.party[0].moves = [{name: 'Super Fang'}];
const superFangFacts = calculateActionFacts(adapterState, {
  kind: 'move', actorId: 'ai-1', moveName: 'Super Fang', targetIds: ['player-1'],
});
assert.equal(superFangFacts.moveType, 'Dark');

adapterState.sides.ai.party[0].ability = 'Contrary';
adapterState.sides.ai.party[0].abilityOn = false;
adapterState.sides.ai.party[0].moves = [{name: 'Leaf Storm'}];
const suppressedAttackerFacts = calculateActionFacts(adapterState, {
  kind: 'move', actorId: 'ai-1', moveName: 'Leaf Storm', targetIds: ['player-1'],
});
assert.equal(suppressedAttackerFacts.attackerAbility, undefined);
adapterState.sides.ai.party[0].abilityOn = undefined;
adapterState.sides.player.party[0].ability = 'Infiltrator';
adapterState.sides.player.party[0].abilityOn = false;
adapterState.sides.ai.party[0].moves = [{name: 'Tackle'}];
const suppressedDefenderFacts = calculateActionFacts(adapterState, {
  kind: 'move', actorId: 'ai-1', moveName: 'Tackle', targetIds: ['player-1'],
});
assert.equal(suppressedDefenderFacts.defenderAbility, undefined);

const suppressedWaterAbsorb = {...adapterState, field: {}, sides: {
  ...adapterState.sides,
  ai: {...adapterState.sides.ai, party: [{
    ...adapterState.sides.ai.party[0], ability: undefined, abilityOn: undefined,
    moves: [{name: 'Surf'}],
  }]},
  player: {...adapterState.sides.player, party: [{
    ...adapterState.sides.player.party[0], ability: 'Water Absorb', abilityOn: false,
  }]},
}};
const suppressedWaterAbsorbFacts = calculateActionFacts(suppressedWaterAbsorb, {
  kind: 'move', actorId: 'ai-1', moveName: 'Surf', targetIds: ['player-1'],
});
assert.ok((suppressedWaterAbsorbFacts.damage?.max || 0) > 0);
const activeWaterAbsorbFacts = calculateActionFacts({...suppressedWaterAbsorb,
  sides: {...suppressedWaterAbsorb.sides, player: {...suppressedWaterAbsorb.sides.player,
    party: suppressedWaterAbsorb.sides.player.party.map(pokemon => ({...pokemon, abilityOn: undefined})),
  }},
}, {kind: 'move', actorId: 'ai-1', moveName: 'Surf', targetIds: ['player-1']});
assert.equal(activeWaterAbsorbFacts.damage?.max, 0);

adapterState.sides.ai.party[0].ability = undefined;
adapterState.sides.ai.party[0].item = 'Scope Lens';
adapterState.sides.player.party[0].item = 'Leftovers';
const activeItemFacts = calculateActionFacts(adapterState, {
  kind: 'move', actorId: 'ai-1', moveName: 'Tackle', targetIds: ['player-1'],
});
assert.equal(activeItemFacts.attackerItem, 'Scope Lens');
assert.equal(activeItemFacts.attackerCriticalHitStage, 1);

adapterState.field.magicRoom = true;
const magicRoomItemFacts = calculateActionFacts(adapterState, {
  kind: 'move', actorId: 'ai-1', moveName: 'Tackle', targetIds: ['player-1'],
});
assert.equal(magicRoomItemFacts.attackerItem, undefined);
assert.equal(magicRoomItemFacts.defenderItem, undefined);
assert.equal(magicRoomItemFacts.attackerCriticalHitStage, 0);

adapterState.field.magicRoom = false;
adapterState.sides.ai.party[0].ability = 'Klutz';
const klutzItemFacts = calculateActionFacts(adapterState, {
  kind: 'move', actorId: 'ai-1', moveName: 'Tackle', targetIds: ['player-1'],
});
assert.equal(klutzItemFacts.attackerItem, undefined);
assert.equal(klutzItemFacts.attackerCriticalHitStage, 0);

adapterState.sides.ai.party[0].item = 'Macho Brace';
const klutzPowerItemFacts = calculateActionFacts(adapterState, {
  kind: 'move', actorId: 'ai-1', moveName: 'Tackle', targetIds: ['player-1'],
});
assert.equal(klutzPowerItemFacts.attackerItem, 'Macho Brace');

adapterState.sides.ai.party[0].item = 'Life Orb';
const klutzLifeOrbFacts = calculateActionFacts(adapterState, {
  kind: 'move', actorId: 'ai-1', moveName: 'Tackle', targetIds: ['player-1'],
});
adapterState.sides.ai.party[0].item = undefined;
const noItemFacts = calculateActionFacts(adapterState, {
  kind: 'move', actorId: 'ai-1', moveName: 'Tackle', targetIds: ['player-1'],
});
assert.deepEqual(klutzLifeOrbFacts.damage, noItemFacts.damage);

adapterState.sides.ai.party[0].ability = undefined;
adapterState.sides.ai.party[0].item = 'Scope Lens';
adapterState.sides.ai.party[0].volatile = {embargo: {turns: 3}};
const embargoItemFacts = calculateActionFacts(adapterState, {
  kind: 'move', actorId: 'ai-1', moveName: 'Tackle', targetIds: ['player-1'],
});
assert.equal(embargoItemFacts.attackerItem, undefined);
assert.equal(embargoItemFacts.attackerCriticalHitStage, 0);

adapterState.sides.ai.party[0].volatile = undefined;
adapterState.sides.ai.party[0].species = 'Charizard';
adapterState.sides.ai.party[0].item = 'Iron Ball';
adapterState.sides.player.party[0].item = 'Covert Cloak';
assert.equal(isGrounded(adapterState, 'ai-1'), true);
assert.equal(blocksSecondaryEffects(adapterState, 'player-1'), true);
adapterState.field.magicRoom = true;
assert.equal(isGrounded(adapterState, 'ai-1'), false);
assert.equal(blocksSecondaryEffects(adapterState, 'player-1'), false);

console.log('Move metadata fixtures passed');
