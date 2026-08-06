import {
  MoveCategory,
  StatBoosts,
  StatusName,
  Terrain,
  VolatileStatusName,
  Weather,
} from './model';

/**
 * Static move/item lookup tables used by the move engine.
 *
 * Data only: no state, no calculator calls, no policy. Split out of
 * `move-engine.ts` so the resolution logic reads as logic.
 */

export const WEATHER_BY_SETTER: Record<string, Weather> = {
  raindance: 'Rain', sunnyday: 'Sun', sandstorm: 'Sand', hail: 'Hail', snowscape: 'Snow', chillyreception: 'Snow',
};
export const TERRAIN_BY_SETTER: Record<string, Terrain> = {
  electricterrain: 'Electric', grassyterrain: 'Grassy', psychicterrain: 'Psychic', mistyterrain: 'Misty',
};
export const WEATHER_SETTER_MIN_GENERATION: Record<string, number> = {
  raindance: 2, sunnyday: 2, sandstorm: 2, hail: 3, snowscape: 9, chillyreception: 9,
};
export const FLING_ITEM_STATUSES: Record<string, StatusName> = {
  flameorb: 'brn', lightball: 'par', poisonbarb: 'psn', toxicorb: 'tox',
};
export const FLING_ITEM_VOLATILES: Record<string, VolatileStatusName> = {
  kingsrock: 'flinch', razorfang: 'flinch',
};
export const FLING_CONFUSION_BERRIES = new Set(['aguavberry', 'figyberry', 'iapapaberry', 'magoberry', 'wikiberry']);
export const FLING_STAT_BERRIES: Record<string, keyof StatBoosts> = {
  liechiberry: 'atk', ganlonberry: 'def', salacberry: 'spe', petayaberry: 'spa', apicotberry: 'spd',
};
export const FLING_RANDOM_BOOST_STATS: Array<keyof StatBoosts> = ['atk', 'def', 'spa', 'spd', 'spe'];
export const MENTAL_HERB_VOLATILES: VolatileStatusName[] = [
  'infatuated', 'taunt', 'encore', 'torment', 'disable', 'healBlock',
];

export const SELF_BOOSTS: Record<string, StatBoosts> = {
  acidarmor: {def: 2}, agility: {spe: 2}, amnesia: {spd: 2}, autotomize: {spe: 2}, barrier: {def: 2},
  bulkup: {atk: 1, def: 1}, calmmind: {spa: 1, spd: 1}, chargebeam: {spa: 1},
  charge: {spd: 1}, coil: {atk: 1, def: 1, acc: 1}, cosmicpower: {def: 1, spd: 1}, cottonguard: {def: 3},
  defensecurl: {def: 1}, doubleteam: {eva: 1},
  dragondance: {atk: 1, spe: 1}, growth: {atk: 1, spa: 1}, harden: {def: 1}, howl: {atk: 1},
  honeclaws: {atk: 1, acc: 1}, irondefense: {def: 2}, meditate: {atk: 1}, nastyplot: {spa: 2},
  minimize: {eva: 2},
  poweruppunch: {atk: 1}, quiverdance: {spa: 1, spd: 1, spe: 1}, rockpolish: {spe: 2},
  sharpen: {atk: 1}, shiftgear: {atk: 1, spe: 2}, swordsdance: {atk: 2}, tailglow: {spa: 3},
  withdraw: {def: 1}, workup: {atk: 1, spa: 1}, stockpile: {def: 1, spd: 1}, shelter: {def: 2},
  takeheart: {spa: 1, spd: 1}, defendorder: {def: 1, spd: 1},
  extremeevoboost: {atk: 2, def: 2, spa: 2, spd: 2, spe: 2},
};

export const STAT_STAGE_MOVE_GENERATIONS: Record<string, number> = {
  charge: 3, sweetscent: 2, sweetspore: 2, scaryface: 2, cottonspore: 2,
  featherdance: 3, metalsound: 3, tickle: 3, captivate: 4, babydolleyes: 6,
  confide: 6, nobleroar: 6, playnice: 6, toxicthread: 7, tearfullook: 7, tarshot: 8,
  shelter: 9, takeheart: 9, spicyextract: 9, defendorder: 4, extremeevoboost: 7, aromaticmist: 6,
};

export const TARGET_BOOSTS: Record<string, StatBoosts> = {
  babydolleyes: {atk: -1}, captivate: {spa: -2}, confide: {spa: -1}, cottonspore: {spe: -2},
  growl: {atk: -1}, leer: {def: -1},
  tailwhip: {def: -1}, charm: {atk: -2},
  scaryface: {spe: -2}, sandattack: {acc: -1}, smokescreen: {acc: -1}, flash: {acc: -1},
  kinesis: {acc: -1}, sweetscent: {eva: -2}, sweetspore: {eva: -2}, featherdance: {atk: -2}, metalsound: {spd: -2},
  stringshot: {spe: -2}, tickle: {atk: -1, def: -1}, tearfullook: {atk: -1, spa: -1},
  nobleroar: {atk: -1, spa: -1}, playnice: {atk: -1}, toxicthread: {spe: -1}, tarshot: {spe: -1},
  faketears: {spd: -2}, screech: {def: -2}, eerieimpulse: {spa: -2},
  snarl: {spa: -1}, strugglebug: {spa: -1}, skittersmack: {spa: -1},
  tropkick: {atk: -1}, lunge: {atk: -1}, breakingswipe: {atk: -1}, icywind: {spe: -1},
  electroweb: {spe: -1}, rocktomb: {spe: -1}, mudshot: {spe: -1}, lowsweep: {spe: -1},
  acidspray: {spd: -2},
  swagger: {atk: 2}, flatter: {spa: 1}, spicyextract: {atk: 2, def: -2}, aromaticmist: {spd: 1},
};

export const STATUS_BY_MOVE: Record<string, StatusName> = {
  toxic: 'tox', poisonpowder: 'psn', poisongas: 'psn', toxicthread: 'psn', willowisp: 'brn', thunderwave: 'par', glare: 'par',
  nuzzle: 'par', stunspore: 'par', spore: 'slp', sleeppowder: 'slp', hypnosis: 'slp',
  sing: 'slp', lovelykiss: 'slp', darkvoid: 'slp', grasswhistle: 'slp',
};

export const RECOVERY_MOVES = new Set([
  'healorder', 'milkdrink', 'moonlight', 'morningsun', 'recover', 'roost', 'shoreup',
  'slackoff', 'softboiled', 'synthesis',
]);
export const HEAL_BLOCKED_MOVES = new Set([
  'floralhealing', 'healorder', 'healingwish', 'healpulse', 'junglehealing', 'lifedew',
  'lunardance', 'milkdrink', 'moonlight', 'morningsun', 'purify', 'recover', 'rest',
  'roost', 'shoreup', 'slackoff', 'softboiled', 'strengthsap', 'swallow', 'synthesis', 'wish',
]);

export const DELAYED_DAMAGE_MOVES = new Set(['futuresight', 'doomdesire']);
export const RAMPAGE_MOVES = new Set(['outrage', 'thrash', 'petaldance', 'ragingfury']);
export const SHELL_TRAP_MIN_GENERATION = 7;
export const PROTECTIVE_MOVES = new Set([
  'protect', 'detect', 'kingsshield', 'wideguard', 'quickguard', 'matblock',
  'banefulbunker', 'spikyshield', 'silktrap', 'obstruct', 'burningbulwark',
  'maxguard',
]);
export const CONSECUTIVE_PROTECTIVE_MOVES = new Set(Array.from(PROTECTIVE_MOVES).concat('endure'));
export const FIRST_TURN_MOVE_MIN_GENERATION: Record<string, number> = {
  fakeout: 3,
  firstimpression: 7,
};

export const RECOIL: Record<string, [number, number]> = {
  bravebird: [33, 100], doubleedge: [33, 100], flareblitz: [33, 100], headsmash: [1, 2],
  submission: [1, 4], takedown: [1, 4], volttackle: [1, 3], wildcharge: [1, 4],
  woodhammer: [1, 3], struggle: [1, 4],
};

export const DRAIN: Record<string, [number, number]> = {
  absorb: [1, 2], drainpunch: [1, 2], dreameater: [1, 2], gigadrain: [1, 2],
  hornleech: [1, 2], leechlife: [1, 2], megadrain: [1, 2], oblivionwing: [3, 4],
  drainingkiss: [3, 4],
};

export const SELF_STAT_CHANGES: Record<string, StatBoosts> = {
  closecombat: {def: -1, spd: -1}, dracometeor: {spa: -2}, fleurcannon: {spa: -2},
  hammerarm: {spe: -1}, leafstorm: {spa: -2}, makeitrain: {spa: -1}, overheat: {spa: -2},
  psychoboost: {spa: -2}, spinout: {spe: -2}, superpower: {atk: -1, def: -1},
  vcreate: {def: -1, spd: -1, spe: -1}, hyperspacefury: {def: -1},
  armorcannon: {def: -1, spd: -1},
  dragonascent: {def: -1, spd: -1}, headlongrush: {def: -1, spd: -1}, icehammer: {spe: -1},
  scaleshot: {def: -1, spe: 1},
};

export const STAGE_IDS = ['atk', 'def', 'spa', 'spd', 'spe', 'acc', 'eva'] as const;

export const SECONDARY_BOOST_MOVES = new Set([
  'chargebeam', 'poweruppunch', 'growl', 'leer', 'tailwhip', 'charm', 'faketears',
  'screech', 'eerieimpulse', 'snarl', 'strugglebug', 'skittersmack', 'tropkick',
  'lunge', 'breakingswipe', 'icywind', 'electroweb', 'rocktomb', 'mudshot', 'lowsweep',
  'acidspray',
]);

export const PROTECT_BYPASS_MOVES = new Set([
  'feint', 'hyperspacefury', 'hyperspacehole', 'mightycleave', 'phantomforce',
  'shadowforce',
]);

export const INSTRUCT_BLOCKED_MOVES = new Set([
  'assist', 'beakblast', 'bide', 'bounce', 'counter', 'copycat', 'dig', 'dive', 'fly',
  'focuspunch', 'metronome', 'mimic', 'mirrormove', 'naturepower', 'phantomforce',
  'shelltrap', 'shadowforce', 'sketch', 'skydrop', 'sleeptalk', 'struggle', 'transform',
  'metalburst', 'mirrorcoat',
]);

export const ABILITY_CHANGE_IMMUNITIES = new Set([
  'asoneglastrier', 'asonespectrier', 'battlebond', 'comatose', 'commander', 'disguise',
  'gulpmissile', 'iceface', 'lingeringaroma', 'mummy', 'multitype', 'powerconstruct',
  'rkssystem', 'rksystem', 'schooling', 'shieldsdown', 'stancechange', 'terashift', 'zenmode',
  'zerotohero',
]);

export const TERRAIN_SEEDS: Record<string, {terrain: Terrain; stat: keyof StatBoosts}> = {
  electricseed: {terrain: 'Electric', stat: 'def'},
  grassyseed: {terrain: 'Grassy', stat: 'def'},
  mistyseed: {terrain: 'Misty', stat: 'spd'},
  psychicseed: {terrain: 'Psychic', stat: 'spd'},
};

export const RESIST_BERRY_TYPES: Record<string, string> = {
  occaberry: 'fire',
  passhoberry: 'water',
  wacanberry: 'electric',
  rindoberry: 'grass',
  yacheberry: 'ice',
  chopleberry: 'fighting',
  kebiaberry: 'poison',
  shucaberry: 'ground',
  cobaberry: 'flying',
  payapaberry: 'psychic',
  tangaberry: 'bug',
  chartiberry: 'rock',
  kasibberry: 'ghost',
  habanberry: 'dragon',
  colburberry: 'dark',
  babiriberry: 'steel',
  roseliberry: 'fairy',
  chilanberry: 'normal',
};

export const REACTIVE_STAT_BERRIES: Record<string, {category: MoveCategory; stat: keyof StatBoosts}> = {
  keeberry: {category: 'Physical', stat: 'def'},
  marangaberry: {category: 'Special', stat: 'spd'},
};

export const REACTIVE_DAMAGE_BERRIES: Record<string, MoveCategory> = {
  jabocaberry: 'Physical',
  rowapberry: 'Special',
};

/** Moves the move engine rejects outright before a given generation. */
export const MOVE_MIN_GENERATION: Record<string, number> = {
  ragingfury: 9,
  geomancy: 6,
  electroshot: 9,
  vcreate: 5,
  hyperspacefury: 6,
  diamondstorm: 6,
  tarshot: 8,
  orderup: 9,
  anchorshot: 7,
  spiritshackle: 7,
  throatchop: 7,
  burningjealousy: 8,
  gigatonhammer: 9,
  scaleshot: 8,
  echoedvoice: 5,
  furycutter: 2,
  burnup: 7,
  doubleshock: 9,
  relicsong: 5,
  glaiverush: 9,
};

export const GENERATION_NUMERALS: Record<number, string> = {
  1: 'I',
  2: 'II',
  3: 'III',
  4: 'IV',
  5: 'V',
  6: 'VI',
  7: 'VII',
  8: 'VIII',
  9: 'IX',
};
