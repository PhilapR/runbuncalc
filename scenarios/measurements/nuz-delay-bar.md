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

## Verdict, 2026-09-23: passes the bar

Treatment nuzd0923 at aaa26bb2, all 12 runs audit-valid.

```
104770 17 -> 21 +4 
209499 17 -> 19 +2 
314228 19 -> 24 +5 
418957 17 -> 20 +3 
511001 8 -> 8 0 
523658 24 -> 25 +1 
600007 17 -> 18 +1 
700019 26 -> 26 0 
731001 23 -> 20 -3 
812345 26 -> 26 0 
842113 24 -> 26 +2 
901234 17 -> 21 +4 
better 8 worse 1 tie 3 | one-sided sign test over non-tied p = 0.0195
median 18 -> 21 | bodies lost per fight won 0.74 -> 0.70
```

No run lost a body at Gavi. Gavi was fought only when it scouted 7/8 or 8/8 (cap 21), and every such
fight was won; runs where it never scouted safe walked on without it. The walls after: Sailor Brenden
and the Dewford gym (Battle Girls, Black Belts, Brawly); nearly every body now dies in a won fight.
