# Choice locks, move history, and copied moves

Choice-item locks vs. move history, the `lastMoveUsed*` sources, Metronome and
Sleep Talk, Dancer, Assist, Me First, Instruct, Transform, Imposter, Trace, and
Conversion.

Part of the Run & Bun engine data rules. Index and the surrounding
architecture rules live in [`AGENTS.md`](../../AGENTS.md).

---

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
