/* eslint-env node, es6 */
'use strict';

/**
 * Run & Bun — species and content deltas against Generation 8.
 *
 * Values here are reconciled against `dekzeh/runandbundex`, the hack author's own
 * pokeemerald-format ROM data dump — the game's numbers rather than a
 * description of them. All 1006 Generation 8 species whose names map cleanly
 * were compared against `species/base_stats.h` and every one agreed.
 *
 * That check is stronger than the earlier one against `dekzeh/calc`, and it
 * caught two errors the calculator comparison could not: Marill kept vanilla
 * 20/20 offences when Run & Bun buffs the whole Azumarill line to 35/35, and
 * Kleavor was ported in with 130 Attack / 75 Sp. Def against the ROM's 135/70.
 * The calculator agreed with us on both, so only the ROM data could settle them.
 *
 * This file is the DECLARATION of those deltas, not a copy kept in sync. It is
 * authored, not generated — regenerating it from `calc/src/data/` would make it
 * agree with whatever that data currently says, including a regression, which
 * is exactly the failure it exists to catch. `runbun_species.test.js` asserts
 * the calculator matches this declaration.
 */

/** Species that exist upstream but whose stats Run & Bun changes. */
const BASE_STAT_CHANGES = {
	// Run & Bun buffs the whole Azumarill line, not just the evolution.
	Marill: {at: 35, sa: 35},
	Azumarill: {at: 65, sa: 90},
	Diggersby: {at: 71},
};

/**
 * Species Run & Bun treats as not fully evolved that upstream Gen 8 does not.
 * Both gain Legends: Arceus evolutions (Wyrdeer, Ursaluna) that Run & Bun carries.
 */
const NOT_FULLY_EVOLVED = ['Stantler', 'Ursaring'];

/**
 * Species present in Run & Bun's Gen 8 that upstream Gen 8 does not have.
 *
 * Mostly Hisuian forms and Legends: Arceus additions. `Saharascal` is not from
 * any official game — it is Run & Bun original content and the single most
 * irreplaceable entry here.
 *
 * Full stat lines are pinned, not just names. An existence check would not have
 * caught Zoroark-Hisui shipping with the wrong base stats, which it did.
 */
const PORTED_SPECIES = {
	'Arcanine-Hisui': {types: ['Fire', 'Rock'], bs: {hp: 95, at: 115, df: 80, sa: 95, sd: 80, sp: 90}, ability: 'Intimidate'},
	'Avalugg-Hisui': {types: ['Ice', 'Rock'], bs: {hp: 95, at: 127, df: 184, sa: 34, sd: 36, sp: 38}, ability: 'Strong Jaw'},
	'Basculegion': {types: ['Water', 'Ghost'], bs: {hp: 120, at: 112, df: 65, sa: 80, sd: 75, sp: 78}, ability: 'Swift Swim'},
	'Basculegion-F': {types: ['Water', 'Ghost'], bs: {hp: 120, at: 92, df: 65, sa: 100, sd: 75, sp: 78}, ability: 'Swift Swim'},
	'Basculin-White-Striped': {types: ['Water'], bs: {hp: 70, at: 92, df: 65, sa: 80, sd: 55, sp: 98}, ability: 'Rattled', nfe: true},
	'Braviary-Hisui': {types: ['Psychic', 'Flying'], bs: {hp: 110, at: 83, df: 70, sa: 112, sd: 70, sp: 65}, ability: 'Keen Eye'},
	'Decidueye-Hisui': {types: ['Grass', 'Fighting'], bs: {hp: 88, at: 112, df: 80, sa: 95, sd: 95, sp: 60}, ability: 'Overgrow'},
	'Dialga-Origin': {types: ['Steel', 'Dragon'], bs: {hp: 100, at: 100, df: 120, sa: 150, sd: 120, sp: 90}, ability: 'Pressure'},
	'Electrode-Hisui': {types: ['Electric', 'Grass'], bs: {hp: 60, at: 50, df: 70, sa: 80, sd: 80, sp: 150}, ability: 'Aftermath'},
	'Enamorus': {types: ['Fairy', 'Flying'], bs: {hp: 74, at: 115, df: 70, sa: 135, sd: 80, sp: 106}, ability: 'Healer'},
	'Enamorus-Therian': {types: ['Fairy', 'Flying'], bs: {hp: 74, at: 115, df: 110, sa: 135, sd: 100, sp: 46}, ability: 'Overcoat'},
	'Floette-Eternal': {types: ['Fairy'], bs: {hp: 74, at: 65, df: 67, sa: 125, sd: 128, sp: 92}, ability: 'Flower Veil'},
	'Goodra-Hisui': {types: ['Steel', 'Dragon'], bs: {hp: 80, at: 100, df: 100, sa: 110, sd: 150, sp: 60}, ability: 'Gooey'},
	'Growlithe-Hisui': {types: ['Fire', 'Rock'], bs: {hp: 60, at: 75, df: 45, sa: 65, sd: 50, sp: 55}, ability: 'Intimidate', nfe: true},
	'Kleavor': {types: ['Bug', 'Rock'], bs: {hp: 70, at: 135, df: 95, sa: 45, sd: 70, sp: 85}, ability: 'Swarm'},
	'Lilligant-Hisui': {types: ['Grass', 'Fighting'], bs: {hp: 70, at: 105, df: 75, sa: 50, sd: 75, sp: 105}, ability: 'Chlorophyll'},
	'Overqwil': {types: ['Dark', 'Poison'], bs: {hp: 85, at: 115, df: 95, sa: 65, sd: 65, sp: 85}, ability: 'Intimidate'},
	'Palkia-Origin': {types: ['Water', 'Dragon'], bs: {hp: 90, at: 100, df: 100, sa: 150, sd: 120, sp: 120}, ability: 'Pressure'},
	'Qwilfish-Hisui': {types: ['Dark', 'Poison'], bs: {hp: 65, at: 95, df: 85, sa: 55, sd: 55, sp: 85}, ability: 'Intimidate', nfe: true},
	'Saharascal': {types: ['Ground'], bs: {hp: 50, at: 80, df: 65, sa: 45, sd: 90, sp: 70}, ability: 'Water Absorb', nfe: true},
	'Samurott-Hisui': {types: ['Water', 'Dark'], bs: {hp: 90, at: 108, df: 80, sa: 100, sd: 65, sp: 85}, ability: 'Torrent'},
	'Sliggoo-Hisui': {types: ['Steel', 'Dragon'], bs: {hp: 58, at: 75, df: 83, sa: 83, sd: 113, sp: 40}, ability: 'Gooey', nfe: true},
	'Sneasel-Hisui': {types: ['Fighting', 'Poison'], bs: {hp: 55, at: 95, df: 55, sa: 35, sd: 75, sp: 115}, ability: 'Inner Focus', nfe: true},
	'Sneasler': {types: ['Fighting', 'Poison'], bs: {hp: 80, at: 130, df: 60, sa: 40, sd: 80, sp: 120}, ability: 'Inner Focus'},
	'Typhlosion-Hisui': {types: ['Fire', 'Ghost'], bs: {hp: 73, at: 84, df: 78, sa: 119, sd: 85, sp: 95}, ability: 'Blaze'},
	'Ursaluna': {types: ['Ground', 'Normal'], bs: {hp: 130, at: 140, df: 105, sa: 45, sd: 80, sp: 50}, ability: 'Guts'},
	'Voltorb-Hisui': {types: ['Electric', 'Grass'], bs: {hp: 40, at: 30, df: 50, sa: 55, sd: 55, sp: 100}, ability: 'Aftermath', nfe: true},
	'Wyrdeer': {types: ['Normal', 'Psychic'], bs: {hp: 103, at: 105, df: 72, sa: 105, sd: 75, sp: 65}, ability: 'Intimidate'},
	'Zoroark-Hisui': {types: ['Normal', 'Ghost'], bs: {hp: 55, at: 100, df: 60, sa: 125, sd: 60, sp: 110}, ability: 'Illusion'},
	'Zorua-Hisui': {types: ['Normal', 'Ghost'], bs: {hp: 35, at: 60, df: 40, sa: 85, sd: 40, sp: 70}, ability: 'Illusion', nfe: true},
};

/**
 * Run & Bun reassigns which ability a species leads with.
 *
 * The calculator uses ability slot 0 as the default when a species is selected,
 * so a vanilla slot means it silently computes with an ability the game does not
 * give that Pokemon — Tyranitar defaulting to Sand Stream instead of Unnerve
 * changes the weather and the damage.
 *
 * All 998 comparable Generation 8 species now match `dekzeh/runandbundex`
 * (`species/base_stats.h`, first entry of `.abilities`). 125 of them were
 * vanilla before this was checked. The count is the seal: a species leaving or
 * joining the overlay moves it and fails the gate.
 *
 * Note this diverges from `dekzeh/calc`, the author's *calculator*, which
 * carries vanilla ability slots. The ROM dump is the stronger source — it is
 * the game rather than a tool's rendering of it — so the calculator comparison
 * could never have surfaced this.
 */
const ABILITY_SLOT_CHANGES = {
	speciesChanged: 125,
	verifiedAgainst: 'github.com/dekzeh/runandbundex — species/base_stats.h',
};

/** Items upstream Gen 8 has that Run & Bun does not. */
const REMOVED_ITEMS = ['Energy Powder'];

/**
 * Seal on the Run & Bun move overlay in `ai/src/move-metadata.ts`.
 *
 * Those tables were long the least verifiable thing in the project: the
 * calculator's move data carries no accuracy or PP field, so nothing internal
 * could check them, and they were transcribed from a community document nobody
 * here has read.
 *
 * They are now verified. `dekzeh/runandbundex` is a pokeemerald-format data
 * dump published by the hack's author, carrying `.power`, `.accuracy` and `.pp`
 * per move — the game's own numbers rather than a description of them. All 166
 * overlay entries were compared against it and every one agreed.
 *
 * The counts below are the seal. Adding an overlay entry changes a count and
 * fails the gate, which forces the new entry to be verified rather than
 * inheriting the confidence of the ones already checked.
 */
const MOVE_OVERLAY = {
	accuracyChanges: 136,
	basePowerChanges: 9,
	maxPpChanges: 21,
	/** Entries compared against the author's ROM data, all in agreement. */
	verifiedEntries: 166,
	verifiedAgainst: 'github.com/dekzeh/runandbundex — moves/battle_moves.h',
};

module.exports = {
	BASE_STAT_CHANGES,
	NOT_FULLY_EVOLVED,
	PORTED_SPECIES,
	REMOVED_ITEMS,
	MOVE_OVERLAY,
	ABILITY_SLOT_CHANGES,
};
