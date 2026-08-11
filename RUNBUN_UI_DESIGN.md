# Run & Bun UI Design

**Canonical product UI design** for `runbuncalc`: information architecture,
visual system, and screen specs. Complements [`RUNBUN_UX.md`](RUNBUN_UX.md)
(layer ownership / phase status) and [`PLAN.md`](PLAN.md) (**master prioritized
backlog** §0 + roadmap). Engine contracts stay in `AGENTS.md` /
`AI_DATA_MODEL.md` — this file is presentation only.

Interactive summary (mode map, token roles, wire regions): open the Cursor
Canvas beside chat —
[runbun-ui-design](C:/Users/ragop/.cursor/projects/c-Users-ragop-Documents-pokemon-agent/canvases/runbun-ui-design.canvas.tsx).

**Status:** Design locked for implementers. Visual rollout is phased and
**priority-ranked** (§9). Do **not** treat this pass as a full Smogon calc
rewrite (**Park** PARK-09).

**Priority scheme:** same as [`PLAN.md`](PLAN.md) — **P0 / P1 / P2 / P3 /
Park**. Product “next” statements here must match PLAN §0 (no contradictory
unranked “next”).

---

## 1. Product principles

1. **One product shell, many modes.** Calc, Sets/Bridge, AI Debug, Singles
   Battle (Explain / Doubles / Replay are P2–P3) share chrome and brand; each
   mode has one job and does not pretend to be the others.
2. **Honesty over completeness.** AI and Battle surfaces always disclose Gen 8
   + modeled-slice limits. Prefer labeled gaps to fake Showdown parity.
3. **Thin client forever.** Browser mirrors validated HTTP/`ai/` responses.
   No second battle engine, no scoring in `src/`, no parsing `Result.desc` /
   `kochance` for decisions.
4. **Calc density is a feature.** The multi-gen oracle stays dense and
   upstream-familiar. R&B chrome frames it; it does not gut tables for
   marketing whitespace.
5. **Brand first on R&B rails.** Product name and Gen 8 identity lead AI /
   Battle / Sets-bridge surfaces. Calc remains clearly labeled as a multi-gen
   **oracle** secondary to R&B modes.
6. **Shared state vocabulary.** Modes pass `BattleState` / sets through
   explicit bridges (Load from calc, Import from AI Debug). Users always know
   which surface owns the live JSON.
7. **Desktop-first, mobile-readable.** Evaluate / choose / apply / advance and
   honesty copy work on small screens; dense calc grids may scroll or stack
   without redesigning every control.
8. **Accessible by default.** Mode nav is keyboard-reachable; status uses
   `role="status"` / `aria-live`; forced-switch and errors are not color-only;
   focus order follows primary actions.

---

## 2. Information architecture / mode map

### 2.1 Modes (product nav)

| Mode ID | Label | Primary job | Gen stance | Shipped? | Priority (open work) |
| --- | --- | --- | --- | --- | --- |
| `calc` | **Calc** | Multi-gen damage oracle + R&B overlays | Gen picker (default **8**) | Yes | P0–P1 shell chrome only (UI-V0/V1); guts stay dense |
| `sets` | **Sets / Bridge** | Build / import sets → Gen 8 zero-EV `BattleState` | **Locked Gen 8** for AI projection | Bridge yes | P1 nav target; P2 SET-01 preview; **Park** PARK-10 dedicated builder |
| `ai-debug` | **AI Debug** | Evaluate / choose / explain / fixture loop | **Gen 8** default; warn if JSON ≠ 8 | Yes | EXP-01/02 nested Explain shipped; P3 EXP-03 / UI-V4 |
| `battle` | **Singles Battle** | Human-readable turn loop over same HTTP | **Gen 8 Singles / Doubles** | MVP yes | UI-V3 + DBL-01/02 in same panel; P3 BAT-01 reverse hop |
| `explain` | **Explain** *(later top-level)* | Doc ↔ facts side-by-side | Gen 8 | Nested under AI Debug (EXP-01) | P3 UI-V4 top-level chrome |
| `doubles` | **Doubles Battle** *(later top-level)* | Targeting / ally chrome | Gen 8 Doubles | In Battle panel (DBL-01/02) | P3 UI-V4 dedicated mode chrome |
| `replay` | **Replay** | Scrub apply/advance traces | Gen 8 | MVP yes (`#runbun-replay`) | RPL-01 shipped; P3 UI-V4 polish |

Headless **API** is not a nav mode; document in `ai/README.md` only.

### 2.2 Shell structure

```text
┌──────────────────────────────────────────────────────────────────┐
│  RB-SHELL: brand · product mode nav · utility (theme, server)    │
├──────────────────────────────────────────────────────────────────┤
│  MODE CONTEXT BAR: gen/fidelity chip · honesty one-liner · hop   │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│                     ACTIVE MODE CONTENT                          │
│                                                                  │
├──────────────────────────────────────────────────────────────────┤
│  FOOTER: credits · doc links · “not a full sim” microcopy        │
└──────────────────────────────────────────────────────────────────┘
```

**Nav rule:** Product mode nav (`Calc | Sets | AI Debug | Battle | …`) is
distinct from the inherited calc **function** radios (One vs One / One vs All /
…). Those stay inside Calc mode only.

**Routing (near-term / P1 UI-V1):** Single-page sections with hash anchors
(`#calc`, `#sets-bridge`, `#ai-panel`, `#runbun-battle`). Mode nav scrolls /
reveals the active region and updates `aria-current`. **P3:** optional query
`?mode=` without splitting engines.

**Cross-mode hops (always explicit):**

| From → To | Control copy | Priority |
| --- | --- | --- |
| Calc → Sets / AI / Battle | “Load from calc panels” | Shipped |
| AI Debug → Battle | “Import from AI Debug” | Shipped |
| Battle → AI Debug | “Open in AI Debug” | P3 BAT-01 |
| Any R&B → Calc | Mode nav; do not auto-mutate calc gen | P1 UI-V1 |

### 2.3 What each mode must never own

| Mode | Must not |
| --- | --- |
| Calc | Action scores, PP clocks, choose/apply/advance |
| Sets / Bridge | Damage formulas; live turn loop |
| AI Debug | Persistent match chrome that hides JSON ownership |
| Battle | Browser-side legality reinvention; Showdown protocol |
| Explain | New scoring heuristics |

---

## 3. Visual direction

### 3.1 Concept

**“Stadium ink + crust accent.”** A dense tool UI with a dark ink field,
warm amber/crust brand accent (Run & Bun), and a cool electric teal for
primary R&B actions. Not a marketing landing page; not purple-indigo SaaS;
not cream+serif broadsheet; not generic Inter-on-white dashboard.

Light theme remains supported (existing `darkTheme` toggle): invert surfaces,
keep accent roles stable.

### 3.2 Color tokens

Implement as CSS custom properties on `:root` / `[data-rb-theme]` (see
optional `src/css/runbun-tokens.css`). Hex below is the **light** baseline;
dark theme swaps surface/text pairs.

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `--rb-ink` | `#1A2228` | `#E8EEF2` | Primary text |
| `--rb-ink-muted` | `#5A6670` | `#9AA8B2` | Secondary / help |
| `--rb-surface` | `#F4F6F7` | `#12171B` | Page background |
| `--rb-surface-raised` | `#FFFFFF` | `#1C242B` | Panels, field cards |
| `--rb-surface-sunken` | `#E8ECEF` | `#0D1114` | JSON editors, wells |
| `--rb-stroke` | `#C5CED6` | `#2E3A44` | Borders |
| `--rb-stroke-strong` | `#8A969F` | `#4A5A66` | Emphasized rules |
| `--rb-brand` | `#C45C26` | `#E07A3A` | Brand / active mode / crust accent |
| `--rb-brand-ink` | `#8F3F14` | `#F0A46A` | Brand text on soft fills (≥4.5:1) |
| `--rb-brand-soft` | `#F3E0D4` | `#3A2418` | Brand tint backgrounds |
| `--rb-action` | `#0B7A78` | `#2BB5B1` | Primary R&B buttons (Evaluate, Apply…) |
| `--rb-action-hover` | `#096664` | `#3FCCC8` | Action hover |
| `--rb-warn` | `#A67C00` | `#E0B84A` | Honesty / Gen-lock callouts |
| `--rb-warn-ink` | `#6B4F00` | `#F0C96A` | Warn text on soft fills (≥4.5:1) |
| `--rb-warn-soft` | `#FFF4D6` | `#3A3014` | Warn panel fill |
| `--rb-danger` | `#B42318` | `#F97066` | Errors, HTTP 400 |
| `--rb-danger-soft` | `#FEE4E2` | `#3B1511` | Error status fill |
| `--rb-ok` | `#1B7A3D` | `#3DDC7A` | Valid state, success status |
| `--rb-hp-high` | `#2F9E44` | `#3DDC7A` | HP ≥ 50% |
| `--rb-hp-mid` | `#E67700` | `#FFA94D` | HP 20–50% |
| `--rb-hp-low` | `#C92A2A` | `#FF6B6B` | HP < 20% |
| `--rb-oracle` | `#3D5A80` | `#7BA3C9` | Calc/oracle secondary chrome |
| `--rb-focus` | `#0B7A78` | `#2BB5B1` | Focus ring (2px offset) |

**Do not use** as primary brand: violet/indigo gradients, pure black+neon
glow stacks, warm cream page (`#F4F1EA`) + terracotta+serif combo.

### 3.3 Typography

| Role | Spec | Notes |
| --- | --- | --- |
| Brand wordmark | `"IBM Plex Sans Condensed", "Arial Narrow", sans-serif` · 700 · 1.35–1.6rem | Distinct from default system UI; condensed = tool density |
| Mode titles (H2) | Same family · 600 · 1.2rem | |
| Body / help | `"IBM Plex Sans", "Segoe UI", sans-serif` · 400 · 0.875–0.9rem · lh 1.4 | |
| Dense calc / tables | Keep inherited calc stack for columns; only shell/R&B panels adopt Plex | Avoid reflowing every Smogon control in phase 1 |
| Mono (JSON, IDs, scores) | `"IBM Plex Mono", "Consolas", monospace` · 0.82–0.85rem | |
| Honesty callouts | Body · 0.82rem · medium weight lead-in | |

Load fonts from a self-hosted or CDN link only when shell CSS lands; until
then system fallbacks are acceptable.

### 3.4 Density

| Surface | Density |
| --- | --- |
| Calc columns | **High** — preserve upstream spacing; shell only frames |
| Sets bridge | **Medium** — callouts + short control rows |
| AI Debug | **Medium-high** — control clusters, expandable rows, JSON well |
| Battle field | **Medium** — readable actives/HP; actions list compact |
| Mobile | Stack regions; hide raw JSON behind `<details>` by default on Battle |

### 3.5 Component patterns

#### Buttons

| Variant | Class (proposed) | Use |
| --- | --- | --- |
| Primary action | `.rb-btn.rb-btn-primary` | Evaluate, Choose, Apply, Advance, Load from calc |
| Secondary | `.rb-btn.rb-btn-secondary` | Validate, Refresh, Export, Reset |
| Ghost / quiet | `.rb-btn.rb-btn-ghost` | Sync fields, Open docs |
| Danger | `.rb-btn.rb-btn-danger` | Destructive reset (rare) |

Reuse existing `.btn` geometry in phase 1; map colors via tokens. Primary R&B
actions use `--rb-action`, not `--rb-brand` (brand = chrome; action = verbs).

#### Panels

- `.rb-panel` — raised surface, 1px `--rb-stroke`, 0.65–0.85rem padding.
- `.rb-panel-sunken` — JSON / log wells.
- Left border accent (3px) for honesty (warn) and error (danger) notes —
  already close to `.ai-panel-scope`.

#### HP bars

```text
[████████░░░░] 142 / 200
```

- Track: `--rb-surface-sunken`; fill: high/mid/low tokens by **current/max**.
- Always show numeric `current / max` beside or under the bar (not color-only).
- Width min 8em; height 0.55–0.7em; radius 2px (tool, not pill-heavy).

#### Action lists (ranked / legal)

Row layout:

```text
│ # │ Action label (move/switch)     │ score │
└───┴────────────────────────────────┴───────┘
  optional expand: reasons · ActionFacts · doc cites
```

- Selected: `--rb-action` left border + soft fill.
- Keyboard: arrow keys move selection when list focused; Enter expands /
  selects for Apply.
- Scores monospace right-aligned.

#### Status toasts / lines

Keep persistent status lines (`#ai-panel-status`, `#runbun-battle-status`)
rather than ephemeral toast stacks for MVP:

| State | Style |
| --- | --- |
| Idle / info | muted text on surface |
| Success | `--rb-ok` text; optional soft fill |
| Error | `--rb-danger` + soft fill; include HTTP status + short server message |
| Loading | Disable primary buttons; status “Working…”; `aria-busy` on region |

#### Chips / fidelity badges

- `Gen 8` chip — brand-soft + brand text on R&B modes.
- `Oracle · multi-gen` chip — `--rb-oracle` on Calc.
- `Modeled slice` chip — warn tokens; links to honesty note.
- `Zero EV` chip — warn on Sets bridge / after load-from-calc.

#### Mode nav

Horizontal tablist:

- `role="tablist"` / `role="tab"` / `aria-selected`.
- Active: brand underline (2px) + brand text; inactive muted.
- Do not use filled pill clusters for every mode.

---

## 4. Screen-by-screen specs

Each polish bullet carries a **Priority** and PLAN **ID** where applicable.
Behavior already shipped is marked **Shipped** (not open backlog).

### 4.1 Calc (oracle mode)

**Purpose:** Answer damage for arbitrary gen/sets; R&B overlays apply when
relevant.

**Layout regions (desktop):**

```text
┌ Shell brand + MODE NAV (Calc active) + theme ─────────────┐
│ Context: [Oracle · multi-gen] Gen picker · notation · fn  │
├───────────────────────────────────────────────────────────┤
│ Move results L/R                     Main result + rolls  │
├─────────────┬───────────────────────┬─────────────────────┤
│ Pokémon 1   │  Field / mid          │  Pokémon 2          │
│ (dense)     │                       │  (dense)            │
└─────────────┴───────────────────────┴─────────────────────┘
│ Optional sticky footer hop: “Send panels → Sets / Battle” │
```

| Priority | ID | Polish / open work |
| --- | --- | --- |
| Shipped | — | Dense columns, move buttons, field checkboxes, select2, result math |
| Shipped | — | Gen default **8**; title wordmark “Run & Bun Damage Calc” |
| Shipped | TW-01 | **Trainer Wheel** (`#trainer-mons`): prev/next + trainer name; opposing party slots front-and-center; default opponent **Youngster Calvin** (set index 0); Truck resets to Calvin; feeds `CURRENT_TRAINER_POKS` → Sets/Bridge |
| Shipped | UI-SP-01 | Spacing pass: shell / fieldsets / AI / Battle / Trainer Wheel use `--rb-space-*` rhythm (no second visual system) |
| P0 | UI-V0 | Token variables available to shell (no guts rewrite) |
| P1 | UI-V1 | Shell mode nav; oracle chip; hash `#calc` |
| P1 | UI-V1 | Sticky/footer hop copy “Send panels → Sets / Battle” (explicit) |
| P1 | UI-V1 | Honesty subtext under brand; gen-picker note (oracle-only) |
| P1 | UI-V2b | ~~Calc columns / fieldsets / results / import restyled to stadium tokens~~ **Done** (density kept; not PARK-09) |
| Park | PARK-09 | Full visual rewrite of every Smogon control / SPA migration |

**Trainer Wheel (named component):** Under Pokémon 2, the opposing-team
region is the **Trainer Wheel** — browse Run & Bun trainers with Prev/Next,
read the selected trainer name, and pick any party slot into the p2 calc.
The party board is a fixed **2×3 grid** (six evenly sized slots); unused
slots render empty when the trainer has fewer than six Pokémon. Filled
slots show sprites (active slot highlighted). Selection updates the
calc opponent and the trainer party used by “Include opposing trainer party”
on the Sets → BattleState bridge. AI Debug sample fixtures stay unchanged.

**Empty / loading / error:** Keep existing “Loading…” labels; no new empty
state art. Calc errors stay local to inputs. (**Shipped**)

**Mobile:** Horizontal scroll or stacked columns acceptable; mode nav wraps
(**P1** UI-V1).

---

### 4.2 Sets / Bridge

**Purpose:** Author path from calc/trainer sets → validated Gen 8 zero-EV
`BattleState`.

**Layout regions:**

```text
┌ Shell · Sets active · [Gen 8] [Zero EV] chips ────────────┐
│ Honesty: Gen 8 only · EVs forced 0 for AI projections     │
├───────────────────────────────────────────────────────────┤
│ Source options: panels · team bench · trainer party       │
│ Actions: Load from calc · Validate                        │
├───────────────────────────────────────────────────────────┤
│ Preview (P2 SET-01): party IDs / species / HP             │
│ (today lives inside AI Debug bridge block)                │
└───────────────────────────────────────────────────────────┘
```

| Priority | ID | Polish / open work |
| --- | --- | --- |
| Shipped | — | Load from calc / Validate; Gen 8 + Zero EV callouts; benches |
| P1 | UI-V1 | Stable `id="sets-bridge"`; product nav scrolls here |
| P1 | UI-V2 | Retoken warn callouts / buttons to R&B tokens |
| P2 | SET-01 | Party preview (IDs / species / HP); elevated IA |
| P2 | SET-01 | Empty: “No panel species loaded” in status (not silent) |
| P2 | SET-01 | Error: HTTP 400 path/message from validate JSON |
| Park | PARK-10 | Dedicated builder + R&B set packs beyond bridge |

**Honesty placement:** Top of section, always visible (not behind `<details>`).
(**Shipped** copy; **P1** UI-V2 restyle)

---

### 4.3 AI Debug

**Purpose:** Inspect ranked legal actions; drive derive→apply→advance; edit
JSON; explain MVP (expand row).

**Layout regions:**

```text
┌ Shell · AI Debug · [Gen 8] [Modeled slice] [Thin client] ─┐
│ Honesty note (scope paragraph)                            │
├─ Sets bridge (or hop link) ───────────────────────────────┤
├─ Toolbar: scenario · fixture · export · side · switches   │
│           [Evaluate] [Choose] [Derive→Apply→Advance] …    │
├─ Structured fields · Actives HP ──────────────────────────┤
├─ BattleState JSON (raw) ──────────────────────────────────┤
├─ Status line ─────────────────────────────────────────────┤
└─ Ranked actions (expand → Explain: engine ↔ policy doc) ─┘
```

| Priority | ID | Polish / open work |
| --- | --- | --- |
| Shipped | — | Evaluate/choose/loop; fixtures load/export; structured fields; explain MVP + citations; honesty scope |
| Shipped | EXP-01 | Side-by-side doc panel (≥24em on wide); damage/KO/speed/status/setup buckets; no browser scoring |
| Shipped | EXP-02 | Citation map audit for top reason phrases |
| P0 | FIX-01 | Curated named scenario inventory (docs → UI list) |
| P0 | FIX-02 | Fixture browser: pick → load → validate |
| P1 | FIX-03 | Golden eval snapshot format + regenerate path |
| P1 | FIX-04 | Golden compare in status line (facts/reasons only) |
| P1 | UI-V1 | Mode chips + shell framing |
| P1 | UI-V2 | Retoken panels; toolbar **Load** \| **Decide** \| **Step** clusters |
| P1 | UI-V2 | Empty/loading/error restyle (copy already present) |
| P3 | EXP-03 | Optional quiz / “spot the score” scenarios |
| P3 | UI-V4 | Top-level Explain mode chrome (if split from Debug) |

**Honesty placement:** `.ai-panel-scope` at top — keep wording; restyle to
`--rb-warn-*` (**P1** UI-V2).

---

### 4.4 Singles Battle

**Purpose:** Practice-vs-policy turn loop; same HTTP as Debug; human field.

**Layout regions:**

```text
┌ Shell · Battle · [Gen 8 Singles] [Modeled slice] ─────────┐
│ Honesty help                                               │
├─ Summary: turn · weather/terrain chips · forced flag ─────┤
├─────────────── Field ─────────────────────────────────────┤
│  AI active card          │  Player active card            │
│  species · ability/item  │  species · ability/item        │
│  HP bar + text           │  HP bar + text                 │
│  status / volatiles      │  status / volatiles            │
├─ Forced switch banner (when pendingForcedSwitchIds) ──────┤
├─ Load row · Decide/Step row                               ┤
├─ Legal actions list                                       ┤
├─ <details> BattleState JSON </details>  (default open desktop, closed mobile)
└─ Status line ─────────────────────────────────────────────┘
```

| Priority | ID | Polish / open work |
| --- | --- | --- |
| Shipped | — | Turn loop over HTTP; actives; forced switch; import hops; honesty help |
| P1 | UI-V1 | Shell + Gen 8 Singles / Modeled slice chips |
| P1 | UI-V2 | Retoken action list, status, primary buttons |
| P2 | UI-V3 | Active cards polish; summary chips; forced banner `role="alert"` |
| P2 | UI-V3 | Mobile: JSON `<details>` closed by default |
| P2 | ACC-01 | ~~A11y: focus order, not color-only forced-switch~~ **Done** |
| P3 | BAT-01 | “Open in AI Debug” reverse import |
| P2 | DBL-01 | ~~Doubles layout sketch (Battle viewer; keep Singles path)~~ **Done** |
| P3 | DBL-02 | ~~Doubles targeting + smoke~~ **Done** |
| P3 | RPL-01 | ~~Replay scrubber~~ **Done** (`#runbun-replay`) |
| Park | PARK-07 | Live ladder / Showdown protocol look-and-feel |

**Forced switch:** Banner lists pending IDs; restrict visible actions to legal
replacements from evaluate; primary CTA “Apply replacement”. (**Shipped**
behavior; **P2** UI-V3 polish)

---

### 4.5 My Run (playthrough)

The panel is designed for the run's END STATE, not its first route: a box of
60+, several lost, 44 milestones, 362 battles. Every component states which of
those scales it serves.

| Component | Serves | Design |
| --- | --- | --- |
| Story spine | 362 battles → 44 milestones | One tick per milestone; beaten = brand fill, next = action outline, split-ending bosses taller than story bosses; names in tooltips, note line names only the next. "Where am I" answered without reading. |
| Boss tiers & caps | Hardcap pacing | Three profile-declared patterns: `BOSS` (badges/E4/Champion — end splits, name the header's "Brawly split (1/18)"), `STORY_BOSS` (rivals, every Aqua/Magma admin fight, Archie, Maxie, Wally, Steven, both Chelle fights, Dumbass Soupercell). The level cap is the ace of the next fight in EITHER tier — a fresh run caps at 12 (Petalburg Woods grunt's Croagunk), not Brawly's 21. Road-ahead rows badge `boss`/`story`; filler is unbadged. |
| Road ahead | 25 fights between gyms | Bordered list (same grammar as ranked actions); any row markable **Beaten**, which moves the run past everything before it — one click per route, not per trainer. Per-row **Plan**. |
| Party strip | Lead order matters | Six visible slots, lead first; built by clicking (+/−) in the box, reordered with ▲. Click order IS lead order. A `<select multiple>` cannot express order — jQuery returns DOM order — which made the lead silently always the earliest catch. Never reintroduce it. |
| Box | 60+ entries, permadeath | Counts bar (`N alive · M lost`), substring filter (a view, never a command), party pinned on top in lead order, the lost below a `lost` divider — in the record, out of the working set. `at cap` chip when a mon meets the run's cap. |
| Catch flow | One per route | Encounter click fills the form, never catches — a misclick must not become a box entry. Refusals quote the route's real roster. |

Rules the panel keeps: thin client (all rules server-side), persist only what
the server accepted, `hidden` attribute + `#runbun-run [hidden]` guard (two
bugs have come from fighting it), and the run lives in `localStorage` only.

## 5. Interaction flows

### 5.1 Evaluate → choose → apply → advance

```text
[Edit/load BattleState]
        │
        ▼
   Validate (optional but encouraged)
        │
        ▼
   Evaluate ──► ranked list (deterministic)
        │
        ├─► user selects row
        │         │
        │         ▼
        │      Apply selected ──► derive → apply (server)
        │         │
        └─► Choose (sampled) ──► selection highlighted
                  │
                  ▼
             Advance turn ──► residuals slice (server)
                  │
                  ▼
             Refresh field / JSON from response
```

**UI rules:**

- Evaluate never mutates state.
- Apply and Advance require server success before replacing display JSON.
- Buttons disabled while `aria-busy`; errors leave prior state visible.
- Debug loop button = Choose → derive → apply → advance convenience; Battle
  loop button matches.

### 5.2 Load from calc

```text
Calc panels (#p1 player, #p2 ai) [+ optional benches]
        │
        ▼
 sets_to_battle_state.js (client adapter only — not a battle engine)
        │
        ▼
 Gen 8 + zero-EV BattleState into AI Debug and/or Battle textarea
        │
        ▼
 POST /ai/validate-battle-state
        │
        ├─ ok → flash Gen8 / Zero EV callouts; status success
        └─ 400 → status error; do not claim loaded
```

### 5.3 Forced switch

```text
State has pendingForcedSwitchIds
        │
        ▼
 Banner visible; Evaluate with side that must replace
        │
        ▼
 User picks legal switch action → Apply
        │
        ▼
 Server clears pending / updates actives → Refresh field
```

Do not invent replacement choice in the browser.

### 5.4 Cross-mode import

- **AI Debug → Battle:** copy validated JSON; Battle refreshes field. (**Shipped**)
- **Battle → AI Debug:** reverse copy for deep explain. (**P3** BAT-01)

---

## 6. Upstream-calc-like vs R&B chrome

| Stays upstream-calc-like | Gets R&B chrome |
| --- | --- |
| Pokémon/move/field column markup | App shell + mode nav |
| Result move button groups | Brand wordmark + subtext |
| Gen / notation / One-vs-One radios (inside Calc) | Fidelity chips (Oracle vs Gen 8 modeled) |
| select2, bootstrap remnants in calc | AI Debug / Battle / Bridge panels |
| Damage rolls / main result typography (phase 1) | Action lists, HP bars, honesty callouts |
| Credits lineage line | Tokenized buttons/status on R&B rails |
| Dark theme toggle mechanism | Token-mapped dark palette for R&B regions |

**Principle:** If a control answers “what damage if this hits?”, it stays calc.
If it answers “what would the AI do / what happens this turn?”, it gets full
R&B visual treatment.

---

## 7. Accessibility

**Shipped (ACC-01).** Checklist for R&B rails:

- Mode nav: tabs or landmark + skip link “Skip to mode content”. ✅
- All icon-less status must include text. ✅
- Focus ring `--rb-focus`; never `outline: none` without replacement. ✅
- Forced-switch banner: `role="alert"` when it appears. ✅
- JSON textareas: labeled; structured fields associate `<label for>`. ✅
- Color contrast: body text on surface ≥ 4.5:1; brand on brand-soft checked
  (`--rb-brand-ink` / `--rb-warn-ink`). ✅
- Prefers-reduced-motion: flash callouts become static border emphasize. ✅

---

## 8. Responsive behavior

| Breakpoint | Behavior |
| --- | --- |
| ≥ 1100px | Shell single row; Battle field 2-col; AI Debug full width ≤ 56–64em |
| 700–1099px | Mode nav wraps; Battle field 2-col if possible; calc may scroll-x |
| < 700px | Mode nav scroll-x; Battle field stacks; JSON `<details>` closed; primary
  button rows wrap; calc density preserved via scroll |

Touch targets for R&B primary buttons ≥ 36px height.

---

## 9. Phased visual rollout

Every phase has an explicit **Priority** and PLAN **ID**. Product fixture work
(FIX-*) is not a visual phase but is **P0** ahead of V2+ polish — see
[`PLAN.md`](PLAN.md) §0.

| Priority | Phase | ID | Scope | Done when |
| --- | --- | --- | --- | --- |
| **P0** | **V0 — Tokens** | UI-V0 | Link `src/css/runbun-tokens.css`; document tokens (this file); wire to `:root` / theme without restyling calc guts | Variables exist; dark/light pairs usable |
| **P1** | **V1 — Shell nav** | UI-V1 | Brand row + product mode nav + context chips + hash show/hide or scroll; `#sets-bridge` | Modes feel framed; Calc still dense |
| **P1** | **V2 — R&B panel polish** | UI-V2 | Retoken AI Debug, Bridge, Battle (buttons, callouts, status, action rows, HP) | Bolted-on feel reduced; honesty chips visible |
| **P1** | **V2b — Full-page unify** | UI-V2b | Restyle calc page guts onto tokens (surfaces, fieldsets, selects, results, import); shell CSS after dark-theme | One product field; calc density preserved |
| **P2** | **V3 — Battle field polish** | UI-V3 | Active cards, summary chips, forced banner, mobile JSON collapse | Singles viewer reads as match UI, still thin client |
| **P2** | **A11y pass** | ACC-01 | ~~Focus, live regions, contrast on R&B rails (§7)~~ **Done** | §7 checklist satisfied for shell/Debug/Battle |
| **P3** | **V4 — Later modes** | UI-V4 | Explain top-level chrome, Doubles chrome, Replay scrubber visuals | Per EXP-01 / DBL-02 / RPL-01 done-when in PLAN |

**Parallelism:** Do **not** block FIX-01/02 (fixture browser) on V2+. V0 can
proceed in parallel with FIX-*; V1 after or beside FIX-02. V3+ waits until
Singles MVP polish is the product focus (after fixtures feel solid).

---

## 10. Explicit non-goals (**Park**)

| Priority | ID | Non-goal |
| --- | --- | --- |
| Park | PARK-09 | Full visual rewrite of every Smogon calc control in one pass |
| Park | PARK-09 | Marketing landing hero, card grids, or dashboard stat strips on first paint |
| Park | PARK-07 | Browser battle engine, Showdown protocol client |
| Park | PARK-06 | Fog-of-war UI |
| Park | — | Claiming multi-gen R&B sim fidelity |
| Park | — | Purple/cream/broadsheet aesthetic clichés as the system |
| Park | — | Replacing IBM-adjacent stacks with Inter/Roboto as “the” brand font |
| Park | — | Toast spam / modal onboarding |
| Park | PARK-09 | Separate SPA framework migration (stay in existing `src/` JS) |
| Park | — | Hand-editing `dist/` |

---

## 11. Scaffolding & related docs

| Artifact | Role |
| --- | --- |
| **This file** | Canonical UI design + per-screen / V0–V4 priorities |
| [`RUNBUN_UX.md`](RUNBUN_UX.md) | Layer map + phase status (same P0–Park ranks) |
| [`PLAN.md`](PLAN.md) | **Master prioritized backlog (§0)** + roadmap |
| [`VALIDATION.md`](VALIDATION.md) | Engine/product completeness backlog (same ranks) |
| [`src/css/runbun-tokens.css`](src/css/runbun-tokens.css) | Token scaffolding (**P0** UI-V0) |
| Cursor Canvas `runbun-ui-design.canvas.tsx` | Interactive IA + token roles + wireframes |

Canvas path (Cursor-managed):

`C:\Users\ragop\.cursor\projects\c-Users-ragop-Documents-pokemon-agent\canvases\runbun-ui-design.canvas.tsx`

---

## 12. Copy deck (canonical short strings)

Use consistently:

- **Modeled slice, not a full sim.**
- **Gen 8 only** (AI / Battle / Bridge projection).
- **Zero EVs** for AI projections — panel EVs ignored.
- **Thin HTTP client** — scores/transitions from `server.js` → `ai/`.
- **Oracle · multi-gen** — Calc mode chip.
- **Caller-owned** — unmodeled residuals / accuracy edges / external events.

---

## 13. Implementer checklist (priority-ranked)

| Priority | ID | Step |
| --- | --- | --- |
| P0 | UI-V0 | Link `runbun-tokens.css` after `main.css`. |
| P0 | HYG-01 | Keep UI smoke green; no policy code in `src/`. |
| P1 | UI-V1 | Wrap page in `.rb-shell`; add mode `tablist`. |
| P1 | UI-V1 | Give Bridge block `id="sets-bridge"`. |
| P1 | UI-V1 | Add context chips per mode (do not remove honesty paragraphs). |
| P1 | UI-V2 | Map `.ai-panel-*` / `.runbun-battle-*` colors to tokens (no behavior change). |
| P1 | UI-V2b | ~~Unify calc columns onto stadium tokens; load shell after dark-theme.~~ **Done** |
| P0 | FIX-02 | Prefer fixture browser MVP before deep V3 field chrome. |

Master ordering and done-when: [`PLAN.md`](PLAN.md) §0 / §11.
