# Held-item changes, consumption, and provenance

`itemByPokemon` vs. `consumedItemByPokemon`, Recycle eligibility, the shared
Berry-eat transition, Heal Block’s recovery-only suppression, theft effects,
Enigma Berry, and Corrosive Gas.

Part of the Run & Bun engine data rules. Index and the surrounding
architecture rules live in [`AGENTS.md`](../../AGENTS.md).

---

  Keep held-item changes explicit through `MoveResolution.itemByPokemon`, and
  record true consumption separately through `consumedItemByPokemon` so
  Knock Off/Trick removal cannot accidentally feed Harvest. Preserve the
  consumed-item provenance only through the current active lifecycle; ordinary
  switch reset clears `lastConsumedItem`, and never reconstruct an item from
  the original party data.
  Recycle may restore only `lastConsumedItem`; do not make forcibly removed or
  stolen items recyclable by inferring from an empty item slot.
  Stuff Cheeks must consume only a held Berry, apply its Defense boost through
  the normal stat transition, and retain its Magic Room exception; Embargo
  still prevents the move from using the Berry.
  Apply Cheek Pouch only to the active consuming holder, not to the Pokémon
  whose Berry was stolen by Bug Bite/Pluck.
  Bug Bite/Pluck and Teatime must call the shared Berry-eat transition after
  consumption: the consumer receives modeled Berry healing, stat, status, and
  volatile effects, while the Bug Bite/Pluck path explicitly excludes Cud
  Chew capture because the Berry was stolen rather than eaten normally.
  Heal Block suppresses only the recovery portion of that boundary, including
  Cheek Pouch and Cud Chew's replayed healing; it must not prevent Berry
  consumption, stat boosts, status cures, volatile setup, or Cud Chew capture.
   Reactive item transitions must remain explicit: Incinerate destruction is
   not recyclable, Magician requires positive damage, and Pickpocket requires
   contact and an empty target item slot. Preserve Sticky Hold and Substitute
   boundaries before recording any transfer; sampled multi-hit arrays may reach
   the item boundary on a later hit after a Substitute breaks.
   Enigma Berry is a post-hit reactive Berry: require a surviving direct,
   super-effective hit and an active holder below full HP, then apply its
   quarter-HP recovery, Ripen multiplier, Cheek Pouch, and explicit consumption.
   Heal Block, Unnerve, item suppression, Substitute-only damage, fainting, and
   prior consumption must block it.
  Corrosive Gas is a persistent item-effect suppression transition, not an
  ordinary item removal: retain the held-item name, block it behind Substitute
  or Sticky Hold, and do not set consumed-item provenance.
  Sticky Hold protects items only from Generation III onward.
