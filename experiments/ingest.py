"""Load playthrough A/B results into MLflow.

The comparisons in this repository were run over about a day, in three
generations of harness, and the point of putting them in one place is to find
out which of them can actually be believed.

Two shapes go in:

* `ui-playthrough-out/<label>-measure.json`, written by `scripts/ab.js --measure`.
  One arm on one revision, for the questions a comparison cannot answer — how
  good is the product today, and is it better than last week.
* `ui-playthrough-out/<label>-ab.json`, written by `scripts/ab.js`. These carry
  per-run provenance — the revision, whether the tree was dirty, the argv — and
  the harness's own validity verdict.
* `ui-playthrough-out/*-ab.log` and `*-batch.log`, written by the shell loops
  that came before it. These carry a tally and nothing else. They are ingested
  because throwing away evidence is worse than labelling it, and every one of
  them is tagged `provenance=none` so a chart cannot quietly mix them with the
  runs that can name their own code.

Nothing here recomputes an outcome. It reads what the runs recorded, attaches
the conditions they ran under, and lets MLflow show which comparisons hold.
"""

from __future__ import annotations

import datetime as dt
import json
import math
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

import mlflow

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "ui-playthrough-out"
# MLflow 3 put the filesystem store into maintenance mode, and SQLite is
# what the ledger in this repository already uses for the same job.
DB = Path(__file__).resolve().parent / "mlflow.db"
TRACKING = f"sqlite:///{DB}"


def ln_choose(n: int, k: int) -> float:
    return math.lgamma(n + 1) - math.lgamma(k + 1) - math.lgamma(n - k + 1)


def fisher_one_sided(a: int, b: int, c: int, d: int) -> float:
    """P(X >= a) with both margins fixed. Matches scripts/ab.js to 4 decimals."""
    n, row, col = a + b + c + d, a + b, a + c
    if n == 0 or row == 0 or col == 0:
        return 1.0
    total = 0.0
    for x in range(a, min(row, col) + 1):
        y, z, w = row - x, col - x, n - row - col + x
        if y < 0 or z < 0 or w < 0:
            continue
        total += math.exp(ln_choose(col, x) + ln_choose(n - col, y) - ln_choose(n, row))
    return min(1.0, total)


@dataclass
class Arm:
    """One side of a comparison, counted the way the runs recorded it."""

    name: str
    runs: int = 0
    orders: list[int] = field(default_factory=list)
    passed_gavi: int = 0
    beat_brawly: int = 0
    gavi_won: int = 0
    gavi_attempts: int = 0
    brawly_won: int = 0
    brawly_attempts: int = 0
    crashed: int = 0
    forecast_live: int = 0
    forecast_dead: int = 0
    forecast_ability: int = 0
    forecast_trainer: int = 0

    @property
    def mean_order(self) -> float:
        return sum(self.orders) / len(self.orders) if self.orders else 0.0


def metrics_for(arm: Arm, side: str) -> dict[str, float]:
    """Metrics named by ROLE, not by what the arm happened to be called.

    Naming them after the arms — NEW_passed_gavi, NOSTATUS_mean_order,
    A_runs — gave five comparisons 84 distinct metric names, so nothing lined
    up across runs and MLflow drew 84 unrelated single-point charts. `side` is
    always "control" or "treatment", which makes every comparison chartable on
    the same axes. Which arm was which is a parameter, where it belongs.
    """
    out = {
        f"{side}_runs": arm.runs,
        f"{side}_mean_order": arm.mean_order,
        f"{side}_passed_gavi": arm.passed_gavi,
        f"{side}_beat_brawly": arm.beat_brawly,
        f"{side}_crashed": arm.crashed,
    }
    if arm.runs:
        out[f"{side}_pass_gavi_rate"] = arm.passed_gavi / arm.runs
        out[f"{side}_beat_brawly_rate"] = arm.beat_brawly / arm.runs
    if arm.gavi_attempts:
        out[f"{side}_gavi_attempt_rate"] = arm.gavi_won / arm.gavi_attempts
    if arm.brawly_attempts:
        out[f"{side}_brawly_attempt_rate"] = arm.brawly_won / arm.brawly_attempts
    # The survival forecast, which is the product metric rather than a policy
    # one: what share of planned fights could the engine answer "do you live
    # through this" for. It went 2.9% -> 14.5% -> 10.6% -> 19.8% across four
    # fixes in a day and lived only in commit messages. The dip in the middle
    # is why the causes are split out — the trainer resolver looked like a
    # regression because it let more fights reach the engine, where they hit
    # the ability wall instead.
    planned = arm.forecast_live + arm.forecast_dead
    if planned:
        out[f"{side}_forecast_rate"] = arm.forecast_live / planned
        out[f"{side}_forecast_planned"] = planned
        out[f"{side}_forecast_dead_ability"] = arm.forecast_ability
        out[f"{side}_forecast_dead_trainer"] = arm.forecast_trainer
    return out


def forecast_metrics(forecast: dict) -> dict[str, float]:
    """What share of this run's planned fights got a survival answer.

    Reported per playthrough as well as per arm, because the spread across runs
    is wide and a mean hides it. Six runs on one revision came in at 0.0, 3.6,
    14.8, 25.0, 32.1 and 42.9 percent, for a pooled 19.8 — so the summary
    number describes none of them and the range is the more useful fact.

    That spread was first written here as "bimodal", by analogy with the wall
    results where a box either clears Camper Gavi or never does. Measured, it
    is not: the six sit fairly evenly across the range rather than clustering
    at two poles. The rate depends on how many refused species a box happens to
    hold, which is a count rather than a threshold.
    """
    live = forecast.get("live", 0)
    dead = forecast.get("dead", 0)
    planned = live + dead
    if not planned:
        return {}
    return {
        "forecast_live": live,
        "forecast_planned": planned,
        "forecast_rate": live / planned,
        "forecast_dead_ability": forecast.get("ability", 0),
        "forecast_dead_trainer": forecast.get("trainer", 0),
    }


def log_playthroughs(rows: list[dict]) -> None:
    """A child run per PLAYTHROUGH, nested under the comparison.

    One run per comparison was the first shape here, and it is the wrong unit.
    MLflow's run is one execution, and one execution here is one playthrough —
    so collapsing thirty into a single row threw away the distribution and left
    only its mean. That is precisely what could not be seen when this
    comparison's direction flipped twice before n = 15: a mean moves smoothly
    while the runs behind it are bimodal, because a box either clears a wall or
    never does. The children make that visible without any statistics at all.
    """
    for row in rows:
        with mlflow.start_run(run_name=f"{row['arm']}-{row['index']}", nested=True):
            prov = row.get("provenance") or {}
            mlflow.set_tags(
                {
                    "arm": row["arm"],
                    "side": row.get("side", ""),
                    "starter": row.get("starter", ""),
                    "crashed": str(bool(row.get("crashed"))).lower(),
                }
            )
            mlflow.log_params(
                {
                    "arm": row["arm"],
                    "side": row.get("side", ""),
                    "starter": row.get("starter", ""),
                    "revision": (prov.get("revision") or "")[:10],
                    "dirty": prov.get("dirty"),
                }
            )
            gavi, brawly = row.get("gavi", {}), row.get("brawly", {})
            mlflow.log_metrics(
                {
                    "order": row.get("order", 0),
                    "gavi_won": gavi.get("won", 0),
                    "gavi_attempts": gavi.get("attempts", 0),
                    "brawly_won": brawly.get("won", 0),
                    "brawly_attempts": brawly.get("attempts", 0),
                    "passed_gavi": 1 if gavi.get("won", 0) else 0,
                    "beat_brawly": 1 if brawly.get("won", 0) else 0,
                    **forecast_metrics(row.get("forecast") or {}),
                }
            )


def log_comparison(
    label: str,
    a: Arm,
    b: Arm,
    params: dict,
    problems: list[str],
    rows: list[dict] | None = None,
) -> None:
    """A parent run per COMPARISON, with a child per playthrough beneath it."""
    with mlflow.start_run(run_name=label):
        mlflow.set_tags(
            {
                "label": label,
                # The single most important field here. A comparison that cannot
                # name the code that produced it is not a slow result, it is an
                # unusable one, and it must never be averaged with the others.
                "valid": (
                    "no"
                    if problems
                    else "yes"
                    if params.get("provenance") == "full"
                    else "reconstructed"
                ),
                "provenance": params.get("provenance", "unknown"),
                "problems": "; ".join(problems) if problems else "",
            }
        )
        mlflow.log_params({k: v for k, v in params.items() if v is not None})
        mlflow.log_metrics(metrics_for(a, "control") | metrics_for(b, "treatment"))
        mlflow.log_metrics(
            {
                "p_pass_gavi": fisher_one_sided(
                    b.passed_gavi,
                    b.runs - b.passed_gavi,
                    a.passed_gavi,
                    a.runs - a.passed_gavi,
                ),
                # CLUSTERED, and not a significance test. Attempts inside one
                # run share a box, a party and a policy: a good box wins early
                # and a bad one loses all twelve, so the attempts are strongly
                # correlated and Fisher's independence assumption does not
                # hold. Pooling them turned the ranking comparison into
                # "p = 0.03" when the run-level test on the same data says
                # 0.07. It is kept because the ratio is informative about
                # efficiency — how many tries a wall costs — and renamed so it
                # cannot be read as evidence of significance.
                "ratio_gavi_attempts_clustered": fisher_one_sided(
                    b.gavi_won,
                    b.gavi_attempts - b.gavi_won,
                    a.gavi_won,
                    a.gavi_attempts - a.gavi_won,
                ),
                # The defensible tests: one independent observation per RUN.
                "p_beat_brawly": fisher_one_sided(
                    b.beat_brawly,
                    b.runs - b.beat_brawly,
                    a.beat_brawly,
                    a.runs - a.beat_brawly,
                ),
                "invalid": 1.0 if problems else 0.0,
                "total_runs": a.runs + b.runs,
            }
        )
        # The file the numbers came from, attached to the run that reports
        # them. Re-deriving a comparison a month from now should not depend on
        # ui-playthrough-out/ still holding the same file under the same name.
        source = params.get("source_file")
        if source and Path(source).exists():
            mlflow.log_artifact(source, artifact_path="source")

        # The distribution, as text, because it is the thing worth reading and
        # the parent's metrics can only hold its mean.
        if rows:
            lines = []
            for side in ("control", "treatment"):
                mine = sorted(r.get("order", 0) for r in rows if r.get("side") == side)
                arm_name = params.get("arm_a" if side == "control" else "arm_b", side)
                lines.append(f"{side} ({arm_name}) n={len(mine)}")
                lines.append("  " + " ".join(str(v) for v in mine))
            mlflow.log_text("\n".join(lines), "distribution.txt")

        verdict = (
            "INVALID — " + "; ".join(problems)
            if problems
            else "valid"
            if params.get("provenance") == "full"
            else "reconstructed: no revision recorded, but nothing the driver "
            "runs was committed while it ran"
        )
        mlflow.set_tag(
            "mlflow.note.content",
            f"{params.get('arm_a')} (control) vs {params.get('arm_b')} "
            f"(treatment), {a.runs + b.runs} playthroughs.\n\n{verdict}",
        )

        if rows:
            log_playthroughs(rows)


def ingest_measurement(path: Path) -> str:
    """A batch on ONE revision, with no arm to compare it against.

    The comparisons answer "is this policy better than that one". They cannot
    answer "how good is the product today", and that is the question the
    forecast rate asks: it moved 2.9% -> 14.5% -> 10.6% -> 19.8% across four
    fixes, each a single batch, and none of them had a way in here.

    Logged as its own run so the series is chartable over revisions. The arm is
    named "measurement" rather than control or treatment, because calling a
    lone batch a control would invite MLflow to line it up against treatments
    it was never run beside.
    """
    data = json.loads(path.read_text())
    rows = data.get("rows", [])
    label = data.get("label", path.stem)
    summary = data.get("summary", {})
    live = summary.get("forecastLive", 0)
    dead = summary.get("forecastDead", 0)
    planned = live + dead

    with mlflow.start_run(run_name=f"{label} (measurement)"):
        mlflow.set_tags({"kind": "measurement", "label": label})
        mlflow.log_params(
            {
                "harness": "scripts/ab.js --measure",
                "revision": (data.get("revision") or "")[:10],
                "flags": " ".join(data.get("flags", [])) or "(defaults)",
                "shared": " ".join(data.get("shared", [])),
                "runs": data.get("runs"),
                "parallel": data.get("parallel"),
                "source_file": str(path),
            }
        )
        metrics = {
            "runs": summary.get("runs", 0),
            "mean_order": summary.get("meanOrder", 0.0),
            "passed_gavi": summary.get("passedGavi", 0),
            "beat_brawly": summary.get("beatBrawly", 0),
            "crashed": summary.get("crashed", 0),
        }
        if planned:
            metrics |= {
                "forecast_rate": live / planned,
                "forecast_live": live,
                "forecast_planned": planned,
                "forecast_dead_ability": summary.get("forecastAbility", 0),
                "forecast_dead_trainer": summary.get("forecastTrainer", 0),
            }
        mlflow.log_metrics(metrics)
        for row in rows:
            row["side"] = "measurement"
        log_playthroughs(rows)
        for problem in data.get("problems", []):
            mlflow.set_tag("problem", problem)
    return label


def ingest_structured(path: Path) -> str:
    data = json.loads(path.read_text())
    arms: dict[str, Arm] = {}
    for row in data.get("rows", []):
        arm = arms.setdefault(row["arm"], Arm(name=row["arm"]))
        arm.runs += 1
        arm.orders.append(row.get("order", 0))
        gavi, brawly = row.get("gavi", {}), row.get("brawly", {})
        arm.gavi_won += gavi.get("won", 0)
        arm.gavi_attempts += gavi.get("attempts", 0)
        arm.brawly_won += brawly.get("won", 0)
        arm.brawly_attempts += brawly.get("attempts", 0)
        arm.passed_gavi += 1 if gavi.get("won", 0) else 0
        arm.beat_brawly += 1 if brawly.get("won", 0) else 0
        arm.crashed += 1 if row.get("crashed") else 0
        forecast = row.get("forecast") or {}
        arm.forecast_live += forecast.get("live", 0)
        arm.forecast_dead += forecast.get("dead", 0)
        arm.forecast_ability += forecast.get("ability", 0)
        arm.forecast_trainer += forecast.get("trainer", 0)

    for row in data.get("rows", []):
        row["side"] = "control" if row["arm"] == "A" else "treatment"
    a = arms.get("A", Arm("A"))
    b = arms.get("B", Arm("B"))
    label = data.get("label", path.stem)
    dirty = any((r.get("provenance") or {}).get("dirty") for r in data.get("rows", []))
    log_comparison(
        label,
        a,
        b,
        {
            "harness": "scripts/ab.js",
            "provenance": "full",
            "revision": (data.get("revision") or "")[:10],
            "arm_a": " ".join(data.get("armA", [])) or "(defaults)",
            "arm_b": " ".join(data.get("armB", [])) or "(defaults)",
            "shared": " ".join(data.get("shared", [])),
            "pairs": data.get("pairs"),
            "parallel": data.get("parallel"),
            "dirty_tree": dirty,
            "source_file": str(path),
        },
        data.get("problems", []),
        data.get("rows", []),
    )
    return label


TALLY = re.compile(
    r"^(?P<arm>[A-Z]+)\s+\d+\s+\((?P<starter>\w+)\):.*?order=(?P<order>\d+)"
    r"(?:.*?gavi=(?P<gw>\d+)/(?P<ga>\d+))?"
    r"(?:.*?brawly=(?P<bw>\d+)/(?P<ba>\d+))?"
)


def run_window(label: str) -> tuple[str, str] | None:
    """When a provenance-less batch actually ran, from its logs' mtimes."""
    stem = label.replace("-ab", "")
    # Only per-run logs. The tally file is written throughout, so its mtime is
    # the end rather than a run; and a batch that was abandoned and renamed
    # DISCARDED must not drag the window back over the commit that caused it to
    # be abandoned — which it did, reporting acc-ab as straddled when the
    # surviving runs all post-date that commit by ten minutes.
    logs = [
        p
        for p in OUT.glob(f"{stem}-*.log")
        if p.is_file() and "DISCARDED" not in p.name and p.name != f"{label}.log"
    ]
    stamps = sorted(p.stat().st_mtime for p in logs)
    if not stamps:
        return None
    # Local time, because that is what `git log --since` compares against.
    fmt = "%Y-%m-%dT%H:%M:%S"
    local = dt.datetime.now().astimezone().tzinfo
    return (
        dt.datetime.fromtimestamp(stamps[0], tz=local).strftime(fmt),
        dt.datetime.fromtimestamp(stamps[-1], tz=local).strftime(fmt),
    )


def code_moved_during(window: tuple[str, str]) -> list[str] | None:
    """Commits to the code a playthrough exercises, inside that window.

    A batch from before provenance existed is not automatically worthless. If
    nothing that the driver runs was committed while it ran, the comparison is
    reconstructably sound — weaker than a recorded revision, stronger than
    nothing. It cannot see uncommitted edits, so it establishes "no evidence
    against" rather than "verified", and the tag says exactly that.
    """
    try:
        out = subprocess.run(
            [
                "git",
                "log",
                "--format=%h %s",
                f"--since={window[0]}",
                f"--until={window[1]}",
                "--",
                "scripts/ui-playthrough.js",
                "lib/",
                "src/",
                "ai/",
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
    except (subprocess.CalledProcessError, OSError):
        return None
    return [line for line in out.splitlines() if line]


def ingest_tally(path: Path) -> str | None:
    """A shell-era tally: two arms, a line each, and no idea what code ran."""
    arms: dict[str, Arm] = {}
    # Each line of a tally IS a playthrough, so it can carry a child run even
    # though the loop that wrote it recorded no provenance. The distribution is
    # the point: these are the comparisons whose direction flipped mid-batch.
    rows: list[dict] = []
    for line in path.read_text().splitlines():
        m = TALLY.match(line.strip())
        if not m:
            continue
        arm = arms.setdefault(m.group("arm"), Arm(name=m.group("arm")))
        rows.append(
            {
                "arm": m.group("arm"),
                "index": arm.runs + 1,
                "starter": m.group("starter"),
                "order": int(m.group("order")),
                "gavi": {
                    "won": int(m.group("gw") or 0),
                    "attempts": int(m.group("ga") or 0),
                },
                "brawly": {
                    "won": int(m.group("bw") or 0),
                    "attempts": int(m.group("ba") or 0),
                },
                "crashed": False,
                "provenance": None,
            }
        )
        arm.runs += 1
        arm.orders.append(int(m.group("order")))
        if m.group("ga"):
            arm.gavi_won += int(m.group("gw"))
            arm.gavi_attempts += int(m.group("ga"))
            arm.passed_gavi += 1 if int(m.group("gw")) else 0
        if m.group("ba"):
            arm.brawly_won += int(m.group("bw"))
            arm.brawly_attempts += int(m.group("ba"))
            arm.beat_brawly += 1 if int(m.group("bw")) else 0
    if len(arms) != 2:
        return None
    names = sorted(arms)
    a, b = arms[names[0]], arms[names[1]]
    for row in rows:
        row["side"] = "control" if row["arm"] == names[0] else "treatment"
    label = path.stem
    # These predate the validity gates entirely. The honest verdict is not
    # "valid" but "unknown", and the tag says so rather than implying a check
    # that never ran.
    window = run_window(label)
    moved = code_moved_during(window) if window else None
    if moved is None:
        provenance, problems = (
            "none",
            ["no provenance recorded, and the run window could not be reconstructed"],
        )
    elif moved:
        provenance, problems = (
            "reconstructed",
            ["code was committed while this batch ran: " + "; ".join(moved)],
        )
    else:
        # No recorded revision, but nothing the driver runs was committed while
        # it did. Not proof — an uncommitted edit leaves no trace — but the
        # difference between this and a straddled batch is the whole question.
        provenance, problems = "reconstructed", []
    log_comparison(
        label,
        a,
        b,
        {
            "harness": "shell loop",
            "provenance": provenance,
            "arm_a": names[0],
            "arm_b": names[1],
            "window_start": window[0] if window else None,
            "window_end": window[1] if window else None,
            "source_file": str(path),
        },
        problems,
        rows,
    )
    return label


def ingest_cost(path: Path) -> str:
    """What a fight COSTS, per arm, written by `scripts/cost-bench.js`.

    The comparisons say which policy wins and the measurements say how good
    the product is. Neither says where the time goes, and that gap let three
    optimisations be argued from a profile nobody had run — one of them turned
    out to be free work on a stage that was already free.

    Counted in constructed calculator objects, which is the unit the cost gates
    in this repository settled on: the runner is shared, three timing gates
    flaked on machine load in one session, and an object is exact. Seconds go in
    beside it because a player feels seconds, not allocations.

    `arms_agree` is the metric that decides whether the rest can be read. Every
    arm plays the same fights and fingerprints its own answer — the assignment
    map, the odds, the top six. An arm that got cheap by getting different is
    not an optimisation, so a run where this is 0 is tagged `problem` and its
    ratios mean nothing.
    """
    data = json.loads(path.read_text())
    label = data.get("label", path.stem)
    arms = data.get("arms", [])
    results = data.get("results", [])
    tail = data.get("tail", {})

    def total(arm: str, field: str) -> float:
        return sum(r["arms"].get(arm, {}).get(field, 0) or 0 for r in results)

    agreed = [r for r in results if r.get("agree") is not False]

    with mlflow.start_run(run_name=f"{label} (cost)"):
        mlflow.set_tags(
            {
                "kind": "cost",
                "label": label,
                # Same discipline as the comparisons: a dirty tree cannot name
                # the code it ran, so it is RECONSTRUCTED at best.
                "valid": "VALID" if data.get("revision") and not data.get("dirty") else "RECONSTRUCTED",
                "provenance": "revision" if data.get("revision") else "none",
            }
        )
        mlflow.log_params(
            {
                "harness": "scripts/cost-bench.js",
                "revision": (data.get("revision") or "")[:10],
                "dirty": data.get("dirty"),
                "node": data.get("node"),
                "arms": " ".join(arms),
                "states": len(results),
                "positions": ",".join(str(r.get("position")) for r in results),
                "source_file": str(path),
            }
        )

        metrics: dict[str, float] = {
            "states": len(results),
            "arms_agree": 1.0 if all(r.get("agree") is not False for r in results) else 0.0,
        }
        for arm in arms:
            safe = re.sub(r"[^0-9a-zA-Z_]+", "_", arm)
            metrics[f"objects_{safe}"] = total(arm, "objects")
            metrics[f"ms_{safe}"] = total(arm, "ms")
        if len(arms) > 1 and total(arms[1], "objects"):
            metrics["objects_ratio"] = total(arms[0], "objects") / total(arms[1], "objects")
        if len(arms) > 1 and total(arms[1], "ms"):
            metrics["ms_ratio"] = total(arms[0], "ms") / total(arms[1], "ms")

        # Per stage, so "the playbook is 81% of it" is a chart rather than a
        # claim somebody has to take on trust.
        base = arms[0] if arms else None
        if base:
            per_stage: dict[str, float] = {}
            for row in results:
                for stage in row["arms"].get(base, {}).get("stages", []) or []:
                    per_stage[stage["stage"]] = per_stage.get(stage["stage"], 0) + stage["objects"]
            grand = sum(per_stage.values()) or 1
            for stage, value in per_stage.items():
                safe = re.sub(r"[^0-9a-zA-Z_]+", "_", stage)
                metrics[f"stage_objects_{safe}"] = value
                metrics[f"stage_share_{safe}"] = value / grand

        # The ranker's cut priced where it bites. On a normal box the
        # enumeration is free; this is the tail it was written for.
        cut = tail.get("cut", {})
        whole = tail.get("wholeBox", {})
        if cut:
            metrics |= {
                "tail_box": tail.get("boxSize", 0),
                "tail_candidates": cut.get("candidates", 0),
                "tail_combinations": cut.get("combinations", 0),
                "tail_ms": cut.get("ms", 0.0),
                "tail_whole_box_refused": 1.0 if whole.get("refused") else 0.0,
            }
        mlflow.log_metrics(metrics)

        if len(agreed) != len(results):
            mlflow.set_tag(
                "problem",
                "an arm answered differently from the others; its ratios are not "
                "a speedup, they are a different question answered faster",
            )
        if whole.get("refused"):
            mlflow.set_tag("tail_refusal", whole["refused"][:250])

        # One nested run per state, so a single fight can be inspected rather
        # than only the total.
        for row in results:
            with mlflow.start_run(run_name=f"#{row.get('position')} {row.get('trainer')}", nested=True):
                mlflow.set_tags({"kind": "cost-state", "trainer": row.get("trainer", "")})
                mlflow.log_params(
                    {"position": row.get("position"), "source": row.get("source")}
                )
                inner: dict[str, float] = {}
                for arm in arms:
                    got = row["arms"].get(arm, {})
                    safe = re.sub(r"[^0-9a-zA-Z_]+", "_", arm)
                    if "objects" in got:
                        inner[f"objects_{safe}"] = got["objects"]
                        inner[f"ms_{safe}"] = got.get("ms", 0.0)
                    if arm == arms[0]:
                        inner |= {
                            "box_size": got.get("boxSize", 0),
                            "combinations": got.get("combinations", 0),
                            "explored": got.get("explored", 0),
                            "variant_rollouts": got.get("variantRollouts", 0),
                        }
                inner["agree"] = 1.0 if row.get("agree") is not False else 0.0
                mlflow.log_metrics(inner)
    return label


def main() -> None:
    mlflow.set_tracking_uri(TRACKING)
    experiment = mlflow.set_experiment("playthrough-policy")
    # The onboarding skill reads this tag to decide which path applies. There is
    # no trained model here — the policy is hand-written JS — but the machinery
    # in use is the traditional one: params, metrics and runs, no tracing.
    mlflow.set_experiment_tag("mlflow.experimentKind", "custom_model_development")
    mlflow.set_experiment_tag(
        "note",
        "A/B comparisons of a game-playing policy. No model artifacts: the "
        "policy is JavaScript, and a run is one playthrough.",
    )
    del experiment

    done = []
    for path in sorted(OUT.glob("*-ab.json")):
        done.append(f"{path.name} -> {ingest_structured(path)} (full provenance)")
    for path in sorted(OUT.glob("*-measure.json")):
        done.append(f"{path.name} -> {ingest_measurement(path)} (measurement)")
    for path in sorted(OUT.glob("*-cost.json")):
        done.append(f"{path.name} -> {ingest_cost(path)} (cost)")
    for path in sorted(OUT.glob("*-ab.log")) + sorted(OUT.glob("*-batch.log")):
        label = ingest_tally(path)
        if label:
            done.append(f"{path.name} -> {label} (NO provenance)")
        else:
            done.append(f"{path.name} -> skipped, not a two-arm tally")
    print("\n".join(done))
    print(f"\ntracking uri: {TRACKING}")


if __name__ == "__main__":
    main()
