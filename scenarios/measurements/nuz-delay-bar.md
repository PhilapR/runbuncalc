# Putting off Camper Gavi until it scouts safe, under permadeath: the bar, declared 2026-09-23 before the arm ran

Control: nuzf0923 at f1d81af6 (search-first=1, plan-first=1 on the rehearsal
spec with nuzlocke=1): median 18 fights won, six of twelve runs wiped at Gavi.

Treatment: nuzd0923 at aaa26bb2, the same spec and seeds plus delay-until=0.75.
aaa26bb2 adds only the delay knob (off by default) over f1d81af6.

Primary: fights won before the wipe, paired by seed, over the seeds where the
two arms differ. The treatment passes if it is better on more seeds than it is
worse, one-sided sign test p < 0.05 over the non-tied seeds.
Reported, not in the verdict: where each run wiped; how often Gavi was put
off and at which caps it scouted; bodies lost per fight won.
