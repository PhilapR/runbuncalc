# Improvement audit — eight lenses over battery3

Run 2026-08-30 against batch `battery3`
(`scenarios/receipts/battery3.json`, revision 3371469, clean tree).
Eight parallel readers, one lens each: stall pathology, leader walls,
anomalous non-leader wipes, resource economy, harness invention, compute
cost, dev-loop economy, and the macro (between-fights) game. This
document is the durable record of what they found and proposed.

## How to read a claim here

Per the house rule, a delegated reader's claim is a lead until verified.
Every claim below carries a grade:

- **verified** — re-checked by a second reader in this session: the code
  shape read directly, or the command re-run and its output cited.
- **measured** — an instrumented probe printed the number; the probe's
  shape is described. Strong, but single-reader.
- **lead** — a single reader's diagnosis. Believable, unconfirmed.

Nothing in this document has been *played* in the STRATEGY.md sense.
A proposal graduates out of here by running its named battery or ab.js
arm and, if it survives, earning a stamp or a STRATEGY.md section.

## Two verified defects (both fixed, 2026-08-30)

Both were spun off into their own sessions on 2026-08-30 and both fixes
have landed on this branch: the Disguise deadlock in 99ad9ce with
ledger entry `disguise-never-breaks-in-the-composed-pipeline` (050cad3),
and the lint gate in the merge of claude/focused-borg-dbf6ca. The
sections below stand as the record of the defects as found.

### 1. The Disguise break deadlock — Mimikyu is invincible in simulation

Two layers each implement Disguise, and composed they deadlock.
`applyDamageGuards` in `ai/src/calc-adapter.ts` (~728-737) zeroes the
whole damage forecast while Disguise is active; the driver passes those
pre-zeroed facts into resolution; and the break marker in
`ai/src/move-engine.ts` (~4295-4315) requires nonzero
`damageOutcome?.directDamage` before setting `disguiseBroken`. The
"first positive hit" the contract promises (`AI_DATA_MODEL.md`,
`ENGINE-CONTRACTS.md`) never exists, so the shield is eternal.
**verified**: both code sites read directly, plus an empirical probe —
six seeds against Pokéfan Miguel @78, Mimikyu ends every fight at 100%
HP with `disguiseBroken` never set, every hit dealing exactly 0. Not a
fork delta: `profiles/run-and-bun/index.js` declares only
`disguiseBreaksWithoutChipDamage`. Unit tests pass because they
hand-build facts with damage=100, bypassing the adapter zeroing — the
composed pipeline is untested. Ice Face has the identical guard shape
one block below (~738-742) — **lead**, audit with the fix.

Consequences: Miguel's 1/20 row in battery3 is this defect, not the
policy (the lone win is confusion self-hits, the only damage channel the
bug leaves open); every prior tally involving Mimikyu or Eiscue holders
is suspect until the ledger entry rules on it; the planner grid caches
Disguise too (`lib/planner.js`).

### 2. The lint gate lists have a hole — 22 live errors unchecked

The `lint` and `test` scripts each carry a hand-maintained file
enumeration, and they have diverged (4 files only in one, 3 only in the
other). Ten files that `test:server` executes appear in neither, and
running eslint over three of them reports 22 errors (mostly
`no-restricted-syntax` ObjectPattern in `tests/server.smoke.test.js`).
**verified**: eslint re-run in this session, 22 errors reproduced. Same
failure class as the `--cache` incident paid off in commit 01d5e1a — a
gate that silently sees less than you think. Whole-tree lint measured at
~2.3s cold, so the enumerations buy nothing but drift.

## Convergent diagnoses

Where independent lenses met, the signal is strongest.

- **Infinite PP.** The engine deducts PP when defined; the bridge builds
  every move as `{name}` only. Both sides of every simulated fight run
  on infinite fuel. **verified** (both code sites re-read this session;
  see the 2026-08-30 addendum in `MODELLING-GAPS.md` for the full
  entry). Standing consequence: any policy treatment that spends turns
  differently, graded under free PP, may not survive real PP — run a
  pp-real arm before believing turn-hungry comparisons.
- **The order-blind KO rule.** The early return in
  `scripts/ui-playthrough.js` (~2304, `why: 'it KOs'`) fires with no
  turn-order or survival check. Two lenses caught it independently in
  instrumented probes: at Brawly, Timburr pressed a "KO" into a faster
  Lopunny whose hit landed first; at Bug Catcher Jose, two bodies in a
  row stayed in while the threat line read "you need 1, they need 1 —
  YOU LOSE THIS RACE · they act first". **measured**, twice.
- **View blindness.** The driver's view exposes item, types, ability,
  and the foe bench (`lib/battle-driver.js` ~363-388), but `viewOf`
  drops them, and nothing exposes foe boost stages or PP. The policy
  cannot see a Bulk Up snowball forming, and `decide()` never reads
  even the `view.bench` it is given. **measured** (economy and wipes
  lenses independently).
- **Answer abandonment.** The policy finds the working line and then
  benches it. At Daisy, Manectric's chip out-paced the heal (drove
  Florges to 45%) and was benched twice — once by the lost-race bounce,
  once by healthiest-first forced replacement. At Wattson, Excadrill —
  the dossier's named answer for Rotom-Fan and Mega Ampharos — was spent
  on Magnezone by turn 2. **measured**, two lenses.

## Per-fight diagnoses from battery3

- **Aroma Lady Daisy @79 (14/20, STUCK=4, 111 turns/fight).** A
  mathematically closed equilibrium against Florges (Leftovers +
  Synthesis): net HP flow is negative for the player, and neither side
  can kill the other. The stall-break fed the bench one body at a time,
  then went silent — `progress.since` reached 303 consecutive
  no-progress turns with no escalation path. The progress clock resets
  on damage-roll noise and on the foe's rendered name changing when a
  status lands (`nameOf` appends `· brn`). **measured** (seed-level
  trace; stuck seeds 4, 10, 11, 20 reproduced).
- **Bug Catcher Jose @37 (1/20).** Bulk Up Pinsir takes 3-5 free boost
  turns every losing seed (boost stages invisible to the view), then the
  order-blind KO rule donates the rest. Hariyama is in the party with
  Whirlwind — a boost-resetting phaze the engine supports — and the
  policy prices it at zero. The ATTACK_DROP rule also spent a turn on
  Baby-Doll Eyes against Storm Throw, an always-crit move that ignores
  attack drops. **measured**.
- **Pokéfan Miguel @78 (1/20).** Defect 1 above, entire.
- **The leader walls (Brawly 0/30, Roxanne 0/30, Wattson 1/30).** A
  stat wall the policy worsens with donated turns and bodies, fought by
  a six never picked for the leader: the battery plays `doc.party`
  verbatim — the party re-pick a live run performs never runs. None of
  the three banked parties holds a dossier-named answer except
  Wattson's Excadrill, which is mis-sequenced (see above). The dossier's
  own counterfactual bounds the headroom: the Wattson box at 31 IVs won
  15/30, so sequencing and selection are leaving real wins on the
  table. **measured**, with **lead** on the exact headroom split.
- **The floor/ceiling waste.** Five of thirteen scenarios sit at 0/30,
  0/30, 20/20, 20/20, 20/20 — 130 seeds per batch spent where win rate
  can't move. **verified** (the receipt says so).

## Structural findings outside the fights

- **boxMatrix is paid three times.** `boxMatrix` (`lib/run.js:1397`) is
  called again by `rankParties` (:3756) and `fightPlaybook` (:4079),
  and each call builds a fresh `specs` array, so the identity-keyed
  WeakMap caches in the calc adapter can never hit across stages.
  Recorded span residuals in `post-perf-cost.json` confirm it on two
  real states (~8-10% of pipeline objects). **verified** call sites,
  **measured** cost.
- **The cost-bench state pool churns.** 6 states (Aug 26) → 3 (Aug 27)
  → 7 different positions today, so cross-label `objects_share_pct`
  comparisons silently compare different workloads; two of the Aug 27
  states' source documents are already deleted despite the retention
  note that deep run documents cannot be regenerated. **measured**.
- **The verify loop is one file.** `tests/browser_run.test.js` measured
  at ~109s alone — most of `test:server`'s ~110s wall, since Node runs
  test files concurrently and wall time is the slowest file. Flat
  150/250ms sleeps in its battle driver pace up to 40 turns per fight.
  **measured** (timings cited per-command in the dev-loop report).
- **The macro layer is built but not driven.** `hold`/`unhold` and the
  measured lead-pull play (Static steering, 5.7%→53.5%) exist in
  `lib/run.js`/`lib/play.js` and are never called by the driver.
  Teaching and Heart Scales are priced against the next fight only —
  the RETEACH comment in `scripts/ui-playthrough.js` names the failure
  itself. The skip the plan already justifies (Gavi pWin 33%→100%,
  STRATEGY.md §I) is pressed only after up to 12 retries burn. Runs
  also die before Brawly: STRATEGY.md §VII's death clustering at fights
  #11-#19 makes depth a sequencing problem, not only a wall problem.
  **measured** (file reads; the numbers are STRATEGY.md's own).

## The backlog

Ranked within each lens by the proposing reader; the cross-lens top ten
was ranked by impact × confidence at synthesis. Every row names its
measurement so it can graduate or die honestly. Flags are proposed
names, not implemented ones.

### Engine truth (do these before trusting turn-hungry A/Bs)

| Proposal | Mechanism | Measure |
|---|---|---|
| Fix Disguise/Ice Face break — LANDED (99ad9ce) | one layer owns the reduction; composed-pipeline test; ledger entry | measured: Miguel 1/20 → 14/20 (pp-econ-a vs battery3) |
| Make PP real — LANDED as a switch, off by default (7bba84c) | fill `pp`/`maxPP` at state construction; view exposure and policy tiebreak still open | measured: pp-econ-a/b — Daisy 14→18 with stuck 4→0, Jose 1→6, leaders unmoved |

### Fight policy

| Proposal | Mechanism | Measure |
|---|---|---|
| KO respects turn order — MEASURED, net-neutral, stays off (bf07dfd, receipts be2f113) | yield the KO to a healthy resisting switch when Speed says they move first, their plain hit kills, and our move has no priority | koorder1 / koorder1-pp vs battery4 / battery4-pp, seed-paired: 20 vs 21 and 22 vs 21 discordant seeds, p = 1.0. Helps where the failure was measured (Jose 6→12/20 real PP, 6-0 on discordant seeds), costs as much elsewhere (winnable Roxanne 8→3, 1-6): the bank-bodies entry-hit trade again. Tapes answered it (8023610): at the first yield in each of the 43 flipped seeds, a healthy holder (≥50% HP) gained 8 and lost 1; a chipped one gained 14 and lost 20 — Vespiquen at 100% into a 290% Rock Slide is worth saving, Octillery at 30% into a 46% Knock Off the AI often does not even choose is not. `koorder2` (`--ko-yield-min-hp=50`, 2b413f9, receipts 7b9c267) failed the bar declared before it ran: in sample it fixed the Roxanne losses and kept Jose (real-PP battery 10 gained, 1 lost, p = 0.012), but on 13 held-out fights it is +3 under both PP models (p = 0.61), no better than ungated koorder1 there, and Triathlete Jacob loses 4. Retested with power on 74 fresh held-out fights (heldout2, 77b5aac, receipts 17564df): koorder1 loses 140 seeds for 66 gained, p < 0.0001; koorder2 21 gained / 40 lost under real PP (p = 0.02, most of it at School Kid Karen, roughly neutral elsewhere). **Refuted out of sample**: the Jose and Roxanne gains were position-specific. Both flags stay off, kept only so the receipts replay |
| Entry-survival gate on resist switch — folded into the KO arm as resist + ≥50% HP; the view prices no bench damage, so nothing finer is honest | the lost-race switch must survive the priced entry hit | measured with koorder1 |
| Phaze the setup | price Whirlwind/Roar class; press on rising-threat signature | Jose ×20, then full battery `--phaze` |
| Pick the six by play — ADOPTED 2026-09-18 by operator ruling (DECISIONS: the-battery-picks-the-six-by-play); built 1449ccc, receipts 2111544 | field the ranker's top K sixes through the real policy on selection seeds and send the best, instead of the ranker's score, whose playout policy is not the one that fights | lead: at Roxanne the ranker's pWin correlates 0.13 with wins; br-19 ranker #1 0/30 vs its #7 20/30. Measured K = 6, S = 6 against the adopted defaults on the 87 held-out fights: real PP 1430 vs 1356 of 1740, +102 / -28, p = 4.4e-11; fuel-free +102 / -27; +29 without Chelle Daycare (+45); worst fight -2 (Isaac br-28, a one-fight selection margin). Play overruled the ranker in 29 of 87 fights; the big gains mostly lead with a body the ranker had benched or slotted second (Drednaw at Chelle 2→17, 6→18, 10→18; Lass Haley 6→17 by dropping Rhyhorn). Brawly unmoved. Costs about 2× battery time. Open: the live run still fields the ranker's six; a lead-order fix in the ranker may recover much of this without 36 fights |
| Price a six's shared weakness in the set score — ADOPTED 2026-09-18 at 0.5 (DECISIONS: the-set-score-prices-shared-weakness); built 41d3c5c, receipts 4e41406 and ef4718e | the set score sums each enemy's best answer, so members the same enemy one-shots before they move cost nothing past its answer; `exposureWeight` charges λ per member an enemy one-shots from the slower side | among the ranker's top six sixes on 87 held-out fights the set score tracked selection wins at r = 0.006, this count at -0.17 (lead order explained none of pick-by-play's gain: 0 of 29 overrules were lead-only). λ = 0.5, ranker's first six, real PP, fresh control at 41d3c5c: 1414 vs 1334 of 1740, +139 / -59, net +80, p = 1.3e-8, +46 without Karen. The six changed in 55 of 87 fights; three lose 10+ (Isaac br-5 -16, reteach2-A-10 -10, Chelle brsend1-B-4 -10); Brawly unmoved. Chosen on these fights' selection seeds. CONFIRMED on heldout3 (80 new boxes, 1e98596): control 1302, λ 0.5 1356 (+133 / -79, p = 2.5e-4), λ 0.25 the same six in 75 of 80; pick-by-play 1366, with the term 1406 (+40 over pick-by-play, p = 0.002). Open: Battle Girl Luna -38 on the ranker's first six, -13 with pick-by-play. Why (br-27, br-20): the linear count taxes a member for one bad matchup even when it is the six's answer elsewhere — Drednaw KOs Electivire and outspeeds and KOs Turtonator, dies only to Tsareena, and loses its slot to Pancham, which answers nothing and dies to nothing. A concentration-only charge (members past the first per enemy) fits that story but tracks selection wins worse than the linear term on heldout1+2 (r 0.121 vs 0.153), and the tallies cannot judge sixes outside the old top six, which is where Luna broke; not pursued without fresh fights |
| Early catch plan — Route 104 measured at Brawly 2026-09-18 (--swap-catch 19c0d70, receipts 27ba6b8) | Brawly's named answers are all catchable by Route 104 and none of the 19 archive boxes that reach him holds one; every box spent its Route 104 encounter on a non-answer (Sizzlipede, Paras, Ledian, ...). The fight is decided in the first hour of the run, before the ranker or the policy acts | the box's Route 104 catch swapped, level-up moves only (a floor), adopted defaults, 380 paired seeds: control 7.9%; Combee (Vespiquen at 21) 19.7%, +60 / -15, p = 1.6e-7, fielded in 17 of 19; Salandit 9.5% (p = 0.15); Yanma 7.9% (net 0). The evolution data carries no gender condition. TM teaches (--swap-teach, e1c4ec5) add nothing at Brawly: the moves dated before him are filler and Aerial Ace, Sludge Bomb, Dual Wingbeat are undated. Answer key, all 16 species (receipts a6816d5): Combee 75, Horsea 40, Salandit 36, Scatterbug 35, Krabby 34, the rest 30-31. Grid scorers name Combee first but order the rest at rho 0.47 (set-score gain), 0.42 (damage), 0.31 (adviseCatches) against a declared 0.5. scripts/catch-planner.js plays every open species on 6 selection seeds and prices walk vs fish by expected gain: its picks score 69 against the control's 30 (p = 1.8e-8, bar >= 65 met), but always-Combee scores 75 — at an 8% base rate six seeds are mostly zeros, so it keeps the catch in 10 of 19 boxes. Next: plan from evidence pooled across boxes, per-box play only to break ties; odds matter (Combee is 5% of walk encounters, Horsea 30% of fishing) |
| Fight keys | compile LEADER-KEYS traps and answer pairings; reserve named answers for named targets | 3 leaders ×30 `--fight-keys` |
| Re-pick the six — ADOPTED 2026-09-18 by operator ruling over the veto, with the priced switch (DECISIONS: the-battery-re-picks-like-a-live-run); measured 83aea75, receipts e6722f6 | the ranker's top six, lead first, set through run.apply before the fight; the live driver's forecast-lead step is not reproduced | held-out pooled real PP 339 gained, 183 lost, net +156, p < 0.0001, holds without the largest trainer. But ten held-out scenarios lose 5+ net (Lass Haley -16 of 20) and the leaders barely move (Brawly 0→2, Roxanne 0→0, Wattson 1→2 of 30): selection is not what walls them. Live runs already re-rank. Tapes of the worst pick (Lass Haley, 16/20 banked vs 0/20 ranked) show the same line on all 20 seeds: the ranker's answer to Lumineon (Exeggcute, scored 0.914) opens with Hypnosis, then the lost-race resist switch sends Rhyhorn in because Rock resists Air Slash, and Lumineon's Surf kills it. `incomingType` reads only the move on the threat line, which is the hardest hit against the body IN PLAY, never against the body coming in. Counterfactual on that scenario, real PP: ranked six 0→1 without status-first, 0→6 without the resist switch, 0→11 without both — and 11/20 matches the ranker's own pWin 0.58, so the ranker forecast its own playbook correctly and the policy did not play it. Without the resist switch the banked six also rises 16→19. In 8 of the 10 vetoed scenarios most lost seeds (72 of 96) hold a resist-switched body dead within two turns. Remaining gap (11 vs 19): the set score takes one answer per enemy and does not price a bench that shares a weakness to that enemy's coverage |
| Net-progress stall clock — MEASURED, no effect, stays off (f524e5a, receipts 536a96a) | stable foe key; heals count against; noise lows (< 5 points below the last reset) don't reset | on both held-out sets under real PP the clock held 633 resets and moved 2 of 1740 outcomes (0 gained, 2 lost, p = 0.5). The diagnosis was right and no longer matters: with real PP no receipt has a stuck seed, because running out of PP ends a stall before either clock acts |
| Price Speed in the advisor — MEASURED at Wattson, low value, not pursued (f5d9e26, receipts 7f2c3d3) | adviseUpgrades scores KOs gained, KOs conceded and max damage (upgradeDelta); a Speed IV moves none, so the filter drops every Speed row and the advisor never buys one, though each board cell records `speed`. Speed 31 flips order in 7 cells across the Wattson and Roxanne dose boxes | speed-probe at 60 paired seeds: +2 Speed at 23 scales gains 1 seed, loses 0 (a real order flip, Ampharos over Eelektross); Speed in place of two defensive buys at 15 scales loses 11-12 for 2 (p ≤ 0.02). The blind spot is real and nearly free at Wattson; revisit only where an order flip decides an even race at a wall |
| Price the voluntary switch — ADOPTED 2026-09-18 by operator ruling over the veto (DECISIONS: a-voluntary-switch-is-priced) | the lost-race resist check reads the threat line's move, which is the hardest hit against the active body; price each candidate's entry against the foe's best move into IT, as forced replacements already are | MEASURED (fa8e9aa, receipts 540165b), vetoed, flag stays off: on the 77 held-out fights not read to find it, real PP 227 gained / 143 lost, net +84, p < 0.0001, +68 without the largest trainer; battery 46 / 11 with no veto. Seven primary scenarios lose 5+ net (Karen -11, Lass Haley -8/-7), so the per-scenario veto decides again, as it did for re-pick. Leaders unmoved. With re-pick, fuel-free 391 / 158 against the control, the largest gain measured. Open decision: whether the net -5 veto is the right bar for broad changes across ~80 fights |
| Siege commitment | on declared stall: pick replacement by damage, commit it, stop the bounce | `--siege`, Daisy + Miguel |
| Ceiling-ranked stall moves | in stall state rank by max×acc — variance is the only lever against a heal loop | `--stall-ceiling`, Daisy ×40 |
| Concede the closed fight | bench exhausted + no progress ⇒ fast honest loss, not a 400-turn guard | `--stall-concede`, wins must not move |
| Heal budget by fight length | cooldown-based heals instead of 2/fight flat | `--heal-budget`, Daisy/Jose/Miguel |
| Re-status on wake | clear the status lock when the suffix clears; cap 3 | `--restatus`, 3 leaders ×30 |
| Exchange-rate ledger | track cumulative HP spent vs removed; play lines when bleeding despite won local races | `--exchange-ledger`, full A/B |
| Auto-crit literacy | skip attack-drop lines against always-crit moves | bundle with phaze batch |
| Wall coroner | all races lost + foe untouched 8 turns ⇒ stop donating, mark `wall` in the receipt | `--wall-coroner`, Miguel: deaths collapse, wins flat |
| Sample the strategy space | `--noise=0.15` at walls — 30 seeds of one deterministic line measure one strategy | rerun manifest vs battery3 as control |

### Measurement harness

| Proposal | Mechanism | Measure |
|---|---|---|
| Per-seed rows in receipts — LANDED (0a2913a); tapes LANDED as replay (8023610) | seed, result, deaths w/ killer, foe remainder; tapes are regenerated from the receipt's argv by `scripts/battery-tape.js`, never stored, and refused unless the replay reproduces the row | `requireWholeReceipt` cross-checks rows against totals; each check failed once in `tests/battery_receipts.test.js` |
| Treatment-fired counters — LANDED (0a2913a) | sum the policy memory counters per scenario; refuse (exit 1) on a passed gating flag whose counter stayed 0 | five gating flags audited; modifier flags excluded because their counters move without them |
| Stuck autopsy | detect the repeating action cycle in the tape tail; flat-vs-drifting foe HP names the stall kind | fires on stuck seeds only |
| Seed-paired A/B + McNemar | run both arms on common seeds; report discordant pairs, not pooled rates | `scripts/battery-pair.js`, joined receipt |
| Blunder bisection | replay a lost seed, substitute one action at step k, resume the real policy; find the earliest flip | `scripts/blunder-bisect.js` over battery loss rows |
| Curation score + MLflow ingest | score scenarios by p(1-p) and movement; propose replacements from the archive (advisory — battery.json stays hand-curated); ingest receipts to MLflow keyed on label | archive sweep at 5 seeds; ingest refuses duplicate labels |

### Compute cost

| Proposal | Mechanism | Measure |
|---|---|---|
| Memoize boxMatrix | WeakMap per (doc, trainer) with content stamp — the calc-adapter's shipped pattern | `objects_rank`/`objects_playbook` each drop ≈ `objects_boxMatrix`; fingerprints byte-identical |
| Prefix-shared variant trials | play each seed once, fork at the first divergent decision | `objects_playbook` on variant-heavy AND light states |
| Cross-stage rollout reuse | instrument exact repeat counts first; memo only what the count proves | probe before any memo ships |
| Battery parallelism | child process per scenario | battery wall clock, not cost-bench |
| Pin the cost-bench state set | freeze a canonical `--positions` list from retained documents; record sources in the cost JSON | methodology guard for all of the above |

One dead proposal recorded on purpose: variant-trial map-dedup looked
like the top win from a stale trace and probed to zero duplicates on all
seven current real states — the constructed-box mistake in a new
costume, caught before shipping.

### Dev loop

| Proposal | Mechanism | Measure |
|---|---|---|
| Shard browser_run.test.js — LANDED (f1278da), with run.test.js split behind it (d564cd6) | 4 browser shards + tests/helpers/browser-run.js; the ranker and advisor gates out of run.test.js, which the browser split exposed as the next long pole | measured: `test:server` 117.3s → 51.1s → 40.1s (39.3s on a second reading); 597 tests before and after; each new file failed once |
| Event-driven battle waits | replace flat 150/250ms sleeps with waits on the status text the loop already reads | time the file alone pre/post |
| Lint by directory | retire both enumerations; exclusions into `.eslintignore`; drop `--cache` from the gate | in flight (defect 2's session) |
| A named fast lane | `test:quick` for touched files, documented as not the gate | additive; the pre-commit claim still requires `npm test` |
| Worker-runtime teardown race | 6.9s wall vs 1.2s CPU; investigate the 5s exit race | time the leg; no orphaned workerd on the port |

### Macro game

| Proposal | Mechanism | Measure |
|---|---|---|
| Wall-keyed prep ledger | compile LEADER-KEYS into per-split prep: routes/holds, reserved scales, named teaches, stone timing | pre-Brawly doc, prepped vs as-played, ×30; then `--key-prep` ab.js arm |
| Skip-first scheduling | adjudicate the floor at a delayable wall pre-fight; declare the measured-free skip before retries burn | `--skip-proactive` under hardcore; depth as readout |
| Boss-horizon pricing | price every teach/give/scale at the split boss too; reserve one-shots for boss-positive rows | re-taught doc vs as-taught at Brawly ×30 |
| Engineered encounters | automate hold + lead-pull for named answers (the built-but-undriven plays) | "named answer in box at wall" rate from reports |
| Over-cap candy at stat walls | spend banked candies on the named six before the boss — legal at a price per the ruling, never yet exercised | doc +2 levels, battery at Brawly ×30; needs an operator ruling before tallies count |

## Sequencing

The honest order: land the two verified defects; land per-seed rows and
treatment counters so every subsequent batch is diagnosable; then run
the policy arms with pp-real as an arm, not an afterthought — because
under free PP, a turn-spending treatment that wins may be winning with
a resource the live game refuses.
