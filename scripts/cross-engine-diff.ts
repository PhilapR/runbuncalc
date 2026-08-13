/**
 * Cross-engine differential gate — runbuncalc vs the mono rab engine's
 * verified core, on the terrain the fidelity corpus never graded.
 *
 * The ROM corpus is boost-free, status-free and weather-free, so a band gate
 * proves nothing about stat stages, crits under stages, burn or weather.
 * This gate covers that blind spot the other way: two engines of separate
 * lineage computing the same scenario matrix, where any disagreement is a
 * bug in one of them. It has already paid for itself once — rab's crit
 * applied stat stages the ROM ignores, caught here, fixed in the mono as
 * `claude/rab-crit-ignores-stat-stages`.
 *
 * Known, DOCUMENTED divergences are allowlisted below with their reasons;
 * anything new fails the gate. Two entries matter:
 *
 *   burn     rab's band path carries no burn halving BY CONTRACT (its own
 *            acceptance test halves externally); ours prices 'brn' in.
 *   weather  the engines disagree by 1 at the low roll under sun/rain — a
 *            rounding-order divergence the corpus cannot adjudicate. A
 *            pykemon weather sweep (spec'd in the mono) settles it; until
 *            then NEITHER side gets "fixed" to match the other.
 *
 * Runs under BUN with the mono checkout present (it imports rab's
 * TypeScript directly): not part of `npm test`, by design — CI has neither.
 *
 *   MONO=/workspace/pokemon-mono bun scripts/cross-engine-diff.ts
 */
import * as fs from 'fs';
import * as path from 'path';

const MONO = process.env.MONO || '/workspace/pokemon-mono';
const HERE = path.join(import.meta.dir, '..');

const { RABCorrected } = await import(path.join(MONO, 'engines/rab/backend/src/data/rab-corrected-loader'));
const { calc: rabCalc } = await import(path.join(MONO, 'engines/rab/backend/src/calculator/runbuncalc-wrapper'));
const ours = require(path.join(HERE, 'calc'));
const gen = ours.Generations.get(8);

const FIDELITY = path.join(HERE, 'profiles', 'run-and-bun', 'fidelity');

interface Scenario {
  name: string;
  atkBoosts?: Record<string, number>;
  defBoosts?: Record<string, number>;
  burn?: boolean;
  crit?: boolean;
  weather?: string;
  allow?: string; // documented divergence — a mismatch here is EXPECTED
}
const SCENARIOS: Scenario[] = [
  {name: 'baseline'},
  {name: 'attacker +2 offense', atkBoosts: {atk: 2, spa: 2}},
  {name: 'attacker -2 offense', atkBoosts: {atk: -2, spa: -2}},
  {name: 'defender +2 defense', defBoosts: {def: 2, spd: 2}},
  {name: 'defender -2 defense', defBoosts: {def: -2, spd: -2}},
  {name: 'both sides +6', atkBoosts: {atk: 6, spa: 6}, defBoosts: {def: 6, spd: 6}},
  {name: 'crit, no stages', crit: true},
  {name: 'crit vs defender +2', crit: true, defBoosts: {def: 2, spd: 2}},
  {name: 'crit with attacker -2', crit: true, atkBoosts: {atk: -2, spa: -2}},
  {name: 'crit vs defender -2', crit: true, defBoosts: {def: -2, spd: -2}},
  {name: 'attacker burned', burn: true,
    allow: 'burn is a caller contract in rab (its gate halves externally)'},
  {name: 'sun', weather: 'Sun',
    allow: 'weather rounding order is ROM-unverified — pykemon sweep pending'},
  {name: 'rain', weather: 'Rain',
    allow: 'weather rounding order is ROM-unverified — pykemon sweep pending'},
];

let total = 0;
let unexpected = 0;
let allowedHits = 0;
const failures: string[] = [];
for (const file of fs.readdirSync(FIDELITY).filter(f => f.startsWith('events-')).sort()) {
  const data = JSON.parse(fs.readFileSync(path.join(FIDELITY, file), 'utf8'));
  const seen = new Set<string>();
  for (const obs of data.observations) {
    const key = `${obs.attacker}|${obs.move}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const atkSpec = data.sides[obs.attacker];
    const defSpec = data.sides[obs.attacker === 'A' ? 'B' : 'A'];
    for (const sc of SCENARIOS) {
      total++;
      const a = new ours.Pokemon(gen, atkSpec.species, {
        level: atkSpec.level, statOverrides: {...atkSpec.stats}, curHP: atkSpec.stats.hp,
        overrides: {abilities: {0: 'None'}},
        boosts: sc.atkBoosts, status: sc.burn ? 'brn' : '',
      });
      const d = new ours.Pokemon(gen, defSpec.species, {
        level: defSpec.level, statOverrides: {...defSpec.stats}, curHP: defSpec.stats.hp,
        overrides: {abilities: {0: 'None'}},
        boosts: sc.defBoosts,
      });
      const field = new ours.Field(sc.weather ? {weather: sc.weather} : {});
      const result = ours.calculate(gen, a, d, new ours.Move(gen, obs.move, {isCrit: !!sc.crit}), field);
      const ourRolls: number[] = Array.isArray(result.damage) ? result.damage : [result.damage];

      const ra = RABCorrected.createPokemon(atkSpec.species, atkSpec.level, {moves: atkSpec.moves});
      ra.ability = undefined; ra.item = undefined;
      ra.stats = {...ra.stats, ...atkSpec.stats};
      ra.boosts = sc.atkBoosts;
      const rd = RABCorrected.createPokemon(defSpec.species, defSpec.level, {moves: defSpec.moves});
      rd.ability = undefined; rd.item = undefined;
      rd.stats = {...rd.stats, ...defSpec.stats};
      rd.boosts = sc.defBoosts;
      const move = ra.moves.find((m: any) => m.name.toLowerCase() === obs.move.toLowerCase());
      if (!move) continue;
      const weather = sc.weather ? {type: sc.weather.toLowerCase()} : undefined;
      const rabRolls = rabCalc.calculateDamageRolls(ra, rd, move, weather, undefined, !!sc.crit);

      const same = ourRolls.length === rabRolls.length && ourRolls.every((v, i) => v === rabRolls[i]);
      if (same) continue;
      if (sc.allow) { allowedHits++; continue; }
      unexpected++;
      if (failures.length < 8) {
        failures.push(`${sc.name}: ${atkSpec.species} ${obs.move} vs ${defSpec.species}` +
          ` — ours [${ourRolls[0]}..${ourRolls[ourRolls.length - 1]}]` +
          ` rab [${rabRolls[0]}..${rabRolls[rabRolls.length - 1]}]`);
      }
    }
  }
}
console.log(`${total} scenario evaluations — ${unexpected} unexpected disagreements, ` +
  `${allowedHits} inside documented divergences`);
for (const line of failures) console.log('  FAIL', line);
if (unexpected > 0) process.exit(1);
console.log('cross-engine agreement holds everywhere the corpus is blind');
