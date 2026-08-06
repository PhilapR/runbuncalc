# Run & Bun AI

`runbuncalc-ai` is the serializable Run & Bun battle-state and decision-policy
package built around the inherited `@smogon/calc` damage oracle.

The package owns state validation, legal action enumeration, action scoring,
move-resolution derivation, end-turn transitions, and switch-entry effects. It
does not mutate calculator objects or use calculator description strings as
machine-readable input. Callers provide or persist plain JSON-compatible
`BattleState` values and receive plain actions, facts, resolutions, or next
states.

## Run & Bun defaults

| Rule | Detail |
| --- | --- |
| Default generation | **8** for R&B modes, sample state, and the sets→BattleState bridge |
| EVs | AI calculator, order, accuracy, entry, and raw-stat projections use an **explicit zero EV map**. Optional EV fields may remain for transport; they must not change AI outcomes |
| Calc package | Remains EV-capable for OSS API compatibility |
| Multi-gen | Supported by the calculator oracle; not a claim of full R&B sim fidelity outside Gen 8 + documented overlays |

Product surfaces and phase status: [`../RUNBUN_UX.md`](../RUNBUN_UX.md).
Data model: [`../AI_DATA_MODEL.md`](../AI_DATA_MODEL.md).
Validation record: [`../VALIDATION.md`](../VALIDATION.md).

## Direct TypeScript usage

```ts
import {
  calculateActionFacts,
  evaluateActions,
  validateBattleState,
} from 'runbuncalc-ai';

validateBattleState(state);
const evaluations = evaluateActions(state, calculateActionFacts, 'ai', {
  includeSwitches: true,
});
```

Use `chooseStateAction()` when the policy should sample among the scored
outcomes. Use `evaluateActions()` when a caller needs deterministic candidates
for a UI, replay tool, or external decision layer.

## HTTP adapter

After the repository build, `node server.js` exposes the same policy through
JSON endpoints and serves the built calculator UI from `dist/`. Invalid
payloads return JSON `{error: string}` with HTTP **400**. Unexpected failures
return HTTP **500**.

Also available: `GET|POST /calculate` (damage oracle; not an AI route).

### Endpoint list

| Method | Path | Request (at a glance) | Success response |
| --- | --- | --- | --- |
| `POST` | `/ai/validate-battle-state` | `{state}` (or bare `BattleState`) | `{ok: true}` |
| `POST` | `/ai/evaluate-actions` | `{state, options?}` | `{evaluations}` |
| `POST` | `/ai/choose-action` | `{state, options?}` | `{action, selectedScore, evaluations}` |
| `POST` | `/ai/derive-resolution` | `{state, action, facts?, hit?, accuracy?, secondaryEffects?}` | `MoveResolution` |
| `POST` | `/ai/apply-action` | `{state, action, resolution?}` | next `BattleState` |
| `POST` | `/ai/derive-end-turn` | `{state}` | `EndTurnResolution` |
| `POST` | `/ai/advance-turn` | `{state}` | next `BattleState` (turn advanced) |
| `POST` | `/ai/derive-switch-entry` | `{state, action}` (`action.kind === "switch"`) | `SwitchEntryResolution` |
| `POST` | `/ai/forced-switch-actions` | `{state, sideId?}` (`"ai"` \| `"player"`, default `"ai"`) | `{actions}` |
| `POST` | `/ai/order-actions` | `{state, actions, itemRollsByPokemon?}` | `{actions}` (ordered) |

Bare `BattleState` bodies (without a `state` wrapper) are accepted where noted
for convenience; prefer `{state: …}` for new clients.

### Shared shapes

**`BattleState` (required fields at the HTTP boundary):**

```json
{
  "generation": 8,
  "mode": "Singles",
  "turn": 1,
  "field": {},
  "sides": {
    "ai": {"activeIds": ["ai-1"], "party": [/* PokemonState… */]},
    "player": {"activeIds": ["player-1"], "party": [/* PokemonState… */]}
  }
}
```

Party members need stable `id`, `species`, `level`, `hp: {current, max}`, and
`moves`. Full field contracts: `AI_DATA_MODEL.md` / `validateBattleState()`.

**`options` (evaluate / choose):**

| Field | Meaning |
| --- | --- |
| `sideId` | `"ai"` (default) or `"player"` |
| `includeSwitches` | Include voluntary switches when legal |
| `viableReplacementIds` | Optional party-ID list |
| `replacementViability` | Optional `{[id]: {faster, notOHKOd, not2HKOd}}` |
| `deriveReplacementViability` | Default `true`; set `false` to skip auto derivation |
| `replacementScores` | Optional `{[id]: number}` ranking for replacements / switch success branch |

**`Action`:** `kind: "move"` with `actorId`, `moveName`, `targetIds[]`, or
`kind: "switch"` with `actorId`, `replacementId` (optional `forced`,
`batonPass`, …).

**Move apply rule:** move actions **require** `resolution`; switch actions
**must omit** `resolution`.

### Minimal examples

Validate only:

```http
POST /ai/validate-battle-state
Content-Type: application/json

{"state": { "generation": 8, "mode": "Singles", "turn": 1, "field": {}, "sides": { … } }}
```

```json
{"ok": true}
```

Evaluate (deterministic):

```http
POST /ai/evaluate-actions
Content-Type: application/json

{"state": { … }, "options": {"sideId": "ai", "includeSwitches": true}}
```

```json
{"evaluations": [{"action": {…}, "outcomes": […], "facts": {…}}, …]}
```

Choose (samples among scored outcomes):

```http
POST /ai/choose-action
Content-Type: application/json

{"state": { … }, "options": {"sideId": "ai"}}
```

```json
{"action": {…}, "selectedScore": 0, "evaluations": […]}
```

Debug turn slice (typical UI loop):

1. `POST /ai/choose-action` or `/ai/evaluate-actions`
2. `POST /ai/derive-resolution` with `{state, action}` (optional `hit` / `facts`)
3. `POST /ai/apply-action` with `{state, action, resolution}`
4. `POST /ai/advance-turn` with `{state}` (applied next state)

### Browser client

The **Run & Bun AI Debug** panel (`#ai-panel`) on the main calculator page is a
thin HTTP client for evaluate/choose (plus an optional derive→apply→advance
debug step). It also:

- Emits a Gen 8 `BattleState` from the current calc panels / trainer sets
  (`sets_to_battle_state.js`) with Gen 8 / zero-EV callouts
- Validates via `/ai/validate-battle-state`
- Loads sample scenarios or fixture JSON files and exports current state
- Offers a thin structured editor (generation / mode / turn / active HP)
  alongside raw JSON
- Expands ranked rows for score reasons, ActionFacts, and policy-doc citations
  into `../run_and_bun_ai.MD` (no `kochance` / calc-string parsing)
- Labels the **modeled slice** vs caller-owned external gaps in panel copy

The **Singles Battle Turn Viewer** (`#runbun-battle`, `battle_turn_viewer.js`)
is a sibling thin client over the same AI HTTP loop: display actives →
evaluate/choose → apply (derive→apply) → advance, plus forced-switch samples
and import from AI Debug / calc panels. Neither panel embeds a second battle
model. Invalid payloads surface the API's JSON HTTP 400 body in the status line.

Smoke coverage: `npm run test:server` (includes validate-battle-state and the
critical AI routes above).

## Ownership

Keep generic damage mechanics in `calc/`, Run & Bun policy and transitions in
`ai/`, transport in `server.js`, and presentation in `src/`. See the repository
[fork map](../FORK_MAP.md), [data model](../AI_DATA_MODEL.md), and
[validation record](../VALIDATION.md) before adding a mechanic.
