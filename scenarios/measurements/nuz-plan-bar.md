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
