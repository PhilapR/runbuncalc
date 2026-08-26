# Strategy

The route book. What the engine has actually been made to do, with the numbers
it printed and the commands that reproduce it.

## How a claim earns a row here

A strategy gets a section when it was **played** — driven through `run.js` /
`battle-driver.js` on a real run document — and then **survived an adversary**
who tried to break it on fresh seeds, a fresh box, and its own reading of the
guards. Numbers here are engine output, not arithmetic done alongside the
engine. Every section names the scratch script that printed them.

Three standing caveats travel with every number:

- **The floor policy underestimates.** `fightPlaybook` runs assignment
  switches plus best-forecast move and says so in its own reply: *"floor:
  assignment switches + best forecast move — a lower bound, not a promise."*
  A pWin here is a comparison key between two lines, never a promise about one.
  `battle-driver.adjudicate` on the same states routinely reports higher pWin
  and keeps the same ordering in deaths.
- **pWin at 16-30 rollouts is ordinal.** Seed-to-seed spread of 10-20 points is
  normal. The *set* of sub-100% fights reproduces; the point estimate does not.
- **Catches are face-value, rolls are gated.** `catch` accepts anything the
  table could have produced. `rollEncounter` refuses what the road has not
  reached, by name. A box assembled at `t0` is a control, not a playthrough.

The law these strategies obey lives in `DECISIONS.json`. Where the book and a
ruling disagree, the ruling wins and the book is wrong.

---

## I. Skip Camper Gavi, come back at cap 21

**The play.** `#48 Camper Gavi` is the single most expensive fight in the
Brawly split and the only wall in it the road lets you walk past. Declare the
skip, take the museum, come back once the cap steps to 21.

**Numbers** (`wf-book-04-gavi.js`, reference box Treecko/Abra/Shroomish/
Phanpy/Combee/Shinx, floor policy, 24 rollouts × seeds 4242/777/90210):

| | cap | pWin | eDeaths |
|---|---|---|---|
| Gavi in place at #48 | 17 | 33% / 33% / 38% | 5.50 / 5.50 / 5.46 |
| Gavi after the museum | 21 | 100% / 100% / 100% | 0.71 / 0.42 / 0.50 |

The delay is free because the road between is free. Same box, same policy,
24 rollouts, seed 31337: `#53 Aqua Grunt Museum #1` 100% / eD 0.17, `#56
Museum #2` 100% / eD 1.13, `#59 Battle Girl Laura` 100% / eD 0.50, `#62 Sailor
Brenden` 100% / eD 1.33. Every intervening fight is winnable at a floor of
100% while Gavi at cap 17 floors at a third.

**Why Gavi and not "walk past him".** Position fast-forwards. Beating a fight
ahead means the road behind fell on the way, and the guard opens with it —
measured (`wf-book-05-guards.js`, current build): beat `Leader Brawly` from
`t0` with Gavi never fought and `rollEncounter(Route110)` returns **Mareep**.
The route is open. A *declared* skip is the only thing that holds it shut:
after `skip Camper Gavi` and walking the whole split, `rollEncounter(Route110)`
still answers *"roll: Route110 is not reachable yet — Camper Gavi (#48) guards
it"*, and the road prints `#48 Camper Gavi | #83 Bug Catcher Lyle | #86 Bug
Maniac James` — the skipped fight stays first among what remains. Beating him
later settles the skip and leaves `position` at 77.

**The cap ladder that prices it** (`wf-book-01-probe.js`): 12 through order 19,
17 through order 56, 21 from order 57, 25 from order 78. The earliest legal
comeback is immediately after `#56`; the first fight actually drawn at cap 21
is `#59`.

**Commands.**

```
skip Camper Gavi --for "cap 17 wall"
beat Team Aqua Grunt Museum #1
beat Team Aqua Grunt Museum #2      # cap steps 17 -> 21 at order 57
beat Camper Gavi                    # settles the skip; position does not move
```

**Who may be skipped at all.** The profile names them and the engine refuses
everything else. Current build (`profiles/run-and-bun/index.js`):
`delayableFights: ['Camper Gavi']`, `optionalFights: ['Triathlete Pablo']`.
Measured: `skip Camper Gavi` ACCEPTED, `skip Triathlete Pablo` ACCEPTED,
`skip Battle Girl Luna` REFUSED, `skip Tuber Chandler` REFUSED — *"is a
required fight — the road goes through them. Only these can be walked past:
Camper Gavi, Triathlete Pablo."*

Ruling: **skips-are-declared**, **the-map-is-the-required-road**.

---

## II. Hold Granite Cave until a Static lead exists

**The play.** Granite Cave 1F's walk table gives Togedemaru one 5% slot.
A Static lead makes half of all encounters Electric when the table has any, and
Togedemaru is the table's only Electric. Hold the cave, take Route 110 when
Gavi falls, put an Electrike with declared ability Static in slot 1, then roll.

**Numbers** (`wf-book-03-hold.js`, 2,000 seeded rolls per row, LCG seed
20260813 — `rollEncounter` draws `random()` twice, once for the pull coin and
once for the slot, so the sweep needs a real stream):

| lead | Togedemaru | rest of the table |
|---|---|---|
| no declared ability | **5.7%** | Phanpy 30.9, Rhyhorn 19.9, Cufant 19.1, Onix 10.4, Aron 9.4, Sandile 4.5 |
| Electrike, **Static** | **53.5%** | Phanpy 15.2, Rhyhorn 9.8, Cufant 9.2, Onix 5.3, Aron 4.7, Sandile 2.5 |
| Electrike, Lightning Rod | 5.0% | unchanged — table rolls flat |

Analytic target is 52.5% (`0.5 + 0.5 × 0.05`); the ledger's own figure is 52%;
the tape says 53.5%. The pull is named in the reply when it fires:
`"pull":{"ability":"Static","type":"Electric"}`. No declared ability, no pull —
Lightning Rod is the control and it moves nothing.

*Amendment (cross-checked against pokemon-mono's independently sourced
encounter tables, which agree):* **roll B1F, not 1F.** Togedemaru is 10% on
Granite Cave B1F — double the 1F slot — and under the area rule the cave is
one encounter whichever floor you roll, so the same held Static play prices
at `0.5 + 0.5 × 0.10 = 55%`. Magnet Pull on 1F is stronger still on paper
(Cufant + Aron ≈ 30% Steel → 65%) but pulls Steel, not the Electric slot
this play is for.

**Commands.**

```
hold GraniteCave1F --for "wait for a Static lead"
beat Camper Gavi                          # opens Route110 (#48)
catch Electrike Route110 12 --ability Static
party Electrike ...                       # Static mon in slot 1
roll GraniteCave1F walk
```

Ruling: **the-lead-pulls-the-grass**.

---

## III. The four-catch route to Brawly

**The play.** Four routes, spent in the only order their guards allow, each on
a specific slot: **Starly** @ Route102 (walk 30%, L5, open at #0) → **Combee**
@ Route104 (walk 5%, L5, open at #11) → **Gligar** @ Granite Cave Steven's Room
(walk 15%, L8, open at #25) → **Shinx** @ Route110 (walk 30%, L12, open at
#48), with Lillipup @ Route101 as the sixth. Fielded at cap 21 as
Grovyle / Herdier / Staravia / Vespiquen / Gligar / Luxio.

**Numbers at `#77 Leader Brawly`, cap 21** (`wf-book-07-routed.js`, floor
policy, 30 rollouts × seeds 7/13/21):

| box | pWin | eDeaths |
|---|---|---|
| naive-modal (routes in opensAt order, modal ungated slot) | **1%** [0,0,3] | 5.99 |
| reference walkthrough box (Abra/Shroomish/Phanpy/Combee/Shinx) | **44%** [37,43,53] | 5.49 |
| **routed** | **84%** [80,83,90] | 3.59 |

Re-measured on the same protocol in `wf-book-08-complement.js` with Horsea in
the Route104 slot: **92%** [93,90,93]. Treat the headline as *1% → 84-92%*
against the naive baseline, *44% → 84-92%* against the reference box.

The guards really do force the order (`wf-book-05-guards.js`, refusals from
`t0`, each naming its own guard):

```
Route104                   Triathlete Mikey (#11) guards it
Granite Cave 1f            Lady Cindy (#16) guards it
Granite Cave B2f           Fisherman Elliot (#22) guards it
Route106                   Fisherman Elliot (#22) guards it
Granite Cave Stevens Room  Ruin Maniac Georgie (#25) guards it
Route110                   Camper Gavi (#48) guards it
Route116                   Youngster Joey (#103) guards it
Route117                   Battle Girl Luna (#162) guards it
Route111 / Route118        Picnicker Bianca (#192) guards it
```

`opensAt` 0 → 11 → 25 → 48 is strictly increasing, so Route102 → Route104 →
Steven's Room → Route110 is the only order those four admit.

**The museum half is a naive-baseline claim only.** Every box wins `#53` and
`#56` at pWin 1.00; the wall is deaths, not defeat (`wf-book-07-routed.js`,
30 rollouts × 3 seeds, cap 17): naive-modal 2.533 + 1.913 = **4.447** eDeaths,
routed 0.067 + 0.633 = **0.700** (a 84% cut), reference walkthrough box 0.157 +
1.157 = **1.313**. Routed beats the reference box at the grunts too, but by
0.6 deaths, not by a factor of five.

**Commands.**

```
catch Lillipup Route101 2
catch Starly Route102 5
beat Triathlete Mikey              # opens Route104
catch Combee Route104 5
beat Ruin Maniac Georgie           # opens Granite Cave Stevens Room
catch Gligar GraniteCaveStevensRoom 8
beat Camper Gavi                   # opens Route110  (or settle the §I skip here)
catch Shinx Route110 12
party ...
```

---

## IV. Gligar is the lever, and the advisor cannot see it

**The play.** Of the four routed picks, the Granite Cave slot carries the fight.
Leave-one-out from the routed box, route budget held fixed, one slot swapped on
the same route (`wf-book-08-complement.js`, 30 rollouts × seeds 7/13/21,
baseline **92%**):

| swap | pWin | delta |
|---|---|---|
| Granite Cave: Gligar → Phanpy | 17% | **−75** |
| Route110: Shinx → Tynamo (Eelektrik) | 78% | −14 |
| Route102: Starly → Surskit | 79% | −13 |
| Route104: Horsea (Seadra) → Combee | 85% | +(−7), noise |

And from the naive box, adding one pick at a time:

| box | pWin |
|---|---|
| naive | 2% |
| naive + Shinx | 0% |
| naive + Starly | 22% |
| **naive + Gligar** | **79%** |
| naive + Starly + Gligar | 88% |
| naive + Gligar + Shinx | 74% |

**The advisor never offers it.** `adviseCatches(doc, 'Leader Brawly')` at
position 76 returns `considered 21, gated 18, routesOpen 13, cap 21`, and its
ten rows are topped by **Shinx / Carnivine / Remoraid**. Gligar is not among
them; Phanpy is, at row #9 (`wf-book-09-advisor.js`).

**The mechanism.** `run.js:859` slices each route's prospects to its three
highest-chance rows (`.slice(0, 3)`), and the `gated:` flag is added at
`run.js:874` — *inside the post-slice `.map`*. Truncation precedes gate
filtering, so rows gated until
order 589 (`oracle.methodOpensAt('surf') = 589`) consume shortlist slots.
Measured coverage across the 13 routes open inside the split: 105 distinct
ungated walk/fish species on the twelve non-cave areas plus 26 across Granite
Cave's four floors = **131**; ungated rows surviving into `best` = **21**;
**21/131 = 16.0%**. Per route: Dewford Town 0/16, Route109 0/7, Petalburg City
1/5, Route110 1/10, Slateport City 1/4, Route104 2/16, Route102 2/11.

Use `adviseCatches` for what it grades and read the route table yourself for a
15% slot. Reordering gate-before-slice would only reach 39/131 (29.8%); the
three-row cap, not the ordering, is the dominant limiter.

---

## V. One catch for the whole cave — buy the Zygarde answer elsewhere

**The rule, verbatim.** After `catch Phanpy GraniteCave1F 8`, every other floor
refuses (`wf-book-06-onecave.js`):

```
catch: this run already used its one Granite Cave encounter on Phanpy on
Granite Cave 1f — a location gives one random catch, and releasing or losing
it does not refund it
```

B1F, B2F and Steven's Room all give the same answer. Route106 and Route102 are
separate locations and accept immediately after.

**What the cave slot is for.** `#139 Leader Roxanne` at cap 25 fields Bisharp
L23 | **Zygarde-10% L23** | Aurorus L24 | Carracosta L24 | Lunatone L25 |
Solrock L25. Ice one-shots the Zygarde, and the engine's own assignments say so
(`wf-book-12-roxanne.js`, one catch added to a solo-starter run, walked to
#138, 12 rollouts, seed 4242 — damage as % of the target's HP):

| pick | route (opensAt) | move on Zygarde-10% | damage |
|---|---|---|---|
| Sneasel | Granite Cave B2f (#22) | Ice Punch | 206-244% |
| Chewtle → Drednaw | Route106 (#22) | Ice Fang | 206-244% |
| Amaura | Granite Cave B2f (#22) | Stomp | 150-175% |
| Spheal → Sealeo | Route106 (#22) | Aurora Beam | 131-156% |
| **Carvanha** | **Route102 fish (#0)** | Ice Fang | **113-138%** |
| Phanpy → Donphan | Granite Cave 1f (#16) | Ice Shard | 88-106% |

Everything at or above 100% minimum is a guaranteed one-shot. **Carvanha is on
Route102's fish table (20% of Surskit 40 / Psyduck 20 / Remoraid 20 / Carvanha
20) and Route102 is open at order 0** — `rollEncounter` on a fresh doc returns
Psyduck and never refuses. Route106's fish table is Spheal 40 / Chewtle 40 /
Shellder 10 / Staryu 10 and opens with Elliot at order 22, the same fight that opens
B2f, at no cost to the cave's single encounter.

So: the cave's one catch is worth spending on **Gligar** for Brawly (§III–IV),
and the Roxanne answer bought off Route102 or Route106 instead. Note also that
Phanpy only reaches 88-106% *after* evolving to Donphan — an evaluation that
never evolves the candidate scores this table wrong by more than a third.

---

## VI. Where the split's deaths are

Fresh, undamaged six-box at **every** fight, no carry-forward — the map's own
toll, not a campaign (`wf-book-10-concentration.js`, 16 rollouts × seed bases
770000/111000, floor policy, all 26 fights at order ≤ 77):

**reference box** — total 24.16 eDeaths

| # | trainer | eDeaths | pWin |
|---|---|---|---|
| 48 | Camper Gavi | 5.69 | 22% |
| 77 | Leader Brawly | 5.69 | 32% |
| 73 | Battle Girl Jocelyn | 3.00 | 78% |
| 16 | Lady Cindy | 2.09 | 100% |
| 19 | Team Aqua Grunt Petalburg Woods | 1.91 | 100% |

`#48 + #77 = 11.38 = 47%` of the split toll. Sub-100% fights: #48, #77, #73.

**routed box** — total 23.96 eDeaths

| # | trainer | eDeaths | pWin |
|---|---|---|---|
| 48 | Camper Gavi | 5.90 | 7% |
| 16 | Lady Cindy | 3.34 | 97% |
| 77 | Leader Brawly | 3.16 | 100% |
| 11 | Triathlete Mikey | 2.91 | 100% |

`#48 + #77 = 9.06 = 38%`. Sub-100% fights: #48, #16.

Two things are stable across both boxes and every seed base measured:
**`#48 Camper Gavi` is the most expensive fight in the split**, and it is the
one the profile lets you walk past. That is the entire case for §I. What is
*not* stable is the pair: for the routed box `#16 Lady Cindy` outranks Brawly,
and the concentration is 38%, not the 60-67% the folklore quotes.

---

## VII. Under permadeath, the split does not clear

24 permadeath lives, deaths written into the document before the next fight
opens, `fightPlaybook` at 1 rollout on the life's own seed
(`wf-book-11-lives.js`, seeds 3/11/19/29/41/59/67/71):

| config | clears | median fights won | wiped at | mons lost |
|---|---|---|---|---|
| reference box | **0/8** | 9 / 26 | 19, 25, 22, 19, 29, 29, 29, 22 | 48 of 48 |
| routed box | **0/8** | 7 / 26 | 16, 16, 22, 16, 19, 16, 25, 32 | 48 of 48 |
| routed + declared Gavi skip | **0/8** | 7 / 26 | identical | 48 of 48 |

Every life loses all six. Deaths cluster where the cap is 12: reference box
`#19 ×18, #16 ×9, #14 ×6`; routed box `#16 ×15, #11 ×14, #19 ×8`.

Read that against §III honestly. **The routed box is a Brawly answer, not an
early-game answer, and under permadeath it dies sooner than the box it beats
at Brawly** — median 7 fights won versus 9. Lillipup L2, Starly L5, Combee L5
and Gligar L8 are exactly the wrong shape for the cap-12 killing field at
#11/#14/#16/#19. The §III numbers are a fresh-box control: they say what the
box is worth *if it arrives*, and 24 lives say it does not.

The Gavi skip changes nothing in this table because no life reached #48.

---

## Refuted folklore

Each of these was played and did not survive the tape.

**"Skipping Bianca (or Luna) prices her guard."** Not representable. `skip
Picnicker Bianca` and `skip Battle Girl Luna` are both REFUSED by the current
build — neither is in `delayableFights` or `optionalFights`. And omitting her
`beat` does not shut her routes: a fight-by-fight walk to `#224 Leader Wattson`
with Bianca's `beat` left out prints `routesOpen 20, Route111 open=true,
Route118 open=true`, identical to the walk that beats her, because position
fast-forwards and the road behind fell on the way. Fast-forwarding straight to
Wattson from `t0` gives the same. The "routesOpen 14 vs 16 at #224" price of
the Bianca skip cannot be reproduced under the law as it now stands
(`wf-book-05-guards.js` and the fast-forward probe in the same session).
Her *guard* is real — `rollEncounter(Route118)` from `t0` answers *"Picnicker
Bianca (#192) guards it"* — but a guard you cannot decline is not a decision.

**"Luna is the second Camper Gavi and the skip is strictly correct."** Refuted
twice over. She cannot be skipped (above), and the road to the comeback is
harder than the fight skipped: on the adversary's thin box `#173 Breeder
Isaac`, `#177 Anna And Meg`, `#181 Chelle Daycare` and `#187 Tyron & Celina`
all floor at 0% pWin / eD 5.00 while Luna at cap 32 floors at 21-38%
(`wf-adv2-gauntlet.js`, `wf-adv2-road.js`). Gavi's road is 88/100/100% — that
is what makes his delay free and hers not. The "coin flip at cap 32" is also
box-specific: a Mudkip/Abra/Shroomish/Phanpy/Combee/Shinx box beats her at cap
32 at 100% with eDeaths 0.25-0.42 (`wf-adv2-luna.js`).

**"Luna's comeback is #187." "Bianca's cap raise lands after #230."** Cap
arithmetic, wrong both times. The ladder steps at orders, not fights:
`150 → 32`, `182 → 35`, `225 → 38` (`wf-book-01-probe.js`). No fight occupies
order 182 or 225 — the earliest cap-35 point is order 182, and 38 arrives at
225, the order immediately after Wattson at #224. The first fight *drawn* at
cap 38 is #230, which is where "after #230" came from.

**"Elliot must fall before you roll the cave, because B2f is the run's only
pre-Roxanne answer to Zygarde-10%."** The guard, the one-catch-per-cave rule
and Elliot's zero cost all check out. The reason does not. §V shows Carvanha
on **Route102 fish, open at order 0**, one-shots the Zygarde at 113-138%
minimum — before any guard falls. And the same fight that opens B2f opens
**Route106**, a separate location whose fish table is 80% Spheal/Chewtle, both
guaranteed one-shots, at no cost to the cave's encounter. Beating Elliot before
rolling the cave is a convenience; it is not forced by Roxanne.

**"Phanpy manages 69% on the Zygarde."** An evaluation that never evolves.
Phanpy → **Donphan** reads 88-106% with Ice Shard (`wf-book-12-roxanne.js`) —
a miss of more than a third. Any candidate ranking that scores mons at their
catch level and base form is ranking catch level, not species.

**"Route access was never the binding constraint; pick quality on the routes
already visited was."** Refuted by construction: the experiment granted all six
catches at fight `#0`, which deletes access from the model. Honoring each map's
own anchor (`Route104 #11`, `GraniteCave1F #16`, `PetalburgWoods #19`,
`DewfordTown #29`, `Route110`/`SlateportCity #48`) collapses every box —
base 8.00 → 1.00 fights won, sameroutes 15.33 → 10.53, strong 14.33 → 3.00,
strongest 13.47 → 1.33 (`wf-refute-gated.js`). Access costs 4.8-13.3 fights,
more than the entire pick-quality effect. The same-route-beats-cross-map
ordering is also a seed artifact: over 45 seeds sameroutes 15.00 vs strong
14.93, Welch t = 0.10 (`wf-refute-camp.js`).

**"The four routed catches are pure complements — the two strongest picks buy
literally nothing alone."** Did not reproduce here. On my construction
`naive + Gligar` alone is **79%** against a 2% naive baseline
(`wf-book-08-complement.js`); the pick is worth +77 points on its own. The
complementarity result *does* reproduce when the Route104 fish slot is dropped
— `Lillipup/Surskit/Tentacool/Gligar/Shinx` scores 6% and adding Starly takes
it only to 9% (`wf-book-07-routed.js`) — so what the CORE ladder actually
measures is that Gligar needs a surviving partner in the box, and Seadra or
Croagunk will do. The four are not complements; Gligar is a lever and the rest
are the fulcrum it needs.

**"Gligar is the single largest same-route swap in the split, +0.14 played
pWin."** The advisor's blindness to Gligar is real (§IV) but nearly free on
that route: against an otherwise identical box, Gligar 0.0825 vs the
advisor-visible Phanpy 0.0950 over 4 seeds × 120 rollouts (`wf-adv4-06-precise.js`).
On a *strong* box the gap is enormous (§IV: 92% → 17%); on a weak one it is
zero. The swap's value is conditional on the rest of the box, not a constant.

**"#48 and #77 are the top-2 expected-death fights for every box."** True for
the reference box (5.69 / 5.69, next is 3.00). Not true for the routed box,
where `#16 Lady Cindy` at 3.34 outranks Brawly at 3.16, and the pair carries
38% of the toll rather than 60% (§VI). `#48` alone is top-1 everywhere
measured; the pair is not.

---

## Open questions

**Is Luna or Bianca actually reorderable in the overworld?** `DECISIONS.json`
holds this open as `reorderable-fights`: the author's Trainer Battles doc
records rosters, not overworld movement. Gavi is operator-confirmed;
`#162 Battle Girl Luna` (Route117) and `#192 Picnicker Bianca` (Route111 +
Route118) are structurally identical in the data — sole anchors of their
routes, cap raise past their own split boss — and wait on the same
confirmation. Until then §I is the only skip play in the book, and everything
priced against a Luna or Bianca skip is priced against a move the engine
refuses to record. **Settled by:** operator confirmation, then a profile row.

**Does the routed box survive if it is caught on schedule?** §III measures it
assembled at `t0`; §VII kills it before Brawly. Nobody has yet played a
gate-honest permadeath campaign that catches Starly at #0, Combee after #11,
Gligar after #25 and Shinx after #48 and then reports Brawly. The two halves
of this book have never met. **Settled by:** a gated campaign harness over
≥15 seeds reporting median wipe order and a Brawly rate.

**Is Route118 worth Bianca's fight?** The reported gate content — 25.0%
combined KO-carrier chance vs Wattson, 40.0% vs Norman, Route118 topping every
walk table anchored at ≤ #337 — reproduced structurally (`wf-refute-06-tables.js`),
but 20 of those 25 points is Kangaskhan, which does not convert in play
(baseline 0% at #224, +Kangaskhan L50 → 0-8%, +Carnivine L50 → 38-50%,
`wf-refute-07-overcap.js`). Route111 contributes 0.0% against both bosses, so
"Route111+118" is Route118 alone. **Settled by:** a played campaign that spends
Route118 on Carnivine and reports Wattson and Norman.

**What does the 3-row cap cost, really?** §IV measures coverage (16.0%) and the
counterfactual ordering fix (29.8%), but not the *play* cost of the 79 species
never graded. **Settled by:** grading all 131 ungated prospects at cap and
comparing the best against `adviseCatches`' own top row, per boss.

**Does the Static hold generalize?** Measured only on Granite Cave 1F, whose
table has exactly one Electric slot — the cleanest possible case (5.7% →
53.5%). A table with three Electric slots splits the pulled half three ways.
No other map has been swept. **Settled by:** the same 2,000-roll sweep over
every table with ≥1 Electric or Steel slot open before the split boss.
