/**
 * Run & Bun data consistency gate.
 *
 * The calculator in `calc/` is inherited source material. The Run & Bun move
 * overlay in `ai/src/move-metadata.ts` is fork-owned and authoritative: it is
 * the transcription of the Run & Bun move-change documentation.
 *
 * Both are consulted at runtime by different surfaces. The AI pushes the
 * overlay into the calculator through `calc-adapter.ts`, so AI scoring sees the
 * Run & Bun value. The browser damage calculator reads `calc/src/data/moves.ts`
 * directly and sees whatever the inherited data says. When those disagree, the
 * two halves of the product report different damage for the same move and
 * nothing fails — which is how Misty Explosion sat at 100 in the calculator and
 * 200 in the overlay.
 *
 * This gate makes the overlay win: any inherited value that contradicts it is a
 * test failure, not a silent divergence. It runs entirely offline against data
 * already in the repository.
 */

import * as Calc from '@smogon/calc';
import assert from 'node:assert/strict';
import {GenerationNum} from '../model';
import {OVERLAY_MOVE_IDS, getMoveMetadata} from '../move-metadata';

/** The generation the Run & Bun product targets. */
const RUNBUN_GEN: GenerationNum = 8;

/**
 * Moves whose calculator base power is deliberately not the overlay's value.
 *
 * Return and Frustration scale with friendship, so the calculator carries `0`
 * and resolves the real power from its own friendship input. The overlay pins
 * them at the max-friendship value because AI scoring has no such input. Both
 * are correct for their own consumer; this is not drift.
 */
const BASE_POWER_EXCEPTIONS = new Map<string, string>([
  ['return', 'friendship-scaled; calculator resolves from its own input'],
  ['frustration', 'friendship-scaled; calculator resolves from its own input'],
]);

const gen = Calc.Generations.get(RUNBUN_GEN);

const basePowerDrift: string[] = [];
const typeDrift: string[] = [];

for (const move of gen.moves) {
  const metadata = getMoveMetadata(move.name, RUNBUN_GEN);

  const expectedBasePower = metadata.basePowerOverride;
  if (expectedBasePower !== undefined &&
      expectedBasePower !== move.basePower &&
      !BASE_POWER_EXCEPTIONS.has(move.id)) {
    basePowerDrift.push(
      `${move.name}: calculator has ${move.basePower}, Run & Bun overlay has ${expectedBasePower}`
    );
  }

  const expectedType = metadata.typeOverride;
  if (expectedType !== undefined && expectedType !== move.type) {
    typeDrift.push(
      `${move.name}: calculator has ${move.type}, Run & Bun overlay has ${expectedType}`
    );
  }
}

assert.deepEqual(
  basePowerDrift,
  [],
  `Inherited calculator base power contradicts the Run & Bun overlay:\n  ${basePowerDrift.join('\n  ')}\n` +
  'Update calc/src/data/moves.ts to the Run & Bun value and record it in FORK_MAP.md, ' +
  'or add a documented entry to BASE_POWER_EXCEPTIONS if the two consumers legitimately differ.'
);

assert.deepEqual(
  typeDrift,
  [],
  `Inherited calculator move type contradicts the Run & Bun overlay:\n  ${typeDrift.join('\n  ')}\n` +
  'Update calc/src/data/moves.ts to the Run & Bun value and record it in FORK_MAP.md.'
);

// Guard the exception list itself: an entry that no longer has an overlay
// override is stale and should be deleted rather than silently excusing drift.
for (const [id, reason] of BASE_POWER_EXCEPTIONS) {
  const move = gen.moves.get(Calc.toID(id));
  assert.ok(move, `BASE_POWER_EXCEPTIONS names unknown move '${id}'`);
  assert.notEqual(
    getMoveMetadata(move!.name, RUNBUN_GEN).basePowerOverride,
    undefined,
    `BASE_POWER_EXCEPTIONS entry '${id}' (${reason}) no longer has an overlay override; remove it`
  );
}

// Every overlay key must name a real move.
//
// The drift comparison above cannot catch a mistyped key: it walks the
// calculator's move table and only compares where an override exists, so a key
// spelled wrong yields no override, no comparison, and a green build — while
// the Run & Bun correction it was meant to apply is silently dropped. That is
// the same shape as the Misty Explosion split this file exists to prevent, one
// typo away. `precicipeblades` sat beside `precipiceblades` until this check
// was added.
const unknownOverlayKeys = OVERLAY_MOVE_IDS.filter(id => !gen.moves.get(Calc.toID(id)));
assert.deepEqual(
  unknownOverlayKeys,
  [],
  `Run & Bun overlay tables name moves that do not exist in generation ${RUNBUN_GEN}: ` +
  `${unknownOverlayKeys.join(', ')}. A key that resolves to nothing applies no override, ` +
  'so the Run & Bun value is silently dropped. Fix the spelling or remove the entry.'
);

// Misty Explosion is the case that motivated this gate; assert it directly so a
// regression names itself instead of surfacing as a generic drift list.
assert.equal(gen.moves.get(Calc.toID('mistyexplosion'))!.basePower, 200);
assert.equal(getMoveMetadata('Misty Explosion', RUNBUN_GEN).basePowerOverride, 200);
