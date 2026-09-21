# insight

Reads headless run records and explains how fights were won or lost.
Strict TypeScript, ESM, [Effect](https://effect.website). It reads artifacts
and never imports the CommonJS harness, so it needs nothing migrated.

```
npm run fight-log -- --report=ui-playthrough-out/runs/LABEL/run-SEED.json   # one HTML page
npm run mcp --prefix insight                                                # the same, for an agent
npm run watch --prefix insight -- --dir=ui-playthrough-out/runs/LABEL       # WATCH a run while it plays (or preview `watch-runs`)
npm test --prefix insight
```

## What goes in

A run is two files, written by `scripts/run-one.js`:

- `run-SEED.json` — the record: the ledger (one row an attempt), the run
  document, the knobs it played.
- `run-SEED.fights.ndjson.gz` — every boss and double attempt, one a line,
  streamed as it ended (`lib/fight-log.js`). Each line is the attempt's turns:
  who faced whom at what health, the choice and why, every option the screen
  offered with its forecast or priced race, what the rollout search scored
  each candidate, and what happened — plus the six that fought.

Across runs, ask DuckDB; it reads the sidecars directly:

```
duckdb -c "COPY (SELECT runSeed, n, trainer, result, t.*
                 FROM read_ndjson('ui-playthrough-out/runs/*/*.fights.ndjson.gz'), unnest(log) u(t))
           TO 'turns.parquet' (FORMAT parquet, COMPRESSION zstd)"
```

## What is inside

| File | What it is |
|---|---|
| `src/schema.ts` | The record's shape, once, as Effect Schema. A drifted record fails here and names the field. |
| `src/tags.ts` | A turn read for the CONTROL it took: speed control, status, set-up, screens, hazards, disruption, pivots, sacks, priority, recovery, crits by side, and turns where the search played something other than the biggest forecast. Regexes over move names and event text — a vocabulary to extend, not ground truth. |
| `src/analyse.ts` | `walls` (a fight's win beside its losses) and `strategyOf` (the same, pooled over a run). Pure. |
| `src/viewer.ts` | One self-contained page. No framework, no server. Deliberately small. |
| `src/mcp.ts` | `run_strategy`, `list_walls`, `compare_attempts`, `get_attempt`, `get_turns`. Each tool's arguments are ONE Schema: published as its input schema and used to decode the call. |
| `src/cli.ts` | Loading, with every failure in the type. |
| `src/serve.ts` | A small local server and one page that polls `run-SEED.live.ndjson` — the CURRENT attempt, a line a turn the moment it is decided — and shows the fight growing, with what the search weighed for every option. Reads files; cannot steer a run. |

## What it does not do

It reads; it decides nothing, and it never plays a fight. A saved run from
before fight logs has no turns to show — `scripts/how-it-won.js` replays the
winning attempt of one of those, and refuses unless the replay reproduces the
ledger.
