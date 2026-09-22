import assert from 'node:assert/strict';
import {BattleState, PokemonState} from '../model';
import {applyLeadEntries} from '../transition';

// The leads' entry effects as a battle opens (applyLeadEntries). Run & Bun
// describes none of these, so each is Generation 8's ("For any mechanic
// that's not described in here, assume Generation 8 mechanics", the hack's
// Mechanic Changes.txt).

function mon(id: string, species: string, ability: string, extra: Partial<PokemonState> = {}): PokemonState {
  return {
    id, species, level: 50, ability,
    hp: {current: 150, max: 150}, moves: [{name: 'Tackle', pp: 35, maxPP: 35}],
    ...extra,
  };
}

function battle(ai: PokemonState[], player: PokemonState[], mode: BattleState['mode'] = 'Doubles'): BattleState {
  return {
    generation: 8, mode, turn: 1, field: {},
    sides: {
      ai: {activeIds: ai.map(entry => entry.id), party: ai},
      player: {activeIds: player.map(entry => entry.id), party: player},
    },
  };
}

// Download: +1 Special Attack when the foes' summed Defense is lower than
// their summed Special Defense, otherwise +1 Attack (a tie raises Attack).
// A fainted foe does not count.
{
  const boostsOf = (state: BattleState) => state.sides.ai.party[0].boosts || {};
  const porygon = () => mon('ai-1', 'Porygon-Z', 'Download');
  // Chansey: base Defense 5, Special Defense 105.
  assert.deepEqual(boostsOf(applyLeadEntries(battle([porygon()], [mon('player-1', 'Chansey', 'Natural Cure')]))),
    {spa: 1}, 'Download vs Chansey raises Special Attack');
  // Cloyster: base Defense 180, Special Defense 45.
  assert.deepEqual(boostsOf(applyLeadEntries(battle([porygon()], [mon('player-1', 'Cloyster', 'Shell Armor')]))),
    {atk: 1}, 'Download vs Cloyster raises Attack');
  // Shuckle: base Defense 230, Special Defense 230 — a tie.
  assert.deepEqual(boostsOf(applyLeadEntries(battle([porygon()], [mon('player-1', 'Shuckle', 'Sturdy')]))),
    {atk: 1}, 'Download on a tie raises Attack');
  // Chansey beside a fainted Cloyster: counted, Cloyster's Defense would
  // outweigh Chansey's Special Defense and flip the raise to Attack.
  assert.deepEqual(boostsOf(applyLeadEntries(battle([porygon()], [
    mon('player-1', 'Chansey', 'Natural Cure'),
    mon('player-2', 'Cloyster', 'Shell Armor', {hp: {current: 0, max: 150}}),
  ]))), {spa: 1}, 'Download ignores a fainted foe');
}

// Lead entry abilities activate fastest first, so the SLOWER weather setter's
// weather is the one that stands — whichever side it is on.
{
  const weatherOf = (ai: PokemonState, player: PokemonState) =>
    applyLeadEntries(battle([ai], [player], 'Singles')).field.weather;
  // Ninetales (base Speed 100) outpaces Politoed (70): Politoed's rain stays.
  assert.equal(weatherOf(mon('ai-1', 'Ninetales', 'Drought'), mon('player-1', 'Politoed', 'Drizzle')), 'Rain');
  assert.equal(weatherOf(mon('ai-1', 'Politoed', 'Drizzle'), mon('player-1', 'Ninetales', 'Drought')), 'Rain');
  // Pelipper (65) outpaces Torkoal (20): Torkoal's sun stays.
  assert.equal(weatherOf(mon('ai-1', 'Pelipper', 'Drizzle'), mon('player-1', 'Torkoal', 'Drought')), 'Sun');
  assert.equal(weatherOf(mon('ai-1', 'Torkoal', 'Drought'), mon('player-1', 'Pelipper', 'Drizzle')), 'Sun');
}

// A speed tie is random in Gen 8: the order comes from the passed stream, so
// both setters can be the last one, and the same stream gives the same field.
{
  const tied = battle([mon('ai-1', 'Ninetales', 'Drought')], [mon('player-1', 'Ninetales', 'Drizzle')], 'Singles');
  const seen = new Set([0, 0.99].map(draw => applyLeadEntries(tied, {random: () => draw}).field.weather));
  assert.deepEqual([...seen].sort(), ['Rain', 'Sun'], 'the stream decides a speed tie');
  const again = [0, 0.99].map(draw => applyLeadEntries(tied, {random: () => draw}).field.weather);
  assert.deepEqual(again, [0, 0.99].map(draw => applyLeadEntries(tied, {random: () => draw}).field.weather));
  // No tie, no draw: a stream that throws is never asked.
  const untied = battle([mon('ai-1', 'Ninetales', 'Drought')], [mon('player-1', 'Politoed', 'Drizzle')], 'Singles');
  assert.equal(applyLeadEntries(untied, {random: () => { throw new Error('drawn'); }}).field.weather, 'Rain');
}

console.log('lead-entries: ok');
