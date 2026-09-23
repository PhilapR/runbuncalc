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
