# Worst-Case Planning

**Status:** approved design, synthesized from three adversarially-reviewed proposals (mechanics / systems / player) with every fatal and serious critique repair folded in. Every code claim below was re-verified against this worktree and against pokemon-mono branch `codex/run-runtime-provider-v1` (head `2ae1b7e…`, the revision pinned by `vendor/pokemon-run-runtime/PROVENANCE.json` and asserted by `scripts/check-sdlc.js:63`).

**The directive (operator, verbatim):** plan with the worst case in mind — our secondary effects do not happen, theirs do; hope crits do not happen, plan for them to happen; accept that this narrows the effective range.

**The defect this fixes:** today every planning surface is an optimism. The matchup grids color both directions by `side.max` (`src/js/run_panel.js:2242`) — nearly pessimal for their direction (but crit-blind), anti-pessimal for ours. Plan verdicts say "N/8 sampled branches deathless" (`run_panel.js:1228`, `1908`) — seeds *sample* the RNG distribution; they do not bound it. And the app engine never rolls a stochastic crit at all: crits enter move resolution only through facts (`ai/src/move-engine.ts:4655`), and `criticalHitGuaranteed` is set from Laser Focus only (`ai/src/calc-adapter.ts:599,636`) — so today's "8/8 deathless" has never once sampled the event the directive names. Worst-case planning is not a narrowing of the current claim; for crits it is the first coverage of the event class.

---

## 1. Semantics — `pessimal-fold/v1`

### 1.1 The rule, stated once

A worst-case evaluation is a **bounded adversarial fold** over a battle: a deterministic playthrough in which

- the **player side follows a fixed, concrete line** (a lead plus a mechanical policy or an explicit playbook — never a search over player choices),
- the **enemy follows the modeled R&B AI** over its *reachable action set* (§1.4),
- and **every chance event resolves to the branch adverse to the player** — keyed by **beneficiary, not by acting side** (an enemy Static proc during *our* move resolves enemy-favorably),

except for a short, closed list of events whose adverse direction is not statically monotone; those **branch** (both edges explored, adversary takes the worse-for-us outcome), under a hard branch/node budget that **fails closed**.

The fold consumes **zero entropy**. Any roll site that reaches the resolver with an unknown label **throws** (fail closed), and the falsify suite includes an unlabeled-roll attack. The output is: a verdict, a **first-binding-event attribution** (which pessimal resolution decided the losing turn), an **assumption ledger** (§1.3), and the trajectory itself.

**Vocabulary discipline (binding on all UI copy and receipts):** the words "guaranteed" and "worst possible" are banned. The claim is always scoped: *"no loss from modeled RNG, vs the modeled AI"*, product-shortened to **crit-safe**. Event-local adversarial resolution with a finite branch list is not a proof of the global worst case; the residual (cross-turn threshold interactions outside the branch list) is documented here and in the modeled-event whitelist, never hidden.

### 1.2 The per-event table (normative)

"Ours/us" = player side; "theirs" = AI side. Labels are the engine's own roll labels (`sampleActionRoll`, `ai/src/move-engine.ts:870`).

| Event (engine seam) | Resolution |
|---|---|
| **Damage roll** — 16 rolls 85–100%, `pickRoll` over `facts.rolls` (`ai/src/resolution.ts:3-9`) | Our hits: minimum roll. Their hits: maximum roll. Per-hit extremes for `hitRolls` (`ai/src/facts.ts:58-80`). **Exception:** recoil moves branch both extremes — damage dealt and recoil taken pull opposite directions, so no single roll is adverse (§1.5). |
| **Crit incidence** — no roll exists in the app engine; crits are facts (`move-engine.ts:4655`) | Their damaging hits: **crit facts substituted for every action** unless structurally blocked — the vendored calc already handles Lucky Chant, Battle/Shell/**Magma** Armor, stage-ignore, and Merciless (`calc/src/mechanics/gen789.ts:145-147,1135`). Ours: never, **except structurally guaranteed crits, which are kept in every mode** — Laser Focus and Merciless-vs-poisoned (the facts flag must be extended; today it is laserFocus-only, `calc-adapter.ts:599,636`, while Merciless appears only in AI scoring at `ai/src/status.ts:1021`). R&B crit profile: 1/16 chance, ×1.5 applied before the roll, both emulator-observed (`profiles/run-and-bun/index.js:104-105,200`; corpus reproduces 1,727/1,727 only under that order, `index.js:180`). |
| **Accuracy** (`getEffectiveMoveAccuracy` + the bare roll at `move-engine.ts:2269`) | Theirs: always hit — including OHKO moves (open question §7.3). Our evasion, Bright Powder, Sand Veil grant nothing. Ours: sure-hit (`accuracy === true`) hits; a sub-100 move resolves per the **accuracy policy**: `miss` (strict) or `assume-hit` with a ledger entry `{move, accuracy, uses}` (§1.3). A resolved miss carries its full consequences (crash damage at adverse magnitude). |
| **Secondary effects, chance < 100** (`move-engine.ts:2426-2500`) | Theirs onto us: proc — **except the non-monotone branch list** (§1.5). MIN picks Tri Attack's status. Consequences persist and feed back (their burn halves our physical floor thereafter). Ours onto them: never proc. Chance = 100 effects are move text, not RNG: they apply on both sides, keyed by beneficiary (our Overheat self-drop applies; their self-boost secondaries proc). |
| **Status/volatile durations** (labels `Sleep duration`, `Confusion duration`, `${move} duration`, Bide — `move-engine.ts:1690,2461,2484,3607,3999-4088`) | Inflicted on us: maximum (sleep 4, confusion 5 acting turns, traps 5); `sleepTurnsResetOnEntry: true` honored (`profiles/run-and-bun/index.js:120`). Inflicted by us: minimum (sleep 2; their freeze thaws on their first check). Freeze on us: persists, subject to the chain cap (§1.3). |
| **Per-turn action gates** (`actionFailure`, `move-engine.ts:876-904`) | On us: full paralysis, confusion self-hit, infatuation, flinch all fire — **subject to the chain cap** (§1.3). Our repeat-Protect fails on the streak roll. On them: none fire; their repeat-Protect succeeds when the modeled AI selects it. |
| **Ability/item chance procs** (contact blocks `move-engine.ts:4569-4606`, `Cursed Body` 5035, end-turn sites `ai/src/end-turn.ts:275-685`) | Ours: never — our Shed Skin never cures, our Quick Claw never procs, our contact-punish abilities never fire, Focus-Band-class never saves us. Theirs: fire — their contact procs trigger on our contact (beneficiary-keyed: these are *enemy*-benefit events even though they resolve during our move), Effect Spore status MIN-picked, Moody/Starf (`move-engine.ts:1487`) MIN-picked; their Quick Claw and Focus-Band-class procs are **repeatable enemy-benefit events under the chain cap** (§1.3). Deterministic survivals (Sturdy, Sash, Disguise) are facts, not RNG — unchanged. |
| **Turn order** (`ai/src/order.ts:218-245`) | Speed arithmetic unchanged (R&B para ×0.25 via profile). Speed ties: enemy acts first — **except branch both orders when either active set carries an order-dependent move/ability** (§1.5). |
| **Multi-hit count** | Ours: minimum legal hits (2 for 2–5). Theirs: maximum (5). Skill Link and fixed counts structural. Composes with per-hit roll extremes via `facts.hitRolls`. |
| **Enemy action choice** (`ai/src/decision.ts` samples per-action `ScoreOutcome` supports; `SCORE_ROLL` 0.2/0.8 + critBonus 0.5, emulator-observed at 0x02000360 — `profiles/run-and-bun/policy.js:34-41`) | An RNG event, and the only *structural* branching: the adversary picks any action in the **reachable set** — `a` is reachable iff `maxOutcome(a) >= max over b≠a of minOutcome(b)`, ties included (exact w.r.t. `decision.ts`'s independent per-action sampling). The fold branches over it (true min node). Enemy forced replacements: unscored replacements all evaluate `{score: 0, probability: 1}` "tie-randomized" (`ai/src/switch.ts:96-116`), so **all living replacements are reachable** — branch over them. |
| **Move-pick samplers** (Sleep Talk/Metronome-class, label `${move} sampler`, `move-engine.ts:3746,3788`) | Branch over candidates; adversary takes the worst-for-us edge. Counts against the branch budget. |
| **Unknown label** | Throw. The fold aborts `unverified(unknown-event)`. Fail closed. |

**Not pessimized, explicitly:** the AI's scoring model itself (corrupting it answers a different question); the player's line (it is the input); deterministic mechanics; catch shake odds (`catchMath` — catching is not a safety claim); encounter/IV identity. Doubles is out of scope for pessimal semantics in this design (cells stay 1v1; doubles remains the opt-in it is today).

### 1.3 The assumption ledger and the chain cap (the useless-answer repair)

Two pessimizations are unbounded and would make every verdict "death": our sub-100 accuracy compounding to zero, and repeatable denial procs (full-para lock, flinch lock, permanent freeze, every-turn Quick Claw, always-save Focus Band). The directive says *plan to have answers to the worst case* — an answer to the bad event, and the bad event again, not to an infinite sequence of it. Both unbounded tails convert to **named assumptions** through one mechanism:

- **Accuracy policy `assume-hit`:** our sub-100 move connects, and each use appends `{move, accuracy, uses}` to the ledger.
- **Chain cap `k` (default 2, operator-tunable, §7.2):** each repeatable chance event keeps a counter per `(event label, source, victim)`. The first `k` consecutive resolutions are adverse; the next resolves player-favorably and appends a ledger entry (e.g. `assumes <=2 consecutive full-paralysis turns`, `assumes <=2 Quick Claw procs`, `assumes thaw after 2 frozen turns`); the counter resets. This is principled where the old design's accuracy exemption was arbitrary: *every* repeatable chance event gets the same boundary, on both sides of the miss/proc symmetry.

**Verdict registers, derived from one fold:**

| Register | Condition | Product copy |
|---|---|---|
| **crit-safe** | fold wins, zero player deaths, **empty ledger** | "no loss from modeled RNG · vs modeled AI" |
| **crit-safe with assumptions** | fold wins, zero deaths, ledger non-empty | "crit-safe — if Hydro Pump lands (90% ×2); assumes ≤2 consecutive flinches" |
| **unsafe** | a player death or loss on some explored branch | first-binding-event named: "dies to crit Rock Slide, turn 2, after flinch" |
| **unverified** | budget/horizon/unknown-label exhaustion | fail closed; never counts as safe |

One fold suffices for both safe registers by construction: an empty ledger means every resolution was adverse and no cap bound, so the fold is identical to the uncapped, accuracy-strict fold (`k = ∞`, `accuracy = miss`). This lemma gets its own falsifier (§3, Phase 3). Degenerate-but-honest outcomes (a stall line that exceeds the turn horizon) terminate at the existing `maxTurns` cap and read **unsafe/unverified with the cause named** — that is real Run & Bun information, not a bug.

### 1.4 The claim is line-scoped

A fold verdict certifies **the line it played** — lead, policy, and the actions actually taken (recorded as the trajectory). It never asserts "a safe line exists." The first verified line is the one the app already plays mechanically: the adjudicator's **assignment-following floor policy** (`lib/battle-driver.js` `adjudicate` doc block: "It is a FLOOR, not optimal play"). User playbooks (`playbook`, exported at `battle-driver.js:939`) are the second input. This is the repair for the strongest critique in the review: a receipt that says "safe" about a line it neither contains nor lets the player execute is a false product.

### 1.5 The non-monotone branch list (soundness repairs)

Deterministic adversarial resolution is only sound where the adverse direction is statically monotone. These are not, and **branch** (both edges, adversary picks; each counts against the budget):

1. **Status-benefit abilities on our mon** — Guts, Marvel Scale, Quick Feet, Flare Boost, Toxic Boost, Synchronize: an always-proc enemy burn would hand us a Guts boost and mint a false crit-safe. Enemy status procs onto such a mon branch proc/no-proc.
2. **Status-blocks-status** — an early always-proc poison immunizes us against a later Spore; when the enemy's reachable options include a sleep- or freeze-inflicting move, their other status procs onto us branch.
3. **Recoil damage rolls** — our min roll minimizes our recoil; their max roll maximizes theirs. Branch roll extremes on recoil moves.
4. **Order-dependent speed ties** — Payback, Bolt Beak, Fishious Rend, Analytic, Counter-timing (static list): "enemy first" halves their Payback. Branch both orders when present.

The list is closed and versioned with the mode id. Anything discovered later extends the list in a `pessimal-fold/v2`, never silently.

### 1.6 The cheap analytic projection (grid cells, closed form)

Per 1v1 cell, no simulation, no AI model — the enemy move set is taken whole (a superset of reachable, so never false-safe from AI modeling):

- **Our floor:** max over our *sure-hit* damaging moves of the minimum roll; the cell's move is **selected by floor**, not by ceiling (`bestDamagingMove` selects by `damage.max` today — `lib/planner.js:504-505` — which shows the min of the max-selected move, the wrong number for this lens). Sub-100 moves are surfaced as `accuracyExposure`, not silently zeroed.
- **Their ceiling:** max over **all** their damaging moves of the max **crit** roll (crits ignore our positive defensive stages, so the ceiling move can differ from the expected-max move — the band is computed per move, not once per cell).
- **Cell facts:** `survivesCrit = critMax < 1` at full HP; `critKO`; the KO booleans stay the policy's own Sturdy/Sash-aware facts (`facts.ts` `guaranteedKO = min >= targetHp`), extended the same way for crit bands.

The projection is deliberately more pessimal than the fold (fixed move, no switching), so cell-tier red can be overturned by fold-tier green, never the reverse.

---

## 2. Placement

| Piece | Box | Files (verified) | Re-pin? |
|---|---|---|---|
| Crit-band damage facts (`critRolls`/`critMin`/`critMax`, crit KO booleans) via a second `Calc.calculate(isCrit: true)` pass; `criticalHitGuaranteed` extended to Merciless-vs-poisoned | **App engine** — the single damage authority the planner routes through | `ai/src/calc-adapter.ts` (crit plumbing exists: `criticalHitStage` :404, `isCrit` :599), `ai/src/facts.ts:58-80`; calc is already R&B-patched incl. Magma Armor + Merciless (`calc/src/mechanics/gen789.ts:145-147`) | **No** |
| Per-cell floor/ceiling verdicts, `worst` sub-object (additive; existing fields keep meaning) | **App engine** | `lib/planner.js` `bestDamagingMove`/`matchupDirection` :487-548 | **No** |
| Roll-seam inventory: side-aware labeled resolver `(label, beneficiary) -> number` behind every RNG site, default byte-identical | **App engine** | `ai/src/move-engine.ts` (bare `random()` at 1475, 2269, 2426, 4326, 5505 must gain labels), `ai/src/order.ts:218-245`, `ai/src/end-turn.ts:275-685`, `ai/src/resolution.ts:3-9`, driver stream `lib/battle-driver.js:49,548-560` | **No** |
| The fold verifier — an explicit small tree driver (reachable-set + branch-list nodes, exact-state memo, budget), **a new module, costed as one**; the resolver seam answers only collapsible events | **App engine** | new `ai/`-level module consumed by `lib/battle-driver.js` `adjudicate`/`playbook`; crit-facts substitution rides the produce/apply split (`deriveMoveResolution` + facts injection, `battle-driver.js:560`) | **No** |
| Grid captions, floor-led move buttons, threat line, verdict registers, crit-proof tags | **UI (rendering only)** | `src/js/run_panel.js` (heat ramp :2201, `heat(side.max)` :2242, cell titles :2257-2259, buttons :2604, verdicts :1228, 1908-1910); `lib/run.js` `boxMatrix` :1136, `answerTable` :2694, `rankParties` :2715 (12 rollouts default :2863) | **No** |
| Receipt semantics visibility: first-class `input.evaluation` enum + surfaced `input.plannerRevision` | **Contract** (canonical: pokemon-mono `contracts/run-runtime/v1`; app `contracts/ecosystem/v1` is the consumer fixture cache) + app validator | mono schemas are `additionalProperties: false` with `input.seeds minItems: 1`; app validator pins exact versions but is structural (`lib/pokemon-bridge.js:6-8,38-44,84-86,98,104-105`); `scripts/check-sdlc.js:177-190` hardcodes `plannerRevision: 'seeded-monte-carlo-lead-planner-v1'` in the binding recompute | **Yes — rides the queued species-fidelity re-pin** |
| Provider pessimal verification (if ever built) | **Pinned provider** (mono `engines/rab/backend/src/bridge/`, `src/agent/monte-carlo-battle-predictor.ts`) | see §3 Phase 5 preconditions | **Yes — its own later re-pin, never the species one** |

**Placement rationale, one line each.** The analytic tier and the fold live app-side because the app's `ai/` engine is the *high-fidelity* engine — labeled rolls, volatiles, items, contact abilities, emulator-pinned profile — while the provider's MC predictor is the lightweight one: it does roll accuracy, damage, crits, status secondaries, confusion, sleep, speed ties (verified at `monte-carlo-battle-predictor.ts:410-447, 489-560, 593, 717-782` — one review's claim that it "models no crits" is false on this branch head), but it plays **both** sides with a greedy tier scorer (:631-663), has no mid-battle switching (next-alive on faint), no multi-hit, no items/abilities, a Gen≤6-style crit-stage model (:741), and vanilla species data until the queued fix. The contract owns semantics visibility because receipts are immutable evidence. The UI computes no worst-case math (same rule that keeps `guaranteedKO` the policy's own boolean).

---

## 3. Phased delivery

Every phase ships alone and is verified per rule 5 of the house: each new gate is made to fail before it counts.

**Phase 1 — Analytic floor/ceiling (app only; no contract change, no re-pin).**
Crit-band facts in `ai/` (second `isCrit` calc pass, per enemy move); Merciless added to `criticalHitGuaranteed`; `lib/planner.js` cells gain the floor-selected our-move, the cross-move crit ceiling, `survivesCrit`, `accuracyExposure`; grid recolors OUR side by floor and THEIR side by crit ceiling with self-explaining captions in the existing style ("ring = KO even on min roll · ◈ = survives their crit"); move buttons lead with the floor (`Surf 34%+ · KOs even on min roll`), full band stays in the hover title; one threat line under our HP bar computed against current HP: *"Their strongest hit: up to 48% — 71% on a crit · survives a crit"* — explicitly their strongest hit, not their predicted hit (the choice-vs-arithmetic split `lib/planner.js` already documents).
*Gates:* dominance against the 1,727-observation corpus (`scripts/rom-band-check.js`, `EXPECTED_MIN_OBSERVATIONS = 1727`) — enemy ceiling ≥ every observation incl. crits, our floor ≤ every player-side observation — **with its coverage stated honestly** (the corpus is three fixture pairs, "no ability, no item, no stat stages" — `profiles/run-and-bun/fidelity/README.md:36`), plus new targeted fixtures for the crit/stage-ignore and Guts/burn interactions. Falsify: drop the `isCrit` pass and watch the ◈ glyph go wrong on a pinned cell.

**Phase 2 — Roll-seam hardening (app only; behavior-preserving).**
Label the five bare `random()` sites in `move-engine.ts` and the `end-turn.ts`/`order.ts`/`resolution.ts` seams; introduce the side-aware resolver interface with a default that reproduces current seeded traces **byte-identically**; assert unknown-label-throws; reconcile the **confusion constant** against the emulator corpus — the app fails action on `roll >= 1/3` (2/3 self-hit, `move-engine.ts:893`) while the provider predictor uses `roll < 0.33` (1/3, `monte-carlo-battle-predictor.ts:418`); one of these is wrong and every seeded baseline inherits it.
*Standalone value:* pins seeded-sim determinism and catches exactly this class of drift. *Gates:* trace-equality over the fixture corpus (falsify by permuting one roll call); unlabeled-roll attack in `just`-equivalent falsify suite.

**Phase 3 — The fold verifier and the verdict ladder (app only).**
The bounded adversarial fold (§1) as an explicit driver: player line fixed, enemy reachable-set + branch-list nodes, crit-facts substitution for enemy actions / min-facts for ours, exact-state memoization only (no HP-domination pruning — unsound under Reversal/Flail/Endeavor/berry thresholds), node budget failing closed to `unverified`. One fold joins `rankParties` adjudication and split prep beside the 12 seeded rollouts; verdict registers render in strength order; rank rows gain a `crit-safe` tag; sort-order change is opt-in until the operator answers §7.4.
*Gates:* determinism (fold twice, byte-identical; zero entropy consumed); the empty-ledger lemma falsifier (force a capped chain, assert the ledger entry appears); per-branch-rule falsifiers (legal enemy flinch must fire; Guts fixture must branch; Payback fixture must branch the tie); a directed implication gate on a curated fixture set free of the branch-list interactions: crit-safe ⇒ every seeded rollout of the same line deathless — valid there **only because** the app engine rolls no stochastic enemy crits today (`move-engine.ts:4655`, laserFocus-only facts); that dependency is written down and the gate is re-derived if W3 ever gains crit rolls.
*Pre-declared success bar (abort criterion):* on the Brawly and Norman fixture boards, the pessimal registers must separate cells (not uniformly red at `k = 2`), and every red must carry a named first-binding event. If the bar fails, recalibrate `k` / copy before any default-on rendering — this is the fun-ceiling tripwire made falsifiable (`docs/EVALUATION.md` risk 5; two consecutive abandoned runs mid-split remains the overriding trigger).

**Phase 4 — Receipt semantics visibility (contract groundwork; the ONLY phase that rides the already-queued vanilla-species data-fidelity re-pin).**
Canonical schemas (mono `contracts/run-runtime/v1`, `additionalProperties: false`) gain an optional first-class `input.evaluation` enum — initially the single value `'seeded-sample/v1'` — and surface `input.plannerRevision` (copying the attribution-receipt precedent; today it is hash-bound but unreadable, `run-runtime-provider.ts` binding + `check-sdlc.js:182`). Rule for consumers: **absence of `evaluation` = seeded-sample semantics**; unknown values reject. The app-side discriminator switch in `lib/pokemon-bridge.js` and `check-sdlc.js` fixture assertions land **before** the re-pin, in that order. No pessimal semantics ship here — this phase makes every future receipt's mode legible so calibration trends never mix claims.
*Gates:* the mislabeled-receipt falsifier is the **evaluation ↔ plannerRevision pairing** (a receipt claiming an evaluation its planner revision cannot produce goes red — checkable, unlike "the numbers look seeded"); contract digest bump verified by `check-sdlc.js:158` and the conformance suite mono-side before re-pin.

**Phase 5 — Provider pessimal verification (deferred; a decision gate, not a commitment; its own deliberate re-pin — the species fix must never wait for it).**
Built only if the operator wants content-addressed receipts for pessimal claims (§7.5) after the app tier proves out. Preconditions, all mandatory, from the critiques that survived verification: (a) the provider mode is a **verifier of a supplied line** and records the trajectory in evidence — never "a safe line exists" with five numbers; (b) move selection consumes pessimal-resolved facts (a selector blind to always-miss rules answers a different question); (c) a `horizon-exhausted` termination becomes legal as a non-victory (today `validatePlannerResult` hard-fails any `termination === 'timeout'`, which a deterministic fold would hit reproducibly); (d) pessimal requests bypass the seed-keyed `rankLeads` aggregation entirely and omit `seeds` (the current schema requires `minItems: 1`; an empty list would also drive `Math.max(...[])` to `-Infinity`); (e) all pre-existing summary fields, `result.safe`, and the lead sort remain defined over seeded branches only — one receipt carries one mode, never mixed branch kinds — with a conformance test that a dying pessimal evaluation cannot move `safeBranches`; (f) the receipt publishes the provider's **modeled-event whitelist** (no items, no abilities, no multi-hit, no switching, Gen≤6 crit-stage model at `monte-carlo-battle-predictor.ts:741`); (g) a pessimal fixture in `contracts/` that the app fold and the provider fold must reproduce byte-comparably, wired into the cross-engine gate, or the two hand-written rule tables drift with nothing watching.

---

## 4. Explosion control, and keeping "crit-safe" meaningful in a Kaizo game

**No enumeration exists anywhere.** The cheap tier is closed form (one extra calc invocation per enemy move per cell — per-move, not per-cell; still O(box × party)). The fold is one deterministic trajectory except at: enemy reachable actions (typically 1–3; exactly computable from `ScoreOutcome` supports), enemy forced replacements (≤ living party), the closed non-monotone list (§1.5), and move-pick samplers — all under one node budget with exact-state memoization, failing closed to `unverified`. Secondary-effect combinations never enumerate: procs are all-on/all-off by beneficiary except the named branches. Semantics ship as **one versioned mode id with two integer-ish knobs** (`k`, accuracy policy) — never per-event toggles, never a 2^k lattice, and never a rerun ladder: the registers fall out of a single fold's ledger.

**The useless-answer problem** is attacked structurally, not cosmetically: (1) the chain cap converts every infinite denial tail (perma-flinch, perma-para, permanent freeze, every-turn Quick Claw, unkillable Focus Band) into a *named, counted* residual, so the top register stays earnable; (2) every red carries its first binding event — the worst case arrives as a to-do ("find the Marill answer to crit Aqua Jet turn 3"), not a verdict of doom; (3) the expected reading never leaves the page (cell titles keep `min–max, crit to N%`; the seeded verdict line always renders beside the pessimal register; the battle log shows real rolls) — with **no persisted lens toggle**, because a verdict that changes with a toggle is not a verdict; (4) the Phase 3 separation bar is declared before the work and aborts the default-on rendering if the boards read uniformly red; (5) scarcity is framed as achievement in the existing heat ramp — no new alarm-red channel.

## 5. Receipt and record semantics (calibration stays interpretable)

- **Every worst-case claim is labeled at birth** with `{mode: 'pessimal-fold/v1', k, accuracyPolicy, engine, engineRevision, register, ledger, firstLoss, trajectoryRef}` — app-side verdicts in run history and split prep, provider-side (if Phase 5 ships) in the receipt's first-class `input.evaluation`. Absence of a mode label = seeded semantics, so no archived receipt or record can ever be misread as worst-case.
- **One artifact, one mode.** Seeded and pessimal evaluations of a fight are separate records/receipts; nothing aggregates across modes.
- **Calibration:** seeded receipts keep the existing two-sided plan-vs-played closeness. Pessimal records get a **one-sided bound check** — a played death where the fold said crit-safe *on the same line* is a falsification event surfaced loudly as engine-fidelity evidence, never averaged — and it is **gated on line adherence** (the recorded trajectory is the adherence key; a player who deviated produced no evidence about the bound). Band containment (played outcome inside [pessimal, best-sampled]) becomes the plan-accuracy trend `docs/EVALUATION.md` calls the most informative number the app is not producing.
- The first pessimal record enters the frozen replay corpus (EVALUATION risk 1) the day it exists, so old verdicts stay regenerable against future engines.

## 6. What we are NOT building

- **A relaxation-rerun ladder (W0/W1/W2 modes).** The ledger + first-binding-event attribution answers "which die breaks this plan" from one fold; a crit-relaxation rerun proved both redundant and gate-breaking under critique.
- **Per-event pessimism toggles** in any contract, API, or UI.
- **Whole-6v6 minimax receipts, MAX-side search, or HP-domination pruning.** The player side is a line, full stop.
- **Provider engine-fidelity uplift smuggled in as "one extra branch."** Items, abilities, switching, multi-hit in the MC predictor is a separate, honestly-scoped mono project — and until it happens, provider pessimal receipts do not exist (a bound computed on a model missing adversarial event classes is not a bound).
- **Mixed-kind branch lists** inside one receipt, or any redefinition of existing seeded summary fields.
- **A persisted Floor/Typical lens toggle**, row-rollup glyph inventories, outlook prefixes — hover titles and the always-visible seeded line carry the expected reading; texture returns only if players ask.
- **Doubles pessimal semantics, catch-odds pessimization, our-side Serene Grace credit.**
- **Any UI word stronger than the model:** "guaranteed", "worst possible", or an unscoped "safe".

## 7. Open questions for the operator

1. **Accuracy default.** The board's default register: strict (our sub-100 moves miss — the literal directive; Hustle/Stone Edge lines grade "unsafe via miss") or assume-hit-with-ledger (recommended: verdicts stay earnable and every residual die is named). Both are specified; only the default is a taste call.
2. **The chain cap `k`.** "Answers to the worst case" = survive how many consecutive bad procs? `k = 2` is proposed (a 3-chain full-para is ~1.6%). `k = 1` doubles strictness; `k = 3` triples leniency.
3. **Enemy OHKO moves.** Strict reading: Sheer Cold connects every turn — any carrier becomes a guaranteed per-turn KO and its fights go permanently red. Alternative: OHKO accuracy joins the chain-cap/ledger machinery ("assumes ≤1 Sheer Cold hit"). Which is the planning tool you want?
4. **Does crit-safety reorder recommendations?** Sorting `rankParties`/lead picks crit-safe-first changes advice globally, not just annotation. Opt-in until you call it.
5. **Is Phase 5 wanted at all?** The app tier fully satisfies the directive with the higher-fidelity engine. The provider tier adds durable, content-addressed receipts at the cost of the §3 parity list. Decide after living with Phases 1–3.
6. **Default-on scope.** Worst-case as the default reading everywhere at once, or planning surfaces first (board + verdicts) with the battle-turn threat line following after the fun-ceiling instrument (risk 5) has data?

---

*Grounding note for reviewers: two review-time factual disputes were settled by direct reads on `codex/run-runtime-provider-v1` head `2ae1b7e…`. (1) The MC predictor does model accuracy/crit/secondary/can-act/tie RNG (`monte-carlo-battle-predictor.ts:410-782`) — the "models no crits" claim is false — but it remains the low-fidelity engine for the reasons in §2. (2) The app engine and the predictor disagree on confusion self-hit (2/3 vs 1/3); reconciliation against the emulator corpus is Phase 2 work, not an open taste call.*