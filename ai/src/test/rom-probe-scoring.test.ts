import assert from 'node:assert/strict';
import {calculateActionFacts} from '../calc-adapter';
import {evaluateActions} from '../evaluate';
import {BattleState, PokemonState} from '../model';

/**
 * Enemy move scores against the Run & Bun ROM.
 *
 * Each case copies one probe from profiles/run-and-bun/fidelity/ai-probes/
 * (species, level, injected stats, moves) and asserts the set of scores the
 * ROM showed over its 20 seeds, on the 100 base. The probe gate
 * (tests/ai-probes.test.js) grades the whole choice distribution; these pin
 * the rule each one exercises, so a revert names the rule.
 */

interface Stats {hp: number; atk: number; def: number; spa: number; spd: number; spe: number}

interface Side {
  species: string;
  moves: string[];
  stats: Stats;
  hp?: number;
  types?: string[];
  ability?: string;
}

function mon(id: string, side: Side): PokemonState {
  return {
    id,
    species: side.species,
    level: 50,
    hp: {current: side.hp ?? side.stats.hp, max: side.stats.hp},
    moves: side.moves.map(name => ({name})),
    ability: side.ability ?? 'Run Away',
    statOverrides: {...side.stats},
    boosts: {},
    status: '',
    ...(side.types ? {typeOverride: side.types} : {}),
  } as PokemonState;
}

function probe(enemy: Side, player: Side, bench: Side[] = []): BattleState {
  return {
    generation: 8,
    mode: 'Singles',
    turn: 2,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [mon('ai-1', enemy)]},
      player: {
        activeIds: ['player-1'],
        party: [mon('player-1', player), ...bench.map((side, i) => mon(`player-${i + 2}`, side))],
      },
    },
    firstTurnOutIds: [],
  };
}

/** Move name -> the sorted set of scores it can roll, on the ROM's 100 base. */
function scores(state: BattleState): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const evaluation of evaluateActions(state, calculateActionFacts, 'ai', {includeSwitches: false})) {
    if (evaluation.action.kind !== 'move') continue;
    const set = new Set(evaluation.outcomes.filter(o => o.probability > 0).map(o => o.score + 100));
    out[evaluation.action.moveName] = [...set].sort((a, b) => a - b);
  }
  return out;
}

// s12-celebrate-hold-hands: Celebrate and Splash read 81 (EFFECT_DO_NOTHING).
{
  const got = scores(probe(
    {species: 'Linoone', moves: ['Celebrate', 'Hold Hands', 'Splash', 'Tackle'],
      stats: {hp: 180, atk: 60, def: 90, spa: 60, spd: 90, spe: 100}},
    {species: 'Snorlax', moves: ['Splash', 'Tackle', 'Growl', 'Leer'],
      stats: {hp: 400, atk: 30, def: 80, spa: 30, spd: 80, spe: 40}},
  ));
  assert.deepEqual(got['Celebrate'], [81], 's12 Celebrate');
  assert.deepEqual(got['Splash'], [81], 's12 Splash');
  assert.deepEqual(got['Tackle'], [106, 108], 's12 Tackle');
}

// i5-all-immune-splash-wins: every attack immune, the zero-damage tie keeps
// the highest-damage +6/+8 and takes -20 (86/88); Splash 81 never wins.
{
  const got = scores(probe(
    {species: 'Marowak', moves: ['Splash', 'Earthquake', 'Bone Club', 'Drill Run'],
      stats: {hp: 200, atk: 110, def: 110, spa: 50, spd: 90, spe: 50}},
    {species: 'Skarmory', moves: ['Splash', 'Tackle', 'Growl', 'Leer'],
      stats: {hp: 400, atk: 30, def: 80, spa: 30, spd: 80, spe: 40}},
  ));
  for (const move of ['Earthquake', 'Bone Club', 'Drill Run']) assert.deepEqual(got[move], [86, 88], `i5 ${move}`);
}

// i1-ground-vs-flying: an immune attack beside a damaging one reads 80.
{
  const got = scores(probe(
    {species: 'Marowak', moves: ['Earthquake', 'Splash', 'Bone Club', 'Horn Attack'],
      stats: {hp: 200, atk: 110, def: 110, spa: 50, spd: 90, spe: 50}},
    {species: 'Pidgeot', moves: ['Splash', 'Tackle', 'Growl', 'Leer'],
      stats: {hp: 400, atk: 30, def: 80, spa: 30, spd: 80, spe: 40}},
  ));
  assert.deepEqual(got['Earthquake'], [80], 'i1 Earthquake');
  assert.deepEqual(got['Bone Club'], [80], 'i1 Bone Club');
  assert.deepEqual(got['Horn Attack'], [106, 108], 'i1 Horn Attack');
}

// u3-dragon-dance-slower-2hko: a self-targeting setup move compares the
// user's speed with the player's, so the slower-and-2HKO'd -5 fires (101).
{
  const got = scores(probe(
    {species: 'Dragonite', moves: ['Splash', 'Dragon Dance', 'Dragon Claw', 'Wing Attack'],
      stats: {hp: 260, atk: 80, def: 120, spa: 40, spd: 120, spe: 40}},
    {species: 'Lapras', moves: ['Splash', 'Ice Beam', 'Growl', 'Leer'],
      stats: {hp: 400, atk: 30, def: 80, spa: 85, spd: 80, spe: 100}},
  ));
  assert.deepEqual(got['Dragon Dance'], [101], 'u3 Dragon Dance');
}

// u5-agility-slower: Agility +7 when slower than the player (107).
{
  const got = scores(probe(
    {species: 'Alakazam', moves: ['Agility', 'Psychic', 'Splash', 'Confusion'],
      stats: {hp: 160, atk: 40, def: 90, spa: 70, spd: 90, spe: 40}},
    {species: 'Snorlax', moves: ['Splash', 'Tackle', 'Growl', 'Leer'],
      stats: {hp: 400, atk: 30, def: 80, spa: 30, spd: 80, spe: 100}},
  ));
  assert.deepEqual(got['Agility'], [107], 'u5 Agility');
}

// u1-swords-dance-safe and u4-dragon-dance-faster-2hko: offensive setup while
// faster stays on its +6 base (106), safe or 2HKO'd.
{
  const u1 = scores(probe(
    {species: 'Scizor', moves: ['Swords Dance', 'X-Scissor', 'Splash', 'Metal Claw'],
      stats: {hp: 200, atk: 80, def: 120, spa: 40, spd: 90, spe: 80}},
    {species: 'Snorlax', moves: ['Splash', 'Tackle', 'Growl', 'Leer'],
      stats: {hp: 400, atk: 30, def: 80, spa: 30, spd: 80, spe: 40}},
  ));
  assert.deepEqual(u1['Swords Dance'], [106], 'u1 Swords Dance');
  const u4 = scores(probe(
    {species: 'Dragonite', moves: ['Splash', 'Dragon Dance', 'Dragon Claw', 'Wing Attack'],
      stats: {hp: 260, atk: 80, def: 120, spa: 40, spd: 120, spe: 120}},
    {species: 'Lapras', moves: ['Splash', 'Ice Beam', 'Growl', 'Leer'],
      stats: {hp: 400, atk: 30, def: 80, spa: 85, spd: 80, spe: 100}},
  ));
  assert.deepEqual(u4['Dragon Dance'], [106], 'u4 Dragon Dance');
}

// u7-nasty-plot-faster-safe: Nasty Plot reads a flat 106 while faster and
// out of 3HKO range; the document's +1/+1 does not fire.
{
  const got = scores(probe(
    {species: 'Absol', moves: ['Nasty Plot', 'Bite', 'Splash', 'Tackle'],
      stats: {hp: 200, atk: 80, def: 120, spa: 60, spd: 120, spe: 100}},
    {species: 'Snorlax', moves: ['Splash', 'Tackle', 'Growl', 'Leer'],
      stats: {hp: 400, atk: 30, def: 80, spa: 30, spd: 80, spe: 40}},
  ));
  assert.deepEqual(got['Nasty Plot'], [106], 'u7 Nasty Plot');
}

console.log('ROM probe scoring fixtures passed');
