# Experiment tracking

MLflow over the playthrough A/B comparisons. `uv run python ingest.py` reads
`ui-playthrough-out/` and loads every comparison it can find; the UI is a
launch config, `preview_start` with `mlflow`, on port 5555.

## Why this exists

Five comparisons were run in one day across three generations of harness, and
putting them side by side was the only way to find out which could be believed.
The answer was two of five, and both of those only reconstructably.

## What a `kind=cost` run is

The comparisons say which policy wins. The measurements say how good the
product is today. Neither says where the time goes. That gap let three
optimisations rest on a profile nobody had run. One of them narrowed a stage
that already cost nothing: the ranker reads cached grid cells, and 78x the
combinations built FEWER calculator objects.

`node scripts/cost-bench.js --label=<name>` writes
`ui-playthrough-out/<name>-cost.json`, and `ingest_cost` loads it. Read
`objects_*` before `ms_*`. Other work shares this runner, three timing gates
flaked on machine load in one session, and a constructed object is exact.
Seconds are there because a player feels seconds, not allocations.

`objects_share_pct__*` is where the money goes. Measured across six real
states: playbook 74%, rank 23%, boxMatrix 3%.

`memory_cache_mb__*` charges a memo for its own keys. A cache trades memory
for compute, and the first version of this benchmark measured one side only.
The naive whole-state key costs 257MB across six fights. That number is the
difference between "ship the cache" and "ship a cheaper key first".

Each run also carries its cost JSON as an artifact. Git ignores
`ui-playthrough-out/`, so the numbers outlive the file they came from. The
stage timings replay as a trace: the harness records when each stage started
and ended, so the span tree is the one that ran.

The tail metrics price the ranker's cut where it bites rather than where it
does not. `tail_whole_box_refused=1` is the feature: a box of 76 is 218,618,940
sixes and used to take 177 seconds.

**`arms_agree` gates every other number here.** Every arm plays the same
fights. Every arm fingerprints its own answer: the assignment map, the odds,
the top six. An arm that got cheap by answering differently is not an
optimisation. The ingest tags such a run `problem`, and its ratios mean
nothing.

The workload is a real run document out of `ui-playthrough-out/`. The harness
refuses a constructed box rather than substituting one. A box of identical
early-route Pokemon collapses the ranker's shortlist to a single six, and it
wipes to every trainer. Two optimisation proposals passed on that box and
died on real mid-run states.

## What the `valid` tag means

- **VALID** — the harness recorded a revision, it did not move, the tree was
  clean, and no run reported a flag nothing read. `scripts/ab.js` enforces all
  four and refuses to print a summary otherwise.
- **RECONSTRUCTED** — no revision was recorded, but nothing under
  `scripts/ui-playthrough.js`, `lib/`, `src/` or `ai/` was committed between
  the first and last run log. Weaker than a recorded revision, because an
  uncommitted edit leaves no trace. It establishes "no evidence against".
- **INVALID** — the code demonstrably moved while the batch ran. Not a weak
  result: an unusable one, because the arms were not comparing what they claim.

## The clustering caveat, which is the important one

`ratio_gavi_attempts_clustered` is **not** a significance test, and it is named
that way so it cannot be mistaken for one. Attempts inside a single run share a
box, a party and a policy — a good box wins early, a bad one loses all twelve —
so they are strongly correlated and Fisher's independence assumption fails.

Pooling them reported the ranking change at `p = 0.03`. The run-level test on
the same thirty runs gives `p = 0.07`. The second number is the defensible one.
Use `p_pass_gavi` and `p_beat_brawly`, which have one observation per run.

The ratio is still worth having: it says how many attempts a wall costs, which
is a claim about efficiency rather than about significance.
