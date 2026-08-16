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

Then deliver in this order:

1. Add or update a consumer fixture against `contracts/ecosystem/v1/`.
2. Implement the provider in a clean, dedicated worktree.
3. Prove deterministic replay and, during migration, cross-engine parity.
   Named expected divergences must be present; missing or unexpected
   divergences fail the gate.
4. Integrate through an adapter. The UI must not import provider internals.
5. Run each changed repository's canonical gate and record exact revisions,
   schema versions, fixture hashes, seeds, throughput, and known limits.
6. Build the exact reviewed revision, deploy it privately, and smoke both
   authenticated success and anonymous denial. Deployment is a separate,
   deliberate action.
7. Promote the provider only after receipts from the deployed surface match
   the reviewed revision. Keep the prior adapter available for rollback until
   the new path has replay evidence.

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
