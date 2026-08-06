import assert from 'node:assert/strict';
import {calculateActionFacts} from '../calc-adapter';
import {BattleState, MoveAction} from '../model';

function makeState(generation: BattleState['generation'] = 8): BattleState {
  return {
    generation, mode: 'Doubles', turn: 1, field: {},
    sides: {
      ai: {activeIds: ['ai-1', 'ai-2'], party: [
        {id: 'ai-1', species: 'Pikachu', level: 100, hp: {current: 100, max: 100}, moves: []},
        {id: 'ai-2', species: 'Pikachu', level: 100, hp: {current: 100, max: 100}, moves: []},
      ]},
      player: {activeIds: ['player-1', 'player-2'], party: [
        {id: 'player-1', species: 'Rattata', level: 100, hp: {current: 100, max: 100}, moves: []},
        {id: 'player-2', species: 'Rattata', level: 100, hp: {current: 100, max: 100}, moves: []},
      ]},
    },
  };
}

function action(moveName: string): MoveAction {
  return {kind: 'move', actorId: 'ai-1', moveName, targetIds: ['player-1']};
}

function maxDamage(state: BattleState, moveName: string): number {
  return calculateActionFacts(state, action(moveName)).damage?.max || 0;
}

const base = makeState();
const baseTackle = maxDamage(base, 'Tackle');
const battery = makeState();
battery.sides.ai.party[1].ability = 'Battery';
assert.ok(maxDamage(battery, 'Thunderbolt') > maxDamage(base, 'Thunderbolt'));
const batteryGen6 = makeState(6);
batteryGen6.sides.ai.party[1].ability = 'Battery';
assert.equal(maxDamage(batteryGen6, 'Thunderbolt'), maxDamage(makeState(6), 'Thunderbolt'));
const batteryGen7 = makeState(7);
batteryGen7.sides.ai.party[1].ability = 'Battery';
assert.ok(maxDamage(batteryGen7, 'Thunderbolt') > maxDamage(makeState(7), 'Thunderbolt'));
const faintedBattery = makeState();
faintedBattery.sides.ai.party[1].ability = 'Battery';
faintedBattery.sides.ai.party[1].hp.current = 0;
assert.equal(maxDamage(faintedBattery, 'Thunderbolt'), maxDamage(base, 'Thunderbolt'));
const suppressedBattery = makeState();
suppressedBattery.sides.ai.party[1].ability = 'Battery';
suppressedBattery.sides.ai.party[1].abilitySuppressed = true;
assert.equal(maxDamage(suppressedBattery, 'Thunderbolt'), maxDamage(base, 'Thunderbolt'));
const powerSpot = makeState();
powerSpot.sides.ai.party[1].ability = 'Power Spot';
assert.ok(maxDamage(powerSpot, 'Tackle') > baseTackle);
const friendGuard = makeState();
friendGuard.sides.player.party[1].ability = 'Friend Guard';
assert.ok(maxDamage(friendGuard, 'Tackle') < baseTackle);
const faintedFriendGuard = makeState();
faintedFriendGuard.sides.player.party[1].ability = 'Friend Guard';
faintedFriendGuard.sides.player.party[1].hp.current = 0;
assert.equal(maxDamage(faintedFriendGuard, 'Tackle'), baseTackle);
const darkAura = makeState();
darkAura.sides.ai.party[1].ability = 'Dark Aura';
assert.ok(maxDamage(darkAura, 'Dark Pulse') > maxDamage(base, 'Dark Pulse'));
const faintedDarkAura = makeState();
faintedDarkAura.sides.ai.party[1].ability = 'Dark Aura';
faintedDarkAura.sides.ai.party[1].hp.current = 0;
assert.equal(maxDamage(faintedDarkAura, 'Dark Pulse'), maxDamage(base, 'Dark Pulse'));
const flowerGift = makeState();
flowerGift.field.weather = 'Sun';
flowerGift.sides.ai.party[1].ability = 'Flower Gift';
assert.ok(maxDamage(flowerGift, 'Tackle') > baseTackle);
const swordRuin = makeState(9);
swordRuin.sides.ai.party[1].ability = 'Sword of Ruin';
assert.ok(maxDamage(swordRuin, 'Tackle') > maxDamage(makeState(9), 'Tackle'));
const tabletsRuin = makeState(9);
tabletsRuin.sides.player.party[1].ability = 'Tablets of Ruin';
assert.ok(maxDamage(tabletsRuin, 'Tackle') < maxDamage(makeState(9), 'Tackle'));
console.log('Aura fixtures passed');
