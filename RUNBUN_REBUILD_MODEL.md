# Run & Bun rebuild model

This model lets the project grow from a run companion into an emulator-synced
experience, and eventually into a clean-room game runtime, without treating
those as the same product.

The machine-readable contract is
[`profiles/run-and-bun/rebuild-model.json`](profiles/run-and-bun/rebuild-model.json).

## Direct answer

The current L0-L6 profile decomposition does **not** include world tilesets.
It covers rules, species and move data, trainers, encounters, progression,
planning, and the player's run document. The repository contains no Run & Bun
map layouts, tileset graphics, palettes, map events, or overworld renderer.

There is an emulator seam, but it is not yet a live product integration:

- `src/runandbun_script_imports.lua` reads mGBA memory and prints the party and
  PC in Showdown format. It is a manual export, not a stream, and it does not
  read map, position, battle phase, bag, flags, menus, or input.
- The sibling `pokemon-mono/engines/rlm` checkout contains a much broader
  `RunBunConnector` and experimental map reader for an mGBA localhost socket
  bridge. Its checked-in status is mixed: the connector models memory, input,
  screenshots, player position, map headers, and metatile IDs, but the bridge
  script named by its documentation is absent and the map reader defaults
  unknown behavior to walkable. Treat that work as reusable research, not as a
  verified live adapter.

So: **yes, live data is feasible**, but the current truthful capability is
manual party/box extraction. A live sync must earn its claims through a
same-ROM, same-state acceptance gate.

## The decomposition

The existing solving layers remain intact:

| Existing layer | Responsibility |
| --- | --- |
| L0-L3 | Damage, game-specific rules, battle state, opponent policy |
| L4-L5 | Trainer road and fight planning |
| L6 | Persistent run, encounters, box, bag, progression |

A full-game path adds three orthogonal domains rather than putting graphics
inside the battle engine:

| New domain | Static content | Live state |
| --- | --- | --- |
| **World** | Map headers, layouts, metatile maps, collision, warps, objects, scripts | Current map, coordinates, facing, active objects and flags |
| **Presentation** | 8x8 tiles, metatile composition, palettes, sprites, animations, text, audio, UI flows | Camera, animation frame, menu/dialog focus |
| **Runtime** | State-transition contracts | Overworld, menus, encounters, battles, saves and input |

Tilesets therefore belong in the model, split into four things that must not be
collapsed:

1. **Tile graphics** — indexed 8x8 pixel data.
2. **Palettes** — colors applied to those indices.
3. **Metatile definitions** — composed tiles and render-layer rules.
4. **Metatile behavior** — collision, elevation, water, ledges, doors and
   scripted behavior.

Reading only the current metatile ID from RAM is enough for navigation and a
tracker minimap. It is not enough to reproduce the game's visuals. A faithful
renderer needs the static tileset, palette and metatile definitions from a
legally supplied ROM or an author-published decomp.

## One model, three products

```text
ROM/decomp import ──► canonical profile ───────┐
                                               ├─► event log ─► tracker / UX
mGBA localhost bridge ─► observed snapshots ──┤
                                               └─► simulator ─► plans / replay
                                                    │
                                                    └──────────► rebuilt runtime
```

### Companion mode

The browser run document is authoritative. Encounters and fights are entered
or played in the companion, as they are today. No emulator or ROM is required.

### Emulator-sync mode

mGBA is authoritative for live runtime state. A local adapter emits normalized
snapshots and semantic events; the browser enriches them with profile data.
The hosted Cloudflare app never reads emulator memory directly.

### Rebuild mode

The simulator becomes authoritative for runtime state. It consumes the same
profile, events, world data, and UX projections used by the first two modes.
This is the path to a complete game rebuild without rewriting the tracker a
third time.

## Live emulator contract

The first bridge should be read-only and local:

```json
{
  "schemaVersion": 1,
  "source": "mgba",
  "romFingerprint": "operator-local-hash",
  "frame": 123456,
  "observedAt": "2026-08-13T12:00:00Z",
  "scene": {
    "mode": "overworld",
    "map": {"group": 0, "number": 16, "layout": 42},
    "position": {"x": 14, "y": 9, "facing": "down"}
  },
  "party": [],
  "boxes": [],
  "bag": {},
  "battle": null,
  "flagsDigest": "..."
}
```

The adapter compares snapshots and emits semantic events such as
`map.entered`, `pokemon.caught`, `pokemon.fainted`, `battle.started`, and
`battle.ended`. The event reducer updates the same run model whether events
came from mGBA, manual entry, an imported save, or the future rebuilt runtime.

Do not expose raw `read_memory(address, size)` over the browser or Cloudflare
API. The localhost process should allowlist named observations, cap payload
sizes, bind only to loopback, and require an ephemeral session token.

## Implemented attempt data plane

The local game now uses a versioned IndexedDB attempt store as its authority.
`localStorage` is only a compatibility mirror and cross-tab wake-up signal.
Model v2 gives manual play, emulator evidence, simulator output, imports, and
the rebuilt runtime one executable event envelope. It carries a stable event
and attempt identity, ledger revision plus optional source cursor, typed source,
provider, confidence, observation time, and source-specific evidence such as an
emulator frame and ROM fingerprint. Legacy v1 bridge vocabulary is accepted only
through an explicit normalizer. Scene and battle observations have serializable,
validated boundaries but remain observation-only until their reducers exist.

Each accepted event or projected command is an optimistic, idempotent transaction containing:

- an immutable semantic event and command receipt,
- a monotonic attempt revision,
- the resulting run head and its SHA-256 state identity,
- links to the previous state and event identities,
- a verified snapshot at lifecycle boundaries and every 50 revisions.

An export is a portable `rabrun.archive` bundle containing the head, complete
event sequence, snapshots, compact idempotency receipts, immutable planning
evidence, manifest, and whole-bundle SHA-256 checksum. Import validates the
bundle, state identities, event hash chain, evidence hashes, and compatibility
command log before making the attempt active. IndexedDB v2 added
attempt/revision indexes and range reads; v3 adds an evidence store indexed by
attempt. v1 databases and older archive bundles upcast without deleting the
original history. End-run records now point to the checked evidence head and
checksum rather than copying an unverified final save.

Planning evidence uses `rabrun.evidence/1.0.0`. Each record binds the full
`pokemon.rab.plan` request and deterministic `pokemon-mono` receipt to an
attempt revision and state hash. It is content-addressed and batch-atomic but
does not enter the semantic event chain or increment the run revision: asking
the simulator a question is evidence acquisition, not a game action.

The storage acceptance tests cover 10,000 compact revisions and a realistic
growing command log. On the development machine, the latter's 2,000-revision
archive fell from roughly 112 MB and 4.6 seconds to roughly 3 MB and 0.73 seconds.
Those are local regression measurements, not cross-device performance promises.

This is the transactional and replay substrate for companion and rebuilt modes.
Played trainer fights emit canonical `battle.ended` events. Their payloads keep
the filtered game progression order separate from the canonical pokemon-mono
trainer order and record seed, lead, participants, turns, result, and deaths.
The review projection pairs each completion only with the latest eligible plan
since the prior play of that trainer; a plan recorded after completion cannot
rewrite the result.

`rl-dataset.js` validates a checked archive and materializes primitive episode,
event, step, observation, planning-receipt, planning-branch, battle-outcome, and
planning-review rows with explicit Arrow/Parquet-oriented types. Schema `1.2.0`
preserves provider, profile/request, seed, result, replay, and evidence
identities so policy data can be traced back to the exact checked attempt.
It is deliberately not Parquet: columnar files belong downstream as immutable
analytics and RL training partitions. At hosted scale, a Durable Object should
serialize writes per attempt, D1 should index attempts and lightweight facts,
and R2 should hold checked archive bundles, replay segments, screenshots, and
Parquet training shards. None of that Cloudflare persistence is deployed yet;
the current vertical slice is local-browser durable storage.

## Build sequence

### R0 — Freeze the contracts

- Version the snapshot and event schemas.
- Add source, frame, ROM fingerprint, and observation time to every snapshot.
- Make event replay produce the same run document deterministically.

Acceptance: a recorded fixture can be replayed offline into an identical run.

### R1 — Read-only emulator sync

- Replace the manual Showdown export with a loopback mGBA adapter.
- Observe scene mode, party/box, HP/status, current map and position first.
- Derive catch, faint, map-entry, and battle boundary events.

Acceptance: compare manual tracker state and emulator state at ten named saves;
all supported fields agree, and unsupported fields are explicitly `unknown`.

### R2 — World model and tracker map

- Import map layouts, behaviors, connections, warps and objects.
- Render a semantic minimap from metatile IDs before importing graphics.
- Add tiles, palettes and metatile compositions only after behavior is correct.

Acceptance: on a fixed save corpus, map identity, position, neighboring
collision, warps and rendered metatile IDs match the emulator.

### R3 — Synced battle UX

- Project observed battle state into the existing calculator and policy model.
- Show recommendations beside the emulator without issuing input.
- Record frame-bounded evidence for every transition.

Acceptance: same-input paired checks agree on party, active Pokémon, HP,
status, move/PP state, field, legal actions and resolved deltas.

### R4 — Rebuilt runtime

- Implement overworld transitions, scripts, menus and save semantics behind
  the same event reducer.
- Replace each emulator-owned domain only when its fixture corpus passes.
- Keep presentation replaceable: faithful tiles or a redesigned UX can consume
  the same world/runtime state.

Acceptance: deterministic replay of a route-to-boss vertical slice reaches the
same semantic checkpoints in mGBA and the rebuilt runtime.

## Recommended first vertical slice

Build **Littleroot through the first encounter and first required fight**:

- one map connection and warp,
- movement and collision,
- one dialog/script flag,
- starter/party state,
- one encounter transition,
- one battle,
- one tracker update.

That slice exercises world, runtime, battle, save, emulator sync and UX without
pretending the whole map or script engine is already understood.
