# Run & Bun Damage Calc

![Test Status](https://github.com/PhilapR/runbuncalc/actions/workflows/test.yml/badge.svg)

Fork of the [Smogon / Pokémon Showdown damage calculator][0] aimed at **Run & Bun**
accuracy: Gen&nbsp;8 mechanics by default (see the workspace `MECHANICS.MD`), plus
documented calculator overlays and a serializable Run & Bun AI policy layer.

The inherited `@smogon/calc` library and browser UI still expose generations 1–9
as a multi-gen damage oracle. That is intentional calculator capability, not a
claim that every generation is fully Run & Bun–sim accurate. Prefer Gen&nbsp;8
(S/S) for Run & Bun work; the UI and AI sample state default there.

Upstream Showdown calc: https://calc.pokemonshowdown.com.

## The run companion

On top of the calculator sits a Run & Bun **playthrough companion**: a
verifiable run document (every catch checked against the real encounter
tables, every taught move against real learnsets) plus the solvers a
nuzlocke actually needs, all graded through the same AI policy that predicts
the fights.

```sh
$ node play.js new --nuzlocke        # start a run (game level caps on by default)
$ node play.js catch Lillipup --map Route101 --level 3
$ node play.js split                 # the boss ahead, the cap, the gauntlet
$ node play.js routes                # every route still holding its encounter, unlock order first
$ node play.js scout                 # what the open routes could add vs the next boss
$ node play.js rank                  # every possible six from the box, ranked
$ node play.js advise                # the single teach/item/Heart Scale that most moves the board
```

The same surface is served over HTTP (`POST /run/*`, see
[`INVENTORY.md`](INVENTORY.md) — generated from the code and gated, so it
cannot drift) and in the browser as the **My Run** panel, which adds the
matchup board, the split sheet and one-click catches off real tables.

### Play it in the browser (no emulator)

The panel is also a **recreation**: roll each route's encounter off the
real tables (Catch it / It got away — a lost roll spends the route), and
play the fights turn by turn against the game's own AI policy, with your
party at the level cap (the infinite candy is the XP system). Deaths and
wins are written back into the run document through the same verified
commands a hand-kept run uses.

```sh
$ npm start
Server running on port 3000
  On this machine:  http://localhost:3000/index.html#runbun-run
  On your phone:    http://192.168.1.23:3000/index.html#runbun-run  (same Wi-Fi)
```

The page is responsive — the panel is designed to be played from a phone.
The run saves in that browser's storage; use Export/Import to move it
between devices.

### Deploy to Cloudflare

The repo follows the fleet's deploy pattern (one Worker per app on the
`stochastic-inference.dev` zone, custom domain, assets binding): static
`dist/` rides the ASSETS binding and the whole `/run/*` surface is answered
in the Worker itself, bundled from the same `run-api.js` the express server
uses — one implementation, three transports, still no storage.

```sh
$ npx wrangler secret put SITE_AUTH_PASSWORD   # once: the private-preview gate
$ npm run cf:preview   # wrangler dev against the built worker (reads .dev.vars)
$ npm run cf:deploy    # ships https://runbun.<account>.workers.dev (printed on deploy)
```

Dev for now, and dev is **private**: the worker carries the fleet's
preview gate (Basic auth against `SITE_AUTH_PASSWORD`, the same pattern as
the journal's middleware) over the page and the API alike — and it **fails
closed**: with no secret set the worker answers 503, never an open door.
Local `wrangler dev` reads `.dev.vars` (copy `.dev.vars.example`). When it
graduates to the portfolio, swap `workers_dev` in `wrangler.jsonc` for the
zone route (the commented block shows it) and set `PREVIEW_OPEN=true` —
going public is a deliberate act, not a forgotten secret.

Notes: the worker embeds the oracle data and trainer sets (~6.4 MB script,
inside the paid-plan limit), and `wrangler.jsonc` raises the CPU ceiling
because Advise and Rank rebuild matchup rows through the policy — seconds of
CPU, not milliseconds.

Nuzlocke rules are individual toggles (`--permadeath`, `--route`,
`--dupes off|species|line|forms`, `--shiny-clause`); `--nuzlocke` is just the
preset. Route availability, encounter odds, level caps and the AI's damage
model are all imported from the hack's own data with provenance tags —
including a 1,727-observation emulator corpus this calculator scores
100% against in CI.

Everything game-specific lives in `profiles/run-and-bun/`; a second hack is
a profile, not a fork.

This repository houses the core damage formula package ([`@smogon/calc`][1]),
the browser UI ([`src/`][2]), and the Run & Bun AI package (`ai/`). Ownership
boundaries are in [`FORK_MAP.md`](FORK_MAP.md).

## `@smogon/calc`

The `@smogon/calc` package powers the UI, providing a programmatic interface for computing damage
ranges. This subpackage contains code that will run on both the server or browser and can be used
as a building block for alternative UIs or applications.

### Installation

```sh
$ npm install @smogon/calc
```

Alternatively, as [detailed below](#browser), if you are using `@smogon/calc` in the browser and want
a convenient way to get started, simply depend on a transpiled and minified version via [unpkg][5]:

```html
<script src="https://unpkg.com/@smogon/calc/dist/data/production.min.js"></script>
<script src="https://unpkg.com/@smogon/calc"></script>
```

*In this example, the `@smogon/calc/data` code is included as well to fulfill the calc's data
layer requirement. Alternatively, a more fully-featured data layer such as [`@pkmn/data`][9] may
be used instead, see below.*

### Usage

`@smogon/calc` exports all of the data types required to perform a calculation. The `calculate`
methods require:

- a `Generation` that contains information about which damage formula mechanics to apply and where
  all of the data about the generation can be found.
- attacker and defender `Pokemon` (note: only relevant attributes are required, everything else
  should have sensible defaults). The `Pokemon` constructor also requires a `Generation` to provide
  the Pokémon's data for the generation.
- the `Move` being used by the attacker (which also requires a `Generation` argument to scope the
  move data to the particular generation).
- (optionally) a `Field` object containing information about the state of each `Side`.

`calculate` returns a `Result` object that contains methods for fetching damage rolls, ranges,
descriptions, recoil/drain information, etc.

```ts
import {calculate, Generations, Pokemon, Move} from '@smogon/calc';

const gen = Generations.get(5); // alternatively: const gen = 5;
const result = calculate(
  gen,
  new Pokemon(gen, 'Gengar', {
    item: 'Choice Specs',
    nature: 'Timid',
    evs: {spa: 252},
    boosts: {spa: 1},
  }),
  new Pokemon(gen, 'Chansey', {
    item: 'Eviolite',
    nature: 'Calm',
    evs: {hp: 252, spd: 252},
  }),
  new Move(gen, 'Focus Blast')
);
```

`@smogon/calc` comes packaged with all of the data required for damage calculation - by default, it
exposes this via its `Generations` object from `@smogon/calc/data`. As a shortcut, the `Generation`
argument required by `calculate`, `Pokemon`, `Move` can instead simply be the generation *number*
(eg. `5`), and it will handle getting that generations `Generation` object behind the scenes from
the data layer it ships with.

**The data in `calc/data` must be kept in sync with Pokémon Showdown. If there is an issue with the
calc's data, please fix it in the simulator first.** In general, you should probably not be
making manual edits to any of the data files, and in the future, they are likely to be generated
programmatically.

In some advanced use cases, you may wish to use a different data layer with the calculator. The
`@smogon/calc/adaptable` entry point can be used with any data layer that implements the calc's
`Generations` interface. This interface is a subset of [`@pkmn/data`][9]'s `Generations` interface,
so `@pkmn/data` (which contains all competitively relevant data from Pokémon Showdown) can be used
with the adaptable entry point for applications which want to avoid having two separate sets of the
same data shipped to users.

```ts
import {Dex} from '@pkmn/dex';
import {Generations} from '@pkmn/data';
import {calculate, Pokemon, Move, Field} from '@smogon/calc/adaptable';

const gens = new Generations(Dex);

const gen = gens.get(1);
const result = calculate(
  gen,
  new Pokemon(gen, 'Gengar'),
  new Pokemon(gen, 'Vulpix'),
  new Move(gen, 'Surf'),
  new Field({defenderSide: {isLightScreen: true}})
);
```

### Browser

The recommended way of using `@smogon/calc` in a web browser is to **configure your bundler**
([Webpack][6], [Rollup][7], [Parcel][8], etc) to minimize it and package it with the rest of your
application. If you do not use a bundler, a convenience `production.min.js` is included in the
package. You simply need to depend on `./node_modules/@smogon/calc/production.min.js` in a `script`
tag (which is what the unpkg shortcut above is doing), after which **`calc` will be
accessible as a global.** You must also have a `Generations` implementation provided, you can either
depend on the calculator's data layer by depending on
`./node_modules/@smogon/calc/data/production.min.js` (or `@smogon/calc/data` via unpkg), or you can
use an alternative data layer such as [`@pkmn/data`][9]. You must load your data layer
**before** loading the calc:

```html
<script src="./node_modules/@smogon/calc/data/production.min.js"></script>
<script src="./node_modules/@smogon/calc/production.min.js"></script>
```

## UI

The [UI layer][2] is currently is written in vanilla JavaScript and HTML. The repository root owns
the calculator and Run & Bun AI subpackages, so install from the top level:

```sh
$ npm install
```

The root `postinstall` step provisions the `calc/` and `ai/` subpackages through `subpkg`.
Avoid installing those packages independently unless you are deliberately working on an
isolated package.

Next, run `npm run build` from the root directory. This compiles both `@smogon/calc` and
`runbuncalc-ai`, then compiles the templated HTML and copies everything into the top-level `dist/`
folder. To then view the UI, open `dist/index.html` -
simply double-clicking on the file from your operating system's file manager UI should open it in
your default browser.

```sh
$ npm run build
$ open dist/index.html # open works on macOS, simply double-clicking the file on Windows/macOS works
```

**If you make changes to anything in `calc/` or `ai/`, you must run `npm run build` from the top level to
compile the files and copy them into `dist/` again. If you make changes to the HTML or JavaScript in
`src/` you must run `node build view` before the changes will become visible in your browser**
(`npm run build` also works, but it is slower, as it will compile `calc/` and `ai/` as well, which is
unnecessary if you did not make any changes to that directory).

Before opening up a Pull Request, please ensure `npm test` passes:

```sh
$ npm test
```

### Run & Bun AI

The `ai/` subpackage contains the serializable Run & Bun battle model and
decision policy. It treats `@smogon/calc` as a read-only damage oracle and can
be used directly from TypeScript or through the local server endpoint:

Package-level API usage, the full HTTP endpoint list (including
`POST /ai/validate-battle-state`), and Gen&nbsp;8 / zero-EV notes are in
[`ai/README.md`](ai/README.md).

The OSS/custom ownership map is recorded in [`FORK_MAP.md`](FORK_MAP.md), with
the data-model and validation contracts in [`AGENTS.md`](AGENTS.md),
[`AI_DATA_MODEL.md`](AI_DATA_MODEL.md), and [`VALIDATION.md`](VALIDATION.md).
Product surfaces and phase status (calc, AI debug, sets bridge, Singles Battle,
explain, API) are mapped in [`docs/attic/RUNBUN_UX.md`](docs/attic/RUNBUN_UX.md) (retired — see `INVENTORY.md`). UI design (shell,
tokens, screen specs, prioritized V0–V4 rollout) lives in
[`RUNBUN_UI_DESIGN.md`](RUNBUN_UI_DESIGN.md). The **master prioritized backlog**
(P0–P3 / Park) plus roadmap, session chunks, and non-goals live in
[`docs/attic/PLAN.md`](docs/attic/PLAN.md) (retired — see `DECISIONS.json` and `INVENTORY.md`) §0.

```sh
POST /ai/choose-action
Content-Type: application/json

{ "generation": 8, "mode": "Singles", "turn": 1, "field": {}, "sides": { ... } }
```

Start the local endpoint after compiling with `node server.js`. The automated
HTTP smoke gate is `npm run test:server`; it uses an ephemeral port and does
not leave a server running. The built UI is served from `dist/` by the same
process; open the main calculator page and use the **Run & Bun AI Debug**
panel to load calc panels into a Gen 8 zero-EV `BattleState`, validate via
`POST /ai/validate-battle-state`, evaluate/choose, and optionally
derive→apply→advance against the live HTTP API without embedding a second
battle model in the browser.

`POST /ai/evaluate-actions` accepts the same `{state, options}` shape as
`/ai/choose-action` and returns the deterministic legal action evaluations
without sampling a selected action. Use `/ai/choose-action` when a caller also
wants the policy's sampled choice. `POST /ai/validate-battle-state` accepts
`{state}` (or a bare `BattleState`) and returns `{ok: true}` or HTTP 400.

The calculator endpoint accepts either `GET /calculate` query parameters or
`POST /calculate` JSON; AI endpoints use JSON POST requests.
Invalid calculator input and malformed JSON receive a JSON `400` response;
unexpected server failures receive a JSON `500` response.
AI action payloads are validated against the same party-ID contract as the
state; malformed AI state or action payloads receive JSON `400` responses.
AI state endpoints validate IDs, active slots, HP, move resources, boosts,
timers, hazards, and per-Pokémon volatile state before processing a request.

The response contains the selected action and scored candidate evaluations.
When `includeSwitches` is enabled, callers may provide
`replacementViability` entries with `faster`, `notOHKOd`, and `not2HKOd`.
The optional replacement-ID and score maps, as well as `itemRollsByPokemon`,
are shape-, party-ID-, and range-validated at the HTTP boundary.
`evaluateActions()` derives those conservative Singles viability checks from
hypothetical entry states and opposing legal move facts by default; caller
values override them, and `deriveReplacementViability: false` disables the
automatic derivation.
If an active Pokémon has no legal move left, the AI action contract exposes
canonical `Struggle` and applies its recoil through the transition boundary.
Shell Trap is represented as a one-turn armed state and only produces its
canonical reaction damage after a damaging contact hit.
When `replacementScores` is supplied, its score is used for the successful
branch of an eligible voluntary switch as well as for forced replacements;
otherwise that branch remains an explicit score-0 tie before the 50% switch
roll.
`recordMoveAction()` can persist legal move bookkeeping (including PP and the
last move), and `applyDamageAction()` can apply a caller-selected damage roll
to legal targets. `resolveMoveAction()` applies a complete, already-resolved
serializable outcome atomically. `deriveMoveResolution()` uses explicit move
metadata when present, otherwise canonical dex data plus the Run & Bun move
overlay, and records the sampled rolls. The calculator adapter applies the
overlay's documented move type and base power, while PP lookup also honors the
Run & Bun values. Common accuracy modifiers are included;
turn order and unsupported mechanics remain the responsibility of the battle engine.

The policy layer includes dedicated Run & Bun scoring for common doubles support
and control cases such as Fling, Role Play, Coaching, Trick/Switcheroo, Encore,
Counter/Mirror Coat, and critical-hit setup; focused fixtures live in
`ai/src/test/model.test.ts`.
The AI transition layer also models Endure as a one-turn direct-damage floor
distinct from Protect, including its consecutive-use lifecycle.
Roost is tracked as a one-turn temporary grounding/type effect when it heals
the user, so terrain and Ground-type eligibility see the same turn-local state.
Miracle Eye is tracked as a Generation IV+ target volatile; it restores Psychic
damage against Dark targets and ignores their evasion changes while active.

`deriveMoveResolution()` provides the first deterministic engine slice for
common hazards, screens, weather/terrain, setup, status, recovery, Substitute,
recoil/drain, and self-fainting moves. It resolves known move accuracy and
supported secondary effects, sequential calculator-backed multi-hit damage,
and common target eligibility, while leaving uncertain-state interactions,
immunities, and unsupported
move-specific rules to the caller.

The transition boundary is also available through `POST /ai/apply-action` with
`{state, action, resolution}`. Switches omit `resolution`; move actions require
the already-resolved outcome. Switches apply common Stealth Rock, G-Max
Steelsurge, Spikes, Toxic Spikes, Sticky Web, Heavy-Duty Boots, grounding, and
immunity rules. Use
`POST /ai/derive-switch-entry` to inspect those consequences without applying them.
Voluntary switches and post-faint replacements use the same transition shape,
but forced replacements carry `forced: true`; `POST /ai/forced-switch-actions`
enumerates legal replacements. If a chooser receives a fainted active with no
move actions, it evaluates those forced replacements automatically; callers
may provide `options.replacementScores` to rank them, otherwise they tie
explicitly.
An explicit switch with `batonPass: true` preserves the outgoing modeled stat
stages and Substitute on the replacement; ordinary and forced switches do not.
`POST /ai/derive-resolution` accepts
`{state, action, facts?, hit?}` and returns the deterministic engine outcome.
`POST /ai/derive-end-turn` returns residual/status progression, including
modeled Shed Skin, Healer, and Harvest outcomes, while
`POST /ai/advance-turn` applies it and advances modeled timers.
Future Sight and Doom Desire store sampled damage in serializable delayed state,
and Wish stores a delayed healing fraction against the original active slot;
all resolve at the due turn boundary. Sleep, paralysis, freeze, flinch, and
confusion action gates are recorded in the move resolution. Destiny Bond is
consumed when a direct damaging resolution KOs its holder.
Healing Wish and Lunar Dance carry a one-shot full-heal flag into the next
replacement entry; PP restoration remains an external simulator event.
Laser Focus is passed into the calculator as a guaranteed critical-hit state
for the holder's next damage calculation; defender critical-hit blockers still
apply. Focus Energy remains a probabilistic crit-stage input for the battle
engine, exposed through `ActionFacts.attackerCriticalHitStage`.
`POST /ai/order-actions` orders simultaneous intents by switch/move priority,
common ability/item modifiers including sampled Quick Claw and the Custap Berry
25%-HP threshold, Magic Room/Klutz held-item suppression, effective speed, and
Trick Room.
Move resolution also normalizes common action gates such as Generation III+
Truant, and common stat-change abilities such as Contrary,
Simple, and Clear Body. `advanceTurn()` handles the modeled weather, status,
item, ability, and G-Max residual effects;
unmodeled simulator events remain external inputs.

### Set data

`src/js/data/sets/gen8.js` holds the Run & Bun trainer parties — authored data
keyed by trainer name, read by the Trainer Wheel. It is edited by hand, never
generated. The upstream `import/` package that regenerated set data from
`@smogon/sets` has been removed, because it overwrote those trainer parties with
Smogon competitive usage sets. [`TASKS.md`][4] covers how to change set data
safely; `runbun_sets.test.js` enforces it.

## Credits

This project was created by Honko and is primarily maintained by Austin.

- Gens 1-6 were originally implemented by Honko.
- The Omega Ruby / Alpha Sapphire update was done by gamut-was-taken and Austin.
- The Gen 7 update was done by Austin.
- The Gen 8 update was done by Austin and Kris.
- The Gen 9 update was done by Austin and Kris.
- Some CSS styling was contributed by Zarel to match the Pokémon Showdown! theme.

Many other contributors have added features or contributed bug fixes, please see the
[full list of contributors](https://github.com/smogon/damage-calc/graphs/contributors).

## License

This package is distributed under the terms of the [MIT License][3].

  [0]: https://github.com/smogon/damage-calc
  [1]: https://github.com/smogon/damage-calc/tree/master/calc
  [2]: https://github.com/smogon/damage-calc/tree/master/src
  [3]: https://github.com/smogon/damage-calc/blob/master/LICENSE
  [4]: TASKS.md
  [5]: https://unpkg.com/
  [6]: https://webpack.js.org/
  [7]: https://rollupjs.org/
  [8]: https://parceljs.org/
  [9]: https://github.com/pkmn/ps/blob/master/data
