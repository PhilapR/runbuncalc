import assert from 'node:assert/strict';
import {calculateActionFacts} from '../calc-adapter';
import {deriveEndTurnResolution} from '../end-turn';
import {BattleState} from '../model';

// D10: the two hand-rolled high-crit lists disagreed with each other AND
// with the games. Poison Jab/Sting never had a crit ratio; Poison Tail,
// Sky Attack and Snipe Shot always did; the always-crit four were filed as
// a mere +1 stage, so Anger Point never fired off them.
function critState(moveName: string): BattleState {
  return {
    generation: 8, mode: 'Singles', turn: 1, field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Nidoking', level: 50,
        hp: {current: 150, max: 150}, moves: [{name: moveName, pp: 20, maxPP: 20}],
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Blissey', level: 50,
        hp: {current: 250, max: 250}, moves: [{name: 'Tackle'}],
      }]},
    },
  };
}

function stageOf(moveName: string): number {
  const fixture = critState(moveName);
  const action = {kind: 'move' as const, actorId: 'ai-1', moveName, targetIds: ['player-1']};
  return calculateActionFacts(fixture, action).attackerCriticalHitStage ?? 0;
}
function guaranteedFor(moveName: string): boolean {
  const fixture = critState(moveName);
  const action = {kind: 'move' as const, actorId: 'ai-1', moveName, targetIds: ['player-1']};
  return !!calculateActionFacts(fixture, action).criticalHitGuaranteed;
}

assert.equal(stageOf('Poison Jab'), 0, 'Poison Jab is not a high-crit move');
assert.equal(stageOf('Poison Sting'), 0, 'Poison Sting is not a high-crit move');
assert.equal(stageOf('Poison Tail'), 1, 'Poison Tail is high-crit');
// Sky Attack and Snipe Shot are in the set too; they are charge/gen-9 moves
// whose facts need a legal learner, so the set membership above covers them.
assert.equal(guaranteedFor('Storm Throw'), true, 'always-crit moves are guaranteed, not staged');
assert.equal(guaranteedFor('Frost Breath'), true, 'Frost Breath always crits');
assert.equal(guaranteedFor('Poison Tail'), false, 'a high-crit move is not a guarantee');

// D14: Aqua Ring and Ingrain heal independently and stack.
function healState(volatiles: Record<string, unknown>, item?: string): BattleState {
  return {
    generation: 8, mode: 'Singles', turn: 2, field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Ludicolo', level: 100,
        hp: {current: 200, max: 320}, moves: [{name: 'Tackle'}],
        volatile: volatiles, ...(item ? {item} : {}),
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Blissey', level: 100,
        hp: {current: 300, max: 300}, moves: [{name: 'Tackle'}],
      }]},
    },
  };
}
const heal = (v: Record<string, unknown>, item?: string) =>
  deriveEndTurnResolution(healState(v, item), {random: () => 0.5}).hpDeltaByPokemon?.['ai-1'] ?? 0;

const ring = heal({aquaRing: true});
const root = heal({ingrain: true});
assert.equal(ring, 20, 'Aqua Ring heals 1/16');
assert.equal(root, 20, 'Ingrain heals 1/16');
assert.equal(heal({aquaRing: true, ingrain: true}), ring + root, 'they stack');
assert.ok(heal({aquaRing: true}, 'Big Root') > ring, 'Big Root boosts Aqua Ring');

console.log('crit-lists-stacking: ok');

// The drift hazard the D10 fix left behind. There were TWO hand-kept copies
// of the high-crit list — calc-adapter's and status.ts's — and this file only
// ever reached the calc-adapter one, so corrupting the other stayed green.
// That is the same defect D10 was, one module over.
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {ALWAYS_CRIT_MOVES, HIGH_CRIT_MOVES} from '../calc-adapter';

// status.ts must IMPORT the list, not declare one.
//
// The first version of this check read
//   statusModule.HIGH_CRIT_MOVES ?? HIGH_CRIT_MOVES === HIGH_CRIT_MOVES
// which is a tautology: status does not export the symbol, so the left side
// was always the right side and a restored local copy sailed through. The
// set is not exported and cannot be compared by identity from here, so the
// source is what gets asserted.
const statusSource = readFileSync(join(__dirname, '..', '..', 'src', 'status.ts'), 'utf8');
assert.match(statusSource, /import \{[^}]*HIGH_CRIT_MOVES[^}]*\} from '\.\/calc-adapter'/,
  'status.ts must import the canonical high-crit list');
assert.doesNotMatch(statusSource, /const\s+HIGH_CRIT_MOVES\s*=\s*new Set/,
  'status.ts must not declare a second high-crit list');
assert.doesNotMatch(statusSource, /const\s+ALWAYS_CRIT_MOVES\s*=\s*new Set/,
  'nor a second always-crit list');

// The set membership this file previously only mentioned in a comment.
// "Sky Attack and Snipe Shot are in the set too" was prose; deleting them
// from the list left every assertion green.
for (const move of ['skyattack', 'snipeshot', 'karatechop', 'poisontail',
  'psychocut', 'razorwind', 'stoneedge', 'slash']) {
  assert.ok(HIGH_CRIT_MOVES.has(move), `${move} is a high-crit move`);
}
// And the ones R&B/Gen 8 do NOT treat as high-crit, which the old list had wrong.
for (const move of ['poisonjab', 'poisonsting', 'strangesteam']) {
  assert.ok(!HIGH_CRIT_MOVES.has(move), `${move} is not a high-crit move`);
}

// The always-crit four are a DIFFERENT set. Folding them into the high-crit
// list made the Focus Energy policy believe it helps a Wicked Blow, which it
// cannot: a move that always crits gains nothing from a crit-stage boost.
for (const move of ['frostbreath', 'stormthrow', 'surgingstrikes', 'wickedblow']) {
  assert.ok(ALWAYS_CRIT_MOVES.has(move), `${move} always crits`);
}

console.log('crit-list drift: ok');
