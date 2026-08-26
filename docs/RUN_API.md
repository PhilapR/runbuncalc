# The run API, as it actually behaves

Written because reading the source was not enough. In one session an agent
misread `learnable`, `fieldItems` and three command signatures in a row, each
time producing a confident wrong answer: `learnable` was called with the wrong
arity and reported "0 teachable moves" for a Pokemon with 33; `fieldItems` was
called without its map and reported "no items exist"; and `teach` was passed
`over` instead of `replace`, which the engine rejected with a message about
having four moves — true, and not the reason the call failed.

Every signature below was verified by calling it. When a shape here disagrees
with the code, the code wins and this file is wrong — `tests/run_api.test.js`
fails when they diverge, so that should not last.

## The two order scales

`order` counts cumulative enemy POKEMON. A player counts TRAINERS. Leader
Brawly is order 77 and the 26th fight of 362. `#N` always means order. See
AGENTS.md; `run.trainerIndexOf(run, order)` converts.

## Reading a run

| Call | Returns |
|---|---|
| `run.upcoming(run, count)` | array of fights, each `{trainer, order, party, tier, cap}` |
| `run.trainerIndexOf(run, order)` | 1-based fight number, or `null` past the road's end |
| `run.learnable(run, id, {atLevel})` | `{now: [...], later: [...]}` — **not** an array |
| `run.fieldItems(run, map)` | items at that map; **the map is required** |
| `run.splitPrep(run)` | `{split, cap, gauntlet, fightsAhead, filler, pickups, adjudication}` |
| `run.adviseUpgrades(run, trainer)` | `{considered, upgrades: [...]}` |
| `run.levelCap(run)` | `{cap, mode, reason?}` — `cap` is `null` when uncapped |

### `learnable` — the shape that bites

```js
const out = run.learnable(doc, monId, {atLevel: 21});
// out.now   -> [{move: 'Aerial Ace', sources: [{source: 'teachable'}]}, ...]
// out.later -> [{move: 'Life Dew', sources: [...], level: 23}, ...]
```

It returns an OBJECT with `now` and `later`, so `learnable(...).length` is
`undefined` and `.map` throws. `atLevel` moves the now/later line: the advisor
asks at the CAP the fight is fought under, because free candy guarantees the
Pokemon reaches it.

`sources[].source` is a string, not a flag: `'teachable'`, `'level-up'`,
`'egg (Piplup)'`. An egg-only move is one where EVERY source starts `egg`.
Across six mid-run species, 56 of 171 teachable moves are egg-only — 32.7%.

Legality here is not availability. `learnable` answers what the SPECIES can
learn; it does not ask whether this run can source it. The advisor applies that
second filter and withholds undated TMs.

### `fieldItems` — the map is not optional

```js
run.fieldItems(doc, 'Route101');   // [{name, kind, location, opensAt, open, collected}]
run.fieldItems(doc);               // [] — and NOT because there are no items
```

The gate field is **`open`**, not `reachable`. `open` is false until the
anchoring fight is beaten: Route 104's Miracle Seed opens at order 11.

## Commands: `run.apply(run, command)`

Every command is `{kind, ...}`. `apply` THROWS on refusal with a message
naming the reason, and the server returns that message with a 400 — a refusal
is the product working, not a fault.

| kind | required | notes |
|---|---|---|
| `catch` | `species`, `level` | `ivs` optional; `moves` checked for legality if given |
| `teach` | `id`, `move`, `replace` | **`replace`**, not `over`/`forget`/`instead` |
| `levelUp` | `id`, `to` | integer 1-100 or `'cap'`; never goes down |
| `evolve` | `id` | refuses below the evolution level |
| `party` | `ids` | the fighting six, in lead order |
| `beat` | `trainer` | credits the win and advances `position` |
| `skip` | `trainer` | NOT the same as beating: a skipped fight does not open the routes it guards |
| `acquire` | `item` | puts it in the bag; `count` optional |
| `give` | `id`, `item` | refuses unless the bag holds it, and unless the item is holdable |
| `take` | `id` | takes the held item back |
| `use` | `id`, `item` | consumables |
| `heartScale` | `id`, `stat` | sets one IV to 31; see below |
| `identify` | `id` | needs a nature, ability, or at least one IV |
| `faint`, `release`, `nickname`, `hold`, `unhold`, `spend` | | |

### `teach` replaces, and says so badly

```js
run.apply(doc, {kind: 'teach', id, move: 'Ice Beam', replace: 'Pluck'});
```

Omitting `replace` on a full moveset refuses with *"knows four moves — name one
to replace"*. Passing the WRONG key name produces the same message, because the
key is simply absent. That message is therefore not evidence that your
`replace` value was wrong; check the key name first.

Teaching is gated on LEGALITY, not on inventory: any move the species can learn
is accepted whether or not a TM for it is in the bag. `Roar of Time` on a
Prinplup is refused as *"not by level-up, TM, tutor, or an egg move"*.

### `heartScale` — and why egg moves are unreachable

One Heart Scale sets one IV to 31, and the relearner charges one for an egg
move. The engine's own refusal says *"no shop sells them"*, so they can only be
picked up.

`profiles/run-and-bun/oracle/availability.json` contains **zero** Heart Scales.
Across every recorded playthrough, 89 log lines mention one and none was ever
acquired. Every egg move is therefore permanently unreachable, and every
IV-setting play with it. That is a data gap, not a rule.

## Things that are true and surprising

- `apply` throws; it does not return an error object. Catching without reading
  `error.message` discards the only explanation you get.
- A `null` cap means uncapped, and `capOf` returning `null` also means "the
  panel showed no cap". Callers must not treat `null` as zero.
- `beat` on a fight already behind `position` is accepted and does nothing
  visible; `beaten` is derived from `position`, not stored.
- Species keys in the calc data are normalised lowercase alphanumerics:
  `gen.species.get('zoroarkhisui')`, not `'Zoroark-Hisui'`.
