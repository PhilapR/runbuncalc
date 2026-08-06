# Reactive and stateful held items

Weakness Policy and the super-effective item family, reactive Berries, Shell
Bell, Berry Juice, type-resist Berries, Terrain Seeds, Mirror Herb, Booster
Energy, and Blunder Policy.

Part of the Run & Bun engine data rules. Index and the surrounding
architecture rules live in [`AGENTS.md`](../../AGENTS.md).

---

  Keep Generation VI+ Weakness Policy as an explicit super-effective-hit
  transition: use the caller/calculator `isSuperEffective` fact, require
  positive direct damage that leaves the holder alive and an active item effect,
  then apply the
  holder's +2 Attack/+2 Special Attack through the normal stat pipeline and
  consume the item. Contrary, Simple, and item-suppression rules remain
  stateful rather than being folded into calculator damage.
  Keep the Generation V+ / VI+ super-effective reactive item family explicit:
  Absorb Bulb and Cell Battery raise Special Attack/Attack for Water/Electric
  hits, Snowball raises Attack for Ice hits, and Luminous Moss raises Special
  Defense for Water hits. Require positive direct damage, the matching
  `isSuperEffective` and move-type facts, a holder that survives the hit, an
  active item effect, and consume the item through the normal stat/consumption
  boundary.
  Keep Generation VI Kee Berry and Maranga Berry as post-hit reactive
  transitions: a surviving holder hit by a Physical or Special move consumes
  the matching Berry and applies +1 Defense or +1 Special Defense through the
  ordinary stat-stage pipeline. Fainting, Unnerve, Magic Room, Embargo, Klutz,
  pre-Generation-VI, and item-provenance boundaries remain explicit; a
  multi-hit move may trigger the one available Berry once after a later direct
  hit breaks a Substitute.
  Keep Generation IV+ Jaboca Berry and Rowap Berry as post-hit reactive damage
  transitions: a matching Physical or Special damaging hit consumes the target
  Berry and applies 1/8 of the holder's max HP as indirect damage to the active
  attacker (1/4 with Ripen). Unnerve, Magic Room, Embargo, Klutz, generation,
  Magic Guard, and item-provenance boundaries remain explicit; a multi-hit move
  triggers the one available Berry once after a later direct hit breaks a
  Substitute.
  Keep Generation IV+ Sticky Barb in the shared item lifecycle: it deals
  one-eighth max-HP residual damage unless Magic Guard or item suppression
  applies, and a successful contact hit may transfer it to an attacker with
  no item. Require `canRemoveHeldItem()` so Sticky Hold blocks the transfer;
  Substitute-only and non-contact hits must leave both item slots unchanged.
  Keep Generation III+ Shell Bell at the post-move boundary: heal one-eighth
  of aggregate direct HP damage after a successful move, including spread and
  multi-hit damage. Do not count Substitute-only damage, and suppress the
  heal for Heal Block, Magic Room, Klutz, forced-switch, or fainted-actor
  paths. Keep this as an additive HP delta so the transition clamps at max HP.
  Keep Generation II+ Berry Juice as a distinct consumable, not a Berry:
  restore 20 HP when direct or modeled indirect move damage leaves a living
  holder at or below half HP, then record consumption. Respect Magic Room,
  Klutz, and generation gates; also cover the end-turn threshold. The current
  move resolution collapses multi-hit activation to the move boundary, so do
  not claim per-hit Berry Juice timing until the sequence model supports it.
  Keep Generation IV+ type-resist Berries explicit: Occa, Passho, Wacan,
  Rindo, Yache, Chople, Kebia, Shuca, Coba, Payapa, Tanga, Charti, Kasib,
  Haban, Colbur, Babiri, Roseli, and Chilan each halve one matching
  super-effective single-hit damage result, require positive direct damage and
  an active item effect, do not activate while all sampled hits are absorbed by
  a Substitute, and consume the Berry with explicit provenance. Unnerve, Magic
  Room, Embargo, Klutz, generation gates, and multi-hit aggregate-damage
  ownership remain explicit.
  Terrain Seeds are stateful entry/field transitions: Generation VII+ Electric,
  Grassy, Misty, and Psychic Seeds activate for the matching active Terrain,
  including terrain established by a move or by switch-entry Surge, apply the
  matching defensive stage through the normal stat pipeline, and consume the
  held item. Existing terrain must also activate a seed on switch entry.
Keep Generation VIII+ Throat Spray as a sound-move item transition: use
canonical sound metadata, require an active unsuppressed held item and a
successful move resolution, apply +1 Special Attack through the normal stat
pipeline, and record explicit consumption. Non-sound, pre-Generation-VIII,
Magic Room, Embargo, and Klutz cases must not trigger it.
Keep Generation IX+ Mirror Herb as an opposing-stat transition: when an
opposing active Pokémon receives a real positive stat-stage change during a
move resolution, copy the positive stages to each eligible active holder once
and consume the item. Do not copy a holder's own stages, do not activate from
negative or clamped-to-zero changes, and keep Magic Room, Embargo, Klutz,
generation, and benched-Pokémon boundaries explicit. Active passive responses
may write item, consumption, and boost maps for any live active slot; they may
not write transition state for benched Pokémon.
Keep Generation IX Opportunist as a post-boost opposing-stat response: an
active, unsuppressed holder copies positive stage deltas made by opposing
active Pokémon after the move resolution. Snapshot the original boost map so
Opportunist copies do not chain from one another or from Mirror Herb, and keep
suppression, generation, clamping, and active-holder boundaries explicit.
Keep Generation IX Poison Puppeteer as a Pecharunt-only status response: when
its active, unsuppressed holder successfully inflicts poison or toxic through a
move, apply the ordinary confusion volatile to the poisoned target. Preserve
status immunity, volatile eligibility, ability-bypass, species, suppression,
and generation boundaries.
Keep Generation IX Booster Energy stateful for Protosynthesis and Quark Drive:
when the ability is active without its natural Sun/Electric Terrain trigger,
consume an unsuppressed Booster Energy on switch entry or after a modeled field
change, persist the corresponding volatile through the next actions, and clear
it on switch. Calculator and order projections must treat that volatile as the
already-activated Booster Energy effect even though the held-item slot is empty;
Magic Room, pre-Generation-IX abilities/items, and suppressed abilities must
not activate it.
Keep Generation VIII+ Blunder Policy as an accuracy-miss transition: when an
eligible move actually misses an accuracy check, apply +2 Speed through the
normal stat pipeline and consume the unsuppressed held item. Generic action
failure, immunity, protection, status failure, pre-Generation-VIII, Magic Room,
Embargo, and Klutz boundaries must not trigger it. A spread move may trigger it
from one missed target even when another target is hit, and the failed-move
transition must preserve only explicit actor self-state changes.
