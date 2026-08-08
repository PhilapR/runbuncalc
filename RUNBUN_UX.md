# Run & Bun UX Layer Map

Product surfaces around the damage calculator and AI policy — not a Showdown
clone. Complements any calc-shell rebrand; ownership stays:

| Layer owner | Responsibility |
| --- | --- |
| `calc/` | Read-only multi-gen damage oracle (+ R&B overlays) |
| `ai/` | Serializable `BattleState`, score/choose, derive/apply/advance |
| `server.js` | HTTP adapter + static `dist/` |
| `src/` | Presentation only — never a second battle engine |

Source workflows: playthrough/AI prediction (`../run_and_bun_ai.MD`), Gen 8–
default mechanics (`../MECHANICS.MD`), contracts (`AI_DATA_MODEL.md`,
`VALIDATION.md`, `FORK_MAP.md`). Endpoint shapes: [`ai/README.md`](ai/README.md).

**Default generation for R&B modes: 8.** Multi-gen remains a calculator
capability, not a claim of full R&B sim fidelity. AI projections force
**zero EVs** (optional EV maps may exist for transport only).

**Priority scheme:** **P0 / P1 / P2 / P3 / Park** — same as
[`PLAN.md`](PLAN.md) §0 (master backlog). Do not leave open work as unranked
“later” / “next” without a rank + ID.

---

## Phase status (product)

| Phase | Status | Priority (open) | ID / notes |
| --- | --- | --- | --- |
| Calc (multi-gen oracle + R&B overlays) | **Shipped** | P0–P1 shell only | UI-V0/V1; Gen 8 default; `GET\|POST /calculate` |
| HTTP AI API + smoke gate | **Shipped** | P0 hygiene | HYG-01; `npm run test:server` |
| AI Debug panel | **Shipped** | P2 polish / Explain | FIX-* fixture browser/goldens shipped; EXP-01 next |
| Sets → BattleState bridge | **Shipped** | P1–P2 polish | UI-V1 `#sets-bridge`; SET-01 preview; PARK-10 builder |
| Trainer Wheel (calc p2) | **Shipped** | — | TW-01: Calvin default; prev/next + party; UI-SP-01 spacing |
| Light explain | **Shipped (MVP)** | P2 deepen | EXP-01 side-by-side |
| Explain citations | **Shipped (MVP)** | P2 audit | EXP-02 citation map |
| Structured state editor | **Shipped (thin MVP)** | — | HTTP validate boundary |
| Singles Battle viewer | **Shipped (MVP)** | P2 polish | UI-V3; P3 BAT-01 reverse hop |
| Fixture browser / golden evals | **Shipped** | P2+ deepen | FIX-01…FIX-04 — `fixtures/ui/` + golden compare |
| Visual shell / tokens | **Shipped** | P2 polish | UI-V0…UI-V2 done; UI-V3 next |
| Doubles Battle chrome | **Open** | **P2 → P3** | DBL-01 sketch then DBL-02 targeting |
| Deeper Explain / quiz | **Open** | **P2 → P3** | EXP-01…EXP-03 |
| Replay scrubber | **Shipped (MVP)** | **P3** | RPL-01 |
| External adapter / batch CLI | **Open** | **P3** | ADP-01 |
| PS residual / event-queue parity | **Park** | **Park** | PARK-01 — caller-owned |

Presentation lives in `src/` (`ai_panel.js`, `battle_turn_viewer.js`, sets bridge);
do not fork a second policy client. Master table: [`PLAN.md`](PLAN.md) §0.

---

## Information architecture (modes)

Keep one shell; separate **modes** so multi-gen calc does not look like a
battle sim:

```text
Run & Bun tools
├── Calc          ← inherited Smogon-style damage UI (shipped)
├── AI Debug      ← thin HTTP client for policy / turn slice (shipped + enrichment)
├── Sets          ← team / trainer / import → sets + BattleState (bridge shipped)
├── Battle*       ← Singles MVP shipped; Doubles P2→P3 (DBL-*)
├── Explain*      ← MVP under AI Debug; deeper P2 (EXP-*); top-level P3 UI-V4
└── (API)         ← headless; documented in ai/README.md; harden P3 ADP-01
```

\*Battle and Explain are sections on the main calculator page, not separate routes.

**Nav rule:** Calc can stay gen-picker-first. AI Debug / Battle / Explain lock
or default to Gen 8 and label overlays. Do not merge battle turn chrome into
the calc columns.

**Shared adapters (not UI):** `Pokemon`/`Move`/`Field` ↔ calc objects;
`BattleState`/`Action`/`ActionFacts`/`MoveResolution` ↔ AI HTTP; future
external battle events → validated state patches only.

---

## Layer 1 — Damage calculator (shipped)

| | |
| --- | --- |
| **Purpose** | Answer “what damage does this action deal?” for arbitrary gen/sets |
| **Primary user** | Player mid-run; set theory; R&B overlay checks |
| **Data contract** | Calc `Pokemon` / `Move` / `Field` / `Result` (browser or `GET|POST /calculate`) |
| **Depends on** | `calc/`, authored set data (`src/js/data/sets/`), R&B fork overlays |
| **MVP** | Existing UI; Gen 8 default; clear R&B fork callouts |
| **Next** | **P0** UI-V0 tokens; **P1** UI-V1 oracle chip / shell framing |
| **Park** | PARK-09 full Smogon visual rewrite |
| **Do not put here** | Action scoring, turn order, PP/status clocks, choose-action |

---

## Layer 2 — AI decision / debug panel (shipped; iterate)

| | |
| --- | --- |
| **Purpose** | Inspect ranked legal actions and drive a one-step derive→apply→advance |
| **Primary user** | AI implementers; players verifying “what would R&B AI click?” |
| **Data contract** | `BattleState` JSON in/out; `POST /ai/evaluate-actions`, `/choose-action`, `/validate-battle-state`, `/derive-resolution`, `/apply-action`, `/advance-turn`, … |
| **Depends on** | `server.js` + `ai/`; optional facts from calc via AI adapter |
| **MVP** | Present: JSON state, evaluate/choose, ranked scores, debug loop, HTTP 400 surfacing; load scenario / fixture file; export state; structured fields; expandable reasons / ActionFacts + doc citations; modeled-slice copy |
| **Next** | **P2** EXP-01 deeper Explain; UI-V2 polish already shipped |
| **Soon** | **P2** EXP-01/02 deeper explain (facts-driven only) |
| **Do not put here** | Reimplemented scoring; persistent match UX (use Layer 4) |

Keep this panel a **thin HTTP client**. Browser must not own policy or
transitions.

---

## Layer 3 — Team / set builder & import (bridge shipped)

| | |
| --- | --- |
| **Purpose** | Author player/AI parties and trainer sets; bridge paste/Lua → calc sets and `BattleState` |
| **Primary user** | Player/builder; romhack authors; fixture authors |
| **Data contract** | Set JSON / paste / Lua export; maps into calc sets **and** serializable party records (`id`, species, moves, HP, …) |
| **Depends on** | Existing import UI + trainer lists; `validateBattleState()` at AI boundary; zero-EV R&B projection in AI |
| **MVP** | One-click “Load from calc panels” into AI Debug (`sets_to_battle_state.js`); Gen 8 + zero-EV projection; optional Team / trainer benches; server `validateBattleState` |
| **Next** | **P1** UI-V1 `#sets-bridge` nav; **P2** SET-01 preview / empty-error polish |
| **Park** | PARK-10 dedicated builder + R&B set packs |
| **Do not put here** | Damage formulas; move resolution; live turn loop |

EV note: calc remains EV-capable for OSS API; R&B AI paths force zero EVs —
builder UX should make that explicit when targeting AI/battle modes.

---

## Layer 4 — Battle / match UI (Singles MVP shipped)

| | |
| --- | --- |
| **Purpose** | Human-readable turn loop: actives, party, field, HP, choose or step AI |
| **Primary user** | Player practicing vs policy; tool authors; not a live online ladder |
| **Data contract** | Same AI HTTP surface; UI holds **display state** mirrored from validated server responses |
| **Depends on** | Mature choose + derive/apply/advance; external sim adapter **P3** ADP-01 |
| **MVP** | `#runbun-battle` Singles turn viewer (`battle_turn_viewer.js`): show state → evaluate → pick/apply → advance; forced switches; import from AI Debug / calc panels; modeled-slice copy |
| **Next** | **P2** UI-V3 field polish; **P2** DBL-01 Doubles layout sketch |
| **Later** | ~~**P3** DBL-02 / RPL-01~~ **Done**; **P3** BAT-01 reverse import |
| **Park** | PARK-07 Showdown protocol / live ladder |
| **Do not put here** | A browser battle engine; Showdown protocol; guessing unmodeled mechanics |

Incomplete sim is fine: label “modeled slice” vs “external event.” Prefer
honest gaps over fake completeness.

---

## Layer 5 — Training / explanation (“why this move”)

| | |
| --- | --- |
| **Purpose** | Map scores to `run_and_bun_ai.MD` rules so players learn the policy |
| **Primary user** | Players; content creators; policy reviewers |
| **Data contract** | `evaluate-actions` evaluations + `ActionFacts` (machine facts, not `Result.desc` / `kochance` strings); optional rule-id annotations from policy |
| **Depends on** | Stable facts + scoring; doc anchors or flowchart assets |
| **MVP (shipped)** | Ranked list + expandable facts/reasons under each scored action (damage rolls, KO flags, speed, status blockers); keyword citations into `run_and_bun_ai.MD` |
| **Next** | **P2** EXP-01 side-by-side “doc says X / engine scored Y”; **P2** EXP-02 citation audit |
| **Later** | **P3** EXP-03 quiz / “spot the score” |
| **Do not put here** | New scoring heuristics; parsing human calc strings for decisions |

---

## Layer 6 — API / automation / headless (shipped; harden)

| | |
| --- | --- |
| **Purpose** | Scripts, bots, MCP-incompatible browser workflows, CI smoke, external clients |
| **Primary user** | Developers; automation; future game adapters |
| **Data contract** | Documented JSON endpoints; `validate*` → HTTP 400; no browser dependency |
| **Depends on** | `server.js`, `ai/`, optionally `/calculate` |
| **MVP** | Current endpoints + `npm run test:server`; OpenAPI-ish list in `ai/README.md` |
| **Later** | **P3** ADP-01 fixture batch CLI + adapter docs (+ optional OpenAPI freeze) |
| **Park** | Auth if ever hosted (no product demand yet) |
| **Do not put here** | UI layout concerns; embedding calc class instances in wire format |

---

## Layer 7 — Scenarios, fixtures, admin/replay (P0–P3)

| | |
| --- | --- |
| **Purpose** | Load curated `BattleState` cases; diff evaluations; replay apply/advance traces |
| **Primary user** | Engine authors; regression hunters |
| **Data contract** | Same validators as HTTP; fixtures mirror `ai/src/test/*.ts` shapes |
| **Depends on** | Layers 2 + 6; optionally Layer 5 for explanations |
| **MVP** | Load scenario / fixture file + export current state in AI Debug (shipped) |
| **Shipped** | Named `fixtures/ui/` browser + golden evaluate snapshots (FIX-01…04) |
| **Next** | More goldens / quiz scenarios (EXP-03); optional adapter CLI (ADP-01) |
| **Later** | ~~**P3** RPL-01 shareable replay JSON / scrubber~~ **Done** (`#runbun-replay`) |
| **Do not put here** | Production admin for multiplayer; hand-edited `dist/` |

---

## Build order (engine-aligned)

Decision-useful first; rich UI last-ish; no Showdown clone.

1. **Engine & contracts** — **done** — `ai/` policy + transitions; validators; fixtures; Gen 8 R&B overlays in `calc/`.
2. **HTTP API stability** — **done** — choose, evaluate, validate, derive, apply, advance, order; smoke tests; error shapes.
3. **AI Debug UX** — **done** — scenarios, fixture load/export, structured fields, ranked results, expandable reasons/facts + citations; still thin client.
4. **Sets → BattleState bridge** — **MVP done** — calc panels / trainer sets → Gen 8 validated AI state with Gen 8 / zero-EV callouts.
5. **Explain MVP** — **done** — expandable reasons + ActionFacts + policy-doc citations.
6. **Battle turn viewer** — **Singles MVP done** — `#runbun-battle` over the same HTTP loop; Doubles **P2→P3** (DBL-*).
7. **Fixture browser / goldens** — **Shipped** FIX-01…04 (`fixtures/ui/`, golden compare).
8. **Polish / rebrand** — [`RUNBUN_UI_DESIGN.md`](RUNBUN_UI_DESIGN.md) **P0** UI-V0 → **P1** UI-V1/V2 → **P2** UI-V3; calc density stays upstream-like.
9. **Deeper Explain / adapter / quiz** — **P3** EXP-03, UI-V4, ADP-01, BAT-01 per [`PLAN.md`](PLAN.md) §0 (RPL-01 shipped).

Stop conditions for “battle UI”: if a feature needs unmodeled residual order,
accuracy edge cases, or full PS mechanics, keep it caller/external — surface
the gap in UX copy rather than inventing browser logic.

---

## Cross-cutting rules

- **One oracle:** damage → `calc.calculate` (via AI adapter or `/calculate`).
- **One policy:** scores/transitions → `ai/` via HTTP (or direct TS in Node).
- **Serializable boundary:** UI edits JSON-compatible state; validate at edges.
- **Gen confusion:** calc = multi-gen tool; R&B battle/AI modes = Gen 8 + docs.
- **Zero EVs:** R&B AI calculator/order/accuracy/entry projections use an explicit zero EV map.
- **Full info:** R&B AI knows the player team — UIs may assume that; fog-of-war is out of scope until modeled.
- **Complement rebrand:** naming/visual identity can unify under Run & Bun; mode separation still matters.

---

## Where this lives

This file is the UX planning sibling to `FORK_MAP.md` / `AI_DATA_MODEL.md`.
The **master prioritized backlog** and ordered roadmap (phases, done-when,
session chunks, Park list) live in [`PLAN.md`](PLAN.md) §0. Visual system,
mode chrome, screen specs, and V0–V4 ranks live in
[`RUNBUN_UI_DESIGN.md`](RUNBUN_UI_DESIGN.md). Engine completeness rows use the
same ranks in [`VALIDATION.md`](VALIDATION.md). Link from README under Run &
Bun AI; avoid duplicating engine contracts here. When “next” changes, update
PLAN §0 first, then this phase table.
