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
| KO respects turn order | demote the KO when "they act first" and their hit is lethal, unless we have priority | full battery A/B `--ko-respects-order` |
| Entry-survival gate on resist switch | the lost-race switch must survive the priced entry hit | bundled with above (`donate1`) |
| Phaze the setup | price Whirlwind/Roar class; press on rising-threat signature | Jose ×20, then full battery `--phaze` |
| Fight keys | compile LEADER-KEYS traps and answer pairings; reserve named answers for named targets | 3 leaders ×30 `--fight-keys` |
| Re-pick the six | run party selection against the named trainer before the fight (its own arm, never mixed) | 3 leaders ×30 `--repick-party` |
| Net-progress stall clock | stable foe key; heals count against; noise lows don't reset | `--stall-clock=net`, Daisy + regression rows |
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
| Per-seed rows in receipts | seed, result, deaths w/ killer, foe remainder, loss tapes | receipt gains `rows`; gate `rows.length === seeds`, failed once |
| Treatment-fired counters | sum the policy memory counters per scenario; warn on a passed flag whose counter stayed 0 | the ab.js refusal, mirrored |
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
| Shard browser_run.test.js | 3-4 files, shared helpers; Node parallelizes files | `test:server` ~110s → ~35-45s; total 567 unchanged; each shard failed once |
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
