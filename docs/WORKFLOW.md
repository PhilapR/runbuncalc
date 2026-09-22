# The workflow, and where it is weak

Written 2026-09-22 from the repository's own records: `docs/PLAN.md`,
`DECISIONS.json` (11 open questions), `ledger/findings.json` (44 of 123
findings open), `docs/IMPROVEMENT-AUDIT.md` (backlog) and
`docs/MODELLING-GAPS.md`. `docs/PLAN.md` holds the ordered work and its bars;
this page is the map it is chosen from.

The goal it serves: **a pinned, start-to-finish run that beats every required
fight, on one revision, audit valid, with no operator hand.** None exists yet.
Seed 418957 reached Champion Wallace across four revisions, with its Elite Four
played before the engine fix and an operator lead at the end. Seed 209499's
clear predates the engine fix.

## The stages

| # | Stage | What it is | Health | Weak points and backlog |
|---|---|---|---|---|
| 1 | Game data | sets, run map, encounters, items, dates (`profiles/run-and-bun`) | amber | Gifts, trades, fossils and roamers wait on one ruling (`do-gifts-consume-an-area-encounter`). Earth Power has no dated place. Every gendered Pokémon is male, and no gender-ratio data exists. 8 catchable species have no level-up moves. The Rustboro encounter table has drifted. About 12 open findings are data or provenance. |
| 2 | Battle engine | mechanics (`ai/src`) | amber | See "Fidelity" below. PP is off by default, so a stall is infinite. 18 doubles are planned as singles. The enemy's post-KO replacement follows documentation, not the ROM. About 10 mechanics findings are open (paralysis before infatuation, Parental Bond crits, Mold Breaker crit block, a consumed item never consumed). Mega timing is not modelled. Kubfu's form is never rolled. |
| 3 | Run rules and audit | `lib/run.js`, `scripts/audit-run.js` | amber | The audit replays commands, not battles, so it cannot see an engine change. Receipts carry no engine version. A run row names only its last leg's revision. A move at the evolution level costs a Heart Scale. Status and forgetting a move at the nurse (free in game) are not modelled. The economy spends items it has no source for. |
| 4 | Planner | the six, order, Mega, plan-by-play | amber | **Held items are not planned** (PLAN 2.1), and it is the lever that keeps recurring: a Focus Sash lead at Wallace, the Fairy Gem at Sidney. Plans vary only the first foe and the last two (2.3). The Mega is not a planned choice (2.2). The upgrade advisor prices a tenth of the movepool. |
| 5 | Fight policy | decide, search, joint doubles search | green | Mostly measured and rejected, which is fine. Unbuilt: phazing set-up users, stall play. When search scores a loss, it ignores how many of our Pokémon survive. Which two lead in doubles is an assumption (`doubles-lead-order`). |
| 6 | Harness and run control | slot pool, checkpoints, carry-on, fallbacks | green | Per-wall experiments are scratch scripts, not repository tools with receipts. Background launches from the agent shell are fragile. Runs span revisions. |
| 7 | Measurement | battery, held-out seeds, paired tests, `scripts/falsify.js` | green method, **red baseline** | Every stored baseline predates `8cc3ece` and `e6399d2`. Re-run it before comparing anything. |
| 8 | Observability | watch page, insight MCP tools, fight view | green | No wall view (PLAN 5.2). Past attempts open in a separate page (5.1). Jev triage belongs to Codex in rab-workspace. |
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

Still unchecked by any sweep: other entry effects (Trace, Frisk, Neutralizing
Gas, Air Lock), item entry effects, and mid-fight rules that a composed-pipeline
test does not reach.

## Where we are weakest

1. **Trust in past numbers.** Every stored comparison needs re-running.
2. **Fidelity had no guard.** The opening sweep closes one class. The same
   idea is owed for the turn loop.
3. **The planner cannot choose items.**
4. **Document sprawl.** There are 28 docs. `docs/ROADMAP.md` (2026-08-17,
   phases 1–6) and `docs/TASKS.md` are stale next to `docs/PLAN.md`.

## Order of work, cheapest first

1. ~~Fidelity check of opening states~~ — done, `e6399d2`.
2. Re-run baselines on idle compute: one fresh pinned run, and the held-out
   battery sets.
3. Plan held items (about a day), measured on the held-out walls.
4. Wall view (half a day).
5. Retire `docs/ROADMAP.md` and `docs/TASKS.md`, or fold them into `docs/PLAN.md`.

Parked: new per-turn policy arms (repeatedly rejected), and the old roadmap's
reinforcement-learning and emulator phases.
