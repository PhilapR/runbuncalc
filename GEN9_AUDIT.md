# Gen 9 Port Coverage Audit

**Generated** — do not hand-edit. Regenerate with:

```sh
npm run build && node scripts/audit-gen9-coverage.js
```

Baseline generation: **8** (the fork default). Ported-from
generation: **9**.

## Why this exists

Run & Bun is a Gen 8-mechanics game with selected Gen 9 elements ported in.
This fork represents that as `state.generation = 8`, which means every Gen 9
element depends on three layers agreeing:

| Layer | Behavior at generation 8 |
| --- | --- |
| `calc/` gen-indexed data | Gen 9-only entries are **absent** — invisible to the Gen 8 calc |
| `ai/src/move-metadata.ts` | Reads `@pkmn/dex` **without** gen-filtering — resolves them anyway |
| `ai/` effect engine | `generation >= 9` gates make the effect a **silent no-op** |

The `R&B?` column is intentionally unresolved. Nothing here asserts what
Run & Bun actually ports; that requires the R&B source docs
(`MECHANICS.MD` / `MOVE_CHANGES.MD`), which are cited by `README.md` and
`ai/src/move-metadata.ts` but are **not in this repository**. Fill the column
once those are vendored, then triage only the ported rows.

## Summary

| Category | In gen 9 but not gen 8 | Notes |
| --- | --- | --- |
| Moves | 72 | 18 resolve at gen 8 but have gated effects |
| Abilities | 31 | 28 referenced in `ai/src` |
| Items | 13 | 6 referenced in `ai/src` |

## Priority 1 — silent no-ops

These moves **resolve** through `ai/src/move-metadata.ts` at generation
8 (so they are selectable and deal damage) while their defining
effect sits behind a `generation >= 9` gate (so it never fires). If Run & Bun
ports any of these, the fork is silently wrong — no error, just bad numbers.

| R&B? | Move | BP @gen8 | Acc @gen8 | Metadata source | Gated at |
| --- | --- | --- | --- | --- | --- |
| ? | Ceaseless Edge | 65 | 90 | canonical | `move-engine.ts:5103` |
| ? | Chilly Reception | 0 | always | canonical | `move-engine.ts:5597` |
| ? | Doodle | 0 | 100 | canonical | `move-engine.ts:5546` |
| ? | Double Shock | 120 | 100 | canonical | `move-engine.ts:5749` |
| ? | Fillet Away | 0 | always | canonical | `actions.ts:602`<br>`move-engine.ts:979`<br>`move-engine.ts:5619` |
| ? | Glaive Rush | 120 | 100 | canonical | `move-engine.ts:3987` |
| ? | Last Respects | 50 | 100 | canonical | `calc-adapter.ts:510` |
| ? | Mortal Spin | 30 | 100 | canonical | `move-engine.ts:5128`<br>`move-engine.ts:5129` |
| ? | Order Up | 80 | 100 | canonical | `move-engine.ts:3403` |
| ? | Power Shift | 0 | always | canonical | `move-engine.ts:5559` |
| ? | Rage Fist | 50 | 100 | canonical | `calc-adapter.ts:507` |
| ? | Raging Bull | 90 | 100 | canonical | `move-engine.ts:5095` |
| ? | Revival Blessing | 0 | always | canonical | `move-engine.ts:4154` |
| ? | Salt Cure | 40 | 100 | canonical | `move-engine.ts:5134` |
| ? | Shed Tail | 0 | always | canonical | `actions.ts:397`<br>`move-engine.ts:2856`<br>`move-engine.ts:5325`<br>`status.ts:216` |
| ? | Stone Axe | 65 | 90 | canonical | `move-engine.ts:5109` |
| ? | Tidy Up | 0 | always | canonical | `actions.ts:494`<br>`move-engine.ts:5137`<br>`move-engine.ts:5761` |
| ? | Victory Dance | 0 | always | canonical | `move-engine.ts:5623` |

## Priority 2 — moves with no AI model at all

Absent from the gen 8 calc tables and never mentioned in `ai/src`.
If R&B ports one of these, it needs to be modelled from scratch.

| R&B? | Move | Resolves @gen8? | BP @gen8 | Metadata source |
| --- | --- | --- | --- | --- |
| ? | Aqua Cutter | yes | 70 | canonical |
| ? | Aqua Step | yes | 80 | canonical |
| ? | Armor Cannon | yes | 120 | canonical |
| ? | Axe Kick | yes | 120 | canonical |
| ? | Barb Barrage | yes | 60 | canonical |
| ? | Bitter Blade | yes | 90 | canonical |
| ? | Bitter Malice | yes | 75 | canonical |
| ? | Blazing Torque | yes | 80 | canonical |
| ? | Bleakwind Storm | yes | 100 | canonical |
| ? | Chilling Water | yes | 50 | canonical |
| ? | Chloroblast | yes | 150 | canonical |
| ? | Collision Course | yes | 100 | canonical |
| ? | Combat Torque | yes | 100 | canonical |
| ? | Comeuppance | yes | 0 | canonical |
| ? | Dire Claw | yes | 80 | canonical |
| ? | Electro Drift | yes | 100 | canonical |
| ? | Esper Wing | yes | 80 | canonical |
| ? | Flower Trick | yes | 70 | canonical |
| ? | Headlong Rush | yes | 120 | canonical |
| ? | Hyper Drill | yes | 100 | canonical |
| ? | Ice Spinner | yes | 80 | canonical |
| ? | Infernal Parade | yes | 60 | canonical |
| ? | Jet Punch | yes | 60 | canonical |
| ? | Kowtow Cleave | yes | 85 | canonical |
| ? | Lumina Crash | yes | 80 | canonical |
| ? | Magical Torque | yes | 100 | canonical |
| ? | Make It Rain | yes | 120 | canonical |
| ? | Mountain Gale | yes | 100 | canonical |
| ? | Mystical Power | yes | 70 | canonical |
| ? | Noxious Torque | yes | 100 | canonical |
| ? | Population Bomb | yes | 20 | canonical |
| ? | Pounce | yes | 50 | canonical |
| ? | Psyshield Bash | yes | 70 | canonical |
| ? | Ruination | yes | 0 | canonical |
| ? | Sandsear Storm | yes | 100 | canonical |
| ? | Spin Out | yes | 100 | canonical |
| ? | Springtide Storm | yes | 100 | canonical |
| ? | Tera Blast | yes | 80 | canonical |
| ? | Torch Song | yes | 80 | canonical |
| ? | Trailblaze | yes | 50 | canonical |
| ? | Triple Arrows | yes | 90 | canonical |
| ? | Triple Dive | yes | 30 | canonical |
| ? | Twin Beam | yes | 40 | canonical |
| ? | Wave Crash | yes | 120 | canonical |
| ? | Wicked Torque | yes | 80 | canonical |
| ? | Wildbolt Storm | yes | 100 | canonical |

## Full move inventory

| R&B? | Move | Resolves @gen8? | Metadata source | `ai/src` refs | Gen 9 gates |
| --- | --- | --- | --- | --- | --- |
| ? | Aqua Cutter | yes | canonical | 0 | — |
| ? | Aqua Step | yes | canonical | 0 | — |
| ? | Armor Cannon | yes | canonical | 0 | — |
| ? | Axe Kick | yes | canonical | 0 | — |
| ? | Barb Barrage | yes | canonical | 0 | — |
| ? | Bitter Blade | yes | canonical | 0 | — |
| ? | Bitter Malice | yes | canonical | 0 | — |
| ? | Blazing Torque | yes | canonical | 0 | — |
| ? | Bleakwind Storm | yes | canonical | 0 | — |
| ? | Ceaseless Edge | yes | canonical | 1 | 1 |
| ? | Chilling Water | yes | canonical | 0 | — |
| ? | Chilly Reception | yes | canonical | 2 | 1 |
| ? | Chloroblast | yes | canonical | 0 | — |
| ? | Collision Course | yes | canonical | 0 | — |
| ? | Combat Torque | yes | canonical | 0 | — |
| ? | Comeuppance | yes | canonical | 0 | — |
| ? | Dire Claw | yes | canonical | 0 | — |
| ? | Doodle | yes | canonical | 3 | 1 |
| ? | Double Shock | yes | canonical | 4 | 1 |
| ? | Electro Drift | yes | canonical | 0 | — |
| ? | Esper Wing | yes | canonical | 0 | — |
| ? | Fillet Away | yes | canonical | 5 | 3 |
| ? | Flower Trick | yes | canonical | 0 | — |
| ? | Gigaton Hammer | yes | canonical | 3 | — |
| ? | Glaive Rush | yes | canonical | 2 | 1 |
| ? | Headlong Rush | yes | canonical | 0 | — |
| ? | Hyper Drill | yes | canonical | 0 | — |
| ? | Ice Spinner | yes | canonical | 0 | — |
| ? | Infernal Parade | yes | canonical | 0 | — |
| ? | Jet Punch | yes | canonical | 0 | — |
| ? | Kowtow Cleave | yes | canonical | 0 | — |
| ? | Last Respects | yes | canonical | 3 | 1 |
| ? | Lumina Crash | yes | canonical | 0 | — |
| ? | Lunar Blessing | yes | canonical | 9 | — |
| ? | Magical Torque | yes | canonical | 0 | — |
| ? | Make It Rain | yes | canonical | 0 | — |
| ? | Mortal Spin | yes | canonical | 2 | 2 |
| ? | Mountain Gale | yes | canonical | 0 | — |
| ? | Mystical Power | yes | canonical | 0 | — |
| ? | Noxious Torque | yes | canonical | 0 | — |
| ? | Order Up | yes | canonical | 2 | 1 |
| ? | Population Bomb | yes | canonical | 0 | — |
| ? | Pounce | yes | canonical | 0 | — |
| ? | Power Shift | yes | canonical | 3 | 1 |
| ? | Psyshield Bash | yes | canonical | 0 | — |
| ? | Rage Fist | yes | canonical | 3 | 1 |
| ? | Raging Bull | yes | canonical | 1 | 1 |
| ? | Raging Fury | yes | canonical | 2 | — |
| ? | Revival Blessing | yes | canonical | 6 | 1 |
| ? | Ruination | yes | canonical | 0 | — |
| ? | Salt Cure | yes | canonical | 1 | 1 |
| ? | Sandsear Storm | yes | canonical | 0 | — |
| ? | Shed Tail | yes | canonical | 5 | 4 |
| ? | Shelter | yes | canonical | 3 | — |
| ? | Silk Trap | yes | canonical | 4 | — |
| ? | Snowscape | yes | canonical | 2 | — |
| ? | Spicy Extract | yes | canonical | 2 | — |
| ? | Spin Out | yes | canonical | 0 | — |
| ? | Springtide Storm | yes | canonical | 0 | — |
| ? | Stone Axe | yes | canonical | 1 | 1 |
| ? | Take Heart | yes | canonical | 8 | — |
| ? | Tera Blast | yes | canonical | 0 | — |
| ? | Tidy Up | yes | canonical | 3 | 3 |
| ? | Torch Song | yes | canonical | 0 | — |
| ? | Trailblaze | yes | canonical | 0 | — |
| ? | Triple Arrows | yes | canonical | 0 | — |
| ? | Triple Dive | yes | canonical | 0 | — |
| ? | Twin Beam | yes | canonical | 0 | — |
| ? | Victory Dance | yes | canonical | 2 | 1 |
| ? | Wave Crash | yes | canonical | 0 | — |
| ? | Wicked Torque | yes | canonical | 0 | — |
| ? | Wildbolt Storm | yes | canonical | 0 | — |

## Abilities

Present in `ABILITIES[9]` but not `ABILITIES[8]`. The
`ai/src` reference count is a coarse proxy for whether the fork models the
ability at all — zero means certainly not.

| R&B? | Ability | `ai/src` refs | Gen 9 gates |
| --- | --- | --- | --- |
| ? | Anger Shell | 1 | 1 |
| ? | Armor Tail | 2 | — |
| ? | Beads of Ruin | 1 | — |
| ? | Commander | 5 | — |
| ? | Costar | 1 | — |
| ? | Cud Chew | 4 | — |
| ? | Earth Eater | 1 | 1 |
| ? | Electromorphosis | 1 | — |
| ? | Good as Gold | 2 | — |
| ? | Guard Dog | 1 | 1 |
| ? | Hadron Engine | 1 | 1 |
| ? | Lingering Aroma | 3 | 1 |
| ? | Mycelium Might | 3 | 1 |
| ? | Opportunist | 1 | — |
| ? | Orichalcum Pulse | 1 | 1 |
| ? | Protosynthesis | 10 | 1 |
| ? | Purifying Salt | 2 | — |
| ? | Quark Drive | 3 | 1 |
| ? | Rocky Payload | 0 | — |
| ? | Seed Sower | 1 | — |
| ? | Sharpness | 0 | — |
| ? | Supreme Overlord | 0 | — |
| ? | Sword of Ruin | 1 | — |
| ? | Tablets of Ruin | 1 | — |
| ? | Thermal Exchange | 2 | 1 |
| ? | Toxic Debris | 1 | 1 |
| ? | Vessel of Ruin | 1 | — |
| ? | Well-Baked Body | 1 | 1 |
| ? | Wind Power | 2 | — |
| ? | Wind Rider | 1 | — |
| ? | Zero to Hero | 5 | — |

## Items

Present in `ITEMS[9]` but not `ITEMS[8]`.

| R&B? | Item | `ai/src` refs | Gen 9 gates |
| --- | --- | --- | --- |
| ? | Ability Shield | 2 | — |
| ? | Adamant Crystal | 0 | — |
| ? | Auspicious Armor | 0 | — |
| ? | Booster Energy | 3 | — |
| ? | Clear Amulet | 4 | — |
| ? | Covert Cloak | 1 | — |
| ? | Griseous Core | 0 | — |
| ? | Loaded Dice | 0 | — |
| ? | Lustrous Globe | 0 | — |
| ? | Malicious Armor | 0 | — |
| ? | Mirror Herb | 1 | — |
| ? | Punching Glove | 1 | — |
| ? | Strange Ball | 0 | — |
