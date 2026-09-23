# --plan-items on the frontier set: the bar, declared 2026-09-23 before any arm ran

Recorded here after the fact: it was written to the session scratchpad at
2026-09-23T01:49Z, before either launch, and restored verbatim from the
session transcript when the scratchpad was cleared. The amendments follow in
the order they were made.

Arms (revision 3feed03, PP real, frontier singles only, 64 scenarios x 10 seeds, paired seeds):
- fpi-ctl:   --plan-by-play=1 --plan-seeds=4 --format=singles --pp-model=1
- fpi-items: the same plus --plan-items=1

Primary: net discordant seeds > 0 and McNemar p < 0.05.
Veto: any scenario net -5 or worse.
Clustering: the net keeps its sign with the largest-contributing trainer removed.
Gate: itemsHeld > 0 in the treatment (else inert, no verdict).
Reported, not in the verdict: the late subset (run-map order > 342); which items were taken.
Scope stated: doubles excluded (planning a double scouts doubles, the slowest fights);
plan seeds 4 against a run's 12 (cost), so plans are noisier than a run's in both arms.


Amended 2026-09-22 22:20 EDT, before any arm played a fight (the first launch died with its session,
unstarted): both arms add --pick-by-play=0. planByPlay chooses the six in both arms, so pick-by-play's
36 scouting fights per scenario were cost with no role. The bar is unchanged.

VOID 2026-09-22 22:25 EDT: the arms at 3feed03 ran with a planner whose every scouting fight threw
(battery main() ran before its exports; fixed in 94af7fb). planned=64 but no plan could move a body;
itemsHeld 0 of 64. Not scored. Rerun at 94af7fb with the same flags and the same bar.

## Verdict, 2026-09-23: does not pass the bar

Arms at 94af7fb, receipts scenarios/receipts/fpi-{ctl,items}-s{0,1,2}.json, scored by
scenarios/measurements/fpi-score.js (written 2026-09-23T01:50Z, before any arm ran; restored
verbatim from the session transcript). Its output:

```
wins 172/640 -> 174/640   gained 3, lost 1, net 2, McNemar p=6.25e-1
gate: itemsHeld in 4 of 64 scenarios
veto (net <= -5): none
largest contributor Team Aqua Grunt Seafloor Cavern #2 (2); net without it 0 (SIGN DOES NOT HOLD)
VERDICT: does not pass the bar

reported, not in the verdict:
  late (order > 342): net 2 over 47 scenarios
  items taken: {"Focus Sash":1,"Choice Band":1,"Lopunnite":1,"Ground Gem":1}
  +2  Team Aqua Grunt Seafloor Cavern #2 @1225 [clear1/run-418957]  0/10 -> 2/10
```

Notes:
- The treatment fired in 4 of 64 scenarios: the planner proposed items in 17 and took them in 4.
  One of the 4 (Lopunny@Lopunnite) is a body change, not an item move: the counter counts a new
  body holding its own item. The knob stays off.
- fpi-items-s0 was refused by the battery for 2 engine refusals at Archie (seeds 2, 7): a sound
  move queued before Throat Chop landed. Fixed in d7f1f0cc; replayed on the fixed engine with the
  arm's flags, seeds 1-7 play with 0 refusals and the same plan and results (all losses), so the
  verdict does not move. The wider class is ledger row mid-turn-volatile-refusals.
- fpi-items-s1 was refused as inert on its own shard (itemsHeld 0 there); the gate in this bar is
  on the pooled treatment.
