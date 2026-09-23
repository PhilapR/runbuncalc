# Spending the spare before the body the road needs, in every searched fight: the bar, declared 2026-09-23 before the arm ran

Control: the delay-until configuration at aaa26bb2 on 24 seeds, nuzd0923 and
nuzd0923b (seeds in nuz-costly-bar.md). Spec: rehearsal spec, nuzlocke=1,
search-first=1, plan-first=1, delay-until=0.75.

Treatment: nuzv0923 and nuzv0923b at abfcb3c1, the same spec and seeds plus
search-value=1: in every searched kept attempt a won playout counts each
survivor as 1 plus its current value to the next 10 fights (bodyValues,
value-weights current=1), so the search trades the spare before the answer.
It is independent of plan-when-costly (nuzc0923), which runs against the same
control; if both pass, their combination is its own arm.

Scored by scripts/nuz-compare.js nuzd0923,nuzd0923b nuzv0923,nuzv0923b.
Primary: better on more seeds than worse, one-sided sign test p < 0.05 over the
non-tied seeds (a failed audit voids its seed).
Secondary, also required: bodies lost per fight won not higher than the control's.

## Verdict, 2026-09-23: does not pass; worse than the control

```
paired 24: better 5, worse 15, tied 4 | one-sided sign test over the non-tied p = 0.9941  does not pass the primary
median fights won 21 -> 19.5 | bodies lost per fight won 0.71 -> 0.74
```

Weighing survivors by current value made the runs shorter (5 better, 15 worse) and costlier per win.
The likeliest reading: a search told to keep the valued bodies spends the others to do it, and the
others are also the box. Current value (answers to the next 10 fights, projected at the cap) may also
name the wrong bodies. The knob stays off.
