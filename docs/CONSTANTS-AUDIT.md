# Constants audit — 2026-08-18 point-in-time record

A four-group adversarial audit of every RNG probability, threshold, and
duration in the ai/ engine against the authority chain (Mechanic
Changes.txt -> emulator-pinned profile constants -> mainline Gen 8).
Motivated by the confusion-constant bug: a flipped comparison that sat
green because no fixture crossed it. 135 constants; 18 confirmed defects;
11 flags refuted by the adversarial pass. This file is the fix wave's
worklist — defects marked [stream-shape] change RNG consumption and land
as ONE wave with a single golden regen; [stream-safe] can land anytime.

## 1. CONFIRMED DEFECTS (verifier real=true), ordered by Kaizo-nuzlocke impact

**D1. Critical hits are never sampled — P(crit)=0 in every predicted outcome. [stream-shape]**
- Location: `ai/src/calc-adapter.ts:794` (`criticalHit: context.baseFacts.criticalHitGuaranteed && !luckyChant`), with `criticalHitGuaranteed` set only from Laser Focus (`calc-adapter.ts:636`). `attackerCriticalHitStage` (`:635`, computed at `:404-416`) has no consumer that converts stage to probability (grep-verified).
- Does vs should: sampled outcomes contain a crit only under Laser Focus. Authority 2 (profile `index.js`: `criticalHitChance: 1/16` **emulator-observed**, `criticalHitMultiplier: 1.5`) says 1/16 base, doubling per stage; the sibling predictor implements `min(0.5, 0.0625 * 2^stage)` with calculator crit rolls (predictor `:741-756`).
- Impact: every enemy attack in every fight. "Survives two hits" plans silently ignore a >=6% per-hit 1.5x outcome — the canonical Kaizo death.
- Fix: sample `roll < min(0.5, 0.0625 * 2^attackerCriticalHitStage)` in the move-resolution path and take damage from the calculator's crit rolls (as the predictor does); or, if expectation-only crit handling is a deliberate design choice, document it on the `criticalHit` fact — no such documentation exists today.
- Blast radius: adds one roll per damaging move — invalidates any seeded trace; also touches Anger Point (`move-engine.ts:4660`).

**D2. Multi-hit count is pinned at 3 — 2, 4, and 5 hits have probability zero. [stream-shape]**
- Location: `calc/src/move.ts:101-103` (`hits = (ability === 'Skill Link') ? multihit[1] : multihit[0] + 1`), consumed via `ai/src/calc-adapter.ts:628` and `ai/src/resolution.ts` (`hitCount = targetFacts.hits || 1`, per-hit damage rolls but no count roll — verified).
- Does vs should: always exactly 3 hits (5 with Skill Link — correct). Gen 8 (authority 1 line 5 -> 3): 35% 2, 35% 3, 15% 4, 15% 5 (Showdown `battle-actions.ts:865`).
- Impact: Rock Blast/Bullet Seed/Icicle Spear-class Kaizo staples deal up to 67% more than predicted 15% of the time; also fixes contact-proc attempt counts (Effect Spore et al.) at exactly 3.
- Fix: sample the count before generating per-hit rolls: `r<0.35?2 : r<0.70?3 : r<0.85?4 : 5`; Skill Link forces 5. The fixed-3 is a damage-display convention of the upstream calc leaking into a sampling engine.

**D3. Sleep lasts one turn too long when inflicted before the victim acts. [stream-safe]**
- Location: gate `ai/src/move-engine.ts:883` (blocks while `statusTurns !== 0`, reading the undecremented counter) + `ai/src/transition.ts:535-548` (`decrementSleep` runs only at the turn boundary via `decrementSideDurations`).
- Does vs should: counter 2-4 gives 1-3 missed turns if slept after acting, but 2-4 missed turns if a faster user sleeps the victim first. Gen 8 decrements on each move attempt (Showdown slp `time--` then wake at 0 and act), so it is always 1-3. Predictor agrees (1-3 `turnsRemaining`, attempt-decremented).
- Impact: sleep is the core Kaizo control tool. Your faster Spore user's target is predicted to give you 2-4 free turns when reality gives 1-3 — the enemy wakes a turn early and kills.
- Fix: decrement `statusTurns` on the sleeping mon's action attempt (fail while pre-decrement counter > 1, wake and act at <= 1), remove the boundary decrement for sleep, and move the Early Bird double-decrement (`transition.ts:541-542`) to the new site.

**D4. Yawn: converts to sleep a turn early AND always at minimum duration. [D4b stream-shape]**
- Location: `ai/src/move-engine.ts:5861` (`addVolatile(..., 'yawn', {turns: 1, ...})`) + `ai/src/end-turn.ts:951-963` (unguarded conversion, `setStatusTurns(..., 2)` at `:960`). Pipeline order verified at `transition.ts` (`advanceTurn = beginNextTurn(applyEndTurnResolution(...deriveEndTurnResolution...))`): end-turn runs before the boundary decrement, so the fresh yawn converts the SAME turn.
- Does vs should: (a) target sleeps at the end of the turn Yawn was used — Gen 8 gives one full grace turn (Showdown yawn `duration: 2`, `onEnd`); (b) sleep counter is hardcoded 2 (always the shortest sleep) — Gen 8 Yawn inflicts ordinary random 2-4-counter sleep, as the engine's own three other sleep sites do (`move-engine.ts:2466, 4593, 5807`).
- Impact: mistimed sleep windows in both directions — you lose the switch/act grace turn in planning, and a yawned mon of yours predicted to wake next turn can sleep 3.
- Fix: (a) `turns: 2` at `move-engine.ts:5861` and gate `end-turn.ts:952` on `yawn.turns === 1`; (b) `setStatusTurns(resolution, pokemon.id, Math.floor(<clamped random>() * 3) + 2)` — `random` is already threaded through `deriveEndTurnResolution` (Shed Skin uses it at `:939`).

**D5. Freeze: defrost-move bypass missing entirely (and no fire-hit thaw of the target). [stream-shape]**
- Location: `ai/src/move-engine.ts:886-888`; grep of `ai/src` confirms no defrost/thaw handling anywhere (only the trace string at `:3391`).
- Does vs should: frozen actors get only the 20% roll with EVERY move. Gen 8: defrost-flag moves (Flame Wheel, Sacred Fire, Flare Blitz, Scald, Steam Eruption, Burn Up, Pyro Ball, Fusion Flare) always thaw the user and execute (Showdown frz returns before the roll). Also missing: a damaging Fire-type move thawing the frozen TARGET — no `'frz'`-clearing on-hit path exists.
- Impact: sacking a "frozen solid" mon that could self-thaw with Scald 100% of the time; enemy frozen mons predicted incapacitated that are not.
- Fix: before the roll, `if (DEFROST_MOVE_IDS.has(actionMoveId)) return {clearStatus: true};` and add target-thaw on damaging Fire hits.

**D6. Protect/Endure consecutive-use success is a flat 1/3 — streak length ignored. [stream-safe]**
- Location: `ai/src/move-engine.ts:904-906`.
- Does vs should: any protective predecessor triggers a flat `roll >= 1/3` failure. Gen 8: success is 1/3^n, floor 1/729 (Showdown stall: counter starts 3, x3 per restart, `counterMax: 729` — verified). The counter already exists: `model.ts` `moveStreakByPokemon {moveName; count}`, incremented in `transition.ts` and correctly deleted on failure.
- Impact: a third consecutive Protect is quoted at 33% when it is 11% — Toxic-stall gambles and enemy Protect-stall predictions both wrong.
- Fix: `const count = state.moveStreakByPokemon?.[actor.id]?.count || 1; if (sampleActionRoll(random, 'Protect') >= Math.max(1/729, Math.pow(1/3, count))) return {failure: 'protect'};` Residual approximation to note: the streak is same-move-keyed, so Protect->Detect alternation resets it where the cartridge counter would not.

**D7. Wide Guard / Quick Guard wrongly take the consecutive-use failure roll. [stream-shape]**
- Location: `ai/src/move-engine.ts:904` with the set at `:200-205` (one set used for both the current-move and previous-move checks).
- Does vs should: WG/QG after any protective move fail 2/3 of the time. Gen 6+/8: they never fail from consecutive use (verified: no `stallingMove` on wideguard/quickguard in Showdown; matblock and protect have it) though they do feed the counter for subsequent stalling moves.
- Impact: doubles fights — the app tells you your Wide Guard line probably fails when it cannot.
- Fix: split the set — keep wideguard/quickguard on the predecessor (streak) side of `:905`, exclude them from the `actionMoveId` side of `:904`; only stalling moves (protect, detect, kingsshield, spikyshield, banefulbunker, obstruct, silktrap, burningbulwark, maxguard, matblock, endure) take the roll.

**D8. Accuracy/evasion-drop secondaries are silently discarded — including five R&B-buffed moves. [stream-shape]**
- Location: `ai/src/move-metadata.ts:276-283` (`toBoosts` filters on `SUPPORTED_STAT_IDS = {hp,atk,def,spa,spd,spe}`, dropping Dex keys `accuracy`/`evasion`), discard at `:303`; overlay at `:221-224`.
- Does vs should: implemented probability 0% for every accuracy-drop secondary — Leaf Tornado 30%, Mirror Shot 20%, Mud Bomb 20%, Night Daze 30%, Octazooka 30% (all R&B author-buffed, values verified against `Move Changes.xlsx`) plus vanilla cases like Muddy Water. The engine itself supports acc stages (`model.ts` `BoostStatID` includes `'acc'`; `accuracy.ts:168` consumes it).
- Impact: enemy acc-drops on your must-hit line are never predicted; the hack author deliberately made these more frequent.
- Fix: map Dex `accuracy`->`acc` and `evasion`->`eva` in `toBoosts`. Do NOT touch the `CUSTOM_SECONDARY_CHANCE` values (see R1). The chargebeam/rocksmash/smog entries are already live and correct.

**D9. Held King's Rock / Razor Fang / Stench flinch is unmodeled — 0% instead of 10% (20% Serene Grace). [stream-shape]**
- Location: kingsrock/razorfang appear in `ai/src` only in the Fling table (`move-engine.ts:111`); `stench` appears nowhere (grep-verified). Both items and the ability exist in R&B data.
- Does vs should: Gen 8 default (doc line 5): 10% flinch per hit on damaging moves without a native flinch secondary, doubled by Serene Grace (verified: Showdown kingsrock/stench `chance: 10` guarded by no-existing-flinch-secondary).
- Impact: unmodeled enemy flinch-denial chains; Fling's 100% flinch is correct and unchanged.
- Fix: in the post-damage block, for damaging moves whose secondaries contain no flinch, roll `< (sereneGrace ? 0.2 : 0.1)` per connecting hit when the attacker holds kingsrock/razorfang or has Stench (item and ability do not stack — roll whichever applies) and add the 1-turn flinch volatile to a target that has not yet acted.

**D10. High-crit move classification wrong in two diverging hand-rolled lists — and it feeds the enemy-AI choice prediction. [stream-safe]**
- Location: `ai/src/calc-adapter.ts:319-325` (used for crit stage `:411` and the `isHighCrit` fact `:786-791`) and a different copy at `ai/src/status.ts:74-78` (used at `:919` in the Focus Energy scoring clause).
- Does vs should: Poison Jab and Poison Sting treated as high-crit (they never were — verified no critRatio in Showdown); Poison Tail, Sky Attack, Snipe Shot missing (all critRatio 2 — verified); the always-crit four (Frost Breath, Storm Throw, Surging Strikes, Wicked Blow) are mislabeled as merely +1 stage — `criticalHitGuaranteed` (`calc-adapter.ts:636`) comes from Laser Focus only, so Anger Point (`move-engine.ts:4660`) never fires off them (the calc's `willCrit` handles their damage correctly). The status.ts copy adds `strangesteam` (a confusion move — a `stormthrow` look-alike, the same copy-pattern class as the original confusion bug) and omits seven members.
- Impact: raised — both lists implement R&B AI doc clauses ("high crit chance and Super Effective", line 63 -> `scoring.ts:355,398`; "has a move with high crit chance", line 506 -> `status.ts:916-920`), so wrong membership mispredicts WHICH move the enemy AI clicks, e.g. a spurious score bump for super-effective Poison Jab.
- Fix: one shared set: remove poisonjab/poisonsting/strangesteam, add poisontail/skyattack/snipeshot; move the always-crit four into `criticalHitGuaranteed`. Before unifying, confirm against `Move Changes.xlsx`/ROM data that R&B did not alter any move's crit ratio (see U4).

**D11. Sandstorm and hail chip ignore ability immunities — in a permanent-weather hack. [stream-safe]**
- Location: `ai/src/end-turn.ts:84-98` (only Overcoat/Magic Guard/Safety Goggles + types exempt; grep confirms sandveil/sandrush/sandforce/icebody/snowcloak/slushrush appear in no damage-immunity check).
- Does vs should: Gen 8: Sand Veil/Sand Rush/Sand Force take no sand chip; Ice Body/Snow Cloak take no hail chip. Concrete verified failure: Ice Body is charged -1/16 at `:93` and credited +1/16 at `:455-456`, netting 0 instead of +1/16.
- **Correction (2026-08-20).** This entry first read "Ice Body/Snow Cloak/**Slush Rush** take no hail chip", and the fix shipped that way. Hail is not symmetric with sand: sand exempts all three of its abilities, hail exempts only two. Slush Rush doubles Speed and grants no immunity — `ai/src/abilities.ts` and `ai/src/order.ts` only ever gave it a speed effect. Removed; `weather-berry-spore.test.ts` now pins Slush Rush taking the chip in both weathers.
- Impact: R&B ability weather is PERMANENT (doc), so enemy Sand Rush/Ice Body mons are mis-chipped every turn all fight — your kill calcs run against phantom-lowered HP.
- Fix: add the three sand abilities to the sand branch and the two ice ones to the hail branch; gate Sand Veil's immunity on `generation >= 4` (immunity began Gen 4; `hasAbility` alone would wrongly grant it in Gen 3).

**D12. Action-gate order: paralysis checked before confusion/infatuation. [stream-shape]**
- Location: `ai/src/move-engine.ts:890-903` (order: flinch -> sleep -> freeze -> par -> confusion -> infatuation).
- Does vs should: both authorities put confusion before paralysis (Showdown onBeforeMovePriority: slp/frz 10, flinch 8, confusion 3, attract 2, par 1 — verified; pokeemerald lineage: CONFUSED -> PARALYSED -> IN_LOVE). Joint probabilities for par+confused: app gives 25% self-hit / 25% full-para; truth is 33% self-hit / 16.7% full-para. Self-hit damage IS modeled (see R2), so the misallocation shifts real chip damage.
- Fix: move the paralysis check between confusion and infatuation (the emerald-lineage order, better supported for this hack); confusion-before-paralysis is the load-bearing part. Flinch-before-sleep is harmless (both deterministic).

**D13. Gluttony ignored for confusion berries. [stream-safe]**
- Location: `ai/src/end-turn.ts:628-630` (bare `> floor(hp.max/4)` guard).
- Does vs should: Gen 8 default: Gluttony raises the trigger to <= 1/2. Both sibling pinch-berry functions in the same file implement the branch (`:525-527`, `:561-563` — verified). The R&B doc line ("Restore half HP, triggering at 1/4 HP") changes the restore amount and restates the base trigger; it says nothing about Gluttony, so Gen 8 default applies.
- Impact: an enemy Gluttony mon's half-max heal arrives at 1/2 HP, a full phase earlier than the app predicts — kill calcs off by half their HP.
- Fix: reuse the sibling threshold expression.

**D14. Aqua Ring and Ingrain do not stack and Big Root is never applied to them. [stream-safe]**
- Location: `ai/src/end-turn.ts:106-109` (single flat 1/16 if either volatile present; `drainRecoveryAmount` at `:73-78` applied only to Leech Seed).
- Does vs should: Gen 8: each heals 1/16 independently, each boosted 30% by Big Root.
- Fix: pass `state` in and sum one `drainRecoveryAmount(state, pokemon, Math.max(1, Math.floor(hp.max/16)))` per active volatile.

**D15. Taunt is a fixed 3-turn counter with no turn-order adjustment. [stream-safe]**
- Location: `ai/src/move-engine.ts:5812`.
- Does vs should: with this engine's end-of-turn decrement, the fixed 3 is correct for a slower target but shorts the FASTER (already-moved) target to 2 taunted actions; Gen 8 always yields 3 (Showdown: duration 3, +1 when the target has already moved).
- Fix (direction corrected by the verifier — the flag as filed was inverted): `turns: targetAlreadyMovedThisTurn ? 4 : 3`.

**D16. Effect Spore split is the Gen 3/4 value: 10/10/10 instead of 9 psn / 10 par / 11 slp. [stream-safe]**
- Location: `ai/src/move-engine.ts:4583-4589`.
- Does vs should: Gen 8 (verified: Showdown r<11 slp, r<21 par, r<30 psn) — total 30% matches, split is the wrong generation; sleep (the worst status) is underweighted.
- Fix: `< 0.09 ? 'psn' : < 0.19 ? 'par' : < 0.30 ? 'slp'` (minimal diff preserving the file's psn-first branch order; the slp-first Showdown-order variant is distribution-identical — see R11). Downstream slp branch at `:4592` needs no change.

**D17. Uproar rolls the Gen 3/4 duration (2-5) instead of the Gen 5+ fixed 3. [stream-shape]**
- Location: `ai/src/move-engine.ts:4093`.
- Does vs should: unconditional `floor(r*4)+2`; Gen 8 is fixed 3 (verified: Showdown uproar condition `duration: 3`); no Uproar entry in the R&B doc.
- Fix: `const turns = state.generation >= 5 ? 3 : Math.floor(sampleActionRoll(...) * 4) + 2;` — matches the file's existing generation-gate style.

**D18. Serene Grace and Pledge-Rainbow doubling do not stack. [stream-safe]**
- Location: `ai/src/move-engine.ts:2397-2399, 2438`.
- Does vs should: boolean OR applied as one x2; Gen 8 stacks them multiplicatively (x4, capped 100 — Serene Grace + Rainbow Iron Head is 100%, not 60%). Niche: requires a Serene Grace user behind its own Rainbow in doubles.
- Fix: `let m = 1; if (sereneGrace) m *= 2; if (gen>=5 && pledgeRainbow) m *= 2; chance = Math.min(100, effect.chance * m);`

---

## 2. CROSS-ENGINE DISAGREEMENTS (app vs MC predictor vs profile)

1. **Crit occurrence** — app: never sampled (D1); predictor: `min(0.5, 0.0625 * 2^stage)` with calculator crit rolls; profile: 1/16 x1.5, emulator-observed (1,727/1,727 damage observations reproduce only with x1.5 before the roll). Resolution: predictor and profile agree; the app is the outlier and must sample or document.
2. **Sleep-turns reset on switch entry** — app: deterministic `FRESH_SLEEP_TURNS = 3` (`transition.ts:30,149-153`); provider engine: re-rolls 1-3 remaining (`rab-status-effects.ts:80-89`); authorities confirm only THAT it resets (doc line "sleeping turns count is reset"; profile boolean `sleepTurnsResetOnEntry`, source-of-truth), not the value. Unresolved — emulator probe (see U1).
3. **Confusion self-hit constant** — app `< 1/3` (`move-engine.ts:898`), predictor `< 0.33` (`:418`). Gen 8 cartridge is exactly 33/100, so align BOTH to 0.33 (0.33pp, behaviorally negligible; direction correct in both — the original `>= 1/3` bug is confirmed gone).
4. **Confusion snap-out turn** — predictor decrements then still rolls the 33% self-hit (`:417-421`), so the wear-off turn can self-hit; the app (and cartridge) snap out first. The app is right; fix the predictor (skip the roll when the decrement reaches 0). Also: the predictor's hp/8 self-hit chip is a heuristic; the app samples real calculator self-hit damage (`confusionDamage`, calc-adapter.ts:857) — app is the stronger model here and the predictor should say so in a comment.
5. **Representation differences verified equivalent (no action)** — app sleep counter 2-4 with boundary decrement vs predictor 1-3 remaining with attempt decrement; app confusion counter 2-5 vs predictor 1-4 acting turns: same distributions, different bookkeeping. Coverage asymmetry: the predictor has no Protect-streak model at all.

---

## 3. REFUTED / CORRECTED FLAGS (anti-noise)

- `CUSTOM_SECONDARY_CHANCE` "unverifiable" — **refuted**: all eight values match the author's own `Move Changes.xlsx` (re-extracted this pass: Charge Beam 70%->100%, Leaf Tornado 50%->30%, Mirror Shot 30%->20%, Night Daze 40%->30%, Rock Smash 50%->100%, Smog 40%->100%; Mud Bomb/Octazooka dedupe-consistent). Values are correct; the defect is the dead-code discard (D8).
- "Confusion self-hit only cancels the action, no damage" (status-durations coverage note) — **refuted**: `confusionDamage` is calculated (`calc-adapter.ts:857`), sampled on the failure path (`move-engine.ts:2780-2784`), and pinned by `ai/src/test/confusion-damage.test.ts`.
- Taunt fix as filed (`targetHasNotMovedYet ? 4 : 3`) — **inverted**; it would have broken the correct slower-target case. Corrected in D15.
- "Align the MC predictor to 1/3" option — **wrong direction**; cartridge Gen 7+ is exactly 33/100; align both engines to 0.33.
- Focus Band `random() >= 0.1) continue` (`move-engine.ts:4331`) — looked like the flipped-comparison class; **verified correct** (10% survival; the `continue` inverts it).
- G-Max residual local named `sixteenth` holding `hp.max / 6` (`end-turn.ts:604`) — **value correct** (1/6); rename-only hazard.
- Nightmare residual inert at gen 8 — **correct** SwSh removal, consistently gated at all three sites; not a missing mechanic.
- Rough Skin 1/8 under the gen 3-4 gates — mainline gen 3-4 was 1/16, but the branch is **unreachable** in R&B; no live defect.
- Sleep initializer `floor(r*3)+2` — **correct at all four sites**; only the decrement placement (D3) is wrong. Do not "fix" the initializer.
- Bide gen-2 3-4 branch — unreachable at gen 8; gen 3+ fixed 2 verified against pokeemerald lineage.
- Effect Spore fix-order difference between audit groups (slp-first vs psn-first thresholds) — **equivalent distributions**; either implements 9/10/11.

---

## 4. THE CLEAN BILL (verified correct, grouped)

- **Action gates and rates**: freeze 20% thaw (act on thaw), full paralysis 25%, infatuation immobilize 50%, deterministic flinch skip, accuracy `roll < acc/100`, the `sampleActionRoll` [0,1) clamp, and the `passesChance` helper direction — all Gen 8-exact, all comparison directions verified in words.
- **Contact-proc abilities**: Static/Flame Body/Poison Point/Cute Charm/Poison Touch/Cursed Body all 30% per connecting hit with correctly inverted `>= 0.3 continue` shape; Cursed Body's 4-turn Disable; Effect Spore's 30% total.
- **Secondary-effect machinery**: proc direction (`bounded < chance/100`), per-connecting-hit rolls, Sheer Force suppression, single Serene Grace x2, Tri Attack 20% then uniform thirds, Fling King's Rock/Razor Fang 100% flinch, Shield Dust/Covert Cloak blocking (self-effects exempt), live chargebeam/rocksmash/smog overlay entries.
- **Crit damage math (calc side)**: x1.5 floored before the 0.85-1.0 roll (emulator-pinned 1,727/1,727), crit stage-ignore rules, screens skipped on crit, Sniper 1.5x, Focus Energy +2 / Scope Lens / Razor Claw / Super Luck +1, Lucky Chant, and crit blockers including R&B's documented Magma Armor extension.
- **Status/volatile durations and locks**: sleep counter 2-4 at all sites, Rest 3, confusion 2-5 at four sites, rampage 2-3 with fatigue confusion, partial trap 4-5 with Grip Claw 7, Bide 2 (gen 3+), Encore 3, Disable 4, Embargo 5, Heal Block 5, Magnet Rise 5, Telekinesis 3, Perish 3, Throat Chop 2, Lock-On 2, charge/delayed moves 2, G-Max side residual 4, Rollout 5, Fury Cutter cap 4, all one-turn markers.
- **End-turn residual damage**: burn 1/16 with Heatproof halving, poison 1/8, toxic n/16 ramp with correct counter seeding and cap, Curse 1/4, sand/hail 1/16 fractions and type immunities, binding 1/8 (1/6 Binding Band), Leech Seed 1/8 with Big Root and Liquid Ooze, Sea of Fire 1/8, G-Max 1/6, Salt Cure correctly gen-9-gated, Grassy Terrain +1/16.
- **Items and berries**: Leftovers, Black Sludge both directions, Sticky Barb, Focus Band 10%, healing berries (threshold <= 1/2, amounts, Ripen doubling, Berry Juice exclusion), stat/Micle pinch berries <= 1/4 with Gluttony <= 1/2, Starf +2 from the correct five-stat pool, Lansat, Leppa 10/20, Cheek Pouch 1/3 at all six sites, Cud Chew correctly gen-9-inert, Flame/Toxic Orb end-of-turn activation.
- **End-turn ability procs**: Shed Skin exactly 1/3 (direction verified), Harvest 50%/100% sun, Healer 30%, Moody +2/-1 honoring R&B's documented acc/eva inclusion, Speed Boost, Bad Dreams 1/8, Poison Heal net +1/8, Rain Dish/Dry Skin/Ice Body/Solar Power magnitudes, Emergency Exit half-crossing, Schooling/Shields Down/Zen/Power Construct thresholds.
- **Uniform samplers**: Metronome/Sleep Talk/Assist candidates, Acupressure (incl. acc/eva), Starf/Fling boost stats, Conversion 2, Tri Attack status choice — all uniform, all index-safe under the clamp.
- **R&B documented overrides honored**: confusion berries restore half HP at 1/4 (doc + profile), paralysis speed x0.25 and crit 1/16 consistent across profile and predictor, Magma Armor crit block, Moody acc/eva, gender-free infatuation at the eligibility layer, Soul Dew stages, Super Fang/Covet types.

---

## 5. UNVERIFIABLE — emulator-corpus extension candidates

1. **Sleep-reset-on-entry VALUE** (app fixed 3 vs provider re-roll 1-3): the doc and profile pin only the boolean. Probe: sleep a mon, switch it out/in repeatedly, record wake-turn distribution.
2. **Paralysis vs infatuation relative gate order**: Showdown (attract before par) and the emerald lineage (par before in-love) disagree; confusion-before-paralysis is settled (D12), the par<->attract edge needs a probe only if the pair co-occurs in practice.
3. **R&B ROM AI's "high crit chance" move set** (bears on D10's scoring side): confirm from the ROM AI dump or emulator AI logs that the hack did not alter any move's crit ratio before unifying the two lists — a faithful AI predictor must mirror the ROM's own classification, buggy or not.
4. **Held King's Rock/Stench flinch rate in-ROM** (D9 assumes the Gen 8 default via doc line 5): cheap probe once implemented.
5. **Bide gen-2 storage duration (3-4)**: no authority consulted; unreachable at gen 8 — deprioritize.