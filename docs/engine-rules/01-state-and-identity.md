# State, identity, and fact contracts

Stable IDs, authoritative `MoveState` overlays, zero-EV projection, stat-change
contracts, Substitute, the validation boundary, secondary-effect resolution, the
shared ability-bypass boundary, and replacement viability.

Part of the Run & Bun engine data rules. Index and the surrounding
architecture rules live in [`AGENTS.md`](../../AGENTS.md).

---

- Use stable Pokémon and move IDs in AI state; do not use array positions as
  identity.
- Treat explicit caller-defined `MoveState` fields as authoritative overlays;
  in particular, preserve `contact`, `heal`, `punch`, `bite`, `pulse`,
  `slicing`, and `bullet` through metadata and calculator/order/resolution
  boundaries so custom moves participate in contact-triggered abilities/items,
  Triage, and calculator modifier/immunity rules.
- Keep current HP, party membership, active slots, field effects, and move
  availability in explicit state fields.
  The Run & Bun rules remove EVs from battle calculations: AI state may retain
  an optional EV map for transport compatibility, but every AI calculator,
  order, accuracy, entry, and raw-stat projection must use an explicit zero
  EV map. The inherited `calc/` package remains EV-capable for OSS API
  compatibility.
- Treat additive stat changes and absolute stat-stage updates as separate
  transition contracts. Use absolute stage updates for copy/swap moves rather
  than encoding them as guessed deltas.
  Keep Substitute HP on `PokemonState`, never on `SideEffects`; damage must
  consume the Substitute pool before reducing real HP.
  Preserve sound-based Substitute exceptions in move resolution: Perish Song
  may apply through Substitute, but Soundproof must still block it.
  Run serialized state through `validateBattleState()` and serialized actions
  through `validateAction()` at external boundaries; do not scatter partial
  shape checks across policy modules. Invalid boundary payloads should become
  explicit client errors (HTTP 400), not accidental internal failures.
  Derived Protect belongs to the acting Pokémon, not the side; retain the
  side-level flag only as a compatibility input.
  Keep Endure distinct from `protected`: its one-turn volatile caps direct
  damage at 1 HP at the transition boundary, without granting Protect-style
  immunity. Recoil, residual damage, and healing are separate HP deltas, and
  Endure participates in the consecutive-protection failure sampler.
  Derived Helping Hand belongs to the selected ally; do not model one ally's
  Helping Hand as a side-wide attacker modifier.
  Secondary-effect resolution must apply the generation-aware attacker
  boundary: Serene Grace doubles canonical secondary chances, Sheer Force
  suppresses damaging-move secondaries, and Shield Dust/Covert Cloak block
  opposing additional effects without suppressing a holder's own self-effects.
  Sampled multi-hit arrays roll only for actual hits that reach the target;
  aggregate multi-hit facts without a hit array must derive the same count
  from direct damage after Substitute rather than assuming one hit.
  Opposing move resolution must also use the shared ability-bypass boundary:
  Mold Breaker, Teravolt, and Turboblaze suppress target abilities from
  Generation IV onward, while Mycelium Might suppresses target abilities for
  status moves from Generation IX onward. This covers status immunities,
  Sturdy/Disguise, reactive contact abilities, and Suction Cups phazing.
  Neutralizing Gas is a global Generation VIII+ suppression boundary: an
  active holder suppresses other active abilities, while Neutralizing Gas,
  canonical non-suppressible abilities, and an effective Ability Shield remain
  active. The shared ability predicate owns this check so calculator
  projections, status eligibility, ordering, residuals, and post-hit responses
  cannot disagree about whether an ability is available.
  Canonical sound flags are the source of truth for Substitute and Soundproof:
  sound moves bypass Substitute, Soundproof blocks their target effects, and
  the category-aware ability bypass is applied before that Soundproof check.
  Life Orb recoil is a separate Generation IV+ indirect-damage effect: it
  applies once after positive move damage, is suppressed by Magic Guard, and
  is also suppressed by Sheer Force only when the damaging move has a secondary.
  Status-synergy scoring may use the active partner's moves and the target's
  modeled confusion/infatuation state, but those facts must be explicit in
  `ActionFacts`; do not infer partner support from side-wide booleans.
  In Doubles, derive active ally Friend Guard, Battery, and Power Spot auras at
  the calculator boundary, excluding the Pokémon that owns the move; retain
  SideEffects fields only as compatibility inputs.
  Derive active global aura abilities and Sun-conditional Flower Gift at the
  calculator boundary with generation gates and ability suppression; retain
  explicit field booleans as compatibility inputs.
  Calculator Pokémon inputs and emitted ActionFacts must project abilities
  through the shared generation-availability map, backed by the inherited
  calculator's canonical ability tables; do not pass a known pre-introduction
  ability string into calculator stats or policy facts.
  The public evaluation boundary must normalize caller-provided ActionFacts
  through the same ability/item generation gate before scoring or deriving
  replacement viability; direct low-level scoring helpers accept already-normalized facts.
  Explicit ability suppression and `abilityOn: false` must omit the ability
  from calculator `Pokemon` and `Move` projections as well; policy-only
  suppression is insufficient because canonical immunities, damage modifiers,
  Skill Link hit counts, and Max-move selection otherwise remain active.
  Derived Foresight belongs to the affected target; do not reveal every
  Doubles partner when only one target was hit.
  `ActionFacts.priority` must come from the shared effective order boundary,
  including generation-gated Prankster, Gale Wings, Triage, and Stall effects;
  fractional item priority remains a separate order fact, and the adapter must
  not expose only the calculator's canonical move priority.
  Leech Seed belongs to the affected target; use `PokemonState.volatile` for
  derived facts and retain side-level `seeded` only for compatibility inputs.
  Replacement viability is a conservative matchup boundary: derive only
  `faster`, `notOHKOd`, and `not2HKOd` from a hypothetical legal entry and
  opposing move facts; keep full replacement scoring caller-owned, and let
  explicit caller viability values override derived values.
