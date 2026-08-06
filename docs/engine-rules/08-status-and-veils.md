# Status eligibility and ally veils

`canApplyVolatile()` / `canApplyMajorStatus()` as the shared predicates, sampled
sleep and Toxic counters, status scoring, the Doubles veil auras, and Run & Bun
non-gendered Infatuation.

Part of the Run & Bun engine data rules. Index and the surrounding
architecture rules live in [`AGENTS.md`](../../AGENTS.md).

---

  Keep Aroma Veil and Soundproof checks in `canApplyVolatile()` so mental-move
  and Perish Song immunity is shared by policy and resolution.
  Route common status immunity through `canApplyMajorStatus()` so Safeguard and
  grounded Terrain rules are not duplicated in individual move handlers.
  Keep its ability checks generation-aware: pre-introduction Levitate must not
  change grounding, and pre-introduction status immunities such as Insomnia,
  Limber, or Good as Gold must not block older-generation statuses.
  Any resolution that applies sleep must set its sampled `statusTurns`; any
  resolution that applies Toxic must initialize `toxicCounter` to one before
  residual progression.
  Status scoring must use that same predicate; do not score a known blocked
  status move as if its effect will resolve.
  In Doubles, active unsuppressed Sweet Veil blocks opposing sleep and Yawn
  from affecting its living ally, while active unsuppressed Aroma Veil blocks
  the modeled Attract, Taunt, Encore, Disable, Torment, and Heal Block effects
  on its living ally. Preserve the Generation VI gates and do not let target
  ability bypass incorrectly suppress an ally's protective aura.
  In Doubles, active unsuppressed Pastel Veil likewise blocks opposing Poison
  and Toxic on living allies, with its Generation VIII gate and suppression
  boundary applied through the same status predicate. Its switch-entry event
  also cures Poison/Toxic and clears the Toxic counter from the holder and
  living active allies.
  Flower Veil is a Generation VI+ Doubles ally aura for living Grass-type
  targets: it blocks move-applied major status/Yawn and negative stat stages,
  including entry Intimidate/Sticky Web drops, while leaving positive stages,
  non-Grass allies, and the holder's own drops unaffected.
  Run & Bun Infatuation is not gender-gated: Attract and Cute Charm may apply
  the volatile to same-gender and genderless targets, subject to the ordinary
  volatile-immunity and ability-bypass boundaries.
  Status-policy no-op checks must also use generation-aware active abilities;
  pre-introduction Battle Armor/Shell Armor must not block Focus Energy or
  Laser Focus before their Generation III availability.
