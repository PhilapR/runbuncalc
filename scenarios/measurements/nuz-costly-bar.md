# Planning the fights that cost bodies, for the bodies worth most: the bar, declared 2026-09-23 before the arm ran

Control: the delay-until configuration at aaa26bb2 on 24 seeds: nuzd0923
(418957, 209499, 842113, 104770, 314228, 731001, 511001, 523658, 600007,
700019, 812345, 901234) and nuzd0923b (130001, 230002, 330003, 430004,
530005, 630006, 730007, 830008, 930009, 140010, 240011, 340012). Spec:
rehearsal spec, nuzlocke=1, search-first=1, plan-first=1, delay-until=0.75.

Treatment: nuzc0923 and nuzc0923b at 79b04230, the same spec and seeds plus
plan-when-costly=0.5 (a non-boss singles fight is planned when its eight
scouts lose half a body or more on average, a lost scout counting the six),
plan-keep=1 (plans chosen for bodies kept) and plan-value=1 with the default
value-weights (current=1: a survivor counts one plus its current value).
79b04230 adds, over aaa26bb2, only knobs that are off by default, the plan
record's kept and valued fields, and the tests' own slot pool.

Primary: fights won before the wipe, paired by seed over the 24, over the
seeds where the arms differ: better on more seeds than worse, one-sided sign
test p < 0.05.
Secondary, also required: bodies lost per fight won not higher than the control's.
Reported, not in the verdict: fights scouted and planned per run; where each
run wiped; wall time.
