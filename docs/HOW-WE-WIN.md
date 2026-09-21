# What our wins are made of

Regenerate any row with `node scripts/how-it-won.js --report=RUN.json
--trainer=NAME`. It replays the winning attempt on the document as the run
walked up to the fight, with the attempt's own seed and hand, and refuses if
the replay does not reproduce the ledger. All eleven below reproduced.

Runs: the valid baseline seeds (docs/PERFORMANCE.md), revisions 85a86f2 and
dd0883f, search-8 after two losses, up to 40 attempts a wall. 2026-09-21.

| Fight | Won on attempt | Turns | Bodies given up | Pivots | Set-up | Speed control / status / pivot moves | Priority |
|---|---|---|---|---|---|---|---|
| Brawly (209499) | 25 | 25 | 5 | 5 | 0 | Thunder Wave | 0 |
| Roxanne (104770) | 31 | 19 | 5 | 1 | 0 | — | 0 |
| Wattson (209499) | 34 | 29 | 5 | 6 | 0 | Bulldoze ×2 | 0 |
| Norman (104770) | 23 | 19 | 5 | 1 | 0 | **Tailwind** | 0 |
| Norman (209499) | 13 | 19 | 6 (one twice) | 2 | 0 | U-turn | 0 |
| Norman (314228) | 20 | 21 | 5 | 4 | 0 | **Tailwind ×2** | 0 |
| Maxie, Mt Chimney (104770) | 5 | 29 | 6 (one twice) | 0 | 0 | — | Sucker Punch |
| Shelly (104770) | 20 | 16 | 5 | 3 | 0 | — | 0 |
| Shelly (209499) | 10 | 22 | 5 | 2 | 0 | **Tailwind** | 0 |
| Winona (104770) | 10 | 16 | 5 | 2 | 0 | **Tailwind** | 0 |
| Winona (418957) | 14 | 14 | 4 | 1 | 0 | — | 0 |

## What that says

**Every win is a trade of the whole team.** Four to six bodies are given up in
every one of eleven wins; not one is clean, and most end with the last body
standing. Under `permadeath: false` that counts as a win. Under a nuzlocke's
rules each of these "wins" ends the run a fight or two later. The harness is
not beating these walls so much as out-lasting them once in twenty tries.

**We win without control.** Zero set-up turns in eleven wins. No screens, no
hazards, no Fake Out, one priority move, one Thunder Wave, one U-turn. The
operator's correction — fights are won by taking control and reaching
favourable positions, not by one-on-ones — describes exactly what is absent.

**The one control tool that shows up is speed control, and it shows up in the
wins: Tailwind in five of eleven**, always from a body that happened to have
it by level-up (Staraptor four times, Noivern once). That agrees with the
board, where nothing in any box outspeeds a wall's back line, and with the
operator's earlier note that speed is the most important thing to manage. The
search finds Tailwind when it is there. Nothing in the harness makes sure it
IS there.

**The lines the search does find are real ones.** Shelly (104770): a lead
pivot to eat Fake Out; a Superpower chip that breaks Dragonite's Multiscale; a
28% Luxray sacked so Lycanroc-Dusk comes in clean and one-shots Dragonite and
Tornadus — the two that cost 1.3 and 1.9 bodies a facing in the losses; and
Carnivine held back all fight for Mega Blastoise, living through Dragon Pulse
on 13%. Lead pivots on turn one or two recur (Winona, Shelly, Roxanne,
Wattson). These are found at about one attempt in twenty, by rollouts, and
forgotten.

**It is not the dice.** Crits across the eleven wins: ours 9, theirs 8.

## What follows

1. Prepare control on purpose: a speed-control move (Tailwind, Thunder Wave,
   Icy Wind, Bulldoze, Electroweb) in the six for a wall whose back line
   outspeeds the box, the way thresholdPrep already prepares a priority move
   for a Focus Sash + Reversal lead. Measurable on the legal Norman boxes.
2. ~~Set-up: not one turn in eleven wins.~~ **Checked 2026-09-21, and it is
   the hack's design, not ours.** The author's learnset document names Dragon
   Dance, Swords Dance, Calm Mind, Quiver Dance, Nasty Plot, Bulk Up, Shell
   Smash and Stealth Rock ZERO times — Gyarados has no Dragon Dance, Scizor no
   Swords Dance, Volcarona no Quiver Dance — and there is no TM or tutor for
   any of them. The ENEMY keeps them (Matt's Gyarados, Winona's Volcarona).
   What the player is left with is what the wins already show: speed control
   (Thunder Wave in 40 learnsets, Tailwind in 24), screens (Reflect and Light
   Screen in 19 each), status, priority and pivoting. A survey of 17 saved
   boxes found speed control known by the six in every winning fight and
   another 22 speed-control and 9 priority moves sitting on benched bodies —
   and every Heart Scale spent, so the 25 speed and 33 priority moves one
   scale away could not be remembered. Rock Tomb (TM46) and Icy Wind (TM33)
   were teachable 35 times and owned never.
3. Judge a win by what it cost. "Bodies given up" belongs beside every win
   rate; a line that wins five-for-six is not a nuzlocke line.
4. Keep the lines. A winning line found on attempt twenty is evidence about
   the fight, and the next run starts from nothing.
