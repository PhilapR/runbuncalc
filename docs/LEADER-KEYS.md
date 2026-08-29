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

## What this feeds next

The answers are exactly the shape `adviseCatches` wants: when the next
milestone is a leader, the named species this document derives should
outrank generic catch advice. That extension — dossiers for all 366
fights, precomputed offline so runtime pays a dictionary lookup — is
designed in the fight-dossier oracle work.
