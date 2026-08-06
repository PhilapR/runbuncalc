# Item availability and end-turn residuals

The shared item-effects predicate, `ITEM_MIN_GENERATION`, end-of-turn ability
residuals, pinch and status Berries, generation-specific status damage, and
modeled volatile constraints on enumeration.

Part of the Run & Bun engine data rules. Index and the surrounding
architecture rules live in [`AGENTS.md`](../../AGENTS.md).

---

  The shared item-effects predicate must also reject pre-introduction
  known held items before any caller derives calculator, entry, order, or
  residual effects. `isItemAvailable()` first honors explicit Run & Bun
  boundaries and then consults the inherited calculator's canonical item
  tables, so uncatalogued canonical items such as Oran Berry do not silently
  become available in older generations; unknown custom items remain available.
  Keep `ITEM_MIN_GENERATION` synchronized for every modeled overlay item; it includes common Gen II Leftovers/Quick Claw, Gen IV Choice items and
  stat modifiers, Gen V–VII defensive items, and the Gen VIII–IX item additions.
  Keep end-of-turn ability residuals explicit and generation-gated: Speed
  Boost raises Speed by one stage from Generation III onward, while
  Generation IV+ Bad Dreams deals one-eighth max HP to each opposing active
  sleeping target. Suppressed abilities and Magic Guard must prevent their
  respective effects.
  Low-HP stat berries are a separate residual trigger: Liechi, Ganlon, Salac,
  Petaya, and Apicot are Generation III+; they consume at or below one-quarter
  max HP, or one-half max HP with Generation IV+ Gluttony, and raise Attack,
  Defense, Speed, Special Attack, or Special Defense respectively. Their stage
  changes use the same Simple/Contrary normalization and clamping boundary as
  other modeled stat changes, and Cheek Pouch applies to their consumption.
  Micle Berry is a Generation IV+ residual accuracy boundary: at the same
  low-HP trigger as other held berries (one-half with Gluttony, otherwise one-
  quarter), consume the Berry and arm a two-turn `micleBerry` volatile. The
  next non-OHKO move accuracy check receives the canonical 4915/4096 boost,
  then consumes that volatile; Magic Room, switching, and unavailable items
  prevent activation.
  Keep Generation III+ status-curing held Berries explicit at both status
  application and end-turn boundaries: Cheri/Chesto/Pecha/Rawst/Aspear cure
  their matching status, while Lum cures any major status and confusion. They
  consume through the normal item/provenance path and obey Magic Room, Embargo,
  Klutz, generation, and Cud Chew boundaries.
  Residual status damage must preserve generation-specific burn rates: burn is
  one-sixteenth in Generation I and VII onward, one-eighth in Generations II–VI,
  and Generation IV+ Heatproof halves the resulting burn damage. Ordinary
  poison remains one-sixteenth only in Generation I and one-eighth thereafter.
  Poison Heal is generation-gated to Generation IV+; Moody is generation-gated
  to Generation V+ and must respect suppression when selecting its random stat
  changes.
  Preserve weather history at the residual boundary: Sandstorm is unavailable
  in Generation I and deals 1/8 in Generation II, then 1/16 from Generation III;
  Hail is unavailable before Generation III; Overcoat suppresses weather damage
  only from Generation V; and Rain Dish is active from Generation III.
  Cloud Nine and Air Lock are Generation III+ global weather suppressors;
  pre-introduction ability strings must not suppress weather. Disguise is
  Generation VII+, and Stalwart/Propeller Tail are Generation VIII+ targeting
  bypasses.
  Keep stateful residuals generation-gated as well: Nightmare is Gen II–VII,
  Curse is Gen II+, and Salt Cure is Gen IX+.
  Magic Guard is a Generation IV+ suppression rule; do not let a caller-supplied
  pre-Gen-IV ability string suppress indirect damage in residual or move paths.
  Rock Head is likewise Generation III+; recoil prevention must use the shared
  ability-availability boundary before honoring a caller-supplied ability string.
  Keep the explicit generation map synchronized with Run & Bun ability
  overlays; canonical inherited abilities are resolved from calculator data,
  while unknown custom names remain available.
  Keep `itemLost` explicit: Unburden activates only after a held item is lost,
  not merely when a Pokémon starts without an item, and the flag resets on
  switch.
  Keep Corrosive Gas separate from `itemLost`: `itemCorroded` means the named
  held item remains present but its ordinary effects are unusable, and it
  persists through switching. Route all ordinary held-item consumers through
  `isItemEffectActive()` so this state cannot leak into policy or calculator
  facts.
  Generation VI+ Assault Vest must reject Status-category moves at both action
  enumeration and direct resolution while its item effect is active; Magic Room,
  Embargo, Klutz, and pre-Generation-VI states restore ordinary status-move
  legality.
  Keep modeled volatile constraints authoritative in `enumerateMoveActions()`;
  a move that is blocked by Taunt, Encore, Imprison, Disable, or Torment must
  not be accepted by the transition boundary.
