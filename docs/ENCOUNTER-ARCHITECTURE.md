# The box is the run: an architecture for encounters

Status: PROPOSED, 2026-09-20. Nothing here is adopted. Every claim marked
*measured* has its command beside it; everything else is design.

## Why this, why now

Four Leaders account for 2,246 of 2,924 deaths across 253 sweep runs, and the
deepest valid run stopped 0 of 60 at Archie on what the ledger already calls a
box-strength wall. Policy work (search, switching, doubles) moved fights that
were winnable. It cannot move a fight the box cannot win. The box is decided
by ~18 encounters a run, each spent once, and today they are spent the moment
a route opens.

## What the dig found

*Measured* — `profiles/run-and-bun/oracle/encounters.json`, `availability.json`:

| Fact | Number |
|---|---|
| Areas (the one-per-route unit) | 69 |
| Areas whose LATER table is 15+ levels above the first one | **16** |
| — of those, open before Leader Norman | **12 of the 24** areas open by then |
| When Surf opens | order 594, just after Flannery (576) |
| Wild species living on exactly one map | 174 of 473 (37%) |

Route 102/103/104/106/107/109/110/117/111/118, Dewford and Slateport all walk
or fish at level 2–32 and surf at **level 50** with fully evolved bodies
(Kingdra, Starmie, Gyarados, Walrein, Ludicolo, Slowking). The harness walks
every one of them on arrival. Half the early road is spent on the worse table.

But the obvious rule — "hold the water routes" — does not survive the data:

- **Holding all twelve halves the early box**, and the early walls are where
  77% of deaths happen. Surf opens *after* Brawly, Roxanne, Wattson, Norman
  and Flannery. A held area is a body those five fights do not have.
- **The held water holds few NAMED answers** to the walls after it: Winona 0
  of 6, Tate 1 of 6 (Muk-Alola), Juan 2 of 11 (Slowking, Walrein), Wallace 1
  of 9 (Ludicolo). Its value is general quality, which nothing here prices.
- **The wall the road ends at has no key.** `fightDossierOf('Aqua Leader
  Archie Mt Pyre')` names **0** answers; Seafloor Cavern names **1**
  (Houndoom — a Fire type, into a rain team). `answersAhead`, `methodFor`
  and `--key-catches` are all blind at exactly the fight that stops the
  deepest runs. A planner cannot plan for a wall nobody has described.
- **Nearly a third of BOXED bodies take no knockout** — a weak reading, kept
  with its faults. 5 runs (seeds 104770, 209499, 314228, 418957, 523686),
  told on the line that stuck by `scripts/chronicle.js`: 26 of 91 bodies took
  no knockout (29%), 43 of 91 at most one (47%), and a run's top three took
  44–71% of its knockouts. What is wrong with it:
  - The runs did NOT run as configured. `--budget` and `--boss-retries` were
    passed through `armFlags()`, which parses three treatment flags and drops
    the rest; the harness reads those two from `process.argv` at load. Every
    run played the defaults (budget 110, 20 boss retries) with an empty
    provenance flag list. **Any arm passed through `playRun` this way
    silently measures the default** — that is step 0 below.
  - Seed 418957 ran before the one-prize rule and holds two prizes.
  - It counts BOXED bodies, not fielded ones, and a body with no knockout
    can still be a pivot or a sacrifice. And these are `rehearsal` runs,
    where a body cannot die, so it says nothing of a spare life's worth.
  It is NOT the hold rule's cost term. It is a reason to build one.

So the lever is real, the naive rule is wrong, and the knowledge it needs is
missing at the wall that matters most. That orders the work.

## The reframe: an area is an option, not a catch

An area is a right to ONE encounter, exercisable at any time from its
opening, against whichever of its tables is open at that moment. Spending it
early is not free and holding it is not free. The harness has no notion of
either cost; it has a sweep that rolls whatever is open.

```
                 ┌────────────────────┐
 oracle tables ─▶│ 1. AREA OPTION BOOK │  per unspent area: tables open now,
 availability  ─▶│    lib/run.js       │  tables opening later (and when),
 route rules   ─▶└─────────┬──────────┘  odds per species under each
                           │
 played evidence ┌─────────▼──────────┐
 (battery,      ▶│ 2. WALL VALUE STORE │  per (wall, species): wins over a
  offline)       │ scenarios/catch-    │  control box, PLAYED, pooled across
                 │   values/*.json     │  boxes, keyed by revision
                 └─────────┬──────────┘
                           │
                 ┌─────────▼──────────┐
                 │ 3. EXERCISE POLICY  │  per area: spend now on table A, or
                 │ scripts/headless    │  hold to order T for table B —
                 │                     │  with the reason written down
                 └─────────┬──────────┘
                           │
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
 4. LEDGER ROW       5. AUDIT CHECK      6. CHRONICLE
 hold/spend + why    no double-spend,    "Route 104 was held for
                     no surf before 594  the water: Pike the Kingdra"
```

### 1. Area option book — `run.areaOptions(doc)`

Mostly exists: `encountersOn` already marks `methodGated`, `unusedRoutes`
lists what is unspent, `methodOpensAt` dates every method and per-route late
sections. What is missing is the forward view as one object: for each unspent
area, `{now: [tables], later: [{opensAt, table}]}` with per-species odds after
the dupes clause. Pure data, no judgment, cheap to gate.

### 2. Wall value store — the part that is actually missing

Three grid scorers were measured against a played answer key at Brawly and
ordered the candidates at rho 0.47, 0.42 and 0.31 against a declared 0.5
(IMPROVEMENT-AUDIT, "Early catch plan"). Playing is the only scorer that has
ever been right: Combee took Brawly from 30 to 75 wins of 380.

So values are PLAYED, offline, in parallel, and the run only reads them:

- One file per wall: `scenarios/catch-values/<wall>.json`, rows of
  `{species, wins, of, controlWins, boxes, revision}`.
- Built by `scripts/battery-arms.js` (one worktree per arm, already exists)
  over `--swap-catch`, pooled across banked boxes — the audit's own stated
  next step, because at an 8% base rate six seeds on one box are mostly zeros.
- **A wall with no value file is reported as UNKEYED**, loudly, in the run's
  provenance. Archie is unkeyed today and nothing said so.

The store replaces named-answer lists as the planner's input. Dossier names
become candidates to play, not facts to trust.

### 3. Exercise policy — `--hold-areas`

For each area at each catching sweep:

```
spend-now value  = Σ over walls ahead   P(species | table now)   × value(wall, species)
hold value       = Σ over walls ≥ T     P(species | table at T)  × value(wall, species)
                 − the cost of one fewer body at the walls before T
```

The last term is the honest unknown. It is measurable, not guessable: the
marginal-body instrument below gives it per wall. Until it exists, v1 is a
rule that cannot be badly wrong:

> Hold an area **iff** its open table holds no species with a positive played
> value at any wall before the later table opens, **and** the box already
> fields six usable bodies at the cap.

That rule only ever holds an encounter the store says is worthless now. It
gives up nothing the evidence values, and it is off by default.

### 4–6. Record, audit, tell

- **Ledger**: every sweep writes `{area, decision: spend|hold, table, until,
  why}`. A hold with no reason is a defect.
- **Audit** (`scripts/audit-run.js`, two new checks): an area is exercised at
  most once; no surf catch is dated before order 594 (nor any method before
  its own gate).
- **Chronicle**: the hold becomes part of the story, which is the point of
  naming bodies at all.

## The mode question underneath all of it

`createRun` sets `permadeath: false` and a wall gets sixty retries. Under
those rules an early body is free — it cannot die, and the wall falls to
retries — so **no hold can ever look costly and no catch can ever look
valuable before Norman**. The harness is measuring a game where the early box
does not matter, then dying at Archie because the box did not matter.

Two named modes, same harness:

| | `rehearsal` (today) | `nuzlocke` |
|---|---|---|
| Death | costs nothing | the body is gone |
| A lost wall | retried, up to 60 | retried with whoever is left |
| What it measures | can the policy win this fight | can the RUN survive its own losses |
| Headline metric | depth reached | depth reached **per body lost** |

`rehearsal` stays the fast loop for policy work. `nuzlocke` is what a finished
run has to be judged under, and it is the only mode in which the encounter
economy above has a price. It also makes the chronicle true rather than
decorative.

## Order of work, each with its bar declared before the run

0. **Make the harness measurable.** `playRun` must carry `budget`,
   `boss-retries`, `prize-at` and `prize-stuck` per run rather than as
   module constants read once from argv, and its provenance must record
   them. Until then no arm run in-process measures what it says. *Bar: a
   gate in which two arms in one process diverge on `boss-retries`.*

1. **Instrument first — the marginal body.** From ledgers (which now carry
   knockouts by individual): per wall, the share of fielded bodies with zero
   knockouts, and the "named answer in box at wall" rate. No code risk, gives
   the hold rule its cost term. *Bar: none — it is a reading.*
2. **Key the unkeyed walls, Archie first.** Played values over banked boxes
   at Archie (Mt Pyre and Seafloor). Needs a banked box AT Archie — the
   deepest sweep-16 document, if it survives; otherwise the first task is
   banking one. *Bar: at least one species with net discordant wins > 0 at
   p < 0.05 on held-out seeds, or the wall is declared box-proof and the
   lever is levels/items, not catches.*
3. **`run.areaOptions`** and the two audit checks. *Bar: the gates, each
   falsified once.*
4. **`--hold-areas=1`, fast loop only.** No sweeps: take banked boxes just
   past order 594, swap the held areas' water catches in (`--swap-catch`
   already does this), battery at Winona / Tate / Juan / Archie. Minutes, not
   hours. *Bar: post-Surf walls net positive on held-out seeds; the five
   pre-Surf walls not worse than −1 each.*
5. **`nuzlocke` mode**, as a run flag, with the chronicle as its report.
   *Bar: a permadeath run's audit is valid and its depth-per-body-lost is
   reported beside the rehearsal depth for the same seeds.*
6. Only then a sweep.

## What this deliberately does not do

- It does not claim holding wins. The named-answer overlap is thin; the case
  rests on unpriced general quality, which step 2 either prices or kills.
- It does not add a scorer. Three have already lost to playing.
- It does not touch money or Poke Balls (ruled out of scope, 2026-09-20).
