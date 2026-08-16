# Pokemon ecosystem bridge

The bridge is a logical contract boundary, not a requirement for a process or
database boundary. The product path imports a pinned, bundleable
`pokemon-mono` provider and calls it in the same process. It lets the companion
ask for planning or simulation while keeping the playable run responsive,
serializable, and usable without a provider.

The canonical bridge packet belongs beside the simulation truth at
`pokemon-mono/contracts/run-runtime/v1/`. The recorded request and receipt in
this repository are a consumer fixture cache pinned by `canonical.lock.json`.
They let app work proceed without a live provider, but they cannot change the
contract or quietly become authoritative through convenience.

```text
runbuncalc (play and save)
  IndexedDB attempt ledger -> checked .rabrun archive
  planning request ---------> pokemon-mono (mechanics and simulation)
  planning receipt <--------- deterministic result + replay evidence
                                      ^
                                      |
                         stochastic-inference-core
                    route capability, schedule fleet,
                    retain lineage and artifact references

checked .rabrun + receipts -> Arrow batches -> Parquet analytics
                                         -> NPZ training shards
```

## Runtime boundary

`runbuncalc` sends `pokemon.bridge.request/1.0.0` JSON. A request identifies
the attempt revision and state hash, the game profile revision, task,
constraints, and explicit seed set. It contains serializable state, never
calculator class instances or a live IndexedDB handle.

`pokemon-mono` returns `pokemon.bridge.receipt/1.0.0` JSON. The receipt binds
the result to the request, engine revision, profile revision, input state hash,
seeds, output hash, and replay evidence. Results are immutable. A correction
creates a new receipt rather than rewriting an old one.

`runbuncalc` stores accepted receipts in the attempt's separate
`rabrun.evidence/1.0.0` collection. Evidence is immutable and
content-addressed, exports with the checked `.rabrun` archive, and does not
advance the game-state revision. This keeps planning observations available
for review and training without pretending that a simulator read changed the
run. Archives created before the evidence collection still import unchanged.

The primary product and development transport is an in-process package export
from `pokemon-mono`. The JSON request and receipt remain the stable API around
that import: they preserve deterministic replay, permit fixture-driven UI work,
and prevent the app from reaching into engine internals. A CLI or loopback
adapter exposes the same API for batch workers, debugging, and runtimes where
the provider cannot be bundled. Cloudflare may serve the companion and small
deterministic calculator operations, but it must not become the high-volume
simulator or read emulator memory.

## Stochastic inference boundary

Stochastic inference registers versioned capabilities such as
`pokemon.rab.plan`, `pokemon.rab.simulate`, and `pokemon.rab.evaluate`. It may:

- choose a compatible `pokemon-mono` provider;
- split broad seed searches across cheap workers;
- reserve exact evaluation for finalists and acceptance fixtures;
- record request, receipt, code/profile revisions, timing, cost, and artifacts;
- reject receipts that violate the requested contract or evidence level.

It must not reinterpret battle rules, mutate the user's active run, or emit a
result without preserving the original provider receipt.

## High-volume path

JSON is the control plane, not the tensor format. The simulator should compile
validated state into compact integer IDs, fixed-width arrays, enums/bitsets,
and explicit PRNG state. Batch execution emits immutable Arrow record batches
or equivalent typed buffers. Validated `.rabrun` archives and receipts are
materialized into partitioned Parquet for analytics; dense observation/action
arrays may become NPZ training shards. Every shard manifest carries schema,
profile, engine revision, seed range, row count, and source receipt hashes.

Active state remains IndexedDB plus the hash-linked event ledger. Parquet is
never the transaction log, NPZ is never a canonical save, and stochastic
inference is never the game-state authority.

## Migration sequence

1. Promote the schema and fixtures into
   `pokemon-mono/contracts/run-runtime/v1/`, record their digest, and pin that
   packet in every consumer.
2. Freeze a small corpus from the existing local engine: first route, first
   required fight, one double battle, and one known divergence.
3. In parallel, build an importable `pokemon-mono` provider against request
   fixtures, the app adapter against that interface plus recorded receipts,
   and the stochastic-inference capability against a fake deterministic
   provider.
4. Compare action legality, damage facts, state transitions, event hashes, and
   zero-death branch outcomes. Gate expected divergences by name.
5. Import the pinned provider package behind the adapter in `runbuncalc`;
   retain recorded fixtures for UI development and local play when planning is
   unavailable.
6. Register the proven provider in stochastic inference for experiment and
   fleet workloads.
7. Scale only after single-run and batch execution reproduce the corpus.

## Current gate — 2026-08-16

Steps 1 through 5 are locally complete for the first seeded planning fixture.
`runbuncalc` imports the browser-safe provider built from `pokemon-mono`
revision `58aad68ac7a93980e1d424e768b009ce7cc0ba2f`, verifies the artifact hash
before building, resolves each filtered product label to the engine's unique
canonical raw trainer order, and reproduces the recorded seed-1450 receipt in
Chromium. The Plan surface combines that eight-seed whole-branch forecast with
the existing tactical action ranking; companion play still falls back to the
local planner if the provider cannot answer.

Step 6 and the first bounded slice of step 7 are now complete locally.
`stochastic-inference-core` revision
`84e7e9eb5d829d10e5f1f4b753976e6abb6d3d1a` registers the exact typed
capability, validates every receipt against its request, and runs cold or warm
batches capped at 1,024 unique requests. Its three-pair fixed corpus now
includes a realistic six-Pokemon Calvin request and has exact single,
cold-batch, warm-batch, and recorded-receipt parity. For that six-Pokemon
fixture, each eight-seed request evaluates 48 candidate branches. A 16-request
warm batch took a 192.233 ms median (3,995 candidate evaluations/second), and
1,024 requests took a 6,844.261 ms median (7,181 candidate evaluations/second).
These are bounded transport/simulator measurements for one recorded party and
fight, not a claim of policy quality or full-game throughput.

The browser consumer at app revision
`27cb8e5e03f90e7931d359f7d23768914c50dd34` uses the already-loaded provider
for a bounded current-plus-two-fight outlook. Browser batches are capped at the
eight fights already present on the visible road, preserve order, reject
duplicate request IDs before provider work, and match single-call receipts.
The UI labels these eight-seed results `PARTIAL PLAN` and says "sampled
branches"; it does not promote a clean sample to `CERTIFIED` or "whole branch
safe."

The same app revision retains those three request/receipt pairs atomically in
IndexedDB v3 and exports them with the attempt. A played trainer fight now emits
the canonical `battle.ended` event with both the game's filtered progression
order and pokemon-mono's canonical trainer order, plus seed, lead, participants,
turns, result, and deaths. The Run history surface pairs the latest plan before
that exact fight and labels the descriptive result `held`, `underestimated`,
`outperformed`, `within-risk`, `defeat`, or `unplayed`; it does not infer carry
or causal policy value. The same immutable completion records replay-stable
per-Pokemon appearances, switch-ins, move attempts, opposing real HP removed by
those moves, and direct KOs. History renders those counters as actual or partial
participation and never promotes them to carry.

The checked archive materializer emits schema `1.3.0` episode, event, step,
observation, planning-receipt, per-seed planning-branch, battle-outcome, and
planning-review tables plus per-Pokemon battle-contribution rows. Its
maximum-batch test retains and materializes 1,024
receipts without adding game events; the checked archive stays below 8 MiB in
the local regression gate.

The integration matrix therefore records single/batch parity, a six-Pokemon
benchmark, planning-evidence persistence/materialization, played-outcome
recording, rendered review, derived review rows, realized-participation capture,
rendering and materialization, and exact app, engine, control, and verification
revisions. `providerEnabled` and
`privateDeploymentVerified` remain false: no production/private promotion is
claimed until the exact reviewed app revision passes authenticated success,
anonymous denial, and deployed receipt checks. Deployment remains private.

The executable manifest is
[`../contracts/ecosystem/v1/contract.json`](../contracts/ecosystem/v1/contract.json).
Its canonical examples remain test vectors. The additional
`seeded-provider-receipt.json` and integration matrix record the narrower fact
that the pinned provider exists and matches the first local browser corpus;
they do not prove batch or deployed parity.
