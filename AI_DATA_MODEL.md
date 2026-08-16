# Run & Bun AI Data Model

The AI model is the state and decision contract around the existing damage
calculator. It is intentionally plain data: it can be serialized, tested, and
used by a browser or server without sharing mutable calculator objects.

The initial TypeScript contract lives in `ai/src/model.ts` and is exported by
the `runbuncalc-ai` subpackage.

Planner output is not mutable battle state. Accepted `pokemon.rab.plan`
request/receipt pairs are stored as content-addressed `rabrun.evidence/1.0.0`
records beside the attempt event ledger. They bind an attempt revision, owned
party and IVs, trainer order, explicit seeds, provider revision, result hash,
and replay hash without advancing the game revision. Played fights are separate
canonical `battle.ended` events with seed, turns, participants, outcome, and
deaths. `rl-dataset.js` schema `1.2.0` materializes both sides into typed
`planning_receipts`, `planning_branches`, `battle_outcomes`, and
`planning_reviews` tables for Arrow/Parquet-oriented analytics and RL work.

`validateBattleState()` is the runtime boundary for serialized inputs. It
checks stable party IDs, active-slot ownership, HP/resource ranges, stat stages,
volatile timers, hazard layers, supported weather/terrain values, field and
side-effect booleans, modeled duration names, and historical lock references
before policy or transition code consumes a state. Unknown field/effect keys,
unsupported boost names, malformed volatile properties, and null-shaped
volatile entries are rejected rather than passed through as forward-compatible
guesses. Accuracy/evasion stages are kept in the AI state and filtered out of
guesses. Move accuracy/targets/secondary effects, move flags, IV/EV maps, and
optional Pokémon identity/battle flags are validated at the same boundary.
Accuracy/evasion stages are kept in the AI state and filtered out of calculator
stat objects; the accuracy boundary consumes them directly. MoveState also
accepts explicit custom overrides for sound, wind, Dancer, Snatch, and
reflectable flags so caller-defined moves use the same move-engine boundaries
as canonical moves.

`validateAction()` is the corresponding boundary for move and switch intents.
It checks the action kind, actor and target/replacement party IDs, non-empty
move names, duplicate-free target lists, and boolean intent flags. Both
validators classify malformed serialized input as a client error so HTTP
callers receive JSON `400` responses.

`validateMoveResolution()` validates caller-supplied move outcomes before they
reach transition code. It checks serializable map shapes, finite HP/damage
values, status/boost/override types, and ensures damage is recorded only for
the selected action's targets. Nested volatile deltas, side-effect and field
patches, duration maps, delayed moves, and resolution traces are checked
against the same canonical names and value shapes; transition code remains
responsible for legal state semantics.

`validateMoveEngineOptions()` applies the same rule to caller-supplied
accuracy, secondary-effect, and `ActionFacts` inputs used by
`deriveMoveResolution()`; malformed calculation facts are rejected before
sampling or effect resolution.

`validateEndTurnResolution()` and `validateSwitchEntryResolution()` apply the
same serializable-shape checks to residual and switch-entry outcomes. The
server validates derived responses, and end-turn application validates before
committing residual state, so every resolution family has an explicit model
boundary.

The Run & Bun policy rules are grounded in the workspace source document
[`run_and_bun_ai.MD`](../run_and_bun_ai.MD). The TypeScript policy is an
executable, test-covered transcription of documented rules; omissions and
known compatibility gaps should be recorded here rather than silently guessed.

## Decision flow

```text
BattleState
  -> enumerate legal Action values
  -> adapt an action and state into calculator objects
  -> call calc.calculate for damage actions
  -> derive machine-readable ActionFacts
  -> apply Run & Bun scoring rules
  -> choose one highest-scoring action, including tie randomness
```

`evaluateActions()` and `evaluateDamagingActions()` normalize caller-provided
ability and held-item fact fields against the current generation before policy
consumes them. This keeps external fact providers from reactivating known
pre-introduction abilities or items; direct scoring helpers are lower-level
interfaces and expect facts that have already crossed this boundary.

The calculator is an oracle in this flow. It does not own the battle state and
does not apply the selected action to the next turn.

Miracle Eye is a Generation IV+ target volatile. It is stored only on affected
targets, makes Psychic damage neutral against Dark targets at the calculator
boundary, suppresses the target's evasion-stage accuracy modifier while active,
and is cleared by ordinary switching.

The calculator fork applies the documented Soul Dew override at its stat
boundary: Latias and Latios holding Soul Dew receive +1 SpA and +1 SpD stages,
clamped at +6. This is an item-derived stage, not an additional direct damage
multiplier.
Its critical-hit paths likewise use the documented 1.5× damage multiplier;
Magma Armor is treated as a critical-hit blocker in the supported generation
mechanics.

Switch selection is intentionally a second-stage policy. `enumerateActions()`
exposes legal Singles and Doubles switch intents, while `evaluateActions()`
includes them only when the caller opts in and supplies viable replacement IDs
for Singles. For Singles,
`evaluateActions()` now derives the documented per-replacement
`faster`, `notOHKOd`, and `not2HKOd` checks from hypothetical legal entry
states and opposing move facts; explicit caller-supplied viability values
override those derived values. This keeps the documented hard-switch
conditions explicit instead of inventing a full matchup score. Callers that
have matchup facts can additionally pass per-replacement `faster`,
`notOHKOd`, and `not2HKOd` checks;
the policy then enforces the documented faster-and-survives-one-hit /
slower-and-survives-two-hit branch. `applySwitchAction()` returns a new state;
it never mutates the input state. The generic 50% hard-switch roll is
intentionally Singles-only; Doubles switch intents remain explainable
candidates but are scored -20 unless a separate specialized policy (for
example, a Perish Song routine) supplies a replacement. Forced post-faint,
phazing, pivot, and emergency replacements use their own required-replacement
queue in either format. When supplied, `replacementScores` ranks the successful
voluntary-switch branch as well as required replacements; without a score, the
successful voluntary branch remains score 0. Applying a switch also derives common
entry-hazard consequences for the replacement: Stealth Rock, G-Max Steelsurge,
Spikes, Toxic Spikes, Sticky Web, Heavy-Duty Boots, grounding (including Iron Ball), and
common immunity/blocker rules. Toxic Spikes uses the shared major-status
eligibility predicate, and non-immune fractional hazard damage has a minimum
one-HP result. `deriveSwitchEntryResolution()` exposes that serializable
consequence separately when a caller needs to inspect or delegate application.
Those hazard layers are generation-gated: Spikes from Generation II, Stealth
Rock and Toxic Spikes from Generation IV, Sticky Web from Generation VI,
Steelsurge from Generation VIII, and Heavy-Duty Boots from Generation VIII.
Switch entry also derives Gen 3+ Intimidate against each opposing active slot,
including Contrary/Simple normalization, Defiant/Competitive/Guard Dog responses,
Gen 8+ Inner Focus protection, and common blockers (Clear Body, Full Metal Body,
White Smoke and Hyper Cutter from Gen 3+, and Clear Amulet from Gen 9+); the
resolution applies those boosts to all affected party records in Singles or
Doubles.
Voluntary switching also respects active opposing Arena Trap, Magnet Pull, and
Shadow Tag. Arena Trap checks the actor's shared groundedness predicate;
Magnet Pull checks effective Steel typing; Shadow Tag exempts a matching active
Shadow Tag ability. Generation VI+ Ghost typing can escape these ability traps,
and forced replacement actions remain legal. Because the serializable model
does not carry Doubles slot positions, any living opposing active holder is
treated as reachable by this shared legality predicate.
Generation VI+ Ghost typing also prevents move-created `trapped`,
`partiallyTrapped`, and `octolock` effects; partial-trap application routes
through the same volatile-eligibility predicate used by status and permanent
trap moves.
Move-induced voluntary switches use the same boundary: U-turn, Volt Switch,
Parting Shot, Flip Turn, Teleport, Chilly Reception, and Baton Pass do not
enqueue a replacement while the user is held by an opposing ability trap.
An active Generation IV+ Shed Shell bypasses move-created and ability-created
traps for voluntary switches and pivot requests, while Magic Room or other
item suppression removes that escape. Ingrain and Commander remain hard locks.
The escape applies only to source-aware external trap markers; source-less
`trapped` state, including No Retreat and legacy hard-lock inputs, remains
non-escapable.
Generation IX+ Hospitality is an explicit Doubles switch-entry response: an
active, unsuppressed incoming holder heals each other live active ally for
one-quarter of that ally's max HP. The entrant is excluded, Singles and
pre-Generation-IX states do not trigger it, and full-health or fainted allies
produce no HP delta.
Generation IX Supersweet Syrup uses a persistent `PokemonState.syrupTriggered`
marker. On the holder's first active entry, each opposing active target gets a
one-stage Evasion drop through the normal entry boost map unless Substitute
blocks that target; the marker is applied even when all target drops clamp or
are blocked, and it prevents later re-entry triggers.
Generation VIII Curious Medicine clears the modeled boost map of each other
live active ally when an unsuppressed holder enters in Doubles. The entry
resolution uses the absolute `setBoostsByPokemon` map, so negative, accuracy,
and evasion stages are all reset without additive drift; Singles, suppression,
and pre-Generation-VIII entries do not trigger it.
Generation IX+ Commander is an explicit Doubles entry transition. A Commander
 Tatsugiri and an active Dondozo create linked `commanding` and `commanded`
 volatiles with stable source IDs; Dondozo receives +2 Attack, Defense,
 Special Attack, Special Defense, and Speed through stage clamping. The linked
 Tatsugiri cannot act, and neither linked partner can switch while the link is
 active. The pairing requires the canonical species relationship and does not
 trigger in Singles, before Gen IX, or when either partner is already linked.
Order Up reads the linked Tatsugiri form from the Dondozo `commanded` source:
Curly raises Attack, Droopy raises Defense, and Stretchy raises Speed by one
stage. This effect is Generation IX-only and is applied even when Order Up's
damage attempt misses, matching its Commander-specific timing.
Generation IX+ Costar copies an active live Doubles ally's modeled boost map
and the modeled Focus Energy/Laser Focus volatiles onto the incoming holder.
`SwitchEntryResolution.setBoostsByPokemon` carries the absolute boost state so
the copy can include negative, accuracy, and evasion stages without additive
drift; no ally is invented for Singles, fainted, suppressed, or pre-Gen-IX
states.
Generation VII+ Adrenaline Orb is an explicit Intimidate-entry response: an
eligible unsuppressed holder receives a normalized +1 Speed stage and consumes
the item in the same switch-entry resolution.
Defiant and Competitive retain the incoming drop before adding their +2 Attack
or Special Attack response; Guard Dog instead blocks Intimidate and raises
Attack by one stage. Gen 8+ Mirror Armor reflects incoming stat drops to the
source, where the normal stat-response rules are applied.
Sticky Web applies the same state-safe Contrary/Simple normalization and
Defiant/Competitive responses to its grounded Speed drop; Clear Body-family
abilities and Clear Amulet suppress that drop. The model does not invent a
Mirror Armor reflection target when the hazard setter is not represented in
state.
Run & Bun weather and terrain abilities also update the field at entry and
clear the corresponding duration, making those effects permanent; weather and
terrain setters retain their canonical generation gates.

If the active Pokémon has fainted and no move action is available,
`evaluateActions()` automatically evaluates required forced replacements.
Callers may pass `replacementScores` from their matchup engine to rank those
replacements; without scores, legal replacements remain an explicit
equal-score tie rather than an invented matchup estimate.

`SwitchAction.forced` distinguishes a required post-faint replacement from a
voluntary hard switch. `enumerateSwitchActions()` excludes fainted actives and
preserves the other active slot in Doubles;
`enumerateForcedSwitchActions()` exposes legal Singles or Doubles replacements with
`forced: true`. The chooser ranks them only from caller-supplied
`replacementScores`, preserving the matchup engine as the owner of replacement
evaluation. A resolved phazing move instead records the living target in
`BattleState.pendingForcedSwitchIds`; that target cannot act or make a voluntary
switch until `enumerateForcedSwitchActions()` exposes a replacement. Applying
that forced switch clears the pending ID and runs normal switch-entry hazards.
Move-induced switching uses the same explicit queue: U-turn, Volt Switch,
Parting Shot, Flip Turn, Teleport, and Chilly Reception request a replacement
when their move-specific hit and generation conditions are met. Baton Pass uses
`pendingBatonPassIds`, and its replacement action preserves the modeled boosts
and Substitute through `SwitchAction.batonPass`.
Shed Tail uses `pendingSubstitutePassIds`: it pays half max HP, creates the
Substitute, and transfers only that Substitute through
`SwitchAction.preserveSubstitute`.
Generation 5+ Red Card and Eject Button use the same queue after positive
damage, consuming the triggering item; generation 8+ Eject Pack does so after
an emitted stat drop.
Heart Swap exchanges the complete modeled stat-stage vector, including
Accuracy and Evasion, through the same absolute-stage transition boundary.
Generation 7+ Spectral Thief transfers the target's positive modeled stages to
the user and removes those positive stages from the target; negative stages are
left in place on the target.
Generation 4+ Embargo is a five-turn target volatile that suppresses held-item
effects without removing the item. Generation 4+ Heal Block is a five-turn
target volatile that prevents modeled recovery moves and healing while leaving
other move effects intact.

## Core invariants

Delayed-move target lists and per-Pokemon move-history target lists contain
unique IDs that resolve to the current battle parties.
`firstTurnOutIds` contains only unique active IDs. Switching resets the
outgoing and incoming active Pokémon's consecutive-move streak state.
Current-appearance move history, selected intents, and Choice locks are also
active-ID-only state and are cleared when a slot switches.

- `PokemonState.id` is stable for the lifetime of a battle.
- `SideState.activeIds` identifies the Pokémon currently on the field.
- `PokemonState.hp.current` is never greater than `hp.max` and a Pokémon with
  zero HP is considered fainted.
- `MoveState.name` identifies a move; PP and disabled state belong to the
  battle model, not to the calculator’s static move data.
  `PokemonState.originalMoves` is retained only while a move-copy effect has
  replaced the current set; ordinary switching restores it and clears the
  field.
- `MoveState.target` is an optional explicit override for custom move data.
  `MoveState.basePower`, `MoveState.type`, `MoveState.category`,
  `MoveState.priority`, `MoveState.accuracy`, `MoveState.secondaryEffects`,
  `MoveState.contact`, `MoveState.heal`, `MoveState.punch`, `MoveState.bite`,
  `MoveState.pulse`, `MoveState.slicing`, `MoveState.bullet`, and the other
  move flags are explicit battle-state
  overrides; otherwise
  `ai/src/move-metadata.ts` layers canonical dex metadata with the Run & Bun
  base-power, PP, accuracy, secondary-effect, and type changes recorded in
  `MOVE_CHANGES.MD`.
  Action enumeration uses the inherited canonical move introduction
  generation before exposing a move. Unknown names remain available for
  caller-defined custom moves; direct resolution accepts explicit caller-owned
  move intents for compatibility with the broader calculator boundary.
  Calculator facts filter future canonical moves from move lists, and called-
  move selectors apply the same filter before choosing a move.
  Target inference preserves the inherited calculator projection for known
  moves and uses the shared metadata fallback for a missing calculator entry;
  an unknown caller-defined move without an explicit `target` therefore uses
  the deterministic ordinary single-target fallback rather than throwing.
  The order boundary uses the same metadata projection: calculator-fallback
  and caller-defined moves remain orderable even when the inherited calculator
  has no `Move` object, using their projected category/type and priority 0 when
  no canonical priority exists.
  When it is absent, the AI derives the target class from calculator data and
  applies explicit context-sensitive overrides for self-only moves, ally
  support, ally-plus-self healing, team-wide cleansing, side/field moves
  (including weather-gated Aurora Veil), all-active effects, and “any other
  Pokémon” moves. This includes non-Ghost
  versus Ghost Curse, Follow Me, Rage Powder, Ally Switch, Magic Coat, Pollen
  Puff, Life Dew, Heal Bell, and Aromatherapy.
- A single-target move produces one action per legal target. Area moves carry
  all affected active IDs in one action, and the calculator adapter preserves
  per-target damage under `ActionFacts.damageByTarget`.
- `DamageFacts.hits` records a calculator-backed sequential hit count while
  `DamageFacts.rolls` remains the per-hit range. `MoveResolution.hitDamageByTarget`
  carries the sampled hit array, whose sum must equal `damageByTarget`; the
  transition applies those hits in order so Substitute and Endure can change
  the outcome between hits. The trace preserves the same hit array for replay.
- `DamageFacts.hitRolls` preserves independent per-hit distributions when the
  calculator returns split-hit damage, such as Generation VI+ Parental Bond.
  The sampler draws one roll from each hit distribution and sends the result
  through the same sequential multi-hit engine; spread moves do not synthesize
  a Parental Bond second hit.
- `PokemonState.volatile` stores modeled non-status effects separately from
  major status, while side and field duration maps keep timers explicit and
  serializable. The `stockpile` volatile also carries a bounded `stacks`
  counter, allowing Stockpile, Swallow, and Spit Up to share explicit state.
  Source IDs and locked target IDs in volatile state must resolve to the
  current battle's party graph; the state validator rejects dangling references.
  Generation IX Cud Chew uses `PokemonState.volatile.cudChew` with `turns` and
  the consumed Berry `item`. It is armed only by an actual Berry-eating path,
  not by Bug Bite/Pluck's stolen-Berry consumer, replays the normal modeled
  Berry effect after two active end-turn boundaries, pauses while the ability is
  suppressed, and is cleared by ordinary switching. A Leppa Berry replay restores
  the first tracked depleted move's PP before clearing the delayed volatile.
  In Doubles, `followMe`, `ragePowder`, and `spotlight` are one-turn redirection volatiles:
  legal single-target opposing moves are enumerated against the active
  redirector, while spread moves keep all targets. Follow Me is generation-3+
  and fails in Generation VIII+ Singles; Rage Powder is generation-5+ and its
  Generation VI+ redirection immunity honors Grass typing, Overcoat, Safety
  Goggles, Stalwart, Propeller Tail, and Snipe Shot. Spotlight is generation-7+
  and is only enumerated in Doubles; its target becomes the redirector.
  Generation VIII+ Tar Shot is modeled as a persistent target volatile in
  `PokemonState.volatile.tarShot`, separate from its Speed-stage drop. The
  action remains legal when the target's Speed is already at -6 if the
  vulnerability marker can still be applied; repeated Tar Shot is rejected
  once both effects are exhausted. The calculator adapter doubles positive
  Fire damage against the marked target, and ordinary switch cleanup removes
  the marker.
- `PokemonState.statusTurns` is the explicit remaining-turn counter for sleep;
  serialized sleep states must provide it. `beginNextTurn()` decrements the
  counter only for active slots and clears sleep at zero; benched status does
  not advance until re-entry, when the modeled fresh sleep counter is restored.
  Generation III+ Early Bird decrements active sleep by two turns per boundary;
  suppressed Early Bird and pre-Generation-III states use the normal decrement.
  `MoveResolution.actionFailure` records a
  turn-local Truant, flinch, paralysis, sleep, freeze, confusion, or consecutive-protect
  gate; failed moves
  still record move bookkeeping/PP, while supported cleanup such as flinch
  removal is applied atomically. Sleep Talk and Snore bypass the sleep gate,
  and a successful freeze thaw clears the freeze before the move proceeds.
  Protective moves use the tracked consecutive-move state: a failed repeat
  does not create protection and resets that streak.
  `PokemonState.volatile.endure` is separate from `protected`: it applies a
  one-turn floor of 1 HP to direct damage, does not grant Protect-style
  immunity, expires at the turn boundary, and participates in the same
  consecutive-protection failure gate.
  Every move-resolution path that applies sleep initializes `statusTurns`, and
  every path that applies Toxic initializes `toxicCounter` to one.
- `PokemonState.volatile.infatuated` models Attract without gender gating. An
  infatuated actor has a 50% turn-local action failure chance; the volatile is
  cleared by the ordinary switch reset and Oblivious blocks new applications.
- `PokemonState.volatile.truant` is a non-timed alternating-action marker for
  active Generation III+ Truant. A normal attempted action arms it in the
  derived resolution; the next attempted action fails with
  `actionFailure: 'truant'` and clears the marker. Ability suppression and
  pre-Generation-III states do not arm or consume it.
- `PokemonState.volatile.slowStart` carries the five-turn active window for
  Generation IV+ Slow Start. Switch entry initializes `{turns: 5}`;
  `beginNextTurn()` decrements it for active holders, order halves Speed while
  it is present, and ordinary switching clears it. Calculator damage projection
  uses the same active window.
- Confusion from Swagger, Flatter, and supported secondary effects samples a
  2–5-turn duration and expires through `beginNextTurn()`; its turn-local
  action gate remains separate from the volatile timer.
- Supported flinch secondaries carry a one-turn volatile timer and are removed
  at the next turn boundary before the next action gate is evaluated.
- `PokemonState.volatile.destinyBond` is consumed when a direct damaging action
  KOs that Pokémon; the transition then sets the acting Pokémon to zero HP.
  Substitute damage, non-KOs, misses, and explicit volatile removal do not
  trigger it.
- `PokemonState.volatile.laserFocus` is consumed by the calculator adapter as a
  guaranteed critical-hit flag for the holder's next damage calculation; the
  calculator still applies the defender's critical-hit blockers. The volatile
  expires at the next turn boundary. `focusEnergy` remains an explicit setup
  volatile; `ActionFacts.attackerCriticalHitStage` exposes its +2 stage (and
  other known crit-stage sources) to the battle engine's generation-specific
  crit-roll layer rather than misrepresenting it as a guaranteed critical.
- `PokemonState.boosts` includes Accuracy and Evasion stages as well as the five
  battle stats. End-of-turn Moody is represented by
  `EndTurnResolution.boostsByPokemon`: it samples one eligible +2 raise and a
  separate eligible -1 drop, then the transition clamps both to the [-6, 6]
  stage range.
- `PokemonState.evs` is accepted only as a serialized compatibility field. Run
  & Bun removes EVs, so all AI calculator, order, accuracy, entry, and
  stat-transform projections use an explicit zero EV map; the inherited
  `calc/` package remains EV-capable for its OSS API.
- `PokemonState.disguiseBroken` records the Run & Bun Disguise lifecycle. An
  intact Disguise converts the first positive direct or delayed move hit into
  zero damage and marks the effect broken; switching resets it for the next
  entry. Calculator adapter facts apply the same protection before scoring.
- `BattleState.delayedMoves` stores already-sampled Future Sight/Doom Desire
  damage and Wish healing fractions until their due turn boundary. The move
  resolution schedules the effect without applying it immediately;
  `advanceTurn()` decrements the timer and `deriveEndTurnResolution()` applies
  and removes due entries atomically. Slot-targeted Wish healing follows the
  original active slot, so a switch can receive the delayed recovery.
  `MoveResolution.pendingFullHealBySide` models Healing Wish and Lunar Dance:
  the user faints immediately, the side carries a one-shot pending flag, and
  the next switch-entry transition fully heals and status-clears the incoming
  replacement before consuming that flag. PP restoration remains an external
  battle-engine fact.
  Delayed damage requires calculator damage facts so the state never pretends
  that an unresolved future hit has a known amount. At impact, delayed move
  damage uses the normal damage-to-Substitute boundary before changing HP;
  residual weather/status deltas remain separate.
- `PokemonState.substituteHp` stores a Substitute on the individual Pokémon;
  it is not a side-wide effect. Damage consumes this pool first, and derived
  direct status/stat/volatile effects do not pass through it, except for the
  modeled sound-based Perish Song path, which still honors Soundproof.
- `PokemonState.itemCorroded` is a persistent held-item suppression flag for
  Corrosive Gas. The item name remains in `PokemonState.item` so the model can
  distinguish “still held but unusable” from ordinary item loss; switching does
  not clear the flag. `isItemEffectActive()` applies this boundary everywhere
  ordinary item effects are consumed by policy, order, residuals, eligibility,
  and calculator facts. Its explicit overlay map plus the inherited
  calculator's canonical item tables reject known pre-introduction items,
  including Leftovers/Quick Claw before Generation II, Choice items before
  Generation IV, Assault Vest before Generation VI, Heavy-Duty Boots before
  Generation VIII, and Clear Amulet/Ability Shield before Generation IX.
  Generation IX+ Ability Shield is an active held-item guard on the holder's
  ability: Role Play, Skill Swap, Entrainment, Simple Beam, Worry Seed, Doodle,
  Gastro Acid, Transform's copied ability, and reactive contact ability changes
  must leave the protected ability unchanged. Magic Room, Embargo, Corrosive
  Gas, Klutz, and pre-introduction item availability suppress that protection
  through the shared `isItemEffectActive()` boundary.
- `MoveResolution.itemByPokemon` records held-item changes, while
  `consumedItemByPokemon` records actual consumption separately from Knock Off,
  Trick/Switcheroo, Bestow, or Thief/Covet removal. The derived move slice
  covers Knock Off, Fling, Natural Gift, Trick/Switcheroo, Bestow, Thief/Covet,
  and Bug Bite/Pluck berry removal. Fling and Natural Gift fail before item
  consumption when the actor cannot use its held item under Magic Room,
  Embargo, or the applicable ability restrictions. For Bug Bite/Pluck,
  `itemByPokemon` identifies the
  target losing the Berry while `consumedItemByPokemon` identifies the attacker
  as its consumer. Bug Bite/Pluck still execute the shared modeled Berry-eat
  effects on the attacker (healing, stat, status, and volatile effects), but
  do not arm that attacker's Cud Chew; item-triggered effects such as Weakness
  Policy activation remain battle-engine inputs.
  Generation V+ Incinerate destroys a hit target's Berry without recording a
  consumed-item provenance, while Generation VI+ Magician and Generation V+
  Pickpocket record explicit post-damage item transfers. These transitions
  honor contact, positive damage, Substitute, Sticky Hold, and faint-target
  boundaries; sampled multi-hit arrays may reach the item boundary on a later
  hit after a Substitute breaks. Sticky Hold is available from Generation III
  onward.
  Recycle restores only `PokemonState.lastConsumedItem` from generation 3
  onward; forced removals such as Knock Off do not become recyclable, and
  Generation V+ Bug Bite/Pluck consumption clears recyclable provenance even
  though the target Berry is still consumed.
  Generation V–VII Natural Gift also preserves its Berry when Red Card forces
  the user out before the item-consumption boundary.
  Generation VIII+ Corrosive Gas marks an eligible target's held item as
  unusable without deleting the item or making it recyclable; Substitute and
  Sticky Hold block the state change, and the suppression persists through
  switching.
  Stuff Cheeks consumes a held Berry and applies its generation-8+ +2 Defense
  effect; unlike ordinary held-item effects, it can eat the user's Berry during
  Magic Room but remains blocked by Embargo.
  Cheek Pouch restores 1/3 max HP for generation-6+ active holders when a
  modeled Berry consumption occurs, including Stuff Cheeks, Bug Bite/Pluck,
  Sitrus activation, confusion-berry recovery, and Lum/Chesto status cures.
  Heal Block suppresses the recovery portion of Berry eating and Cheek Pouch,
  including residual Berry triggers, Cud Chew replay, Bug Bite/Pluck, Teatime,
  Fling, and Belly Drum's Sitrus follow-up; it does not suppress the Berry's
  stat, status, or volatile effect, consumption, or Cud Chew capture.
  Generation III+ status-curing Berries use the same immediate and end-turn
  consumption boundary: Cheri cures paralysis, Chesto cures sleep, Pecha
  cures poison/toxic, Rawst cures burn, Aspear cures freeze, and Lum cures any
  major status plus the modeled confusion volatile; Persim cures the modeled
  confusion volatile. Magic Room, Embargo, Klutz,
  and pre-introduction item boundaries suppress these reactions, while the
  consumed-item map preserves Recycle/Harvest provenance.
  Generation III+ Shell Bell heals one-eighth of the move's aggregate direct
  HP damage after a successful move, including damage across multiple targets
  and later direct hits after a Substitute breaks. Substitute-only damage,
  Heal Block, item suppression, a forced switch, and a fainted actor do not
  produce Shell Bell healing.
  Generation II+ Berry Juice restores 20 HP when damage leaves a living holder
  at or below half HP, consuming the item with explicit provenance. It is not a
  Berry for Cheek Pouch or Cud Chew purposes. The current resolution boundary
  collapses a multi-hit trigger to the end of that move; end-turn projection
  retains the same threshold and suppression rules.
  Cud Chew's delayed re-eat is an ability-driven effect rather than a new held
  item: it clears its volatile after replay, applies modeled healing/stat/status
  Berry effects and Cheek Pouch, and leaves `lastConsumedItem` unchanged.
  Belch is legal only after `lastConsumedItem` records a consumed Berry; item
  removal and non-Berry consumption do not satisfy that prerequisite.
  Snore and Sleep Talk are legal only while the actor remains asleep; a
  wake-up at the action boundary invalidates both moves.
  `MoveState.timesUsed` is advanced by the transition when a move is recorded;
  Last Resort is legal only when every other move in the current set has a
  positive usage count.
  Stockpile is legal only below its three-stack cap; Swallow and Spit Up are
  legal only when Stockpile energy is present. Dream Eater and Nightmare are
  enumerated only against sleeping targets, and direct Dream Eater actions
  fail when the selected target is awake.
  The scoring boundary uses Swallow's canonical stack-dependent healing
  fraction (1/4, 1/2, or full HP) when evaluating whether recovery is useful.
  Self-resource moves use the same boundary: Rest and Swallow are excluded at
  full HP, and Rest also requires the shared sleep-eligibility predicate
  (including terrain and ability immunity); Belly Drum, Clangorous Soul, and
  Fillet Away require their canonical HP thresholds; Substitute requires
  enough HP and no existing Substitute; No Retreat cannot repeat while already
  trapped; and direct Stuff Cheeks actions fail without a usable held Berry.
  Target-dependent no-ops follow the same rule: Teatime requires an active
  Berry holder, Acupressure requires an uncapped target stat, and Psych Up,
  Guard Swap, and Power Swap require a stage difference to copy or exchange.
  Repeat-status moves also require a usable target state: Encore and Disable
  need current move history, while Taunt, Torment, Leech Seed, Perish Song,
  Foresight, Electrify, Octolock, Miracle Eye, Gastro Acid, Embargo, Heal
  Block, and trapping moves are excluded when their target marker is already
  active.
  Support and recovery moves follow the same deterministic boundary: ordinary
  self-recovery is excluded at full HP; Refresh, Purify, and Pain Split need a
  status-bearing target or unequal HP totals; and Life Dew, Jungle Healing,
  Aromatherapy, and Heal Bell require at least one ally who can be healed or
  cleansed. Pollen Puff remains selectable against an opposing target at full
  HP because its damaging branch is still valid.
  Field-state setters follow the same no-op boundary: hazards and side
  protections are excluded once their layer or marker is already present;
  Aurora Veil requires Hail or Snow; Fairy Lock, Water Sport, Mud Sport, and
  Ion Deluge, and Gravity require an inactive, generation-supported field state; and
  repeated weather or terrain setters are excluded when they cannot change the
  active field. Trick Room, Magic Room, and Wonder Room remain selectable as
  toggles even when already active; the documented policy scores an
  already-active Trick Room toggle at -20, while the transition still applies
  the legal toggle.
  Repeat volatile moves use the same boundary: Aqua Ring, Ingrain, and Magnet
  Rise cannot be reapplied to the user; Magic Coat and Snatch cannot be rearmed
  while their same-turn self volatile is active; Attract, Yawn, Leech Seed,
  Telekinesis, and Nightmare require an eligible target. Run & Bun Attract is
  intentionally gender-independent, so same-gender and genderless targets still
  pass the ordinary volatile-immunity and ability-protection checks. These checks
  are applied during action enumeration and direct move resolution.
  Cleanup utilities are also excluded when they have no deterministic work:
  Defog requires hazards or target-side screens, Court Change requires a side
  condition to exchange, Steel Roller requires active Terrain, and Flower
  Shield/Rototiller require an eligible Grass target with room for the relevant
  stage boosts.
  Transition-dependent moves use the same contract: Healing Wish and Lunar
  Dance require a legal replacement, Shed Tail requires more than half HP, no
  existing Substitute, and a legal replacement, and Psycho Shift requires a
  major status on the user. Generation IX Revival Blessing enumerates only a
  fainted same-side party target; it restores half max HP and clears major
  status without inferring an active-slot replacement.
  The remaining canonical status helpers use the same boundary: Lunar Blessing
  heals and cleanses the user's active side, Shelter raises Defense, Take Heart
  raises Special Attack/Special Defense while curing major status, and Spicy
  Extract trades target Attack and Defense stages. Odor Sleuth shares
  Foresight's target marker and is excluded once that marker is already active.
  Pure self-boost moves are excluded when every affected stage is already at
  +6. The shared setup contract deliberately leaves compound moves such as
  Shell Smash and No Retreat, and damaging setup attacks such as Power-Up
  Punch, selectable when their other effects remain meaningful.
  Pure target stat-drop moves are excluded when every affected target stage is
  already at -6; Captivate also requires compatible explicit genders. Damaging
  or multi-effect debuffs such as Snarl and Toxic Thread remain selectable
  because their other modeled effects remain meaningful.
  Pure target stage-boost moves use the matching upper-bound contract:
  Aromatic Mist is excluded when its ally's Special Defense is already +6.
  Coil and Hone Claws include their canonical Accuracy stage in both the
  self-stage legality predicate and the resulting accuracy facts.
  Defend Order and Extreme Evoboost use the shared pure self-stage contract,
  while Armor Cannon, Dragon Ascent, Headlong Rush, Ice Hammer, V-create, and
  Hyperspace Fury retain their damaging branch and apply their canonical self
  drops with generation-aware direct-resolution gates.
  Pure held-item transfers are likewise excluded when they cannot change the
  item state: Bestow needs an item-bearing user and empty ally, while Trick and
  Switcheroo need at least one transferable item and respect Sticky Hold.
  Damaging item moves such as Thief, Covet, Knock Off, and Bug Bite remain
  available because their damage branch is independent of item removal.
  Pure confusion setters are excluded when every target is already confused or
  protected by Own Tempo. Compound or damaging confusion moves such as Swagger,
  Flatter, and Chatter remain selectable when their other modeled effects or
  damage branch is still meaningful.
  Pure stage resets follow the same target-effect boundary: Haze and
  Topsy-Turvy are excluded when every affected target stage is already neutral.
  Clear Smog remains selectable because its damage branch is independent of the
  reset.
  Pure ability-copy and replacement moves are excluded when their modeled
  ability result is already identical: Role Play, Skill Swap, Entrainment,
  Simple Beam, Worry Seed, and Doodle compare the generation-valid active
  abilities before selection and direct resolution. Ability Shield also blocks
  the relevant holder-side change, including both sides of Skill Swap.
  Pure stat/stage exchange moves use the same boundary: Speed Swap, Guard
  Split, Power Split, Heart Swap, Power Trick, and Power Shift are excluded
  when their raw-stat or stage result would be identical.
  Instruct is excluded when its ally has no generation-valid, non-blocked last
  move with remaining PP to repeat; the same callable-move predicate is used
  by direct resolution.
  Pure move-copy actions use the same source predicate: Copycat and Mirror Move
  need a legal recent source, while Mimic and Sketch also reject missing targets
  and moves the actor already knows.
  Candidate-source moves use the same boundary: Assist needs an eligible party
  move, Me First needs a pending damaging target move, Sleep Talk needs an
  eligible non-Sleep-Talk move while asleep, and Metronome needs a legal move
  pool.
  Pure PP-reduction moves use the current-appearance move history: Spite
  reduces the target's last move by four PP from Generation II onward, while
  Eerie Spell reduces it by three PP from Generation VIII onward. A known
  zero-PP last move is rejected; an omitted PP value remains caller-owned and
  is not fabricated into a reduction.
  Pure type-changing moves use the same expected-state check: Soak, Magic
  Powder, Forest's Curse, Trick-or-Treat, Reflect Type, Camouflage, Conversion,
  and Conversion 2 are excluded when their modeled type result is already
  satisfied or when Conversion 2 has no resistant type/history to select.
  Pure major-status setters are excluded when every target already has a major
  status. Toxic Thread remains selectable in that state because its modeled
  Speed-drop effect is independent of the Poison application; spread status
  moves remain selectable when at least one target is still eligible. The
  eligibility check also respects modeled type, terrain, ability, Safeguard,
  and Crafty Shield immunities.
  Volatile setters use the same canonical target rules: Leech Seed respects
  Grass immunity, Attract respects target ability protection without gender
  gating, and Yawn, Telekinesis, and Nightmare respect their existing
  status/volatile eligibility gates.
  Generation IX Supreme Overlord is projected through the calculator from the
  explicit `PokemonState.alliesFainted` field. The inherited calculator caps
  the count at five and applies the ability's damage multiplier; pre-Generation
  IX projection omits the ability rather than applying a custom AI-side boost.
  Generation IX Last Respects uses that same explicit `alliesFainted` field for
  its canonical 50 + 50-per-fainted-ally base power. Rage Fist uses the
  per-appearance `rageFistHits` counter, incremented by successful incoming
  damaging hits and cleared on switch, with the canonical 350-power cap.
  Generation IX Orichalcum Pulse and Hadron Engine use the existing switch-entry
  field transition: they establish permanent Sun or Electric Terrain and clear
  the corresponding timer. Suppressed or pre-Generation IX abilities do not
  create field state.
  Generation IX Wind Rider uses canonical move metadata rather than a hand-
  maintained move list. A successful opposing wind move emits +1 Attack through
  the normal resolution pipeline; the calculator supplies the wind immunity,
  while protection, misses, ability bypass, and generation gates remain in the
  AI boundary.
  Generation IX Wind Power uses the same canonical wind metadata for damaging
  hits and also responds when Tailwind is newly established on the holder's
  side. Both responses create the shared `charged` volatile; the calculator
  adapter doubles the holder's next regular Electric damaging move and the
  move engine consumes that volatile. Tailwind refreshes do not retrigger it.
  Generation IX Well-Baked Body and Earth Eater are damage-resolution responses
  on the existing typed-move boundary. Fire grants +2 Defense or Ground heals
  1/4 max HP respectively, while the calculator supplies immunity and the AI
  excludes protected, missed, suppressed, and ability-bypassed hits.
  Generation IX Electromorphosis stores its successful damaging-hit response as
  a `charged` volatile. The calculator adapter doubles the next regular Electric
  damaging move, and the move transition consumes the volatile; ordinary switch,
  suppression, ability-bypass, and pre-Generation IX boundaries remain explicit.
  Flash Fire activation is stored as a persistent `flashFire` volatile. The
  calculator adapter maps that volatile to the inherited calculator’s
  `abilityOn` input for subsequent Fire damage, while ordinary switching clears
  it and the move transition enforces generation, suppression, protection, miss,
  and Mold Breaker boundaries.
  Generation VIII+ Gulp Missile uses `speciesOverride` for Cramorant-Gulping or
  Cramorant-Gorging after Surf/Dive, selected from the holder’s HP threshold.
  A later damaging hit emits 1/4 attacker-max-HP retaliation, a Defense drop or
  paralysis, and a reset to base Cramorant; switching clears the form and Magic
  Guard suppresses only the retaliation damage; Gulp Missile remains
  non-suppressible by Mold Breaker-style ability bypass.
  Generation IX Seed Sower and Thermal Exchange are modeled as damaging-hit
  responses: Seed Sower sets five-turn Grassy Terrain and Thermal Exchange adds
  one Attack stage after a Fire hit. Both use the normal response eligibility
  boundary for protection, misses, suppression, and ability bypass.
  Typed absorption responses remain separate from calculator damage: Water
  Absorb, Volt Absorb, and Dry Skin emit one-quarter-max-HP healing, while
  Lightning Rod (Generation IV+) and Storm Drain (Generation V+) emit +1
  Special Attack. The response is suppressed when the move bypasses abilities or
  cannot affect the target, and all introductions remain generation-gated.
- End-of-turn resolution also models the Run & Bun confusion-inducing berries
  (Aguav, Figy, Iapapa, Mago, and Wiki): at or below 1/4 max HP they restore
  1/2 max HP and are consumed through `EndTurnResolution.itemByPokemon`.
- Derived Protect state is likewise stored per Pokémon for one turn, so a
  Protecting partner does not shield the rest of a Doubles side. The legacy
  side-level `effects.protected` input remains supported for external callers.
- User-only protection volatiles retain their move name so blocked contact
  moves can apply the documented counter-effect: King's Shield lowers Attack,
  Baneful Bunker poisons, Spiky Shield deals one-eighth max-HP damage, Silk
  Trap lowers Speed, Obstruct lowers Defense by two stages, and Burning Bulwark
  burns. Wide Guard, Quick Guard, and Mat Block remain side-level protections
  without these contact effects. Protection-breaking moves such as Feint clear
  both personal and side-level protection. Generation VIII+ Unseen Fist is a
  contact-only bypass for personal and side-level protection, but not Max Guard;
  it depends on the attacker's effective ability being active.
- Contact resolution also carries deterministic defensive consequences in the
  move HP delta: Rough Skin and Iron Barbs deal one-eighth of the attacker's
  max HP, Rocky Helmet deals one-sixth, and Aftermath deals one-quarter when
  the holder is KOed by a contact move. Sampled multi-hit resolutions count
  each hit that reaches the holder, stop after a KO, and begin counting later
  hits once a Substitute breaks. These effects honor Substitute, Endure,
  Magic Guard, Long Reach, Protective Pads, Punching Glove, active item state,
  and their generation gates.
- The same contact boundary carries reactive status and stat effects:
  Generation III+ Static, Flame Body, and Poison Point have 30% paralysis,
  burn, and poison checks; Generation III+ Effect Spore has independent
  10%-each poison, paralysis, and sleep outcomes; Generation III+ Cute Charm
  infatuates a contacting opposite-gender attacker; Generation IV+ Poison
  Touch poisons the contacted target; Generation VI+ Gooey and Generation
  VII+ Tangling Hair lower the attacker's Speed; and Generation V+ Cursed
  Body can disable any damaging move for four turns. These use the existing
  major-status, volatile, and stat-stage eligibility rules. Cursed Body samples
  its disabling chance for each damaging hit until it succeeds or the move
  ends. A sampled
  multi-hit resolution repeats eligible contact attempts per hit, including
  later hits after a Substitute breaks, until the effect applies or the
  sequence ends.
  Generation III+ Synchronize reflects opposing burn, poison, or paralysis
  back through the same status-immunity and item-cleanup boundary.
- Damage-triggered ability responses are represented in the same resolution:
  Weak Armor, Stamina, and Berserk produce their target-scoped stat changes;
  Motor Drive, Steam Engine, Sap Sipper, Justified, Water Compaction, and
  Rattled inspect the resolved move type; and Generation IX Toxic Debris adds
  a capped Toxic Spikes layer to the holder's side after each actual direct
  physical hit.
  These responses require resolved damage, honor active-ability and generation
  gates, and remain serializable through `boostsByPokemon` and
  `sideEffectsBySide`. Sampled multi-hit arrays repeat `onDamagingHit`-style
  stat and field responses per actual hit, including Cotton Down in Doubles and
  Toxic Debris, while immunity and threshold responses retain their one-time
  boundaries. Berserk's threshold response follows the same post-move rule as
  the simulator: a single-hit secondary move suppressed by Sheer Force does
  not trigger it, while an aggregate multi-hit sequence may.
  Aggregate caller-owned damage also uses the post-Substitute direct HP amount
  for this threshold, so partial Substitute breaks cannot overstate the drop.
  Electromorphosis, Wind Power, and Seed Sower likewise require positive
  direct HP damage; damage absorbed entirely by Substitute does not activate
  them.
- Generation IX Anger Shell is a post-move threshold response. A living holder
  crossing from above half HP to at or below half HP receives +1 Attack,
  +1 Special Attack, +1 Speed, -1 Defense, and -1 Special Defense through
  `boostsByPokemon`; a multi-hit move evaluates its aggregate direct damage
  once after the sequence, while Substitute, KO, single-hit Sheer Force,
  ability-bypass, and generation boundaries remain explicit. A hit that breaks
  a Substitute can trigger the threshold from the direct HP damage that gets
  through.
- Generation IV+ Anger Point is an actual critical-hit response. An eligible
  living holder receives +12 Attack, clamped through `boostsByPokemon`; callers
  may provide `ActionFacts.criticalHit` for a sampled critical result, while a
  guaranteed critical projects the same fact. Substitute, KO, ability-bypass,
  and pre-introduction boundaries remain explicit.
- Generation VIII Cotton Down is an active-field damage response. A positive
  damaging hit on its holder lowers every other living active Pokémon's Speed
  by one through `boostsByPokemon`, including active allies in Doubles. The
  holder, fainted actives, status/no-damage moves, ability bypass, and
  generation boundaries remain explicit; aggregate caller-owned facts stay
  one response, while sampled multi-hit arrays repeat the response for each
  actual damaging hit.
- Generation VII+ Emergency Exit and Wimp Out are represented as threshold
  responses. A living active holder crossing from above half HP to at or below
  half HP from real move or residual damage writes `forcedSwitchByPokemon` only
  when a legal replacement exists; applying the resolution adds the holder to
  `pendingForcedSwitchIds`. Sampled multi-hit damage follows the sequence
  through a Substitute before testing the threshold; aggregate caller-owned
  damage follows the same direct-HP boundary. Substitute, KO,
  already-low HP, ability bypass, trapping, Fairy Lock, generation, and
  no-replacement boundaries remain explicit.
- Direct-KO responses are also represented in `boostsByPokemon`: Moxie raises
  Attack, Chilling Neigh/Grim Neigh raise Attack/Special Attack, Beast Boost
  raises the attacker's highest calculator-derived raw non-HP stat, and
  Generation VII+ Soul-Heart raises each eligible active holder's Special
  Attack once per faint. These require direct move damage to cross the target
  HP boundary and exclude Substitute, Endure, Disguise, and delayed-damage
  false positives. For sampled multi-hit arrays, the engine follows the
  sequence through Substitute and uses the first actual KO for this boundary.
- Generation VII+ Battle Bond uses the same direct-KO boundary for a base
  Greninja. If the KO leaves another opposing party member alive, the move
  resolution sets `speciesOverrideByPokemon` to `Greninja-Ash` and applies
  `{atk: 1, spa: 1, spe: 1}`. Substitute-only damage, misses, the last
  opposing Pokémon, suppressed abilities, and pre-Generation-VII states do
  not trigger it; switching clears the temporary form override.
  An active `Greninja-Ash` also projects Water Shuriken as three hits in the
  calculator adapter, matching the form-specific move modification.
- Generation V+ Sturdy is represented before KO derivation: a full-HP target's
  first direct hit that would itself KO is capped at one HP, then later sampled
  hits continue against the remaining HP. A nonfatal first direct hit does not
  arm Sturdy for a later hit in the same move; sampled hits absorbed while
  breaking a Substitute do not consume it. The calculator adapter and
  move-resolution boundary share this rule, while pre-Generation-V cases
  remain distinct.
- Generation IV+ Focus Sash follows the same calculator and move-resolution
  boundary for an unsuppressed full-HP holder: the first direct hit that would
  itself KO is capped at one HP and the resolution consumes the item; a
  nonfatal first direct hit does not activate it for a later hit in the same
  move. Sampled hits absorbed while breaking a Substitute do not consume it,
  and later direct hits continue normally. Non-full-HP, pre-Generation-IV,
  and suppressed item cases are not capped. The transition applies the
  explicit item and `lastConsumedItem` maps, so Recycle can distinguish this
  consumption from forced item loss.
- Generation II+ Focus Band is a sampled move-resolution survival boundary for
  an active holder facing a fatal direct hit. A successful 10% roll caps the
  first fatal hit at one HP without consuming the item; misses, Substitute-only
  damage, pre-Generation-II states, and suppressed item effects do not trigger
  it. Sampled multi-hit arrays are walked through Substitute so a later fatal
  direct hit can be the one that receives the roll.
- Generation V+ Air Balloon is a direct-damaging-hit item transition. A
  successful damaging move consumes the active Air Balloon even when the
  direct damage is zero, while a Substitute-only hit does not; sampled
  multi-hit arrays can break the Substitute first and burst the Balloon on a
  later direct hit. Generation, Magic Room, Embargo, Klutz, and item-corrosion
  suppression preserve the item and its grounding effect.
- Generation VIII+ Ice Face is a stateful species boundary. An active
  Eiscue-form holder blocks the first qualifying physical hit in a sampled
  sequence, and the move resolution sets `speciesOverrideByPokemon` to
  `Eiscue-Noice`; later hits resolve normally. Hail in Generation VIII and Snow in
  Generation IX+ restore the override at end turn unless weather is
  suppressed, and switching still clears the temporary species override.
- HP-threshold form abilities use the same serializable species boundary at the
  end-turn projection: Generation VII+ Schooling toggles level-20+ Wishiwashi
  above 25% HP, Shields Down toggles Minior at 50% HP, Generation V+ Zen Mode
  toggles the regular or Galarian Darmanitan Zen form at 50% HP, and Generation
  VII+ Power Construct promotes Zygarde to Complete Form below 50% HP. The
  transition respects suppressed abilities and generation gates, and applies
  against projected post-residual HP.
- Generation IX+ Zero to Hero uses a persistent `zeroToHeroTriggered` marker on
  `PokemonState`. Switching out an active Palafin sets the marker; a later
  switch-entry resolution sets `speciesOverrideByPokemon` to `Palafin-Hero`.
  The marker survives switching, while the temporary species override is
  cleared and rebuilt by the ordinary switch boundary.
- Generation VI+ Stance Change is projected before damage facts: an active,
  untransformed Aegislash uses Blade Form for damaging moves and Shield Form
  for King's Shield, while other Status moves preserve the current form. The
  move resolution records the same `speciesOverrideByPokemon` change so the
  calculator and applied state use the same form.
- Generation VI+ Weakness Policy is a move-resolution item transition. A
  surviving positive direct-damage hit with caller/calculator
  `isSuperEffective: true` applies `{atk: 2, spa: 2}` through the ordinary
  stat-stage normalization (so Contrary and Simple still apply), then records
  the explicit item consumption. A hit that KOs the holder cannot activate the
  item. Generation, Magic Room, Embargo, Klutz,
  all-sampled-hits-absorbed-by-Substitute, and non-super-effective boundaries
  suppress the transition; a later direct hit in the same sampled sequence may
  activate it.
- The Generation V+ / VI+ reactive item family uses the same explicit
  transition: Absorb Bulb (Water -> +1 Special Attack), Cell Battery
  (Electric -> +1 Attack), Snowball (Ice -> +1 Attack), and Luminous Moss
  (Water -> +1 Special Defense). Each requires positive direct damage, matching
  move type and `isSuperEffective` facts, a holder that survives the hit, and
  an active item effect; a later direct hit after a Substitute breaks may
  activate it, and the item is consumed after the normal stat-stage pipeline
  applies.
- Generation VI Kee Berry and Maranga Berry are post-hit reactive transitions.
  A surviving holder of the matching active Berry consumes it after a
  Physical or Special hit and receives +1 Defense or +1 Special Defense via
  `boostsByPokemon`; fainting, Unnerve, Magic Room, Embargo, Klutz, generation,
  and item-consumption provenance boundaries remain explicit; a sampled
  multi-hit may trigger the one Berry on a later direct hit after Substitute.
- Generation IV+ Jaboca Berry and Rowap Berry are post-hit reactive damage
  transitions. A matching Physical or Special damaging hit consumes the active
  target Berry and applies 1/8 of the target's max HP as indirect damage to the
  active attacker (1/4 with Ripen). Substitute, Unnerve, Magic Room, Embargo,
  Klutz, Magic Guard, generation, and item-consumption provenance boundaries
   remain stateful and explicit; a sampled multi-hit triggers the one Berry once
   on the first direct hit, including a later hit after Substitute breaks.
 - Generation III+ Enigma Berry is a post-hit reactive recovery transition. A
   surviving positive direct-damage super-effective hit consumes an active
   Enigma Berry and restores 1/4 max HP (1/2 with Ripen); Heal Block, Unnerve,
   Magic Room, Embargo, Klutz, full HP, Substitute-only damage, fainting, and
   prior item consumption suppress the transition. Cheek Pouch receives its
   ordinary additional Berry-eating recovery.
 - Generation IV+ type-resist Berries are an explicit damage transition. Occa,
  Passho, Wacan, Rindo, Yache, Chople, Kebia, Shuca, Coba, Payapa, Tanga,
  Charti, Kasib, Haban, Colbur, Babiri, Roseli, and Chilan each map to one
  move type and halve one positive, matching, super-effective single-hit
  damage result. They require an active held-item effect, do not activate while
  all sampled hits are absorbed by a Substitute, consume the Berry, and record
  consumed-item provenance; Unnerve, Magic Room, Embargo, Klutz, generation,
  and multi-hit boundaries remain stateful and explicit.
- Generation VII+ Terrain Seeds are explicit field/entry transitions. Electric
  and Grassy Seeds apply +1 Defense on matching terrain; Misty and Psychic
  Seeds apply +1 Special Defense. They activate when terrain is established by
  a move or Surge entry, and when a replacement enters existing matching
  terrain. The transition records item removal and `lastConsumedItem` for every
  eligible active holder, while Simple/Contrary and held-item suppression use
  the normal state rules. The regression contract lives in
  `ai/src/test/terrain-seeds.test.ts`.
- Generation VIII+ Throat Spray is a sound-move item transition. A successful
  canonical sound move with an active unsuppressed Throat Spray applies a +1
  Special Attack stage through the normal stat pipeline and records explicit
  item consumption. Non-sound, pre-Generation-VIII, Magic Room, Embargo, and
  Klutz cases remain ordinary item behavior.
- Generation IX+ Mirror Herb is an opposing-stat transition. A successful
  move resolution that produces positive stages for an opposing active
  Pokémon copies those positive stage deltas to each eligible active Mirror
  Herb holder once, then records item removal and consumed-item provenance.
  The holder's own boosts, negative or clamped-to-zero changes, pre-Gen-IX
  items, and Magic Room/Embargo/Klutz suppression do not activate it. Active
  passive-response maps may address live active slots beyond the selected move
  targets, while transition validation still rejects benched IDs.
- Generation IX Opportunist is a post-boost opposing-stat response. It copies
  positive stage deltas from opposing active Pokémon after the original move
  boost map is complete, with no chaining from other Opportunist or Mirror Herb
  copies. The response is generation-gated, suppression-aware, clamped through
  the ordinary stat pipeline, and limited to active holders.
- Generation IX Poison Puppeteer is modeled at the post-status boundary for an
  active Pecharunt holder. A successful move-applied poison or toxic status
  adds the ordinary target-scoped confusion volatile after status and ability
  eligibility checks; wrong species, suppression, ability bypass, status
  immunity, and pre-Gen-IX states do not create the response.
- Generation IX Booster Energy is represented as a persistent
  `protosynthesis` or `quarkDrive` volatile after consumption. Switch entry and
  modeled weather/terrain changes activate it only when the corresponding
  natural trigger is absent; the calculator adapter and action-order boundary
  project the activated volatile as a virtual Booster Energy item so the
  canonical Protosynthesis/Quark Drive stat selection remains authoritative.
  Ordinary switching clears the volatile, while Magic Room and unavailable or
  suppressed ability/item states prevent activation.
- Generation VIII+ Blunder Policy is an accuracy-miss transition. An actual
  sampled accuracy miss applies +2 Speed through `boostsByPokemon`, records
  `itemByPokemon[pokemonId]: null` and `consumedItemByPokemon`, and persists those
  actor self-state changes even though the move has `hit: false`. Generic action
  failure and non-accuracy failure paths do not activate it; spread resolutions
  retain the partial-miss signal, while generation and held-item suppression
  remain explicit.
- Faint/contact ability responses are also serializable: Generation VII+
  Innards Out emits an attacker HP delta equal to the holder's remaining HP
  after a direct KO unless Magic Guard applies; Generation VIII+ Perish Body
  applies a three-turn `perishSong` volatile to both participants after actual
  direct contact damage.
  Generation V+ Mummy, Generation VIII+ Wandering Spirit, and Generation IX+
  Lingering Aroma use `abilityOverrideByPokemon` for mutable contact ability
  changes after actual direct contact damage, while form/identity abilities
  remain protected and overrides clear on switch.
- Wide Guard, Quick Guard, and Mat Block are explicit one-turn side effects,
  rather than ordinary per-Pokemon Protect. Wide Guard blocks moves whose
  canonical target can include multiple Pokemon (including in Singles), with
  the Generation V-VI damaging-move limitation; Quick Guard blocks opposing
  increased-priority moves; and Generation 6+ Mat Block blocks opposing
  damaging moves only when its user is in `firstTurnOutIds`. Feint clears these
  side protections, and all three expire at the next turn boundary.
    - `SideEffects.pledgeRainbow`, `pledgeSwamp`, and `pledgeSeaOfFire` are the
  serializable four-turn fields created by the three Generation V+ Pledge
  combinations: Fire+Water doubles secondary chances for the user's side,
  Grass+Water quarters the opposing side's Speed, and Fire+Grass applies
  opposing-side 1/8-HP residual damage to non-Fire Pokémon. A first same-side
  Pledge is represented in `BattleState.pendingPledgeBySide`; when a same-side
  partner intent already contains the complementary Pledge, the calculator
  adapter projects the first action as the eventual combined move for policy
  facts as well. The paired resolution samples the combined move at 150 power,
  clears the pending entry, and writes the appropriate field. Swamp is projected by the calculator
  adapter as a 1/4 Speed modifier, Rainbow is applied by the secondary-effect
  boundary, and Sea of Fire is applied by `advanceTurn()`.
- Ally Switch is a Generation 6+ Doubles action that requires a living active
  ally. Its successful resolution carries an actor-scoped slot-swap fact, and
  the transition swaps the two active IDs without changing party identity or
  mutating the input state. Singles, pre-Generation 6, and faint-ally uses
  fail at both action enumeration and resolution.
- `PokemonState.volatile.magicCoat` is a Generation 4+ one-turn self-protection
  volatile. An opposing Status move aimed at the coated active target is
  reflected to its source, the coat is consumed, and ordinary damaging moves
  pass through without consuming it; Nightmare is an explicit non-reflectable
  exception. The reflection is applied before the
  shared status/volatile/secondary-effect handlers so the source receives the
  same serializable effect boundary.
- Generation V+ Magic Bounce uses the canonical move `reflectable` flag rather
  than a hand-maintained status list. It reflects eligible status moves and
  hazards to the original actor's side, respects semi-invulnerability,
  suppression, and Mold Breaker-style bypass, and changes the effect actor
  before shared status, volatile, immunity, and side-condition handlers run.
- `PokemonState.volatile.snatch` is a Generation III-VII one-turn control
  volatile. It is armed by Snatch and consumes itself when another active
  Pokémon uses a canonical `snatch`-flagged status move; the move's supported
  self effects are applied to the Snatch user, while team/side effects are
  applied to that user's side. Z/Max moves are never stolen, and Snatch is
  unavailable in Generations VIII-IX. When multiple Snatch users are active,
  the modeled speed order selects the recipient; Generation III-IV chaining
  consumes all participating Snatch volatiles and leaves the final effect on
  the slowest user.
- `PokemonState.volatile.grudge` is a Generation III+ persistent self-protection
  marker. When a direct damaging move KOs its holder, `resolveMoveAction()` sets
  the attacking move's tracked PP to zero. Substitute and Endure prevent the
  faint-triggered PP change, while switching clears the marker with ordinary
  volatile cleanup.
- Derived Helping Hand state is stored on the selected ally for one turn. The
  calculator adapter applies its modifier to that ally only; legacy side-level
  `effects.helpingHand` remains an external compatibility input.
- Secondary-effect resolution is a separate boundary from calculator damage:
  Serene Grace doubles the sampled secondary chance, Sheer Force suppresses
  damaging-move secondaries, and Shield Dust/Covert Cloak block opposing
  additional effects while leaving self-effects eligible.
  Canonical move-level self effects with an explicit chance are normalized into
  that same boundary; Diamond Storm therefore samples its 50% self +2 Defense
  effect without treating deterministic V-create/Hyperspace Fury drops as
  secondaries.
  Random-status secondaries retain their mutually exclusive outcome set in
  `SecondaryEffect.statusChoices`: Dire Claw samples sleep, poison, or
  paralysis after its 50% proc, while Tri Attack samples paralysis, burn, or
  freeze after its 20% proc. For calculator-backed sampled multi-hit arrays,
  each actual hit receives its own secondary roll and trace key; hits absorbed
  by Substitute or after a KO do not roll. Aggregate multi-hit facts without
  a hit array use the post-Substitute direct-hit count, so fully absorbed
  damage does not roll while a partial break can produce its aggregate roll.
  The selected status still passes through normal status immunity and
  secondary-blocker checks.
- Opposing move resolution suppresses target abilities for active Mold Breaker,
  Teravolt, and Turboblaze from Generation IV onward. Mycelium Might applies
  the same bypass to status moves from Generation IX onward; field and type
  immunities remain independent.
- Neutralizing Gas is represented through the shared state-aware ability
  predicate. An active Generation VIII+ holder suppresses other active
  abilities; Neutralizing Gas itself, canonical non-suppressible abilities,
  and an effective Ability Shield remain active. Calculator inputs, status
  eligibility, ordering, residuals, and reactive responses all consume that
  same predicate.
- Canonical move sound flags drive target eligibility: sound moves bypass
  Substitute, Soundproof blocks their target effects, and Mycelium Might only
  bypasses Soundproof when the move category is Status.
- Life Orb recoil is applied once per damaging move from Generation IV onward;
  Magic Guard suppresses it, while Sheer Force suppresses it only for a
  damaging move that has secondary effects.
- Endure is resolved at the transition boundary as a direct-damage floor, not
  as a protection effect; residual damage, recoil, and healing remain separate
  HP deltas. A direct hit reduced to 1 HP cannot trigger Destiny Bond.
- Drain HP effects are target-aware at the move and residual boundaries:
  Generation III+ Liquid Ooze converts draining recovery into attacker damage,
  Big Root increases the affected recovery amount by 30% from Generation IV,
  and Strength Sap/Leech Seed share the same handling. Magic Guard suppresses
  Liquid Ooze's indirect damage, and Dream Eater keeps its pre-Gen V exception.
- Derived Foresight state is stored on the affected Pokémon, and the calculator
  checks it per defender target. Legacy side-level `effects.foresight` remains
  an external compatibility input.
- Leech Seed facts are likewise target-specific through the Pokémon volatile
  state; Grass-type and already-seeded targets are rejected by the common
  volatile eligibility boundary, while legacy side-level `effects.seeded`
  remains an external compatibility input. Derived Yawn also uses the shared
  sleep-status predicate before creating its delayed volatile.
- Legal move enumeration honors modeled Taunt, Encore, Imprison, Disable, and
  Torment state. Encore and Disable store move names when derived; Torment uses
  last-move history to prevent consecutive reuse, and repeated Taunt/Encore
  applications are rejected at both the policy and resolution boundaries.
  Aroma Veil blocks Disable and Torment, while Soundproof blocks Perish Song
  at the shared volatile-eligibility boundary.
  Other move locks remain explicit future state fields.
- If an active Pokémon has no legal selectable move because every known move is
  disabled, out of PP, or blocked by a modeled lock, action enumeration exposes
  the canonical Struggle fallback. Struggle does not consume a move slot or PP,
  and its canonical recoil is applied through the ordinary move transition.
- Choice Band, Choice Scarf, and Choice Specs use a dedicated lock map updated
  when a move is recorded and cleared when that Pokémon switches; Magic Room,
  Embargo, and active Generation IV+ Klutz suppress the lock while their item effects are
  unavailable. Last-move history remains available for Encore and scoring
  without doubling as a Choice lock.
- Fake Out and First Impression are first-turn-only moves. When
  `firstTurnOutIds` is supplied, action enumeration and direct move resolution
  require the actor's active ID to be present; switching adds the replacement
  to that window and `beginNextTurn()` clears it. Fake Out remains Generation
  III+, while First Impression remains Generation VII+.
- `Action` describes intent only. It does not mutate `BattleState`.
- A voluntary switch requires a living active Pokémon; a forced switch may
  replace either a fainted active or a living active with a pending forced-
  replacement marker (phazing, pivot moves, emergency abilities, or item
  effects). Both transitions apply the replacement's entry hazards, reset
  battle-local stat/volatile state, and preserve stable party IDs. Major status
  persists by default, while the toxic counter resets.
   An available, unsuppressed Natural Cure holder clears its status when making
   an outgoing switch. An available, unsuppressed Regenerator holder instead
   heals one-third of max HP on the same outgoing switch. An explicit
   `SwitchAction.batonPass` contract preserves only the modeled outgoing stat
   stages and Substitute on the replacement; ordinary switches never infer that
   preservation, and forced replacements cannot use it. Sleep status persists,
   but its modeled counter resets to the fresh-entry value of three when the
   sleeping Pokémon re-enters.
- `recordMoveAction()` may persist a legal move intent and consume PP while a
  separate battle engine resolves the move. Generation III+ active Pressure
  holders add one PP cost per opposing target selected, while unavailable or
  suppressed Pressure does not. Active Generation III+ Leppa Berry restores up
  to ten PP (twenty with active Ripen) when the used move reaches zero and
  records the Berry as consumed;
  Magic Room, Embargo, Klutz, and pre-introduction states suppress that effect.
  It intentionally does not apply damage, status, boosts, hazards, or secondary
  effects.
- `BattleState.statBoostsThisTurnByPokemon` records positive stat-stage changes
  emitted by applied resolutions and is cleared by `beginNextTurn()`. Burning
  Jealousy uses this explicit current-turn ledger to burn opposing targets that
  were hit after raising a stat; it does not infer history from the target's
  final stage vector.
- Gigaton Hammer reuses `lastMoveUsedByPokemon` for its Generation IX same-move
  lock: the action is excluded and direct resolution fails when the current
  active appearance used Gigaton Hammer immediately before; using another move
  releases the lock.
- Scale Shot uses the shared damaging self-stage boundary to emit its Generation
  VIII+ post-hit Defense drop and Speed rise. Its calculator facts retain the
  canonical multi-hit flag, while a miss produces no self-stage change.
- Echoed Voice’s Generation V+ power ramp is resolved at the calculator adapter:
  consecutive uses read the actor’s existing move streak, cap at 200 base power,
  and reset when another move is used.
- Generation IV+ held Metronome uses that same prior successful move streak at
  the calculator boundary: the first repeat supplies one consecutive use, the
  multiplier caps at the canonical twofold maximum, and Magic Room, Klutz,
  switching, or a failed move removes the held-item contribution.
- Generation III+ Mental Herb consumes when an active mental volatile is
  applied and clears Infatuation, Taunt, Encore, Torment, Disable, and Heal
  Block together. Its item/provenance transition obeys the shared generation,
  Magic Room, and Klutz suppression boundary.
- Fury Cutter uses a dedicated `furyCutter` volatile for its Generation II+
  consecutive-hit power ramp. It doubles from 10 to a 160 cap, persists through
  turn boundaries, and clears on a miss, another move, or switching.
- `PokemonState.typeOverride: []` is the serializable typeless state;
  `undefined` still means species-derived types. Burn Up (Generation VII+) and
  Double Shock (Generation IX+) set this state after a successful use, and
  ordinary switching clears it.
- Relic Song uses the existing `speciesOverride` boundary for its Generation V+
  Meloetta form toggle: a successful use alternates Meloetta and
  Meloetta-Pirouette, while non-Meloetta users keep their current species.
  Ordinary switching clears the temporary form override.
- Fling reuses the calculator's held-item power and the shared secondary-effect
  boundary for its Generation IV+ item effects: Flame Orb burns, Light Ball
  paralyzes, Poison Barb poisons, Toxic Orb badly poisons, and King's Rock or
  Razor Fang flinches the eligible target. Shield Dust, Covert Cloak, Sheer
  Force, status/volatile immunities, misses, and protection prevent the added
  effect, while the thrown item is still consumed according to Fling's existing
  resource rule.
- Fling also models the canonical direct effects of Mental Herb and White Herb:
  Mental Herb clears the target's six disabling volatiles, while White Herb
  restores all negative target stat stages. These direct item effects are
  separate from Fling's secondary-status path, so Shield Dust and Covert Cloak
  do not suppress them; the thrown item is still consumed by the actor.
- Fling also activates the currently modeled Berry effects on the target:
  Oran/Sitrus and the five confusion Berries heal, Cheri/Chesto/Pecha/Rawst/
  Aspear/Lum cure their matching or supported statuses, and the five stat
  Berries raise their canonical stat.
  The five flavor-dependent Berries also use the target's known nature to
  apply their canonical confusion side effect, subject to Own Tempo.
  Kee and Maranga raise Defense and Special Defense, Lansat arms Focus Energy,
  Micle arms its two-turn accuracy volatile, and Starf samples one of the five
  battle stats for a +2 stage boost at its low-HP trigger. Ripen doubles Fling Berry healing and
  stat-stage effects where applicable; it does not alter direct volatile/status
  effects or held-item loss.
  Leppa restores the first zero-PP or partially depleted tracked move by ten
  PP, or twenty with Ripen. Natural Leppa consumption also follows the shared
  Berry-eating boundary: active Cheek Pouch heals one-third max HP and active
  Cud Chew captures the Berry for delayed replay. Cheek Pouch and Cud Chew are
  applied to the target for Fling as Berry-eating abilities; unsupported
  Berry-specific effects remain outside this focused slice. Unnerve is scoped
  to opposing active consumers: it does not block the holder from using Fling,
  but it suppresses the target's Berry-eating effect when the target is opposed
  by an active Unnerve holder. The thrown Berry is still consumed in that
  suppressed case.
- `Revival Blessing` keeps its fainted ally target as a stable party ID in the
  action and resolution. Generation IX+ resolution restores half of the target's
  max HP and clears major status; it does not mutate active slots or invent a
  replacement transition.
- Canonical status helpers retain their distinct target scopes in the same
  serializable resolution: Lunar Blessing applies quarter-HP healing and major
  status cleanup to living same-side active targets, Shelter and Take Heart
  emit self-stage changes, Spicy Extract emits target Attack/Defense changes,
  and Odor Sleuth applies the existing Foresight volatile.
- Canonical stage effects use the same serializable boost boundary: Aromatic
  Mist applies ally Special Defense, Defend Order and Extreme Evoboost apply
  their self boosts, and the four damaging self-drop moves emit actor-scoped
  negative stage deltas without suppressing their damage path.
- `applyDamageAction()` is a lower-level primitive for applying a caller-
  selected damage roll to legal move targets. It consumes PP and updates HP,
  but all other move consequences remain separate.
- `resolveMoveAction()` applies a serializable, already-resolved outcome
  atomically: damage, HP deltas, status, additive or absolute stat-stage
  changes, volatile effects, timed side effects, Substitute HP, explicit
  stat-stage resets, and field changes. Absolute stage updates are used for
  Psych Up, Guard Swap, and Power Swap; omitted stage keys remain unchanged.
  It does not decide accuracy,
  secondary-effect chances, recoil, or turn order; those belong to the battle
  engine that produces the outcome.
- `applyAction()` dispatches switches directly and moves through
  `resolveMoveAction()` when a resolution is supplied; it rejects unresolved
  move actions rather than fabricating their consequences.
- `sampleDamageResolution()` samples a calculator roll and records it in a
  `ResolutionTrace`. `deriveMoveResolution()` can consume explicit metadata or
  obtain the default source-aware move metadata, record accuracy/secondary
  rolls, and apply the resulting status/boost/volatile changes.
- `deriveMoveResolution()` is the first deterministic move-engine slice. It
  derives representable effects for common hazards, screens, weather/terrain,
  setup, status, weather-dependent recovery, Strength Sap, context-sensitive
  Curse, Substitute, deterministic ally healing (Heal Pulse, Floral Healing,
  Pollen Puff on allies, Life Dew, and Jungle Healing), status cleansing
  (Purify, Refresh, Heal Bell, and Aromatherapy), Aurora Veil’s weather
  prerequisite, model-backed Gravity/Magic Room/Wonder Room durations, G-Max side
  conditions and their durations, Haze’s
  all-active stat reset, Clear Smog’s target-only stat reset, and Defog’s
  hazard/target-side screen removal, including the legacy target Evasion drop,
  Rapid Spin’s own-hazard removal and Gen 8+ Speed boost, screen-breaking attacks,
  Ceaseless Edge/Stone Axe hazard placement, generation-specific Mortal Spin
  poison, sacrifice-and-boost setup moves, and Tidy Up
  cleanup, Court Change’s modeled side-condition swap, and
  Mist's timed stat-drop protection, Lucky Chant's timed critical-hit
  prevention, Crafty Shield's one-turn opposing-status protection,
  Fairy Lock's timed voluntary-switch lock, recoil/drain/self-fainting moves.
  Field rooms are explicit toggles: first use establishes their generation-gated
  five-turn duration, re-use clears the active room and its duration, and normal
  turn advancement removes expired room state. Magic Room suppression therefore
  follows the same field transition rather than being inferred from item state.
  Water Sport and Mud Sport use active-user volatiles before Generation VI and
  timed field effects in Generations VI–VII, with calculator power modifiers.
  Ion Deluge is represented as a one-turn Gen VI–VII field type-conversion
  effect for Normal moves.
  Flower Shield raises Defense for eligible active Grass-type Pokémon in
  Generations VI–VIII; Rototiller raises Attack and Special Attack for
  eligible grounded active Grass-type Pokémon in Generations VI–VII.
  Teatime consumes held Berries for all active Pokémon in Generation VIII and
  applies each Berry's shared modeled eat effect to its holder, then records
  the consumption provenance for Harvest/Recycle and Cheek Pouch. Cud Chew
  may arm for eligible holders because Teatime is an actual Berry-eating path.
  Coaching,
  Decorate, Acupressure, Swagger,
  Flatter, Psych Up, Guard Swap, and Power Swap use the same serializable
  stat-stage transition boundary. Stockpile/Swallow lifecycle is modeled, and
  the calculator adapter supplies 100/200/300 base power to Spit Up from its
  stored stack count. The Rapid Spin Speed boost and Mortal Spin
  poison remain canonical calculator metadata and are applied through the
  normal secondary-effect path.
  Future Sight and Doom Desire use the delayed-damage state lifecycle when
  calculator damage facts are supplied; their sampled damage is applied at the
  later turn boundary rather than at cast time.
  It also applies the explicit action gate for Truant, flinch, paralysis, sleep,
  freeze, confusion, and consecutive protection before accuracy and move
  effects are resolved. Calculator facts expose optional
  `ActionFacts.confusionDamage` for the actor's special 40-power physical
  self-hit; when present, a confusion failure samples that range and records
  the HP loss through `MoveResolution.hpDeltaByPokemon`. Other unsupported
  simulator-specific failure consequences remain caller-supplied.
  it also filters protected targets, calculator-confirmed damaging immunities,
  common type/ability/item status immunities, secondary-effect blockers, and
  existing major statuses. Unsupported mechanics remain caller-supplied or
  unimplemented. Generation-introduced stateful effects are gated at this
  boundary: hazards, terrain/weather setters, field rooms, screens, Defog,
  Aqua Ring, Ingrain, Roost, and Healing Wish/Lunar Dance do not create state
  before their canonical generation.
  The same eligibility boundary includes active Doubles ally auras: Sweet Veil
  blocks opposing sleep/Yawn and Aroma Veil blocks Attract, Taunt, Encore,
  Disable, Torment, and Heal Block for living allies. These checks honor
  suppression and Generation VI availability, and remain distinct from the
  target's own ability-bypass check.
  Pastel Veil extends the same active-ally boundary to Poison and Toxic in
  Generation VIII+; faint or suppressed holders do not protect an ally. On a
  valid switch entry, its status cleanup uses `statusByPokemon` plus a zero
  Toxic-counter transition for the holder and living active allies.
  Flower Veil is applied at both eligibility and boost-resolution boundaries:
  a living Grass-type target with an active Flower Veil ally rejects
  move-applied status/Yawn and negative stat stages, including entry hazards
  and Intimidate. Positive boosts and non-Grass targets remain unaffected.
- `getEffectiveMoveAccuracy()` and `deriveMoveResolution()` cover common
  accuracy modifiers and preserve per-target accuracy rolls in the resolution
  trace. The accuracy boundary also gates generation-introduced abilities,
  items, and Gravity: No Guard, Compound Eyes, Victory Star, Hustle, Lens
  items, Sand Veil, Snow Cloak, Tangled Feet, Keen Eye, Mind's Eye, Micle Berry,
  and evasion items are not applied before their canonical generation. Spread actions
  resolve those modifiers
  independently per target; target-scoped Lock-On/Mind Reader therefore only
  guarantees the locked target. Unmodeled accuracy/evasion interactions
  and uncertain states remain external facts. Friend Guard (Generation V+),
  Battery (Generation VII+), and Power Spot (Generation VIII+) are derived
  from a living active ally at the calculator boundary and honor ability
  suppression. Ability-derived terrain entry uses Generation VII+ for Surge
  abilities, and other ability availability is projected through the shared
  canonical generation map. Keen Eye (Generation III+) and
  Mind's Eye (Generation IX+) block negative Accuracy stages and make the
  holder's move accuracy ignore target Evasion stages and evasion items.
- The move-resolution eligibility boundary also blocks opposing priority
  moves against grounded targets under Generation VII+ Psychic Terrain and
  against targets with the generation-appropriate Dazzling, Queenly Majesty,
  or Armor Tail ability. Generation IX+ Armor Tail also protects a living
  active ally in Doubles. Airborne targets and same-side priority effects are
  not blocked by this boundary.
- Common status eligibility also honors generation-aware ability immunities,
  Safeguard, grounded Misty Terrain, and
  grounded Electric Terrain sleep protection, including Flying/Levitate/Air
  Balloon/Iron Ball grounding rules.
- Status-action scoring calls the same eligibility boundary, so a move blocked
  by those rules is scored as a no-op rather than selected as useful policy.
- `beginNextTurn()` advances the turn, decrements modeled volatile/side/field
  durations, removes expired effects, and clears first-turn/protection
  bookkeeping. `advanceTurn()` composes it with the modeled end-turn
  resolution.
- `deriveEndTurnResolution()` and `advanceTurn()` cover the modeled residual
  slice: burn/poison/toxic progression, Generation IV+ Poison Heal, weather chip, Salt Cure
  application and residual damage,
  Leech Seed, held-orb statuses, Leftovers/Black Sludge, G-Max residual side
  conditions, Yawn, Curse, and
  Perish Song. Generation III+ Speed Boost emits a one-stage Speed increase
  for each active holder, and Generation IV+ Bad Dreams emits one-eighth max-
  HP indirect damage for each opposing active sleeping target. Both use the
  active-ability boundary; Magic Guard suppresses Bad Dreams damage.
  Berry consumption in this boundary can also emit `movesByPokemon` for Leppa
  PP restoration, alongside item consumption, Berry recovery, status cures, and
  delayed Cud Chew replay.
  Burn and poison residuals retain their generation-specific denominators;
  Generation IV+ Heatproof halves burn residual damage after that denominator
  is applied.
  Common weather-dependent residual abilities are also explicit: Rain Dish and
  Dry Skin and Hydration heal or cure in Rain; Dry Skin and Solar Power apply
  their Sun interaction,
  and Ice Body heals in generation-appropriate Hail/Snow. Suppressed abilities
  do not contribute; Magic Guard suppresses the damage side of these effects.
  Moody is modeled only from Generation V onward and respects the active-ability
  boundary; this fork retains Accuracy and Evasion in its modeled stat pool,
  including Generation VIII+.
  Emergency Exit and Wimp Out may add a living holder to
  `EndTurnResolution.forcedSwitchByPokemon` when residual damage crosses the
  holder from above half HP to at or below half HP; applying that resolution
  feeds the same `pendingForcedSwitchIds` queue used by move responses.
  Stat-stage normalization in move resolution, White Herb restoration, and
  calculator-side Shell Smash projection use the same generation-aware ability
  availability map, so
  pre-introduction Contrary/Simple and stat-drop blockers do not alter older
  generations. The explicit map covers Run & Bun overlays and the canonical
  calculator ability tables cover inherited abilities such as Mountaineer;
  unknown custom names remain available, but known names never silently become
  generation-agnostic inputs.
  Weather residuals retain their historical boundaries: Sandstorm exists from
  Generation II and deals one-eighth in Generation II before using one-sixteenth
  from Generation III onward; Hail deals one-sixteenth from Generation III
  through VIII; Overcoat protects from weather damage from Generation V onward;
  and Rain Dish restores one-sixteenth from Generation III onward.
  Nightmare residuals are active only in Generations II–VII, Curse residuals
  from Generation II onward, and Salt Cure residuals from Generation IX onward.
  Magic Guard’s indirect-damage suppression is active only from Generation IV;
  pre-introduction states do not suppress weather, status, drain-conversion, or
  contact-response damage.
  Rock Head blocks modeled recoil only from Generation III onward; pre-introduction
  Rock Head strings remain data and do not suppress recoil.
  Shed Skin is modeled as a generation-3+ one-third end-of-turn status cure,
  including sleep and Toxic counter cleanup.
  Healer is modeled in generation 5+ Doubles as a 30% end-of-turn cure for
  active allies, including Toxic counter cleanup; Singles has no eligible ally.
  `PokemonState.lastConsumedItem` distinguishes consumed items from Knock Off,
  Trick, or other forced removals, allowing generation-5+ Harvest to restore a
  consumed Berry with its normal 50% chance, or guaranteed in unsuppressed Sun.
  Grassy Terrain heals grounded active Pokémon by 1/16 in generation 6+;
  shared grounding honors Gravity, Flying/Levitate, Air Balloon, Iron Ball,
  Magic Room, and Generation IV+ Klutz state.
  Aqua Ring and Ingrain are explicit persistent self-volatiles with 1/16
  end-of-turn recovery; Ingrain also grounds the user and blocks voluntary
  switching until the volatile is cleared by a switch or external event.
  Magnet Rise is a generation-4+ five-turn self-volatile that makes the user
  airborne for shared grounding and Ground-type damage, except while Gravity is
  active; the calculator adapter passes that explicit grounding override into
  the fork.
  Roost is a one-turn self-volatile for a successful recovery below full HP;
  it makes the holder grounded and removes its Flying type for grounding,
  terrain, residual, and calculator-fact checks until the turn boundary.
  Telekinesis is a generation-5+ three-turn target volatile that makes the
  target airborne for grounding and Ground-type damage checks; Gravity rejects
  new Telekinesis and clears active Magnet Rise/Telekinesis volatiles.
  Smack Down (generation 5+) and Thousand Arrows (generation 6+) create a
  switch-persistent `landed` volatile on an ungrounded non-Substitute target,
  clear Magnet Rise/Telekinesis, and make Flying targets vulnerable to Ground
  damage and grounded effects until they switch.
  Generation III+ Cloud Nine and Air Lock suppress weather chip, weather-based healing/damage,
  and Hydration at this boundary. Safety Goggles suppress weather chip from
  generation 6 onward, subject to Magic Room and Generation IV+ Klutz item suppression.
  Residual held-item effects use the same Magic Room/Generation IV+ Klutz boundary: Leftovers,
  Black Sludge, Flame/Toxic Orb, Sitrus/Oran, and confusion berries do not
  activate while their item effects are suppressed. Generation III+ Oran heals
  10 HP at or below half HP; Sitrus heals 30 HP in Generation III and one-quarter
  max HP from Generation IV onward, with Cheek Pouch adding its normal one-third
  max-HP recovery when applicable. Active Ripen doubles Berry healing and
  stat-stage effects, but not Berry Juice or Cheek Pouch. Generation III+ Liechi,
  Ganlon, Salac, Petaya,
  and Apicot are consumed at or below one-quarter max HP and raise Attack,
  Defense, Speed, Special Attack, and Special Defense respectively; Generation
  IV+ Gluttony changes that trigger to one-half max HP. Their stat-stage deltas
  pass through Simple/Contrary normalization and the [-6, 6] clamp.
  Micle Berry uses the same Generation IV+ residual trigger, consuming the item
  and arming a two-turn `micleBerry` volatile. The next non-OHKO move receives
  the canonical 4915/4096 accuracy multiplier, and the volatile is consumed at
  that accuracy boundary. Magic Room, switching, and unavailable item effects
  prevent activation.
  Generation IV+ Sticky Barb deals one-eighth max-HP residual damage through
  the same item-suppression and Magic Guard boundary. A successful direct
  contact hit transfers an active Sticky Barb to an attacker with no item when
  Sticky Hold does not prevent removal; Substitute-only, non-contact, and
  suppressed-item paths do not transfer it.
  They intentionally collapse simultaneous residual deltas; switch order,
  replacement, and unmodeled end-of-turn events remain external.
- `getActionOrderFacts()` and `orderActions()` provide the execution-order
  boundary for simultaneous intents: switch priority, move priority, effective
  speed, Trick Room reversal, common boost/status/weather/item speed effects,
  common generation-gated priority: Prankster from Generation V, Gale Wings
  from Generation VI, and Triage from Generation VII, plus reproducible speed
  ties.
  Run & Bun's fork-specific order rules are applied here as well: Paralysis
  always quarters Speed, and Gale Wings boosts Flying priority regardless of
  current HP.
  Quick Claw is an explicit 20% sampled item-priority fact (callers can provide
  `itemRollsByPokemon` for reproducibility); Custap Berry is deterministic at
  or below 25% HP, or at or below 50% HP with Generation IV+ Gluttony. Positive-
  priority moves and Generation IX Mycelium Might status moves do not consume
  it. Quick Feet is active from Generation IV; Swift Swim and
  Chlorophyll from Generation III; Sand Rush from Generation V; and Slush Rush
  and Surge Surfer from Generation VII. Stall is Generation IV+ and Mycelium
  Might is Generation IX+. Magic Room and Generation IV+ Klutz suppress held-item speed and order
  effects, including Choice Scarf, Iron Ball, Lagging Tail, Full Incense, Quick
  Claw, and Custap Berry; Klutz retains the calculator's power-item exceptions.
  Item consumption remains a battle-engine transition: `resolveMoveAction()`
  consumes an eligible Custap Berry after the order boundary grants priority.
  Full action legality and uncommon item interactions remain explicit future
  facts.
  `PokemonState.itemLost` distinguishes an item-less Pokémon from one that
  lost a held item; Unburden doubles effective Speed from generation 4 onward
  until the Pokémon switches, and item-removal transitions set this flag.
- Move stat changes are normalized through the same transition boundary:
  Contrary reverses deltas, Simple doubles them, Clear Body/White Smoke/Full
  Metal Body/Clear Amulet block incoming drops, and common self-drop attacks
  are represented explicitly. Canonical self-stage moves including Amnesia,
  Defense Curl, Withdraw, Double Team, Minimize, and Charge, plus common
  accuracy/evasion and defensive/offensive target drops, use the same `acc` /
  `eva`-aware stage model and generation gates. Poison Gas/Toxic Thread,
  direct confusion moves, and Topsy-Turvy use the same status/volatile and
  absolute-stage transition boundaries; Captivate checks known opposing
  genders before applying its drop. Mean Look, Block, and Spider Web use a
  source-aware, switch-persistent `trapped` volatile; source switching or
  fainting releases that trap, while legacy source-less traps remain
  compatibility inputs. Generation VII+ Anchor Shot and Spirit Shackle add
  the same source-aware permanent trap after a positive damaging hit. Pain
  Split balances current HP, and
  Psycho Shift transfers a known major status through the same eligibility
  boundary. `PokemonState.typeOverride` represents current battle types and
  is cleared on switch; `getEffectiveTypes()` and the calculator adapter use it
  for damage, grounding, status, terrain, and entry-hazard checks. Soak, Magic
  Powder, Forest's Curse, Trick-or-Treat, Reflect Type, Camouflage, and
  Conversion and Conversion 2 populate that boundary where their deterministic
  type result is representable; Conversion 2 keeps its generation-specific
  self/adjacent-target rule and uses the known last-move source when available.
  Color Change is a post-hit defender transition: a surviving Generation V+
  holder that takes direct damage from a non-Status move adopts that move's
  resolved type, unless the type is already present or the attacker's ability
  suppression boundary ignores the defender's ability. A KO, miss, immunity,
  Substitute-only hit, or Mold Breaker-style bypass does not create this
  override.
  Protean and Libero are pre-move attacker transitions: the shared calculator
  projection and move engine resolve the move's type before damage, then record
  the resulting `typeOverride`. Generation VI+ Protean and Generation VIII+
  Libero may update that type on each eligible move through Generation VIII;
  Generation IX records `typeChangeUsed` and permits only the first eligible
  type change per active appearance. Called-move wrappers and suppressed or
  unavailable abilities do not consume the marker; ordinary switching clears
  both the type override and the marker.
  Forecast supplies Castform's weather-derived Fire, Water, Ice, or Normal
  identity and synchronizes its Castform form at switch entry, weather changes,
  end turn, and weather expiry. Flower Gift similarly synchronizes Cherrim's
  Sunshine Form with active Sun, while Hunger Switch toggles Morpeko's form at
  the end-turn boundary. These form transitions remain separate from the
  calculator's direct Flower Gift stat modifier. Switch-entry weather-form
  evaluation uses the post-switch active roster, so an outgoing Cloud Nine or
  Air Lock holder no longer suppresses the incoming form, and an incoming
  suppressor takes effect immediately.
  Mimicry is the terrain-driven exception: Generation VIII+ active holders are
  assigned the terrain's canonical type at terrain start, terrain replacement,
  and switch entry, then restore base types when terrain clears or expires;
  suppression and the normal switch cleanup boundary remain authoritative.
  Switch-entry side-effect changes use `SwitchEntryResolution.sideEffectsBySide`
  and are merged independently for both sides. Screen Cleaner uses that map to
  clear only Reflect, Light Screen, and Aurora Veil while preserving unrelated
  side effects.
  Intrepid Sword and Dauntless Shield use persistent
  `PokemonState.intrepidSwordTriggered` and
  `PokemonState.dauntlessShieldTriggered` markers. Their Generation VIII+
  entry boosts are additive, stage-clamped, and do not repeat after a switch.
  `PokemonState.abilityOverride` similarly represents a
  move-induced effective ability and is cleared on switch; Role Play, Skill
  Swap, Entrainment, Simple Beam, Worry Seed, and Doodle populate this
   boundary through the generation-aware ability projection; they must not
   copy a known ability before its introduction generation. `PokemonState.abilitySuppressed` is a separate temporary flag for
   Gastro Acid-style suppression, so a suppressed ability remains recoverable
   and is restored by switching; the original `abilityOn` caller fact is not
   overwritten. `PokemonState.statOverrides` is the calculator boundary for
   current raw battle-stat values; Power Trick and Gen 9 Power Shift exchange
   raw Attack and Defense, Speed Swap exchanges raw Speed, and Guard Split /
   Power Split average the relevant raw values while preserving stat stages.
   These overrides are cleared on switch. `PokemonState.baseStatsOverride`
   remains available for explicit species-base-stat modeling, but is not used
   for these raw-value transforms.
   `BattleState.lastMoveUsed` records the battle-wide source for Copycat;
   `lastMoveUsedByPokemon` records the current active appearance's last move
   and is cleared on switch, while `lastMoveByPokemon` remains historical for
   scoring and Encore. `lastMoveTargetedByPokemon` records switch-scoped
   successful target history for Mirror Move; `lastMoveTargetIdsByPokemon`
   preserves the selected target slots for Instruct, while
   `lastDamagingMoveByPokemon` separately records the switch-scoped damaging
   history required by legacy Conversion 2. Sketch and Mimic replace the
   selected move slot through
   `MoveResolution.movesByPokemon`, while Copycat and Mirror Move expose their
   selected move through `copyMoveByPokemon` for the caller's immediate
   execution boundary.
   Metronome and Sleep Talk expose `calledMoveByPokemon` at the same immediate
   caller-execution boundary; they do not silently apply the called move.
   A successful Generation VII+ dance move also emits active Dancer holders at
   that boundary, with `calledMoveExternalByPokemon` marking the copied move so
   the caller does not recursively retrigger Dancer. Opposing Dancer holders
   target the original actor; same-side holders preserve the original target
   slots.
   Nature Power uses that boundary for its generation/terrain-selected move;
   environments that are not represented in `BattlefieldState` use the plain
   or link-battle fallback.
   Assist uses the same boundary for an eligible move drawn from other party
   members; the party pool remains separate from the active move set.
   Me First consumes a caller-seeded `selectedMoveByPokemon` entry for a
   pending same-turn opponent intent. Executing an action removes that actor's
   pending entry; the next-turn boundary clears leftovers. Its copied move and
   1.5x-power/accuracy modifiers are emitted through the called-move boundary.
   Instruct reads the target's current-appearance last move and target slots,
   then emits the target actor plus its repeated move and target slots through
   the called-move boundary. Switch cleanup clears those current-appearance
   records so prior occupants cannot be instructed accidentally.
  Transform uses `speciesOverrideByPokemon` plus the same type, ability, raw
  stat, stage, and move-set boundaries to copy a target without overwriting
  the roster species or HP; opposing Good as Gold blocks it only from
  Generation IX onward, and ordinary switching clears the entire temporary
  transformed state.
  Imposter and Trace are switch-entry copy transitions. `Imposter` (Generation
  V+) emits species/type/ability/stat/move overrides plus absolute copied
  stages for a legal opposing active; copied moves are capped at five PP in
  Generation V+ and Substitute or an already transformed target blocks the
  copy. Ability Shield blocks the ability override while preserving the other
  copied fields. `Trace` (Generation III+) emits only a randomly selected,
  traceable opposing active ability and is blocked by Ability Shield. The
  serializable `SwitchEntryResolution` maps preserve null-vs-absent reset
  semantics: `abilityOverrideByPokemon: null` restores the holder's base
  ability, while `noAbilityByPokemon: true` explicitly projects No Ability.
  Direct `applySwitchAction()` callers may inject a finite sampler for
  deterministic tests.
   `MoveResolution.forcedSwitchByPokemon` records a successful phazing request;
   Roar/Whirlwind are gated to Gen 2+, Dragon Tail/Circle Throw to Gen 5+, and
   Suction Cups/Ingrain prevent the request when active.
- `lastDamageTakenByPokemon` records the most recent positive direct HP damage
  for the current appearance, excluding Substitute damage. It retains the
  actual post-Endure amount, source Pokémon, move category, move name, and
  turn. For sampled multi-hit resolutions it records only direct HP damage
  after a Substitute breaks; later hits stop at the first KO. The record
  survives into the immediately following turn for
  Counter/Mirror Coat/Metal Burst, expires after that window, and clears on
  switching. Those moves emit fixed damage from this state rather than asking
  the calculator to invent a base-power result: Counter and Mirror Coat return
  2× matching Physical/Special damage, while Metal Burst returns 1.5× damage.
- Focus Punch is Generation III+ and fails when the actor has already taken
  positive direct damage during the current turn. Damage retained from the
  previous turn does not interrupt the next Focus Punch.
- `PokemonState.volatile.bide` stores the locked move's remaining turns,
  accumulated direct HP damage, and latest attacking source. Bide excludes
  Substitute damage but continues accumulating later hits after a Substitute
  breaks, releases for twice the stored amount on its final locked action, and
  clears without damage when nothing was stored. Generation I and II use their
  longer variable durations; later generations use two turns.
- `PokemonState.volatile.rollout` stores the consecutive Rollout/Ice Ball move,
  hit count, and lock timer. The calculator adapter raises canonical base power
  by 2× per prior successful hit; a miss, switch, or fifth hit clears the
  sequence, and the chooser exposes only the locked move while it is active.
- `PokemonState.volatile.rampage` stores an Outrage, Thrash, or Petal Dance
  lock and its remaining turns. The move engine keeps the actor on that move
  and applies a sampled confusion duration when the final locked action ends.
  Generation IX Raging Fury uses the same lock and post-lock confusion
  boundary, with its canonical generation gate.
- `PokemonState.volatile.recharge` stores the move that forces a recharge turn.
  The forced turn is exposed as a synthetic no-target action, does not spend
  PP or deal damage, and still leaves switching available.
- `PokemonState.volatile.charge` stores canonical two-turn damaging moves,
  their locked target IDs, and the remaining charge timer. The first action
  creates this state without calculator damage; the next action releases the
  move and clears it. Power Herb and the canonical Sunny weather shortcuts are
  represented at the move-engine boundary. Generation VI+ Geomancy reuses the
  charge state with a self target, then applies +2 Special Attack, Special
  Defense, and Speed on release; Power Herb applies those boosts immediately,
  and the release action does not consume a second PP.
- `Electro Shot` is a Generation IX canonical charge move. Its charge release
  raises Special Attack by one stage; Rain and Power Herb skip the charge turn
  while preserving the same immediate boost. Because the bundled calculator
  fork predates the move, the AI metadata boundary supplies its canonical
  130-power Special Electric fallback and calculator-compatible move shape.
- `PokemonState.volatile.glaiveRush` is a Generation IX one-turn vulnerability
  marker created after a successful Glaive Rush. While active, incoming moves
  targeting that PokÃ©mon receive sure-hit accuracy and double calculator damage;
  the multiplier is applied before Sturdy/Focus Sash full-HP caps, and the marker
  expires at the next active turn boundary.
- `PokemonState.volatile.uproar` stores Uproar's canonical move name and its
  2–5-turn lock. While active, sleep status application is blocked globally;
  starting Uproar wakes active Pokémon and switching clears the lock.
- Fly, Dig, Dive, Bounce, Phantom Force, and Shadow Force mark their charge
  turn as semi-invulnerable in both calculator facts and engine target
  eligibility; canonical bypass moves remain explicit exceptions.
- `PokemonState.volatile.lockOn` stores the target of Lock-On or Mind Reader's
  next-move guarantee. The accuracy boundary returns sure-hit facts only for
  that target, and the move engine consumes the volatile on the next attempted
  move.
- `PokemonState.volatile.partiallyTrapped` is separate from permanent
  `trapped`: damaging Bind/Clamp/Fire Spin/Infestation/Magma Storm/Sand Tomb/
  Snap Trap/Thunder Cage/Whirlpool/Wrap hits store source, move, and timer.
  The target cannot voluntarily switch, receives generation-aware residual
  damage, and is released when the source switches or faints.
- `PokemonState.volatile.nightmare` is a Generation II–VII sleep-scoped
  volatile. Nightmare fails against an awake target, deals one-quarter max HP
  residual damage while the target remains asleep, and clears when it wakes or
  switches.
- `PokemonState.volatile.electrified` is a Generation VI+ one-turn target
  volatile. The target's next move is adapted as Electric at the calculator
  boundary, then the volatile is consumed; it also expires at the turn
  boundary.
- `PokemonState.volatile.throatChop` is a Generation VII+ two-turn target
  volatile. While active, sound-flagged moves are excluded from action
  enumeration and fail at direct-resolution boundaries; the marker is
  created only after a positive Throat Chop hit and expires through the normal
  volatile-duration transition.
- `PokemonState.volatile.shellTrap` is a Generation VII+ one-turn armed trap.
  Shell Trap is a status/setup action at the policy boundary; a successful
  contact move that deals damage to the armed active target consumes the trap
  and applies the canonical Fire reaction damage to the contact user. Non-
  contact moves leave the trap armed until the turn boundary.
- `PokemonState.volatile.octolock` is a Generation VIII+ source-scoped trap
  marker paired with `trapped`. While its source remains active, the target
  receives end-turn Defense and Special Defense drops; source switching or
  fainting clears both trap markers.
- `moveStreakByPokemon` preserves consecutive move use so rules such as the
  two-turn Protect lockout do not have to infer history from human strings.
- `ScoreOutcome.probability` values for one evaluation sum to 1.
- The policy now gives dedicated, fixture-covered scores to the documented
  support/control cases for Fling, Role Play, Coaching, Trick/Switcheroo,
  Encore, Counter/Mirror Coat, Focus Energy/Laser Focus, sleep/poison
  synergies, Taunt against active screens/Defog/Trick Room, and Rest's full-heal/sleep-cure
  policy. Belly Drum scoring accounts for the post-drum HP boundary and active
  Sitrus Berry survival, including Heal Block suppressing the Berry recovery.
  White Herb clears resulting negative stages after move and
  switch-entry stat changes, consumes the item, and Shell Smash action facts
  project the resulting stages before calculating incoming damage. Rest scoring
  uses the same modeled incoming move set as KO checks;
  non-highest Power-Up Punch and Charge Beam use the same setup/survival
  boundary as their non-damaging setup counterparts, with Power-Up Punch
  retaining its Unaware exception and Charge Beam losing setup value against
  Unaware;
  `ActionFacts.opponentMaxDamage` exposes the maximum damage to the evaluated
  actor, including the actor's entry in `damageByTarget` for Doubles spread
  moves, for either supported evaluation side, without leaking calculator
  result objects into the policy. These rules consume normalized
  facts; they do not inspect calculator description strings.
  `ActionFacts.defenderIncapacitated` exposes the same setup-policy boundary
  for sleeping, frozen, recharging, and Truant-loafing targets.
  Protect-family scoring applies the residual/context and consecutive-use rules
  to personal protection variants such as King’s Shield, while Wide Guard,
  Quick Guard, and Mat Block remain side-level protections at the transition
  boundary.
  Ability fields in canonical `ActionFacts` represent only currently active
  abilities; suppressed or explicitly disabled abilities are omitted from the
  calculator `Pokemon` and `Move` projections as well, so immunity, damage
  modifiers, Skill Link hit counts, and Max-move selection cannot leak through
  the state boundary.
  Item fields likewise represent held items whose effects are currently
  available: Magic Room, Embargo, active Generation IV+ Klutz, and Corrosive Gas suppression
  remove ordinary item facts, while Klutz preserves the calculator's power-item
  exceptions. Corroded item identity remains explicit in the battle state.
  Generation VI+ Assault Vest blocks Status-category moves at action enumeration
  and direct resolution while its item effect is active. Magic Room, Embargo,
  Klutz, and pre-Generation-VI states suppress that restriction.
  The same effective item is used for item-driven type identity and Ghost/type
  eligibility checks; suppressed Arceus/Silvally item forms do not leak through
  those non-damage boundaries.
  In Doubles, calculator-derived multi-hit moves receive the documented
  one-point damaging-action bonus through `ActionFacts.isMultiHit`.
  Guaranteed damaging Atk/SpAtk drops use the split of the stat being lowered,
  not the attack category of the move: this includes Mystical Fire and the
  physical Spirit Break as Special-side debuffs, alongside the existing
  Trop Kick, Skitter Smack, and related rules.
  In Doubles, Helping Hand and Follow Me require a living active partner,
  consult its caller-seeded move intent, and score as unusable when that
  partner is using a status/support move; they are no-ops without that partner.

## Knowledge model

The initial model assumes the Run & Bun AI has the complete information called
out in the AI documentation: opposing moves, stats, abilities, and items are
known. Hidden-information tracking can be added later without changing the
action or scoring contracts.

## Calculator boundary

The adapter should construct calculator objects from `PokemonState`,
`MoveState`, and `BattlefieldState`. It should normalize the calculator’s
damage representation into `DamageFacts` rather than exposing `Result` to
scoring rules. Human-facing descriptions remain a UI concern.

Calculator `Result.recoil()` keeps its display-oriented `recoil` value and
also exposes `recoilHP` for exact transition deltas. Generic consumers should
use that machine-readable field rather than reverse-engineering percentages
from descriptions; the AI resolution boundary applies the same canonical
fractions to its sampled damage facts.

The policy layer may derive additional facts such as type effectiveness,
opponent speed, HP thresholds, and per-target damage. Move-specific exceptions
belong in scoring rule tables; they must not be implemented by changing the
generic damage formula.

The adapter also exposes the active partner's ability/item/moves and the
opponent's last-move category, confusion, and infatuation state where a
documented doubles or status-synergy rule needs them. It derives whether the
acting Pokémon has a flinch move from the same canonical/overlay secondary
metadata used by move resolution.
In Doubles, active ally Friend Guard, Battery, and Power Spot abilities are
derived at this boundary with generation gates and self-exclusion; legacy
side-effect booleans remain supported as compatibility inputs.
Global aura abilities and Sun-conditional Flower Gift are likewise derived
from active Pokémon here with generation gates and ability suppression; legacy
field booleans remain supported as compatibility inputs.
The shared Cloud Nine/Air Lock predicate also suppresses weather accuracy
abilities, weather Speed abilities, and Flower Gift consistently across the
accuracy, order, and calculator boundaries.

## Known boundaries

The engine intentionally models a focused, serializable battle-state slice; it
does not claim to derive every volatile effect, residual ordering detail,
uncertain accuracy interaction, or simulator-specific turn-order event.
Canonical move accuracy/secondaries, sequential calculator-backed multi-hit
damage for core barriers, selected per-hit contact and KO reactions, accuracy
and evasion stages (including Wonder Skin and Gen 9 Illuminate), common target
eligibility, common entry hazards, the documented Run & Bun overlays, and the
common residual slice through `advanceTurn()` are supported.

Remaining uncommon accuracy interactions, exact residual interleaving, and
encyclopedia-scale ability edges stay **caller-owned or parked** until a
decision-useful gap appears. Add focused engine modules with matching fixtures
rather than guessing in the chooser or calculator formula. See the ranked
backlog in [`VALIDATION.md`](VALIDATION.md).

Browser presentation must call the HTTP/`runbuncalc-ai` API; it must not embed a
second battle model.
