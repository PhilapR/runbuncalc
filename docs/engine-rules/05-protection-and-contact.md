# Protection, redirection, and contact responses

Doubles redirection, side-level guards, user-only protection consequences,
contact-triggered abilities and items, damage-triggered responses, and
survival effects (Sturdy, Focus Sash, Focus Band, Air Balloon).

Part of the Run & Bun engine data rules. Index and the surrounding
architecture rules live in [`AGENTS.md`](../../AGENTS.md).

---

  Keep Doubles redirection state explicit: Follow Me, Rage Powder, and
  Spotlight last one turn, redirect only single-target opposing moves, and
  leave spread-target actions unchanged. Preserve the generation, Singles,
  and Rage Powder immunity/ignore gates at action enumeration and resolution
  boundaries.
  Keep Wide Guard, Quick Guard, and Mat Block as side-level one-turn
  protections, not ordinary Protect volatiles: Wide Guard checks the move's
  canonical multi-target class, Quick Guard checks effective opposing priority,
  and Mat Block checks damaging moves plus the user's first-turn-out state.
  Preserve their generation gates, Feint removal of both personal and side
  protection, and turn-boundary expiry at
  both action enumeration and resolution boundaries.
  User-only protection moves must retain their identity for blocked contact
  effects: King's Shield lowers Attack, Baneful Bunker poisons, Spiky Shield
  deals one-eighth max HP, Silk Trap lowers Speed, Obstruct lowers Defense by
  two stages, and Burning Bulwark burns. Wide Guard, Quick Guard, and Mat Block
  do not receive these user-only contact consequences. Generation VIII+ Unseen
  Fist bypasses contact protection, including side guards, except Max Guard;
  keep the contact and ability-active checks at resolution time.
  Contact consequences must remain target-aware and serializable: Generation
  III+ Rough Skin, Generation V+ Iron Barbs, Generation V+ Rocky Helmet, and
  Generation IV+ Aftermath damage the active attacker only when the move makes
  contact and is not stopped by Substitute or immunity. For sampled multi-hit
  damage, count each contact hit that reaches the Pokémon, stop at a KO, and
  let later hits begin triggering contact damage after a Substitute breaks.
  Respect Magic Guard, Long Reach, Protective Pads, Punching Glove, Endure,
  item suppression, and the generation gates before adding those HP deltas.
  Keep contact-triggered status/stat effects in the same resolution boundary:
  Generation III+ Static, Flame Body, and Poison Point use their 30% status
  checks; Generation IV+ Poison Touch poisons on contact; Generation VI+
  Gooey and Generation VII+ Tangling Hair lower Speed. For sampled multi-hit
  moves, repeat eligible contact attempts after a Substitute breaks until the
  status/volatile applies or the sequence ends. Generation V+ Cursed Body
  samples its disabling chance for each damaging hit until it succeeds or the
  move ends. Generation III+
  Synchronize reflects opposing burn, poison, and paralysis. Route all status and
  boost results through existing immunity, suppression, and volatile helpers.
  Damage-triggered responses must also remain target-scoped and facts-aware:
  Generation V+ Weak Armor changes Defense/Speed on each physical hit, Generation
  VII+ Stamina and Berserk respond to damage/HP thresholds, and typed response
  abilities (Motor Drive, Steam Engine, Sap Sipper, Justified, Water
  Compaction, and Rattled) use the resolved move type. Generation IX Toxic
  Debris adds at most two Toxic Spikes to the holder's side, repeating after
  each actual direct physical hit until the cap. Preserve generation gates and
  route all stat/hazard changes through the existing serializable resolution
  helpers. Berserk's threshold response is evaluated after the complete move;
  single-hit secondary suppression by Sheer Force blocks it, while an aggregate
  multi-hit sequence remains eligible. Electromorphosis, Wind Power, and Seed
  Sower require actual direct HP damage, so Substitute-only damage cannot
  activate them.
  Generation IX Anger Shell is a post-move threshold response: when a living
  holder crosses from above half HP to at-or-below half HP, apply +1 Attack,
  +1 Special Attack, +1 Speed, -1 Defense, and -1 Special Defense through the
  ordinary stat-stage pipeline. Multi-hit moves evaluate aggregate direct
  damage once after the sequence; Substitute, KO, single-hit Sheer Force
  secondary suppression, generation, and ability-bypass boundaries remain
  explicit; a hit that breaks a Substitute uses only the direct HP damage that
  gets through, and threshold responses use their own one-time boundary.
  Generation IV+ Anger Point is a critical-hit response: an eligible living
  holder that is hit by an actual critical move receives +12 Attack through the
  normal clamped stat-stage pipeline. A critical hit may be supplied explicitly
  as `ActionFacts.criticalHit`, while guaranteed criticals project the same fact;
  Substitute, KO, ability bypass, and pre-introduction boundaries remain
  explicit.
  Generation VIII Cotton Down is a post-damage active-field response: when its
  holder is hit for positive damage, lower every other living active Pokémon's
  Speed by one through the normal stat-stage pipeline. The holder itself,
  fainted actives, status/no-damage moves, Mold Breaker-family suppression,
  generation, and the distinction between aggregate caller-owned facts and
  sampled per-hit resolution remain explicit. Cotton Down repeats for each
  actual damaging hit in sampled multi-hit arrays.
  Emergency Exit and Wimp Out are Generation VII+ threshold responses: when a
  living active holder crosses from above half HP to at-or-below half HP from
  real damage, including an Endure/Sturdy/Focus Sash one-HP result, enqueue a
  required replacement only if a legal replacement exists. Sampled multi-hit
  damage follows the sequence through a Substitute before testing the threshold;
  aggregate caller-owned damage follows the same direct-HP boundary.
  Substitute, KO, already-low HP, Mold Breaker-family suppression, trapping,
  Fairy Lock, generation, and no-replacement boundaries remain explicit;
  residual crossing uses the same pending forced-switch queue.
  Keep Generation V+ Sturdy at both calculator-facts and move-resolution
  boundaries: a full-HP target survives the first direct hit that would itself
  KO at 1 HP, while a nonfatal first direct hit does not arm Sturdy for a later
  hit in the same move. Sampled hits spent breaking a Substitute do not consume
  Sturdy; later direct hits continue against that HP. Pre-Generation-V behavior
  retains its distinct rules, and Sturdy must not create a false KO response.
  Keep Generation IV+ Focus Sash at the same two boundaries: an unsuppressed,
  full-HP holder survives the first direct hit that would itself KO at 1 HP and
  consumes the item; a nonfatal first direct hit does not activate it for a
  later hit in the same move. Sampled hits spent breaking a Substitute do not
  consume it, and later direct hits continue normally. Non-full-HP and Magic
  Room/Embargo/Corrosive Gas cases retain their ordinary damage behavior.
  Keep Generation II+ Focus Band as a sampled, non-consuming survival effect:
  on a fatal direct move hit, a successful 10% roll caps the first fatal hit at
  1 HP. Walk sampled multi-hit damage through Substitute before selecting the
  fatal hit; misses, nonfatal damage, pre-Generation-II states, and suppressed
  item effects do not trigger it.
  Keep Generation V+ Air Balloon as a direct-hit lifecycle: a successful
  damaging move bursts an active Balloon even when direct damage is zero, but
  Substitute-only damage does not. Walk sampled multi-hit arrays through the
  Substitute boundary so a later direct hit can burst it; generation and the
  shared Magic Room/Embargo/Klutz/corrosion item-suppression predicate remain
  authoritative.
