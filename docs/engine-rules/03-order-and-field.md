# Turn order and field durations

Run & Bun order overlays from `MECHANICS.MD`, generation-gated order abilities,
Magic Room / Klutz suppression in the order boundary, and field-duration
extension items.

Part of the Run & Bun engine data rules. Index and the surrounding
architecture rules live in [`AGENTS.md`](../../AGENTS.md).

---

  In `order.ts`, preserve the Run & Bun fork rules from `MECHANICS.MD`: a
  paralyzed Pokémon uses the 75% Speed reduction and Gale Wings always gives
  Flying moves priority, independent of current HP.
  Keep order abilities generation-gated: Gale Wings is Generation VI+,
  Triage Generation VII+, Quick Feet Generation IV+, Swift Swim/Chlorophyll
  Generation III+, Sand Rush Generation V+, and Slush Rush/Surge Surfer
  Generation VII+. Stall is Generation IV+ and Mycelium Might Generation IX+.
  Keep Magic Room and Generation IV+ Klutz suppression centralized in the order boundary:
  held-item speed and order effects must not leak through for Choice Scarf,
  Iron Ball, Lagging Tail, Full Incense, Quick Claw, or Custap Berry; Custap
  also uses the Generation IV+ Gluttony half-HP threshold and cannot activate
  for positive-priority or Generation IX Mycelium Might status moves. Preserve
  the calculator's Klutz exception for power items such as Macho Brace. Before
  Generation IV, a caller-supplied Klutz string must not suppress item effects.
  Apply the same item-effects predicate in residual processing; passive
  Leftovers, Black Sludge, Orbs, Safety Goggles, Sitrus/Oran, and berry triggers must not
  leak through Magic Room or Generation IV+ Klutz.
  Field durations must honor active extension items at the creation boundary:
  Light Clay extends Reflect/Light Screen/Aurora Veil, weather rocks extend
  move-created weather, and Terrain Extender extends move-created or Seed
  Sower-created terrain;
  repeated terrain setters fail while the same terrain is active, and repeated
  Gen III+ weather setters fail while the same weather is active; preserve the
  Gen II Rain Dance/Sunny Day refresh exception and Gen II same-Sandstorm failure.
  Ordinary weather setters also fail while the state carries unoverridable
  Harsh Sunshine, Heavy Rain, or Strong Winds; switch-entry weather abilities
  must obey the same overwrite boundary.
  suppressed, unavailable, or permanent entry effects must not gain a false
  extension.
  Treat Harsh Sunshine as Sun and Heavy Rain as Rain for weather-dependent
  abilities, recovery, Harvest, status eligibility, and order; keep strong
  weather's overwrite protection separate from those effect predicates.
