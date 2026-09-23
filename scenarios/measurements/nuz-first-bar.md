# The strong hand on the first attempt, under permadeath: the bar, declared 2026-09-23 before the arm ran

Control: nuz0923 at df1bd2ee (12 seeds, already played): the rehearsal spec
(budget=4000, boss-retries=40, retries=40, double-retries=40, scale-ivs=1,
search-after=2, search-rollouts=8, repick-after=3, plan-after=5) with nuzlocke=1.
Median 13.5 fights won before every body was lost (range 8-17); 147 bodies lost.

Treatment: nuzf0923 at f1d81af6, the same spec and seeds plus search-first=1,
plan-first=1. (The revisions differ: f1d81af6 adds only the two knobs, off by
default, and the one-definition preparation shape; no plan ran in any control
run, so the shape change cannot have moved a control fight.)

Primary: fights won before the wipe, paired by seed. The treatment passes if it
wins more fights on at least 10 of the 12 seeds (one-sided sign test p < 0.02),
ties counted against it.
Reported, not in the verdict: bodies lost per fight won; winCost; where each
run wiped; wall time.
