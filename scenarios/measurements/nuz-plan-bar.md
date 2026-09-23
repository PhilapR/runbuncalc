# Planning for permadeath: plan unsafe fights, choose plans for bodies kept. The bar, declared 2026-09-23 before the arm ran

Control: nuzd0923 at aaa26bb2 (rehearsal spec, nuzlocke=1, search-first=1,
plan-first=1, delay-until=0.75), whatever its own verdict.

Treatment: nuzp0923 at a720e0fd, the same spec and seeds plus
plan-when-unsafe=0.75 (every non-boss singles fight is scouted with eight
decide() fights and planned by play when fewer than six win) and plan-keep=1
(every plan, bosses included, is chosen for our bodies kept per scouting fight,
then wins). a720e0fd adds only those knobs (off by default), the keep-weight
knob (default unchanged) and the plan record's kept field over aaa26bb2.

Primary: fights won before the wipe, paired by seed, over the seeds where the
arms differ: better on more seeds than worse, one-sided sign test p < 0.05.
Secondary, also required: bodies lost per fight won not higher than the control's.
Reported, not in the verdict: how many fights were scouted and planned; where
each run wiped; wall time (planning every unsafe fight costs time).

## Verdict, 2026-09-23: does not pass the bar

Treatment nuzp0923 at a720e0fd, all runs audit-valid.

```
104770 21 -> 24 +3 
209499 19 -> 18 -1 
314228 24 -> 24 0 
418957 20 -> 21 +1 
511001 8 -> 8 0 
523658 25 -> 25 0 
600007 18 -> 18 0 
700019 26 -> 26 0 
731001 20 -> 20 0 
812345 26 -> 26 0 
842113 26 -> 26 0 
901234 21 -> 24 +3 
better 3 worse 1 tie 8 | one-sided sign test over non-tied p = 0.3125
median 21 -> 24 | bodies lost per fight won 0.70 -> 0.68

```

Nearly inert: every non-boss fight was scouted, but only 0-2 a run won fewer than six scouts in
eight, so plans rarely ran. The criterion asked whether a fight is LOST; under permadeath the cost is
in fights that are won (three quarters of the deaths). Followed by --plan-when-costly (79b04230).
