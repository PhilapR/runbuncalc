# Where each part of the game lives, and how we decide

Approved by the operator on 2026-09-22. It replaces the "Repository roles"
stance of `docs/SDLC.md` (2026-08-16) and restates the pokemon-mono entry of
`ECOSYSTEM.json` (2026-08-11/12), which disagreed with each other.

## Why it changes

Two statements four days apart disagree. `ECOSYSTEM.json` (2026-08-11/12):
build here, grade against pokemon-mono's external evidence, port only what
proves sound, never merge it in. `docs/SDLC.md` (2026-08-16): pokemon-mono
owns mechanics truth, and runbuncalc's `ai/` is temporary duplication that new
mechanics must not deepen. Practice followed neither cleanly. The runs, the
planner and the live advice run on `ai/`. The app's lookups and matchups run
on rab. Each platform carries a different part of the game at a different
depth, and nothing grades most of those parts against the game.

## The rule

1. **Truth is the ROM.** pykemon, which runs the real game, is the only
   authority. The hack's own documents (`docs/official/`) come next. Where
   they are silent, Gen 8 mechanics apply (their own rule). Showdown and
   mainline knowledge are evidence of what Gen 8 does, never of what Run & Bun
   does.
2. **One live implementation per aspect.** For each aspect of the game (the
   damage formula, entry abilities, action-gate order, enemy AI move choice,
   enemy switch-in, trainer data, and so on), one platform is named as its
   live home. Every consumer asks that platform, through its declared
   interface. Other copies are prototypes or graders, and are labelled as such.
3. **The home is chosen by evidence, not by where the code sits.** An aspect's
   home is the implementation with the best measured agreement with the ROM
   for that aspect. With no ROM evidence, it is the implementation with the
   best evidence from the hack's documents, and the aspect is listed as
   ungraded.
4. **Moving an aspect needs evidence.** Moving a home, or porting a better
   implementation into it, needs a graded comparison on the same fixtures.
5. **Graders stay external.** The evidence corpus (pykemon traces, the
   cross-engine fixtures) lives in pokemon-mono and is vendored by digest. An
   engine never grades itself.

## The table (from the capability matrix, 2026-09-22)

"Home" is the proposed live home. **Bold** marks a place where another
platform has the better-evidenced detail today, so the home should import it
or move.

| Aspect | Proposed home | Other copies | ROM evidence | Action |
|---|---|---|---|---|
| Damage formula and rounding | runbuncalc calc fork | rab wrapper (100%), rlm `battle/damage.py` (100%); rab configurable (87%) and rlm `planning/calculator.py` are stale | 1,727/1,727 in band, all three real cores | keep; retire or label the two stale cores; settle weather rounding (`f4-weather-rain`, never run) |
| Crits | runbuncalc | rab (fixed), rlm | rate and multiplier observed | keep |
| Move effects and secondaries | runbuncalc `ai/` | rab, rlm partial | 5 secondary proc rates | keep |
| Entry abilities | runbuncalc `ai/` (every opening swept) | rab `mechanics/ability-triggers.ts`, rlm partial | **none**; every fixture uses Run Away | probes P1, P2, P5 |
| In-battle abilities | runbuncalc `ai/` | rab, rlm partial | none | later probes |
| Weather and terrain, Primal, permanence | runbuncalc `ai/` (the only one with Primal weathers) | rab (no Primal), rlm (stub) | **none** | P0, P1, P3 |
| Action-gate order | runbuncalc `ai/` (Showdown order since `b193e3f`) | **rab checks flinch before sleep** | **none** | P4 settles it; D12 pending |
| Held items and berries | runbuncalc `ai/` | rab, rlm partial | none | later probes |
| Mega Evolution and forms | runbuncalc (stored Mega, player once per fight) | rab stub claims R&B has no Megas (wrong) | none | label rab's stub; timing is PLAN 3.1 |
| Doubles | runbuncalc (joint search) | rab heuristic, rlm targeting only | none; lead order assumed | a doubles-lead probe |
| **Enemy AI move choice** | **rab `agent/complete-ai-scoring.ts`**: fitted to 52 ROM probes, held-out top-1 0.972 | runbuncalc `ai/src/scoring.ts`, graded 2026-09-22 against the same 85 ROM probes (`tests/ai-probes.test.js`): held-out top-1 **0.833**, TVD **0.428** (rab 0.972 / 0.053); worst on setup moves and on Splash (106, the ROM says 81); rlm partial | ROM score arrays, 1,040/1,040 rows | **replay the probes against runbuncalc, then import rab's corrections.** The app's turn advice uses the weaker copy today |
| **Enemy switch-in after a KO** | undecided | rab: the documented +5..-1 table; runbuncalc: the same documented rule, adopted in the driver (`f6708e5`); rlm: none | **none**; 1,240 of 1,328 logged send-outs match party order | a post-KO probe decides it |
| Accuracy and evasion | runbuncalc `ai/` | rab, rlm partial | none (100-accuracy fixtures only) | later probes |
| PP | shared contract | all three | decomp values, not observed | keep |
| Speed and turn order | runbuncalc `ai/` (Quick Claw, Custap, Trick Room) | rab partial, rlm (no Quick Claw) | the AI's view of a speed tie only | later probes |
| Trainer data | runbuncalc sets | rab DB | none (decomp and documents) | keep; the divergence ledger stays |
| Encounters and catching | runbuncalc | rab, rlm partial | one wild trace | keep |
| World items and shops | runbuncalc | rab partial; **rlm invents shop locations** | none (documents) | keep rlm's shops out of every consumer |
| Learnsets, TM and tutor dates | runbuncalc | rab, rlm partial | none (decomp checked against the author's documents) | keep |
| Levelling, caps, evolution | runbuncalc | rab, rlm partial | none (documents) | keep |
| Run rules | runbuncalc `lib/run.js` | rab, rlm partial | rulings | keep |
| Planning and search | runbuncalc (plan by play, rollout search) | **rab agent** (lead-first, full-battle planner, enemy-policy search); rlm MDP unsound | battery receipts, 1,328 logged fights | keep; grade rab's planner on the same walls before choosing |

In the app today: rab supplies species, move and encounter lookups, the
matchup, the enemy moveset fill and the companion fight plan. runbuncalc
supplies the fight list, plan by play, turn advice and turn search. pykemon
supplies only the RAM map. So the companion plan and the turn advice use
different enemy-AI scoring and different switch-in rules on the same screen.

## What this changes in practice

- New mechanics land in the aspect's home. Today, for most battle mechanics,
  that is runbuncalc `ai/`. This matches where the work is done and graded,
  and it retires the "temporary duplication" line in SDLC.md.
- rab keeps the aspects where it is the home (to be confirmed from the
  matrix), and the app's matchup comes from the damage home, or is graded
  against it.
- An ungraded aspect is marked on every output that depends on it, the way
  `borrowedPlayerBuild` is marked today.

## Settled with the approval

- The rab engine is not the single engine by decree. An aspect moves to rab
  when rab's grading against the ROM beats the current home. That is the
  same rule, applied in either direction.
- ROM probe work happens in pokemon-mono (`groundtruth/pykemon`, the home of
  the evidence) on a `claude/*` or `codex/*` worktree branch, under that
  repository's AGENTS.md. The scope and order are P0 to P5 in the probe scope
  recorded with this decision (docs/PLAN.md, 3.5).
