# Evaluation strategy — what we gate, what we measure, what we plan

This document answers one question for every risk the project carries: which
instrument does it get? The wrong instrument is worse than none — a gate on
an evolving surface freezes bugs and punishes improvement; a trend line on a
frozen invariant lets corruption in politely.

**The rule: gate what is frozen, evaluate what is evolving, plan what is
dormant.**

- A **gate** is mechanical, binary, and blocks a merge. It is reserved for
  invariants that must never drift: hash chains, archived evidence, contract
  digests, accessibility floors. A gate is not done until it has been made to
  fail (AGENT-PRACTICE rule 5).
- An **evaluation** is a number we record and trend. It informs judgment and
  never blocks. Evolving surfaces — plan accuracy, data coverage, play
  experience, performance — live here. Moving an evaluation to a gate is a
  deliberate promotion with a reason, not a reflex.
- A **plan** is a named trigger and a decision owner, with zero code. Dormant
  layers live here until the trigger fires.

The knowns/unknowns framing maps onto the instruments directly:

| Class | Instrument | Why |
|---|---|---|
| Known knowns (invariants we rely on) | Gates | Cheap to check, catastrophic to lose |
| Known unknowns (questions we can name) | Evaluations | Measure and trend; judge with context |
| Unknown unknowns | Insurance, not tests | Retain raw material, date everything, invite fresh eyes |

Unknown unknowns cannot be tested for by definition. The insurance that works:
keep every real archive and receipt (raw material to re-check any future
hypothesis against the past); keep provenance on everything (so when a
surprise arrives it can be dated and bisected); and schedule fresh-eyes
adversarial review of one load-bearing component per season — the
attempt-store review found nine real defects in code the suite called green.

---

## The five named risks, each with its instrument

### 1. Receipt-replay compatibility — GATE, with an acceptance valve

Today every check replays the current engine against the current engine.
Nothing replays yesterday's receipts against tomorrow's engine, so an
innocent battle-code refactor that changes RNG consumption order would
silently orphan every archived receipt.

The instrument is a **frozen replay corpus**: a small set of real receipts
(one per receipt schema era, one per notable battle shape) that every engine
change must replay bit-identically. The over-gating trap is real here — the
engine SHOULD change when it was wrong about the game. So the gate carries an
acceptance valve, same shape as the upstream audit's Policy B: a mismatch
fails the gate unless the change lands with an `expectedDivergences` entry
naming the receipt, the field, and the reason. Silent drift is impossible;
deliberate drift costs one honest line.

Status: not built. Cheap now (the corpus is three receipts), unbuildable
later (old receipts against old engines cannot be regenerated).

### 2. Game-version staleness — PLAN plus one provenance field

Run & Bun itself is a moving target with no version pin anywhere in the
oracle. When the hack updates, the oracle is silently stale and the first
symptom will be a wrong damage roll mid-run.

Not gateable: nothing in this repository can observe the hack's release
channel. The instruments are:

- One provenance field: `gameVersion` (the decomp revision the oracle was
  imported from) in the oracle provenance block, shown in the Lab.
- A plan trigger: any session that re-runs an import script checks the decomp
  for upstream movement first and records what it found.
- An evaluation: oracle coverage numbers (below) trend against the same
  decomp revision, so a version bump visibly resets the baseline.

### 3. Migration debt — GATE over a real-archive corpus

Every schema change owes every saved run a correct upcast, forever, and the
v1 upcaster was the buggiest code the adversarial review found. The
instrument is a **migration corpus**: real archives (not synthetic fixtures),
one per schema era plus one per notable shape — a wiped run, a completed run,
a run with attribution receipts, an imported legacy run. Every migration must
round-trip the whole corpus: upcast, validate, export, re-import, byte-equal
heads. Gate, not evaluation — losing a player's run is the one unforgivable
failure, and the corpus only grows by one archive per era.

Curation rule to avoid bloat: the corpus is a museum, not a landfill. New
archives enter only when they exercise a shape the corpus lacks.

### 4. Suite wall-clock — EVALUATION with a promotion threshold

Gates must stay fast; the fix is architecture, not timeouts. Instruments:

- Split the lanes: `test:fast` (units and style guards, seconds) for the
  inner loop; the full suite for pre-push and CI. Fast lane failures and full
  suite failures mean the same thing — the split changes when you learn, not
  what.
- Trend the wall-clock: record full-suite duration per CI run. The promotion
  threshold: if the suite doubles from its baseline, the next session's first
  task is test architecture, before any feature.

### 5. The fun ceiling — EVALUATION, human-shaped

The entire data spine starves if the operator does not voluntarily play. No
gate can measure this, but it can be evaluated honestly:

- **Completion shape** (already derivable from the collection layer): runs
  started vs runs finished vs farthest point, trended per month. The archive
  shelf computes this today; nobody looks at it as a health metric.
- **The run journal**: three lines after each real run — what dragged, what
  delighted, would you start another. Kept in the run's own notes, not in
  ceremony.
- The trigger: two consecutive runs abandoned mid-split means the next work
  is product, not plumbing. This is the only evaluation in the file that
  outranks every gate.

---

## The evaluation gap — what we measure today vs what matters

The project gates correctness magnificently and trends almost nothing.
Current coverage, honestly assessed:

| Surface | Today | Missing |
|---|---|---|
| Engine correctness | Gated exhaustively (unit, fixture, falsify) | — |
| Contract conformance | Gated (digests, conformance, provenance) | — |
| Determinism | Gated (current-vs-current) | The replay-compat corpus (risk 1) |
| Accessibility/style | Gated (floors, guards) | — |
| Plan accuracy | Per-fight comparison rendered in history | **No trend.** "How often did the sampled risk match played reality" is computable from existing receipts and never aggregated. This is the single most informative number the app is not producing. |
| Advice uptake | Nothing | Did the player field the recommended lead? Receipts + battle events already contain both sides. |
| Oracle coverage | Import-time counts, printed once | Trend: TM dating 56/78, learnset coverage, item coverage — per decomp revision |
| Performance | Nothing | Plan latency, worker cold start, suite wall-clock |
| Play experience | Nothing | Completion shape + run journal (risk 5) |

The pattern in the gap: everything missing is longitudinal — numbers that
only mean something across runs and weeks. That is exactly the collection
layer's job, which is why these evaluations belong in the Runs surface when
it exists, not in more gates.

## What this file is not

Not a backlog. The instruments here are built when their box is touched or
their trigger fires, in this order of cheapness: replay corpus and migration
corpus (collect now, while small), gameVersion field (one import-script
line), lane split (one package.json change), plan-accuracy trend (first
feature of the Runs surface). Nothing here justifies a new layer; every item
lives inside an existing box.
