(function () {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

const util_1 = require("./util");
const RBY = ['hp', 'atk', 'def', 'spc', 'spe'];
const GSC = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
const ADV = GSC;
const DPP = GSC;
const BW = GSC;
const XY = GSC;
const SM = GSC;
const SS = GSC;
const SV = GSC;
exports.STATS = [[], RBY, GSC, ADV, DPP, BW, XY, SM, SS, SV];
const HP_TYPES = [
    'Fighting', 'Flying', 'Poison', 'Ground', 'Rock', 'Bug', 'Ghost', 'Steel',
    'Fire', 'Water', 'Grass', 'Electric', 'Psychic', 'Ice', 'Dragon', 'Dark',
];
const HP = {
    Bug: { ivs: { atk: 30, def: 30, spd: 30 }, dvs: { atk: 13, def: 13 } },
    Dark: { ivs: {}, dvs: {} },
    Dragon: { ivs: { atk: 30 }, dvs: { def: 14 } },
    Electric: { ivs: { spa: 30 }, dvs: { atk: 14 } },
    Fighting: { ivs: { def: 30, spa: 30, spd: 30, spe: 30 }, dvs: { atk: 12, def: 12 } },
    Fire: { ivs: { atk: 30, spa: 30, spe: 30 }, dvs: { atk: 14, def: 12 } },
    Flying: { ivs: { hp: 30, atk: 30, def: 30, spa: 30, spd: 30 }, dvs: { atk: 12, def: 13 } },
    Ghost: { ivs: { def: 30, spd: 30 }, dvs: { atk: 13, def: 14 } },
    Grass: { ivs: { atk: 30, spa: 30 }, dvs: { atk: 14, def: 14 } },
    Ground: { ivs: { spa: 30, spd: 30 }, dvs: { atk: 12 } },
    Ice: { ivs: { atk: 30, def: 30 }, dvs: { def: 13 } },
    Poison: { ivs: { def: 30, spa: 30, spd: 30 }, dvs: { atk: 12, def: 14 } },
    Psychic: { ivs: { atk: 30, spe: 30 }, dvs: { def: 12 } },
    Rock: { ivs: { def: 30, spd: 30, spe: 30 }, dvs: { atk: 13, def: 12 } },
    Steel: { ivs: { spd: 30 }, dvs: { atk: 13 } },
    Water: { ivs: { atk: 30, def: 30, spa: 30 }, dvs: { atk: 14, def: 13 } },
};
exports.Stats = new (class {
    displayStat(stat) {
        switch (stat) {
            case 'hp':
                return 'HP';
            case 'atk':
                return 'Atk';
            case 'def':
                return 'Def';
            case 'spa':
                return 'SpA';
            case 'spd':
                return 'SpD';
            case 'spe':
                return 'Spe';
            case 'spc':
                return 'Spc';
            default:
                throw new Error(`unknown stat ${stat}`);
        }
    }
    shortForm(stat) {
        switch (stat) {
            case 'hp':
                return 'hp';
            case 'atk':
                return 'at';
            case 'def':
                return 'df';
            case 'spa':
                return 'sa';
            case 'spd':
                return 'sd';
            case 'spe':
                return 'sp';
            case 'spc':
                return 'sl';
        }
    }
    getHPDV(ivs) {
        return ((this.IVToDV(ivs.atk) % 2) * 8 +
            (this.IVToDV(ivs.def) % 2) * 4 +
            (this.IVToDV(ivs.spe) % 2) * 2 +
            (this.IVToDV(ivs.spc) % 2));
    }
    IVToDV(iv) {
        return Math.floor(iv / 2);
    }
    DVToIV(dv) {
        return dv * 2;
    }
    DVsToIVs(dvs) {
        const ivs = {};
        let dv;
        for (dv in dvs) {
            ivs[dv] = exports.Stats.DVToIV(dvs[dv]);
        }
        return ivs;
    }
    calcStat(gen, stat, base, iv, ev, level, nature) {
        if (gen.num < 1 || gen.num > 9)
            throw new Error(`Invalid generation ${gen.num}`);
        if (gen.num < 3)
            return this.calcStatRBY(stat, base, iv, level);
        return this.calcStatADV(gen.natures, stat, base, iv, ev, level, nature);
    }
    calcStatADV(natures, stat, base, iv, ev, level, nature) {
        if (stat === 'hp') {
            return base === 1
                ? base
                : Math.floor(((base * 2 + iv + Math.floor(ev / 4)) * level) / 100) + level + 10;
        }
        else {
            let mods = [undefined, undefined];
            if (nature) {
                const nat = natures.get((0, util_1.toID)(nature));
                mods = [nat === null || nat === void 0 ? void 0 : nat.plus, nat === null || nat === void 0 ? void 0 : nat.minus];
            }
            const n = mods[0] === stat && mods[1] === stat
                ? 1
                : mods[0] === stat
                    ? 1.1
                    : mods[1] === stat
                        ? 0.9
                        : 1;
            return Math.floor((Math.floor(((base * 2 + iv + Math.floor(ev / 4)) * level) / 100) + 5) * n);
        }
    }
    calcStatRBY(stat, base, iv, level) {
        return this.calcStatRBYFromDV(stat, base, this.IVToDV(iv), level);
    }
    calcStatRBYFromDV(stat, base, dv, level) {
        if (stat === 'hp') {
            return Math.floor((((base + dv) * 2 + 63) * level) / 100) + level + 10;
        }
        else {
            return Math.floor((((base + dv) * 2 + 63) * level) / 100) + 5;
        }
    }
    getHiddenPowerIVs(gen, hpType) {
        const hp = HP[hpType];
        if (!hp)
            return undefined;
        return gen.num === 2 ? exports.Stats.DVsToIVs(hp.dvs) : hp.ivs;
    }
    getHiddenPower(gen, ivs) {
        const tr = (num, bits = 0) => {
            if (bits)
                return (num >>> 0) % (Math.pow(2, bits));
            return num >>> 0;
        };
        const stats = { hp: 31, atk: 31, def: 31, spe: 31, spa: 31, spd: 31 };
        if (gen.num <= 2) {
            const atkDV = tr(ivs.atk / 2);
            const defDV = tr(ivs.def / 2);
            const speDV = tr(ivs.spe / 2);
            const spcDV = tr(ivs.spa / 2);
            return {
                type: HP_TYPES[4 * (atkDV % 4) + (defDV % 4)],
                power: tr((5 * ((spcDV >> 3) +
                    (2 * (speDV >> 3)) +
                    (4 * (defDV >> 3)) +
                    (8 * (atkDV >> 3))) +
                    (spcDV % 4)) / 2 + 31),
            };
        }
        else {
            let hpTypeX = 0;
            let hpPowerX = 0;
            let i = 1;
            for (const s in stats) {
                hpTypeX += i * (ivs[s] % 2);
                hpPowerX += i * (tr(ivs[s] / 2) % 2);
                i *= 2;
            }
            return {
                type: HP_TYPES[tr(hpTypeX * 15 / 63)],
                power: (gen.num && gen.num < 6) ? tr(hpPowerX * 40 / 63) + 30 : 60,
            };
        }
    }
})();
//# sourceMappingURL=stats.js.map
})();
