# ROM fidelity corpus — 1,727 emulator-captured damage observations

Ground truth for `scripts/rom-band-check.js` and `rom-band.test.js`.

## Provenance

| | |
| --- | --- |
| Origin | `PhilapR/pokemon-mono`, `contracts/cross-engine/fidelity/` |
| Commit | `be6570d6391a1fd4602c83959f92c2ea2c957198` (2026-07-29) |
| Captured by | `groundtruth/pykemon` — an instrumented emulator reading damage out of the running Run & Bun ROM, not a reimplementation of it |
| Sweep | 2026-07-24; 3 fixtures × 30 seeds = 90 battles, 965 turns |
| Method | `groundtruth/pykemon/SPIKE-GROUND-TRUTH.md`, "FIDELITY RESULTS" |
| Provenance tag | `emulator-observed` (see `profiles/profile.js`) |

Vendored rather than referenced: the gate has to run in CI on a clone of this
repository alone, and evidence that only exists on one machine is not evidence.

Copied byte-for-byte. Do not edit — regrading the corpus to make a gate green is
the one thing that would make it worthless.

```
8894cdc158d26d8940544c107f453f71e5ccefbb27809a8682db636695b394f6  events-f1-combusken-breloom.json
8dfabd81eb4b2570e1cb8fb7704b16c4049b5749b778993e812f66e112db339a  events-f2-golduck-grovyle.json
84d7f7cdcda46f397c0053c4151539cc60d5f25659622359ee9442854ca9c170  events-f3-kadabra-hariyama.json
```

## What is in each file

Self-describing: every file carries the fixture it came from, both sides in
full, and the conventions its bands were captured under.

| Field | |
| --- | --- |
| `sides.{A,B}` | `species`, `level`, `types`, `moves`, and the exact `stats` the sweep injected into the ROM. These stats are authoritative — the harness feeds them through `statOverrides` rather than recomputing them from base stats. |
| `band_conventions` | No ability, no item, no stat stages, no weather or terrain; 16 rolls at 85–100%. |
| `observations` | One per damage event: `attacker`, `move`, `damage`, `crit_detected`, `censored`, `attacker_status`, `defender_status`, plus the seed and turn it happened on. |
| `n_observations` | Scored observations — 471 + 593 + 663 = **1,727**. |
| `n_censored` | 67 events where the defender fainted. The ROM only shows the HP that was left, so the number is a lower bound on the roll, not a roll. The gate skips them. |
| `proc_rows`, `anomalies`, `battles`, `seeds` | Secondary-effect proc data and per-battle bookkeeping. Unused here. |

### The `band`, `in_band` and `n_in_band` fields are NOT ground truth

They are what the *capturing* engine (rab's TypeScript calculator) predicted at
the time of the sweep, and it was wrong 11% of the time: 1,531/1,727 = 88.65%,
with all 196 misses on the low side. Two rounding-order bugs caused it — a
non-floored `2·level/5 + 2` term, and applying the roll after all modifiers
instead of flooring per stage. Read `damage` and `crit_detected`; ignore the
verdict fields.

## Two facts the sweep established about Run & Bun

- Crit is **×1.5 applied before the damage roll**, not to the finished roll.
  Detected crit rate 94/1,727 = 5.44%, CI [4.4, 6.6] — consistent with 1/16,
  excluding Gen 7+'s 1/24.
- Damage floors at every stage of the ROM's own order. The discrete value set
  matters, not just its endpoints: Combusken's Flamethrower into Breloom can
  only ever deal 90, 92, 96, 98, 102, 104 or 108 — never 94.

## What the corpus does not cover

Abilities (Run Away was injected on both sides), items, stat stages, weather,
terrain, multi-hit moves, and any status on a *physical* attacker — the burned
sides in this corpus only ever clicked special moves, so the burn path is
modelled by the harness but not exercised by the evidence. A gate is only as
wide as its corpus, and this one is 1v1, ability-free, single-target damage.
