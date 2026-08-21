# What the game has that the tool does not model

An audit of the whole platform against the R&B author's own workbooks in
`docs/official/`, run 2026-08-21. Every number below was measured, not
estimated; the commands are given so they can be re-run.

## The shape of it

The battle engine is mature. The GAME-WORLD model is thin.

Nothing here is about damage, mechanics, or AI. `ai/src/switch.ts` scores
switch-ins and `evaluateForcedSwitchActions` handles post-KO entry, so the
Post-KO Switch-in AI workbook is already covered. The gaps are all in one
place: **what exists in the world, and how you get it.**

## The defect underneath all of it

The tool has ONE word for two different situations, and they are opposites.

```
$ node scripts/ask.js where Kubfu      -> NOT FINDABLE
$ node scripts/ask.js where Caterpie   -> NOT FINDABLE
```

Kubfu is a **guaranteed free gift**. Caterpie is on the hack's
**Unavailable** list and can never be obtained at all. For a nuzlocke
planner those are the two most different answers possible — one is a
Pokemon you are missing, the other is one you must stop planning around —
and the tool says the same thing about both.

Everything below is a variation on that: an absence the tool cannot
distinguish from a fact.

## Measured coverage

| | modelled | exists |
|---|---|---|
| Species with a wild source | 472 | 472 |
| Species declared **unavailable** | 0 | ~416, in 8 generation rows |
| Game Corner reward tiers | 0 | 8, one per badge |
| In-game trades | 0 | 3 |
| Other gifts | 0 | egg, Castform, Kubfu, fossils |
| Field items | 28 | 127 location references, 6 categories |

Reproduce:

```bash
node scripts/ask.js where Kubfu          # NOT FINDABLE — it is a gift
node scripts/ask.js where Caterpie       # NOT FINDABLE — it does not exist
```

### The economy debits what it cannot credit

`lib/run.js` charges **Rare Candy** for every level over the cap and a
**Heart Scale** for every relearner move. Neither appears anywhere in the
28 modelled field items, so the tool spends two currencies it cannot tell
you how to earn. `Item Locations.xlsx` opens with a "Heart Scale Location"
sheet naming Route 104, Route 106 and 125 more.

Every evolution stone is missing too — Fire, Water, Thunder, Moon, Sun,
Dusk — which is the input an evolution plan needs most.

### What the Game Corner actually pays

Each badge unlocks a random draw from a set. The last one is not a
curiosity; it is four mythicals:

| Badge | Reward pool |
|---|---|
| Knuckle | Smoochum, Elekid or Magby |
| Stone | Tauros or Miltank |
| Dynamo | Throh or Sawk |
| Balance | Pinsir or Heracross |
| Heat | Larvitar or Beldum |
| Feather | Dratini, Bagon, Deino |
| Mind | Gible, Goomy, Jangmo-o or Dreepy |
| Rain | Mew, Celebi, Jirachi or Victini |

Eight guaranteed Pokemon across a run, gated on progress the tool already
tracks, and it mentions none of them.

## The plan

Four phases, ordered so each is useful alone and the cheapest honesty
comes first.

### Phase 0 — say which kind of nothing it is

Add the Unavailable list as profile data and split the answer in two:
`unavailable` (the hack removed it) against `not-modelled` (we have not
taught the tool that source yet).

Smallest change here, largest change in trust: it stops the tool implying
that a free gift and a deleted species are the same thing. It also makes
every later phase measurable, because "not modelled" becomes a countable
set rather than silence.

**Done when** `ask.js where Caterpie` says unavailable, `ask.js where
Kubfu` says not-modelled, and a gate fails if any species falls in
neither bucket and has no wild source.

### Phase 1 — non-wild species sources

One `sources` table in the profile covering gift, trade, fossil,
game-corner, egg and static. Each entry carries its location, its gate
(badge or fight order, so it sorts into the timeline already built), and
the option set with odds where the game rolls.

This is the phase that changes play. Eight badge rewards plus three
trades plus the egg, Castform, Kubfu and the fossils are free Pokemon a
nuzlocke would plan around, and the catch advisor cannot currently see
any of them.

**Done when** `whereToFind` answers for all of them, they appear in the
encounter planner at their gate, and the Game Corner tiers show their
option sets the way a wild table shows its odds.

### Phase 2 — the item economy

Model the six `Item Locations.xlsx` sheets, in this order: Heart Scales
and Rare Candies first, because the engine already charges them; then
Evolution Items, because evolution planning needs them; then Held Items,
TMs/tutors and Mega Stones.

**Done when** the bag ledger can answer "where do I get another one",
and no currency the engine debits is unsourced.

### Phase 3 — close the loop on what the tool spends

With Phases 1 and 2 in, the safety path can stop refusing advice it
cannot fund. `affordableOptions` currently drops any option the bag
cannot pay for, which is correct but silent; once items have locations it
can say "go get one, it is on Route 104" instead of saying nothing.

## What this is not

Not a data-entry exercise to be handed to an agent. Every number in the
tool now carries provenance — `transcribed`, `derived`, `corrected` — and
these must too, because the workbooks are community documents and have
already been wrong once in this session (`docs/CONSTANTS-AUDIT.md` D11).
Transcribe with the source named, gate what can be gated, and mark
estimates as estimates.
