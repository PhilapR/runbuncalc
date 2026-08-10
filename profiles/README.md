# Game profiles

A **profile** is a declarative description of one game — a ROM hack, a romhack
version, or vanilla itself — expressed as deltas against a base generation plus
the rules and content that make it that game.

Run & Bun is the first profile. It is not meant to be the only one.

## Why profiles exist

Everything Run & Bun-specific used to be hardcoded across the tree: move
overrides inside `ai/src/`, species edits inside `calc/src/data/`, trainer
parties inside `src/js/data/`, and rule deltas described only in prose in
`FORK_MAP.md`. That works for exactly one game. Supporting a second one means
forking the whole project again — which is the thing this project exists to stop
doing.

A profile pulls that knowledge into data. Adding a game becomes authoring a
profile, not editing the engine.

## The layers

The tools are meant to stack. Each layer is usable on its own, and each one adds
a degree of automation over the one beneath it. A consumer picks the height it
wants.

| Layer | What it answers | Needs |
| --- | --- | --- |
| **L0 — Oracle** | "How much damage does this move do?" | `calc/` alone |
| **L1 — Profile** | "…with *this game's* numbers." | L0 + a profile's `data` |
| **L2 — State** | "What actions are legal, and what happens if I take one?" | L1 + `ai/` state and transitions |
| **L3 — Policy** | "What will the opponent do?" | L2 + a profile's `policy` |
| **L4 — Encounters** | "What does this specific trainer have, and where am I in the run?" | L3 + a profile's `encounters` |
| **L5 — Planner** | "What line survives this fight?" | L4 + search over L3 |

L5 exists as `planner.js`: it loads the run map in progression order, builds a
`BattleState` for a named fight from a player's team, and returns the opponent's
ranked actions with a decision margin. It owns no rules — parties come from the
run map, damage from the calculator, decisions from the policy — so a wrong
answer there is a bug in a layer beneath it.

L0–L1 is a calculator. L3 is an opponent oracle. L4–L5 is a fight planner. The
same primitives serve a player who wants one number and a tool that wants to
plan a whole battle.

A profile does not have to fill every layer. A profile with only `data` gives
accurate numbers for a hack and nothing more, and that is a legitimate,
useful profile.

## Shape

```js
{
  id: 'run-and-bun',
  name: 'Run & Bun',
  baseGeneration: 8,        // the generation whose mechanics this game inherits
  data: { ... },            // content deltas vs that generation
  mechanics: { ... },       // rule deltas (optional)
  policy: { KIND, ... },    // opponent decision model; KIND says how it decides
  encounters: { ... },      // trainers / run map (optional)
  // learnsets: { ... },    // not modelled yet — see "Designing for a second game"
  provenance: { ... },      // how each claim is known
}
```

`provenance` is deliberately part of the contract rather than a comment. Not
every claim in a profile is known the same way, and the difference matters:

| Tag | Meaning |
| --- | --- |
| `source-of-truth` | Taken from the game author's own published data |
| `observed` | Confirmed in-game by a maintainer |
| `transcribed` | Copied from community documentation, unverified |
| `inferred` | Derived by us; nobody has checked it |

For Run & Bun the source of truth is [`dekzeh/calc`](https://github.com/dekzeh/calc),
the hack author's own calculator. Community documentation is valuable for
approach and colloquial knowledge — how the game is understood and played — but
it is not a source for values. Where the two disagree, the author's data wins.

That distinction has a limit worth stating plainly: it applies to **values**.
For **behavior** — what the AI actually does — there is no published authority,
because no such simulator exists upstream. There, observation is the evidence,
and `observed` is the strongest tag available.

## Designing for a second game

Run & Bun is one shape of ROM hack. Radical Red, the Kaizo family and others sit
in the same space but vary in ways this contract has to absorb. Nothing here is
built yet — the point is to know which parts are *shape* (stable across games)
and which are *content* (varies), so a second game costs a profile plus perhaps
an adapter, not a fork.

### What is shape, and already holds

These carry across games unchanged, and are the reason a second profile is
plausible at all:

- **`BattleState` is game-agnostic.** Serializable, no Run & Bun in it.
- **The engine is generation-parameterised.** `ai/` keys behaviour off
  `state.generation`, and the generation literals inside it are canonical
  Pokemon gates — Teatime is Generation 8, Nightmare is pre-Generation 8 — not
  Run & Bun rules. A FireRed-based hack running Gen 8 mechanics gets the right
  behaviour from the same code.
- **The layer split.** oracle → data → state → policy → encounters → planner is
  a decomposition of the problem, not of this game.
- **Provenance.** Every game has an author, community docs of varying quality,
  and things only observation settles. The tags mean the same thing everywhere.

### What varies, and how the contract must bend

**Pokedex — delta versus replacement.** Run & Bun's `data` is a small delta: 3
stat changes, 30 ported species, 125 ability-slot swaps. A hack that rebuilds
the roster wholesale makes "delta against a base generation" the wrong frame —
the profile should be able to declare a *replacement* dex instead of a patch,
and the conformance gate should check whichever was declared. Same contract,
two modes.

**Learnsets — missing entirely.** No layer models them, and nothing in the
repository knows what a species can learn. Run & Bun does not expose the gap
because moves are chosen by hand and trainer parties come with their moves
listed. A planner in a game that heavily rewrites learnsets needs them: to
validate a player's team, and to reason about what an opponent *could* carry
rather than only what a set says. This is the clearest missing layer.

**Stat tweaks — same model, different volume.** The delta approach holds; only
the size changes. Worth noting the ROM-verification method transfers too: any
hack published as a pokeemerald-format dump can be checked the same way this one
was.

**Trainer decision profiles — one AI is a Run & Bun assumption.** `policy` is
currently a single model for the whole game. Elsewhere, difficulty modes select
different AIs, and boss trainers often think differently from route filler. The
shape that absorbs this is *named policies* on the profile, with `encounters`
naming which policy a trainer uses and a default for the rest.

**Move decision trees — `policy` should not assume scoring.** Run & Bun's AI
scores candidate moves and rolls. Other hacks script decision trees, and some
use the vanilla AI unchanged. So a policy needs a `kind` that says how to
evaluate it — scoring, tree, vanilla — and the planner should ask the policy for
ranked actions without knowing which it got. Today the planner reaches straight
into the scoring evaluator, which works for one game and would not survive the
second.

### Known leaks to fix when a second game arrives

Found by auditing rather than assumed. Each is a game rule currently living in
engine code:

- `RUN_AND_BUN_EVS` in `ai/src/model.ts` — a zero-EV map, because Run & Bun
  removes EVs. That is a *game rule*, and a game with EVs cannot use this engine
  correctly until it moves into `mechanics` as a stat model.
- `RUN_AND_BUN_GENERATION` in `src/js/sets_to_battle_state.js` — the bridge
  pins Generation 8 while already reading the trainer table location from the
  profile. Half-abstracted.
- `planner.js` assumes a scoring policy, as above.

None of these block Run & Bun, and none are worth fixing speculatively. They are
recorded so the second game is a known quantity rather than a discovery.

## Adding a game

1. Create `profiles/<id>/` with an `index.js` exporting the shape above.
2. Declare `baseGeneration` and the content deltas you know.
3. Tag every claim in `provenance`. Untagged claims default to `inferred`,
   which is intentionally the weakest tag — unverified content should never
   enter looking authoritative.
4. Add the profile to `profiles/index.js`.

You do not need to touch `calc/`, `ai/`, or `server.js`.
