# The key to each leader

Generated evidence, human conclusions. Sources: `scripts/leader-dossier.js`
(every leader's kit priced by the engine's matchup grid against the full
period-catchable sample — species from open tables, levelled to the cap,
level evolutions, last-four level-up moves, 15 IVs) and the counterfactual
battery `gymkey1` (30 seeds per cell at the three reachable gyms).
Regenerate the dossiers with `node scripts/leader-dossier.js`; the JSON
lands in `ui-playthrough-out/leader-dossiers.json`.

## The one gimmick every leader shares

Leaders out-stat the period pool everywhere, not just early: mean best
hits run 80–180% of a sample body's HP, and the fraction of the pool that
qualifies as an *answer* (2HKOs on its floor damage while surviving the
crit ceiling) is 0–6% at every gym. So the key is never "catch better in
general". It is three specific things, in order:

1. **Named species.** The answers are a short list with names on it, per
   leader mon, below.
2. **Tech traps.** Most leaders carry at least one punish the obvious
   play walks into. These are listed per leader; the plan must respect
   them before any species choice matters.
3. **Stats stacked on the right names.** Empirically at Brawly:
   the named box at 15 IVs went 0/30 and the *rolled* box at 31 IVs went
   0/30, but the named box at 31 IVs went 4/30 — the first counterfactual
   Brawly wins ever recorded. Composition and investment multiply; neither
   alone moves him.

One honest limit: a synthetic named box (level-up moves, no items, neutral
natures) is a WEAKER instantiation than a real evolved box. At Wattson the
real deep-run box at 31 IVs (15/30) crushed the synthetic key box at 31
IVs (1/30). The names say *what to catch*; the real box's TMs, items and
natures still carry the rest.

## Per leader

Speed columns read: "outsped" = share of the period sample that moves
before it. A mon most of the pool outspeeds is the revenge window.

### Brawly (order 80, cap 21) — the pure type wall
- Kit traps: Speed Boost + Work Up Combusken (snowballs), Technician
  Hitmontop (Fake Out + Mach Punch priority), Water Absorb Poliwhirl
  (no Water moves into it), Eviolite + Shed Skin + Rest Scraggy (the
  12/12 survivor in every probe — the fight dies against him), Eject
  Button Lopunny, Sucker Punch Kubfu.
- Named answers: Vespiquen, Gligar (Kubfu); Hitmonchan (Scraggy).
  Key box: Hitmonchan, Vespiquen, Gligar, Salandit, Kadabra, Yanma.
- The key: that box, invested (Heart-Scale IVs). Break Scraggy with
  Fighting/Fairy pressure before Rest value compounds; never leave
  Combusken a free turn.
- Openings: Scraggy (49% outsped) and Combusken (42%) are the slow half.

### Roxanne (order 142, cap 25) — the punish gauntlet
- Kit traps: **Defiant Bisharp behind a Focus Sash** (an Intimidate lead
  gifts +2; the sash forces two hits), **Weakness Policy Lunatone**
  (a super-effective hit gifts +2/+2 on a Levitate body with Hypnosis),
  Refrigerate Aurorus (Body Slam is STAB Ice), Solid Rock + Rindo
  Carracosta, Extreme Speed Zygarde-10%.
- Named answers: Hariyama (Aurorus, Lunatone), Hitmonchan, Palpitoad.
- The key: no single composition cracked her (named box 0/30 even at 31
  IVs — her fights are races her answers lose to Zygarde and Aurorus
  speed). The measured lever is a DIVERSE box at high IVs (7/30), plus
  discipline: chip Bisharp twice without Intimidate, hit Lunatone with
  neutral damage only, never Ice/Rock into Carracosta's Rindo plan.
- Opening: Carracosta is slower than 91% of the pool.
- Measured 2026-09-18 on the fixed engine (Burn Up, mid-turn no-effect
  moves and charged-move retargeting fixed; the figures above predate
  those fixes). Adopted policy (ranker's six, priced switch), real PP:
  - Across the 60 archive boxes that reach her, **15.5% of fights won**
    (93 of 600, 10 seeds each). The Centiskorch "30/30" boxes were the
    Burn Up defect (ledger burn-up-user-is-unhittable), not a line.
  - **The line that works is one 4x answer per member**, and the box
    that has it wins **29/30** (fixture reteach-B-5): Monferno Brick
    Break takes Bisharp (30/30), **Gurdurr Ice Punch takes Zygarde-10%
    (30/30)** and Low Kick takes Aurorus (28/30), Grass moves take
    Carracosta, Seadra's Surf takes Lunatone and Solrock. Gurdurr with an
    Ice move is the linchpin: Zygarde and Aurorus are her killers.
  - Carrying the TYPE is not enough: 57 of 60 sixes had an Ice move. The
    carrier has to land it and survive to — which the ranker cannot see.
  - **The ranker misprices her**: its answer strength vs Zygarde
    correlates 0.03 with wins, its own pWin 0.13, and it forecast 17% for
    the 29/30 box. In fixture br-19 its first six wins 0/30 and its own
    seventh (Qwilfish for Deerling) wins 20/30 on fresh seeds (p <
    0.0001). Ten seeds misled once (sv-8: 3 vs 7 at 10 seeds, 20 vs 16 on
    30 fresh), so a six chosen by play needs more seeds and disjoint
    seeds to be believed.

### Wattson (order 229, cap 35) — the immunity lattice
- Kit traps: two Volt Absorbs (Lanturn, Zeraora), two Levitates
  (Rotom-Fan, Eelektross), **Sturdy + Custap Magnezone** (survives the
  kill, moves first next turn, Explosion), **Shuca Zeraora** (the first
  Ground hit is halved — the "obvious" Ground answer whiffs half this
  team), Mold Breaker Mega Ampharos (ignores your Levitate/Sturdy),
  Will-O-Wisp, Thunder Wave, Coil.
- Named answers: **Excadrill** (answers both Rotom-Fan and Mega
  Ampharos), Bewear (Eelektross).
- The key: stats first — the real box at 31 IVs went 15/30, the best
  counterfactual result at any wall. Excadrill is the structural name to
  add. Zeraora (127% mean hit, Close Combat, 18 kills in 12 probe
  fights) must be answered before it cleans.
- Openings: Ampharos-Mega (67% outsped), Eelektross (62%), Magnezone
  (61%) — the back half is slow.

### Norman (order 342, cap 42) — Huge Power twice
- Kit traps: Huge Power Azumarill AND Huge Power Diggersby (sash),
  Eviolite + Recover + Thunder Wave Porygon2, Mega Pidgeot, Cinccino
  (faster than the entire pool).
- Named answers: Crustle (Meloetta), Copperajah, Aggron (Cinccino).
- The key: Steel/Rock bulk walls the Normal spam; the two Huge Power
  bodies are the fight — remove them without donating turns to P2's
  Recover stall.

### Flannery (order 576, cap 57) — the widest door
- Kit traps: Mega Charizard-Y sun, Sash + Fake Out Salazzle, Extreme
  Speed Entei, Assault Vest Incineroar, Alolan Marowak (183% mean hit —
  the hardest single hitter of the early-mid game).
- Named answers: the broadest of any gym — Gigalith, Rhydon, Seismitoad,
  Gastrodon, Flygon, Carracosta, Drednaw, Golem-Alola, Hariyama.
- The key: bulky Rock/Ground/Water cores genuinely exist in the pool by
  this point (4–6% answer rates on four of her six). Kill Marowak in the
  revenge window (61% outsped); respect sun-boosted fire from the Mega.

### Winona (order 763, cap 69) — the sweep stack
- Kit traps: Choice Scarf Staraptor (170% mean hit at scarf speed),
  Quiver Dance + Sash Volcarona, Unburden + Swords Dance Hawlucha
  (one activation ends the fight), Beast Boost + AV Celesteela,
  Sky Shaymin, Mega Altaria with Roost.
- Named answers: nearly none — Jellicent (Volcarona), Corviknight
  (Shaymin-Sky). The second-worst answer field after Brawly.
- The key: this is the late stat wall. Deny setup turns (three of six
  snowball), revenge through Celesteela's slowness (62% outsped), and
  arrive overinvested. Expect a wall of the Brawly class.

### Tate and Liza (orders 1131/1135, cap 85) — two halves, same trap
- Kit traps: Sash + Stealth Rock Azelf lead, Mega Latios with Dragon
  Dance (Tate), Calm Mind Latias and Sash Hoopa-Unbound (Liza),
  Zoroark ILLUSION on Tate's side (the mon you target may not be the mon
  you see), AV Tapu Lele.
- Named answers: Muk-Alola (twice on Tate's side), Spiritomb (Azelf),
  Copperajah, Metagross (Lele).
- The key: Dark/Steel bulk again — Muk-Alola is the name that repeats.
  Break the Azelf sash before it stacks rocks; assume Zoroark until
  disproven.

### Juan (order 1369, cap 91) — DOUBLES
- Played in doubles format (currently refused in play; skip-and-owe).
- Kit traps: Sash + Fake Out Sneasler, Refrigerate Mega Glalie (spread
  Ice off Explosion-class power), Keldeo, Aqua Jet Basculegion, AV
  Glastrier.
- Named answers: Crobat, Drifblim, Chandelure (Sneasler); Torkoal,
  Walrein (Glalie); Slowking, Dragonite, Amoonguss (Keldeo).
- The key (abstract until doubles play exists): ghosts float over his
  physical spread game; Torkoal walls the Refrigerate axis.

### The Elite Four and Champion, in one line each
- Sidney: Greninja→Primarina/Chesnaught; Urshifu→Togekiss; the Mega
  Gyarados axis falls to Chesnaught.
- Phoebe: Crobat→Rhydon; Zoroark-Hisui→Incineroar; Marshadow→Gliscor;
  Illusion again — assume it.
- Glacia: the slowest team in the game (four of six outsped by 40%+ of
  the pool) — a revenge-speed team with Fire/Steel bulk; Camerupt and
  Excadrill are the recurring names.
- Drake: Avalugg and Cloyster answer Coil Zygarde; Ferrothorn and
  Abomasnow answer Calm Mind Suicune; everything else outspeeds the
  pool wholesale.
- Wallace: Exeggutor-Alola and Chesnaught answer Choice Band
  Barraskewda; Bewear/Hariyama break Curse-Rest Hisuian Goodra;
  Abomasnow/Ferrothorn take Manaphy.

## The bridge rival, measured rather than derived (2026-09-19)

Trainer Rival Bridge is a DOUBLE — six at Level 65-66 led by a Speed Boost
Mega Blaziken — and the official documentation names no answer for a single
one of them. It is the road's blocker: a run that cannot win it owes it for
ever, and sweep 13's deepest run went 0 of 120 attempts there on the engine's
own hand. On that run's own box the ranker's top twelve sixes went 0 of 33
with the joint search and the doubles prep, and a six built by hand for the
fight won 1 of 24 (about 4%, which 60 retries clear about nine times in ten).

The one win, turn by turn, is the shape of the answer:

1. **Survive the first turn.** Fake Out blunts one of the two attackers
   (Hariyama's, over Focus Punch, taught before the fight).
2. **Mega Blaziken hurts itself.** It opens Brave Bird, and the recoil puts
   it in range — nothing in the box outspeeds it, and nothing survives
   Close Combat.
3. **A fast Water finishes it on turn 2** (Barraskewda's Liquidation).
4. **Tailwind** (Ribombee) carries the middle, and a bulky Ground grinds the
   tail out (Seismitoad's Earthquake, through Blastoise's Protect).

So the named answers here are a SHAPE, not a species list: a Fake Out body, a
fast Water, a Tailwind setter, a bulky Ground. The ranker cannot reach it —
it scores a six by the best single answer per enemy, which rates bulk over
speed and prices no tool. A doubles selector would have to build its pool
from that shape.

## Archie at Seafloor Cavern, the wall the road now ends at (2026-09-20)

With the doubles fixed, sweep 16's deepest run reached fight #294 of 358
with 290+ wins, no skips, no engine refusals and every rule check clean, and
stopped at Aqua Leader Archie in Seafloor Cavern: **0 wins of 60 attempts**.

It is a rain team, and the fight is decided before any six is chosen:

- Drizzle Kyogre (Level 90, Custap Berry) with Origin Pulse, Thunder that
  cannot miss in rain, and Ice Beam;
- Mega Swampert and Overqwil, both Swift Swim, so both act twice in the rain;
- Contrary Serperior (Leaf Storm raises its own attack), Weakness Policy
  Aegislash, Zapdos with Thunder and Roost.

Measured on that run's own box of 59, at cap 89: **3 bodies survive Kyogre's
best hit** (Ludicolo, which resists Water, at 79%; Sneasler and Muk-Alola at
99-100%), and the hardest hit anyone lands on it is 72% from a Torterra that
Ice Beam removes at 273%. The run fielded none of the three survivors, and a
six built survivor-first went 0 of 12 with search, leaving three to five of
Archie's six standing.

The box held no weather move, no Water Absorb and no Storm Drain body, and
nothing in it could learn one. So the answer is not a six and not a hand: it
is a box that arrives at cap 89 with a rain answer in it, which is a
PREPARATION problem — which routes are spent, on which method, and what is
held for later.

## What this feeds next

The answers are exactly the shape `adviseCatches` wants: when the next
milestone is a leader, the named species this document derives should
outrank generic catch advice. That extension — dossiers for all 366
fights, precomputed offline so runtime pays a dictionary lookup — is
designed in the fight-dossier oracle work.

## Norman, measured on LEGAL boxes (2026-09-20)

The banked "Norman" boxes were not Norman boxes: seven of eight sit at cap
35–38 against his level 40–42 six, and four lead a level-50 Route 118 catch
from a table that opens at 618. Rebuilt legally — illegal catch stripped,
`beat` forward to 337, levelled to cap 42, relearn + advice — five boxes give:

| Lever tried | Result at Norman |
|---|---|
| decide(), as the run arrives | 0 / 100 |
| search-8 | 0 / 20 |
| every species catchable before him, swapped in (645 candidates × 6 seeds) | 4 / 3870; no species wins twice |
| every stone in the bag used (2–8 unevolved bodies a box) | 0 / 100 |
| the CEILING of Heart Scales: every body 31 IVs | 5 / 100 |
| — and a +Speed nature on every body | 1 / 100 (foes left 2.97 → 2.10) |

What the knockout record says: Porygon2 falls ~20 of 20, Azumarill ~18,
Diggersby 5–19, Meloetta rarely, Cinccino almost never, **Mega Pidgeot never,
in 120 fights**. From the box matrix, **0 of 24 bodies outspeed Meloetta,
Cinccino or Mega Pidgeot in any box**, and no box holds a one-on-one winner
for all six (acc-11 has none for Pidgeot; sac-A-6 none for Diggersby or
Meloetta; speed-plus23 none for Meloetta).

So at Norman the catch, the stone, the level, the IV, the nature and the
search have each been measured and none is the lever. Untested, and what is
left: held items (every one of his six holds one; our sixes hold nothing or
type-boost filler), speed control and priority (Mach Punch is super
effective on five of his six; sac-A-6's Breloom and Conkeldurr are its only
1v2 winners over Cinccino), and setting up on Porygon2, which is passive
(Tri Attack 38%) while our lead spent eight turns Super Fanging into Recover.

**Rejected at Norman, 2026-09-20 — reserving an answer for its matchup.** A
fight reached Mega Pidgeot holding the one body that one-shots it (Drednaw,
Head Smash) at 14% health, spent earlier on Porygon2. An arm assigned each of
the six to the foe the matchup board says it beats (best cover of 720
orderings), sent that body at a forced replacement and held reserved bodies
back. With every legal lever stacked, five boxes × 20 seeds: foes left 2.40
without it, **2.71 with it**, Diggersby knockouts 94 → 75. The board covers
only 3–4 of his six in any box, so holding the covered ones back feeds the
rest to the foes nobody answers. Removed, not flagged off. The stacked legal
levers (stones, items, berries in empty slots, --loser-work) reach Meloetta
45 times and Cinccino 15 in 100 fights, and Mega Pidgeot still never falls.

## Norman, the lever (2026-09-21): a PLAN, not a part

Seed 842113 (clear1, pinned 1c82d50) lost Norman 40 times; its box replayed
0 of 170 across every control. Four sibling seeds beat him in 2–6 attempts.
Read side by side, the wins share a shape and the loss lacks it:

- **his first falls to the lead, cleanly.** The losing six led Gigalith — the
  board's one Mega Pidgeot answer — and spent it (Self-Destruct, 44 times in
  40 attempts) on Porygon2. It met Meloetta already 3.3 bodies down; the
  winners met her 1–2 down.
- **a Fighting hit is held for Meloetta and Cinccino.** Staraptor's Close
  Combat, Conkeldurr's Brick Break, Throh's Storm Throw (always a crit).
- **the Electric or Ice type is held for the Mega**, and arrives fresh.

From 842113's OWN box, `Infernape > Victreebel > Krookodile > Kingdra > Throh
> Eelektross` wins **13 of 40 on fresh seeds** under plain decide(), with the
moves the run had. Every part alone measured nothing, which is why the
one-lever-at-a-time table above found nothing:

| Infernape in | closers held back | decide(), 30 fights |
|---|---|---|
| – | – | 0 |
| – | ✓ | 0 |
| ✓ | – | 0 |
| ✓ (+ Throh) | ✓ | 13 of 40 |

Why nothing found it: the ranker's winner rule is our minimum roll against
their maximum, so Throh into Cinccino (93–112% a hit, taking 42–52%) is "no
answer"; the re-pick chooses among the ranker's sixes in the ranker's order,
by wins alone, and at a wall they all win none. `--plan-after`
(scripts/headless-run.js planByPlay) has the board propose generously and
play decide: on this box it took 135 s and went **0 of 40 → 3 of 40** on
fresh seeds by itself (bar declared first: ≥ 2 with the control at 0). It
found the closers and not the lead; the hand plan's 13 is the headroom.

**Void, and why:** arms that taught Infernape Brick Break (decide 5–6 of 30;
search 1 of 10) — its tutor stands on Route 118, order 623, and the teach rule
never asked where a tutor was. Fixed (da27918); no real run had leaned on it.
**Refuted:** taking Self-Destruct off Gigalith (foes left 2.20 → 3.17 — the
explosion does real work); four Fighting types in the ranker's order (0 of
20); a hypothetical Staraptor under decide() (Cinccino falls 14 of 30, no
wins, and decide() never clicks Tailwind).
