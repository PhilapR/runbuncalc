/* eslint-env node, es6 */
'use strict';

/**
 * Run & Bun species and item identity gate.
 *
 * `calc/src/data/` is inherited from the upstream Smogon calculator, but the
 * fork's copy is not a pristine one: Run & Bun changes base stats, adds species
 * that upstream Gen 8 does not have, changes which species are fully evolved,
 * and drops an item. Those edits are the product, yet nothing asserted them —
 * `FORK_MAP.md` listed a single species delta (Azumarill) while the Gen 8 data
 * actually carries 54.
 *
 * This file is the fork-owned statement of that identity. It is authored to
 * express intent, not snapshotted from the data, so regenerating it cannot
 * silently bless a regression. Everything below was verified once against a
 * pristine `@smogon/calc@0.7.0` — the same version the fork carries — so the
 * list is the real delta set rather than upstream version drift.
 *
 * Move-level Run & Bun data is deliberately NOT duplicated here. That surface
 * is owned by the overlay in `ai/src/move-metadata.ts` and gated by
 * `ai/src/test/runbun-data.test.ts`; adding a second source of truth for it
 * would create exactly the split those files exist to prevent.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

// Assert the data tables directly rather than through `Generations.get()`. The
// runtime wrapper renames base stats (`at` -> `atk`) and does not surface
// `nfe`, and it is the tables themselves that a bad regeneration would damage.
const SPECIES = require('./calc/dist/data/species.js').SPECIES;
const ITEMS = require('./calc/dist/data/items.js').ITEMS;

/** The generation the Run & Bun product targets. */
const RUNBUN_GEN = 8;

/**
 * Base stats Run & Bun changes on species that already exist upstream.
 * Only the changed stats are listed; everything else must stay upstream.
 */
const BASE_STAT_CHANGES = {
  Azumarill: {at: 65, sa: 90},
  Diggersby: {at: 71},
};

/**
 * Species Run & Bun treats as not-fully-evolved that upstream Gen 8 does not.
 * Both gained evolutions in Legends: Arceus (Wyrdeer, Ursaluna), which Run &
 * Bun carries.
 */
const NOT_FULLY_EVOLVED = ['Stantler', 'Ursaring'];

/**
 * Species present in the fork's Gen 8 data but absent from upstream Gen 8.
 *
 * Almost all are Hisuian forms and Legends: Arceus additions. `Saharascal` is
 * not from any official game — it is Run & Bun original content, and the most
 * irreplaceable single entry in this file.
 */
const PORTED_SPECIES = [
  'Arcanine-Hisui', 'Avalugg-Hisui', 'Basculegion', 'Basculegion-F',
  'Basculin-White-Striped', 'Braviary-Hisui', 'Decidueye-Hisui', 'Dialga-Origin',
  'Electrode-Hisui', 'Enamorus', 'Enamorus-Therian', 'Floette-Eternal',
  'Goodra-Hisui', 'Growlithe-Hisui', 'Kleavor', 'Lilligant-Hisui', 'Overqwil',
  'Palkia-Origin', 'Qwilfish-Hisui', 'Saharascal', 'Samurott-Hisui',
  'Sliggoo-Hisui', 'Sneasel-Hisui', 'Sneasler', 'Typhlosion-Hisui', 'Ursaluna',
  'Voltorb-Hisui', 'Wyrdeer', 'Zoroark-Hisui', 'Zorua-Hisui',
];

/** Run & Bun original species: assert the full stat line, not just presence. */
const SAHARASCAL = {
  types: ['Ground'],
  bs: {hp: 50, at: 80, df: 65, sa: 45, sd: 90, sp: 70},
  abilities: {0: 'Water Absorb'},
  nfe: true,
};

/** Items upstream Gen 8 has that Run & Bun does not. */
const REMOVED_ITEMS = ['Energy Powder'];

const species = SPECIES[RUNBUN_GEN];
const items = ITEMS[RUNBUN_GEN];

test('Run & Bun base stat changes are present', () => {
  for (const name of Object.keys(BASE_STAT_CHANGES)) {
    assert.ok(species[name], `${name} is missing from Gen ${RUNBUN_GEN} species data`);
    for (const stat of Object.keys(BASE_STAT_CHANGES[name])) {
      assert.equal(
        species[name].bs[stat],
        BASE_STAT_CHANGES[name][stat],
        `${name} base ${stat} is not the Run & Bun value`
      );
    }
  }
});

test('Run & Bun evolution changes are present', () => {
  for (const name of NOT_FULLY_EVOLVED) {
    assert.ok(species[name], `${name} is missing from Gen ${RUNBUN_GEN} species data`);
    assert.equal(species[name].nfe, true, `${name} should be not-fully-evolved in Run & Bun`);
  }
});

test('Species Run & Bun ports into Gen 8 are present', () => {
  const missing = PORTED_SPECIES.filter(name => !species[name]);
  assert.deepEqual(
    missing,
    [],
    `Run & Bun species missing from Gen ${RUNBUN_GEN} data: ${missing.join(', ')}. ` +
    'These are not upstream content; if they are gone the fork data has been ' +
    'overwritten from an upstream source.'
  );
});

test('Saharascal keeps its Run & Bun original stat line', () => {
  const saharascal = species['Saharascal'];
  assert.ok(saharascal, 'Saharascal is missing — this species exists in no official game');
  assert.deepEqual(saharascal.types, SAHARASCAL.types);
  assert.deepEqual(saharascal.bs, SAHARASCAL.bs);
  assert.equal(saharascal.abilities[0], SAHARASCAL.abilities[0]);
  assert.equal(saharascal.nfe, SAHARASCAL.nfe);
});

test('Items Run & Bun removes stay absent', () => {
  const present = REMOVED_ITEMS.filter(item => items.includes(item));
  assert.deepEqual(present, [], `items removed by Run & Bun are back: ${present.join(', ')}`);
});
