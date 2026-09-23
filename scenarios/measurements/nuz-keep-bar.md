# Paying more for every body kept in a won playout, under permadeath: the bar, declared 2026-09-23 before the arm ran

Control: nuzd0923 at aaa26bb2 (rehearsal spec, nuzlocke=1, search-first=1,
plan-first=1, delay-until=0.75), whatever its own verdict.

Treatment: nuzk0923 at d964c91a, the same spec and seeds plus
search-keep-weight=0.3 (a win is worth 0.3 plus 0.7 times the share of ours
standing, against 0.5 plus 0.5). d964c91a adds only the weight knob (default
0.5, unchanged) over aaa26bb2.

Primary: fights won before the wipe, paired by seed, over the seeds where the
arms differ: better on more seeds than worse, one-sided sign test p < 0.05.
Secondary, also required: bodies lost per fight won not higher than the control's.
Reported, not in the verdict: where each run wiped; winCost.
