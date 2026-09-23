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

## Verdict, 2026-09-23: does not pass the bar

Treatment nuzk0923 at d964c91a, all runs audit-valid.

```
104770 21 -> 21 0 
209499 19 -> 20 +1 
314228 24 -> 26 +2 
418957 20 -> 15 -5 
511001 8 -> 20 +12 
523658 25 -> 26 +1 
600007 18 -> 26 +8 
700019 26 -> 36 +10 
731001 20 -> 7 -13 
812345 26 -> 17 -9 
842113 26 -> 21 -5 
901234 21 -> 26 +5 
better 7 worse 4 tie 1 | one-sided sign test over non-tied p = 0.2744
median 21 -> 21 | bodies lost per fight won 0.70 -> 0.68

```

The knob stays at 0.5. The per-seed swings are large both ways (+12, +10, -13, -9): a small change
sends a permadeath run down a different road, so twelve seeds detect only large effects. Later arms
should use more seeds. Seed 700019 reached 36 fights won, the deepest permadeath run so far.
