# The plan: what to improve next, and what it is worth

Written 2026-09-22, from what this week measured. Ordered by expected value
against the standing goal — **a pinned, start-to-finish run that beats all 358
required fights, efficiently** — not by how interesting the work is.

Every item states the evidence that motivates it, the cost, and the bar it
must clear. An item with no bar is not ready to start.

The whole workflow, stage by stage, with its weak points and backlog, is
mapped in `docs/WORKFLOW.md`; this page is the ordered work chosen from it.
These two pages are the only plan. `docs/ROADMAP.md` and `docs/TASKS.md` were
retired into them on 2026-09-22; `docs/attic/` says where each item went.

---

## Where we actually are

The deepest valid run is **seed 418957: trainer #350 of 358**, stopped at
Elite Four Sidney 0 of 40 (audit valid, clean provenance, 585 fights, 605
minutes). Nine fights from the end. Its predecessor stopped at #294.

What stops runs, from every logged attempt across the fleet:

| Wall | Seeds that met it | Cleared | Median attempts |
|---|---|---|---|
| Elite Four Sidney | 1 | 0 | 40 |
| Aqua Admin Matt | 4 | 2 | 40 |
| Aqua Admin Shelly (Seafloor) | 4 | 2 | 14 |
| Aqua Leader Archie (Seafloor) | 2 | 1 | 39 |
| Leader Winona | 2 | 2 | 9 (one run spent 31) |
| Leader Norman | 5 | 4 | 17 |

Sidney, read from its 40 tapes: **Nidoking costs 2.00 of our bodies a facing
and falls only 23 times of 40; Yveltal costs 1.26 and falls 7 of 19; Mega
Gyarados has never fallen** (0 of 5 facings). Greninja and Necrozma always
fall and are cheap. So Sidney is lost in its middle, not at its lead.

**The one policy lever that has ever worked is `--plan-after`** — plan the six
and its order by playing candidate plans. It cleared Matt in 6 and Shelly in 7
where the control went 0 of 40 on both. Everything else measured has been
rejected: widened search, sequential halving, the material lookahead, the
played switch price, `ko-respects-order` (twice, the second time validly),
reserving an answer, heal-break.

**Read that pattern before choosing work.** Per-turn cleverness keeps losing.
What wins is choosing the right bodies, in the right order, with the right
items, before the fight starts.

---

## 1. Finish the game (the goal itself)

### 1.0 What 2026-09-22 found at Sidney
- **The Four are 2 singles + 2 doubles, free choice.** The run fought Sidney's
  single 80 times over two legs and stopped on "a required fight" with his
  double never tried. `ac10aec`: at the cap a walled format hands the run the
  member's other one. Verified on the real path: attempt 41 is SidneyDouble.
- **On that box the double is no easier.** Battery default policy: single
  0/20, double 1/80. The run's own hand (search, plan-after) is stronger;
  the carry-on is the measurement.
- **The Kubfu gift never learned Urshifu's moves** (`fabc32d`): levelled to 99
  in one step as Kubfu, it knew Leer and Focus Energy. Fixed for every run from
  here; this leg's Urshifu cannot be repaired (no Heart Scale, prompt gone).
- The doubles battery never reported the foe's remainder (`ac10aec`), so
  planByPlay's fewest-foes-left tie-break read 0 in every double.

### 1.0b Wallace, and the rules underneath every number (2026-09-22)
- 418957 took the Elite Four as SidneyDouble (17), Phoebe (5), GlaciaDouble
  (2, after Glacia's single walled at 40) and Drake (15). It is at Champion
  Wallace, 358 of 358.
- **No lead's entry ability had ever fired** (`8cc3ece`): no Drizzle, no
  Intimidate, and Primordial Sea was never modelled. Every tally before that
  commit ran on an easier game. The Wallace leg was restarted on the fixed
  engine.
- Wallace on this box, searched, correct rules, 24 paired seeds: control 0,
  Focus Sash Dhelmise lead 0. The sash halves Kyogre's cost (2.46 → 1.13
  bodies); the wall moves to Curse/Rest Hisuian Goodra (2.4 a fight). The
  leg plays with `--lead-for` (operator-assisted, on its row).
- **Parked (operator, 2026-09-22): no more work aimed at Wallace.** Too much
  underneath needs fixing first: the review's must-fixes, the per-aspect
  engine stance, ROM probes beyond damage, then a re-baseline on the fixed
  engine. Wallace returns as a measurement after that, not as a lever hunt.
  The Curse/Rest answer (Perish Song Altaria, fixed damage, crits) waits
  with it.

### 1.1 Resume 418957 at Sidney with every fix in place — RUNNING
Three Mega fixes landed after that run was pinned, and they change its Sidney
six: it fielded Mega Houndoom, and the set score wants Mega Lopunny (the six's
gap is what Lopunny covers, not what Houndoom duplicates). It also now plans
the wall. Cost: about an hour of one slot. **Bar: clears Sidney inside 40.**

### 1.2 If Sidney falls, drive to the end and audit
Eight fights remain (Phoebe, Glacia, Drake, Wallace and their doubles). Then
`scripts/audit-run.js` must pass with `beatTheGame` true. **That is the goal.**

### 1.3 If Sidney holds, read it the way Norman was read
Compare a winning attempt against losing ones — the method that found the
Norman lever. Nidoking and Mega Gyarados are the named targets; the box holds
eleven Mega-capable bodies, so the question is which Mega answers Nidoking.
Cost: an afternoon. **Bar: name a lever, or say plainly it is a box wall.**

---

## 2. Make the planner better (the lever that works)

### 2.1 Plan items, not only bodies and order
`planByPlay` proposes leads, closers and who makes room. It does **not**
propose held items — yet the item is half of what a body is, and the run's
item logic is a filler-berry rule. Sidney's six holds a Fairy Gem, an Expert
Belt and two berries against a team that KOs through them.
Cost: a day. **Bar: the held-out wall test (three walls, four arms, 40
attempts) — clears a wall the control does not, loses none.**

### 2.2 Plan the Mega as a dimension of its own
The ranker now chooses one Mega per six by set score (`99bdcf6`), and the run
hands it the stone. The planner does not yet *play* alternative Mega choices —
it takes the ranker's. On a box with eleven capable bodies that is one
scouted decision worth making. Cost: half a day, reusing the `changes`
mechanism. **Bar: as 2.1.**

### 2.3 Widen what the planner proposes
Today it proposes for their first foe and their last two. At Matt on seed
842113 it tried 19 plans and none won a planning fight, because the foe that
costs 2 bodies a facing (Dracovish, Nidoking at Sidney) is in the middle.
Cost: hours. **Bar: as 2.1, and it must not slow a wall by more than 15%.**

---

## 3. Close the modelling gaps that bias every measurement

These are correctness, not cleverness. Each one makes every future number
truer, and three of them changed play the day they landed.

### 3.1 Mega Evolution timing — needs your ruling on cost
Feasible: the engine already changes forms mid-battle (`setSpeciesOverride`
drives Aegislash, Palafin, Gulp Missile). But a Mega is an action taken
*before* moves resolve and it changes Speed, so it needs a new action shape
ordered ahead of moves, per-side "already megad" state, the option list
roughly doubling, and the same for the foe or the approximation goes
asymmetric. Cost: about a day, and it doubles the search's branching factor
on a search that already costs 8–12 s a decision.
**Do this first, before building it:** count from the existing tapes how often
a pre-evolved Mega actually cost us — a turn where the base form's ability or
Speed would have been better. Cost: an hour. If that number is small, this
is not the next lever.

### 3.2 The unwired sources — waiting on one ruling
Gifts are wired (`44ad51e`): the Lavaridge egg, Castform, **Kubfu**. Still
unwired: the three trades (they consume a body we own), the fossils, and the
seven roaming legendaries (undated, gated on the Sootopolis event, so late and
cheap to leave). All of them wait on the same open question: **does a gift
spend its area's wild encounter?** It currently does not.

### 3.3 Kubfu's Urshifu form is not rolled
The game rolls a random form at level 50; `evolveByLevel` always takes the
first path the data lists (single-strike). Cost: an hour, and it needs the
run's dice. **Bar: the run's replay stays identical on a fixed seed.**

### 3.4 Earth Power has no dated place
The one TM/tutor row still undated: "Given by an NPC at Fossil Maniac's
house", which no Run & Bun source places. Needs your knowledge or a source.

---

## 4. Optimize (you asked for this once the Mega work was in)

Measured costs today, on this eleven-core machine:

| Thing | Cost now | Why it matters |
|---|---|---|
| `rankParties` at E4 box sizes | ~8 s, and now **two** matchup grids when a Mega is in play | called on every box/bag change |
| One searched decision (`search-8`) | 8–12 s | a searched fight is 100–150 s |
| A full run | ~10 hours | one seed at a time |
| A wall at 40 attempts | ~1 hour | the unit of every measurement |

### 4.1 Cheap and safe, in order
1. **Score the no-Mega case once** and reuse its per-column maxima; a Mega
   candidate can only raise a column, so most candidates can be rejected
   without a full re-score. Removes most of the cost 3.2 added.
2. **Skip the base grid entirely** when no Mega-capable body is in the pool —
   already done, but the check is per-rank; make it per-box.
3. **Cache `boxMatrix` per (box shape, bag shape, trainer)** — the run already
   computes a `lastShape` key for exactly this reason and does not use it here.
4. **Stop rebuilding the foe's party** per rollout in the search; it is
   constant for the fight.

**Bar for all four: play-identical output** (compare ledgers, not timings) at
1.5× or better on a wall. Anything that changes play is a policy change and
needs a policy bar, not a speed one.

### 4.2 Structural, only if 4.1 is not enough
- Run the battery's scenarios in worker threads rather than processes; the
  slot pool already caps concurrency, and process start is a real share of a
  short scenario.
- Profile `act()` itself: 7 ms lean, 19 ms full. The lean path is what
  rollouts use, so a 2× there is a 2× on all search.

---

## 5. The instruments

### 5.1 The fight view only shows the live attempt
Past walls open in a separate page. The run view knows every attempt; it
should open one. Cost: hours.

### 5.2 A wall view
The thing I keep building by hand at 1 a.m.: per foe, bodies lost per facing,
how often it falls, what kills us, and the winning attempt beside the losses.
`insight/src/analyse.ts` already computes most of it. Cost: half a day, and it
would have saved a day this week alone.

### 5.3 Jev triage
Owned by Codex in rab-workspace. My reusable pieces are stated: the tag set,
the ledger row (with `monId` as stable identity), `fight-log.js` as the
durable journal, checkpoints as restore epochs. **Constraint that must hold:
semantic routing into drafts only; every confirmed number stays derived by
rules and replayable, or `audit-run.js` stops meaning anything.**

---

## 6. Process (what keeps the numbers honest)

- **Declare the bar before the data exists.** Done for every arm this week;
  it is why the played switch price and the lookahead could be rejected
  cleanly instead of argued about.
- **Make every gate fail once.** Two gates this week were hollow and only the
  falsification found them.
- **Make every measurement script fail once too.** The determinism finding was
  an artifact of reading `action.move` (undefined) and falling back to
  `action.kind` — the same string for every move. A 100.0% result is a smell.
- **One seed is one journey.** The fleet view groups legs by seed; arms that
  restart from a wall are not separate runs.
- **Never `pgrep -f` / `pkill -f`.** Wait on PIDs. Three waiters matched their
  own command lines this week and one `pkill` killed the watch server.
- **Size a measurement before launching it.** Over-subscribing eleven cores
  took a 16-fight check from 4 minutes to 20.
- **Stop a change that makes a run unreplayable or blurs where a fact came
  from.** Carried from the retired roadmap's stop conditions: `audit-run.js`
  means something only while every confirmed number replays from recorded
  commands and a named source.

---

## Do not re-open without new evidence

Measured and rejected, with receipts: `--search-widen`, `--search-halving`,
`--search-lookahead`, `--switch-played`, `--ko-respects-order` (re-measured
2026-09-21 under real Speed: heldout2 net −16, p = 0.014), reserve-an-answer,
heal-break, and taking Self-Destruct off Gigalith.

`--hand-by-probe` is off and indistinguishable from the control on three
held-out walls; it stays available because it rescued one stuck run, but it
has no evidence beyond that box.
