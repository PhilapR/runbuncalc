# ROM AI probes — 85 positions, the real trainer AI's choice over 20 seeds each

Ground truth for `scripts/replay-ai-probes.js` and `tests/ai-probes.test.js`.

## Provenance

| | |
| --- | --- |
| Origin | `PhilapR/pokemon-mono`, `groundtruth/pykemon/traces/emu/probes/` |
| Commit | `14a0515d0ed4cc83e8101827ed4c739ed1619f21` (2026-09-18) |
| Captured by | `groundtruth/pykemon` — an instrumented emulator that injects both parties into the running Run & Bun ROM and reads the AI's live score array out of RAM (`0x02000360`, u8[4], based at 100; chosen slot `0x02000391`) |
| Method | `groundtruth/pykemon/SPIKE-GROUND-TRUTH.md`, phases 3–5 and "HELD-OUT PROBES" |
| Provenance tag | `emulator-observed` (see `profiles/profile.js`) |

Vendored rather than referenced, for the reason the damage corpus beside it is:
the gate has to run on a clone of this repository alone.

Copied byte-for-byte with `git show 14a0515:<path>`. Do not edit. Regrading a
probe to make a gate green is the one thing that would make it worthless.

## Two cohorts — keep them apart

- **reference** (73 files): the phase-3/4 Breloom-vs-Combusken probes (`p*`,
  `k1`–`k3`), the 52 phase-5 matchup probes, and the 8 drag probes (`d1`–`d8`
  with Roar, Whirlwind, Dragon Tail, Circle Throw). rab's scoring was FITTED to
  the phase-5 set (pokemon-mono `cddeb25..cea2416`, `286a45d`), so for rab these
  are training data.
- **heldout** (12 files, `h1`–`h12`, `"seed_cohort": "heldout"`): 24 species no
  other probe uses, a disjoint seed cohort, one phase-5 rule each (commit
  `3618edd`). rab's out-of-sample numbers come from these.

`p6-slot1-artifact-check` is not an AI decision: under the single-turn protocol
it executed slot 1 of the patched moveset, which May's real mon had pre-chosen
before injection (SPIKE-GROUND-TRUTH.md, phase 3 §1). The replay names it as
excluded; rab's bench excludes it for the same reason.

`d1-drain-at-low-hp` and `d1-roar-no-bench` share a prefix and both sit in the
`d` family; they are different probes.

```
42ee3a4eab62ce65ca479d40b54f6f92c5d5d9fa677a8a4dd407e1b1ebb51f43  c1-high-crit-super-effective.json
44bfd61c8a390e2f93d4fe21292a9287d72ff6d2af2a84d419a5fa927228da72  c2-high-crit-neutral.json
061fc892a453d75d7655e8eabc916d0290a22a4ea59dfed5e8595a71ab23ddae  c3-high-crit-se-not-highest.json
ed142f11311aca61cb28f707cf86642290c440793576227ce587d8337c1cb2ae  d1-drain-at-low-hp.json
089955f303062dc971d9f6ebe4d00a4580782caef7fea9c2772ea125dede65a6  d1-roar-no-bench.json
b5f78c81e3f6da69a66fa6ec31083a614e62a56de3922df6a63d097f5930483b  d2-whirlwind-no-bench.json
cba4568ef4dec39d4f69446e8fd499ea836d488fb75f5520b2ccb0a0be673791  d3-roar-with-bench.json
d56e81f20dcf5c03ab286eaaccaedd384fe2eef67823ba4f09d7d6544e8c750b  d4-whirlwind-with-bench.json
c154d2e2eb08c7324a58f33347bbeefa9feae501eee878f100681a77a2b113a7  d5-dragon-tail-no-bench.json
99d82ab003606d72fd9e9f02c322a7260e4149900db2f81446bdd15a6512902b  d6-circle-throw-no-bench.json
18162cef2478370bebd2eb6e9ed9b9a00123a63d958d2b2f0760e5caf621844a  d7-dragon-tail-with-bench.json
30e71b6200999e8b4536929189bf53f6f24c03a72c45619bd7204f4bdc759f58  d8-circle-throw-with-bench.json
2c7e7f421eea6763a642910081b6a2fb451663bd159c65e74c5c33fcb6522f85  h1-twave-vs-ground-heldout.json
edc00e3ac5b0bfe6e06153755128576e38895c7635111f808143286760b6bfdd  h10-dragon-dance-slower-2hko-heldout.json
5aec70cf5375286a5f6a4967fc4b11ee2ab4a13cdd9b0bcb4f4bf3c51bca917a  h11-priority-kill-slower-aqua-jet-heldout.json
9b71461c5c6c5c89fd0cf63f7e88ceb29e160e2d7810a830e42e2165e0da2778  h12-priority-kill-slower-bullet-punch-heldout.json
6575cc24067927f6610136da2e964eaf86a1d175138910e2e4ee4b41cc34ca90  h2-sleep-blocked-insomnia-heldout.json
672a32643bcec5dbc73afe46274701bc6a842c3f156c0857870436c965a1917b  h3-toxic-vs-poison-type-heldout.json
48b63914815c1b49c994af5d5aab77969bd6199f39cccfb0272420adc2620b54  h4-immune-attack-beside-damage-heldout.json
1857cceee893d1597a0f0ca9020f28cf830ba720e5816fbe4900bf697c48669b  h5-all-attacks-immune-heldout.json
8b2eff3c34804d54a5b2edf9958a72585b297f67c6d30ec7e7dae3aa4d6bf5af  h6-celebrate-beside-usable-heldout.json
05c110cb4c57e1bd791533ec6d99004b505a591331c8c6157e381b6d4a404b27  h7-recover-full-hp-heldout.json
4c5324fb3bf85cc523508905b4f0dfede89b9ab83e8153c944dddad0dfa93280  h8-recover-low-hp-slower-heldout.json
1c95f962d05a418bf077803e63bac68cb8f6ff4d5a37d8c0277df75640b935b4  h9-swords-dance-faster-heldout.json
cb7cfdc775cb67c3ec4902ef0173ca63d5992c47d4d33bc82c6fd5e64063c0bb  i1-ground-vs-flying.json
3ccadde5625ce975a7491a54a2fd9b5c4049b7268df6911b90dadc059591bc38  i2-normal-fighting-vs-ghost.json
9db55a077c51138c156552b3ec73f5584bce62be8a1f739fe13c441c928b0d41  i3-electric-vs-ground.json
b3f09a10c24435912d6a035a35a050a2db80dedfed04e27d48699e58e40119bb  i4-psychic-vs-dark.json
3260e83ec24864bf90301ab0d1d1e1d5a6e9f6cdeea8806671d2d92b3c4ed501  i5-all-immune-splash-wins.json
d8943feec29c4b1ee54ac9f2f0f94c9eb598429ad714603ad6ca5e63fab9a5a1  k1-both-kill-fast.json
143cf6e39a084a107409ae38e0a598b292cc2333018b7c2a0ee46e956de473ea  k10-doomed-slower-priority-is-highest.json
9c16ce2c839e226d57be1fcbc2f7d10a5a7beae7d108d1d6f45af57eb261196a  k1b-both-kill-slow.json
19b7e5544c9bf9ac0aac6c3e90eb952ad29a1eb1245bd29209f011957672a8fb  k2-only-strong-kills.json
d8b16307f039af5e2e1266169155ddb54e28a40bdc62c496e70cade1b0f99157  k3-only-weak-move-kills.json
b2db1459f9df0ddbc35f85ad7dd41ed5236aa09e50a8a1600c1bfd1ffc6e598a  k4-fast-kill-both-special.json
f163b585334cef34648a437e511abde47006082c7b7ee558245fe1e424dcdaa5  k5-slow-kill-only-strong.json
cb4feef2a02f8e1afe19a2b3be49cc595b37c6b3f2e0fdc50ce8788d84fe6ca0  k6-priority-kill-when-slower.json
26d6e9848afb0eb98ffa5a5c689a6f2060bd605f5b1e3f6aa481775cf71a7bf2  k7-slow-kill-beats-non-kill-priority.json
b233b72a5848fd2da7160e4233afd99f5b0533fc54cd5aa86e36bee9052b33de  k8-speed-tie-kill.json
d270c99fe585c34034972f4745b0db40435c0915c9f0a260c2a886805f757bfa  k9-doomed-slower-bullet-punch.json
16a945b1ca6559e194392c9b96756bdc075c573737628277239e6982789c4b99  m1-bullet-seed-2p5-hits.json
22a508432566d3d50da5d519e0c20cc7dbf50ec175e55c78ea1cd7838c42239d  m2-pin-missile-3p6-hits.json
4038955494e74d45ee754ac2bc1728bc978b54bd120521e725a7e0f503334aca  m3-double-kick-two-strikes.json
7f7397de667d0c2f6b71e9e8d521bd6311b27ab57b603c6c8da09a717462e5a5  p0-baseline.json
4b2e64e647e7e8bd69e52508adef5fa10399a0cd9cd242678607f1b0e3f3a621  p1-no-doom.json
31267b01b0309c2c7b0b494f7663d68bc6a23d3823e767deb1fb6d37f7e50ec1  p2-move-shuffle.json
df8dcedb5309202c384b28bd0857a5ad909ef288666d1994ce42577de7d8554a  p3-ai-slower-doomed.json
695a7eb65df98f0f010b2465a6e865307d25b2c0eac326107d1856ae9c7dc199  p3b-ai-slower-no-doom.json
7060c444e6a33c357388fe1db85ca0e93a220e819d5d216fe4c4a579d9520948  p4-no-priority.json
ef7b5e59003120a3ec3640a05734fce8e0140ab6bdb08033470a902017a7544c  p4b-slower-doomed-no-priority.json
28acb898debf38798257393777f5f7f2a53f2c884cdf702a5cd2f738ff2a8415  p5-status-vs-weak-attacks.json
592aaba1e3d8a76fb97ec341b935c8b53a61a9ecfbfa168862e7711c2e2d21d3  p6-slot1-artifact-check.json
0a16deda5d376595fb0a4c2468f2b8291793ccc56aa826a9e379b35b3dce59d9  r1-recover-full-hp.json
07bddb87393b51f20caf58e304d4e8fa665152cabe7a1d706f23bba6bfa11367  r2-recover-90pct.json
f9f27e5fa81ae315e8f4698bbd33ad53e2edac84e6f384c8c9cc6e252f476b04  r3-recover-low-slower.json
184f03eebe016637cc29d7f92dbee98109d19d4f45e996d762b69f7a4264a3b4  r4-recover-low-faster.json
af39cd36fe4318359e92e49127790991b5b6a9efbc045d0d6896fb987d6076ed  r5-roost-mid-faster.json
05f57a74551ff4c2b86ac790f5110751e94484a0a53cff1ef98452b5ceb02531  rc1-recoil-highest.json
7133dbe8eb6cc49a7ff0284b08a8699d014c229a9410296c95fcb7d28e90e168  rc2-recoil-at-low-hp.json
d8de725b027a22b0e71faa4ce1832eebb8aee5cc6e15afa2b6131069c5950de2  s1-sleep-vs-highest-attack.json
3e91c1f6001ba67f6dcb9c0c9962ef1e06134542aecbfe880583d8df80e333a1  s10-toxic-neutral.json
90d8d2cf51af880f4c1363e5c2411bd3542b8321ee37ebb745eed34b1981f15f  s11-toxic-vs-steel.json
835a5cc10f5bd3c94dd821e899b9e455f025b6107326be56b971026095a3189f  s12-celebrate-hold-hands.json
1b8f145127320cd400f8d1d6344789d5eeff5567af0301873bc2c4d63406804c  s2-sleep-blocked-insomnia.json
a9043b1b6c9597864a7ecb3e917b31da8668311cf3c7f29d21b6edc39b6782ab  s3-sleep-powder-vs-grass.json
7258b209690b0f9bcadb86bbf5b77434c9b65e956c277c84d25db0a856881711  s4-twave-quarter-speed-flip.json
902745f1e07dfc8bcb11dc7024305076bd2c62a40407c2d2f77ad29901cc8aaa  s5-twave-already-faster.json
eb433fb61b89a242a0529980f2328f633496e9b643f6163a7fe6cdd8825d0a9a  s6-twave-flip-both-rules.json
4401a6ce030347b2bd8a4e6877191d798d9355bb10b83ab3d322ba40ca339e35  s7-twave-vs-ground.json
bb987d57e66a6aed27cc18825224b66638afd21536a60580619f9835bc9ad9bd  s8-wisp-physical-target.json
eab21c5abcbd816d056eb6f7f468643d42437512c504da47241ee132da6dc210  s9-wisp-special-target.json
99db35e9a99b389206a0835e2a5880b5689bee1804b63aa44596c744c19ddee4  t1-se-low-bp-beats-neutral-high-bp.json
b06259483f5e9c026bc1e53d76313299cf6272d9d9da59e97aa3896cf9274a79  t2-neutral-stab-beats-se-low-bp.json
83605b0f11d43e292a90e00cc10fdf68647341fe5ed5c4f7ac394e4f8513580e  t3-4x-weak-stab-beats-strong-neutral.json
1f85769c76088242be250440b3214078e980ee0ad02ec3abc6e697161272aa08  t4-double-resisted-stab-loses.json
551b3762a95d7d7e2e116f0523c285b5a78b566b19552ae4bd25d1166e82bb67  tie1-identical-moves.json
31de90c6ddaed1a4269f64d3fb2d622d58b4eb02692ebd19022b347010d5858d  tie2-three-way-cross-category.json
0d5bf59c35f7a89d5988aa2c154b57f7127314a216d9daf7084bcafc8a0748de  tie3-overlapping-rolls.json
33dbdebd150c3b5249e023ca44c30ff6356bc33ef5e9f3065c73891e46393925  u1-swords-dance-safe.json
4d0b92a4816043922039adda94c6589d5ed53261c76eb5ed996cfca0a3048662  u2-swords-dance-doomed.json
e439eec56e16bb2c31ab4dccffe3caef4909c1a5476b8e4956162c1d2b913668  u3-dragon-dance-slower-2hko.json
e186c5e6a1c1715eaac3b9fe407d0f4085e49ab5c4b38ef2e8895eae8a7ebdf2  u4-dragon-dance-faster-2hko.json
8aabfb292362604d355a58f1fb5d9846951038b4219d8c4c4dc856704482aae0  u5-agility-slower.json
a80b7cecbe302eb3d7ba2c38dfdade15d73058085a6261db741c0108ac416c8a  u6-agility-faster.json
7021a4d29ba6ee36bdefe22c1ffbad1d94a467c0cf9296fcd55fa5fff34e1d4d  u7-nasty-plot-faster-safe.json
```

## What is in each file

| Field | |
| --- | --- |
| `player`, `enemy` | `species` (national dex), `level`, `moves` (names), the exact injected `stats`, `ability` (id: 50 Run Away, 15 Insomnia, 27 Effect Spore, 66 Blaze), `types` (probe_suite.py `TYPE` ids; absent on the phase-3/4 fixtures), `hp_now` when current HP was set below max |
| `player_bench` | d3/d4/d7/d8 only: the teammate a drag move can pull in |
| `distribution` | The enemy's executed move over the resolved rows. This is the label |
| `rows[].ai_scores` | Per moveset slot, the AI's score for that move in that seed (score-bearing probes only; `p1`, `p2`, `p3b`, `p4`, `p4b`, `p6` have none) |
| `score_distributions` | The distinct score values per move over the rows |
| `seed_cohort` | `heldout` for h1–h12; `reference` or absent otherwise |

Every row is uncontaminated and, where scores exist, the executed move held the
top score and matched the chosen-slot byte (`scores_explain_all_choices`).

## What the probes do not cover

Singles only, level 30–50, no items, no weather or terrain, no stat stages, no
status on either side at decision time, inert abilities except Insomnia. Turn 2
of the battle: nobody is on their first turn out. A gate is only as wide as its
corpus; this one says nothing about doubles, items or field effects.
