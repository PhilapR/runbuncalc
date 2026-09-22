# Run control

How heavy jobs are started, watched, stopped and carried on. Built 2026-09-21
after one afternoon in which six full runs, four measurement shards and two
ad-hoc probes shared eleven cores (load 34; a search fight went from about a
minute to 146 s), a `pkill -f` took the watch server down with its target, and
three `pgrep -f` waiters matched their own command lines and waited for ever.

There is no daemon. Everything is a file beside the run, or a lock file in the
slot pool, and every handle on a process is the pid that process wrote itself.

## Start

```bash
node scripts/run-batch.js --label=NAME --seeds=a,b,c --spec=budget=4000,boss-retries=40
```

Pinned clean worktree, one child per seed, each inside the slot pool. Anything
else that plays more than a few fights goes through the pool too:

```bash
node scripts/submit.js --label=what-it-is -- node path/to/script.js --its=flags
```

```bash
node scripts/submit.js --list
```

The pool is `RUNBUN_SLOTS` wide (default: cores - 2) and lives in
`~/.cache/runbuncalc/slots`, outside the repository, so worktrees at any
revision draw from the same one. A slot whose owner died is reaped.

## Watch

```bash
node scripts/runs.js list
```

or the watch page (`watch-runs` in `.claude/launch.json`, port 4173): every run
with its state, pace, memory and knobs, the slot pool and the load, and the
fight each is in. Agents have the same through the insight MCP server
(`list_live_runs`).

States: `running`, `paused`, `stopping`, `stopped` (asked to), `ended` (a wall
or the budget), `finished` (the road), `dead` (says running, process gone).

## Stop, pause, kill

```bash
node scripts/runs.js stop LABEL/run-SEED
```

| verb | what happens | what is lost |
|---|---|---|
| `stop` | the run reads the request between fights, checkpoints, exits 0 | nothing; waits out the fight in progress (a search fight is a minute or more) |
| `pause` / `cont` | SIGSTOP / SIGCONT, at once | nothing; a paused run keeps its slot and its memory |
| `kill` | SIGTERM | at most 20 s of play since the last checkpoint |

The page has stop, pause and continue; the MCP server has `control_run`.

## Carry on

```bash
node scripts/runs.js carry-on LABEL/run-SEED --spec=hand-by-probe=1,budget=4000
```

Takes the run up from `run-SEED.checkpoint.json`, in a pinned worktree, inside
the pool. The checkpoint is the document AND the run's own state (the dice's
position, the fight seed, the attempts at the wall in front of it, what was
caught where, the ledger so far), so a carried-on run plays what it would have
played: one ledger, one fight log (cut back to the checkpoint, never doubled),
`restoredAt` on the row. Without `--spec` it keeps its knobs; with one, it
plays on under the new ones — a run stuck at a wall can be given another hand.

This is not `--resume=RUN.json`, which starts from a document alone and
restarts all of that state.

## Falsify a guard without touching the tree

```bash
node scripts/falsify.js --file=lib/run.js --test=tests/run.test.js --name="the Elite Four is four members" --from="return named[2] ? state.doublesSpent : state.singlesSpent;" --to="return false;"
```

A gate nobody has watched fail is not a gate, so every guard here is broken
once on purpose and restored. Do that IN the working tree and you hand broken
code to anything that loads this repository live — the rab-workspace companion
spawns planner and advice children from the checked-out tree, and a child
spawned inside one of those windows plays a race that never wins or a plan
that never holds, on a receipt naming a revision that looks clean. Twelve such
windows were opened in one session before a peer noticed (2026-09-22).

So the mutation happens in a detached worktree at HEAD and the live tree is
never touched. Four outcomes, four exit codes, because a script that cannot
tell them apart will read the wrong one as success:

| | | |
|---|---|---|
| **FALSIFIED** | 0 | an assertion failed. The guard tests what you think. |
| **HOLLOW** | 1 | it passed with the source mutated. The guard does not. |
| **BROKEN** | 2 | the mutation stopped the file loading, so every test failed and the guard was never asked. |
| **DRIFTED** | 3 | `--from` no longer matches, so nothing was mutated at all. |

The last two flatter you: both look like a result and neither is one. The
first cut of this tool called BROKEN a pass (`--to=x` reported success), and
DRIFTED threw, which exits 1 — the same code as HOLLOW, so a script could not
tell a hollow guard from a stale pattern. pokemon-mono's `just falsify` made
the same split in fb5ab8d, and that session raised the fourth case here.

HOLLOW has caught real ones: a checkpoint gate that ignored the dice position,
and a Mega gate where party order and board order happened to agree.

## What is not here

- No queue priorities and no pre-emption: first come, first served, and a
  pause button.
- The row records the revision of the LAST leg only. Legs played at different
  revisions are not yet listed on it.
- The contention bar (seconds per search fight under a full pool within 15% of
  a solo run) has not been measured: it needs a machine with nothing running
  outside the pool.
