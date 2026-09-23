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

## Verdict, 2026-09-23: does not pass the bar

```
104770  21 -> 20  -1
130001  23 -> 26  +3
140010  31 -> 24  -7
209499  19 -> 22  +3
230002  26 -> 26  0
240011  15 -> 31  +16
314228  24 -> 17  -7
330003  7 -> 18  +11
340012  26 -> 26  0
418957  20 -> 26  +6
430004  8 -> 26  +18
511001  8 -> 26  +18
523658  25 -> 24  -1
530005  17 -> 8  -9
600007  18 -> 19  +1
630006  14 -> 11  -3
700019  26 -> 32  +6
730007  18 -> 26  +8
731001  20 -> 18  -2
812345  26 -> 26  0
830008  24 -> 23  -1
842113  26 -> 26  0
901234  21 -> 18  -3
930009  21 -> 15  -6
paired 24: better 10, worse 10, tied 4 | one-sided sign test over the non-tied p = 0.5881  does not pass the primary
median fights won 21 -> 24 | bodies lost per fight won 0.71 -> 0.66
```

The gains were large where they came (8->26 twice, 7->18, 15->31) and the losses moderate, but the
sign test counts seeds, not fights, and it is 10 against 10. Many runs in both arms stop at exactly
26 fights: Leader Brawly, where 17 runs arrived, probes and plans found no six that wins even a
scouting fight (0/12, 0/13), and the 3 that won lost 4-5 bodies. Brawly is a box wall (docs/LEADER-KEYS.md:
Hitmonchan, Vespiquen, Gligar, Salandit, Kadabra, Yanma), not a planning one. At Sailor Brenden the
arm did what it was built for (planned, won first time losing 0-1), which the seed count cannot show.
