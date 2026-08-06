# Run & Bun / runbuncalc — Detailed Plan

**Canonical planning doc** for what to do next. Product surfaces and phase
status live in [`RUNBUN_UX.md`](RUNBUN_UX.md). UI shell / visual system specs
live in [`RUNBUN_UI_DESIGN.md`](RUNBUN_UI_DESIGN.md). Engine contracts live in
[`AGENTS.md`](AGENTS.md), [`AI_DATA_MODEL.md`](AI_DATA_MODEL.md),
[`VALIDATION.md`](VALIDATION.md), and [`FORK_MAP.md`](FORK_MAP.md).

This file is the **ordered roadmap** and home of the **master prioritized
backlog** (§0). Prefer updating priorities here when they change; keep layer
details in `RUNBUN_UX.md` and screen specs in `RUNBUN_UI_DESIGN.md` rather than
duplicating full specs.

**Priority scheme (use everywhere):**

| Rank | Meaning |
| --- | --- |
| **P0** | Now / blocking product quality or the next shippable slice |
| **P1** | Next — scheduled immediately after P0 |
| **P2** | Soon — after P1 lands or its deps clear |
| **P3** | Later — valuable but not near-term |
| **Park** | Explicitly deferred; reopen only under the stated trigger |

Do not mix MoSCoW into these docs. Engine completeness detail stays in
[`VALIDATION.md`](VALIDATION.md); every open row there must carry the same
P0–P3 / Park rank and an ID that appears (or rolls up) in §0.

---

## 0. Master prioritized backlog

Sorted **P0 → P1 → P2 → P3 → Park**. IDs are stable cross-doc references.
Shipped MVP items are in §4 (not listed again). There is **no open engine P0**.

| Priority | ID | Item | Area | Depends on | Done-when |
| --- | --- | --- | --- | --- | --- |
| P0 | HYG-01 | ~~Keep root floor green (`npm test`, UI smoke on panel touches, Policy B notes when overlays change)~~ **Ongoing** — ESLint Promise/globals + Invalid Action prefix fixed this session; keep green before merge | docs | — | Root gate green; smoke regressions caught before merge |
| P0 | FIX-01 | ~~Inventory 8–12 AI fixtures as named UI scenarios~~ **Done** (`fixtures/ui/`) | docs | HYG-01 | Curated list of scenario IDs/names ready for browser load |
| P0 | FIX-02 | ~~Fixture browser MVP: list/dropdown → load into AI Debug → validate~~ **Done** | UI | FIX-01 | Author opens a named scenario, validates, evaluates without hand-pasting JSON |
| P0 | UI-V0 | ~~Link `runbun-tokens.css`; CSS variables on `:root` / theme (no calc-guts rewrite)~~ **Done** | UI | — | Tokens wired; light/dark pairs usable by shell/panels |
| P1 | FIX-03 | ~~Golden eval snapshot format + regenerate one golden + clear fail message~~ **Done** (`fixtures/ui/goldens/`, `scripts/regen-ui-golden.js`) | engine | FIX-02 | Deterministic evaluate snapshot exists; regen is deliberate |
| P1 | FIX-04 | ~~Wire golden compare into AI Debug status (facts/reasons only)~~ **Done** | UI | FIX-03 | Pass/fail vs golden visible in-page or documented CLI; no `kochance` parsing |
| P1 | UI-V1 | ~~Product shell: brand row, mode tablist, context chips, hash `#calc` / `#sets-bridge` / `#ai-panel` / `#runbun-battle`~~ **Done** | UI | UI-V0 | Modes feel framed; Calc stays dense; Bridge has stable `id` |
| P1 | UI-V2 | ~~Retoken AI Debug, Sets bridge, Battle (buttons, callouts, status, action rows, HP)~~ **Done** | UI | UI-V1 | Bolted-on feel reduced; honesty chips visible |
| P1 | UI-V2b | ~~Full-page unify: calc columns/results/import share stadium tokens + shell cascade~~ **Done** | UI | UI-V2 | One product surface; density preserved (not PARK-09 rewrite) |
| P1 | TW-01 | ~~Trainer Wheel + Youngster Calvin default opponent~~ **Done** | UI | UI-V2b | Prev/next + name; party front-and-center; p2 + bridge party; Truck → Calvin |
| P1 | UI-SP-01 | ~~Spacing rhythm pass (`--rb-space-*`) across shell / calc / AI / Battle / Wheel~~ **Done** | UI | TW-01 | Uneven gaps tightened; IDs/nav preserved |
| P1 | ENG-01 | Bug-driven engine fill: scoring wrong because facts missing → facts then score | engine | Repro `BattleState` | Focused fixture; `VALIDATION.md` row closed or re-Parked |
| P1 | ENG-02 | Bug-driven calc overlay only when damage identity ≠ `MECHANICS.MD` | engine | Repro + `FORK_MAP` | `fork.test.ts` + Policy B inventory note |
| P2 | EXP-01 | ~~Deeper Explain: side-by-side doc cite vs reasons / ActionFacts~~ **Done** | UI | Explain MVP; FIX-02 strongly preferred | One scored action shows matching doc section + machine facts together |
| P2 | EXP-02 | ~~Citation map audit for top score-reason phrases~~ **Done** | docs | EXP-01 or Explain MVP | Gaps filled for high-traffic reason keywords |
| P2 | UI-V3 | ~~Battle field polish: active cards, summary chips, forced banner, mobile JSON collapse~~ **Done** (cards + chips + collapsible JSON; forced banner retained) | UI | UI-V2 | Singles viewer reads as match UI; still thin client |
| P2 | DBL-01 | ~~Doubles Battle layout sketch (display only, same HTTP)~~ **Done** | UI | Singles MVP stable; FIX-02 Doubles cases preferred | Two actives/side readable; Singles path unchanged |
| P2 | SET-01 | ~~Sets/Bridge preview polish (party IDs / species / HP) + elevated `#sets-bridge` IA~~ **Done** (standalone mode panel + party preview) | UI | UI-V1 | Bridge is a first-class mode target; empty/error states explicit |
| P2 | ACC-01 | ~~A11y pass on shell/nav/status/forced-switch (focus, live regions, contrast)~~ **Done** | UI | UI-V1 | Checklist in `RUNBUN_UI_DESIGN.md` §7 satisfied for R&B rails |
| P3 | DBL-02 | ~~Doubles target selection UX + evaluate for selected actor + smoke~~ **Done** | UI | DBL-01 | Load Doubles Gen 8 → evaluate → apply → advance via HTTP; targeting clear |
| P3 | EXP-03 | Optional quiz / “spot the score” scenarios | UI | FIX-02, EXP-01 | At least one teachable scenario using goldens/fixtures |
| P3 | RPL-01 | ~~Replay scrubber + shareable apply/advance traces~~ **Done** (`#runbun-replay`, `fixtures/ui/replays/`) | UI | FIX-04 useful; DBL optional | Saved replay reloads/steps; invalid → 400 clarity |
| P3 | UI-V4 | Later mode chrome: Explain top-level, Doubles, Replay visuals | UI | EXP-01, DBL-02, RPL-01 as each lands | Per mode done-when in UI design §9 |
| P3 | ADP-01 | Fixture batch CLI + adapter pattern docs (+ optional OpenAPI-ish freeze) | docs | Stable HTTP (shipped); real consumer | External caller can validate→evaluate→derive→apply→advance headless — **partial:** HTTP `{error,code}` + BattleState/Action prefixes frozen in `ai/README.md` / smoke |
| P3 | BAT-01 | Battle → AI Debug reverse import (“Open in AI Debug”) | UI | Battle + AI Debug MVP | Explicit hop copies validated JSON both ways |
| Park | PARK-01 | Exact PS residual / event-queue interleaving | engine | — | Reopen if external adapter needs a specific residual ordering contract |
| Park | PARK-02 | Full ability / volatile encyclopedia sweep | engine | — | Reopen on bug report with reproducible `BattleState` |
| Park | PARK-03 | Uncommon accuracy (OHKO niches, rare items) unless scoring needs them | engine | — | Else caller `hit`; reopen if R&B policy/fixture requires |
| Park | PARK-04 | Berry Juice per-hit timing | engine | — | Reopen when multi-hit sequence model expands |
| Park | PARK-05 | Map/environment Nature Power without terrain | engine | — | Documented non-goal |
| Park | PARK-06 | Fog-of-war / hidden info UI | UI | — | Only if product scope changes |
| Park | PARK-07 | Live online ladder / Showdown protocol | UI | — | Not this product |
| Park | PARK-08 | Silent upstream expectation rewrites | engine | — | Never without explicit `FORK_MAP` + fixture promotion |
| Park | PARK-09 | Full Smogon calc visual rewrite / SPA migration | UI | — | Shell frames calc; density stays upstream-like |
| Park | PARK-10 | Dedicated set builder + R&B set packs (beyond bridge) | UI | SET-01 | Reopen when bridge preview is solid and authors demand packs |

**Near-term “start here”:** FIX-01…FIX-04, UI-V0…V2b, TW-01, UI-SP-01, SET-01,
UI-V3, EXP-01, EXP-02, ACC-01, DBL-01, DBL-02, and RPL-01 are shipped. Next:
repro-backed **ENG-01/02**, or P3 EXP-03 / UI-V4 / BAT-01 / ADP-01. Full phase
write-ups: §6; session chunks: §7; UI rollout detail:
[`RUNBUN_UI_DESIGN.md`](RUNBUN_UI_DESIGN.md) §9.

---

## 1. Current status snapshot (as of this plan)

| Area | Status |
| --- | --- |
| Multi-gen damage calculator (`calc/`) + R&B overlays | **Shipped** — Gen 8 UI default; Magma Armor / 1.5× crit / Soul Dew / etc. |
| AI policy + transitions (`ai/`) | **Shipped** — decision-useful Gen 8 scope; no open engine P0 |
| HTTP AI API (`server.js`) | **Shipped** — choose / evaluate / validate / derive / apply / advance / order; stable `{error,code}` 400s |
| Root validation gate (`npm test`) | **Green path** — calc → AI → build → `test:server` → UI lint |
| Upstream audit (`npm run test:upstream`) | **Policy B** — intentional fails (~75/63); not part of root gate |
| Sets → Gen 8 zero-EV `BattleState` bridge | **Shipped** (`sets_to_battle_state.js`) |
| AI Debug panel | **Shipped** + fixture browser + golden compare (FIX-01…04) |
| Fixture browser / golden evals | **Shipped** — `fixtures/ui/` (10 Gen 8 Singles) + `sample.eval.json` |
| Light explain + doc citations | **Shipped (MVP)** → superseded by EXP-01 |
| Deeper Explain (EXP-01/02) | **Shipped** — side-by-side engine ↔ policy doc; citation map audit |
| Singles Battle turn viewer | **Shipped (MVP)** (`#runbun-battle`) |
| Replay scrubber (RPL-01) | **Shipped (MVP)** (`#runbun-replay`, `fixtures/ui/replays/`) |
| Browser UI smoke | **Manual check — not in `npm test`.** Last ad-hoc run 16/16 (incl. no `util_1` / Abilities console errors; Gen 8 default). Evidence is session screenshots under the ignored `_ui_smoke_test/`; re-run by hand after touching AI Debug / Battle panels |
| Accuracy: Wonder Skin / Illuminate (+ Mold Breaker path) | **Shipped** |
| `secondaryRolls` / derive-resolution smoke | **Shipped** (HTTP smoke asserts trace) |
| R&B branding + Gen 8 default | **Shipped** |
| Product shell (UI-V0/V1/V2/V2b) | **Shipped** — tokens + mode nav + R&B panels + calc-page unify |
| Sets / Bridge elevated mode (SET-01) | **Shipped** — standalone `#sets-bridge` + party preview |
| Singles Battle polish (UI-V3) | **Shipped** — active cards, summary chips, collapsible JSON |
| A11y pass (ACC-01) | **Shipped** — shell/nav/status/forced-switch; §7 checklist |
| Docs sync (UX / validation / README / ai README) | **Current** |

**Bottom line:** The decision-useful engine, thin product MVP, fixture
browser/goldens, Sets bridge, Singles/Doubles Battle field + targeting UX,
Replay scrubber (RPL-01), deeper Explain, and ACC-01 a11y pass are in place.
**Next:** repro-backed ENG-01/02 or later P3 (EXP-03 / UI-V4 / BAT-01 /
ADP-01). No open engine P0. Not a second battle simulator — see §0.

---

## 2. Architecture reminder (plain language)

Think of three boxes that must stay separate:

```text
┌─────────────────────┐     read-only damage      ┌─────────────────────┐
│  calc/              │ ◄─────────────────────────│  ai/                │
│  “What damage if    │   Pokemon / Move / Field  │  “Which action?”    │
│   this move hits?”  │   → Result / rolls        │  score → choose →   │
│  Multi-gen oracle   │                           │  derive / apply /   │
│  + R&B overlays     │                           │  advance turn       │
└─────────────────────┘                           └──────────▲──────────┘
                                                             │
                                                    JSON over HTTP
                                                             │
                                                  ┌──────────┴──────────┐
                                                  │  src/ + server.js   │
                                                  │  Presentation only  │
                                                  │  Never a 2nd engine │
                                                  └─────────────────────┘
```

| Layer | Owns | Does not own |
| --- | --- | --- |
| **`calc/`** | Damage math, species/move/item data, fork overlays | Action scoring, PP clocks, turn state |
| **`ai/`** | Serializable `BattleState`, legality, scoring, transitions | Browser UI, Showdown protocol |
| **`server.js`** | HTTP adapter + static `dist/` | A second copy of policy rules |
| **`src/`** | Buttons, panels, display state | Scoring, resolution sampling, residual inventiveness |
| **Docs** (`MECHANICS.MD`, `run_and_bun_ai.MD`) | Source of truth for R&B rules | Executable code until mirrored in `calc/` / `ai/` + tests |

**Two generations of truth:**

- **Calculator:** generations 1–9 remain available as an oracle.
- **Run & Bun AI / Battle / Explain modes:** default and target **Generation 8**,
  zero EVs in AI projections, overlays from `MECHANICS.MD` / move overlays.

Do not blur “multi-gen calc works” into “every gen is a full R&B sim.”

---

## 3. Hard rules (do not bend)

1. **Policy B — upstream audit stays separate.**  
   `npm run test:upstream` in `calc/` is a compatibility audit. Root `npm test`
   stays green without requiring the audit green. Document fork deltas in
   `FORK_MAP.md` + `fork.test.ts`. Never silently rewrite inherited Smogon
   expectations to force the audit green.

2. **No second battle engine in the browser.**  
   `src/` is a thin HTTP client. All choose / derive / apply / advance go through
   `server.js` → `ai/`. Display state mirrors validated server responses.

3. **Calculator is a read-only oracle.**  
   `calc.calculate()` does not advance battle state. AI converts state → calc
   objects at the adapter boundary, then converts `Result` into machine facts
   (never by parsing `Result.kochance()` / human description strings).

4. **Honest modeled slice.**  
   Incomplete sim is fine. Label “modeled” vs “caller / external event.” Prefer
   surfacing gaps over inventing Pokémon Showdown residual/event-queue parity
   in the browser or chooser.

5. **Expand the engine only when decisions change.**  
   New mechanics belong in `ai/` (or `calc/` overlays) with fixtures when they
   affect legality, facts, scores, or transitions — not for encyclopedia
   completeness.

---

## 4. What’s done (recent era — keep as regression baseline)

Treat these as **shipped baselines**. Re-break only with intent and tests.

### Engine / API

- [x] Decision-useful Gen 8 AI scope; VALIDATION backlog shows **no open P0**
- [x] Wonder Skin (Gen 5+ status accuracy cap) + Illuminate (Gen 9+ evasion ignore)
- [x] Mold Breaker family vs accuracy abilities on the shared accuracy path
- [x] Full HTTP surface + `npm run test:server` (incl. validate-battle-state)
- [x] `secondaryRolls` / derive-resolution trace coverage in smoke
- [x] Policy B documented (upstream inventory buckets in `VALIDATION.md`)

### Product / UI

- [x] R&B branding; Gen 8 default in calc shell
- [x] Browser build fix (no `util_1` / Abilities load failures in UI smoke)
- [x] AI Debug panel: evaluate/choose, debug loop, scenarios, fixture load/export
- [x] Named UI fixtures (`fixtures/ui/`, 10 Gen 8 Singles) + manifest browser (FIX-01/02)
- [x] Golden evaluate snapshot format + `sample.eval.json` + regen script (FIX-03)
- [x] AI Debug golden compare (facts/reasons; no `kochance`) (FIX-04)
- [x] Structured state editor (thin: gen / mode / turn / active HP + raw JSON)
- [x] Sets → BattleState bridge with Gen 8 + zero-EV callouts
- [x] Elevated Sets / Bridge mode + party ID/species/HP preview (SET-01)
- [x] Light explain: expandable score reasons + ActionFacts
- [x] Explain citations: keyword → `run_and_bun_ai.MD` section/line anchors
- [x] Deeper Explain side-by-side: reasons / ActionFacts buckets ↔ policy doc (EXP-01)
- [x] Citation map audit for high-traffic score-reason phrases (EXP-02)
- [x] Singles Battle viewer on main page (`battle_turn_viewer.js`)
- [x] Battle field polish: active cards, summary chips, collapsible JSON (UI-V3)
- [x] Doubles field layout (DBL-01) + actor/target UX over evaluate rows (DBL-02)
- [x] Replay scrubber + shareable `apply-advance-trace` JSON (RPL-01)
- [x] Invalid Action 400 prefix distinct from Invalid BattleState
- [x] Stable HTTP `{error, code}` contract; resolution/options → Action; AI domain Errors → 400
- [x] Modeled-slice honesty copy in AI Debug and Battle
- [x] UI smoke 16/16 on its last ad-hoc run — **manual, not a gated baseline** (see §1)

### Docs

- [x] `RUNBUN_UX.md` phase table; README / `ai/README.md` endpoint notes;
      `VALIDATION.md` done/next/park tables; `FORK_MAP.md` Policy B

---

## 5. Explicit non-goals (Park)

Do **not** schedule these as “make green” or “finish the encyclopedia” work
unless a real playthrough / scoring bug forces a focused module. IDs match §0.

| Priority | ID | Item | Why parked | When to reopen |
| --- | --- | --- | --- | --- |
| Park | PARK-01 | Exact PS residual / event-queue interleaving | Collapsed `advanceTurn()` is enough; unmodeled events stay caller-owned | External adapter needs a specific residual ordering contract |
| Park | PARK-02 | Full ability / volatile encyclopedia | Add modules when legality/score bugs appear | Bug report with reproducible `BattleState` |
| Park | PARK-03 | OHKO niche accuracy formulas / rare items | Caller can supply `hit`; scoring rarely needs them | R&B policy or a fixture requires them |
| Park | PARK-04 | Berry Juice per-hit timing | Sequence model collapses to move boundary | Multi-hit timing model expands |
| Park | PARK-05 | Map/environment Nature Power without terrain | Documented non-goal | — |
| Park | PARK-06 | Fog-of-war / hidden info | R&B AI has full team knowledge | Only if product scope changes |
| Park | PARK-07 | Live online ladder / Showdown protocol | Not this product | — |
| Park | PARK-08 | Silent upstream expectation rewrites | Policy B | Never without explicit `FORK_MAP` + fixture promotion |
| Park | PARK-09 | Full Smogon calc visual rewrite / SPA migration | Shell frames calc; density stays upstream-like | Explicit product decision |
| Park | PARK-10 | Dedicated set builder + R&B set packs | Bridge MVP enough for now | After SET-01; author demand |

**Not Park — scheduled later:** Doubles chrome DBL-01/DBL-02 **shipped**;
Replay scrubber RPL-01 **shipped**; golden fixture browser = **P0–P1** FIX-*
(shipped). Do not leave open work as unranked “later” without an ID in §0.

---

## 6. What’s next (ordered phases)

Each phase lists **priority**, **goal**, **concrete tasks** (with IDs),
**done-when**, **ownership**, and **depends on**. Prefer §0 order when a
phase spans multiple ranks. Bug-driven ENG-* may interrupt product chrome.

---

### Phase A — Keep the floor green (**P0** hygiene)

**Goal:** Never lose the shipped MVP while iterating. **ID:** HYG-01.

| Priority | Task | Owner |
| --- | --- | --- |
| P0 | Before merge: `npm test` at repo root | all |
| P0 | After `src/`-only changes: at least `node build view` + `npm run test:server` + spot UI | `src/` |
| P0 | Record new intentional calc overlays in `FORK_MAP.md` + `fork.test.ts` | `calc/` |
| P0 | New AI rules get focused fixtures under `ai/src/test/` | `ai/` |
| P0 | Re-run / refresh UI smoke when touching AI Debug or Battle panels | `src/` / docs |

**Done when:** Root gate stays green; UI smoke regressions are caught before
merge; Policy B inventory updated only when fork deltas change.

**Depends on:** Nothing — continuous.

---

### Phase B — Fixture browser & golden eval snapshots (**P0 → P1**) ✅ shipped

**Goal:** Make regression hunting and “what would AI click?” reproducible
without hand-pasting JSON every time. **IDs:** FIX-01…FIX-04 (**Done**).

| Priority | Task | Owner | ID |
| --- | --- | --- | --- |
| P0 | Inventory curated `BattleState` cases (mirror `ai/src/test` shapes) | docs + `src/` | FIX-01 |
| P0 | One-click load into AI Debug (reuse existing validate boundary) | `src/` + `server.js` if needed | FIX-02 |
| P1 | Snapshot ranked evaluations (action + score + key facts) as golden files | `ai/` or scripts + `src/` | FIX-03 |
| P1 | Diff UI: current eval vs golden (facts/reasons only — no string parsing of calc desc) | `src/` | FIX-04 |
| P0 | Keep validators shared with HTTP (`validateBattleState`) | `ai/` / `server.js` | FIX-02 |

**Done when:**

- Author can open a named scenario, evaluate, and see pass/fail vs a golden
  snapshot without leaving the page (or via a documented CLI).
- Goldens are regenerated deliberately; failures are reviewable.
- Still no policy code in the browser.

**Depends on:** Phase A floor; existing fixture load/export MVP.

**Non-goal:** Full replay scrubber (**P3** RPL-01 / Phase E).

---

### Phase C — Deeper Explain (“doc says X / engine scored Y”) (**P2 → P3**)

**Goal:** Help players and reviewers trust scores against `run_and_bun_ai.MD`.
**IDs:** EXP-01…EXP-03.

| Priority | Task | Owner | ID |
| --- | --- | --- | --- |
| P2 | ~~Side-by-side view: policy-doc cite vs score reasons / ActionFacts for one action~~ **Done** | `src/` | EXP-01 |
| P2 | ~~Strengthen citation map only from real reason keywords / fact fields~~ **Done** | `src/` | EXP-02 |
| P3 | Optional quiz / “spot the score” scenarios using Phase B fixtures | `src/` + docs | EXP-03 |
| P0 | Never drive UI or policy from `Result.desc` / `kochance` strings | hard rule | HYG-01 |

**Done when:**

- For a scored action, user can see the matching doc section and the machine
  facts that produced the score in one place.
- Citations remain keyword/fact-driven; no new scoring heuristics in UI.

**Depends on:** Explain MVP (shipped); Phase B scenarios (FIX-02) make this much
stronger.

---

### Phase D — Doubles Battle chrome (**P2 → P3**)

**Goal:** Human-readable Doubles turn loop with targeting / ally clarity —
still over the same HTTP AI loop. **IDs:** DBL-01, DBL-02.

| Priority | Task | Owner | ID |
| --- | --- | --- | --- |
| P2 | ~~Extend Battle viewer for two actives per side (layout sketch)~~ **Done** | `src/` | DBL-01 |
| P3 | ~~Target selection UX for single-target vs spread~~ **Done** | `src/` | DBL-02 |
| P3 | ~~Ally support actions (Helping Hand, Follow Me, etc.) shown honestly~~ **Done** | `src/` (display) / `ai/` (already modeled) | DBL-02 |
| P3 | ~~Keep Singles path unchanged; label modeled vs external~~ **Done** | `src/` | DBL-02 |
| P3 | ~~Smoke coverage for Doubles happy path~~ **Done** | `src/` + `test:server` | DBL-02 |

**Done when:**

- User can load a Doubles Gen 8 state, evaluate per actor/target, apply one
  chosen action, and advance turn via HTTP.
- Targeting mistakes are prevented or clearly flagged; no browser-side legality
  reinvention beyond calling evaluate/validate.

**Depends on:** Singles MVP stable; Doubles fixtures already in `ai/` (engine
ready). Prefer Phase B scenarios that include Doubles cases.

**Deferred relative to this:** Replay scrubber stays **P3** RPL-01; do not
block Doubles sketch on replay.

---

### Phase E — Replay scrubber & shareable traces (**P3**) ✅ shipped

**Goal:** Step through apply/advance traces for teaching and bug reports.
**ID:** RPL-01 (**Done**).

| Priority | Task | Owner | ID |
| --- | --- | --- | --- |
| P3 | ~~Record sequence: state₀ → action → resolution → state₁ → …~~ **Done** | `src/` + `fixtures/ui/replays/` | RPL-01 |
| P3 | ~~Scrubber UI: scrub turns, show ranked actions at each step~~ **Done** (`#runbun-replay`) | `src/` | RPL-01 |
| P3 | ~~Shareable JSON replay (validated shapes only)~~ **Done** (`apply-advance-trace`) | docs + `src/` | RPL-01 |

**Done when:** A saved replay reloads and steps without re-deriving random
rolls unless the file stores them; invalid files get HTTP/client 400 clarity.

**Depends on:** Phases B–D usefulness; not blocking decision-useful play.

---

### Phase F — Engine fills (**P1** bug-driven; else **Park**)

**Goal:** Fill gaps that actually change legality, facts, scores, or transitions.
**IDs:** ENG-01, ENG-02; uncommon accuracy stays PARK-03 until needed.

| Priority | Task | Owner | ID |
| --- | --- | --- | --- |
| Park | Remaining uncommon accuracy (OHKO niches, rare items) — implement **or** keep Park with caller `hit` | `ai/` | PARK-03 |
| P1 | Scoring wrong because facts missing — add facts first, then score | `ai/` | ENG-01 |
| P1 | Calc overlay only when damage identity is wrong vs `MECHANICS.MD` | `calc/` | ENG-02 |
| Park | Ability encyclopedia entry only when a bug needs it | `ai/` | PARK-02 |

**Done when:** Each change has a focused fixture; `VALIDATION.md` backlog row
updated; no chooser inventiveness.

**Depends on:** Repro `BattleState` or playthrough note. Do not schedule a
sweep of “all abilities.”

---

### Phase G — External adapter / headless hardening (**P3**)

**Goal:** Scripts, bots, or a real game bridge consume the same JSON contracts.
**ID:** ADP-01.

| Priority | Task | Owner | ID |
| --- | --- | --- | --- |
| P3 | Fixture batch runner CLI (evaluate many states) | scripts / `ai/` | ADP-01 |
| P3 | Document adapter pattern: external events → validated state patches | docs | ADP-01 |
| P3 | Optional OpenAPI-ish freeze of endpoint schemas | docs / `ai/README.md` | ADP-01 |
| Park | Auth only if ever hosted | — | (no ID until hosting is in scope) |

**Done when:** An external caller can validate → evaluate → derive → apply →
advance without browser; unmodeled residuals stay inject-only.

**Depends on:** Stable HTTP shapes (shipped). Trigger when a consumer exists.

---

## 7. Suggested session-sized chunks

Use these as one-sitting scopes. Prefer finishing a chunk over starting three.
Priorities match §0.

| # | Priority | ID | Chunk (~1 session) | Phase | Owner |
| --- | --- | --- | --- | --- | --- |
| 1 | P0 | FIX-01 | Inventory AI test fixtures worth exposing as named UI scenarios; list 8–12 | B | docs + `src/` |
| 2 | P0 | FIX-02 | Fixture browser MVP: dropdown/list → load into AI Debug → validate | B | `src/` |
| 3 | P1 | FIX-03 | Golden eval snapshot format + regenerate one golden + diff fail message | B | `ai/` / scripts |
| 4 | P1 | FIX-04 | Wire golden compare into AI Debug status line | B | `src/` |
| 5 | P0 | UI-V0 | Wire tokens CSS (parallel with FIX-*) | UI design | `src/` |
| 6 | P1 | UI-V1 | Shell mode nav + `#sets-bridge` + context chips | UI design | `src/` |
| 7 | P2 | EXP-01 | ~~Explain side-by-side panel for one expanded action row~~ **Done** | C | `src/` |
| 8 | P2 | EXP-02 | ~~Citation map audit: gaps for top score-reason phrases~~ **Done** | C | `src/` + docs |
| 9 | P2 | DBL-01 | ~~Doubles Battle layout sketch (display only, still HTTP)~~ **Done** | D | `src/` |
| 10 | P3 | DBL-02 | ~~Doubles target pick + evaluate for selected actor~~ **Done** | D | `src/` |
| 11 | P0 | HYG-01 | ~~UI smoke cases for fixture browser / Doubles happy path~~ **Done** (server smoke) | A/B/D | `src/` |
| 12 | P1 | ENG-01 | One engine fill from a real bug (facts + fixture + score if needed) | F | `ai/` / `calc/` |
| 13 | P0 | HYG-01 | Policy B: refresh upstream fail inventory counts if overlays changed | A | `calc/` / docs |
| 14 | P3 | ADP-01 | Adapter notes: how a Lua/PS bridge would patch state (doc only) | G | docs |

Skip chunks that duplicate shipped MVP. If a session discovers an engine **P0**,
fix that before product chrome (today: none open).

---

## 8. Risks and how to handle them

| Risk | Mitigation |
| --- | --- |
| UI grows a shadow ruleset | Code review: no scoring/transition logic in `src/`; HTTP only |
| Gen confusion (calc gen ≠ R&B mode) | Keep Gen 8 defaults + callouts in AI/Battle/Sets bridge |
| EV leakage into AI projections | Zero-EV map at every AI calc/order/accuracy/entry path; bridge callouts |
| Upstream audit pressure | Policy B; document buckets; promote baselines only explicitly |
| “Almost Showdown” scope creep | Park residual parity; honest modeled-slice copy |
| Fixture browser duplicates validators | Always call `validateBattleState` / HTTP validate |
| Explain cites wrong doc lines | Cite by stable section headings; re-check after `run_and_bun_ai.MD` edits |
| Doubles UX invents slot adjacency | Serializable model has no adjacency; don’t fake it in UI |
| Golden snapshots flake on tie randomness | Snapshot **evaluate** (deterministic), not sampled **choose**, unless seed is fixed |
| `dist/` hand-edits | Never; regenerate via `npm run build` / `node build view` |

---

## 9. Ownership cheat sheet

| Change type | Primary folder | Evidence |
| --- | --- | --- |
| Damage formula / R&B calc overlay | `calc/` | `fork.test.ts`, mechanics tests |
| Legality, score, resolve, residual, switch entry | `ai/` | focused `ai/src/test/*.ts` |
| HTTP shapes / 400 behavior | `server.js` | `server.smoke.test.js` |
| Panels, battle chrome, citations UI | `src/` | UI smoke + lint |
| Set data generation | `import/` | separate `npm test` in `import/` |
| Product roadmap / phase status | `PLAN.md` + `RUNBUN_UX.md` | this file |
| Rule source (not code) | `../MECHANICS.MD`, `../run_and_bun_ai.MD` | mirrored into code + tests |

---

## 10. Doc map (where to look)

| Doc | Role |
| --- | --- |
| **`PLAN.md` (this file)** | **Master backlog (§0)**; ordered roadmap, chunks, risks, Park list |
| [`RUNBUN_UX.md`](RUNBUN_UX.md) | Product layers, phase status + priorities, IA |
| [`RUNBUN_UI_DESIGN.md`](RUNBUN_UI_DESIGN.md) | Canonical UI design; V0–V4 + screen polish priorities |
| [`VALIDATION.md`](VALIDATION.md) | What’s tested; Policy B; engine/product backlog (same ranks) |
| [`AI_DATA_MODEL.md`](AI_DATA_MODEL.md) | Serializable contracts |
| [`FORK_MAP.md`](FORK_MAP.md) | Where a change belongs; intentional calc deltas |
| [`AGENTS.md`](AGENTS.md) | Agent/contributor architecture rules; index of the engine data rules |
| [`docs/engine-rules/`](docs/engine-rules/) | Normative per-domain engine data rules (state, resolution, order, items, residuals, entry) |
| [`ai/README.md`](ai/README.md) | HTTP endpoints and browser client notes |
| [`README.md`](README.md) | Install, build, high-level entry |
| [`../MECHANICS.MD`](../MECHANICS.MD) | R&B mechanic source (Gen 8 default) |
| [`../run_and_bun_ai.MD`](../run_and_bun_ai.MD) | R&B AI scoring source |

When priorities change: update **§0 first**, then §6–§7, the phase table in
`RUNBUN_UX.md`, UI rollout ranks in `RUNBUN_UI_DESIGN.md` §9, and open rows in
`VALIDATION.md`. Do not fork a second plan in chat-only notes.

---

## 11. Immediate “start here” recommendation

1. **P0** HYG-01 — keep root/`test:server` green (ongoing).
2. ~~**P0** FIX-01 → FIX-02~~ **Done** — `fixtures/ui/` + AI Debug load/validate.
3. ~~**P1** FIX-03/04~~ **Done** — golden snapshot + in-panel compare.
4. ~~UI-V0/V1/V2~~ **Done** (sibling track).
5. ~~**P2+** Explain depth (EXP-01), Battle polish (UI-V3), Doubles layout (DBL-01), targeting (DBL-02)~~ **Done**.
6. ~~**P3** RPL-01~~ **Done** — `#runbun-replay` + `fixtures/ui/replays/`.
7. **P1** ENG-01/02 only with a repro; **P3** EXP-03 / UI-V4 / BAT-01 / ADP-01 and
   **Park** stay out of the critical path until needed. Policy B and “no browser
   engine” untouched.
