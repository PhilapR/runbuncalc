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

## Making the search cheaper: one rejection, one pass

Both arms below are 12 paired seeds at Leader Brawly on
`fixtures/banked-runs/brkeys3b-A-7.run.json`, search-8, real PP, control and
treatment run back to back in the same process. The bar was declared before
either ran: **adopt if wins are no worse and the per-fight cost drops at
least 40%**.

**Rejected — pruning the candidate list** (`prunedChoices`, 2026-09-20). Kept
the best damaging move of each type and, when anything damaged, only the
switches that WIN their race. At Brawly it cut nine candidates to three:

```
seeds 11
full   wins 8  mean 280s a fight
pruned wins 2  mean 122s a fight
discordant: full-only 7  pruned-only 1
speed-up 2.30x, cost drop 56%
```

It bought the speed by deleting the switches the board had priced as losing
— and those are the pivots that win boss fights: a body that loses its race
is often exactly the body worth sending, to eat a hit or force the foe off a
set-up. No a-priori rule prices that; only a rollout does. Same-type damage
dominance is unsound for the same reason (it ignores accuracy and secondary
effects). Reverted, and the reasoning is kept in `setSearchWiden`'s comment
so it is not retried.

**Passed — widening** (`--search-widen=N`, `driver.setSearchWiden(N)`, OFF by
default). Nothing is removed. Every candidate gets one scouting rollout, the
top N then get the full remaining budget, and the winner is chosen only among
those N — otherwise one lucky single rollout outranks a candidate measured
eight times. Nine candidates at eight rollouts is 30 playouts instead of 72:

```
Leader Brawly, search-8, real PP, 12 paired seeds
flat   wins 8/12  seeds [1,3,4,6,8,9,11,12]  mean 312s a fight
widen3 wins 9/12  seeds [1,3,4,7,8,9,10,11,12]  mean 100s a fight
discordant: flat-only [6]  widen-only [7,10]
cost drop 68%  (3.1x faster)
```

The flat control reproduced the pruning arm's win set exactly, in a separate
process, which is how the refactor was shown to leave the flat path alone.
Two wins to one is not significant; the bar asked only that wins not get
worse.

**And then held-out refused it.** Four trainers the width was never tuned on
(Rival Sceptile/acc-11, Lass Haley/brkeys1-B-1, Cool Trainer George/
flannery-3, Psychic Jaclyn/pf-2), 5 seeds each, same search and PP model.
Bar declared before the run: adopt if net discordant is at least −1 and cost
drops 40%.

```
flat   wins 17/20  mean 116s a fight
widen3 wins 14/20  mean 50s a fight
discordant: flat-only 4  widen-only 1
net -3  | cost drop 57%  (2.3x)
  3 -> 1 of 5   Trainer Rival Cycling Road Sceptile
  4 -> 5 of 5   Lass Haley
  5 -> 3 of 5   Cool Trainer George
  5 -> 5 of 5   Psychic Jaclyn
```

Net −3 against a bar of −1: **not adopted as a default**, and this is the
third time an arm has won in-sample and lost held-out. The scouting rollout
is too thin a read — one playout shortlists, and against Sceptile and George
it shortlists wrong. `--search-widen=N` stays available and off, for work
where wall time matters and win rate does not (crash hunting, shape checks).
A wider scout (2–3 rollouts) is the obvious next arm and is NOT claimed here.

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

## The depth baseline under valid rules (2026-09-21, revision 6a059c6)

Every sweep depth tally from before 29ffa9f is over-supplied (one Game Corner
prize per BADGE), so this is the number to beat. Six runs, Chimchar, the
sweeps' real flag set as per-run knobs (`--boss-retries=60 --retries=24
--double-retries=60 --scale-ivs=1 --search-after=2 --search-rollouts=8
--repick-after=3`), `--stop-at=343` so a run ends the moment it is past
Norman. All six audits valid; each took one prize or none.

| Seed | Reached | Fights | Wall time | Brawly | Roxanne | Wattson | Norman |
|---|---|---|---|---|---|---|---|
| 104770 | past Norman | 123 | 53 min | 1/3 | 1/1 | 1/6 | 1/18 |
| 314228 | past Norman | 121 | 57 min | 1/14 | 1/4 | 1/5 | 1/8 |
| 209499 | past Norman | 171 | 92 min | 1/24 | 1/6 | 1/21 | 1/22 |
| 418957 | Norman | 172 | 104 min | 1/4 | 1/4 | 1/5 | 0/60 |
| 628415 | Wattson | 143 | 90 min | 1/6 | 1/8 | 0/60 | — |
| 523686 | Brawly | 87 | 64 min | 0/60 | — | — | — |

**3 of 6 pass Norman.** Where a wall falls it falls in 1–24 attempts (a per-
attempt rate of roughly 4–12% under search-8); where it does not, sixty
attempts do not move it — the box is wrong, and retries cannot fix a box.
That is the efficiency problem in one table: a run that will pass pays about
twenty fights for it, and a run that will not pays sixty and an hour to learn
nothing.

A first attempt at this baseline (six runs at 16fb345) is VOID: it was
launched in-process and `--search-after` lived only on argv, so all sixty of
its Brawly attempts were played by decide(). Fixed in 6a059c6.

It also showed the slot-filling rule's flaw: every run reached Norman with
five or six Sitrus Berries in the bag and nobody holding one, because slots
filled with a Chesto or Pecha before the trees opened (235) were never looked
at again, and bodies re-picked into the six after the advice ran held nothing.

## What a boss retry is worth (259 run ledgers, 2026-09-21)

Read from every sweep and baseline ledger on disk (the over-supplied sweeps
included: a prize changes whether a wall falls, not the shape of when). 412
boss fights were eventually won, 46 walls never fell.

| Attempt on which a won boss fell | |
|---|---|
| median | 1 |
| p75 / p90 | 4 / 9 |
| p95 / p99 | 21 / 33 |
| **latest ever** | **42** |

| `--boss-retries` | Wins kept | Attempts saved on walls that never fell |
|---|---|---|
| 20 | 94.9% | 1900 |
| 25 | 97.8% | 1670 |
| **40** | **99.5%** | **980** (~21 hours of search-8) |
| 60 | 100% | 60 |

**Sweeps should run `--boss-retries=40`, not 60.** No boss has ever fallen
after attempt 42; the last twenty attempts of sixty bought 2 wins in 412 and
cost about twenty minutes a wall. Below 40 the trade is real — a cap of 25
gives up 2.2% of wins PER WALL, which over a dozen walls compounds to about a
quarter of a run's chance of finishing — so 25 is for fast diagnostic runs,
not for a run meant to clear the game.

### The same six seeds at 85a86f2 (Sitrus trade-up, pre-fight fill, retries capped at 40)

| Seed | 6a059c6 reached | 85a86f2 reached | Norman before → after |
|---|---|---|---|
| 104770 | past Norman | past Norman | 1/18 → 1/23 |
| 209499 | past Norman | past Norman | 1/22 → 1/13 |
| 314228 | past Norman | past Norman | 1/8 → 1/20 |
| 418957 | **Norman, 0/60** | **past Norman** | 0/60 → 1/3 |
| 523686 | Brawly, 0/60 | Brawly, 0/40 | — |
| 628415 | Wattson, 0/60 | **Roxanne, 0/40** | — |

**4 of 6 past Norman against 3 of 6; 817 fights → 746; 461 machine-minutes →
361 (−22%).** All audits valid, no member of any six empty-handed, Sitrus held
in every run that reached the trees. One seed gained a wall and one lost one,
so the pass count is inside the noise of six runs and is NOT claimed as an
improvement; the time is, because the cap alone removes twenty attempts from
every wall that never falls. Seed 104770 took Roxanne on attempt 31 — inside
the cap of 40, outside a cap of 25, which is the trade the table above prices.

### Carried on from Norman (2026-09-21): all four reach past Winona

The four runs that passed Norman were resumed from their saved documents
(`options.resume`, dd0883f) with `--stop-at=770`. **All four beat Flannery and
Winona — six badges — in 63 to 77 more minutes each**, about 2h15 from a fresh
start. Every rules check passes (replay, one catch an area, one prize, moves,
TMs, no refusal-bought wins, no over-cap body, no crashes).

| Seed | Fights past Norman | Hardest fights (wins/attempts) |
|---|---|---|
| 104770 | 165 | Shelly (Weather Inst.) 1/20, Bird Keeper double 1/11, bridge rival 1/10, Winona 1/10 |
| 209499 | 151 | bridge rival 1/22, Shelly 1/10, Winona 1/5 |
| 314228 | 139 | Bird Keeper double 1/9, bridge rival 1/8, Shelly 1/5 |
| 418957 | 134 | Winona 1/14, Bird Keeper double 1/7, Shelly 1/4 |

**The audit FAILS their provenance, correctly:** they were launched from the
live checkout while it was being edited, so the stamp reads "dirty tree at
dd0883f". The play is what the code at launch did, but a result that cannot
name its revision is a lead, not a claim. The final leg (Winona onward, no
stop) runs from a pinned clean worktree at 4d8988e, as every sweep did and as
these baselines should have.

## The first run to finish the game (2026-09-21, seed 209499)

Chimchar, played in three legs and preserved in
`ui-playthrough-out/runs/first-clear/`. **All 358 required fights beaten, no
skips, no engine-refusal-bought wins, no crashes, one Game Corner prize
(Tauros), one catch an area across 68 areas.** Under today's audit: 13 PASS,
0 FAIL, 1 WARN (effort: Aqua Leader Archie at Seafloor Cavern took 37
attempts — the wall that stopped the previous record at #294, 0 of 60).

| Leg | Road | Fights played | Wall time | Revision |
|---|---|---|---|---|
| 1 | start → past Norman | 172 | 94 min | 85a86f2, clean |
| 2 | → past Winona | 151 | 75 min | dd0883f, **DIRTY** |
| 3 | → Champion Wallace | 303 | 277 min | 4d8988e, clean |
| | **358 fights** | **626 attempts** | **7 h 26 min** | |

The starter carried it: Tuck the Infernape, 40 knockouts on the final leg
alone. The six that beat Wallace were Infernape, Staraptor, Rapidash,
Delcatty, Ludicolo and Masquerain at level 99.

**What this is, and is not.**

- It IS the standing goal's first half: a headless run beat the game.
- It is NOT one pinned run. Leg 2 was launched from the live checkout while it
  was being edited and its provenance is dirty; the play is what the code at
  launch did, but it cannot name its revision. A clean claim needs one run
  start to finish through `scripts/run-batch.js`.
- It was played in REHEARSAL: `permadeath: false`, up to 40 retries a wall.
  626 attempts for 358 fights, and the wins replayed from this family of runs
  each gave up four to six bodies. It is not a nuzlocke clear.
- It is NOT yet "efficiently": seven and a half hours, 142 of its attempts
  spent losing to walls before the line that stuck.
- It played WITHOUT several things since added, all of which only help the
  player: no Mega Evolution (the-player-megas), none of the 23 handed-over
  items including every gym leader's TM, Heart Scales spent with no reserve
  and never on a nature, and losing replacements ranked the old way for leg 1.
- Its first audit FAILED replay: ten teaches of Icy Wind refused. The fault
  was in a rule written that morning — a TM re-sold at Lilycove still had to
  be in the bag after Lilycove opened, though money is not modelled and the
  store sells it. Corrected (an HM is never sold and must still be held),
  gated both ways, and the run then replays whole.

## Declared, not yet run: do `--hand-by-probe` and `--plan-after` earn their default? (2026-09-21)

Each switch has ONE stuck run of evidence, and that run is the one it was
found on (731001 at Brawly; 842113 at Norman). That is in-sample. The bar
below is written before any held-out data exists.

**Held-out walls.** When clear1 (six seeds, pinned 1c82d50, switches absent)
ends, every run that stopped at a wall leaves its document there. Those walls
— excluding Brawly on 731001 and Norman on 842113 — are the test set, plus any
boss a finished run needed 10 or more attempts for, replayed from the run's
checkpointed document at that position where one exists.

**Arms, per wall, from the same document, through the slot pool, pinned:**
control (`search-after=2, repick-after=3`), `+hand-by-probe`, `+plan-after=5`,
both. Forty attempts each, as a run has. One run per arm per wall; the dice
are the run's own.

**Bar.** Adopt a switch if, over the held-out walls, it clears at least one
wall the control does not and loses none the control clears; and the median
attempts-to-clear over walls both clear is not worse by more than 5. Reject
if it loses a wall the control clears. Anything else: stays off, stays
available. Wall-clock per wall is reported, not judged — a plan costs about
two minutes and a wall costs an hour.

**Known limit.** Expect 3–6 held-out walls, so this can reject but can only
weakly adopt; a second batch of seeds with both arms from the start is what
would settle it, at roughly 6 seeds x 2 arms x 3–7 hours of a slot each.

## The lookahead (`--search-lookahead=D`): built, fast, and so far WORSE — off (2026-09-21)

Why it was built: over 7,603 searched turns the playout search's best option
beat its second by a median of 0.010 (under 0.02 on two turns in three), each
value the mean of 8 playouts; in 63% of turns no option won a playout, so a
value is 0.3 x their HP removed after a sixty-turn fight our side plays by
greedyChoice. And the foe is predictable: asked forty times with different
dice at 162 positions across three late walls, the trainer AI chose the same
move every time, at every position.

What it is: every option one turn deep against their real reply, only the
contenders (within 0.05) a turn deeper, siblings on shared dice; leaf = the
material lead. One decision: 0.2 s against 8-12 s for search-8, and the top
option leads by 0.057 where playouts showed 0.010.

What it does, Brawly box (fixtures/banked-runs/clear1-731001-brawly), fresh
seeds 7001-7020, one loaded machine:

| hand | wins | a fight |
|---|---|---|
| decide() (seeds 9001-9030, measured earlier) | 12 of 30 | ~2 s |
| search-8 (replayed earlier) | 0 of 16 | ~146 s |
| lookahead-1 | 1 of 20 | 7 s |
| lookahead-2 | 0 of 20 | 27 s |
| lookahead-3 | stopped after 3 losses | 182 s |

Sharper values did not make better play. A material lead one or two turns out
is a greedy objective: it takes the biggest trade now and has no notion of
holding a body for the foe it answers, which is what wins these fights
(LEADER-KEYS, "a plan, not a part"). decide()'s hand-built rules encode some
of that; this does not. Not tuned further against one box. What would make it
worth another look: a leaf that values matchups still to come (who of ours
beats who of theirs that is still standing), not HP.

## The played switch price (`--switch-played`): built, and REJECTED on its declared bar — off (2026-09-21)

What it is: when decide() is about to attack into a race the threat line
says is lost, the choice is played instead of priced — staying, and each
bench body coming in, three sets of dice each, the foe on its own AI and our
side continuing on decide(), until this foe falls, two more of ours do, or
ten turns pass; a line is worth what it did to this foe minus the bodies it
cost, and a switch is taken only if it beats staying by 0.4. Built because
the priced switch (pessimal, and no better priced fairly or as odds) sent
Kingdra in third against a Choice-locked Dracovish it walls (LEADER-KEYS,
Aqua Admin Matt).

Bar, declared before the run: five boxes it was not found on, 30 fresh seeds
each (7101–7130), on against off; a candidate only at net +5 wins with no box
losing 3.

| box | off | on | foes left, off → on |
|---|---|---|---|
| Matt, 209499 | 0 / 30 | 0 / 30 | 3.10 → 3.03 |
| Matt, 731001 | 0 / 30 | 0 / 30 | 3.50 → 3.30 |
| Shelly, 104770 | 0 / 30 | 0 / 30 | 2.87 → 3.40 |
| Norman, 842113 | 0 / 30 | 0 / 30 | 2.23 → 2.23 |
| Brawly, 731001 | 14 / 30 | **7 / 30** | 1.10 → 1.47 |

Net −7, and the one box decide() can win is the one it halves. (On the box
it was found on it read 0 → 1 of 10: noise.) It looks ~4 times a fight and
switches ~1.3 times, at 3–7 s a fight. Why it hurts, as far as the numbers
say: a line is judged by THIS duel only, on three dice, so it buys a better
exchange now with a body the rest of the fight needed — the same myopia that
sank the material lookahead. Not tuned against these boxes.

A count taken while looking for bugs in the tapes (15,603 logged decisions):
decide() chose a move because "it KOs" 1,632 times, and 388 of those times
(24%) our body fainted before it moved. The guard for that
(KO_RESPECTS_ORDER, yield to a resisting switch) was measured before: it won
in-sample and lost on held-out. The hole is real and its obvious patch is
already known not to be the answer.

## Verdict on the declared bar (2026-09-21): `--plan-after` adopted at 5, `--hand-by-probe` stays off

Three held-out walls, four arms each from the same clear1 document, 40
attempts, through the slot pool, pinned. (Five arms died at the end of their
play when a shared worktree was removed under them — 47a4adb; their plain
logs are complete and are what is counted. Three arms were re-run.)

| wall (seed) | control | hand-by-probe | plan-after | both |
|---|---|---|---|---|
| Aqua Admin Matt (209499) | 0 of 40 | 0 of 40 | cleared in 6 | cleared in 17 |
| Aqua Admin Shelly (104770) | 0 of 40 | 0 of 40 | cleared in 7 | cleared in 7 |
| Seafloor grunt #5 (314228) | cleared in 7 | cleared in 7 | cleared in 7 | cleared in 7 |

plan-after clears two walls the control does not, loses none, and ties on
the third: adopted, on by default at 5 (DECISIONS a-wall-is-planned-by-play).
hand-by-probe is indistinguishable from the control on every wall: off,
available. The limit stated with the bar stands — three walls adopt weakly —
and so does the counter-example: 842113 went 0 of 40 at Matt with the planner
on. The third wall also shows the control itself moved: it clears in 7 a
grunt that stopped clear1 for 24, which is today's dated items and the
keep-valued search, not either switch.

## Declared before the run: does `--ko-respects-order` deserve a second hearing? (2026-09-21)

The hole: decide() clicks a move because "it KOs" before it asks whether the
body lives to click it. In 15,603 logged decisions, 1,639 KO clicks; 409 of
them (25%) fainted before moving, every one with the threat line already
saying "they act first" and a plain hit at or over our HP. 179 were bodies
under 35% (a last gasp; the foe fell within three turns in 118), 111 were
bodies at 70%+ thrown to Kartana, Volcarona, Meloetta, Dracovish — and in
105 of those 111 no switch on the bench survived the entry hit either.

The guard for it exists (KO_RESPECTS_ORDER: yield the KO to a resisting
refuge when outsped and the hit kills) and was rejected: heldout2, 66 gained
140 lost, p < 0.0001. **That measurement is void.** It was taken on
2026-09-18; real Speed reads landed 2026-09-19 (30dd0eb), and before them
every Speed read 0, `race.faster` was always false, and "they act first"
stood on every turn — so the guard yielded on every KO click where the hit
could kill, including the ones where we moved first and would have won.
It was measured as "always yield", never as "yield when outsped".

**Bar.** heldout1 + heldout2 (154 + 74 fights), control and
`--ko-respects-order=1`, both PP models, pinned, seed-paired. Real PP is the
verdict: net discordant seeds > 0 with McNemar p < 0.05, no scenario net −5,
and the sign holds with the largest-contributing trainer removed. Infinite
PP must not be net negative. Anything else: stays off. Reported beside it,
not judged: the 111 healthy deaths are mostly a box problem (no refuge
survives), so the ceiling here is the 179 + 104 where a refuge sometimes did.
