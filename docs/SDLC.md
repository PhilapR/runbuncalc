# Run & Bun delivery lifecycle

The unit of delivery is a user-visible capability with one owner, one
versioned boundary, and reproducible evidence. A green package test is
necessary but does not prove that the browser, engine, evidence router, and
private deployment agree.

## Repository roles

| Repository | Owns | Must not own |
| --- | --- | --- |
| `runbuncalc` | Playable companion UX, local attempt head, commands, archive export/import, Cloudflare adapter | Canonical cross-game simulation mechanics or fleet scheduling |
| `pokemon-mono` | Run & Bun mechanics truth, deterministic simulator, replay parity, batch execution | Product navigation, user save authority, or experiment governance |
| `stochastic-inference-core` | Capability discovery/routing, cheap-to-exact fleet policy, evidence envelopes, experiment lineage | Battle mechanics, mutable attempt state, or UI projections |

The current in-repository `ai/` engine remains a compatibility and prototyping
provider until a `pokemon-mono` provider passes the same contract fixtures and
replay parity gate. New cross-project mechanics should land in `pokemon-mono`,
not deepen that temporary duplication.

## Required change packet

Before implementation, record:

1. the player outcome and primary interaction;
2. the owning repository and named consumer;
3. the contract version and compatibility policy;
4. acceptance fixtures, including whole-branch zero-death gates where safety
   is claimed;
5. explicit non-goals and a rollback boundary.

## Parallel development train

Only the contract freeze is serial. Land a versioned schema, request fixture,
receipt fixture, compatibility policy, and contract digest first. Then these
lanes may proceed concurrently in separate, explicitly owned worktrees:

| Lane | Repository and write set | Develops against | Independent lane gate |
| --- | --- | --- | --- |
| Contract | `pokemon-mono/contracts/run-runtime/` | Existing runtime and cross-engine contracts | Schema, examples, canonical digest, backward-compatibility fixtures |
| Engine | `pokemon-mono/engines/rab/**/bridge/` | Pinned request fixtures | Deterministic provider receipt and replay parity |
| App | `runbuncalc` provider adapter and product UI | Pinned importable provider interface plus recorded receipt fixture | Same-process provider path, offline/local fallback, and browser interaction tests |
| Control | A clean `stochastic-inference-core` worktree limited to Pokémon capability files | Recorded request/receipt pair and fake provider | Routing, typed artifact, lineage, and side-effect declarations |
| Verification | Cross-repository harness with no product ownership | Exact lane revisions and fixture digest | Compatibility matrix, named divergences, single/batch parity |

The `runbuncalc/contracts/ecosystem/v1/` directory is a recorded consumer
fixture cache, not the authority. The canonical packet is frozen on the
dedicated `pokemon-mono` contract lane under `contracts/run-runtime/v1/`, and
the app pins its exact revision and digest in `canonical.lock.json`. Consumers
may vendor the small packet, but CI must compare any vendored digest to the
lock. No consumer reaches through another repository's source tree or tracks
an unpinned `latest`. Importing a pinned, declared `pokemon-mono` package export
is the preferred app integration; relative imports into a live worktree are
not.

Each lane must remain runnable without the others: the app can use recorded
receipts when the imported provider is absent, the engine uses request
fixtures, and stochastic inference uses a fake deterministic provider.
Provider unavailability must not prevent local companion play. Collab may
launch and display these modules as a lab, but it is not the contract registry,
merge coordinator, or save authority.

## Integration train

1. Rebase each lane onto its current repository target and rerun its lane gate.
2. Assemble an integration matrix containing the contract digest, app SHA,
   engine SHA, stochastic-inference SHA, fixture corpus, and expected
   divergences. Begin with
   `contracts/ecosystem/v1/integration-matrix.example.json`; a blank or moving
   revision is a failure for promotion.
3. Prove deterministic replay and cross-engine parity. Named expected
   divergences must be present; missing or unexpected divergences fail.
4. Prove the app's local fallback and provider path produce compatible
   user-visible facts for the pinned corpus.
5. Prove single and batched execution agree before enabling fleet volume.
6. Fast-forward each reviewed lane independently. A rejected fast-forward
   means rebase and rerun; it is not permission to force or merge around drift.
7. Build the exact reviewed app revision, deploy it privately, and smoke both
   authenticated success and anonymous denial.
8. Promote the provider only after deployed receipts match the integration
   matrix. Retain the prior adapter for rollback until replay evidence exists.

Parallelism ends at shared files. Two lanes must never own the same path, and
no lane may weaken a contract or acceptance fixture merely to make another
lane green.

## Local entrypoints

- `npm run dev` performs a full build and serves `dist/`.
- `npm run preview` is only for UI iteration after a successful full build.
- `src/index.template.html` is never a runnable preview.
- `npm run check:sdlc` validates the product entrypoint and ecosystem contract.
- `npm test` is the repository acceptance gate and includes the SDLC check.

## Evidence levels

| Level | Evidence | Permitted claim |
| --- | --- | --- |
| L0 | Design and schema only | Proposed |
| L1 | Contract fixture and local unit tests | Locally compatible |
| L2 | Replay parity on named corpus | Engine-compatible for that corpus |
| L3 | Single and batched outputs agree; benchmarks recorded | Batch-ready at measured scale |
| L4 | Exact private revision passes auth and gameplay smoke | Deployed dev capability |

No level is inferred from a later-looking UI or from source presence alone.

## Stop conditions

Stop integration if ownership is ambiguous, a run cannot replay to the same
hash, provider identity is absent from a receipt, a batch path disagrees with
single execution, the worktree contains overlapping unowned changes, or the
private deployment cannot prove its exact revision and fail-closed auth state.
