# Move resolution and turn-local gates

Action selection vs. state mutation, `deriveMoveResolution()`, action-failure
gates, delayed and locked moves, damage-history responses, and target-scoped
volatiles.

Part of the Run & Bun engine data rules. Index and the surrounding
architecture rules live in [`AGENTS.md`](../../AGENTS.md).

---

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
