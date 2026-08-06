# End-turn transitions and field state

Moody, Protect scoring, weather suppression, `isGrounded()`, self-volatiles,
field rooms, Berry boundaries, Fling, Cud Chew, and typed absorption and
charge-response abilities.

Part of the Run & Bun engine data rules. Index and the surrounding
architecture rules live in [`AGENTS.md`](../../AGENTS.md).

---

  Keep end-of-turn Moody transitions in `EndTurnResolution.boostsByPokemon`;
  sample the raise and drop from all seven modeled stages, including Accuracy
  and Evasion, and apply them through the normal clamped state transition.
  Protect scoring applies the documented residual/context and repeat-use rules
  to the personal protection family, including King’s Shield and modern
  personal protection variants; side guards retain their separate side-level
  protection semantics.
  Keep Cloud Nine/Air Lock weather suppression global across the active field,
  and apply Safety Goggles weather-chip immunity only while its item effect is
  active; Magic Room and Generation IV+ Klutz suppress the item.
  Reuse the shared weather-suppression predicate in accuracy, order, residual,
  and calculator-aura paths; do not reimplement local Cloud Nine checks.
  Reuse `isGrounded()` for terrain/status/hazard boundaries. Its item checks
  must honor Magic Room and Generation IV+ Klutz before treating Air Balloon or Iron Ball as
  active.
  Keep Aqua Ring and Ingrain as explicit self-volatiles with end-turn recovery;
  Ingrain also contributes grounding and must block voluntary switching at the
  transition boundary.
  Keep Magnet Rise as a timed Gen 4+ volatile and route its airborne state
  through `isGrounded()`; Gravity overrides it.
  Keep Healing Wish/Lunar Dance pending full healing on the side state until
  the next replacement entry; consume it exactly once and leave PP restoration
  to the external battle engine.
  Keep field-room transitions explicit and serializable: Generation IV+ Trick
  Room and Generation V+ Magic Room/Wonder Room each establish a five-turn
  field effect, re-use toggles that room off and clears its duration, and
  ordinary turn advancement removes expired room state. Magic Room's item
  suppression must therefore begin and end at the same field transition
  boundary.
  Keep Run & Bun confusion-inducing berry healing in the end-turn boundary;
  trigger at or below 1/4 max HP, add 1/2 max HP, and consume the item through
  the explicit resolution map.
  Keep the Generation III+ pinch-Berry boundary shared for low-HP consumption:
  Liechi/Ganlon/Salac/Petaya/Apicot raise their mapped battle stat, Lansat arms
  Focus Energy, and Starf samples one of Attack/Defense/Sp. Atk/Sp. Def/Speed
  for +2 stages. Gluttony moves the trigger to 1/2 max HP from Generation IV,
  Ripen doubles Berry stage effects, and all three paths must consume the held
  Berry, arm Cud Chew when eligible, and apply Cheek Pouch independently.
  Apply active Ripen's 2x modifier to Berry healing and Berry stat-stage
  effects in both end-turn and external Berry-eating paths; keep Berry Juice and
  Cheek Pouch outside that multiplier.
  Keep Generation III+ status-curing Berry reactions at both the status-
  application and end-turn boundaries: Cheri/Chesto/Pecha/Rawst/Aspear cure
  their matching status, while Lum cures a newly applied major status and
  modeled confusion, and Persim cures modeled confusion. All consume through
  the explicit item/provenance maps,
  add Cheek Pouch recovery when active, and use the shared
  Magic Room/Embargo/Klutz and generation-availability predicates.
  Keep Generation IV+ held Metronome attached to the consecutive-move
  calculator boundary: derive its repeat count from the prior successful
  `moveStreakByPokemon` entry, cap through canonical calculator mechanics, and
  suppress it under Magic Room, Klutz, switching, or a failed move. Explicit
  `MoveState.timesUsedWithMetronome` remains caller-authoritative.
  Keep Generation III+ Mental Herb in the volatile lifecycle: when an active
  holder receives Infatuation, Taunt, Encore, Torment, Disable, or Heal Block,
  consume the item and clear the entire six-volatile family. Use the normal
  item/provenance path and shared Magic Room/Klutz/generation suppression.
  Fling's Mental Herb and White Herb effects are direct item effects on the
  eligible target: clear the six mental volatiles or set all negative stages to
  zero without routing through secondary-effect suppression. The thrown item
  is consumed by Fling's actor, while the target's held item is untouched.
  Fling Berry handling must preserve the shared Berry-eating boundary: include
  target-directed status-Berry cures plus Kee/Maranga, Lansat, Micle, and Starf effects, while keeping
  unsupported Berry-specific effects explicit rather than silently inventing
  simulator event ordering. Unnerve suppresses an opposing target's Berry
  consumption, but does not prevent an Unnerve holder from using Fling; the
  thrown Berry remains consumed when that target-side suppression applies.
  Generation IX Cud Chew stores an eligible Berry only when its holder actually
  eats it, excludes Bug Bite/Pluck's stolen-Berry consumer path, and re-eats the
  stored Berry after its explicit two-boundary countdown. Store the Berry on a
  `cudChew` volatile, clear it on ordinary switching, pause its countdown while
  the ability is suppressed, and do not recreate held-item or Recycle/Harvest
  provenance during the delayed re-eat.
  Keep Generation IX Supreme Overlord in the calculator-facing ability
  projection. Its `PokemonState.alliesFainted` input is capped by the inherited
  calculator at five allies and must remain generation-gated; do not fold this
  damage modifier into generic move power or scoring heuristics.
  Keep Generation IX Orichalcum Pulse and Hadron Engine as permanent switch-
  entry field setters: Orichalcum Pulse establishes Sun and Hadron Engine
  establishes Electric Terrain, both with suppression and generation gates.
  Keep Generation IX Wind Rider tied to the canonical move `wind` flag: an
  opposing successful wind move grants the holder +1 Attack, while the
  calculator owns the corresponding immunity. Protect, misses, Mold Breaker,
  and pre-introduction boundaries must remain explicit.
  Keep Generation IX Wind Power tied to canonical wind metadata and Tailwind
  starts: a successful damaging wind hit or a newly established Tailwind grants
  the active holder the shared `charged` state, and the next regular Electric
  damaging move consumes it. Respect protection, misses, suppression, ability
  bypass, Tailwind refreshes, and generation gates.
  Keep Generation IX Well-Baked Body and Earth Eater tied to the resolved move
  type: Fire grants +2 Defense and Ground restores 1/4 max HP. The calculator
  owns their immunities; the AI response must honor protection, misses, ability
  bypass, suppression, and generation boundaries.
  Keep Generation IX Electromorphosis as a stateful charged response: a
  successful damaging hit grants the holder a `charged` volatile, the next
  regular Electric damaging move doubles through the calculator adapter, and
  that volatile is consumed on use and cleared on switching. Honor suppression,
  ability bypass, and generation boundaries.
  Keep Generation IX Seed Sower and Thermal Exchange as damaging-hit responses:
  Seed Sower creates five-turn Grassy Terrain (extended to eight turns by an
  active Terrain Extender), while Thermal Exchange raises Attack after a Fire hit.
  Their responses must remain generation-gated and
  respect protection, misses, suppression, and ability bypass.
  Keep Flash Fire’s activation as a persistent `flashFire` volatile rather than
  treating the ability as permanently active: a legal Fire-type hit activates
  it, the calculator adapter projects that activation into `abilityOn` for later
  Fire damage, and ordinary switching clears it. Respect Mold Breaker,
  protection, misses, suppression, and the Generation III introduction.
  Keep Generation VIII+ Gulp Missile as an explicit form-and-retaliation
  transition: Cramorant using Surf or Dive becomes Gulping above half HP or
  Gorging at or below half HP; a later damaging hit spits the catch for 1/4 of
  the attacker’s max HP, then lowers Defense or applies paralysis and restores
  base Cramorant. Reset the form on switch, skip Dynamax, preserve the
  non-suppressible ability boundary, and let Magic Guard block only the
  retaliation damage.
  Keep classic typed absorption responses explicit at the AI boundary: Water
  Absorb, Volt Absorb, and Dry Skin restore one-quarter max HP, while
  Generation IV+ Lightning Rod and Generation V+ Storm Drain raise Special
  Attack. The inherited calculator owns the immunity; the transition owns the
  healing/boost response and its Mold Breaker, protection, miss, suppression,
  and generation gates.
  Belly Drum must set HP to half max, then apply a Sitrus Berry heal and consume
  it when appropriate; its scoring must use that post-move survival boundary.
  White Herb must clear resulting negative stages after move and switch-entry
  stat changes as an explicit set-stage and item-consumption transition rather
  than leaving the item in state. Shell Smash is one covered case; its policy
  facts must calculate incoming damage against the projected post-Shell-Smash
  stages, including White Herb restoration.
