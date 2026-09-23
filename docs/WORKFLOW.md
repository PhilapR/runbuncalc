# The workflow, and where it is weak

Written 2026-09-22 from the repository's own records: `docs/PLAN.md`,
`DECISIONS.json` (11 open questions), `ledger/findings.json` (44 of 123
findings open), `docs/IMPROVEMENT-AUDIT.md` (backlog) and
`docs/MODELLING-GAPS.md`. `docs/PLAN.md` holds the ordered work and its bars;
this page is the map it is chosen from.

The goal it serves: **a pinned, start-to-finish PERMADEATH run that beats every
required fight, on one revision, audit valid, with no operator hand** (ruling,
Philip, 2026-09-23). None exists yet. Rehearsal runs (`permadeath: false`, walls
retried) are how the policy got better; their depth says nothing about a
permadeath run. Under `--nuzlocke=1` every run so far loses its last body before
Brawly: median fights won 13.5 at baseline, 18 with search and planning on the
first attempt, 21 with Camper Gavi put off until it scouts safe
(`scenarios/measurements/nuz-*-bar.md`).
Seed 418957 reached Champion Wallace across four revisions, with its Elite Four
played before the engine fix and an operator lead at the end. Seed 209499's
clear predates the engine fix.

## The stages

| # | Stage | What it is | Health | Weak points and backlog |
|---|---|---|---|---|
| 1 | Game data | sets, run map, encounters, items, dates (`profiles/run-and-bun`) | amber | Gifts, trades, fossils and roamers wait on one ruling (`do-gifts-consume-an-area-encounter`). Earth Power has no dated place. Every gendered Pokémon is male, and no gender-ratio data exists. 8 catchable species have no level-up moves. The Rustboro encounter table has drifted. About 12 open findings are data or provenance. |
| 2 | Battle engine | mechanics (`ai/src`) | amber → green where graded | **2026-09-22:** lead entry abilities fire at battle start; Download (ROM direction), Intimidate blockers and reactors, White Herb, Primal weathers (permanent, as the hack's doc says); gate order from the ROM (sleep/freeze before Truant and flinch, paralysis before infatuation); enemy AI move scoring ported to 85 ROM probes (held-out top-1 0.972, TVD 0.019). Every opening is swept (`tests/fidelity_openings.test.js`); the mechanics gate drives each declared hack rule. Still open: PP off by default (a stall is infinite), 18 doubles planned as singles, Mega timing, Kubfu's form roll, Room Service. |
| 3 | Run rules and audit | `lib/run.js`, `scripts/audit-run.js` | amber | The audit replays commands, not battles, so it cannot see an engine change. Receipts carry no engine version. A run row names only its last leg's revision. A move at the evolution level costs a Heart Scale. Status and forgetting a move at the nurse (free in game) are not modelled. The economy spends items it has no source for. |
| 4 | Planner | the six, order, Mega, plan-by-play | amber | Held items can be planned (`--plan-items`, off until measured on held-out walls); the matchup board now opens cells as the fight does. Plans vary only the first foe and the last two (2.3). The Mega is not a planned choice (2.2). The upgrade advisor prices a tenth of the movepool. |
| 5 | Fight policy | decide, search, joint doubles search | green | Mostly measured and rejected, which is fine. Unbuilt: phazing set-up users, stall play. When search scores a loss, it ignores how many of our Pokémon survive. Which two lead in doubles is an assumption (`doubles-lead-order`). |
| 6 | Harness and run control | slot pool, checkpoints, carry-on, fallbacks, jobs | green | Every leg of a run names its engine; batteries, A/B arms and plan-by-play are watchable jobs (`lib/watch.js`). Open: rab-workspace's planning worker needs its side of the job wiring (a change request exists); pinned worktrees load the main checkout's calc. |
| 7 | Measurement | battery, held-out seeds, paired tests, `scripts/falsify.js` | green | Re-baselined on the corrected engine (`base0923-*` receipts, one engine stamp); `battery-pair` refuses cross-engine joins and reports McNemar. heldout3 is kept unspent as the confirmation set. **2026-09-23:** `scenarios/frontier.json` (`scripts/frontier-set.js`) is the first set past Norman: 77 fights the stored runs lost 3+ times, Gavi to Champion Wallace, doubles included, cut from each run's own log. Every earlier set stopped at Norman. |
| 8 | Observability | watch page, insight MCP tools, fight view, wall view | green | The wall view (per foe, hazards, end-of-turn and recoil counted apart) and past attempts on the fight tab exist; doubles tapes are read. |
| 9 | Performance | cost per decision | amber | `rankParties` about 8 s, twice that with a Mega. One searched decision 8–12 s. About 10 h a run, about 1 h for a wall at 40 attempts. |

## Fidelity

What changed the game under every earlier number:

- `8cc3ece`: the leads' entry abilities never fired at battle start: no
  Intimidate, no ability weather, no surge terrain. 74 of 366 fights opened
  wrong. Primordial Sea, Desolate Land and Delta Stream were never
  implemented.
- `e6399d2`: Download was never implemented. The same commit adds
  `tests/fidelity_openings.test.js`, which opens every fight the way a run does
  and checks it. It is falsified four ways and runs in the fast suite.
- The bias went both ways: foes lost their opening Intimidate and weather, and
  our own Intimidate leads (Staraptor at Norman) never fired either.
- Declared, not a defect: ability weather and terrain are **permanent** in
  Run & Bun (`docs/AI_DATA_MODEL.md`).

ROM evidence beyond damage now exists (pokemon-mono PR #6, `groundtruth/pykemon`
P0–P5): stat stages, status and weather mapped in RAM; entry abilities and the
action-gate order observed. Open: whether Primal weather outlives a fainted
holder in the ROM (P3, needs a second party member), and a sweep for the
turn loop (mid-fight rules a composed-pipeline test does not reach).

## The flywheel

The loop this repository turns: **a full run stalls at a wall → the wall
becomes a scenario → an arm is measured on it → what passes its bar is
adopted → the next run goes further.** It jammed at the second step: the
scenario sets were picked once, from archives before 2026-09-18, and none
reached past Norman, so walls the runs found (Matt, Shelly, Archie, Sidney,
Glacia, Wallace) were studied by hand and never measured.
`scripts/frontier-set.js` closes that step. Re-run it after each batch of
full runs; the manifest records the rule, so the set grows by the same rule,
not by choice.

What still slows each turn:

1. **Diagnosis is by hand.** A wall is read from tapes by a person or an
   agent. The wall view (`insight`) says per foe what it costs; it does not
   yet propose an arm.
2. **Fidelity has a guard for openings only.** The same idea is owed for the
   turn loop; the engine fixes of 2026-09-22 were found by hand, twice by
   Philip from the hack's own `Mechanic Changes.txt`.
3. **A pin of whole output breaks on every engine fix** (`item_planning`'s
   hash, replaced 2026-09-23). A test pins what the change promised, not a
   snapshot of play.
4. **Full runs cost about 10 hours.** The battery is the fast loop; a run is
   the confirmation, not the experiment.
5. **The gate had an unnamed intermittent failure** (twice on 2026-09-22).
   Its log was lost with a worktree; keep suite logs until a failure is named.

## Order of work, cheapest first

1. ~~Fidelity check of opening states~~ — done, `e6399d2`.
2. ~~Re-run baselines~~ — done, `base0923-*`.
3. ~~Plan held items~~ — built, off (`--plan-items`); measure it on the
   frontier set before adopting.
4. ~~Wall view~~ — done.
5. ~~Retire `docs/ROADMAP.md` and `docs/TASKS.md`~~ — done 2026-09-22, see
   `docs/attic/README.md`.
6. Frontier baseline (`front0923-*`), then the arms that wait for it:
   `--plan-items` (built, off) and the Mega as a planned choice
   (`docs/PLAN.md` 2.2, not built).
7. A turn-loop fidelity sweep against the ROM probes.

Parked, each with no bar and so not ready to start:

- New per-turn policy arms (repeatedly rejected).
- The old roadmap's reinforcement-learning and emulator phases
  (`docs/attic/ROADMAP.md` phases 5–6): training a policy, NPZ tensors,
  an mGBA observation bridge, a rebuilt runtime.
- Hosted run storage (a Durable Object per attempt, R2 archives). The local
  IndexedDB ledger is the save; the old roadmap made hosting conditional on a
  need that has not appeared.
- The private Worker. Its last deployment receipt is revision `ad0e0bc`,
  2026-08-18 (`contracts/ecosystem/v1/attribution-local-evidence.json`,
  promoted in `7850276`). The repository records no deployment since, so the
  live app is about a month behind the engine.

## Maintenance procedures

Carried from the retired `docs/TASKS.md`; checked against the tree on
2026-09-22.

- **Trainer set data.** `src/js/data/sets/gen8.js` holds the Run & Bun
  trainer parties, keyed by trainer name, with an `index` ordering each
  party. It is authored by hand. Never regenerate it from an upstream set
  source: the removed `import/` generator replaced it with Smogon usage sets.
  To change it, edit the file, then `npm run build`, then `npm test`
  (`tests/runbun_sets.test.js` fails if the data stops being trainer-shaped),
  then open `#runbun-battle` and the Trainer Wheel and confirm the party
  board renders. The other `sets/gen*.js` files are inherited Smogon sets and
  are not regenerated.
- **Move overlay.** Run & Bun move changes (accuracy, power, PP, type) live
  in `ai/src/move-metadata.ts`, which is authoritative over the inherited
  calculator data. When they disagree, `ai/src/test/runbun-data.test.ts`
  fails; fix `calc/src/data/` and record the delta in the Policy B table in
  `docs/FORK_MAP.md`.
- **Gen 9 coverage.** Only if a release ports Gen 9 content:
  `npm run build && node scripts/audit-gen9-coverage.js`, then work the list.
  `docs/GEN9_AUDIT.md` says why GEN9-02 is parked.
- **The gate.** `npm test` runs `calc`, `ai`, `insight`, the `view` build,
  `check:sdlc`, `test:server` and the lint, in that order. Keep it green
  before a merge. `npm run test:upstream --prefix calc` is a compatibility
  audit only and fails where the fork diverges on purpose (Policy B).
