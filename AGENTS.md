# Repository Guidelines

## Scope

This repository is a Run & Bun-focused fork of the open-source Pokémon damage
calculator. The project has three important boundaries:

- `calc/` is the reusable damage-calculation library.
- `src/` is the browser UI and Run & Bun orchestration layer.
- `ai/` is the Run & Bun decision-policy layer.

Keep Run & Bun policy code out of `calc/src/mechanics/`. The calculator should
answer what happens when an action is taken; the AI should decide which action
to take.

## Architecture rules

- Treat `calc.calculate()` as a read-only calculation oracle. It clones its
  inputs and returns a `Result`; it does not advance battle state.
- Keep AI state serializable and independent of calculator class instances.
  Convert `ai/` state into `Pokemon`, `Move`, and `Field` objects at the
  adapter boundary, then convert `Result` into simple decision facts.
- Keep Run & Bun-specific scoring, switching, target selection, and turn-state
  transitions in `ai/`.
- Prefer small, named rule modules over a single large move-scoring function.
- Do not parse human-facing strings such as `Result.kochance()` to drive
  decisions. Derive machine-readable facts from damage rolls and state.
- Preserve the existing public calculator API unless a generic calculator
  capability is genuinely missing.
- Keep fork-specific calculator mechanics explicit and regression-tested. The
  current critical-hit overlay includes Magma Armor alongside Battle Armor and
  Shell Armor; keep that rule in the generation damage paths, not in AI policy.
  Soul Dew is another fork overlay: apply its +1 SpA/+1 SpD effect to Latias
  and Latios as clamped stat stages in the calculator boundary, rather than as
  a second direct damage modifier.
  Apply the fork's 1.5× critical-hit damage multiplier consistently across the
  supported generation paths.

## Source and generated files

- Edit TypeScript under `calc/src/` and AI source under `ai/`.
- Edit UI source under `src/`.
- `dist/` is generated output. Do not hand-edit it; regenerate it with the
  repository build process when dependencies are installed.
- Treat the Run & Bun documentation in the parent workspace as source material,
  not as executable code. A mechanic or move change is not implemented until
  it has corresponding code and tests.

## Changing what something costs

Performance work is not one kind of change. The bar differs for each kind.
Decide which kind you make before you make it. Name that kind in the commit.

1. **Waste** — the output is provably identical. One example: the code builds
   an object, reads one immutable field, and discards it. Bar: show that the
   work count fell and that the result did not.
2. **A cache behind an assumption** — the output stays identical only while
   something stays true. Bar: probe the dependency to establish that
   assumption, and do not conclude from a reading of the code. Gate the probe
   apart from the thing it enables, so the cache cannot outlive its premise.
   `tests/adjudication_cost.test.js` pins what moves `stats.spe`, which is
   what makes the speed cache in `ai/src/order.ts` safe across a battle.
3. **A behaviour change** — the output differs. This is not performance work,
   even when it is faster, and it must not travel as performance work. Bar: a
   ledger finding, evidence that the new answer is better, and the usual
   falsification. The ranker now plays four different sixes; it also costs 54%
   less, but that is a side effect and not the argument for it.
4. **A contract change** — it removes something that the design promises. Bar:
   Philip decides. No consumer reads a value today, and that fact alone does
   not make the value dead. `planner.js` says that both crit bands travel with
   a cell, "so no consumer has to re-derive them from an average". That
   sentence states what a cell is.

Measure work, not time. This repository shares a runner with every other build
on the machine. A millisecond assertion then measures load as often as it
measures the product. Three timing gates flaked that way in one session, at
load averages between 17 and 139. Count objects, calls, or rollouts instead. A
count is exact, and it moves only when behaviour moves.

Record a cost next to the contract that causes it. Give the measured price of
each deliberate design choice. A reader cannot weigh a cost that nobody wrote
down. The next person meets that cost in a profiler, not in the design.

## A deviation from the mainline games is not a bug

This is a hack, and a hack IS its deviations. Before treating behaviour that
differs from the mainline games as a defect, check all three:

1. `profiles/run-and-bun/index.js` — the `mechanics` block states the rule
   deltas, and `provenance` says how well each is sourced. `source-of-truth`
   is the highest tier the profile has.
2. `docs/AI_DATA_MODEL.md` — describes what the engine models and why,
   including where it departs from stock Generation 8 on purpose.
3. `DECISIONS.json` — standing rulings. Several were opened as suspected bugs
   and closed by an audit *without changing code*; `enforcedBy` on each ruling
   names the files that hold it up.

`tests/runbun_mechanics.test.js` asks the engine and compares it against the
profile for every flag it can drive, and requires each declared mechanic to be
either driven there or listed with a reason. If it fails naming a flag, the
declaration and the implementation have come apart — decide which is wrong
rather than changing whichever is easier to reach.

A test asserting behaviour that looks wrong is not automatically a bug locked
in by omission. Read what it cites before flipping it. Gender-independent
Attract was "fixed" this way once, against four separate records saying it was
the rule, and reverted in `dedb4d0`.

## Build and validation

- Run `npm install` at the repository root; the root `postinstall` provisions
  both `calc/` and `ai/` through `subpkg`.
- Run `npm test` for the full calculator, AI, build, and supported UI lint gate.
  `dist/` is regenerated by that command and must not be hand-edited.
- Keep the root `lint`, `compile`, `build`, and `test` scripts explicitly
  calculator-first, then AI. The AI package consumes the local `calc/` junction,
  so this ordering keeps its compiled dependency boundary stable.
- The AI package test command compiles `ai/src/test/*.ts` and discovers every
  compiled `dist/test/*.test.js` fixture automatically; adding a fixture does
  not require maintaining a second hand-written command list.
- Any fixture that exercises a probabilistic action gate must pass an explicit
  deterministic sampler. For example, a paralyzed actor needs a roll above
  the paralysis-failure threshold when the fixture is testing a later effect.
- The legacy `shared_controls.js` script is now included in the root lint gate.
  Its Ctrl-key behavior supports append-vs-swap dragging; there is no separate
  multi-row selection model.
- `src/js/data/sets/gen8.js` is authored Run & Bun trainer data, not generated
  output. Never regenerate it from an upstream set source: the removed `import/`
  generator did exactly that and destroyed the trainer parties.
  `runbun_sets.test.js` runs in the root gate — see `docs/TASKS.md`.

## Data rules

- **Ask the game before reading its source.** Every fact about Run & Bun —
  encounters, unlock order, learnsets, evolutions, catch rates, trainer teams
  — is behind the profile oracle, and `node scripts/ask.js` answers the common
  questions directly. `docs/DATA-ACCESS.md` documents the full API, including
  the return shapes that mislead: `levelUpMoves` gives `[level, move]` PAIRS
  (an object-style `.filter(m => m.level <= 5)` silently returns nothing),
  `encountersOn` wraps its list under `.mons`, and `availabilityOf` returning
  `null` means UNDATED, never closed. Re-deriving these by grep is how the
  same mistakes get made twice.
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
- Keep action selection separate from state mutation. A chooser returns an
  action; `ai/src/transition.ts` applies only explicit switch/turn transitions
  or caller-supplied `MoveResolution` outcomes. Common deterministic
  volatile/timed effects may be derived by `deriveMoveResolution()`; canonical
  move metadata plus the Run & Bun overlay provide default accuracy and
  probabilistic secondaries, while explicit move-state metadata remains
   authoritative. Unmodeled accuracy interactions, residual ordering, and unsupported move
  metadata belong in the engine that produces those outcomes. Common Protect
  calculator-confirmed damage-immunity, common status-immunity, and secondary
  blocker filtering are part of the move engine. Use
  `advanceTurn()` for the modeled end-turn residual slice before applying
  external simulator events. Use `orderActions()` to establish priority/speed
  order; do not silently infer probabilistic or uncommon ability/item effects.
  Recoil and drain fractions in `deriveMoveResolution()` must come from the
  generation-aware calculator move data first; retain local tables only as a
  fallback for caller-defined custom moves that have no canonical entry.
  Action enumeration must reject canonical moves introduced after the active
  generation using the inherited move table; unknown caller-defined move names
  remain available for custom Run & Bun data. Direct resolution remains a
  caller-owned compatibility boundary and may resolve an explicit move intent.
  Calculator-facing move lists and Metronome, Sleep Talk, Assist, Copycat,
  Me First, and Instruct candidate pools must apply the same availability
  filter before projecting or selecting a move.
  Drain resolution must remain target-aware: Generation III+ Liquid Ooze
  converts eligible draining recovery into indirect damage, Big Root raises
  the affected recovery amount by 30% from Generation IV onward, and
  Strength Sap and Leech Seed use the same boundary. Preserve the pre-Gen V
  Dream Eater exception and Magic Guard suppression of Liquid Ooze damage.
  Crash-damage moves must likewise use canonical calculator metadata; apply
  generation-specific miss consequences at the move-resolution boundary and
  keep Gen 3-4 Ghost immunity explicit.
  `deriveMoveResolution()` owns the explicit turn-local action gate for modeled
  Truant, flinch, paralysis, sleep, freeze, confusion, infatuation, and consecutive-protection
  outcomes. Keep that gate at
  resolution time so the chooser does not fabricate random simulator state;
  failed actions still record their move intent, while only explicit cleanup
  is applied. Confusion self-hit is the one modeled failure consequence: when
  calculator-backed `ActionFacts.confusionDamage` is supplied, resolution
  samples it and applies the resulting HP loss to the actor through
  `hpDeltaByPokemon`; caller-supplied facts remain optional for compatibility.
  Truant is a deterministic alternating gate from Generation III onward: a
  successful attempted action arms `PokemonState.volatile.truant`, the next
  attempted action records `actionFailure: 'truant'` and clears it, and
  suppressed or pre-introduction Truant remains inactive.
  Slow Start is a Generation IV+ five-turn entry volatile; use the shared timer
  for both order Speed and calculator damage projection, and clear it through
  ordinary switch reset.
  Target-ID collections in delayed moves and move-history state must be unique
  and party-backed before they cross the validation boundary.
  `firstTurnOutIds` must contain unique active IDs, and switching must clear
  both outgoing and incoming active Pokémon's consecutive-move streak state.
  First-turn-only Fake Out and First Impression must use the same
  `firstTurnOutIds` boundary at action enumeration and direct move resolution;
  their generation gates remain explicit, and switching creates the new
  replacement's first-turn window.
  Current-appearance move history, selected intents, and Choice locks must
  likewise reference active IDs; switching is the lifecycle boundary that
  removes those records for outgoing and incoming slots.
  Confusion applications must carry their sampled 2–5-turn duration so the
  existing volatile decrement boundary can expire them.
  Preserve independent calculator hit distributions in `DamageFacts.hitRolls`
  for split-hit effects such as Parental Bond; route them through the existing
  sequential damage/barrier/secondary pipeline and do not treat spread moves as
  Parental Bond splits.
  Generation III+ Early Bird must shorten active sleep countdowns by two turns
  per boundary, while suppressed abilities and pre-Generation-III states use
  the ordinary one-turn decrement. Keep benched sleep and switch re-entry
  semantics unchanged.
  Future Sight and Doom Desire are delayed-damage transitions: keep their
  sampled damage in `BattleState.delayedMoves` and resolve it through the
  end-turn boundary rather than applying it as immediate move damage. Keep
  delayed move damage distinct from residual HP deltas so it consumes a
  current Substitute before changing HP.
  Delayed healing uses the same serializable boundary: every healing entry
  must reference a scheduled target and carry a positive integer numerator and
  denominator.
  Destiny Bond is consumed at the transition boundary only when a direct
  damaging action actually KOs its holder; do not trigger it from Substitute
  damage, a miss, or a non-KO damage roll.
  Keep Counter, Mirror Coat, and Metal Burst on explicit transition damage
  history: record positive direct damage after Endure, exclude Substitute and
  residual damage, retain the source/category/turn for the immediate next
  turn, and clear the record on switch or expiry. Counter and Mirror Coat
  require matching Physical/Special damage and return 2×; Metal Burst accepts
  either category and returns 1.5×. Do not route these fixed-damage responses
  through ordinary calculator base-power damage.
  Focus Punch is a Generation III+ interruption move: fail its resolution when
  the actor's current-turn damage history records a positive direct hit, while
  damage carried from the prior turn does not interrupt it. Keep this check in
  the move engine, not in scoring or calculator base-power logic.
  Bide must remain an explicit locked volatile with remaining turns, accumulated
  direct HP damage, and the latest attacking source. Exclude Substitute damage
  but continue accumulating later sampled hits after a Substitute breaks;
  release for 2× stored damage on the final Bide action, and clear the volatile
  when it releases or stores no damage; preserve the Generation I/II duration
  differences at the move-engine boundary.
  Rollout and Ice Ball use a shared explicit consecutive-move volatile with the
  move name, hit count, and timer. Apply the 2× per-hit base-power escalation
  through the calculator adapter, lock action enumeration to that move, and
  clear it on a miss, switch, or fifth hit.
  Outrage, Thrash, and Petal Dance use a separate rampage volatile with the
  move name and remaining 2–3-turn duration. Lock action enumeration to that
  move and apply confusion only when the final locked action ends; switching
  clears the lock through the ordinary volatile reset.
  Recharge moves use a `recharge` volatile carrying the canonical move name.
  Expose a no-target forced recharge action, consume it without PP or damage,
  and preserve switching as an alternative; do not fake the recharge as a
  second use of the damaging move.
  Canonical two-turn damaging moves use a `charge` volatile carrying the move
  name, locked target IDs, and a timer. The initial action must not call the
  calculator for damage; enumerate only the locked release action on the next
  turn. Power Herb and Sunny-weather Solar Beam/Solar Blade shortcuts belong
  in the move engine, and switching clears the charge state.
  Uproar uses its own 2–5-turn `uproar` volatile, locks action enumeration to
  Uproar, wakes active sleepers when it begins, and blocks new sleep status
  application while any active Pokémon is making the uproar.
  Semi-invulnerable charge moves must be reflected at both boundaries: score
  ordinary incoming damage as zero and exclude those targets in move-engine
  eligibility, while preserving canonical Gust/Twister/Thunder/Hurricane and
  related bypass moves.
  Lock-On and Mind Reader use a target-scoped `lockOn` volatile. Expose the
  sure-hit result through both `ActionFacts` and `getEffectiveMoveAccuracy`,
  consume it on the next attempted move, and validate that its target ID is in
  the current party graph. Resolve accuracy independently for each target of a
  spread action so a locked target does not make its other targets sure-hit.
  Damaging partial-trap moves use a separate `partiallyTrapped` volatile with
  source ID, move name, timer, and generation-aware residual damage. Keep it
  distinct from permanent Mean Look/No Retreat trapping; block voluntary
  switching and release the target when the source switches or faints.
  Mean Look, Block, and Spider Web store their source ID in the permanent
  `trapped` volatile so the same switch/faint cleanup applies; No Retreat has
  no external source and lasts until the user switches.
  Nightmare is a Generation II–VII volatile that requires an already sleeping
  target, deals one-quarter max-HP end-turn damage, and clears when the target
  wakes or switches; do not model it as a major status.
  Electrify is a Generation VI+ one-turn target volatile: the target's next
  move, including Status moves, must reach the calculator as Electric and
  consume the volatile.
  Miracle Eye is a Generation IV+ target volatile: keep it target-scoped,
  neutralize Psychic's Dark-type immunity in the calculator boundary, ignore
  the target's evasion changes for accuracy while active, and clear it on
  switch.
  Psychic Terrain blocks opposing priority moves from affecting grounded
  targets from Generation VII onward. Apply the same target boundary for
  Generation VII+ Dazzling and Queenly Majesty. Generation IX+ Armor Tail
  protects the holder and its living active allies in Doubles; airborne targets
  and same-side priority effects remain eligible. From Generation VII onward,
  Dark-type targets are likewise immune to opposing Prankster-boosted Status
  moves; this is a target eligibility rule, not a change to Prankster's order
  priority, and Mold Breaker does not suppress the attacker's own Prankster.
  Octolock is a Generation VIII+ source-scoped trap: store a separate
  `octolock` marker alongside `trapped`, apply its Defense/Special Defense
  drops at each end-turn while the source remains active, and clear both when
  the source switches or faints.
  Laser Focus is a guaranteed critical-hit input for the holder's next damage
  calculation: the calculator adapter must set its explicit critical flag and
  preserve defender-side critical-hit blockers. Focus Energy remains a
  probabilistic critical-stage effect; expose its stage through
  `ActionFacts.attackerCriticalHitStage` rather than forcing deterministic
  critical damage.
  Treat Battle Armor, Shell Armor, and the Run & Bun Magma Armor fork as the
  same critical-hit blockers in both setup policy and high-crit damage facts.
  Keep Disguise state explicit on `PokemonState`; its first positive direct or
  delayed move hit is reduced to zero and marks the effect broken, while an
  ordinary or forced switch resets it on re-entry.
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
  Keep Choice-item locks separate from `lastMoveByPokemon`; a switch clears the
  lock but does not erase historical move data used by scoring or Encore. Apply
  the shared effective-item predicate so Magic Room, Embargo, and active Generation IV+ Klutz
  do not leak a suppressed Choice lock into move enumeration.
  `lastMoveUsed` is the battle-wide source for Copycat, while
  `lastMoveUsedByPokemon` is the current-appearance source for Mimic, Sketch,
  and modern Conversion 2; a switch clears it. `lastMoveTargetedByPokemon`
  is the switch-scoped source for Mirror Move, and
  `lastMoveTargetIdsByPokemon` preserves the target slots required by Instruct.
  Copy moves that replace a slot must preserve the pre-copy move set in
  `PokemonState.originalMoves`; ordinary switching restores that set.
  Metronome and Sleep Talk must expose their selected move through an explicit
  caller-execution field rather than pretending the wrapper move resolved as
  the called move.
  Successful Generation VII+ dance moves must expose active Dancer holders
  through the same boundary, preserving original target slots for allies and
  targeting the original actor for opposing Dancer holders. Mark those calls as
  external so the caller does not recursively retrigger Dancer.
  Nature Power follows the same boundary; do not infer unmodeled map
  environments from the absence of a terrain value.
  Assist draws from other party members, including fainted members and moves
  with zero PP; preserve its generation gate and its Gen III original-move
  behavior when temporary move copies exist.
  Me First consumes a caller-seeded `selectedMoveByPokemon` intent for the
  current turn; it must fail without a pending opponent damaging move, on a
  selected Z/Max move, or on a status/blocked move. Expose the copied move and
  its 1.5x-power/accuracy modifiers through the immediate called-move boundary;
  historical last-move data is not a substitute for a same-turn intent.
  Instruct uses the target's current-appearance last move, preserves its last
  target slots through `calledMoveTargetIdsByPokemon`, and exposes the target
  as the immediate called-move actor; historical cross-switch move data must
  not leak into this boundary.
  Helping Hand and Follow Me use the caller-seeded partner intent when
  available; they require a live Doubles partner, and if that partner is using
  a status/support move that turn, score the support action as unusable rather
  than inventing simultaneous behavior. Preserve `ActionFacts.isMultiHit` from
  the calculator boundary; in Doubles it carries the documented multi-hit
  damaging-action bonus into scoring.
  Transform uses the same temporary boundary to copy effective species, types,
  ability, non-HP raw stats, stat stages, and five-PP moves; it must fail on an
  already transformed user/target where the generation rules require it and
  must restore every copied field on switch. Good as Gold blocks opposing
  Transform only from Generation IX.
  Imposter and Trace use the same serializable switch-entry boundary. From
  Generation V onward, an active Imposter holder copies a legal opposing
  active's effective species, types, non-HP raw stats, current stat stages,
  ability, and moves; copied moves use five PP in Generation V+ and the target
  is not copied through Substitute or an existing temporary transform. Ability
  Shield prevents only the copied ability. From Generation III onward, Trace
  selects one living opposing active target and copies only a traceable ability;
  No Ability, non-traceable abilities, Ability Shield, suppression, and invalid
  sampler output remain explicit no-op/error boundaries. Keep these effects in
  `SwitchEntryResolution` maps; use `noAbilityByPokemon` for an explicit No
  Ability copy and reserve a null ability override for restoring the base
  ability, so ordinary switch reset can clear both forms.
  Conversion's generation-dependent first-slot rule and Conversion 2's
  generation-dependent last-move source, damaging-history distinction, and
  targeting must remain explicit; modern Conversion 2 bypasses Substitute but
  remains blocked by an opposing Crafty Shield; do not invent a type when no
  known resistant candidate exists.
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
  Switch transitions derive common entry hazards, including Steel-type G-Max
  Steelsurge, and their blockers in the AI boundary; keep full simulator event
  ordering external. Normalize stat changes
  through the engine so Contrary, Simple, and common stat-drop blockers are
  applied consistently.
  Preserve hazard introductions at this boundary: Spikes Gen II+; Stealth Rock
  and Toxic Spikes Gen IV+; Sticky Web and terrain setters Gen VI+; Steelsurge
  and Heavy-Duty Boots Gen VIII+. Entry weather setters remain Gen III+ except
  Snow Warning, which is Gen IV+.
Hospitality is a Generation IX Doubles switch-entry response: an active,
unsuppressed incoming holder heals each other live active ally for one-quarter
of that ally's max HP, never itself, and never in Singles or before Gen IX.
Supersweet Syrup is a Generation IX one-time switch-entry response: the first
active, unsuppressed holder lowers each opposing active target's Evasion by one
stage, except through Substitute, and persists a trigger marker on the party
record so later switches do not repeat it. Preserve generation, suppression,
clamping, and target-eligibility boundaries.
Curious Medicine is a Generation VIII Doubles switch-entry response: an active,
unsuppressed incoming holder clears all modeled stat stages from its other live
active ally through an absolute boost reset. It does not invent an ally in
Singles and remains generation- and suppression-gated.
Color Change is a Generation V+ post-hit type transition: a surviving holder
that takes direct damage from a non-Status move adopts that move's resolved
type, unless the type is already present or the attacker suppresses/bypasses
the ability.

Protean and Libero are pre-move attacker transitions. Project their resolved
move type into calculator inputs before damage, then persist the resulting
`typeOverride`; Generation IX additionally consumes `typeChangeUsed` once per
active appearance. Switching clears both fields.

Forecast must project Castform's weather type and form consistently across
calculator input, switch entry, weather changes, end turn, and weather expiry.
Flower Gift synchronizes Cherrim's Sunshine Form with Sun; Hunger Switch
toggles Morpeko at end turn. Switch-entry weather-form projection must evaluate
the post-switch active roster: an outgoing Cloud Nine/Air Lock holder cannot
suppress the incoming form, while an incoming suppressor must suppress it
immediately.

Mimicry is a Generation VIII+ terrain lifecycle: every active, unsuppressed
holder becomes Electric, Grass, Fairy, or Psychic type for Electric, Grassy,
Misty, or Psychic Terrain respectively. Apply it when terrain starts or a
replacement enters existing terrain, restore base types when terrain clears or
expires, and preserve generation, suppression, and switch-cleanup boundaries.
Screen Cleaner is a Generation VIII+ switch-entry response: an active,
unsuppressed incoming holder clears Reflect, Light Screen, and Aurora Veil from
both sides, while leaving unrelated side effects intact. Preserve its
generation and suppression gates.
Intrepid Sword and Dauntless Shield are Generation VIII+ one-time switch-entry
responses: an active, unsuppressed holder receives +1 Attack or +1 Defense
through the ordinary stage pipeline, records a persistent battle marker, and
does not trigger again after switching out and back in.
Commander is a Generation IX Doubles entry link: a Tatsugiri with Commander
and an active Dondozo create `commanding`/`commanded` state, give Dondozo +2 to
each battle stat through the normal stage pipeline, and prevent the linked
Tatsugiri from acting or either partner from switching while linked.
Costar is a Generation IX Doubles entry copy: an incoming active Costar holder
copies its live ally's modeled stat stages and Focus Energy/Laser Focus state;
it does not invent a partner in Singles or copy from a fainted ally.
Intimidate entry effects target every opposing active slot in the current
format; preserve its generation gate, ability suppression, Contrary inversion,
Simple doubling, Defiant/Competitive/Guard Dog responses, Gen 8+ Inner Focus,
and modeled Clear Body/Full Metal Body blockers, with White Smoke/Hyper Cutter
available from Gen III and Clear Amulet from Gen IX, at the entry-resolution
boundary.
Generation VII+ Adrenaline Orb activates on an eligible Intimidate attempt,
raises the target's Speed through the normal stat-stage pipeline, and consumes
the active unsuppressed item; generation, blocker, Magic Room, Embargo, and
Klutz boundaries remain authoritative.
Defiant and Competitive are additive responses after the incoming drop, not
drop replacements; keep the same net-stage semantics in ordinary move drops.
Mirror Armor reflects opposing drops back to their source; route the reflected
delta through the source’s normal blockers and counter-ability handling.
Sticky Web is an entry stat drop as well: grounded targets must apply
Contrary/Simple, Clear Body-family, Clear Amulet, Defiant, and Competitive
rules before emitting the Speed delta. If a hazard setter is not represented,
do not fabricate a Mirror Armor reflection target.
Treat `SwitchAction.forced` as a required replacement, not as a second scoring
path for voluntary hard switches. Post-faint replacement is required by zero
HP; a successful phazing move records a living active in
`BattleState.pendingForcedSwitchIds` and uses the same explicit replacement
queue. Do not invent the replacement choice in the move resolution.
Move-induced switching must also remain explicit: U-turn, Volt Switch, Parting
Shot, Flip Turn, Teleport, Chilly Reception, and Baton Pass enqueue a required
replacement only when a legal living replacement exists. Baton Pass uses its
separate pending marker so `SwitchAction.batonPass` preserves only the modeled
boosts and Substitute.
Shed Tail has a separate pending marker and `preserveSubstitute` switch mode;
it must pay its HP cost and create the Substitute before that replacement is
applied, without transferring stat stages.
Active opposing Arena Trap, Magnet Pull, and Shadow Tag are also switch
legality boundaries. Apply their generation availability, active/suppressed
ability state, groundedness, effective typing, and Shadow Tag self-immunity in
`isSwitchBlockedByAbility()` before enumerating or applying a voluntary switch;
forced replacements bypass the ability trap. The serializable model has no
Doubles slot adjacency, so the shared predicate treats any living opposing
active holder as reachable; a positional battle adapter may narrow that rule.
Generation VI+ Ghost-types likewise avoid move-created trapping effects, and
the move engine must pass partial traps through the shared volatile-eligibility
predicate rather than writing them directly.
Move-induced voluntary switches use the same predicate: U-turn, Volt Switch,
Parting Shot, Flip Turn, Teleport, Chilly Reception, and Baton Pass do not
enqueue a replacement while the user is held by an opposing ability trap.
An active Generation IV+ Shed Shell lets its holder bypass move-created and
ability-created traps for voluntary switching and pivot requests, subject to
the shared item-suppression boundary. It does not bypass Ingrain or Commander.
Ghost/Shed Shell escape applies only to source-aware external traps; the
source-less `trapped` marker used by No Retreat and legacy hard-lock inputs
remains non-escapable.
Red Card and Eject Button are damage-triggered item transitions, while Eject
Pack is a stat-drop-triggered transition; consume the item in the same
resolution that enqueues the replacement.
Heart Swap must exchange all modeled stages, including Accuracy and Evasion,
using absolute set semantics rather than additive deltas.
Spectral Thief must transfer positive modeled stages, including Accuracy and
Evasion, to the user and clear those stolen positive stages from the target
while preserving the target's negative stages.
Power Trick and Power Shift must exchange the user's raw Attack and Defense
values while leaving their stat stages on the corresponding stats. Speed Swap
must exchange raw Speed values, and Guard Split/Power Split must average the
respective raw values without converting the result into stat-stage changes.
Embargo must suppress held-item effects for five turns without deleting the
item; Heal Block must suppress modeled recovery and healing for five turns
without clearing unrelated status or volatile state.
   Ordinary switches reset stat stages, volatile state, toxic counters, Salt
   Cure, and Dynamax state; Baton Pass preservation is available only through
   the explicit `SwitchAction.batonPass` contract and is limited to modeled
   boosts and Substitute state.
   Natural Cure clears the outgoing status and Regenerator heals one-third of
   max HP when a living Pokémon leaves, including a phazing-forced switch;
   post-faint replacements have no outgoing cleanup. Natural Cure is available
   from Generation III and Regenerator from Generation V; unavailable or
   suppressed abilities do not perform those cleanups.
   Hospitality is resolved on the incoming switch entry in Generation IX+
   Doubles, healing each other live active ally for one-quarter max HP; it does
   not heal the entrant, does not operate in Singles, and respects suppression.
   Commander links an entering Tatsugiri and active Dondozo in Generation IX+
   Doubles, records the relationship by stable IDs, applies the Dondozo +2
   all-stat boost through normal stage clamping, and blocks linked switching;
   pre-Gen IX, Singles, wrong-species, and already-linked states do not trigger.
   Costar copies an active live ally's modeled boost map and Focus Energy/Laser
   Focus volatiles into the incoming holder in Generation IX+ Doubles through
   the absolute entry-boost map; it does not copy from a fainted ally or in
   Singles, and suppression/pre-introduction states do not trigger.
   Sleep status persists across a switch, but its modeled counter resets on
   re-entry according to the Run & Bun mechanics document.
   `beginNextTurn()` advances sleep and active volatile timers only for current
   active slots; do not age benched status or volatile state.
- Preserve uncertainty explicitly if hidden information is introduced later.
  The initial Run & Bun model assumes the AI has the full information described
  by the game’s AI documentation.

## Validation

Install dependencies before running checks. The normal validation command is:

```sh
npm test
```

Calculator-only checks can be run from `calc/` with `npm test` and
`npm run lint`. New AI rules should have focused fixtures covering the input
state, candidate action, derived facts, expected score outcomes, and selected
action.

When changing the calculator and UI together, build from the repository root
so the generated `dist/` output stays synchronized.

## Change hygiene

- Keep upstream calculator fixes separate from Run & Bun policy changes when
  practical.
- Avoid changing generated data manually; document its source and regenerate
  it through the importer when possible.
- Do not add a new special case to the damage mechanics merely to implement an
  AI preference.

## Parallel work

- Use a dedicated, named worktree for every concurrent or cross-repository
  lane. Never share a worktree between agents or absorb unrelated dirty paths.
- Declare one disjoint write set per lane using the table in `docs/SDLC.md`.
  Shared contract files have one owner; consumers develop against pinned
  fixtures or recorded receipts.
- Stage explicit paths, re-check status immediately before committing, and do
  not use stash as a coordination mechanism.
- Rebase onto the current target, rerun the lane gate, and integrate with a
  fast-forward. A rejected fast-forward is drift evidence, not permission to
  force or weaken a fixture.
- Record exact lane revisions and the contract digest in an integration matrix
  before cross-repository compatibility or deployment may be claimed.
