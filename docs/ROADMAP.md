# Run & Bun Roadmap

Run & Bun is a private, playable companion/game: it should provide most of the
meaningful run experience without requiring navigation through the original
game. The browser companion is the product surface. The calculator and AI are
reusable engines; emulator sync and a rebuilt runtime are later laboratories,
not prerequisites for a good game.

## Current posture

- The private Cloudflare Worker is the deployment target. The current branch
  build-materializes the authored trainer set and now passes a real workerd
  `new → apply → status` acceptance test without dynamic code generation. The
  live site still serves the older failing revision until this branch is
  reviewed and deliberately redeployed.
- The local browser run is authoritative for companion play. IndexedDB stores
  a versioned, hash-linked event ledger with lifecycle/every-50-revision
  snapshots; localStorage is only a compatibility mirror and wake-up signal.
- Export/import is a checked `rabrun.archive` boundary. Parquet and NPZ are
  derived analytics/training formats produced from checked archives; neither is
  live game state or the transactional save store.
- Planner request/receipt pairs are immutable, content-addressed attempt
  evidence. They export with the archive but never advance the game revision.
- Static Run & Bun profile data remains separate from runtime state. Tiles,
  palettes, metatiles, collision, scripts, and presentation are not yet a
  complete world/runtime implementation.

## Sequencing rule

Each phase must leave the previous phase usable. A phase is complete only when
its acceptance evidence is automated or captured in a reproducible fixture.
Do not start emulator integration or high-volume training by making the live
save model less reliable. The order below is dependency order, not a promise
that every phase will be built.

## Phase 1 — Deployment stabilization

**User outcome:** A private link opens reliably, can start a run, apply a
command, report status, and expose the same useful game/API surfaces locally
and on Cloudflare.

**Architecture/data work:** Replace `eval`/string-based model loading with
statically bundled modules or build-generated data. Add a Worker-compatible
`workerd` test harness for every protected route, including the complete
`/run/new`, `/run/apply`, `/run/status` sequence. Repair or remove the
exposed Tools validator route mismatch. Keep Basic Auth fail-closed, metadata
versioned, and deployment revision-visible.

**Acceptance gates:** `npm test`; authenticated and unauthenticated live
smoke; workerd test for new/apply/status; malformed JSON and invalid state
return explicit 400s; no browser console errors; deployed metadata matches
the exact reviewed revision; private gate remains 401 without credentials and
503 when unconfigured.

**Non-goals:** Public launch, hosted user accounts, server-side saves,
emulator access, or redesigning the entire UI.

**Risk/difficulty:** Medium/high. Cloudflare compatibility can expose hidden
Node/browser assumptions in the large embedded data set. A green local server
is not evidence that the Worker runtime works.

**Sequence:** First. Nothing downstream is accepted against a deployment that
cannot complete one authenticated run command.

## Phase 2 — Core run loop: a self-contained game

**User outcome:** A new player can choose a starter, see the next meaningful
decision, claim encounters, manage party/box/bag, prepare for a fight, play the
fight, recover, and understand what changed without being instructed by a
tutorial or navigating irrelevant original-game menus.

**Architecture/data work:** Make the run state machine and command vocabulary
the single game contract across CLI, browser, and HTTP. Add explicit route,
encounter, item, tutor, healing, level-cap, milestone, and fight-preparation
projections. Keep battle calculation read-only; apply all mutations through
serializable AI/run transitions. Add seeded deterministic decision fixtures so
encounters and fights can be replayed.

**Acceptance gates:** A browser fixture completes the first vertical slice
(starter → first route encounter → recovery/prep → first required fight) with
no impossible command accepted, no state mutation on refusal, and a valid
archive export. Reload and import reproduce the same run head and event hash.
Desktop and mobile layouts show the primary next action, party health, road
ahead, available encounters/items/tutors, and relevant warnings without
gradients or excess chrome.

**Non-goals:** Full overworld navigation, every original NPC/menu, live ROM
control, perfect XP simulation, or a complete second game profile.

**Risk/difficulty:** Medium. The hard part is product coherence: content,
rules, and UI must agree about what is available next. Avoid silently inventing
world facts when the profile is incomplete.

**Sequence:** After Phase 1. This is the minimum viable game and the reference
flow for all later data and analytics work.

## Phase 3 — Planning, review, and run intelligence

**User outcome:** Before committing to a fight or route, the player can see
what is ahead, compare legal teams, understand the largest risks, and review
why a choice worked or failed. Historical runs make progress and recurring
walls visible.

**Architecture/data work:** Promote the planner, encounter scout, matchup
board, explain facts, replay traces, and run-history views into one planning
model. Record route claims, available alternatives, decision margins, deaths,
species contribution, IV/quality evidence, item/tutor opportunity cost, and
milestone reach as typed events or derived views—not duplicated UI state. Keep
machine-readable damage facts separate from human descriptions.

**Acceptance gates:** Given the same archive and seed, planner/review output is
stable and cites its source events. A player can answer “what can I encounter
before this fight?”, “what preparation is still available?”, “why did this
team fail?”, and “how far do my runs usually reach?” from the UI. Golden
fixtures cover recommendation, encounter availability, death attribution,
and replay review; no recommendation is driven by `Result.desc()` or
`kochance()` strings.

**Current evidence:** The browser records a played trainer fight as
`battle.ended` with seed, result, turns, participants, deaths, filtered
progression order, and canonical pokemon-mono trainer order. Run history joins
the latest eligible receipt by trainer number and revision, distinguishes
unplayed and unplanned evidence, and renders descriptive plan-vs-played outcomes
without claiming carry. Re-plans after a fight cannot rewrite its review, and
wild/malformed records do not enter the join. Each new fight also records and
renders replay-stable appearances, switch-ins, move attempts, opposing real HP
removed by those moves, and direct KOs. Incomplete resumed telemetry stays
marked partial, and the UI calls this actual participation rather than carry.

The pinned Pokemon Mono provider now also evaluates bounded fixed-seed
replacement and all-15 IV reference interventions. Receipts bind the exact
attempt state, baseline and effective teams, policy, seeds, branch budget, and
provider/planner revisions. Replacement candidates require a matching chained
acquisition event. History renders these as modeled tests beside, never inside,
actual participation, and the dataset materializer emits normalized attribution
receipt/test/branch tables without a carry field.

**Non-goals:** An omniscient optimal policy, fabricated hidden information,
social leaderboards, or a promise that high IVs/species alone explain a run.

**Risk/difficulty:** Medium/high. Attribution is easy to make persuasive but
wrong. Preserve source, confidence, seed, and the exact carried state for
every claim; a casualty is not a successful safe plan.

**Sequence:** After the core loop is playable. Build on the same event ledger;
do not create a separate analytics save format.

## Phase 4 — Durable attempt history and analytics

**User outcome:** Runs are safe to pause, export, restore, compare, and mine
over time. A player can keep a trustworthy history of wipes, resets, completed
runs, milestones, encounters, and battle evidence across devices or browsers.

**Architecture/data work:** Treat the IndexedDB ledger/archive as the canonical
portable local boundary. Add schema migrations, archive repair diagnostics,
range reads, compaction policy, and explicit provenance for manual, import,
emulator, simulator, and rebuilt sources. Materialize primitive episode/event/
step/observation tables from checked archives. Use columnar Parquet (and NPZ
where dense tensor arrays are genuinely useful) only as immutable downstream
products. If hosted collaboration becomes necessary, use a Durable Object per
attempt for ordered writes, D1 for indexes/lightweight facts, and R2 for
archives/replays/derived shards; never make Parquet the live store.

**Acceptance gates:** 10,000-revision local stress test; interrupted commit,
duplicate command, revision conflict, corrupt archive, migration, and
cross-tab cases are deterministic and recoverable. Export/import preserves
hash chains and outcomes. A materializer produces versioned Parquet/NPZ with a
manifest tying every row to attempt, revision, schema, seed, and source.

**Current evidence:** IndexedDB v3 stores planner receipts separately from the
event ledger, imports older archives, rejects receipt corruption, and preserves
atomic batch order. Materializer schema `1.3.0` emits typed planning receipt,
per-seed branch, played battle outcome, plan-vs-played review, and per-Pokemon
battle-contribution tables. A
1,024-receipt maximum batch remains below 8 MiB and materializes in the local
five-second regression bound without creating game events. Native Parquet/Arrow
file writing remains downstream work.

**Non-goals:** Multi-user editing, real-time cloud sync by default, arbitrary
event mutation, or treating screenshots/tiles as structured state.

**Risk/difficulty:** High. Long-lived saves create compatibility obligations;
analytics can accidentally become a second authority. Keep event schemas
small, typed, versioned, and replayable before optimizing storage.

Cross-repository work follows the ownership and evidence boundaries in
[`ECOSYSTEM_BRIDGE.md`](ECOSYSTEM_BRIDGE.md) and the gated delivery lifecycle
in [`SDLC.md`](SDLC.md). A cross-repository feature does not advance merely
because one checkout is green; its provider, consumer, contract fixtures, and
reviewed deployment revision must agree.

**Sequence:** Begin the schema discipline in Phase 2; make cross-device or
hosted storage only after Phase 3 proves which facts users actually review.

## Phase 5 — High-volume simulation and RL workloads

**Current evidence:** The control plane now has exact single/cold-batch/warm-
batch receipt parity and reproducible transport benchmarks through 1,024
eight-seed requests, including a six-Pokemon party that evaluates 48 candidate
branches per request. The companion consumes and retains a bounded warm batch
for the current and next two fights, and checked archives materialize those
receipts into replay-linked RL rows. This closes the JSON/provider and evidence
lineage baseline, not the phase: broader party/fight distributions, native
Parquet/Arrow shard benchmarks, replayed policy episodes, and policy-quality
evaluation remain.

**User outcome:** The project can evaluate many seeds, teams, encounters, and
policy variants quickly enough to discover robust strategies and explain their
limits in the companion.

**Architecture/data work:** Separate interactive state from batch state. Use
compact integer IDs, fixed-width numeric arrays, bitsets/enums for categorical
state, explicit seeds, and versioned observation/action schemas. Keep the
calculator as a pure oracle and the transition engine serializable. Build a
headless simulator, deterministic replay/checkpointing, vectorized batch
execution, sharded Parquet observations, and NPZ/Arrow tensors only at the
training boundary. Track model/profile/code revisions and reject incompatible
shards. Add a cheap-model fleet path for broad search, with expensive exact
evaluation reserved for finalists and acceptance fixtures.

**Acceptance gates:** Replaying a sampled episode from its seed and archive
matches the interactive transition sequence; batch and single-run outputs
agree on a fixed corpus; throughput, memory, and shard-size benchmarks are
recorded; zero-death constraints and sequential encounter gates are evaluated
over whole branches, not just one favorable casualty outcome; policy changes
produce attributable metric deltas.

**Non-goals:** Training an agent before the transition contract is stable,
claiming statistical generalization from a small corpus, replacing the
companion with an opaque optimizer, or using RL to paper over missing game
rules.

**Risk/difficulty:** Very high. State explosion, simulator drift, accidental
randomness, and misleading aggregate metrics can consume substantial compute
and tokens. Start with narrow route/fight slices and cheap deterministic
rollouts; scale only when replay parity is proven.

**Sequence:** After durable schemas and a trusted core loop. Analytics formats
are outputs of this phase, never its source of truth.

## Phase 6 — Optional emulator integration and rebuild laboratory

**User outcome:** Power users may observe a local emulator and receive a
companion/planning view that stays honest about what is live, inferred, or
unsupported. Later, a rebuilt runtime may reproduce selected slices without
changing the companion contract.

**Architecture/data work:** Keep mGBA in a separate local process initially,
with a loopback-only, allowlisted observation bridge and ephemeral session
token. Emit normalized snapshots with ROM fingerprint, frame, timestamp,
scene, party/box, bag, battle, and flags digest; reduce them into the same
event envelope as manual play. Build world data in layers: map
headers/layouts, metatile behavior/collision/warps first, then tiles, palettes,
composition, sprites, scripts, and presentation. Tilesets are static
presentation assets; metatile behavior is world logic; neither belongs in
the live event ledger. The hosted Worker must never read emulator memory.

**Acceptance gates:** Read-only sync agrees with the emulator at ten named
saves for every supported field and labels unsupported values `unknown`.
Same-input battle checks agree on party, active state, HP/status, moves/PP,
field, legal actions, and resolved deltas. A rebuilt vertical slice reaches
the same semantic checkpoints as mGBA under deterministic replay. Every ROM,
asset, and bridge claim has provenance and distribution boundaries.

**Non-goals:** Remote emulator control, shipping copyrighted ROM/tileset assets,
full map coverage, perfect visual emulation, or making the emulator a
production dependency for ordinary companion play.

**Risk/difficulty:** Extreme. Memory layouts, save variants, timing, scripts,
tileset extraction, and process reliability make this a research program. The
previous separate-process mGBA work is evidence to reuse, not proof of a live
adapter. Shared-process integration remains optional and should be attempted
only after the read-only contract passes.

**Sequence:** Last and independently gated. The first candidate is a small
route-to-fight slice, not the whole game.

## Near-term execution order

1. Review the Worker-safe loader and workerd `new → apply → status` gate,
   redeploy privately, and repeat the authenticated/anonymous live smoke.
2. Finish the first self-contained game slice and its reload/export/import
   evidence.
3. Consolidate road-ahead, encounter/item/tutor availability, prep, and review
   into the core game screen.
4. Expand historical run attribution and archive-derived analytics.
5. Add batch simulation/RL only against replay-locked schemas.
6. Revisit emulator sync only if the companion and simulator still leave a
   valuable, testable gap.

## Global stop conditions

Pause expansion when a change makes the run head non-replayable, blurs the
source of a fact, requires the user to understand internal workflow, or makes
the private deployment less verifiable. A new feature must identify its user
outcome, event/state contract, evidence gate, and explicit non-goal before it
enters implementation.
