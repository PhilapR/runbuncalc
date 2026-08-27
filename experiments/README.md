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

## The tracking standard

Every batch gets one label and up to three runs on it, each answering a
question the others cannot:

- **measurement** (`ab.js --measure`) — how far runs get. Reach, walls,
  forecast rate.
- **cost** (`cost-bench.js`) — where the work goes, counted in constructed
  calculator objects because wall clock measures the shared runner.
- **calibration** (`plan-calibration.js`) — whether the plan told the truth,
  fight by fight.

One revision per label. The `valid` tag is `VALID` only when every report in
the batch names the same revision; anything else is `POOLED` and must not be
charted as one product.

### Metrics

Named by role, never by arm. Curves go in **stepped** (`log_metric(...,
step=n)`) so the shape is one chart, not n charts. Every run carries a
`METRICS.md` artifact defining its metric names, because a chart legend is
all a reader gets.

### Traces: one per evaluation

A fight is an evaluation, and each one gets a full trace:

- **root span** — the claim and the grade side by side: `predicted_losses`,
  `actual_losses`, `underpriced_by`, the verdict string the player read.
- **turn spans** — one per timeline entry, HP on both sides, the bench.
- **events** — the transcript, line by line, on the root. "Foe Mankey used
  Reversal. (100% to Tirtouga)" belongs on the trace, not one click away.
- **tags** — the searchable dimensions: `outcome`, `trainer`, `threshold`,
  `underpriced`. `tags.underpriced = 'true'` in the filter box is the whole
  triage workflow.
- **assessments** — `predicted_losses` as an *expectation*, `actual_losses`
  and `verdict_held` as *feedback* with a rationale. Logged after
  `end_trace`, because assessments attach to persisted traces only.
- **artifacts** — `fights/NNN-trainer-outcome.json`, the complete record.

Batch ingest must set `MLFLOW_ENABLE_ASYNC_TRACE_LOGGING=false` (ingest.py
does). The async queue is sized for a live app and silently dropped 60% of
the first batch — "Queue full, dropping Span" in a scrollback nobody reads.

### Review is required, and it refuses

`uv run python trace_qc.py <label>` recounts everything against the source
JSON: traces against evaluations, turn spans against timeline entries, events
against transcript lines, assessments against predicted fights. Any mismatch
is exit 1. A pass stamps `qc_*` metrics and `qc = PASS` on the calibration
run — **a calibration run without that tag has not been reviewed** and its
traces must not be cited.

Ingest is not idempotent: re-running it duplicates runs and traces. Delete
the label's calibration run and wipe the trace tables before re-ingesting,
then re-run QC.

### Retention

After a batch is calibrated, ingested, and QC-passed, the raw artifacts are
redundant and can go:

- **delete** the per-run driver `.log` files (raw stdout — a proven-broken
  instrument for analysis; the journal lives in the reports) and screenshots
- **delete** the batch's `report-*.json` once its calibration JSON exists —
  every fight's verdict, timeline and transcript is embedded there and
  QC-verified in MLflow
- **keep** every `*-calibration.json` (QC audits against them), the
  measure/ab/cost summaries, the old shell-loop tally logs (ingest re-reads
  them), and the historical pre-batch reports — those carry the deep run
  documents all real-state sampling depends on and cannot be regenerated
- **never delete** `mlflow.db` or `mlruns/` — they are the system of record

Run `trace_qc.py` for every label after cleaning; a PASS proves the record
survived the deletion.
