# Repository Guidelines

## Scope

This repository is a Run & Bun-focused fork of the open-source Pokémon damage
calculator. The project has three important boundaries:

- `calc/` is the reusable damage-calculation library.
- `src/` is the browser UI and Run & Bun orchestration layer.
- `ai/` is the Run & Bun decision-policy layer.

Keep Run & Bun policy code out of `calc/src/mechanics/`. The calculator should
answer what happens when an action is taken; the AI should decide which action
to take.

## Architecture rules

- Treat `calc.calculate()` as a read-only calculation oracle. It clones its
  inputs and returns a `Result`; it does not advance battle state.
- Keep AI state serializable and independent of calculator class instances.
  Convert `ai/` state into `Pokemon`, `Move`, and `Field` objects at the
  adapter boundary, then convert `Result` into simple decision facts.
- Keep Run & Bun-specific scoring, switching, target selection, and turn-state
  transitions in `ai/`.
- Prefer small, named rule modules over a single large move-scoring function.
- Do not parse human-facing strings such as `Result.kochance()` to drive
  decisions. Derive machine-readable facts from damage rolls and state.
- Preserve the existing public calculator API unless a generic calculator
  capability is genuinely missing.
- Keep fork-specific calculator mechanics explicit and regression-tested. The
  current critical-hit overlay includes Magma Armor alongside Battle Armor and
  Shell Armor; keep that rule in the generation damage paths, not in AI policy.
  Soul Dew is another fork overlay: apply its +1 SpA/+1 SpD effect to Latias
  and Latios as clamped stat stages in the calculator boundary, rather than as
  a second direct damage modifier.
  Apply the fork's 1.5× critical-hit damage multiplier consistently across the
  supported generation paths.

## Source and generated files

- Edit TypeScript under `calc/src/` and AI source under `ai/`.
- Edit UI source under `src/`.
- `dist/` is generated output. Do not hand-edit it; regenerate it with the
  repository build process when dependencies are installed.
- Treat the Run & Bun documentation in the parent workspace as source material,
  not as executable code. A mechanic or move change is not implemented until
  it has corresponding code and tests.

## Two order scales, and `#` means only one of them

`order` counts cumulative enemy POKEMON before a fight. A player counts
TRAINERS. Leader Brawly is order 80 and the 29th fight of 366. The two numbers
are far apart, and they get further apart as the run goes on.

`#N` in this repository always means ORDER. `#48 Camper Gavi` is order 48, not
fight 48 — Camper Gavi is the 17th trainer. Every dated source is in order:
LEVEL_CAPS, availability's items and moveItems, the HM gates, a fight's own
`order` field.

Do not write "fight #N" for an order. That phrasing sent a reader 51 trainers
and two gyms past a TM unlock. `lib/play.js` printed "opens at fight #77" for
TM16, and TM16 unlocks at fight 26. Say "order N", or convert with
`run.trainerIndexOf(run, order)` and say "fight #N" truthfully. The converter
belongs at the edge: the data is in order, and only presentation wants
trainers.

`tests/order_scales.test.js` pins the anchors and asks whether each dated row
is one of the 366 real fight orders.

It asked something weaker until 2026-08-26, and the difference matters.
`run.trainerIndexOf` SNAPS FORWARD to the first fight at or after its argument,
so `trainerIndexOf(doc, x) !== null` only asks whether x is at most 1625. All
362 trainer numbers passed it, and so did all 435 engine row indexes. Both
scales this section exists to keep apart went through it unchallenged, and the
item ledger shipped in the wrong one twice.

Set membership is not a complete test either — 97 of the 362 trainer numbers
are also real orders — so it is paired with the named anchors, which pin a row
to the fight its own place names. Use both.

## Changing what something costs

Performance work is not one kind of change. The bar differs for each kind.
Decide which kind you make before you make it. Name that kind in the commit.

1. **Waste** — the output is provably identical. One example: the code builds
   an object, reads one immutable field, and discards it. Bar: show that the
   work count fell and that the result did not.
2. **A cache behind an assumption** — the output stays identical only while
   something stays true. Bar: probe the dependency to establish that
   assumption, and do not conclude from a reading of the code. Gate the probe
   apart from the thing it enables, so the cache cannot outlive its premise.
   `tests/adjudication_cost.test.js` pins what moves `stats.spe`, which is
   what makes the speed cache in `ai/src/order.ts` safe across a battle.
3. **A behaviour change** — the output differs. This is not performance work,
   even when it is faster, and it must not travel as performance work. Bar: a
   ledger finding, evidence that the new answer is better, and the usual
   falsification. The ranker now plays four different sixes; it also costs 54%
   less, but that is a side effect and not the argument for it.

   Evidence means a measurement on frozen code, not a good argument. Three
   changes in one day passed the argument and failed the measurement: they
   priced status moves by what they take away, spent a body to bring a counter
   in free, and added noise to a retry. Each rested on a real mechanism and
   each read convincingly, and each shipped OFF once thirty interleaved pairs
   had spoken.

   A fourth ranks moves by turns rather than by damage. That models the game
   better and bought nothing. It ships because it is no worse.

   So a behaviour change defaults to OFF behind a flag until an experiment on
   one revision says otherwise, and the flag stays afterwards. `scripts/ab.js`
   refuses a comparison whose revision moved, whose tree was dirty, or that
   passed a flag nothing read, because all three happened here.
4. **A contract change** — it removes something that the design promises. Bar:
   Philip decides. No consumer reads a value today, and that fact alone does
   not make the value dead. `planner.js` says that both crit bands travel with
   a cell, "so no consumer has to re-derive them from an average". That
   sentence states what a cell is.

Measure work, not time. This repository shares a runner with every other build
on the machine. A millisecond assertion then measures load as often as it
measures the product. Three timing gates flaked that way in one session, at
load averages between 17 and 139. Count objects, calls, or rollouts instead. A
count is exact, and it moves only when behaviour moves.

Record a cost next to the contract that causes it. Give the measured price of
each deliberate design choice. A reader cannot weigh a cost that nobody wrote
down. The next person meets that cost in a profiler, not in the design.

## Evidence and gates

These rules come from measured failures. Each rule names its incident.

- Make a new gate fail one time before you trust it. A gate that has never
  failed can be a tautology. Two gates here passed with their comparison
  deleted.
- Count the treatment before you credit the result. An experiment is valid
  only when its logs show that the treatment fired. Three batches produced
  significant tallies from treatments that never ran.
- Prefer a gate that closes a class to a gate that pins one instance. The
  class gates here enumerate every fight (each one must start) and every
  dated item (each one must be collectable). Both found holes that instance
  gates had missed for a week.
- Anchor new dated data to a trainer label, not to a raw order. A label
  survives a map insertion. The Route 103 insertion moved fourteen
  order-anchored stores by hand and zero label-anchored stores.
- Stamp each run document with `ORDER_SCALE.id` at creation. A reader of a
  banked document must refuse a stamp that it does not know.
- Keep one implementation for two consumers. When two surfaces must render
  the same text, share the function and add a parity gate. `lib/battle-view.js`
  and the panel threat line are the example.
- Digest each experiment batch. Give the batch a label, write the
  calibration, ingest it to MLflow, and run `trace_qc.py`. The standard and
  the retention rules are in `experiments/README.md`.
- Stamp each measured manifest in `scenarios/`. Add a `measured` entry that
  names the batch label and the commit that carries the batch. Stamp in the
  commit after the batch lands, the same as a ledger `fixed_in`. The battery
  writes a receipt to `scenarios/receipts/<label>.json`; commit the receipt
  with the batch. `tests/manifest_provenance.test.js` verifies each stamp
  against the branch, and each `recorded` stamp against its receipt. Before
  this gate, only session memory recorded the four void batches.

## A deviation from the mainline games is not a bug

This is a hack, and a hack IS its deviations. Before treating behaviour that
differs from the mainline games as a defect, check all three:

1. `profiles/run-and-bun/index.js` — the `mechanics` block states the rule
   deltas, and `provenance` says how well each is sourced. `source-of-truth`
   is the highest tier the profile has.
2. `docs/AI_DATA_MODEL.md` — describes what the engine models and why,
   including where it departs from stock Generation 8 on purpose.
3. `DECISIONS.json` — standing rulings. Several were opened as suspected bugs
   and closed by an audit *without changing code*; `enforcedBy` on each ruling
   names the files that hold it up.

`tests/runbun_mechanics.test.js` asks the engine and compares it against the
profile for every flag it can drive, and requires each declared mechanic to be
either driven there or listed with a reason. If it fails naming a flag, the
declaration and the implementation have come apart — decide which is wrong
rather than changing whichever is easier to reach.

A test asserting behaviour that looks wrong is not automatically a bug locked
in by omission. Read what it cites before flipping it. Gender-independent
Attract was "fixed" this way once, against four separate records saying it was
the rule, and reverted in `dedb4d0`.

## Build and validation

- Run `npm install` at the repository root; the root `postinstall` provisions
  both `calc/` and `ai/` through `subpkg`.
- Run `npm test` for the full calculator, AI, build, and supported UI lint gate.
  `dist/` is regenerated by that command and must not be hand-edited.
- Keep the root `lint`, `compile`, `build`, and `test` scripts explicitly
  calculator-first, then AI. The AI package consumes the local `calc/` junction,
  so this ordering keeps its compiled dependency boundary stable.
- The root `lint` and `test` gates run eslint on the full directories `src`,
  `profiles`, `lib`, `tests`, `scripts`, and `fixtures`. Do not add a
  hand-written file list to a gate; a stale list narrows the gate without a
  signal. Put an exclusion in `.eslintignore`. The gates do not use `--cache`;
  a stale cache hid five errors before (commit 01d5e1a). `npm run lint:fast`
  keeps `--cache` for a quick local pass. It is not the gate.
- The AI package test command compiles `ai/src/test/*.ts` and discovers every
  compiled `dist/test/*.test.js` fixture automatically; adding a fixture does
  not require maintaining a second hand-written command list.
- Any fixture that exercises a probabilistic action gate must pass an explicit
  deterministic sampler. For example, a paralyzed actor needs a roll above
  the paralysis-failure threshold when the fixture is testing a later effect.
- The legacy `shared_controls.js` script is now included in the root lint gate.
  Its Ctrl-key behavior supports append-vs-swap dragging; there is no separate
  multi-row selection model.
- `src/js/data/sets/gen8.js` is authored Run & Bun trainer data, not generated
  output. Never regenerate it from an upstream set source: the removed `import/`
  generator did exactly that and destroyed the trainer parties.
  `runbun_sets.test.js` runs in the root gate — see `docs/TASKS.md`.

## Data rules

- **Ask the game before reading its source.** Every fact about Run & Bun —
  encounters, unlock order, learnsets, evolutions, catch rates, trainer teams
  — is behind the profile oracle, and `node scripts/ask.js` answers the common
  questions directly. `docs/DATA-ACCESS.md` documents the full API, including
  the return shapes that mislead: `levelUpMoves` gives `[level, move]` PAIRS
  (an object-style `.filter(m => m.level <= 5)` silently returns nothing),
  `encountersOn` wraps its list under `.mons`, and `availabilityOf` returning
  `null` means UNDATED, never closed. Re-deriving these by grep is how the
  same mistakes get made twice.
- Use stable Pokémon and move IDs in AI state; do not use array positions as
  identity.
- Treat explicit caller-defined `MoveState` fields as authoritative overlays;
  in particular, preserve `contact`, `heal`, `punch`, `bite`, `pulse`,
  `slicing`, and `bullet` through metadata and calculator/order/resolution
  boundaries so custom moves participate in contact-triggered abilities/items,
  Triage, and calculator modifier/immunity rules.
- Keep current HP, party membership, active slots, field effects, and move
  availability in explicit state fields.
  The Run & Bun rules remove EVs from battle calculations: AI state may retain
  an optional EV map for transport compatibility, but every AI calculator,
  order, accuracy, entry, and raw-stat projection must use an explicit zero
  EV map. The inherited `calc/` package remains EV-capable for OSS API
  compatibility.
- Treat additive stat changes and absolute stat-stage updates as separate
  transition contracts. Use absolute stage updates for copy/swap moves rather
  than encoding them as guessed deltas.
  Keep Substitute HP on `PokemonState`, never on `SideEffects`; damage must
  consume the Substitute pool before reducing real HP.
  Preserve sound-based Substitute exceptions in move resolution: Perish Song
  may apply through Substitute, but Soundproof must still block it.
  Run serialized state through `validateBattleState()` and serialized actions
  through `validateAction()` at external boundaries; do not scatter partial
  shape checks across policy modules. Invalid boundary payloads should become
  explicit client errors (HTTP 400), not accidental internal failures.
  Derived Protect belongs to the acting Pokémon, not the side; retain the
  side-level flag only as a compatibility input.
  Keep Endure distinct from `protected`: its one-turn volatile caps direct
  damage at 1 HP at the transition boundary, without granting Protect-style
  immunity. Recoil, residual damage, and healing are separate HP deltas, and
  Endure participates in the consecutive-protection failure sampler.
  Derived Helping Hand belongs to the selected ally; do not model one ally's
  Helping Hand as a side-wide attacker modifier.
  Secondary-effect resolution must apply the generation-aware attacker
  boundary: Serene Grace doubles canonical secondary chances, Sheer Force
  suppresses damaging-move secondaries, and Shield Dust/Covert Cloak block
  opposing additional effects without suppressing a holder's own self-effects.
  Sampled multi-hit arrays roll only for actual hits that reach the target;
  aggregate multi-hit facts without a hit array must derive the same count
  from direct damage after Substitute rather than assuming one hit.
  Opposing move resolution must also use the shared ability-bypass boundary:
  Mold Breaker, Teravolt, and Turboblaze suppress target abilities from
  Generation IV onward, while Mycelium Might suppresses target abilities for
  status moves from Generation IX onward. This covers status immunities,
  Sturdy/Disguise, reactive contact abilities, and Suction Cups phazing.
  Neutralizing Gas is a global Generation VIII+ suppression boundary: an
  active holder suppresses other active abilities, while Neutralizing Gas,
  canonical non-suppressible abilities, and an effective Ability Shield remain
  active. The shared ability predicate owns this check so calculator
  projections, status eligibility, ordering, residuals, and post-hit responses
  cannot disagree about whether an ability is available.
  Canonical sound flags are the source of truth for Substitute and Soundproof:
  sound moves bypass Substitute, Soundproof blocks their target effects, and
  the category-aware ability bypass is applied before that Soundproof check.
  Life Orb recoil is a separate Generation IV+ indirect-damage effect: it
  applies once after positive move damage, is suppressed by Magic Guard, and
  is also suppressed by Sheer Force only when the damaging move has a secondary.
  Status-synergy scoring may use the active partner's moves and the target's
  modeled confusion/infatuation state, but those facts must be explicit in
  `ActionFacts`; do not infer partner support from side-wide booleans.
  In Doubles, derive active ally Friend Guard, Battery, and Power Spot auras at
  the calculator boundary, excluding the Pokémon that owns the move; retain
  SideEffects fields only as compatibility inputs.
  Derive active global aura abilities and Sun-conditional Flower Gift at the
  calculator boundary with generation gates and ability suppression; retain
  explicit field booleans as compatibility inputs.
  Calculator Pokémon inputs and emitted ActionFacts must project abilities
  through the shared generation-availability map, backed by the inherited
  calculator's canonical ability tables; do not pass a known pre-introduction
  ability string into calculator stats or policy facts.
  The public evaluation boundary must normalize caller-provided ActionFacts
  through the same ability/item generation gate before scoring or deriving
  replacement viability; direct low-level scoring helpers accept already-normalized facts.
  Explicit ability suppression and `abilityOn: false` must omit the ability
  from calculator `Pokemon` and `Move` projections as well; policy-only
  suppression is insufficient because canonical immunities, damage modifiers,
  Skill Link hit counts, and Max-move selection otherwise remain active.
  Derived Foresight belongs to the affected target; do not reveal every
  Doubles partner when only one target was hit.
  `ActionFacts.priority` must come from the shared effective order boundary,
  including generation-gated Prankster, Gale Wings, Triage, and Stall effects;
  fractional item priority remains a separate order fact, and the adapter must
  not expose only the calculator's canonical move priority.
  Leech Seed belongs to the affected target; use `PokemonState.volatile` for
  derived facts and retain side-level `seeded` only for compatibility inputs.
  Replacement viability is a conservative matchup boundary: derive only
  `faster`, `notOHKOd`, and `not2HKOd` from a hypothetical legal entry and
  opposing move facts; keep full replacement scoring caller-owned, and let
  explicit caller viability values override derived values.
- Keep action selection separate from state mutation. A chooser returns an
  action; `ai/src/transition.ts` applies the transition.
- Read `docs/ENGINE-CONTRACTS.md` before you edit a move, an ability, an
  item effect, or a transition in `ai/src/`. It holds the per-mechanic
  contracts that past changes broke. Add a new contract there when a
  regression teaches one.
- Preserve uncertainty explicitly if hidden information is introduced later.
  The initial Run & Bun model assumes the AI has the full information described
  by the game’s AI documentation.

## Validation

Install dependencies before running checks. The normal validation command is:

```sh
npm test
```

Calculator-only checks can be run from `calc/` with `npm test` and
`npm run lint`. New AI rules should have focused fixtures covering the input
state, candidate action, derived facts, expected score outcomes, and selected
action.

When changing the calculator and UI together, build from the repository root
so the generated `dist/` output stays synchronized.

## Change hygiene

- Keep upstream calculator fixes separate from Run & Bun policy changes when
  practical.
- Avoid changing generated data manually; document its source and regenerate
  it through the importer when possible.
- Do not add a new special case to the damage mechanics merely to implement an
  AI preference.

## Parallel work

- Use a dedicated, named worktree for every concurrent or cross-repository
  lane. Never share a worktree between agents or absorb unrelated dirty paths.
- Declare one disjoint write set per lane using the table in `docs/SDLC.md`.
  Shared contract files have one owner; consumers develop against pinned
  fixtures or recorded receipts.
- Stage explicit paths, re-check status immediately before committing, and do
  not use stash as a coordination mechanism.
- Rebase onto the current target, rerun the lane gate, and integrate with a
  fast-forward. A rejected fast-forward is drift evidence, not permission to
  force or weaken a fixture.
- Record exact lane revisions and the contract digest in an integration matrix
  before cross-repository compatibility or deployment may be claimed.
