# Switch entry, forced switches, and trapping

Entry hazards and their blockers, switch-entry ability responses, Intimidate
and its counter-abilities, forced and move-induced replacements, ability and
move trapping, and ordinary switch reset.

Part of the Run & Bun engine data rules. Index and the surrounding
architecture rules live in [`AGENTS.md`](../../AGENTS.md).

---

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
