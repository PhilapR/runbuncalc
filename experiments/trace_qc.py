"""Quality control for the per-fight traces. Refuses; does not report.

The first trace ingest silently dropped 60% of what it was given: the async
export queue overflowed, printed "Queue full, dropping Span" into a scrollback
nobody reads, and left 166 traces of 491 looking like a complete record. Only
recounting against the source caught it. That is the failure mode this gate
exists for — an observability store that is quietly partial is worse than
none, because it is trusted.

So every count here is checked against the calibration JSON the traces were
built from, and a mismatch is an exit code, not a log line:

  * one trace per evaluation, found by exact count — FILTERED TO THE LABEL
    under audit, because the store holds every batch and counting the pool
    against one batch's source fails the moment a second label lands
  * one turn span per timeline entry, summed across the batch
  * one span event per transcript line (as capped at ingest)
  * the root attributes a reviewer filters on, present on every root
  * an expectation/feedback pair on every fight that predicted a number

Passing writes `qc_*` metrics onto the calibration run so the run itself
records that its traces were audited — a calibration run without them has not
been through review.

Usage:
    uv run python trace_qc.py post-perf
"""

from __future__ import annotations

import json
import sys

import mlflow

import ingest

REQUIRED_ROOT_ATTRIBUTES = (
    "trainer",
    "outcome",
    "predicted_losses",
    "actual_losses",
    "verdict",
)


def audit(label: str) -> int:
    mlflow.set_tracking_uri(ingest.TRACKING)
    client = mlflow.MlflowClient()
    experiment = client.get_experiment_by_name("playthrough-policy")
    if experiment is None:
        print("QC FAIL: no playthrough-policy experiment")
        return 1

    source = ingest.OUT / f"{label}-calibration.json"
    if not source.exists():
        print(f"QC FAIL: {source.name} does not exist; nothing to audit against")
        return 1
    data = json.loads(source.read_text())
    evaluations = data.get("evaluations", [])
    if not evaluations:
        print("QC FAIL: the calibration JSON carries no evaluations")
        return 1

    runs = client.search_runs(
        [experiment.experiment_id],
        filter_string=f"tags.kind = 'calibration' and tags.label = '{label}'",
    )
    if len(runs) != 1:
        print(
            f"QC FAIL: {len(runs)} calibration runs for {label!r}; expected exactly 1"
        )
        return 1
    run = runs[0]

    traces = client.search_traces(
        [experiment.experiment_id],
        filter_string=f"tags.label = '{label}'",
        max_results=5000,
    )
    failures: list[str] = []

    # One trace per evaluation. Counted, not sampled.
    if len(traces) != len(evaluations):
        failures.append(
            f"traces: {len(traces)} in store, {len(evaluations)} evaluations"
        )

    expected_turns = sum(len(e.get("timeline") or []) for e in evaluations)
    expected_events = sum(len(e.get("log") or []) for e in evaluations)
    turn_spans = 0
    root_events = 0
    missing_attributes = 0
    missing_assessments = 0
    predicted_count = sum(
        1 for e in evaluations if e.get("predictedLosses") is not None
    )

    for trace in traces:
        spans = trace.data.spans
        if not spans:
            failures.append(f"trace {trace.info.trace_id}: no spans at all")
            continue
        root = spans[0]
        turn_spans += sum(1 for s in spans if s.name.startswith("turn "))
        root_events += len(root.events)
        if any(a not in root.attributes for a in REQUIRED_ROOT_ATTRIBUTES):
            missing_attributes += 1
        assessments = getattr(trace.info, "assessments", None) or []
        names = {a.name for a in assessments}
        if root.attributes.get("predicted_losses") is not None and not (
            {"predicted_losses", "actual_losses", "verdict_held"} <= names
        ):
            missing_assessments += 1

    if turn_spans != expected_turns:
        failures.append(
            f"turn spans: {turn_spans} in store, {expected_turns} timeline entries"
        )
    if root_events != expected_events:
        failures.append(
            f"events: {root_events} in store, {expected_events} transcript lines"
        )
    if missing_attributes:
        failures.append(f"{missing_attributes} roots missing reviewer attributes")
    if missing_assessments:
        failures.append(
            f"{missing_assessments} of {predicted_count} predicted fights lack their "
            "expectation/feedback pair"
        )

    if failures:
        print("QC FAIL:")
        for line in failures:
            print("  - " + line)
        return 1

    client.log_batch(
        run.info.run_id,
        metrics=[
            mlflow.entities.Metric("qc_traces", float(len(traces)), 0, 0),
            mlflow.entities.Metric("qc_turn_spans", float(turn_spans), 0, 0),
            mlflow.entities.Metric("qc_events", float(root_events), 0, 0),
            mlflow.entities.Metric("qc_assessed", float(predicted_count), 0, 0),
            mlflow.entities.Metric("qc_pass", 1.0, 0, 0),
        ],
    )
    client.set_tag(run.info.run_id, "qc", "PASS")
    print(
        f"QC PASS: {len(traces)} traces, {turn_spans} turn spans, "
        f"{root_events} events, {predicted_count} assessed — all match the source"
    )
    return 0


if __name__ == "__main__":
    sys.exit(audit(sys.argv[1] if len(sys.argv) > 1 else "post-perf"))
