# Where the harness spends its time

Regenerate every number here with the committed instrument, never by hand:

```
node scripts/profile-run.js --budget=30
node scripts/profile-run.js --fight="Leader Brawly" --rollouts=2
node --cpu-prof --cpu-prof-dir=/tmp/prof scripts/profile-run.js --fight="Leader Brawly" --rollouts=2
node -e "for (const r of require('./scripts/profile-run.js').summariseProfile('/tmp/prof/FILE.cpuprofile')) console.log(r.percent + '%', r.frame)"
```

A deep run takes hours and a sweep takes most of a day, so a guess about what
to make faster costs a day to test twice. These are the numbers to beat.

## Baseline, 2026-09-20, this machine (a sweep running at nice +15 alongside)

| What | Cost |
|---|---|
| A 30-fight run, end to end | 425s wall |
| — fights | 74% of wall |
| — `rankParties` | 15% (65s over 30 fights, ~2s a cycle) |
| — `adviseUpgrades` | 8% |
| — `unusedRoutes`, `preFightOpportunities` | 1% each |
| A fight played by `decide()` | **0.3s** |
| A fight played by `search-8` | **77s** |
| A fight played by `search-1` | 22s |
| A double played by `joint-4` | ~20s |
| The node test suite (`npm run test:server`) | ~6 min |

**The shape of it: the rollout search is the harness.** Four searched fights
in that run cost 309s of 425s. A boss retried sixty times at search-8 is over
an hour on one fight, which is why a deep run is a three-to-four hour job and
why the walls dominate a sweep's wall time.

## Inside a searched fight (CPU profile, self time)

| Share | Frame |
|---|---|
| 9% | `calculateMoveActionFacts` (ai/calc-adapter) |
| 9% | `calculateActionFacts` (ai/calc-adapter) |
| 6% | `extend` (calc/util — a deep copy) |
| 4% | `calculateTargetFacts` (ai/calc-adapter) |
| 4% | `normalizeGenerationFacts` (ai/facts) |
| 3% | garbage collector |
| 3% | `enumerateMoveActions` (ai/actions) |
| 2% each | `makeMoveContext`, `deriveMoveResolution`, `Pokemon` (calc), `clone` (calc) |

**About a third of a searched fight is the calculator adapter**, and much of
the rest is the copying that feeds it — `extend`, `Pokemon`, `clone`, and the
garbage they make. `calc-adapter.js` keeps `CALC_POKEMON_CACHE`, a WeakMap
keyed on state and Pokemon IDENTITY; a rollout `structuredClone`s the state
per rollout, so every clone is a cache miss by construction. That is the
candidate worth measuring first — and it must be measured on a REAL state,
because two earlier optimisation proposals died on real playthrough states
after passing on a constructed box.

## Known slow gates

The three slowest tests are full-RUN tests, and they are slow for a reason:
the defects they catch only appear in a run, and a fixture-level version of
each passed with its fix removed.

| Test | Cost |
|---|---|
| `the ledger says what fell and to what` | 179s |
| `a body never relearns what it gave up` | 176s |
| `an engine crash is a lost fight, not a lost run` | 117s |

The thrash gate needs ~40 fights: at 24 fights the defect does not appear at
all, so it cannot be shortened without losing its power.

**Loop discipline:** run the affected test files while iterating, and the full
suite once per batch before reporting. Keep a background sweep at `nice +15`,
or it takes the cores the suite needs and the browser gates start timing out.

## Fixed regressions, for the pattern

- **A per-move lookup that rebuilt its list** (2026-09-20): `learnable` asked
  `moveTutors()` for every move, and that mapped the workbook array each call.
  Ranking a box of 30 went from ~1s to 6.8s, and a box of 76 to 9.7s — caught
  by the suite's own budget gate, not by a profile. Cached as a Set: 1.36s and
  1.76s. A per-item call into a rebuilt collection is the shape to watch for.
- **Worktrees filling the disk** (2026-09-20): one pinned worktree per sweep
  revision, never cleaned, reached 2.2GB and Playwright failed with ENOSPC
  mid-suite. `git worktree remove` the old ones after a sweep; the failure
  reads as a test defect, not a housekeeping one.
