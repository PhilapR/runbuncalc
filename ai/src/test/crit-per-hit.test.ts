import assert from 'node:assert/strict';
import {calculateActionFacts} from '../calc-adapter';
import {deriveMoveResolution} from '../move-engine';
import {BattleState} from '../model';

// Two defects an independent mechanics review proved, both from the same
// root: the engine grew a SECOND, disjoint representation of "this was a
// critical hit" and never reconciled it with the first.

function mon(id: string, species: string, extra: object = {}) {
  return {
    id, species, level: 50, hp: {current: 200, max: 200},
    moves: [{name: 'Tackle', pp: 10, maxPP: 10}], ...extra,
  };
}
function state(ai: object, player: object): BattleState {
  return {
    generation: 8, mode: 'Singles', turn: 1, field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [ai]},
      player: {activeIds: ['player-1'], party: [player]},
    },
  } as BattleState;
}
function resolve(fixture: BattleState, moveName: string, random: () => number) {
  const action = {kind: 'move' as const, actorId: 'ai-1', moveName, targetIds: ['player-1']};
  return deriveMoveResolution(fixture, action, {
    facts: calculateActionFacts(fixture, action), hit: true, random,
  });
}

// D-anger: a SAMPLED crit set criticalHitTargets but never fired Anger
// Point; a GUARANTEED crit fired Anger Point but never appeared in the log.
// The 1/16 event the ability exists for could not trigger it.
const angerTarget = () => mon('player-1', 'Tauros', {ability: 'Anger Point', abilityOn: true});

const sampled = resolve(state(mon('ai-1', 'Machamp'), angerTarget()), 'Tackle', () => 0.001);
assert.deepEqual(sampled.criticalHitTargets, ['player-1'], 'a sampled crit is reported');
assert.equal(sampled.boostsByPokemon?.['player-1']?.atk, 6,
  'a sampled crit maxes Anger Point — the whole point of the ability');

// Storm Throw always crits. It must ALSO say so in the log.
const guaranteed = resolve(
  state(mon('ai-1', 'Machamp', {moves: [{name: 'Storm Throw', pp: 10, maxPP: 10}]}), angerTarget()),
  'Storm Throw', () => 0.9);
assert.deepEqual(guaranteed.criticalHitTargets, ['player-1'],
  'a guaranteed crit is a crit, and the log must say so');
assert.equal(guaranteed.boostsByPokemon?.['player-1']?.atk, 6,
  'Anger Point still fires on the guaranteed path');

// A hit that does NOT crit reports nothing and boosts nothing.
const ordinary = resolve(state(mon('ai-1', 'Machamp'), angerTarget()), 'Tackle', () => 0.9);
assert.equal(ordinary.criticalHitTargets, undefined, 'no crit, no report');
assert.equal(ordinary.boostsByPokemon?.['player-1'], undefined, 'no crit, no Anger Point');

// D-perhit: one crit draw covered EVERY hit of a multi-hit move, so a
// 5-hit Rock Blast was 6.25% all-five-crit and 93.75% none. Mainline rolls
// the crit inside the hit loop, so it is 1-(15/16)^5 spread across 1..5.
function blastState() {
  return state(
    mon('ai-1', 'Cloyster', {moves: [{name: 'Rock Blast', pp: 10, maxPP: 10}]}),
    mon('player-1', 'Blissey', {hp: {current: 700, max: 700}}));
}

// mulberry32: reproducible, and it uses Math.imul so no intermediate
// exceeds 2^53. ONE continuous stream feeds every trial — re-seeding per
// trial with 1, 2, 3... was the first version and it is wrong: an LCG's
// first output is a linear function of its seed, so the crit draws came out
// structured and the measured rate read 45% against a theoretical 27.6%.
// The generator has to be trustworthy before a distribution assertion means
// anything.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const stream = mulberry32(0x5eed);

// Crit damage and ordinary damage do not overlap for this matchup —
// ordinary rolls are 37-44, crit rolls 56-66 — so each hit can be
// classified exactly rather than inferred from spread. That matters: an
// earlier version of this test counted DISTINCT damage values, which vary
// from ordinary roll spread whether or not the crits are per-hit, and it
// stayed green when resolution applied hit 0's flag to all five.
const bands = calculateActionFacts(blastState(), {
  kind: 'move', actorId: 'ai-1', moveName: 'Rock Blast', targetIds: ['player-1'],
}).damage!;
const ordinaryCeiling = Math.max(...bands.rolls);
assert.ok(Math.min(...(bands.critRolls || [0])) > ordinaryCeiling,
  'the bands must be disjoint for this classification to mean anything');

let anyCrit = 0;
let allFive = 0;
let mixed = 0;
// Only five-hit blasts are counted, and only THEY form the denominator — a
// [2,5] move rolls five hits 15% of the time, so dividing by every trial
// would report 4% and say nothing about the per-hit draw.
let fiveHitTrials = 0;
const TRIALS = 4000;
for (let trial = 0; trial < TRIALS; trial += 1) {
  const resolution = resolve(blastState(), 'Rock Blast', stream);
  const hits = resolution.hitDamageByTarget?.['player-1'] || [];
  if (hits.length !== 5) continue;
  fiveHitTrials += 1;
  // How many of the five hits actually landed in the crit band.
  const critHits = hits.filter(damage => damage > ordinaryCeiling).length;
  if (critHits > 0) {
    anyCrit += 1;
    if (critHits === 5) allFive += 1;
    else mixed += 1;
  }
  assert.equal(critHits > 0, !!resolution.criticalHitTargets?.length,
    'the reported crit and the damage dealt must agree');
}
assert.ok(anyCrit > 0, 'the fixture must produce crits at all');
assert.ok(fiveHitTrials > 400, 'enough five-hit samples to measure a rate');
// Five independent 1/16 draws give P(at least one) = 1-(15/16)^5 = 27.6%.
// One shared draw gives 6.25%. Measured 30.1% over 627 samples, which is
// 1.4 standard errors from theory; the band is wide enough that the fixed
// seed cannot drift into it and far above the shared-draw answer.
const rate = anyCrit / fiveHitTrials;
assert.ok(rate > 0.20 && rate < 0.36,
  `five hits must each get their own crit draw — saw ${(rate * 100).toFixed(1)}% ` +
  'of five-hit Rock Blasts crit against a theoretical 27.6%, ' +
  'and a single shared draw would be near 6.25%');
// All five critting together is one in a million with independent draws,
// and was the ONLY way to crit under the shared one. Zero of them beside a
// healthy count of partial crits is the shape of the fix.
// The discriminator. With independent per-hit draws, crit counts follow
// Binomial(5, 1/16): one critting hit is the common case and all five is a
// one-in-a-million event. If the resolution applies a single flag to every
// hit, the count can only ever be 0 or 5 — so a healthy population of
// partial crits IS the fix, and it is the only assertion here that catches
// the resolution half of it.
assert.equal(allFive, 0, 'all five hits critting together must not happen at this scale');
assert.ok(mixed > 100,
  `crits must land on SOME hits and not others — saw ${mixed} partial crits`);

console.log('crit-per-hit: ok');
