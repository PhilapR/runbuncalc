# Experiment tracking

MLflow over the playthrough A/B comparisons. `uv run python ingest.py` reads
`ui-playthrough-out/` and loads every comparison it can find; the UI is a
launch config, `preview_start` with `mlflow`, on port 5555.

## Why this exists

Five comparisons were run in one day across three generations of harness, and
putting them side by side was the only way to find out which could be believed.
The answer was two of five, and both of those only reconstructably.

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
