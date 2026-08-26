# Asking the game a question

Every fact this project knows about Run & Bun lives behind one object: the
profile **oracle**. This page is how to reach it without reading its source
first.

There is a CLI for the common questions and a documented API for the rest.
Use the CLI unless you need something it does not ask.

```bash
node scripts/ask.js where Ponyta            # where can I catch it
node scripts/ask.js encounters "Oldale Town" # what is on this route
node scripts/ask.js opens "Mirage Tower 1f"  # when does it open, and on what evidence
node scripts/ask.js moves Mudkip 12          # what does it know by L12
node scripts/ask.js learn Mudkip Surf        # can it hold this move
node scripts/ask.js evolve Mudkip            # the line, both directions
node scripts/ask.js catch Poochyena          # catch rate and per-ball odds
node scripts/ask.js fight "Bug Catcher Rick" # their team, at run-map levels
node scripts/ask.js order                    # the tracker's route order
node scripts/ask.js starters                 # what the game starts you with
node scripts/ask.js coverage                 # how much of the game is on file
```

`--json` on any of them gives the raw answer for piping.

## Reaching the oracle directly

```js
const {getProfile} = require('./profiles');
const oracle = getProfile('run-and-bun').oracle;
```

## The shapes, including the ones that mislead

The return shapes are not uniform, and two of them have cost real time.

| Call | Returns | Note |
|---|---|---|
| `maps()` | `[{map, name, tables}]` | `map` is the ROM constant, `name` is what a player says |
| `getMap(name)` | one map record | |
| `encountersOn(name)` | `{mons: [{species, method, minLevel, maxLevel, chance, rod}]}` | **wrapped in `.mons`**, not a bare array |
| `whereToFind(species)` | `[{map, name, method, minLevel, maxLevel}]` | every table the species is on |
| `areaOf(name)` | the nuzlocke unit | folds Granite Cave 1F/B1F/B2F into "Granite Cave" |
| `availabilityOf(name)` | `{opensAt, method, provenance?, basis?}` or `null` | `null` means **undated, not closed** |
| `methodOpensAt(method)` | fight order, `0` if never gated | `surf` is 589, `rock-smash` 139 |
| `levelUpMoves(species)` | **`[[level, move], …]` PAIRS** | ⚠️ not objects — see below |
| `teachableMoves(species)` | `[moveName]` | TM and tutor |
| `ownEggMoves(species)` | `[moveName]` | relearner-only, charges a Heart Scale |
| `canLearn(species, move)` | `{legal, sources: [{source, level?}]}` | the honest "how" |
| `evolutionsOf(species)` | `[{into, method, level?, item?}]` | |
| `preEvolutionOf(species)` | species name or `null` | |
| `lineageOf(species)` | the whole line | |
| `catchRateOf(species)` | number | `null` for an unknown species |
| `growthRateOf(species)` | growth curve name | |
| `expForLevel(species, level)` | number | |
| `fieldItems()` | `[{item, map, …}]` | |
| `coverage()` | counts per dataset | what is actually on file |

### ⚠️ `levelUpMoves` returns pairs

```js
oracle.levelUpMoves('Mudkip')
// [[1,'Tackle'], [1,'Growl'], [5,'Water Gun'], [9,'Mud-Slap'], …]
```

A reasonable-looking `.filter(m => m.level <= 5)` returns **nothing** and reads
as missing data rather than a misuse. This happened twice while writing this
page. Use index `[0]` for the level and `[1]` for the move, or use
`node scripts/ask.js moves <species> <level>`, which handles it.

### ⚠️ `encountersOn` wraps its list

```js
oracle.encountersOn('Oldale Town').mons   // the array
oracle.encountersOn('Oldale Town')        // NOT the array
```

### ⚠️ `availabilityOf` returning `null` means unknown

`null` is "nothing in the data places this location", **not** "closed". Seven
locations are genuinely undatable — post-game and cut content the R&B tracker
never lists. Treating `null` as closed hides a fifth of the map; treating it
as open sends a fresh run to Sky Pillar.

Entries also carry provenance, and it matters:

- no `provenance` field — the original transcription, rab `minOrder`
  translated through name-matched trainer anchors
- `provenance: 'derived'` — placed from the R&B tracker's route order, because
  no trainer stands there for the original method to anchor to
- `provenance: 'corrected'` — a transcribed value was wrong and a human said
  so; `transcribedOpensAt` keeps the original visible

## Beyond the oracle

Some questions are about the run, not the game, and live elsewhere:

| Question | Where |
|---|---|
| A trainer's team | `lib/planner.js` → `getFight(trainer, profileId)` |
| Which of mine answers which of theirs | `lib/run.js` → `fightPlaybook(run, trainer)` |
| Who a crit can kill | `lib/run.js` → `safetyPath(run, trainer)` |
| What to teach or hold | `lib/run.js` → `adviseUpgrades(run, trainer)` |
| Which routes are still open | `lib/run.js` → `unusedRoutes(run)` |
| Catch odds at full HP | `lib/battle-driver.js` → `catchOddsAtFullHp(doc, species)` |

`fightPlaybook` is the one worth knowing. It returns per-enemy
**assignments** — which of your party answers each of theirs — plus rollout
odds:

```
their Grubbin L6    → send Lillipup
their Pineco L6     → send Mudkip
odds: pWin 1.0, eDeaths 0, pDeathless 1.0  (12 rollouts)
```

Playing a run by those assignments instead of "pick the biggest number"
was the difference between wiping on the 2nd fight and reaching the 11th.
(Fights counted as trainers here, not as `order` — see AGENTS.md.)

## What is NOT modelled

`node scripts/ask.js starters` reports **starters: NOT MODELLED**. The three
choices are hardcoded in `src/index.template.html`, and the rival is
identified only by ace (`RIVAL_ACES` in `profiles/run-and-bun/encounters.js`).
Nothing in the data says what the game starts you with, so nothing can check
it. That is a live gap, not a documentation one.
