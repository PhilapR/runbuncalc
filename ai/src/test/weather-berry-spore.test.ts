import assert from 'node:assert/strict';
import {deriveEndTurnResolution} from '../end-turn';
import {BattleState} from '../model';

// D11/D13 falsifiers: weather-ability immunities and Gluttony's confusion-
// berry threshold. Each case was wrong before the constants-audit wave.
function base(ability: string, weather?: 'Sand' | 'Hail', item?: string, hp = 100): BattleState {
  return {
    generation: 8,
    mode: 'Singles',
    turn: 2,
    field: weather ? {weather} : {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Pikachu', level: 100,
        hp: {current: hp, max: 100}, moves: [{name: 'Tackle'}],
        ability, abilityOn: true, ...(item ? {item} : {}),
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Blissey', level: 100,
        hp: {current: 300, max: 300}, moves: [{name: 'Tackle'}],
      }]},
    },
  };
}

function hpDelta(state: BattleState): number {
  const resolution = deriveEndTurnResolution(state, {random: () => 0.5});
  return resolution.hpDeltaByPokemon?.['ai-1'] ?? 0;
}

// Sand Rush takes no sand chip; a no-ability control does.
assert.equal(hpDelta(base('Sand Rush', 'Sand')), 0, 'Sand Rush is sand-immune');
assert.equal(hpDelta(base('Run Away', 'Sand')), -6, 'the control still takes 1/16');
// Ice Body NETS +1/16 in hail (chip exemption plus its heal), not zero.
assert.equal(hpDelta(base('Ice Body', 'Hail', undefined, 50)), 6,
  'Ice Body heals 1/16 in hail instead of netting zero');
assert.equal(hpDelta(base('Snow Cloak', 'Hail')), 0, 'Snow Cloak is hail-immune');
// Gluttony confusion berry: fires at 1/2 HP, a full phase before 1/4.
assert.ok(hpDelta(base('Gluttony', undefined, 'Figy Berry', 40)) >= 50,
  'Gluttony fires the confusion berry at half HP');
assert.equal(hpDelta(base('Run Away', undefined, 'Figy Berry', 40)), 0,
  'without Gluttony the berry waits for 1/4');

console.log('weather-berry-spore: ok');
