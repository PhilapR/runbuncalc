# Tasks

Recurring maintenance for the Run & Bun calculator. This is a standalone
product; procedures inherited from the upstream Smogon calculator do not apply
unless they are written down here.

## Set data

`src/js/data/sets/gen8.js` holds the **Run & Bun trainer parties** — authored
data keyed by trainer name, with an `index` field ordering each party. It is the
most Run & Bun-specific dataset in the repository and the Trainer Wheel reads it
directly.

Do **not** regenerate it from an upstream set source. The inherited `import/`
generator wrote all nine generations into `src/js/data/sets/` from
`@smogon/sets`, so running it replaced the trainer parties with Smogon
competitive usage sets. That generator has been removed; `runbun_sets.test.js`
now fails if the trainer data is ever overwritten that way.

To change trainer sets, edit `src/js/data/sets/gen8.js` directly, then:

1. `npm run build`
2. `npm test` — `runbun_sets.test.js` checks the data is still trainer-shaped
3. Load `#runbun-battle` and the Trainer Wheel in the browser and confirm the
   party board still renders

The remaining `sets/gen*.js` files are inherited Smogon usage sets for the
non-Run & Bun generations the calculator still exposes. They are not part of the
Run & Bun surface and are not regenerated.

## Run & Bun data overlays

Move-level Run & Bun changes (accuracy, base power, PP, type) live in the
fork-owned overlay at `ai/src/move-metadata.ts`. That overlay is authoritative
over the inherited calculator data — see `FORK_MAP.md`. When the two disagree,
`ai/src/test/runbun-data.test.ts` fails the build; fix the inherited data in
`calc/src/data/` and record the delta in the `FORK_MAP.md` Policy B table.

## Gen 9 coverage

Run & Bun is a Gen 8 game. If a future release ports Gen 9 content, regenerate
the coverage audit and work the resulting list:

```sh
npm run build && node scripts/audit-gen9-coverage.js
```

See `GEN9_AUDIT.md` for the current evidence and why GEN9-02 is Parked.

## Validation gate

`npm test` is the floor: `calc` → `ai` → build → `test:server` → UI lint. Keep
it green before merge. `npm run test:upstream` is a compatibility audit only and
is expected to fail where the fork intentionally diverges (Policy B).
