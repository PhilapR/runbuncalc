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

The executable manifest is
[`../contracts/ecosystem/v1/contract.json`](../contracts/ecosystem/v1/contract.json).
Its examples are test vectors, not proof that a live `pokemon-mono` provider
already exists.
