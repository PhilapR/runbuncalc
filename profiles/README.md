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
  policy: { ... },          // AI scoring model (optional)
  encounters: { ... },      // trainers / run map (optional)
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

## Adding a game

1. Create `profiles/<id>/` with an `index.js` exporting the shape above.
2. Declare `baseGeneration` and the content deltas you know.
3. Tag every claim in `provenance`. Untagged claims default to `inferred`,
   which is intentionally the weakest tag — unverified content should never
   enter looking authoritative.
4. Add the profile to `profiles/index.js`.

You do not need to touch `calc/`, `ai/`, or `server.js`.
