# Validation Status

The repository now has separate focused gates for the calculator and the Run &
Bun AI layer:

```sh
cd ai
npm test
npm run lint

cd ../calc
npm run compile
npm run lint
npm test
```

The root gate intentionally does not install or execute the auxiliary
`import/` generator. For import-pipeline changes, run `npm ci` and
`npm test` from `import/` separately; its generated set files are UI data, not
AI or calculator source. The importer compiles and lint-checks through its
TypeScript 7 `tsc` gate. The GitHub Actions test job runs that separate import
install/test step after the root gate.

The AI test command discovers every compiled `dist/test/*.test.js` fixture, so
new focused fixtures are included automatically. The decision fixture also
checks bounded chooser randomness and rejects empty or non-finite score samples.

The AI fixture suite covers action enumeration, target semantics, calculator
adaptation, damage normalization, scoring rules, status/setup rules, switching,
move-resolution rules, volatile/timed effect lifecycle, source-aware accuracy and
secondary-effect rolls, turn-local action gates (sleep, paralysis, freeze/thaw,
flinch, confusion including calculator-backed self-hit damage, and consecutive protection), delayed Future Sight damage,
Run & Bun order overrides (Paralysis, Gale Wings, and Quick Claw/Custap item priority), Magic Room/Generation IV+ Klutz held-item suppression including pre-Gen-IV behavior, weather ability residuals, G-Max side conditions, confusion/flinch volatile expiry, Toxic counters, and secondary sleep state, and immutable transition
bookkeeping, Destiny Bond consumption, sleep re-entry reset, and permanent weather/terrain ability entry.
The EV-removal fixture also covers the older-generation calculator default:
serialized EV maps cannot change AI damage or raw-stat projections even in
Generation II, where the inherited calculator otherwise supplies a nonzero
default.
The switch-ability fixture covers Arena Trap, Magnet Pull, and Shadow Tag
generation, grounding, typing, suppression, Ghost escape, self-immunity, and
forced-replacement boundaries at both action and transition levels, including
the pivot-switch bypass boundary for trapped and airborne users, and Shed Shell
escape versus item suppression and hard locks. It also covers Generation VI+
Ghost immunity to move-created trapping and permanent-trap action filtering,
including source-less No Retreat hard locks that escape items and Ghost typing
must not bypass.
The Pressure fixture covers Generation III availability, one extra PP cost per
opposing Pressure target, and suppression/ordinary-ability boundaries through
the move-recording transition.
The Leppa fixture covers zero-PP restoration capped by max PP, Ripen's
Generation VIII +20 PP behavior, natural Cheek Pouch healing, natural Cud Chew
capture, delayed Cud Chew Leppa PP restoration, consumption provenance, and
Generation/Magic Room/Embargo/Klutz suppression boundaries.
The Revival Blessing fixture covers Generation IX fainted same-side party
target enumeration, half-HP revival and status cleanup, no-fainted-ally
rejection, and the pre-Generation IX boundary at both action and direct-
resolution boundaries.
The canonical-status fixture covers Lunar Blessing healing and cleansing,
Shelter and Take Heart self-stage/status behavior, Spicy Extract's mixed target
stage changes, Odor Sleuth's Foresight marker, and no-op/direct-failure
boundaries for all five moves.
The canonical-stage-effects fixture covers Aromatic Mist ally boosting,
Defend Order and Extreme Evoboost self boosts, Armor Cannon/Dragon Ascent/
Headlong Rush/Ice Hammer self drops, Coil/Hone Claws Accuracy boosts, and saturated-stage action/direct-failure
boundaries where applicable.
The Raging Fury fixture covers the Generation IX gate, 2-turn rampage lock,
forced same-move enumeration, and post-lock confusion transition.
The PP-legality fixture covers Spite and Eerie Spell last-move lookup, tracked
PP reduction, missing/zero-PP failure, unknown-PP compatibility, and the
Generation VIII Eerie Spell boundary at both action and direct-resolution
boundaries.
The dedicated self-resource fixture also verifies that action enumeration and
direct resolution agree for full-HP Rest/Swallow, while the status-target
fixture verifies that Rest also rejects sleep-blocking abilities and grounded
Electric/Misty Terrain. It also covers Stockpile-family energy,
Belly Drum, Substitute, Clangorous Soul, Fillet Away, No Retreat, and
Stuff Cheeks prerequisites, with Struggle remaining the fallback when a
Pokémon has no selectable move.
It also covers target-dependent no-ops for Teatime, Acupressure, Psych Up,
Guard Swap, and Power Swap at both action and direct-resolution boundaries.
The status-legality fixture covers repeat-marker and move-history prerequisites
for Encore, Disable, Taunt, Torment, Leech Seed, Perish Song, Foresight,
Electrify, Octolock, Miracle Eye, Gastro Acid, Embargo, Heal Block, and
trapping moves at both boundaries.
The support-legality fixture covers full-HP recovery, Refresh, Purify with a
Doubles ally, Pain Split, Life Dew, and team cleansing prerequisites, while
preserving Pollen Puff's valid opposing-damage branch.
The field-legality fixture covers already-maxed hazards, screens, Aurora Veil,
Tailwind, side protections, Fairy Lock, Water Sport/Mud Sport, Ion Deluge, and
repeated weather/terrain setters at both action and direct-resolution
boundaries, while preserving Trick Room, Magic Room, and Wonder Room toggles.
It also covers repeated Gravity, which is a one-way field setter rather than a
toggle.
The volatile-legality fixture covers repeated Aqua Ring, Ingrain, Magnet Rise,
Magic Coat, and Snatch, plus Attract, Yawn, Leech Seed, Telekinesis, and
Nightmare, including same-gender Attract success under the Run & Bun
gender-independent rule, at both action and direct-resolution boundaries.
The Grudge fixture covers Generation III gating, repeated-use rejection,
faint-triggered attacker PP zeroing, and Substitute/Endure exclusions at the
move-resolution transition boundary.
The utility-legality fixture covers no-op Defog, Court Change, Steel Roller,
Flower Shield, and Rototiller cases, while preserving selectable effectful
targets and field states.
The transition-legality fixture covers Healing Wish, Lunar Dance, Shed Tail,
and Psycho Shift prerequisites at both action and direct-resolution boundaries,
including valid replacement and status-bearing cases.
The setup-legality fixture covers saturated pure self-boost moves at both
boundaries, while preserving compound Shell Smash and damaging Power-Up Punch
cases.
The stage-legality fixture covers saturated Growl, Screech, and Captivate at
both boundaries, including Captivate's explicit gender rule, while preserving
damaging Snarl when its stat drop is capped.
The item-legality fixture covers no-op Bestow, Trick, and Switcheroo actions,
valid transfers, and Sticky Hold protection at both action and direct-resolution
boundaries.
The volatile-confusion-legality fixture covers repeated Confuse Ray, Sweet Kiss,
Supersonic, and Teeter Dance, Own Tempo protection, and preserves damaging
Chatter when confusion is already present.
The stage-reset-legality fixture covers no-op Haze and Topsy-Turvy actions at
both boundaries, preserves their useful reset cases, and keeps damaging Clear
Smog selectable when no stage reset is needed.
The ability-legality fixture covers repeated Role Play, Skill Swap, Doodle,
Simple Beam, Worry Seed, and Entrainment, plus Generation IX Ability Shield
protection for pure ability changes and Gastro Acid. It also verifies that
Magic Room suppresses Ability Shield, while preserving useful ability changes
at the action and direct-resolution boundaries.
The stat-transfer-legality fixture covers equal-state Speed Swap, Guard Split,
Power Split, Heart Swap, Power Trick, and Power Shift, while preserving useful
raw-stat and stage exchanges at both boundaries.
The instruct-legality fixture covers missing, blocked, and zero-PP ally move
history, while preserving Instruct when a callable last move exists.
The copy-legality fixture covers missing and blocked Copycat/Mirror Move sources
and Mimic/Sketch duplicate-move protection, while preserving legal copy cases.
The call-legality fixture covers empty Assist and Sleep Talk pools, missing or
status-only Me First intents, generation gates, and preserves legal candidate
sources for those moves and Metronome.
The type-legality fixture covers already-satisfied Soak, Magic Powder, Forest's
Curse, Trick-or-Treat, Reflect Type, Camouflage, and Conversion states, plus
missing Conversion 2 history, while preserving useful type changes.
The status-target-legality fixture covers repeated Toxic, Spore, and Will-O-Wisp
against already-statused targets, while preserving Toxic Thread and spread
status actions with at least one eligible target. It also covers Ground,
ability, terrain, and Safeguard status blocks. The same fixtures cover Grass
immunity for Leech Seed, Oblivious Attract, and Insomnia Yawn.
The order fixtures also cover ordinary ability-less Quick Claw through the full
action-ordering path, not only direct order facts.
Custap fixtures cover its Generation IV+ quarter-HP threshold, Gluttony
half-HP threshold, positive-priority and Mycelium Might exclusions, suppression,
and one-time consumption/provenance through move transitions.
Spread accuracy fixtures verify that target-scoped Lock-On/Mind Reader only
guarantees the locked target rather than every target in the spread action.
Priority-resolution fixtures verify grounded Psychic Terrain blocking,
airborne-target escape, generation-aware Dazzling priority immunity, and the
Generation IX Armor Tail ally aura in Doubles.
Order fixtures also verify calculator-fallback and caller-defined moves use the
AI metadata boundary and remain orderable with a deterministic priority-0
fallback when the inherited calculator has no Move entry.
Move-metadata fixtures separately verify the canonical-vs-Run & Bun source
boundary, accuracy/type/base-power/secondary/PP overlays, explicit move-state
type/category/priority/power/contact/heal/punch/bite/pulse/slicing/bullet
overrides, custom damaging-move calculator and order projection, move-flag
overrides, and canonical maximum PP lookup. The dedicated custom-flag fixture
also verifies calculator ability/item modifiers and Bulletproof immunity. They
also verify that action enumeration rejects
canonical moves introduced after the active generation while retaining
caller-defined custom move names, including safe target inference for an
unknown caller-defined move when no explicit target override is supplied.
Calculator-fact and called-move fixtures also verify that future canonical
moves do not leak through projected move lists or Assist/Sleep Talk pools.
The HTTP gate also rejects malformed move resolutions, including non-numeric
HP deltas and damage entries for targets not selected by the action.
Called-move target lists are checked for unique, known party IDs at the public
resolution-validation boundary.
Battle-state validation also rejects duplicate delayed-move and move-history
target IDs.
It also requires `firstTurnOutIds` to be unique active party IDs; switching
fixtures verify consecutive-move streak reset across the same boundary.
Current-appearance history, selected intents, and Choice locks are rejected
when they reference benched Pokémon.
It rejects malformed derive-resolution facts and accuracy/secondary inputs as
well.
The HTTP gate also rejects malformed optional move and Pokémon state fields,
including invalid accuracy, target, and IV/EV values.
Move-resolution fixtures also verify that recoil and drain fractions come from
the generation-aware calculator data, with compatibility fallback for caller-
supplied custom moves, that Rock Head suppresses regular recoil from Generation
III onward, and that pre-Gen-III Rock Head does not.
They also verify target-aware Liquid Ooze damage, Big Root's 30% drain
adjustment, Leech Seed conversion, Magic Guard suppression, and the
pre-Generation-V Dream Eater exception.
Fixed max-HP self-recoil from Mind Blown is covered separately from
damage-proportional recoil. Missed modern crash-damage moves are covered at
their fixed 50% max-HP consequence and remain distinct from Rock Head. Gen 3-4
crash damage uses the sampled half-damage consequence and is suppressed when
the missed target is Ghost-type.
Calculator mechanics fixtures also verify that proportional recoil retains its
display output while exposing an exact HP delta through `recoilHP`.
The terrain fixtures also verify that Defog leaves Terrain intact while Steel
Roller removes active Terrain and its duration, rejects use without Terrain,
and that repeated terrain setters fail without refreshing the active duration.
Weather fixtures cover repeated-setter behavior, including the Generation II
Rain Dance refresh exception, same-Generation-II-Sandstorm failure, and
ordinary setters being blocked by strong weather. They also cover strong
Sun/Rain speed-ability behavior and entry-weather overwrite protection.
Legacy-generation Defog fixtures also cover its target Evasion drop.
Rapid Spin, Mortal Spin, and No Retreat fixtures cover their generation-gated
Speed, poison, stat-boost, and self-trapping effects.
Salt Cure fixtures cover Gen 9 application, transition persistence, and
end-of-turn residual damage.
Screen-breaking attack fixtures cover Brick Break, Psychic Fangs, and Raging
Bull; hazard-setting attack fixtures cover Ceaseless Edge and Stone Axe.
Sacrifice-setup fixtures cover Clangorous Soul, Fillet Away, and Victory Dance
HP costs and boost vectors.
Disguise fixtures cover calculator damage facts, the immediate first-hit break,
delayed Future Sight impact, and switch re-entry reset.
Switch fixtures cover Natural Cure cleanup, Regenerator recovery, Intimidate
targeting, counter-abilities, Mirror Armor reflection, Sticky Web stat-drop
responses, and forced-switch preservation
in Singles and Doubles. Natural Cure and Regenerator fixtures include their
Generation III and Generation V availability boundaries.
They also cover generation-gated entry layers, Heavy-Duty Boots activation,
and permanent weather/terrain ability entry. Hospitality fixtures cover its
Generation IX Doubles ally-healing response, entrant/full-health/fainted-ally
exclusions, suppression, Singles, and pre-introduction boundaries. Supersweet
Syrup fixtures cover the first-entry opposing Evasion drop, persistent trigger
state across switching, Substitute/clamping boundaries, suppression, and the
pre-Generation IX gate. Curious Medicine fixtures cover absolute all-stage
resets for a live Doubles ally, Singles, suppression, and the pre-Generation
VIII gate. Commander
Intrepid Sword and Dauntless Shield fixtures cover the Generation VIII entry
boosts, persistent once-per-battle markers across switching, suppression, and
the pre-Generation VIII gate. Commander
Mimicry fixtures cover terrain-start type changes, terrain replacement, expiry
cleanup, existing-terrain switch entry, suppression, and the pre-Generation
VIII gate.
Screen Cleaner fixtures cover both-side screen removal, unrelated side-effect
preservation, suppression, and the pre-Generation VIII gate.
fixtures cover both entry orders, linked volatile IDs, all five Dondozo stage
boosts, action/switch blocking, species, Singles, and pre-introduction
boundaries. Order Up fixtures cover Curly/Droopy/Stretchy form-to-stat mapping,
the miss-time boost, no-Commander behavior, and the pre-Generation-IX gate.
Costar fixtures cover absolute boost copying, modeled crit
volatiles, live-ally selection, suppression, Singles, and pre-introduction
boundaries. Intimidate entry fixtures cover
the Gen III White Smoke/Hyper Cutter and Gen IX Clear Amulet blocker boundaries,
plus Generation VII Adrenaline Orb activation, consumption, and suppression.
Imposter fixtures verify Generation V+ effective species/type/ability copying,
including explicit No Ability targets, non-HP raw-stat and absolute-stage copying,
five-PP move copying, Ability
Shield's ability-only block, and the Substitute, transformed-target, and
pre-Generation-V boundaries. Trace fixtures verify Generation III+ ability-only
copying, deterministic finite sampling, Ability Shield, non-traceable and No
Ability targets, and the pre-Generation-III boundary.
Item-effect fixtures verify Heavy-Duty Boots is inactive before Gen VIII and
Clear Amulet is inactive before Gen IX, with Choice Scarf, Leftovers, and
Assault Vest introduction boundaries covered as well. Choice Band and Binding
Band fixtures cover their Generation III and Generation V effect boundaries.
Item fixtures cover irreversible Knock Off/Fling/Trick/Natural Gift and
berry-removal paths, including suppressed Fling/Natural Gift use and Sticky
Hold preservation.
Infatuation fixtures cover gender-independent Attract, Oblivious immunity, and
the 50% turn-local action gate.
Moody fixtures cover end-turn +2/-1 sampling, stage clamping, and the Accuracy
and Evasion stage boundary.
Multi-hit fixtures also cover Parental Bond's paired hit distributions,
sequential sampling, and the no-split Doubles spread boundary.
Slow Start fixtures cover Generation IV+ entry, the five-turn timer, 0.5x order
Speed, timer expiry, suppression/pre-Generation-IV behavior, and damage parity.
Confusion-berry fixtures cover the custom 1/4 HP trigger, half-HP healing,
nature-dependent confusion, and irreversible item consumption.
`npm run test:server` starts the exported HTTP app on an ephemeral port and
smoke-tests `POST /calculate`, `POST /ai/validate-battle-state`,
`POST /ai/choose-action`, `POST /ai/evaluate-actions`,
`POST /ai/derive-end-turn`, `POST /ai/derive-resolution`,
`POST /ai/derive-switch-entry`, `POST /ai/forced-switch-actions`,
`POST /ai/apply-action`, `POST /ai/advance-turn`, and `POST /ai/order-actions`
after the packages are built. It also verifies that missing and unknown
calculator inputs and malformed AI actions / invalid battle state are returned
as JSON `400` responses. Endpoint shapes live in [`ai/README.md`](ai/README.md);
product phase status in [`RUNBUN_UX.md`](RUNBUN_UX.md).
The HTTP choice smoke also evaluates the player side and verifies that incoming
KO and maximum-damage facts survive the public `sideId: "player"` boundary.
The calculator test
gate runs the fork and mechanics regression suites (70 tests), covering the
documented custom data/mechanics, Triage healing flags, and the Run & Bun Magma
Armor critical-hit prevention and 1.5x critical-hit multiplier across supported
generations, including the legacy Generation I/II paths.
Forced-switch fixtures also cover automatic evaluation after a faint,
caller-supplied replacement ranking, equal-score tie fallback, and invalid
ranking rejection. They also cover phazing requests, pending replacement
queueing, Roar generation gating, Suction Cups blocking, and the rule that a
pending living target cannot act before replacement.
Move-switch fixtures cover U-turn, Parting Shot, Chilly Reception, and Baton
Pass queueing, with Baton Pass boost preservation through the selected
replacement.
Shed Tail fixtures cover its Gen 9 gate, half-HP cost, Substitute creation, and
Substitute-only transfer to the selected replacement.
Item-switch fixtures cover Gen 5+ Red Card/Eject Button and Gen 8+ Eject Pack
consumption with explicit replacement queueing.
Heart Swap fixtures cover complete Accuracy/Evasion-aware stage exchange.
Spectral Thief fixtures cover positive stage theft across battle stats,
Accuracy, and preservation of a target's negative stage.
Embargo fixtures cover timed held-item suppression without item removal, and
Heal Block fixtures cover recovery action blocking and HP-healing suppression.
The calculator fixture suite also covers the Soul Dew stat-stage override for
Latias and Latios.
Power Trick and Power Shift fixtures verify raw Attack/Defense swapping,
calculator damage changes, toggle behavior, switch reset, and malformed
stat/base-stat override rejection. Speed Swap, Guard Split, and Power Split
fixtures verify raw Speed exchange and raw-stat averaging without changing
stat stages. Calculator fixtures verify raw stat overrides survive calculator
cloning.
Copy-move fixtures verify Sketch and Mimic target selection, copied move names,
maximum PP, Copycat and Mirror Move source selection/failure, and restoration
of the original move set on switch.
Metronome and Sleep Talk fixtures verify called-move selection and failure when
Sleep Talk has no callable move.
Dancer fixtures verify Generation VII gating, successful dance-move dispatch,
original target preservation, external-call marking, and miss handling.
Nature Power fixtures verify generation fallbacks and Electric, Grassy, Misty,
and Psychic Terrain dispatch.
Assist fixtures verify other-party pooling, fainted/zero-PP availability,
Gen III original-move lookup, and the Gen VIII selection failure.
Me First fixtures verify caller-seeded same-turn intent consumption, copied
damaging moves, 1.5x power and accuracy modifiers, and missing-intent failure.
Instruct fixtures verify generation gating, current-appearance last-move lookup,
target-slot preservation, and called-move actor selection in Doubles.
Helping Hand and Follow Me fixtures verify the same-turn partner-intent
status-move conflict, the no-partner Singles boundary, and the resulting
unusable score, including a fainted active-partner boundary. Toxic fixtures verify the documented healthy-target,
no-damaging-move, and Hex-family scoring bonuses; setup fixtures verify the
faster-and-safe setup bonus. Taunt fixtures cover active screens and Doubles
multi-hit fixtures cover the documented +1 scoring adjustment.
Status-synergy fixtures also cover partner-driven Hex/flinch scoring,
confusion/infatuation paralysis scoring, and Doubles Tailwind/Trick Room
decisions that account for the slower active partner.
Transform fixtures verify opponent targeting, effective species/types/ability,
explicit No Ability projection, non-HP raw-stat and stage copying, five-PP move
copying, generation-safe failure boundaries, Good as Gold's Gen IX boundary,
malformed species overrides, and complete switch cleanup.
Conversion fixtures verify first-slot type selection and the already-matching
type no-op. Conversion 2 fixtures verify legacy self-targeting from damaging
history, modern adjacent-targeting from current-appearance move history,
resistant-type selection, and
missing-source failure, including Crafty Shield blocking without Substitute
blocking.
Order fixtures verify Magic Room and Generation IV+ Klutz suppression of ordinary held-item
speed and last-move effects, the Klutz power-item exception, plus Unburden
activation after item loss and reset on switch.
Calculator adapter fixtures omit suppressed attacker, partner, and defender
abilities from scoring facts while retaining the calculator's ability-off state.
Assault Vest fixtures verify Generation VI+ Status-move rejection at both action
enumeration and direct resolution, while pre-Generation-VI, Magic Room, Embargo,
and Klutz suppression restore status-move legality.
Endure fixtures verify the one-HP direct-damage floor, separation from Protect
immunity, expiry, consecutive-use failure, and Destiny Bond interaction.
Reactive-damage fixtures verify direct-damage history, Substitute exclusion,
Counter/Mirror Coat category matching, Metal Burst's 1.5× response, and
history expiry across turn boundaries.
Focus Punch fixtures verify its Generation III gate, same-turn interruption by
direct damage, and successful execution when prior-turn damage is no longer an
interruption condition.
Bide fixtures verify locked move selection, accumulated direct damage across
turns, fixed 2× release damage, no-damage release failure, and volatile cleanup.
Rollout/Ice Ball fixtures verify generation gates, locked action enumeration,
calculator base-power escalation, miss reset, and fifth-hit cleanup.
Rage Fist/Last Respects fixtures verify Generation IX gates, dynamic base power
from incoming-hit and fainted-ally counters, and Rage Fist counter reset on switch.
Rampage fixtures verify Outrage's Generation II gate, locked action selection,
2–3-turn timing, final-action confusion, and cleanup.
Recharge fixtures verify canonical move gating, no-target forced-turn actions,
no PP/damage during recharge, miss behavior, and the Generation I Hyper Beam
boundary.
Charge fixtures verify two-turn state creation, locked target/action
enumeration, release damage facts, Power Herb and Sunny weather shortcuts,
generation gates, and cleanup on release or switch.
Geomancy fixtures verify its Generation VI gate, self-targeted charge/release
state, +2 Special Attack/Special Defense/Speed release boosts, Power Herb
immediate resolution, saturated-stage rejection, and no second PP cost.
Glaive Rush fixtures verify its Generation IX gate, successful one-turn
vulnerability marker, sure-hit incoming accuracy, doubled incoming damage, and
turn-boundary cleanup.
Electro Shot fixtures verify its canonical Gen IX fallback metadata, two-turn
charge/release +1 Special Attack, Power Herb and Rain shortcuts, calculator
facts, PP boundary, and pre-Gen IX rejection.
Damaging self-effect fixtures verify V-create's three canonical self-drops,
Hyperspace Fury's Defense drop, and their Generation V/VI boundaries.
Uproar fixtures verify the Generation III gate, 2–5-turn lock, active-sleeper
wake-up, global sleep-prevention window, and cleanup at the final action.
Semi-invulnerable charge fixtures verify zero incoming calculator damage,
engine target exclusion, and canonical bypass-move handling.
Lock-On/Mind Reader fixtures verify the Generation II gate, target-scoped
sure-hit facts, next-move consumption, and target-reference validation.
Partial-trap fixtures verify positive-damage application, generation-aware
residual damage, voluntary-switch blocking, expiry, and source-switch release.
Damaging-trap fixtures verify Generation VII+ Anchor Shot and Spirit Shackle,
positive-hit source-aware trapping, switch blocking, miss behavior, and the
pre-Generation-VII boundary.
Permanent-trap fixtures verify source-aware Mean Look cleanup on source switch
and faint, while preserving source-less legacy trap compatibility.
Nightmare fixtures verify the Generation II–VII gate, sleeping-target
requirement, quarter-HP residual damage, and cleanup on wake.
Electrify fixtures verify the Generation VI gate, target application, next
damaging-move Electric type override, consumption, and turn-boundary expiry.
Octolock fixtures verify the Generation VIII gate, paired trap state,
end-turn Defense/Special Defense drops, and source-switch cleanup.
Miracle Eye fixtures verify the Generation IV gate, target-scoped application,
Psychic-versus-Dark calculator interaction, evasion-stage suppression, and
switch cleanup.
Follow Me, Rage Powder, and Spotlight fixtures also verify one-turn Doubles
redirection, spread-move preservation, Spotlight's Generation VII+ Doubles
gate, Generation VIII+ Singles failure for Follow Me, and Rage Powder
immunity/ignore gates.
Wide Guard, Quick Guard, and Mat Block fixtures verify side-level protection
against multi-target, priority, and damaging moves, respectively, plus the
Mat Block first-turn gate, generation gates, Feint removal, and expiry.
User-only protection fixtures verify King's Shield, Baneful Bunker, Spiky
Shield, Silk Trap, Obstruct, and Burning Bulwark contact effects, along with
their generation gates. Unseen Fist fixtures verify the Generation VIII gate,
contact-only bypass, Max Guard exception, and side-protection bypass.
Defensive contact fixtures verify Rough Skin, Iron Barbs, Rocky Helmet, and
Aftermath HP deltas, stacking, Substitute/Endure/KO boundaries, generation
gates, Magic Guard, Long Reach, Protective Pads, and Punching Glove behavior.
Secondary-effect fixtures verify Serene Grace chance doubling, Sheer Force
suppression, and Shield Dust/Covert Cloak target blocking without suppressing
self-effects. Random-secondary fixtures verify Dire Claw and Tri Attack
status-choice normalization, sampled outcomes, Serene Grace, status immunity,
and Sheer Force suppression. Life Orb fixtures verify one-time Generation IV+ recoil, the
Sheer Force secondary-effect exception, and Magic Guard suppression.
Throat Chop fixtures verify its Generation VII gate, positive-hit target marker,
sound-move exclusion and direct failure, two-turn expiry, miss behavior, and
calculator sound-move facts.
Burning Jealousy fixtures verify the Generation VIII gate, current-turn positive
stat-rise ledger, hit-and-damage requirement, status eligibility, and turn-boundary
history expiry.
Gigaton Hammer fixtures verify its Generation IX gate, current-appearance
same-move exclusion, direct-resolution failure, and release after another move.
Scale Shot fixtures verify canonical multi-hit facts, the Generation VIII gate,
post-hit Defense/Speed stages, and miss-time suppression.
Echoed Voice fixtures verify the Generation V gate, consecutive-use power ramp,
200-power cap boundary behavior, and reset after another move.
Metronome-item fixtures verify Generation IV+ consecutive-use damage scaling,
the first-repeat count, Magic Room suppression, and failed-move streak reset.
Mental Herb fixtures verify Generation III+ clearing of the six mental
volatiles, consumption provenance, and Magic Room, Klutz, and generation
suppression.
Fury Cutter fixtures verify the Generation II gate, dedicated consecutive-hit
marker, power ramp, miss reset, and reset after another move.
Typeless-move fixtures verify Burn Up and Double Shock prerequisites, generation
gates, post-hit type removal, calculator type projection, and switch restoration.
Relic Song fixtures verify the Generation V gate, successful Meloetta form toggle
in both directions, non-Meloetta no-op behavior, and switch cleanup.
Fling-effect fixtures verify Generation IV item availability, Flame Orb/Light
Ball/Poison Barb/Toxic Orb statuses, King's Rock/Razor Fang flinch, status and
volatile immunity, Covert Cloak/Inner Focus and Sheer Force suppression,
actor-side Unnerve eligibility and target-side Unnerve Berry suppression with
item consumption,
Mental Herb and White Herb direct target effects (including Covert Cloak
non-suppression),
Oran/Sitrus/confusion-Berry healing, all six status-Berry cures, Kee/Maranga/
Lansat/Micle/Starf effects, Ripen healing/stat scaling, Liechi stat raising,
Leppa PP restoration with and without Ripen, Cheek Pouch activation, miss-time
item consumption, and the pre-Generation-IV boundary.
Diamond Storm fixtures verify canonical move-level self-secondary extraction,
50% sampled +2 Defense, and the Generation VI boundary. Reactive
Tar Shot fixtures verify its Generation VIII gate, target Speed-drop plus
persistent vulnerability marker, saturated-stage action legality, turn-boundary
persistence, repeated no-op rejection, and 2x Fire damage through the
calculator adapter. Reactive
status fixtures verify Static, Flame Body, Poison Point, Effect Spore,
Cute Charm, Poison Touch, Gooey, Tangling Hair, and Cursed Body, including
forced-proc/no-proc rolls,
status immunities, generation gates, contact-only behavior, and four-turn
disable state.
Synchronize fixtures cover reflected status, generation, ability-bypass, and
status-immunity boundaries.
Mold Breaker-family fixtures verify target-ability suppression for status
moves, Sturdy/Disguise, reactive contact abilities, and Suction Cups phazing,
including the Mycelium Might Generation IX boundary.
Sound-boundary fixtures verify canonical sound metadata, Substitute bypass,
Soundproof blocking, and category-aware Mycelium Might behavior.
Damage-response fixtures verify Weak Armor, Stamina, Berserk, Steam Engine,
Motor Drive, Sap Sipper, Justified, Water Compaction, Rattled, and Toxic
Debris, including physical/type gates, HP-threshold behavior, generation
gates, stat-stage outputs, and capped side-hazard creation.
Anger Shell fixtures verify its Generation IX one-hit threshold, five-stage
boost vector, multi-hit, Substitute, KO, Sheer Force, and pre-introduction
boundaries.
Anger Point fixtures verify explicit critical-hit triggering, stage clamping,
Substitute, KO, ability-bypass, and the pre-introduction boundary.
Cotton Down fixtures verify Generation VIII active-field Speed drops in Singles
and Doubles, active-ally targeting, Substitute, aggregate multi-hit behavior,
fainted-actives, status/no-damage, Mold Breaker, and generation boundaries.
Cud Chew fixtures verify Generation IX Berry capture, two-boundary delayed
re-eating, Sitrus and Leppa replay, ability suppression pause, ordinary-switch
cleanup, natural Leppa capture, and the Bug Bite/Pluck stolen-Berry exclusion
without new Recycle provenance.
Supreme Overlord fixtures verify the Generation IX ability projection, damage
increase across zero versus five fainted allies, and the pre-Generation IX
calculator-input boundary.
Orichalcum Pulse and Hadron Engine fixtures verify their Generation IX switch-
entry Sun/Electric Terrain setters, suppression, and pre-introduction gates.
Wind Rider fixtures verify canonical wind metadata, immunity plus the +1 Attack
response, Mold Breaker suppression, and the Generation IX boundary.
Wind Power fixtures verify successful damaging wind hits, newly established
Tailwind, shared charged-state projection and consumption, Tailwind refreshes,
Mold Breaker-style bypass, suppression, and pre-Generation IX gating.
Well-Baked Body and Earth Eater fixtures verify typed immunity responses, +2
Defense or 1/4 max-HP healing, Mold Breaker suppression, and Gen IX gating.
Electromorphosis fixtures verify Generation IX charged-state creation after a
damaging hit, doubled regular Electric damage, one-shot consumption, suppression,
ability bypass, and the pre-introduction boundary.
Flash Fire fixtures verify Fire-hit activation, calculator-side subsequent Fire
damage amplification, switch cleanup, Mold Breaker bypass, and generation gating.
Gulp Missile fixtures verify Generation VIII+ Surf/Dive form selection, Gulping
Defense-drop retaliation, Gorging paralysis retaliation, 1/4-max-HP damage,
non-suppressible Mold Breaker behavior, Magic Guard, and pre-introduction boundaries.
Seed Sower and Thermal Exchange fixtures verify their Generation IX damaging-hit
responses, five-turn Grassy Terrain with active Terrain Extender extension,
Attack boost, and pre-introduction gates.
Typed absorption fixtures verify Water Absorb, Volt Absorb, Dry Skin, Lightning
Rod, and Storm Drain calculator immunities plus their healing or Special Attack
responses and generation boundaries.
Emergency Exit/Wimp Out fixtures verify Generation VII threshold crossing from
move and residual damage, Endure survival, pending replacement queueing,
already-low HP, Substitute, Mold Breaker, no-replacement, and pre-introduction
boundaries.
KO-response fixtures verify Moxie, Chilling Neigh, Grim Neigh, Beast Boost,
and Soul-Heart, including direct-KO detection, Beast Boost raw-stat selection,
Soul-Heart per-faint behavior, Endure suppression, and generation gates.
Sturdy fixtures verify full-HP single-hit damage capping in both calculator
facts and move resolution, Substitute and pre-Generation-V exclusions, and
the absence of false KO boosts.
Focus Sash fixtures verify Generation IV+ full-HP single-hit capping in both
calculator facts and move resolution, explicit consumption, multi-hit,
nonfatal-first-hit, fatal-first-hit, Substitute, and held-item suppression
exclusions.
Focus Band fixtures verify Generation II+ fatal-hit survival with a sampled 10%
roll, non-consumption, multi-hit/Substitute sequencing, and generation/item
suppression exclusions.
Air Balloon fixtures verify Generation V+ direct-hit bursting, zero-damage
 direct hits, Substitute-only and later multi-hit boundaries, and item
 suppression/generation exclusions.
Ice Face fixtures verify the Generation VIII+ physical-hit block, Eiscue form
transition, calculator projection, Mold Breaker/special/multi-hit exclusions,
and hail/snow end-turn restoration.
Weakness Policy fixtures verify Generation VI+ super-effective positive-damage
activation on a surviving direct hit, stat-stage normalization, explicit
consumption, Simple doubling, multi-hit continuation, final-KO, and
Substitute/held-item suppression exclusions.
Reactive super-effective item fixtures verify Absorb Bulb, Cell Battery,
Snowball, and Luminous Moss type/stat mappings, generation gates, explicit
consumption, and wrong-type/Substitute exclusions.
`ai/src/test/terrain-seeds.test.ts` verifies move-established and switch-entry
terrain, Electric/Grassy/Misty/Psychic stat mappings, Surge-created terrain,
explicit item consumption, Simple/Contrary normalization, and generation/item
suppression boundaries.
Throat Spray fixtures verify Generation VIII+ canonical sound activation,
Special Attack boosting, explicit consumption, and non-sound/generation/item
suppression exclusions.
Faint/contact ability fixtures verify Innards Out's remaining-HP damage and
Magic Guard suppression, Perish Body's paired three-turn Perish Song, and
Mummy, Wandering Spirit, and Lingering Aroma ability changes with mutable-
ability exceptions and generation gates.
Ally Switch fixtures verify actor/ally active-slot swapping, immutable input
state, and Singles, generation, and faint-ally rejection at both boundaries.
Magic Coat fixtures verify Generation IV gating, opposing Status reflection,
coat consumption, and non-consuming damaging moves.
Magic Bounce fixtures verify Generation V gating, canonical reflectable move
metadata, status and hazard reflection, effect-actor side placement, and
suppression/Mold Breaker bypass.
Protection-breaking fixtures verify Feint removes personal King’s Shield state
as well as side-level protection.
Snatch fixtures verify canonical snatchable metadata, Generation III-VII
one-turn arming, self-effect transfer, side-effect transfer, non-snatchable
status moves, recipient validation, multi-user generation-specific chaining,
and the Generation VIII+ selection gate.
It also checks the exact fork critical-hit damage range across those generations.
The current AI fixtures also exercise advanced support/control scoring, setup exceptions,
doubles ally safety, explicit switch viability, and malformed-state rejection
through `validateBattleState()`.
Matchup fixtures verify automatic Singles replacement viability derivation from
hypothetical entry states, opposing legal moves, and caller overrides.
Residual fixtures verify Gen III+ Cloud Nine/Air Lock suppression, including
their pre-introduction behavior, Safety Goggles,
Magic Room/Generation IV+ Klutz item suppression across Safety Goggles, Leftovers, Orbs, and
Sitrus/Oran and confusion berries, plus Rain Dish, Hydration, generation-gated Shed Skin
behavior, and Doubles Healer status cleanup.
They also verify Generation IV+ Sticky Barb residual damage, Magic Guard and
item-suppression boundaries, and contact transfer with Sticky Hold, Substitute,
non-contact, and already-held-item exclusions.
Move-model fixtures also verify Generation III+ Shell Bell healing from direct
single-target, Substitute-breaking, and aggregate damage, including generation
and item-suppression boundaries.
They also verify Generation II+ Berry Juice at move and end-turn boundaries,
including 20-HP healing, consumption provenance, Substitute-only exclusion,
generation, Magic Room, Klutz suppression, and the rule that Berry Juice does
not activate Cheek Pouch.
They also verify Generation III+ Cheri, Pecha, and Rawst status cures at both
move-application and end-turn boundaries, including item consumption, Cheek
Pouch healing, and residual-damage suppression after the cure.
They also cover the Generation III+ Liechi/Ganlon/Salac/Petaya/Apicot low-HP
stat-berry family, including the Generation IV+ Gluttony threshold, each stat
mapping, Simple/Contrary normalization, Cheek Pouch, max-stage consumption,
and item suppression.
Calculator adapter fixtures also verify that suppressed held items are omitted
from policy facts, while Klutz power-item exceptions remain visible.
They also verify that pre-introduction ability strings are omitted from
calculator facts while the same abilities become visible at their introduction
generation, including Moxie, Friend Guard, Power Spot, and Zero to Hero.
Evaluation-boundary fixtures also verify that caller-provided pre-introduction
ability facts are removed before status scoring.
The residual fixtures also verify consumed-item provenance and generation-5+
Harvest restoration, including Cloud Nine suppression of the Sun guarantee.
They also cover generation-gated Grassy Terrain healing and shared grounding
under Flying, Air Balloon, and Magic Room conditions. They also cover
Generation III+ Speed Boost, Generation IV+ Bad Dreams, ability suppression,
and Magic Guard protection from Bad Dreams damage.
They also cover Generation IV+ Poison Heal, its pre-introduction behavior and
suppression, plus Generation V+ Moody and its pre-introduction behavior and
suppression. Move-resolution fixtures also verify the shared generation gate
for pre-introduction Contrary stat normalization.
Weather residual fixtures cover the Gen I/II/III Sandstorm boundaries, the
Gen III Hail boundary, Gen V Overcoat activation, and Gen III Rain Dish.
Residual state fixtures also cover Nightmare’s Gen II–VII damage window, Curse’s
Gen II floor, and Salt Cure’s Gen IX residual boundary.
Magic Guard fixtures cover its Gen IV introduction boundary in both residual and
contact indirect-damage resolution. Rock Head fixtures cover its Gen III
recoil-prevention boundary.
Generation-gate fixtures cover pre-introduction hazards, screens, field/terrain
setters, Aqua Ring, Ingrain, Roost, and Healing Wish state.
Telekinesis fixtures cover its three-turn Ground immunity, Gravity failure,
Gravity cancellation, and timer lifecycle.
Smack Down and Thousand Arrows fixtures cover landed-state creation, removal of
airborne volatiles, Substitute protection, and Ground damage against landed
Flying targets.
Model fixtures cover Aqua Ring/Ingrain volatile creation, recovery, and
Ingrain switch blocking.
They also cover generation-aware eligibility for Levitate grounding,
pre-introduction Insomnia sleep immunity, and Good as Gold status blocking.
Sweet Veil and Aroma Veil fixtures cover living Doubles ally protection for
sleep/Yawn and Attract/Taunt/Encore/Disable/Torment/Heal Block, respectively,
including faint-ally, suppression, and pre-Generation VI boundaries.
Pastel Veil fixtures cover living Doubles ally Poison/Toxic protection,
switch-entry cure and Toxic-counter cleanup, faint-ally, suppression, and the
pre-Generation VIII boundary.
Flower Veil fixtures cover living Grass-type ally status/Yawn protection,
negative boost protection across moves and entry Intimidate, non-Grass/faint
ally behavior, suppression, and the pre-Generation VI boundary.
Disguise and Stalwart fixtures cover their pre-introduction boundaries.
Status-policy fixtures also cover pre-introduction critical-hit blockers in
the Focus Energy no-op boundary.
AI scoring fixtures cover weather-based recovery parity: Morning Sun, Synthesis,
and Moonlight use the Sun healing branch before falling back to the standard
recovery decision outside Sun.
They also verify that Swallow's recovery score follows its one-, two-, and
three-Stockpile healing fractions instead of assuming generic half recovery.
They also cover setup survival lines: full-HP Sturdy and an unconsumed Focus
Sash may set up through a modeled opposing KO, while a non-full Sturdy user
is still rejected.
Special setup fixtures cover Tail Glow/Nasty Plot/Work Up's modeled three-hit
survival, speed, and existing Special Attack-stage adjustments.
Setup-policy fixtures also cover recharge and Truant-loafing targets as
incapacitated setup opportunities, including the derived `ActionFacts` flag.
Protect scoring fixtures reject a turn that ends in modeled residual death.
They also cover the same residual/context and repeat-use scoring rules for
King’s Shield, while side-level Wide Guard, Quick Guard, and Mat Block retain
their separate protection boundary.
Damaging-action fixtures reject all-immune zero-damage actions while retaining
normal scoring for spread actions that damage at least one target. They also
cover guaranteed Atk/SpAtk-drop scoring for Mystical Fire and the physical
Spirit Break, including the target-move-split distinction.
The move-metadata fixture also verifies the documented Screech PP overlay,
alongside the existing Run & Bun accuracy, power, type, effect-chance, and PP
overrides.
This aggregate check keeps mixed-immunity Doubles spreads eligible when any
target still takes damage. Doubles setup-threat fixtures additionally verify
that KO and maximum-damage checks use the evaluated actor's target-scoped
spread damage rather than the first ally's result.
Perspective fixtures also verify that the same incoming-threat facts are
derived when the public evaluator is asked to score the player side.
Contrary fixtures verify non-highest, non-KO Leaf Storm/Overheat and Superpower
use their Nasty Plot/Bulk Up setup-equivalent scores even under KO pressure.
Damaging setup fixtures also cover non-highest Power-Up Punch and Charge Beam:
they use the setup/survival boundary, preserve Power-Up Punch's Unaware
exception, and reject Charge Beam's setup value against Unaware or an
unprotected opposing KO.
Special damaging fixtures keep documented no-use outcomes terminal for Fling
without an item, Meteor Beam without Power Herb, and Pirouette Relic Song.
Taunt fixtures distinguish the documented inactive-Trick-Room pressure (including
a slower Taunt user) and faster Defog-plus-Aurora-Veil pressure from ordinary
Reflect/Light Screen presence.
Destiny Bond fixtures gate its faster-user bonus on the opponent's KO threat,
and Encore fixtures reject an explicit first-turn-out target.
Protect fixtures cover the full residual/volatile context adjustment for the
user and opposing active Pokémon.
Recovery fixtures cover Sun-branch fallback to standard healing logic and
Strength Sap’s full/85%-HP no-op thresholds.
Explosion fixtures verify the documented under-33%-HP `+8/+0` roll, and sleep
fixtures suppress Dream Eater/Nightmare bonus when the target has Sleep Talk
or Snore.
Poisoning fixtures require both the documented status synergy and a target with
no physical or special damaging moves before applying the bonus.
Will-O-Wisp fixtures verify that speed and safety alone do not create an
undocumented bonus; only physical-move and Hex synergy do.
Sleep fixtures keep the sleep move score at +6 when the opponent can KO,
matching the documented no-kill condition on the synergy branch.
They also cover Gen 4+ Magnet Rise timing and grounding interaction.
Mist fixtures verify side-condition creation, opposing stat-drop protection,
expiration, the generation-1 untimed form, and no-op scoring when already active.
Lucky Chant fixtures verify generation-4+ creation, expiry, calculator critical-hit
prevention, and pre-introduction gating.
Crafty Shield fixtures verify generation-6+ creation, one-turn expiry, opposing
status blocking, and preservation of damaging-move secondary effects.
Field-room fixtures verify Generation IV+ Trick Room and Generation V+ Magic
Room/Wonder Room five-turn durations, re-use toggles, duration clearing, and
Magic Room item suppression before and after the field transition. AI scoring
fixtures also reject an already-active Trick Room toggle with the documented
-20 policy score while preserving the legal transition.
Pledge fixtures verify all three serializable first/partner action sequences,
150-power combined damage projection both before and after the partner action,
Rainbow secondary-chance doubling, the
Generation V+ quarter-Speed Swamp condition, Sea of Fire residual damage,
four-turn side-effect durations, and expiration across turn boundaries.
Fairy Lock fixtures verify generation-6+ gating, timed field expiry, voluntary
switch blocking, and forced-switch allowance.
Water Sport/Mud Sport fixtures verify pre-Gen-VI active-user state, Gen VI–VII
timed field state, calculator power reduction, and Gen VIII gating.
Ion Deluge fixtures verify one-turn field expiry, Normal-to-Electric calculator
conversion in Generations VI–VII, and pre-introduction gating.
Grounding fixtures also verify Magnet Rise Ground-type damage immunity and
Roost’s temporary Ground-type interaction through the calculator adapter.
Delayed-effect fixtures cover Wish healing at its due boundary and delivery to
the replacement occupying the original active slot.
Healing Wish fixtures cover immediate self-faint, pending side state, and
full/status-clearing forced replacement entry.
Item fixtures also cover Recycle restoration from consumed-item provenance and
its no-op behavior after forced removal.
They cover Gen 8+ Stuff Cheeks Berry consumption, Defense setup, item
suppression, and its Magic Room exception. Natural Gift is gated to
Generations IV–VII and consumes a usable Berry; Trick/Switcheroo fixtures cover
one-sided item transfers, Gen III+ Sticky Hold blocking, its pre-introduction
behavior, and empty-item failure.
Bug Bite/Pluck fixtures distinguish Generation IV recyclable consumption from
the Generation V+ non-Recycle-able stolen Berry path, and verify that the
attacker receives the modeled Berry-eat effect without arming Cud Chew. Teatime
fixtures verify Generation VIII consumption plus the shared Berry-eat effect
on each active holder. Natural Gift also covers
the Generation V–VII Red Card preservation boundary.
Reactive item fixtures cover Incinerate destruction, Sticky Hold and faint
target handling, Magician theft, and contact-gated Pickpocket theft.
Reactive stat-Berry fixtures cover Generation VI Kee Berry and Maranga Berry,
physical/special mapping, one-time consumption and provenance, multi-hit,
Substitute, faint, Unnerve, and pre-Generation-VI boundaries.
Reactive damage-Berry fixtures cover Generation IV+ Jaboca Berry and Rowap Berry,
physical/special mapping, Ripen damage scaling, one-time multi-hit consumption,
lethal hits, Substitute, Magic Guard, Unnerve, and the pre-introduction boundary.
Enigma Berry fixtures cover Generation III+ super-effective surviving-hit healing,
Ripen scaling, explicit consumption, full-HP, Heal Block, and lethal-hit
suppression.
Low-HP Berry fixtures cover Generation III+ Lansat Focus Energy and Starf random
+2 stage activation, Gluttony’s Generation IV threshold, Ripen scaling, item
consumption, and invalid Starf sampler rejection.
Type-resist Berry fixtures cover all Generation IV+ type mappings, one-hit
super-effective damage halving, item consumption and provenance, Substitute
and multi-hit boundaries, Unnerve, Magic Room, Embargo, Klutz, and the
pre-introduction Generation III boundary.
Corrosive Gas fixtures cover retained-but-unusable item state, Sticky Hold and
Substitute blocking, and persistence across switching.
Mirror Herb fixtures cover Generation IX opposing positive-stage copying,
one-time consumption, self-boost exclusion, generation and
Magic Room/Embargo/Klutz suppression, and active-response validation without
allowing benched Pokémon IDs.
Opportunist fixtures cover Generation IX post-boost copying, generation and
suppression boundaries, ordinary stage clamping, and non-chaining behavior.
Poison Puppeteer fixtures cover Pecharunt-only poison/toxic status responses,
confusion duration, generation and suppression boundaries, and wrong-species
exclusion.
Booster Energy fixtures cover Protosynthesis and Quark Drive activation on
switch entry and after a weather change, natural Sun/Electric Terrain trigger
suppression, item consumption, persistent volatile projection into calculator
and order paths, generation gating, and Magic Room suppression.
Blunder Policy fixtures cover actual sampled accuracy misses, +2 Speed and
explicit consumption, partial spread misses, generic failure exclusion, and
Generation VIII, Magic Room, Embargo, and Klutz suppression boundaries. Failed
move transitions also verify that the actor's explicit self-state changes are
applied without applying ordinary missed-move effects.
Status-berry fixtures cover Generation III+ Cheri, Chesto, Pecha, Rawst, Aspear,
and Lum consumption at the status-application boundary, Lum/Persim confusion cleanup,
Chesto sleep-counter cleanup,
Cheek Pouch recovery, consumed-item provenance, non-matching Chesto behavior,
and Magic Room/Klutz/pre-introduction suppression.
They also cover generation-6+ Cheek Pouch healing from modeled Berry
consumption paths, plus Heal Block suppression of Berry recovery and Cheek
Pouch while preserving consumption and non-healing Berry effects.
Aura fixtures verify generation-gated Friend Guard, Battery, and Power Spot
ally effects, including suppression and the Battery Generation VI/VII boundary.
Generation-map fixtures also verify the inherited canonical boundaries for
Contrary, Hydration, Poison Touch, Sand Veil, Full Metal Body, and the four
Surge abilities; entry and contact fixtures cover the corresponding effects.
Weather fixtures verify the same suppression across Wide Lens, Sand Veil,
Swift Swim, and Flower Gift calculator/order paths. They also verify
generation gates for representative accuracy abilities, Gravity, and evasion
items. Keen Eye and Mind's Eye fixtures cover Accuracy-drop blocking and
holder-side Evasion ignoring across their introduction generations.
Wonder Skin fixtures cover the Generation V+ Status accuracy cap, pre-Gen-V
inactivity, damaging-move exclusion, and Mold Breaker bypass. Illuminate
fixtures cover the Generation IX evasion-ignore boundary. Accuracy ability
bypass fixtures also cover Mold Breaker vs Sand Veil.
Order fixtures also verify the introduction gates for Gale Wings, Triage, Quick
Feet, weather-speed abilities, Stall, and Mycelium Might.
They also cover Belly Drum’s half-max HP transition, Sitrus consumption,
Heal Block suppression, and post-drum survival scoring.
White Herb fixtures cover move-stage clearing, pre-existing negative stages,
Contrary, Shell Smash, Baton Pass entry, and item consumption. The adapter
fixtures also compare projected incoming damage with and without White Herb.
Laser Focus fixtures verify the guaranteed critical-hit adapter path, expiry at
the next turn boundary, and Battle Armor/Magma Armor critical-hit blocking;
Focus Energy policy fixtures verify the same blocker family.
Sleep lifecycle fixtures verify that benched sleep does not advance and that
re-entry restores the modeled fresh sleep counter.
They also verify Generation III+ Early Bird's accelerated countdown,
suppression handling, and its pre-Generation-III gate.
Residual-status fixtures also verify Generation I/VII+ burn at 1/16,
Generation II–VI burn at 1/8, Generation IV+ Heatproof halving, and the
Generation I poison denominator.
Perish Song fixtures verify its sound-based Substitute bypass and retained
Soundproof immunity.
Doubles aura fixtures verify active ally Battery, Power Spot, and Friend Guard
damage modifiers with self-exclusion, plus global aura and Flower Gift
generation/suppression behavior.
Endure fixtures verify the one-HP direct-damage floor, separation from Protect
immunity, expiry, consecutive-use failure, and Destiny Bond interaction.
First-turn move fixtures verify Fake Out and First Impression generation gates,
enumeration and direct-resolution rejection after the opening turn, replacement
first-turn activation, and turn-boundary expiry.
State-contract fixtures also reject delayed healing entries with unknown
targets or non-positive/non-integer fraction components.

## Upstream compatibility policy (Policy B)

`npm run test:upstream` in `calc/` is an **intentional compatibility audit**,
not part of the root `npm test` gate. Root tests stay green without requiring
upstream green. Fork deltas that cause audit failures are recorded in
[`FORK_MAP.md`](FORK_MAP.md) and covered by `calc/src/test/fork.test.ts`.

Do **not** silently rewrite inherited Smogon expectations to go green. Promote a
baseline only with an explicit fixture change and a short note in `FORK_MAP.md`.

### Upstream failure inventory (75 fail / 63 pass)

Name-based buckets from the current Jest audit (`data.test.ts` + `calc.test.ts`):

| Bucket | Count | Meaning |
| --- | ---: | --- |
| Description / default-IV display | 41 | Fork shows IV-based stat labels (`31 Atk` vs upstream `0 Atk`); damage ranges usually match |
| Iron Ball grounding | 12 | Fork Iron Ball / landed grounding vs Flying/Levitate |
| Critical-hit 1.5× (and related desc) | 9 | Run & Bun 1.5× crit multiplier vs upstream 1.5/2.0-era expectations |
| Parental Bond `abilityOn` | 4 | Child hit only while Parental Bond is active |
| Thousand Arrows / Ring Target | 4 | Grounding / nullifier interaction (often description-coupled) |
| Psychic Terrain scaling | 3 | Fork modern terrain damage scaling |
| Super Fang type Dark | 1 | Intentional move-data overlay |
| Azumarill 65 base Atk | 1 | Intentional species-data overlay |

## Completeness backlog (decision-useful scope)

North star: expand the serializable engine only where missing rules change
legality, facts, scores, or transitions. Do not chase Pokémon Showdown parity.
Tags: `engine` | `scoring` | `caller-owned` | `calc-overlay` | `product`.

**Priority scheme (same everywhere):** **P0 / P1 / P2 / P3 / Park** — see
[`PLAN.md`](PLAN.md) §0 for the **master prioritized backlog** (UI + product +
engine). Product phase map: [`RUNBUN_UX.md`](RUNBUN_UX.md). UI rollout ranks:
[`RUNBUN_UI_DESIGN.md`](RUNBUN_UI_DESIGN.md) §9.

Every open row below must keep a Priority + ID that appears (or rolls up) in
PLAN §0. Do not leave unranked “next” / “later” rows here.

### Done (closed engine P0 / product MVP)

| Item | Tag | Status |
| --- | --- | --- |
| Wonder Skin status-move accuracy cap (Gen 5+) | engine | Done — `accuracy.ts` + weather fixtures; Mold Breaker bypass |
| Illuminate Gen 9+ evasion ignore | engine | Done — with Keen Eye / Mind's Eye family |
| Mold Breaker family vs accuracy abilities (Sand Veil / Snow Cloak / Tangled Feet / Wonder Skin) | engine | Done — shared `ignoresTargetAbility` in accuracy path |
| Per-hit contact / KO / threshold reactions already modeled | engine | Audit: present in `move-engine.ts` with fixtures; no open P0 hole |
| Browser UI ↔ evaluate/choose (+ derive→apply→advance) | caller-owned UI | Done — thin `ai_panel.js` HTTP client |
| Sets → Gen 8 zero-EV `BattleState` bridge | caller-owned UI | Done — `sets_to_battle_state.js` |
| `POST /ai/validate-battle-state` + smoke coverage | caller-owned API | Done — HTTP 400 on invalid; `server.smoke.test.js` |
| Light explain (expandable reasons / ActionFacts) | product | Done MVP under AI Debug |
| Explain citations (`run_and_bun_ai.MD` anchors) | product | Done MVP — keyword map on reasons/facts; no `kochance` parsing |
| Structured BattleState editor (thin) | product | Done MVP — gen/mode/turn/HP fields + raw JSON; HTTP validate |
| Fixture load + export current state | product | Done MVP under AI Debug |
| Singles Battle turn viewer | product / caller-owned UI | Done MVP — `#runbun-battle` + `battle_turn_viewer.js`; same AI HTTP loop; modeled-slice labeling |

**No open engine P0** items remain for decision-useful Run & Bun scope.

### Open backlog (ranked — detail; master table in PLAN §0)

| Priority | ID | Item | Tag | Notes / done-when |
| --- | --- | --- | --- | --- |
| P0 | HYG-01 | Keep root `npm test` + UI smoke / Policy B notes green | product | Continuous floor (`fixtures/ui.test.js` in `test:server`) |
| P0 | FIX-01 | ~~Inventory 8–12 fixtures as named UI scenarios~~ **Done** | product | `fixtures/ui/manifest.json` (10 Gen 8 Singles) |
| P0 | FIX-02 | ~~Fixture browser MVP → AI Debug → validate~~ **Done** | product | `/fixtures/ui` + AI Debug Load fixture |
| P0 | UI-V0 | ~~Wire `runbun-tokens.css` (no calc guts rewrite)~~ **Done** | product | Tokens usable |
| P1 | FIX-03 | ~~Golden eval snapshot format + one golden~~ **Done** | product | `fixtures/ui/goldens/sample.eval.json`; regen via `scripts/regen-ui-golden.js` |
| P1 | FIX-04 | ~~Golden compare in AI Debug (facts/reasons)~~ **Done** | product | Compare golden button / auto after Evaluate |
| P1 | UI-V1 / UI-V2 | ~~Shell nav + R&B panel retoken~~ **Done** | product | See UI design §9 |
| P1 | ENG-01 | Scoring wrong because facts missing → facts then score | scoring | Repro-backed; never invent in chooser |
| P1 | ENG-02 | Calc overlays for new R&B damage identity | calc-overlay | Only when oracle wrong; `fork.test.ts` |
| P2 | EXP-01 / EXP-02 | Deeper Explain + citation audit | product | Facts-driven only |
| P2 | UI-V3 / SET-01 / ACC-01 / DBL-01 | ~~Battle/Sets polish + ACC-01~~ **Done**; Doubles layout sketch (DBL-01) open | product | After fixtures feel solid |
| P3 | EXP-03 / UI-V4 / ADP-01 / BAT-01 | Quiz, later chrome, adapter CLI, reverse hop (DBL-02 + RPL-01 shipped) | product | See PLAN §0 |
| Park | PARK-03 | Remaining uncommon accuracy (OHKO niches, rare items) | engine | Else caller `hit`; reopen if policy needs |
| Park | PARK-01 | Exact PS residual / event-queue interleaving | caller-owned | Collapsed `advanceTurn()` enough |
| Park | PARK-02 | Full volatile / ability encyclopedia | engine | Module per bug with repro |
| Park | PARK-04 | Berry Juice per-hit timing | engine | Sequence model is move-boundary |
| Park | PARK-05 | Map/environment Nature Power without terrain | engine | Documented non-goal |
| Park | PARK-08 | Silent upstream expectation rewrites | engine | Policy B |

**Note:** Doubles chrome and replay are **P2/P3 scheduled**, not Park — only
PARK-* rows above are deferred without a near-term slot.

## Existing validation debt

One older repository-wide gate remains a deliberate compatibility audit under
Policy B above. The fork-focused `npm test` in `calc/` covers intentional
overlays (~70 tests); upstream failures must be reconciled deliberately before
being promoted.

Do not use the legacy UI exclusion for new code. Treat upstream compatibility
as a separate decision and record any promoted baseline in its own fixture
change.
