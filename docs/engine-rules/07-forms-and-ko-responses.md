# Form changes, KO responses, and reflection moves

Ice Face and HP-threshold form abilities, Zero to Hero, Stance Change,
item-driven identity, KO-triggered boosts, Battle Bond, faint/contact ability
transformations, Ally Switch, Magic Coat, Magic Bounce, and Snatch.

Part of the Run & Bun engine data rules. Index and the surrounding
architecture rules live in [`AGENTS.md`](../../AGENTS.md).

---

Keep Generation VIII+ Ice Face as a stateful form boundary: an active
  Eiscue-form holder blocks the first qualifying physical hit in a sampled
  multi-hit sequence, changes to Eiscue-Noice, and lets later hits resolve;
  hail/snow restores the form at end turn when weather is not suppressed.
  Keep HP-threshold form abilities stateful at the end-turn boundary as well:
  Generation VII+ Schooling toggles level-20+ Wishiwashi above 25% HP,
  Shields Down toggles Minior at 50% HP, Generation V+ Zen Mode toggles the
  appropriate Darmanitan Zen form at 50% HP, and Generation VII+ Power
  Construct promotes Zygarde to Complete Form below 50% HP. These changes use
  `speciesOverrideByPokemon`, respect ability suppression and generation gates,
  and are applied from projected post-residual HP.
  Generation IX+ Zero to Hero keeps a persistent `zeroToHeroTriggered` marker
  after an active Palafin leaves the field; a later legal entry sets its
  temporary species override to `Palafin-Hero`. The marker survives switching,
  while the form override is rebuilt on entry and cleared by the ordinary
  switch reset boundary.
  Generation VI+ Stance Change projects Aegislash into Blade Form before
  calculator facts for damaging moves and into Shield Form for King's Shield;
  other Status moves do not change form. The same form is written to the move
  resolution so calculation and transition state stay aligned, and transformed
  or suppressed holders do not trigger it.
  Item-driven identity must use the same effective-item boundary everywhere:
  active Generation IV+ Multitype Plates project Arceus's type, and active
  Generation VII+ RKS System Memories project Silvally's type. Explicit type
  overrides win; Magic Room, Corrosive Gas, and suppressed abilities remove
  the item-driven identity for damage, grounding, redirection, and eligibility.
  Keep KO-triggered boosts tied to direct damage KOs: Generation V+ Moxie,
  Generation VIII+ Chilling Neigh/Grim Neigh and As One variants, and
  Generation VII+ Beast Boost may respond only when the attacker actually
  KOs a target. Beast Boost selects from calculator-derived raw non-HP stats;
  Endure, Substitute, Disguise, delayed damage, and generation gates must not
  create false KO boosts. Generation VII+ Soul-Heart responds once per faint
  for each eligible active holder, including allied or opposing fainted
  targets, through the same serializable boost map.
  Generation VII+ Battle Bond is the corresponding identity transition for a
  base Greninja: after a direct move KO while another opposing party member
  remains, set `Greninja-Ash` and apply the one-time +1 Attack, Special Attack,
  and Speed boost through the same resolution map. Do not trigger from
  Substitute-only damage, a miss, the last opposing Pokémon, suppression, or a
  pre-Generation-VII ability.
  Once the Ash form is active, Water Shuriken is projected as its fixed
  three-hit move before calculator facts are requested.
  Keep faint/contact ability transformations in the same resolution boundary:
  Generation VII+ Innards Out deals the holder's remaining HP to the direct
  attacker after a qualifying KO, with Magic Guard suppression. Generation
  VIII+ Perish Body starts a three-turn Perish Song on both contacted active
  Pokemon. Generation V+ Mummy, Generation VIII+ Wandering Spirit, and
  Generation IX+ Lingering Aroma change or exchange contact abilities only
  after actual direct contact damage and when both abilities are mutable;
  preserve form/identity ability exceptions
  and reset temporary ability overrides on switch.
  Keep Ally Switch as an explicit actor-scoped active-slot transition: it is
  Generation 6+ and requires a living active ally in Doubles. Swap slot order
  through the serializable resolution/transition contract, never by mutating
  party identity or the input state; reject invalid Singles, generation, and
  faint-ally requests at both boundaries.
  Keep Magic Coat as an explicit one-turn volatile rather than a generic
  Protect flag: only opposing Status moves reflect to their source, the coat
  is consumed on reflection, and damaging moves leave it intact. Apply the
  reflection before shared status/volatile/secondary handlers and preserve the
  Generation IV gate at enumeration and resolution boundaries.
  Magic Bounce is a separate Generation V+ ability boundary: use the canonical
  move `reflectable` flag, reflect eligible status moves and hazards to the
  original actor's side, and preserve semi-invulnerability, suppression, and
  Mold Breaker-style bypass behavior. Reflected status and volatile effects must
  use the Magic Bounce holder as their source for immunity and ability checks.
  Keep Snatch driven by the canonical move `snatch` flag instead of a hand-
  maintained move list. It is a Generation III-VII one-turn volatile, cannot
  steal Z/Max moves, transfers supported self effects to the Snatch user and
  team/side effects to that user's side, and must be consumed only when a
  steal actually occurs. Preserve the Generation VIII+ unselectable gate and
  allow the serializable transition boundary to validate effects on the
  Snatch recipient even when it was not the original move target.
  When multiple Snatch states are active, use modeled effective speed for the
  recipient: Generation III-IV chains through all users to the slowest, while
  later supported generations consume only the first executed Snatch.
