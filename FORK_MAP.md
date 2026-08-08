# Fork Map

This repository is a Smogon damage-calculator fork with a Run & Bun policy and
battle-state layer added around the calculator. Use this map when deciding
where a change belongs.

## Inherited OSS surfaces

- `calc/src/` contains the upstream calculator architecture: generation damage
  formulas, move/species/item data, calculator objects, descriptions, and
  calculator tests.
- `src/` contains the inherited browser UI structure and its data/import
  surfaces.
- `calc/src/data/` should remain aligned with simulator data. A data change is
  an intentional fork overlay only when it is documented and fixture-tested.

## Run & Bun calculator overlays

These are changes to the calculator oracle, not AI policy:

- `calc/src/field.ts` and generation mechanics files contain fork-specific
  grounding, terrain, ability, critical-hit, and damage behavior.
- `calc/src/pokemon.ts` and `calc/src/state.ts` carry explicit calculator
  boundaries for type/stat overrides and state cloning.
- `calc/src/test/fork.test.ts` is the focused regression gate for those
  overlays.

### Upstream audit policy (Policy B)

`npm run test:upstream` remains a **compatibility audit only**. It is not part
of the root `npm test` gate and is not required to be green. Document intentional
fork deltas here and in `VALIDATION.md`; promote an upstream baseline only with
an explicit fixture change. Do not silently rewrite inherited expectations to
force the audit green.

The current intentional deltas are:

| Surface | Fork behavior | Source and fixture |
| --- | --- | --- |
| Move data | Super Fang is Dark-type | `calc/src/data/moves.ts`; `fork.test.ts` |
| Move data | Misty Explosion is 200 base power (upstream Gen 8 is 100) | `calc/src/data/moves.ts`; `fork.test.ts`; `ai/src/test/runbun-data.test.ts` |
| Species data | Azumarill has 65 base Attack | `calc/src/data/species.ts`; `fork.test.ts` |
| Descriptions | Damage descriptions use IV values for the displayed stat labels | `calc/src/mechanics/util.ts` and generation mechanics; `fork.test.ts` |
| Modern terrain | Psychic Terrain uses the fork's modern damage scaling | `calc/src/mechanics/gen56.ts` and `gen789.ts`; `fork.test.ts` |
| Priority and protection | Gale Wings is not full-HP gated; intact Disguise blocks the first hit | `calc/src/mechanics/gen56.ts` and `gen789.ts`; `fork.test.ts` |
| Stat stages | Soul Dew contributes SpA/SpD stages for Latias and Latios | `calc/src/pokemon.ts`; `fork.test.ts` |
| Critical hits | Magma Armor blocks critical hits and the fork uses a 1.5× critical multiplier | generation mechanics; `fork.test.ts` |
| Split-hit state | Parental Bond creates a child hit only while `abilityOn` is active; the AI preserves both hit distributions for sequential resolution | `calc/src/mechanics/gen56.ts`, `gen789.ts`; `ai/src/facts.ts`, `resolution.ts`; multi-hit/fork fixtures |
| Grounding | Explicit landed state and the fork's Iron Ball behavior affect Ground damage | `calc/src/field.ts` and generation mechanics; `fork.test.ts` |
| Field moves | Water Sport/Mud Sport and Ion Deluge use the fork's generation gates and effects | generation mechanics; `fork.test.ts` |
| Item suppression | Corrosive Gas can retain held-item identity for Poltergeist while suppressing ordinary item effects | `calc/src/state.ts`, `calc/src/mechanics/util.ts`, `calc/src/mechanics/gen789.ts`; `mechanics.test.ts` |

The AI also carries a separate Run & Bun move-metadata overlay in
`ai/src/move-metadata.ts`. It owns the documented accuracy, secondary-chance,
base-power, PP, and Covet/Super Fang type changes used by policy and
resolution; these are not silently injected into the generic calculator data.
The adapter applies the overlay's type and base power to calculator move
overrides, while PP changes feed canonical maximum-PP lookup and Transform.
`ai/src/test/metadata.test.ts` is the focused regression gate for that overlay.
Serializable `MoveState` also permits caller-defined type, category, priority,
target, accuracy, secondary-effect, and move-flag overrides; the AI metadata,
order, calculator, and move-engine boundaries preserve those fields.

### The overlay outranks the inherited data

`calc/` is inherited source material; the Run & Bun overlay is fork-owned and
**authoritative**. Both are read at runtime by different surfaces — the AI
pushes the overlay through `calc-adapter.ts`, while the browser damage
calculator reads `calc/src/data/moves.ts` directly — so a disagreement makes the
two halves of the product report different damage for the same move, silently.

`ai/src/test/runbun-data.test.ts` is the gate for that: any inherited base power
or move type contradicting the overlay fails the build. When it fires, change
the inherited data to the Run & Bun value and add a row above. Only add a
documented exception when the two consumers legitimately differ (friendship-
scaled Return and Frustration are the current pair). The gate runs offline
against data already in the repository; it does not track any upstream fork.

## Run & Bun application code

- `ai/` owns serializable battle state, legal actions, transition bookkeeping,
  move-state effects, order, matchup facts, and Run & Bun scoring. It treats
  `@smogon/calc` as a read-only damage oracle.
- `server.js` owns the local HTTP adapter for calculator and AI endpoints. It
  validates incoming state/actions/resolutions and validates derived or applied
  battle state before serialization; it does not become a second battle model.
- `src/js/data/sets/gen8.js` holds the authored Run & Bun trainer parties and is
  fork-owned product data, not generated output. The inherited `import/`
  generator that overwrote it from `@smogon/sets` has been removed;
  `runbun_sets.test.js` guards the data against being regenerated. See
  `TASKS.md`.
- `AGENTS.md`, `AI_DATA_MODEL.md`, and `VALIDATION.md` define the contracts and
  evidence for these additions.

## Generated surfaces

- `dist/` is generated by `npm run build`; never hand-edit it.
- `node_modules/`, package caches, and TypeScript build metadata are disposable
  environment output, not source-of-truth project state.

When uncertain, keep generic damage mechanics in `calc/`, Run & Bun policy in
`ai/`, HTTP translation in `server.js`, and browser presentation in `src/`.
