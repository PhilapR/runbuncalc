(function () {
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });

const data_1 = require("./data");
const A = __importStar(require("./adaptable"));
const Acalculate = A.calculate;
exports.calculate = calculate;
exports.calcStat = calcStat;
function calculate(gen, attacker, defender, move, field) {
    return (Acalculate || A.calculate)(typeof gen === 'number' ? data_1.Generations.get(gen) : gen, attacker, defender, move, field);
}
class Move extends A.Move {
    constructor(gen, name, options = {}) {
        super(typeof gen === 'number' ? data_1.Generations.get(gen) : gen, name, options);
    }
}
exports.Move = Move;
class Pokemon extends A.Pokemon {
    constructor(gen, name, options = {}) {
        super(typeof gen === 'number' ? data_1.Generations.get(gen) : gen, name, options);
    }
    static getForme(gen, speciesName, item, moveName) {
        return A.Pokemon.getForme(typeof gen === 'number' ? data_1.Generations.get(gen) : gen, speciesName, item, moveName);
    }
}
exports.Pokemon = Pokemon;
function calcStat(gen, stat, base, iv, ev, level, nature) {
    return A.Stats.calcStat(typeof gen === 'number' ? data_1.Generations.get(gen) : gen, stat === 'spc' ? 'spa' : stat, base, iv, ev, level, nature);
}
var field_1 = require("./field");
exports.Field = field_1.Field;
exports.Side = field_1.Side;
var result_1 = require("./result");
exports.Result = result_1.Result;
var index_1 = require("./data/index");
exports.Generations = index_1.Generations;
var util_1 = require("./util");
exports.toID = util_1.toID;
var abilities_1 = require("./data/abilities");
exports.ABILITIES = abilities_1.ABILITIES;
var items_1 = require("./data/items");
exports.ITEMS = items_1.ITEMS;
exports.MEGA_STONES = items_1.MEGA_STONES;
var moves_1 = require("./data/moves");
exports.MOVES = moves_1.MOVES;
var species_1 = require("./data/species");
exports.SPECIES = species_1.SPECIES;
var natures_1 = require("./data/natures");
exports.NATURES = natures_1.NATURES;
var types_1 = require("./data/types");
exports.TYPE_CHART = types_1.TYPE_CHART;
var stats_1 = require("./stats");
exports.STATS = stats_1.STATS;
exports.Stats = stats_1.Stats;
//# sourceMappingURL=index.js.map
})();
